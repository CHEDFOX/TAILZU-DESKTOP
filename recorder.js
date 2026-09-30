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
let mediaRecorder = null;
let chunks = [];

// ---- live state ----
let ws = null;
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
let liveRec = null, liveChunks = [], recordedSession = 0;
// What this session has already written, pause by pause. Each stretch
// after the first is sent with it as context, so it is written as the
// continuation it is rather than as a new message: no capital after a
// comma, no repeated greeting.
let written = "";

window.tailzu.onStart((c) => {
  cfg = c;
  session = c.session || 0;
  // The knobs as of this press, from the main process's bootstrap.
  if (c.knobs) K.setKnobs(c.knobs);
  // Defensive teardown: if a previous session is somehow still capturing
  // (state desync upstream), kill it completely before starting fresh —
  // never let two captures share the mic or a chunks array.
  forceTeardownAll();
  written = "";
  cfg.live ? startLive(session) : startBatch(session);
});
window.tailzu.onStop((p) => {
  // Only stop the session main thinks is active; a stale stop is a no-op.
  if (p && p.session && p.session !== session) return;
  stopped = session;
  stopBands();
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
    bandTimer = setInterval(() => {
      if (sid !== session) return;
      an.getByteFrequencyData(bins);
      const out = [];
      for (let b = 0; b < N; b++) {
        let m = 0; const a = edges[b], z = Math.max(a + 1, edges[b + 1]);
        for (let i = a; i < z && i < bins.length; i++) m = Math.max(m, bins[i]);
        out.push(Math.max(0, Math.min(1, (m - floor) / span)));
      }
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
//   flushSilenceMs  long enough to be a breath, not a gap
//   minSegmentMs    never flush a cough
//   idleEndMs       walked away: close the mic ourselves
//   speechLevel     RMS floor; room tone sits well under
//   meterPollMs     how often the level is read

let levelCtx = null, levelTimer = null, analyser = null;
let speaking = false, lastSpeechAt = 0, segmentStartedAt = 0, flushing = false;
// How long this stretch was actually above the room. A cough or a
// breath trips `speaking` for a poll or two, and flushed on its own it
// came back from the recogniser as "Thank you." or "Okay." and was
// pasted. A stretch with less than a word's worth of sound is kept and
// joined to what is said next.
let speechMs = 0;

function watchLevel(sid) {
  const FLUSH_SILENCE_MS = K.num("desktop.recorder.flushSilenceMs", 1200);
  const MIN_SEGMENT_MS = K.num("desktop.recorder.minSegmentMs", 700);
  const IDLE_END_MS = K.num("desktop.recorder.idleEndMs", 25000);
  const SPEECH_LEVEL = K.num("desktop.recorder.speechLevel", 0.012);
  const MIN_SPEECH_MS = K.num("desktop.recorder.minSpeechMs", 400);
  const POLL_MS = K.num("desktop.recorder.meterPollMs", 120);
  try {
    levelCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = levelCtx.createMediaStreamSource(stream);
    analyser = levelCtx.createAnalyser();
    analyser.fftSize = K.num("desktop.recorder.fftSize", 512);
    src.connect(analyser);
  } catch { return; }   // no meter is survivable: it just never flushes
  const buf = new Float32Array(analyser.fftSize);
  segmentStartedAt = lastSpeechAt = Date.now();
  levelTimer = setInterval(() => {
    if (sid !== session || !analyser) return;
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    const now = Date.now();
    if (rms > SPEECH_LEVEL) { speaking = true; lastSpeechAt = now; speechMs += POLL_MS; return; }
    const quietFor = now - lastSpeechAt;
    // Flush only if they actually said something since the last one.
    if (speaking && quietFor > FLUSH_SILENCE_MS
        && now - segmentStartedAt > MIN_SEGMENT_MS) {
      speaking = false;
      if (speechMs < MIN_SPEECH_MS) return;   // a breath: keep it with the next words
      speechMs = 0;
      flushSegment(sid);
    } else if (!speaking && quietFor > IDLE_END_MS) {
      window.tailzu.idle({ session: sid });
    }
  }, POLL_MS);
}

function stopWatchingLevel() {
  if (levelTimer) { clearInterval(levelTimer); levelTimer = null; }
  if (levelCtx) { try { levelCtx.close(); } catch {} levelCtx = null; }
  analyser = null;
  speaking = false;
  speechMs = 0;
}

/** End this segment and start the next one on the SAME microphone. The
 *  stream is never touched, so there is no permission blink, no device
 *  re-acquire, and no gap where speech would be lost. */
function flushSegment(sid) {
  if (!mediaRecorder || mediaRecorder.state === "inactive") return;
  flushing = true;
  try { mediaRecorder.stop(); } catch { flushing = false; }
}

function emitSegment(sid, text) { window.tailzu.segment({ session: sid, text: text }); }
function emitResult(sid, text) { window.tailzu.result({ session: sid, text: text }); }
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
function auth() { return cfg.token ? { Authorization: "Bearer " + cfg.token } : {}; }
function stopTracks() {
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
}
function forceTeardownAll() {
  stopBands();
  try {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.ondataavailable = null;
      mediaRecorder.onstop = null;
      mediaRecorder.stop();
    }
  } catch {}
  mediaRecorder = null;
  chunks = [];
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

// ---- Per-tone refine routing (mirrors the mobile app/src/api.ts) -------
async function refineText(text, alternative) {
  const tone = (cfg.tone || "none").toLowerCase();
  const llmTones = K.list("desktop.recorder.llmTones", ["formal", "casual", "very-casual", "excited"]);
  const p = tone === "none" ? "/v1/refine/none"
    : llmTones.includes(tone) ? "/v1/refine/" + tone
    : "/v1/refine";
  const body = { text, targetApp: "Desktop", language: cfg.language || "auto" };
  // The second engine's reading goes with it: the server reconciles the
  // two and decides which leads. Dropped here, the work was wasted.
  if (alternative) body.alternative = alternative;
  // ONE RETRY. A refine that fails pastes the raw transcript, and the
  // raw transcript still holds everything that was said TO the keyboard
  // ("…write this in Japanese"). A blip is worth a second try first.
  let last = null;
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(base() + p, {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, auth()),
        body: JSON.stringify(body),
      });
      // Refused (no words left, signed out): a retry gets the same answer.
      if (res.status >= 400 && res.status < 500) throw Object.assign(new Error("refine HTTP " + res.status), { final: true });
      if (!res.ok) throw new Error("refine HTTP " + res.status);
      const j = await res.json();
      return (j.refinedText || "").trim();
    } catch (err) {
      last = err;
      if (err && err.final) break;
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

async function startBatch(sid) {
  try {
    stream = await getMic();
    // Superseded, or already stopped, while awaiting the mic — which on
    // a first run waits on the OS asking the person for permission.
    if (sid !== session || sid === stopped) { stopTracks(); return; }
    chunks = [];
    const mimeType = pickMime();
    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    mediaRecorder.onstop = () => onRecorderStopped(sid, mimeType);
    mediaRecorder.start();
    if (cfg.pauseFlush !== false) watchLevel(sid);
    startBands(sid, stream);
  } catch (err) {
    stopTracks();
    emitError(sid, micMessage(err), { detail: errText(err) });
  }
}

/** A recorder stopped. Which kind of stop it was decides everything:
 *  a flush hands off to a fresh recorder on the same mic, a real stop
 *  closes the microphone. Confusing the two either leaves the mic hot
 *  forever or ends the session on the first pause. */
function onRecorderStopped(sid, mimeType) {
  const wasFlush = flushing;
  flushing = false;
  const type = (mediaRecorder && mediaRecorder.mimeType) || "audio/webm";
  const segment = chunks.slice();
  chunks = [];

  if (wasFlush && sid === session && stream) {
    // Next segment first, so the microphone is live again before the
    // upload starts. Anything said during the round trip is captured.
    try {
      mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      mediaRecorder.onstop = () => onRecorderStopped(sid, mimeType);
      mediaRecorder.start();
      segmentStartedAt = Date.now();
    } catch (err) {
      stopTracks(); stopWatchingLevel();
      emitError(sid, K.txt("desktop.recorder.continueFailed", "Recording stopped unexpectedly. Try again."),
        { detail: errText(err) });
      return;
    }
    void uploadBatch(sid, segment, type, true);
    return;
  }

  stopWatchingLevel();
  stopTracks();
  void uploadBatch(sid, segment, type, false);
}

function stopBatch(sid) {
  try {
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
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

async function uploadBatch(sid, parts, type, isSegment) {
  try {
    if (!parts || !parts.length) {
      // A flush with nothing in it is ordinary — they paused twice, or
      // the segment was all room tone. Only a FINAL stop with no audio
      // is worth telling anyone about.
      if (!isSegment) emitError(sid, K.txt("desktop.mic.noAudio", "no audio captured"));
      return;
    }
    const ext = type.includes("ogg") ? "ogg" : "webm";
    const blob = new Blob(parts, { type });
    const fd = new FormData();
    fd.append("audio", blob, "audio." + ext);
    fd.append("targetApp", "Desktop");
    fd.append("language", cfg.language || "auto");
    // Explicit tone override — same field the mobile keyboard sends.
    fd.append("tone", cfg.tone || "none");
    // What this session already wrote, so this stretch continues it.
    if (written) fd.append("context", written.slice(-K.num("desktop.recorder.contextChars", 600)));
    const res = await fetch(base() + "/v1/transcribe-clean", {
      method: "POST",
      headers: auth(),
      body: fd,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      emitError(sid, httpMessage(res.status, body), {
        // The main process asks for a fresh bootstrap on this, so the
        // next press is refused before the mic opens.
        code: body.indexOf("quota_exceeded") !== -1 ? "quota_exceeded" : undefined,
        detail: "HTTP " + res.status + (body ? " " + body.slice(0, K.num("desktop.recorder.errorBodyChars", 120)) : ""),
      });
      return;
    }
    const json = await res.json();
    const cleaned = (json.cleanedText || "").trim();
    const transcript = (json.transcript || json.text || "").trim();
    // A segment pastes and leaves the session running; a final result
    // pastes and ends it. Same text, different meaning to the main
    // process, and it must not learn the difference by guessing.
    const deliver = isSegment ? emitSegment : emitResult;
    if (cleaned && sid === session) written = (written + " " + cleaned).trim();
    if (cleaned) {
      deliver(sid, cleaned);
    } else if (transcript) {
      // Cleanup returned nothing but STT heard real words — paste the raw
      // transcript rather than silently pasting nothing.
      deliver(sid, transcript);
    } else if (!isSegment) {
      // Both empty: the mic captured silence (wrong input device, muted
      // mic, or OS permission). Say so instead of a no-op — but only for
      // a real stop. A silent segment is just a pause, and a toast for
      // every pause would be unusable.
      emitError(sid, str("noSpeech"));
    }
  } catch (err) {
    // A failed SEGMENT must not end the session: the mic is still open
    // and they are probably still talking. Tell them, keep going.
    if (isSegment) { window.tailzu.segment({ session: sid, text: "", failed: true }); return; }
    emitError(sid, K.txt("desktop.recorder.uploadFailed", "Couldn't send your recording. Check your connection and try again."),
      { detail: errText(err) });
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
    stream = await getMic();
    if (sid !== session || sid === stopped) { stopTracks(); return; } // as in startBatch
    startBands(sid, stream);
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
    liveChunks = [];
    try {
      const mimeType = pickMime();
      liveRec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      liveRec.ondataavailable = (e) => { if (e.data && e.data.size) liveChunks.push(e.data); };
      liveRec.start();
    } catch { liveRec = null; }   // no recorder: the stream's text is the fallback
    ws = new WebSocket(wsUrl());
    ws.binaryType = "arraybuffer";
    // Browser WebSocket can't set an Authorization header; the protocol
    // carries the token in the start message (the server accepts both).
    ws.onopen = () => { if (sid === session && ws) ws.send(JSON.stringify({
      type: "start", token: cfg.token, targetApp: "Desktop",
      language: cfg.language || "auto",
      sampleRate: 16000, encoding: "pcm_s16le", channels: 1,
    })); };
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
      ws.send(downsampleTo16k(e.inputBuffer.getChannelData(0), inRate));
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
  // The recording first, so its last words are in before the mic closes.
  if (liveRec && liveRec.state !== "inactive") {
    const rec = liveRec;
    rec.onstop = () => {
      const parts = liveChunks.slice(); liveChunks = [];
      const type = rec.mimeType || "audio/webm";
      if (liveRec === rec) liveRec = null;
      void uploadBatch(sid, parts, type, false);
    };
    try { rec.stop(); recordedSession = sid; } catch { liveRec = null; }
  }
  teardownLiveGraph();
  stopTracks();
  try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "stop" })); } catch {}
  // If "done" never arrives (server hiccup), finish with what we have —
  // but only for THIS session (checked inside finishLive).
  wsWatchdog = setTimeout(() => { if (sid === session && live) finishLive(sid); },
    K.num("desktop.recorder.liveTailMs", 4000));
}

function teardownLive() {
  live = false;
  clearTimeout(wsWatchdog);
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
  // Same shape as mobile: stream gives the transcript, refine polishes it
  // with the active tone. If refine hiccups, the raw words still paste.
  try {
    // An empty answer is the server saying there is nothing to write —
    // noise the recogniser turned into words. Pasting the raw words
    // instead was how they reached the field.
    emitResult(sid, await refineText(raw, doneAlternative));
  } catch {
    // Unreachable twice over: their words are not lost, but they go as
    // they were heard.
    emitResult(sid, raw);
  }
}
