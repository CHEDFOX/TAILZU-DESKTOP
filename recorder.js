/*
 * recorder.html's script: the hidden window that holds the microphone, with
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
// Sessions in a private window or a sensitive app: the server is told, and
// keeps nothing off the screen (not even their own prior text).
const privates = new Map();   // session → true
// The text on the screen around the field, when it was read.
const arounds = new Map();    // session → text
window.tailzu.onTarget && window.tailzu.onTarget((p) => {
  if (p && typeof p.targetApp === "string" && p.targetApp) targets.set(p.session, p.targetApp.slice(0, 40));
  // A private window's field is never read, so no read is coming to wait for.
  if (p && p.privateField) { privates.set(p.session, true); fieldArrived(p.session); }
  // Any other: the main process starts reading the field as it sends this,
  // so the read has given up desktop.field.timeoutMs from now (see fieldRead).
  else if (p && p.session) namedAt.set(p.session, Date.now());
  // Only the recent ones are worth keeping.
  const cut = (p && p.session || 0) - 20;
  for (const m of [targets, privates, arounds, namedAt]) for (const k of m.keys()) if (k < cut) m.delete(k);
});
window.tailzu.onAround && window.tailzu.onAround((p) => {
  if (p && typeof p.surroundings === "string" && p.surroundings && !privates.get(p.session)) {
    arounds.set(p.session, p.surroundings.slice(0, 8000));
  }
});
/** The screen read for a session, put on a request (surroundings + the
 *  private flag), the way `put` adds fields. Private wins: nothing off the
 *  screen rides with it. */
function withScreen(sid, put) {
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
 *  private window (none is read there; this is the second lock). */
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

// ---- The voice, band by band, for the pill ------------------------------
// Its own analyser on the same stream, separate from the pause meter, so
// the bars move whether or not pausing writes. Bands are spaced the way
// an ear hears (low voice in the first), each 0..1, sent a few dozen
// times a second and only while this session is the live one.
let bandCtx = null, bandTimer = null;
function startBands(sid, src) {
  if (!src || !window.tailzu.level) return;
  try {
    bandCtx = new (window.AudioContext || window.webkitAudioContext)();
    const an = bandCtx.createAnalyser();
    an.fftSize = K.num("desktop.pill.fftSize", 1024);
    an.smoothingTimeConstant = K.num("desktop.pill.smoothing", 0.55);
    bandCtx.createMediaStreamSource(src).connect(an);
    const bins = new Uint8Array(an.frequencyBinCount), hz = bandCtx.sampleRate / an.fftSize;
    const N = Math.max(4, Math.min(24, K.num("desktop.pill.bands", 12)));
    const lo = K.num("desktop.pill.lowHz", 90), hi = K.num("desktop.pill.highHz", 4200);
    const floor = K.num("desktop.pill.floorDb", 30), span = K.num("desktop.pill.spanDb", 150);
    const edges = Array.from({ length: N + 1 }, (_, i) => Math.round(lo * Math.pow(hi / lo, i / N) / hz));
    // Silence is sent once, not thirty times a second through two
    // processes: the pill lets bars fall by itself when the voice stops.
    let quiet = false;
    bandTimer = setInterval(() => {
      if (sid !== session) return;
      an.getByteFrequencyData(bins);
      const out = [];
      for (let b = 0; b < N; b++) {
        let m = 0; const a = edges[b], z = Math.max(a + 1, edges[b + 1]);
        for (let i = a; i < z && i < bins.length; i++) m = Math.max(m, bins[i]);
        out.push(Math.max(0, Math.min(1, (m - floor) / span)));
      }
      const silent = out.every((v) => v === 0);
      if (silent && quiet) return;
      quiet = silent;
      window.tailzu.level({ session: sid, bands: out });
    }, K.num("desktop.pill.levelMs", 33));
  } catch { stopBands(); }
}
function stopBands() {
  if (bandTimer) { clearInterval(bandTimer); bandTimer = null; }
  if (bandCtx) { try { bandCtx.close(); } catch {} bandCtx = null; }
}

// ---- Pause-flush -------------------------------------------------------
// A PAUSE IS NOT AN ENDING, AND TREATING IT AS ONE IS WHY AUTO-STOP FAILS.
//
// Stopping on silence cuts people off while they think, because a
// thinking pause and a finished sentence look identical from here. So a
// pause flushes instead: what has been said so far is written out, the
// mic stays open, and the session ends when the user says so.
//
// Pausing therefore costs nothing — nothing ends, nothing is lost — and
// the text appears as you go rather than all at once at the end.
// The thresholds, read when the meter starts (so each session uses the
// knobs it was started with):
//   flushPauseMs    a pause this long is the end of a thought, not a breath
//   flushSpeechMs   voice a stretch needs before a pause writes it alone
//   minSegmentMs    never flush a cough
//   idleEndMs       walked away: close the mic ourselves
//   speechLevel     RMS floor; room tone sits well under
//   voicing         how periodic a loud frame must be to be a voice
//   meterPollMs     how often the level is read
//
// A PAUSE WRITES A PARAGRAPH, NOT A PHRASE. It used to write after 1.2 s of
// quiet and 0.4 s of sound: stretches of a few words, each written in
// isolation, where the writer had no sentence to punctuate and no way to
// fix a false start that ran across the pause — so it came back close to
// the raw transcript, and every stretch was one more upload that silence
// could turn into words. Now a pause writes only after several sentences'
// worth of voice and a pause long enough to end a thought. A short
// dictation is written once, whole, when it stops; a long one still
// appears paragraph by paragraph as it goes. (New keys: the old ones,
// flushSilenceMs and minSpeechMs, carry the server's old values.)
//
// NOTHING THAT IS NOT A VOICE IS SENT. The meter (speechMeter.js) reads
// every sample and counts only voice: a breath, a keyboard, a fan or a
// hum is loud but not voice. A stretch is written on a pause only once it
// holds `flushSpeechMs` of voice; less, and it stays with the next words
// rather than going alone to a recogniser that answers breath with
// "Thank you.". And the stretch a stop ends is sent only if it holds any
// voice at all (see lastStretchHeard).
//
// The meter runs in every mode, so that last decision can be made in
// every mode; it flushes and idles only where pausing writes (batch).

let levelCtx = null, levelTimer = null, analyser = null, pollLevel = null;
let speaking = false, lastSpeechAt = 0, lastSoundAt = 0, segmentStartedAt = 0, flushing = false;
// Voice in the stretch not yet written, in ms (speechMeter.js): at the
// level a pause writes at, and at the far lower level the stop's decision
// uses (a quiet voice is still a voice; only a stretch without one is
// withheld).
let speechMs = 0, softSpeechMs = 0;
// The meter has read real audio this session, so its silence is real.
// Unset (it could not start), the server is asked instead of trusted.
let metered = false;

function watchLevel(sid, pausing) {
  const FLUSH_SILENCE_MS = K.num("desktop.recorder.flushPauseMs", 2000);
  const MIN_SEGMENT_MS = K.num("desktop.recorder.minSegmentMs", 700);
  const IDLE_END_MS = K.num("desktop.recorder.idleEndMs", 25000);
  const SPEECH_LEVEL = K.num("desktop.recorder.speechLevel", 0.012);
  const MIN_SPEECH_MS = K.num("desktop.recorder.flushSpeechMs", 4000);
  const POLL_MS = K.num("desktop.recorder.meterPollMs", 120);
  let meter, soft, buf, readTo;
  try {
    levelCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = levelCtx.createMediaStreamSource(stream);
    analyser = levelCtx.createAnalyser();
    // Longer than the time between two reads, so every sample is read once
    // (it used to be a 10 ms snapshot of every 120).
    analyser.fftSize = Math.min(32768, Math.pow(2, Math.ceil(Math.log2(levelCtx.sampleRate * POLL_MS / 1000 * 1.5))));
    src.connect(analyser);
    const voicing = K.num("desktop.recorder.voicing", 0.5);
    meter = window.TailzuSpeech.createSpeechMeter({ sampleRate: levelCtx.sampleRate, level: SPEECH_LEVEL, voicing });
    // The server now measures the voice in every clip itself, so this one
    // only has to catch a stretch with none in it at all: its floor is far
    // under the pause's, about -50 dBFS, and a soft-spoken sentence clears it.
    soft = window.TailzuSpeech.createSpeechMeter({
      sampleRate: levelCtx.sampleRate, level: K.num("desktop.recorder.finalSpeechLevel", 0.003), voicing,
    });
    buf = new Float32Array(analyser.fftSize);
    readTo = levelCtx.currentTime;
  } catch { stopWatchingLevel(); return; }   // no meter is survivable: it just never flushes
  segmentStartedAt = lastSpeechAt = lastSoundAt = Date.now();
  askEnded = false;
  pollLevel = () => {
    if (sid !== session || !analyser || !levelCtx) return;
    // Only what arrived since the last read, by the audio clock.
    const at = levelCtx.currentTime, fresh = Math.min(buf.length, Math.round((at - readTo) * levelCtx.sampleRate));
    readTo = at;
    if (fresh <= 0) return;
    analyser.getFloatTimeDomainData(buf);
    const read = buf.subarray(buf.length - fresh), r = meter.feed(read);
    softSpeechMs = Math.max(0, softSpeechMs + soft.feed(read).voicedMs);
    metered = true;
    const now = Date.now();
    speechMs = Math.max(0, speechMs + r.voicedMs);
    if (r.loudMs > 0) lastSoundAt = now;
    if (r.voicedMs > 0) { speaking = true; lastSpeechAt = now; return; }
    // A question is over at its first real pause: the main process stops it.
    if (asks.has(sid)) {
      if (speaking && !askEnded && now - lastSpeechAt > K.num("desktop.agent.pauseEndMs", 1200)) {
        askEnded = true;
        if (window.tailzu.askPause) window.tailzu.askPause({ session: sid });
      }
      return;
    }
    if (!pausing) return;
    // Flush only if they actually said something since the last one.
    if (speaking && now - lastSpeechAt > FLUSH_SILENCE_MS
        && now - segmentStartedAt > MIN_SEGMENT_MS) {
      speaking = false;
      if (speechMs < MIN_SPEECH_MS) return;   // a few words, or a cough: kept with the next ones
      speechMs = softSpeechMs = 0;
      flushSegment(sid);
    } else if (!speaking && now - lastSoundAt > IDLE_END_MS) {
      window.tailzu.idle({ session: sid });
    }
  };
  levelTimer = setInterval(pollLevel, POLL_MS);
}

function stopWatchingLevel() {
  if (levelTimer) { clearInterval(levelTimer); levelTimer = null; }
  if (levelCtx) { try { levelCtx.close(); } catch {} levelCtx = null; }
  analyser = null;
  pollLevel = null;
  speaking = false;
  speechMs = softSpeechMs = 0;
}

/**
 * Whether the stretch a stop just ended holds a voice, asked before the
 * meter is cleared. It is usually the silence after the last pause, and
 * sent on its own that silence came back as words nobody said. Gentle on
 * purpose (a second line of defence behind the server's own measure): any
 * voice at all, however quiet, and it is sent. A meter that read nothing,
 * or belongs to a newer session, knows nothing: then the server decides.
 */
function lastStretchHeard(sid) {
  if (sid !== session || !metered) return true;
  return softSpeechMs >= K.num("desktop.recorder.minFinalSpeechMs", 120);
}

/** A stop whose stretch held no voice: nothing is sent, so nothing can be
 *  invented from it. The session still ends, after the stretches it did
 *  send. If it sent none, it heard nothing at all, and says so the way the
 *  server's empty answer would have. */
async function nothingToSend(sid, sentAny) {
  const t = turn(sid);
  await t.wait;
  try { if (sentAny) emitResult(sid, ""); else emitError(sid, str("noSpeech")); } finally { t.done(); }
}

// ---- One stretch after another -------------------------------------------
// A session's stretches are sent one after another, each once the one
// before it has been answered. Sent together, the short last one came back
// first and was pasted before the words it follows; and each went with the
// context of what had been written when it LEFT, which missed the stretch
// still in flight — so the server shaped it as a new sentence and said no
// space was needed after nothing. In turn, each carries exactly what was
// written before it. Per session: a newer one never waits on an older one.
const queues = new Map();   // session → the previous stretch's turn
function turn(sid) {
  const wait = queues.get(sid) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  queues.set(sid, mine);
  return { wait, done: () => { release(); if (queues.get(sid) === mine) queues.delete(sid); } };
}

/** End this segment and start the next one on the SAME microphone. The
 *  stream is never touched, so there is no permission blink, no device
 *  re-acquire, and no gap where speech would be lost. */
function flushSegment(sid) {
  if (!mediaRecorder || mediaRecorder.state === "inactive") return;
  flushing = true;
  try { mediaRecorder.stop(); } catch { flushing = false; }
}

// `join`: the server's word on a space before `text` (see transcribe).
// `heard`: what the recogniser heard for the stretch (its raw transcript), which
// the main process reads to decide where the words go (routing.js); only the
// written `text` is ever pasted.
function emitSegment(sid, text, join, edges, heard) { window.tailzu.segment({ session: sid, text: text, join: join, edges: edges, heard: heard || "" }); }
function emitResult(sid, text, join, edges, heard) { window.tailzu.result({ session: sid, text: text, join: join, edges: edges, heard: heard || "" }); }
/** A failure. `message` is the sentence the notification shows, and
 *  only ever words for a person; what actually went wrong travels in
 *  `extra.detail` to the main process's log, with the server's `code`
 *  when there was one. */
function emitError(sid, message, extra) {
  window.tailzu.error(Object.assign({ session: sid, message: message }, extra || {}));
}
/** An error as a developer reads it — for the log, never the screen. */
function errText(err) {
  return (err && err.message) ? (err.name ? err.name + ": " : "") + err.message : String(err);
}
function emitPartial(sid, text) { window.tailzu.partial({ session: sid, text: text }); }

function base() { return (cfg.baseUrl || "").replace(/\/+$/, ""); }
/** The account's bearer, and no header at all without one. */
function auth(token) { return token ? { Authorization: "Bearer " + token } : {}; }

/**
 * The token for one request, from the main process, which alone renews it.
 * The one handed over at the start used to serve every stretch, and a
 * dictation that outlived it was refused halfway. `renew`: the server has
 * just refused the one sent, so it is renewed now rather than at its stated
 * expiry.
 */
async function freshToken(renew) {
  try {
    const t = window.tailzu.token ? await window.tailzu.token(!!renew) : null;
    if (typeof t === "string" && t) cfg.token = t;
  } catch { /* the main process did not answer: the one in hand is tried */ }
  return cfg.token;
}

/** A request with the account's token; refused as unauthorised, sent once
 *  more with a renewed one before anything else is concluded. */
async function authorized(send) {
  const res = await send(auth(await freshToken(false)));
  if (res.status !== 401 && res.status !== 403) return res;
  return send(auth(await freshToken(true)));
}
function stopTracks() {
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
}
function forceTeardownAll() {
  stopBands();
  // The meter too: left running, the old one's timer and audio context
  // outlived its session, and its stop could close the new one's.
  stopWatchingLevel();
  flushing = false;
  try {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.ondataavailable = null;
      mediaRecorder.onstop = null;
      mediaRecorder.stop();
    }
  } catch {}
  mediaRecorder = null;
  if (liveRec) { try { liveRec.ondataavailable = liveRec.onstop = null; if (liveRec.state !== "inactive") liveRec.stop(); } catch {} liveRec = null; }
  liveChunks = [];
  teardownLiveGraph();
  if (ws) {
    ws.onclose = ws.onmessage = ws.onerror = ws.onopen = null;
    try { ws.close(); } catch {}
    ws = null;
  }
  live = false;
  clearTimeout(wsWatchdog);
  stopTracks();
}
// A server-drawn sentence, handed over with the session. Falls back to
// the built-in wording when a launch never reached the backend.
const STRING_FALLBACKS = {
  micBlockedMac: "microphone blocked — System Settings → Privacy & Security → Microphone → Tailzu",
  micBlockedWindows: "microphone blocked — Settings → Privacy & security → Microphone → let desktop apps access",
  micMissing: "no microphone found — plug one in, then try again",
  micBusy: "microphone is in use by another app",
  noSpeech: "no speech detected — check your microphone",
};
function str(key) {
  const v = cfg.strings && cfg.strings[key];
  return (typeof v === "string" && v.trim()) ? v : STRING_FALLBACKS[key];
}

function micMessage(err) {
  const m = (err && err.message) ? err.message : String(err);
  // A sentence getMic already wrote is passed through as it is.
  // Compared against the resolved strings rather than a prefix, so
  // server-drawn copy in any wording still matches.
  for (const k of ["micBlockedMac", "micBlockedWindows", "micMissing", "micBusy"]) {
    if (m === str(k)) return m;
  }
  // Anything else is a failure we cannot name, and the browser's words
  // for it ("AbortError: Could not start audio source") are not for
  // people. The notification says the mic did not start; the caller
  // sends the error itself to the log.
  return K.txt("desktop.recorder.micError", "Couldn't start the microphone. Try again.");
}

/**
 * A refused upload, worded by what the server said. It used to be the
 * status and the raw body ("HTTP 429 {code: quota_exceeded, …}") in the
 * notification. The words are the phones' (labels error.*), so one edit
 * on the server changes every surface; the word cap's own sentence is
 * already written for people (the number, the reset date, the way out)
 * and is shown.
 */
function httpMessage(status, body) {
  let j = null;
  try { j = JSON.parse(body); } catch { j = null; }
  if (j && j.code === "quota_exceeded") {
    return (typeof j.message === "string" && j.message.trim())
      ? j.message.trim() : K.txt("error.quota", "You've used this month's free words.");
  }
  if (status === 401 || status === 403) return K.txt("error.unauthorized", "Your session has expired. Sign in again to continue.");
  if (status === 429) return K.txt("error.rateLimited", "Too many requests. Wait a moment, then try again.");
  if (status >= 500) return K.txt("error.server", "Something went wrong on our side. Try again in a moment.");
  return K.txt("error.generic", "Something went wrong. Try again.");
}

async function getMic() {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: K.obj("desktop.mic.constraints", { echoCancellation: true, noiseSuppression: true, autoGainControl: true }),
    });
  } catch (err) {
    // THERE IS NO PERMISSION SCREEN HERE, AND THERE SHOULD NOT BE.
    //
    // Electron already grants the microphone to its own page (main.js
    // setPermissionRequestHandler), so an in-app step would have nothing
    // to ask. The gate that is left belongs to the operating system, and
    // no screen we draw can open it — only a sentence that says which
    // settings panel to go to. Chromium's own wording ("Permission
    // denied by system") names the problem and not the fix.
    // The sentences come with the session (cfg.strings), so the panel
    // this names can be corrected from the backend — Microsoft moves
    // that menu between Windows releases, and a wrong direction baked
    // into an installer is a wrong direction forever.
    const name = (err && err.name) || "";
    const mac = navigator.platform.indexOf("Mac") === 0;
    if (name === "NotAllowedError" || name === "SecurityError") {
      throw new Error(str(mac ? "micBlockedMac" : "micBlockedWindows"));
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") {
      throw new Error(str("micMissing"));
    }
    if (name === "NotReadableError") {
      throw new Error(str("micBusy"));
    }
    throw err;
  }
}

// ---- Refine (the live path's fallback, when there is no recording) ------
// /v1/refine with no tone, as the phone's keyboard sends it: the server
// writes in the account's own voice, its tone and its preset. It used to
// pick /v1/refine/<tone> from the tone this window was handed, and that was
// "none" (repair only, restyle nothing) whenever the main process had not
// read the account, which made live dictation read like its transcript.
async function refineText(text, alternative, context, sid) {
  const rid = sid === undefined ? session : sid;
  const body = { text, targetApp: targetFor(rid), language: cfg.language || "auto", tzOffsetMinutes: -new Date().getTimezoneOffset() };
  withField(rid, (k, v) => { body[k] = v; });
  withScreen(rid, (k, v) => { body[k] = v === "true" ? true : v; });
  // Said with text selected: the server rewrites it (see selections).
  const selection = selectionFor(rid);
  if (selection) body.selection = selection;
  // What the session already wrote, as on /v1/transcribe-clean.
  if (context) body.context = context.slice(-K.num("desktop.recorder.contextChars", 600));
  // The second engine's reading goes with it: the server reconciles the
  // two and decides which leads. Dropped here, the work was wasted.
  if (alternative) body.alternative = alternative;
  // ONE RETRY for a blip. A refusal is not retried (no words left: the
  // same answer again), except a spent token, which authorized() renews
  // and resends first.
  let last = null;
  for (let i = 0; i < 2; i++) {
    try {
      const res = await authorized((h) => fetch(base() + "/v1/refine", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, h),
        body: JSON.stringify(body),
      }));
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const err = Object.assign(new Error("refine HTTP " + res.status + (text ? " " + text.slice(0, K.num("desktop.recorder.errorBodyChars", 120)) : "")),
          { words: httpMessage(res.status, text), code: text.indexOf("quota_exceeded") !== -1 ? "quota_exceeded" : undefined });
        if (res.status < 500) { last = err; break; }
        throw err;
      }
      const j = await res.json();
      const refined = (j.refinedText || "").trim();
      if (refined) selections.delete(rid);
      // The join the server read, as /v1/transcribe-clean gives it: none
      // for a rewrite, which takes the selection's place, edges and all.
      return {
        text: refined,
        join: typeof j.joinWithSpace === "boolean" ? j.joinWithSpace : undefined,
        edges: j.replacedSelection && selection ? edgesOf(selection) : undefined,
      };
    } catch (err) {
      last = err;
    }
  }
  throw last || new Error("refine failed");
}

// ======================= BATCH =======================
function pickMime() {
  const candidates = K.list("desktop.mic.mimeTypes", ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]);
  for (const m of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return ""; // let the browser choose
}

/** A recorder on the open microphone that keeps its own audio: a stop
 *  still finishing never shares an array with the recorder after it. */
function record(sid, mimeType) {
  const parts = [], startedAt = Date.now();
  const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
  rec.onstop = () => onRecorderStopped(sid, mimeType, rec, parts, startedAt);
  rec.start();
  return rec;
}

async function startBatch(sid) {
  try {
    const mic = await getMic();
    // Superseded, or already stopped, while awaiting the mic — which on
    // a first run waits on the OS asking the person for permission. Its
    // own tracks are closed, never the global stream, which by now may be
    // a newer session's.
    if (sid !== session || sid === stopped) { mic.getTracks().forEach((t) => t.stop()); return; }
    stream = mic;
    const mimeType = pickMime();
    mediaRecorder = record(sid, mimeType);
    // Measured in every mode, so a stop can tell whether its last stretch
    // held a voice; it writes on a pause only when pausing is on.
    watchLevel(sid, !asks.has(sid) && cfg.pauseFlush !== false);
    startBands(sid, stream);
  } catch (err) {
    if (sid === session) stopTracks();
    emitError(sid, micMessage(err), { detail: errText(err) });
  }
}

/** A recorder stopped. Which kind of stop it was decides everything:
 *  a flush hands off to a fresh recorder on the same mic, a real stop
 *  closes the microphone. Confusing the two either leaves the mic hot
 *  forever or ends the session on the first pause. */
function onRecorderStopped(sid, mimeType, rec, parts, startedAt) {
  const wasFlush = flushing;
  flushing = false;
  const type = rec.mimeType || "audio/webm";
  const took = Date.now() - startedAt;

  if (wasFlush && sid === session && stream) {
    // Next segment first, so the microphone is live again before the
    // upload starts. Anything said during the round trip is captured.
    try {
      mediaRecorder = record(sid, mimeType);
      segmentStartedAt = Date.now();
    } catch (err) {
      stopTracks(); stopWatchingLevel();
      emitError(sid, K.txt("desktop.recorder.continueFailed", "Recording stopped unexpectedly. Try again."),
        { detail: errText(err) });
      return;
    }
    sentStretches++;
    void uploadBatch(sid, parts, type, true, took, true);
    return;
  }

  // The real stop. Whether its stretch held a voice is asked before the
  // meter is cleared; and only this session's microphone and meter are
  // closed, since a newer session may already hold them.
  const heard = lastStretchHeard(sid), sentAny = sentStretches > 0;
  if (sid === session) { stopWatchingLevel(); stopTracks(); }
  if (asks.has(sid)) { void handOver(sid, heard ? parts : [], type, took); return; }
  if (!heard) { void nothingToSend(sid, sentAny); return; }
  void uploadBatch(sid, parts, type, false, took, sentAny);
}

/** A question, recorded: its audio to the main process, which asks /v1/agent
 *  with it and the screen (agent.js). No voice in it: no audio, and the guide
 *  says it did not catch that. `text`: what the live stream has heard of it
 *  so far ("" when it was not streamed); its last word follows as askText. */
async function handOver(sid, parts, type, took, text) {
  let data = null;
  try { if (parts.length) data = await new Blob(parts, { type }).arrayBuffer(); } catch { data = null; }
  if (window.tailzu.askAudio) window.tailzu.askAudio({ session: sid, mime: type, data, durationMs: took, text: text || "" });
}
/** The stream's final text for a question, once: the main process waits a
 *  moment for it after the clip (desktop.agent.finalTextMs), and goes with
 *  what it has if it does not come. */
function askFinal(sid, text) {
  if (window.tailzu.askText) window.tailzu.askText({ session: sid, text: askSilent === sid ? "" : text || "", final: true });
}

function stopBatch(sid) {
  try {
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
    // A pause's stop is still finishing: it becomes the last one. Taken
    // for "nothing was recording", it said "Recording didn't start" and
    // closed the mic under the pause's own recorder.
    else if (flushing) flushing = false;
    else {
      stopTracks();
      // Nothing was ever recording — say so instead of dying silently
      // (this is the state a dropped start-recording IPC used to leave).
      emitError(sid, K.txt("desktop.recorder.notRunning", "Recording didn't start. Try again."),
        { detail: "recorder was not running" });
    }
  } catch (err) {
    emitError(sid, K.txt("desktop.recorder.stopFailed", "Recording didn't finish. Try again."),
      { detail: errText(err) });
  }
}

/** Close this session's capture without sending anything: the server has
 *  refused it outright (no words left, signed out), so nothing more it
 *  records can be written. */
function endCapture(sid) {
  if (sid !== session) return;
  if (mediaRecorder) { mediaRecorder.ondataavailable = mediaRecorder.onstop = null; try { if (mediaRecorder.state !== "inactive") mediaRecorder.stop(); } catch {} mediaRecorder = null; }
  flushing = false;
  stopBands();
  stopWatchingLevel();
  stopTracks();
}

/** Send a stretch once the one before it has been answered and reported
 *  (see turn). `sentAny`: this session already sent a stretch, so an empty
 *  answer to the last one ends it quietly rather than as "no speech". */
async function uploadBatch(sid, parts, type, isSegment, durationMs, sentAny) {
  const t = turn(sid);
  await t.wait;
  let report = null;
  try { report = await transcribe(sid, parts, type, isSegment, durationMs, sentAny); }
  finally {
    try { if (report) report(); } finally { t.done(); }
  }
}

/** The upload itself. Answers with what to tell the main process, or null. */
async function transcribe(sid, parts, type, isSegment, durationMs, sentAny) {
  if (!parts || !parts.length) {
    // A flush with nothing in it is ordinary — they paused twice, or
    // the segment was all room tone. Only a FINAL stop with no audio
    // is worth telling anyone about.
    return isSegment ? null : () => emitError(sid, K.txt("desktop.mic.noAudio", "no audio captured"));
  }
  // The session's first request carries the field read, and the selection
  // in it, when that read is still on its way (see fieldRead).
  await fieldRead(sid);
  // A request that never answers held the pill on "writing" until the next
  // press. It gets what a stretch of its length could need, then it fails.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), K.num("desktop.recorder.uploadTimeoutMs", 60000) + 2 * (durationMs || 0));
  try {
    const ext = type.includes("ogg") ? "ogg" : "webm";
    const blob = new Blob(parts, { type });
    const fd = new FormData();
    fd.append("audio", blob, "audio." + ext);
    fd.append("targetApp", targetFor(sid));
    withField(sid, (k, v) => fd.append(k, v));
    withScreen(sid, (k, v) => fd.append(k, v));
    // The device's UTC offset now, so recent-dictation timing reads right.
    fd.append("tzOffsetMinutes", String(-new Date().getTimezoneOffset()));
    fd.append("language", cfg.language || "auto");
    // No tone field, as the phone app sends none: the server writes in the
    // account's voice (tone and preset). It used to be sent from this
    // window's copy, which said "none" (repair only) whenever the main
    // process had not read the account, and overrode it.
    // What this session already wrote, so this stretch continues it.
    const before = wrote.get(sid) || "";
    if (before) fd.append("context", before.slice(-K.num("desktop.recorder.contextChars", 600)));
    // The context stops where they paused, its full stop held back: the server
    // is told, and its answer either opens with that stop or carries on.
    if (before && heldStops.has(sid)) fd.append("heldStop", "1");
    // Said with text selected: what they say is about it, and the answer is
    // the selection rewritten, to paste over it (see selections).
    const selection = selectionFor(sid);
    if (selection) fd.append("selection", selection);
    const res = await authorized((h) => fetch(base() + "/v1/transcribe-clean", {
      method: "POST",
      headers: h,
      body: fd,
      signal: ctl.signal,
    }));
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const quota = body.indexOf("quota_exceeded") !== -1;
      // A pause's stretch refused for a passing reason (the server busy, a
      // burst of requests) is lost like a dropped one, and the session goes
      // on. It used to end the session in the main process while this
      // window kept the microphone open, recording into nowhere.
      if (isSegment && !quota && res.status !== 401 && res.status !== 403) {
        return () => window.tailzu.segment({ session: sid, text: "", failed: true });
      }
      if (isSegment) endCapture(sid);
      return () => emitError(sid, httpMessage(res.status, body), {
        // The main process asks for a fresh bootstrap on this, so the
        // next press is refused before the mic opens.
        code: quota ? "quota_exceeded" : undefined,
        detail: "HTTP " + res.status + (body ? " " + body.slice(0, K.num("desktop.recorder.errorBodyChars", 120)) : ""),
      });
    }
    const json = await res.json();
    const cleaned = (json.cleanedText || "").trim();
    const heardText = json.noSpeech ? "" : String(json.transcript || json.text || "").trim().slice(0, 4000);
    const heardWords = !!heardText;
    // Whether it joins what came before with a space, as the server read it
    // against the context sent — which, sent in turn, is exactly what was
    // written before it. An older server says nothing, and the main process
    // decides (pasteJoin.js).
    const join = typeof json.joinWithSpace === "boolean" ? json.joinWithSpace : undefined;
    // A segment pastes and leaves the session running; a final result
    // pastes and ends it. Same text, different meaning to the main
    // process, and it must not learn the difference by guessing.
    const deliver = isSegment ? emitSegment : emitResult;
    // A rewrite of the selection goes back in its place with its own edges.
    const edges = json.replacedSelection && selection ? edgesOf(selection) : undefined;
    return () => {
      // A HELD STOP (heldStop.js). Any words in this answer settle the stop
      // held at the last pause: it opened with that stop, or it carries the
      // sentence on. A pause stretch holds its own closing stop in turn, when
      // the server says it can be told (holdsStops). A dictation that ends on
      // the pause, with nothing more to write, gets the held stop after all.
      const stop = heldStops.get(sid);
      let text = cleaned;
      if (text) heldStops.delete(sid);
      if (text && isSegment && json.holdsStops === true && !edges) {
        const h = window.TailzuHeld && window.TailzuHeld.holdStop(text);
        if (h && h.text.trim()) { text = h.text; heldStops.set(sid, h.stop); }
      }
      if (!text && !isSegment && stop) { heldStops.delete(sid); text = stop; }
      // Added in the order spoken, so the context reads as it was said.
      const placed = edges ? edges[0] + text + edges[1] : text;
      if (text) wrote.set(sid, before ? before + (join === false || text === stop ? "" : " ") + placed : placed);
      // Pasted, it takes the selection's place: the next stretch is plain
      // dictation after it.
      if (text) selections.delete(sid);
      // ONLY THE WRITTEN TEXT IS EVER PASTED. An empty `cleanedText` is the
      // server deciding there is nothing to write: silence, noise the
      // recogniser turned into words, a stretch that was only an
      // instruction. The raw transcript used to be pasted in its place,
      // which put exactly those invented or unwritten words at the cursor.
      if (text) deliver(sid, text, text === stop ? false : join, edges, heardText);
      // A stretch with words but nothing written ("Tailzu," on its own, an
      // instruction): nothing to paste, but where the rest goes may turn on it.
      else if (isSegment && heardWords) emitSegment(sid, "", undefined, undefined, heardText);
      else if (!isSegment) {
        // Nothing to write at the end. After stretches that were written,
        // or when words were heard and the writer chose to write none,
        // that is just the end. Otherwise nothing was heard at all (wrong
        // input device, muted mic, or OS permission): say so — but only
        // for a real stop. A silent segment is just a pause, and a toast
        // for every pause would be unusable.
        if (sentAny || heardWords) emitResult(sid, "", undefined, undefined, heardText);
        else emitError(sid, str("noSpeech"));
      }
    };
  } catch (err) {
    // A failed SEGMENT must not end the session: the mic is still open
    // and they are probably still talking. Tell them, keep going.
    if (isSegment) return () => window.tailzu.segment({ session: sid, text: "", failed: true });
    return () => emitError(sid, K.txt("desktop.recorder.uploadFailed", "Couldn't send your recording. Check your connection and try again."),
      { detail: errText(err) });
  } finally {
    clearTimeout(timer);
  }
}

// ======================= LIVE =======================
function wsUrl() { return base().replace(/^http/, "ws") + "/v1/transcribe-stream"; }
function previewText() { return (finals.join(" ") + " " + lastPartial).trim(); }

async function startLive(sid) {
  // A stale watchdog from the PREVIOUS live session must never fire into
  // this one (it used to finishLive() the new session prematurely).
  clearTimeout(wsWatchdog);
  live = true;
  finals = [];
  lastPartial = "";
  doneAlternative = "";
  try {
    const mic = await getMic();
    if (sid !== session || sid === stopped) { mic.getTracks().forEach((t) => t.stop()); return; } // as in startBatch
    stream = mic;
    startBands(sid, stream);
    // Measured only (no pause-writing here), for the stop's decision.
    watchLevel(sid, false);
    // LIVE IS FOR SEEING, NOT FOR WRITING.
    //
    // The pasted text used to be built from the stream's finals — a
    // quicker, rougher reading than the whole clip gets, which a second
    // engine could interleave and double — and then refined as bare text.
    // Words were misheard, sentences came twice, and instructions stayed
    // in. Now the whole recording is kept beside the stream and, when the
    // person stops, goes through /v1/transcribe-clean: the same recogniser
    // fusion, instruction split and writing as every other dictation. The
    // captions still move as they talk; they just are not what is sent.
    // Its own array, so a quick next press cannot empty it under a stop.
    const mine = [];
    liveChunks = mine;
    liveAt = Date.now();
    try {
      const mimeType = pickMime();
      liveRec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      liveRec.ondataavailable = (e) => { if (e.data && e.data.size) mine.push(e.data); };
      liveRec.start();
    } catch { liveRec = null; }   // no recorder: the stream's text is the fallback
    const sock = ws = new WebSocket(wsUrl());
    const start = wsStart = { sock, sent: false, held: [], stop: false };
    ws.binaryType = "arraybuffer";
    // Browser WebSocket can't set an Authorization header; the protocol
    // carries the token in the start message (the server accepts both).
    //
    // THE TOKEN IS ASKED FOR AGAIN AS IT OPENS. A question starts with the
    // one in hand, with no time to renew it first, and one spent while the
    // laptop slept was refused here without a word: the question lost its
    // live words, its instant answer and its stream text. Renewed only when
    // it is spent. The audio said meanwhile is held, since the server takes
    // none before the start, and goes right after it.
    ws.onopen = async () => {
      const token = await freshToken(false);
      if (sid !== session || ws !== sock) return;
      try {
        sock.send(JSON.stringify({
          type: "start", token, targetApp: targetFor(sid),
          language: cfg.language || "auto",
          sampleRate: 16000, encoding: "pcm_s16le", channels: 1,
          // A question is metered as Ask is, not as words written.
          ...(asks.has(sid) ? { purpose: "ask" } : {}),
        }));
        start.sent = true;
        for (const frame of start.held.splice(0)) sock.send(frame);
        if (start.stop) sock.send(JSON.stringify({ type: "stop" }));
      } catch { /* closed meanwhile: onclose finishes it */ }
    };
    ws.onmessage = (ev) => {
      if (sid !== session) return; // message for a dead session
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === "partial") {
        lastPartial = m.text || "";
        emitPartial(sid, previewText());
      } else if (m.type === "final") {
        if (m.text && m.text.trim()) finals.push(m.text.trim());
        lastPartial = "";
        emitPartial(sid, previewText());
      } else if (m.type === "done") {
        doneAlternative = typeof m.alternative === "string" ? m.alternative.trim() : "";
        finishLive(sid);
      } else if (m.type === "error") {
        // Captions lost while the recording carries on: nothing to tell
        // them, the words are still being kept.
        if (liveRec && liveRec.state === "recording") { dropStream(); return; }
        // A question already stopped has its clip on the way: the stream's
        // failure only means its final text is what it had.
        if (asks.has(sid) && stopped === sid) { finishLive(sid); return; }
        // The server's sentence — except the sign-in refusal, which it
        // keeps in the keyboards' old wording ("invalid or missing
        // token") because they match on it. That one is said here.
        emitError(sid, m.code === "unauthorized"
          ? K.txt("error.unauthorized", "Your session has expired. Sign in again to continue.")
          : (m.message || K.txt("desktop.recorder.streamError", "Voice stopped working. Try again.")),
        { code: m.code, detail: m.message });
        teardownLive();
      }
    };
    ws.onclose = () => { if (sid === session && live) finishLive(sid); };
    ws.onerror = () => { /* onclose follows and routes to finishLive */ };

    // WebAudio capture → linear-interp downsample → 16 kHz s16le frames.
    // ScriptProcessor is deprecated but universally supported in Electron
    // and by far the simplest way to tap PCM.
    audioCtx = new AudioContext();
    srcNode = audioCtx.createMediaStreamSource(stream);
    proc = audioCtx.createScriptProcessor(4096, 1, 1);
    srcNode.connect(proc);
    proc.connect(audioCtx.destination);
    const inRate = audioCtx.sampleRate;
    proc.onaudioprocess = (e) => {
      if (sid !== session || !ws || ws.readyState !== 1) return;
      const frame = downsampleTo16k(e.inputBuffer.getChannelData(0), inRate);
      if (start.sent) ws.send(frame);
      // Held for the start, a few seconds at most: a token that takes longer
      // than that is a stream that will not start.
      else if (start.held.length < 64) start.held.push(frame);
    };
  } catch (err) {
    emitError(sid, micMessage(err), { detail: errText(err) });
    teardownLive();
  }
}

function downsampleTo16k(f32, inRate) {
  const ratio = inRate / 16000;
  const outLen = Math.floor(f32.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, f32.length - 1);
    const frac = idx - i0;
    let s = f32[i0] * (1 - frac) + f32[i1] * frac;
    s = Math.max(-1, Math.min(1, s));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out.buffer;
}

function teardownLiveGraph() {
  try { proc && proc.disconnect(); } catch {}
  try { srcNode && srcNode.disconnect(); } catch {}
  try { audioCtx && audioCtx.close(); } catch {}
  proc = srcNode = audioCtx = null;
}

function stopLive(sid) {
  // Whether the recording holds a voice at all, before the meter closes.
  const heard = lastStretchHeard(sid);
  stopWatchingLevel();
  const ask = asks.has(sid);
  if (ask && !heard) askSilent = sid;
  // A question's words so far, as of the stop; read again when its clip is
  // ready, unless a newer session has the stream's text by then.
  const saidAtStop = previewText();
  const said = () => (!heard ? "" : sid === session ? previewText() : saidAtStop);
  // The recording first, so its last words are in before the mic closes.
  if (liveRec && liveRec.state !== "inactive") {
    const rec = liveRec, parts = liveChunks, took = Date.now() - liveAt;
    // Let go of it now: a next press arriving before it has finished
    // stopping used to tear it down with the rest, and its words were lost.
    liveRec = null;
    rec.onstop = () => {
      const type = rec.mimeType || "audio/webm";
      if (ask) { void handOver(sid, heard ? parts.slice() : [], type, took, said()); return; }
      if (heard) void uploadBatch(sid, parts.slice(), type, false, took, false);
      else void nothingToSend(sid, false);
    };
    try { rec.stop(); recordedSession = sid; } catch {
      // Nothing recorded: the stream's text is the fallback. A question's
      // onstop will not come, so it goes now with the words alone, rather
      // than after the main process has given up waiting for its clip.
      if (ask) void handOver(sid, [], rec.mimeType || "audio/webm", took, said());
    }
  } else if (ask) {
    // No recording beside the stream (the microphone was not open yet, or
    // no recorder would start): the stream's words are all the question
    // there is, and none at all is one nobody heard.
    void handOver(sid, [], "audio/webm", Date.now() - liveAt, said());
  }
  teardownLiveGraph();
  stopTracks();
  // A question whose stream has already gone (it dropped, or never opened)
  // will hear no more: its final text is what it had, now, rather than
  // after the watchdog.
  if (ask && !ws) { finishLive(sid); return; }
  // A stream still waiting for its token is stopped right after it starts:
  // a stop before the start ended nothing, and the start after it began a
  // stream that waited for the watchdog.
  try {
    if (ws && wsStart && wsStart.sock === ws && !wsStart.sent) wsStart.stop = true;
    else if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "stop" }));
  } catch {}
  // If "done" never arrives (server hiccup), finish with what we have —
  // but only for THIS session (checked inside finishLive).
  wsWatchdog = setTimeout(() => { if (sid === session && live) finishLive(sid); },
    K.num("desktop.recorder.liveTailMs", 4000));
}

function teardownLive() {
  live = false;
  clearTimeout(wsWatchdog);
  stopBands();
  stopWatchingLevel();
  teardownLiveGraph();
  stopTracks();
  if (ws) {
    // Detach handlers BEFORE closing so the old socket's close event can
    // never call finishLive against a newer session.
    ws.onclose = ws.onmessage = ws.onerror = ws.onopen = null;
    try { ws.close(); } catch {}
    ws = null;
  }
}

/** Close the caption stream alone, leaving the microphone and the
 *  recording running. */
function dropStream() {
  if (!ws) return;
  ws.onclose = ws.onmessage = ws.onerror = ws.onopen = null;
  try { ws.close(); } catch {}
  ws = null;
}

async function finishLive(sid) {
  if (sid !== session || !live) return;
  // The stream ended before they did: the captions stop, the recording
  // goes on, and stopping still writes it.
  if (liveRec && liveRec.state === "recording") { dropStream(); return; }
  const raw = previewText();
  // A question: nothing is written or refined. The stream's last word on
  // what was said goes to the main process, which may be waiting for it.
  if (asks.has(sid)) {
    teardownLive();
    // Over before they stopped, with no recording beside it: what the
    // stream heard is the whole question.
    if (stopped !== sid) void handOver(sid, [], "audio/webm", Date.now() - liveAt, raw);
    askFinal(sid, raw);
    return;
  }
  // The recording is being written (stopLive → uploadBatch): the stream
  // only had to draw the captions, and it has.
  const recorded = recordedSession === sid || liveChunks.length > 0;
  teardownLive();
  if (recorded) return;
  if (!raw) {
    // The same sentence the batch path uses, server-drawn like it.
    emitError(sid, str("noSpeech"));
    return;
  }
  // Same shape as mobile: stream gives the transcript, refine writes it in
  // the account's voice.
  try {
    // An empty answer is the server saying there is nothing to write —
    // noise the recogniser turned into words. Pasting the raw words
    // instead was how they reached the field. The field read is waited for
    // first (see fieldRead), so what it found before the cursor is the
    // context; the second reading is taken before, as a press during the
    // wait starts a new stream and clears it.
    const alternative = doneAlternative;
    await fieldRead(sid);
    const refined = await refineText(raw, alternative, wrote.get(sid), sid);
    emitResult(sid, refined.text, refined.join, refined.edges, raw);
  } catch (err) {
    // NOT THE RAW WORDS. A refine that failed (twice for a blip; a spent
    // token is renewed and resent first) used to paste the stream's own
    // reading, and in 0.2.1 a token that expired after an hour made every
    // refine fail, so live dictation pasted raw transcripts. A failure is
    // said as one, in the server's words when it refused.
    emitError(sid, (err && err.words) || K.txt("desktop.recorder.uploadFailed", "Couldn't send your recording. Check your connection and try again."),
      { code: err && err.code, detail: errText(err) });
  }
}
