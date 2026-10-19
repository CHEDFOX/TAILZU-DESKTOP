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

  let win = null;          // the guide's window
  let bounds = null;       // where it is, in screen DIP
  let ready = false;
  const queue = [];        // what to send once it has loaded
  let session = 0;         // the recorder session that is a question, while one records
  let listening = false;
  let listenTimer = null;
  let onAudio = null;      // who the next recorded question is for (begin, or an ASK's reply)
  let confirmWait = null;  // the card's Do it / Not now, while it is up
  // The driver's units: UI Automation reports physical pixels, AX reports
  // points, which are already Electron's DIP.
  const pixels = process.platform === "win32";
  let hideTimer = null;

  // ---- the window ---------------------------------------------------------------
  function displayFor(pt) {
    return pt ? screen.getDisplayNearestPoint({ x: Math.round(pt.x), y: Math.round(pt.y) }) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  }
  function ensureWindow(display) {
    const wa = display.workArea;
    if (win && !win.isDestroyed()) {
      if (!bounds || bounds.x !== wa.x || bounds.y !== wa.y || bounds.width !== wa.width || bounds.height !== wa.height) {
        bounds = Object.assign({}, wa);
        ctx.setBoundsExactly(win, bounds);
      }
      return win;
    }
    bounds = Object.assign({}, wa);
    ready = false;
    // THE PILL'S RECIPE: never focused (the app you asked about keeps the
    // keyboard, and a paste still lands in it), click-through except over the
    // card, over full-screen apps and every Space. The work area, not the
    // whole display: a topmost window over the taskbar too reads to Windows
    // as a full-screen app, and it holds back notifications for one.
    win = new BrowserWindow(Object.assign({}, bounds, {
      frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
      focusable: false, resizable: false, movable: false, hasShadow: false, show: false,
      ...(process.platform === "darwin" ? { type: "panel" } : {}),
      webPreferences: ctx.webPrefs({ backgroundThrottling: false }),
    }));
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true }); } catch { /* one space */ }
    win.setIgnoreMouseEvents(true, { forward: true });
    // Off by default: someone sharing their screen to show a colleague
    // "where's export" should be seen being shown. A knob for those who want
    // the guide out of every capture.
    if (bool("desktop.guide.contentProtection", false)) { try { win.setContentProtection(true); } catch { /* unsupported */ } }
    ctx.hardenWindow(win);
    win.webContents.once("did-finish-load", () => { ready = true; for (const m of queue.splice(0)) win.webContents.send("guide", m); });
    win.on("closed", () => { win = null; ready = false; });
    win.loadFile("guide.html");
    return win;
  }
  function send(m) {
    if (!win || win.isDestroyed()) return;
    if (ready) win.webContents.send("guide", m); else queue.push(m);
  }
  function showWindow() {
    if (!win || win.isDestroyed()) return;
    if (!win.isVisible()) win.showInactive();
    ctx.raisePill(win);
  }
  /** A screen frame (the driver's units) as the guide window's own DIP. */
  function local(frame) {
    if (!Array.isArray(frame) || frame.length !== 4 || !bounds) return null;
    let [x, y, w, h] = frame.map(Number);
    if (pixels) {
      const r = screen.screenToDipRect(null, { x, y, width: w, height: h });
      x = r.x; y = r.y; w = r.width; h = r.height;
    }
    return [x - bounds.x, y - bounds.y, w, h];
  }
  function localPoint(p) { return p && bounds ? { x: p.x - bounds.x, y: p.y - bounds.y } : null; }

  // ---- what the agent drives ---------------------------------------------------
  // What agent.js calls (its §3 guide), turned into the guide window's
  // messages. When the card goes away is the agent's to say (hide), except
  // for what only this file knows about (a question nobody said: notHeard).
  let shown = false;
  const guide = {
    show(state, data) {
      clearTimeout(hideTimer);
      const anchor = (data && data.anchor) || screen.getCursorScreenPoint();
      ensureWindow(displayFor(anchor));
      showWindow();
      shown = true;
      send({ type: "show", state, app: (data && data.app) || "", anchor: localPoint(anchor), key: str("desktop.agent.tapKey", "Alt") });
    },
    // listening / thinking / acting (with what it is doing) / done (with
    // what it has to say about it).
    state(s, data) {
      const text = typeof data === "string" ? data : "";
      if (s === "acting") { send({ type: "state", state: "doing", label: text }); return; }
      send({ type: "state", state: s });
      if (s === "done" && text) guide.say(text);
    },
    heard(t) { send({ type: "heard", text: String(t || "") }); },
    say(t, opts) {
      const text = String(t || "");
      if (!text) return;
      send({ type: "say", text });
      if (bool("desktop.agent.speak", true)) void voice(text, opts || {});
    },
    point(frame, caption) {
      const f = local(frame);
      if (!f) return;
      // The ring is on another display: the guide goes there.
      const cx = frame[0] + frame[2] / 2, cy = frame[1] + frame[3] / 2;
      const d = displayFor({ x: cx, y: cy });
      if (!bounds || d.workArea.x !== bounds.x || d.workArea.y !== bounds.y) { ensureWindow(d); showWindow(); }
      send({ type: "point", frame: local(frame), caption: caption || "" });
    },
    unpoint() { send({ type: "unpoint" }); },
    steps(items) { send({ type: "steps", items: items || [] }); },
    confirm(text, risk) {
      if (confirmWait) confirmWait(false);
      send({ type: "confirm", text: String(text || ""), risk: risk === "always" ? "always" : "confirm" });
      return new Promise((resolve) => { confirmWait = (yes) => { confirmWait = null; resolve(!!yes); }; });
    },
    hide() { hide(); },
    error(msg) {
      // Refused before anything was shown (a private window): the card
      // comes up to say so.
      if (!shown) guide.show("error", {});
      send({ type: "state", state: "error" });
      if (msg) send({ type: "say", text: String(msg) });
    },
  };
  /** An error only this file knows of, on a card it then puts away itself. */
  function notHeard(msg) {
    guide.error(msg);
    later(num("desktop.agent.doneMs", 9000));
  }
  function later(ms) { clearTimeout(hideTimer); hideTimer = setTimeout(() => { if (!agent.active()) hide(); }, ms); }
  function hide() {
    clearTimeout(hideTimer);
    shown = false;
    if (confirmWait) confirmWait(false);
    send({ type: "hush" });
    send({ type: "hide" });
    // Gone, once Blip has ducked and the card has faded.
    setTimeout(() => { if (win && !win.isDestroyed() && !agent.active()) { win.setIgnoreMouseEvents(true, { forward: true }); win.hide(); } }, 520);
  }

  /** The answer out loud: the server's voice (the read-aloud voice chosen in
   *  Settings, any language), as the desk's voice session does; the
   *  built-in one, with a real locale, if that fails. */
  async function voice(text, opts) {
    const rate = num("desktop.agent.voiceRate", 1.04);
    if (bool("desktop.agent.serverVoice", true)) {
      try {
        const res = await ctx.authorizedFetch("/v1/speak", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, format: "mp3" }),
        });
        if (res.ok) {
          const audio = new Uint8Array(await res.arrayBuffer());
          send({ type: "voice", audio, mime: "audio/mpeg" });
          return;
        }
      } catch { /* the built-in voice */ }
    }
    send({ type: "voice", text, speak: true, locale: opts.locale || "", rate });
  }

  // ---- the microphone ------------------------------------------------------------
  function record() {
    if (!ctx.recorderReady()) ctx.createRecorderWindow();
    session = ctx.nextSession();
    listening = true;
    ctx.sendToRecorder("start-recording", Object.assign(ctx.recorderStart(session), { live: false, pauseFlush: false, mode: "ask" }));
    clearTimeout(listenTimer);
    listenTimer = setTimeout(stopListening, num("desktop.agent.listenMaxMs", 15000));
  }
  function stopListening() {
    clearTimeout(listenTimer);
    if (!listening) return;
    listening = false;
    ctx.sendToRecorder("stop-recording", { session });
  }
  function dropListening() {
    clearTimeout(listenTimer);
    if (listening) ctx.sendToRecorder("cancel-recording", { session });
    listening = false;
    onAudio = null;
  }
  /** The recorder's clip for the question it was recording. */
  function audioIn(p) {
    if (!p || p.session !== session) return;
    listening = false;
    clearTimeout(listenTimer);
    const take = onAudio; onAudio = null;
    const audio = p.data ? { mime: String(p.mime || "audio/webm"), data: Buffer.from(p.data) } : null;
    if (take) take(audio);
  }

  // ---- the agent -------------------------------------------------------------
  const agent = agentCore.createAgent({
    driver: ctx.driver,
    guide,
    post: agentCore.makePost({ baseUrl: ctx.baseUrl, token: ctx.token, fetch: ctx.fetch || ((...a) => fetch(...a)) }),
    paste: (text) => ctx.paste(text),
    // An ASK's answer: the microphone again, its clip back to the agent.
    listen: () => new Promise((resolve) => { onAudio = resolve; record(); }),
    knob: (name, fallback) => {
      if (typeof fallback === "boolean") return bool(name, fallback);
      if (typeof fallback === "number") return num(name, fallback);
      return str(name, fallback);
    },
    platform: process.platform === "win32" ? "win" : "mac",
    now: () => Date.now(),
    log: (...a) => console.log("[ask]", ...a),
  });

  /** Alt twice. Starts a question; or, mid-question, ends it; or answers the
   *  card's Do it; or, while it works, stops it. */
  async function tap() {
    if (confirmWait) { confirmWait(true); return; }
    if (listening) { stopListening(); return; }
    if (agent.active()) { cancel("tap"); return; }
    if (!ctx.requireAccount()) return;
    onAudio = (audio) => {
      if (audio) { void agent.heard(audio); return; }
      // Nothing said: the run that was waiting for it ends, and the card says so.
      agent.cancel("not heard");
      notHeard(txt("desktop.agent.notHeard", "I didn't catch that. Tap {key} twice and ask again.", { key: str("desktop.agent.tapKey", "Alt") }));
    };
    // The microphone first: what they say in the moment it takes to name the
    // app is not lost.
    record();
    const info = await ctx.frontInfo().catch(() => null);
    // Stopped (Esc, a dictation) while the app was being named.
    if (!listening || !onAudio) return;
    agent.begin({ app: info ? info.label : "", privateField: !!(info && info.private), sensitive: !!(info && info.sensitive) });
    if (!agent.active()) dropListening();   // refused: a private window, a bank
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
  ipcMain.on("guide:spoken", () => {});

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
      listening = false; onAudio = null; clearTimeout(listenTimer);
      if (agent.active()) agent.cancel("recorder");
      notHeard(String(p.message || ""));
      return true;
    },
    owns(sid) { return sid === session && sid !== 0; },
    active: () => listening || agent.active(),
    escape() { if (listening || agent.active() || confirmWait) { cancel("esc"); return true; } return false; },
  };
}

module.exports = { createAsk };
