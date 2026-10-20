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
      const text = typeof data === "string" ? data : "";
      if (s === "acting") { send({ type: "state", state: "doing", label: text }); return; }
      // Over (its deadline, say) while an ASK's reply records: that
      // microphone has nobody left to answer.
      if (s === "done") dropReply();
      send({ type: "state", state: s });
      if (s === "done" && text) guide.say(text);
    },
    heard(t) { send({ type: "heard", text: String(t || "") }); },
    say(t, opts) {
      const text = String(t || "");
      if (!text) return;
      send({ type: "say", text });
      if (bool("desktop.agent.speak", true)) sayAloud(text, opts || {});
    },
    point(frame, caption) {
      const r = dip(frame);
      if (!r) return;
      // The ring is on another display: the guide goes there. Found from the
      // DIP rectangle, as displays are: on a scaled display a physical pixel
      // position can lie in the next display's DIP, and the guide would move
      // there and draw the ring off its own edge.
      const d = displayFor({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
      if (!sameRect(bounds, areaOf(d))) { ensureWindow(d); showWindow(); }
      send({ type: "point", frame: local(r), caption: caption || "" });
    },
    unpoint() { send({ type: "unpoint" }); },
    steps(items) { send({ type: "steps", items: items || [] }); },
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

  // ---- the microphone ------------------------------------------------------------
  function record() {
    if (!ctx.recorderReady()) ctx.createRecorderWindow();
    // Nothing is said while a question records: the microphone would hear it.
    quiet();
    session = ctx.nextSession();
    listening = true;
    clipDue = true;
    clearTimeout(clipTimer);
    ctx.sendToRecorder("start-recording", Object.assign(ctx.recorderStart(session), { live: false, pauseFlush: false, mode: "ask" }));
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
  /** The question's clip will not come: whoever waits for it gets nothing. */
  function noClip() {
    clearTimeout(listenTimer); clearTimeout(clipTimer);
    listening = false; clipDue = false;
    const take = onAudio; onAudio = null;
    if (take) take(null);
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
    naming = 0;
    asking++;
  }
  /** The recorder's clip for the question it was recording. */
  function audioIn(p) {
    if (!p || p.session !== session) return;
    listening = false; clipDue = false;
    clearTimeout(listenTimer); clearTimeout(clipTimer);
    const take = onAudio; onAudio = null;
    const audio = p.data ? { mime: String(p.mime || "audio/webm"), data: Buffer.from(p.data) } : null;
    if (take) take(audio);
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
  const agent = agentCore.createAgent({
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
  });

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
    if (listening) { stopListening(); return; }
    if (agent.active() || onAudio || naming) { cancel("tap"); return; }
    // One microphone: while a dictation records, it keeps it.
    if (ctx.dictating && ctx.dictating()) return;
    if (!ctx.requireAccount()) return;
    const mine = ++asking;
    let begun = false, early = null;
    const answer = (audio) => {
      if (audio) { void agent.heard(audio); return; }
      // Nothing said: the run that was waiting for it ends, and the card says so.
      agent.cancel("not heard");
      cardError(txt("desktop.agent.notHeard", "I didn't catch that. Tap {key} twice and ask again.", { key: str("desktop.agent.tapKey", "Alt") }));
    };
    // A clip back before the run has begun (a short "undo", or Alt twice
    // again while the app was still being named) is held for it.
    onAudio = (audio) => { if (begun) answer(audio); else early = { audio }; };
    // The microphone first: what they say in the moment it takes to name the
    // app is not lost.
    record();
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
    agent.begin({ app: info.label || "", privateField: !!info.private, sensitive: !!info.sensitive });
    if (!agent.active()) { dropListening(); return; }   // refused: a private window, a bank
    if (early) { const a = early.audio; early = null; answer(a); }
  }
  function cancel(reason) {
    dropListening();
    if (confirmWait) confirmWait(false);
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
  ipcMain.on("guide:dismiss", (e) => { if (fromGuide(e)) cancel("dismiss"); });
  ipcMain.on("guide:spoken", (e) => { if (fromGuide(e) && spokenWait) spokenWait(); });

  return {
    tap,
    cancel,
    audioIn,
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
      clearTimeout(listenTimer); clearTimeout(clipTimer);
      asking++;
      if (agent.active()) agent.cancel("recorder");
      cardError(String(p.message || ""));
      return true;
    },
    /** The recorder's page crashed: a question it was recording will not come back. */
    recorderGone() { if (clipDue) noClip(); },
    owns(sid) { return sid === session && sid !== 0; },
    active: () => listening || !!onAudio || !!naming || agent.active(),
    escape() {
      // The agent's own Escape, heard by the same hook: for a moment after
      // it sends one, an Esc is its, not theirs.
      if (Date.now() < selfEscUntil) return false;
      if (listening || onAudio || naming || agent.active() || confirmWait) { cancel("esc"); return true; }
      return false;
    },
  };
}

module.exports = { createAsk };
