// The batch path: MediaRecorder, webm, POST /v1/transcribe-clean, a stretch
// at a time.

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
