// The live path: WebAudio, 16 kHz PCM frames, WS /v1/transcribe-stream for
// the captions; on stop the recording goes through /v1/transcribe-clean like
// a batch one.

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
