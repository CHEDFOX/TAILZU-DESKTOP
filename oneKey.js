// THE ONE KEY: everything Tailzu does on this computer starts from one key.
//
// Hold it: talk while it is down, and what was said goes where it is meant
// when it comes up (routing.js). Tap it: hands-free, until it is tapped
// again. That is the whole gesture. It replaces the three there were (a talk
// chord with a hold key and double-taps beside it, Ask's Alt twice, and the
// meeting notes chord): Ask and notes are reached by saying so.
//
// Which key: Fn on a Mac, Right Ctrl on Windows, by default; the person can
// pick another single key in Settings (choices below). Linux keeps the keys
// it had: there is no text box to read there, so nothing to route by.
//
// Right ⌥, Right ⌘, Right Ctrl and Right Alt come through the key hook
// (uiohook-napi). Fn does not: the hook cannot see it on a Mac, and neither
// can Electron's shortcuts, so a small helper watches it (native/tzkey.swift,
// built into build/tzkey). Either one failing (no hook, no helper, macOS
// saying no) and main.js falls back to the talk chord, and says so once.
//
// A modifier is a modifier first: Right Ctrl+C is a copy, Fn+← is Home. A
// press only becomes talking once it has been down a moment alone (armMs);
// another key or a click while it is down makes it a chord, and a chord that
// had already started talking throws that away.
"use strict";

const knobs = require("./knobs.js");

const CHOICES = {
  darwin: [{ id: "fn", label: "Fn" }, { id: "rightOption", label: "Right ⌥" }, { id: "rightCommand", label: "Right ⌘" }],
  win32: [{ id: "rightCtrl", label: "Right Ctrl" }, { id: "rightAlt", label: "Right Alt" }],
};
// The key hook's names for each (UiohookKey). Fn has none: the helper watches it.
const HOOK = { rightOption: "AltRight", rightCommand: "MetaRight", rightCtrl: "CtrlRight", rightAlt: "AltRight" };

/** A key's name as the person reads it: the server's label (desktop.oneKey.label.*), the one above as the fallback. */
function named(c) {
  const said = {
    fn: knobs.txt("desktop.oneKey.label.fn", "Fn"),
    rightOption: knobs.txt("desktop.oneKey.label.rightOption", "Right ⌥"),
    rightCommand: knobs.txt("desktop.oneKey.label.rightCommand", "Right ⌘"),
    rightCtrl: knobs.txt("desktop.oneKey.label.rightCtrl", "Right Ctrl"),
    rightAlt: knobs.txt("desktop.oneKey.label.rightAlt", "Right Alt"),
  }[c.id];
  return typeof said === "string" && said.trim() ? said : c.label;
}
/** The keys this system can use as the one key: [{ id, label }]. None on Linux. */
function choices(platform) { return (CHOICES[platform] || []).map((c) => Object.assign({}, c, { label: named(c) })); }
/** Whether this system has the one key at all. */
function supported(platform) { return Object.hasOwn(CHOICES, platform); }
/** Fn on a Mac, Right Ctrl on Windows; null elsewhere. */
function defaultKey(platform) { return supported(platform) ? CHOICES[platform][0].id : null; }
/** The key to use: the one asked for when this system has it, else the default.
 *  "off" (config.json) is no one key at all: the old keys, as on Linux. */
function pickKey(platform, wanted) {
  if (!supported(platform) || wanted === "off") return null;
  return CHOICES[platform].some((c) => c.id === wanted) ? wanted : defaultKey(platform);
}
/** "Fn", "Right ⌥", "Right Ctrl" … as the person reads it. */
function keyLabel(id, platform) {
  const hit = (CHOICES[platform] || []).find((c) => c.id === id);
  return hit ? named(hit) : "";
}
/** The hook's key code, or null (Fn, or a hook without the key). */
function hookCode(id, UiohookKey) {
  const name = HOOK[id];
  const code = name && UiohookKey ? UiohookKey[name] : undefined;
  return typeof code === "number" ? code : null;
}
/** Fn needs the helper; the others the hook. */
function needsHelper(id) { return id === "fn"; }

/** An option given as a number, or a function read when it is needed (knobs). */
function option(v, fallback) {
  const n = typeof v === "function" ? v() : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Hold, or tap: the gesture on one key, as events. Pure: the clock and the
 * timers are given, so the tests drive it.
 *
 *   down()   the key went down (a held key's repeats come here too: ignored)
 *   up()     it came up
 *   other()  any other key, or a click or the wheel
 *   reset()  forget the gesture (the key was rebound)
 *
 * o.press()       start talking: "talk" when a dictation started, "other" when
 *                 the press went to something else (Ask's card), "none" when
 *                 nothing happened (signed out, out of words)
 * o.finish()      stop talking and write it
 * o.cancel()      throw the talking away (a chord)
 * o.talking()     a dictation is recording now (started from anywhere)
 * o.tapOn()       a quick tap keeps it listening (the "tap" setting)
 * o.armMs         how long the key is down alone before it talks (200)
 * o.tapMs         a press shorter than this is a tap (300)
 */
function createHoldTap(o) {
  const now = o.now || Date.now;
  const later = o.setTimeout || setTimeout;
  const cancelTimer = o.clearTimeout || clearTimeout;
  const armMs = () => option(o.armMs, 200);
  const tapMs = () => option(o.tapMs, 300);
  const call = (f, fallback) => { try { return f(); } catch { return fallback; } };
  // idle      nothing
  // armed     down, alone, not talking yet
  // held      down, talking
  // free      up, talking hands-free (a tap started it)
  // closing   down again, to stop hands-free: waiting for it to come up
  // chord     down with another key: nothing until it comes up
  // used      down, the press went to something else: nothing until it comes up
  let state = "idle";
  let downAt = 0;
  let timer = null;

  function arm() {
    timer = null;
    if (state !== "armed") return;
    const r = call(() => o.press(), "none");
    state = r === "talk" ? "held" : "used";
  }

  function down() {
    // Hands-free that ended elsewhere (the pill's ✓, a long silence, an
    // error): this press starts again.
    if (state === "free" && !call(() => o.talking(), false)) state = "idle";
    if (state === "free") { state = "closing"; call(() => o.finish()); return; }
    if (state !== "idle") return;                     // a repeat, or a press not yet released
    // Talking that something else started (the tray, the pill): this press stops it.
    if (call(() => o.talking(), false)) { state = "closing"; call(() => o.finish()); return; }
    state = "armed";
    downAt = now();
    cancelTimer(timer);
    timer = later(arm, armMs());
  }

  function up() {
    const was = state;
    state = "idle";
    if (was === "armed") {
      // Down and up before it armed: a tap. Hands-free, when taps are on.
      cancelTimer(timer); timer = null;
      if (call(() => o.tapOn(), true) !== false && call(() => o.press(), "none") === "talk") state = "free";
      return;
    }
    if (was === "held") {
      // A short press is a tap: it keeps listening. Held, it was talk-while-held.
      if (now() - downAt < tapMs() && call(() => o.tapOn(), true) !== false && call(() => o.talking(), false)) { state = "free"; return; }
      call(() => o.finish());
    }
    // closing, chord, used, idle: the gesture is over.
  }

  function other() {
    if (state === "armed") { cancelTimer(timer); timer = null; state = "chord"; return; }
    if (state === "held") { state = "chord"; call(() => o.cancel()); }
    // Hands-free, the hands are free: typing while it listens is not a chord.
  }

  function reset() { cancelTimer(timer); timer = null; state = "idle"; }

  return { down, up, other, reset, state: () => state };
}

/**
 * Split a stream of bytes into lines, a chunk at a time.
 */
function lineReader(onLine) {
  let rest = "";
  return (chunk) => {
    rest += String(chunk);
    let i;
    while ((i = rest.indexOf("\n")) !== -1) {
      const line = rest.slice(0, i).trim();
      rest = rest.slice(i + 1);
      if (line) onLine(line);
    }
    if (rest.length > 256) rest = "";   // never a line of this protocol
  };
}

/**
 * Bind the one key to a gesture (createHoldTap). Answers through o.bound()
 * once the key is live, or o.failed(reason) when it cannot be: "hook" (the
 * key hook did not load), "helper" (the Fn helper is not there or would not
 * start), "denied" (macOS would not let it listen), "exited" (it stopped).
 *
 *   o.key, o.platform
 *   o.gesture            createHoldTap's { down, up, other }
 *   o.hook               { uIOhook, UiohookKey } or null
 *   o.helper             { path, exists(path), spawn(path, args, opts) } (Fn)
 *   o.bound(), o.failed(reason)
 *
 * Returns { stop() }: the hook's listeners off, the helper ended.
 */
function bindOneKey(o) {
  const g = o.gesture;
  let stopped = false;
  const offs = [];
  let settled = false;
  const ok = () => { if (!settled && !stopped) { settled = true; try { o.bound(); } catch { /* said nothing */ } } };
  const fail = (why) => { if (!stopped) { const first = !settled; settled = true; try { o.failed(why, first); } catch { /* said nothing */ } } };
  const stop = () => {
    stopped = true;
    for (const f of offs.splice(0)) { try { f(); } catch { /* already off */ } }
  };

  if (needsHelper(o.key)) {
    // Fn: the helper. One word a line on its stdout (tzkey.swift).
    const h = o.helper;
    if (!h || !h.path || !h.exists(h.path)) { fail("helper"); return { stop }; }
    let child;
    try { child = h.spawn(h.path, [], { stdio: ["pipe", "pipe", "ignore"] }); } catch { fail("helper"); return { stop }; }
    let ready = false;
    child.stdout.on("data", lineReader((line) => {
      if (stopped) return;
      if (line === "ready") { ready = true; ok(); }
      else if (line === "down") g.down();
      else if (line === "up") g.up();
      else if (line === "other") g.other();
    }));
    child.on("error", () => fail("helper"));
    child.on("exit", (code) => fail(code === 3 ? "denied" : ready ? "exited" : "helper"));
    offs.push(() => { try { child.stdin.end(); } catch { /* closed */ } try { child.kill(); } catch { /* gone */ } });
    return { stop };
  }

  // Right ⌥ / Right ⌘ / Right Ctrl / Right Alt: the key hook.
  const hook = o.hook;
  const code = hook ? hookCode(o.key, hook.UiohookKey) : null;
  if (!hook || code == null) { fail("hook"); return { stop }; }
  // Right Alt is AltGr on many Windows layouts, which Windows sends with a
  // left Ctrl of its own, again with every repeat while it is held: that
  // Ctrl is part of the key, not a chord.
  const quiet = o.key === "rightAlt" ? [hook.UiohookKey.Ctrl].filter((c) => typeof c === "number") : [];
  const onDown = (e) => { if (e.keycode === code) g.down(); else if (!quiet.includes(e.keycode)) g.other(); };
  const onUp = (e) => { if (e.keycode === code) g.up(); };
  const onMouse = () => g.other();
  hook.uIOhook.on("keydown", onDown);
  hook.uIOhook.on("keyup", onUp);
  hook.uIOhook.on("mousedown", onMouse);
  hook.uIOhook.on("wheel", onMouse);
  offs.push(() => {
    const u = hook.uIOhook, off = (ev, f) => (typeof u.off === "function" ? u.off(ev, f) : u.removeListener(ev, f));
    off("keydown", onDown); off("keyup", onUp); off("mousedown", onMouse); off("wheel", onMouse);
  });
  ok();
  return { stop };
}

module.exports = { choices, supported, defaultKey, pickKey, keyLabel, hookCode, needsHelper, createHoldTap, bindOneKey, lineReader };
