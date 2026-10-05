/**
 * Askify AI — in-chat assistant endpoint
 *
 * Tagged with `@askify` inside a 1:1 chat, the dashboard calls this route with
 * the recent messages of the thread as context and gets a reply back. The
 * reply is written by the CLIENT as a normal message in that thread (flagged
 * `askifyReply`), so it renders for both people and survives a reload.
 *
 * Provider is chosen by whichever key is present, in this order:
 *   1. GEMINI_API_KEY  → Google Generative Language API (default)
 *   2. XAI_API_KEY     → xAI / Grok (OpenAI-compatible)
 *   3. OPENAI_API_KEY  → OpenAI (OpenAI-compatible)
 *   4. GROQ_API_KEY    → Groq (OpenAI-compatible)
 *
 * Auth: the client sends its Firebase ID token as `Authorization: Bearer <t>`,
 * which we verify with the Admin SDK — the provider key never leaves the server.
 *
 * Env vars:
 *   GEMINI_API_KEY / GEMINI_MODEL      (default gemini-flash-latest)
 *   XAI_API_KEY    / XAI_MODEL         (default grok-4-fast)
 *   OPENAI_API_KEY / OPENAI_MODEL      (default gpt-4o-mini)
 *   GROQ_API_KEY   / GROQ_MODEL        (default llama-3.3-70b-versatile)
 *   AI_MAX_PER_HOUR                    (default 30) per-user request cap
 */

const express = require("express");
const admin = require("firebase-admin");

// ── Firebase Admin init (idempotent — shares the app with admin-api.js) ─────
if (!admin.apps.length) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    });
  } else {
    admin.initializeApp();
  }
}

const app = express();
app.use(express.json({ limit: "256kb" }));

// ── CORS ────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-Secret");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── Provider abstraction ────────────────────────────────────────────────────
const PROVIDERS = {
  gemini: {
    key: () => process.env.GEMINI_API_KEY,
    // Tried in order — the alias first, then a pinned model as a fallback for
    // transient "high demand" errors on a specific model.
    models: () => [process.env.GEMINI_MODEL || "gemini-flash-latest", "gemini-3.8-flash"],
    call: callGemini,
  },
  xai: {
    key: () => process.env.XAI_API_KEY,
    models: () => [process.env.XAI_MODEL || "grok-4-fast"],
    base: () => "https://api.x.ai/v1/chat/completions",
    call: callOpenAICompatible,
  },
  openai: {
    key: () => process.env.OPENAI_API_KEY,
    models: () => [process.env.OPENAI_MODEL || "gpt-4o-mini"],
    base: () => "https://api.openai.com/v1/chat/completions",
    call: callOpenAICompatible,
  },
  groq: {
    key: () => process.env.GROQ_API_KEY,
    models: () => [process.env.GROQ_MODEL || "llama-3.3-70b-versatile"],
    base: () => "https://api.groq.com/openai/v1/chat/completions",
    call: callOpenAICompatible,
  },
};

// Transient provider hiccups (capacity/rate limits) are worth one retry, on
// the next model in the list.
function isTransient(msg) {
  return /high demand|overloaded|unavailable|try again|rate limit|\b(429|500|503)\b/i.test(String(msg || ""));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Ask the provider, walking its model list and retrying transient failures.
async function askProvider(provider, { system, messages, maxTokens }) {
  const models = provider.models ? provider.models() : [];
  let lastErr = null;
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const answer = await provider.call({
          system,
          messages,
          model,
          key: provider.key(),
          base: provider.base ? provider.base() : undefined,
          maxTokens,
        });
        return { answer, model };
      } catch (e) {
        lastErr = e;
        if (attempt === 0 && isTransient(e.message)) {
          await sleep(700);
          continue;
        }
        break; // non-transient, or already retried → next model
      }
    }
  }
  throw lastErr || new Error("Askify could not reach the AI provider");
}

// Provider preference order: Gemini first, then xAI/Grok, then the rest.
const PROVIDER_ORDER = ["gemini", "xai", "openai", "groq"];

// Every provider that has a key configured, in preference order. The request
// handler walks this whole list so a Gemini outage (or an xAI account with no
// credits) falls through to the next provider instead of failing outright.
function availableProviders() {
  return PROVIDER_ORDER
    .filter(name => PROVIDERS[name].key())
    .map(name => ({ name, ...PROVIDERS[name] }));
}

// Kept for the status endpoint / callers that just want the primary.
function pickProvider() {
  const all = availableProviders();
  return all.length ? all[0] : null;
}

async function callGemini({ system, messages, model, key, maxTokens }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const contents = messages.map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { temperature: 0.6, maxOutputTokens: maxTokens || 1024 },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || `Gemini HTTP ${res.status}`;
    throw new Error(msg);
  }
  const cand = data.candidates && data.candidates[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  const text = parts.map(p => p.text || "").join("").trim();
  if (!text) throw new Error("Gemini returned an empty response");
  return text;
}

async function callOpenAICompatible({ system, messages, model, key, base, maxTokens }) {
  const res = await fetch(base, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: system }, ...messages],
      temperature: 0.6,
      max_tokens: maxTokens || 1024,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || `Provider HTTP ${res.status}`;
    throw new Error(msg);
  }
  const text = data.choices && data.choices[0] && data.choices[0].message
    ? String(data.choices[0].message.content || "").trim()
    : "";
  if (!text) throw new Error("Provider returned an empty response");
  return text;
}

// ── Auth: verify the Firebase ID token ──────────────────────────────────────
async function requireUser(req, res, next) {
  const header = req.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ success: false, error: "Missing auth token" });
  try {
    req.user = await admin.auth().verifyIdToken(token);
    next();
  } catch (e) {
    return res.status(401).json({ success: false, error: "Invalid or expired session" });
  }
}

// ── Per-user rate limit (in-memory; fine for a single Render instance) ──────
const AI_MAX_PER_HOUR = parseInt(process.env.AI_MAX_PER_HOUR || "30", 10);
const hits = new Map(); // uid -> [timestamps]
function rateLimited(uid) {
  const now = Date.now();
  const arr = (hits.get(uid) || []).filter(t => now - t < 3600000);
  if (arr.length >= AI_MAX_PER_HOUR) {
    hits.set(uid, arr);
    return true;
  }
  arr.push(now);
  hits.set(uid, arr);
  return false;
}

// ── Prompt construction ─────────────────────────────────────────────────────
const ASKIFY_SYSTEM = [
  "You are Askify, the built-in assistant inside the Nexa Messenger app.",
  "You are tagged inside a private 1:1 chat to help the two people in it.",
  "You can see the recent messages of the conversation, labelled by speaker.",
  "Answer helpfully and concisely (usually under 120 words unless asked for more).",
  "When asked to summarise or recall what was said, rely only on the transcript provided.",
  "Never invent messages that are not in the transcript.",
  "Do not use markdown headings or code fences; plain conversational text only.",
].join(" ");

function buildMessages(question, history) {
  const lines = [];
  if (Array.isArray(history)) {
    for (const m of history.slice(-20)) {
      if (!m || typeof m.text !== "string" || !m.text.trim()) continue;
      const who = m.from === "me" ? "Me" : "Them";
      lines.push(`${who}: ${m.text.trim().slice(0, 800)}`);
    }
  }
  const transcript = lines.length ? lines.join("\n") : "(no earlier messages)";
  const userContent =
    `Recent conversation transcript:\n${transcript}\n\n` +
    `My request to you:\n${String(question || "").trim().slice(0, 2000)}`;
  return [{ role: "user", content: userContent }];
}

// ── POST /api/ai/ask ────────────────────────────────────────────────────────
app.post("/api/ai/ask", requireUser, async (req, res) => {
  try {
    const providers = availableProviders();
    if (!providers.length) {
      return res.status(503).json({
        success: false,
        code: "not_configured",
        error: "Askify isn't configured yet — no AI provider key is set on the server.",
      });
    }

    const { question, history } = req.body || {};
    if (!question || typeof question !== "string" || !question.trim()) {
      return res.status(400).json({ success: false, error: "question required" });
    }

    if (rateLimited(req.user.uid)) {
      return res.status(429).json({
        success: false,
        error: `You've reached Askify's limit (${AI_MAX_PER_HOUR}/hour). Try again later.`,
      });
    }

    const messages = buildMessages(question, history);

    // Try each configured provider in order until one answers.
    const failures = [];
    for (const provider of providers) {
      try {
        const { answer, model } = await askProvider(provider, {
          system: ASKIFY_SYSTEM,
          messages,
          maxTokens: 1024,
        });
        return res.json({ success: true, answer, provider: provider.name, model });
      } catch (e) {
        failures.push(provider.name + ": " + e.message);
        console.warn("Askify provider failed, trying next:", provider.name, "-", e.message);
      }
    }

    console.error("Askify: all providers failed:", failures.join(" | "));
    return res.status(503).json({
      success: false,
      code: "providers_unavailable",
      error: "Askify is busy right now — the AI providers are temporarily unavailable. Please try again in a moment.",
    });
  } catch (err) {
    console.error("ai/ask error:", err);
    res.status(502).json({ success: false, error: err.message || "Askify could not answer right now." });
  }
});

app.get("/api/ai/status", (req, res) => {
  const provider = pickProvider();
  res.json({ success: true, configured: !!provider, provider: provider ? provider.name : null });
});

// Only bind a port when run directly; when required from another server
// (e.g. a merged Render service) the caller mounts `app` itself.
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Nexa AI API listening on :${PORT}`));
}

module.exports = { app, buildMessages, pickProvider, availableProviders, ASKIFY_SYSTEM, callGemini, callOpenAICompatible, askProvider, isTransient };
