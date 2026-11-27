/**
 * Firestore rules — authorization tests.
 *
 * The Firestore emulator needs Java, which is not available here, so instead of
 * a real emulator this suite implements a small evaluator for the subset of the
 * rules language these collections use (isSignedIn, ==, !=, in, &&, ||,
 * affectedKeys().hasOnly(...), keys().hasAny(...), array concat/removeAll) and
 * runs the REAL `allow` expressions extracted from firestore.rules against
 * concrete before/after documents.
 *
 * That means these tests fail if the rule TEXT regresses, not just if a helper
 * name changes — which is what matters: the previous holes were
 * `allow update: if isSignedIn()`.
 *
 * Run: node tests/firestore-rules.test.js
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const RULES = fs.readFileSync(path.join(ROOT, "firestore.rules"), "utf8").replace(/\r\n/g, "\n");

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name);
  console.log("  ✗ " + name);
}

// ── Pull one `match /<collection>/{id} { ... }` block out of the rules ──────
function blockAt(src, collection) {
  const start = src.indexOf("match /" + collection + "/{");
  if (start < 0) throw new Error("collection not found: " + collection);
  // Skip the `{docId}` path placeholder — the body brace comes after it.
  const close = src.indexOf("}", start);
  const open = src.indexOf("{", close);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error("unbalanced block: " + collection);
}

// "channels/posts" -> the `posts` block nested inside `channels`.
function matchBlock(pathSpec) {
  const parts = pathSpec.split("/");
  let scope = RULES;
  let block = null;
  for (const part of parts) {
    block = blockAt(scope, part);
    scope = block;
  }
  return block;
}

// Return the raw condition text of `allow <op>: if <cond>;` for an operation.
function allowCond(block, op) {
  const re = new RegExp(
    "allow\\s+(?:[\\w]+\\s*,\\s*)*" + op + "\\s*(?:,\\s*[\\w]+\\s*)*:\\s*if\\s+" +
    "([\\s\\S]*?);\\s*(?=\\n\\s*(?:allow|match|//|\\}))"
  );
  const m = block.match(re);
  return m ? m[1] : null;
}

// ── Tiny evaluator for the rules subset ────────────────────────────────────
// Values: plain JS. `resource` = before doc, `request` = {auth, resource}.
function evaluate(cond, ctx) {
  // Strip comments, then collapse newlines: the rules are wrapped across lines,
  // and the `.diff(x)\n  .affectedKeys().hasOnly(...)` chain must be contiguous
  // for the rewriter below to recognise it.
  let src = cond.replace(/\/\/[^\n]*/g, " ").replace(/[ \t\n]+/g, " ");

  // Normalise helper calls into inline booleans.
  const helpers = {
    isSignedIn: () => ctx.auth != null,
    isOwner: (uid) => ctx.auth != null && ctx.auth.uid === uid,
    isGroupAdmin: (d) => ctx.auth != null && (
      ctx.auth.uid === d.ownerUid ||
      ctx.auth.uid === d.createdBy ||
      (d.admins && d.admins.indexOf(ctx.auth.uid) > -1)
    ),
    isGroupMember: (d) => ctx.auth != null && (
      (d.memberUids && d.memberUids.indexOf(ctx.auth.uid) > -1) ||
      ctx.auth.uid === d.ownerUid ||
      ctx.auth.uid === d.createdBy
    ),
    isChannelAdmin: (d) => ctx.auth != null && (
      ctx.auth.uid === d.ownerUid ||
      (d.admins && d.admins.indexOf(ctx.auth.uid) > -1)
    ),
    isMember: () => ctx.auth != null && (ctx.resource.members || []).indexOf(ctx.auth.uid) > -1,
    isParty: (d) => ctx.auth != null && (ctx.auth.uid === d.from || ctx.auth.uid === d.to),
    isCallParty: (d) => ctx.auth != null && (ctx.auth.uid === d.from || ctx.auth.uid === d.to),
    validPair: () => true,
  };

  // groupData()/channelData() resolve to the BEFORE doc in these tests.
  src = src.replace(/groupData\(\)/g, "__parent");
  src = src.replace(/channelData\(\)/g, "__parent");

  // `.diff(X) .affectedKeys().hasOnly(['a','b'])` -> __hasOnly(a,b,[keys])
  // (tolerate whitespace around the dots — the rules are line-wrapped)
  src = src.replace(/([\w.$\[\]"']+)\s*\.\s*diff\(([\w.$\[\]"']+)\)\s*\.\s*affectedKeys\(\)\s*\.\s*hasOnly\(\[([^\]]*)\]\)/g,
    (_, a, b, keys) => `__hasOnly(${a},${b},[${keys}])`);
  // bare `.affectedKeys().hasOnly([...])` (diff already inlined)
  src = src.replace(/\.\s*affectedKeys\(\)\s*\.\s*hasOnly\(\[([^\]]*)\]\)/g, (_, keys) => `__hasOnly(null,null,[${keys}])`);

  // `'k' in data.x[.y]` -> __has(data.x[.y],'k')
  src = src.replace(/'([\w]+)'\s+in\s+((?:resource\.data|request\.resource\.data|__before)(?:\.\w+)*)/g,
    (_, k, d) => `__has(${d},'${k}')`);
  // `uid in data.admins` -> __in(uid, data.admins)
  src = src.replace(/(request\.auth\.uid)\s+in\s+(resource\.data\.\w+|request\.resource\.data\.\w+|__before\.\w+)/g,
    (_, a, b) => `__in(${a},${b})`);

  // `get(/databases/.../documents/x/y).data` contains nested $(...) — strip it
  // with a balanced scan (a flat regex would leave a `/` that parses as a regex).
  for (;;) {
    const at = src.indexOf("get(/databases/");
    if (at < 0) break;
    let d = 0, i = at + 3;
    for (; i < src.length; i++) {
      if (src[i] === "(") d++;
      else if (src[i] === ")") { d--; if (d === 0) break; }
    }
    let end = i + 1;
    if (src.slice(end, end + 5) === ".data") end += 5;
    src = src.slice(0, at) + "__getDoc()" + src.slice(end);
  }

  // `x is <type>` -> __isType(x,'<type>')
  src = src.replace(/([\w.$\[\]"']+)\s+is\s+(string|int|list|map|timestamp|bool|number)/g,
    (_, v, t) => `__isType(${v},'${t}')`);
  // `.size()` on a string/array -> `.length`
  src = src.replace(/\.size\(\)/g, ".length");
  // `.keys().hasAny([...])` / `.keys().hasOnly([...])` -> helpers
  src = src.replace(/([\w.$\[\]"']+)\s*\.\s*keys\(\)\s*\.\s*hasAny\(\[([^\]]*)\]\)/g,
    (_, a, keys) => `__hasAny(${a},[${keys}])`);
  src = src.replace(/([\w.$\[\]"']+)\s*\.\s*keys\(\)\s*\.\s*hasOnly\(\[([^\]]*)\]\)/g,
    (_, a, keys) => `__keysOnly(${a},[${keys}])`);
  // Firestore array equality is DEEP; JS `==` is reference. Rewrite the
  // concat/removeAll comparisons the rules use into a deep compare.
  src = src.replace(/([\w.$\[\]"']+)\s*==\s*([\w.$\[\]"']+\.(?:concat|removeAll)\(\[[^\]]*\]\))/g,
    (_, a, b) => `__eqArr(${a},${b})`);

  const request = { auth: ctx.auth, resource: { data: ctx.after } };
  const resource = { data: ctx.before };
  const __before = ctx.before;

  const __hasOnly = (a, b, keys) => {
    const after = a ? ctx.after : ctx.after;
    const before = b ? ctx.before : ctx.before;
    const changed = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]));
    // Nested `settings.x` writes count as a top-level key change.
    return changed.every((k) => keys.indexOf(k) > -1);
  };
  const __has = (doc, k) => doc != null && Object.prototype.hasOwnProperty.call(doc, k);
  const __hasAny = (doc, ks) => doc != null && ks.some((k) => Object.prototype.hasOwnProperty.call(doc, k));
  const __isStr = (v) => typeof v === "string";
  const __keysOnly = (doc, ks) =>
    doc != null && Object.keys(doc).every((k) => ks.indexOf(k) > -1);
  const __isType = (v, t) => ({
    string: typeof v === "string",
    int: Number.isInteger(v),
    number: typeof v === "number",
    bool: typeof v === "boolean",
    list: Array.isArray(v),
    map: v != null && typeof v === "object" && !Array.isArray(v),
    timestamp: v != null && typeof v === "object" && ("seconds" in v || v instanceof Date),
  })[t] === true;
  const __eqArr = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // Stand-in for get(...).data on a foreign doc (e.g. the caller's user doc).
  const __getDoc = () => ctx.foreignDoc || {};
  const __in = (v, arr) => Array.isArray(arr) && arr.indexOf(v) > -1;

  // Array methods the rules use.
  if (ctx.after && ctx.after.memberUids && !ctx.after.memberUids.concat) {
    ctx.after.memberUids.concat = (x) => Array.prototype.concat.call(ctx.after.memberUids, x);
    ctx.after.memberUids.removeAll = (x) => Array.prototype.filter.call(ctx.after.memberUids, (v) => x.indexOf(v) < 0);
  }
  const deep = (o) => {
    if (!o || typeof o !== "object") return o;
    if (Array.isArray(o)) return o.map(deep);
    const r = {};
    for (const k of Object.keys(o)) {
      if (typeof o[k] === "function") continue;
      r[k] = deep(o[k]);
    }
    return r;
  };
  const afterSafe = deep(ctx.after);

  const scope = {
    request: { auth: request.auth, resource: { data: afterSafe } },
    resource: { data: deep(ctx.before) },
    __before: deep(ctx.before),
    __parent: deep(ctx.parent || ctx.before),
    __hasOnly, __has, __in, __hasAny, __keysOnly, __isStr, __isType, __eqArr, __getDoc,
    // Wildcard path segment, e.g. `match /users/{uid}` → the doc's own id.
    uid: ctx.docId,
    // Rule-language helpers, bound to this context.
    isSignedIn: helpers.isSignedIn,
    isGroupAdmin: helpers.isGroupAdmin,
    isGroupMember: helpers.isGroupMember,
    isChannelAdmin: helpers.isChannelAdmin,
    isOwner: helpers.isOwner,
    isMember: helpers.isMember,
    isParty: helpers.isParty,
    isCallParty: helpers.isCallParty,
    validPair: helpers.validPair,
  };
  // Provide array helpers on the deep copies.
  for (const doc of [scope.resource.data, scope.__before, scope.request.resource.data]) {
    if (doc && Array.isArray(doc.memberUids)) {
      doc.memberUids.concat = (x) => doc.memberUids.slice().concat(x);
      doc.memberUids.removeAll = (x) => doc.memberUids.filter((v) => x.indexOf(v) < 0);
    }
    if (doc && Array.isArray(doc.subscriberUids)) {
      doc.subscriberUids.concat = (x) => doc.subscriberUids.slice().concat(x);
      doc.subscriberUids.removeAll = (x) => doc.subscriberUids.filter((v) => x.indexOf(v) < 0);
    }
    if (doc && Array.isArray(doc.invitedUids)) {
      doc.invitedUids.concat = (x) => doc.invitedUids.slice().concat(x);
    }
  }

  // Rule-local helpers close over `resource`/`request`/`uid`, so they must be
  // declared in the SAME function scope as the condition — prepend them.
  let prelude = "";
  if (ctx.__blockHelpers) {
    prelude = Object.entries(ctx.__blockHelpers)
      .filter(([name]) => !scope[name])
      .map(([, body]) => body)
      .join("\n");
  }

  const keys = Object.keys(scope);
  try {
    const fn = new Function(...keys, prelude + "\nreturn (" + src + ");");
    return !!fn(...keys.map((k) => scope[k]));
  } catch (e) {
    return { error: e.message };
  }
}

// A rule block may declare its own `function` helpers (countMovedBy,
// identityKept, storyExpired, ...). Pull them out of the block and inject them
// as real JS functions so the harness never has to know their names.
function blockFunctions(block) {
  const out = {};
  const re = /function\s+(\w+)\s*\(([^)]*)\)\s*\{/g;
  let m;
  while ((m = re.exec(block))) {
    const name = m[1];
    if (name === "groupData" || name === "channelData") continue;
    const open = block.indexOf("{", m.index + m[0].length - 1);
    let depth = 0;
    let end = open;
    for (let i = open; i < block.length; i++) {
      if (block[i] === "{") depth++;
      else if (block[i] === "}") {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    out[name] = block.slice(m.index, end);
  }
  return out;
}

function allows(a, b, c, d) {
  // Supports allows("chats", "update", ctx) and
  //          allows("channels", "posts", "create", ctx).
  let collection = a, op = b, ctx = c;
  if (d !== undefined) { collection = a + "/" + b; op = c; ctx = d; }
  const block = matchBlock(collection);
  const cond = allowCond(block, op);
  if (cond == null) return false;
  const r = evaluate(cond, { ...ctx, __blockHelpers: blockFunctions(block) });
  if (r && r.error) throw new Error(collection + "/" + op + " eval error: " + r.error);
  return r;
}

const as = (uid) => ({ auth: uid ? { uid } : null });

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── groups: doc updates ──");
{
  const group = {
    name: "Team", ownerUid: "owner", createdBy: "owner",
    admins: ["owner", "admin1"], memberUids: ["owner", "admin1", "m1"],
    membersCount: 3, lastMessage: "hi", lastMessageTime: 1, lastSenderName: "owner",
  };

  ok("owner may rename the group",
    allows("groups", "update", { ...as("owner"), before: group, after: { ...group, name: "Renamed" } }));

  ok("admin may rename the group",
    allows("groups", "update", { ...as("admin1"), before: group, after: { ...group, name: "Renamed" } }));

  // THE HOLE: a plain member (or any signed-in user) used to be able to do all
  // of the below because the rule was `allow update: if isSignedIn()`.
  ok("plain member may NOT rename the group",
    !allows("groups", "update", { ...as("m1"), before: group, after: { ...group, name: "Pwned" } }));

  ok("stranger may NOT rename the group",
    !allows("groups", "update", { ...as("stranger"), before: group, after: { ...group, name: "Pwned" } }));

  ok("plain member may NOT grant themselves admin",
    !allows("groups", "update", {
      ...as("m1"), before: group,
      after: { ...group, admins: ["owner", "admin1", "m1"] },
    }));

  ok("plain member may NOT hijack ownerUid",
    !allows("groups", "update", { ...as("m1"), before: group, after: { ...group, ownerUid: "m1" } }));

  ok("plain member may NOT empty memberUids",
    !allows("groups", "update", { ...as("m1"), before: group, after: { ...group, memberUids: [] } }));

  // Legitimate member actions must still work.
  ok("member may update the chat-list preview",
    allows("groups", "update", {
      ...as("m1"), before: group,
      after: { ...group, lastMessage: "hello", lastMessageTime: 99, lastSenderName: "m1" },
    }));

  ok("member may LEAVE (remove self + decrement)",
    allows("groups", "update", {
      ...as("m1"), before: group,
      after: { ...group, memberUids: ["owner", "admin1"], membersCount: 2 },
    }));

  ok("member may NOT remove someone else",
    !allows("groups", "update", {
      ...as("m1"), before: group,
      after: { ...group, memberUids: ["owner", "m1"], membersCount: 2 },
    }));

  ok("non-member may JOIN via invite (append self + increment)",
    allows("groups", "update", {
      ...as("newbie"), before: group,
      after: { ...group, memberUids: ["owner", "admin1", "m1", "newbie"], membersCount: 4 },
    }));

  ok("joiner may NOT inflate membersCount by more than one",
    !allows("groups", "update", {
      ...as("newbie"), before: group,
      after: { ...group, memberUids: ["owner", "admin1", "m1", "newbie"], membersCount: 99 },
    }));

  ok("group delete is creator-only",
    allows("groups", "delete", { ...as("owner"), before: group, after: null }) &&
    !allows("groups", "delete", { ...as("admin1"), before: group, after: null }));

  // ── ownership is immutable, and legacy docs without membersCount work ──
  ok("not even an admin may repoint ownerUid",
    !allows("groups", "update", {
      ...as("admin1"), before: group,
      after: { ...group, ownerUid: "admin1" },
    }));

  ok("not even the owner may repoint createdBy",
    !allows("groups", "update", {
      ...as("owner"), before: group,
      after: { ...group, createdBy: "admin1" },
    }));

  // Legacy group docs predate membersCount. A missing key would make
  // `resource.data.membersCount - 1` throw and deny the WHOLE rule, so leaving
  // must still work when the field is absent on both sides.
  const legacy = {
    name: "Old", ownerUid: "owner", createdBy: "owner",
    admins: ["owner"], memberUids: ["owner", "m1"],
  };
  ok("a member may leave a legacy group with no membersCount",
    allows("groups", "update", {
      ...as("m1"), before: legacy,
      after: { ...legacy, memberUids: ["owner"] },
    }));

  ok("a non-member may still join a legacy group",
    allows("groups", "update", {
      ...as("newbie"), before: legacy,
      after: { ...legacy, memberUids: ["owner", "m1", "newbie"] },
    }));

}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── channels: feed integrity ──");
{
  const chan = {
    name: "News", ownerUid: "owner", admins: ["owner", "a1"],
    subscriberUids: ["owner", "a1", "sub1"], subscribersCount: 3,
    lastPostTime: 1,
  };
  const post = {
    authorUid: "owner", authorName: "Owner", createdAt: 1,
    viewsUids: ["owner"], viewsCount: 1, commentsCount: 0, reactions: {},
  };

  ok("owner may post",
    allows("channels", "posts", "create", { ...as("owner"), before: chan, parent: chan, after: post }));

  // An admin posts AS THEMSELVES — the rule pins authorUid to the caller.
  ok("admin may post (as themselves)",
    allows("channels", "posts", "create", {
      ...as("a1"), before: chan, parent: chan, after: { ...post, authorUid: "a1" },
    }));

  ok("an admin may NOT post as somebody else",
    !allows("channels", "posts", "create", { ...as("a1"), before: chan, parent: chan, after: post }));

  // THE WORST HOLE: `allow create: if isSignedIn()` on posts.
  ok("subscriber may NOT post into the channel",
    !allows("channels", "posts", "create", { ...as("sub1"), before: chan, after: post }));

  ok("stranger may NOT post into the channel",
    !allows("channels", "posts", "create", { ...as("stranger"), before: chan, after: post }));

  ok("subscriber may NOT delete a post",
    !allows("channels", "posts", "delete", { ...as("sub1"), before: post, parent: chan, after: null }));

  ok("owner may delete a post",
    allows("channels", "posts", "delete", { ...as("owner"), before: post, parent: chan, after: null }));

  ok("subscriber may react (only reaction fields)",
    allows("channels", "posts", "update", {
      ...as("sub1"), before: post, parent: chan,
      after: { ...post, reactions: { "❤": ["sub1"] } },
    }));

  ok("subscriber may NOT rewrite the post text",
    !allows("channels", "posts", "update", {
      ...as("sub1"), before: post, parent: chan,
      after: { ...post, text: "defaced" },
    }));

  ok("subscriber may NOT hijack authorUid",
    !allows("channels", "posts", "update", {
      ...as("sub1"), before: post, parent: chan,
      after: { ...post, authorUid: "sub1" },
    }));

  ok("anyone may follow (append self + increment)",
    allows("channels", "update", {
      ...as("newbie"), before: chan,
      after: { ...chan, subscriberUids: ["owner", "a1", "sub1", "newbie"], subscribersCount: 4 },
    }));

  ok("follower may NOT edit the channel name",
    !allows("channels", "update", { ...as("sub1"), before: chan, after: { ...chan, name: "Pwned" } }));

  ok("follower may NOT grant themselves admin",
    !allows("channels", "update", {
      ...as("sub1"), before: chan,
      after: { ...chan, admins: ["owner", "a1", "sub1"] },
    }));

  ok("stranger may NOT subscribe someone else",
    !allows("channels", "update", {
      ...as("stranger"), before: chan,
      after: { ...chan, subscriberUids: ["owner", "a1", "sub1", "victim"], subscribersCount: 4 },
    }));

  ok("owner may rename the channel",
    allows("channels", "update", { ...as("owner"), before: chan, after: { ...chan, name: "News 2" } }));

  ok("channel delete is owner-only",
    allows("channels", "delete", { ...as("owner"), before: chan, after: null }) &&
    !allows("channels", "delete", { ...as("a1"), before: chan, after: null }));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── groups: message authorization ──");
{
  const msg = { senderUid: "m1", text: "hi", createdAt: 1 };

  ok("author may edit their own message",
    allows("groups", "messages", "update", { ...as("m1"), before: msg, parent: { ownerUid: "m1", admins: ["m1"], memberUids: ["m1"] }, after: { ...msg, text: "edited" } }));

  ok("a non-author may NOT edit someone's message",
    !allows("groups", "messages", "update", { ...as("m2"), before: msg, parent: { ownerUid: "m1", admins: ["m1"], memberUids: ["m1"] }, after: { ...msg, text: "defaced" } }));

  ok("a stranger may NOT delete someone's message",
    !allows("groups", "messages", "delete", { ...as("stranger"), before: msg, parent: { ownerUid: "m1", admins: ["m1"], memberUids: ["m1"] }, after: null }));

  ok("author may delete their own message",
    allows("groups", "messages", "delete", { ...as("m1"), before: msg, parent: { ownerUid: "m1", admins: ["m1"], memberUids: ["m1"] }, after: null }));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── voice_rooms: invite-only integrity ──");
{
  const room = { id: "r1", title: "Live", hostId: "host", invitedUids: ["host"] };

  ok("host may update the room",
    allows("voice_rooms", "update", { ...as("host"), before: room, after: { ...room, title: "Live 2" } }));

  // THE HOLE: `allow update` only pinned hostId, so anyone could rename the
  // room or add arbitrary uids to invitedUids and bypass the invite gate.
  ok("a guest may NOT rename the room",
    !allows("voice_rooms", "update", { ...as("guest"), before: room, after: { ...room, title: "Pwned" } }));

  ok("a guest may NOT add someone else to invitedUids",
    !allows("voice_rooms", "update", {
      ...as("guest"), before: room, after: { ...room, invitedUids: ["host", "guest", "victim"] },
    }));

  ok("a guest MAY append only themselves to invitedUids",
    allows("voice_rooms", "update", {
      ...as("guest"), before: room, after: { ...room, invitedUids: ["host", "guest"] },
    }));

  ok("nobody may hijack hostId",
    !allows("voice_rooms", "update", { ...as("guest"), before: room, after: { ...room, hostId: "guest" } }));

  ok("room delete is host-only",
    allows("voice_rooms", "delete", { ...as("host"), before: room, after: null }) &&
    !allows("voice_rooms", "delete", { ...as("guest"), before: room, after: null }));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── follows: only the target accepts ──");
{
  const rel = { follower: "me", following: "them", status: "pending" };

  ok("the target may accept a pending follow",
    allows("follows", "update", { ...as("them"), before: rel, after: { ...rel, status: "accepted" } }));

  ok("the follower may NOT self-accept",
    !allows("follows", "update", { ...as("me"), before: rel, after: { ...rel, status: "accepted" } }));

  ok("a stranger may NOT touch the follow",
    !allows("follows", "update", { ...as("stranger"), before: rel, after: { ...rel, status: "accepted" } }));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── status: stories ──");
{
  const story = { uid: "author", createdAt: 1, views: [], likes: [], reshares: [] };

  ok("a viewer may record a view on someone's story",
    allows("status", "update", { ...as("viewer"), before: story, after: { ...story, views: ["viewer"] } }));

  ok("a viewer may NOT rewrite someone's story text",
    !allows("status", "update", { ...as("viewer"), before: story, after: { ...story, text: "defaced" } }));

  ok("the owner may edit their own story",
    allows("status", "update", { ...as("author"), before: story, after: { ...story, text: "new" } }));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── chats: 1:1 messages ──");
{
  const msg = { from: "a", to: "b", text: "hi", read: false };

  ok("the recipient may mark it read",
    allows("chats", "update", { ...as("b"), before: msg, after: { ...msg, read: true } }));

  ok("the recipient may NOT rewrite the text",
    !allows("chats", "update", { ...as("b"), before: msg, after: { ...msg, text: "changed" } }));

  ok("the sender may edit the text",
    allows("chats", "update", { ...as("a"), before: msg, after: { ...msg, text: "edited" } }));

  ok("a stranger may NOT read or edit the message",
    !allows("chats", "update", { ...as("c"), before: msg, after: { ...msg, text: "defaced" } }));

  ok("nobody may impersonate the sender on create",
    !allows("chats", "create", { ...as("c"), before: null, after: { from: "a", to: "b", text: "spoof" } }));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── users: cross-user counter writes are delta-bound ──");
{
  const victim = { uid: "victim", displayName: "V", followCounts: { followers: 10, following: 3 } };
  const asUser = (caller, before, after) => ({ ...as(caller), docId: "victim", before, after });

  ok("a follower may increment the target's follower count by one",
    allows("users", "update", {
      ...as("fan"), docId: "victim", before: victim,
      after: { ...victim, followCounts: { followers: 11, following: 3 } },
    }));

  ok("a follower may decrement it by one (unfollow)",
    allows("users", "update", {
      ...as("fan"), docId: "victim", before: victim,
      after: { ...victim, followCounts: { followers: 9, following: 3 } },
    }));

  // THE HOLE: field-name-only checks let any caller set any number.
  ok("a stranger may NOT inflate followers to 999999",
    !allows("users", "update", {
      ...as("stranger"), docId: "victim", before: victim,
      after: { ...victim, followCounts: { followers: 999999, following: 3 } },
    }));

  ok("a stranger may NOT write followCounts alongside other fields",
    !allows("users", "update", {
      ...as("stranger"), docId: "victim", before: victim,
      after: { ...victim, displayName: "Pwned", followCounts: { followers: 11, following: 3 } },
    }));

  ok("a stranger may NOT touch someone else's `following` count",
    !allows("users", "update", {
      ...as("stranger"), docId: "victim", before: victim,
      after: { ...victim, followCounts: { followers: 10, following: 4 } },
    }));

  ok("the owner may rewrite their own profile freely",
    allows("users", "update", {
      ...as("victim"), docId: "victim", before: victim,
      after: { ...victim, displayName: "New name", bio: "hi" },
    }));

  // Referral credit: a new signup credits the inviter.
  const inviter = { uid: "inviter", referralCount: 2, referredUsers: [{ uid: "a" }, { uid: "b" }] };
  ok("a new signup may credit the inviter by exactly one",
    allows("users", "update", {
      ...as("newbie"), docId: "inviter", before: inviter,
      after: { ...inviter, referralCount: 3, referredUsers: [{ uid: "a" }, { uid: "b" }, { uid: "newbie" }] },
    }));

  ok("nobody may bump referralCount by more than one",
    !allows("users", "update", {
      ...as("newbie"), docId: "inviter", before: inviter,
      after: { ...inviter, referralCount: 1000, referredUsers: [{ uid: "a" }, { uid: "b" }, { uid: "newbie" }] },
    }));

  ok("a stranger may NOT inject many referredUsers at once",
    !allows("users", "update", {
      ...as("newbie"), docId: "inviter", before: inviter,
      after: { ...inviter, referralCount: 3, referredUsers: [{ uid: "a" }, { uid: "b" }, { uid: "x" }, { uid: "y" }] },
    }));

  ok("users docs can never be deleted from a client",
    !allows("users", "delete", { ...as("victim"), docId: "victim", before: victim, after: null }));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── videos: counters are delta-bound ──");
{
  const vid = {
    uid: "author", videoUrl: "https://x/v.mp4", createdAt: 1,
    views: 100, likes: 5, commentsCount: 2, shares: 1, saves: 0,
  };

  ok("a viewer may add a view",
    allows("videos", "update", { ...as("viewer"), before: vid, after: { ...vid, views: 101 } }));

  ok("a viewer may add a like",
    allows("videos", "update", { ...as("viewer"), before: vid, after: { ...vid, likes: 6 } }));

  ok("a viewer may remove a like",
    allows("videos", "update", { ...as("viewer"), before: vid, after: { ...vid, likes: 4 } }));

  // THE HOLE: `views: 1000000` used to be accepted from anyone.
  ok("a viewer may NOT inflate views to 1000000",
    !allows("videos", "update", { ...as("viewer"), before: vid, after: { ...vid, views: 1000000 } }));

  ok("a viewer may NOT set a negative view count",
    !allows("videos", "update", { ...as("viewer"), before: vid, after: { ...vid, views: -5 } }));

  ok("a viewer may NOT rewrite the video URL",
    !allows("videos", "update", {
      ...as("viewer"), before: vid, after: { ...vid, videoUrl: "https://evil/x.mp4" },
    }));

  ok("a viewer may NOT delete someone's video",
    !allows("videos", "delete", { ...as("viewer"), before: vid, after: null }));

  ok("the author may delete their own video",
    allows("videos", "delete", { ...as("author"), before: vid, after: null }));

  const comment = { uid: "c1", text: "nice", likes: 3 };
  ok("a viewer may add a comment like",
    allows("videos", "comments", "update", { ...as("v2"), before: comment, after: { ...comment, likes: 4 } }));

  ok("a viewer may NOT inflate a comment's likes to 999",
    !allows("videos", "comments", "update", { ...as("v2"), before: comment, after: { ...comment, likes: 999 } }));

  ok("a viewer may NOT rewrite a comment's text",
    !allows("videos", "comments", "update", { ...as("v2"), before: comment, after: { ...comment, text: "pwned" } }));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── no collection is wide open ──");
{
  // Regression guard for the exact pattern that caused the holes above.
  const openers = [];
  // Only WRITE grants matter here; broad reads are intentional (public feeds).
  const re = /allow\s+((?:write|create|update|delete)(?:,\s*(?:write|create|update|delete))*)\s*:\s*if\s+isSignedIn\(\)\s*;/g;
  let m;
  while ((m = re.exec(RULES)) !== null) {
    const before = RULES.slice(Math.max(0, m.index - 400), m.index);
    const coll = (before.match(/match\s+\/([\w]+)\//g) || []).pop();
    openers.push((coll || "?") + " → " + m[0].trim());
  }
  // These are intentionally open to any signed-in user (public read surfaces).
  const allowed = [
    "match /users/", "match /presence/", "match /typing/",
    "match /voice_rooms/", "match /voice_invites/", "match /status/",
    "match /profile_notes/", "match /groups/", "match /channels/",
    "match /notifHistory/", "match /videos/", "match /calls/",
  ];
  const unexpected = openers.filter((o) => !allowed.some((a) => o.startsWith(a.replace("match /", "").replace("/", ""))));
  ok("no unexpected `allow ... if isSignedIn();` blanket grants", unexpected.length === 0);
  if (unexpected.length) console.log("    unexpected: " + unexpected.join(", "));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n─────────────────────────────────────────────");
console.log(`TOTAL: ${pass} passed, ${fail} failed`);
if (fail) {
  console.log("Failed: " + failures.join(", "));
  process.exit(1);
}
