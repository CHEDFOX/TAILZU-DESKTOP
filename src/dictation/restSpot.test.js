// node --test
// Where Blip rests between dictations (restSpot.js).

const test = require("node:test");
const assert = require("node:assert");
const { restBounds, pointerNear, restsNow, REST_W, REST_H } = require("./restSpot.js");

const MAC = { x: 0, y: 25, width: 1440, height: 875 };

test("he rests against the right edge, a little below the middle, inside the work area", () => {
  const b = restBounds(MAC);
  assert.deepStrictEqual(b, { x: 1440 - REST_W, y: Math.round(25 + 875 * 0.58 - REST_H / 2), width: REST_W, height: REST_H });
  assert.ok(b.y > MAC.y + 875 / 2 - REST_H / 2, "below the middle");
  assert.ok(b.y + b.height < MAC.y + MAC.height, "clear of the Dock and the taskbar");
});

test("on a second display he is on that display's right edge; on a short one he stays inside it", () => {
  const right = { x: 1440, y: 0, width: 1920, height: 1040 };
  assert.strictEqual(restBounds(right).x, 1440 + 1920 - REST_W);
  const short = { x: 0, y: 0, width: 800, height: 100 };
  const b = restBounds(short);
  assert.ok(b.y >= 0 && b.y + b.height <= Math.max(100, REST_H), JSON.stringify(b));
});

test("he ducks when the pointer comes within reach of his window, not before", () => {
  const b = { x: 1344, y: 500, width: 96, height: 120 };
  assert.strictEqual(pointerNear({ x: 1400, y: 560 }, b), true, "over him");
  assert.strictEqual(pointerNear({ x: 1300, y: 560 }, b), true, "44 px to his left");
  assert.strictEqual(pointerNear({ x: 1200, y: 560 }, b), false, "144 px away");
  assert.strictEqual(pointerNear(null, b), false);
});

test("he rests only while the pill is on and at rest", () => {
  assert.strictEqual(restsNow({ on: true, pillOn: true, pillState: "rest" }), true);
  for (const pillState of ["listening", "writing", "routed", "ask", "error"]) assert.strictEqual(restsNow({ on: true, pillOn: true, pillState }), false, pillState);
  assert.strictEqual(restsNow({ on: false, pillOn: true, pillState: "rest" }), false);
  assert.strictEqual(restsNow({ on: true, pillOn: false, pillState: "rest" }), false);
});

test("he goes to the edge only after a while at rest with no command", () => {
  const s = { on: true, pillOn: true, pillState: "rest", afterMs: 45000 };
  assert.strictEqual(restsNow(Object.assign({}, s, { idleMs: 10000 })), false, "ten seconds in: still at the bottom");
  assert.strictEqual(restsNow(Object.assign({}, s, { idleMs: 45000 })), true, "45 s with nothing asked: the edge");
  assert.strictEqual(restsNow(Object.assign({}, s, { idleMs: 90000, pillState: "routed" })), false, "never while something is on the pill");
  assert.strictEqual(restsNow(Object.assign({}, s, { idleMs: 0, afterMs: 0 })), true, "afterMs 0: at once");
});
