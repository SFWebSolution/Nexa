/**
 * Room-chat sender names (Live rooms) — behaviour of the REAL resolution logic.
 *
 * Room chat messages carry a `name` field stamped at send time. That stamp used
 * to be the Firebase Auth displayName, which is normally null, so it fell back
 * to the email prefix ("kelvin" from kelvin@…) or plain "You"/"User". Names in
 * the room then looked wrong, and existing docs stayed wrong forever because
 * the name was already written.
 *
 * getCurrentUser() and resolveSenderName() are extracted from nexa-voice-room.js
 * and exercised in a vm with a window stub, so this covers the actual code and
 * not a copy of it.
 *
 * Run: node tests/live-room-chat-names.test.js
 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "nexa-voice-room.js"), "utf8");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; } catch (e) { fail++; console.log(`  \u2717 ${name}\n    ${e.message}`); }
}
const ok = (v, m) => { if (!v) throw new Error(m || "expected truthy"); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || "mismatch"}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

// Extract a method DEFINITION by brace matching so the test runs the shipped
// source. Must anchor to line-start indentation: a bare indexOf would hit a
// call site (e.g. `this.resolveSenderName(m)`) and slice the wrong block.
function extractMethod(name) {
  const re = new RegExp("\\n(\\s{2,})" + name + "\\s*\\(");
  const m = re.exec(SRC);
  ok(m, `method definition ${name} not found`);
  const at = m.index + 1 + m[1].length;
  const open = SRC.indexOf("{", at);
  ok(open !== -1, `body of ${name} not found`);
  let i = open, depth = 0;
  while (i < SRC.length) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") { depth--; if (depth === 0) return SRC.slice(at, i + 1); }
    i++;
  }
  throw new Error(`unbalanced body for ${name}`);
}

const GET_CURRENT = extractMethod("getCurrentUser");
const RESOLVE = extractMethod("resolveSenderName");
const ESCAPE = extractMethod("escapeHTML");

// Build a fresh object exposing the real methods plus the escapeHTML helper.
function makeRoom(win = {}, participants = new Map()) {
  const noStore = { getItem: () => null, key: () => null, length: 0 };
  const src = `
    const room = {
      participants: participantsRef,
      ${GET_CURRENT},
      ${RESOLVE},
      ${ESCAPE}
    };
    return room;
  `;
  const fn = new Function("window", "localStorage", "participantsRef", src);
  return fn(win, noStore, participants);
}

console.log("\n── getCurrentUser: the real profile name wins ──");

t("prefers the users/{uid} profile name over the Auth displayName", () => {
  const win = {
    currentUser: { uid: "u1", displayName: null, email: "kelvin@example.com" },
    allUsersData: [{ uid: "u1", displayName: "Kelvin Mensah" }],
  };
  eq(makeRoom(win).getCurrentUser().name, "Kelvin Mensah", "profile name");
});

t("never falls back to the email prefix when a profile exists", () => {
  // This was the bug: email prefix became the sender name.
  const win = {
    currentUser: { uid: "u1", displayName: null, email: "kelvin@example.com" },
    allUsersData: [{ uid: "u1", displayName: "Nana Kwame" }],
  };
  const n = makeRoom(win).getCurrentUser().name;
  ok(n !== "kelvin", `must not use the email prefix, got ${n}`);
});

t("supports a profile that only exposes `name` (not displayName)", () => {
  const win = {
    currentUser: { uid: "u1", displayName: null },
    allUsersData: [{ uid: "u1", name: "Ama Serwaa" }],
  };
  eq(makeRoom(win).getCurrentUser().name, "Ama Serwaa", "name field");
});

t("a real Auth displayName still wins (explicitly set at signup)", () => {
  const win = {
    currentUser: { uid: "u1", displayName: "Kojo" , email: "k@x.com" },
    allUsersData: [{ uid: "u1", displayName: "Old Name" }],
  };
  eq(makeRoom(win).getCurrentUser().name, "Kojo", "auth displayName");
});

t("falls back to the email prefix only when nothing else exists", () => {
  const win = { currentUser: { uid: "u1", email: "solo@example.com" }, allUsersData: [] };
  eq(makeRoom(win).getCurrentUser().name, "solo", "email fallback");
});

t("tidies the profile avatar", () => {
  const win = {
    currentUser: { uid: "u1" },
    allUsersData: [{ uid: "u1", displayName: "A", photo: "https://x/a.jpg" }],
  };
  eq(makeRoom(win).getCurrentUser().avatar, "https://x/a.jpg", "avatar");
});

console.log("\n── resolveSenderName: heals already-sent messages ──");

t("keeps a good stored name", () => {
  const room = makeRoom({ allUsersData: [{ uid: "u2", displayName: "Nope" }] });
  eq(room.resolveSenderName({ uid: "u2", name: "Nana Yaw" }), "Nana Yaw", "stored name kept");
});

t("replaces a stored 'User'", () => {
  const room = makeRoom({ allUsersData: [{ uid: "u2", displayName: "Akosua" }] });
  eq(room.resolveSenderName({ uid: "u2", name: "User" }), "Akosua", "User replaced");
});

t("replaces a stored 'You'", () => {
  const room = makeRoom({ allUsersData: [{ uid: "u2", displayName: "Akosua" }] });
  eq(room.resolveSenderName({ uid: "u2", name: "You" }), "Akosua", "You replaced");
});

t("replaces a fake 'user_xxxx' placeholder id used as a name", () => {
  const room = makeRoom({ allUsersData: [{ uid: "u2", displayName: "Ama" }] });
  eq(room.resolveSenderName({ uid: "u2", name: "user_ab12cd34" }), "Ama", "placeholder replaced");
});

t("resolves from presence cache when the users list is not loaded", () => {
  const room = makeRoom({ userPresenceCache: { u3: { name: "Efua" } } });
  eq(room.resolveSenderName({ uid: "u3", name: "User" }), "Efua", "presence cache");
});

t("resolves from the participant map (a Map, not an array)", () => {
  const parts = new Map([["u4", { id: "u4", name: "Yaa" }]]);
  const room = makeRoom({}, parts);
  eq(room.resolveSenderName({ uid: "u4", name: "User" }), "Yaa", "participant map");
});

t("resolves my own message through getCurrentUser", () => {
  const win = {
    currentUser: { uid: "me", email: "me@x.com" },
    allUsersData: [{ uid: "me", displayName: "Myself" }],
  };
  eq(makeRoom(win).resolveSenderName({ uid: "me", name: "You" }), "Myself", "self name");
});

t("degrades to the stored value when nothing is known", () => {
  const room = makeRoom({});
  eq(room.resolveSenderName({ uid: "ghost", name: "Ghost" }), "Ghost", "unknown uid");
});

t("never throws for a null/undefined doc or missing uid", () => {
  const room = makeRoom({});
  eq(room.resolveSenderName({}), "User", "empty doc");
  eq(room.resolveSenderName({ name: "" }), "User", "empty name");
  ok(typeof room.resolveSenderName({ uid: "u9" }) === "string", "missing name must return a string");
});

console.log("\n── Safety + wiring ──");

t("names are escaped before interpolation", () => {
  const room = makeRoom({});
  eq(room.escapeHTML('<img src=x onerror=alert(1)>'),
     "&lt;img src=x onerror=alert(1)&gt;", "escaped");
});

t("the render path uses resolveSenderName, not the raw stored name", () => {
  ok(/const name = this\.escapeHTML\(this\.resolveSenderName\(m\)\)/.test(SRC),
     "subscribeToRoomChat must render resolveSenderName(m)");
});

t("the name is still rendered only for OTHER people", () => {
  // Own messages are visually attributed by alignment; showing your own name
  // on every bubble you send would be noise.
  ok(/\$\{!mine \? `<div class="nexa-vr-chat-msg-name">/.test(SRC),
     "own messages must not render a sender name");
});

t("getCurrentUser consults window.allUsersData for the profile name", () => {
  ok(/allUsersData[\s\S]{0,120}find/.test(GET_CURRENT),
     "getCurrentUser must look the profile up in window.allUsersData");
});

console.log("\n── Line endings ──");

t("edited files keep CRLF", () => {
  ["nexa-voice-room.js", "nexa-voice-room.css", "app-main.js", "nexa-videos.css"].forEach((f) => {
    const raw = fs.readFileSync(path.join(ROOT, f), "utf8");
    const crlf = (raw.match(/\r\n/g) || []).length;
    const lf = (raw.match(/\n/g) || []).length;
    ok(crlf > 0 && crlf === lf, `${f}: mixed line endings (${crlf} CRLF / ${lf} LF)`);
  });
});

console.log(`\n${fail === 0 ? "\u2713 PASSED" : "\u2717 FAILED"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
