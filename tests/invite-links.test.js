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
    console, URLSearchParams, decodeURIComponent, encodeURIComponent, Math, Date, JSON, URL,
  }, sandbox));
}

// Pull a top-level `const NAME = ...;` declaration verbatim.
function extractConst(src, name) {
  const re = new RegExp("const\\s+" + name + "\\s*=\\s*[^;]+;");
  const m = re.exec(src);
  if (!m) throw new Error("const not found: " + name);
  return m[0];
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
  ok("send path uses updateGroupPreview", /const snippet = groupMsgSnippet\(payload\);[\s\S]{0,80}?await updateGroupPreview\(selectedGroup\.id, snippet, senderName, '', mentionUidsOf\(payload\)\)/.test(appJs));
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

console.log("\n4b) group @ badge reflects only the newest message (tag-then-delete)");
{
  // The old groupMentionAlerts/recordGroupMention accumulator kept the MAX
  // mention timestamp forever, so deleting the tagging message (or editing the
  // @ out) left the chat-list "@" badge stuck. It is gone; the badge now reads
  // the group doc's denormalized lastMentionUids.
  ok("old mention-alert accumulator removed", !/function recordGroupMention\(/.test(appJs) && !/groupMentionAlerts\s*=\s*\{/.test(appJs));
  ok("old isMentionedInGroup helper removed", !/function isMentionedInGroup\(/.test(appJs));
  ok("listener no longer calls recordGroupMention", !/recordGroupMention\(/.test(appJs));

  // updateGroupPreview is the single writer of the denormalized mention set.
  ok("updateGroupPreview accepts mention uids", /async function updateGroupPreview\(groupId, snippet, senderName, prefix, mentionUids, at\)/.test(appJs));
  ok("updateGroupPreview writes lastMentionUids", /lastMentionUids: Array\.isArray\(mentionUids\) \? mentionUids\.filter\(Boolean\) : \[\]/.test(appJs));
  ok("send path passes the mentions", /updateGroupPreview\(selectedGroup\.id, snippet, senderName, '', mentionUidsOf\(payload\)\)/.test(appJs));
  ok("edit path passes the mentions", /updateGroupPreview\(selectedGroup\.id, groupMsgSnippet\(local\), local\.senderName \|\| '', '', mentionUidsOf\(local\), local\.createdAt \|\| 0\)/.test(appJs));
  ok("delete recompute clears stale mentions", /refreshGroupPreviewAfterDelete[\s\S]{0,600}?updateGroupPreview\(groupId, groupMsgSnippet\(m\), m\.senderName \|\| '', '', uids, m\.createdAt \|\| 0\)/.test(appJs));
  ok("empty group clears the mention set", /updateGroupPreview\(groupId, 'No messages yet', '', '', \[\]\)/.test(appJs));
  ok("edit recomputes mentions from the new text", /newMentions = resolveMentionedMembers\(newText\)/.test(appJs));
  ok("badge reads the denormalized set", /const mentionUids = Array\.isArray\(g\.lastMentionUids\) \? g\.lastMentionUids : \[\]/.test(appJs));
  ok("badge only highlights when unseen", /const iAmMentioned = hasUnseen && mentionUids\.includes\(currentUser\.uid\)/.test(appJs));
  ok("preview keeps the real time on delete/edit", /updateGroupPreview\(groupId, groupMsgSnippet\(m\), m\.senderName \|\| '', '', uids, m\.createdAt \|\| 0\)/.test(appJs) && /mentionUidsOf\(local\), local\.createdAt \|\| 0\)/.test(appJs));
  ok("preview writer accepts an explicit timestamp", /async function updateGroupPreview\(groupId, snippet, senderName, prefix, mentionUids, at\)/.test(appJs));

  // Evaluate the real helper that feeds lastMentionUids.
  const fn = run(extractFn(appJs, "mentionUidsOf") + "\n;mentionUidsOf;", {});
  eq("mentionUidsOf extracts uids", JSON.stringify(fn({ mentions: [{ uid: "a" }, { uid: "b" }] })), '["a","b"]');
  eq("mentionUidsOf drops blank uids", JSON.stringify(fn({ mentions: [{ uid: "a" }, { name: "x" }, null] })), '["a"]');
  eq("mentionUidsOf empty for no mentions", JSON.stringify(fn({ text: "hi" })), "[]");
  eq("mentionUidsOf empty for null", JSON.stringify(fn(null)), "[]");
}

console.log("\n4c) notifications: connection requests, group-added, @all");
{
  // Connections is a real category and drives the master switch.
  ok("connections notif setting declared", /connections:\s*true/.test(appJs));
  ok("connections in NEXA_NOTIF_TYPES", /NEXA_NOTIF_TYPES = \["messages", "groups", "stories", "reactions", "connections"\]/.test(appJs));
  ok("push gates on connections", /if \(isConnect && !notificationSettings\.connections\) return;/.test(appJs));
  ok("push reads isConnect flag", /const isConnect = extraData\.isConnect === true;/.test(appJs));

  // Connection request / accept pushes exist and are single-target.
  ok("request sends a connect push", /sent you a connection request', uid, \{[\s\S]{0,80}?isConnect: true,/.test(appJs));
  ok("accept sends a connect push", /accepted your connection request', uid, \{[\s\S]{0,80}?isConnect: true,/.test(appJs));
  ok("connect push marks isConnect", /connectType: 'request'/.test(appJs) && /connectType: 'accepted'/.test(appJs));

  // Group-added push on both create and add-members.
  ok("create-group notifies added members", /addedUids = memberUids\.filter\(u => u && u !== currentUser\.uid\);[\s\S]{0,160}?added you to the group/.test(appJs));
  ok("add-members notifies added members", /addedUids = Array\.from\(selectedGroupMemberUids\)[\s\S]{0,400}?added you to the group/.test(appJs));
  ok("group-added push tagged isGroup+groupAdded", /isGroup: true, groupAdded: true, recipientUids: addedUids/.test(appJs));

  // @all: popup row, insert, expansion, single combined push, highlight.
  ok("mention popup shows an @all row", /mention-row mention-row-all" onclick="insertMentionAll\(\)"/.test(appJs));
  ok("insertMentionAll exists", /function insertMentionAll\(\)/.test(appJs));
  ok("popup keeps @all visible on empty filter", /const showAllRow = !query \|\| 'all'\.startsWith\(query\) \|\| 'everyone'\.startsWith\(query\)/.test(appJs));
  ok("send expands @all to all members", /if \(\/\\B@all\\b\/i\.test\(text\)\) \{[\s\S]{0,200}?extras\.mentionAll = true;/.test(appJs));
  ok("@all push is a single combined push", /isMentionAll && mentionedUids\.length[\s\S]{0,160}?mentioned @all/.test(appJs));
  ok("@all skips the plain group push", /if \(groupRecipients\.length && !isMentionAll\)/.test(appJs));
  ok("renderMentionText highlights @all for everyone", /function renderMentionText\(text, mentions, mentionAll\)/.test(appJs) && /const isAll = \/\^all\$\/i\.test\(name\);/.test(appJs));
  ok("edit path understands @all", /let newMentionAll = false;/.test(appJs) && /mentionAll: newMentionAll/.test(appJs));

  // Icon mapping for the new event types.
  const icon = run(extractFn(appJs, "notifHistoryIconFor") + "\n;notifHistoryIconFor;", {});
  eq("icon: connection request (title)", icon("Ada sent you a connection request"), "\u{1F91D}");
  eq("icon: group added (title)", icon("Ada added you to the group"), "\u{1F465}");
  eq("icon: mention (title)", icon("🔔 Ada mentioned you"), "\u{1F4AC}");

  const iconForData = run(extractFn(appJs, "notifHistoryIconFor") + "\n" + extractFn(appJs, "notifIconForData") + "\n;notifIconForData;", {});
  eq("iconForData: connect", iconForData("Ada", { isConnect: true }), "\u{1F91D}");
  eq("iconForData: group added", iconForData("Ada", { groupAdded: true }), "\u{1F465}");
  eq("iconForData: mention-all", iconForData("Ada", { mentionAll: true }), "\u{1F514}");
  eq("iconForData: plain message falls back", iconForData("Ada", {}), "\u{1F4AC}");

  // The @all detector used on send must match standalone tokens only.
  const isAll = t => /\B@all\b/i.test(t);
  ok("@all matches 'hi @all'", isAll("hi @all"));
  ok("@all matches '@ALL there'", isAll("@ALL there"));
  ok("@all rejects 'email@all.com'", !isAll("email@all.com"));
  ok("@all rejects 'call'", !isAll("call me"));
}

console.log("\n5) admin: Top-20 gone, communities section removed");
{
  const admin = read("admin.html");
  ok("no champions UI", !/Nexa Champions/.test(admin));
  ok("no renderChampions", !/renderChampions/.test(admin));
  ok("no cachedMsgScores", !/cachedMsgScores/.test(admin));
  ok("no weekly-activity call", !/weekly-activity/.test(admin));
  ok("no communities list container", !/id="communitiesList"/.test(admin));
  ok("no communities loader", !/loadCommunities/.test(admin));
  ok("no communities renderer", !/renderCommunities/.test(admin));
  ok("no communities delete", !/deleteCommunity/.test(admin));
  ok("stories-this-week card kept", /id="storiesThisWeek"/.test(admin));
  ok("referrals card kept", /id="totalReferrals"/.test(admin));
}

console.log("\n6) backend: weekly-activity + community endpoints removed");
{
  const api = read("server/admin-api.js");
  ok("weekly-activity route removed", !/\/api\/admin\/weekly-activity/.test(api));
  ok("aggregateWeeklyActivity removed", !/aggregateWeeklyActivity/.test(api));
  ok("list-communities route removed", !/app\.get\("\/api\/admin\/list-communities"/.test(api));
  ok("delete-community route removed", !/app\.post\("\/api\/admin\/delete-community"/.test(api));
  ok("deleteCollection helper removed", !/function deleteCollection/.test(api));
  ok("admin routes still auth-guarded", /requireAdminSecret/.test(api));
}

console.log("\n7) join.html landing page");
{
  const j = read("join.html");
  ok("reads joinGroup + joinChannel", /params\.get\("joinGroup"\)/.test(j) && /params\.get\("joinChannel"\)/.test(j));
  ok("has android intent:// fallback", /intent:\/\/[\s\S]{0,200}?browser_fallback_url/.test(j));
  ok("uses the real package id", /com\.nexa\.messenger/.test(j));
  ok("routes signed-out users to login with next=", /login\.html\?next=/.test(j));
  ok("routes signed-in users to dashboard with the invite", /dashboard\.html\?" \+ p/.test(j));
  ok("detects the native WebView via its user agent", /function isNativeApp\(\)[\s\S]{0,160}?NexaMobileNative/.test(j));
  ok("has a nexa:// custom-scheme URL", /function nexaSchemeUrl\(\)[\s\S]{0,120}?nexa:\/\//.test(j));
  ok("primary button tries the app then falls back", /openAppOrFallback\(primaryHref\)/.test(j));
  ok("falls back to the in-browser action", /function openAppOrFallback\(fallback\)/.test(j));
  ok("uses visibilitychange to confirm hand-off", /document\.addEventListener\("visibilitychange", onHide\)/.test(j));
  ok("no leftover 'Open in app' secondary button", !/id="openAppBtn"/.test(j));
  ok("auto-continues to the dashboard inside the app", /function autoContinue\(user\)[\s\S]{0,220}?window\.location\.replace\(dest\)/.test(j));
  ok("start() triggers autoContinue for the native app", /if \(isNativeApp\(\)\) autoContinue\(user\)/.test(j));

  // Evaluate the real UA predicates.
  const uaFn = extractFn(j, "isNativeApp");
  const isNative = run(uaFn + "\n;isNativeApp;", {
    navigator: { userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36 NexaMobileNative/1.2.0" },
  });
  eq("native UA detected", isNative(), true);
  const notNative = run(uaFn + "\n;isNativeApp;", {
    navigator: { userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile Safari/537.36" },
  });
  eq("plain Android browser not native", notNative(), false);

  // Evaluate the real URL builders.
  const sandbox = {
    NEXA_ANDROID_PACKAGE: "com.nexa.messenger",
    window: {
      location: {
        host: "nexa-qydr.onrender.com",
        pathname: "/join.html",
        search: "?joinGroup=ABC123",
        href: "https://nexa-qydr.onrender.com/join.html?joinGroup=ABC123",
      },
    },
  };
  const urlFns = extractFn(j, "invitePath") + "\n" + extractFn(j, "absoluteUrl") + "\n" + extractFn(j, "androidIntentUrl") + "\n" + extractFn(j, "nexaSchemeUrl") + "\n;[androidIntentUrl('/login.html?next=%2Fjoin.html'), nexaSchemeUrl()];";
  const built = run(urlFns, sandbox);
  ok("intent URL targets the package", /package=com\.nexa\.messenger/.test(built[0]));
  ok("intent URL carries the invite path", /intent:\/\/nexa-qydr\.onrender\.com\/join\.html\?joinGroup=ABC123/.test(built[0]));
  ok("intent fallback is the in-browser destination", /browser_fallback_url=https%3A%2F%2Fnexa-qydr\.onrender\.com%2Flogin\.html/.test(built[0]));
  eq("scheme URL shape", built[1], "nexa://nexa-qydr.onrender.com/join.html?joinGroup=ABC123");
}

console.log("\n8) App Links / assetlinks wiring");
{
  const al = JSON.parse(read(".well-known/assetlinks.json"));
  eq("assetlinks has one target", al.length, 1);
  eq("assetlinks package", al[0].target.package_name, "com.nexa.messenger");
  ok("assetlinks relation is handle_all_urls", al[0].relation.includes("delegate_permission/common.handle_all_urls"));
  ok("assetlinks fingerprint present", /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(al[0].target.sha256_cert_fingerprints[0]));

  const fb = JSON.parse(read("firebase.json"));
  ok("hosting deploys .well-known", fb.hosting[0].ignore.includes("!.well-known/**"));

  const patch = read("android-deeplink.patch");
  ok("android patch: autoVerify app link", /android:autoVerify="true"/.test(patch));
  ok("android patch: host + pathPrefix", /android:host="nexa-qydr\.onrender\.com"[\s\S]{0,80}?pathPrefix="\/join\.html"/.test(patch));
  ok("android patch: custom scheme", /android:scheme="nexa"/.test(patch));
  ok("android patch: singleTask launch mode", /android:launchMode="singleTask"/.test(patch));
  ok("android patch: deep-link handler", /private String deepLinkTarget\(Intent intent\)/.test(patch));
  ok("android patch: keeps nexa:// in the app", /url\.startsWith\("nexa:\/\/"\)/.test(patch));
  ok("android patch: swallows intent:// inside the app", /url\.startsWith\("intent:\/\/"\)/.test(patch));
  ok("android patch: version bumped to 1.3.0", /versionName "1\.3\.0"/.test(patch));
}

console.log("\n9) in-app update gate");
{
  const src = read("app-main.js");
  const latestM = /const NEXA_LATEST_APP_VERSION = '([\d.]+)'/.exec(src);
  ok("NEXA_LATEST_APP_VERSION declared", !!latestM);
  const latest = latestM ? latestM[1] : "0.0.0";

  // `android-deeplink.patch` is the recipe for the currently-published APK, so
  // its target ("+") versionName must equal the web constant. If a future patch
  // bumps the APK version, publish the build first and raise the constant in the
  // same commit — otherwise this fails.
  const patch = read("android-deeplink.patch");
  const removedVer = /^-\s*versionName "([\d.]+)"/m.exec(patch);
  const addedVer = /^\+\s*versionName "([\d.]+)"/m.exec(patch);
  eq("patch bumps the version", (removedVer && removedVer[1]) + "->" + (addedVer && addedVer[1]), "1.2.0->1.3.0");
  eq("NEXA_LATEST_APP_VERSION == published APK version", latest, addedVer && addedVer[1]);

  const cmp = extractFn(src, "_cmpVersion") + "\n" + extractFn(src, "_verNum") + "\n_cmpVersion;";
  const f = run(cmp, {});
  eq("equal versions compare 0", f(latest, latest), 0);
  ok("older device is behind latest", f("1.2.0", latest) < 0 || latest === "1.2.0");

  const pending = extractFn(src, "isAppUpdatePending");
  ok("gate consults the device version", /getDeviceAppVersion\(\)/.test(pending));
  ok("gate compares device against latest", /_cmpVersion\(device, NEXA_LATEST_APP_VERSION\) < 0/.test(pending));

  const dot = extractFn(src, "updateAppUpdateDot");
  ok("dot highlights install row", /installAppRow/.test(dot) && /settings-row-highlight/.test(dot));
  ok("dot labels the update", /Update available/.test(dot));
  ok("tab dots are toggled", /settingsTabDotDesktop/.test(dot) && /settingsTabDotMobile/.test(dot));

  const modal = read("dashboard.html");
  ok("update modal exists", /id="appUpdateModal"/.test(modal));
  ok("update-now button wired", /onclick="updateAppNow\(\)"/.test(modal));
  ok("native in-place update bridge used", /NexaAndroid\.installUpdate/.test(src));
}

console.log("\n8) group/channel instant-open message cache");
{
  // A fake localStorage shared between save and load, plus the minimal globals
  // the cache helpers touch (currentUser + the storage object).
  const store = {};
  const localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
  };
  const sandbox = { localStorage, currentUser: { uid: "me" } };
  const cacheCode = [
    extractConst(appJs, "COMM_MSG_CACHE_MAX"),
    extractFn(appJs, "commMsgCacheKey"),
    extractFn(appJs, "saveCommMsgCache"),
    extractFn(appJs, "loadCommMsgCache"),
    extractFn(appJs, "clearCommMsgCache"),
    "\n;({ saveCommMsgCache, loadCommMsgCache, clearCommMsgCache, commMsgCacheKey, COMM_MSG_CACHE_MAX });",
  ].join("\n");
  const C = run(cacheCode, sandbox);

  ok("cache is capped (mirrors 1:1 cache)", C.COMM_MSG_CACHE_MAX === 24);

  const key = C.commMsgCacheKey("group", "g1");
  eq("key is scoped to user + kind + id", key, "nexa_comm_msgs_me_group_g1");
  ok("group and channel keys differ",
    C.commMsgCacheKey("group", "x") !== C.commMsgCacheKey("channel", "x"));

  const msgs = [
    { id: "m1", createdAt: 1, text: "one" },
    { id: "m2", createdAt: 2, text: "two" },
    { id: "s1", createdAt: 3, isSystem: true, text: "joined" },
  ];
  C.saveCommMsgCache("group", "g1", msgs);
  const loaded = C.loadCommMsgCache("group", "g1");
  eq("round-trips the newest messages", loaded.map(m => m.id).join(","), "m1,m2");
  ok("system notices are not cached", !loaded.some(m => m.isSystem));
  eq("a different chat loads empty", C.loadCommMsgCache("group", "other").length, 0);

  // Cap: 30 messages -> only the newest 24 survive, oldest first.
  const many = Array.from({ length: 30 }, (_, i) => ({ id: "n" + i, createdAt: i + 1 }));
  C.saveCommMsgCache("channel", "c1", many);
  const capped = C.loadCommMsgCache("channel", "c1");
  eq("cache keeps only the newest COMM_MSG_CACHE_MAX", capped.length, 24);
  eq("cache is oldest-first", capped[0].id, "n6");
  eq("cache keeps the newest", capped[capped.length - 1].id, "n29");

  C.clearCommMsgCache("group", "g1");
  eq("clear drops the entry", C.loadCommMsgCache("group", "g1").length, 0);

  // The live listeners must consult the cache on open (not just paint a
  // loading placeholder) and persist on render — otherwise the "Loading…"
  // flash on every group/channel open comes back.
  ok("group open paints from cache", /loadCommMsgCache\('group', group\.id\)/.test(appJs));
  ok("group cache paint runs before the join-time await",
    /loadCommMsgCache\('group', group\.id\)[\s\S]{0,400}?resolveGroupJoinedAt\(group\.id\)/.test(appJs));
  ok("group render persists to cache", /saveCommMsgCache\('group', selectedGroup\.id, messages\)/.test(appJs));
  ok("channel open paints from cache", /loadCommMsgCache\('channel', channelId\)/.test(appJs));
  ok("channel render persists to cache", /saveCommMsgCache\('channel', selectedChannel\.id, posts\)/.test(appJs));
  ok("empty group render clears the cache", /clearCommMsgCache\('group', selectedGroup\.id\)/.test(appJs));
  ok("empty channel render clears the cache", /clearCommMsgCache\('channel', selectedChannel\.id\)/.test(appJs));
  // The reactions-only fast path must still be reset before the first snapshot
  // (the "2nd open shows nothing" regression).
  ok("channel posts cache is reset before subscribing",
    /window\._nexaChannelPostsCache = null;\s*\n\s*window\._nexaChannelPostsChannelId = channelId;\s*\n\s*\n\s*const cachedPosts/.test(appJs));
}

console.log("\n" + (fail ? "\u2717 FAILED" : "\u2713 PASSED") + " — " + pass + " passed, " + fail + " failed\n");
process.exit(fail ? 1 : 0);
