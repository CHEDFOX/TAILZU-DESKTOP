/**
 * THE NOTE-TAKER'S EARS — a hidden window, like the dictation recorder, that
 * listens while a note is being taken and never types anything anywhere.
 *
 * Two tracks, never mixed: the microphone (you, and anyone in the room with
 * you) and the computer's own sound (everyone on a call). Where a voice came
 * from is the one thing about a meeting no model can get wrong, so the server
 * is told it rather than left to guess (tulmi/src/notes/speakers.ts).
 *
 * Each track is recorded twice at once:
 *   - in stretches (desktop.notes.chunkMs), each uploaded as it ends, so the
 *     note is built while it runs and a crash loses one stretch at most. A
 *     stretch nobody spoke in is not sent: nothing to pay for, and nothing for
 *     a recogniser to invent words from.
 *   - whole, small (desktop.notes.trackBitrate), uploaded once at the end so
 *     the server can tell the speakers apart across the whole meeting.
 *
 * The computer's sound comes in one of three ways, chosen by the main process:
 *   "desktop" (Windows) — Chromium's desktop capture with loopback audio;
 *   "monitor" (Linux)   — the sound server's monitor of the output device;
 *   "pcm"     (macOS)   — 16 kHz PCM from the audiotap helper, played into a
 *                         stream here so it is recorded like the others.
 */
(function () {
  "use strict";
  const K = window.TailzuKnobs;
  const N = window.TailzuNotes;
  const bridge = window.tailzuNotes;

  let note = null;          // { id, base, ... } while a note runs
  let queue = null;
  const tracks = {};        // mic | system → track state
  let ctx = null;           // one AudioContext for metering (and the PCM feed)
  let pcm = null;           // macOS: { ctx, dest, playAt }
  let tick = null, poll = null;
  let stopping = false;
  // Whether the computer's sound was heard: "ok", "unavailable" (this
  // computer gave none), or "denied" (macOS refused; the main process says).
  let systemAudio = "ok";

  const base = () => (note && note.base ? note.base.replace(/\/+$/, "") : "");

  async function authed(send) {
    let token = await bridge.token(false);
    let res = await send(token ? { Authorization: "Bearer " + token } : {});
    if (res.status === 401) {
      token = await bridge.token(true);
      res = await send(token ? { Authorization: "Bearer " + token } : {});
    }
    return res;
  }

  function mimeType() {
    const list = K.list("desktop.notes.mimeTypes", ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]);
    for (const m of list) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
    return "";
  }

  // ---- the tracks -------------------------------------------------------------

  async function micStream() {
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  }

  async function systemStream(cfg) {
    if (cfg.system === "desktop") {
      // Video has to be asked for to get the audio; it is dropped at once.
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: "desktop" } },
        video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: cfg.sourceId, maxWidth: 8, maxHeight: 8, maxFrameRate: 1 } },
      });
      s.getVideoTracks().forEach((t) => { t.stop(); s.removeTrack(t); });
      return s.getAudioTracks().length ? s : null;
    }
    if (cfg.system === "monitor") {
      const want = new RegExp(K.str("desktop.notes.monitorPattern", "monitor"), "i");
      const dev = (await navigator.mediaDevices.enumerateDevices())
        .find((d) => d.kind === "audioinput" && want.test(d.label || ""));
      if (!dev) return null;
      return navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: dev.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    }
    if (cfg.system === "pcm") {
      const c = new AudioContext({ sampleRate: 16000 });
      const dest = c.createMediaStreamDestination();
      pcm = { ctx: c, dest, playAt: 0 };
      return dest.stream;
    }
    return null;
  }

  /** macOS: a packet of 16-bit PCM from the helper, played into the stream. */
  function feedPcm(bytes) {
    if (!pcm || !bytes || bytes.byteLength < 2) return;
    const view = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    const f = new Float32Array(view.length);
    for (let i = 0; i < view.length; i++) f[i] = view[i] / 32768;
    const b = pcm.ctx.createBuffer(1, f.length, 16000);
    b.copyToChannel(f, 0);
    const src = pcm.ctx.createBufferSource();
    src.buffer = b;
    src.connect(pcm.dest);
    const now = pcm.ctx.currentTime;
    // A late packet starts a little ahead rather than in the past; a burst
    // plays back to back.
    if (pcm.playAt < now) pcm.playAt = now + 0.05;
    src.start(pcm.playAt);
    pcm.playAt += b.duration;
  }

  function startTrack(name, stream, cfg) {
    const t = { name, stream, chunk: null, chunkParts: [], chunkAt: 0, voicedMs: 0, heardAnything: false, whole: null, wholeParts: [], wholeBytes: 0, wholeAt: 0 };
    // The meter: voiced time in the current stretch.
    try {
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 8192;
      src.connect(an);
      t.analyser = an;
      t.buf = new Float32Array(an.fftSize);
      t.readTo = ctx.currentTime;
      t.meter = window.TailzuSpeech.createSpeechMeter({
        sampleRate: ctx.sampleRate,
        level: name === "mic" ? K.num("desktop.notes.micSpeechLevel", 0.006) : K.num("desktop.notes.systemSpeechLevel", 0.004),
        voicing: K.num("desktop.recorder.voicing", 0.5),
      });
    } catch { /* no meter: every stretch is sent, the server's gate decides */ }
    const type = mimeType();
    t.type = type || "audio/webm";
    t.whole = new MediaRecorder(stream, Object.assign({ audioBitsPerSecond: cfg.trackBitrate }, type ? { mimeType: type } : {}));
    t.whole.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      t.wholeBytes += e.data.size;
      if (t.wholeBytes <= cfg.maxTrackBytes) t.wholeParts.push(e.data);
      else t.wholeParts = null;            // too long to send whole: the live labels stand
    };
    t.wholeAt = (performance.now() - note.t0) / 1000;
    t.whole.start(10000);
    newChunk(t);
    tracks[name] = t;
  }

  function newChunk(t) {
    const type = mimeType();
    const rec = new MediaRecorder(t.stream, type ? { mimeType: type } : undefined);
    const parts = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
    t.chunk = rec;
    t.chunkParts = parts;
    t.chunkAt = (performance.now() - note.t0) / 1000;
    t.voicedMs = 0;
    rec.start();
  }

  /** End the current stretch of a track; upload it if anyone spoke in it. */
  function endChunk(t, restart) {
    const rec = t.chunk, parts = t.chunkParts, at = t.chunkAt, voiced = t.voicedMs, metered = !!t.meter;
    const ended = new Promise((resolve) => {
      if (!rec || rec.state === "inactive") { resolve(); return; }
      rec.onstop = () => resolve();
      try { rec.stop(); } catch { resolve(); }
    });
    if (restart) newChunk(t);
    return ended.then(() => {
      if (!parts.length) return;
      if (metered && !N.worthSending(voiced, K.num("desktop.notes.minVoicedMs", 400))) return;
      t.heardAnything = true;
      const blob = new Blob(parts, { type: t.type });
      return queue.push({ kind: "audio", track: t.name, at, blob });
    });
  }

  function readMeters() {
    for (const t of Object.values(tracks)) {
      if (!t.analyser || !t.meter) continue;
      const now = ctx.currentTime, fresh = Math.min(t.buf.length, Math.round((now - t.readTo) * ctx.sampleRate));
      t.readTo = now;
      if (fresh <= 0) continue;
      t.analyser.getFloatTimeDomainData(t.buf);
      t.voicedMs += t.meter.feed(t.buf.subarray(t.buf.length - fresh)).voicedMs;
    }
  }

  // ---- uploads ------------------------------------------------------------------

  function send(job) {
    const fd = new FormData();
    fd.append("track", job.track);
    fd.append("at", String(Math.round(job.at * 10) / 10));
    if (job.kind === "audio" && note.language) fd.append("language", note.language);
    const ext = job.blob.type.indexOf("ogg") !== -1 ? "ogg" : "webm";
    fd.append("audio", job.blob, "audio." + ext);
    const path = "/v1/notes/" + encodeURIComponent(note.id) + (job.kind === "audio" ? "/audio" : "/track");
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), job.kind === "audio" ? K.num("desktop.notes.uploadTimeoutMs", 90000) : K.num("desktop.notes.trackTimeoutMs", 600000));
    return authed((h) => fetch(base() + path, { method: "POST", headers: h, body: fd, signal: ctl.signal }))
      .then(async (res) => ({ status: res.status, body: res.ok ? "" : await res.text().catch(() => "") }))
      .finally(() => clearTimeout(timer));
  }

  // ---- start and stop --------------------------------------------------------------

  async function start(cfg) {
    if (note) return;
    if (cfg.knobs) K.setKnobs(cfg.knobs);
    systemAudio = cfg.systemAudio === "denied" ? "denied" : "ok";
    stopping = false;
    note = { id: cfg.id, base: cfg.baseUrl, language: cfg.language && cfg.language !== "auto" ? cfg.language : "", t0: performance.now() };
    queue = N.createQueue({
      send,
      renew: () => bridge.token(true),
      tries: K.num("desktop.notes.uploadTries", 5),
      backoffMs: K.num("desktop.notes.retryMs", 1500),
      onFatal: (kind) => {
        // Out of words, signed out, or the note gone: stop listening, keep
        // what was heard, and say why.
        bridge.status({ state: "fatal", reason: kind });
        void stop();
      },
    });
    const opts = {
      trackBitrate: K.num("desktop.notes.trackBitrate", 24000),
      // 45 MB: the server takes 50 MB a file. About four hours at 24 kbit/s.
      maxTrackBytes: K.num("desktop.notes.maxTrackBytes", 47185920),
    };
    try {
      ctx = new AudioContext();
      startTrack("mic", await micStream(), opts);
    } catch (e) {
      bridge.status({ state: "failed", reason: "mic", detail: String(e && e.message || e) });
      note = null;
      return;
    }
    let sys = null;
    try { sys = await systemStream(cfg); } catch (e) { sys = null; }
    // A refusal that came in meanwhile stands.
    if (systemAudio !== "denied") systemAudio = sys ? "ok" : "unavailable";
    if (sys) startTrack("system", sys, opts);
    bridge.status({ state: "recording", system: !!sys });

    const chunkMs = Math.max(5000, K.num("desktop.notes.chunkMs", 30000));
    poll = setInterval(readMeters, K.num("desktop.notes.meterPollMs", 150));
    tick = setInterval(() => {
      if (stopping) return;
      for (const t of Object.values(tracks)) void endChunk(t, true);
    }, chunkMs);
  }

  async function stop() {
    if (!note || stopping) return;
    stopping = true;
    clearInterval(tick);
    clearInterval(poll);
    readMeters();
    const id = note.id;
    const duration = (performance.now() - note.t0) / 1000;
    bridge.status({ state: "saving" });
    // The last stretches, then the whole tracks.
    await Promise.all(Object.values(tracks).map((t) => endChunk(t, false)));
    const wholes = await Promise.all(Object.values(tracks).map((t) => new Promise((resolve) => {
      if (!t.whole || t.whole.state === "inactive") { resolve(null); return; }
      t.whole.onstop = () => resolve(t);
      try { t.whole.stop(); } catch { resolve(null); }
    })));
    for (const t of Object.values(tracks)) t.stream.getTracks().forEach((x) => x.stop());
    await queue.drain();
    if (!queue.dead) {
      for (const t of wholes) {
        if (!t || !t.wholeParts || !t.wholeParts.length || !t.heardAnything) continue;
        await queue.push({ kind: "track", track: t.name, at: t.wholeAt, blob: new Blob(t.wholeParts, { type: t.type }) });
      }
    }
    // Finish even after a fatal answer: what was heard is kept and organised.
    let finished = false;
    try {
      const res = await authed((h) => fetch(base() + "/v1/notes/" + encodeURIComponent(id) + "/finish", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, h),
        body: JSON.stringify({ durationSeconds: Math.round(duration), systemAudio }),
      }));
      finished = res.ok;
    } catch { finished = false; }
    for (const k of Object.keys(tracks)) delete tracks[k];
    try { ctx && ctx.close(); } catch { /* closing */ }
    try { pcm && pcm.ctx.close(); } catch { /* closing */ }
    ctx = null; pcm = null; note = null; queue = null;
    bridge.done({ id, finished, durationSeconds: Math.round(duration) });
  }

  bridge.onStart((cfg) => { void start(cfg); });
  bridge.onStop(() => { void stop(); });
  bridge.onPcm((bytes) => feedPcm(bytes));
  bridge.onSystem((p) => { if (note && p && p.systemAudio === "denied") systemAudio = "denied"; });
})();
