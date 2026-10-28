// node --test
//
// The one key (oneKey.js): which keys a system offers, the hold-or-tap
// gesture as timed sequences of events, and its binding to the key hook or
// the Fn helper, all with fakes. Nothing here touches Electron.

const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const k = require("./oneKey.js");

test("the keys: Fn on a Mac and Right Ctrl on Windows by default, the person's pick when the system has it, none on Linux", () => {
  assert.deepStrictEqual(k.choices("darwin").map((c) => c.id), ["fn", "rightOption", "rightCommand"]);
  assert.deepStrictEqual(k.choices("win32").map((c) => c.id), ["rightCtrl", "rightAlt"]);
  assert.deepStrictEqual(k.choices("linux"), []);
  assert.strictEqual(k.defaultKey("darwin"), "fn");
  assert.strictEqual(k.defaultKey("win32"), "rightCtrl");
  assert.strictEqual(k.defaultKey("linux"), null);
  assert.strictEqual(k.pickKey("darwin", "rightCommand"), "rightCommand");
  assert.strictEqual(k.pickKey("darwin", "rightCtrl"), "fn", "a PC's key on a Mac is the Mac's default");
  assert.strictEqual(k.pickKey("win32", "fn"), "rightCtrl");
  assert.strictEqual(k.pickKey("win32", undefined), "rightCtrl");
  assert.strictEqual(k.pickKey("darwin", "off"), null, "config.json can turn it off");
  assert.strictEqual(k.pickKey("linux", "fn"), null, "Linux keeps its keys");
  assert.strictEqual(k.keyLabel("rightOption", "darwin"), "Right ⌥");
  assert.strictEqual(k.keyLabel("rightAlt", "win32"), "Right Alt");
  assert.strictEqual(k.keyLabel("fn", "win32"), "");
  // A copy each time: nobody can change the list from outside.
  k.choices("darwin")[0].id = "x";
  assert.strictEqual(k.choices("darwin")[0].id, "fn");
});

test("the hook's codes: the right-hand modifiers; Fn has none (the helper watches it)", () => {
  const U = { AltRight: 3640, MetaRight: 3676, CtrlRight: 3613, Ctrl: 29 };
  assert.strictEqual(k.hookCode("rightOption", U), 3640);
  assert.strictEqual(k.hookCode("rightCommand", U), 3676);
  assert.strictEqual(k.hookCode("rightCtrl", U), 3613);
  assert.strictEqual(k.hookCode("rightAlt", U), 3640);
  assert.strictEqual(k.hookCode("fn", U), null);
  assert.strictEqual(k.hookCode("rightCtrl", {}), null);
  assert.ok(k.needsHelper("fn"));
  assert.ok(!k.needsHelper("rightCtrl"));
});

/** The gesture with a clock and timers driven by hand, and a dictation that
 *  records when it is told to. */
function rig(o = {}) {
  let clock = 1_000_000;
  let timers = [];
  const did = [];
  let recording = false;
  const g = k.createHoldTap({
    now: () => clock,
    setTimeout: (f, ms) => { const t = { f, at: clock + ms }; timers.push(t); return t; },
    clearTimeout: (t) => { timers = timers.filter((x) => x !== t); },
    press: () => {
      did.push("press");
      if (o.press) return o.press();
      recording = true;
      return "talk";
    },
    finish: () => { did.push("finish"); recording = false; },
    cancel: () => { did.push("cancel"); recording = false; },
    talking: () => recording,
    tapOn: () => o.tapOn !== false,
    armMs: 200, tapMs: 300,
  });
  const wait = (ms) => {
    const until = clock + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((t) => t !== due);
      clock = due.at;
      due.f();
    }
    clock = until;
  };
  return { g, did, wait, rec: () => recording, setRecording: (v) => { recording = v; } };
}

test("hold: talking starts once the key has been down alone a moment, and stops when it comes up", () => {
  const r = rig();
  r.g.down();
  r.wait(150);
  assert.deepStrictEqual(r.did, [], "not yet: it may still be a chord");
  r.wait(60);
  assert.deepStrictEqual(r.did, ["press"]);
  assert.strictEqual(r.g.state(), "held");
  // The key repeats while it is held: nothing.
  r.g.down(); r.g.down();
  r.wait(2000);
  r.g.up();
  assert.deepStrictEqual(r.did, ["press", "finish"]);
  assert.strictEqual(r.rec(), false);
});

test("a quick tap is hands-free: it keeps listening until the key is tapped again", () => {
  const r = rig();
  r.g.down(); r.wait(80); r.g.up();
  assert.deepStrictEqual(r.did, ["press"]);
  assert.strictEqual(r.g.state(), "free");
  r.wait(5000);
  assert.strictEqual(r.rec(), true);
  // Typing while it listens hands-free is not a chord.
  r.g.other();
  assert.strictEqual(r.rec(), true);
  // Down again: it stops on the press, and the release is the end of it.
  r.g.down();
  assert.deepStrictEqual(r.did, ["press", "finish"]);
  r.wait(500); r.g.up();
  assert.deepStrictEqual(r.did, ["press", "finish"]);
  assert.strictEqual(r.g.state(), "idle");
});

test("a press just past the arm but short of a hold is a tap too", () => {
  const r = rig();
  r.g.down(); r.wait(250); r.g.up();
  assert.deepStrictEqual(r.did, ["press"]);
  assert.strictEqual(r.g.state(), "free");
});

test("with taps off, a quick tap does nothing; a hold still talks", () => {
  const r = rig({ tapOn: false });
  r.g.down(); r.wait(80); r.g.up();
  assert.deepStrictEqual(r.did, []);
  r.g.down(); r.wait(250); r.g.up();
  assert.deepStrictEqual(r.did, ["press", "finish"], "held past the arm, then up: it was a hold");
});

test("a chord is not the key: another key before it talks, nothing; after, the talking is thrown away", () => {
  const r = rig();
  // Right Ctrl+C: C comes while Ctrl is down, before the arm.
  r.g.down(); r.wait(90); r.g.other(); r.wait(500); r.g.up();
  assert.deepStrictEqual(r.did, []);
  assert.strictEqual(r.g.state(), "idle");
  // Fn+Delete late: it had started talking; that is cancelled, not written.
  r.g.down(); r.wait(400); r.g.other(); r.wait(100); r.g.up();
  assert.deepStrictEqual(r.did, ["press", "cancel"]);
  assert.strictEqual(r.rec(), false);
  // A click with the key down is a chord as well (Ctrl+click).
  const c = rig();
  c.g.down(); c.wait(50); c.g.other(); c.g.up();
  assert.deepStrictEqual(c.did, []);
});

test("talking that started elsewhere (the pill, the tray) is stopped by the key", () => {
  const r = rig();
  r.setRecording(true);
  r.g.down();
  assert.deepStrictEqual(r.did, ["finish"]);
  r.wait(400); r.g.up();
  assert.deepStrictEqual(r.did, ["finish"]);
});

test("hands-free that ended elsewhere (the pill's ✓, a long silence): the next press starts again", () => {
  const r = rig();
  r.g.down(); r.wait(50); r.g.up();
  assert.strictEqual(r.g.state(), "free");
  r.setRecording(false);
  r.g.down(); r.wait(250);
  assert.deepStrictEqual(r.did, ["press", "press"]);
  assert.strictEqual(r.g.state(), "held");
});

test("a press that goes to something else (Ask's card) or is refused: nothing more until it comes up", () => {
  for (const answer of ["other", "none"]) {
    const r = rig({ press: () => answer });
    r.g.down(); r.wait(300);
    assert.strictEqual(r.g.state(), "used", answer);
    r.g.down(); r.wait(300); r.g.up();
    assert.deepStrictEqual(r.did, ["press"], answer);
    assert.strictEqual(r.g.state(), "idle");
  }
  // A tap refused (signed out): not hands-free.
  const t = rig({ press: () => "none" });
  t.g.down(); t.wait(50); t.g.up();
  assert.strictEqual(t.g.state(), "idle");
});

test("reset forgets a gesture half made (the key was rebound)", () => {
  const r = rig();
  r.g.down(); r.g.reset(); r.wait(1000);
  assert.deepStrictEqual(r.did, []);
  assert.strictEqual(r.g.state(), "idle");
});

// ---- binding --------------------------------------------------------------------

function gestureLog() {
  const seen = [];
  return { seen, down: () => seen.push("down"), up: () => seen.push("up"), other: () => seen.push("other") };
}
function fakeHook() {
  const u = new EventEmitter();
  return { uIOhook: u, UiohookKey: { AltRight: 3640, MetaRight: 3676, CtrlRight: 3613, Ctrl: 29, Escape: 1 } };
}

test("bound through the key hook: its key down and up, anything else is a chord; stopped, it hears nothing", () => {
  const hook = fakeHook(), g = gestureLog();
  let bound = 0; const failed = [];
  const w = k.bindOneKey({ key: "rightCtrl", platform: "win32", gesture: g, hook, bound: () => bound++, failed: (why) => failed.push(why) });
  assert.strictEqual(bound, 1);
  assert.deepStrictEqual(failed, []);
  hook.uIOhook.emit("keydown", { keycode: 3613 });
  hook.uIOhook.emit("keydown", { keycode: 46 });
  hook.uIOhook.emit("keyup", { keycode: 46 });
  hook.uIOhook.emit("keyup", { keycode: 3613 });
  hook.uIOhook.emit("mousedown", {});
  hook.uIOhook.emit("wheel", {});
  assert.deepStrictEqual(g.seen, ["down", "other", "up", "other", "other"]);
  w.stop();
  hook.uIOhook.emit("keydown", { keycode: 3613 });
  assert.strictEqual(g.seen.length, 5);
  assert.strictEqual(hook.uIOhook.listenerCount("keydown"), 0);
});

test("Right Alt as AltGr: the left Ctrl Windows sends with it is part of the key, not a chord", () => {
  const hook = fakeHook(), g = gestureLog();
  k.bindOneKey({ key: "rightAlt", platform: "win32", gesture: g, hook, bound() {}, failed() {} });
  hook.uIOhook.emit("keydown", { keycode: 29 });
  hook.uIOhook.emit("keydown", { keycode: 3640 });
  hook.uIOhook.emit("keydown", { keycode: 29 });
  hook.uIOhook.emit("keydown", { keycode: 3640 });
  hook.uIOhook.emit("keyup", { keycode: 3640 });
  assert.deepStrictEqual(g.seen, ["down", "down", "up"]);
  // Right Ctrl has no such exception: left Ctrl with it is a chord.
  const h2 = fakeHook(), g2 = gestureLog();
  k.bindOneKey({ key: "rightCtrl", platform: "win32", gesture: g2, hook: h2, bound() {}, failed() {} });
  h2.uIOhook.emit("keydown", { keycode: 3613 });
  h2.uIOhook.emit("keydown", { keycode: 29 });
  assert.deepStrictEqual(g2.seen, ["down", "other"]);
});

test("no hook (it did not load): a hook key cannot be bound, and says so", () => {
  const failed = [];
  k.bindOneKey({ key: "rightOption", platform: "darwin", gesture: gestureLog(), hook: null, bound: () => assert.fail("bound"), failed: (why) => failed.push(why) });
  assert.deepStrictEqual(failed, ["hook"]);
});

function fakeHelper(o = {}) {
  const spawned = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdin = { end: () => spawned.push("stdin closed") };
  child.kill = () => spawned.push("killed");
  return {
    child, spawned,
    helper: {
      path: "/app/tzkey", exists: () => o.exists !== false,
      spawn: (p, args, opts) => { if (o.throws) throw new Error("no"); spawned.push([p, args, opts.stdio]); return child; },
    },
  };
}

test("Fn: the helper's words, a line at a time, however its output is cut", () => {
  const f = fakeHelper(), g = gestureLog();
  let bound = 0; const failed = [];
  const w = k.bindOneKey({ key: "fn", platform: "darwin", gesture: g, hook: null, helper: f.helper, bound: () => bound++, failed: (why) => failed.push(why) });
  assert.deepStrictEqual(f.spawned[0], ["/app/tzkey", [], ["pipe", "pipe", "ignore"]]);
  assert.strictEqual(bound, 0, "not until it says it is ready");
  f.child.stdout.emit("data", Buffer.from("rea"));
  f.child.stdout.emit("data", Buffer.from("dy\ndown\n"));
  assert.strictEqual(bound, 1);
  f.child.stdout.emit("data", Buffer.from("other\nup\nnonsense\n"));
  assert.deepStrictEqual(g.seen, ["down", "other", "up"]);
  w.stop();
  assert.deepStrictEqual(f.spawned.slice(1), ["stdin closed", "killed"]);
  f.child.stdout.emit("data", Buffer.from("down\n"));
  f.child.emit("exit", 0);
  assert.strictEqual(g.seen.length, 3, "stopped: nothing more");
  assert.deepStrictEqual(failed, [], "its own stop is not a failure");
});

test("Fn: no helper, a helper that will not start, macOS saying no, or a helper that stops, each said", () => {
  const why = (o, then) => {
    const f = fakeHelper(o); const failed = [];
    k.bindOneKey({ key: "fn", platform: "darwin", gesture: gestureLog(), hook: null, helper: f.helper, bound() {}, failed: (w) => failed.push(w) });
    if (then) then(f.child);
    return failed;
  };
  assert.deepStrictEqual(why({ exists: false }), ["helper"]);
  assert.deepStrictEqual(why({ throws: true }), ["helper"]);
  assert.deepStrictEqual(why({}, (c) => c.emit("exit", 3)), ["denied"]);
  assert.deepStrictEqual(why({}, (c) => c.emit("exit", 1)), ["helper"]);
  assert.deepStrictEqual(why({}, (c) => { c.stdout.emit("data", "ready\n"); c.emit("exit", 0); }), ["exited"]);
  assert.deepStrictEqual(why({}, (c) => c.emit("error", new Error("ENOENT"))), ["helper"]);
});

test("lines: split across chunks, blank ones skipped, a runaway one dropped", () => {
  const got = [];
  const feed = k.lineReader((l) => got.push(l));
  feed("a\n\nb"); feed("c\r\n"); feed("x".repeat(400)); feed("\nd\n");
  assert.deepStrictEqual(got, ["a", "bc", "d"]);
});
