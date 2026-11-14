// node --test
//
// kernel.js: what a screen MEANS — expressions, text with holes, templates, rules, limits and paths — GENERATED
// from the phone's src/sdui/kernel/. Here: the file is exactly what was generated (a hand edit fails), and the
// kernel runs in node the way the window will load it.
//
// Nothing in the window imports it yet; the v2 nodes (sdui/v2/) pick it up.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const FILE = path.join(__dirname, "kernel.js");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const SOURCES = ["limits.ts", "blocks.ts", "paths.ts", "coreGrammar.ts", "format.ts", "expr.ts", "text.ts", "defs.ts", "rules.ts"];

test("kernel.js is the generated file, untouched (regenerate it from the phone, never edit it)", () => {
  const text = fs.readFileSync(FILE, "utf8");
  const body = /body sha256 ([0-9a-f]{64})/.exec(text);
  assert.ok(body, "the header names the body");
  const at = text.indexOf("\n(function (root, factory)");
  assert.ok(at > 0);
  assert.strictEqual(
    sha(text.slice(at + 1)),
    body[1],
    "kernel.js was edited by hand: run `node src/sdui/kernel/genKernel.mjs` in TAILZU-FRONTEND/app",
  );
  const phone = path.resolve(__dirname, "../../../../TAILZU-FRONTEND/app/src/sdui/kernel");
  if (!fs.existsSync(phone)) return;
  for (const name of SOURCES) {
    const want = /** @type {RegExpExecArray} */ (new RegExp(`${name.replace(".", "\\.")} sha256 ([0-9a-f]{64})`).exec(text));
    assert.ok(want, `the header names ${name}`);
    assert.strictEqual(sha(fs.readFileSync(path.join(phone, name), "utf8")), want[1], `${name} changed: regenerate kernel.js`);
  }
});

test("the kernel runs as the window loads it: expressions, text, templates, rules", () => {
  const k = require("./kernel.js");
  assert.strictEqual(k.VOCAB, 2);
  assert.strictEqual(k.BLOCKS.length, 13);
  assert.strictEqual(k.LIMITS.exprOps, 256);

  const state = { done: [1, 2], items: [1, 2, 3], busy: false, title: "{{ state.secret }}", secret: "s3cret" };
  const env = { locale: "en-US", now: Date.UTC(2026, 10, 13), timeZone: "UTC", intl: false };
  assert.strictEqual(k.compileExpr("state.busy ? 0.4 : 1").run({ state }), 1);
  assert.strictEqual(k.compileText("{{ count(state.done) }} of {{ count(state.items) }} done").run({ state, env }), "2 of 3 done");
  assert.strictEqual(k.compileProp(state.title).kind, "constant", "a bare string is never a template");
  assert.strictEqual(k.compileExpr("state.title").run({ state }), "{{ state.secret }}");
  assert.strictEqual(k.compileExpr("state.__proto__").run({ state }), undefined);
  assert.strictEqual(k.tryCompileExpr("state.x = 1").ok, false);

  const row = k.expandTree(
    { type: "Use", def: "row", args: { name: { $: "item.name" } } },
    { row: { root: { type: "Text", props: { content: { $: "args.name" } } } } },
  );
  assert.deepStrictEqual(row.node[k.ARGS_KEY], [{ name: { $: "item.name" } }], "the argument frames, outermost first");

  const { rules, errors } = k.compileRules([{ id: "t", every: 1000, do: "tick" }]);
  assert.deepStrictEqual(errors, []);
  const m = new k.RuleMachine(rules, { now: 0 });
  assert.deepStrictEqual(m.tick({ state }, 500).fired, []);
  assert.strictEqual(m.tick({ state }, 1000).fired.length, 1);

  assert.ok(k.networkPathOk("/v1/notes/n1"));
  assert.ok(!k.networkPathOk("https://evil.test/v1/x"));
  assert.ok(!k.networkPathOk("/v1/.%2e/admin"), "a dot segment the window's URL would resolve out of /v1/");
  assert.ok(!k.localKeyOk("authToken"));
});
