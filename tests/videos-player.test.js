// Functional harness for the Nexa Videos player upgrade.
// Loads the REAL nexa-videos.js in a vm with a compact DOM + Firestore stub and
// exercises: in-place patching (no <video> restart), double-tap seek, duration
// badge, scrubbing, transactional like, and share-on-success.
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const ROOT = require("path").join(__dirname, "..");
const code = fs.readFileSync(path.join(ROOT, "nexa-videos.js"), "utf8");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  \u2713 " + n); } else { fail++; console.log("  \u2717 " + n); } };

// ── mini DOM ────────────────────────────────────────────────────────────────
const VOID = new Set(["img", "input", "br", "hr", "source"]);
class El {
  constructor(tag) {
    this.tagName = (tag || "div").toUpperCase();
    this.children = []; this.parentNode = null;
    this.attrs = {}; this.dataset = {}; this.style = {};
    this._text = ""; this._listeners = {}; this._classes = new Set();
    this.duration = 0; this.currentTime = 0; this.paused = true; this.muted = false;
    this.playbackRate = 1; this._rect = { left: 0, top: 0, width: 360, height: 640 };
    this._played = 0;
    const self = this;
    this.classList = {
      add: (...c) => c.forEach(x => self._classes.add(x)),
      remove: (...c) => c.forEach(x => self._classes.delete(x)),
      contains: (c) => self._classes.has(c),
      toggle: (c, f) => { const has = self._classes.has(c); const on = f === undefined ? !has : !!f; on ? self._classes.add(c) : self._classes.delete(c); return on; },
    };
  }
  play() { this._played++; this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  load() {}
  get className() { return [...this._classes].join(" "); }
  set className(v) { this._classes = new Set(String(v || "").split(/\s+/).filter(Boolean)); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === "class") this.className = v; if (k === "id") { this.id = v; document._byId[v] = this; } }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  get textContent() { if (this.children.length) return this.children.map(c => (c instanceof El ? c.textContent : String(c))).join(""); return this._text; }
  set textContent(v) { this.children = []; this._text = String(v); }
  set innerHTML(html) { this.children = parseHTML(String(html)); this.children.forEach(c => { c.parentNode = this; register(c); }); }
  get innerHTML() { return this.children.map(serialize).join(""); }
  insertAdjacentHTML(pos, html) { const nodes = parseHTML(String(html)); nodes.forEach(n => { n.parentNode = this; register(n); }); if (pos === "beforeend") this.children.push(...nodes); else this.children.unshift(...nodes); }
  appendChild(n) { n.parentNode = this; this.children.push(n); register(n); return n; }
  insertBefore(n, ref) { n.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(n); else this.children.splice(i, 0, n); register(n); return n; }
  remove() { if (this.parentNode) { const i = this.parentNode.children.indexOf(this); if (i >= 0) this.parentNode.children.splice(i, 1); this.parentNode = null; } if (this.id) delete document._byId[this.id]; }
  get firstElementChild() { return this.children.find(c => c instanceof El) || null; }
  get firstChild() { return this.children[0] || null; }
  get nextSibling() { if (!this.parentNode) return null; const i = this.parentNode.children.indexOf(this); return this.parentNode.children[i + 1] || null; }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  removeEventListener(t, fn) { if (this._listeners[t]) this._listeners[t] = this._listeners[t].filter(f => f !== fn); }
  dispatch(t, ev) { ev = ev || {}; ev.type = t; if (!ev.target) ev.target = this; ev.stopPropagation = ev.stopPropagation || (() => {}); ev.preventDefault = ev.preventDefault || (() => {}); (this._listeners[t] || []).forEach(fn => fn(ev)); }
  getBoundingClientRect() { return this._rect; }
  scrollIntoView() {}
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  querySelectorAll(s) { const out = []; const parts = splitSelector(s); walk(this, out, parts); return out; }
  closest(s) { let n = this; while (n) { if (n instanceof El && matchesSimple(n, splitSelector(s).slice(-1)[0])) return n; n = n.parentNode; } return null; }
}
function walk(root, out, parts) {
  for (const c of root.children) {
    if (!(c instanceof El)) continue;
    if (parts.length === 1 ? matchesChain(c, parts) : matchesChain(c, parts)) out.push(c);
    walk(c, out, parts);
  }
}
function register(n) { if (n instanceof El && n.id) document._byId[n.id] = n; }

// selector: only the forms this module uses — compound parts + descendant (space)
function splitSelector(s) { return String(s).trim().split(/\s+/); }
function matchesChain(el, parts) {
  if (!matchesSimple(el, parts[parts.length - 1])) return false;
  let i = parts.length - 2, node = el.parentNode;
  while (i >= 0 && node) { if (node instanceof El && matchesSimple(node, parts[i])) i--; node = node.parentNode; }
  return i < 0;
}
function matchesSimple(el, part) {
  if (!part) return true;
  const tag = (part.match(/^[a-zA-Z][\w-]*/) || [null])[0];
  if (tag && el.tagName !== tag.toUpperCase()) return false;
  const id = (part.match(/#([\w-]+)/) || [])[1];
  if (id && el.id !== id) return false;
  for (const c of (part.match(/\.([\w-]+)/g) || [])) if (!el._classes.has(c.slice(1))) return false;
  const attr = part.match(/\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]/);
  if (attr) { const v = el.getAttribute(attr[1]); if (v === null) return false; if (attr[2] !== undefined && v !== attr[2]) return false; }
  return true;
}
function serialize(n) {
  if (!(n instanceof El)) return String(n);
  const attrs = Object.keys(n.attrs).map(k => ` ${k}="${n.attrs[k]}"`).join("");
  if (VOID.has(n.tagName.toLowerCase())) return `<${n.tagName.toLowerCase()}${attrs}>`;
  return `<${n.tagName.toLowerCase()}${attrs}>${n.children.map(serialize).join("")}</${n.tagName.toLowerCase()}>`;
}
// very small HTML parser for the module's generated markup
function parseHTML(html) {
  const root = []; const stack = [];
  const re = /<\/?([a-zA-Z][\w-]*)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*\/?>/g;
  let last = 0, m;
  const push = (node) => { if (stack.length) { stack[stack.length - 1].children.push(node); node.parentNode = stack[stack.length - 1]; } else root.push(node); };
  while ((m = re.exec(html))) {
    const text = html.slice(last, m.index); last = re.lastIndex;
    if (text.trim()) push(text);
    const closing = m[0][1] === "/";
    const tag = m[1].toLowerCase();
    if (closing) { if (stack.length) stack.pop(); continue; }
    const el = new El(tag);
    (m[2] || "").replace(/([\w-]+)(?:="([^"]*)")?/g, (_, k, v) => { el.attrs[k] = v === undefined ? "" : v; if (k === "class") el.className = v; if (k === "id") el.id = v; return ""; });
    push(el);
    if (!VOID.has(tag) && !/\/>$/.test(m[0])) stack.push(el);
  }
  const tail = html.slice(last); if (tail.trim()) push(tail);
  return root;
}
const document = {
  _byId: {},
  createElement: (t) => new El(t),
  getElementById: (id) => document._byId[id] || null,
  querySelector: (s) => document.body.querySelector(s),
  querySelectorAll: (s) => document.body.querySelectorAll(s),
  body: new El("body"),
  addEventListener() {}, removeEventListener() {},
  visibilityState: "visible",
};

// ── Firestore stub ──────────────────────────────────────────────────────────
const txCalls = [];
function makeDoc(id, data) {
  return {
    id,
    get: () => Promise.resolve({ exists: true, id, data: () => data }),
    update: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    collection: (name) => ({
      doc: () => ({ get: () => Promise.resolve({ exists: false }), set: () => Promise.resolve(), delete: () => Promise.resolve() }),
      add: () => Promise.resolve({ id: "c1" }),
      orderBy: () => ({ limit: () => ({ onSnapshot: () => () => {} }) }),
    }),
  };
}
let feedSnapCb = null;
const db = {
  collection: (name) => ({
    orderBy: () => ({ limit: () => ({ onSnapshot: (cb) => { feedSnapCb = cb; return () => {}; } }) }),
    startAfter: () => ({ limit: () => ({ get: () => Promise.resolve({ forEach() {}, size: 0, empty: true }) }) }),
    doc: (id) => makeDoc(id, videosById[id] || {}),
    where: () => ({ limit: () => ({ onSnapshot: () => () => {} }) }),
  }),
  runTransaction: (fn) => fn({
    get: (ref) => Promise.resolve({ exists: false }),
    set: (ref, d) => { txCalls.push(["set", d]); },
    update: (ref, d) => { txCalls.push(["update", d]); },
    delete: () => { txCalls.push(["delete"]); },
  }).then(() => {}),
  batch: () => ({ delete() {}, commit: () => Promise.resolve() }),
  fieldValue: { increment: (n) => ({ __inc: n }) },
};

let videosById = {};
const store = {};
const sandbox = {
  console, setTimeout, clearTimeout, requestAnimationFrame: (fn) => fn(),
  Math, Date, Number, String, Object, Promise, JSON, Set, Map, Array, parseFloat, parseInt, isNaN, isFinite, encodeURIComponent,
  IntersectionObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
  document, localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
  db,
  lucide: { createIcons() {} },
  escapeHtml: (s) => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
  safeMediaUrl: (u) => u,
  showNotifToast: () => {},
  nexaCurrentUser: { uid: "me", displayName: "Me" },
  nexaMyConnections: {},
  sendPushNotification: () => {},
  uploadFile: () => Promise.resolve("https://res.cloudinary.com/x/video/upload/a.mp4"),
  nexaConfirm: () => Promise.resolve(true),
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: "nexa-videos.js" });

// ── seed feed ───────────────────────────────────────────────────────────────
const root = new El("div"); root.id = "nexaVideosRoot"; document._byId["nexaVideosRoot"] = root; document.body.appendChild(root);
const now = Date.now();
videosById = {
  v1: { uid: "u1", authorName: "one", authorPhoto: "p", videoUrl: "https://res.cloudinary.com/x/video/upload/v1.mp4", caption: "first", music: "", duration: 60, createdAt: now - 1000, views: 0, likes: 5, commentsCount: 2, shares: 1 },
  v2: { uid: "u2", authorName: "two", authorPhoto: "p", videoUrl: "https://res.cloudinary.com/x/video/upload/v2.mp4", caption: "second", music: "", duration: 30, createdAt: now - 2000, views: 0, likes: 3, commentsCount: 0, shares: 0 },
};
function snapshotOf(ids) {
  return { forEach: (fn) => ids.forEach(id => fn({ id, data: () => videosById[id] })) };
}
sandbox.window.NexaVideos.open();
feedSnapCb(snapshotOf(["v1", "v2"]));

const feed = document.getElementById("nvFeed");
const cards = feed.querySelectorAll(".nv-card");
ok("feed renders one card per video", cards.length === 2);
const card1 = feed.querySelector('.nv-card[data-id="v1"]');
const video1 = card1.querySelector(".nv-video");
video1.duration = 60; video1.currentTime = 0;
ok("duration badge shows the clip length", card1.querySelector(".nv-dur").textContent === "1:00");

// ── 1. snapshot patches in place (no restart) ───────────────────────────────
videosById.v1 = Object.assign({}, videosById.v1, { likes: 9 });
feedSnapCb(snapshotOf(["v1", "v2"]));
const card1b = feed.querySelector('.nv-card[data-id="v1"]');
ok("card element is REUSED after a snapshot", card1b === card1);
ok("the <video> element is NEVER recreated (no restart)", card1b.querySelector(".nv-video") === video1);
ok("like count is patched to the new value", card1b.querySelector(".nv-rail-like .nv-rail-count").textContent === "9");

// ── 2. double-tap right seeks +10s, left -10s ───────────────────────────────
function tap(card, clientX) { feed.dispatch("click", { target: card, clientX }); }
tap(card1b, 340); // right zone (width 360 → x=0.94)
tap(card1b, 340);
ok("double-tap right seeks forward 10s", video1.currentTime === 10);
tap(card1b, 20); // left zone
tap(card1b, 20);
ok("double-tap left seeks back 10s", video1.currentTime === 0);
ok("seek pill flashes on the card", !!card1b.querySelector(".nv-seek-pill"));

// ── 3. scrubbing ────────────────────────────────────────────────────────────
const bar = card1b.querySelector(".nv-progress");
bar._rect = { left: 0, top: 0, width: 360, height: 22 };
feed.dispatch("pointerdown", { target: bar, clientX: 180 });
ok("scrub sets currentTime to the dragged ratio", Math.round(video1.currentTime) === 30);
ok("card flags scrubbing for the fat track", card1b._classes.has("nv-scrubbing"));
document._listeners = document._listeners || {};
// release
(document._listeners.pointerup || []).forEach(fn => fn());

// ── 4. transactional like ───────────────────────────────────────────────────
txCalls.length = 0;
const likeBtn = card1b.querySelector(".nv-rail-like");
feed.dispatch("click", { target: likeBtn, clientX: 350 });
// the click path uses e.target.closest('[data-act]')
setTimeout(() => {
  ok("like runs a transaction (marker + count together)", txCalls.some(c => c[0] === "update"));
  ok("optimistic like paints immediately", likeBtn._classes.has("liked"));

  // ── 5. share link + count-on-success ──────────────────────────────────────
  let sharedUrl = null;
  sandbox.navigator = { share: (o) => { sharedUrl = o.url; return Promise.resolve(); }, clipboard: null };
  const shareBtn = card1b.querySelector('[data-act="share"]');
  feed.dispatch("click", { target: shareBtn, clientX: 350 });
  setTimeout(() => {
    ok("share uses the watch.html landing link", /\/watch\.html\?v=v1$/.test(sharedUrl || ""));
    ok("share link points at the canonical host", /^https:\/\/nexa-qydr\.onrender\.com\//.test(sharedUrl || ""));
    console.log("\n" + (fail ? "\u2717 FAILED" : "\u2713 PASSED") + " — " + pass + " passed, " + fail + " failed\n");
    process.exit(fail ? 1 : 0);
  }, 20);
}, 20);
