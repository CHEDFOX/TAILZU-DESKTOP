// node --test
//
// The one key (oneKey.js): which keys a system offers, the hold-or-tap
// gesture as timed sequences of events, and its binding to the key hook or
// the Fn helper, all with fakes. Nothing here touches Electron.

const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const k = require("./oneKey.js");

test("the keys: Right ⌘ on a Mac and Right Ctrl on Windows and Linux by default, the person's pick when the system has it", () => {
  assert.deepStrictEqual(k.choices("darwin").map((c) => c.id), ["rightCommand", "fn", "rightOption"]);
  assert.deepStrictEqual(k.choices("win32").map((c) => c.id), ["rightCtrl", "rightAlt"]);
  assert.deepStrictEqual(k.choices("linux").map((c) => c.id), ["rightCtrl", "rightAlt", "rightSuper"]);
  assert.deepStrictEqual(k.choices("freebsd"), []);
  assert.strictEqual(k.defaultKey("darwin"), "rightCommand");
  assert.strictEqual(k.defaultKey("win32"), "rightCtrl");
  assert.strictEqual(k.defaultKey("linux"), "rightCtrl");
  assert.strictEqual(k.defaultKey("freebsd"), null);
  assert.strictEqual(k.pickKey("darwin", "fn"), "fn", "Fn is still a Mac's choice");
  assert.strictEqual(k.pickKey("darwin", "rightCommand"), "rightCommand");
  assert.strictEqual(k.pickKey("darwin", "rightCtrl"), "rightCommand", "a PC's key on a Mac is the Mac's default");
  assert.strictEqual(k.pickKey("win32", "fn"), "rightCtrl");
  assert.strictEqual(k.pickKey("win32", undefined), "rightCtrl");
  assert.strictEqual(k.pickKey("win32", "rightSuper"), "rightCtrl", "Right Super is Linux's");
  assert.strictEqual(k.pickKey("darwin", "off"), null, "config.json can turn it off");
  assert.strictEqual(k.pickKey("linux", "rightSuper"), "rightSuper");
  assert.strictEqual(k.pickKey("linux", "fn"), "rightCtrl", "a Mac's key on Linux is Linux's default");
  assert.strictEqual(k.pickKey("linux", "off"), null);
  assert.strictEqual(k.keyLabel("rightOption", "darwin"), "Right ⌥");
  assert.strictEqual(k.keyLabel("rightAlt", "win32"), "Right Alt");
  assert.strictEqual(k.keyLabel("rightSuper", "linux"), "Right Super");
  assert.strictEqual(k.keyLabel("fn", "win32"), "");
  // A copy each time: nobody can change the list from outside.
  k.choices("darwin")[0].id = "x";
  assert.strictEqual(k.choices("darwin")[0].id, "rightCommand");
});

test("the first default is kept: a Mac that had launched before keeps Fn, a new Mac gets Right ⌘", () => {
  assert.strictEqual(k.firstDefault("darwin", 0), "rightCommand");
  assert.strictEqual(k.firstDefault("darwin", 12), "fn");
  assert.strictEqual(k.firstDefault("win32", 12), "rightCtrl", "Windows' key did not change");
  assert.strictEqual(k.firstDefault("linux", 3), "rightCtrl");
  assert.strictEqual(k.firstDefault("freebsd", 0), null);
});

test("a Linux session: Wayland or X11 from its environment; nothing elsewhere", () => {
  assert.strictEqual(k.linuxSession("linux", { XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" }), "wayland");
  assert.strictEqual(k.linuxSession("linux", { XDG_SESSION_TYPE: "x11" }), "x11");
  assert.strictEqual(k.linuxSession("linux", { WAYLAND_DISPLAY: "wayland-0" }), "wayland");
  assert.strictEqual(k.linuxSession("linux", { DISPLAY: ":1" }), "x11");
  assert.strictEqual(k.linuxSession("linux", {}), "");
  assert.strictEqual(k.linuxSession("darwin", { XDG_SESSION_TYPE: "wayland" }), "");
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
  let inTalk = false;
  const g = k.createHoldTap({
    now: () => clock,
    setTimeout: (f, ms) => { const t = { f, at: clock + ms }; timers.push(t); return t; },
    clearTimeout: (t) => { timers = timers.filter((x) => x !== t); },
    press: (how) => {
      did.push("press");
      if (o.hows) o.hows.push(how);
      if (o.press) return o.press();
      recording = true;
      return "talk";
    },
    finish: () => { did.push("finish"); recording = false; },
    cancel: () => { did.push("cancel"); recording = false; },
    talking: () => recording,
    tapOn: () => o.tapOn !== false,
    ...(o.freed ? { freed: () => did.push("freed") } : {}),
    armMs: 200, tapMs: 300,
    // Two taps and talk mode (talk.js), only when the test asks for them.
    ...(o.talk ? {
      double: () => { did.push("double"); inTalk = true; },
      doubleMs: () => o.doubleMs ?? 400,
      inTalk: () => inTalk,
      talkHold: () => did.push("talkHold"),
      talkRelease: () => did.push("talkRelease"),
      talkTap: () => { did.push("talkTap"); inTalk = false; },
    } : {}),
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

test("two taps: the first one's hands-free is thrown away and talk mode starts", () => {
  const r = rig({ talk: true });
  r.g.down(); r.wait(80); r.g.up();
  assert.deepStrictEqual(r.did, ["press"], "the first tap starts hands-free, as it always has");
  r.wait(150);
  r.g.down();
  assert.deepStrictEqual(r.did, ["press"], "not stopped on the press: it may be the second tap");
  r.wait(80); r.g.up();
  assert.deepStrictEqual(r.did, ["press", "cancel", "double"]);
  assert.strictEqual(r.rec(), false);
  assert.strictEqual(r.g.state(), "idle");
});

test("two taps: a second press held long stops the hands-free as before; one too late is a press of its own", () => {
  const r = rig({ talk: true });
  r.g.down(); r.wait(80); r.g.up();
  r.wait(100); r.g.down(); r.wait(300);
  assert.deepStrictEqual(r.did, ["press", "finish"]);
  r.wait(200); r.g.up();
  assert.deepStrictEqual(r.did, ["press", "finish"]);
  const late = rig({ talk: true });
  late.g.down(); late.wait(80); late.g.up();
  late.wait(600); late.g.down();
  assert.deepStrictEqual(late.did, ["press", "finish"], "past doubleMs: the press stops the hands-free at once");
  late.wait(80); late.g.up();
  assert.deepStrictEqual(late.did, ["press", "finish"]);
});

test("two taps with taps off, and with two taps off (doubleMs 0)", () => {
  const r = rig({ talk: true, tapOn: false });
  r.g.down(); r.wait(80); r.g.up();
  r.wait(150); r.g.down(); r.wait(80); r.g.up();
  assert.deepStrictEqual(r.did, ["double"], "nothing had started: no cancel");
  const off = rig({ talk: true, doubleMs: 0 });
  off.g.down(); off.wait(80); off.g.up();
  off.wait(150); off.g.down(); off.wait(80); off.g.up();
  assert.deepStrictEqual(off.did, ["press", "finish"]);
});

test("in talk mode the key is talk's: held is their turn until it comes up, a tap ends it, a chord is a release", () => {
  const r = rig({ talk: true });
  r.g.down(); r.wait(80); r.g.up(); r.wait(100); r.g.down(); r.wait(80); r.g.up();
  r.did.length = 0;
  r.wait(2000);
  r.g.down(); r.wait(150);
  assert.deepStrictEqual(r.did, []);
  r.wait(100);
  assert.deepStrictEqual(r.did, ["talkHold"]);
  r.g.down();
  r.wait(3000); r.g.up();
  assert.deepStrictEqual(r.did, ["talkHold", "talkRelease"]);
  r.g.down(); r.wait(400); r.g.other(); r.g.up();
  assert.deepStrictEqual(r.did, ["talkHold", "talkRelease", "talkHold", "talkRelease"]);
  r.g.down(); r.wait(50); r.g.other(); r.g.up();
  assert.deepStrictEqual(r.did.length, 4, "a chord before it is held: nothing");
  r.g.down(); r.wait(80); r.g.up();
  assert.deepStrictEqual(r.did.slice(-1), ["talkTap"]);
  // Talk mode over: the key dictates again.
  r.wait(1000);
  r.g.down(); r.wait(250);
  assert.deepStrictEqual(r.did.slice(-1), ["press"]);
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

test("Linux: Right Ctrl and Right Super through the hook; Right Alt's left Ctrl is a real chord there; Wayland refuses", () => {
  const U = { AltRight: 3640, MetaRight: 3676, CtrlRight: 3613, Ctrl: 29 };
  assert.strictEqual(k.hookCode("rightSuper", U), 3676);
  const run = (key, platform, session) => {
    const uIOhook = new EventEmitter();
    const seen = [];
    const said = [];
    const watch = k.bindOneKey({
      key, platform, session, hook: { uIOhook, UiohookKey: U },
      gesture: { down: () => seen.push("down"), up: () => seen.push("up"), other: () => seen.push("other") },
      bound: () => said.push("bound"), failed: (why) => said.push(why),
    });
    return { uIOhook, seen, said, watch };
  };
  const x = run("rightCtrl", "linux", "x11");
  assert.deepStrictEqual(x.said, ["bound"]);
  x.uIOhook.emit("keydown", { keycode: 3613 }); x.uIOhook.emit("keydown", { keycode: 46 }); x.uIOhook.emit("keyup", { keycode: 3613 });
  assert.deepStrictEqual(x.seen, ["down", "other", "up"]);
  const alt = run("rightAlt", "linux", "x11");
  alt.uIOhook.emit("keydown", { keycode: 3640 }); alt.uIOhook.emit("keydown", { keycode: 29 });
  assert.deepStrictEqual(alt.seen, ["down", "other"], "no Windows AltGr Ctrl on Linux: a left Ctrl is a chord");
  const win = run("rightAlt", "win32", "");
  win.uIOhook.emit("keydown", { keycode: 3640 }); win.uIOhook.emit("keydown", { keycode: 29 });
  assert.deepStrictEqual(win.seen, ["down"], "Windows keeps AltGr's own Ctrl quiet, as before");
  const way = run("rightCtrl", "linux", "wayland");
  assert.deepStrictEqual(way.said, ["wayland"]);
  way.uIOhook.emit("keydown", { keycode: 3613 });
  assert.deepStrictEqual(way.seen, [], "nothing is listened to under Wayland");
  const mac = run("rightCommand", "darwin", "");
  assert.deepStrictEqual(mac.said, ["bound"], "the Mac's new default needs no helper");
});

test("the press says how it came (a hold or a tap), and a held press that was short says it is hands-free now", () => {
  // The bot on X0's screen hears a hold while it is down, and a tap until the first pause (main.js oneKeyPress, windowVoice.js).
  const hows = [];
  const r = rig({ hows, freed: true });
  r.g.down(); r.wait(250); r.g.up();
  assert.deepStrictEqual(hows, ["hold"]);
  assert.ok(r.did.includes("freed"), "down 250 ms: past the arm, short of a hold: hands-free");
  r.g.down(); r.g.up();
  r.wait(500);
  r.g.down(); r.wait(100); r.g.up();
  assert.deepStrictEqual(hows, ["hold", "tap"], "a tap, before it armed");
  const long = rig({ freed: true });
  long.g.down(); long.wait(600); long.g.up();
  assert.ok(!long.did.includes("freed"), "a real hold is not freed");
  assert.deepStrictEqual(long.did, ["press", "finish"]);
});
