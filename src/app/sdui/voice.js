// The microphone in the page: the voice button, the held mic, and the spoken
// session over the live transcription socket.

/**
 * The in-page microphone.
 *
 * Click to start, click again to stop. The clip goes to the same
 * /v1/transcribe-clean the tray uses, the text is written into the bound path,
 * and `onChange` fires — which is the moment the server's action refines it.
 * A failure fires `onError` with the real reason, because a permission denial
 * and a dead connection are not the same problem and must not read alike.
 */
let MIC = null;   // { rec, stream, path, node } while a capture is open

function voiceButton(n, p, s) {
  const size = Number(p.size) || K.num("desktop.voice.buttonSize", 44);
  // Held to speak, let go to stop: the onboarding's.
  if (p.hold === true) return holdMicButton(n, p, s, size);
  const on = !!(MIC && MIC.path === ((n.bind && n.bind.value) || ""));
  return '<button class="tz-press" data-mic="' + esc((n.bind && n.bind.value) || "") + '"' +
    ' aria-pressed="' + on + '" title="' +
    esc(on ? K.txt("desktop.voice.stop", "Stop and transcribe") : K.txt("desktop.voice.record", "Record")) + '"' +
    ' style="' + s + ";flex:none;width:" + size + "px;height:" + size + "px;border-radius:50%;cursor:pointer" +
    ";border:0;display:flex;align-items:center;justify-content:center;background:" +
    // Amber ONLY while it is recording — the one live thing; pale ink at rest.
    esc(tok(on ? K.color("desktop.voice.liveBackground", "#E8A23C")
               : (p.background || K.color("desktop.voice.background", "#F3E2C6")))) + '">' +
    // A filled circle while live, the mic glyph at rest. Drawn rather than
    // loaded: the phones use an uploaded icon, and a window that waited on
    // that upload would show an empty button until somebody made one.
    (on
      ? '<span style="width:' + Math.round(size * 0.34) + "px;height:" + Math.round(size * 0.34) +
        'px;border-radius:3px;background:#fff"></span>'
      : '<svg width="' + Math.round(size * 0.46) + '" height="' + Math.round(size * 0.46) +
        '" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round">' +
        '<rect x="9" y="2" width="6" height="12" rx="3" fill="#000" stroke="none"/>' +
        '<path d="M5 11a7 7 0 0 0 14 0M12 18v4"/></svg>') +
    "</button>";
}

/**
 * HOLD TO SPEAK, as the phones' button is held: press to start, let go to stop.
 * A window has a mouse, which can hold, so the onboarding's mic is the same
 * gesture it is on the phone. The disc is the node's size and colours; the
 * glyph on it is this window's own (the phones draw a child node there).
 */
const MIC_PATH = "M9 6a3 3 0 0 1 6 0v5a3 3 0 0 1-6 0zM5 11a7 7 0 0 0 14 0M12 18v3";
function holdMicButton(n, p, s, size) {
  const path = (n.bind && n.bind.value) || "";
  const on = !!(MIC && MIC.path === path);
  const bg = cssv(tok(on ? (p.recordingBackground || p.background) : p.background), "#1C1A17");
  const words = label(p.label) || K.txt("desktop.voice.hold", "Hold to speak");
  return '<button type="button" class="tz-press ob-mic" data-mic="' + esc(path) + '" data-hold="1" aria-pressed="' + on + '" aria-label="' + esc(words) + '"' +
    ' style="' + s + ";flex:none;width:" + size + "px;height:" + size + "px;border-radius:" + okNum(p.radius, size / 2, 0, size) +
    "px;border:0;cursor:pointer;display:flex;align-items:center;justify-content:center;background:" + bg + '">' +
    '<svg width="' + Math.round(size * 0.43) + '" height="' + Math.round(size * 0.43) + '" viewBox="0 0 24 24" fill="none" stroke="' +
    cssv(tok(p.glyphColor), "#FCFBF8") + '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + MIC_PATH + '"/></svg></button>';
}

/** What the microphone is asked for — the same knob the tray's recorder reads. */
const micConstraints = () =>
  K.obj("desktop.mic.constraints", { echoCancellation: true, noiseSuppression: true, autoGainControl: true });

async function micStart(path, n) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() });
  const mime = K.list("desktop.mic.mimeTypes", ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"])
    .find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  // A node that names a state path is told what the mic is doing there:
  // "recording", "busy" (turning it into text) and "idle". The onboarding
  // changes Blip's pose and its captions with it.
  const sk = n.bind && n.bind.state;
  const mood = (v) => { if (sk) setStatePath(sk, v); };
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    MIC = null;
    if (sk) { mood("busy"); repaint(); }
    try {
      if (!chunks.length) throw worded(K.txt("desktop.mic.noAudio", "no audio captured"));
      const type = rec.mimeType || "audio/webm";
      const fd = new FormData();
      fd.append("audio", new Blob(chunks, { type }), "audio." + (type.indexOf("ogg") !== -1 ? "ogg" : "webm"));
      fd.append("targetApp", "Desktop");
      fd.append("language", String(n.props?.language || "auto"));
      const tok = await bearer();
      const res = await fetch(ENV.baseUrl + "/v1/transcribe-clean", {
        method: "POST",
        headers: tok ? { Authorization: "Bearer " + tok } : {},
        body: fd,
      });
      if (!res.ok) throw worded(statusText(res.status), "transcribe → " + res.status);
      const j = await res.json();
      // The written text only: an empty cleanedText is the server deciding
      // there was nothing to write, and the raw transcript in its place was
      // the invented or unwritten words it had just withheld.
      const text = String(j.cleanedText || "").trim();
      if (!text) throw worded(K.txt("desktop.mic.noSpeech", "no speech detected"));
      if (path) setStatePath(path, text);
      mood("idle");
      repaint();
      const ch = n.on && n.on.onChange;
      if (ch) await run(ch, text);
    } catch (err) {
      mood("idle");
      repaint();
      const eh = n.on && n.on.onError;
      const msg = userText(err, K.txt("desktop.mic.transcribeFailed", "Couldn't turn that into text. Try again."));
      if (eh) await run(eh, msg); else toast(msg);
    }
  };
  rec.start();
  MIC = { rec, stream, path, node: n };
  mood("recording");
  repaint();
}

/**
 * A SPOKEN CONVERSATION, the same loop the phones run.
 *
 * Renders nothing. It owns the audio and writes what it knows into the screen's
 * state, so the screen around it stays ordinary backend JSON — a bubble bound
 * to `level`, a line bound to `line`, a button that posts `$state.turns`.
 *
 * One turn at a time:
 *
 *   listening   a socket to /v1/transcribe-stream fills in text as you talk.
 *               A pause of silenceMs with something said ends the turn, and
 *               the mic closes — it must be shut while the app talks, or it
 *               transcribes its own voice.
 *   thinking    the conversation so far goes to `path`; a reply comes back.
 *   speaking    the browser says it. When it finishes, listening resumes.
 *
 * Turn-based, not full duplex — you cannot talk over it — which is the same
 * limit the phones have, for the same reason.
 *
 * The phone version spends half its length on AVAudioSession categories, so
 * the reply comes out of the speaker rather than the earpiece. A window has no
 * earpiece and no categories, and all of that simply does not exist here.
 */
let SESSION_RUN = null;   // the live loop, or null

function startSession(n) {
  if (SESSION_RUN) return;                 // already running for this screen
  const p = deepResolve(n.props || {});
  // How the level bubble moves: how often it decays, how far a word lifts it,
  // where it rests, and where it sits while the app thinks and speaks.
  const LV = K.obj("desktop.voice.level", {
    tickMs: 90, onSpeech: 0.8, floor: 0.15, decay: 0.86, thinking: 0.12, speaking: 0.5,
  });
  const r = {
    alive: true,
    endpoint: String(p.path || K.str("desktop.voice.endpoint", "/v1/train/converse")),
    silenceMs: Math.max(K.num("desktop.voice.minSilenceMs", 600), Number(p.silenceMs) || K.num("desktop.voice.silenceMs", 1500)),
    maxTurns: Math.max(K.num("desktop.voice.minTurns", 2), Number(p.maxTurns) || K.num("desktop.voice.maxTurns", 40)),
    language: p.language ? String(p.language) : "auto",
    // The locale the built-in voice should use when the server's cannot be
    // had: the catalog's speakLanguage ("en-IN" for Hinglish), never the raw
    // dictation setting, which is not a locale ("hinglish").
    speakLanguage: p.speakLanguage ? String(p.speakLanguage) : "",
    statePath: String(p.statePath || "sessionState"),
    levelPath: String(p.levelPath || "level"),
    linePath: String(p.linePath || "line"),
    turnsPath: String(p.turnsPath || "turns"),
    greeting: String(p.greeting || "").trim(),
    node: n, turns: [], committed: "", partial: "",
    ws: null, stream: null, ctx: null, proc: null, src: null, tts: null,
    decay: null, silence: null, level: 0,
  };
  SESSION_RUN = r;

  const put = (path, v) => { if (path) setStatePath(path, v); };
  const setState_ = (v) => { put(r.statePath, v); repaint(); };
  const setLevel = (v) => { r.level = v; put(r.levelPath, v); };
  const say = (role, text) => {
    r.turns = r.turns.concat([{ role, text }]);
    put(r.turnsPath, r.turns);
    put(r.linePath, text);
    repaint();
  };
  const fail = (m) => {
    if (!r.alive) return;
    r.alive = false;
    closeMic(r);
    setState_("error");
    const eh = n.on && n.on.onError;
    if (eh) void run(eh, m); else toast(m);
  };

  const armSilence = () => {
    clearTimeout(r.silence);
    r.silence = setTimeout(() => {
      const said = (r.committed + " " + r.partial).trim();
      // A pause with nothing in it is a pause, not a turn. Keep listening.
      if (!said) { armSilence(); return; }
      closeMic(r);
      say("user", said);
      void respond();
    }, r.silenceMs);
  };
  const heard = () => { setLevel(LV.onSpeech); armSilence(); };

  async function listen(warmed) {
    if (!r.alive) return;
    if (r.turns.length >= r.maxTurns * 2) { setState_("idle"); setLevel(0); return; }
    r.committed = ""; r.partial = "";
    setState_("listening");
    setLevel(LV.floor);
    // The level has no amplitude behind it — the socket hands over text, not
    // PCM. So it rises on the arrival of words and decays between them, which
    // is a true signal about speech even though it is not loudness.
    r.decay = setInterval(() => {
      if (r.level > LV.floor) setLevel(Math.max(LV.floor, r.level * LV.decay));
    }, LV.tickMs);
    try {
      // The microphone opened behind the greeting, when there was one. A
      // warm-up that failed falls through to asking again, so a denial is
      // still reported by the same path rather than silently.
      r.stream = (warmed ? await warmed : null) ||
        await navigator.mediaDevices.getUserMedia({ audio: micConstraints() });
      const token = await bearer();
      // Either wait can outlast the screen; a socket opened after that is one
      // nothing will ever close.
      if (!r.alive) { closeMic(r); return; }
      r.ws = new WebSocket(ENV.baseUrl.replace(/^http/, "ws") + "/v1/transcribe-stream");
      r.ws.binaryType = "arraybuffer";
      // A browser socket cannot set an Authorization header; the protocol
      // carries the token in the start frame, which the server accepts.
      r.ws.onopen = () => r.ws && r.ws.send(JSON.stringify({
        type: "start", token, targetApp: "Desktop", language: r.language,
        sampleRate: 16000, encoding: "pcm_s16le", channels: 1,
      }));
      r.ws.onmessage = (ev) => {
        if (!r.alive) return;
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === "partial") { r.partial = m.text || ""; heard(); }
        else if (m.type === "final") {
          if (m.text && m.text.trim()) r.committed = (r.committed + " " + m.text.trim()).trim();
          r.partial = ""; heard();
        } else if (m.type === "error") {
          // The server's sentence, except its sign-in refusal: that keeps
          // the keyboards' old wording ("invalid or missing token") because
          // they match on it, so it is said here.
          if (m.message) console.warn("[voice] stream error " + (m.code || "") + ": " + m.message);
          fail(m.code === "unauthorized"
            ? K.txt("error.unauthorized", "Your session has expired. Sign in again to continue.")
            : (m.message || K.txt("desktop.voice.micStopped", "The microphone stopped.")));
        }
      };
      r.ws.onerror = () => { /* onclose follows */ };
      // The socket went away under a live microphone (the server closed it, the
      // network dropped). Nothing else would ever notice: the silence timer
      // keeps re-arming on nothing said, and the mic stays open. Our own
      // closes detach this first (closeMic).
      r.ws.onclose = () => fail(K.txt("desktop.voice.micStopped", "The microphone stopped."));
      r.ctx = new AudioContext();
      r.src = r.ctx.createMediaStreamSource(r.stream);
      r.proc = r.ctx.createScriptProcessor(4096, 1, 1);
      r.src.connect(r.proc);
      r.proc.connect(r.ctx.destination);
      const inRate = r.ctx.sampleRate;
      // The level follows the voice itself as well as the words: the words
      // arrive a beat late, and a field that sits still while someone talks
      // reads as a microphone that is not on.
      const VL = K.obj("desktop.voice.inputLevel", { gate: 0.012, gain: 6 });
      r.proc.onaudioprocess = (e) => {
        if (!r.alive || !r.ws || r.ws.readyState !== 1) return;
        const f32 = e.inputBuffer.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < f32.length; i += 4) sum += f32[i] * f32[i];
        const rms = Math.sqrt(sum / Math.ceil(f32.length / 4));
        if (rms > VL.gate) setLevel(Math.max(r.level, Math.min(1, LV.floor + rms * VL.gain)));
        r.ws.send(pcm16k(f32, inRate));
      };
      armSilence();
    } catch (err) {
      fail(err && err.name === "NotAllowedError"
        ? K.txt("desktop.voice.micBlocked", "microphone blocked — allow it in your system settings")
        : userText(err, K.txt("desktop.voice.startFailed", "Couldn't start listening.")));
    }
  }

  async function respond() {
    if (!r.alive) return;
    setState_("thinking");
    setLevel(LV.thinking);
    try {
      const res = await api(r.endpoint, { turns: r.turns, language: r.language });
      if (!r.alive) return;
      const reply = String((res && res.reply) || "").trim();
      if (!reply) { void listen(); return; }
      say("assistant", reply);
      setState_("speaking");
      setLevel(LV.speaking);
      // The server names the voice for this reply (speak: "bn-IN") from its
      // script: someone who switched to Bengali is answered in Bengali.
      speak(reply, () => { if (r.alive) void listen(); }, res && typeof res.speak === "string" ? res.speak : "");
    } catch (err) {
      fail(userText(err, K.txt("desktop.voice.replyFailed", "Couldn't reach the conversation.")));
    }
  }

  /**
   * OUT LOUD, IN THE VOICE THEY PICKED, then back to listening.
   *
   * This used to be the window's own synthesiser only, and that is the OS's
   * voices: a Windows install with no Indian English voice said a Hinglish
   * reply in nothing at all, and it was handed "hinglish" as a locale, which
   * no synthesiser has. The reply is now read by the server (/v1/speak, the
   * read-aloud voice chosen in Settings, which speaks whatever language the
   * text is in) and played through Web Audio — the page's media-src admits no
   * blob: URLs, and Web Audio needs none. Only if that fails does the built-in
   * voice say it, with a real locale.
   */
  function speak(text, then, voice) {
    // Once, whichever of the end, an error or the ceiling comes first. The
    // ceiling used to fire on its own schedule too: a long first reply's
    // timer ended the NEXT reply mid-sentence and opened a second microphone
    // over the first.
    let timer = null, over = false, fellBack = false;
    const done = () => { if (over) return; over = true; clearTimeout(timer); stopTts(r); then(); };
    const ceiling = (ms) => {
      clearTimeout(timer);
      timer = setTimeout(done, Math.min(K.num("desktop.voice.ttsMaxMs", 30000), ms));
    };
    const builtIn = () => {
      if (over || fellBack || !r.alive) return;
      fellBack = true;
      try {
        const synth = window.speechSynthesis;
        if (!synth) { done(); return; }
        synth.cancel();
        const u = new SpeechSynthesisUtterance(text);
        const lang = voice || r.speakLanguage || (/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(r.language) && r.language !== "auto" ? r.language : "");
        if (lang) u.lang = lang;
        u.onend = done;
        u.onerror = done;
        synth.speak(u);
        // Some engines drop an utterance silently. A ceiling proportional to
        // the reply keeps a dead synthesiser from ending the conversation.
        ceiling(K.num("desktop.voice.ttsBaseMs", 2000) + text.length * K.num("desktop.voice.ttsPerCharMs", 90));
      } catch { done(); }
    };
    if (!K.bool("desktop.voice.serverTts", true)) { builtIn(); return; }
    // The fetch and the decode get a ceiling of their own; past it, the
    // built-in voice says it rather than the room going quiet.
    timer = setTimeout(() => { if (!r.tts || !r.tts.src) { stopTts(r); builtIn(); } }, K.num("desktop.voice.serverTtsWaitMs", 8000));
    void (async () => {
      try {
        const tok = await bearer();
        const res = await fetch(ENV.baseUrl + "/v1/speak", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(tok ? { Authorization: "Bearer " + tok } : {}) },
          body: JSON.stringify({ text, format: "mp3" }),
        });
        if (!res.ok) throw new Error("speak " + res.status);
        const bytes = await res.arrayBuffer();
        if (over || fellBack || !r.alive) return;
        const ac = new AudioContext();
        r.tts = { ctx: ac, src: null };
        const buf = await ac.decodeAudioData(bytes);
        if (over || fellBack || !r.alive || !r.tts || r.tts.ctx !== ac) { try { ac.close(); } catch {} return; }
        const src = ac.createBufferSource();
        src.buffer = buf;
        src.connect(ac.destination);
        src.onended = done;
        r.tts.src = src;
        src.start();
        // The audio says how long it is; a second over that, it is over.
        ceiling(buf.duration * 1000 + 1000);
      } catch (err) {
        if (over || fellBack) return;
        console.warn("[voice] server voice unavailable, using the built-in one: " + ((err && err.message) || err));
        stopTts(r);
        clearTimeout(timer);
        builtIn();
      }
    })();
  }

  /**
   * THE WARM-UP HAPPENS BEHIND THE GREETING, NOT BEFORE IT.
   *
   * This used to open by listening, so asking for the microphone and opening
   * the socket happened in silence with the screen already up — and the first
   * thing the app said arrived only after the user had spoken into that
   * silence and waited out a round trip. That reads as broken, not as
   * thinking.
   *
   * The greeting arrives written, composed by the server from the name and
   * what has actually been learned, so it is said at once and the warm-up goes
   * underneath it. A window has no audio-session category to fight, so here
   * the microphone itself can be opened early: by the time the sentence ends
   * the stream is live and the handover is a state change rather than a wait.
   */
  if (r.greeting) {
    r.turns = [{ role: "assistant", text: r.greeting }];
    put(r.turnsPath, r.turns);
    put(r.linePath, r.greeting);
    setState_("speaking");
    setLevel(LV.speaking);
    // Not awaited. The point is that it opens WHILE the sentence is spoken.
    const warm = navigator.mediaDevices
      .getUserMedia({ audio: micConstraints() })
      .catch(() => null);
    speak(r.greeting, () => {
      if (!r.alive) { void warm.then((st) => st && st.getTracks().forEach((t) => t.stop())); return; }
      void listen(warm);
    });
  } else {
    void listen();
  }
}

/** Stop the server voice mid-sentence, if it is speaking. */
function stopTts(r) {
  const t = r && r.tts;
  if (!t) return;
  r.tts = null;
  try { t.src && (t.src.onended = null, t.src.stop()); } catch {}
  try { t.ctx && t.ctx.close(); } catch {}
}

/** Close the microphone and its socket, leaving the loop able to open another. */
function closeMic(r) {
  clearInterval(r.decay); r.decay = null;
  clearTimeout(r.silence); r.silence = null;
  try { r.proc && (r.proc.onaudioprocess = null, r.proc.disconnect()); } catch {}
  try { r.src && r.src.disconnect(); } catch {}
  try { r.ctx && r.ctx.close(); } catch {}
  r.proc = r.src = r.ctx = null;
  if (r.ws) { r.ws.onmessage = r.ws.onclose = r.ws.onerror = null; try { r.ws.close(); } catch {} r.ws = null; }
  if (r.stream) { r.stream.getTracks().forEach((t) => t.stop()); r.stream = null; }
}

/** End the conversation for good. Called when the screen goes away — a loop
 *  that outlives its screen keeps a live microphone open behind a window the
 *  user believes they have left. */
function stopSession() {
  if (!SESSION_RUN) return;
  SESSION_RUN.alive = false;
  closeMic(SESSION_RUN);
  stopTts(SESSION_RUN);
  try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch {}
  SESSION_RUN = null;
}

/** Float samples at the device rate → 16 kHz signed 16-bit, which is what the
 *  transcribe socket expects. Linear interpolation; the same routine the tray
 *  recorder uses, so both paths sound identical to the server. */
function pcm16k(f32, inRate) {
  const ratio = inRate / 16000;
  const outLen = Math.floor(f32.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const idx = i * ratio, i0 = Math.floor(idx), i1 = Math.min(i0 + 1, f32.length - 1);
    const frac = idx - i0;
    let v = f32[i0] * (1 - frac) + f32[i1] * frac;
    v = Math.max(-1, Math.min(1, v));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out.buffer;
}
