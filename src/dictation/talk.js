// TALK MODE: a conversation with Blip on the one key, turn after turn
// (main.js wires it; oneKey.js createHoldTap's double tap starts it).
//
// Two quick taps of the one key, and the microphone opens. The person
// speaks; their turn ends at the recorder's first real pause (the "ask" mode,
// recorder/pauseFlush.js), or when the key they held comes up. Their words go
// to POST /v1/talk, the answer streams back as NDJSON and is shown in the
// pill and said, sentence by sentence, as it comes; then the microphone opens
// again for the next turn. The server keeps the thread: this keeps only the
// talk's id and the turn's number.
//
// It ends after desktop.talk.quietMs of silence after an answer, on a tap of
// the key, on Esc, on a click on the pill, after desktop.talk.maxMs, or after
// desktop.talk.maxErrors failed turns in a row.
//
// Holding the key takes the turn at once: what Blip is saying stops, the turn
// in flight is stopped (POST /v1/talk/stop), and the microphone is theirs
// until the key comes up. With desktop.talk.bargeVoice the microphone also
// listens while he speaks, and a voice over desktop.talk.bargeLevel does the
// same (off by default: the speakers can be heard by the microphone).
//
// An answer can hand off: "agent" to Ask (as routing.js does: askHeard with
// { trusted }), "write" pasted into the box in front, "routine" saved,
// "notes" started or stopped, "bot" sent to that bot. Talk listens again once
// the handoff is over.
//
// A private window or a money or health app (frontApp.js): nothing of the
// screen goes with the words, not its title, its field or its page.
//
// Every effect is a dependency (main.js passes its own), so the flow runs in
// the tests with fakes:
//   d.id()                     a new talk's id
//   d.nextSession()            a recorder session id
//   d.record(sid, { watch })   open the microphone for a turn ("ask" mode, streamed); `watch`: only its level
//                              (bargeVoice), nothing sent
//   d.stopRecording(sid), d.cancelRecording(sid)
//   d.front()                  the window in front: { label, title, private, sensitive } or null
//   d.field()                  optional: the focused field, { selection } or null
//   d.ours()                   our own window is in front
//   d.pageFor(info)            the page in front for `page`, or null (main.js; never asked for a private window)
//   d.grants()                 optional: the setup card's state
//   d.post(path, body, { signal })  the account's authorised fetch → Response
//   d.voice(text, { lang })    the sentence's audio, fetched as soon as it is written → a message for d.play
//   d.play(message)            say it → resolves once it has been said, or stopped
//   d.hush()                   stop saying anything now
//   d.pill(state, data)        "talk" with { phase, heard, said, gesture }; d.pillRest() gives it back
//   d.ask(goal, { trusted })   hand to Ask → true when it took it; d.askBusy() while its run or card is up
//   d.type(text)               paste into the box in front → Promise
//   d.routine(goal)            save a routine → { text } or null
//   d.notes(start)             start (true) or stop (false) meeting notes
//   d.bot(goal, bot)           send to a bot ({ slug, name } or none) → { name, text } or null
//   d.told(reply)              say a bot's or routine's reply (a notification)
//   d.requireAccount()         signed in (says so when not)
//   d.failed(p)                the microphone failed: the recorder's error
//   d.knobs                    { num, bool, txt }
//   d.now, d.setTimeout, d.clearTimeout, d.log
"use strict";
const { readEvents } = require("../agent/run/stream.js");
const { joinStretch } = require("./pasteJoin.js");

// What Blip does for each of the server's moods (shared/blip.js BLIP_GESTURES).
const MOOD_GESTURE = { talk: "talk", laugh: "laugh", ponder: "ponder", done: "done", sorry: "facepalm", surprised: "sneeze", shy: "shy", nope: "nope" };
// And while a handoff is being done.
const HANDOFF_GESTURE = { agent: "work", write: "write", routine: "routine", notes: "listen", bot: "send" };
const HANDOFFS = new Set(Object.keys(HANDOFF_GESTURE));

/** The gesture for a mood; "talk" for one this build does not know. */
function gestureFor(mood) { return Object.hasOwn(MOOD_GESTURE, mood) ? MOOD_GESTURE[mood] : "talk"; }

// The end of a sentence: . ! ? … with any closing quote or bracket, then a
// space; the CJK marks with or without one; a line break.
const SENTENCE_END = /[.!?…]["'”’)\]]*\s+|[。！？]["'”’)\]]*\s*|\n+/u;

/**
 * Whole sentences off the front of `buf`: { said: [...], rest }. A run longer
 * than `longChars` with no end of sentence in it is cut at its last comma or
 * space, so the voice is not held up by a long one.
 */
function sentences(buf, longChars) {
  const said = [];
  let rest = String(buf || "");
  let m;
  while ((m = SENTENCE_END.exec(rest))) {
    const piece = rest.slice(0, m.index + m[0].length).trim();
    rest = rest.slice(m.index + m[0].length);
    if (piece) said.push(piece);
  }
  const long = Math.max(40, Number(longChars) || 240);
  while (rest.length > long) {
    const head = rest.slice(0, long);
    const cut = Math.max(head.lastIndexOf(", "), head.lastIndexOf(" "));
    if (cut < 1) break;
    const piece = rest.slice(0, cut + 1).trim();
    rest = rest.slice(cut + 1);
    if (piece) said.push(piece);
  }
  return { said, rest };
}

const squash = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();

function createTalk(d) {
  const { num, bool, txt } = d.knobs;
  const later = d.setTimeout || setTimeout;
  const cancelTimer = d.clearTimeout || clearTimeout;
  const now = d.now || Date.now;
  const log = d.log || (() => {});
  const ms = (k, f) => Math.max(0, Number(num(k, f)) || 0);
  const call = (f, fallback) => { try { return f(); } catch { return fallback; } };
  let s = null;   // the talk, while it is on

  // ---- the pill ---------------------------------------------------------------------
  function show(o) {
    if (!s) return;
    Object.assign(s.view, o || {});
    call(() => d.pill("talk", Object.assign({}, s.view)));
  }

  /** The microphone opened for a session (main.js may renew the token first). */
  function record(sid, o) {
    const fail = (e) => log("talk: the microphone did not open: " + ((e && e.message) || e));
    try { Promise.resolve(d.record(sid, o)).catch(fail); } catch (e) { fail(e); }
  }

  // ---- start and end ----------------------------------------------------------------
  /** Two taps of the one key: talk mode starts. False when it cannot (off, signed out, already on). */
  function start() {
    if (s) return false;
    if (!call(() => d.requireAccount(), false)) return false;
    s = {
      id: String(call(() => d.id(), "") || "talk-" + now()),
      turn: 0, errors: 0, phase: null, sid: 0, watchSid: 0, held: false,
      heard: "", final: null, clipIn: false, said: "", pending: "", lang: "", handoff: null,
      quietAt: now() + ms("desktop.talk.quietMs", 8000), timers: {}, ctrl: null,
      gen: 0, speech: Promise.resolve(), infoP: null, fieldP: null,
      view: { phase: "listen", heard: "", said: "", gesture: "listen" },
    };
    s.maxTimer = later(() => end("max"), ms("desktop.talk.maxMs", 20 * 60 * 1000));
    log("talk: on");
    listen(false);
    return true;
  }

  /** Talk mode ends: the microphone closes, nothing more is said, a turn in flight is stopped. */
  function end(why) {
    const me = s;
    if (!me) return false;
    s = null;
    clearTurn(me);
    cancelTimer(me.maxTimer);
    me.gen++;
    call(() => d.hush());
    if (me.ctrl) { try { me.ctrl.abort(); } catch { /* done */ } me.ctrl = null; stopServer(me); }
    if (me.sid && (me.phase === "listening" || me.phase === "hearing")) call(() => d.cancelRecording(me.sid));
    unwatch(me);
    call(() => d.pillRest());
    log("talk: off (" + why + ")");
    return true;
  }

  function stopServer(me) {
    try { Promise.resolve(d.post("/v1/talk/stop", { talkId: me.id })).catch(() => {}); } catch { /* the turn ends on the server by itself */ }
  }

  function clearTurn(me) {
    for (const k of Object.keys(me.timers)) cancelTimer(me.timers[k]);
    me.timers = {};
  }

  // ---- their turn ---------------------------------------------------------------------
  /** The microphone opens for their turn. `held`: the key is down, and only its release ends the turn. */
  function listen(held) {
    const me = s;
    if (!me) return;
    clearTurn(me);
    unwatch(me);
    me.phase = "listening";
    me.held = !!held;
    me.heard = ""; me.final = null; me.clipIn = false; me.spoke = false;
    me.sid = d.nextSession();
    // The window in front, and its field, asked while they speak.
    me.infoP = Promise.resolve().then(() => d.front()).catch(() => null);
    me.fieldP = me.infoP.then((info) => (screenOk(info) && typeof d.field === "function" ? d.field() : null)).catch(() => null);
    const sid = me.sid;
    record(sid, {});
    show({ phase: "listen", heard: "", said: "", gesture: "listen" });
    if (!me.held) quietWatch(me);
    me.timers.turn = later(() => { if (s === me && me.sid === sid) stopTurn(); }, ms("desktop.talk.turnMaxMs", 60000));
  }

  /** Nobody speaks before the quiet deadline: talk mode ends. */
  function quietWatch(me) {
    cancelTimer(me.timers.quiet);
    me.timers.quiet = later(() => { if (s === me && me.phase === "listening" && !me.spoke && !me.held) end("quiet"); }, Math.max(0, me.quietAt - now()));
  }

  function heardVoice(me) {
    me.spoke = true;
    cancelTimer(me.timers.quiet);
  }

  /** The turn is over (their pause, the key's release, the ceiling): the microphone closes, the words come back. */
  function stopTurn() {
    const me = s;
    if (!me || me.phase !== "listening") return;
    clearTurn(me);
    me.phase = "hearing";
    me.held = false;
    call(() => d.stopRecording(me.sid));
    show({ phase: "think", gesture: "think" });
    const sid = me.sid;
    // The clip never comes back (the recorder's page crashed, a message lost): what the stream heard is the turn.
    me.timers.clip = later(() => { if (s === me && me.sid === sid && me.phase === "hearing") heardAll(); }, ms("desktop.talk.clipWaitMs", 8000));
  }

  /** Their words, once the stream's final text or the clip is in. */
  function heardAll() {
    const me = s;
    if (!me || me.phase !== "hearing") return;
    clearTurn(me);
    const words = squash(me.final || me.heard);
    // Nothing said: listening again, to the same quiet deadline.
    if (!words) { listen(false); return; }
    void turn(me, words);
  }

  // ---- the server's answer ------------------------------------------------------------
  /** Whether the screen may be read for this window: known, not private, not sensitive, not ours. */
  function screenOk(info) {
    return !!info && !info.private && !info.sensitive && !call(() => d.ours(), false);
  }

  async function bodyFor(me, words) {
    const info = await me.infoP;
    const ours = !!call(() => d.ours(), false);
    const body = { talkId: me.id, turn: me.turn, words: words.slice(0, Math.max(1, ms("desktop.talk.wordsChars", 2000))), tz: -new Date().getTimezoneOffset(), ours };
    if (info && (info.private || info.sensitive)) {
      // Nothing of the screen: the field is said to be private, and that is all.
      body.field = { private: true };
    } else if (info && !ours) {
      if (info.label) body.app = String(info.label).slice(0, 80);
      if (info.title) body.title = String(info.title).slice(0, 200);
      if (info.url) body.url = String(info.url).slice(0, 500);
      const f = await me.fieldP;
      body.field = f && typeof f === "object" ? (typeof f.selection === "string" && f.selection ? { selection: f.selection.slice(0, 4000) } : {}) : null;
      let page = null;
      try { page = await d.pageFor(info); } catch { page = null; }
      if (page && typeof page === "object") body.page = page;
    }
    const grants = typeof d.grants === "function" ? call(() => d.grants(), undefined) : undefined;
    if (grants) body.grants = grants;
    return body;
  }

  /** One turn: their words to /v1/talk, the answer shown and said as it streams, then the next turn. */
  async function turn(me, words) {
    me.phase = "thinking";
    me.turn++;
    me.said = ""; me.pending = ""; me.handoff = null;
    show({ phase: "think", heard: words, said: "", gesture: "think" });
    const body = await bodyFor(me, words);
    if (s !== me || me.phase !== "thinking") return;
    const ctrl = me.ctrl = new AbortController();
    const mine = () => s === me && me.ctrl === ctrl;
    let failed = null, finished = false;
    try {
      const res = await d.post("/v1/talk", body, { signal: ctrl.signal });
      if (!mine()) return;
      if (!res || !res.ok) failed = "HTTP " + (res ? res.status : "none");
      else {
        me.phase = "answering";
        for await (const ev of readEvents(res.body)) {
          if (!mine()) return;
          if (ev.t === "error") { failed = String(ev.code || "error") + (ev.message ? ": " + ev.message : ""); break; }
          heard(me, ev);
          if (ev.t === "done") { finished = true; break; }
        }
      }
    } catch (e) {
      if (!mine()) return;
      failed = (e && e.message) || String(e);
    }
    if (!mine()) return;
    me.ctrl = null;
    // A stream that stopped short with some of an answer is that answer; with none, it failed.
    if (!failed && !finished && !me.said) failed = "no answer";
    if (failed) { log("talk: turn " + me.turn + " failed: " + failed); return trouble(me); }
    me.errors = 0;
    sayRest(me);
    const n = me.turn;
    await allSaid(me);
    if (s !== me || me.turn !== n || me.phase !== "answering") return;
    unwatch(me);
    if (me.handoff) return handOff(me, me.handoff);
    listenAgain(me);
  }

  /** One event of the answer. */
  function heard(me, ev) {
    if (me.phase !== "answering") return;
    switch (ev.t) {
      case "route":
        if (typeof ev.lang === "string") me.lang = ev.lang.slice(0, 20);
        if (ev.depth === "think") show({ gesture: "ponder" });
        break;
      case "mood":
        show({ gesture: gestureFor(ev.mood) });
        break;
      case "text": {
        const piece = typeof ev.text === "string" ? ev.text : "";
        if (!piece) break;
        const joined = joinStretch(me.said, piece);
        me.said += joined;
        me.pending += joined;
        if (me.view.gesture === "think" || me.view.gesture === "ponder") me.view.gesture = "talk";
        show({ phase: "answer", said: me.said });
        sayReady(me);
        break;
      }
      case "handoff":
        if (HANDOFFS.has(ev.to)) me.handoff = ev;
        break;
      case "done":
        // Nothing streamed: the whole answer, said now.
        if (!me.said && typeof ev.text === "string" && ev.text.trim()) {
          me.said = ev.text.trim();
          me.pending = me.said;
          if (me.view.gesture === "think" || me.view.gesture === "ponder") me.view.gesture = "talk";
          show({ phase: "answer", said: me.said });
        }
        break;
      default:
        break;
    }
  }

  /** The turn failed: said in a few words, then listening again, or the end after maxErrors in a row. */
  async function trouble(me) {
    me.errors++;
    me.phase = "answering";
    me.said = txt("desktop.talk.trouble", "I couldn't get that.");
    me.pending = "";
    show({ phase: "answer", said: me.said, gesture: "facepalm" });
    say(me, me.said);
    const n = me.turn;
    await allSaid(me);
    if (s !== me || me.turn !== n || me.phase !== "answering") return;
    if (me.errors >= Math.max(1, ms("desktop.talk.maxErrors", 2))) { end("errors"); return; }
    listenAgain(me);
  }

  function listenAgain(me) {
    me.quietAt = now() + ms("desktop.talk.quietMs", 8000);
    listen(false);
  }

  // ---- saying it ----------------------------------------------------------------------
  // Each sentence's voice is fetched as soon as it is written, and said once
  // the one before it has been. A barge-in or the end drops all of it (gen).
  function sayReady(me) {
    const r = sentences(me.pending, ms("desktop.talk.sentenceChars", 240));
    me.pending = r.rest;
    for (const t of r.said) say(me, t);
  }
  function sayRest(me) {
    sayReady(me);
    const t = me.pending.trim();
    me.pending = "";
    if (t) say(me, t);
  }
  function say(me, text) {
    const gen = me.gen;
    if (!me.watchSid && bool("desktop.talk.bargeVoice", false)) watch(me);
    const got = Promise.resolve().then(() => d.voice(text, { lang: me.lang })).catch(() => null);
    me.speech = me.speech.then(() => got).then((m) => (m && s === me && me.gen === gen ? d.play(m) : undefined)).catch(() => {});
  }
  /** Everything given to say, said (or dropped). */
  function allSaid(me) {
    const p = me.speech;
    return p.then(() => (me.speech === p ? undefined : allSaid(me)));
  }
  function hush(me) {
    me.gen++;
    me.speech = Promise.resolve();
    call(() => d.hush());
  }

  // ---- barge-in -----------------------------------------------------------------------
  /** desktop.talk.bargeVoice: the microphone listens while he speaks, for a voice over his. */
  function watch(me) {
    me.watchSid = d.nextSession();
    record(me.watchSid, { watch: true });
  }
  function unwatch(me) {
    if (!me.watchSid) return;
    call(() => d.cancelRecording(me.watchSid));
    me.watchSid = 0;
  }

  /**
   * Their turn, now: the key held ("key"), or a voice over his ("voice"). What
   * he is saying stops, a turn in flight is stopped on the server, and the
   * microphone opens. Held, only the key's release ends the turn.
   */
  function bargeIn(how) {
    const me = s;
    if (!me) return false;
    const held = how === "key";
    if (me.phase === "listening") {
      if (held) { me.held = true; cancelTimer(me.timers.quiet); }
      return true;
    }
    // Their words are on their way already: the turn goes on.
    if (me.phase === "hearing") return false;
    log("talk: barge-in (" + how + ")");
    hush(me);
    if (me.ctrl) { try { me.ctrl.abort(); } catch { /* done */ } me.ctrl = null; stopServer(me); }
    listen(held);
    return true;
  }

  /** The key held for a turn came up: the turn is over. */
  function release() {
    const me = s;
    if (!me || me.phase !== "listening" || !me.held) return;
    me.held = false;
    me.quietAt = now() + ms("desktop.talk.quietMs", 8000);
    stopTurn();
  }

  // ---- handoffs -----------------------------------------------------------------------
  async function handOff(me, h) {
    me.phase = "acting";
    const goal = squash(h.goal).slice(0, 2000);
    show({ phase: "act", gesture: HANDOFF_GESTURE[h.to] || "work" });
    log("talk: handoff to " + h.to);
    const sayLine = (k, f) => { if (s === me) { me.said = txt(k, f); show({ phase: "act", said: me.said, gesture: "facepalm" }); say(me, me.said); } };
    try {
      if (h.to === "agent") {
        const took = !!(await d.ask(goal, h.trusted === true ? { trusted: true } : undefined));
        if (took) await whileAsk(me);
      } else if (h.to === "write") {
        if (goal) await d.type(goal);
      } else if (h.to === "routine") {
        const r = await d.routine(goal);
        if (r && r.text) call(() => d.told({ name: txt("desktop.route.routineName", "Routines"), text: r.text }));
        else sayLine("desktop.talk.routineFailed", "I couldn't save that routine.");
      } else if (h.to === "notes") {
        d.notes(h.notes !== "stop");
      } else if (h.to === "bot") {
        const bot = h.bot && typeof h.bot === "object" && typeof h.bot.slug === "string" ? { slug: h.bot.slug, name: String(h.bot.name || "") } : null;
        const r = await d.bot(goal, bot);
        if (r) call(() => d.told(r));
        else sayLine("desktop.talk.botFailed", "I couldn't reach your bots.");
      }
    } catch (e) { log("talk: handoff failed: " + ((e && e.message) || e)); }
    await allSaid(me);
    if (s !== me || me.phase !== "acting") return;
    listenAgain(me);
  }

  /** Until Ask's run and its card are done (or desktop.talk.handoffMaxMs). */
  function whileAsk(me) {
    const until = now() + ms("desktop.talk.handoffMaxMs", 10 * 60 * 1000);
    return new Promise((resolve) => {
      const check = () => {
        if (s !== me || me.phase !== "acting" || !call(() => d.askBusy(), false) || now() >= until) { resolve(); return; }
        me.timers.ask = later(check, Math.max(100, ms("desktop.talk.askPollMs", 500)));
      };
      check();
    });
  }

  // ---- the recorder's messages (main.js hands them here first) -------------------------
  const isTalk = (p) => !!s && !!p && !!p.session && (p.session === s.sid || p.session === s.watchSid);
  const watching = (p) => p.session === s.watchSid;

  /** A partial: their words so far. True when the session is talk's. */
  function partial(p) {
    if (!isTalk(p)) return false;
    if (watching(p) || s.phase !== "listening") return true;
    s.heard = squash(p.text);
    if (s.heard) heardVoice(s);
    show({ heard: s.heard });
    return true;
  }
  /** The voice's level. A voice over desktop.talk.voiceLevel counts as speaking; over his, bargeLevel barges in. */
  function level(p) {
    if (!isTalk(p)) return false;
    const b = Array.isArray(p.bands) ? p.bands : [];
    const v = b.length ? Math.max(...b.map((x) => Number(x) || 0)) : 0;
    if (watching(p)) {
      if (v >= num("desktop.talk.bargeLevel", 0.5) && s.phase === "answering") bargeIn("voice");
      return true;
    }
    if (s.phase === "listening" && v >= num("desktop.talk.voiceLevel", 0.3)) heardVoice(s);
    return true;
  }
  /** The recorder's first real pause: the end of their turn, unless the key is held. */
  function paused(p) {
    if (!isTalk(p)) return false;
    if (!watching(p) && s.phase === "listening" && !s.held) stopTurn();
    return true;
  }
  /** The turn's clip (with what the stream heard of it as of the stop). */
  function audioIn(p) {
    if (!isTalk(p)) return false;
    if (watching(p)) return true;
    const me = s;
    // Ended by the recorder itself: the same as a stop.
    if (me.phase === "listening") { clearTurn(me); me.phase = "hearing"; show({ phase: "think", gesture: "think" }); }
    if (me.phase !== "hearing") return true;
    me.clipIn = true;
    if (typeof p.text === "string" && squash(p.text)) me.heard = squash(p.text);
    cancelTimer(me.timers.clip);
    if (me.final !== null) { heardAll(); return true; }
    // The stream's final text is usually a moment behind the clip.
    me.timers.final = later(() => { if (s === me && me.phase === "hearing") heardAll(); }, ms("desktop.talk.finalTextMs", 400));
    return true;
  }
  /** The stream's final text for the turn. */
  function textIn(p) {
    if (!isTalk(p)) return false;
    if (watching(p)) return true;
    s.final = squash(p.text);
    if (s.phase === "hearing" && (s.final || s.clipIn)) heardAll();
    return true;
  }
  /** A recorder error: a watch's is nothing; a turn's (the microphone blocked, missing, in use) ends talk mode. */
  function error(p) {
    if (!isTalk(p)) return false;
    if (watching(p)) { s.watchSid = 0; return true; }
    end("microphone");
    call(() => d.failed(p));
    return true;
  }
  /** The recorder's page crashed: a turn it was recording will not come back. */
  function recorderGone() {
    if (s && (s.phase === "listening" || s.phase === "hearing")) end("recorder");
  }

  return {
    start, end, bargeIn, release,
    partial, level, paused, audioIn, textIn, error, recorderGone,
    active: () => !!s,
    phase: () => (s ? s.phase : null),
  };
}

module.exports = { createTalk, gestureFor, sentences, MOOD_GESTURE };
