// node --test
//
// `local.*`: what this computer remembers between launches, who it belongs to, and what it refuses to keep.
const test = require("node:test");
const assert = require("node:assert");
const { fakePage } = require("../../testkit.js");

/** A page with a localStorage that behaves like one. */
function stored(session) {
  const page = fakePage();
  const data = new Map();
  // The window has one; node does not, so the page is given the browser's.
  page.g.atob = (b) => Buffer.from(b, "base64").toString("binary");
  page.g.localStorage = {
    get length() { return data.size; },
    key: (i) => [...data.keys()][i],
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
  };
  if (session) page.run("SESSION = " + JSON.stringify(session) + ";");
  return { page, data };
}

/** A token like the one Supabase hands back: header, body, signature. The body is the only part read. */
function token(sub) {
  const body = Buffer.from(JSON.stringify({ sub })).toString("base64").replace(/=+$/, "");
  return { access_token: "h." + body + ".s" };
}

test("a value written is a value read back, under the account that wrote it", () => {
  const { page, data } = stored(token("user-1"));
  assert.strictEqual(page.run('v2LocalSet("hint.dismissed", true)'), "");
  assert.strictEqual(page.run('v2LocalAll().hint.dismissed'), true);
  assert.ok([...data.keys()].some((k) => k.indexOf("user-1") !== -1), "the key says whose it is");
});

test("signing out empties it, and the next person starts with nothing", () => {
  const { page } = stored(token("user-1"));
  page.run('v2LocalSet("hint.dismissed", true)');
  // A reload after sign-out: no session, and the namespace is worked out again.
  page.run("SESSION = null; V2_LOCAL_NS = null; V2_LOCAL_CACHE = null;");
  assert.deepStrictEqual(JSON.parse(page.run("JSON.stringify(v2LocalAll())")), {});
  page.run("SESSION = " + JSON.stringify(token("user-1")) + "; V2_LOCAL_NS = null; V2_LOCAL_CACHE = null;");
  assert.deepStrictEqual(JSON.parse(page.run("JSON.stringify(v2LocalAll())")), {}, "what was wiped stays wiped");
});

test("a name that reads like a secret is refused, and so is a path that climbs", () => {
  const { page } = stored(token("user-1"));
  assert.match(page.run('v2LocalSet("sessionToken", "x")'), /secret/);
  assert.match(page.run('v2LocalSet("api_key", "x")'), /secret/);
  assert.notStrictEqual(page.run('v2LocalSet("__proto__", "x")'), "");
  assert.notStrictEqual(page.run('v2LocalSet("a b", "x")'), "");
  assert.strictEqual(page.run('v2LocalSet("lastChoice", "hi")'), "");
});

test("a value too big for the shelf is refused, and nothing is half-written", () => {
  const { page } = stored(token("user-1"));
  page.run('var big = new Array(9000).join("x");');
  assert.strictEqual(page.run('v2LocalSet("draft", big)'), "value too large");
  assert.strictEqual(page.run("v2LocalAll().draft"), undefined);
});

test("the local.set action goes through the block, and a refusal runs the action's onError", () => {
  const { page } = stored(token("user-1"));
  page.run("var __err = 0;");
  page.run('CURRENT_SCREEN = { screenId: "s", needs: ["local"], root: { type: "Text" } }; STATE = {}; node(CURRENT_SCREEN.root); v2RunHook();');
  page.run('run({ kind: "local.set", path: "hint", value: 1 });');
  assert.strictEqual(page.run("v2LocalAll().hint"), 1);
  page.run('run({ kind: "local.remove", path: "hint" });');
  assert.strictEqual(page.run("v2LocalAll().hint"), undefined);
});
