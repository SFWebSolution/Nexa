/**
 * Shared-media grid — view-once exclusion + document cards.
 *
 * Two product rules that are easy to regress silently:
 *   1. View-once media must NEVER appear in Chat Info → shared media. Listing
 *      it there defeats the entire point of "view once" — the recipient could
 *      simply re-open the thumbnail forever.
 *   2. Photos, videos AND documents shared in the chat DO belong in the grid.
 *
 * These tests run the REAL loadMediaGrid() against a DOM stub and assert what
 * actually lands in the grid, so they fail if the filter or a branch changes.
 *
 * Run: node tests/media-grid-files.test.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "app-main.js"), "utf8").replace(/\r\n/g, "\n");

function grab(name) {
  const start = SRC.indexOf("function " + name + "(");
  if (start < 0) throw new Error("function not found: " + name);
  const open = SRC.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") {
      depth--;
      if (depth === 0) return SRC.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced function: " + name);
}

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name);
  console.log("  ✗ " + name);
}

// ── Minimal DOM stub: only what loadMediaGrid touches ──────────────────────
function makeEl(tag) {
  return {
    tagName: tag,
    className: "",
    innerHTML: "",
    title: "",
    children: [],
    _listeners: {},
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
    click() { (this._listeners.click || []).forEach((f) => f()); },
  };
}

function runGrid(messages) {
  const grid = makeEl("div");
  const opened = [];
  const sandbox = {
    console,
    allMessages: messages,
    document: {
      getElementById: (id) => (id === "mediaGrid" ? grid : makeEl("div")),
      createElement: (tag) => makeEl(tag),
    },
    // Real helpers, so the rendering path is genuine.
    safeMediaUrl: (u) => (/^(https?:|blob:|data:(image|video|audio)\/)/i.test((u || "").trim()) ? u : ""),
    escapeHtml: (s) => String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;"),
    fileIconFor: () => "📎",
    viewImg: (u) => opened.push({ kind: "image", url: u }),
    viewVideo: (u) => opened.push({ kind: "video", url: u }),
    openMediaViewer: (u, kind, opts) => opened.push({ kind, url: u, opts }),
  };
  vm.createContext(sandbox);
  vm.runInContext(grab("loadMediaGrid"), sandbox);
  sandbox.loadMediaGrid();
  return { grid, opened };
}

const img = (id, extra) => ({ id, image: "https://res.cloudinary.com/x/" + id + ".png", ...extra });
const vid = (id, extra) => ({ id, video: "https://res.cloudinary.com/x/" + id + ".mp4", ...extra });
const file = (id, name, extra) => ({
  id, fileUrl: "https://res.cloudinary.com/x/" + id + ".pdf", fileName: name, fileSize: 2048, ...extra,
});

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── view-once media is never listed ──");
{
  const { grid } = runGrid([
    img("normal"),
    img("vo-image", { isViewOnce: true }),
    vid("vo-video", { isViewOnce: true }),
    file("vo-file", "secret.pdf", { isViewOnce: true }),
  ]);

  ok("only the normal photo renders", grid.children.length === 1);
  const html = grid.children.map((c) => c.innerHTML).join("");
  ok("no view-once image thumbnail", !html.includes("vo-image"));
  ok("no view-once video thumbnail", !html.includes("vo-video"));
  ok("no view-once file card", !html.includes("secret.pdf"));
  ok("the normal photo IS present", html.includes("normal"));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── a grid of ONLY view-once media is empty ──");
{
  const { grid } = runGrid([
    img("a", { isViewOnce: true }),
    vid("b", { isViewOnce: true }),
  ]);
  ok("renders the empty state, not a thumbnail", grid.children.length === 0);
  ok("empty state copy is shown", /No media shared/.test(grid.innerHTML));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── photos, videos and documents all appear ──");
{
  const { grid } = runGrid([
    img("p1"), vid("v1"), file("f1", "Report.pdf"), file("f2", "notes.txt"),
  ]);
  ok("four cards rendered (2 media + 2 files)", grid.children.length === 4);

  const html = grid.children.map((c) => c.innerHTML).join("");
  ok("photo thumbnail present", html.includes("p1.png"));
  ok("video thumbnail present", html.includes("v1.mp4"));
  ok("pdf file card present", html.includes("Report.pdf"));
  ok("txt file card present", html.includes("notes.txt"));

  const fileCards = grid.children.filter((c) => /media-file-card/.test(c.innerHTML));
  ok("file cards use .media-file-card", fileCards.length === 2);
  ok("file cards are marked .media-file-thumb",
    fileCards.every((c) => /media-file-thumb/.test(c.className)));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── a file card opens the download-first viewer ──");
{
  const { grid, opened } = runGrid([file("f1", "Report.pdf")]);
  ok("one card rendered", grid.children.length === 1);
  grid.children[0].click();
  ok("clicking opens a 'file' viewer", opened.length === 1 && opened[0].kind === "file");
  ok("the viewer gets the real URL", opened[0].url === "https://res.cloudinary.com/x/f1.pdf");
  ok("the viewer gets the display name", opened[0].opts.filename === "Report.pdf");
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── an audio document is flagged for the inline player ──");
{
  const { grid, opened } = runGrid([file("a1", "memo.mp3")]);
  grid.children[0].click();
  ok("mp3 is flagged isAudioFile", opened[0].opts.isAudioFile === true);

  const { grid: g2, opened: o2 } = runGrid([file("d1", "Report.pdf")]);
  g2.children[0].click();
  ok("pdf is NOT flagged isAudioFile", o2[0].opts.isAudioFile === false);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── a message that is BOTH an image and a file is not doubled ──");
{
  const both = { id: "x", image: "https://res.cloudinary.com/x/x.png", fileUrl: "https://res.cloudinary.com/x/x.png" };
  const { grid } = runGrid([both]);
  ok("counted once, as a photo", grid.children.length === 1);
  ok("rendered as an image thumb", /<img /.test(grid.children[0].innerHTML));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── file names are HTML-escaped ──");
{
  const { grid } = runGrid([file("f1", '<img src=x onerror=alert(1)>.pdf')]);
  const html = grid.children[0].innerHTML;
  ok("a crafted filename cannot inject an element", !/<img src=x/.test(html));
  ok("it is escaped instead", /&lt;img/.test(html));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n─────────────────────────────────────────────");
console.log(`TOTAL: ${pass} passed, ${fail} failed`);
if (fail) {
  console.log("Failed: " + failures.join(", "));
  process.exit(1);
}
