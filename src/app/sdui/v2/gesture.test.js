// node --test
//
// Gestures: where a drag settles, what counts as a swipe, and the rule that a gesture's values reach the store
// only when the pointer lifts.
const test = require("node:test");
const assert = require("node:assert");
const { fakePage } = require("../../testkit.js");

/** A page with one node under the pointer, its actions written down instead of run. */
function held(screen) {
  const page = fakePage();
  // The clock is pinned, so a drag that starts and ends in one breath has no speed of its own to be carried by.
  page.run("V2.clock = function () { return __now; }; var __now = 1000;");
  page.run("var __ran = []; run = function (a, v) { __ran.push([a && a.kind ? a.kind : a, v]); }; repaint = function () {};");
  page.run("CURRENT_SCREEN = " + JSON.stringify(screen) + "; STATE = " + JSON.stringify(screen.state || {}) + ";");
  page.run('$("view").innerHTML = node(CURRENT_SCREEN.root); v2WireIn($("view"));');
  const el = page.run('$("view").querySelector("[data-v2-n]")');
  const Ev = page.dom.Ev;
  return {
    page, el,
    send: (type, init) => el.dispatchEvent(new Ev(type, init)),
    ran: () => JSON.parse(page.run("JSON.stringify(__ran)")),
    ui: () => JSON.parse(page.run("JSON.stringify(V2.ui)")),
  };
}

test("a drag's own speed carries it, and then the nearest snap wins", () => {
  const page = fakePage();
  const settle = (v, speed, snaps, min, max, ms) =>
    page.run(`v2Settle(${v}, ${speed}, ${JSON.stringify(snaps)}, ${min}, ${max}, ${ms})`);
  assert.strictEqual(settle(10, 0, null, 0, 100, 90), 10);
  assert.strictEqual(settle(10, 0, [0, 50, 100], 0, 100, 90), 0);
  assert.strictEqual(settle(40, 0, [0, 50, 100], 0, 100, 90), 50);
  assert.strictEqual(settle(10, 1000, [0, 50, 100], 0, 100, 90), 100, "flung, it carries past the middle");
  assert.strictEqual(settle(999, 0, null, 0, 100, 90), 100, "never past its run");
});

test("a swipe has to be far enough or fast enough, and says which way", () => {
  const page = fakePage();
  const way = (dx, dy, ms, g) => page.run(`v2SwipeWay(${dx}, ${dy}, ${ms}, ${JSON.stringify(g || {})})`);
  assert.strictEqual(way(-80, 0, 200, {}), "left");
  assert.strictEqual(way(80, 0, 200, {}), "right");
  assert.strictEqual(way(0, -80, 200, {}), "up");
  assert.strictEqual(way(10, 0, 2000, {}), "", "a slow nudge is not a swipe");
  assert.strictEqual(way(20, 0, 20, {}), "right", "a fast one is, even though it is short");
  assert.strictEqual(way(-80, 0, 200, { axis: "y" }), "", "an axis means that axis");
});

test("past its run a drag gives, but only so far", () => {
  const page = fakePage();
  assert.strictEqual(page.run("v2Rubber(50, 0, 100, 120)"), 50);
  assert.strictEqual(page.run("v2Rubber(-40, 0, 100, 120)"), -20);
  assert.strictEqual(page.run("v2Rubber(-1000, 0, 100, 120)"), -120);
});

test("a tap runs what the node said", () => {
  const g = held({
    screenId: "pill", needs: ["gesture"],
    root: { type: "Stack", gestures: [{ kind: "tap", do: { kind: "toast", message: "tapped" } }] },
  });
  g.send("pointerdown", { clientX: 10, clientY: 10 });
  g.send("pointerup", { clientX: 11, clientY: 10 });
  assert.deepStrictEqual(g.ran().map((r) => r[0]), ["toast"]);
});

test("a tap that wandered is not a tap", () => {
  const g = held({
    screenId: "pill", needs: ["gesture"],
    root: { type: "Stack", gestures: [{ kind: "tap", do: { kind: "toast", message: "tapped" } }] },
  });
  g.send("pointerdown", { clientX: 10, clientY: 10 });
  g.send("pointerup", { clientX: 90, clientY: 10 });
  assert.deepStrictEqual(g.ran(), []);
});

test("a drag writes nothing to the store until the pointer lifts, then asks its question", () => {
  const g = held({
    screenId: "slide", needs: ["gesture", "expr"],
    root: {
      type: "Stack",
      gestures: [{
        kind: "drag", axis: "x", into: "pill", min: 0, max: 100,
        commitIf: { expr: "ui.pill.x > 60" }, onCommit: { kind: "toast", message: "done" },
      }],
    },
  });
  g.send("pointerdown", { clientX: 0, clientY: 0 });
  g.send("pointermove", { clientX: 80, clientY: 0 });
  assert.strictEqual(g.page.run("STATE.ui === undefined"), true, "while the finger moves, nothing is in the store");
  assert.strictEqual(g.ui().pill.x, 80, "but motion.drive can see it");
  g.send("pointerup", { clientX: 80, clientY: 0 });
  assert.strictEqual(g.page.run("STATE.ui.pill.x"), 80);
  assert.deepStrictEqual(g.ran().map((r) => r[0]), ["toast"]);
});

test("a drag that did not go far enough commits nothing", () => {
  const g = held({
    screenId: "slide", needs: ["gesture", "expr"],
    root: {
      type: "Stack",
      gestures: [{
        kind: "drag", axis: "x", into: "pill", min: 0, max: 100,
        commitIf: { expr: "ui.pill.x > 60" }, onCommit: { kind: "toast", message: "done" },
        onCancel: { kind: "reloadScreen" },
      }],
    },
  });
  g.send("pointerdown", { clientX: 0, clientY: 0 });
  g.send("pointermove", { clientX: 20, clientY: 0 });
  g.send("pointerup", { clientX: 20, clientY: 0 });
  assert.deepStrictEqual(g.ran().map((r) => r[0]), ["reloadScreen"]);
});

test("a gesture kind a mouse cannot do is not wired at all", () => {
  const g = held({
    screenId: "pinch", needs: ["gesture"],
    root: { type: "Stack", gestures: [{ kind: "pinch", do: { kind: "toast" } }] },
  });
  assert.strictEqual(g.el, null, "nothing to mark: the node carries no gesture this window has");
});
