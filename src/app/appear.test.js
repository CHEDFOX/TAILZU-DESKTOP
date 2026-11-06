// node --test
//
// A node's onAppear (sdui/nodes.js appearAt, navigation.js appearNew), as the phones run it: once as the node comes onto the screen,
// never again while it stays, again when it comes back; and the hand-off screen a notification opens, which opens Maps by itself.
const test = require("node:test");
const assert = require("node:assert");
const { fakePage } = require("./testkit.js");

const set = (path, value) => ({ kind: "setState", path, value });
const append = (path, value) => ({ kind: "appendState", path, value });

function page(root, state, o = {}) {
  const opened = [];
  const p = fakePage({ bridge: { openExternal: (u) => opened.push(u) } });
  p.ctx.__sc = { screenId: o.screenId || "bots.test", look: "bots", root, state: state || {} };
  p.run("ENV = { baseUrl: 'https://api.test' }; STACK = [{ screenId: __sc.screenId, params: {} }]; STATE = Object.assign({}, __sc.state); repaint(__sc)");
  return { p, opened, state: (k) => JSON.parse(JSON.stringify(p.run("STATE")))[k] };
}

test("onAppear runs once as its node comes onto the screen, and not again on a repaint while it stays", async () => {
  const { p, state } = page({ type: "Stack", on: { onAppear: append("ran", "root") }, children: [{ type: "Text", props: { content: "Hi" } }] }, { ran: [] });
  await p.settle();
  assert.deepStrictEqual(state("ran"), ["root"]);
  p.run("repaint()");
  await p.settle();
  assert.deepStrictEqual(state("ran"), ["root"], "the same node, still there: not again");
});

test("a node a setState shows runs its onAppear then; hidden and shown again, it runs again", async () => {
  const root = { type: "Stack", children: [
    { type: "Text", visibleIf: { truthy: "open" }, props: { content: "Here" }, on: { onAppear: append("ran", "shown") } },
  ] };
  const { p, state } = page(root, { ran: [], open: false });
  await p.settle();
  assert.deepStrictEqual(state("ran"), [], "hidden: nothing");
  p.ctx.__a = set("open", true);
  p.run("run(__a)");
  await p.settle();
  assert.deepStrictEqual(state("ran"), ["shown"]);
  p.ctx.__a = set("open", false);
  p.run("run(__a)");
  await p.settle();
  p.ctx.__a = set("open", true);
  p.run("run(__a)");
  await p.settle();
  assert.deepStrictEqual(state("ran"), ["shown", "shown"]);
});

test("two nodes with the same onAppear are two nodes, and another screen starts afresh", async () => {
  const root = { type: "Stack", children: [
    { type: "Text", props: { content: "a" }, on: { onAppear: append("ran", "x") } },
    { type: "Text", props: { content: "b" }, on: { onAppear: append("ran", "x") } },
  ] };
  const { p, state } = page(root, { ran: [] });
  await p.settle();
  assert.deepStrictEqual(state("ran"), ["x", "x"]);
  p.run("repaint()");
  await p.settle();
  assert.deepStrictEqual(state("ran"), ["x", "x"]);
  // The same screen opened again (a new place in the stack) is a new screen.
  p.run("STACK = [{ screenId: 'bots.test', params: {} }]; repaint._next = STACK[0]; repaint(__sc)");
  await p.settle();
  assert.deepStrictEqual(state("ran"), ["x", "x", "x", "x"]);
});

test("the hand-off screen a leave-by notification opens: Maps opens as it appears, then the Plan", async () => {
  const url = "https://www.google.com/maps/dir/?api=1&destination=Indiranagar&travelmode=driving";
  const go = { kind: "sequence", actions: [{ kind: "openUrl", url, handoff: true }, set("home", true)] };
  const root = { type: "Stack", children: [{ type: "Text", props: { content: "Opening Maps…" } }], on: { onAppear: go } };
  const { p, opened, state } = page(root, {}, { screenId: "bots.plan.go" });
  await p.settle();
  assert.deepStrictEqual(opened, [url]);
  assert.strictEqual(state("home"), true);
  p.run("repaint()");
  await p.settle();
  assert.deepStrictEqual(opened, [url], "once");
});
