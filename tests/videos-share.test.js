// Functional harness for the Nexa Videos share flow + interaction
// notifications. Loads the REAL nexa-videos.js in a vm with a compact DOM +
// Firestore stub and asserts:
//   • a share counts ONCE per user per video (like a like): the first completed
//     share advances the count, every later share of the same video does NOT
//   • a dismissed share sheet / failed clipboard write never counts
//   • a lagging feed snapshot cannot wipe the count we just painted
//   • likes and shares push a notification to the author (never to yourself)
//   • posting a video pushes NOTHING
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const code = fs.readFileSync(path.join(ROOT, "nexa-videos.js"), "utf8");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  \u2713 " + n); } else { fail++; console.log("  \u2717 " + n); } };
const eq = (n, got, want) => ok(n + " (got " + JSON.stringify(got) + ")", got === want);

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
    const self = this;
    this.classList = {
      add: (...c) => c.forEach(x => self._classes.add(x)),
      remove: (...c) => c.forEach(x => self._classes.delete(x)),
      contains: (c) => self._classes.has(c),
      toggle: (c, f) => { const has = self._classes.has(c); const on = f === undefined ? !has : !!f; on ? self._classes.add(c) : self._classes.delete(c); return on; },
    };
  }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  load() {}
  focus() { this._focused = true; }
  select() {}
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
  querySelectorAll(s) { const out = []; walk(this, out, splitSelector(s)); return out; }
  closest(s) { let n = this; while (n) { if (n instanceof El && matchesSimple(n, splitSelector(s).slice(-1)[0])) return n; n = n.parentNode; } return null; }
}
function walk(root, out, parts) {
  for (const c of root.children) {
    if (!(c instanceof El)) continue;
    if (matchesChain(c, parts)) out.push(c);
    walk(c, out, parts);
  }
}
function register(n) {
  if (!(n instanceof El)) return;
  if (n.id) document._byId[n.id] = n;
  n.children.forEach(register);
}
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
  execCommand: () => false,
};

// ── Firestore stub ──────────────────────────────────────────────────────────
const shareUpdates = [];   // every { shares: increment(n) } written
const pushes = [];         // every sendPushNotification(...)
const shareMarks = new Set();  // "videoId/shares/uid" markers already claimed
let videosById = {};
const db = {
  collection: () => ({
    orderBy: () => ({ limit: () => ({ onSnapshot: (cb) => { feedSnapCb = cb; return () => {}; } }) }),
    startAfter: () => ({ limit: () => ({ get: () => Promise.resolve({ forEach() {}, size: 0, empty: true }) }) }),
    doc: (id) => ({
      id,
      get: () => Promise.resolve({ exists: true, id, data: () => videosById[id] || {} }),
      update: (patch) => { if (patch && patch.shares) shareUpdates.push(patch.shares); return Promise.resolve(); },
      delete: () => Promise.resolve(),
      collection: (name) => ({
        doc: (sub) => {
          const key = id + "/" + name + "/" + sub;
          return {
            _key: key,
            get: () => Promise.resolve({ exists: name === "shares" ? shareMarks.has(key) : false }),
            set: () => { shareMarks.add(key); return Promise.resolve(); },
            delete: () => { shareMarks.delete(key); return Promise.resolve(); },
          };
        },
        add: () => Promise.resolve({ id: "c1" }),
        orderBy: () => ({ limit: () => ({ onSnapshot: () => () => {} }) }),
      }),
    }),
    where: () => ({ limit: () => ({ onSnapshot: () => () => {} }) }),
  }),
  runTransaction: (fn) => fn({
    get: (ref) => Promise.resolve({ exists: !!(ref && ref._key) && shareMarks.has(ref._key) }),
    set: (ref) => { if (ref && ref._key) shareMarks.add(ref._key); },
    update: () => {}, delete: () => {},
  }),
  batch: () => ({ delete() {}, commit: () => Promise.resolve() }),
  fieldValue: { increment: (n) => ({ __inc: n }) },
};
let feedSnapCb = null;

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
  sendPushNotification: (...a) => pushes.push(a),
  uploadFile: () => Promise.resolve("https://res.cloudinary.com/x/video/upload/a.mp4"),
  nexaConfirm: () => Promise.resolve(true),
};
sandbox.window = sandbox;
sandbox.navigator = { share: null, clipboard: null };
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: "nexa-videos.js" });

// ── seed feed ───────────────────────────────────────────────────────────────
const root = new El("div"); root.id = "nexaVideosRoot"; document._byId["nexaVideosRoot"] = root; document.body.appendChild(root);
videosById = {
  v1: { uid: "author1", authorName: "Ada", authorPhoto: "p", videoUrl: "https://res.cloudinary.com/x/video/upload/v1.mp4", caption: "clip", music: "", duration: 30, createdAt: Date.now(), views: 0, likes: 0, commentsCount: 0, shares: 0 },
  mine: { uid: "me", authorName: "Me", authorPhoto: "p", videoUrl: "https://res.cloudinary.com/x/video/upload/m.mp4", caption: "mine", music: "", duration: 10, createdAt: Date.now(), views: 0, likes: 0, commentsCount: 0, shares: 0 },
  // A count whose ROUNDED label ("1.2K") would swallow a +1 — the exact case
  // the user hit ("I share, I share again, it still reads the same").
  big: { uid: "author1", authorName: "Ada", authorPhoto: "p", videoUrl: "https://res.cloudinary.com/x/video/upload/b.mp4", caption: "big", music: "", duration: 20, createdAt: Date.now(), views: 0, likes: 0, commentsCount: 0, shares: 1299 },
  v2: { uid: "author1", authorName: "Ada", authorPhoto: "p", videoUrl: "https://res.cloudinary.com/x/video/upload/2.mp4", caption: "two", music: "", duration: 12, createdAt: Date.now(), views: 0, likes: 0, commentsCount: 0, shares: 0 },
  v3: { uid: "author1", authorName: "Ada", authorPhoto: "p", videoUrl: "https://res.cloudinary.com/x/video/upload/3.mp4", caption: "three", music: "", duration: 9, createdAt: Date.now(), views: 0, likes: 0, commentsCount: 0, shares: 0 },
};
const snapOf = (ids) => ({ forEach: (fn) => ids.forEach(id => fn({ id, data: () => videosById[id] })) });
sandbox.window.NexaVideos.open();
feedSnapCb(snapOf(["v1", "mine", "big", "v2", "v3"]));

const feed = document.getElementById("nvFeed");
const card = feed.querySelector('.nv-card[data-id="v1"]');
const label = () => document.getElementById("nvShareCount-v1").textContent;
const clickShare = () => feed.dispatch("click", { target: card.querySelector('[data-act="share"]'), clientX: 350 });

function done() {
  console.log("\n" + (fail ? "\u2717 FAILED" : "\u2713 PASSED") + " — " + pass + " passed, " + fail + " failed\n");
  process.exit(fail ? 1 : 0);
}

// ── 1. the FIRST share counts once and notifies the author ─────────────────
sandbox.navigator.share = () => Promise.resolve();
clickShare();
setTimeout(() => {
  eq("first share counts once", label(), "1");
  eq("first share writes one increment", shareUpdates.length, 1);
  eq("sharing notifies the author", pushes.filter(p => p[3] && p[3].isVideoShare && p[2] === "author1").length, 1);

  // ── 2. a SECOND share by the same user must NOT re-count (once per user) ──
  const w1 = shareUpdates.length, p1 = pushes.length;
  clickShare();
  setTimeout(() => {
    eq("a second share does NOT re-count (once per user)", label(), "1");
    eq("a second share writes nothing", shareUpdates.length, w1);
    eq("a second share notifies nobody again", pushes.length, p1);

    const v2card = feed.querySelector('.nv-card[data-id="v2"]');
    const v2label = () => document.getElementById("nvShareCount-v2").textContent;
    const clickShareV2 = () => feed.dispatch("click", { target: v2card.querySelector('[data-act="share"]'), clientX: 350 });

    // ── 3. a dismissed share sheet must NOT count ──────────────────────────
    const before = shareUpdates.length, pbefore = pushes.length;
    sandbox.navigator.share = () => { const e = new Error("cancelled"); e.name = "AbortError"; return Promise.reject(e); };
    clickShareV2();
    setTimeout(() => {
      eq("a cancelled share sheet writes nothing", shareUpdates.length, before);
      eq("a cancelled share sheet notifies nobody", pushes.length, pbefore);

      // ── 4. a double tap on a FRESH video counts exactly ONCE ────────────
      const resolvers = [];
      sandbox.navigator.share = () => new Promise(r => { resolvers.push(r); });
      const w0 = shareUpdates.length;
      clickShareV2(); clickShareV2();  // both while the first is still open
      setTimeout(() => {
        ok("a double tap opens only ONE share sheet", resolvers.length === 1);
        resolvers.forEach(r => r());
        setTimeout(() => {
          eq("a double tap counts ONCE", shareUpdates.length, w0 + 1);
          eq("a double tap advances the label by one", v2label(), "1");

          // ── 5. a lagging snapshot cannot wipe the painted count ──────────
          const keep = label();
          feedSnapCb(snapOf(["v1", "v2", "v3", "mine", "big"]));   // server still says shares:0
          eq("a stale snapshot does not reset the count", label(), keep);

          // ── 6. clipboard fallback (no Web Share API) counts a fresh video ─
          let copied = null;
          sandbox.navigator.share = null;
          sandbox.navigator.clipboard = { writeText: (t) => { copied = t; return Promise.resolve(); } };
          const v3card = feed.querySelector('.nv-card[data-id="v3"]');
          feed.dispatch("click", { target: v3card.querySelector('[data-act="share"]'), clientX: 350 });
          setTimeout(() => {
            ok("clipboard fallback copies the share link", /watch\.html\?v=v3/.test(copied || ""));
            eq("clipboard fallback counts the fresh video", document.getElementById("nvShareCount-v3").textContent, "1");
            // A second clipboard share of the same video must not re-count.
            const w3 = shareUpdates.length;
            feed.dispatch("click", { target: v3card.querySelector('[data-act="share"]'), clientX: 350 });
            setTimeout(() => {
              eq("a second clipboard share does NOT re-count", shareUpdates.length, w3);

              // ── 7. sharing your OWN video notifies nobody ────────────────
              const mineCard = feed.querySelector('.nv-card[data-id="mine"]');
              const pb = pushes.length;
              feed.dispatch("click", { target: mineCard.querySelector('[data-act="share"]'), clientX: 350 });
              setTimeout(() => {
                eq("sharing your own video notifies nobody", pushes.length, pb);

                // ── 8. a like notifies the author, an unlike does not ───────
                const lb = pushes.length;
                feed.dispatch("click", { target: card.querySelector('[data-act="like"]'), clientX: 350 });
                setTimeout(() => {
                  const likePushes = pushes.slice(lb).filter(p => p[3] && p[3].isVideoLike);
                  eq("liking notifies the author once", likePushes.length, 1);
                  eq("the like push targets the author", likePushes[0][2], "author1");

                  // ── 9. an exact count still advances past a rounded label ──
                  // `big` starts at 1299 ("1.3K" rounds the same either way);
                  // one share must carry the EXACT count to 1300, so the label
                  // must NOT be re-parsed from the rounded text.
                  const bigCard = feed.querySelector('.nv-card[data-id="big"]');
                  const bigLabel = () => document.getElementById("nvShareCount-big").textContent;
                  eq("a large count starts on a rounded label", bigLabel(), "1.3K");
                  feed.dispatch("click", { target: bigCard.querySelector('[data-act="share"]'), clientX: 350 });
                  setTimeout(() => {
                    eq("one share advances the exact count across a rounding boundary", bigLabel(), "1.3K");
                    const wbig = shareUpdates.length;
                    feed.dispatch("click", { target: bigCard.querySelector('[data-act="share"]'), clientX: 350 });
                    setTimeout(() => {
                      eq("a repeat share of the big video still does not re-count", shareUpdates.length, wbig);

                      // ── 10. posting a video pushes NOTHING ───────────────
                      ok("the 'posted a new video' fan-out is gone", !/posted a new video/.test(code) && !/notifyConnections/.test(code));

                      // ── 11. source invariants ────────────────────────────
                      ok("share counts are kept exactly (not re-parsed from the label)",
                        /function exactShares\(v\)/.test(code) && /function bumpShare\(id\)/.test(code));
                      ok("a share is claimed once per user (idempotent marker)",
                        /function claimShare\(id\)/.test(code) && /collection\('shares'\)\.doc\(myUid\(\)\)/.test(code));
                      ok("the share button is guarded against a double tap",
                        /if \(state\.sharing\[id\]\) return;/.test(code));

                      done();
                    }, 30);
                  }, 30);
                }, 30);
              }, 30);
            }, 30);
          }, 30);
        }, 30);
      }, 30);
    }, 30);
  }, 30);
}, 30);
