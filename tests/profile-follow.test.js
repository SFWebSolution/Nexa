/**
 * Profile follow logic — functional tests.
 *
 * Extracts the REAL `nexaRelationshipWith` helper from app-main.js (brace
 * matching) and exercises the asymmetric follow relationship it derives from
 * the two in-memory maps the follows listener maintains. Pure logic, no
 * Firebase — this is the branch that decides which Follow button the profile
 * shows, so getting it wrong is user-visible.
 *
 * Run: node tests/profile-follow.test.js
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

const source = grab("nexaRelationshipWith");
const sandbox = { _nexaFollowsMap: {}, _nexaFollowsBackMap: {} };
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const { nexaRelationshipWith } = sandbox;

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name); }
}
function setMaps(out, back) {
  sandbox._nexaFollowsMap = out || {};
  sandbox._nexaFollowsBackMap = back || {};
}

// 1. no relationship
setMaps({}, {});
let r = nexaRelationshipWith("bob");
ok("no docs → following null, followsMe false", r.following === null && r.followsMe === false);

// 2. I follow them (accepted)
setMaps({ bob: { follower: "me", following: "bob", status: "accepted" } }, {});
r = nexaRelationshipWith("bob");
ok("accepted outgoing → following:'accepted'", r.following === "accepted");

// 3. pending outgoing
setMaps({ bob: { status: "pending" } }, {});
ok("pending outgoing → following:'pending'", nexaRelationshipWith("bob").following === "pending");

// 4. they follow me (accepted) but I don't follow them → follow-back
setMaps({}, { bob: { follower: "bob", following: "me", status: "accepted" } });
r = nexaRelationshipWith("bob");
ok("accepted incoming → followsMe true, following null", r.followsMe === true && r.following === null);

// 5. mutual
setMaps({ bob: { status: "accepted" } }, { bob: { status: "accepted" } });
r = nexaRelationshipWith("bob");
ok("mutual → following:'accepted' AND followsMe true", r.following === "accepted" && r.followsMe === true);

// 6. incoming PENDING does not count as followsMe (only accepted does)
setMaps({}, { bob: { status: "pending" } });
ok("pending incoming is NOT followsMe", nexaRelationshipWith("bob").followsMe === false);

// 7. unknown uid is safe
setMaps({}, {});
ok("unknown uid returns the empty relationship", JSON.stringify(nexaRelationshipWith("nobody")) === JSON.stringify({ following: null, followsMe: false }));

// 8. missing maps (early call before the listener runs) must not throw
sandbox._nexaFollowsMap = undefined;
sandbox._nexaFollowsBackMap = undefined;
let threw = false, res = null;
try { res = nexaRelationshipWith("bob"); } catch (e) { threw = true; }
ok("undefined maps are tolerated (no throw)", threw === false && res && res.following === null);

console.log("\n" + (fail ? "\u2717 FAILED" : "\u2713 PASSED") + " — " + pass + " passed, " + fail + " failed\n");
process.exit(fail ? 1 : 0);
