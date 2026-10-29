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
 * The card grows out of the pill (main.js pillAsk): the pill's halves part,
 * the card is opened on the pill's display and tied to it by a thread, and
 * the pill's bead follows the card's phase until the card folds back into it.
 * While it explains, the answer may mark up the screen (draw), in the guide
 * window's own coordinates.
 *
 * The same window also carries Blip while a dictation records (peek): small,
 * over the text box at the cursor, reading over their shoulder, and gone when
 * the words have landed. createPeekWatch below is what asks where the cursor
 * is while the dictation runs (main.js wires it to dictation's moments); the
 * peek itself only ever shows when no question has the guide.
 *
 * And the main process's side of Ask's one-time setup card in the app window
 * (createAskSetup): what is allowed on this computer, and the card's buttons.
 *
 * Kept apart from main.js, with everything it needs handed in, so the order
 * of what happens can be read in one place and tested without Electron.
 */
const agentCore = require("./agent.js");

// ---- the pill (main.js pillAsk) ------------------------------------------------------
// A question grows out of the pill: its halves part, and the guide's thread
// rises from the gap to the card (pill.js "ask", guide.js dock). These two
// are main.js's rules for that, kept here, without Electron, so they can be
// tested.
const PILL_PHASES = new Set(["listening", "thinking", "showing", "closing"]);

/**
 * What a question may do with the pill, given what the pill is doing now
 * (`now`: { state: main's pill state, recording, first }). `first`: this
 * is a question's first phase (its card's show).
 *
 * DICTATION ALWAYS WINS THE PILL. While one records or writes, nothing
 * changes. Closing, and giving it back (null), touch only a pill that is
 * still the question's: a dictation that started meanwhile owns it, and
 * putting it back to rest under that dictation would hide it listening.
 *
 *   null     leave it as it is
 *   "rest"   give it back
 *   "ask"    the next phase of the question that has it
 *   "take"   the first phase: put on the display under the cursor first
 *
 * A new question asked while the last card is still up or folding finds the
 * pill already "ask", and is still a first phase: it is put under the cursor
 * again, or the new card opened on the display the last one was on, while
 * they looked at another.
 */
function pillAskMove(phase, now) {
  const o = now || {};
  if (o.recording || o.state === "listening" || o.state === "writing") return null;
  if (phase == null) return o.state === "ask" ? "rest" : null;
  if (!PILL_PHASES.has(phase)) return null;
  if (o.state === "ask") return o.first && phase !== "closing" ? "take" : "ask";
  return phase === "closing" ? null : "take";
}

/**
 * The pill's capsule in screen DIP, for a pill window whose bounds are `b`:
 * centred across it, its bottom desktop.pill.bottomPad above the window's,
 * exactly where pill.js draws it, from the same knobs pill.js reads. The
 * small pill's size when the capsule look is off, or the Bots look is on.
 */
function capsuleRect(b, K) {
  if (!b || ![b.x, b.y, b.width, b.height].every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  // The Bots look (bots.app) has no capsule: the small white pill (pill.js botsTargets).
  const capsule = !K.bool("bots.app", false) && K.bool("desktop.pill.split", true) && K.bool("desktop.pill.capsule", true);
  const w = capsule ? K.num("desktop.pill.capsuleWidth", 40) : K.num("desktop.pill.restWidth", 46);
  const h = capsule ? K.num("desktop.pill.capsuleHeight", 16) : K.num("desktop.pill.restHeight", 14);
  return { x: b.x + b.width / 2 - w / 2, y: b.y + b.height - K.num("desktop.pill.bottomPad", 14) - h, w, h };
}

// What the guide can draw (guide.js draw).
const MARKS = new Set(["box", "circle", "underline", "highlight", "arrow", "number", "label", "path"]);
// The ones drawn round (or under, or over) a frame.
const FRAMED = new Set(["box", "circle", "underline", "highlight"]);

// What a peek can be doing (guide.js peek): watching the words go in while
// the microphone is open, watching the last of them be written, and the
// little hop when they have landed.
const PEEK_STATES = new Set(["listening", "writing", "done"]);
// How long the guide takes to duck Blip back below the edge (guide.js
// PEEK_DUCK, 300 ms, and a frame or two for its loop to finish): the window
// is hidden once it has, not while Blip is still going down in it.
const PEEK_GONE_MS = 340;
/** A caret or field frame as the driver gave it, [x, y, w, h], or null when
 *  it is not one: numbers that are not finite, or far past any screen (a
 *  helper's garbage), a negative width, no height. */
function peekFrame(f) {
  if (!Array.isArray(f) || f.length !== 4) return null;
  if (!f.every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1e6)) return null;
  return f[2] >= 0 && f[3] > 0 ? f.slice() : null;
}

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
  let offered = null;      // the button on the card that is up (guide offer), until it is clicked or the card goes
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
  let goneTimer = null;    // the window itself going, after the card has folded away
  // THE PILL, while a question has it (main.js pillAsk): the phase it was
  // last given (null once it is given back), and where its capsule is, in
  // screen DIP, as main last said. The card is opened on that display and
  // tied to it (dock).
  let pillPhase = null;
  let pillAt = null;
  let drawSeq = 0;         // the marks' ids, d1, d2, ...: never reused, so one fading out is never taken for a new one
  let marksHere = 0;       // marks drawn on the guide's display since it was put there, or last cleared
  // THE PEEK, while a dictation records: Blip is up (or ducking) over a text
  // box in the guide's window, and the window's going once it has ducked.
  let peeking = false;
  let peekGone = null;
  // The last look said the Mac has not let Tailzu see the screen
  // (no_screen_permission), until a look says otherwise: the setup card's
  // "Restart Tailzu to finish" when the system says it has.
  let screenDenied = false;
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
  /** The guide's window over `display`, made or moved there. True when it
   *  was (and the card has been told its new area, and where the pill is
   *  from there); false when it was already there. */
  function ensureWindow(display) {
    const area = areaOf(display);
    if (win && !win.isDestroyed()) {
      if (!sameRect(bounds, area)) {
        bounds = Object.assign({}, area);
        ctx.setBoundsExactly(win, bounds);
        // The marks up were drawn in the window's coordinates on the display
        // it has left: kept, a circle round a menu on one screen went on
        // being drawn on the other, round whatever was there. They go; the
        // answer draws on in this one's.
        send({ type: "clear" });
        marksHere = 0;
        send({ type: "area", inset: insetOf(display, bounds) });
        dock();
        return true;
      }
      return false;
    }
    bounds = Object.assign({}, area);
    ready = false;
    queue.length = 0;
    marksHere = 0;
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
      clearTimeout(goneTimer); goneTimer = null;
      // A peek in it went with it; the next caret builds a new one.
      peeking = false; clearTimeout(peekGone); peekGone = null;
      try { w.destroy(); } catch { /* already gone */ }
      // Nothing is left to fold back into the pill: it is given back at once.
      cancel("guide gone");
    });
    // Only this window's own close: a late one from a window already
    // replaced must not forget the new one.
    w.on("closed", () => { if (win === w) { win = null; ready = false; bounds = null; } });
    w.loadFile("guide.html");
    send({ type: "area", inset: insetOf(display, bounds) });
    dock();
    return true;
  }
  function send(m) {
    if (!win || win.isDestroyed()) return;
    if (ready) win.webContents.send("guide", m); else queue.push(m);
  }
  // main.js hands in a raise that leaves the pill over the guide: the thread
  // comes out of the gap between the pill's halves only if the pill is drawn
  // over its first few pixels (main.js raiseGuide).
  function showWindow() {
    if (!win || win.isDestroyed()) return;
    clearTimeout(goneTimer); goneTimer = null;
    if (!win.isVisible()) win.showInactive();
    ctx.raisePill(win);
    feedCursor();
  }

  // Where the pointer is, in the window's own coordinates, ten times a second
  // while the window is up and only when it moved: the card works out from it
  // whether it is under the pointer (guide.js TAKING CLICKS), which a pointer
  // that has not moved since the card arrived could never tell it otherwise.
  // It stops by itself once the window is hidden or gone.
  let cursorTimer = null;
  let cursorLast = "";
  function feedCursor() {
    if (cursorTimer) return;
    cursorTimer = setInterval(() => {
      try {
        if (!win || win.isDestroyed() || !win.isVisible()) { clearInterval(cursorTimer); cursorTimer = null; cursorLast = ""; return; }
        const p = screen.getCursorScreenPoint();
        const b = win.getBounds();
        const key = `${p.x - b.x},${p.y - b.y}`;
        if (key === cursorLast) return;
        cursorLast = key;
        send({ type: "cursor", x: p.x - b.x, y: p.y - b.y });
      } catch { clearInterval(cursorTimer); cursorTimer = null; cursorLast = ""; }
    }, 100);
    if (cursorTimer && cursorTimer.unref) cursorTimer.unref();
  }

  // ---- the pill ------------------------------------------------------------------
  /** Docked: on, and there is a pill to dock to. With desktop.guide.dock off
   *  the card is what it was before it had one, and the pill is left alone. */
  const docking = () => typeof ctx.pillAsk === "function" && bool("desktop.guide.dock", true);
  /**
   * The pill to a phase of the question: "listening", "thinking", "showing",
   * "closing". Main says no while a dictation has it (null). Each phase once:
   * the same one again is asked of main only when the card needs to know
   * where the pill is now (`fresh`, at show, which is always a question's
   * first phase: main puts the pill under the cursor for it). Returns the
   * capsule in screen DIP, or null.
   */
  function pillTo(phase, fresh) {
    if (!docking()) return null;
    // Never had it: there is nothing to close.
    if (phase === "closing" && pillPhase === null) return null;
    if (!fresh && phase === pillPhase) return pillAt;
    let r = null;
    try { r = ctx.pillAsk(phase, !!fresh); } catch (e) { console.warn("[ask] the pill would not take the question:", (e && e.message) || e); }
    pillPhase = phase;
    if (phase !== "closing") {
      const ok = r && [r.x, r.y, r.w, r.h].every((v) => typeof v === "number" && Number.isFinite(v)) && r.w > 0 && r.h > 0;
      const was = pillAt;
      pillAt = ok ? { x: r.x, y: r.y, w: r.w, h: r.h } : null;
      // Taken back mid-card (an error of dictation's said on the pill, "Out
      // of words this month", then the next phase), main puts it under the
      // cursor again, which can be elsewhere: the card is told, or its
      // thread would go on rising from where the pill was. At show the
      // caller tells it.
      if (!fresh && shown && !sameCapsule(was, pillAt)) dock();
    }
    return pillAt;
  }
  const sameCapsule = (a, b) => (!a && !b) || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);
  /** The next phase, for a card that is up; nothing for one put away. */
  function phaseTo(phase) { if (shown) pillTo(phase); }
  /** The pill back to dictation: at rest, unless a dictation has it by now. */
  function letPill() {
    if (pillPhase === null) return;
    pillPhase = null; pillAt = null;
    try { ctx.pillAsk(null); } catch (e) { console.warn("[ask] the pill would not let go:", (e && e.message) || e); }
  }
  /**
   * Tell the card where the pill is, in its window's own coordinates, so it
   * grows from it (guide.js dock). `pill: null` when no question has the pill
   * (off, or a dictation's): the card grows from a seed of its own. And
   * `seed: false` with it when the pill is on another display than the guide
   * (a ring there took it there): no seed, no tether, the card placed as it
   * was before it had a pill. The pill never follows the guide.
   */
  function dock() {
    if (!bounds) return;
    const r = pillAt;
    if (!r) { send({ type: "dock", pill: null }); return; }
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const here = cx >= bounds.x && cx < bounds.x + bounds.width && cy >= bounds.y && cy < bounds.y + bounds.height;
    send(here ? { type: "dock", pill: { x: r.x - bounds.x, y: r.y - bounds.y, w: r.w, h: r.h } } : { type: "dock", pill: null, seed: false });
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
  /** A screen point (the driver's units, [x, y]) in screen DIP, or null. */
  function dipPoint(pt) {
    if (!Array.isArray(pt) || pt.length !== 2) return null;
    let [x, y] = pt.map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (pixels && typeof screen.screenToDipPoint === "function") {
      try {
        const q = screen.screenToDipPoint({ x: Math.round(x), y: Math.round(y) });
        x = q.x; y = q.y;
      } catch { /* as it is: right on a display at 100% */ }
    }
    return { x, y };
  }
  /** A DIP rectangle as the guide window's own coordinates. */
  function local(r) { return r && bounds ? [r.x - bounds.x, r.y - bounds.y, r.w, r.h] : null; }
  function localPoint(p) { return p && bounds ? { x: p.x - bounds.x, y: p.y - bounds.y } : null; }

  // ---- the marks -----------------------------------------------------------------
  // What the agent draws (agent.js draw) comes in the driver's units, frames
  // [x, y, w, h] and points [x, y], and goes to the guide in its window's own.
  // A mark is drawn where the guide is or not at all: one with any part off
  // its window is dropped. The window moves for a mark only when it is the
  // first on the guide's display and lies on another (draw): the card opens
  // on the pill's display, under the pointer, and the app asked about can
  // be on the next one, where every mark of an answer that only draws
  // ("1, 2, 3") was dropped.
  const onWindow = {
    frame: (f) => !!bounds && f[2] >= 0 && f[3] >= 0 && f[0] < bounds.width && f[1] < bounds.height && f[0] + f[2] > 0 && f[1] + f[3] > 0,
    point: (p) => !!bounds && p[0] >= 0 && p[1] >= 0 && p[0] <= bounds.width && p[1] <= bounds.height,
  };
  function markFrame(f) {
    const r = dip(f), l = r && local(r);
    return l && onWindow.frame(l) ? l : null;
  }
  function markPoint(p) {
    const q = dipPoint(p), l = q && bounds ? [q.x - bounds.x, q.y - bounds.y] : null;
    return l && onWindow.point(l) ? l : null;
  }
  /** A frame or a point, by its length, as the guide's own. */
  const markSpot = (s) => (Array.isArray(s) && s.length === 4 ? markFrame(s) : markPoint(s));
  /** The guide's draw message for a mark, or null when it is not to be drawn. */
  function markOf(mark) {
    const m = mark && typeof mark === "object" ? mark : {};
    const kind = String(m.kind || "");
    if (!MARKS.has(kind) || !bounds) return null;
    const out = { type: "draw", id: "", kind };
    if (m.frame != null) { if (!(out.frame = markFrame(m.frame))) return null; }
    if (m.at != null) { if (!(out.at = markSpot(m.at))) return null; }
    if (m.from != null || m.to != null) {
      out.from = markSpot(m.from); out.to = markSpot(m.to);
      if (!out.from || !out.to) return null;
    }
    if (m.points != null) {
      if (!Array.isArray(m.points) || m.points.length < 2) return null;
      out.points = m.points.map(markPoint);
      if (out.points.some((p) => !p)) return null;
    }
    // Somewhere to draw it, of the kind it needs: a ring, a line under or a
    // swipe over goes round a frame, an arrow from one place to another, a
    // path through its points. The guide draws what it is sent, and a box
    // sent only a point had nothing to go round.
    if (FRAMED.has(kind) ? !out.frame : kind === "arrow" ? !out.from : kind === "path" ? !out.points : !out.frame && !out.at) return null;
    if (m.closed === true) out.closed = true;
    const n = Math.round(Number(m.n));
    if (Number.isFinite(n) && n >= 1 && n <= 9) out.n = n;
    // A number is its numeral (the card's step 2 is the badge "2"), and a
    // label is its words: without them there is nothing to show.
    else if (kind === "number") return null;
    const text = typeof m.text === "string" ? m.text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim().slice(0, 48) : "";
    if (text) out.text = text;
    else if (kind === "label") return null;
    return out;
  }
  /** Where a mark is, in screen DIP: the middle of its frame, or its first
   *  point. Null when it has no place to be, or is no mark the guide draws. */
  function markPlace(mark) {
    const m = mark && typeof mark === "object" ? mark : {};
    if (!MARKS.has(String(m.kind || ""))) return null;
    const s = [m.frame, m.at, m.from, Array.isArray(m.points) ? m.points[0] : null].find((v) => Array.isArray(v));
    if (!s) return null;
    if (s.length === 4) { const r = dip(s); return r && { x: r.x + r.w / 2, y: r.y + r.h / 2 }; }
    return dipPoint(s);
  }

  // ---- what the agent drives ---------------------------------------------------
  // What agent.js calls (its §3 guide), turned into the guide window's
  // messages. When the card goes away is the agent's to say (hide), except
  // for what only this file knows about (a question nobody said: cardError).
  let shown = false;
  /** A card with a question on it, and the wait for its answer: `pick` turns
   *  what the guide (or Alt twice) answered into what the agent is given,
   *  `silent` is what no answer is. */
  function holdCard(message, pick, silent) {
    if (confirmWait) confirmWait(false);
    phaseTo("showing");
    send(message);
    confirmAt = Date.now();
    return new Promise((resolve) => {
      let timer = null;
      const answer = (yes) => {
        clearTimeout(timer);
        if (confirmWait === answer) confirmWait = null;
        resolve(pick(yes));
      };
      confirmWait = answer;
      // The agent stops waiting after confirmMs, and so does the card: a
      // wait left open would take the next Alt twice, meant as a new
      // question, as the answer to one nobody is asking any more.
      timer = soft(setTimeout(() => answer(false), Math.max(0, num("desktop.agent.confirmMs", 30000))));
    }).then((v) => v, () => silent);
  }
  const guide = {
    show(state, data) {
      clearTimeout(hideTimer);
      if (confirmWait) confirmWait(false);
      if (permitWait) permitWait("no");
      offered = null;
      // A question has the guide now: the guide ends any peek itself on show,
      // and the window stays for the card.
      peeking = false; clearTimeout(peekGone); peekGone = null;
      // A new card: whatever the last one was still saying stops.
      quiet();
      // THE CARD GROWS OUT OF THE PILL. The pill first: main parts it on the
      // display under the cursor (on the question's first phase) and says
      // where it is. The guide opens on that display, told where the pill is
      // before it shows anything, so the thread starts from it. Without a
      // pill (off, or a dictation's), the cursor's display, as before.
      const r = pillTo(state === "listening" || state === "thinking" ? state : "showing", true);
      const anchor = (data && data.anchor) || screen.getCursorScreenPoint();
      if (!ensureWindow(displayFor(r ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : anchor))) dock();
      showWindow();
      shown = true;
      // The key that answers the card: the one key, tapped once, or Ask's own pair.
      send({ type: "show", state, app: (data && data.app) || "", anchor: localPoint(anchor), key: oneKeyName() || str("desktop.agent.tapKey", "Alt"), once: !!oneKeyName() });
    },
    // listening / thinking / acting (with what it is doing) / done (with
    // what it has to say about it).
    state(s, data) {
      // Whatever the agent says next, it has stopped waiting on the card: it
      // was answered, or its confirmMs or the run's deadline ran out.
      if (confirmWait) confirmWait(false);
      if (permitWait) permitWait("no");
      const text = typeof data === "string" ? data : "";
      // The pill's bead follows: amber while the microphone is open (an
      // ASK's reply opens it again), cream while it thinks, and while it
      // shows what it has (acting, done).
      phaseTo(s === "listening" || s === "thinking" ? s : "showing");
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
      phaseTo("showing");
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
      // A guess while they are still talking leaves the bead amber: the
      // microphone is still open. Only an answer's ring is showing.
      if (!(opts && opts.tentative)) phaseTo("showing");
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
      return holdCard({ type: "confirm", text: String(text || ""), risk: risk === "always" ? "always" : "confirm" }, (v) => v === true, false);
    },
    // The server's own card for something in a connected app (agent.js
    // approve): its words as they came, and the person's answer, "approve",
    // "edit" or "deny". Alt twice is the yes, on the same timing as any
    // confirm card. Silence, or the card taken away, answers "".
    approve(card) {
      const c = card && typeof card === "object" ? card : {};
      const text = (v, n) => String(v == null ? "" : v).slice(0, n);
      const buttons = (Array.isArray(c.buttons) ? c.buttons : []).slice(0, 3).map((b) => ({ id: text(b && b.id, 12), label: text(b && b.label, 40) }));
      return holdCard({
        type: "confirm", text: "", risk: "confirm",
        card: { title: text(c.title, 80), app: text(c.app, 60), label: text(c.label, 60), preview: text(c.preview, 1400), note: text(c.note, 240), buttons },
      }, (v) => (v === true ? "approve" : v === "edit" || v === "deny" ? v : ""), "");
    },
    hide() { hide(); },
    // A button on the finished card for what stopped the answer: only
    // "screenSettings", the Mac's Screen Recording page (agent.js
    // TEXT.needScreen), and only where this computer can open it. Its click
    // opens that page and nothing else (guide:offer).
    offer(kind) {
      if (kind !== "screenSettings" || typeof ctx.screenSettings !== "function" || !shown) return;
      offered = kind;
      send({ type: "offer", kind, text: txt("desktop.agent.screenSettingsButton", "Open Screen Recording settings") });
    },
    error(msg) {
      if (confirmWait) confirmWait(false);
      if (permitWait) permitWait("no");
      dropReply();
      // Refused before anything was shown (a private window): the card
      // comes up to say so.
      if (!shown) guide.show("error", {}); else phaseTo("showing");
      send({ type: "state", state: "error" });
      if (msg) send({ type: "say", text: String(msg) });
    },
    // A mark on the screen while it explains (agent.js draw): converted to
    // the guide's own coordinates, given a fresh id, or dropped. The first
    // one on the guide's display, when it lies on another, takes the guide
    // there, as a ring does; after that the guide stays with what it has
    // drawn, and a mark elsewhere is dropped.
    draw(mark) {
      if (!shown || !win || win.isDestroyed()) return;
      let m = markOf(mark);
      if (!m && marksHere === 0) {
        const p = markPlace(mark);
        const d = p && displayFor(p);
        if (d && !sameRect(bounds, areaOf(d))) { ensureWindow(d); showWindow(); m = markOf(mark); }
      }
      if (!m) { console.log("[ask] a mark was dropped: it is not on the guide's display, or it is not one it can draw"); return; }
      m.id = "d" + (++drawSeq);
      marksHere++;
      send(m);
    },
    clear() { marksHere = 0; send({ type: "clear" }); },
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
    const was = shown;
    shown = false;
    offered = null;
    if (confirmWait) confirmWait(false);
    if (permitWait) permitWait("no");
    quiet();
    send({ type: "hide" });
    // No window to fold back into the pill (its page went away): the pill is
    // given back at once.
    if (!win || win.isDestroyed()) { clearTimeout(goneTimer); goneTimer = null; letPill(); return; }
    // Already folding: the first hide's time stands. A second one (the run's
    // own, right behind a cancel) used to put the window's going off again.
    if (goneTimer && !was) return;
    // THE CARD FOLDS BACK INTO THE PILL. The guide folds the card into the
    // thread's end and pulls the thread down into the bead (foldMs); the
    // pill is told at once, and holds its gap open until the thread is home
    // (pill.js askCloseDelayMs) before it clicks shut. The window stays up
    // for the fold, and then the pill is given back: at rest, unless a
    // dictation has it by now. A card that came back up in the meantime (a
    // new question; the not-heard card, put up right after the run's own
    // hide and meant to stay doneMs) keeps both.
    pillTo("closing");
    clearTimeout(goneTimer);
    goneTimer = soft(setTimeout(() => {
      goneTimer = null;
      if (shown || agent.active()) return;
      // A peek that took the window meanwhile keeps it (peek clears this
      // timer itself; this is the second lock). The pill is still let go:
      // the dictation has it, so nothing of it changes, and the question no
      // longer holds a phase it would otherwise keep until the next one.
      if (peeking) { letPill(); return; }
      if (win && !win.isDestroyed()) { win.setIgnoreMouseEvents(true, { forward: true }); win.hide(); }
      letPill();
    }, Math.max(0, num("desktop.guide.foldMs", 620)) + 80));
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
      // Nor while a dictation records: its microphone would write Blip's
      // words into what they are writing.
      if (!m || tok !== voiceTok || !shown || listening || (ctx.dictating && ctx.dictating())) return undefined;
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
  /** Everything the card has been given to say, said, however long that
   *  takes: each sentence is held up at most voiceWaitMs, so it settles. A
   *  finished answer's card stays up for it (agent.js scheduleHide): timed
   *  from the end of the stream, it put the card away, and the voice with
   *  it, two sentences into an answer that came as eight. */
  function allSaid() {
    const s = speech;
    return s.then(() => (speech === s ? undefined : allSaid()));
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
  // WHAT "ALWAYS" IS REMEMBERED BY: the question's app as frontApp.js
  // names it for that (its pictureKey), set as the question begins. The
  // app's own name, never a window's title: a browser's label is the page's
  // title, which the page writes ("Always for Chrome: Dashboard" covered any
  // page calling itself that), and every Store app on Windows seen only as
  // its frame is "Application Frame Host". Those have no key, and no Always.
  let pictureApp = null;   // { label, key } of the question's app
  /** The key for `app`, when it is the question's app and has one; else null. */
  function pictureKey(app) {
    const p = pictureApp;
    return p && p.key && appKey(p.label) === appKey(app) ? p.key : null;
  }
  /** "never", "always" or "ask", for pictures of this app. "always" only
   *  ever from this computer's own say-so: the server may turn pictures off
   *  everywhere, but a server value that skipped the card would send a
   *  picture of whatever is in front with nobody asked. That say-so is
   *  "Always for <app>" on the card, or the setup card's "Look at the screen
   *  when it's needed" in the app window, which is yes once for every app:
   *  browser pages and unnamed Store apps too, which have no Always of their
   *  own, since that is what they said yes to. */
  function pictures(app) {
    if (str("desktop.agent.pictures", "ask") === "never") return "never";
    if (typeof ctx.picturesAlwaysAll === "function" && ctx.picturesAlwaysAll() === true) return "always";
    const key = appKey(pictureKey(app));
    const always = typeof ctx.picturesAlways === "function" ? ctx.picturesAlways() : [];
    if (key && Array.isArray(always) && always.some((a) => appKey(a) === key)) return "always";
    return "ask";
  }
  /** The picture card, until it is answered: "once", "always" (remembered
   *  for this app) or "no". Unanswered in confirmMs, put away, or the card
   *  replaced, it is no. `about.region`: "window" when the picture is the
   *  whole window, which the card then says, not "this part". */
  function permit(app, about) {
    if (permitWait) permitWait("no");
    // The name whole, as the run has it (up to 60). The card cuts it short
    // on screen itself.
    const name = String(app || "").replace(/\s+/g, " ").trim().slice(0, 60);
    // Remembered by the very key pictures() looks for next time. Without
    // one the card offers no Always, and a guide that still shows the
    // button sends this once and remembers nothing.
    const key = String(pictureKey(app) || "").replace(/\s+/g, " ").trim().slice(0, 60);
    const whole = !!about && about.region === "window";
    // ONE LINE. The card asks to see, and nothing more: what is sent, and to
    // whom, is the privacy policy's to say (its Ask section), where it can
    // be said whole. Two knobs still, the part of the screen and the whole
    // window, so either can be worded on its own from the server.
    send({
      type: "permission", app: name, always: !!key,
      text: whole
        ? txt("desktop.agent.permitWindowText", "To answer that I need to see it.")
        : txt("desktop.agent.permitText", "To answer that I need to see it."),
    });
    return new Promise((resolve) => {
      let timer = null;
      const answer = (choice) => {
        clearTimeout(timer);
        if (permitWait !== answer) return;
        permitWait = null;
        let c = choice === "once" || choice === "always" ? choice : "no";
        if (c === "always" && !key) c = "once";
        if (c === "always" && typeof ctx.allowPicturesAlways === "function") {
          try { ctx.allowPicturesAlways(key); } catch { /* still yes, for this once */ }
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
   * window's frame and the picture's own size. No frame is the whole window.
   * Null when there is no picture to crop, and when the frame misses the
   * window or is too small in the picture to see anything in: the whole
   * window in its place sent the title bar and the address bar, which the
   * part asked about was cut below, on a card that asked about "this part".
   *
   * `frame` comes back with it: the part of the window the picture really
   * shows, in the driver's units (the frame asked for, cut to the window, or
   * the whole window). The answer's marks in the picture are places in THIS
   * picture.
   */
  function crop(look, frame) {
    try {
      const img = look && look.image;
      const win = look && look.window && look.window.frame;
      const ok = (f) => Array.isArray(f) && f.length === 4 && f.every((n) => typeof n === "number" && Number.isFinite(n));
      if (!img || typeof img.data !== "string" || !img.data || !ok(win) || win[2] <= 0 || win[3] <= 0 || !ctx.nativeImage) return null;
      if (frame != null && !ok(frame)) return null;
      const pic = ctx.nativeImage.createFromBuffer(Buffer.from(img.data, "base64"));
      if (!pic || pic.isEmpty()) return null;
      const size = pic.getSize();
      const sx = size.width / win[2], sy = size.height / win[3];
      let rect = { x: 0, y: 0, width: size.width, height: size.height };
      let shows = win.slice();
      if (frame != null) {
        const x0 = Math.max(0, Math.floor((frame[0] - win[0]) * sx)), y0 = Math.max(0, Math.floor((frame[1] - win[1]) * sy));
        const x1 = Math.min(size.width, Math.ceil((frame[0] + frame[2] - win[0]) * sx)), y1 = Math.min(size.height, Math.ceil((frame[1] + frame[3] - win[1]) * sy));
        if (x1 - x0 < 8 || y1 - y0 < 8) return null;
        rect = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
        const l = Math.max(frame[0], win[0]), t = Math.max(frame[1], win[1]);
        shows = [l, t, Math.min(frame[0] + frame[2], win[0] + win[2]) - l, Math.min(frame[1] + frame[3], win[1] + win[3]) - t];
      }
      let out = rect.x === 0 && rect.y === 0 && rect.width === size.width && rect.height === size.height ? pic : pic.crop(rect);
      const max = Math.max(64, num("desktop.agent.pictureMaxSide", 1024));
      const got = out.getSize();
      if (Math.max(got.width, got.height) > max) {
        out = out.resize(got.width >= got.height ? { width: max, quality: "good" } : { height: max, quality: "good" });
      }
      const data = out.toJPEG(Math.max(1, Math.min(100, num("desktop.agent.pictureQuality", 82))));
      return data && data.length ? { mime: "image/jpeg", data, frame: shows } : null;
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
  const hands = {
    key: {
      value: async (chord) => {
        const esc = /\besc(ape)?\b/i.test(String(chord));
        if (esc) selfEscUntil = Date.now() + 5000;
        try { return await ctx.driver.key(chord); } finally {
          if (esc) selfEscUntil = Date.now() + Math.max(0, num("desktop.agent.selfKeyMs", 600));
        }
      },
    },
  };
  // And its look, watched for what it says about the Mac's Screen Recording
  // permission. macOS can say it is granted while the helper, started
  // before it was, is still refused until Tailzu restarts: the setup card
  // offers the restart only then (main.js "ask-setup"). Only an answer that
  // says something counts: a look that timed out says nothing either way.
  // A driver with no look keeps none, as agent.js expects.
  if (ctx.driver && typeof ctx.driver.look === "function") {
    hands.look = {
      value: async (o) => {
        const r = await ctx.driver.look(o);
        const denied = !!r && r.ok === false && r.error === "no_screen_permission";
        if (r && (r.ok === true || denied) && denied !== screenDenied) {
          screenDenied = denied;
          if (typeof ctx.lookPermission === "function") {
            try { ctx.lookPermission(denied); } catch (e) { console.warn("[ask] the setup card could not be told:", (e && e.message) || e); }
          }
        }
        return r;
      },
    };
  }
  const driver = Object.create(ctx.driver, hands);
  // Handed in by the tests, which watch what the run is told; agent.js's own
  // otherwise.
  const agent = (ctx.createAgent || agentCore.createAgent)({
    driver,
    guide,
    post: agentCore.makePost({ baseUrl: ctx.baseUrl, token: ctx.token, fetch: ctx.fetch || ((...a) => fetch(...a)) }),
    approveElsewhere: () => txt("desktop.agent.approveElsewhere", "I need your OK in X0 Bot first."),
    // "This computer": the person's own files, done here by localfiles.js and
    // only inside the folders they allowed (main.js hands it in).
    device: ctx.device,
    // The server's confirm card's buttons: a task's yes or no, with the
    // account's token the way every call here is made. Those two routes and
    // nothing else, whatever the card named.
    call: async (route) => {
      const r = route && typeof route === "object" ? route : {};
      const none = { status: 0, body: null };
      if (r.method !== "POST" || !agentCore.isTaskRoute(r.path) || typeof ctx.authorizedFetch !== "function") return none;
      try {
        const res = await ctx.authorizedFetch(r.path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(r.body && typeof r.body === "object" ? r.body : {}),
          signal: AbortSignal.timeout(Math.max(1000, num("desktop.agent.approveCallMs", 25000))),
        });
        return { status: res.status, body: await res.json().catch(() => null) };
      } catch { return none; }
    },
    paste: (text) => ctx.paste(text),
    // The server's `open` (a hand-off for the person to finish: an email in
    // Gmail, a message, a search or a route): only a link safeOpenUrl allows,
    // checked here again, and opened by main. Anything else is not opened,
    // whatever asked.
    open: (url) => {
      const link = agentCore.safeOpenUrl(url);
      return link && typeof ctx.openExternal === "function" ? ctx.openExternal(link) : false;
    },
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
    // The names it answers to, their own for it among them, taken off the
    // front of a question here as the server takes them: "Jarvis, where's
    // export?" was matched with "jarvis" in it, and found nothing.
    names: ctx.names,
    // A finished answer's card stays up until all of it has been said.
    afterSpeech: allSaid,
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
      cardError(oneKeyName()
        ? txt("desktop.agent.notHeardOneKey", "I didn't catch that. Hold {key} and ask again.", { key: oneKeyName() })
        : txt("desktop.agent.notHeard", "I didn't catch that. Tap {key} twice and ask again.", { key: str("desktop.agent.tapKey", "Alt") }));
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
      cardError(oneKeyName()
        ? txt("desktop.agent.unknownWindowOneKey", "I couldn't tell which window this is, so I didn't look. Hold {key} and ask again.", { key: oneKeyName() })
        : txt("desktop.agent.unknownWindow", "I couldn't tell which window this is, so I didn't look. Tap {key} twice to try again.", { key: str("desktop.agent.tapKey", "Alt") }));
      return;
    }
    begun = true;
    pictureApp = { label: info.label || "", key: typeof info.pictureKey === "string" && info.pictureKey.trim() ? info.pictureKey : null };
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

  /**
   * A question already said: the one key's words, routed here (routing.js)
   * when they were for Ask. The same run as tap()'s, without the microphone:
   * the app in front is named, the run begins, and the words go in as the
   * question's final caption. True when it took them; false when it could
   * not (a dictation still has the microphone, signed out, the window could
   * not be told, a private window or a bank: their cards say so).
   */
  async function askHeard(text) {
    const words = String(text || "").replace(/\s+/g, " ").trim();
    if (!words) return false;
    if (ctx.dictating && ctx.dictating()) return false;
    // Whatever was up (a finished answer's card, a question still out) gives way.
    if (confirmWait || permitWait || listening || onAudio || naming || finalWait || agent.active() || shown) cancel("restart");
    if (!ctx.requireAccount()) return false;
    const mine = ++asking;
    const pointer = pointerNow();
    naming = mine;
    let info = await front();
    if (!info && mine === asking) info = await front();
    if (mine !== asking) return false;
    naming = 0;
    if (!info) {
      cardError(txt("desktop.agent.unknownWindowOneKey", "I couldn't tell which window this is, so I didn't look. Hold {key} and ask again.", { key: oneKeyName() }));
      return false;
    }
    pictureApp = { label: info.label || "", key: typeof info.pictureKey === "string" && info.pictureKey.trim() ? info.pictureKey : null };
    agent.begin({ app: info.label || "", privateField: !!info.private, sensitive: !!info.sensitive, pointer });
    if (!agent.active()) return false;     // refused: a private window, a bank
    void agent.heard(null, { text: words, final: true });
    return true;
  }
  /** The one key, as it is bound (main.js), or "" when the old keys are in use. */
  function oneKeyName() { try { return (typeof ctx.oneKey === "function" && ctx.oneKey()) || ""; } catch { return ""; } }

  // ---- the peek, while a dictation records ----------------------------------------
  // Blip over the text box at the cursor (guide.js peek), in the guide's own
  // window: put on the field's display, its frames turned to DIP and then to
  // the window's own coordinates, as a ring is. Decoration on top of
  // dictation: anything wrong with it is dropped without a word, and it never
  // takes the guide from a question.
  /** A question has the guide, or is on its way to it. */
  const questionUp = () => shown || listening || !!onAudio || !!naming || !!finalWait || !!confirmWait || !!permitWait || agent.active();
  /**
   * Blip at the caret (`caretFrame`) over its text box (`fieldFrame`), both
   * [x, y, w, h] in the driver's units or null, doing `state` (listening,
   * writing, done). True when it was sent; false, and nothing shown, while a
   * question has the guide or when neither frame says where the cursor is
   * (a peek already up then ducks: it never stays where it can no longer
   * know the cursor is).
   */
  function peek(caretFrame, fieldFrame, state) {
    if (questionUp()) return false;
    const c = dip(peekFrame(caretFrame)), f = dip(peekFrame(fieldFrame));
    if (!c && !f) { unpeek(); return false; }
    // The field's display, which is where the box is. Except for a tall one
    // (past desktop.guide.peekTallField: a document, where the guide peeks
    // over the caret's line rather than the box's top): its text view can be
    // scrolled far past the screen's edges, its middle on no display at all,
    // and the caret's display is the one Blip stands on.
    const by = !f || (c && f.h > num("desktop.guide.peekTallField", 120)) ? c : f;
    ensureWindow(displayFor({ x: by.x + by.w / 2, y: by.y + by.h / 2 }));
    if (!win || win.isDestroyed()) return false;
    clearTimeout(peekGone); peekGone = null;
    // A card still folding back into the pill (a dictation started as an
    // answer went): the guide puts it away for the peek, and the pill is
    // given back now rather than after the fold. A dictation has it, so
    // nothing of the pill changes (main.js pillAsk).
    if (goneTimer) { clearTimeout(goneTimer); goneTimer = null; letPill(); }
    showWindow();
    peeking = true;
    send({ type: "peek", caret: local(c), field: local(f), state: PEEK_STATES.has(state) ? state : "listening" });
    return true;
  }
  /** The voice's level (0..1) for Blip's antenna, while it peeks. */
  function peekLevel(v) {
    // Not before the page is there: the voice comes thirty times a second,
    // and a page that never loaded would have queued every one of them for
    // the whole dictation. A level is gone by the next one anyway.
    if (!peeking || !ready || questionUp()) return;
    const n = Number(v);
    send({ type: "peekLevel", v: Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0 });
  }
  /** Blip ducks below the edge at once, and the window goes once it is
   *  down: unless a peek or a question has it again by then. */
  function unpeek() {
    if (!peeking) return;
    peeking = false;
    send({ type: "unpeek" });
    clearTimeout(peekGone);
    peekGone = soft(setTimeout(() => {
      peekGone = null;
      if (peeking || goneTimer || questionUp()) return;
      if (win && !win.isDestroyed()) { win.setIgnoreMouseEvents(true, { forward: true }); win.hide(); }
    }, PEEK_GONE_MS));
  }

  // ---- from the guide window ---------------------------------------------------------
  const fromGuide = (e) => !!win && !win.isDestroyed() && e.sender === win.webContents;
  ipcMain.on("guide:mouse", (e, inside) => {
    if (!fromGuide(e)) return;
    if (inside) win.setIgnoreMouseEvents(false);
    else win.setIgnoreMouseEvents(true, { forward: true });
  });
  // A yes or a no; on the server's card also "edit" and "deny" (Not now),
  // which are answers of their own. Anything else is read as a no.
  ipcMain.on("guide:confirm", (e, yes) => { if (fromGuide(e) && confirmWait) confirmWait(yes === "edit" || yes === "deny" ? yes : !!yes); });
  ipcMain.on("guide:permit", (e, choice) => { if (fromGuide(e) && permitWait) permitWait(String(choice || "")); });
  ipcMain.on("guide:dismiss", (e) => { if (fromGuide(e)) cancel("dismiss"); });
  // The card's button (guide offer): only the one it was given, once. The
  // settings page comes up over the card, which goes: there is nothing more
  // to do on it.
  ipcMain.on("guide:offer", (e, kind) => {
    if (!fromGuide(e) || !offered || String(kind || "") !== offered) return;
    offered = null;
    try { ctx.screenSettings(); } catch (err) { console.warn("[ask] the settings would not open:", (err && err.message) || err); }
    cancel("settings");
  });
  ipcMain.on("guide:spoken", (e) => { if (fromGuide(e) && spokenWait) spokenWait(); });

  return {
    tap,
    askHeard,
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
    /** A card is up: a run's, or a finished answer's, which may still be
     *  saying it. A dictation starting puts it away (main.js toggleDictation). */
    shown: () => shown,
    // Blip over the text box while a dictation records (createPeekWatch).
    // Never a card: none of these makes the question active or shown.
    peek,
    peekLevel,
    unpeek,
    peeking: () => peeking,
    /** The last look was refused for want of Screen Recording (and none
     *  since has been let through). */
    screenDenied: () => screenDenied,
    escape() {
      // The agent's own Escape, heard by the same hook: for a moment after
      // it sends one, an Esc is its, not theirs.
      if (Date.now() < selfEscUntil) return false;
      // A finished answer's card too: it stays up while it is said, and Esc
      // is how its voice is stopped.
      if (listening || onAudio || naming || finalWait || agent.active() || confirmWait || permitWait || shown) { cancel("esc"); return true; }
      return false;
    },
  };
}

// ---- the peek's watch (main.js, while a dictation records) -------------------------------
/**
 * WHERE THE CURSOR IS WHILE THEY DICTATE, for Blip to peek over the text box
 * (ask.peek). main.js tells it a dictation's moments: it started (with the
 * app it is going into, once that is named), a chunk was pasted, it stopped,
 * its words were pasted, it ended any other way. This asks the driver where
 * the caret is at the start, after each pasted chunk and every
 * desktop.dictation.peekEveryMs while the microphone is open, one request at
 * a time, and tells the peek.
 *
 * DECORATION, AND NOTHING ELSE. It reads only rectangles and the app's name,
 * from a helper that is already running (Ask's); it never starts one, never
 * sends anything anywhere, and never touches what the dictation records,
 * sends or pastes. Every failure in it is silent: a helper that is not up, a
 * caret it cannot find, an answer that never comes, a peek that throws. The
 * dictation goes on as if it were not here.
 *
 * And it never peeks where it should not look: into a private window or a
 * sensitive app (frontApp.js's own checks, as Ask's), or at an app the
 * dictation is not going into (the front app moved).
 *
 *   o.driver      driver.js: caret({ budgetMs }) → { ok, caret, field, app: { name, pid } }
 *   o.ask         createAsk's peek, peekLevel, unpeek
 *   o.knobs       { num }
 *   o.on()        the peek is on: desktop.dictation.peek, and Ask is
 *   o.labelOf     frontApp.label(appName, windowTitle): how the dictation's app was named
 *   o.sensitive   frontApp.looksSensitive(name)
 */
function createPeekWatch(o) {
  const num = o.knobs.num;
  const soft = (t) => { if (t && typeof t.unref === "function") t.unref(); return t; };
  const quietly = (f) => { try { return f(); } catch { return undefined; } };
  // The end of each of its promise chains: what goes wrong inside one is
  // said in the log and goes no further. Left unhandled, it was a rejection
  // in the main process, in the middle of a dictation.
  const shrug = (e) => { console.warn("[peek]", (e && e.message) || e); };
  // And its timers' callbacks, for the same reason: a throw in one is an
  // uncaught exception in the main process.
  const safely = (f) => () => { try { f(); } catch (e) { shrug(e); } };
  let cur = null;   // the dictation being watched

  /** A dictation started: `sid`, and `named`, the app it is going into
   *  (frontApp.frontInfo's { label, title, private, sensitive }, or a
   *  promise of it; { pid } for Tailzu's own window). Any watch before it
   *  ends. */
  function start(sid, named) {
    end();
    if (!sid || quietly(() => o.on()) !== true) return;
    const w = cur = {
      sid, state: "listening", target: null, pid: 0, up: false, last: null,
      busy: false, again: false, gone: false, timer: null, doneTimer: null,
    };
    Promise.resolve(named).then((info) => {
      if (cur !== w) return;
      // Not named, a private window, a bank: no peek, and nothing is read.
      if (!info || typeof info !== "object" || info.private || info.sensitive) { end(sid); return; }
      w.target = info;
      read(w, true);
      // Only while the microphone is open: a stop that came before the app
      // was named is already writing. A tick while a read is out is skipped:
      // the next one asks.
      // Kept between 100 ms and a minute: a value past Node's timer (24
      // days) is run every millisecond instead, a poll that never rests.
      if (w.state === "listening") {
        w.timer = soft(setInterval(safely(() => { if (cur === w && w.state === "listening") read(w, false); }), Math.min(60000, Math.max(100, num("desktop.dictation.peekEveryMs", 700)))));
      }
    }, () => { if (cur === w) end(sid); }).catch(shrug);
  }

  /** The caret, asked once: never two at a time. Asked while one is out,
   *  with `queue` it is asked again as soon as that one is back (a chunk was
   *  pasted, so the caret has moved since that one was asked). */
  function read(w, queue) {
    if (cur !== w || !w.target || w.gone) return;
    if (w.busy) { if (queue) w.again = true; return; }
    if (!o.driver || typeof o.driver.caret !== "function") { w.gone = true; return; }
    w.busy = true; w.again = false;
    // No more than the drivers allow (2 s): a larger one only made the cap
    // below overflow Node's timer and fire at once, so every read was lost.
    const budgetMs = Math.min(2000, Math.max(50, num("desktop.dictation.peekBudgetMs", 250)));
    let asked;
    try { asked = Promise.resolve(o.driver.caret({ budgetMs })); } catch { asked = Promise.resolve(null); }
    // The drivers always answer within the budget; this only makes sure one
    // that did not can never hold every later read behind it.
    let cap = null;
    const capped = new Promise((r) => { cap = soft(setTimeout(() => r(null), budgetMs + 500)); });
    Promise.race([asked, capped]).then((r) => r, () => null).then((r) => { clearTimeout(cap); landed(w, r); }).catch(shrug);
  }

  /** Whether an answer's app is the dictation's: by the pid, once one
   *  answer has matched; until then by how frontApp names an app (its name,
   *  and for a browser the site, from the window's title at the start). */
  function mine(w, app) {
    const pid = Number(app.pid) || 0;
    if (w.pid) return pid === w.pid;
    const t = w.target;
    const same = t.pid ? pid === t.pid
      : typeof t.label === "string" && !!t.label && quietly(() => o.labelOf(String(app.name || ""), String(t.title || ""))) === t.label;
    if (same && pid) w.pid = pid;
    return same;
  }

  /** What an answer says: { caret, field } to peek at; null, no peek here
   *  (another app, a sensitive one, a password field, nothing found); or
   *  undefined, no news (a failure: what is up stays). */
  function placeOf(w, r) {
    if (!r || typeof r !== "object" || r.ok !== true) return undefined;
    const app = r.app && typeof r.app === "object" ? r.app : {};
    if (!mine(w, app)) return null;
    if (quietly(() => o.sensitive(String(app.name || ""))) !== false) return null;
    const caret = peekFrame(r.caret), field = peekFrame(r.field);
    return caret || field ? { caret, field } : null;
  }

  function landed(w, r) {
    w.busy = false;
    if (cur !== w) return;
    // No helper running (Ask is off, or it has not started): nothing more is
    // asked of it for this dictation. A dictation never starts one.
    if (r && r.ok === false && (r.error === "unavailable" || r.error === "unsupported")) w.gone = true;
    const place = placeOf(w, r);
    // Done, and asked again meanwhile: this answer is from before the last
    // words landed, and the next one says where they are.
    if (w.state === "done" && w.again && !w.gone) { read(w, true); return; }
    if (place === null) down(w);
    else if (place) { w.last = place; show(w, place); }
    if (w.state === "done") { finish(w, place); return; }
    if (w.again && !w.gone) read(w, true);
  }

  /** Up, or moved. Only while the microphone is open does it come up:
   *  writing and done move one that is already up, and a dictation that
   *  never showed it does not pop it up to hop at its end. */
  function show(w, place) {
    if (!w.up && w.state !== "listening") return;
    w.up = quietly(() => o.ask.peek(place.caret, place.field, w.state)) === true;
  }
  function down(w) {
    if (!w.up) return;
    w.up = false;
    quietly(() => o.ask.unpeek());
  }
  /** The last words are in: the hop where the caret is now (or where it
   *  was, when it could not be read again), then away. */
  function finish(w, place) {
    if (w.doneTimer) return;
    if (place === undefined && w.up && w.last) show(w, w.last);
    if (!w.up) { end(w.sid); return; }
    w.doneTimer = soft(setTimeout(safely(() => { if (cur === w) end(w.sid); }), Math.max(0, num("desktop.dictation.peekDoneMs", 900))));
  }

  /** A chunk was pasted while it records (the pill's flash): the caret moved. */
  function pasted(sid) {
    const w = cur;
    if (!w || w.sid !== sid || w.state === "done") return;
    read(w, true);
  }
  /** The microphone closed: it watches the words being written. */
  function stop(sid) {
    const w = cur;
    if (!w || w.sid !== sid || w.state !== "listening") return;
    w.state = "writing";
    clearInterval(w.timer); w.timer = null;
    if (w.up && w.last) show(w, w.last);
  }
  /** The words were pasted: where the caret is now, the hop, and away
   *  after desktop.dictation.peekDoneMs. */
  function done(sid) {
    const w = cur;
    if (!w || w.sid !== sid || w.state === "done") return;
    w.state = "done";
    clearInterval(w.timer); w.timer = null;
    if (!w.up || !w.target) { end(sid); return; }
    read(w, true);
    // A read already out lands first and asks again (landed); one that
    // could not be asked at all (the helper went) hops where it was.
    if (!w.busy && cur === w) finish(w, undefined);
  }
  /** The dictation ended any other way (cancelled, failed, nothing written,
   *  given up on): away at once. `sid` omitted: whatever is watched. */
  function end(sid) {
    const w = cur;
    if (!w || (sid != null && w.sid !== sid)) return;
    cur = null;
    clearInterval(w.timer); clearTimeout(w.doneTimer);
    down(w);
  }
  /** The voice's bands (the pill's level stream), their mean for the antenna. */
  function level(sid, bands) {
    const w = cur;
    if (!w || w.sid !== sid || !w.up || w.state !== "listening" || !Array.isArray(bands) || !bands.length) return;
    const v = bands.reduce((a, b) => a + (Number(b) || 0), 0) / bands.length;
    quietly(() => o.ask.peekLevel(v));
  }

  // Nothing here may throw into main.js's dictation paths.
  const guarded = (f) => (...a) => { try { f(...a); } catch (e) { console.warn("[peek]", (e && e.message) || e); } };
  return {
    start: guarded(start), pasted: guarded(pasted), stop: guarded(stop), done: guarded(done), end: guarded(end), level: guarded(level),
    /** The dictation it is watching, or 0. */
    watching: () => (cur ? cur.sid : 0),
  };
}

// ---- the setup card in the app window (main.js) ---------------------------------------
// The "ask" actions the card may ask for. Anything else is ignored.
const SETUP_KINDS = new Set(["openAccessibility", "openScreenRecording", "picturesAll", "relaunch"]);

/**
 * ASK'S ONE-TIME SETUP, the main process's side of it: "Let Ask see what you
 * see." in the app window (sdui.js DeskAskSetup), three rows, each with its
 * state and one button.
 *
 *   read      Accessibility on a Mac (the screen's buttons, fields and text);
 *             nothing to allow elsewhere ("na")
 *   see       Screen Recording on a Mac; "restart" when the Mac says it is
 *             granted but the helper's last look was still refused, which
 *             takes a restart of Tailzu
 *   pictures  look without asking each time, for every app (local state
 *             askPicturesAlwaysAll); "never" when the server has turned
 *             pictures off, which wins over everything
 *
 * The states are read here, on this computer, and nothing of them leaves it.
 * The window asks for them (app:askSetup) and is told again whenever they
 * may have changed ("ask-setup": its focus, each action, a look's answer).
 * Only the app window may ask or act (fromApp), and a button opens only its
 * own fixed page.
 *
 *   o.ipcMain, o.fromApp(e)
 *   o.platform             process.platform
 *   o.systemPreferences    Electron's (Mac: isTrustedAccessibilityClient, getMediaAccessStatus)
 *   o.knobs                { str }
 *   o.localState, o.saveLocalState
 *   o.screenDenied()       the last look was refused for want of Screen Recording
 *   o.openAccessibility()  the Mac's Accessibility page
 *   o.openScreenRecording()  the guide's Screen Recording path (main.js)
 *   o.relaunch()
 *   o.send(state)          to the app window, as "ask-setup"
 */
function createAskSetup(o) {
  const mac = o.platform === "darwin";
  const call = (f, fallback) => { try { return f(); } catch { return fallback; } };
  let axPrompted = false;   // macOS asked to list Tailzu under Accessibility, this launch

  function state() {
    let read = "na", see = "na";
    if (mac) {
      const sp = o.systemPreferences || {};
      read = call(() => sp.isTrustedAccessibilityClient(false), false) === true ? "on" : "off";
      if (call(() => sp.getMediaAccessStatus("screen"), "") === "granted") {
        see = call(() => o.screenDenied(), false) === true ? "restart" : "on";
      } else see = "off";
    }
    const never = o.knobs.str("desktop.agent.pictures", "ask") === "never";
    return {
      platform: mac ? "mac" : o.platform === "win32" ? "windows" : "linux",
      read, see,
      pictures: never ? "never" : o.localState.askPicturesAlwaysAll === true ? "on" : "off",
    };
  }
  /** The state, to the app window. */
  function push() {
    try { o.send(state()); } catch (e) { console.warn("[ask] the setup card could not be told:", (e && e.message) || e); }
  }

  /** One of the card's buttons. True when it was one it may ask for. */
  function act(p) {
    if (!p || typeof p !== "object" || !SETUP_KINDS.has(p.kind)) return false;
    if (p.kind === "openAccessibility" || p.kind === "openScreenRecording") {
      // A Mac's own settings pages; there is nothing to open elsewhere.
      if (!mac) return false;
      // ON A FRESH MAC TAILZU IS NOT IN THE ACCESSIBILITY LIST until it has
      // asked once, so the page opened on a list with nothing to switch on.
      // Asked here, once a launch and only while it is still off: macOS adds
      // Tailzu to the list (and shows its own prompt), then the page opens.
      if (p.kind === "openAccessibility" && !axPrompted) {
        const sp = o.systemPreferences || {};
        if (call(() => sp.isTrustedAccessibilityClient(false), false) !== true) {
          axPrompted = true;
          call(() => sp.isTrustedAccessibilityClient(true));
        }
      }
      call(() => (p.kind === "openAccessibility" ? o.openAccessibility() : o.openScreenRecording()));
      return true;
    }
    if (p.kind === "picturesAll") {
      if (typeof p.on !== "boolean") return false;
      o.localState.askPicturesAlwaysAll = p.on;
      call(() => o.saveLocalState());
      return true;
    }
    // relaunch: only when the card offers it ("Restart Tailzu to finish"). A
    // restart takes a dictation, a note and a question down with it, so a
    // window cannot ask for one at any other time.
    if (state().see !== "restart") return false;
    call(() => o.relaunch());
    return true;
  }

  o.ipcMain.handle("app:askSetup", (e) => (o.fromApp(e) ? state() : null));
  o.ipcMain.on("app:askSetupAction", (e, p) => {
    if (!o.fromApp(e)) return;
    if (act(p)) push();
  });
  return { state, push, act };
}

module.exports = { createAsk, pillAskMove, capsuleRect, createPeekWatch, createAskSetup };
