// blip.js: where Blip peeks over a text box while you dictate (peekSpot), and
// the small things the peek asks of the figure (a nod, the voice on its
// antenna, holding still). The drawing itself is checked on the page
// (guide.html?demo=peek and peekdoc); this is the geometry, which decides
// whether it covers the words being written.
const test = require("node:test");
const assert = require("node:assert");
const { peekSpot, createBlip, POSES } = require("./blip.js");

const view = { w: 1440, h: 900, top: 0 };
const o = { height: 54, tall: 120 };

test("a short field: on its top edge, at the caret's x plus 10", () => {
  const s = peekSpot([600, 500, 2, 20], [500, 490, 400, 40], view, o);
  assert.deepStrictEqual({ x: s.x, y: s.y, side: s.side, tall: s.tall }, { x: 610, y: 490, side: "top", tall: false });
  // Its eye on the caret, below it.
  assert.deepStrictEqual(s.look, [601, 510]);
});

test("kept 24 px in from the field's ends, and the middle of a field too narrow for that", () => {
  assert.strictEqual(peekSpot([502, 500, 2, 20], [500, 490, 400, 40], view, o).x, 524);
  assert.strictEqual(peekSpot([898, 500, 2, 20], [500, 490, 400, 40], view, o).x, 876);
  assert.strictEqual(peekSpot([505, 500, 2, 20], [500, 490, 40, 40], view, o).x, 520);
});

test("a tall field (a document): the caret's own line top, a little to its right", () => {
  const s = peekSpot([700, 400, 2, 22], [400, 100, 700, 600], view, o);
  assert.deepStrictEqual({ x: s.x, y: s.y, side: s.side, tall: s.tall }, { x: 718, y: 398, side: "top", tall: true });
  // At 120 it is still a short one: the knob is "taller than".
  assert.strictEqual(peekSpot([700, 400, 2, 22], [400, 380, 700, 120], view, o).y, 380);
  assert.strictEqual(peekSpot([700, 400, 2, 22], [400, 380, 700, 120], view, { height: 54, tall: 100 }).y, 398);
});

test("no caret, only a field: its top-right corner", () => {
  const s = peekSpot(null, [600, 500, 300, 40], view, o);
  assert.deepStrictEqual({ x: s.x, y: s.y, side: s.side }, { x: 870, y: 500, side: "top" });
});

test("only a caret: just over its line", () => {
  const s = peekSpot([600, 500, 2, 20], null, view, o);
  assert.deepStrictEqual({ x: s.x, y: s.y, side: s.side }, { x: 610, y: 496, side: "top" });
});

test("nothing known, or nonsense: no peek", () => {
  assert.strictEqual(peekSpot(null, null, view, o), null);
  assert.strictEqual(peekSpot([NaN, 1, 2, 3], ["a", 1, 2, 3], view, o), null);
  assert.strictEqual(peekSpot([1, 2, 3], [1, 2, 3, 4, 5], view, o), null);
  // Number(null) is 0: a frame with a hole in it is not one at the top of the screen.
  assert.strictEqual(peekSpot([600, null, 2, 20], null, view, o), null);
  assert.strictEqual(peekSpot([600, 500, 2, Infinity], [500, -Infinity, 400, 40], view, o), null);
  assert.strictEqual(peekSpot([600, 500, -2, 20], [500, 490, -400, 40], view, o), null);
  assert.strictEqual(peekSpot("caret", { x: 1 }, view, o), null);
  assert.strictEqual(peekSpot([600, 500, 2, 20], [500, 490, 400, 40], null, o), null);
});

test("an empty caret rect, or one a paragraph high, is no caret", () => {
  // The field's corner instead.
  assert.strictEqual(peekSpot([600, 500, 0, 0], [500, 490, 400, 40], view, o).x, 870);
  assert.strictEqual(peekSpot([600, 300, 2, 400], [500, 290, 400, 600], view, o).x, 870);
});

test("a field larger than the window is cut to it; huge numbers are clamped, not drawn off screen", () => {
  const s = peekSpot([700, 400, 2, 22], [-1e9, -1e9, 2e9, 2e9], view, o);
  assert.deepStrictEqual({ x: s.x, y: s.y, side: s.side, tall: s.tall }, { x: 718, y: 398, side: "top", tall: true });
  // A field off the window altogether: nothing of it to stand on.
  assert.strictEqual(peekSpot(null, [2000, 100, 300, 40], view, o), null);
  assert.strictEqual(peekSpot(null, [100, 1e12, 300, 40], view, o), null);
  // A caret off the window is not believed; its field still is.
  assert.strictEqual(peekSpot([5000, 500, 2, 20], [500, 490, 400, 40], view, o).x, 870);
});

test("a caret a little outside its field is brought in; one far outside is not believed", () => {
  assert.strictEqual(peekSpot([920, 500, 2, 20], [500, 490, 400, 40], view, o).x, 876);
  const far = peekSpot([100, 800, 2, 20], [600, 500, 300, 40], view, o);
  assert.deepStrictEqual([far.x, far.y], [870, 500]);
  assert.deepStrictEqual(far.look, [750, 520]);
});

test("no room above: out from beside the field's right edge at the caret's height, else its left", () => {
  const r = peekSpot([400, 10, 2, 20], [300, 4, 500, 36], view, o);
  assert.deepStrictEqual({ x: r.x, y: r.y, side: r.side }, { x: 800, y: 20, side: "right" });
  const l = peekSpot([1300, 10, 2, 20], [1140, 4, 300, 36], view, o);
  assert.deepStrictEqual({ x: l.x, y: l.y, side: l.side }, { x: 1140, y: 20, side: "left" });
  // The whole top of the screen: nowhere it would not be off screen.
  assert.strictEqual(peekSpot([700, 10, 2, 20], [0, 0, 1440, 40], view, o), null);
});

test("the room above starts below the menu bar", () => {
  // 40 px under the window's top is room for its head; under a 25 px menu
  // bar it is not.
  assert.strictEqual(peekSpot([400, 50, 2, 20], [300, 40, 500, 36], view, o).side, "top");
  assert.strictEqual(peekSpot([400, 50, 2, 20], [300, 40, 500, 36], { w: 1440, h: 900, top: 25 }, o).side, "right");
});

test("a document's first line at the top of the screen: beside the field, at the caret's line", () => {
  const s = peekSpot([700, 6, 2, 22], [400, 0, 700, 900], view, o);
  // At the caret's height (17), held down far enough for its head and hands
  // to be on screen (.3 of its height, and 2).
  assert.deepStrictEqual({ x: s.x, y: s.y, side: s.side }, { x: 1100, y: 18.2, side: "right" });
});

test("never off screen along the edge", () => {
  // A field running off the window's right: its visible part, and Blip's
  // head and hands kept on the window.
  const s = peekSpot([1436, 500, 2, 20], [1000, 490, 1000, 40], view, o);
  assert.ok(s.x <= 1440 - 18 && s.x >= 1000 + 24, String(s.x));
  const t = peekSpot(null, [-500, 490, 520, 40], view, o);
  assert.ok(t === null || t.x >= 18, JSON.stringify(t));
});

test("it scales with its height: a bigger Blip needs more room above", () => {
  assert.strictEqual(peekSpot([400, 50, 2, 20], [300, 40, 500, 36], view, { height: 54, tall: 120 }).side, "top");
  assert.strictEqual(peekSpot([400, 50, 2, 20], [300, 40, 500, 36], view, { height: 112, tall: 120 }).side, "right");
});

test("the peek's face: snap jumps to the pose, a nod and the voice never throw, holding still is held", () => {
  const b = createBlip({ height: 54 });
  b.pose("listening");
  b.snap();
  assert.strictEqual(b.state().rise, POSES.listening.rise);
  assert.strictEqual(b.shown(), true);
  b.pose("hidden");
  b.step(0); b.step(.05);
  assert.ok(b.state().rise > 0 && b.state().rise < POSES.listening.rise, "eased, not jumped, without snap");
  b.snap();
  assert.strictEqual(b.shown(), false);
  b.level(.7); b.level(NaN); b.level("loud"); b.level(5);
  b.nod();
  b.still(true); b.nod(); b.still(false);
  b.size(60);
});

// What the figure draws, in Node: a 2D context that writes down every call
// (and, for each fill, the colour and opacity it was made with), and an
// OffscreenCanvas of the same, so draw() runs as it does on the page. Its
// buffer reads back empty, so this is the solid face (eye, lid, antennae,
// the lit ball and its glow) without the dots, which is what the peek's own
// methods change.
function recorder() {
  const log = [];
  const st = { fillStyle: "#000", strokeStyle: "#000", globalAlpha: 1 };
  const r = (v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v);
  return new Proxy({ log }, {
    get(target, k) {
      if (k === "log") return log;
      if (k in st) return st[k];
      if (k === "getImageData") return (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(0, w * h * 4)) });
      if (k === "createRadialGradient") return () => ({ addColorStop() {} });
      return (...a) => { log.push(k + "(" + a.map(r).join(",") + ")" + (k === "fill" ? ` ${st.fillStyle} ${r(st.globalAlpha)}` : "")); };
    },
    set(target, k, v) { st[k] = v; return true; },
  });
}
global.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return recorder(); } };
/** One frame of a peeking Blip at `t` seconds, as the calls it made. */
function frameAt(b, t) { const c = recorder(); b.draw(c, 100, 100, t, 2); return c.log; }
function peeking(setup) {
  const b = createBlip({ height: 54 });
  b.pose("listening"); b.snap(); b.live(true); b.lookAt([100, 140]);
  if (setup) setup(b);
  b.step(0);
  return b;
}

test("held still (reduced motion): the same frame whenever it is drawn, through a blink", () => {
  const b = peeking((x) => x.still(true));
  const a = frameAt(b, 1.0);
  // 3.4 s is a blink's moment ((3400 + 300) % 3700 < 120); 2.27 s is mid-sway.
  assert.deepStrictEqual(frameAt(b, 2.27), a);
  assert.deepStrictEqual(frameAt(b, 3.4), a);
  // Not held, the same moments differ: it bobs and sways, and blinks.
  const m = peeking();
  const m1 = frameAt(m, 1.0);
  assert.notDeepStrictEqual(frameAt(m, 2.27), m1);
});

test("the voice swells the lit antenna's glow, and only while it is lit", () => {
  const glow = (log) => log.filter((l) => l.startsWith("fill()") && l.includes("#E8A23C") && !l.endsWith(" 1"));
  const quiet = peeking((x) => { x.still(true); x.level(0); });
  const loud = peeking((x) => { x.still(true); x.level(1); });
  const q = glow(frameAt(quiet, 1)), l = glow(frameAt(loud, 1));
  assert.strictEqual(q.length, 1); assert.strictEqual(l.length, 1);
  assert.match(q[0], / 0\.25$/);
  assert.match(l[0], / 0\.7$/);
  // Nonsense is no voice, and past 1 is 1.
  loud.level(NaN); assert.deepStrictEqual(glow(frameAt(loud, 1)), q);
  loud.level(7); assert.deepStrictEqual(glow(frameAt(loud, 1)), l);
  // Not lit (the microphone closed): no glow, however loud.
  loud.live(false); assert.strictEqual(glow(frameAt(loud, 1)).length, 0);
});

test("a nod dips the head and is over in 340 ms; held still, there is none", () => {
  const plain = peeking();
  const nodded = peeking((x) => x.nod());   // from its next frame, here t = 0
  for (const t of [.05, .17, .3]) assert.notDeepStrictEqual(frameAt(nodded, t), frameAt(plain, t), String(t));
  assert.deepStrictEqual(frameAt(nodded, .4), frameAt(plain, .4));
  const still = peeking((x) => { x.still(true); x.nod(); });
  const ref = peeking((x) => x.still(true));
  assert.deepStrictEqual(frameAt(still, .17), frameAt(ref, .17));
});
