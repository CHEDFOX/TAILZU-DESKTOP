// node --test
//
// The split pill: while it listens it comes apart, ✕ to the left edge of the
// screen and ✓ to the right, with a thread between them the voice plucks; on
// stop it is whole again where it started. The owner: "When stop listening,
// the pill will assemble again and complete shape, initial position."

const test = require("node:test");
const assert = require("node:assert");
const SP = require("./pillSplit.js");

const W = 1920, PILL = { x: (W - 188) / 2, y: 80, w: 188, h: 38 };

test("joined, the halves sit where the ✕ and the ✓ are in the pill", () => {
  const p = SP.pods(PILL, W, 0, 22);
  assert.strictEqual(p.lx, PILL.x + 19);
  assert.strictEqual(p.rx, PILL.x + PILL.w - 19);
  assert.strictEqual(p.cy, PILL.y + 19);
});

test("apart, they reach the two edges of the screen, the inset kept", () => {
  const p = SP.pods(PILL, W, 1, 22);
  assert.strictEqual(p.lx, 22 + 19);
  assert.strictEqual(p.rx, W - 22 - 19);
  // Half way, half way: symmetric about the middle, so the pill reassembles where it was.
  const h = SP.pods(PILL, W, 0.5, 22);
  assert.ok(Math.abs((h.lx + h.rx) / 2 - W / 2) < 1e-9);
});

test("a window narrower than the pill never pulls the halves inward", () => {
  const p = SP.pods({ x: 0, y: 0, w: 188, h: 38 }, 120, 1, 22);
  assert.strictEqual(p.lx, 19);
  assert.strictEqual(p.rx, 188 - 19);
});

test("the easing glides out of place and into it, and ends where it says", () => {
  assert.strictEqual(SP.easeInOut(0), 0);
  assert.strictEqual(SP.easeInOut(1), 1);
  assert.ok(SP.easeInOut(0.1) < 0.1, "slow to leave");
  assert.ok(SP.easeInOut(0.9) > 0.9, "slow to arrive");
  assert.ok(Math.abs(SP.easeInOut(0.5) - 0.5) < 1e-9);
});

test("the separation is a spring: it stretches out taut and is pulled home", () => {
  // Coming apart: settles at ~1, and the stretch does not run past the edge cap.
  const out = { x: 0, v: 0 };
  let maxOut = 0;
  for (let i = 0; i < 300; i++) { SP.spring(out, 1, {}, 1 / 60); maxOut = Math.max(maxOut, out.x); }
  assert.ok(Math.abs(out.x - 1) < 0.02, `apart settles at 1 (${out.x.toFixed(3)})`);
  assert.ok(maxOut <= 1.12 + 1e-9, "the stretch stays within its cap");
  assert.ok(!SP.springMoving(out, 1), "and it comes to rest");

  // Pulled home: a yank that overshoots the join (goes below 0) — the capsule's
  // click-shut absorbs it — then settles at 0, overshoot bounded.
  const home = { x: 1, v: 0 };
  let minIn = 1;
  for (let i = 0; i < 300; i++) { SP.spring(home, 0, {}, 1 / 60); minIn = Math.min(minIn, home.x); }
  assert.ok(minIn < 0, `the pull overshoots the join (${minIn.toFixed(3)})`);
  assert.ok(minIn >= -0.12 - 1e-9, "but the overshoot is bounded");
  assert.ok(Math.abs(home.x) < 0.02, `home settles at 0 (${home.x.toFixed(3)})`);
});

test("home is pulled faster than it stretches apart — the thread's tension", () => {
  const out = { x: 0, v: 0 }, home = { x: 1, v: 0 };
  let tOut = Infinity, tIn = Infinity;
  for (let i = 0; i < 1200; i++) {
    SP.spring(out, 1, {}, 1 / 120); SP.spring(home, 0, {}, 1 / 120);
    if (out.x >= 0.5 && tOut === Infinity) tOut = i;
    if (home.x <= 0.5 && tIn === Infinity) tIn = i;
  }
  assert.ok(tIn < tOut, `the pull home reaches halfway first (${tIn} < ${tOut})`);
});

test("a settled spring reports no motion, a mid-flight one does", () => {
  assert.ok(!SP.springMoving({ x: 0, v: 0 }, 0), "at home, at rest: still");
  assert.ok(!SP.springMoving({ x: 1, v: 0 }, 1), "apart, at rest: still");
  assert.ok(SP.springMoving({ x: 0.5, v: 0 }, 1), "between: moving");
  assert.ok(SP.springMoving({ x: 1, v: -2 }, 1), "carrying speed: moving");
});

test("a click finds the half it is on, and nothing between them", () => {
  const p = SP.pods(PILL, W, 1, 22);
  assert.strictEqual(SP.podAt(p, p.lx + 5, p.cy - 5), "cancel");
  assert.strictEqual(SP.podAt(p, p.rx - 5, p.cy + 5), "finish");
  // The thread and the screen between the halves stay the app's.
  assert.strictEqual(SP.podAt(p, W / 2, p.cy), null);
  assert.strictEqual(SP.podAt(p, p.lx + p.r + 3, p.cy), null);
  assert.strictEqual(SP.podAt(p, p.lx + p.r + 3, p.cy, 4), "cancel", "the pad reaches a little past the edge");
});

test("the body gives way to the thread as the halves leave, and comes back before they meet", () => {
  const joined = SP.fades(0), apart = SP.fades(1);
  assert.deepStrictEqual(joined, { body: 1, thread: 0, disc: 0 });
  assert.deepStrictEqual(apart, { body: 0, thread: 1, disc: 1 });
  const early = SP.fades(0.15);
  assert.ok(early.disc > 0.5, "each half is its own disc as soon as it is out");
  assert.ok(early.body > 0.5, "the body is still mostly there");
});

test("the thread hangs still at its ends and rings with the voice", () => {
  const th = SP.createThread();
  const quiet = th.points(100, 1800, 80, 0, 64, null, {});
  assert.strictEqual(quiet.length, 65);
  assert.deepStrictEqual(quiet[0], [100, 80]);
  assert.deepStrictEqual(quiet[64], [1800, 80]);
  const swing = (pts) => Math.max(...pts.map((p) => Math.abs(p[1] - 80)));
  assert.ok(swing(quiet) < 6, "quiet: a little slack and a sway, no more");

  // Talking: the low bands swing it, and it rises within a tenth of a second.
  const loud = new Float32Array(12).fill(0.8);
  for (let i = 0; i < 6; i++) th.step(1 / 60, loud, true, {});
  let most = 0;
  for (let f = 0; f < 30; f++) { th.step(1 / 60, loud, true, {}); most = Math.max(most, swing(th.points(100, 1800, 80, f / 60, 64, null, {}))); }
  assert.ok(most > 10, `talking moves it (${most.toFixed(1)}px)`);
  assert.ok(most < 40, `but it stays in the window's strip (${most.toFixed(1)}px)`);

  // Stopped talking: it dies away rather than freezing mid-swing.
  for (let i = 0; i < 90; i++) th.step(1 / 60, null, false, {});
  assert.ok(th.energy() < 1.5, `it settles (${th.energy().toFixed(2)})`);
});

test("a pause that writes a chunk plucks it, within bounds", () => {
  const th = SP.createThread();
  th.pluck(0.7, { amp: 18 });
  assert.ok(th.modes[0].a > 10);
  for (let i = 0; i < 5; i++) th.pluck(0.7, { amp: 18 });
  assert.ok(th.modes[0].a <= 18 * 1.4 + 1e-9, "plucked again and again, it does not grow without end");
});

test("a short gap does not take a tall swing", () => {
  const th = SP.createThread();
  th.pluck(1, { amp: 18 });
  const short = th.points(900, 960, 80, 0.3, 16, null, {});
  assert.ok(Math.max(...short.map((p) => Math.abs(p[1] - 80))) < 6);
});

test("the hand's tremor holds for a frame and changes at the next", () => {
  const a = SP.tremor(7, 0.8), b = SP.tremor(7, 0.8), c = SP.tremor(8, 0.8);
  assert.strictEqual(a(5), b(5));
  assert.notStrictEqual(a(5), c(5));
  for (let i = 0; i < 50; i++) assert.ok(Math.abs(a(i)) <= 0.8);
});
