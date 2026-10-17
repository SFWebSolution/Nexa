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

// ── GET /api/admin/list-communities ───────────────────────────
// Lists every group and channel for the admin Communities section. Uses the
// Admin SDK because the hardened rules only let an OWNER delete a community
// (an admin is not the owner), and because counts live in subcollections the
// browser can't aggregate cheaply.
app.get("/api/admin/list-communities", requireAdminSecret, async (req, res) => {
  try {
    const [groupsSnap, channelsSnap] = await Promise.all([
      db.collection("groups").get(),
      db.collection("channels").get(),
    ]);
    const shape = (snap, kind) => snap.docs.map(doc => {
      const d = doc.data() || {};
      const uidList = kind === "channel" ? d.subscriberUids : d.memberUids;
      const declared = kind === "channel" ? d.subscribersCount : d.membersCount;
      const count = Array.isArray(uidList) ? uidList.length : (Number(declared) || 0);
      return {
        id: doc.id,
        kind,
        name: d.name || (kind === "channel" ? "Untitled channel" : "Untitled group"),
        handle: d.handle || "",
        avatarUrl: d.avatarUrl || "",
        ownerUid: d.ownerUid || d.createdBy || "",
        ownerName: d.ownerName || "",
        count,
        description: d.description || "",
        isPublic: d.isPublic !== false,
        createdAt: d.createdAt || 0,
      };
    });
    const communities = shape(groupsSnap, "group").concat(shape(channelsSnap, "channel"));
    communities.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json({ success: true, communities });
  } catch (err) {
    console.error("list-communities error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/admin/delete-community ──────────────────────────
// Body: { id, kind: "group" | "channel" }
// Recursively deletes the community and ALL of its subcollections. A plain
// doc delete would orphan members/messages/posts (they'd still be billed and
// still readable), so we walk the subcollections first.
async function deleteCollection(ref, batchSize) {
  const size = batchSize || 300;
  while (true) {
    const snap = await ref.limit(size).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    if (snap.size < size) break;
  }
}

app.post("/api/admin/delete-community", requireAdminSecret, async (req, res) => {
  try {
    const { id, kind } = req.body || {};
    if (!id || typeof id !== "string") {
      return res.status(400).json({ success: false, error: "id required" });
    }
    const isChannel = kind === "channel";
    const coll = isChannel ? "channels" : "groups";
    const subcolls = isChannel ? ["subscribers", "posts", "messages"] : ["members", "messages"];

    for (const sub of subcolls) {
      try {
        await deleteCollection(db.collection(coll).doc(id).collection(sub));
      } catch (e) {
        console.warn(`subcollection ${sub} cleanup failed for ${coll}/${id}:`, e.message);
      }
    }
    await db.collection(coll).doc(id).delete();
    res.json({ success: true });
  } catch (err) {
    console.error("delete-community error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nexa admin API listening on :${PORT}`));
