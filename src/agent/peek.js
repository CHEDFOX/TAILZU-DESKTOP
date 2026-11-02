// The peek: Blip over the text box at the cursor while a dictation records.
// What the peek may be doing, and the watch that asks the driver where the
// caret is (createPeekWatch).

// What a peek can be doing (guide/peek.js peek): watching the words go in while
// the microphone is open, watching the last of them be written, and the
// little hop when they have landed.
const PEEK_STATES = new Set(["listening", "writing", "done"]);
// How long the guide takes to duck Blip back below the edge (guide/
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

module.exports = { PEEK_STATES, PEEK_GONE_MS, peekFrame, createPeekWatch };
