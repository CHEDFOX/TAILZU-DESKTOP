/**
 * ASK, IN THE MAIN PROCESS: the guide's window, the question's microphone,
 * and the agent's hands (agent.js), wired to each other.
 *
 * Tap Alt twice (desktop.agent.tapKey) and say something about the app in
 * front. The recorder records one clip in "ask" mode (recorder.js), ended by
 * the first real pause, Alt twice again, or a ceiling; it comes here whole,
 * and the agent asks /v1/agent with it and a text snapshot of the screen
 * (driver.js). What comes back is drawn by the guide (guide.html): the card,
 * the ring, Blip pointing; what is done is done by the driver, risky things
 * only after "Do it" on the card or Alt twice.
 *
 * The question is streamed as well (desktop.agent.liveStream): its words come
 * here as they are said, and the agent matches them against the screen while
 * they are still being said (a tentative ring), then answers from the
 * stream's text with no transcription to wait for. A question about something
 * drawn sends one picture of it, cropped here, only once the card has been
 * answered "Allow once" or "Always for <app>".
 *
 * Kept apart from main.js, with everything it needs handed in, so the order
 * of what happens can be read in one place and tested without Electron.
 */
const agentCore = require("./agent.js");

function createAsk(ctx) {
  const { BrowserWindow, screen, ipcMain, knobs: K } = ctx;
  const num = K.num, bool = K.bool, str = K.str, txt = K.txt;
  // Handed in by the tests, which play a Mac and a Windows PC on any machine.
  const platform = ctx.platform || process.platform;

  let win = null;          // the guide's window
  let bounds = null;       // where it is, in screen DIP
  let ready = false;
  const queue = [];        // what to send once it has loaded
  let session = 0;         // the recorder session that is a question, while one records
  let listening = false;
  let listenTimer = null;
  let clipDue = false;     // a question's clip is still to come back from the recorder
  let clipTimer = null;
  let onAudio = null;      // who the next recorded question is for (begin, or an ASK's reply)
  let reply = null;        // the ASK's reply it is, when it is one
  // Counts the questions begun and thrown away, so a tap still waiting to
  // learn which app is in front can tell it has been overtaken.
  let asking = 0;
  let naming = 0;          // the question whose app is being named, until its run begins
  let confirmWait = null;  // the card's Do it / Not now, while it is up
  let confirmAt = 0;       // when that card was put up
  let permitWait = null;   // the picture card's Allow once / Always / Not now, while it is up
  // THE LIVE STREAM'S WORDS, for the question recording now. Partials as they
  // come (shown to the agent as previews), the text so far with the clip, and
  // the stream's final text, which can arrive a moment after the clip or
  // just before it.
  let streamed = false;    // the question now recording goes to the stream too
  let streamText = "";     // what the stream has heard of it so far
  let finalText = null;    // the stream's last word on it, once that has come
  let finalWait = null;    // its clip, back and waiting a moment for that
  let previewing = false;  // the run has begun, and may be shown the words
  // The driver's units: UI Automation reports physical pixels, AX reports
  // points, which are already Electron's DIP.
  const pixels = platform === "win32";
  let hideTimer = null;
  let goneTimer = null;    // the window itself going, after the card has faded
  // None of this file's timers keeps a process alive by itself: in the app
  // Electron does that, and the tests end when their run does.
  const soft = (t) => { if (t && typeof t.unref === "function") t.unref(); return t; };

  // ---- the window ---------------------------------------------------------------
  function displayFor(pt) {
    return pt ? screen.getDisplayNearestPoint({ x: Math.round(pt.x), y: Math.round(pt.y) }) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  }
  /** What the window covers on a display. On a Mac the whole display: the
   *  menu bar's items (File, Edit, ...) are things to point at, and a window
   *  over the work area starts just below them. On Windows the work area: a
   *  topmost window over the taskbar too reads to Windows as a full-screen
   *  app, and it holds back notifications for one. */
  function areaOf(display) {
    return platform === "darwin" && display.bounds ? display.bounds : display.workArea;
  }
  /** How far in from the window's edges the card keeps: the menu bar and
   *  the Dock, on a Mac; nothing on Windows. */
  function insetOf(display, b) {
    const wa = display.workArea || b;
    return {
      top: Math.max(0, wa.y - b.y), left: Math.max(0, wa.x - b.x),
      right: Math.max(0, b.x + b.width - (wa.x + wa.width)), bottom: Math.max(0, b.y + b.height - (wa.y + wa.height)),
    };
  }
  const sameRect = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  function ensureWindow(display) {
    const area = areaOf(display);
    if (win && !win.isDestroyed()) {
      if (!sameRect(bounds, area)) {
        bounds = Object.assign({}, area);
        ctx.setBoundsExactly(win, bounds);
        send({ type: "area", inset: insetOf(display, bounds) });
      }
      return win;
    }
    bounds = Object.assign({}, area);
    ready = false;
    queue.length = 0;
    // THE PILL'S RECIPE: never focused (the app you asked about keeps the
    // keyboard, and a paste still lands in it), click-through except over the
    // card, over full-screen apps and every Space. A Mac's frameless panel is
    // let over the menu bar, which AppKit would otherwise push it below.
    const w = win = new BrowserWindow(Object.assign({}, bounds, {
      frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
      focusable: false, resizable: false, movable: false, hasShadow: false, show: false,
      ...(platform === "darwin" ? { type: "panel", enableLargerThanScreen: true } : {}),
      webPreferences: ctx.webPrefs({ backgroundThrottling: false }),
    }));
    try { w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true }); } catch { /* one space */ }
    w.setIgnoreMouseEvents(true, { forward: true });
    // Off by default: someone sharing their screen to show a colleague
    // "where's export" should be seen being shown. A knob for those who want
    // the guide out of every capture.
    if (bool("desktop.guide.contentProtection", false)) { try { w.setContentProtection(true); } catch { /* unsupported */ } }
    ctx.hardenWindow(w);
    w.webContents.once("did-finish-load", () => { if (win !== w) return; ready = true; for (const m of queue.splice(0)) w.webContents.send("guide", m); });
    // A page that crashed (the GPU, memory) leaves a window that is still
    // there and draws nothing, so every later run would go on unseen, its
    // Do it card included. It is thrown away instead, the run with it, and
    // the next card builds a new one. The pill and the recorder do the same.
    w.webContents.on("render-process-gone", () => {
      if (win !== w) return;
      console.warn("[ask] the guide's page went away; a new one is made for the next question");
      win = null; ready = false; bounds = null; shown = false; queue.length = 0;
      clearTimeout(goneTimer);
      try { w.destroy(); } catch { /* already gone */ }
      cancel("guide gone");
    });
    // Only this window's own close: a late one from a window already
    // replaced must not forget the new one.
    w.on("closed", () => { if (win === w) { win = null; ready = false; bounds = null; } });
    w.loadFile("guide.html");
    send({ type: "area", inset: insetOf(display, bounds) });
    return w;
  }
  function send(m) {
    if (!win || win.isDestroyed()) return;
    if (ready) win.webContents.send("guide", m); else queue.push(m);
  }
  function showWindow() {
    if (!win || win.isDestroyed()) return;
    clearTimeout(goneTimer);
    if (!win.isVisible()) win.showInactive();
    ctx.raisePill(win);
  }
  /** A screen frame (the driver's units) in screen DIP, or null. */
  function dip(frame) {
    if (!Array.isArray(frame) || frame.length !== 4) return null;
    let [x, y, w, h] = frame.map(Number);
    if (![x, y, w, h].every(Number.isFinite)) return null;
    if (pixels) {
      try {
        const r = screen.screenToDipRect(null, { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) });
        x = r.x; y = r.y; w = r.width; h = r.height;
      } catch { /* as they are: right on a display at 100% */ }
    }
    return { x, y, w, h };
  }
  /** A DIP rectangle as the guide window's own coordinates. */
  function local(r) { return r && bounds ? [r.x - bounds.x, r.y - bounds.y, r.w, r.h] : null; }
  function localPoint(p) { return p && bounds ? { x: p.x - bounds.x, y: p.y - bounds.y } : null; }

  // ---- what the agent drives ---------------------------------------------------
  // What agent.js calls (its §3 guide), turned into the guide window's
  // messages. When the card goes away is the agent's to say (hide), except
  // for what only this file knows about (a question nobody said: cardError).
  let shown = false;
  const guide = {
    show(state, data) {
      clearTimeout(hideTimer);
      if (confirmWait) confirmWait(false);
      if (permitWait) permitWait("no");
      // A new card: whatever the last one was still saying stops.
      quiet();
      const anchor = (data && data.anchor) || screen.getCursorScreenPoint();
      ensureWindow(displayFor(anchor));
      showWindow();
      shown = true;
      send({ type: "show", state, app: (data && data.app) || "", anchor: localPoint(anchor), key: str("desktop.agent.tapKey", "Alt") });
    },
    // listening / thinking / acting (with what it is doing) / done (with
    // what it has to say about it).
    state(s, data) {
      // Whatever the agent says next, it has stopped waiting on the card: it
      // was answered, or its confirmMs or the run's deadline ran out.
      if (confirmWait) confirmWait(false);
      if (permitWait) permitWait("no");
      const text = typeof data === "string" ? data : "";
      if (s === "acting") { send({ type: "state", state: "doing", label: text }); return; }
      // Over (its deadline, say) while an ASK's reply records: that
      // microphone has nobody left to answer.
      if (s === "done") dropReply();
      send({ type: "state", state: s });
      if (s === "done" && text) guide.say(text);
    },
    heard(t) { permitGone(); send({ type: "heard", text: String(t || "") }); },
    // A long answer comes a sentence at a time (`append`): each is added to
    // what the card says, and said after the one before it.
    say(t, opts) {
      permitGone();
      const o = opts || {};
      const text = String(t || "");
      if (!text) return;
      send(o.append ? { type: "say", text, append: true } : { type: "say", text });
      if (bool("desktop.agent.speak", true)) sayAloud(text, o);
    },
    // `tentative`: a guess while they are still talking, or the part of the
    // window a picture is being taken of. Drawn lightly, with nothing tied
    // to it; the answer's own ring replaces it.
    point(frame, caption, opts) {
      permitGone();
      const r = dip(frame);
      if (!r) return;
      // The ring is on another display: the guide goes there. Found from the
      // DIP rectangle, as displays are: on a scaled display a physical pixel
      // position can lie in the next display's DIP, and the guide would move
      // there and draw the ring off its own edge.
      const d = displayFor({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
      if (!sameRect(bounds, areaOf(d))) { ensureWindow(d); showWindow(); }
      const m = { type: "point", frame: local(r), caption: caption || "" };
      if (opts && opts.tentative) m.tentative = true;
      send(m);
    },
    // A word in the card's header about the answer: "1 picture sent".
    badge(t) { permitGone(); send({ type: "badge", text: String(t || "") }); },
    unpoint() { permitGone(); send({ type: "unpoint" }); },
    steps(items) { permitGone(); send({ type: "steps", items: items || [] }); },
    confirm(text, risk) {
      if (confirmWait) confirmWait(false);
      send({ type: "confirm", text: String(text || ""), risk: risk === "always" ? "always" : "confirm" });
      confirmAt = Date.now();
      return new Promise((resolve) => {
        let timer = null;
        const answer = (yes) => {
          clearTimeout(timer);
          if (confirmWait === answer) confirmWait = null;
          resolve(!!yes);
        };
        confirmWait = answer;
        // The agent stops waiting after confirmMs, and so does the card: a
        // wait left open would take the next Alt twice, meant as a new
        // question, as the answer to one nobody is asking any more.
        timer = soft(setTimeout(() => answer(false), Math.max(0, num("desktop.agent.confirmMs", 30000))));
      });
    },
    hide() { hide(); },
    error(msg) {
      if (confirmWait) confirmWait(false);
      if (permitWait) permitWait("no");
      dropReply();
      // Refused before anything was shown (a private window): the card
      // comes up to say so.
      if (!shown) guide.show("error", {});
      send({ type: "state", state: "error" });
      if (msg) send({ type: "say", text: String(msg) });
    },
  };
  /** An error only this file knows of, on a card it then puts away itself. */
  function cardError(msg) {
    guide.error(msg);
    later(num("desktop.agent.doneMs", 9000));
  }
  function later(ms) {
    clearTimeout(hideTimer);
    hideTimer = soft(setTimeout(() => { if (!agent.active() && !listening) hide(); }, ms));
  }
  function hide() {
    clearTimeout(hideTimer);
    shown = false;
    if (confirmWait) confirmWait(false);
    if (permitWait) permitWait("no");
    quiet();
    send({ type: "hide" });
    // Gone, once Blip has ducked and the card has faded; unless a card came
    // back up in the meantime. The not-heard card is put up right after the
    // run's own hide, and it is meant to stay doneMs, not half a second.
    clearTimeout(goneTimer);
    goneTimer = soft(setTimeout(() => {
      if (win && !win.isDestroyed() && !shown && !agent.active()) { win.setIgnoreMouseEvents(true, { forward: true }); win.hide(); }
    }, 520));
  }

  // ---- the voice -------------------------------------------------------------------
  // What a card says is said in the order it was written, one sentence after
  // the other, and only while that card is up. Each sentence's audio is
  // fetched as soon as it is written; it is played once the one before has
  // been heard (the guide's "spoken"), and dropped if the card it belonged to
  // was put away, replaced, or a question started recording meanwhile. One
  // that arrived late used to play over nothing, or over the next question.
  let voiceTok = 0;                 // which card's voice may still be heard
  let speech = Promise.resolve();   // this card's sentences, in order
  let spokenWait = null;            // releases the sentence being said
  /** Nothing more is said: what is playing stops, what is on its way is dropped. */
  function quiet() {
    voiceTok++;
    speech = Promise.resolve();
    if (spokenWait) spokenWait();
    send({ type: "hush" });
  }
  function sayAloud(text, opts) {
    const tok = voiceTok;
    const got = voice(text, opts);
    speech = speech.then(() => got).then((m) => {
      if (!m || tok !== voiceTok || !shown || listening) return undefined;
      send(m);
      return spoken();
    });
  }
  /** Until the guide says it has finished saying it, and never longer than
   *  voiceWaitMs, so one that never says so holds nothing up for good. */
  function spoken() {
    return new Promise((resolve) => {
      let timer = null;
      const done = () => { clearTimeout(timer); if (spokenWait === done) spokenWait = null; resolve(); };
      spokenWait = done;
      timer = soft(setTimeout(done, Math.max(0, num("desktop.agent.voiceWaitMs", 15000))));
    });
  }
  /** What has been written so far, said; bounded the same way. */
  function afterSpeech() {
    const cap = new Promise((r) => soft(setTimeout(r, Math.max(0, num("desktop.agent.voiceWaitMs", 15000)) + 2000)));
    return Promise.race([speech, cap]);
  }
  /** The sentence out loud, as a message for the guide. The built-in voice
   *  with a real locale, by default: the server's voice (/v1/speak, the
   *  read-aloud voice chosen in Settings) counts its words against the
   *  month's, and Ask must never use up what dictation needs. Where the
   *  server turns it on, and it fails, the built-in voice still speaks. */
  async function voice(text, opts) {
    const rate = num("desktop.agent.voiceRate", 1.04);
    if (bool("desktop.agent.serverVoice", false)) {
      try {
        const res = await ctx.authorizedFetch("/v1/speak", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, format: "mp3" }),
          signal: AbortSignal.timeout(Math.max(1000, num("desktop.agent.voiceFetchMs", 8000))),
        });
        if (res.ok) return { type: "voice", audio: new Uint8Array(await res.arrayBuffer()), mime: "audio/mpeg" };
      } catch { /* the built-in voice */ }
    }
    return { type: "voice", text, speak: true, locale: opts.locale || "", rate };
  }

  // ---- the picture ---------------------------------------------------------------
  // A question about something drawn (an equation, a chart, a photo) is
  // answered from one picture of it. Taken from the window the driver
  // captured at Alt twice, cropped here to the part asked about, and sent
  // only with their say-so for the app it is of: the card, every time, or
  // "Always for <app>", which this computer remembers (main.js's local
  // state). The knob turns pictures off everywhere.
  const appKey = (name) => String(name || "").replace(/\s+/g, " ").trim().toLowerCase();
  /** "never", "always" or "ask", for pictures of this app. */
  function pictures(app) {
    const k = str("desktop.agent.pictures", "ask");
    if (k === "never") return "never";
    const key = appKey(app);
    const always = typeof ctx.picturesAlways === "function" ? ctx.picturesAlways() : [];
    if (key && Array.isArray(always) && always.some((a) => appKey(a) === key)) return "always";
    return k === "always" ? "always" : "ask";
  }
  /** The picture card, until it is answered: "once", "always" (remembered
   *  for this app) or "no". Unanswered in confirmMs, put away, or the card
   *  replaced, it is no. */
  function permit(app) {
    if (permitWait) permitWait("no");
    // The name whole, as the run has it (up to 60): "Always for <app>" must
    // remember the very name pictures() is asked about next time, or a long
    // one is asked about every time. The card cuts it short on screen itself.
    const name = String(app || "").replace(/\s+/g, " ").trim().slice(0, 60);
    send({ type: "permission", app: name, text: txt("desktop.agent.permitText", "To answer that I need to see it: one picture of this part of the screen, sent to Tailzu.") });
    return new Promise((resolve) => {
      let timer = null;
      const answer = (choice) => {
        clearTimeout(timer);
        if (permitWait !== answer) return;
        permitWait = null;
        const c = choice === "once" || choice === "always" ? choice : "no";
        if (c === "always" && name && typeof ctx.allowPicturesAlways === "function") {
          try { ctx.allowPicturesAlways(name); } catch { /* still yes, for this once */ }
        }
        resolve(c);
      };
      permitWait = answer;
      timer = soft(setTimeout(() => { if (permitWait === answer) permitGone(); }, Math.max(0, num("desktop.agent.confirmMs", 30000))));
    });
  }
  /** The picture card's question, settled without a click: nobody answered
   *  in confirmMs, here or in the run, which stops waiting at the same time
   *  and may already be telling the guide the answer. It is a no, and the
   *  card is taken off its question first: nothing else the run sends moves
   *  it from there, and its buttons stayed up under the answer, asking a
   *  question already settled. */
  function permitGone() {
    if (!permitWait) return;
    permitWait("no");
    send({ type: "state", state: "thinking" });
  }
  /**
   * The part of the look's picture under `frame`, as a JPEG no longer on its
   * long side than desktop.agent.pictureMaxSide. The picture is exactly the
   * look's window, so a frame in the driver's units maps into it by the
   * window's frame and the picture's own size; a frame that misses the
   * window, or is too thin to see anything in, is the whole window instead.
   * Null when there is no picture to crop.
   */
  function crop(look, frame) {
    try {
      const img = look && look.image;
      const win = look && look.window && look.window.frame;
      const ok = (f) => Array.isArray(f) && f.length === 4 && f.every((n) => typeof n === "number" && Number.isFinite(n));
      if (!img || typeof img.data !== "string" || !img.data || !ok(win) || win[2] <= 0 || win[3] <= 0 || !ctx.nativeImage) return null;
      const pic = ctx.nativeImage.createFromBuffer(Buffer.from(img.data, "base64"));
      if (!pic || pic.isEmpty()) return null;
      const size = pic.getSize();
      const sx = size.width / win[2], sy = size.height / win[3];
      let rect = { x: 0, y: 0, width: size.width, height: size.height };
      if (ok(frame)) {
        const x0 = Math.max(0, Math.floor((frame[0] - win[0]) * sx)), y0 = Math.max(0, Math.floor((frame[1] - win[1]) * sy));
        const x1 = Math.min(size.width, Math.ceil((frame[0] + frame[2] - win[0]) * sx)), y1 = Math.min(size.height, Math.ceil((frame[1] + frame[3] - win[1]) * sy));
        if (x1 - x0 >= 8 && y1 - y0 >= 8) rect = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
      }
      let out = rect.x === 0 && rect.y === 0 && rect.width === size.width && rect.height === size.height ? pic : pic.crop(rect);
      const max = Math.max(64, num("desktop.agent.pictureMaxSide", 1024));
      const got = out.getSize();
      if (Math.max(got.width, got.height) > max) {
        out = out.resize(got.width >= got.height ? { width: max, quality: "good" } : { height: max, quality: "good" });
      }
      const data = out.toJPEG(Math.max(1, Math.min(100, num("desktop.agent.pictureQuality", 82))));
      return data && data.length ? { mime: "image/jpeg", data } : null;
    } catch (e) {
      console.warn("[ask] the picture could not be cropped:", (e && e.message) || e);
      return null;
    }
  }

  // ---- the microphone ------------------------------------------------------------
  /** Opens the microphone for a question (`question`), streamed when
   *  desktop.agent.liveStream is on, or for an ASK's reply, which is only
   *  ever its audio. */
  function record(question) {
    if (!ctx.recorderReady()) ctx.createRecorderWindow();
    // Nothing is said while a question records: the microphone would hear it.
    quiet();
    session = ctx.nextSession();
    listening = true;
    clipDue = true;
    clearTimeout(clipTimer);
    streamed = !!question && bool("desktop.agent.liveStream", true);
    streamText = ""; finalText = null; finalWait = null; previewing = false;
    ctx.sendToRecorder("start-recording", Object.assign(ctx.recorderStart(session), { live: streamed, pauseFlush: false, mode: "ask" }));
    clearTimeout(listenTimer);
    listenTimer = soft(setTimeout(stopListening, num("desktop.agent.listenMaxMs", 15000)));
  }
  function stopListening() {
    clearTimeout(listenTimer);
    if (!listening) return;
    listening = false;
    ctx.sendToRecorder("stop-recording", { session });
    // The clip comes back in a moment. If it never does (the recorder's page
    // crashed, a message lost between the processes), the question ends as
    // one nobody heard, not as a card on "Listening" for good.
    const sid = session;
    clearTimeout(clipTimer);
    clipTimer = soft(setTimeout(() => { if (sid === session && clipDue && !listening) noClip(); }, Math.max(0, num("desktop.agent.clipWaitMs", 8000))));
  }
  /** The question's clip will not come: whoever waits for it gets nothing
   *  but what the stream heard of it, if it was streamed (its final text,
   *  when that came without the clip, else what it had so far). */
  function noClip() {
    clearTimeout(listenTimer); clearTimeout(clipTimer);
    listening = false; clipDue = false; previewing = false;
    const take = onAudio; onAudio = null;
    const words = streamed && take !== reply ? finalText || streamText : "";
    if (take) take(null, { text: words, final: !!words && words === finalText });
  }
  /** An ASK's reply that is still wanted, or being recorded, given up. */
  function dropReply() {
    if (reply && onAudio === reply) dropListening();
    reply = null;
  }
  function dropListening() {
    clearTimeout(listenTimer); clearTimeout(clipTimer);
    if (listening) ctx.sendToRecorder("cancel-recording", { session });
    listening = false; clipDue = false;
    onAudio = null;
    finalWait = null;
    previewing = false;
    naming = 0;
    asking++;
  }
  const squash = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();
  /** The recorder's clip for the question it was recording, with what the
   *  stream heard of it (`text`). Handed on with the stream's final text:
   *  at once when that is already here, else once it comes, or after
   *  desktop.agent.finalTextMs, with the text there was. */
  function audioIn(p) {
    if (!p || p.session !== session) return;
    listening = false; clipDue = false; previewing = false;
    clearTimeout(listenTimer); clearTimeout(clipTimer);
    const take = onAudio; onAudio = null;
    const audio = p.data ? { mime: String(p.mime || "audio/webm"), data: Buffer.from(p.data) } : null;
    if (!take) return;
    // An ASK's reply, or a question that was not streamed: the clip is all.
    if (take === reply || !streamed) { take(audio, { text: "", final: false }); return; }
    const said = typeof p.text === "string" ? squash(p.text) : streamText;
    // No voice in the clip and no words in the stream: nobody said
    // anything, and there is nothing to wait for.
    if (!audio && !said) { take(null, { text: "", final: false }); return; }
    const w = finalWait = {
      go() {
        clearTimeout(w.timer);
        if (finalWait !== w) return;
        finalWait = null;
        // The final text, when it came and has words, is the stream's own
        // reading of the whole question; otherwise what it had so far.
        take(audio, finalText ? { text: finalText, final: true } : { text: said, final: false });
      },
      timer: null,
    };
    if (finalText !== null) { w.go(); return; }
    w.timer = soft(setTimeout(() => w.go(), Math.max(0, num("desktop.agent.finalTextMs", 400))));
  }
  /** The stream's final text (ask-text), for the question it was. */
  function textIn(p) {
    if (!p || !session || p.session !== session || !streamed) return;
    finalText = squash(p.text);
    if (finalWait) finalWait.go();
  }
  /** A partial: the question's words so far, shown to the agent (which may
   *  ring what they name, tentatively) while they are still being said.
   *  True when it was this question's, whether or not it was shown. */
  function partial(p) {
    if (!p || !session || p.session !== session) return false;
    // Only while the question is being said: the stream's last words after
    // the stop come as its final text, and change nothing on screen.
    if (!streamed || !listening) return true;
    streamText = squash(p.text);
    if (previewing) preview(streamText);
    return true;
  }
  function preview(text) {
    if (typeof agent.preview !== "function" || !agent.active()) return;
    try { agent.preview(text); } catch (e) { console.warn("[ask] preview failed:", (e && e.message) || e); }
  }

  // ---- the agent -------------------------------------------------------------
  // The driver, with its own Escape marked. KEY escape is posted as a real
  // key event, and the key hook that hears the person's Esc hears the
  // agent's too: without this, "close this dialog and open settings" was
  // stopped by its own first step.
  let selfEscUntil = 0;
  const driver = Object.create(ctx.driver, {
    key: {
      value: async (chord) => {
        const esc = /\besc(ape)?\b/i.test(String(chord));
        if (esc) selfEscUntil = Date.now() + 5000;
        try { return await ctx.driver.key(chord); } finally {
          if (esc) selfEscUntil = Date.now() + Math.max(0, num("desktop.agent.selfKeyMs", 600));
        }
      },
    },
  });
  // Handed in by the tests, which watch what the run is told; agent.js's own
  // otherwise.
  const agent = (ctx.createAgent || agentCore.createAgent)({
    driver,
    guide,
    post: agentCore.makePost({ baseUrl: ctx.baseUrl, token: ctx.token, fetch: ctx.fetch || ((...a) => fetch(...a)) }),
    paste: (text) => ctx.paste(text),
    // An ASK's answer: the microphone again, its clip back to the agent;
    // opened once the question has been said, or the microphone hears Blip
    // ask it, and a reply in ask mode ends at its first pause.
    listen: () => new Promise((resolve) => {
      onAudio = reply = resolve;
      afterSpeech().then(() => { if (onAudio === resolve && !listening && agent.active()) record(); });
    }),
    knob: (name, fallback) => {
      if (typeof fallback === "boolean") return bool(name, fallback);
      if (typeof fallback === "number") return num(name, fallback);
      return str(name, fallback);
    },
    // The language dictation is set to, so a question is heard and answered
    // in it too ("auto" and none are the server's own choice).
    language: () => (typeof ctx.language === "function" ? ctx.language() : ctx.language) || "",
    platform: platform === "win32" ? "win" : "mac",
    now: () => Date.now(),
    log: (...a) => console.log("[ask]", ...a),
    // The picture path: whether this app's pictures may go, the card that
    // asks, and the crop of the part asked about.
    pictures,
    permit,
    crop,
  });

  /** Where the pointer is, in the driver's units (UI Automation's are
   *  physical pixels), for "what's this?" said while pointing at it. */
  function pointerNow() {
    try {
      const p = screen.getCursorScreenPoint();
      if (pixels && typeof screen.dipToScreenPoint === "function") {
        const q = screen.dipToScreenPoint({ x: p.x, y: p.y });
        return { x: q.x, y: q.y };
      }
      return { x: p.x, y: p.y };
    } catch { return null; }
  }

  /** The window in front, or null when it could not be told. */
  const front = () => Promise.resolve().then(() => ctx.frontInfo()).catch(() => null);

  /** Alt twice. Starts a question; or, mid-question, ends it; or answers the
   *  card's Do it; or, while it works, stops it. The tray's "Ask about this
   *  screen" is the same, except that it is never Do it (`menu`): a menu
   *  item that says ask must not send or delete anything. */
  async function tap(opts) {
    const menu = !!(opts && opts.menu);
    if (confirmWait) {
      if (agent.active()) {
        // Do it, only for a card up long enough to have been read. The same
        // gesture while it works means stop, and a pair begun before the card
        // came up was that: approving it would send what they meant to stop.
        // 800 ms by default: the card takes a quarter of that to fade in,
        // and a pair is up to 400 ms long, so it was there to be read before
        // the pair's first tap.
        if (!menu && Date.now() - confirmAt >= Math.max(0, num("desktop.agent.confirmTapMs", 800))) confirmWait(true);
        else cancel("tap");
        return;
      }
      confirmWait(false);
    }
    // The picture card's own answers are its buttons. The gesture while it
    // is up means stop, as it does while a run works: a picture is never
    // sent on a pair of taps that may have been begun to stop it.
    if (permitWait) { cancel("tap"); return; }
    if (listening) { stopListening(); return; }
    if (agent.active() || onAudio || naming || finalWait) { cancel("tap"); return; }
    // One microphone: while a dictation records, it keeps it.
    if (ctx.dictating && ctx.dictating()) return;
    if (!ctx.requireAccount()) return;
    const mine = ++asking;
    // Where the pointer was at Alt twice, not wherever it has wandered by
    // the time the app is named.
    const pointer = pointerNow();
    let begun = false, early = null;
    const answer = (audio, said) => {
      const text = (said && said.text) || "";
      // The stream's words are a question too, when the clip itself is
      // missing (no recorder would start beside the stream).
      if (audio || text) { void agent.heard(audio, { text, final: !!(said && said.final) }); return; }
      // Nothing said: the run that was waiting for it ends, and the card says so.
      agent.cancel("not heard");
      cardError(txt("desktop.agent.notHeard", "I didn't catch that. Tap {key} twice and ask again.", { key: str("desktop.agent.tapKey", "Alt") }));
    };
    // A clip back before the run has begun (a short "undo", or Alt twice
    // again while the app was still being named) is held for it.
    onAudio = (audio, said) => { if (begun) answer(audio, said); else early = { audio, said }; };
    // The microphone first: what they say in the moment it takes to name the
    // app is not lost.
    record(true);
    // NOT KNOWING WHICH WINDOW IS NOT "FINE". A private window or a bank is
    // refused before anything is read, and a front window that could not be
    // named (System Events slow to wake or not allowed, the helper busy) may
    // be either: it is asked once more, and then refused like them.
    naming = mine;
    let info = await front();
    if (!info && mine === asking) info = await front();
    // Stopped (Esc, a dictation, a recorder error) while the app was being named.
    if (mine !== asking) return;
    naming = 0;
    if (!info) {
      dropListening();
      cardError(txt("desktop.agent.unknownWindow", "I couldn't tell which window this is, so I didn't look. Tap {key} twice to try again.", { key: str("desktop.agent.tapKey", "Alt") }));
      return;
    }
    begun = true;
    agent.begin({ app: info.label || "", privateField: !!info.private, sensitive: !!info.sensitive, pointer });
    if (!agent.active()) { dropListening(); return; }   // refused: a private window, a bank
    if (early) { const a = early; early = null; answer(a.audio, a.said); return; }
    // Still being said: the words so far (spoken while the app was being
    // named) are shown to it now, and every partial after them as it comes.
    previewing = listening;
    if (previewing && streamText) preview(streamText);
  }
  function cancel(reason) {
    dropListening();
    if (confirmWait) confirmWait(false);
    if (permitWait) permitWait("no");
    agent.cancel(reason);
    hide();
  }

  // ---- from the guide window ---------------------------------------------------------
  const fromGuide = (e) => !!win && !win.isDestroyed() && e.sender === win.webContents;
  ipcMain.on("guide:mouse", (e, inside) => {
    if (!fromGuide(e)) return;
    if (inside) win.setIgnoreMouseEvents(false);
    else win.setIgnoreMouseEvents(true, { forward: true });
  });
  ipcMain.on("guide:confirm", (e, yes) => { if (fromGuide(e) && confirmWait) confirmWait(!!yes); });
  ipcMain.on("guide:permit", (e, choice) => { if (fromGuide(e) && permitWait) permitWait(String(choice || "")); });
  ipcMain.on("guide:dismiss", (e) => { if (fromGuide(e)) cancel("dismiss"); });
  ipcMain.on("guide:spoken", (e) => { if (fromGuide(e) && spokenWait) spokenWait(); });

  return {
    tap,
    cancel,
    audioIn,
    textIn,
    partial,
    /** The recorder's pause, for the question it is recording. */
    paused(p) { if (p && p.session === session && listening) stopListening(); },
    /** The voice's level, for the dots. */
    level(p) {
      if (!p || p.session !== session || !listening || !Array.isArray(p.bands)) return false;
      const v = p.bands.reduce((a, b) => a + (Number(b) || 0), 0) / Math.max(1, p.bands.length);
      send({ type: "level", v });
      return true;
    },
    /** A recorder error for the question: said on the card, not as a toast. */
    error(p) {
      if (!p || p.session !== session) return false;
      listening = false; clipDue = false; onAudio = null; naming = 0;
      finalWait = null; previewing = false;
      clearTimeout(listenTimer); clearTimeout(clipTimer);
      asking++;
      if (agent.active()) agent.cancel("recorder");
      cardError(String(p.message || ""));
      return true;
    },
    /** The recorder's page crashed: a question it was recording will not come back. */
    recorderGone() { if (clipDue) noClip(); },
    owns(sid) { return sid === session && sid !== 0; },
    active: () => listening || !!onAudio || !!naming || !!finalWait || agent.active(),
    escape() {
      // The agent's own Escape, heard by the same hook: for a moment after
      // it sends one, an Esc is its, not theirs.
      if (Date.now() < selfEscUntil) return false;
      if (listening || onAudio || naming || finalWait || agent.active() || confirmWait || permitWait) { cancel("esc"); return true; }
      return false;
    },
  };
}

module.exports = { createAsk };
