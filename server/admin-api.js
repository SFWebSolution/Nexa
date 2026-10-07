/**
 * Nexa Admin API — privileged operations for admin.html
 *
 * These endpoints perform actions the hardened Firestore rules forbid from
 * the browser (edit any user, ban, delete). They must run server-side with
 * the Firebase Admin SDK.
 *
 * Deploy: merge these routes into the existing nexa-backend service
 * (https://nexa-backend-e6pq.onrender.com) or run standalone.
 *
 * Required env vars:
 *   GOOGLE_APPLICATION_CREDENTIALS  path to serviceAccountKey.json (local dev)
 *   — on Render, paste the service-account JSON into env var FIREBASE_SERVICE_ACCOUNT
 *   ADMIN_SECRET                    long random string; admin.html sends it as
 *                                   the X-Admin-Secret header. Without it these
 *                                   routes refuse every request.
 *   ALLOWED_ORIGIN                  e.g. https://your-app.onrender.com (CORS)
 */

const express = require("express");
const admin = require("firebase-admin");

// ── Admin SDK init ──────────────────────────────────────────────────────────
// Supports either a local key file (GOOGLE_APPLICATION_CREDENTIALS) or the
// whole JSON pasted into an env var (FIREBASE_SERVICE_ACCOUNT) for Render.
if (!admin.apps.length) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    });
  } else {
    admin.initializeApp(); // uses GOOGLE_APPLICATION_CREDENTIALS
  }
}
const db = admin.firestore();

const app = express();
app.use(express.json());

// ── CORS (locked to the app origin) ─────────────────────────────────────────
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Secret");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── Shared-secret guard ─────────────────────────────────────────────────────
// Every admin endpoint requires the X-Admin-Secret header to match
// ADMIN_SECRET. This is the ONLY thing standing between the internet and
// ban/delete/edit-any-user, so make it long and keep it out of the repo.
function requireAdminSecret(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    return res.status(500).json({ success: false, error: "ADMIN_SECRET not configured on server" });
  }
  if (req.get("X-Admin-Secret") !== secret) {
    return res.status(403).json({ success: false, error: "Forbidden" });
  }
  next();
}

// ── POST /api/admin/edit-user ───────────────────────────────────────────────
// Body: { uid, displayName, email?, phone? }
app.post("/api/admin/edit-user", requireAdminSecret, async (req, res) => {
  try {
    const { uid, displayName, email, phone } = req.body || {};
    if (!uid || typeof uid !== "string") {
      return res.status(400).json({ success: false, error: "uid required" });
    }
    if (!displayName || typeof displayName !== "string" || !displayName.trim()) {
      return res.status(400).json({ success: false, error: "displayName required" });
    }
    const name = displayName.trim().slice(0, 100);
    const update = {
      displayName: name,
      name,
      updatedAt: Date.now(),
      lastModifiedBy: "admin-backend",
    };
    if (email && typeof email === "string" && email.includes("@")) {
      update.email = email.trim().slice(0, 200);
    }
    if (phone && typeof phone === "string" && phone.trim()) {
      // Keep the same normalized form signup.html stores (digits + leading +).
      update.phone = phone.trim().replace(/[^\d+]/g, "").slice(0, 20);
    }
    await db.collection("users").doc(uid).update(update);
    res.json({ success: true });
  } catch (err) {
    console.error("edit-user error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/admin/ban-user ────────────────────────────────────────────────
// Body: { uid, banned: boolean }
app.post("/api/admin/ban-user", requireAdminSecret, async (req, res) => {
  try {
    const { uid, banned } = req.body || {};
    if (!uid || typeof uid !== "string") {
      return res.status(400).json({ success: false, error: "uid required" });
    }
    await db.collection("users").doc(uid).update({
      banned: banned === true,
      updatedAt: Date.now(),
    });
    // Also disable/enable the Firebase Auth account so a banned user can't sign in.
    await admin.auth().updateUser(uid, { disabled: banned === true }).catch(err => {
      console.warn("auth disable toggle failed (user may not exist in Auth):", err.message);
    });
    res.json({ success: true });
  } catch (err) {
    console.error("ban-user error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/admin/delete-user ─────────────────────────────────────────────
// Body: { uid }
// Deletes the user profile, their presence doc, and their Firebase Auth account.
app.post("/api/admin/delete-user", requireAdminSecret, async (req, res) => {
  try {
    const { uid } = req.body || {};
    if (!uid || typeof uid !== "string") {
      return res.status(400).json({ success: false, error: "uid required" });
    }
    await db.collection("users").doc(uid).delete().catch(() => {});
    await db.collection("presence").doc(uid).delete().catch(() => {});
    await admin.auth().deleteUser(uid).catch(err => {
      console.warn("auth delete failed (user may not exist in Auth):", err.message);
    });
    res.json({ success: true });
  } catch (err) {
    console.error("delete-user error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/admin/weekly-activity ──────────────────────────────────────────
// Returns this-week activity per uid so the champions list can rank people who
// have NOT referred anyone yet. The browser can't read other users' `chats`
// docs (rules are auth-party-only) and the admin account itself is anonymous,
// so this MUST come from the Admin SDK. Two aggregate-style scans, no realtime
// listener. Query: ?weekStart=<epoch ms>
// createdAt is normally a ms-epoch number; tolerate a Firestore Timestamp or
// string anyway so a doc written by another path can't zero out a count.
function tsMs(v) {
  if (typeof v === "number") return v;
  if (v && typeof v.toMillis === "function") return v.toMillis();
  if (v && typeof v.toDate === "function") return v.toDate().getTime();
  const n = new Date(v).getTime();
  return isNaN(n) ? 0 : n;
}

// Pure aggregation over already-fetched docs — separated out so it can be
// unit-tested without a Firestore connection.
function aggregateWeeklyActivity(chatDocs, statusDocs, weekStart) {
  const messages = {};
  const stories = {};
  (chatDocs || []).forEach(d => {
    const ts = tsMs(d && d.createdAt);
    if (d && d.from && ts && ts >= weekStart) messages[d.from] = (messages[d.from] || 0) + 1;
  });
  (statusDocs || []).forEach(d => {
    const ts = tsMs(d && d.createdAt);
    if (d && d.uid && ts && ts >= weekStart) stories[d.uid] = (stories[d.uid] || 0) + 1;
  });
  const totals = {};
  Object.keys(messages).forEach(uid => { totals[uid] = (totals[uid] || 0) + messages[uid]; });
  Object.keys(stories).forEach(uid => { totals[uid] = (totals[uid] || 0) + stories[uid]; });
  return { messages, stories, totals };
}

app.get("/api/admin/weekly-activity", requireAdminSecret, async (req, res) => {
  try {
    const weekStart = Number(req.query.weekStart) || 0;
    const chatsSnap = await db.collection("chats").get();
    const statusSnap = await db.collection("status").get();
    const chatDocs = chatsSnap.docs.map(doc => doc.data() || {});
    const statusDocs = statusSnap.docs.map(doc => doc.data() || {});
    res.json(Object.assign({ success: true }, aggregateWeeklyActivity(chatDocs, statusDocs, weekStart)));
  } catch (err) {
    console.error("weekly-activity error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nexa admin API listening on :${PORT}`));
