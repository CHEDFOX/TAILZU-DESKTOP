// blip.js: where Blip peeks over a text box while you dictate (peekSpot), and
// the small things the peek asks of the figure (a nod, the voice on its
// antenna, holding still). The drawing itself is checked on the page
// (guide.html?demo=peek and peekdoc); this is the geometry, which decides
// whether it covers the words being written. At the foot: the walker who
// goes with you through the onboarding, whose journeys are timed here.
const test = require("node:test");
const assert = require("node:assert");
const { peekSpot, createBlip, POSES, createWalker, burst, WALKER_POSES } = require("./blip.js");

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

// ---- the walker: Blip on the onboarding's stage ------------------------------------------

/** A walker on a recording canvas, with a clock held in the test's hand. */
function stage(extra) {
  let now = 1000, ctx = null;
  const canvas = { width: 0, height: 0, getContext: () => (ctx = recorder()) };
  const w = createWalker(canvas, Object.assign({ now: () => now, dpr: 1 }, extra));
  w.size(800, 600, 1);
  return { w, canvas, log: () => ctx.log, at: (t) => { now = t; }, tick: (t) => { now = t; w.tick(t); } };
}
const where = (s) => { const t = s.w.state(); return [t.x, t.y, t.H, t.pose]; };

test("the first spot is an arrival, and one that is as good as where he stands is only a new pose", () => {
  const s = stage();
  const lands = [];
  assert.strictEqual(s.w.go(200, 300, 100, "wave", (k) => lands.push(k)), "snap");
  assert.deepStrictEqual(where(s), [200, 300, 100, "wave"]);
  assert.deepStrictEqual([s.w.state().placed, s.w.state().traveling], [true, false]);
  // Within 8 px, the same height: no journey, his pose springs to the new one.
  assert.strictEqual(s.w.go(206, 292, 100, "tap", (k) => lands.push(k)), "pose");
  assert.deepStrictEqual(where(s), [206, 292, 100, "tap"]);
  assert.deepStrictEqual(lands, ["snap", "pose"]);
  // Nine away is a journey; so is the same place at another size.
  assert.strictEqual(s.w.go(215, 292, 100, "tap"), "travel");
  s.tick(5000);
  assert.strictEqual(s.w.go(215, 292, 120, "tap"), "travel");
});

test("a short move is a hop: a 90 ms crouch, 460 ms, his pose changing at 45%, a squash on landing", () => {
  const s = stage();
  s.w.go(200, 300, 100, "present");
  const lands = [];
  s.at(1000);
  assert.strictEqual(s.w.go(230, 300, 100, "tap", (k) => lands.push(k)), "travel");
  const j = s.w.state().journey;
  assert.deepStrictEqual([j.hop, j.T, j.t0, j.swapAt, j.dist], [true, 460, 1090, .45, 30]);
  assert.strictEqual(s.w.state().pose, "walk", "he goes in his walking pose");
  s.tick(1000); s.tick(1060);
  assert.strictEqual(s.w.state().x, 200, "crouching: he has not moved yet");
  s.tick(1090 + 460 * .44);
  assert.strictEqual(s.w.state().pose, "walk");
  s.tick(1090 + 460 * .46);
  assert.strictEqual(s.w.state().pose, "tap", "the new pose from the swap on");
  assert.ok(s.w.state().lift > 0, "he is in the air");
  assert.deepStrictEqual(lands, []);
  s.tick(1090 + 460);
  const t = s.w.state();
  assert.deepStrictEqual([t.x, t.y, t.pose, t.traveling, t.lift], [230, 300, "tap", false, 0]);
  assert.deepStrictEqual(lands, ["travel"]);
  assert.ok(t.sq > .01, "squashed as he lands (a spring, so it is already on its way back)");
  // Landing is once.
  s.tick(3000);
  assert.deepStrictEqual(lands, ["travel"]);
});

test("a long move is a walk of clamp(430 + 2.3 d, 520, 960) ms, his pose changing at 60%", () => {
  const timing = (dx, dH = 0) => {
    const s = stage();
    s.w.go(100, 300, 100, "present");
    s.w.go(100 + dx, 300, 100 + dH, "tap");
    const j = s.w.state().journey;
    return [j.hop, Math.round(j.T * 10) / 10, j.swapAt];
  };
  assert.deepStrictEqual(timing(100), [false, 660, .6]);
  assert.deepStrictEqual(timing(300), [false, 960, .6], "never longer than 960");
  assert.deepStrictEqual(timing(50), [false, 545, .6]);
  assert.deepStrictEqual(timing(46), [false, 535.8, .6], "46 is a walk, not a hop");
  assert.deepStrictEqual(timing(45.9), [true, 460, .45]);
  // A change of size counts half toward the distance.
  assert.deepStrictEqual(timing(0, 90), [true, 460, .45]);
  assert.deepStrictEqual(timing(0, 100), [false, 545, .6]);
  const s = stage();
  s.w.go(100, 300, 100, "present");
  const lands = [];
  s.at(1000);
  s.w.go(500, 300, 100, "listen", (k) => lands.push(k));
  s.tick(1090 + 960 * .59);
  assert.strictEqual(s.w.state().pose, "walk");
  assert.ok(s.w.state().x > 100 && s.w.state().x < 500, "on his way");
  s.tick(1090 + 960 * .61);
  assert.strictEqual(s.w.state().pose, "listen");
  s.tick(1090 + 960 + 5);
  assert.deepStrictEqual([s.w.state().x, lands], [500, ["travel"]]);
});

test("with his hands full he keeps what he holds while he walks, and otherwise walks", () => {
  for (const held of ["wave", "key", "carry"]) {
    const s = stage();
    s.w.go(100, 300, 100, held);
    s.w.go(500, 300, 100, "tap");
    assert.strictEqual(s.w.state().pose, held, held);
  }
  for (const free of ["present", "listen", "tada", "think", "nod"]) {
    const s = stage();
    s.w.go(100, 300, 100, free);
    s.w.go(500, 300, 100, "tap");
    assert.strictEqual(s.w.state().pose, "walk", free);
  }
});

test("a new spot while he is on his way starts from where he is", () => {
  const s = stage();
  s.w.go(100, 300, 100, "present");
  s.at(1000);
  s.w.go(500, 300, 100, "tap");
  s.tick(1500);
  const mid = s.w.state().x;
  assert.ok(mid > 100 && mid < 500);
  s.w.go(100, 300, 100, "wave");
  assert.strictEqual(s.w.state().journey.dist, Math.hypot(mid - 100, 0));
});

test("the place he is going to can move (a scroll, a resize) and he follows, with no walk", () => {
  const s = stage();
  s.w.go(100, 300, 100, "present");
  // At rest: he is moved.
  s.w.retarget(100, 250, 100);
  assert.deepStrictEqual(where(s), [100, 250, 100, "present"]);
  // On a journey: its end moves, and he lands there.
  s.at(1000);
  s.w.go(500, 250, 100, "tap");
  s.w.retarget(500, 200, 100);
  s.tick(1000 + 90 + 960 + 10);
  assert.deepStrictEqual(where(s), [500, 200, 100, "tap"]);
});

test("held still (reduced motion) there is no journey: a beat of 160 ms and he is there", () => {
  const s = stage({ reduced: true });
  s.w.go(100, 300, 100, "wave");
  const lands = [];
  s.at(1000);
  assert.strictEqual(s.w.go(500, 100, 150, "tada", (k) => lands.push(k)), "travel");
  assert.strictEqual(s.w.state().journey, null, "no walk is timed");
  assert.strictEqual(s.w.state().pose, "wave", "he does not even change to a walking pose");
  s.tick(1100); s.tick(1159);
  assert.deepStrictEqual([where(s), lands], [[100, 300, 100, "wave"], []]);
  s.tick(1160);
  assert.deepStrictEqual([where(s), lands, s.w.state().traveling], [[500, 100, 150, "tada"], ["travel"], false]);
  // The frame loop asks for nothing more once he is still.
  assert.strictEqual(s.w.frame(1200), false);
  // …and for frames while he is on his way, and always when he is not held still.
  s.w.go(300, 100, 150, "wave");
  assert.strictEqual(s.w.frame(1300), true);
  assert.strictEqual(stage().w.frame(1000), false, "nobody shown: nothing to draw");
  const live = stage(); live.w.snap(100, 100, 100, "present");
  assert.strictEqual(live.w.frame(1000), true);
});

test("sent away, the next spot is a first one again", () => {
  const s = stage();
  s.w.go(100, 300, 100, "present");
  s.w.hide();
  assert.deepStrictEqual([s.w.state().placed, s.w.state().shown], [false, false]);
  assert.strictEqual(s.w.go(400, 200, 100, "wave"), "snap");
  assert.deepStrictEqual(where(s), [400, 200, 100, "wave"]);
  assert.strictEqual(s.w.state().shown, true);
});

test("every pose draws only finite numbers, at rest and mid-stride, and a missing pose is a plain one", () => {
  for (const reduced of [true, false]) for (const pose of Object.keys(WALKER_POSES)) {
    const s = stage({ reduced });
    s.w.snap(300, 400, 110, pose);
    s.w.draw(.016); s.w.draw(.016);
    const log = s.log().join("\n");
    assert.ok(log.length > 200, pose + " drew nothing");
    assert.doesNotMatch(log, /NaN|Infinity/, `${pose} reduced=${reduced}`);
  }
  const s = stage();
  s.w.snap(300, 400, 110, "no-such-pose");
  s.w.draw(.016);
  assert.doesNotMatch(s.log().join("\n"), /NaN|Infinity/);
  // Mid-journey, facing away, squashed.
  const w = stage();
  w.w.go(100, 400, 150, "present");
  w.at(2000); w.w.go(700, 380, 110, "tap");
  for (let t = 2000; t < 3300; t += 40) { w.tick(t); w.w.draw(.04); }
  assert.doesNotMatch(w.log().join("\n"), /NaN|Infinity/);
});

test("he is drawn where his feet are, and a frame clears only the box he was in", () => {
  const s = stage();
  s.w.snap(300, 400, 100, "present");
  s.w.draw(.016);
  const first = s.log().filter((l) => l.startsWith("clearRect"));
  assert.strictEqual(first.length, 0, "nothing to clear the first time");
  s.w.snap(500, 300, 100, "present");
  s.w.draw(.016);
  const cleared = s.log().filter((l) => l.startsWith("clearRect"));
  assert.deepStrictEqual(cleared, ["clearRect(205,222,190,190)"], "the box around the old place: 95 either side, 150 + 28 above, 40 below");
});

test("the confetti is 22 pieces thrown from where he lands, gone in 1.4 s, and none when held still", async () => {
  const made = [];
  const host = {
    ownerDocument: {
      createElement: () => {
        const e = { className: "", style: { props: {}, setProperty(k, v) { this.props[k] = v; } }, removed: false, remove() { this.removed = true; } };
        made.push(e);
        return e;
      },
    },
    kids: [],
    appendChild(e) { this.kids.push(e); },
  };
  const out = burst(host, 120, 80, { rand: () => .5, ttl: 5 });
  assert.strictEqual(out.length, 22);
  assert.strictEqual(host.kids.length, 22);
  assert.ok(out.every((e) => e.className === "cf" && e.style.left === "120px" && e.style.top === "80px"));
  assert.deepStrictEqual(out.slice(0, 5).map((e) => e.style.background), ["#1C1A17", "#39FF14", "#F3E2C6", "#8D8983", "#1C1A17"]);
  assert.deepStrictEqual([out[0].style.props["--dx"], out[0].style.props["--dy"], out[0].style.props["--r"]], ["0px", "-30px", "0deg"], "rand .5 is the middle of every range");
  // Each takes itself away once its time is up.
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(out.every((e) => e.removed));
  // Held still: nothing is thrown. No page to throw it on: nothing either.
  assert.deepStrictEqual(burst(host, 1, 1, { reduced: true }), []);
  assert.deepStrictEqual(burst(null, 1, 1), []);
  assert.strictEqual(host.kids.length, 22);
  // The stage's own colours, when it names them.
  assert.strictEqual(burst(host, 1, 1, { colors: ["#123456"], ttl: 5 })[3].style.background, "#123456");
});
