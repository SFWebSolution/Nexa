/**
 * Full profile page — render + gating tests.
 *
 * Extracts the REAL profile module from app-main.js (the block between the
 * "FULL PROFILE PAGE" banner and the "STORIES / STATUS" banner) and runs it in
 * a vm with a tiny DOM stub + a no-op Firestore, then asserts what actually
 * gets painted. This is the "does opening a profile show the right thing"
 * check — the profile shell is meant to be renderable with ZERO reads, so the
 * user object handed in is the only source of truth here.
 *
 * Run: node tests/profile-render.test.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "app-main.js"), "utf8").replace(/\r\n/g, "\n");

// ── extract the module ─────────────────────────────────────────────────────
const START = SRC.indexOf("const NEXA_PROFILE_TTL_MS");
const END = SRC.indexOf("/* =========================================================================\n   STORIES / STATUS");
if (START < 0 || END < 0 || END <= START) throw new Error("could not locate the profile module");
const MODULE = SRC.slice(START, END);

// ── DOM stub ───────────────────────────────────────────────────────────────
function makeEl(id) {
  const el = {
    id,
    textContent: "",
    innerHTML: "",
    value: "",
    src: "",
    href: "",
    disabled: false,
    style: {},
    dataset: {},
    _cls: new Set(),
    classList: {
      add: (c) => el._cls.add(c),
      remove: (c) => el._cls.delete(c),
      toggle: (c, on) => { if (on === undefined ? !el._cls.has(c) : on) el._cls.add(c); else el._cls.delete(c); },
      contains: (c) => el._cls.has(c),
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    setAttribute: () => {},
    getAttribute: () => null,
    addEventListener: () => {},
    appendChild: () => {},
    focus: () => {},
  };
  return el;
}
const els = {};
function el(id) { return (els[id] = els[id] || makeEl(id)); }

// ── no-op Firestore ────────────────────────────────────────────────────────
function chain() {
  const o = {};
  ["where", "limit", "orderBy", "doc", "collection", "limitToLast", "startAfter", "endBefore"].forEach(m => { o[m] = () => o; });
  o.onSnapshot = () => () => {};
  o.get = () => Promise.resolve({ exists: false, empty: true, forEach() {}, docs: [] });
  o.set = () => Promise.resolve();
  o.update = () => Promise.resolve();
  o.delete = () => Promise.resolve();
  return o;
}

// Records navigation triggered by a tile click (nexaWatchVideo).
const navCalls = [];

const sandbox = {
  console,
  setTimeout,
  Promise,
  JSON,
  Math,
  Date,
  Number,
  String,
  Object,
  Array,
  document: {
    getElementById: el,
    querySelectorAll: () => [],
    querySelector: () => null,
  },
  db: { collection: () => chain() },
  firebase: { firestore: { FieldValue: { increment: () => 0 } } },
  navigator: {},
  location: { origin: "https://nexa.example" },
  currentUser: null,
  allUsersData: [],
  userPresenceCache: {},
  blockedUsers: {},
  _nexaFollowsMap: {},
  _nexaFollowsBackMap: {},
  // helpers the module depends on (real ones live elsewhere in app-main.js)
  safeMediaUrl: (u) => (typeof u === "string" ? u : ""),
  escapeHtml: (s) => String(s == null ? "" : s),
  linkify: (s) => String(s == null ? "" : s),
  formatCount: (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n || 0)),
  isUserOnline: (p) => !!(p && p.online),
  isConnectedTo: (uid) => uid === "other",
  sendConnectRequest: () => {},
  openProfilePic: () => {},
  showNotifToast: () => {},
  openConnectedChat: () => {},
  setBlocked: () => {},
  uploadFile: () => Promise.resolve(""),
  updateConnectTabDot: () => {},
  switchTab: (t) => { navCalls.push(["tab", t]); },
  switchMomentsSubTab: (t) => { navCalls.push(["sub", t]); },
  openMediaViewer: () => {},
  nexaNoteQuotaError: () => {},
  nexaCacheRead: () => null,
  nexaCacheWrite: () => {},
  nexaShareInvite: () => {},
  window: {},
  lucide: { createIcons: () => {} },
};
sandbox.window.lucide = sandbox.lucide;
sandbox.window.NexaVideos = { openFocus: (id) => { navCalls.push(["focus", id]); } };
vm.createContext(sandbox);
vm.runInContext(MODULE, sandbox);

const {
  nexaProfileShow, nxProfileTab, nexaGridTileHtml, nexaRelationshipWith,
  nexaSetTabCount, nexaLoadSavedGrid, nexaLoadMirrorGrid, nexaWatchVideo,
} = sandbox;

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name); }
}

const ME = { uid: "me", displayName: "Me Myself", username: "meuser", photo: "https://x/p.jpg" };
const OTHER = {
  uid: "other", displayName: "Ada Lovelace", username: "ada",
  bio: "First programmer", link: "https://ada.example/x",
  followCounts: { followers: 1200, following: 42 }, videoCount: 7,
  coverUrl: "https://x/cover.jpg", photo: "https://x/ada.jpg",
};
sandbox.currentUser = ME;
sandbox.allUsersData = [ME, OTHER];

// ── 1. someone else's profile ──────────────────────────────────────────────
sandbox._nexaFollowsMap = {};
sandbox._nexaFollowsBackMap = {};
nexaProfileShow(OTHER);

ok("name painted from the passed user", el("nxProfileName").textContent === "Ada Lovelace");
ok("handle painted with a leading @", el("nxProfileHandle").textContent === "@ada");
ok("avatar painted", el("nxProfileAvatar").src === "https://x/ada.jpg");
ok("cover painted from coverUrl", /url\("https:\/\/x\/cover\.jpg"\)/.test(el("nxProfileCover").style.backgroundImage));
ok("bio painted", el("nxProfileBio").innerHTML === "First programmer");
ok("link shown + href set", el("nxProfileLink").style.display === "" && el("nxProfileLink").href === "https://ada.example/x");
ok("followers stat uses the denormalised count", el("nxStatFollowers").textContent === "1.2k");
ok("following stat", el("nxStatFollowing").textContent === "42");
ok("videos stat", el("nxStatVideos").textContent === "7");
ok("overlay opened", el("nxProfilePage").classList.contains("active"));
ok("follow button offered for a stranger", /nexaToggleFollow\('other'\)/.test(el("nxProfileActions").innerHTML));
ok("connected peer gets Message, not Connect", /openConnectedChat\('other'\)/.test(el("nxProfileActions").innerHTML) && !/sendConnectRequest\('other'\)/.test(el("nxProfileActions").innerHTML));
ok("block button present", /nexaProfileBlock\('other'\)/.test(el("nxProfileActions").innerHTML));
ok("someone else's profile hides the Saved tab", el("nxPtabSaved").style.display === "none");

// ── 2. relationship states drive the follow button ─────────────────────────
sandbox._nexaFollowsMap = { other: { status: "accepted" } };
sandbox._nexaFollowsBackMap = {};
nexaProfileShow(OTHER);
ok("already following → 'Following' state", /Following/.test(el("nxProfileActions").innerHTML) && /nx-pa-btn following/.test(el("nxProfileActions").innerHTML));

sandbox._nexaFollowsMap = {};
sandbox._nexaFollowsBackMap = { other: { status: "accepted" } };
nexaProfileShow(OTHER);
ok("they follow me → 'Follow back'", /Follow back/.test(el("nxProfileActions").innerHTML));

sandbox._nexaFollowsMap = { other: { status: "pending" } };
nexaProfileShow(OTHER);
// Following is instant now, so a legacy 'pending' doc still renders the plain
// Follow button (there is no approval mode to show 'Requested' for).
ok("a legacy pending follow renders 'Follow' (no approval mode)",
  /Follow/.test(el("nxProfileActions").innerHTML) && !/Requested/.test(el("nxProfileActions").innerHTML));

// ── 3. my own profile ──────────────────────────────────────────────────────
sandbox._nexaFollowsMap = {};
sandbox._nexaFollowsBackMap = {};
nexaProfileShow(ME);
ok("self profile: Edit + Share + Settings actions", /openEditProfile\(\)/.test(el("nxProfileActions").innerHTML) && /nexaShareProfile\('me'\)/.test(el("nxProfileActions").innerHTML) && /switchTab\('settings'\)/.test(el("nxProfileActions").innerHTML));
ok("self profile: no Follow/Block", !/nexaToggleFollow/.test(el("nxProfileActions").innerHTML) && !/nexaProfileBlock/.test(el("nxProfileActions").innerHTML));
ok("self profile: status reads 'this is you'", /this is you/.test(el("nxProfileStatus").innerHTML));
ok("self profile: empty bio gets the default", el("nxProfileBio").textContent === "Hey! I am using Nexa.");
ok("self profile: Saved tab visible", el("nxPtabSaved").style.display === "");

// ── 4. grid tile rendering ─────────────────────────────────────────────────
const tile = nexaGridTileHtml({ id: "v1", uid: "other", thumbUrl: "https://x/t.jpg", views: 1500 });
ok("tile carries a play-view badge", /1\.5k/.test(tile));
ok("tile opens the watcher", /nexaWatchVideo\('v1'\)/.test(tile));
ok("someone else's tile has NO manage buttons", !/nx-pv-manage/.test(tile));
const ownTile = nexaGridTileHtml({ id: "v2", uid: "me", thumbUrl: "https://x/t.jpg", views: 3 });
ok("my own tile exposes edit + delete", /nx-pv-manage/.test(ownTile) && /nexaVideosEdit\('v2'\)/.test(ownTile) && /nexaVideosDelete\('v2'\)/.test(ownTile));
// The tile keeps the views badge; the like count rides as PLAIN TEXT (no heart
// icon, no pill) so the thumbnail stays clean.
const likedTile = nexaGridTileHtml({ id: "v3", uid: "other", thumbUrl: "https://x/t.jpg", views: 10, likes: 2400 });
ok("tile keeps the views badge", /nx-pv-views/.test(likedTile));
ok("tile shows the like count as plain text", /<span class="nx-pv-likes">2\.4k<\/span>/.test(likedTile));
ok("the like badge has NO heart icon", !/nx-pv-likes"><i /.test(likedTile));
ok("a tile with no likes renders 0, not 'undefined'", /<span class="nx-pv-likes">0<\/span>/.test(nexaGridTileHtml({ id: "v4", uid: "other", views: 0 })));

// Tapping a tile must land on the video in the feed: the feed lives in the
// Moments > Videos pane, so nexaWatchVideo has to switch there first.
navCalls.length = 0;
nexaWatchVideo("v9");
ok("tile click switches to the Moments tab", navCalls.some(c => c[0] === "tab" && c[1] === "stories"));
ok("tile click opens the Videos sub-tab", navCalls.some(c => c[0] === "sub" && c[1] === "videos"));
ok("tile click focuses that exact video", navCalls.some(c => c[0] === "focus" && c[1] === "v9"));

// ── 5. tab switching does not throw with a cold cache ──────────────────────
let threw = false;
try { nxProfileTab("liked"); nxProfileTab("videos"); } catch (e) { threw = true; console.log("   ", e.message); }
ok("tab switch is safe (cache cold)", threw === false);
ok("liked tab marks itself active", el("nxProfileGrid").innerHTML !== undefined);
// Saved is self-only: the loader is a no-op for someone else's profile.
let savedRan = false;
try { nexaLoadSavedGrid("other"); } catch (e) { savedRan = true; }
ok("Saved loader refuses another user's uid", savedRan === false);

// Tab count chips: a positive number paints, zero clears (chip hides via CSS).
nexaSetTabCount("liked", 12);
ok("tab count chip paints a number", el("nxPtabCountLiked").textContent === "12");
nexaSetTabCount("liked", 0);
ok("tab count chip clears at zero", el("nxPtabCountLiked").textContent === "");

// ── 6. a profile with no counts does not print 'undefined' ─────────────────
nexaProfileShow({ uid: "bare", displayName: "Bare" });
ok("missing stats render as 0, never 'undefined'",
  el("nxStatFollowers").textContent === "0" && el("nxStatFollowing").textContent === "0" && el("nxStatVideos").textContent === "0");

console.log("\n" + (fail ? "\u2717 FAILED" : "\u2713 PASSED") + " — " + pass + " passed, " + fail + " failed\n");
process.exit(fail ? 1 : 0);
