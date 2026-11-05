/*
 * recorder.html's scripts: the hidden window that holds the microphone, with
 * two capture paths:
 *
 * BATCH (default): MediaRecorder → webm → POST /v1/transcribe-clean →
 *   cleaned text → main pastes it. Proven, simple, one round-trip.
 *
 * LIVE (cfg.live): WebAudio → 16 kHz PCM frames → WS /v1/transcribe-stream.
 *   Partials/finals stream back and paint the captions while you talk; on
 *   stop the whole recording, kept beside the stream, goes through
 *   /v1/transcribe-clean like a batch one (the stream's own text is refined
 *   and pasted only when there is no recording), and the text pastes once.
 *   (Partials are NEVER typed into the target app — captions only.)
 *
 * SESSION PROTOCOL: main mints a monotonic session id per dictation and
 * sends it in start-recording; every message we emit echoes it. All async
 * callbacks here capture their own session id and no-op when a NEWER
 * session has started — so a stale watchdog, a late ws close, or a slow
 * upload can never tear down or contaminate the session that replaced it.
 *
 * KNOBS: every threshold, the microphone constraints and the error copy
 * here are the server's (knobs.js, desktop.recorder.* / desktop.mic.*),
 * handed over with each start-recording as `cfg.knobs`. The literals next
 * to each key are what they were before, and what a launch that never
 * reached the backend still uses.
 *
 * PARTS. This file holds the session's state and what the main process says
 * to it; bands.js, pauseFlush.js, stretches.js, mic.js, refine.js, batch.js
 * and live.js follow it in recorder.html, classic scripts sharing the page's
 * global scope.
 */
const K = window.TailzuKnobs;
let cfg = {};
let session = 0;      // id of the CURRENT session (from main)
// A session told to stop before its microphone had opened. The stop
// found nothing recording; the mic that opened a moment later must not
// then start one — nobody would ever stop it (see startBatch/startLive).
let stopped = 0;
let stream = null;

// ---- batch state ----
let mediaRecorder = null;   // the one recording now (each keeps its own audio: record())

// ---- live state ----
let ws = null;
// The caption stream's start, while it waits for a token: the audio said
// meanwhile (held), and a stop that came before it (stop).
let wsStart = null;         // { sock, sent, held, stop }
let audioCtx = null;
let srcNode = null;
let proc = null;
let live = false;
let finals = [];
let lastPartial = "";
let wsWatchdog = null;
// The second engine's reading, when the stream's `done` carried one.
let doneAlternative = "";
// THE WHOLE RECORDING, kept beside the stream. See startLive: the text
// that is pasted comes from this, and the stream only draws captions.
let liveRec = null, liveChunks = [], recordedSession = 0, liveAt = 0;
// What each session has already written, pause by pause. Each stretch
// after the first is sent with it as context, so it is written as the
// continuation it is rather than as a new message: no capital after a
// comma, no repeated greeting, and the server can say whether it joins
// with a space. Per session, because a stop's last stretch can still be
// on its way when the next session starts.
const wrote = new Map();   // session → text
// The full stop each session held back at its last pause (heldStop.js): the
// next stretch's answer settles it, and a dictation that ends there gets it.
const heldStops = new Map();   // session → "." or "…"
// Stretches this session has sent on a pause.
let sentStretches = 0;

window.tailzu.onStart((c) => {
  cfg = c;
  session = c.session || 0;
  // The knobs as of this press, from the main process's bootstrap.
  if (c.knobs) K.setKnobs(c.knobs);
  // When the press was, so a first upload waits for the field read only as
  // long as that read can still be coming (see fieldRead).
  pressedAt.set(session, Date.now());
  for (const k of pressedAt.keys()) if (k < session - 20) pressedAt.delete(k);
  // Defensive teardown: if a previous session is somehow still capturing
  // (state desync upstream), kill it completely before starting fresh —
  // never let two captures share the mic or a chunks array.
  forceTeardownAll();
  // Sessions with nothing left to send are done with.
  for (const k of wrote.keys()) if (!queues.has(k)) wrote.delete(k);
  for (const k of heldStops.keys()) if (!queues.has(k)) heldStops.delete(k);
  sentStretches = 0;
  metered = false;
  // ASK: a question for the guide (agent.js), not a dictation. One clip, no
  // pause-writing; it ends on the first real pause, and it goes to the main
  // process whole rather than to /v1/transcribe-clean. With `live` it is
  // streamed as well, so the guide can match the words against the screen
  // while they are still being said, and the stream's text goes with the
  // clip (see stopLive and finishLive). An ASK's reply records without it.
  if (c.mode === "ask") { asks.add(session); for (const k of asks) if (k < session - 20) asks.delete(k); }
  cfg.live ? startLive(session) : startBatch(session);
});
const asks = new Set();   // sessions that are questions for the guide
let askEnded = false;     // this question's pause has been reported
// A question whose clip held no voice: whatever the stream made of it (a
// breath, the fan) is not a question either, so its final text goes empty.
let askSilent = 0;
// The app each session is going into, named by the main process a moment after
// the press (frontApp.js). "Desktop" until it arrives, or where it cannot be
// known.
const targets = new Map();
const targetFor = (sid) => targets.get(sid) || "Desktop";
// Sessions in a sensitive app (or a private window, while the server has them
// off): the server is told, and keeps nothing off the screen (not even their
// own prior text).
const privates = new Map();   // session → true
// Sessions in a private (incognito) window, read as any other: the server is
// told, and keeps nothing of them.
const incognito = new Map();  // session → true
// The text on the screen around the field, when it was read.
const arounds = new Map();    // session → text
window.tailzu.onTarget && window.tailzu.onTarget((p) => {
  if (p && typeof p.targetApp === "string" && p.targetApp) targets.set(p.session, p.targetApp.slice(0, 40));
  if (p && p.privateWindow) incognito.set(p.session, true);
  // An off-limits window's field is never read, so no read is coming to wait for.
  if (p && p.privateField) { privates.set(p.session, true); fieldArrived(p.session); }
  // Any other: the main process starts reading the field as it sends this,
  // so the read has given up desktop.field.timeoutMs from now (see fieldRead).
  else if (p && p.session) namedAt.set(p.session, Date.now());
  // Only the recent ones are worth keeping.
  const cut = (p && p.session || 0) - 20;
  for (const m of [targets, privates, incognito, arounds, namedAt]) for (const k of m.keys()) if (k < cut) m.delete(k);
});
window.tailzu.onAround && window.tailzu.onAround((p) => {
  if (p && typeof p.surroundings === "string" && p.surroundings && !privates.get(p.session)) {
    arounds.set(p.session, p.surroundings.slice(0, 8000));
  }
});
/** The screen read for a session, put on a request (surroundings + the
 *  private flags), the way `put` adds fields. Off limits wins: nothing off the
 *  screen rides with it. */
function withScreen(sid, put) {
  if (incognito.get(sid)) put("privateWindow", "true");
  if (privates.get(sid)) { put("privateField", "true"); return; }
  const around = arounds.get(sid);
  if (around) put("surroundings", around);
}
// The field each session is going into (frontApp.focusedField, by way of the
// main process): its kind and label ride with every request, and what was
// already written before the cursor is where the session's context starts,
// so the first stretch is written as the continuation of what is there.
// Only when nothing has been written yet: a read that lands late must not
// rewrite a context the session has already sent.
const fields = new Map();
// WHAT WAS SELECTED in that field when they started talking. What they say is
// then about it ("make this bullet points", "shorter"): it goes with the
// session's first request, the server rewrites it to follow what was said,
// and the answer is pasted over it, joining nothing. Kept until a stretch
// with words is written (a silent first stretch leaves it selected), and only
// taken while nothing has been sent: a read that lands after the first
// request would rewrite text the first paste already replaced.
const selections = new Map();   // session → text
const asked = new Set();        // sessions that have sent a request
window.tailzu.onField && window.tailzu.onField((p) => {
  if (!p) return;
  // Any answer ends a first upload's wait, an empty one (no text field)
  // included: there is nothing more to wait for.
  fieldArrived(p.session);
  if (!p.field || typeof p.field.kind !== "string") return;
  fields.set(p.session, { kind: p.field.kind, label: typeof p.field.label === "string" ? p.field.label : "" });
  if (typeof p.field.before === "string" && p.field.before && !wrote.has(p.session)) wrote.set(p.session, p.field.before);
  if (typeof p.field.selection === "string" && p.field.selection.trim() && !asked.has(p.session)) selections.set(p.session, p.field.selection);
  for (const k of fields.keys()) if (k < (p.session || 0) - 20) fields.delete(k);
  for (const k of selections.keys()) if (k < (p.session || 0) - 20) selections.delete(k);
  for (const k of asked) if (k < (p.session || 0) - 20) asked.delete(k);
});
// THE FIRST REQUEST WAITS A MOMENT FOR THE FIELD. The main process reads the
// field only after it has named the app (two system reads in a row), and a
// short instruction ("shorter", "bullets") can be over before that lands. Sent
// without it, the instruction went as plain dictation and was pasted over
// the very text it was about. So a session's first request, when no read has
// arrived, waits for one: at most desktop.recorder.fieldWaitMs, and never
// past the moment the read would have given up (desktop.field.timeoutMs
// after the app was named, or, while it has not been, 1.5 s after the press
// plus that), so a long dictation into something that is not a text field
// does not wait. The main process sends nothing when it finds no text
// field, so that bound is all that ends the wait there. Only a Mac and
// Windows read the field at all; anywhere else nothing is waited for.
const pressedAt = new Map();    // session → when it started
const namedAt = new Map();      // session → when the app it goes into was named
const fieldSeen = new Set();    // sessions whose field read has answered
const fieldWaiters = new Map(); // session → what to call when it does
function fieldArrived(sid) {
  if (!sid) return;
  fieldSeen.add(sid);
  for (const k of fieldSeen) if (k < sid - 20) fieldSeen.delete(k);
  const wake = fieldWaiters.get(sid);
  if (wake) { fieldWaiters.delete(sid); wake.forEach((f) => f()); }
}
/** Resolves when the session's field read has answered, or once waiting
 *  longer could no longer help. At once for every request after the first. */
function fieldRead(sid) {
  if (asked.has(sid) || fieldSeen.has(sid) || privates.get(sid) || !K.bool("desktop.field.read", true)) return Promise.resolve();
  // frontApp.focusedField reads nothing on Linux.
  if (!/^(Mac|Win)/.test(navigator.platform || "")) return Promise.resolve();
  const readMs = K.num("desktop.field.timeoutMs", 1200);
  const givesUpAt = namedAt.has(sid) ? namedAt.get(sid) + readMs : (pressedAt.get(sid) || 0) + 1500 + readMs;
  const ms = Math.min(K.num("desktop.recorder.fieldWaitMs", 900), givesUpAt - Date.now());
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      const rest = (fieldWaiters.get(sid) || []).filter((f) => f !== done);
      if (rest.length) fieldWaiters.set(sid, rest); else fieldWaiters.delete(sid);
      resolve();
    };
    const timer = setTimeout(done, ms);
    fieldWaiters.set(sid, (fieldWaiters.get(sid) || []).concat(done));
  });
}
/** The session's selection, for the request about to go, or "". Never off a
 *  off-limits window (none is read there; this is the second lock). */
function selectionFor(sid) {
  asked.add(sid);
  return privates.get(sid) ? "" : (selections.get(sid) || "");
}
/** The whitespace a selection starts and ends with. Its rewrite comes back
 *  trimmed, and pasted over a paragraph selected with its line break, it
 *  would join the next one; the main process puts these back around it.
 *  Up to 64 characters each side, which the main process accepts: a block
 *  of code indented deeper than a few spaces, or a run of blank lines,
 *  otherwise lost what was cut, and even an edit that changed nothing
 *  changed the document. */
function edgesOf(selection) {
  return [selection.match(/^\s*/)[0].slice(0, 64), selection.match(/\s*$/)[0].slice(-64)];
}
/** The field's kind and label, put on a request the way `put` adds fields. */
function withField(sid, put) {
  const f = fields.get(sid);
  if (!f) return;
  put("fieldKind", f.kind);
  if (f.label) put("fieldLabel", f.label.slice(0, 60));
}
window.tailzu.onStop((p) => {
  // Only stop the session main thinks is active; a stale stop is a no-op.
  if (p && p.session && p.session !== session) return;
  stopped = session;
  stopBands();
  // The last words since the meter's previous read, before anything stops.
  if (pollLevel) pollLevel();
  live ? stopLive(session) : stopBatch(session);
});
// Thrown away from the pill: close the mic and upload nothing. A new
// session id means nothing still in flight can report into this one.
window.tailzu.onCancel && window.tailzu.onCancel((p) => {
  if (p && p.session && p.session !== session) return;
  stopBands();
  stopWatchingLevel();
  forceTeardownAll();
  session = -1;
});
