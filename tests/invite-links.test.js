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
  ok("connections in NEXA_NOTIF_TYPES", /NEXA_NOTIF_TYPES = \["messages", "groups", "stories", "videos", "reactions", "connections"\]/.test(appJs));
  ok("videos in NEXA_NOTIF_TYPES", /NEXA_NOTIF_TYPES = \[[^\]]*"videos"/.test(appJs));
  ok("video push gate reads isVideo flag", /isVideo && !notificationSettings\.videos/.test(appJs));
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
  ok("android patch: version bumped to 1.4.0", /versionName "1\.4\.0"/.test(patch));
  ok("android patch: watch.html app link", /pathPrefix="\/watch\.html"/.test(patch));
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
  eq("patch bumps the version", (removedVer && removedVer[1]) + "->" + (addedVer && addedVer[1]), "1.2.0->1.4.0");
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

// ── Videos: upload caps, progress ring, edit/delete, My Videos ─────────────
{
  const vids = read("nexa-videos.js");
  const html = read("dashboard.html");

  // Upload caps: 20-min duration AND 100 MB size, both hard client caps.
  ok("video duration cap constant is 20 min", /const MAX_VIDEO_MIN = 20;/.test(vids));
  ok("duration cap derives ms from the minutes constant", /const MAX_VIDEO_MS = MAX_VIDEO_MIN \* 60 \* 1000;/.test(vids));
  ok("size cap constant is 100 MB", /const MAX_VIDEO_MB = 100;/.test(vids));
  ok("size cap derives bytes from the MB constant", /const MAX_VIDEO_BYTES = MAX_VIDEO_MB \* 1024 \* 1024;/.test(vids));
  ok("over-size videos are hard-rejected", /if \(file\.size > MAX_VIDEO_BYTES\) \{/.test(vids));
  ok("size rejection clears pendingFile + sets pendingTooBig", /state\.pendingFile = null;[\s\S]{0,80}state\.pendingTooBig = true;/.test(vids));
  ok("post() blocks over-size videos", /if \(state\.pendingTooBig\) \{/.test(vids));
  ok("metadata sets pendingTooLong", /state\.pendingTooLong = durMs > MAX_VIDEO_MS;/.test(vids));
  ok("post() blocks over-long videos", /if \(state\.pendingTooLong\) \{/.test(vids));
  ok("post() uses true byte progress capped at 99 while uploading",
    /setRing\(true, Math\.min\(99, pct\), 'Uploading/.test(vids));
  ok("post() drives the ring to 100 at the write step", /setRing\(true, 100, 'Posting/.test(vids));

  // Ring centre must ALWAYS show the percentage (the stage is a caption now).
  ok("ring label shows the percent number", /if \(label\) label\.textContent = p \+ '%';/.test(vids));
  ok("ring has a stage caption element", /nvRingStage/.test(vids));

  // Edit.
  ok("edit sheet opens for a video", /function openEditVideo\(id\)/.test(vids));
  ok("saveEdit writes the caption", /\.update\(\{ caption: caption \}\)/.test(vids));
  ok("edit exports present",
    /window\.nexaVideosEdit = openEditVideo;/.test(vids) &&
    /window\.nexaVideosSaveEdit = saveEdit;/.test(vids) &&
    /window\.nexaVideosDelete = deleteVideo;/.test(vids));
  ok("edit/delete rail buttons removed from the feed card",
    !/data-act="edit"/.test(vids) && !/nv-rail-del/.test(vids) &&
    !/data-act="delete"/.test(vids) && !/const mine = v\.uid === myUid\(\);/.test(vids));
  ok("edit + delete live in the My Videos settings rows",
    /nexaVideosEdit\([^)]*\+ id/.test(vids) && /nexaVideosDelete\([^)]*\+ id/.test(vids));

  // Sound: feed starts with audio, with a toggle for browsers that block
  // audible autoplay before a gesture.
  ok("feed defaults to sound on", /soundOn: \(function \(\) \{ try \{ var s = localStorage\.getItem\('nexa_videos_sound'\); return s === null \? true : s === '1';/.test(vids));
  ok("tryPlay honours the sound setting", /video\.muted = !state\.soundOn;/.test(vids));
  ok("tryPlay falls back to muted when audible autoplay is blocked",
    /p\.catch\(\(\) => \{[\s\S]{0,300}video\.muted = true;[\s\S]{0,120}state\.soundOn = false;/.test(vids));
  ok("sound toggle button replaces the + FAB",
    /class="nv-sound" id="nvSoundBtn"/.test(vids) && !/nv-fab/.test(vids) && !/nvFab/.test(vids));
  ok("sound toggle is exported + persists the choice",
    /window\.nexaVideosToggleSound = toggleSound;/.test(vids) &&
    /localStorage\.setItem\('nexa_videos_sound'/.test(vids));
  ok("sound button reflects state (volume icons)",
    /volume-2/.test(vids) && /volume-x/.test(vids));

  // The + upload entry moved out of the feed into the Moments header.
  ok("dashboard has a + New Video header button",
    /id="momentsNewVideoBtn"[^>]*nexaVideosOpenComposer\(\)/.test(html));
  ok("the header button swaps with the Moments sub-tab",
    /momentsNewVideoBtn[\s\S]{0,420}vb\.style\.display = tab === 'videos' \? '' : 'none';/.test(appJs));

  // Delete: promise-based confirm + cascade of the subcollections.
  ok("delete awaits the promise nexaConfirm (not a callback)", /await window\.nexaConfirm\(/.test(vids));
  ok("delete purges comments + likes", /purgeSub\(ref, 'comments'\)[\s\S]{0,120}purgeSub\(ref, 'likes'\)/.test(vids));
  ok("delete removes the video doc", /await ref\.delete\(\);/.test(vids));

  // ── Player: no restart, double-tap seek, duration + scrubber ──────────────
  ok("feed patches cards in place instead of rebuilding (no restart)",
    /function patchCard\(card, v\)/.test(vids) &&
    /feed\.querySelectorAll\('\.nv-card'\)\.forEach/.test(vids) &&
    !/feed\.innerHTML = state\.videos\.map\(cardHtml\)/.test(vids));
  ok("patchCard never rewrites the <video> element", (() => {
    const s = vids.indexOf('function patchCard');
    const body = vids.slice(s, vids.indexOf('\n  function ', s + 10));
    return s > -1 && body.length > 100 && !/\.nv-video/.test(body);
  })());
  ok("patchCard updates like/comment/share counts", /\[data-act="comment"\] \.nv-rail-count/.test(vids));
  ok("cards show a duration badge", /class="nv-dur"/.test(vids) && /function fmtDur\(ms\)/.test(vids));
  ok("progress bar is driven from the media clock", /addEventListener\('timeupdate', paint\)/.test(vids));
  ok("double-tap left/right seeks ±10s (SEEK_STEP)",
    /const SEEK_STEP = 10;/.test(vids) && /if \(z === 'l'\) seekBy\(card, -SEEK_STEP\);/.test(vids) &&
    /else if \(z === 'r'\) seekBy\(card, SEEK_STEP\);/.test(vids));
  ok("double-tap centre still likes", /else likeBurst\(id, card\);/.test(vids));
  ok("tap zones are left/centre/right thirds", /function tapZone\(card, clientX\)/.test(vids));
  ok("seek shows a flash pill", /function showSeekPill\(card, delta\)/.test(vids));
  ok("progress bar is draggable to scrub", /function startScrub\(e\)/.test(vids) && /nv-scrubbing/.test(vids));
  ok("scrub intercepts the pointerdown before long-press",
    /closest\('\.nv-progress'\)\) \{ startScrub\(e\); return; \}/.test(vids));

  // ── Accurate counts ───────────────────────────────────────────────────────
  ok("likes move marker + count together in a transaction",
    /runTransaction\(tx => tx\.get\(likeRef\)/.test(vids));
  ok("like is idempotent (checks the marker exists first)",
    /if \(liked && !has\)/.test(vids) && /else if \(!liked && has\)/.test(vids));
  ok("share counts only when the share actually completed",
    /navigator\.share\(\{ title: 'Nexa', text: text, url: url \}\)\s*\n\s*\.then\(\(\) => \{ countShare\(\); toast\('Shared', 'success'\); \}\)/.test(vids));
  ok("a dismissed share sheet is NOT counted",
    /if \(err && \(err\.name === 'AbortError' \|\| err\.name === 'NotAllowedError'\)\) return;/.test(vids));
  ok("a double tap cannot count the same share twice",
    /if \(state\.sharing\[id\]\) return;/.test(vids) && /state\.sharing\[id\] = true;/.test(vids));
  ok("share count is exact, not re-parsed from the rounded label",
    /function exactShares\(v\)/.test(vids) && /state\.sharesExact\[v\.id\] === undefined/.test(vids) &&
    /function bumpShare\(id\) \{\s*\n\s*state\.sharesExact\[id\] = exactShares\(findVideo\(id\)\) \+ 1;/.test(vids));
  ok("a lagging snapshot cannot wipe the just-painted share count",
    /serverShares > state\.sharesExact\[v\.id\]/.test(vids));
  ok("share has a clipboard + execCommand fallback",
    /function copyShareFallback\(id, payload\)/.test(vids) && /document\.execCommand\('copy'\)/.test(vids));
  ok("share link points at the watch.html landing on the canonical host",
    /const SHARE_ORIGIN = 'https:\/\/nexa-qydr\.onrender\.com';/.test(vids) &&
    /function shareUrlFor\(id\) \{ return SHARE_ORIGIN \+ '\/watch\.html\?v=' \+ encodeURIComponent\(id\); \}/.test(vids));

  // ── Composer preview: sound + duration ────────────────────────────────────
  ok("composer preview is NOT hard-muted", /nv-composer-preview" id="nvComposerPreview" playsinline loop/.test(vids) &&
    !/id="nvComposerPreview" playsinline muted/.test(vids));
  ok("composer preview has a mute toggle", /function togglePreviewSound\(\)/.test(vids) &&
    /window\.nexaVideosTogglePreviewSound = togglePreviewSound;/.test(vids));
  ok("composer shows the duration + size once loaded", /durBox\.textContent = fmtDur\(durMs\)/.test(vids));

  // ── Deep link: ?video=<id> ────────────────────────────────────────────────
  ok("dashboard honours the ?video= deep link", /async function checkVideoUrlParam\(\)/.test(appJs) &&
    /const vid = params\.get\('video'\);/.test(appJs));
  ok("deep link opens the Videos sub-tab", /switchMomentsSubTab\('videos'\);/.test(appJs) &&
    /window\.NexaVideos\.openFocus\(vid\)/.test(appJs));
  ok("NexaVideos exposes openFocus + focus scroll", /openFocus: \(id\) => \{ state\.focusVideoId = id; open\(id\); \}/.test(vids) &&
    /function focusPendingVideo\(\)/.test(vids));
  ok("leaving the Moments tab pauses playback (not just unsubscribes)",
    /feed\.querySelectorAll\('\.nv-video'\)\.forEach\(v => \{ try \{ v\.pause\(\); \}/.test(vids));

  // watch.html landing page.
  const watch = read("watch.html");
  ok("watch.html exists and reads ?v=<id>", /params\.get\("v"\)/.test(watch));
  ok("watch.html previews the video (poster + play)", /class="wstage"/.test(watch) && /id="wplay"/.test(watch));
  ok("watch.html shows author/caption/duration/stats",
    /wauthor/.test(watch) && /wcap/.test(watch) && /fmtDur/.test(watch) && /wstats/.test(watch));
  ok("watch.html downloads the blob before playing", /await fetch\(url, \{ mode: "cors", credentials: "omit" \}\)/.test(watch));
  ok("watch.html has the Android app hand-off + fallback",
    /function androidIntentUrl/.test(watch) && /com\.nexa\.messenger/.test(watch) && /browser_fallback_url/.test(watch));
  ok("watch.html routes signed-out users through login with ?next=",
    /return "\/login\.html\?next=" \+ encodeURIComponent\(back\)/.test(watch));
  ok("watch.html shows a sign-in gate for signed-out visitors",
    /function renderSignInGate\(\)/.test(watch) && /if \(!user\) \{ renderSignInGate\(\); return; \}/.test(watch));
  ok("watch.html routes into the feed via ?video=", /return "\/dashboard\.html\?video=" \+ encodeURIComponent\(videoId\)/.test(watch));
  ok("watch.html keeps a tight CSP (no frame-src)",
    /Content-Security-Policy/.test(watch) && /frame-src 'none'/.test(watch));

  // My Videos settings sub-page.
  ok("My Videos uses a single-field uid query (no composite index)",
    /collection\('videos'\)\.where\('uid', '==', uid\)/.test(vids));
  ok("My Videos sorts client-side, not by an orderBy query", /items\.sort\(\(a, b\) =>/.test(vids));
  ok("My Videos row escapes the caption", /v\.caption \? esc\(v\.caption\)/.test(vids));
  ok("inline onclick ids are sanitized", /function sid\(id\)/.test(vids));
  ok("dashboard has the My Videos settings row", /id="myVideosRow"[^>]*openSettingsSubPage\('myvideos'\)/.test(html));
  const dashCss = read("dashboard.css");
  ok("settings sub-pages carry a heading + subtitle", /class="settings-subpage-titles"/.test(html) && /class="settings-subpage-sub"/.test(html) && (html.match(/class="settings-subpage-sub"/g) || []).length >= 13);
  ok("settings sub-page body is width-capped on desktop", /\.settings-subpage-body \{[\s\S]{0,220}calc\(\(100% - 720px\) \/ 2\)/.test(dashCss));
  ok("settings scroll children never flex-shrink", /\.settings-scroll-area > \* \{[^}]*flex-shrink: 0/.test(dashCss));
  ok("dashboard has the myvideos sub-page", /data-subpage="myvideos"/.test(html) && /id="nvMyVideosList"/.test(html));
  ok("app-main opens My Videos on the sub-page", /if \(name === 'myvideos' && window\.NexaVideos\) window\.NexaVideos\.renderMyVideos\(\);/.test(appJs));
  ok("app-main tears the My Videos listener down on close",
    /window\.NexaVideos\.closeMyVideos\(\)/.test(appJs));
  ok("leaving the Settings tab drops the My Videos listener",
    /tabName !== 'settings' && window\.NexaVideos\) window\.NexaVideos\.closeMyVideos\(\);/.test(appJs));

  // CRLF preserved (whole file must not flip to LF).
  const rawVids = fs.readFileSync(path.join(ROOT, "nexa-videos.js"));
  eq("nexa-videos.js keeps CRLF", rawVids.includes(Buffer.from("\r\n")), true);
  eq("nexa-videos.js has no lone LF",
    rawVids.toString("utf8").split("\n").length - 1, rawVids.toString("utf8").split("\r\n").length - 1);
}

// ── Admin: Intelligence dashboard (KPIs, charts, insights) ─────────────────
{
  const adm = read("admin.html");
  const api = read("server/admin-api.js");

  // Range-aware KPIs.
  ok("admin has a range selector", /class="an-range"/.test(adm) && /NexaAdminAnalytics\.setRange\(30\)/.test(adm));
  ok("admin has the KPI grid", /id="anKpiGrid"/.test(adm));
  ok("admin has the analytics card grid", /id="anRecency"/.test(adm) && /id="anWeekday"/.test(adm) && /id="anMixCanvas"/.test(adm) && /id="anRetention"/.test(adm));
  ok("admin has leaderboards + insights", /id="anTopVideos"/.test(adm) && /id="anTopGroups"/.test(adm) && /id="anInsights"/.test(adm));

  // Pure, testable analytics helpers exposed for headless testing.
  ok("admin exposes pure analytics helpers", /window\.NexaAdminAnalytics\._pure = \{/.test(adm));
  ok("computeKPIs present", /function computeKPIs\(/.test(adm));
  ok("computeRecency present", /function computeRecency\(/.test(adm));
  ok("computeRetention present", /function computeRetention\(/.test(adm));
  ok("buildInsights present", /function buildInsights\(/.test(adm));

  // Content analytics use ONLY signed-in-readable collections (the admin is anon).
  ok("content stats read videos/status/groups/channels",
    /collection\("videos"\)/.test(adm) && /collection\("status"\)/.test(adm) && /collection\("groups"\)/.test(adm) && /collection\("channels"\)/.test(adm));
  ok("content stats never read party-only collections directly",
    !/db\.collection\("chats"\)/.test(adm) && !/db\.collection\("calls"\)/.test(adm) && !/db\.collection\("connections"\)/.test(adm));

  // Table: per-user Videos/Stories columns + new filters + sort.
  ok("table has Videos + Stories columns", /data-sort="videos"/.test(adm) && /data-sort="stories"/.test(adm));
  ok("empty-state colspan matches 10 columns", (adm.match(/colspan="10"/g) || []).length === 2);
  ok("new filters wired (new7d, never)",
    /data-filter="new7d"/.test(adm) && /data-filter="never"/.test(adm) && /currentFilter === "new7d"/.test(adm) && /currentFilter === "never"/.test(adm));
  ok("sort handles videos + stories", /case "videos":/.test(adm) && /case "stories":/.test(adm));

  // Lifecycle hooks.
  ok("analytics init called from initDashboard", /window\.NexaAdminAnalytics\) window\.NexaAdminAnalytics\.init\(\);/.test(adm));
  ok("analytics refresh called from render", /window\.NexaAdminAnalytics\) window\.NexaAdminAnalytics\.refresh\(\);/.test(adm));

  // XSS: leaderboards/rows escape user text.
  ok("leaderboard captions escaped", /escapeHtml\(\(v\.caption \|\| "Untitled"\)/.test(adm));
  ok("group names escaped", /escapeHtml\(\(g\.name \|\| "Group"\)/.test(adm));

  // No party-only collections read client-side (anon admin can never see them).
  ok("no client-side chats/calls analytics scan",
    !/admin\/analytics/.test(adm) && !/id="anEngagementGrid"/.test(adm) && !/fetchBackendStats/.test(adm));
  ok("backend has no analytics endpoint", !/api\/admin\/analytics/.test(api));
}

// ── Settings: "Report a problem" (now live → admin) ────────────────────────
{
  const dash = read("dashboard.html");

  ok("settings has a Support group", /settings-group-title">\s*<i data-lucide="life-buoy"[\s\S]{0,120}Support<\/div>/.test(dash));
  ok("settings has the Report a problem row",
    /id="reportProblemRow"[\s\S]{0,120}openReportModal\(\)/.test(dash) && /Report a problem<\/span>/.test(dash));
  ok("report row is NO LONGER flagged coming soon",
    !/reportProblemRow"[\s\S]{0,400}settings-row-pill">Soon/.test(dash));
}

// ── Videos: comments (like · reply · notify · delete) ──────────────────────
{
  const nv = read("nexa-videos.js");
  const css = read("nexa-videos.css");
  const rules = read("firestore.rules");

  ok("comment like handler defined + exported",
    /function likeComment\(cid\)/.test(nv) && /window\.nexaVideosLikeComment = likeComment;/.test(nv));
  ok("comment reply handler defined + exported",
    /function replyComment\(cid\)/.test(nv) && /window\.nexaVideosReplyComment = replyComment;/.test(nv));
  ok("comment reply cancel defined + exported",
    /function cancelCommentReply\(\)/.test(nv) && /window\.nexaVideosCancelCommentReply = cancelCommentReply;/.test(nv));
  ok("comment likes are a transaction (marker + count together)",
    /runTransaction\(tx => tx\.get\(ref\)/.test(nv) && /collection\('comment_likes'\)/.test(nv));
  ok("comment like markers resolved in ONE batched query (no per-comment get)",
    /where\('cid', 'in', chunk\)/.test(nv));
  ok("replies are grouped client-side (replyTo threading)", /function buildCommentTree\(items\)/.test(nv) && /c\.replyTo/.test(nv));
  ok("reply carries replyTo/replyToName/replyToUid", /doc\.replyTo = reply\.id;/.test(nv) && /doc\.replyToName/.test(nv));
  ok("replying notifies the parent author, else the video author",
    /replied to your comment/.test(nv) && /commented on your video/.test(nv));
  ok("comment action row CSS present",
    /\.nv-comment-acts/.test(css) && /\.nv-comment-like\.liked/.test(css) && /\.nv-comment-reply-chip/.test(css) && /\.nv-comment-child/.test(css));
  ok("rules allow a non-author to bump only `likes`",
    /affectedKeys\(\)\.hasOnly\(\['likes'\]\)/.test(rules));
  ok("rules add the comment_likes subcollection (owner-only create/delete)",
    /match \/comment_likes\/\{likeId\}/.test(rules)
    && /allow create: if isSignedIn\(\)\s*\r?\n\s*&& request\.resource\.data\.uid == request\.auth\.uid;/.test(rules)
    && /allow delete: if isSignedIn\(\)\s*\r?\n\s*&& resource\.data\.uid == request\.auth\.uid;/.test(rules));
  ok("comment_likes delete rule uses resource.data (request.resource is null on delete)",
    !/allow create, delete: if isSignedIn\(\)\s*\r?\n\s*&& request\.resource\.data\.uid/.test(rules));
}

// ── Header bell + profile button ───────────────────────────────────────────
{
  const dash = read("dashboard.html");
  const css = read("dashboard.css");
  const app = read("app-main.js");

  ok("sidebar header has an actions row", /class="nx-head-actions"/.test(dash));
  ok("bell button opens the notification history", /id="nxBellBtn"[^>]*onclick="openNotificationHistory\(\)"/.test(dash));
  ok("bell has an unread badge element", /id="nxBellBadge"/.test(dash));
  ok("profile button opens my profile", /id="nxProfileBtn"[^>]*onclick="openMyProfile\(\)"/.test(dash));
  ok("actions row sits before the tab switcher",
    dash.indexOf("nx-head-actions") < dash.indexOf("sidebar-tab-switcher"));
  ok("header action CSS present", /\.nx-head-btn\b/.test(css) && /\.nx-head-badge\b/.test(css) && /\.nx-bell-ring\b/.test(css));
  ok("desktop header wraps to two rows (brand not collapsed)", /\.top \{[^}]*flex-wrap: wrap/.test(css) && /\.top \.nx-brand \{[^}]*flex: 1 1 auto/.test(css) && /\.top \.sidebar-tab-switcher \{[^}]*flex: 1 1 100%/.test(css));
  ok("phone header hides the redundant desktop tab switcher", /@media \(max-width: 768px\)[\s\S]{0,260}\.top \.sidebar-tab-switcher \{\s*display: none !important/.test(css));
  ok("updateNotificationHistoryBadge also paints the bell badge", /nxBellBadge/.test(app));
  ok("recordNotificationHistory rings the bell", /nxRingBell/.test(app));
  ok("openMyProfile defined", /function openMyProfile\(\)/.test(app));
}

// ── Reports (Settings → Report a problem → admin dashboard) ─────────────────
{
  const dash = read("dashboard.html");
  const app = read("app-main.js");
  const rules = read("firestore.rules");
  const api = read("server/admin-api.js");
  const admin = read("admin.html");
  const css = read("dashboard.css");

  ok("report row opens the real composer (no 'Soon' pill)", /id="reportProblemRow" onclick="openReportModal\(\)"/.test(dash) && !/reportProblemRow"[\s\S]{0,300}settings-row-pill">Soon/.test(dash));
  ok("report composer modal exists", /id="reportModal"/.test(dash));
  ok("report has category chips", /class="report-cat active" data-cat="bug"/.test(dash) && /selectReportCat\('safety'\)/.test(dash));
  ok("report has a textarea + counter", /id="reportText"/.test(dash) && /id="reportCounter"/.test(dash));
  ok("report has an optional screenshot attach", /id="reportFile"/.test(dash) && /previewReportShot\(event\)/.test(dash));
  ok("coming-soon report modal is gone", !/reportComingModal/.test(dash) && !/openReportComing/.test(app));

  ok("openReportModal/closeReportModal defined", /function openReportModal\(\)/.test(app) && /function closeReportModal\(\)/.test(app));
  ok("submitReport writes to the reports collection", /db\.collection\("reports"\)\.add\(/.test(app));
  ok("report carries context (app/platform/tab)", /function reportContext\(\)/.test(app) && /platform:/.test(app));
  ok("report uploads its screenshot through uploadFile", /uploadFile\(file\.files\[0\]\)/.test(app));
  ok("report CSS present", /\.report-cats\b/.test(css) && /\.report-text\b/.test(css) && /\.report-shot-preview\b/.test(css));

  ok("rules add the reports collection", /match \/reports\/\{reportId\}/.test(rules));
  ok("reports are NOT readable from the browser", /match \/reports\/\{reportId\} \{\s*allow read: if false;/.test(rules));
  ok("reports create is owner-only + validated",
    /allow create: if isSignedIn\(\)[\s\S]{0,400}request\.resource\.data\.uid == request\.auth\.uid/.test(rules)
    && /request\.resource\.data\.text\.size\(\) <= 2000/.test(rules));
  ok("reports update/delete denied", /allow update, delete: if false;/.test(rules));

  ok("backend lists reports (Admin SDK)", /app\.get\("\/api\/admin\/reports", requireAdminSecret/.test(api));
  ok("backend sets report status", /app\.post\("\/api\/admin\/report-status", requireAdminSecret/.test(api));

  ok("admin has a Reports section", /🚩 Reports/.test(admin));
  ok("admin Reports section is flagged coming soon",
    /report-soon-card/.test(admin) && /Reports are coming soon/.test(admin));
  ok("admin no longer queries the reports backend (coming soon)",
    !/adminFetchGet\("\/api\/admin\/reports/.test(admin) && !/function loadReports\(/.test(admin) && !/function setReportStatus\(/.test(admin));
  ok("admin init no longer loads reports", !/loadReports\('open'\)/.test(admin));
  ok("backend endpoints stay for the future wiring",
    /app\.get\("\/api\/admin\/reports", requireAdminSecret/.test(api) && /app\.post\("\/api\/admin\/report-status", requireAdminSecret/.test(api));
}

// ── App identity refresh (not "just chatting") ──────────────────────────────
{
  const idx = read("index.html");
  const dash = read("dashboard.html");

  ok("index title leads with more than messaging",
    /<title>Nexa — Chat, Moments, short videos, profiles/.test(idx));
  ok("index description mentions videos + profile/follow",
    /short videos/.test(idx) && /profile you can follow/.test(idx));
  ok("index keywords cover social + video", /Short Videos/.test(idx) && /Profiles/.test(idx) && /Follow/.test(idx));
  ok("hero headline is broader than chat", /Chat, share Moments, watch<br>videos/.test(idx));
  ok("index has a Short videos feature card", /<h3>Short videos<\/h3>/.test(idx));
  ok("index has a profile & followers feature card", /<h3>Your profile &amp; followers<\/h3>/.test(idx));
  ok("OG/Twitter titles refreshed", /og:title" content="Nexa — Chat, Moments, Videos/.test(idx) && /twitter:title" content="Nexa — Chat, Moments, Videos/.test(idx));
  ok("footer no longer says 'messaging' only", /Chat, Moments, videos and live rooms/.test(idx));

  ok("splash tagline broadened", /nexa-splash-tag">Chat · Moments · Video · Live</.test(dash));
  ok("splash still says Nexa", /nexa-splash-name">Nexa</.test(dash));
}

// ── Read-quota cache wiring ─────────────────────────────────────────────────
{
  const app = read("app-main.js");
  ok("cache helper is defined", /function nexaCacheFetch\(/.test(app) && /function nexaCacheRead\(/.test(app));
  ok("cache is cleared on logout", /nexaCacheClearAll\(\);/.test(app));
}

// ── Full profile page ──────────────────────────────────────────────────────
{
  const dash = read("dashboard.html");
  const app = read("app-main.js");
  const css = read("dashboard.css");
  const rules = read("firestore.rules");
  const vids = read("nexa-videos.js");

  ok("profile overlay exists", /id="nxProfilePage"/.test(dash) && /class="nx-profile-overlay"/.test(dash));
  ok("profile has cover + avatar + name + handle", /id="nxProfileCover"/.test(dash) && /id="nxProfileAvatar"/.test(dash) && /id="nxProfileName"/.test(dash) && /id="nxProfileHandle"/.test(dash));
  ok("profile has stats (following/followers/videos)", /id="nxStatFollowing"/.test(dash) && /id="nxStatFollowers"/.test(dash) && /id="nxStatVideos"/.test(dash));
  ok("profile has bio + link", /id="nxProfileBio"/.test(dash) && /id="nxProfileLink"/.test(dash));
  ok("profile has Videos | Liked tabs", /data-tab="videos"/.test(dash) && /data-tab="liked"/.test(dash));
  ok("follow list sheet exists", /id="nxFollowSheet"/.test(dash) && /id="nxFollowList"/.test(dash));
  ok("edit profile modal exists", /id="nxEditProfileModal"/.test(dash) && /id="nxEditBio"/.test(dash) && /id="nxEditLink"/.test(dash));

  ok("nexaProfileOpen + nexaProfileShow defined", /async function nexaProfileOpen\(/.test(app) && /function nexaProfileShow\(/.test(app));
  ok("profile resolves by uid OR @username", /function nexaResolveUser\(/.test(app) && /where\('username', '==', bare\)/.test(app));
  ok("follow toggle defined", /async function nexaToggleFollow\(/.test(app) && /function nexaRelationshipWith\(/.test(app));
  ok("follows listener is a single 2-query listener", /function startFollowsListener\(/.test(app) && /where\('follower', '==', myUid\)/.test(app) && /where\('following', '==', myUid\)/.test(app));
  ok("profile video grid is cached + one listener", /function nexaLoadVideoGrid\(/.test(app) && /nexaCacheWrite\(cacheKey/.test(app));
  ok("liked grid reads the mirror (no collection-group)", /function nexaLoadLikedGrid\(/.test(app) && /collection\('liked_videos'\)/.test(app) && !/collectionGroup/.test(app));
  ok("saved grid reads the mirror (no collection-group)", /function nexaLoadSavedGrid\(/.test(app) && /collection\('saved_videos'\)/.test(app) && !/collectionGroup/.test(app));
  ok("Saved tab exists + is self-only", /data-tab="saved"/.test(dash) && /id="nxPtabSaved"/.test(dash) && /nxProfileTabName === 'saved' && !isSelf/.test(app));
  ok("tab count chips exist (videos/liked/saved)", /id="nxPtabCountVideos"/.test(dash) && /id="nxPtabCountLiked"/.test(dash) && /id="nxPtabCountSaved"/.test(dash) && /function nexaSetTabCount\(/.test(app));
  ok("edit profile saves bio/link/cover (merge, owner doc)", /async function saveEditProfile\(/.test(app) && /bio: bio, link: link, coverUrl/.test(app));
  ok("profile deep link handler exists", /async function checkProfileUrlParam\(/.test(app) && /params.get\('profile'\)/.test(app));
  ok("boot starts the follows listener + profile deep link", /startFollowsListener\(\);/.test(app) && /checkProfileUrlParam\(\);/.test(app));
  ok("profile share builds a ?profile= link", /function nexaShareProfile\(/.test(app) && /\?profile=/.test(app));

  ok("old profile modal now delegates to the full page", /function openUserProfile\(\)[\s\S]{0,300}nexaProfileShow\(selectedUser\)/.test(app));
  ok("header profile button delegates to the full page", /function openMyProfile\(\)[\s\S]{0,200}nexaProfileOpen\(currentUser.uid\)/.test(app));
  ok("profile pic viewer returns to the full profile", /returnTo === 'nxprofile'/.test(app));

  ok("profile CSS present", /\.nx-profile-overlay\b/.test(css) && /\.nx-profile-grid\b/.test(css) && /\.nx-follow-card\b/.test(css) && /\.nx-edit-card\b/.test(css));

  ok("rules add the follows collection", /match \/follows\/\{followId\}/.test(rules));
  ok("follows create is self-sourced + validated",
    /match \/follows\/\{followId\} \{[\s\S]{0,400}request\.resource\.data\.follower == request\.auth\.uid/.test(rules)
    && /request\.resource\.data\.following != request\.auth\.uid/.test(rules));
  ok("follows update is limited to status/updatedAt", /affectedKeys\(\)\.hasOnly\(\['status', 'updatedAt'\]\)/.test(rules));
  ok("users update allows non-owner followCounts credit",
    /affectedKeys\(\)\.hasOnly\(\['followCounts'\]\)/.test(rules));
  ok("users has a liked_videos subcollection rule", /match \/liked_videos\/\{videoId\}/.test(rules) && /allow write: if isOwner\(uid\)/.test(rules));
  ok("users has a saved_videos subcollection rule", /match \/saved_videos\/\{videoId\}/.test(rules) && /allow write: if isOwner\(uid\)/.test(rules));

  ok("video like mirrors into liked_videos", /liked_videos'\).doc\(id\)/.test(vids) && /mirror\.set\(/.test(vids) && /mirror\.delete\(\)/.test(vids));
  ok("video save mirrors into saved_videos", /saved_videos'\)\.doc\(id\)/.test(vids) && /state\.savedMine\[id\]/.test(vids) && /function ensureSavedState\(/.test(vids));
  ok("video author is a profile tap target", /nv-author-tap"[^>]*nexaProfileOpen/.test(vids));
  ok("own profile tiles expose edit/delete", /nx-pv-manage/.test(app) && /nexaVideosEdit\(/.test(app) && /nexaVideosDelete\(/.test(app));

  // ── Follow is INSTANT — there is no request/approve step ─────────────────
  // Following used to have a dead "request → accept" mode that nothing could
  // enable (no UI ever set `followPolicy:'approve'`). It was removed, so a
  // follow is always accepted straight away and the accept UI is gone.
  ok("following is instant (a new follow is accepted, never pending)",
    /status: 'accepted', createdAt: Date\.now\(\), updatedAt: Date\.now\(\) \}\)/.test(app));
  ok("no follow-approval / request machinery remains",
    !/acceptFollowRequest/.test(app) && !/declineFollowRequest/.test(app) &&
    !/Follow requests<\/div>/.test(app));
  // (The Connect feature keeps its own "Requested" button — that is a
  // connection request, not a follow request, so only the FOLLOW branch is
  // asserted gone here.)
  ok("no 'Requested' / pending-follow follow button",
    !/rel\.following === 'pending'/.test(app) && !/'Requested' :/.test(app));
  ok("follow counts move for BOTH sides in one step",
    /await _nexaBumpFollowCounts\(otherUid, myUid, 1, 1\);/.test(app));
  ok("unfollow moves both counts back",
    /await _nexaBumpFollowCounts\(otherUid, myUid, -1, -1\);/.test(app));
  ok("a new follow notifies the target",
    /'started following you', otherUid, \{ isFollow: true, chatUid: myUid \}/.test(app));
  ok("the follow category is gated by the connections toggle",
    /if \(isFollow && !notificationSettings\.connections\) return;/.test(app));
  ok("follow/like/share have distinct notification icons",
    /if \(data\.isVideoLike\) return/.test(app) && /if \(data\.isVideoShare\) return/.test(app) && /if \(data\.isFollow\) return/.test(app));

  // ── Video notifications: interactions yes, publishing no ─────────────────
  ok("posting a video pushes NOTHING",
    !/posted a new video/.test(vids) && !/function notifyConnections/.test(vids));
  ok("liking a video notifies the author",
    /notifyVideoAuthor\(id, 'liked your video', \{ isVideoLike: true \}\)/.test(vids));
  ok("sharing a video notifies the author",
    /notifyVideoAuthor\(id, 'shared your video', \{ isVideoShare: true \}\)/.test(vids));
  ok("commenting still notifies the author / parent",
    /'commented on your video'/.test(vids) && /isVideoComment: true/.test(vids));
  ok("an interaction never notifies yourself",
    /if \(!target \|\| target === myUid\(\) \|\| !window\.sendPushNotification\) return;/.test(vids));
  ok("Settings copy describes interactions, not 'someone posted'",
    /Likes, comments and shares on your videos/.test(dash) && /new followers/.test(dash));
}

// ── Videos: "Add music" field removed ───────────────────────────────────────
{
  const vids = read("nexa-videos.js");
  const vcss = read("nexa-videos.css");
  ok("composer has no music input", !/nvComposerMusic/.test(vids) && !/Add music/.test(vids));
  ok("edit sheet has no music field", !/nvEditMusic/.test(vids));
  ok("post() does not write a music field", !/music: music/.test(vids) && !/const music =/.test(vids));
  ok("feed card renders no music line", !/nv-music/.test(vids));
  ok("My Videos renders no music line", !/nv-mine-music/.test(vids));
  ok("liked-video mirror drops music", !/music: v\.music/.test(vids));
  ok("no music source references remain anywhere in the video module",
    !/\bmusic\b/i.test(vids));
  ok("dead music CSS removed", !/nv-music|nv-composer-music|nv-mine-music/.test(vcss));
}

// ── Videos: Copy on comments ────────────────────────────────────────────────
{
  const vids = read("nexa-videos.js");
  ok("every comment offers Copy", /nv-comment-act"[^>]*nexaVideosCopyComment/.test(vids));
  ok("copyComment copies the comment text",
    /function copyComment\(cid\)/.test(vids) && /copyText\(c\.text \|\| ''/.test(vids));
  ok("copyText has a clipboard + execCommand fallback",
    /function copyText\(payload, okMsg, errMsg\)/.test(vids) &&
    /document\.execCommand\('copy'\)/.test(vids));
  ok("copyComment is exported", /window\.nexaVideosCopyComment = copyComment;/.test(vids));
}

// ── Notification history: tappable → deep link to content ───────────────────
{
  const app = read("app-main.js");
  const css = read("dashboard.css");
  ok("history entries store a target", /target: \(target && target\.type\) \? target : null/.test(app));
  ok("push payloads map to a deep-link target",
    /function notifTargetForData\(data\)/.test(app) &&
    /isVideoComment \|\| data\.isVideoLike \|\| data\.isVideoShare/.test(app) &&
    /return id \? \{ type: 'video', id: String\(id\) \} : \{ type: 'moments' \}/.test(app));
  ok("a video interaction carries videoId so it can deep-link",
    /videoId: id \}\)/.test(read("nexa-videos.js")) &&
    /videoId: id \}/.test(read("nexa-videos.js")));
  ok("FCM + in-app message records pass a target",
    /target: notifTargetForData\(data\)/.test(app) &&
    /target: \{ type: 'chat', uid: uid \}/.test(app));
  ok("history render marks tappable entries (keyed by stable id)",
    /nh-item-tappable/.test(app) && /onclick="nexaOpenNotifItem\('\$\{eid\}', \$\{i\}\)"/.test(app));
  ok("history tap resolves by id first, index fallback",
    /window\.nexaOpenNotifItem = function \(id, index\)/.test(app) &&
    /items\.find\(x => x && x\.id === id\)/.test(app) &&
    /if \(!it\) it = items\[index\]/.test(app));
  ok("tap router opens the content",
    /window\.nexaOpenNotifItem = function \(id, index\)/.test(app) &&
    /openFocus\(t\.id\)/.test(app) &&
    /switchTab\('chats'\)/.test(app) && /selectChat\(u, null\)/.test(app) &&
    /selectGroupChat\(g\)/.test(app) &&
    /nexaProfileOpen\(t\.uid\)/.test(app));
  ok("tappable history rows are styled", /\.nh-item-tappable/.test(css));
  ok("clear history still resets items", /store\.items = \[\]|items: \[\]/.test(app));
  ok("a video notification's OS tap deep-links to ?video=<id>",
    /function notifClickAction\(data\)/.test(app) &&
    /return '\/dashboard\.html\?video=' \+ encodeURIComponent\(t\.id\)/.test(app));
  ok("sendPushNotification stamps click_action for the service worker",
    /if \(!data\.click_action\) data\.click_action = notifClickAction\(data\)/.test(app));
  ok("service worker cache name was bumped for this release",
    /const CACHE_NAME = 'nexa-v14-notifdl';/.test(read("firebase-messaging-sw.js")));
  ok("router is shared (nexaOpenNotifTarget) + history tap delegates to it",
    /window\.nexaOpenNotifTarget = function \(t\)/.test(app) &&
    /window\.nexaOpenNotifItem = function \(id, index\) \{[\s\S]{0,200}nexaOpenNotifTarget\(it\.target\)/.test(app));
  ok("SW posts the tap to the focused app so it can route",
    /client\.postMessage\(\{ type: "nexa-open-notif", data: notifData \}\)/.test(read("firebase-messaging-sw.js")) &&
    /nexa-open-notif/.test(app));
}

// ── Notification-history deep-link router (functional) ─────────────────────
console.log("\n" + "10) notification-history target mapping + tap router");
{
  const app = read("app-main.js");
  const tfn = run(extractFn(app, "notifTargetForData") + "\n;notifTargetForData;", {});
  eq("video comment -> video target", JSON.stringify(tfn({ isVideoComment: true, videoId: "v1" })), JSON.stringify({ type: "video", id: "v1" }));
  eq("video with no id -> moments", JSON.stringify(tfn({ isVideo: true })), JSON.stringify({ type: "moments" }));
  eq("group -> group target", JSON.stringify(tfn({ isGroup: true, chatUid: "g1" })), JSON.stringify({ type: "group", id: "g1" }));
  eq("follow -> profile", JSON.stringify(tfn({ isFollow: true, chatUid: "u5" })), JSON.stringify({ type: "profile", uid: "u5" }));
  eq("plain chat -> chat", JSON.stringify(tfn({ chatUid: "u7" })), JSON.stringify({ type: "chat", uid: "u7" }));
  eq("connect -> connect", JSON.stringify(tfn({ isConnect: true })), JSON.stringify({ type: "connect" }));
  eq("unknown -> null", tfn({}), null);

  // Slice both router functions out by brace matching and drive them.
  const grab = (src, marker) => {
    const s0 = src.indexOf(marker);
    if (s0 < 0) throw new Error("missing " + marker);
    let i = src.indexOf("{", s0), d = 0;
    for (let j = i; j < src.length; j++) { const c = src[j]; if (c === "{") d++; else if (c === "}") { d--; if (!d) return src.slice(s0, j + 1); } }
    throw new Error("unbalanced " + marker);
  };
  const calls = [];
  const ITEMS = [
    { id: "a", target: { type: "video", id: "v1" } },
    { id: "b", target: { type: "chat", uid: "u1" } },
    { id: "c", target: { type: "chat", uid: "ghost" } },
    { id: "d", target: { type: "group", id: "g1" } },
    { id: "e", target: { type: "profile", uid: "u9" } },
    { id: "f", target: { type: "connect" } },
    { id: "g", target: { type: "moments" } },
    { id: "h", target: { type: "community" } },
  ];
  const sb = {
    window: {},
    _nhLoad: () => ({ items: ITEMS }),
    closeNotificationHistory: () => calls.push(["close"]),
    switchTab: (x) => calls.push(["tab", x]),
    switchMomentsSubTab: (x) => calls.push(["mSub", x]),
    allUsersData: [{ uid: "u1" }],
    myGroups: [{ id: "g1" }],
    selectChat: (u) => calls.push(["chat", u.uid]),
    selectGroupChat: (g) => calls.push(["group", g.id]),
    nexaProfileOpen: (uid) => calls.push(["profile", uid]),
    showNotifToast: (m) => calls.push(["toast", m]),
  };
  sb.window.NexaVideos = { openFocus: (id) => calls.push(["video", id]) };
  run(grab(app, "window.nexaOpenNotifTarget = function (t)") + "\n" + grab(app, "window.nexaOpenNotifItem = function (id, index)") + "\n", sb);
  const router = sb.window.nexaOpenNotifItem;

  calls.length = 0; router("a", 0);
  eq("video entry -> Moments>Videos + openFocus",
    JSON.stringify(calls), JSON.stringify([["close"], ["tab", "stories"], ["mSub", "videos"], ["video", "v1"]]));
  calls.length = 0; router("b", 1);
  eq("chat entry -> Chats + selectChat", JSON.stringify(calls), JSON.stringify([["close"], ["tab", "chats"], ["chat", "u1"]]));
  calls.length = 0; router("c", 2);
  eq("missing chat toasts, no navigation", calls.length === 1 && calls[0][0] === "toast", true);
  calls.length = 0; router("d", 3);
  eq("group entry -> Community + selectGroupChat", JSON.stringify(calls), JSON.stringify([["close"], ["tab", "community"], ["group", "g1"]]));
  calls.length = 0; router("e", 4);
  eq("profile entry -> nexaProfileOpen", JSON.stringify(calls), JSON.stringify([["close"], ["profile", "u9"]]));
  calls.length = 0; router("f", 5);
  eq("connect entry -> Connect tab", JSON.stringify(calls), JSON.stringify([["close"], ["tab", "connect"]]));
  calls.length = 0; router("g", 6);
  eq("moments entry -> Moments>Videos", JSON.stringify(calls), JSON.stringify([["close"], ["tab", "stories"], ["mSub", "videos"]]));
  calls.length = 0; router("h", 7);
  eq("community entry -> Community tab", JSON.stringify(calls), JSON.stringify([["close"], ["tab", "community"]]));
  calls.length = 0; router("b", 6);
  eq("id wins over a stale index", JSON.stringify(calls), JSON.stringify([["close"], ["tab", "chats"], ["chat", "u1"]]));
  calls.length = 0; router("zz", 99);
  eq("unknown id + out-of-range index is a no-op", calls.length, 0);
}

console.log("\n" + (fail ? "\u2717 FAILED" : "\u2713 PASSED") + " — " + pass + " passed, " + fail + " failed\n");
process.exit(fail ? 1 : 0);
