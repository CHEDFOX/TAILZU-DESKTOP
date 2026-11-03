// node --test
// Blip strolling along the bottom of the screen (roam.js).

const test = require("node:test");
const assert = require("node:assert");
const { createRoam } = require("./roam.js");

/** A run of steps of dt seconds, from now (ms). */
function walk(r, i, secs, dt = 0.05) {
  const out = [];
  for (let n = Math.round(secs / dt); n > 0; n--) { i.now += dt * 1000; out.push(r.step(i, dt)); }
  return out;
}

test("idle, he waits a pause, then walks somewhere else in the strip, and stops there", () => {
  const r = createRoam({ rnd: () => 0.9 });
  const i = { mode: "wander", now: 0, span: 300, speed: 60, pauseMs: [1000, 1000], free: true };
  r.step(Object.assign({}, i, { mode: "stay" }), 0.05);
  const before = walk(r, i, 0.9);
  assert.ok(before.every((s) => !s.walking && s.x === 0), "not before the pause is over");
  const after = walk(r, i, 6);
  assert.ok(after.some((s) => s.walking), "he walks");
  const end = after.findIndex((s) => s.arrived);
  assert.ok(end > 0, "and arrives");
  assert.ok(Math.abs(after[end].x - 240) < 1e-9, "where it picked (0.9 of the way out)");
  assert.ok(after.every((s) => Math.abs(s.x) <= 300), "never past the strip");
});

test("he walks at his speed, facing the way he goes", () => {
  const r = createRoam({ rnd: () => 0.1 });  // picks -240
  const i = { mode: "wander", now: 10000, span: 300, speed: 60, pauseMs: [0, 0], free: true };
  const s = walk(r, i, 1, 0.1);
  assert.ok(Math.abs(s[s.length - 1].x + 60) < 1e-6, "60 px in a second: " + s[s.length - 1].x);
  assert.strictEqual(s[s.length - 1].dir, -1);
});

test("in the middle of a gesture no new walk starts", () => {
  const r = createRoam({ rnd: () => 0.9 });
  const s = walk(r, { mode: "wander", now: 10000, span: 300, speed: 60, pauseMs: [0, 0], free: false }, 2);
  assert.ok(s.every((x) => !x.walking));
});

test("a command stops him where he stands: no walk back to the middle", () => {
  const r = createRoam({ rnd: () => 0.9 });
  const i = { mode: "wander", now: 10000, span: 300, speed: 60, pauseMs: [0, 0], free: true };
  walk(r, i, 2);
  const at = r.x;
  assert.ok(at > 100, "out in the strip: " + at);
  i.mode = "stay"; i.pauseMs = [2000, 2000];
  const s = walk(r, i, 3);
  assert.ok(s.every((x) => !x.walking && x.x === at), "he stays at " + at);
  // Free again, he waits a full pause before the next walk.
  i.mode = "wander";
  assert.ok(walk(r, i, 1.5).every((x) => !x.walking));
});

test("working, he walks the strip too", () => {
  const r = createRoam({ rnd: () => 0.2 });
  const s = walk(r, { mode: "work", now: 10000, span: 200, speed: 80, pauseMs: [0, 0], free: true }, 1);
  assert.ok(s.some((x) => x.walking));
});

test("leaving for the screen's edge, he gets there in the time given, however far", () => {
  const r = createRoam({ rnd: () => 0.5 });
  r.place(-300);
  const s = walk(r, { mode: "leave", now: 0, span: 300, speed: 60, leaveTo: 760, leaveMs: 2000 }, 2.1);
  assert.ok(s.some((x) => x.arrived), "arrived");
  assert.strictEqual(r.x, 760);
  assert.strictEqual(s[0].dir, 1);
});

test("a strip that shrank takes him in with it", () => {
  const r = createRoam({ rnd: () => 0.5 });
  r.place(500);
  const s = r.step({ mode: "wander", now: 0, span: 200, speed: 60, pauseMs: [9000, 9000], free: false }, 0.05);
  assert.strictEqual(s.x, 200);
});

test("while a task's label is on the pill he keeps to his side of it, never across", () => {
  for (const r0 of [0.05, 0.5, 0.95]) {
    const r = createRoam({ rnd: () => r0 });
    r.place(-60);
    const s = walk(r, { mode: "work", now: 0, span: 400, speed: 80, pauseMs: [0, 0], free: true, avoid: [-40, 120] }, 12);
    assert.ok(s.some((x) => x.walking), "he walks");
    assert.ok(s.every((x) => x.x <= -40 || x.x === -60), "left of the label: " + Math.max(...s.map((x) => x.x)));
  }
});
