/**
 * Headless regression tests for the invite-link / preview work.
 *
 * These evaluate the ACTUAL function source pulled out of the shipped files
 * (not a re-implementation), so a regression in the real code fails the test.
 * Run: node tests/invite-links.test.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = f => fs.readFileSync(path.join(ROOT, f), "utf8");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  \u2713 " + name); }
  else { fail++; console.log("  \u2717 " + name + (extra ? "  -> " + extra : "")); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, "got " + JSON.stringify(actual) + ", want " + JSON.stringify(expected));
}

// Pull `function NAME(...) { ... }` (or `async function`) out by brace matching.
function extractFn(src, name) {
  const re = new RegExp("(?:async\\s+)?function\\s+" + name + "\\s*\\(");
  const m = re.exec(src);
  if (!m) throw new Error("function not found: " + name);
  let i = src.indexOf("{", m.index + m[0].length - 1);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
  }
  throw new Error("unbalanced braces for " + name);
}

function run(code, sandbox) {
  return vm.runInNewContext(code, Object.assign({
    console, URLSearchParams, decodeURIComponent, encodeURIComponent, Math, Date, JSON,
  }, sandbox));
}

console.log("\n1) join.html / dashboard invite URL + preview helpers");
const appJs = read("app-main.js");

{
  const sandbox = { window: { location: { origin: "https://nexa.test", pathname: "/dashboard.html", href: "https://nexa.test/dashboard.html?joinGroup=abc" } } };
  const fn = run(extractFn(appJs, "nexaJoinUrl") + "\n;nexaJoinUrl;", sandbox);
  eq("nexaJoinUrl(group) uses join.html", fn("joinGroup", "abc123"), "https://nexa.test/join.html?joinGroup=abc123");
  eq("nexaJoinUrl(channel) uses join.html", fn("joinChannel", "xy z"), "https://nexa.test/join.html?joinChannel=xy%20z");
}

{
  const fn = run(extractFn(appJs, "groupMsgSnippet") + "\n;groupMsgSnippet;", {});
  eq("snippet: text", fn({ text: "hello" }), "hello");
  eq("snippet: image", fn({ image: "u" }), "\uD83D\uDCF7 Photo");
  eq("snippet: video", fn({ video: "u" }), "\uD83C\uDFA5 Video");
  eq("snippet: audio", fn({ audio: "u" }), "\uD83C\uDFA4 Voice note");
  eq("snippet: file", fn({ fileUrl: "u", fileName: "a.pdf" }), "\uD83D\uDCCE a.pdf");
  eq("snippet: poll", fn({ type: "poll", pollQuestion: "Q?" }), "\uD83D\uDCCA Q?");
  eq("snippet: empty", fn(null), "");
}

console.log("\n2) invite resolution + already-a-member detection (real source)");
{
  ok("_resolveGroupByInviteToken exists", /async function _resolveGroupByInviteToken\(/.test(appJs));
  ok("_resolveChannelByInviteToken exists", /async function _resolveChannelByInviteToken\(/.test(appJs));
  ok("group resolver queries inviteCode", /_resolveGroupByInviteToken[\s\S]{0,600}?where\('inviteCode', '==', token\)/.test(appJs));
  ok("channel resolver queries inviteCode", /_resolveChannelByInviteToken[\s\S]{0,600}?where\('inviteCode', '==', token\)/.test(appJs));
  ok("group param reports already-in", /You're already in/.test(appJs));
  ok("channel param reports already-following", /You're already following/.test(appJs));
  ok("group param no longer double-counts on re-join", /memberUids: firebase\.firestore\.FieldValue\.arrayUnion\(currentUser\.uid\),\s*\r?\n\s*membersCount: firebase\.firestore\.FieldValue\.increment\(1\)/.test(appJs));
  ok("in-chat card checks ownerUid too", /const isMember = \(group\.memberUids \|\| \[\]\)\.includes\(_joinerUid\)[\s\S]{0,120}?group\.ownerUid === _joinerUid/.test(appJs));
}

console.log("\n3) group preview is written from EVERY path");
{
  ok("updateGroupPreview helper exists", /async function updateGroupPreview\(/.test(appJs));
  ok("refreshGroupPreviewAfterDelete helper exists", /async function refreshGroupPreviewAfterDelete\(/.test(appJs));
  ok("send path uses updateGroupPreview", /const snippet = groupMsgSnippet\(payload\);[\s\S]{0,80}?await updateGroupPreview\(selectedGroup\.id, snippet, senderName\)/.test(appJs));
  ok("forward path uses updateGroupPreview", /await updateGroupPreview\(targetId, groupMsgSnippet\(payload\), senderName, '\u2933 '\)/.test(appJs));
  ok("delete path refreshes preview", /\.then\(\(\) => refreshGroupPreviewAfterDelete\(_gid\)\)/.test(appJs));
  ok("edit path updates preview", /if \(isGroup && selectedGroup && local[\s\S]{0,200}?updateGroupPreview\(selectedGroup\.id, groupMsgSnippet\(local\)/.test(appJs));
}

console.log("\n4) login/signup ?next= is same-origin only (no open redirect)");
for (const file of ["login.html", "signup.html"]) {
  const html = read(file);
  const name = file === "login.html" ? "nexaNextTarget" : "nexaSignupNextTarget";
  let code = extractFn(html, name);
  if (file === "login.html") {
    code = "var urlParams = new URLSearchParams(window.location.search);\n" + code;
  }
  const mk = (search) => run(code + "\n;" + name + ";", {
    window: { location: { search, href: "https://nexa.test/" + file, pathname: "/" + file } },
  });
  const f = mk("?next=" + encodeURIComponent("/join.html?joinGroup=abc"));
  eq(file + ": keeps /join.html invite", f("dashboard.html"), "/join.html?joinGroup=abc");
  const f2 = mk("?next=" + encodeURIComponent("https://evil.example/x"));
  eq(file + ": blocks absolute external", f2("dashboard.html"), "dashboard.html");
  const f3 = mk("?next=" + encodeURIComponent("//evil.example/x.html"));
  eq(file + ": blocks protocol-relative", f3("dashboard.html"), "dashboard.html");
  const f4 = mk("?next=" + encodeURIComponent("dashboard.html"));
  eq(file + ": allows bare same-origin file", f4("fallback.html"), "dashboard.html");
  const f5 = mk("");
  eq(file + ": no next -> fallback", f5("dashboard.html"), "dashboard.html");
}

console.log("\n5) admin: Top-20 gone, communities section present");
{
  const admin = read("admin.html");
  ok("no champions UI", !/Nexa Champions/.test(admin));
  ok("no renderChampions", !/renderChampions/.test(admin));
  ok("no cachedMsgScores", !/cachedMsgScores/.test(admin));
  ok("no weekly-activity call", !/weekly-activity/.test(admin));
  ok("communities list container", /id="communitiesList"/.test(admin));
  ok("communities loader", /async function loadCommunities\(/.test(admin));
  ok("communities renderer", /function renderCommunities\(/.test(admin));
  ok("communities delete", /async function deleteCommunity\(/.test(admin));
  ok("stories-this-week card kept", /id="storiesThisWeek"/.test(admin));
  ok("referrals card kept", /id="totalReferrals"/.test(admin));
}

console.log("\n6) backend: weekly-activity removed, community endpoints added");
{
  const api = read("server/admin-api.js");
  ok("weekly-activity route removed", !/\/api\/admin\/weekly-activity/.test(api));
  ok("aggregateWeeklyActivity removed", !/aggregateWeeklyActivity/.test(api));
  ok("list-communities route", /app\.get\("\/api\/admin\/list-communities", requireAdminSecret/.test(api));
  ok("delete-community route", /app\.post\("\/api\/admin\/delete-community", requireAdminSecret/.test(api));
  ok("delete-community cleans subcollections", /subscribers[\s\S]{0,80}posts[\s\S]{0,80}messages/.test(api));
  ok("list-communities is auth-guarded", /list-communities", requireAdminSecret/.test(api));
}

console.log("\n7) join.html landing page");
{
  const j = read("join.html");
  ok("reads joinGroup + joinChannel", /params\.get\("joinGroup"\)/.test(j) && /params\.get\("joinChannel"\)/.test(j));
  ok("has android intent:// fallback", /intent:\/\/[\s\S]{0,200}?browser_fallback_url/.test(j));
  ok("uses the real package id", /com\.nexa\.messenger/.test(j));
  ok("routes signed-out users to login with next=", /login\.html\?next=/.test(j));
  ok("routes signed-in users to dashboard with the invite", /dashboard\.html\?" \+ p/.test(j));
}

console.log("\n" + (fail ? "\u2717 FAILED" : "\u2713 PASSED") + " — " + pass + " passed, " + fail + " failed\n");
process.exit(fail ? 1 : 0);
