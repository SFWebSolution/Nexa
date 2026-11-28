/**
 * Moments → Videos feed layout invariants.
 *
 * The feed is a full-bleed, scroll-snapping column that fills the sidebar/phone
 * pane. Its interactive controls (caption, action rail, progress bar) hug the
 * bottom of each card, which collides with the app's fixed mobile bottom nav.
 *
 * These are structural assertions over the real stylesheets — no DOM needed.
 * They exist to catch drift: if the nav height or breakpoint changes in
 * dashboard.css, the clearance reserved in nexa-videos.css must move with it.
 *
 * Run: node tests/videos-layout.test.js
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\r\n/g, "\n");

const VIDEOS_CSS = read("nexa-videos.css");
const DASH_CSS = read("dashboard.css");

let pass = 0, fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    fail++;
    console.log(`  \u2717 ${name}\n    ${e.message}`);
  }
}
function ok(v, msg) { if (!v) throw new Error(msg || "expected truthy"); }

// Pull the body of the mobile nav rule out of dashboard.css so the paired
// constants below are derived from the real source, not hardcoded twice.
// There are several 768px queries in dashboard.css — pick the one that actually
// declares the nav, not merely the first.
function mobileNavRule() {
  const RE = /\.mobile-bottom-nav\s*\{([^}]*)\}/g;
  let m, found = null;
  while ((m = RE.exec(DASH_CSS))) {
    // The real rule declares the fixed positioning; other matches are
    // overrides (e.g. the native backdrop-filter reset).
    if (/position:\s*fixed/.test(m[1])) { found = m; break; }
  }
  ok(found, "dashboard.css: fixed .mobile-bottom-nav rule not found");
  return found[0];
}

// Return the source of every @media (max-width: 768px) { … } block body.
function media768Bodies(css) {
  const bodies = [];
  const re = /@media\s*\(max-width:\s*768px\)\s*\{/g;
  let m;
  while ((m = re.exec(css))) {
    let i = re.lastIndex, depth = 1;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    bodies.push(css.slice(re.lastIndex, i - 1));
  }
  return bodies;
}

// True when `selector` is declared inside any max-width:768px query.
function inside768(css, selector) {
  return media768Bodies(css).some((b) => b.includes(selector));
}

// Everything outside @media blocks. Rule lookups must use this: a responsive
// override such as `#momentsVideosView.active.nv-clear-nav .nv-meta { bottom: }`
// also contains the text `.nv-meta {`, so a naive match would test the override
// (no position/text-shadow) instead of the base rule.
function withoutMedia(css) {
  return css.replace(/@media[^{]*\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}/g, "");
}
const BASE_CSS = withoutMedia(VIDEOS_CSS);

function baseRule(sel) {
  const re = new RegExp(`${sel.replace(/\./g, "\\.")}\\s*\\{[^}]*\\}`);
  return BASE_CSS.match(re);
}

console.log("\n── Videos feed: mobile nav clearance ──");

t("the bottom nav is a fixed, opaque, full-width bar", () => {
  const rule = mobileNavRule();
  ok(/position:\s*fixed/.test(rule), "nav must be position:fixed");
  ok(/bottom:\s*0/.test(rule), "nav must pin to the bottom");
  ok(/height:\s*\d+px/.test(rule), "nav must declare an explicit height");
});

t("nexa-videos.css reserves exactly the nav's height", () => {
  const rule = mobileNavRule();
  const navH = Number((rule.match(/height:\s*(\d+)px/) || [])[1]);
  ok(navH > 0, "could not read nav height");

  // The clearance lives on the view that CONTAINS #nexaVideosRoot. The feed is
  // absolutely positioned (inset:0) inside the root, so padding on the FEED or
  // on the root would either be ignored or overlap the cards; padding on the
  // parent shrinks the flex:1 root and the feed follows.
  const clearance = VIDEOS_CSS.match(
    /@media \(max-width: 768px\)[\s\S]*?#momentsVideosView\.active\.nv-clear-nav\s*\{[^}]*\}/);
  ok(clearance, "missing the <=768px clearance block for #momentsVideosView.active.nv-clear-nav");
  ok(new RegExp(`\\b${navH}px\\b`).test(clearance[0]),
     `clearance must reserve the nav's ${navH}px height`);
});

t("the video keeps its FULL height — only the controls are lifted", () => {
  // The earlier fix padded the pane, which shrank the card to 782px and
  // letterboxed the feed: the "video isn't full any more" regression. The pane
  // must never be padded; the card has to fill it and the controls move instead.
  const bodies = media768Bodies(VIDEOS_CSS).filter((b) => /#momentsVideosView/.test(b));
  ok(bodies.length > 0, "no 768px rule targets #momentsVideosView");
  bodies.forEach((b) => {
    ok(!/(^|;)\s*padding(-bottom|-top|-block)?\s*:/.test(b),
       "the videos pane must NOT be padded — that shrinks the video instead of clearing the nav:\n" + b.trim());
  });

  // Controls are the things that get lifted.
  ["nv-meta", "nv-rail", "nv-progress"].forEach((sel) => {
    const re = new RegExp(`#momentsVideosView\\.active\\.nv-clear-nav\\s+\\.${sel}\\s*\\{[^}]*bottom:`);
    ok(re.test(VIDEOS_CSS), `.${sel} must be lifted above the nav when the nav is visible`);
  });
});

t("control lift is OPT-IN, so nothing moves while the nav is hidden", () => {
  // The nav hides with a chat and returns when it closes. Reserving space
  // unconditionally moved the controls for no reason and left a dead strip.
  const bodies = media768Bodies(VIDEOS_CSS).filter((b) => /#momentsVideosView\.active/.test(b));
  ok(bodies.length > 0, "no 768px clearance rules");
  bodies.forEach((b) => {
    const sel = b.slice(0, b.indexOf("{"));
    ok(/nv-clear-nav/.test(sel),
       `every clearance selector must be gated on .nv-clear-nav, got: ${sel.trim()}`);
  });
});

t("JS only adds the clearance class when the nav is really on screen", () => {
  const js = read("app-main.js");
  ok(/function navReservesSpace\s*\(/.test(js), "navReservesSpace() helper missing");
  ok(/function syncVideosNavClearance\s*\(/.test(js), "syncVideosNavClearance() helper missing");
  ok(/nv-clear-nav/.test(js), "JS never toggles .nv-clear-nav");
  // A measurement, not a hardcoded assumption about which page we're on.
  ok(/getComputedStyle\(nav\)/.test(js), "navReservesSpace must inspect computed style");
  ok(/getBoundingClientRect\(\)\.height/.test(js), "navReservesSpace must measure the nav");
  ok(/switchMomentsSubTab[\s\S]{0,900}syncVideosNavClearance/.test(js),
     "switchMomentsSubTab must sync the clearance");
});

t("clearance also accounts for the iOS home-indicator inset", () => {
  const clearance = VIDEOS_CSS.match(
    /@media \(max-width: 768px\)[\s\S]*?#momentsVideosView\.active\.nv-clear-nav\s*\{[^}]*\}/);
  ok(clearance, "missing clearance block");
  ok(/env\(safe-area-inset-bottom/.test(clearance[0]),
     "clearance must add env(safe-area-inset-bottom) or the caption sits under the home indicator");
});

t("the clearance breakpoint matches the nav's breakpoint", () => {
  ok(inside768(VIDEOS_CSS, "#momentsVideosView.active"),
     "the clearance rule must live inside a max-width:768px query");
  ok(inside768(DASH_CSS, ".mobile-bottom-nav"),
     "dashboard.css nav breakpoint changed — update nexa-videos.css to match");
});

t("desktop is left alone (no clearance above 768px)", () => {
  // The base rule must not pad: above 768px the nav is display:none and the
  // feed should stay full-height.
  const base = VIDEOS_CSS.match(/^\s*#momentsVideosView\s*\{[^}]*\}/m);
  ok(base, "#momentsVideosView base rule missing");
  ok(!/padding-bottom/.test(base[0]),
     "base #momentsVideosView must not reserve nav space on desktop");
});

console.log("\n── Videos feed: card layout ──");

t("feed fills the root and snaps per card", () => {
  const feed = VIDEOS_CSS.match(/\.nv-feed\s*\{[^}]*\}/);
  ok(feed, ".nv-feed rule missing");
  ok(/inset:\s*0/.test(feed[0]), "feed must fill its root (inset:0)");
  ok(/scroll-snap-type:\s*y mandatory/.test(feed[0]), "feed must scroll-snap vertically");
  const card = VIDEOS_CSS.match(/\.nv-card\s*\{[^}]*\}/);
  ok(card, ".nv-card rule missing");
  ok(/scroll-snap-align:\s*start/.test(card[0]), "cards must snap to start");
});

t("bottom-hugging controls sit inside the card", () => {
  // The clearance above is only correct because these are anchored to the card,
  // not to the viewport.
  [".nv-meta", ".nv-rail", ".nv-progress"].forEach((sel) => {
    const rule = baseRule(sel);
    ok(rule, `${sel} rule missing`);
    ok(/position:\s*absolute/.test(rule[0]), `${sel} must be absolutely positioned in the card`);
  });
});

console.log("\n── Videos feed: legibility ──");

t("the duration chip stays readable over bright video", () => {
  const rule = VIDEOS_CSS.match(/\.nv-dur\s*\{[^}]*\}/);
  ok(rule, ".nv-dur rule missing");
  ok(/text-shadow:/.test(rule[0]), ".nv-dur needs a text-shadow (it sits over live video)");
});

t("the caption block keeps its text shadow", () => {
  const rule = baseRule(".nv-meta");
  ok(rule, ".nv-meta rule missing");
  ok(/text-shadow:/.test(rule[0]), ".nv-meta needs a text-shadow");
});

console.log("\n── Line endings ──");

t("edited stylesheets keep CRLF", () => {
  ["nexa-videos.css", "dashboard.css"].forEach((f) => {
    const raw = fs.readFileSync(path.join(ROOT, f), "utf8");
    const crlf = (raw.match(/\r\n/g) || []).length;
    const lf = (raw.match(/\n/g) || []).length;
    ok(crlf > 0 && crlf === lf, `${f}: mixed line endings (${crlf} CRLF / ${lf} LF)`);
  });
});

console.log(`\n${fail === 0 ? "\u2713 PASSED" : "\u2717 FAILED"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
