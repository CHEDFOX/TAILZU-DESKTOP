// node --test
//
// The gesture is a sequence of events with timings, so the clock is injected
// and every case here is written as one: press, wait, release, wait. Nothing
// in this file touches Electron or the key hook.

const test = require("node:test");
const assert = require("node:assert");
const { createTapDetector } = require("./tapDetector.js");

/** A detector with a clock you drive by hand. */
function rig(names = ["Ctrl", "Alt"]) {
  let clock = 1_000_000;
  const fired = [];
  const d = createTapDetector({ names, now: () => clock, onPair: (n) => fired.push(n) });
  return {
    fired,
    wait: (ms) => { clock += ms; },
    down: (n, code) => d.keyDown(n, code),
    up: (n, code) => d.keyUp(n, code),
    /** a mouse button, or the wheel */
    click: () => d.other(),
    /** press and release a key, held for `ms` */
    tap(n, ms = 40) { d.keyDown(n); clock += ms; d.keyUp(n); },
  };
}

// ---- the mouse, and keys already down ---------------------------------------
// The ones that made ordinary use of Ctrl start dictation: nothing here presses
// a second key while Ctrl is held, and every one of them used to pass.

test("Ctrl+click on two things is not a double-tap", () => {
  const r = rig();
  r.down("Ctrl"); r.wait(30); r.click(); r.wait(40); r.up("Ctrl");
  r.wait(220);
  r.down("Ctrl"); r.wait(30); r.click(); r.wait(40); r.up("Ctrl");
  assert.deepStrictEqual(r.fired, []);
});

test("Ctrl+wheel twice, to zoom, is not a double-tap", () => {
  const r = rig();
  r.down("Ctrl"); r.wait(20); r.click(); r.click(); r.wait(30); r.up("Ctrl");
  r.wait(150);
  r.down("Ctrl"); r.wait(20); r.click(); r.wait(30); r.up("Ctrl");
  assert.deepStrictEqual(r.fired, []);
});

test("a click between two taps means they were two things", () => {
  const r = rig();
  r.tap("Ctrl"); r.wait(100); r.click(); r.wait(100); r.tap("Ctrl");
  assert.deepStrictEqual(r.fired, []);
});

test("a letter between two taps means they were two things", () => {
  const r = rig();
  r.tap("Ctrl"); r.wait(80); r.down(null, 30); r.up(null, 30); r.wait(80); r.tap("Ctrl");
  assert.deepStrictEqual(r.fired, []);
});

test("Ctrl pressed while Shift is already down is a chord", () => {
  const r = rig();
  r.down(null, 42);                 // shift, first
  r.wait(60);
  r.tap("Ctrl"); r.wait(120); r.tap("Ctrl");
  r.up(null, 42);
  assert.deepStrictEqual(r.fired, []);
});

test("a release the hook never saw does not lock the gesture out for good", () => {
  const r = rig();
  r.down(null, 42);                 // and its keyup went to another window
  r.wait(9000);
  r.tap("Ctrl"); r.wait(120); r.tap("Ctrl");
  assert.deepStrictEqual(r.fired, ["Ctrl"]);
});

test("the gesture still works right after a click elsewhere", () => {
  const r = rig();
  r.click(); r.wait(300);
  r.tap("Ctrl"); r.wait(120); r.tap("Ctrl");
  assert.deepStrictEqual(r.fired, ["Ctrl"]);
});

test("two quick taps fire once", () => {
  const r = rig();
  r.tap("Ctrl");
  r.wait(120);
  r.tap("Ctrl");
  assert.deepStrictEqual(r.fired, ["Ctrl"]);
});

test("a third tap does not fire again — the pair is spent", () => {
  const r = rig();
  r.tap("Ctrl");
  r.wait(120);
  r.tap("Ctrl");
  r.wait(120);
  r.tap("Ctrl");
  assert.deepStrictEqual(r.fired, ["Ctrl"]);
});

test("one tap on its own never fires", () => {
  const r = rig();
  r.tap("Ctrl");
  r.wait(5000);
  assert.deepStrictEqual(r.fired, []);
});

test("two taps too far apart are two separate uses of the key", () => {
  const r = rig();
  r.tap("Ctrl");
  r.wait(900);
  r.tap("Ctrl");
  assert.deepStrictEqual(r.fired, []);
});

test("holding the key is not a tap", () => {
  const r = rig();
  r.down("Ctrl");
  r.wait(1200);
  r.up("Ctrl");
  r.wait(120);
  r.tap("Ctrl");
  assert.deepStrictEqual(r.fired, []);
});

// THE BUG THIS FILE EXISTS FOR.
//
// Windows repeats a held key and the hook reports each repeat as its own press
// and release: short, clean, and inside the pair window. Every guard passed, so
// holding Ctrl for a second started dictation and holding it again stopped it.
test("a held key repeating under Windows is not a double-tap", () => {
  const r = rig();
  r.down("Ctrl");
  r.wait(500);                 // the delay before Windows starts repeating
  for (let i = 0; i < 40; i++) {
    r.up("Ctrl");              // the repeat arrives as release + press…
    r.wait(2);
    r.down("Ctrl");            // …about thirty milliseconds apart
    r.wait(30);
  }
  r.up("Ctrl");
  assert.deepStrictEqual(r.fired, [], "a long press must never start dictation");
});

test("the key still works right after a repeat train ends", () => {
  const r = rig();
  r.down("Ctrl");
  r.wait(500);
  for (let i = 0; i < 20; i++) { r.up("Ctrl"); r.wait(2); r.down("Ctrl"); r.wait(30); }
  r.up("Ctrl");
  assert.deepStrictEqual(r.fired, []);
  // Hand off the key, then use it properly.
  r.wait(400);
  r.tap("Ctrl");
  r.wait(120);
  r.tap("Ctrl");
  assert.deepStrictEqual(r.fired, ["Ctrl"], "the gesture must survive a hold");
});

test("Ctrl+C Ctrl+V does not dictate", () => {
  const r = rig();
  for (const letter of ["C", "V"]) {
    r.down("Ctrl");
    r.wait(30);
    r.down(null);              // the letter — any key we do not watch
    r.wait(40);
    r.up("Ctrl");
    r.wait(150);
  }
  assert.deepStrictEqual(r.fired, []);
});

test("Ctrl then Alt is not a pair — a pair is the same key twice", () => {
  const r = rig();
  r.tap("Ctrl");
  r.wait(120);
  r.tap("Alt");
  assert.deepStrictEqual(r.fired, []);
});

test("each watched key keeps its own pair", () => {
  const r = rig();
  r.tap("Alt");
  r.wait(120);
  r.tap("Alt");
  assert.deepStrictEqual(r.fired, ["Alt"]);
});

test("a release the hook has no press for is ignored", () => {
  const r = rig();
  r.up("Ctrl");                // the hook missed the press
  r.wait(120);
  r.up("Ctrl");
  assert.deepStrictEqual(r.fired, []);
});

test("a key we do not watch is ignored entirely", () => {
  const r = rig();
  r.tap(null);
  r.wait(120);
  r.tap(null);
  assert.deepStrictEqual(r.fired, []);
});
