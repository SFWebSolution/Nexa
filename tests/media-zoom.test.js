/**
 * Media viewer — zoom + in-app download.
 *
 * Extracts the REAL zoom/download engine from app-main.js and runs it in a vm
 * with a small DOM stub. Asserts the behaviour the user asked for:
 *   1. A photo in the viewer can be zoomed (double-tap, wheel, pinch) and panned.
 *   2. Downloading saves the file WITHOUT navigating away from the app.
 *
 * Run: node tests/media-zoom.test.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "app-main.js"), "utf8").replace(/\r\n/g, "\n");
const DASH = fs.readFileSync(path.join(ROOT, "dashboard.html"), "utf8").replace(/\r\n/g, "\n");
const CSS = fs.readFileSync(path.join(ROOT, "dashboard.css"), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name); }
}

// ── extract the engine ─────────────────────────────────────────────────────
const START = SRC.indexOf("const NEXA_ZOOM_MIN");
const END = SRC.indexOf("// Photo bubble / shared-media grid entry point");
if (START < 0 || END < 0 || END <= START) throw new Error("could not locate the zoom engine");
// `const`/`let` bindings don't land on the vm sandbox, so expose the engine
// through a getter shim. This is test-only; production reads them in-scope.
const MODULE = SRC.slice(START, END) + `
;globalThis.__zoom = {
  get mediaZoom() { return mediaZoom; },
  NEXA_ZOOM_MIN, NEXA_ZOOM_MAX,
  attachMediaZoom, resetMediaZoom, setMediaZoom, applyMediaZoom, clampMediaPan,
  nexaMediaFilename, nexaDownloadMedia,
};`;

// ── DOM stub ───────────────────────────────────────────────────────────────
function makeEl(tag) {
  const el = {
    tagName: (tag || "div").toUpperCase(),
    textContent: "", innerHTML: "", value: "", href: "", download: "", rel: "",
    offsetWidth: 800, offsetHeight: 600, clientWidth: 1000, clientHeight: 800,
    style: {}, dataset: {}, _cls: new Set(), _listeners: {},
    classList: {
      add: (c) => el._cls.add(c),
      remove: (c) => el._cls.delete(c),
      toggle: (c, on) => { if (on === undefined ? !el._cls.has(c) : on) el._cls.add(c); else el._cls.delete(c); },
      contains: (c) => el._cls.has(c),
    },
    setAttribute: (k, v) => { el.dataset["attr_" + k] = v; },
    removeAttribute: (k) => { delete el.dataset["attr_" + k]; },
    getAttribute: (k) => (el.dataset["attr_" + k] === undefined ? null : el.dataset["attr_" + k]),
    addEventListener: (t, fn) => { (el._listeners[t] = el._listeners[t] || []).push(fn); },
    removeEventListener: () => {},
    setPointerCapture: () => {}, releasePointerCapture: () => {},
    appendChild: (c) => { el.children.push(c); c.parentNode = el; return c; },
    removeChild: (c) => { el.children = el.children.filter(x => x !== c); },
    click: () => { el._clicked = true; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: el.clientWidth, height: el.clientHeight }),
    querySelector: () => null,
    children: [],
    dispatch(t, ev) { (el._listeners[t] || []).forEach(fn => fn(Object.assign({ preventDefault() {}, stopPropagation() {}, target: el }, ev))); },
  };
  return el;
}

const docEls = {};
const bodyEl = makeEl("body");
const created = [];
const document = {
  body: bodyEl,
  createElement: (t) => { const n = makeEl(t); created.push(n); return n; },
  getElementById: (id) => (docEls[id] = docEls[id] || makeEl("div")),
  querySelector: () => null,
  addEventListener: () => {},
};

const toasts = [];
const sandbox = {
  console, Math, Date, Number, String, Object, Promise, JSON, Map, Set, Array,
  isNaN, isFinite, parseFloat, parseInt, URL, location: { href: "https://nexa.test/" },
  document,
  showNotifToast: (m, t) => toasts.push([m, t]),
  fetchMediaBlobUrl: async (u) => "blob:https://nexa.test/" + Math.random().toString(36).slice(2),
  lucide: { createIcons() {} },
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(MODULE, sandbox, { filename: "zoom-engine.js" });

// ── 1. zoom engine present + wired into the viewer ─────────────────────────
console.log("\n1. zoom engine");
ok("viewer attaches zoom to the photo", /attachMediaZoom\(img, body\)/.test(SRC));
ok("zoom state is reset when the viewer closes", /resetMediaZoom\(\);/.test(SRC.slice(SRC.indexOf("function closeMediaViewer"), SRC.indexOf("function closeMediaViewer") + 500)));
ok("zoom range is 1x..5x", sandbox.__zoom.NEXA_ZOOM_MIN === 1 && sandbox.__zoom.NEXA_ZOOM_MAX === 5);

// ── 2. double-tap toggles zoom, at the tap point ───────────────────────────
console.log("\n2. double-tap");
const host = makeEl("div");
const img = makeEl("img");
sandbox.__zoom.attachMediaZoom(img, host);
ok("starts at fit (scale 1)", sandbox.__zoom.mediaZoom.scale === 1);
img.dispatch("click", { clientX: 400, clientY: 300 });
ok("a single tap does not zoom", sandbox.__zoom.mediaZoom.scale === 1);
img.dispatch("click", { clientX: 400, clientY: 300 });
ok("double-tap zooms to 2.5x", sandbox.__zoom.mediaZoom.scale === 2.5);
ok("the transform is applied to the image", /scale\(2\.5\)/.test(img.style.transform));
ok("the host is flagged as zoomed", host.classList.contains("is-zoomed"));

// ── 3. pan is clamped so the photo cannot be dragged off-screen ────────────
console.log("\n3. pan + clamp");
img.dispatch("pointerdown", { pointerId: 1, clientX: 500, clientY: 400, pointerType: "touch" });
img.dispatch("pointermove", { pointerId: 1, clientX: 50000, clientY: 40000 });
const maxX = (img.offsetWidth * 2.5 - host.clientWidth) / 2;
ok("pan is clamped horizontally", Math.abs(sandbox.__zoom.mediaZoom.x) <= maxX + 1);
img.dispatch("pointerup", { pointerId: 1 });

// ── 4. wheel zoom on desktop ───────────────────────────────────────────────
console.log("\n4. wheel");
const before = sandbox.__zoom.mediaZoom.scale;
host.dispatch("wheel", { deltaY: -100, clientX: 400, clientY: 300 });
ok("wheel up zooms in", sandbox.__zoom.mediaZoom.scale > before);
host.dispatch("wheel", { deltaY: 100, clientX: 400, clientY: 300 });
host.dispatch("wheel", { deltaY: 100, clientX: 400, clientY: 300 });
host.dispatch("wheel", { deltaY: 100, clientX: 400, clientY: 300 });
ok("wheel down never goes below 1x", sandbox.__zoom.mediaZoom.scale >= 1);

// ── 5. reset clears pan too ────────────────────────────────────────────────
console.log("\n5. reset");
sandbox.__zoom.setMediaZoom(3);
sandbox.__zoom.mediaZoom.x = 120; sandbox.__zoom.mediaZoom.y = 90;
sandbox.__zoom.setMediaZoom(1);
ok("zoom back to 1 resets the pan", sandbox.__zoom.mediaZoom.x === 0 && sandbox.__zoom.mediaZoom.y === 0);
ok("transform is cleared on reset", /scale\(1\)/.test(img.style.transform));
sandbox.__zoom.resetMediaZoom();
ok("resetMediaZoom drops the element refs", sandbox.__zoom.mediaZoom.el === null);

// ── 6. a zoomed photo swallows the close tap ───────────────────────────────
console.log("\n6. close guard");
ok("zoomed photo resets instead of closing", /if \(mediaZoom\.scale > 1\.01\) \{ setMediaZoom\(NEXA_ZOOM_MIN\); return; \}/.test(SRC));

// ── 7. in-app download: no navigation, real save ───────────────────────────
console.log("\n7. in-app download");
(async () => {
  const btn = makeEl("button");
  btn.innerHTML = "<svg/>";
  created.length = 0;
  await sandbox.__zoom.nexaDownloadMedia("https://res.cloudinary.com/x/video/upload/a.jpg", "photo.jpg", btn);
  const anchor = created.find(c => c.tagName === "A");
  ok("a temporary <a download> is used", !!anchor && anchor.download === "photo.jpg");
  ok("the anchor points at the fetched blob", /^blob:/.test(anchor.href));
  ok("the anchor is removed afterwards", !bodyEl.children.includes(anchor) && anchor._clicked === true);
  ok("the button is restored after saving", btn.innerHTML === "<svg/>" && !btn.classList.contains("is-busy"));
  ok("the user is told it saved", toasts.some(t => /Saved/.test(t[0])));

  // A CORS failure must still save, not navigate.
  sandbox.fetchMediaBlobUrl = async () => { throw new Error("CORS"); };
  toasts.length = 0;
  created.length = 0;
  await sandbox.__zoom.nexaDownloadMedia("https://other.example/a.pdf", "doc.pdf", null);
  const a2 = created.find(c => c.tagName === "A");
  ok("falls back to the direct URL when the fetch fails", !!a2 && a2.href === "https://other.example/a.pdf");
  ok("still names the file correctly", a2.download === "doc.pdf");

  // Filenames derived from the URL when none is supplied.
  ok("derives an extension from the URL", sandbox.__zoom.nexaMediaFilename("https://x/y/clip.mp4", "video", {}) === "video.mp4");
  ok("keeps an explicit filename", sandbox.__zoom.nexaMediaFilename("https://x/y/a.jpg", "image", { filename: "holiday.jpg" }) === "holiday.jpg");
  ok("falls back to kind+ext without a URL extension", sandbox.__zoom.nexaMediaFilename("https://x/y/abc", "image", {}) === "image.jpg");

  // ── 8. markup + css wiring ───────────────────────────────────────────────
  console.log("\n8. markup + styling");
  ok("download control is a <button>, not a navigating link",
    /<button class="media-viewer-download"/.test(DASH) && !/<a class="media-viewer-download"/.test(DASH));
  ok("the download button calls the in-app saver", /nexaDownloadMedia\(this\.dataset\.mediaUrl/.test(DASH));
  ok("the old target=_blank download link is gone",
    !/mediaViewerDownload[^>]*target="_blank"/.test(DASH));
  ok("file attachments save in place", /class="media-viewer-save-btn"/.test(SRC));
  ok("the profile picture viewer zooms too", /attachMediaZoom\(img, host\)/.test(SRC));
  ok("css marks the zoomed body", /\.media-viewer-body\.is-zoomed/.test(CSS));
  ok("css stops the image being selectable while panning", /user-select: none/.test(CSS));

  console.log("\n" + (failed ? "✗ FAILED" : "✓ PASSED") + ` — ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
