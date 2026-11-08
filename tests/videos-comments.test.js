// Functional harness for the Nexa Videos comment system: likes, replies
// (threading), reply notifications and delete. Loads the REAL nexa-videos.js in
// a vm with a compact DOM + Firestore stub.
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const code = fs.readFileSync(path.join(ROOT, "nexa-videos.js"), "utf8");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  \u2713 " + n); } else { fail++; console.log("  \u2717 " + n); } };
const eq = (n, got, want) => ok(n + " (got " + JSON.stringify(got) + ")", got === want);

// ── mini DOM (same shape as videos-player.test.js) ──────────────────────────
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
};

// ── Firestore stub (comments + comment_likes + transactions) ────────────────
let commentsSnapCb = null;
const txCalls = [];
const pushes = [];
const docs = { comments: {}, likes: {} };   // comments[id]=data, likes["cid_uid"]=true
const refFor = (cid) => ({ id: cid, get: () => Promise.resolve({ exists: !!docs.comments[cid], data: () => docs.comments[cid] }) });
const commentsCol = {
  orderBy: () => ({ limit: () => ({ onSnapshot: (cb) => { commentsSnapCb = cb; return () => {}; } }) }),
  add: (d) => { const id = "c" + (Object.keys(docs.comments).length + 1); docs.comments[id] = d; return Promise.resolve({ id }); },
  doc: (cid) => Object.assign(refFor(cid), { delete: () => { delete docs.comments[cid]; return Promise.resolve(); } }),
};
const likesCol = {
  doc: (lid) => ({
    set: () => { docs.likes[lid] = true; return Promise.resolve(); },
    delete: () => { delete docs.likes[lid]; return Promise.resolve(); },
    get: () => Promise.resolve({ exists: !!docs.likes[lid] }),
  }),
  where: () => ({ where: () => ({ get: () => Promise.resolve({ forEach: (fn) => Object.keys(docs.likes).forEach(k => { if (docs.likes[k]) fn({ id: k, data: () => ({ uid: k.split("_").pop(), cid: k.split("_").slice(0, -1).join("_") }) }); }) }) }) }),
};
const videoDoc = {
  collection: (name) => (name === "comments" ? commentsCol : likesCol),
  update: () => Promise.resolve(),
};
const db = {
  collection: (name) => ({
    orderBy: () => ({ limit: () => ({ onSnapshot: () => () => {} }) }),
    startAfter: () => ({ limit: () => ({ get: () => Promise.resolve({ forEach() {}, size: 0, empty: true }) }) }),
    doc: () => videoDoc,
    where: () => ({ limit: () => ({ onSnapshot: () => () => {} }) }),
  }),
  runTransaction: (fn) => fn({
    get: (ref) => ref.get(),
    set: () => { txCalls.push(["set"]); },
    update: () => { txCalls.push(["update"]); },
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
  sendPushNotification: (...a) => pushes.push(a),
  uploadFile: () => Promise.resolve("https://res.cloudinary.com/x/video/upload/a.mp4"),
  nexaConfirm: () => Promise.resolve(true),
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: "nexa-videos.js" });

// ── seed a feed so the comments sheet can open on v1 ────────────────────────
const root = new El("div"); root.id = "nexaVideosRoot"; document._byId["nexaVideosRoot"] = root; document.body.appendChild(root);
videosById = {
  v1: { uid: "author1", authorName: "author", authorPhoto: "p", videoUrl: "https://res.cloudinary.com/x/video/upload/v1.mp4", caption: "c", music: "", duration: 30, createdAt: Date.now(), views: 0, likes: 1, commentsCount: 2, shares: 0 },
};
let feedSnapCb = null;
// re-point the feed listener capture
sandbox.db.collection = (name) => ({
  orderBy: () => ({ limit: () => ({ onSnapshot: (cb) => { feedSnapCb = cb; return () => {}; } }) }),
  startAfter: () => ({ limit: () => ({ get: () => Promise.resolve({ forEach() {}, size: 0, empty: true }) }) }),
  doc: () => videoDoc,
  where: () => ({ limit: () => ({ onSnapshot: () => () => {} }) }),
});
sandbox.window.NexaVideos.open();
feedSnapCb({ forEach: (fn) => fn({ id: "v1", data: () => videosById.v1 }) });

function commentSnap(items) { return { forEach: (fn) => items.forEach(c => fn({ id: c.id, data: () => c })) }; }

// ── 1. open the comments sheet ──────────────────────────────────────────────
sandbox.window.NexaVideos.openComments("v1");
const sheet = document.getElementById("nvCommentsSheet");
ok("comments sheet exists + is active", sheet && sheet._classes.has("active"));
ok("reply chip starts hidden", document.getElementById("nvCommentReplyChip").style.display === "none");

// ── 2. render: like count + Reply on every comment, Delete only on mine ─────
docs.comments = {
  c1: { uid: "other1", name: "Ada", photo: "p", text: "nice one", createdAt: Date.now() - 5000, likes: 2 },
  c2: { uid: "me", name: "Me", photo: "p", text: "thanks!", createdAt: Date.now() - 4000, likes: 0 },
};
commentsSnapCb(commentSnap([
  { id: "c1", uid: "other1", name: "Ada", photo: "p", text: "nice one", createdAt: Date.now() - 5000, likes: 2 },
  { id: "c2", uid: "me", name: "Me", photo: "p", text: "thanks!", createdAt: Date.now() - 4000, likes: 0 },
]));
const list = document.getElementById("nvCommentsList");
const c1 = list.querySelector('.nv-comment[data-id="c1"]');
const c2 = list.querySelector('.nv-comment[data-id="c2"]');
ok("every comment shows a Like button", !!c1.querySelector(".nv-comment-like") && !!c2.querySelector(".nv-comment-like"));
ok("every comment shows a Reply button", c1.querySelectorAll(".nv-comment-act").some(b => /Reply/.test(b.textContent)));
ok("like count renders on the comment", /2/.test(c1.querySelector(".nv-comment-like").textContent));
ok("Delete shows only on my own comment", !c1.querySelector(".nv-comment-del") && !!c2.querySelector(".nv-comment-del"));

// ── 3. like a comment → transaction + optimistic paint ──────────────────────
txCalls.length = 0;
sandbox.window.nexaVideosLikeComment("c1");
setTimeout(() => {
  const c1b = document.getElementById("nvCommentsList").querySelector('.nv-comment[data-id="c1"]');
  ok("liking a comment runs a transaction", txCalls.length >= 1);
  ok("liked comment paints the heart", c1b.querySelector(".nv-comment-like")._classes.has("liked"));
  ok("like count increments optimistically", /3/.test(c1b.querySelector(".nv-comment-like").textContent));

  // ── 4. reply → chip shows, then sends with replyTo + notification ─────────
  sandbox.window.nexaVideosReplyComment("c1");
  const chip = document.getElementById("nvCommentReplyChip");
  ok("reply chip becomes visible", chip.style.display === "flex");
  ok("reply chip names the parent author", /Ada/.test(document.getElementById("nvCommentReplyText").textContent));
  document.getElementById("nvCommentInput").value = "agreed!";
  sandbox.window.nexaVideosSendComment();
  setTimeout(() => {
    const added = Object.values(docs.comments).find(c => c.text === "agreed!");
    ok("reply stores replyTo = parent id", added && added.replyTo === "c1");
    ok("reply stores the parent name for the @tag", added && added.replyToName === "Ada");
    ok("reply chip hides after sending", document.getElementById("nvCommentReplyChip").style.display === "none");
    ok("replying notifies the parent author", pushes.some(p => p[2] === "other1"));

    // ── 5. threading: the reply renders indented under its parent ────────────
    commentsSnapCb(commentSnap([
      { id: "c1", uid: "other1", name: "Ada", photo: "p", text: "nice one", createdAt: Date.now() - 5000, likes: 2 },
      { id: "c2", uid: "me", name: "Me", photo: "p", text: "thanks!", createdAt: Date.now() - 4000, likes: 0 },
      { id: "c3", uid: "me", name: "Me", photo: "p", text: "agreed!", createdAt: Date.now() - 1000, likes: 0, replyTo: "c1", replyToName: "Ada" },
    ]));
    const kids = document.getElementById("nvCommentsList").querySelectorAll(".nv-comment-child");
    ok("a reply renders as a child comment", kids.length === 1 && kids[0].getAttribute("data-id") === "c3");
    ok("a reply shows the @parent tag", /@Ada/.test(kids[0].querySelector(".nv-comment-replyto").textContent));

    // ── 6. top-level comment notifies the VIDEO author ──────────────────────
    pushes.length = 0;
    sandbox.window.nexaVideosCancelCommentReply();
    document.getElementById("nvCommentInput").value = "great clip";
    sandbox.window.nexaVideosSendComment();
    setTimeout(() => {
      ok("top-level comment notifies the video author", pushes.some(p => p[2] === "author1"));

      // ── 7. delete removes it ─────────────────────────────────────────────
      sandbox.window.nexaVideosDeleteComment("c2");
      setTimeout(() => {
        ok("delete removes the comment doc", !docs.comments["c2"]);
        console.log("\n" + (fail ? "\u2717 FAILED" : "\u2713 PASSED") + " — " + pass + " passed, " + fail + " failed\n");
        process.exit(fail ? 1 : 0);
      }, 20);
    }, 20);
  }, 20);
}, 20);
