// node --test
//
// Blip's catalog: the copy this build carries plays every move he had, the server's catalog replaces it live (a new move,
// a changed one, one taken back), a catalog that does not compile changes nothing, and an expression can only do arithmetic.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

/** A fresh blip.js (its tables are module state). */
function freshBlip() {
  for (const f of ["./blip.js", "./blipCatalog.js", "./blipStarter.js"]) delete require.cache[require.resolve(f)];
  return require("./blip.js");
}
const starter = () => JSON.parse(JSON.stringify(require("./blipStarter.js")));

test("the copy this build carries compiles whole: every move, the card's poses, the ground's", () => {
  const c = require("./blipCatalog.js").compile(starter());
  assert.deepStrictEqual(c.errors, []);
  const b = freshBlip();
  assert.ok(Object.keys(b.BLIP_GESTURES).length >= 39);
  for (const name of ["rest", "sleep", "wake", "listen", "think", "write", "send", "done", "celebrate", "oops", "talk", "stroll"]) assert.ok(b.BLIP_GESTURES[name], name);
  assert.deepStrictEqual(Object.keys(b.POSES).sort(), ["confirm", "crane", "done", "hidden", "listening", "oops", "peek", "point", "thinking"]);
  assert.strictEqual(b.WALKER_POSES.key, b.WALKER_POSES.carry, "a name in the table is the same pose");
  assert.strictEqual(b.QUIRKS.length, 12);
  assert.ok(b.HOVER.includes("jelly"));
  assert.strictEqual(b.GESTURE_LENGTH.wake, 2.1);
});

test("the moves are the same numbers they always were", () => {
  const b = freshBlip();
  // jelly at 0.3 s: w = sin(6.6) · e^-0.45
  const w = Math.sin(0.3 * 22) * Math.exp(-0.3 * 1.5);
  const p = b.gesturePose("jelly", 0.3, 0);
  assert.ok(Math.abs(p.sqx - (1 + 0.14 * w)) < 1e-12);
  assert.deepStrictEqual(p.mouth, "grin");
  // wake, in its first step, is sleep; listen follows the voice.
  assert.strictEqual(b.gesturePose("wake", 0.2, 0).lid, 1);
  assert.ok(Math.abs(b.gesturePose("listen", 0, 1).glow - 1) < 1e-12);
  // melt's eye opens past half way, and is unset before.
  assert.strictEqual(b.gesturePose("melt", 0.65, 0).eye, "wide");
  assert.strictEqual(b.gesturePose("melt", 0.05, 0).eye, undefined);
});

test("the server's catalog replaces it live: a new move plays, a changed one changes, and back down works too", () => {
  const b = freshBlip();
  const perf = b.createPerformer({ reduced: true });
  const next = starter();
  next.v = 2;
  next.gestures.wiggle = { length: 1, hover: true, quirk: true, let: [["w", "sin(t*20)"]], pose: { spin: "0.1*w", mouth: "grin", ra: [2.5, "0.2*w"] } };
  next.gestures.jelly.pose.mouth = "o";
  const r = b.useCatalog(next);
  assert.ok(r.ok, r.errors.join("; "));
  assert.strictEqual(b.catalogVersion(), 2);
  assert.ok(b.BLIP_GESTURES.wiggle && b.HOVER.includes("wiggle") && b.QUIRKS.includes("wiggle"));
  assert.strictEqual(b.gesturePose("jelly", 0.3, 0).mouth, "o");
  // A performer made before the catalog changed plays the new move.
  perf.play("wiggle", { now: 0 });
  assert.strictEqual(perf.name, "wiggle");
  // The same version again is nothing new; a lower one (taken back on the server) is used.
  assert.strictEqual(b.useCatalog(next).v, 2);
  const back = starter();
  assert.ok(b.useCatalog(back).ok);
  assert.strictEqual(b.catalogVersion(), back.v);
  assert.ok(!b.BLIP_GESTURES.wiggle);
});

test("a move that does not compile is left out; a catalog with no rest changes nothing", () => {
  const b = freshBlip();
  const half = starter();
  half.v = 5;
  half.gestures.broken = { pose: { tilt: "sin(" } };
  half.gestures.unknown = { pose: { tail: 1 } };
  const r = b.useCatalog(half);
  assert.ok(r.ok);
  assert.strictEqual(r.errors.length, 2);
  assert.ok(!b.BLIP_GESTURES.broken && !b.BLIP_GESTURES.unknown && b.BLIP_GESTURES.jelly);
  const none = { v: 6, gestures: { jelly: { pose: { tilt: 1 } } } };
  const r2 = b.useCatalog(none);
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(b.catalogVersion(), 5, "the one before stays");
  assert.ok(b.BLIP_GESTURES.rest);
  assert.strictEqual(b.useCatalog({ v: 7, format: 2, gestures: { rest: { pose: {} } } }).ok, false, "another format");
});

test("an expression can only do arithmetic: no names it was not given, no code", () => {
  const { compile } = require("./blipCatalog.js");
  for (const src of ["process.exit(1)", "constructor", "this", "globalThis", "require(1)", "t; 1", "`x`", "x => 1"]) {
    const r = compile({ v: 1, gestures: { rest: { pose: {} }, bad: { pose: { tilt: src } } } });
    assert.ok(!r.gestures.bad, src);
    assert.strictEqual(r.errors.length, 1, src);
  }
});

test("macros are spelled out where they are used, nested and with commas inside", () => {
  const { expand } = require("./blipCatalog.js");
  const m = { io: [["k"], "k*k"], two: [["a", "b"], "a+b"] };
  assert.strictEqual(expand("io(two(t, max(1, 2)))", m), "((((t)+(max(1, 2))))*(((t)+(max(1, 2)))))");
  assert.throws(() => expand("io(", m));
});

test("this copy is the server's catalog (when the server repo sits beside this one)", (t) => {
  const server = path.resolve(__dirname, "../../../TAILZU-BACKEND/shared/bots/blip.json");
  if (!fs.existsSync(server)) { t.skip("no TAILZU-BACKEND checkout beside this one"); return; }
  assert.deepStrictEqual(starter(), JSON.parse(fs.readFileSync(server, "utf8")), "run tulmi/scripts/gen-blip-starter.mjs in TAILZU-BACKEND");
});
