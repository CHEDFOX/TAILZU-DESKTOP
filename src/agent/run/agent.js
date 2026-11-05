// TAILZU ASK: THE RUN ON THIS COMPUTER.
//
// Alt twice, a sentence about the app in front ("where's export?", "turn on
// captions", "open #design and tell them the mockups are ready"), and Blip
// points at the thing, explains it, or does a small job. The server is a
// stateless planner that answers one step at a time; everything that has to be
// trusted lives here:
//
//   the screen  read as an accessibility tree (driver.js) into a short list of
//               elements. Roles, labels, short values and a coarse region tag
//               leave this computer; frames, pixels and window titles do not.
//               The server answers with element ids and the frames are looked
//               up here, in a map that belongs to the snapshot it was sent.
//   the risk    the server sends one with every action, and risk.js works it
//               out again and takes the higher. A model talked into calling
//               "Send" free does not get to send anything without a yes.
//   the loop    post a step, hand its events to the guide as they stream in,
//               run at most one action, let the app settle, read the screen
//               again, say what changed, and go round — until the server says
//               done, or a stop: too many steps, too long, the same thing twice
//               to no effect, Esc.
//
// The screen is read twice at Alt twice, while they are still speaking: the
// tree, and a look at the window (driver.look) — its picture, and the text in
// it read by the system's own OCR, each line with its place. The lines join
// the tree as elements of their own (o1, o2…), so a label drawn on a canvas
// or a web page with no accessibility can still be named and pointed at. Then
// three ways to answer, cheapest first:
//
//   instant     "where's Export?" matched here, against the labels and the
//               lines (resolver.js): the ring, "Here's Export.", done, with no
//               request at all. The ring is up, tentatively, while they are
//               still saying it (preview).
//   picture     a question about something drawn ("explain this equation",
//               "what does this chart show"): ONE cropped picture of it goes
//               with the question, only with their permission for this app,
//               and the card says it went. Never from a sensitive app (nor a
//               private window while the server has them off); the window's
//               picture is checked like its tree.
//   text        everything else, as before; with the live caption's words
//               as the utterance when there are some, so the server has
//               nothing to transcribe.
//
// And the whole page, for understanding it (deps.page, context/pageRead.js):
// the window's text with the parts out of sight, read from the tree while
// they speak, after the snapshot; and, when that is thin and the question is
// about the whole thing ("summarise this"), read a screen at a time before
// the first step. It goes with step 0 only, as `page`, and is never acted on:
// only the snapshot's elements are.
//
// The answer may draw while it explains, the way a teacher uses a pen: a
// circle on part of a diagram, an arrow from a label to what it names, the
// places to click numbered in order. A mark names what it is on the way a
// point does, by an id of this screen, or, on a run that sent a picture, by
// a place in that picture (0–1000 across and down it). Both are turned into
// screen positions here, from frames and the picture's own region that never
// left this computer, and nothing new goes back. Marks belong to the screen
// they were drawn on, so they are cleared before anything changes it.
//
// Pure logic with every dependency injected (the driver, the guide window, the
// network, the clipboard paste, the microphone, the clock, the picture's crop
// and its permission), so a whole run can be played in a test without
// Electron, a screen or a server.
//
// This file is the loop (createAgent). Its parts, each in a file of its own
// here: screen.js (the elements sent), picture.js (OCR lines and the crop),
// marks.js (what an answer draws), changes.js (what an action changed),
// risk.js, actions.js (an action in words), stream.js (the step request and
// its event stream), text.js (the guide's words), approval.js (the server's
// confirm card), openLink.js (the "open" event), helpers.js.

const crypto = require("crypto");
const frontApp = require("../../context/frontApp.js");
const resolver = require("../resolver.js");
const localFiles = require("../localfiles.js");
const { TEXT } = require("./text.js");
const { safeOpenUrl } = require("./openLink.js");
const { isTaskRoute, CARD_BUTTONS, approvalOf } = require("./approval.js");
const { str, squash, clip, errText, isFrame, elementsOf, focusedOf, within, sleep, WEB_APPS } = require("./helpers.js");
const { MAX_ELEMENTS, SCREEN_CHARS, frameMap, ADDRESS_BAR, stripUrls, HAS_URL_TAIL, toRequestElements } = require("./screen.js");
const { sameWindow, ocrElements, pictureRegion, hasBytes, byteSize } = require("./picture.js");
const { resolveMark } = require("./marks.js");
const { describeChange, focusMoved, focusLandedOn, titleOf } = require("./changes.js");
const { maxRisk, sameApp, classifyRisk, wordsRisk } = require("./risk.js");
const { actionLine, fingerprint, confirmText, acting } = require("./actions.js");
const { makePost } = require("./stream.js");
const { needsWhole } = require("../../context/pageRead.js");

/** What a device result may carry back, as the server reads it. */
const DEVICE_DATA_MAX = 5000;
/** A long job's plan, and the facts it keeps (the server takes the same: AgentJob). */
const JOB_PLAN_MAX = 12;
const JOB_NOTES_MAX = 8;
/** Device events one run may carry out. */
const DEVICE_PER_RUN = 6;
/** A remembered kind of change still asks when it touches more files than this. */
const DEVICE_BIG = 100;
/** The driver resolves within the timeout it is given, so a little more than
 *  that here only ever catches a driver that broke its promise. */
const SNAPSHOT_GRACE_MS = 250;
/** The server takes a picture up to this size (AGENT_IMAGE_MAX_BYTES) and
 *  answers 413 above it; a crop that big is not sent at all. */
const MAX_PICTURE_BYTES = 2000000;
/** What step 0's page may carry, whatever deps.page gave back. */
const PAGE_TEXT_MAX = 20000;
const PAGE_OUTLINE_MAX = 200;

const TERMINAL = new Set(["action", "ask", "done", "error", "look", "approve", "device", "handover"]);
const ACTION_KINDS = new Set(["press", "set", "type", "key", "scroll", "focus", "open"]);
/** Actions that mean nothing without an element. */
const NEEDS_ID = new Set(["press", "set", "focus"]);
const SCROLL_DIRS = new Set(["up", "down", "left", "right"]);

// ---- the run ----------------------------------------------------------------

const ABORTED = Symbol("aborted");

/** An async iterator over whatever post() gave back: an async iterable (a
 *  stream of events), or a plain array (handy for a fixed answer). */
function iteratorOf(source) {
  if (source && typeof source[Symbol.asyncIterator] === "function") return source[Symbol.asyncIterator]();
  if (source && typeof source[Symbol.iterator] === "function") {
    const it = source[Symbol.iterator]();
    return { next: async () => it.next(), return: async () => (it.return ? it.return() : { done: true }) };
  }
  return null;
}

/** Stop reading a stream. Not awaited: a generator stuck inside an await only
 *  finishes returning when that await does, and nothing here waits on it. */
function close(it) {
  try {
    const r = it && typeof it.return === "function" ? it.return() : null;
    if (r && typeof r.then === "function") r.then(null, () => {});
  } catch { /* already finished */ }
}

const hasAudio = (a) => !!(a && a.data && (a.data.length > 0 || a.data.size > 0 || a.data.byteLength > 0));

/** A press's answers that do not mean "nothing happened": the driver gave up
 *  waiting while the helper still ran it, the helper died part way, or the
 *  app took it and was slow to say so (an ok with pending or slow set). */
const UNSURE_PRESS = new Set(["timeout", "pending", "slow", "dead", "helper_exited"]);
function pressMayHaveHappened(r) {
  if (!r || typeof r !== "object") return false;
  if (r.ok === true) return r.pending === true || r.slow === true;
  return UNSURE_PRESS.has(str(r.error));
}

/**
 * @param {object} deps
 * @param {object} deps.driver   the §1 driver API
 * @param {object} deps.guide    { show, state, heard, say, point, unpoint, steps, confirm, approve?, hide, error, badge, draw?, clear?, offer? }:
 *        approve(card) shows the server's confirm card for a connected app and resolves
 *        "approve", "edit", "deny", or "" for no answer (confirmMs, or the card taken away);
 *        a guide without it cannot ask, and nothing is called
 *        point(frame, caption?, { tentative: true }?) and say(text, { speak, rate, locale?, append? });
 *        draw(mark) with a mark from resolveMark (driver units), clear() to take the marks away.
 *        draw and clear are called only when the guide has them: one without them draws nothing.
 *        offer("screenSettings"): a button on the finished card to the Mac's Screen Recording
 *        settings, after TEXT.needScreen; a guide without it says the words alone
 * @param {(req: object, audio: object|null, signal: AbortSignal, image?: {mime: string, data: Buffer}|null) => AsyncIterable<object>|Promise<AsyncIterable<object>>} deps.post
 *        `image` only on the step that carries the picture
 * @param {(route: { method: "POST", path: string, body: object }) => Promise<{ status: number, body: object|null }>} [deps.call]
 *        the confirm card's button: the server route it names (a task's approve or deny), with
 *        the account's token. Status 0 when it could not be reached. Without it nothing is called.
 * @param {() => string} [deps.approveElsewhere]  the words for an approval that arrived with no card
 *        to ask it on (it is then left waiting, to be answered in Tasks)
 * @param {(url: string) => boolean|void|Promise<boolean|void>} [deps.open]  the server's `open` event
 *        (a hand-off: an email, a message, a search or a route): a link already checked by
 *        safeOpenUrl, to open in the person's browser or mail app. Resolves false (or throws)
 *        when it could not, and the fallback is tried. Without it an `open` does nothing.
 * @param {(text: string) => Promise<void>} deps.paste
 * @param {() => Promise<{mime: string, data: Buffer}|null>} deps.listen
 * @param {(name: string, fallback: any) => any} [deps.knob]
 * @param {"mac"|"win"} [deps.platform]
 * @param {() => number} [deps.now]
 * @param {(line: string) => void} [deps.log]
 * @param {(appName: string) => boolean} [deps.sensitive]  defaults to frontApp.looksSensitive
 * @param {string|(() => string)} [deps.language]
 * @param {(look: object, frame: number[]) => {mime: string, data: Buffer, frame?: number[]}|Promise<{mime: string, data: Buffer, frame?: number[]}|null>|null} [deps.crop]
 *        the part of the look's picture under `frame` (driver units), as a
 *        file, with the part of the window it really shows (`frame`) when that
 *        is not quite what was asked for. Without it there is no picture path.
 * @param {(app: string) => "never"|"ask"|"always"|Promise<string>} [deps.pictures]
 *        whether pictures of this app may go. Without it there is no picture path.
 * @param {(app: string, about: { region: "element"|"window" }) => Promise<"once"|"always"|"no">} [deps.permit]
 *        the guide's permission card, told whether the picture is one image or
 *        the whole window (ringed on screen while it asks). Without it, "ask" is no.
 * @param {string[]|(() => string[])} [deps.names]  the names it answers to, taken
 *        off the front of a question (its own, the guide's, their nickname for it)
 * @param {() => Promise<void>} [deps.afterSpeech]  settles once everything the guide
 *        has been given to say so far has been said. A finished run's card stays up
 *        for it, and doneMs after. Without it, doneMs from the moment the run ends.
 * @param {(o: { question: string, needWhole: boolean }) => Promise<{ outline: string[], text: string, where: string, source: string, truncated: boolean }|null>} [deps.page]
 *        the whole page in front (pageRead.readPage): with needWhole false the tree's
 *        read only; with true, the read a screen at a time when the tree has little.
 *        Without it, step 0 carries no page.
 */
function createAgent(deps) {
  const d = deps || {};
  const driver = d.driver || {};
  const guide = d.guide || {};
  const knob = typeof d.knob === "function" ? d.knob : (_name, fallback) => fallback;
  const now = typeof d.now === "function" ? d.now : Date.now;
  const platform = d.platform === "win" || d.platform === "mac" ? d.platform : process.platform === "win32" ? "win" : "mac";
  const sensitive = typeof d.sensitive === "function" ? d.sensitive : frontApp.looksSensitive;
  // The picture path needs both the crop and the per-app policy; with
  // either missing, no picture is taken with the look, let alone sent.
  const canPicture = typeof d.crop === "function" && typeof d.pictures === "function";

  function log(line) { try { if (typeof d.log === "function") d.log(line); } catch { /* a logger must not stop a run */ } }
  function num(name, fallback) {
    let v;
    try { v = knob(name, fallback); } catch { v = fallback; }
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
  }
  function bool(name, fallback) {
    let v;
    try { v = knob(name, fallback); } catch { v = fallback; }
    return typeof v === "boolean" ? v : fallback;
  }
  /** Whether a private window is read and acted in like any other (the
   *  server's switch; frontApp.privateWindowsOk reads the same one). */
  const privateOk = () => bool("desktop.agent.privateWindows", true);
  /** History the server takes, oldest first. Older turns fall off the front. */
  const historyMax = () => Math.max(1, Math.round(num("desktop.agent.historyMax", 16)));
  /** Words the person reads (desktop.*, through `d.txt`, the knobs' reader); the English here without it. */
  function txt(key, fallback, vars) {
    let v;
    try { v = typeof d.txt === "function" ? d.txt(key, fallback, vars) : undefined; } catch { v = undefined; }
    return typeof v === "string" && v.trim() ? v : localFiles.fill(fallback, vars);
  }

  function language() {
    try { return str(typeof d.language === "function" ? d.language() : d.language); } catch { return ""; }
  }
  function isSensitive(name) {
    try { return !!sensitive(name); } catch { return false; }
  }
  function names() {
    try {
      const n = typeof d.names === "function" ? d.names() : d.names;
      const list = Array.isArray(n) ? n.filter((s) => typeof s === "string" && s.trim()) : [];
      return list.length ? list : resolver.NAMES;
    } catch { return resolver.NAMES; }
  }
  /** Their words against a screen, with this computer's bars. */
  function matchOn(text, screen) {
    // A window's label is its title: never something to point at, and never
    // on the server's list either.
    const els = elementsOf(screen).filter((e) => e.role !== "window");
    return resolver.match(text, els, {
      score: num("desktop.agent.matchScore", 0.85),
      margin: num("desktop.agent.matchMargin", 0.2),
      names: names(),
    });
  }

  /** The run in progress, or null. Everything a run does checks it is still
   *  this one, so a run that was cancelled or has finished can never touch
   *  the guide again, whatever arrives late on its stream. */
  let current = null;
  let seq = 0;
  let hideTimer = null;
  /** Which scheduled hide may still happen: a new question, or a cancel,
   *  moves it on, and a hide still waiting for the last answer's voice
   *  then never comes. */
  let hideGen = 0;

  const alive = (run) => !!run && current === run && !run.over;

  /** A guide call, fire-and-forget. The guide is another window in another
   *  process; one that throws, or answers with a rejection, is logged and
   *  the run goes on. */
  function callGuide(method, args) {
    const fn = guide && guide[method];
    if (typeof fn !== "function") return;
    try {
      const r = fn.apply(guide, args || []);
      if (r && typeof r.then === "function") r.then(null, (e) => log(`agent: guide.${method} failed: ${errText(e)}`));
    } catch (e) {
      log(`agent: guide.${method} threw: ${errText(e)}`);
    }
  }
  function tell(run, method, ...args) { if (alive(run)) callGuide(method, args); }

  /** Whatever `p` gives, or ABORTED the moment the run is cancelled. */
  const race = (run, p) => Promise.race([p, run.aborted]);

  /** The card goes doneMs after the answer has been said. A long answer comes
   *  a sentence at a time and takes far longer to say than doneMs, and the
   *  hide stops the voice where it is: timed from the end of the stream, it
   *  cut off most of what was written, and the card with it. */
  function scheduleHide() {
    unscheduleHide();
    const gen = hideGen;
    const arm = () => {
      if (gen !== hideGen || current) return;
      hideTimer = setTimeout(() => { hideTimer = null; if (!current) callGuide("hide"); }, Math.max(0, num("desktop.agent.doneMs", 9000)));
      // A timer that only tidies the screen need not keep a process alive.
      if (hideTimer && typeof hideTimer.unref === "function") hideTimer.unref();
    };
    if (typeof d.afterSpeech !== "function") { arm(); return; }
    let said;
    try { said = d.afterSpeech(); } catch (e) { log(`agent: afterSpeech threw: ${errText(e)}`); }
    let cap = null;
    new Promise((resolve) => {
      // A finished answer's card waits for its voice to finish before its doneMs starts, but never longer than
      // desktop.agent.speechMaxMs: a voice that never says it has finished does not hold the card up for good.
      cap = setTimeout(resolve, Math.max(0, num("desktop.agent.speechMaxMs", 180000)));
      if (typeof cap.unref === "function") cap.unref();
      Promise.resolve(said).then(resolve, resolve);
    }).then(() => { clearTimeout(cap); arm(); });
  }
  function unscheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = null;
    hideGen++;
  }

  /**
   * The run is over. `how`: "done" (the card says `text`, if any), "error"
   * (the card shows `text` as an error), "quiet" (hide now, nothing to say).
   * Done and error stay on screen for doneMs.
   */
  function finish(run, how, text) {
    if (!alive(run)) return;
    // A tentative ring is a guess at an answer that is not coming now (the
    // look showed a refused window after preview drew it off the tree, the
    // request failed): it does not stay up beside the card.
    if (run.tentative) { run.tentative = false; tell(run, "unpoint"); }
    if (how === "done") {
      if (text) tell(run, "state", "done", text); else tell(run, "state", "done");
    } else if (how === "error") {
      tell(run, "error", text || TEXT.failed);
    }
    run.over = true;
    current = null;
    clearTimeout(run.deadlineTimer);
    // Whatever is still in flight for this run — a stream, a fetch — is
    // dropped, not left to finish into nothing.
    try { run.controller.abort(); } catch { /* already */ }
    if (how === "quiet") callGuide("hide"); else scheduleHide();
    log(`agent ${run.tag}: ${how}${how === "done" && run.stop ? ` (${run.stop})` : ""} after ${run.step + 1} step(s)`);
  }
  function stop(run, why) {
    if (!alive(run)) return;
    run.stop = why;
    finish(run, "done", TEXT[why]);
  }

  /** Read the screen. Always settles, with a Snapshot or { ok:false, error }. */
  function takeSnapshot() {
    const timeoutMs = num("desktop.agent.snapshotTimeoutMs", 1500);
    const max = Math.max(1, Math.min(MAX_ELEMENTS, num("desktop.agent.maxElements", 250)));
    const asked = Promise.resolve().then(() => driver.snapshot({ max, timeoutMs }));
    return within(asked, timeoutMs + SNAPSHOT_GRACE_MS, { ok: false, error: "timeout" }).then(
      (s) => (s && s.ok === true && Array.isArray(s.elements) ? s : { ok: false, error: str((s && s.error) || "no snapshot") }),
      (e) => ({ ok: false, error: errText(e) }),
    );
  }

  /** True when this app's pictures are set never to go, as far as can be
   *  told at once: a policy still to come is not a never yet. One that throws
   *  is, as it is in picturePolicy(). */
  function picturesNever(run) {
    if (!canPicture) return true;
    try {
      const p = d.pictures(appLabel(run));
      if (p && typeof p.then === "function") { p.then(null, () => {}); return false; }
      return p === "never";
    } catch { return true; }
  }

  /** Look at the window: its picture, and its text read by the system's OCR.
   *  Always settles, with a look or { ok:false, error }. The picture itself
   *  is only asked for when one could go: there is a way to send it, and
   *  this app's pictures are not set never to go. A full-window picture of
   *  their mail is not taken, sent over the pipe and kept for the run to no
   *  purpose. When it is, it is at the window's own size: the crop cuts a
   *  small part out of it, and a 4K window brought down to 1600 first sends
   *  an equation at a fraction of its pixels. */
  function takeLook(run) {
    if (!bool("desktop.agent.look", true)) return Promise.resolve({ ok: false, error: "off" });
    if (typeof driver.look !== "function") return Promise.resolve({ ok: false, error: "unsupported" });
    const timeoutMs = num("desktop.agent.lookTimeoutMs", 2500);
    const opts = { budgetMs: num("desktop.agent.lookBudgetMs", 1500), timeoutMs, ocr: true, image: !picturesNever(run) };
    if (opts.image) opts.maxSide = num("desktop.agent.lookMaxSide", 4096);
    const asked = Promise.resolve().then(() => driver.look(opts));
    return within(asked, timeoutMs + SNAPSHOT_GRACE_MS, { ok: false, error: "timeout" }).then(
      (l) => (l && l.ok === true && l.window && isFrame(l.window.frame) ? l : { ok: false, error: str((l && l.error) || "no look") }),
      (e) => ({ ok: false, error: errText(e) }),
    );
  }

  /** Make `snap` the screen the next request describes, with its own id maps.
   *  A failed read leaves an empty screen, not the last one: ids from an old
   *  walk would point at whatever has moved there since. */
  function adopt(run, snap) {
    if (!snap || snap.ok !== true) {
      log(`agent ${run.tag}: screen not read (${(snap && snap.error) || "no snapshot"}); asking without it`);
      run.snapshot = { ok: false, error: (snap && snap.error) || "no snapshot", elements: [] };
    } else {
      if (snap.linesOnly) log(`agent ${run.tag}: tree not read; using the text read off the window`);
      run.snapshot = snap;
      if (!run.firstApp && snap.app && snap.app.name) run.firstApp = str(snap.app.name);
    }
    run.frames = frameMap(run.snapshot);
    run.byId = new Map(elementsOf(run.snapshot).filter((e) => typeof e.id === "string").map((e) => [e.id, e]));
  }

  /** adopt(), unless the screen is now a sensitive app's (or a private
   *  window's, while the server has them off) — an OPEN, a link, a tab or a
   *  key of theirs landed in a bank, a password manager or, then, an
   *  incognito window. The check at begin saw only the window
   *  that was in front then; a browser's app name stays "Google Chrome" on
   *  every site, so the window's title is checked here too, on every screen
   *  the run takes in. Nothing of a refused screen is sent: the run ends
   *  here. False when it did. */
  function adoptChecked(run, snap) {
    const why = refusal(snap);
    if (why) { refuseScreen(run, why); return false; }
    adopt(run, snap);
    return true;
  }

  /** The run ends on a screen it must not read: nothing of it is kept. */
  function refuseScreen(run, why) {
    log(`agent ${run.tag}: the front window is ${why === "private" ? "a private one" : "a sensitive app's"}; stopping`);
    run.snapshot = { ok: false, error: why, elements: [] };
    run.frames = new Map();
    run.byId = new Map();
    run.look = null;
    run.stop = why === "private" ? "private" : "blocked";
    finish(run, "done", why === "private" ? TEXT.blockedPrivate : TEXT.blocked);
  }

  /** refusal() for a look: its window's title, with the tree's app name when
   *  there is one. The picture is of a window too, and a refused one's
   *  picture is no more to be read than its tree. */
  function lookRefusal(look, snap) {
    if (!look || look.ok !== true) return "";
    const title = str(look.window && look.window.title).slice(0, 200);
    if (!title) return "";
    const name = snap && snap.ok === true && snap.app && snap.app.name ? str(snap.app.name) : "";
    if (frontApp.isPrivate(title) && !privateOk()) return "private";
    if (isSensitive(squash(name + " " + title)) || isSensitive(title)) return "sensitive";
    return "";
  }

  /**
   * The first screen of a run, from the two reads begun at Alt twice: the
   * tree with the look's lines after it, and the look itself (for its
   * picture) — or `why` it must not be read at all. Either read may be
   * missing or failed; the other is still used. A look of some other window
   * than the tree's is dropped whole, lines and picture. `quiet` for
   * preview's reading of it, which the run's own reading logs after.
   * @returns {{ why?: string, screen?: object, look?: object|null }}
   */
  function firstScreen(run, snap, look, quiet) {
    const s = snap && snap.ok === true && Array.isArray(snap.elements) ? snap : null;
    const l = look && look.ok === true && look.window && isFrame(look.window.frame) ? look : null;
    const why = (s && refusal(s)) || (l && lookRefusal(l, s)) || "";
    if (why) return { why };
    let usable = l;
    if (l && s && !sameWindow(s, l)) {
      if (!quiet) log(`agent ${run.tag}: the look saw another window than the tree; not using it`);
      usable = null;
    } else if (l && s && s.scale && l.scale && s.scale !== l.scale) {
      if (!quiet) log(`agent ${run.tag}: the look and the tree are in different units; not using the look`);
      usable = null;
    }
    const lines = usable ? ocrElements(s, usable) : [];
    if (s) return { screen: lines.length ? Object.assign({}, s, { elements: elementsOf(s).concat(lines) }) : s, look: usable };
    // No tree (it timed out, the app has none to speak of): the lines alone
    // are still a screen to point at, in the look's window.
    if (lines.length) {
      return {
        screen: {
          ok: true, app: null, window: { frame: usable.window.frame.slice(), title: str(usable.window.title).slice(0, 200) },
          focused: null, selection: "", scale: usable.scale, elements: lines, truncated: false, ms: 0, linesOnly: true,
        },
        look: usable,
      };
    }
    return { screen: snap || { ok: false, error: "no snapshot" }, look: usable };
  }

  /** The screen that preview() matches against: what of the two reads has
   *  arrived, checked like the run's first screen. Null until the tree has
   *  answered, and for a screen that must not be read. */
  function previewScreen(run) {
    if (!run.snapSeen) return null;
    const c = run.previewCache;
    if (c && c.snap === run.snapSeen && c.look === run.lookSeen) return c.screen;
    const first = firstScreen(run, run.snapSeen, run.lookSeen, true);
    const screen = first.why || !first.screen || first.screen.ok !== true ? null : { snapshot: first.screen, frames: frameMap(first.screen) };
    run.previewCache = { snap: run.snapSeen, look: run.lookSeen, screen };
    return screen;
  }

  /** "private" or "sensitive" when this screen must not be read or acted
   *  in, by the app's name and the window's title; "" otherwise. A private
   *  window is read and acted in like any other (only never remembered:
   *  privateWindow), unless the server has them off. */
  function refusal(snap) {
    if (!snap || snap.ok !== true) return "";
    const name = snap.app && snap.app.name ? str(snap.app.name) : "";
    const title = titleOf(snap);
    if (title && frontApp.isPrivate(title) && !privateOk()) return "private";
    if ((name && isSensitive(name)) || (title && isSensitive(squash(name + " " + title)))) return "sensitive";
    return "";
  }

  /** The apps this run counts as "where it started": the short label it was
   *  begun with ("Gmail") and the app the first walk found ("Google Chrome"). */
  const startApps = (run) => [run.app, run.firstApp].filter(Boolean);

  /** The front app's short label, as dictation sends it. After an OPEN moved
   *  the run to another app, that app's own name. */
  function appLabel(run) {
    const s = run.snapshot;
    const name = s && s.ok === true && s.app ? str(s.app.name) : "";
    if (name && run.firstApp && !sameApp(name, [run.firstApp])) return clip(squash(name), 60);
    return clip(squash(run.app || name), 60);
  }

  function buildRequest(run, input) {
    const snap = run.snapshot;
    // The window's text counts against the same budget as the elements.
    const text = snap.ok === true && typeof snap.text === "string" && snap.text.trim() ? stripUrls(snap.text).slice(0, 4000) : "";
    const screen = { elements: toRequestElements(snap, Math.min(MAX_ELEMENTS, num("desktop.agent.maxElements", 250)), SCREEN_CHARS - text.length) };
    const focused = focusedOf(snap);
    // The field's kind in dictation's own words (frontApp.kindOf), so the
    // server reads it the same way on both routes. Never a password's.
    const kind = focused ? frontApp.kindOf(focused.role, focused.secure ? "secure" : "", focused.label) : null;
    // A browser selects the whole URL when its address bar takes focus (a
    // click, Cmd+L), so the selection there is the page's address with its
    // reset tokens and session ids: the very thing toRequestElements keeps
    // off the wire. Nor does any other selection go with a URL's query or
    // fragment in it. It cannot be stripped instead: a rewrite pastes its
    // answer over the whole selection, and a stripped copy would put the
    // link back broken.
    const addressBar = !!focused && (kind === "url" || ((focused.role === "field" || focused.role === "combo") && ADDRESS_BAR.test(squash(focused.label))));
    if (snap.ok === true && typeof snap.selection === "string" && snap.selection && snap.selection.length <= 8000
      && !(focused && focused.secure) && !addressBar && !HAS_URL_TAIL.test(snap.selection)) {
      screen.selection = snap.selection;
    }
    if (focused) {
      if (kind && kind !== "password") {
        screen.field = { kind };
        const label = clip(squash(focused.label), 80);
        if (label) screen.field.label = label;
      }
    }
    if (text) screen.text = text;
    const req = { runId: run.id, step: run.step, platform, app: appLabel(run), screen, tzOffsetMinutes: -new Date().getTimezoneOffset() };
    // A run begun in a private window, or that has been in one since, says so
    // on every step: the server keeps nothing of it.
    if (!run.privateWindow && (frontApp.isPrivate(titleOf(snap)) || (run.look && run.look.window && frontApp.isPrivate(str(run.look.window.title))))) run.privateWindow = true;
    if (run.privateWindow) req.privateWindow = true;
    // With audio, the audio is the words (step 0, or the reply to an ASK).
    // Without, the run's goal goes again: the server keeps nothing between
    // steps, so every step says what the run is for.
    if (!input.audio) {
      const utterance = clip(squash(input.utterance || run.goal), 1000);
      if (utterance) req.utterance = utterance;
    }
    // Which part of the window the picture with this step is: one image on
    // it, or all of it. Where it is stays here, like every other frame.
    if (input.image && input.picture) req.picture = { region: input.picture.region === "element" ? "element" : "window" };
    const lang = language();
    if (lang) req.language = lang;
    // "This computer": the person's own files, offered to the planner only when this copy can do them.
    if (canDevice()) req.capabilities = ["DeviceFiles"];
    if (run.history.length) req.history = run.history.slice(-historyMax()).map((h) => Object.assign({}, h));
    if (run.job) req.job = { goal: run.job.goal, plan: run.job.plan.slice(), done: run.job.done.slice(), notes: run.job.notes.slice() };
    // The whole page, on step 0 only, and never from a screen that must not be read.
    if (run.step === 0 && input.page && !refusal(snap)) {
      const p = input.page;
      const page = {};
      const outline = Array.isArray(p.outline) ? p.outline.filter((l) => typeof l === "string" && l.trim()).slice(0, PAGE_OUTLINE_MAX).map((l) => clip(squash(l), 300)) : [];
      if (outline.length) page.outline = outline;
      if (typeof p.text === "string" && p.text) page.text = stripUrls(p.text).slice(0, PAGE_TEXT_MAX);
      if (typeof p.where === "string" && p.where.trim()) page.where = clip(stripUrls(squash(p.where)), 200);
      if (p.source === "tree" || p.source === "scroll") page.source = p.source;
      if (page.text || page.outline) req.page = page;
    }
    return req;
  }

  function pushHistory(run, turn) {
    const t = {};
    for (const k of ["said", "did", "result", "note", "data"]) if (turn[k]) t[k] = turn[k];
    if (t.said) t.said = clip(t.said, 1000);
    if (t.did) t.did = clip(t.did, 200);
    if (t.note) t.note = clip(t.note, 200);
    // What the files gave back (names, sizes, kinds, dates): lines kept, and only the newest two turns keep it.
    if (t.data) {
      t.data = str(t.data).replace(/[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]+/g, " ").slice(0, DEVICE_DATA_MAX);
      let kept = 0;
      for (let i = run.history.length - 1; i >= 0; i--) if (run.history[i].data && ++kept >= 2) delete run.history[i].data;
    }
    run.history.push(t);
    while (run.history.length > historyMax()) run.history.shift();
  }

  function showPlan(run) {
    if (!run.plan) return;
    // A job's steps are ticked off by the planner (PROGRESS); a short plan's by each step that worked.
    if (run.job) {
      const done = new Set(run.job.done);
      const next = run.plan.findIndex((_, i) => !done.has(i));
      tell(run, "steps", run.plan.map((text, i) => ({ text, state: done.has(i) ? "done" : i === next ? "active" : "todo" })));
      return;
    }
    tell(run, "steps", run.plan.map((text, i) => ({ text, state: i < run.planDone ? "done" : i === run.planDone ? "active" : "todo" })));
  }

  // ---- a long job --------------------------------------------------------------
  //
  // A do-run whose plan has several steps keeps a ledger: the goal, the plan,
  // which steps are finished and what it learned. It goes with every step, so
  // the server (which keeps nothing) never loses the start of a job when the
  // oldest history turns fall off, and the run may take a job's steps and
  // time (desktop.agent.jobMaxSteps, jobDeadlineMs) instead of a small one's.

  function startJob(run, plan, same) {
    if (run.job) {
      // A new plan mid-job: its steps start over; what was kept stays.
      if (!same) { run.job.plan = plan.slice(); run.job.done = []; }
      return;
    }
    run.job = { goal: clip(squash(run.goal), 1000), plan: plan.slice(), done: [], notes: [] };
    const ms = Math.max(num("desktop.agent.deadlineMs", 60000), num("desktop.agent.jobDeadlineMs", 20 * 60000));
    clearTimeout(run.deadlineTimer);
    run.deadline = now() + ms;
    run.deadlineTimer = setTimeout(() => stop(run, "deadline"), ms);
    log(`agent ${run.tag}: a job of ${plan.length} steps`);
  }

  /** The planner's PROGRESS: plan steps finished (0-based), and a fact to keep. */
  function progress(run, ev) {
    if (!run.job) return;
    for (const n of Array.isArray(ev.done) ? ev.done : []) {
      if (Number.isInteger(n) && n >= 0 && n < run.job.plan.length && !run.job.done.includes(n)) run.job.done.push(n);
    }
    run.job.done.sort((a, b) => a - b);
    const note = clip(squash(ev.note), 160);
    if (note && !run.job.notes.includes(note)) {
      run.job.notes.push(note);
      while (run.job.notes.length > JOB_NOTES_MAX) run.job.notes.shift();
    }
    showPlan(run);
  }

  /**
   * HANDOVER: the next part is theirs (a password, a code, a CAPTCHA, card
   * details, a choice). The card says what to do; the run waits, its clock
   * stopped, for Continue (desktop.agent.handoverMs, 10 minutes by default),
   * then reads the screen afresh and goes on. Stop, or no answer, ends it.
   */
  async function handover(run, ev) {
    const text = clip(squash(ev.text), 240) || TEXT.handover;
    const showCard = guide && guide.approve;
    pushHistory(run, { said: run.said, did: "HANDOVER", note: text });
    if (typeof showCard !== "function") { finish(run, "done", text); return null; }
    clearTimeout(run.deadlineTimer);
    run.deadline = Infinity;
    tell(run, "say", text, sayOpts(""));
    const card = {
      title: TEXT.yourTurn, app: appLabel(run), label: "", preview: text, note: TEXT.handoverNote,
      buttons: [{ id: "approve", label: TEXT.handoverGo }, { id: "deny", label: TEXT.handoverStop }],
    };
    const asked = Promise.resolve().then(() => showCard.call(guide, card)).then((v) => (v === "approve" ? "go" : ""), (e) => {
      log(`agent ${run.tag}: guide.approve failed: ${errText(e)}`);
      return "";
    });
    const answer = await race(run, within(asked, num("desktop.agent.handoverMs", 10 * 60000), ""));
    if (!alive(run) || answer === ABORTED) return null;
    if (answer !== "go") { log(`agent ${run.tag}: handover not continued`); finish(run, "done", TEXT.handoverStopped); return null; }
    log(`agent ${run.tag}: handover continued`);
    // Their part may have changed everything: the screen is read again before the next step.
    const after = await race(run, takeSnapshot());
    if (!alive(run)) return null;
    if (!adoptChecked(run, after)) return null;
    pushHistory(run, { did: "HANDOVER", result: "ok", note: "they did their part and pressed Continue" });
    const ms = run.job ? Math.max(num("desktop.agent.deadlineMs", 60000), num("desktop.agent.jobDeadlineMs", 20 * 60000)) : num("desktop.agent.deadlineMs", 60000);
    run.deadline = now() + ms;
    run.deadlineTimer = setTimeout(() => stop(run, "deadline"), ms);
    tell(run, "state", "thinking");
    return {};
  }

  const sayOpts = (locale, append) => {
    const o = { speak: bool("desktop.agent.speak", true), rate: num("desktop.agent.voiceRate", 1.04) };
    if (locale) o.locale = locale;
    if (append) o.append = true;
    return o;
  };

  /** The marks drawn on this screen go, when there are any: the screen is
   *  about to change under them, or a new answer is about to draw its own. */
  function clearMarks(run) {
    if (!run.marks) return;
    run.marks = 0;
    tell(run, "clear");
  }

  /** The server's draw event, placed on this screen and handed to the guide,
   *  or dropped when it cannot be placed. A clear takes them all away. */
  function drawMark(run, ev) {
    if (!bool("desktop.agent.draw", true)) return;
    if (ev.kind === "clear") { clearMarks(run); return; }
    const mark = resolveMark(ev, run.frames, run.pictureFrame);
    if (!mark) {
      log(`agent ${run.tag}: a ${clip(squash(ev.kind), 12) || "mark"} dropped: not on this screen`);
      return;
    }
    // The answer is showing where it means with its own pen: the guess at
    // it (preview's, or the picture's pulsing "Looking" ring round the very
    // thing being drawn on) goes, as it does for the answer's own ring.
    dropTentative(run);
    run.marks += 1;
    tell(run, "draw", mark);
  }

  /** A tentative ring from preview() or the picture path, put away once the
   *  answer it stood in for has come without one of its own. */
  function dropTentative(run) {
    if (!run.tentative) return;
    run.tentative = false;
    run.previewKey = "";
    tell(run, "unpoint");
  }

  /** The events before the terminal one: shown as they arrive. */
  function onEvent(run, ev) {
    switch (ev.t) {
      case "heard": {
        const text = squash(ev.text);
        if (!run.mode && (ev.mode === "show" || ev.mode === "do")) run.mode = ev.mode;
        if (run.fresh && text) run.said = text;
        if (run.step === 0 && text && !run.goal) run.goal = clip(text, 1000);
        if (text && text !== run.lastHeard) { run.lastHeard = text; tell(run, "heard", text); }
        break;
      }
      case "say": {
        // A long answer comes a sentence at a time: each one after the first
        // is added to the card (and to what is said aloud), not put in its place.
        const text = squash(ev.text);
        if (!text) break;
        run.says += 1;
        tell(run, "say", clip(text, 240), sayOpts(typeof ev.locale === "string" ? ev.locale : "", ev.append === true));
        break;
      }
      case "point": {
        const frame = run.frames.get(str(ev.id));
        if (!frame) { log(`agent ${run.tag}: point at ${clip(str(ev.id), 12)} skipped: not on this screen`); break; }
        // The answer's own ring takes the place of a tentative one.
        run.tentative = false;
        const caption = squash(ev.caption);
        if (caption) tell(run, "point", frame, clip(caption, 120)); else tell(run, "point", frame);
        break;
      }
      case "draw":
        drawMark(run, ev);
        break;
      case "steps": {
        const items = (Array.isArray(ev.items) ? ev.items : []).map((s) => clip(squash(s), 120)).filter(Boolean).slice(0, JOB_PLAN_MAX);
        if (!items.length) break;
        // The same plan again (the model repeats it each step) keeps its
        // progress; a new one starts over.
        const same = run.plan && run.plan.length === items.length && run.plan.every((s, i) => s === items[i]);
        if (!same) { run.plan = items; run.planDone = 0; }
        // A do-run with a plan of several steps is a LONG JOB: its ledger goes with every step from now on, and its limits are a job's.
        if (run.mode === "do" && items.length >= 2) startJob(run, items, same);
        showPlan(run);
        break;
      }
      case "progress":
        progress(run, ev);
        break;
      case "open":
        openLink(run, ev);
        break;
      default: break;   // a newer server's event this build does not know
    }
  }

  /** The server's `open` (a hand-off, such as an email written in Gmail): the link, or its fallback, handed to main to open. At most once a run. */
  function openLink(run, ev) {
    if (run.opened) return;
    const links = [safeOpenUrl(ev.url), safeOpenUrl(ev.fallback)].filter(Boolean);
    if (!links.length) { log(`agent ${run.tag}: open skipped: not a link this app opens`); return; }
    if (typeof d.open !== "function") return;
    run.opened = true;
    void (async () => {
      for (const link of links) {
        try { if ((await d.open(link)) !== false) return; } catch (e) { log(`agent ${run.tag}: open failed: ${errText(e)}`); }
      }
    })();
  }

  /** A yes or no from the person, within confirmMs. Silence is no. So is a
   *  guide that cannot ask, or one that throws: only a real yes acts. */
  async function confirm(run, text, risk) {
    const fn = guide && guide.confirm;
    if (typeof fn !== "function") return false;
    const asked = Promise.resolve().then(() => fn.call(guide, text, risk)).then((v) => v === true, (e) => {
      log(`agent ${run.tag}: guide.confirm failed: ${errText(e)}`);
      return false;
    });
    const answer = await race(run, within(asked, num("desktop.agent.confirmMs", 30000), false));
    return answer === true;
  }

  async function drive(method, ...args) {
    const fn = driver && driver[method];
    if (typeof fn !== "function") return { ok: false, error: "unsupported" };
    try {
      const r = await fn.apply(driver, args);
      return r && typeof r === "object" ? r : { ok: false, error: "no answer" };
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
  }

  /** Through the clipboard, like dictation: it replaces a selection, it does
   *  not care what keyboard layout is on, and a web app hears it as typing.
   *  Main's paste, untouched — in particular the clipboard is NOT put back
   *  afterwards: a restore on a timer can land in the middle of the next
   *  paste and put whatever was there before (often a password) into the
   *  message instead. */
  async function pasteText(text) {
    if (typeof d.paste !== "function") return { ok: false, error: "unsupported" };
    try { await d.paste(text); return { ok: true, how: "paste" }; } catch (e) { return { ok: false, error: errText(e) }; }
  }

  /** The front app is a browser, or built on one. */
  function webApp(run) {
    const s = run.snapshot;
    const name = s && s.ok === true && s.app && s.app.name ? str(s.app.name) : run.firstApp || run.app;
    return WEB_APPS.test(squash(name));
  }

  /** SET the way a person would: click into the field, select all of it, and
   *  paste over it. Each step only if the one before worked — a select-all
   *  with focus somewhere else selects the whole page, and a paste after it
   *  replaces the wrong thing. */
  async function pasteInto(run, id, text) {
    const target = run.byId.get(id) || null;
    const before = run.snapshot;
    const focus = await drive("focus", id);
    if (focus.ok !== true) return { ok: false, error: focus.error || "couldn't focus it" };
    if (!alive(run)) return { ok: false, error: "cancelled" };
    // A focus the app said yes to is not always a focus that moved: a web
    // page's wrapper takes the request and keeps nothing, an app answers late.
    // So the screen is read again, and the keys go only when the focused
    // element is the field this step names — otherwise Cmd+A selects a whole
    // document and the paste or Backspace replaces it.
    // A browser moves focus a moment after it says yes (the page takes it and
    // reports back on its next frame), so a first read that still shows the
    // old focus waits a little and looks once more before giving up.
    for (let look = 0; ; look++) {
      if (look) {
        await race(run, sleep(Math.min(150, num("desktop.agent.settleMs", 450))));
        if (!alive(run)) return { ok: false, error: "cancelled" };
      }
      const seen = await race(run, takeSnapshot());
      if (!alive(run)) return { ok: false, error: "cancelled" };
      if (!seen || seen.ok !== true) return { ok: false, error: "couldn't read the focus" };
      // Nothing is typed into a sensitive app either (nor a private window,
      // while the server has them off); the read after the step ends the run there.
      if (refusal(seen)) return { ok: false, error: "not this window" };
      if (focusLandedOn(target, before, seen)) break;
      if (look >= 1) return { ok: false, error: "focus didn't move" };
    }
    const all = await drive("key", platform === "mac" ? "cmd+a" : "ctrl+a");
    if (all.ok !== true) return { ok: false, error: all.error || "couldn't select it" };
    if (!alive(run)) return { ok: false, error: "cancelled" };
    // Emptying a field: there is nothing to paste, so delete what is selected.
    if (!text) return drive("key", "backspace");
    return pasteText(text);
  }

  async function perform(run, a) {
    const id = a.id != null ? str(a.id) : null;
    switch (a.kind) {
      case "press": {
        const pressed = await drive("press", id);
        // A press that timed out, is still running (it opened something
        // modal) or that the app was slow to answer may well have happened:
        // the helper does the work whether or not anyone still waits for it.
        // A click on top of it would press twice — a toggle flips back, Add
        // adds two. So no click: the step counts as failed, and the screen
        // read next says what it did.
        if (pressMayHaveHappened(pressed)) {
          const how = pressed.ok === true ? (pressed.pending === true ? "pending" : "slow") : clip(str(pressed.error), 40);
          log(`agent ${run.tag}: press ${id} came back ${how}; not clicking on top of it`);
          return { ok: false, error: how, maybe: true };
        }
        if (pressed.ok === true) return pressed;
        // Plenty of controls have no press action to call (custom web
        // widgets, canvas apps); a real click at their centre still works.
        log(`agent ${run.tag}: press ${id} failed (${clip(str(pressed.error), 40)}); clicking instead`);
        const clicked = await drive("click", id);
        return clicked.ok === true ? { ok: true, how: "click" } : { ok: false, error: clicked.error || pressed.error };
      }
      case "set": {
        const text = str(a.text);
        if (webApp(run)) return pasteInto(run, id, text);
        const set = await drive("setValue", id, text);
        if (set.ok === true) return set;
        log(`agent ${run.tag}: set ${id} failed (${clip(str(set.error), 40)}); pasting instead`);
        return pasteInto(run, id, text);
      }
      case "type": {
        const text = str(a.text);
        if (!text) return { ok: false, error: "nothing to type" };
        return pasteText(text);
      }
      case "key": {
        const keys = squash(a.keys || a.text);
        return keys ? drive("key", keys) : { ok: false, error: "no keys" };
      }
      case "scroll": {
        const dir = squash(a.dir).toLowerCase() || "down";
        if (!SCROLL_DIRS.has(dir)) return { ok: false, error: "bad direction" };
        return drive("scroll", id, dir, Math.max(1, num("desktop.agent.scrollLines", 5)));
      }
      case "focus": return drive("focus", id);
      case "open": {
        const app = squash(a.app || a.text);
        return app ? drive("open", app) : { ok: false, error: "no app" };
      }
      default: return { ok: false, error: "unknown action" };
    }
  }

  /** Everything the person said in this run, for the risk check that asks
   *  whether a code being typed came from them or from the page. */
  const saidSoFar = (run) => [run.goal, ...run.history.map((h) => h.said), run.said].filter(Boolean).join("\n");

  /** The step's action: checked, confirmed if it needs it, run, and looked
   *  at afterwards. The next input, or null when the run ended here. */
  async function act(run, a) {
    if (run.mode === "show") {
      // The server never sends one in a show run; this is the second lock.
      log(`agent ${run.tag}: refused a ${clip(str(a.kind), 12)} in a show run`);
      finish(run, "done");
      return null;
    }
    if (!ACTION_KINDS.has(a.kind)) {
      log(`agent ${run.tag}: unknown action ${clip(str(a.kind), 12)}`);
      finish(run, "error", TEXT.failed);
      return null;
    }
    const did = actionLine(a);
    const verb = did.split(" ")[0];
    const said = run.said || undefined;
    const el = a.id != null ? run.byId.get(str(a.id)) || null : null;
    if ((NEEDS_ID.has(a.kind) || a.id != null) && !el) {
      // Only ids from the snapshot this step was sent with can be acted on:
      // anything else could be an element nobody has looked at.
      log(`agent ${run.tag}: ${verb} names no element on this screen`);
      pushHistory(run, { said, did, result: "failed", note: "no such element on screen" });
      return {};
    }
    if (el && el.ocr === true) {
      // A line read off the window's picture is something to point at, not
      // a control: the driver has no element behind it to press, focus or
      // fill, and a click at a guess is not what was asked for.
      log(`agent ${run.tag}: ${verb} names a line of text read off the screen`);
      pushHistory(run, { said, did, result: "failed", note: `${clip(str(a.id), 12)} is text read off the screen, not a control` });
      return {};
    }
    const planned = focusedOf(run.snapshot);
    const target = el || (a.kind === "type" || a.kind === "key" ? planned : null);
    const frame = target ? run.frames.get(target.id) || null : null;

    // THE SAME THING A THIRD TIME is a loop, whatever the screen did: A, B, A,
    // B is two buttons undoing each other, and a scroll on a page with a
    // clock or a typing indicator "changes" every time. Checked before the
    // yes, so nobody is asked to approve a step that will not run.
    const print = fingerprint(a, target);
    if ((run.seen.get(print) || 0) >= 2) {
      log(`agent ${run.tag}: ${verb} on the same target a third time; stopping`);
      stop(run, "loop");
      return null;
    }

    const mine = classifyRisk(a, run.snapshot, { startApp: startApps(run), said: saidSoFar(run), trusted: run.trusted === true });
    // ASKED FOR ALREADY, the server's side too: the send they asked to send is marked "confirm" by the server as every send
    // is. A task or a message they gave in so many words (trusted) takes that as their yes, unless the words on the target or
    // in the text are themselves risky (pay, delete…) or the server says "always". Found end to end: a trusted message still
    // asked "Send to #design: …?" before the one press they had asked for.
    const serverRisk = run.trusted === true && a.risk === "confirm" && wordsRisk(a, run.snapshot, true) === "free" ? "free" : a.risk;
    const risk = maxRisk(maxRisk(serverRisk, mine), bool("desktop.agent.confirmAll", false) ? "confirm" : "free");

    if (frame) tell(run, "point", frame);
    if (risk !== "free") {
      log(`agent ${run.tag}: ${verb} needs a yes (${risk}; server said ${clip(str(a.risk), 10) || "nothing"})`);
      const yes = await confirm(run, confirmText(a, target), risk);
      if (!alive(run)) return null;
      if (!yes) {
        pushHistory(run, { said, did, result: "declined" });
        if (frame) tell(run, "unpoint");
        finish(run, "done", TEXT.declined);
        return null;
      }
    }

    // KEYS GO WHEREVER FOCUS IS NOW, not where it was when the step was
    // planned. A click while the guide was asking, a notification taking
    // focus, a dialog opening: the keystrokes would land somewhere nobody
    // chose. So the focus is read again first, and a key or a paste only
    // goes ahead into the same element (role and label) it was planned for.
    if (a.kind === "key" || a.kind === "type") {
      const nowSnap = await race(run, takeSnapshot());
      if (!alive(run)) return null;
      // The same field in a window that is now private (one of theirs opened
      // while the guide was asking) is still not one to type in.
      if (refusal(nowSnap)) {
        if (frame) tell(run, "unpoint");
        adoptChecked(run, nowSnap);
        return null;
      }
      const moved = focusMoved(run.snapshot, nowSnap);
      if (moved) {
        log(`agent ${run.tag}: ${verb} not sent: focus moved since the step was planned`);
        if (frame) tell(run, "unpoint");
        if (!adoptChecked(run, nowSnap)) return null;
        pushHistory(run, { said, did, result: "failed", note: moved });
        return {};
      }
    }

    // The marks were drawn on the screen this is about to change, and would
    // be left pointing at whatever moves there next. The ring on the target
    // stays; the next step's answer draws on the screen it finds.
    clearMarks(run);
    run.seen.set(print, (run.seen.get(print) || 0) + 1);
    tell(run, "state", "acting", acting(a, target));
    // From here the screen may change, and the picture taken at Alt twice
    // shows one that may no longer be there.
    run.acted = true;
    const r = await race(run, perform(run, a));
    if (!alive(run)) return null;
    // Give the app a moment to redraw before reading it again: a menu takes
    // a frame or two to open, a dialog longer.
    await race(run, sleep(num("desktop.agent.settleMs", 450)));
    if (!alive(run)) return null;
    if (frame) tell(run, "unpoint");

    const before = run.snapshot;
    const after = await race(run, takeSnapshot());
    if (!alive(run)) return null;
    if (!adoptChecked(run, after)) return null;

    const ok = !!r && r.ok === true;
    let note;
    if (ok) note = describeChange(before, after);
    else if (r && r.maybe === true) {
      // Not a failure the model should simply try again: what did change, if
      // anything, goes with it.
      const change = describeChange(before, after);
      note = clip("press may have happened" + (change && change !== "nochange" ? "; " + change : ""), 200);
    } else note = clip("failed" + (r && r.error ? ": " + squash(r.error) : ""), 200);
    const result = !ok ? "failed" : note === "nochange" ? "nochange" : "ok";
    const prev = run.history[run.history.length - 1];
    pushHistory(run, { said, did, result, note });
    log(`agent ${run.tag}: step ${run.step} ${verb} → ${result}`);
    if (ok && run.plan) { run.planDone = Math.min(run.planDone + 1, run.plan.length - 1); showPlan(run); }
    if (result === "nochange" && prev && prev.did === did && prev.result === "nochange") {
      stop(run, "stuck");
      return null;
    }
    return {};
  }

  // ---- this computer's files (localfiles.js) ------------------------------------

  /** This copy can look after the person's files: main handed in the way to. */
  function canDevice() {
    const dev = d.device;
    if (!dev || typeof dev.plan !== "function") return false;
    try { return typeof dev.enabled === "function" ? dev.enabled() !== false : true; } catch { return false; }
  }

  /** The plan card's words: the server's, one voice, each kept to what a card holds; ours in English where it sent none. */
  function deviceWords(sent) {
    const w = Object.assign({}, localFiles.EN_WORDS);
    if (sent && typeof sent === "object") for (const k of Object.keys(w)) if (typeof sent[k] === "string" && squash(sent[k])) w[k] = clip(squash(sent[k]), 300);
    return w;
  }

  /** The plan, as the guide's confirm card draws it: the headline, then each file's line. */
  function planCard(p, w) {
    const rows = (Array.isArray(p.lines) ? p.lines : []).map((l) => `• ${clip(squash(l), 90)}`);
    const preview = [
      localFiles.fill(w[p.say && p.say.key] || "", p.say && p.say.vars),
      ...rows,
      p.more > 0 ? localFiles.fill(w.more, { n: p.more }) : "",
      p.extra ? clip(squash(p.extra), 120) : "",
    ].filter(Boolean).join("\n");
    const trash = p.risk === "destructive";
    return {
      title: trash ? w.titleTrash : w.title,
      app: txt("desktop.files.thisComputer", "This computer"), label: w.label, preview,
      note: trash ? w.noteTrash : w.note,
      buttons: [{ id: "approve", label: w.ok }, { id: "deny", label: w.later }],
    };
  }

  /**
   * The server's `device` event: something to do to the person's own files.
   * localfiles.js plans it first (no change made), and holds its own risk
   * table, rules and folders: the server's word is only a request. A look
   * runs at once. A change shows its plan on a card and waits for a yes (said
   * once per kind of change and then remembered, never for the Trash, and not
   * for a big one); the outcome goes back to the server on the next step as
   * this turn's `data`: names, sizes, kinds and dates, never contents.
   */
  async function device(run, ev) {
    const tool = clip(squash(str(ev.tool)), 40);
    const did = `DEVICE ${tool}`;
    const said = run.said || undefined;
    const dev = d.device;
    const failed = (why) => { pushHistory(run, { said, did, result: "failed", note: why, data: why }); return {}; };
    if (!canDevice()) { log(`agent ${run.tag}: a device event with no files to work on`); return failed("this computer can’t do that here"); }
    const id = clip(squash(str(ev.id)), 64);
    run.deviceIds = run.deviceIds || new Set();
    if ((id && run.deviceIds.has(id)) || run.deviceIds.size >= DEVICE_PER_RUN) { log(`agent ${run.tag}: device event refused (repeat or too many)`); finish(run, "done"); return null; }
    run.deviceIds.add(id || String(run.deviceIds.size));
    let p;
    try { p = await race(run, Promise.resolve().then(() => dev.plan(tool, ev.args && typeof ev.args === "object" ? ev.args : {}))); } catch (e) {
      log(`agent ${run.tag}: device plan failed: ${errText(e)}`);
      p = { ok: false, error: "that didn’t work" };
    }
    if (!alive(run) || p === ABORTED) return null;
    if (!p || p.ok !== true) return failed(clip(squash(p && p.error) || "I can’t do that", 200));
    const risk = localFiles.higher(p.risk, ["read", "write", "destructive"].includes(ev.risk) ? ev.risk : "");
    // The server never asks for a change in a show run; this is the second lock.
    if (risk !== "read" && run.mode === "show") { log(`agent ${run.tag}: refused a change in a show run`); finish(run, "done"); return null; }
    const w = deviceWords(ev.words);
    log(`agent ${run.tag}: ${tool} (${risk}${p.count ? `, ${p.count} files` : ""})`);
    if (risk !== "read") {
      const big = (p.count || 0) > DEVICE_BIG;
      // A name in the person's files can say anything (a download's name is whoever sent it's text), and the planner
      // has read names in this run: so a change that follows a look at them asks, said yes to before or not.
      const known = risk === "write" && !big && !run.sawNames && typeof dev.remembered === "function" && (() => { try { return dev.remembered(tool) === true; } catch { return false; } })();
      if (!known) {
        const showCard = guide && guide.approve;
        if (typeof showCard !== "function") { log(`agent ${run.tag}: no card to ask on`); finish(run, "done", w.left); return null; }
        // The person's time on the card is theirs, not the run's.
        clearTimeout(run.deadlineTimer);
        run.deadline = Infinity;
        const asked = Promise.resolve().then(() => showCard.call(guide, planCard(p, w))).then((v) => (v === "approve" ? v : ""), (e) => {
          log(`agent ${run.tag}: plan card failed: ${errText(e)}`);
          return "";
        });
        const answer = await race(run, within(asked, num("desktop.agent.confirmMs", 30000), ""));
        if (!alive(run) || answer === ABORTED) return null;
        if (answer !== "approve") {
          log(`agent ${run.tag}: ${tool} not approved`);
          pushHistory(run, { said, did, result: "declined", note: "they said no" });
          finish(run, "done", w.left);
          return null;
        }
        if (risk === "write" && typeof dev.remember === "function") { try { dev.remember(tool); } catch (e) { log(`agent ${run.tag}: remember failed: ${errText(e)}`); } }
        // The run's clock starts again once the card has been answered.
        const again = num("desktop.agent.deadlineMs", 60000);
        run.deadline = now() + again;
        run.deadlineTimer = setTimeout(() => stop(run, "deadline"), again);
      }
    }
    tell(run, "state", "acting", clip(squash(w.working), 60));
    let res;
    try { res = await race(run, Promise.resolve().then(() => p.run())); } catch (e) {
      log(`agent ${run.tag}: ${tool} threw: ${errText(e)}`);
      res = { ok: false, text: "that didn’t work", note: "that didn’t work" };
    }
    if (!alive(run) || res === ABORTED) return null;
    const r = res && typeof res === "object" ? res : {};
    if (risk === "read" && (tool === "find_files" || tool === "list_folder") && str(r.text)) run.sawNames = true;
    pushHistory(run, { said, did, result: r.ok === false ? "failed" : "ok", note: clip(squash(r.note), 200), data: str(r.text) });
    log(`agent ${run.tag}: step ${run.step} ${tool} → ${r.ok === false ? "failed" : "ok"}`);
    return {};
  }

  /** The server's yes-or-no before it does something in a connected app. */
  async function approve(run, ev) {
    const card = approvalOf(ev);
    const showCard = guide && guide.approve;
    if (!card || typeof showCard !== "function" || typeof d.call !== "function") {
      log(`agent ${run.tag}: an approval with no card to ask it on`);
      // Its words are a label (ask.js), asked for here and never written here.
      let words = "";
      try { words = clip(squash(typeof d.approveElsewhere === "function" ? d.approveElsewhere() : ""), 240); } catch { /* none */ }
      finish(run, "done", words || undefined);
      return null;
    }
    // The person's time on the card is theirs, not the run's: the deadline
    // does not tick while it is up, and starts again if the run goes on.
    clearTimeout(run.deadlineTimer);
    run.deadline = Infinity;
    const asked = Promise.resolve().then(() => showCard.call(guide, card)).then((v) => (CARD_BUTTONS.includes(v) ? v : ""), (e) => {
      log(`agent ${run.tag}: guide.approve failed: ${errText(e)}`);
      return "";
    });
    const answer = await race(run, within(asked, num("desktop.agent.confirmMs", 30000), ""));
    if (!alive(run) || answer === ABORTED) return null;
    // No answer leaves it waiting, where Tasks can still say yes within the hour.
    if (!answer) { log(`agent ${run.tag}: approval unanswered`); finish(run, "done", card.after.left || undefined); return null; }
    const button = card.buttons.find((b) => b.id === answer);
    log(`agent ${run.tag}: approval ${answer}`);
    if (answer === "approve") tell(run, "state", "acting");
    const r = await race(run, within(
      Promise.resolve().then(() => d.call(button.call)).then((v) => (v && typeof v === "object" ? v : { status: 0, body: null }), (e) => {
        log(`agent ${run.tag}: approval call failed: ${errText(e)}`);
        return { status: 0, body: null };
      }),
      num("desktop.agent.approveCallMs", 25000), { status: 0, body: null },
    ));
    if (!alive(run) || r === ABORTED) return null;
    const body = r.body && typeof r.body === "object" ? r.body : {};
    const said = (v) => clip(squash(v), 240);
    if (r.status === 0) { finish(run, "error", TEXT.network); return null; }
    if (answer === "approve") {
      if (r.status === 200 && body.ok === true) {
        // The card's own "Done", and nothing of the app's answer (its ids,
        // links and raw words are for the server, not for the person).
        finish(run, "done", said(card.after.done) || undefined);
      } else {
        const why = r.status === 200 && body.error && typeof body.error === "object" ? body.error.message : body.message;
        finish(run, "error", said([r.status === 200 ? card.after.failed : "", why].filter(Boolean).join(" ")) || TEXT.failed);
      }
      return null;
    }
    // A no that arrives after the task has moved on (409) is still a no.
    if (r.status !== 200 && r.status !== 409) { finish(run, "error", said(body.message) || TEXT.failed); return null; }
    if (answer === "deny") { finish(run, "done", card.after.left || undefined); return null; }
    // Edit: this one is left, and what to change is asked for out loud.
    pushHistory(run, { said: run.said, did: "EDIT", result: "declined", note: card.preview });
    const again = num("desktop.agent.deadlineMs", 60000);
    run.deadline = now() + again;
    run.deadlineTimer = setTimeout(() => stop(run, "deadline"), again);
    return ask(run, { text: card.after.change });
  }

  async function ask(run, ev) {
    const question = clip(squash(ev.text), 240);
    pushHistory(run, { said: run.said, did: "ASK", note: question });
    if (question) tell(run, "say", question, sayOpts(""));
    // Listening only when the microphone opens at once (desktop.agent.askOpensMic); otherwise the question stays
    // up, waiting for the key, and the card does not pretend to listen.
    tell(run, "state", bool("desktop.agent.askOpensMic", false) ? "listening" : "showing");
    let audio = null;
    try {
      if (typeof d.listen === "function") audio = await race(run, Promise.resolve().then(() => d.listen()));
    } catch (e) {
      log(`agent ${run.tag}: listen failed: ${errText(e)}`);
    }
    if (!alive(run)) return null;
    if (!hasAudio(audio)) { log(`agent ${run.tag}: no reply`); finish(run, "quiet"); return null; }
    return { audio };
  }

  /** One request and its stream. The next input, or null when the run ended. */
  async function step(run, input) {
    // Each answer draws on the screen it finds. What the last one drew and
    // nothing has cleared (an ASK's numbered choices, once they have picked
    // one; the marks of a step whose action never ran) goes before the next
    // is asked for: left up, the same mark is drawn again on top of itself.
    clearMarks(run);
    if (run.step > 0) tell(run, "state", "thinking");
    run.says = 0;
    const audio = input.audio || null;
    const image = input.image || null;
    run.fresh = !!audio || !!input.utterance;
    run.said = input.utterance ? clip(squash(input.utterance), 1000) : "";
    const req = buildRequest(run, input);
    if (image) {
      run.pictureSent = true;
      // Where the picture is, for the answer's marks in it. Never sent.
      run.pictureFrame = isFrame(input.pictureFrame) ? input.pictureFrame.slice() : null;
    }
    log(`agent ${run.tag}: step ${run.step} (${audio ? "audio" : "text"}${image ? " + picture" : ""}, ${req.screen.elements.length} elements)`);

    let source;
    try {
      source = d.post(req, audio, run.controller.signal, image);
      if (source && typeof source.then === "function") source = await race(run, source);
    } catch (e) {
      if (!alive(run)) return null;
      log(`agent ${run.tag}: post failed: ${errText(e)}`);
      finish(run, "error", TEXT.network);
      return null;
    }
    if (!alive(run)) return null;
    const it = iteratorOf(source);
    if (!it) { finish(run, "error", TEXT.failed); return null; }

    let terminal = null;
    try {
      for (;;) {
        const r = await race(run, it.next());
        if (!alive(run) || r === ABORTED) return null;
        if (!r || r.done) break;
        const ev = r.value;
        if (!ev || typeof ev !== "object" || typeof ev.t !== "string") continue;
        if (TERMINAL.has(ev.t)) { terminal = ev; break; }
        onEvent(run, ev);
      }
    } catch (e) {
      if (!alive(run)) return null;
      log(`agent ${run.tag}: stream broke: ${errText(e)}`);
      terminal = { t: "error", code: "network", message: TEXT.network };
    } finally {
      // Exactly one terminal event ends a stream; anything after it is not
      // read, and the connection is let go.
      close(it);
    }

    // The answer is in. A tentative ring it did not replace was a guess
    // (preview's, or the picture's "Looking"), and goes now.
    dropTentative(run);
    if (!terminal) {
      log(`agent ${run.tag}: stream ended with no answer`);
      finish(run, "error", TEXT.incomplete);
      return null;
    }
    switch (terminal.t) {
      case "look":
        return lookAgain(run, input);
      case "done": {
        if (run.plan) { run.planDone = run.plan.length; if (run.job) run.job.done = run.plan.map((_, i) => i); showPlan(run); }
        // DONE's words are the card's whole text, in place of what it said;
        // after an answer said a sentence at a time, they come after it
        // instead. Words with no letter or digit in them ("DONE.") are none.
        const text = clip(squash(terminal.text), 240);
        const words = /[\p{L}\p{N}]/u.test(text) ? text : "";
        if (words && run.says) { tell(run, "say", words, sayOpts("", true)); finish(run, "done"); } else finish(run, "done", words);
        return null;
      }
      case "error":
        log(`agent ${run.tag}: server error ${clip(str(terminal.code), 40)}`);
        finish(run, "error", clip(squash(terminal.message), 240) || TEXT.failed);
        return null;
      case "ask":
        return ask(run, terminal);
      case "approve":
        return approve(run, terminal);
      case "device":
        return device(run, terminal);
      case "handover":
        return handover(run, terminal);
      default:
        return act(run, terminal);
    }
  }

  // ---- the picture path -------------------------------------------------------

  /** Whether pictures of this run's app may go: "never", "always" or "ask"
   *  (anything else is asked about too). "never" with no way to send one. */
  async function picturePolicy(run) {
    if (!canPicture) return "never";
    let policy;
    try {
      policy = await race(run, Promise.resolve().then(() => d.pictures(appLabel(run))));
    } catch (e) {
      log(`agent ${run.tag}: pictures() failed: ${errText(e)}`);
      return "never";
    }
    return policy === "never" || policy === "always" ? policy : "ask";
  }

  /** The person's say for this app, on the guide's permission card: once,
   *  always, or no. Asked at most once a run, and a card nobody answers
   *  within confirmMs is a no, as a confirm is. While the card asks, what
   *  would go is ringed on the screen, and the card is told whether it is
   *  one image or the whole window: "this part of the screen" is a part they
   *  can see. A no takes the ring away with it. */
  async function askPermission(run, pic) {
    if (run.permit) return run.permit !== "no";
    if (typeof d.permit !== "function") return false;
    ringPicture(run, pic);
    const region = pic.picture.region;
    const asked = Promise.resolve().then(() => d.permit(appLabel(run), { region })).then((v) => v, (e) => {
      log(`agent ${run.tag}: permit() failed: ${errText(e)}`);
      return "no";
    });
    const answer = await race(run, within(asked, num("desktop.agent.confirmMs", 30000), "no"));
    if (!alive(run)) return false;
    run.permit = answer === "once" || answer === "always" ? answer : "no";
    log(`agent ${run.tag}: picture ${run.permit === "no" ? "not allowed" : `allowed (${run.permit})`}`);
    if (run.permit === "no") dropTentative(run);
    return run.permit !== "no";
  }

  /** The part of the window a picture is of, ringed lightly as "Looking":
   *  once, from when the card asks about it (or, with no card to ask, when it
   *  goes) until the answer comes. */
  function ringPicture(run, pic) {
    if (pic.ringed) return;
    pic.ringed = true;
    run.previewKey = "";
    run.tentative = true;
    tell(run, "point", pic.frame, TEXT.looking, { tentative: true });
  }

  /** The part of the look's picture the question is about, cropped here:
   *  { image, picture, frame }, or null when there is none to send. Only the
   *  picture taken at Alt twice, and only while the screen is still the one
   *  it shows (nothing has been done to it). */
  async function cropPicture(run) {
    const look = run.look;
    if (!canPicture || !look || !look.image || run.acted) return null;
    const { frame, region } = pictureRegion(run.snapshot, look, run.pointer);
    let file;
    try {
      file = await race(run, Promise.resolve().then(() => d.crop(look, frame)));
    } catch (e) {
      log(`agent ${run.tag}: crop failed: ${errText(e)}`);
      return null;
    }
    if (!alive(run)) return null;
    // Only the three types the server takes: another would go labelled as a
    // JPEG (pictureFile) and be answered about as noise.
    if (!file || typeof file !== "object" || !hasBytes(file.data) || !/^image\/(?:jpe?g|png|webp)\b/i.test(str(file.mime))) {
      log(`agent ${run.tag}: crop gave no picture`);
      return null;
    }
    if (byteSize(file.data) > MAX_PICTURE_BYTES) {
      log(`agent ${run.tag}: the picture is too big to send (${byteSize(file.data)} bytes)`);
      return null;
    }
    // Where the picture really is: what the crop really cut (the region kept
    // to the window, in whole pixels of the picture), and the answer's places
    // in the picture are places in what was sent. A region too small to crop
    // is no picture at all (pictureRegion grows one to MIN_CROP_PX first).
    const shows = isFrame(file.frame) && file.frame[2] > 0 && file.frame[3] > 0 ? file.frame.slice() : frame;
    return { image: { mime: str(file.mime).toLowerCase(), data: file.data }, picture: { region }, frame: shows };
  }

  /** The picture for this step, if the person's policy and answer allow it:
   *  the crop is made first (nothing leaves this computer for it), so a card
   *  asking to send it never comes up for a picture there is not. */
  async function allowedPicture(run) {
    const policy = await picturePolicy(run);
    if (!alive(run) || policy === "never") return null;
    const pic = await cropPicture(run);
    if (!pic || !alive(run)) return null;
    if (policy === "ask" && !(await askPermission(run, pic))) return null;
    return alive(run) ? pic : null;
  }

  /** What is being looked at, on the screen and on the card, and the step
   *  input that sends it. */
  function withPicture(run, pic, input) {
    ringPicture(run, pic);
    tell(run, "badge", TEXT.pictureSent);
    return Object.assign({}, input, { image: pic.image, picture: pic.picture, pictureFrame: pic.frame });
  }

  /**
   * The text path's answer was LOOK: it needs to see the picture. The same
   * step goes again with it — once a run, with the same permission as ever,
   * and only while the picture still shows the screen. Otherwise the card
   * says it can't, and the run ends.
   */
  async function lookAgain(run, input) {
    log(`agent ${run.tag}: the answer needs the picture`);
    const pic = !run.pictureSent && !run.acted && run.look && run.look.image ? await allowedPicture(run) : null;
    if (!alive(run)) return null;
    if (!pic) {
      // No look at all because the Mac has not let Tailzu see the screen:
      // said so, with the way to it, rather than a "can't" they cannot act
      // on. The helper never asks for the permission itself (tzax.swift).
      // Not for an app whose pictures are set never to go.
      const noScreen = !run.look && !!run.lookSeen && run.lookSeen.error === "no_screen_permission" && !picturesNever(run);
      tell(run, "say", noScreen ? TEXT.needScreen : TEXT.needLook, sayOpts(""));
      if (noScreen) {
        log(`agent ${run.tag}: no Screen Recording permission`);
        tell(run, "offer", "screenSettings");
      }
      finish(run, "done");
      return null;
    }
    // The answer comes again, from the picture, with marks of its own; what
    // the text answer drew goes first.
    clearMarks(run);
    // The words of this step (the server heard them already), so they are
    // not transcribed twice; the recording again only when there are none.
    const words = run.said || run.goal;
    const again = words ? { utterance: words } : { audio: input.audio || null, utterance: input.utterance };
    return Object.assign(withPicture(run, pic, again), { sameStep: true });
  }

  // ---- the first step -------------------------------------------------------------

  /** "Where's Export?" answered here: the ring on it, "Here's Export.", and
   *  done — no request at all. False when its frame is gone. */
  function instant(run, text, m) {
    const frame = run.frames.get(m.id);
    if (!frame) return false;
    const label = squash(m.label);
    run.goal = text;
    run.mode = "show";
    tell(run, "heard", text);
    tell(run, "say", clip(`Here's ${label.replace(/[\s.…:]+$/u, "")}.`, 240), sayOpts(""));
    run.tentative = false;
    tell(run, "point", frame, clip(label, 120));
    log(`agent ${run.tag}: instant (${clip(m.id, 12)}, score ${m.score.toFixed(2)}, margin ${m.margin.toFixed(2)})`);
    finish(run, "done");
    return true;
  }

  /**
   * Step 0's input, by the three paths, cheapest first: answered here
   * (instant; null, the run is over), a picture with the question, or the
   * words — the live caption's when there are some, else the recording.
   *
   * Only the stream's final caption is the question. One it had not finished
   * (`final` false: its last words were still to come when it was stopped)
   * may be missing the end ("where is the save" of "…save as") and its
   * question mark with it, so nothing that cannot be taken back is done on
   * it: no instant answer, no picture. The recording goes instead, and is
   * heard whole; only with no recording do those words go.
   */
  async function firstInput(run, first) {
    if (first.utterance) return { utterance: first.utterance };
    const text = first.text || "";
    const audio = first.audio || null;
    const final = first.final === true;
    if (text && final && bool("desktop.agent.instant", true)) {
      const m = matchOn(text, run.snapshot);
      if (m && m.intent === "show" && instant(run, text, m)) return null;
    }
    // Only a question with words: a recording nobody has transcribed yet
    // cannot say whether it is about a picture, and no picture goes on a guess.
    if (text && final && run.look && run.look.image && resolver.isVisualQuestion(text, names())) {
      const pic = await allowedPicture(run);
      if (!alive(run)) return null;
      if (pic) {
        run.goal = text;
        return withPicture(run, pic, { utterance: text });
      }
    }
    if (text && (!audio || (final && bool("desktop.agent.useStreamText", true)))) {
      run.goal = text;
      return { utterance: text };
    }
    return audio ? { audio } : null;
  }

  /** deps.page, never throwing; null for nothing. */
  async function askPage(o) {
    try {
      const p = await d.page(o);
      return p && typeof p === "object" && typeof p.text === "string" ? p : null;
    } catch (e) {
      log(`agent: page failed: ${errText(e)}`);
      return null;
    }
  }

  /**
   * Step 0's page: the tree's read begun at Alt twice, waited for a short
   * while; and when that has little and the question is about the whole
   * thing, the read a screen at a time (pageRead.js). Null when there is
   * none, or the screen must not be read.
   */
  async function firstPage(run, input) {
    if (!run.pagePromise || refusal(run.snapshot)) return null;
    let p = await race(run, within(run.pagePromise, num("desktop.agent.pageWaitMs", 1500), null));
    if (p === ABORTED || !alive(run)) return null;
    const question = input.utterance || run.goal || "";
    const thin = !p || p.text.length < num("desktop.page.minChars", 400);
    if (thin && question && needsWhole(question)) {
      const more = await race(run, within(askPage({ question, needWhole: true }), num("desktop.agent.pageScrollMs", 20000), null));
      if (more === ABORTED || !alive(run)) return null;
      if (more && (!p || more.text.length > p.text.length)) p = more;
    }
    if (!p || (!p.text && !(Array.isArray(p.outline) && p.outline.length))) return null;
    log(`agent ${run.tag}: page (${clip(squash(p.source), 10)}, ${p.text.length} chars)`);
    return p;
  }

  async function loop(run, first) {
    run.started = true;
    tell(run, "state", "thinking");
    const deadlineMs = num("desktop.agent.deadlineMs", 60000);
    run.deadline = now() + deadlineMs;
    // Checked between steps on the injected clock, and enforced by a timer
    // as well, for a stream that hangs without ever closing.
    // (Not unref'd: for a stream that hangs, it is the one thing left that
    // will wake the run. Every way a run ends clears it.)
    run.deadlineTimer = setTimeout(() => stop(run, "deadline"), deadlineMs);
    try {
      // The screen was being read, both ways, while they spoke; the first
      // step waits for it (never past each read's own timeout). A failed read
      // still asks — "what does this error mean?" can be answered from the
      // words alone. Both are checked before anything of them is used: a
      // refused window's picture is as refused as its tree.
      const got = await race(run, Promise.all([run.snapPromise, run.lookPromise]));
      if (!alive(run) || got === ABORTED) return;
      const [snap, look] = got;
      const screen = firstScreen(run, snap, look);
      if (screen.why) { refuseScreen(run, screen.why); return; }
      adopt(run, screen.screen);
      run.look = screen.look || null;
      if (look && look.ok !== true && look.error !== "off" && look.error !== "unsupported") {
        log(`agent ${run.tag}: no look (${clip(squash(look.error), 40)})`);
      }
      let input = await firstInput(run, first);
      if (!alive(run)) return;
      if (!input) { finish(run, "quiet"); return; }
      const page = await firstPage(run, input);
      if (!alive(run)) return;
      if (page) input = Object.assign({}, input, { page });
      const maxSteps = Math.max(1, num("desktop.agent.maxSteps", 8));
      // A long job may take a job's steps (startJob); everything else, a small run's.
      const limit = () => (run.job ? Math.max(maxSteps, num("desktop.agent.jobMaxSteps", 60)) : maxSteps);
      while (alive(run)) {
        if (run.step >= limit()) { stop(run, "steps"); return; }
        if (now() >= run.deadline) { stop(run, "deadline"); return; }
        const next = await step(run, input);
        if (!next || !alive(run)) return;
        input = next;
        // The same step again, with the picture it asked for.
        if (!next.sameStep) run.step++;
      }
    } catch (e) {
      log(`agent ${run.tag}: run failed: ${errText(e)}`);
      finish(run, "error", TEXT.failed);
    }
  }

  /**
   * Alt twice. Refused outright for a sensitive app, or a screen marked off
   * limits (`privateField`) — nothing is read. A private window (`privateWindow`)
   * is read and acted in like any other, and every step tells the server so,
   * which keeps nothing of it; while the server has them off (privateOk) it
   * is refused too. Otherwise the guide starts listening and the screen is
   * read at the same time, while they are still speaking: the tree, and a
   * look at the window (its text and its picture), in parallel.
   * @param {{ app?: string, privateField?: boolean, privateWindow?: boolean, sensitive?: boolean, pointer?: { x: number, y: number }, trusted?: boolean }} [opts]
   *        `pointer` in the driver's units (Windows: physical pixels); `trusted`: the person asked for this
   *        task or message in so many words, so its ordinary steps are not asked about (classifyRisk)
   * @returns {boolean} whether a run began
   */
  function begin(opts) {
    const o = opts || {};
    if (current) cancel("restart");
    // The last answer's card, still up (still being said, or in its doneMs),
    // is this question's now: nothing of the last run puts it away.
    unscheduleHide();
    // The last answer's marks may still be up beside its card: this question
    // starts on a clean screen, refused or not.
    callGuide("clear");
    const privateOff = !!o.privateWindow && !privateOk();
    if (o.privateField || privateOff || o.sensitive) {
      const priv = !!o.privateField || privateOff;
      log(`agent: refused (${priv ? "private window" : "sensitive app"})`);
      callGuide("error", [priv ? TEXT.private : TEXT.sensitive]);
      scheduleHide();
      return false;
    }
    const p = o.pointer;
    const pointer = p && typeof p.x === "number" && typeof p.y === "number" && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null;
    const controller = new AbortController();
    const id = crypto.randomUUID().replace(/-/g, "");
    const run = {
      token: ++seq, id, tag: id.slice(0, 8), controller,
      aborted: new Promise((resolve) => controller.signal.addEventListener("abort", () => resolve(ABORTED), { once: true })),
      over: false, started: false, stop: "",
      app: clip(squash(o.app), 60), firstApp: "", privateWindow: !!o.privateWindow,
      snapshot: { ok: false, error: "not read yet", elements: [] }, frames: new Map(), byId: new Map(),
      mode: null, step: 0, history: [], goal: "", said: "", fresh: false, lastHeard: "", seen: new Map(),
      plan: null, planDone: 0, job: null, deadline: 0, deadlineTimer: null, snapPromise: null, lookPromise: null, pagePromise: null,
      pointer, look: null, snapSeen: null, lookSeen: null, previewCache: null, previewKey: "", tentative: false,
      acted: false, pictureSent: false, permit: "", pictureFrame: null, marks: 0, says: 0,
      // Asked for in so many words (the one key's brain: a task or a message, no money, nothing deleted).
      trusted: o.trusted === true,
    };
    current = run;
    callGuide("show", ["listening", { app: run.app }]);
    // Kept as they arrive, for preview(), which cannot wait for them.
    run.snapPromise = takeSnapshot().then((s) => { run.snapSeen = s; return s; });
    run.lookPromise = takeLook(run).then((l) => { run.lookSeen = l; return l; });
    // The whole page, from the tree, after the snapshot: the helper does one
    // thing at a time, and the snapshot is what the first step waits on. Not
    // read at all from a screen that must not be.
    if (typeof d.page === "function" && bool("desktop.agent.page", true)) {
      run.pagePromise = run.snapPromise.then((snap) => (alive(run) && !refusal(snap) ? askPage({ question: "", needWhole: false }) : null));
    }
    log(`agent ${run.tag}: begun`);
    return true;
  }

  /**
   * The live caption so far, while they are still speaking. A question or an
   * order that already names one thing on screen clearly puts a tentative
   * ring on it — moved when the target changes, put away when the words stop
   * naming one. Never acts, and never reads anything itself: only what the
   * reads begun at Alt twice have brought back, checked as the run's first
   * screen will be.
   */
  function preview(text) {
    const run = current;
    if (!run || run.started || run.over) return;
    if (!bool("desktop.agent.instant", true)) return;
    const screen = previewScreen(run);
    const words = clip(squash(text), 1000);
    const m = screen && words ? matchOn(words, screen.snapshot) : null;
    const frame = m && (m.intent === "show" || m.intent === "do") ? screen.frames.get(m.id) || null : null;
    const key = frame ? `${m.id}@${frame.join(",")}` : "";
    if (key === run.previewKey) return;
    run.previewKey = key;
    if (!frame) {
      if (run.tentative) { run.tentative = false; tell(run, "unpoint"); }
      return;
    }
    run.tentative = true;
    tell(run, "point", frame, clip(squash(m.label), 120), { tentative: true });
  }

  /**
   * They stopped speaking: step 0. `audio` is the recording; `opts.text` the
   * live caption's transcript of it (may be empty), `opts.final` whether that
   * is the stream's final text or only what it had so far. Resolves when the
   * run is over (nothing waits on it in main; the tests do).
   */
  function heard(audio, opts) {
    const run = current;
    if (!run || run.started) { log("agent: heard with no run waiting for it"); return Promise.resolve(); }
    const o = opts || {};
    const text = clip(squash(o.text), 1000);
    const clipIn = hasAudio(audio) ? audio : null;
    if (!clipIn && !text) { finish(run, "quiet"); return Promise.resolve(); }
    if (text) log(`agent ${run.tag}: heard with ${o.final === true ? "the final" : "a partial"} caption`);
    return loop(run, { audio: clipIn, text, final: o.final === true });
  }

  /** Esc, the card's ×, Alt twice while running — whatever the integrator
   *  wires to it. Only ever called on purpose: the key hook cannot tell this
   *  run's own synthetic keys and clicks from the person's, so "they started
   *  typing" is not a signal this file listens for. The run stops where it
   *  is, its request is aborted and the guide goes away. */
  function cancel(reason) {
    unscheduleHide();
    const run = current;
    if (!run) { callGuide("hide"); return false; }
    run.over = true;
    current = null;
    clearTimeout(run.deadlineTimer);
    try { run.controller.abort(); } catch { /* already */ }
    log(`agent ${run.tag}: cancelled (${clip(squash(reason) || "cancel", 30)})`);
    callGuide("hide");
    return true;
  }

  function active() { return !!current; }

  return { begin, heard, preview, cancel, active };
}

// What ask.js uses: the run, and three of its pieces.
module.exports = { createAgent, safeOpenUrl, isTaskRoute, makePost };
