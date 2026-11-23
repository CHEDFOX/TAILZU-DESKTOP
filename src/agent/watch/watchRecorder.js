/**
 * ASK'S CLIP, RECORDED: the hidden window (watch.html) that records a few
 * seconds of the window in front while a video plays in it, for a question
 * about what happens in it. The main process (clipper.js) finds the window's
 * capture source and says how long, how big and how fast; this records it
 * and hands the file back. It never sends anything anywhere itself.
 *
 * Two streams, joined into one recording:
 *   - the window's pictures: Chromium's desktop capture of that one source,
 *     no bigger than maxSide a side and no faster than fps;
 *   - the computer's own sound, heard the way the note-taker hears it
 *     (notes/notesRecorder.js), when the main process says how: "desktop"
 *     (Windows loopback), "monitor" (Linux's output monitor, by name) or
 *     "pcm" (macOS, the audiotap helper's samples played into a stream).
 *
 * NEVER THE MICROPHONE. Nothing here asks for an ordinary audio input: the
 * loopback is a desktop source, the monitor is used only when a device of
 * that name is there (no such device, no sound, not the default input), and
 * the PCM is the computer's output. No sound at all is a clip of frames
 * only, and is said so (`sound: false`).
 *
 * Past maxBytes it stops where it is and keeps nothing: the run sends the
 * still picture instead.
 */
(function () {
  "use strict";
  const bridge = window.tailzuWatch;
  let current = null;   // the clip being recorded

  const DEFAULT_TYPES = {
    sound: ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm"],
    quiet: ["video/webm;codecs=vp8", "video/webm;codecs=vp9", "video/webm"],
  };

  function pick(types) {
    for (const t of types || []) if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
    return "";
  }

  function videoStream(cfg) {
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: cfg.sourceId, maxWidth: cfg.maxSide, maxHeight: cfg.maxSide, maxFrameRate: cfg.fps } },
    });
  }

  /** The computer's sound for this clip, or null. */
  async function soundStream(sound, job) {
    const s = sound || {};
    if (s.system === "desktop" && s.sourceId) {
      // Video has to be asked for to get the loopback; it is dropped at once.
      const got = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: "desktop" } },
        video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: s.sourceId, maxWidth: 8, maxHeight: 8, maxFrameRate: 1 } },
      });
      got.getVideoTracks().forEach((t) => { t.stop(); got.removeTrack(t); });
      return got.getAudioTracks().length ? got : null;
    }
    if (s.system === "monitor") {
      const want = new RegExp(String(s.pattern || "monitor"), "i");
      const dev = (await navigator.mediaDevices.enumerateDevices())
        .find((x) => x.kind === "audioinput" && want.test(x.label || ""));
      if (!dev) return null;
      return navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: dev.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    }
    if (s.system === "pcm") {
      const ctx = new AudioContext({ sampleRate: 16000 });
      const dest = ctx.createMediaStreamDestination();
      job.pcm = { ctx, dest, playAt: 0 };
      return dest.stream;
    }
    return null;
  }

  /** macOS: a packet of 16-bit PCM from the helper, played into the clip's sound. */
  function feedPcm(bytes) {
    const pcm = current && current.pcm;
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
    if (pcm.playAt < now) pcm.playAt = now + 0.05;
    src.start(pcm.playAt);
    pcm.playAt += b.duration;
  }

  function release(job) {
    clearTimeout(job.timer);
    for (const s of job.streams) { try { s.getTracks().forEach((t) => t.stop()); } catch { /* stopped */ } }
    job.streams = [];
    if (job.pcm) { try { job.pcm.ctx.close(); } catch { /* closing */ } job.pcm = null; }
  }

  function answer(job, p) {
    if (job.answered) return;
    job.answered = true;
    release(job);
    if (current === job) current = null;
    bridge.done(Object.assign({ id: job.id }, p));
  }

  async function record(cfg) {
    if (current) answer(current, { ok: false, error: "replaced" });
    const job = { id: cfg.id, streams: [], parts: [], bytes: 0, tooBig: false, answered: false, rec: null, pcm: null, timer: null };
    current = job;
    try {
      const video = await videoStream(cfg);
      job.streams.push(video);
      let sound = null;
      try { sound = await soundStream(cfg.sound, job); } catch { sound = null; }
      if (sound) job.streams.push(sound);
      if (job.answered) return;   // stopped while it was asking
      const withSound = !!(sound && sound.getAudioTracks().length);
      const types = cfg.types || DEFAULT_TYPES;
      const type = pick(withSound ? types.sound : types.quiet);
      const stream = new MediaStream(video.getVideoTracks().concat(withSound ? sound.getAudioTracks() : []));
      const opts = Object.assign({ videoBitsPerSecond: cfg.videoBitrate || 1000000 },
        withSound ? { audioBitsPerSecond: cfg.audioBitrate || 32000 } : {}, type ? { mimeType: type } : {});
      const rec = new MediaRecorder(stream, opts);
      job.rec = rec;
      const stop = () => { try { if (rec.state !== "inactive") rec.stop(); } catch { /* stopped */ } };
      rec.ondataavailable = (e) => {
        if (!e.data || !e.data.size || job.tooBig) return;
        job.bytes += e.data.size;
        if (job.bytes > cfg.maxBytes) { job.tooBig = true; job.parts = []; stop(); return; }
        job.parts.push(e.data);
      };
      const t0 = performance.now();
      rec.onstop = async () => {
        const seconds = (performance.now() - t0) / 1000;
        if (job.tooBig) { answer(job, { ok: true, tooBig: true }); return; }
        if (!job.parts.length) { answer(job, { ok: false, error: "nothing recorded" }); return; }
        const mime = (type || "video/webm").split(";")[0];
        try {
          const buf = await new Blob(job.parts, { type: mime }).arrayBuffer();
          answer(job, { ok: true, mime, data: new Uint8Array(buf), sound: withSound, seconds });
        } catch (e) {
          answer(job, { ok: false, error: String((e && e.message) || e) });
        }
      };
      rec.start(1000);
      job.timer = setTimeout(stop, Math.max(1, cfg.seconds) * 1000);
    } catch (e) {
      answer(job, { ok: false, error: String((e && e.message) || e) });
    }
  }

  /** The main process gave up waiting: stop, and answer nothing it still wants. */
  function stopNow(p) {
    const job = current;
    if (!job || (p && p.id !== job.id)) return;
    answer(job, { ok: false, error: "stopped" });
    try { if (job.rec && job.rec.state !== "inactive") job.rec.stop(); } catch { /* stopped */ }
  }

  bridge.onRecord((cfg) => { void record(cfg); });
  bridge.onStop((p) => stopNow(p));
  bridge.onPcm((bytes) => feedPcm(bytes));
})();
