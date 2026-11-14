// node --test
//
// The Input node: what each kind stores, what it refuses to store, and a field that writes its value to the path
// the node named.
const test = require("node:test");
const assert = require("node:assert");
const { fakePage } = require("../../testkit.js");

function paint(page, screen) {
  page.run("CURRENT_SCREEN = " + JSON.stringify(screen) + "; STATE = " + JSON.stringify(screen.state || {}) + ";");
  page.run('$("view").innerHTML = node(CURRENT_SCREEN.root); v2WireIn($("view"));');
}

test("a line never keeps a newline or a control character, and is capped", () => {
  const page = fakePage();
  assert.strictEqual(page.run('v2Line("one\\ntwo", 512)'), "one two");
  assert.strictEqual(page.run('v2Line("a\\u202eb", 512)'), "ab");
  assert.strictEqual(page.run('v2Line("abcdef", 3)'), "abc");
  assert.strictEqual(page.run('v2Text("one\\r\\ntwo", 8192)'), "one\ntwo");
});

test("a code is its letters and digits, upper case, as long as the field asked for", () => {
  const page = fakePage();
  assert.strictEqual(page.run('v2Code("7kq-29d", 6, false)'), "7KQ29D");
  assert.strictEqual(page.run('v2Code("7kq 29d 1", 6, false)'), "7KQ29D");
  assert.strictEqual(page.run('v2Code("12a34", 6, true)'), "1234");
});

test("a number is a number as it is typed, and only then clamped", () => {
  const page = fakePage();
  const num = (raw, shape) => JSON.parse(page.run(`JSON.stringify(v2Number(${JSON.stringify(raw)}, ${JSON.stringify(shape || {})}))`));
  assert.deepStrictEqual(num("1."), { text: "1.", value: 1 });
  assert.deepStrictEqual(num("-"), { text: "", value: null }, "a minus is only kept where below zero is allowed");
  assert.deepStrictEqual(num("-2", { min: -5 }), { text: "-2", value: -2 });
  assert.deepStrictEqual(num("9", { min: 0, max: 5 }), { text: "9", value: 5 });
  assert.deepStrictEqual(num("1.239", { decimals: 2 }), { text: "1.23", value: 1.23 });
  assert.deepStrictEqual(num("1.5", { decimals: 0 }), { text: "15", value: 15 });
});

test("a slider's value sits on its step and inside its run", () => {
  const page = fakePage();
  assert.strictEqual(page.run("v2Step(0.34, 0, 1, 0.25)"), 0.25);
  assert.strictEqual(page.run("v2Step(99, 0, 10, 1)"), 10);
  assert.strictEqual(page.run("v2Step(NaN, 0, 10, 1)"), 0);
});

test("options are pairs, without a value twice", () => {
  const page = fakePage();
  const opts = JSON.parse(page.run('JSON.stringify(v2Options(["a", { value: "b", label: "Bee" }, { id: "b", title: "again" }]))'));
  assert.deepStrictEqual(opts, [{ value: "a", label: "a" }, { value: "b", label: "Bee" }]);
});

test("a text field writes what was typed to the path the node named", () => {
  const page = fakePage();
  paint(page, {
    screenId: "ask", needs: ["input"], state: { q: "" },
    root: { type: "Input", props: { kind: "text", label: "Ask" }, bind: { value: "q" } },
  });
  const field = page.run('$("view").querySelector("[data-v2-f]")');
  field.type("hello");
  assert.strictEqual(page.run("STATE.q"), "hello");
});

test("a switch flips what it is bound to", () => {
  const page = fakePage();
  paint(page, {
    screenId: "set", needs: ["input"], state: { on: false },
    root: { type: "Input", props: { kind: "switch", label: "Sounds" }, bind: { value: "on" } },
  });
  page.run('$("view").querySelector("[data-v2-f]").click()');
  assert.strictEqual(page.run("STATE.on"), true);
});

test("a kind this window does not have draws the node's fallback", () => {
  const page = fakePage();
  paint(page, {
    screenId: "odd", needs: ["input"],
    root: { type: "Input", props: { kind: "hologram" }, fallback: { type: "Text", props: { content: "not here" } } },
  });
  assert.match(page.run('$("view").innerHTML'), /not here/);
});
