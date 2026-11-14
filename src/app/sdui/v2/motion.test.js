// node --test
//
// Motion: a keyframe track sampled into what the browser plays, a spring that settles, and what Reduce Motion and
// the kill switch do to all of it.
const test = require("node:test");
const assert = require("node:assert");
const { fakePage } = require("../../testkit.js");

test("a keyframe track eases between its keys and holds at both ends", () => {
  const page = fakePage();
  page.run('var t = v2Track({ k: [[0, 0], [0.5, 10, "lin"]] });');
  assert.strictEqual(page.run("t.at(0)"), 0);
  assert.strictEqual(page.run("t.at(0.25)"), 5);
  assert.strictEqual(page.run("t.at(0.5)"), 10);
  assert.strictEqual(page.run("t.at(9)"), 10, "past the end it rests on the last key");
  assert.strictEqual(page.run("t.end"), 0.5);
  page.run('var loop = v2Track({ k: [[0, 0], [2, 100, "lin"]], loop: true });');
  assert.strictEqual(page.run("loop.at(3)"), 50, "a loop starts again");
});

test("a spring settles where it was sent", () => {
  const page = fakePage();
  page.run("var s = v2Track({ spring: 1, from: 0, k: 160, damp: 0.8 });");
  assert.strictEqual(page.run("s.at(0)"), 0);
  assert.ok(page.run("Math.abs(s.at(s.end) - 1) < 0.01"), "it ends on its target");
  assert.ok(page.run("s.end < 3"), "and does not run for ever");
});

test("nine style keys become one transform, sampled", () => {
  const page = fakePage();
  const made = JSON.parse(page.run('JSON.stringify(v2Keyframes(v2Tracks({ opacity: { k: [[0, 0], [0.2, 1]] }, translateY: { k: [[0, 10], [0.2, 0]] } })))'));
  assert.strictEqual(made.ms, 200);
  assert.strictEqual(made.frames[0].opacity, "0");
  assert.match(made.frames[0].transform, /translateY\(10px\)/);
  assert.strictEqual(made.frames[made.frames.length - 1].opacity, "1");
  assert.match(made.frames[made.frames.length - 1].transform, /translateY\(0px\)/);
  // A key the model does not know is ignored, never guessed at.
  assert.deepStrictEqual(JSON.parse(page.run('JSON.stringify(v2Tracks({ blur: 4 }).length)')), 0);
});

test("Reduce Motion makes an entrance a cross-fade, and the kill switch stops everything", () => {
  const page = fakePage({ reduced: true });
  assert.strictEqual(page.run("v2MotionMode()"), "reduced");
  const el = { played: [], animate(frames, opts) { this.played.push({ frames, opts }); return { finished: null }; } };
  page.g.__el = el;
  page.run('v2Play(__el, { translateY: { k: [[0, 10], [0.3, 0]] } }, {})');
  assert.strictEqual(el.played.length, 1);
  assert.strictEqual(JSON.stringify(el.played[0].frames), JSON.stringify([{ opacity: "0" }, { opacity: "1" }]));
  assert.strictEqual(el.played[0].opts.duration, 180);
  page.run('K.setKnobs({ labels: {}, flags: { "sdui.motion": "off" } })');
  page.run('v2Play(__el, { translateY: { k: [[0, 10], [0.3, 0]] } }, {})');
  assert.strictEqual(el.played.length, 1, "nothing moves at all");
});

test("drive follows one input and never runs a clock", () => {
  const page = fakePage();
  const el = { style: {} };
  page.g.__el = el;
  page.run('V2.ui.scrollY = 0; var apply = v2Drive(__el, { translateY: { by: "ui.scrollY", k: [[0, 0], [120, -40]] } }, function (by) { return v2UiRead(by); });');
  assert.strictEqual(el.style.transform, "translateY(0px)");
  page.run("V2.ui.scrollY = 60; apply();");
  assert.strictEqual(el.style.transform, "translateY(-20px)");
  page.run("V2.ui.scrollY = 600; apply();");
  assert.strictEqual(el.style.transform, "translateY(-40px)", "past its last key it rests there");
});
