// node --test
//
// Rules and timers: when they fire, what keeps firing across a repaint, and what stops when the screen goes.
// The kernel decides what is due; this is about the clock around it.
const test = require("node:test");
const assert = require("node:assert");
const { fakePage } = require("../../testkit.js");

/** A page with a clock a test moves, and a note of every action that ran. */
function ruled(screen) {
  const page = fakePage();
  page.run("V2.clock = function () { return __now; }; var __now = 0; var __ran = [];");
  page.run("run = function (action) { __ran.push(action && action.kind ? action.kind : action); };");
  page.run("CURRENT_SCREEN = " + JSON.stringify(screen) + "; STATE = " + JSON.stringify(screen.state || {}) + ";");
  page.run('$("view").innerHTML = node(CURRENT_SCREEN.root); v2RulesSync();');
  return {
    page,
    at: (ms) => { page.run("__now = " + ms + "; v2RulesTick();"); },
    ran: () => JSON.parse(page.run("JSON.stringify(__ran)")),
  };
}

test("an `after` fires once, when its time has come", () => {
  const r = ruled({
    screenId: "nudge", needs: ["rules"],
    rules: [{ id: "nudge", after: 8000, do: { kind: "setState", path: "hint", value: true } }],
    root: { type: "Text", props: { content: "hello" } },
  });
  r.at(1000);
  assert.deepStrictEqual(r.ran(), []);
  r.at(9000);
  assert.deepStrictEqual(r.ran(), ["setState"]);
  r.at(20000);
  assert.deepStrictEqual(r.ran(), ["setState"], "an after is one thing happening, not a timer");
});

test("an `every` keeps its period, and the floor the kernel sets", () => {
  const r = ruled({
    screenId: "tick", needs: ["rules"],
    rules: [{ id: "tick", every: 1000, do: { kind: "setState", path: "now", value: 1 } }],
    root: { type: "Text", props: { content: "x" } },
  });
  r.at(500);
  assert.strictEqual(r.ran().length, 0);
  r.at(1000);
  assert.strictEqual(r.ran().length, 1);
  r.at(1500);
  assert.strictEqual(r.ran().length, 1);
  r.at(2000);
  assert.strictEqual(r.ran().length, 2);
});

test("a `when` fires on the change to true, and only once with `once`", () => {
  const r = ruled({
    screenId: "kb", needs: ["rules", "expr"], state: { ready: false },
    rules: [{ id: "kb", when: { expr: "state.ready" }, do: { kind: "navigate", screen: "done" }, once: true }],
    root: { type: "Text", props: { content: "x" } },
  });
  r.at(100);
  assert.deepStrictEqual(r.ran(), []);
  r.page.run("STATE.ready = true;");
  r.at(200);
  assert.deepStrictEqual(r.ran(), ["navigate"]);
  r.page.run("STATE.ready = false;");
  r.at(300);
  r.page.run("STATE.ready = true;");
  r.at(400);
  assert.deepStrictEqual(r.ran(), ["navigate"], "once means once");
});

test("a repaint keeps the machine, and a new screen stops it", () => {
  const r = ruled({
    screenId: "tick", needs: ["rules"],
    rules: [{ id: "tick", every: 1000, do: { kind: "setState", path: "n", value: 1 } }],
    root: { type: "Text", props: { content: "x" } },
  });
  r.at(1000);
  assert.strictEqual(r.ran().length, 1);
  r.page.run('$("view").innerHTML = node(CURRENT_SCREEN.root); v2RulesSync();');
  r.at(1500);
  assert.strictEqual(r.ran().length, 1, "the period did not start again under the repaint");
  r.page.run('CURRENT_SCREEN = { screenId: "elsewhere", root: { type: "Text" } }; node(CURRENT_SCREEN.root); v2RulesSync();');
  assert.strictEqual(r.page.run("V2_RULES === null"), true);
});

test("a rule a node carries is live only while that node is drawn", () => {
  const screen = {
    screenId: "card", needs: ["rules", "expr"], state: { show: true },
    root: {
      type: "Stack",
      children: [{
        type: "Text", visibleIf: { expr: "state.show" }, props: { content: "hi" },
        rules: [{ id: "card.tick", every: 1000, do: { kind: "setState", path: "n", value: 1 } }],
      }],
    },
  };
  const r = ruled(screen);
  r.at(1000);
  assert.strictEqual(r.ran().length, 1);
  r.page.run('STATE.show = false; $("view").innerHTML = node(CURRENT_SCREEN.root); v2RulesSync();');
  r.at(5000);
  assert.strictEqual(r.ran().length, 1, "the node went, so its rule went with it");
});
