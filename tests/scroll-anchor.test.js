/**
 * Scroll anchoring — functional tests.
 *
 * Paging older history prepends bubbles, which changes scrollHeight. Restoring
 * by "newHeight - oldHeight + oldTop" drifts whenever a bubble's real height
 * differs from what was measured before the load (media, wrapped text, images
 * that decode late) — that drift is the "messages scatter / jump while
 * scrolling" bug. The fix pins the top-most visible bubble and re-aligns that
 * same bubble after the render.
 *
 * These tests extract the REAL capture/restore helpers from app-main.js and run
 * them against a minimal fake DOM (getBoundingClientRect + querySelectorAll).
 * No browser, no Firebase.
 *
 * Run: node tests/scroll-anchor.test.js
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
  throw new Error("unterminated function: " + name);
}

// ── Minimal DOM stubs ─────────────────────────────────────────────────────
// Element positions are stored in CONTENT coordinates. Scrolling moves the
// CONTENT, not the container: the container's viewport rect is fixed, and an
// element's viewport top is `containerTop + contentY - scrollTop`.
function makeEl(id, contentY, height) {
  return {
    dataset: { msgId: id },
    contentY,
    height,
    _box: null,
    getBoundingClientRect() {
      const top = this._box._top + this.contentY - this._box.scrollTop;
      return { top, bottom: top + this.height, height: this.height };
    },
  };
}

function makeBox({ top = 100, clientHeight = 400, scrollTop = 0, scrollHeight = 2000 } = {}) {
  const box = {
    scrollTop,
    clientHeight,
    scrollHeight,
    _top: top,
    style: { scrollBehavior: "smooth" },
    _els: [],
    add(...els) {
      els.forEach((e) => { e._box = box; });
      box._els = box._els.concat(els);
      return box;
    },
    getBoundingClientRect() {
      return { top: this._top, bottom: this._top + this.clientHeight };
    },
    querySelectorAll(sel) {
      if (sel === ".msg[data-msg-id]") return this._els;
      return [];
    },
    querySelector(sel) {
      const m = sel.match(/data-msg-id="(.+?)"/);
      if (!m) return null;
      return this._els.find((e) => e.dataset.msgId === m[1]) || null;
    },
  };
  return box;
}

// Vertical gap between the anchored element's viewport top and the box's top.
function visualOffset(box, el) {
  return el.getBoundingClientRect().top - box.getBoundingClientRect().top;
}

const sandbox = {
  CSS: { escape: (s) => String(s).replace(/"/g, '\\"') },
};
vm.createContext(sandbox);
vm.runInContext([grab("captureScrollAnchor"), grab("restoreScrollAnchor")].join("\n"), sandbox);
const { captureScrollAnchor, restoreScrollAnchor } = sandbox;

let pass = 0, fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n    ${e.message}`);
  }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || ""} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function ok(v, msg) { if (!v) throw new Error(msg || "expected truthy"); }

console.log("\n── Scroll anchoring ──");

// 1. Anchor picks the first bubble whose bottom is past the viewport top.
t("capture picks the top-most visible bubble", () => {
  const box = makeBox({ top: 100, scrollTop: 0 });
  box.add(makeEl("a", 0, 60), makeEl("b", 70, 60), makeEl("c", 140, 60));
  const a = captureScrollAnchor(box);
  eq(a.id, "a", "first bubble is the one at the top of the viewport");
  eq(a.offset, 0, "flush with the container top");
});

// 2. A bubble fully scrolled past the top is skipped (bottom <= boxTop).
t("capture skips bubbles fully above the viewport", () => {
  // scrollTop 100 pushes a (0-50) and b (50-90) entirely above the box top.
  const box = makeBox({ top: 100, scrollTop: 100 });
  box.add(makeEl("a", 0, 50), makeEl("b", 50, 40), makeEl("c", 95, 40));
  eq(captureScrollAnchor(box).id, "c");
});

// 3. The offset is relative to the box top, not the document.
t("capture stores the offset relative to the container", () => {
  // Element sits 10px below the container's viewport top.
  const box = makeBox({ top: 250 });
  box.add(makeEl("a", 10, 60));
  eq(captureScrollAnchor(box).offset, 10);
});

// 4. Empty list yields no anchor rather than throwing.
t("capture returns null for an empty list", () => {
  eq(captureScrollAnchor(makeBox()), null);
});

// 5. Restore realigns the SAME bubble to the same visual offset.
t("restore realigns the anchored bubble", () => {
  const box = makeBox({ top: 100, scrollTop: 300 });
  const el = makeEl("b", 350, 60); // sits 250px into the viewport pre-load
  box.add(el);
  const anchor = captureScrollAnchor(box);
  eq(anchor.id, "b");
  const wanted = anchor.offset;

  // A 480px page is prepended: "b" moves down in CONTENT space.
  el.contentY = 830;
  restoreScrollAnchor(box, anchor);
  eq(visualOffset(box, el), wanted, "bubble back at its original visual offset");
  eq(box.scrollTop, 780, "scrolled by exactly the inserted height");
});

// 6. The restore jumps instead of animating (smooth scroll would slide history).
t("restore disables smooth scrolling and restores the previous value", () => {
  const box = makeBox({ top: 100, scrollTop: 0 });
  box.style.scrollBehavior = "smooth";
  const el = makeEl("a", 200, 60);
  box.add(el);
  restoreScrollAnchor(box, { id: "a", offset: 0 });
  eq(box.style.scrollBehavior, "smooth", "previous value restored");
});

// 7. A vanished anchor falls back without throwing.
t("restore tolerates a missing anchor element", () => {
  const box = makeBox();
  restoreScrollAnchor(box, { id: "gone", offset: 5 });
  ok(true);
});

// 8. No anchor means "top of history".
t("restore with no anchor scrolls to the top", () => {
  const box = makeBox({ scrollTop: 900 });
  restoreScrollAnchor(box, null);
  eq(box.scrollTop, 0);
});

// 9. Real media heights do NOT shift the view: the old pixel-math restore would
//    drift here because the prepended block is taller than estimated.
t("realigning is immune to a wrong height estimate", () => {
  const box = makeBox({ top: 0, scrollTop: 0 });
  const el = makeEl("m", 0, 60);
  box.add(el);
  const anchor = captureScrollAnchor(box);
  restoreScrollAnchor(box, anchor);
  const before = box.scrollTop;

  // A photo bubble above decodes to 3x its estimated height.
  el.contentY = 999;
  restoreScrollAnchor(box, anchor);
  eq(box.scrollTop - before, 999, "scrolled by exactly the inserted height");
  eq(visualOffset(box, el), 0, "bubble did not move on screen");
});

console.log("\n── Structural invariants ──");

t("loadOlderMessages uses the anchor, not scrollHeight arithmetic", () => {
  const fn = grab("loadOlderMessages");
  ok(fn.includes("captureScrollAnchor"), "captures an anchor");
  ok(fn.includes("restoreScrollAnchor"), "restores the anchor");
  ok(!fn.includes("scrollHeight - prevHeight"), "old pixel math is gone");
});

t("prepended history does not play the entrance animation", () => {
  ok(
    SRC.includes("if (!_loadingOlderRender) {\n        msgEl.classList.add(\"msg-new\");"),
    "msg-new is gated on !_loadingOlderRender"
  );
});

t(".msg no longer uses content-visibility (it caused the jump)", () => {
  const css = fs.readFileSync(path.join(ROOT, "dashboard.css"), "utf8").replace(/\r\n/g, "\n");
  const block = css.slice(css.indexOf("\n.msg {"), css.indexOf("\n.msg {") + 1200);
  ok(!/content-visibility\s*:\s*auto/.test(block), ".msg must not set content-visibility");
});

t("the chat list keeps content-visibility (uniform 76px rows)", () => {
  const css = fs.readFileSync(path.join(ROOT, "dashboard.css"), "utf8").replace(/\r\n/g, "\n");
  const block = css.slice(css.indexOf("\n.user-item {"), css.indexOf("\n.user-item {") + 800);
  ok(/content-visibility\s*:\s*auto/.test(block), ".user-item keeps content-visibility");
});

console.log(`\n${fail === 0 ? "✓ PASSED" : "✗ FAILED"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
