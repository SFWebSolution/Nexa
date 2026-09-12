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
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
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
// Body: { uid, displayName, email? }
app.post("/api/admin/edit-user", requireAdminSecret, async (req, res) => {
  try {
    const { uid, displayName, email } = req.body || {};
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

// ── Nexa Wallet: withdrawals ────────────────────────────────────────────────
// GET  /api/admin/withdrawals?status=pending   → list requests
// POST /api/admin/withdrawals/:id/approve      → deduct coins + mark approved
// POST /api/admin/withdrawals/:id/reject       → mark rejected

app.get("/api/admin/withdrawals", requireAdminSecret, async (req, res) => {
  try {
    const status = req.query.status || "pending";
    const snap = await db.collection("withdrawals")
      .where("status", "==", status)
      .orderBy("createdAt", "desc")
      .limit(200)
      .get();
    const items = [];
    snap.forEach(d => {
      items.push({ id: d.id, ...d.data() });
    });
    res.json({ success: true, items });
  } catch (err) {
    console.error("withdrawals list error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/admin/withdrawals/:id/approve", requireAdminSecret, async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body || {};
    const ref = db.collection("withdrawals").doc(id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ success: false, error: "Withdrawal not found" });
    const data = doc.data();
    if (data.status !== "pending") {
      return res.status(400).json({ success: false, error: "Withdrawal already processed" });
    }

    // Deduct from the user's ledger balance (authoritative = users.coinsBalance).
    const userRef = db.collection("users").doc(data.uid);
    const userDoc = await userRef.get();
    const cur = userDoc.exists && typeof userDoc.data().coinsBalance === "number" ? userDoc.data().coinsBalance : 0;
    if (cur < data.coins) {
      return res.status(400).json({ success: false, error: "Insufficient balance on user" });
    }

    const batch = db.batch();
    batch.update(userRef, {
      coinsBalance: admin.firestore.FieldValue.increment(-data.coins)
    });
    batch.update(ref, {
      status: "approved",
      paidAt: Date.now(),
      processedAt: Date.now(),
      notes: notes || null,
      processedBy: "admin"
    });
    await batch.commit();

    res.json({ success: true });
  } catch (err) {
    console.error("withdraw approve error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/admin/withdrawals/:id/reject", requireAdminSecret, async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body || {};
    const ref = db.collection("withdrawals").doc(id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ success: false, error: "Withdrawal not found" });
    const data = doc.data();
    if (data.status !== "pending") {
      return res.status(400).json({ success: false, error: "Withdrawal already processed" });
    }
    await ref.update({
      status: "rejected",
      processedAt: Date.now(),
      notes: notes || null,
      processedBy: "admin"
    });
    res.json({ success: true });
  } catch (err) {
    console.error("withdraw reject error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Nexa Wallet: referral coins (public, no admin secret) ───────────────────
// Called by a newly-referred user when they open the app: credits their
// referrer 50 coins ONCE. The referrer is read from users/{referredUid}.
//referredBy, and duplicate credits are prevented by the ledger sourceId.
app.post("/api/referral-credit", async (req, res) => {
  try {
    const { referredUid } = req.body || {};
    if (!referredUid || typeof referredUid !== "string") {
      return res.status(400).json({ success: false, error: "referredUid required" });
    }

    const referredRef = db.collection("users").doc(referredUid);
    const referredDoc = await referredRef.get();
    if (!referredDoc.exists || !referredDoc.data().referredBy) {
      return res.json({ success: true, credited: false, reason: "no-inviter" });
    }
    const referrerUid = referredDoc.data().referredBy;
    if (referrerUid === referredUid) {
      return res.json({ success: true, credited: false, reason: "self-invite" });
    }

    const sourceId = "referral_" + referredUid;
    // Idempotency: if a referral entry already exists for this referred user
    // (to ANY referrer), do nothing.
    const existing = await db.collection("coinLedger")
      .where("sourceId", "==", sourceId)
      .limit(1)
      .get();
    if (!existing.empty) {
      return res.json({ success: true, credited: false, reason: "already-credited" });
    }

    const amount = 50;
    await db.collection("coinLedger").add({
      uid: referrerUid,
      action: "referral",
      amount,
      sourceId,
      createdAt: Date.now(),
      day: new Date().toISOString().slice(0, 10)
    });
    await db.collection("users").doc(referrerUid).update({
      coinsBalance: admin.firestore.FieldValue.increment(amount)
    }).catch(err => console.warn("referral balance increment failed:", err.message));

    res.json({ success: true, credited: true, reason: "ok" });
  } catch (err) {
    console.error("referral-credit error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nexa admin API listening on :${PORT}`));
