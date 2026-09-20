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
    down: (n) => d.keyDown(n),
    up: (n) => d.keyUp(n),
    /** press and release a key, held for `ms` */
    tap(n, ms = 40) { d.keyDown(n); clock += ms; d.keyUp(n); },
  };
}

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
