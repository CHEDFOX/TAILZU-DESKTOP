// Pause-flush.
//
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
