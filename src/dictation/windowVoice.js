// THE WINDOW'S OWN VOICE: the bot on X0's screen listens (main.js wires it; the app window draws it, app/sdui/listen.js).
//
// A screen of the app window can hold a bot who listens (the server's voiceLive action, and the screen's talkTo for the one
// key). His words are recorded here, in the main process, the way a talk turn is: the hidden recorder's "ask" mode, live
// partials, the voice's level, a turn ended by the first real pause (pauseEndMs, the screen's silenceMs: about 0.9 s). The
// window is told everything on one channel (app:voice) and draws it: his listen pose, the live words, the bubbles pulsing.
// Nothing is pasted, nothing goes to the pill, and nothing goes to /v1/talk: the window runs the server's own action with the
// words (a question on Home, a message in a space).
//
// Its modes:
//   hold   the one key held: listening while it is down, pauses and all; the words go at the release. One turn.
//   free   the one key tapped: one turn, until the first pause or the next tap.
//   once   a double-click asked for one turn (or a screen's own voiceLive "once"): until the first pause.
//   chat   two taps, or a double-click: turn after turn. After each turn the window runs its action, then says `again`.
// It ends on Esc, a tap on him (the window's stop), the key tapped in a chat, X0 leaving the front (main.js: "blur"),
// another use of the microphone (a dictation, talk mode, a question), nobody speaking (desktop.window.firstQuietMs on the
// first turn, desktop.window.chatQuietMs after), a chord, an error, or desktop.window.maxMs.
//
// THE TURN'S WORDS ARE THE WHOLE TURN. The recorder's partial is already every final its stream sent for the session, then
// the partial after them (recorder/live.js previewText), and a turn is one recording, so the newest preview is the turn.
// A preview that starts over (shorter, and not the start of what was heard: a stream that began again) is put after what
// was heard instead of in its place, so no word of the turn is lost (`extend`). The window never joins anything.
//
// Every effect is a dependency (main.js passes its own), so the flow runs in the tests with fakes:
//   d.nextSession()            a recorder session id
//   d.record(sid, { pauseEndMs })  open the microphone for a turn ("ask" mode, streamed)
//   d.stopRecording(sid), d.cancelRecording(sid)
//   d.send(message)            to the app window, on app:voice
//   d.requireAccount()         signed in, with words left (says so when not)
//   d.blocked()                optional: this computer does not let X0 use the microphone
//   d.changed()                optional: the microphone opened or closed (the tray's dot)
//   d.knobs                    { num, bool, txt }
//   d.now, d.setTimeout, d.clearTimeout, d.log
"use strict";
const { joinStretch } = require("./pasteJoin.js");

const MODES = new Set(["hold", "free", "once", "chat"]);
const squash = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();

/** The turn's words: what was heard, and the recorder's newest preview of them (see above). */
function extend(prev, next) {
  const a = squash(prev), b = squash(next);
  if (!a) return b;
  if (!b) return a;
  const first = (x) => x.slice(0, x.indexOf(" ") === -1 ? x.length : x.indexOf(" ")).toLowerCase();
  // More said, or the last words heard better: the preview is the turn. Only a short preview with another start and
  // several words before it is a stream that began again (a revision can change a word, not drop most of them).
  const restarted = b.length * 2 <= a.length && a.split(" ").length >= 4 && first(a) !== first(b) && a.toLowerCase().indexOf(b.toLowerCase()) === -1;
  return restarted ? a + joinStretch(a, b) : b;
}

function createWindowVoice(d) {
  const { num, bool } = d.knobs;
  const later = d.setTimeout || setTimeout;
  const cancelTimer = d.clearTimeout || clearTimeout;
  const now = d.now || Date.now;
  const log = d.log || (() => {});
  // A time from a knob, never below 0. Each knob is named whole at its call, so tools/knobs/extract.mjs lists it.
  const ms = (v) => Math.max(0, Number(v) || 0);
  const call = (f, fallback) => { try { return f(); } catch { return fallback; } };
  let s = null;        // the session, while it is on
  let count = 0;       // sessions so far: the window knows each one by its number

  const say = (m) => call(() => d.send(m));
  const changed = () => { if (typeof d.changed === "function") call(() => d.changed()); };

  function record(sid, o) {
    const fail = (e) => log("window voice: the microphone did not open: " + ((e && e.message) || e));
    try { Promise.resolve(d.record(sid, o)).catch(fail); } catch (e) { fail(e); }
  }

  // ---- start and end ------------------------------------------------------------------
  /**
   * A session starts: `mode` (above), `by` "key" or "click". o.silenceMs: the screen's pause (0: the knob). False when it
   * cannot (one already on, signed out, out of words, the microphone not allowed), and the window is told why.
   */
  function start(mode, by, o) {
    if (s) return false;
    const m = MODES.has(mode) ? mode : "once";
    const session = ++count;
    // Refused: the window is told at once, so a double-click that asked does not wait on a listen that is not coming.
    if (!bool("desktop.window.voice", true) || !call(() => d.requireAccount(), false)) { say({ kind: "end", session, why: "error" }); return false; }
    if (typeof d.blocked === "function" && call(() => d.blocked(), false)) {
      say({ kind: "error", session, message: "", blocked: true });
      say({ kind: "end", session, why: "error" });
      return false;
    }
    const silence = Number(o && o.silenceMs);
    s = {
      session, mode: m, by: by === "key" ? "key" : "click", turn: 0,
      sid: 0, phase: null, held: false, heard: "", final: null, clipIn: false, spoke: false,
      pauseEndMs: silence > 0 ? Math.min(5000, silence) : ms(num("desktop.window.pauseEndMs", 900)),
      quietAt: now() + ms(num("desktop.window.firstQuietMs", 8000)), timers: {}, levelAt: 0,
    };
    s.maxTimer = later(() => end("max"), ms(num("desktop.window.maxMs", 1200000)));
    log("window voice: on (" + m + ", " + s.by + ")");
    say({ kind: "listen", session, mode: m, by: s.by });
    listen(m === "hold");
    changed();
    return true;
  }

  /** It ends: the microphone closes, what was heard of the turn is dropped, and the window is told. */
  function end(why) {
    const me = s;
    if (!me) return false;
    s = null;
    clearTurn(me);
    cancelTimer(me.maxTimer);
    if (me.sid && (me.phase === "listening" || me.phase === "hearing")) call(() => d.cancelRecording(me.sid));
    say({ kind: "end", session: me.session, why: String(why || "tap") });
    log("window voice: off (" + why + ")");
    changed();
    return true;
  }

  function clearTurn(me) {
    for (const k of Object.keys(me.timers)) cancelTimer(me.timers[k]);
    me.timers = {};
  }

  // ---- a turn ---------------------------------------------------------------------------
  /** The microphone opens for a turn. `held`: the key is down, and only its release ends the turn. */
  function listen(held) {
    const me = s;
    if (!me) return;
    clearTurn(me);
    me.phase = "listening";
    me.held = !!held;
    me.heard = ""; me.final = null; me.clipIn = false; me.spoke = false;
    me.sid = d.nextSession();
    me.turn++;
    const sid = me.sid;
    record(sid, { pauseEndMs: me.pauseEndMs });
    if (!me.held) quietWatch(me);
    me.timers.turn = later(() => { if (s === me && me.sid === sid) stopTurn(); }, ms(num("desktop.window.turnMaxMs", 60000)));
  }

  /** Nobody speaks before the quiet deadline: it ends. */
  function quietWatch(me) {
    cancelTimer(me.timers.quiet);
    me.timers.quiet = later(() => { if (s === me && me.phase === "listening" && !me.spoke && !me.held) end("quiet"); }, Math.max(0, me.quietAt - now()));
  }

  function heardVoice(me) {
    me.spoke = true;
    cancelTimer(me.timers.quiet);
  }

  /** The turn is over (a pause, the key's release, the next tap, the ceiling): the microphone closes, the words come back. */
  function stopTurn() {
    const me = s;
    if (!me || me.phase !== "listening") return;
    clearTurn(me);
    me.phase = "hearing";
    me.held = false;
    call(() => d.stopRecording(me.sid));
    const sid = me.sid;
    // The clip never comes back (the recorder's page crashed, a message lost): what the stream heard is the turn.
    me.timers.clip = later(() => { if (s === me && me.sid === sid && me.phase === "hearing") heardAll(); }, ms(num("desktop.window.clipWaitMs", 8000)));
  }

  /** Their words, once the stream's final text or the clip is in: to the window, which runs its action with them. */
  function heardAll() {
    const me = s;
    if (!me || me.phase !== "hearing") return;
    clearTurn(me);
    const words = extend(me.heard, me.final || "");
    if (!words) {
      // Held and nothing said: there is nothing to send. Otherwise listening again, to the same quiet deadline.
      if (me.mode === "hold") { end("quiet"); return; }
      listen(false);
      return;
    }
    me.phase = "waiting";
    say({ kind: "heard", session: me.session, text: words });
    // The window answers with `again` (a chat) or `stop`; a window that never does (it was reloaded) is not waited on for good.
    me.timers.wait = later(() => { if (s === me && me.phase === "waiting") end("max"); }, ms(num("desktop.window.waitMaxMs", 180000)));
  }

  // ---- the key and the window -------------------------------------------------------------
  /** The key came up after a hold, or was tapped again in a free turn: the turn is over, and its words go. */
  function finish() {
    if (s && s.phase === "listening") stopTurn();
  }

  /** A held press that was short is a tap (oneKey.js): hands-free now, until the first pause or the next tap. */
  function free() {
    const me = s;
    if (!me || me.mode !== "hold" || me.phase !== "listening") return;
    me.mode = "free";
    me.held = false;
    quietWatch(me);
  }

  /** A chat, the key held: their turn now. Held, only the key's release ends it. */
  function hold() {
    const me = s;
    if (!me || me.mode !== "chat") return false;
    if (me.phase === "listening") { me.held = true; cancelTimer(me.timers.quiet); return true; }
    // Their words are on their way: the turn goes on.
    if (me.phase === "hearing") return false;
    listen(true);
    return true;
  }

  /** A chat, the held key came up: the turn is over. */
  function release() {
    const me = s;
    if (!me || me.mode !== "chat" || me.phase !== "listening" || !me.held) return;
    me.held = false;
    me.quietAt = now() + ms(num("desktop.window.chatQuietMs", 12000));
    stopTurn();
  }

  /** The window has run its action with a chat's turn: the next turn. False for anything else. */
  function again(session) {
    const me = s;
    if (!me || me.mode !== "chat" || me.phase !== "waiting") return false;
    if (session && session !== me.session) return false;
    me.quietAt = now() + ms(num("desktop.window.chatQuietMs", 12000));
    listen(false);
    return true;
  }

  // ---- the recorder's messages (main.js hands them here first) -----------------------------
  const mine = (p) => !!s && !!p && !!p.session && p.session === s.sid;

  /** A partial: the turn's words so far, to the window as they come. True when the session is the window's. */
  function partial(p) {
    if (!mine(p)) return false;
    if (s.phase !== "listening") return true;
    const was = s.heard;
    s.heard = extend(s.heard, p.text);
    if (s.heard) heardVoice(s);
    if (s.heard !== was) say({ kind: "words", session: s.session, text: s.heard });
    return true;
  }

  /** The voice's level, for his bubbles: at most desktop.window.levelHz a second. A voice over voiceLevel counts as speaking. */
  function level(p) {
    if (!mine(p)) return false;
    if (s.phase !== "listening") return true;
    const b = Array.isArray(p.bands) ? p.bands : [];
    const v = Math.max(0, Math.min(1, b.length ? Math.max(...b.map((x) => Number(x) || 0)) : 0));
    if (v >= num("desktop.window.voiceLevel", 0.3)) heardVoice(s);
    const t = now(), every = 1000 / Math.max(1, num("desktop.window.levelHz", 30));
    if (t - s.levelAt >= every) { s.levelAt = t; say({ kind: "level", session: s.session, v: Math.round(v * 1000) / 1000 }); }
    return true;
  }

  /** The recorder's first real pause: the end of the turn, unless the key is held. */
  function paused(p) {
    if (!mine(p)) return false;
    if (s.phase === "listening" && !s.held) stopTurn();
    return true;
  }

  /** The turn's clip, with what the stream heard of it as of the stop. */
  function audioIn(p) {
    if (!mine(p)) return false;
    const me = s;
    // Ended by the recorder itself: the same as a stop.
    if (me.phase === "listening") { clearTurn(me); me.phase = "hearing"; }
    if (me.phase !== "hearing") return true;
    me.clipIn = true;
    if (typeof p.text === "string") me.heard = extend(me.heard, p.text);
    cancelTimer(me.timers.clip);
    if (me.final !== null) { heardAll(); return true; }
    // The stream's final text is usually a moment behind the clip.
    me.timers.final = later(() => { if (s === me && me.phase === "hearing") heardAll(); }, ms(num("desktop.window.finalTextMs", 400)));
    return true;
  }

  /** The stream's final text for the turn. */
  function textIn(p) {
    if (!mine(p)) return false;
    s.final = squash(p.text);
    if (s.phase === "hearing" && (s.final || s.clipIn)) heardAll();
    return true;
  }

  /** A recorder error (the microphone blocked, missing, in use): the window is told, and it ends. */
  function error(p) {
    if (!mine(p)) return false;
    const session = s.session;
    say({ kind: "error", session, message: String((p && p.message) || ""), blocked: typeof d.blocked === "function" && call(() => d.blocked(), false) === true });
    end("error");
    return true;
  }

  /** The recorder's page crashed: a turn it was recording will not come back. */
  function recorderGone() {
    if (s && (s.phase === "listening" || s.phase === "hearing")) end("error");
  }

  return {
    start, end, finish, free, hold, release, again,
    partial, level, paused, audioIn, textIn, error, recorderGone,
    active: () => !!s,
    /** The microphone is open for it, or its words are coming back (a key press then stops it, as for a dictation). */
    listening: () => !!s && (s.phase === "listening" || s.phase === "hearing"),
    mode: () => (s ? s.mode : null),
    phase: () => (s ? s.phase : null),
    session: () => (s ? s.session : 0),
  };
}

module.exports = { createWindowVoice, extend };
