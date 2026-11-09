/**
 * Read-quota cache — functional tests.
 *
 * The cache is what keeps the profile / follow / reports surfaces from burning
 * Firestore reads: a hit costs ZERO reads. These tests extract the REAL helper
 * functions from app-main.js (brace matching, same technique as the other
 * suites) and run them against a minimal localStorage stub — no Firebase.
 *
 * Run: node tests/cache.test.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "app-main.js"), "utf8").replace(/\r\n/g, "\n");

// ── Extract a top-level `function name(...) {...}` by brace matching ────────
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

const prefixMatch = SRC.match(/const NEXA_CACHE_PREFIX = "[^"]+";/);
if (!prefixMatch) throw new Error("NEXA_CACHE_PREFIX not found");

const source = [
  prefixMatch[0],
  grab("nexaCacheRead"),
  grab("nexaCacheWrite"),
  grab("nexaCacheClear"),
  grab("nexaCacheFetch"),
  grab("nexaCacheFetchSync"),
  grab("nexaCacheClearAll"),
].join("\n\n");

// ── Minimal localStorage stub ──────────────────────────────────────────────
function makeStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    key(i) { return Array.from(map.keys())[i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(String(k), String(v)); },
    removeItem(k) { map.delete(k); },
    clear() { map.clear(); },
  };
}

const sandbox = { localStorage: makeStorage(), Date, JSON, Number, Promise };
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const {
  nexaCacheRead, nexaCacheWrite, nexaCacheClear,
  nexaCacheFetch, nexaCacheFetchSync, nexaCacheClearAll,
  NEXA_CACHE_PREFIX,
} = sandbox;

// ── Test harness ───────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name); }
}
function reset() { sandbox.localStorage.clear(); }

(async () => {
  // 1. basic write / read round-trip
  reset();
  nexaCacheWrite("profile_u1", { name: "Ada" });
  let hit = nexaCacheRead("profile_u1");
  ok("write then read returns the value", hit && hit.value && hit.value.name === "Ada");
  ok("a fresh entry reports fresh:true", hit && hit.fresh === true);
  ok("age is a small non-negative number", hit && hit.age >= 0 && hit.age < 2000);

  // 2. miss on unknown key
  ok("unknown key returns null", nexaCacheRead("nope") === null);

  // 3. TTL expiry
  reset();
  nexaCacheWrite("k", 1);
  ok("within TTL is fresh", nexaCacheRead("k", 60000).fresh === true);
  ok("past TTL is stale (still returned, fresh:false)", (() => {
    const h = nexaCacheRead("k", -1); // negative TTL => always stale
    return h && h.fresh === false && h.value === 1;
  })());
  ok("no TTL means always fresh", nexaCacheRead("k").fresh === true);

  // 4. corrupt entry is ignored (never throws)
  reset();
  sandbox.localStorage.setItem(NEXA_CACHE_PREFIX + "bad", "{not json");
  ok("corrupt JSON returns null (no throw)", nexaCacheRead("bad") === null);
  sandbox.localStorage.setItem(NEXA_CACHE_PREFIX + "bad2", "42");
  ok("non-object payload returns null", nexaCacheRead("bad2") === null);

  // 5. nexaCacheFetch only runs the fetcher when stale — the read-saver
  reset();
  let calls = 0;
  const fetcher = () => { calls++; return Promise.resolve({ v: calls }); };

  let a = await nexaCacheFetch("feed", 60000, fetcher);
  ok("first fetch calls the fetcher once", calls === 1 && a.v === 1);
  let b = await nexaCacheFetch("feed", 60000, fetcher);
  ok("second fetch is a HIT — fetcher NOT called again", calls === 1 && b.v === 1);
  await nexaCacheFetch("feed", -1, fetcher); // force stale
  ok("stale fetch runs the fetcher again", calls === 2);

  // 6. fetch stores the produced value
  reset();
  await nexaCacheFetch("stored", 60000, () => ({ n: 7 }));
  ok("fetch writes its result to the cache", nexaCacheRead("stored").value.n === 7);

  // 7. sync flavour
  reset();
  let scalls = 0;
  const prod = () => { scalls++; return "x" + scalls; };
  const s1 = nexaCacheFetchSync("s", 60000, prod);
  const s2 = nexaCacheFetchSync("s", 60000, prod);
  ok("sync fetch caches (producer called once)", scalls === 1 && s1 === "x1" && s2 === "x1");

  // 8. clear single
  reset();
  nexaCacheWrite("c", 1);
  nexaCacheClear("c");
  ok("nexaCacheClear removes one entry", nexaCacheRead("c") === null);

  // 9. clear all only touches nexa_cache_* (never other keys)
  reset();
  nexaCacheWrite("a", 1);
  nexaCacheWrite("b", 2);
  sandbox.localStorage.setItem("nexa_cached_users_u1", "keepme");
  sandbox.localStorage.setItem("nexa_latest_msg_time", "keepme2");
  nexaCacheClearAll();
  ok("clearAll drops every nexa_cache_* entry",
    nexaCacheRead("a") === null && nexaCacheRead("b") === null);
  ok("clearAll preserves non-cache localStorage keys",
    sandbox.localStorage.getItem("nexa_cached_users_u1") === "keepme" &&
    sandbox.localStorage.getItem("nexa_latest_msg_time") === "keepme2");

  // 10. quota safety: a setItem throw must not break the caller
  reset();
  const realSet = sandbox.localStorage.setItem;
  sandbox.localStorage.setItem = () => { throw new Error("QuotaExceededError"); };
  let threw = false;
  try { nexaCacheWrite("boom", 1); } catch (e) { threw = true; }
  sandbox.localStorage.setItem = realSet;
  ok("a failing setItem is swallowed (no crash)", threw === false);

  console.log("\n" + (fail ? "\u2717 FAILED" : "\u2713 PASSED") + " — " + pass + " passed, " + fail + " failed\n");
  process.exit(fail ? 1 : 0);
})();
