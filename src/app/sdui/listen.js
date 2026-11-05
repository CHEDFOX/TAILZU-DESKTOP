// The bot on the screen listens (shared/types/sdui.ts 3i: VoiceLive, LiveWords, DeskTalkTo): the window's half of the voice the main
// process records for him (src/dictation/windowVoice.js, over app:voice).
//
// voiceLive starts a session (a double-click on him: the window asks main to start one), or adopts the one the one key opened (main
// says `listen` by "key", and this runs the screen's talkTo.voice with the key's own mode: a hold or a tap is one turn, two taps a
// chat). Then, from main: `words` are written into LiveWords in place (no repaint), `level` goes on the voice bus his stage reads
// every frame (never into state), and `heard` writes the turn's words to `into`, sets statePath "sending", runs onHeard and waits
// for it, then asks for the next turn (a chat, while stopWhen does not hold) or stops. statePath is "listening" while he hears, and
// "" when it is over (then onEnd). voiceStop, a tap on him, Escape and another screen end it and drop the words not sent yet; a
// write's fetch or a quiet reload of the same screen does not (navigation.js paint calls voiceLeave).
//
// After every paint (navigation.js repaint, and so a live reload too) the window tells main whether this screen's bot takes the one
// key (talkTo), and not while a text field other than the one in his thought has the focus, so typing in "Name your space" or the
// code box with the key still types.

/** The session on this screen: { session (0 while main has not answered a start), mode, action, key, words, timer }. */
let VOICE = null;
/** Sessions this window finished itself: a late word from main about one of them is nothing. */
const VOICE_DONE = new Set();
/** The voice bus: the level main sends while he listens (0..1), and when; his stage reads it every frame (stage.js). */
const VOICE_LEVEL = { v: 0, at: 0 };
/** What the last talkTo told main ("" never told). */
let TALK_TOLD = "";

const voiceBridge = () => (VOICE_ON() ? window.tailzuApp : null);
const voiceKey = (t) => (t ? String(t.screenId || "") + "|" + JSON.stringify(t.params || {}) : "");

/** The voice now, 0..1, falling away when main has said nothing for a moment. */
function voiceLevel() {
  if (!VOICE) return 0;
  const age = performance.now() - VOICE_LEVEL.at;
  return age > 600 ? 0 : VOICE_LEVEL.v * Math.max(0, 1 - Math.max(0, age - 120) / 480);
}

/** He listens on this screen: listenWhen, and the box shows only the words. */
const voiceListening = () => !!VOICE;

/** statePath, written, and the screen drawn again holding what the person was doing (the field, the scroll). */
function voiceState(action, v) {
  if (!action || !action.statePath) return;
  setStatePath(action.statePath, v);
  const live = window.TailzuLive, held = live && live.holdView ? live.holdView(document) : null;
  repaint();
  if (held) live.restoreView(document, held);
}

/** voiceLive: a session starts, or (adopt: { session, mode }) the one the key opened is taken on. */
function voiceLiveRun(action, adopt) {
  const bridge = voiceBridge();
  if (!bridge || !action) return run(action && action.onError);
  // One session on a screen: a second start while one is on is nothing (the one on goes on).
  if (VOICE && !adopt) return;
  if (VOICE) voiceFinish(false);
  const target = STACK[STACK.length - 1];
  VOICE = { session: adopt ? adopt.session : 0, mode: adopt ? adopt.mode : action.mode === "chat" ? "chat" : "once", action, key: voiceKey(target), words: "", timer: 0 };
  VOICE_LEVEL.v = 0;
  liveWordsSet("");
  if (!adopt) {
    try { bridge.voice("start", { mode: VOICE.mode, silenceMs: Number(action.silenceMs) || 0 }); } catch { VOICE = null; return run(action.onError); }
    // Main answers a start at once (listen, or end when it refuses); one that never answers is not waited on.
    const me = VOICE;
    me.timer = setTimeout(() => { if (VOICE === me && !me.session) voiceFinish(true); }, K.num("desktop.window.startWaitMs", 4000));
  }
  voiceState(action, "listening");
}

/** A session this window is done with: main's late words about it are nothing (the last few are enough to know). */
function voiceDone(session) {
  if (!session) return;
  VOICE_DONE.add(session);
  if (VOICE_DONE.size > 32) VOICE_DONE.delete(VOICE_DONE.values().next().value);
}

/** It is over here: statePath "", the words gone, and onEnd. `ran`: run onEnd (not when another session takes its place). */
function voiceFinish(ran) {
  const me = VOICE;
  if (!me) return;
  VOICE = null;
  clearTimeout(me.timer);
  voiceDone(me.session);
  VOICE_LEVEL.v = 0;
  liveWordsSet("");
  voiceState(me.action, "");
  if (ran) void run(me.action.onEnd);
}

/** voiceStop, a tap on him: main stops, the words of the turn not sent yet are dropped. Idempotent. */
function voiceStopRun(cmd) {
  const me = VOICE;
  if (!me) return;
  const bridge = voiceBridge();
  try { if (bridge) bridge.voice(cmd || "stop", { session: me.session }); } catch { /* the main process is gone: it is over anyway */ }
  voiceFinish(true);
}

/** Another screen (other id or params) is being painted: the voice of the one it started on stops. */
function voiceLeave(target) {
  if (VOICE && voiceKey(target) !== VOICE.key) voiceStopRun("stop");
}

/** A turn's words are in: to `into`, "sending" while onHeard runs, then the next turn (a chat) or the end. */
async function voiceHeard(me, text) {
  const a = me.action;
  if (a.into) setStatePath(a.into, text);
  voiceState(a, "sending");
  try { await run(a.onHeard); } catch { /* its own onError said so */ }
  if (VOICE !== me) return;
  const bridge = voiceBridge();
  if (me.mode === "chat" && !(a.stopWhen && visible(a.stopWhen))) {
    liveWordsSet("");
    voiceState(a, "listening");
    try { bridge.voice("again", { session: me.session }); } catch { voiceFinish(true); }
    return;
  }
  try { bridge.voice("stop", { session: me.session }); } catch { /* over anyway */ }
  voiceFinish(true);
}

/** A message from main (app:voice). */
function voiceMessage(m) {
  if (!m || typeof m !== "object") return;
  const session = Number(m.session) || 0;
  if (VOICE_DONE.has(session)) return;
  const me = VOICE;
  // A session this window asked for and main has not named yet takes the first word about a session it has not finished.
  const mine = !!me && (me.session ? me.session === session : true);
  switch (m.kind) {
    case "listen": {
      if (m.by === "key") {
        // The one key opened it: the screen's own voice takes it on, in the key's mode.
        const t = CURRENT_SCREEN && CURRENT_SCREEN.talkTo;
        const voice = t && t.voice && t.voice.kind === "voiceLive" ? t.voice : null;
        if (!voice || gateUp()) { try { window.tailzuApp.voice("stop", { session }); } catch { /* gone */ } return; }
        voiceLiveRun(voice, { session, mode: m.mode === "chat" ? "chat" : "once" });
        return;
      }
      if (me && !me.session) { me.session = session; clearTimeout(me.timer); return; }
      // A start this window did not ask for (or no longer wants): stopped.
      if (!mine) { try { window.tailzuApp.voice("stop", { session }); } catch { /* gone */ } }
      return;
    }
    case "words":
      if (!mine) return;
      me.words = String(m.text || "");
      liveWordsSet(me.words);
      return;
    case "level":
      if (!mine) return;
      VOICE_LEVEL.v = Math.max(0, Math.min(1, Number(m.v) || 0));
      VOICE_LEVEL.at = performance.now();
      return;
    case "heard":
      if (!mine) return;
      void voiceHeard(me, String(m.text || ""));
      return;
    case "error":
      if (!mine) return;
      // No microphone allowed: the screen's onBlocked; anything else its onError, else the main process's own words.
      if (m.blocked && me.action.onBlocked) void run(me.action.onBlocked);
      else if (me.action.onError) void run(me.action.onError, String(m.message || ""));
      else if (m.message) toast(String(m.message));
      return;
    case "end":
      if (!mine) return;
      voiceDone(me.session || session);
      voiceFinish(true);
      return;
    default:
      return;
  }
}

// ---- the one key, with X0 in front -------------------------------------------------------------------------------------

/** A text field that is not the one in his thought has the focus: the one key types into it, as it always did. */
function otherFieldFocused() {
  const a = document.activeElement;
  if (!a || !a.tagName) return false;
  const tag = String(a.tagName).toLowerCase();
  const field = tag === "textarea" || (tag === "input" && !/^(button|checkbox|radio|range|submit|reset)$/i.test(a.type || "")) || a.isContentEditable === true;
  return field && !(a.closest && a.closest(".tz-th-box"));
}

/** Tell main whether the key goes to this screen's bot, when that changed. */
function talkToFollow() {
  const bridge = voiceBridge();
  if (!bridge || typeof bridge.talkTo !== "function") return;
  const t = !gateUp() && CURRENT_SCREEN && CURRENT_SCREEN.talkTo;
  const want = t && t.voice && !otherFieldFocused() ? { hold: true, chat: true } : null;
  const said = JSON.stringify(want);
  if (said === TALK_TOLD) return;
  TALK_TOLD = said;
  try { bridge.talkTo(want); } catch { /* the main process is gone */ }
}

// ---- LiveWords ------------------------------------------------------------------------------------------------------------
// One span per word: a new word (or one a later partial changed) starts at freshColor and settles to color over settleMs. Written in
// place as the words come, never by a repaint; a repaint draws them as they are (a settling word carries on settling).

/** The turn's words: [{ w, at }] (at: when this word, as it is now, came). */
let LW_WORDS = [];

function liveWordsSet(text) {
  const next = String(text || "").split(/\s+/).filter(Boolean);
  const now = performance.now();
  LW_WORDS = next.map((w, i) => (LW_WORDS[i] && LW_WORDS[i].w === w ? LW_WORDS[i] : { w, at: now }));
  const view = document.getElementById("view");
  if (view) view.querySelectorAll("[data-lw]").forEach(liveWordsDraw);
}

function liveWordsNode(p) {
  const size = Number(p.size) || 16, lh = Number(p.lineHeight) || 22;
  const font = String(p.fontFamily || "Tailzu Geist");
  return '<div class="tz-lw" data-lw="1" aria-live="polite" data-color="' + esc(p.color || "#0a0a0a") + '" data-fresh="' + esc(p.freshColor || "#b5b5b5") +
    '" data-settle="' + (Number(p.settleMs) > 0 ? Number(p.settleMs) : 600) + '" style="font-family:\'' + esc(font) + "';font-weight:normal;font-size:" + size +
    "px;line-height:" + lh + 'px;min-height:' + lh + 'px;white-space:normal;word-break:break-word"></div>';
}

/** The words into one LiveWords: kept spans stay as they are, changed ones start fresh, the rest go. */
function liveWordsDraw(el) {
  const color = el.getAttribute("data-color") || "#0a0a0a", fresh = el.getAttribute("data-fresh") || "#b5b5b5";
  const settle = Number(el.getAttribute("data-settle")) || 600;
  const now = performance.now();
  const spans = Array.from(el.children);
  LW_WORDS.forEach((o, i) => {
    let s = spans[i];
    if (s && s.__w === o) return;
    if (!s) { s = document.createElement("span"); s.className = "tz-lw-w"; el.appendChild(s); }
    s.__w = o;
    s.textContent = (i ? " " : "") + o.w;
    const left = Math.max(0, settle - (now - o.at));
    if (!left) { s.style.transition = "none"; s.style.color = color; return; }
    s.style.transition = "none";
    s.style.color = fresh;
    requestAnimationFrame(() => {
      if (s.__w !== o) return;
      s.style.transition = "color " + Math.round(left) + "ms ease-out";
      s.style.color = color;
    });
  });
  for (let i = spans.length - 1; i >= LW_WORDS.length; i--) spans[i].remove();
}

/** After a paint: each LiveWords drawn with the words as they are. */
function mountLiveWords(root) {
  root.querySelectorAll("[data-lw]").forEach(liveWordsDraw);
}

// ---- wiring --------------------------------------------------------------------------------------------------------------
if (typeof window !== "undefined" && window.tailzuApp && typeof window.tailzuApp.onVoice === "function") {
  try { window.tailzuApp.onVoice(voiceMessage); } catch { /* an older main process */ }
}
if (typeof document !== "undefined" && document.addEventListener) {
  // The focus moving in or out of a text field changes where the one key goes (after it has settled on its new element).
  const refocus = () => setTimeout(talkToFollow, 0);
  document.addEventListener("focusin", refocus);
  document.addEventListener("focusout", refocus);
  // Escape: an open @ or / list first (mention.js, on its own field), then an open thought (stage.js), then his listening.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (typeof mentionEscape === "function" && mentionEscape()) { e.preventDefault(); return; }
    if (typeof stageEscape === "function" && stageEscape()) { e.preventDefault(); return; }
    if (VOICE) { e.preventDefault(); voiceStopRun("cancel"); }
  });
}
