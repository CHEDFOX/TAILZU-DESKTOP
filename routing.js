// ONE KEY, AND THE WORDS GO WHERE THEY ARE MEANT (router.js decides; this
// does it, session by session, for main.js).
//
// A dictation's words come back a stretch at a time (a pause writes what was
// said so far). Its first words decide how the rest is handled:
//
//   type   a text box has focus and nothing says otherwise: every stretch is
//          pasted the moment it is written, exactly as dictation always was.
//          Nothing here waits for anything first.
//   hold   the words may be for somewhere else ("Tailzu, …", "take notes",
//          a question with no text box in front): nothing is pasted, and when
//          the person stops, router.route() decides on all of it.
//
// What a held session can become:
//   type / rewrite   pasted after all, in order (a selection's rewrite is the
//                    server's, as before)
//   ask              handed to Ask (ask.js askHeard), about the app in front
//   notesStart/Stop  meeting notes started or stopped (main.js's own)
//   bot              a bot's task: the backend's own pick of who answers
//                    (/v1/shell/route, "Ask any bot"'s), then /v1/shell/ask
//   unclear          the backend is asked who answers: a bot, or else Ask
//
// THE ONE-TAP FIX. After a route the pill says what it did and offers one
// other thing ("Typed · Ask instead", "Sent to Plan bot · Type it instead").
// Choosing it undoes the first and does the other: what was typed is taken
// back with the app's own undo, a question is put away, and a bot's task or a
// notes command is held for a moment before it goes, so taking it back is
// simply not sending it.
//
// Every effect is a dependency (main.js passes its own), so the flow can be
// run in the tests with fakes:
//   d.on()                   routing is on (the one key, on a Mac or Windows)
//   d.signals()              { names, askOn, notesOn, bots }
//   d.type(sid, chunks)      paste these, in order, the usual way → Promise
//   d.undo(times)            the app in front's own undo, `times` times → Promise
//   d.ask(message)           hand the words to Ask → true when it took them
//   d.askCancel()            put Ask's question away
//   d.notes(start)           start (true) or stop (false) meeting notes
//   d.whichBot(message, slug)  { slug, name, confidence } or null (the backend's pick)
//   d.sendBot(message, slug) → { name, text } or null
//   d.botAnswered(reply)     say the bot's answer (a notification)
//   d.pill(state, data)      the pill; d.pillRest() puts a label we left back to rest
//   d.knobs                  { num, bool, txt }
//   d.setTimeout, d.clearTimeout, d.log
"use strict";
const router = require("./router.js");

function createRouting(d) {
  const { num, bool, txt } = d.knobs;
  const later = d.setTimeout || setTimeout;
  const cancelTimer = d.clearTimeout || clearTimeout;
  const log = d.log || (() => {});
  const sessions = new Map();   // sid → { ours, field, mode, chunks, heard, typed }
  let offer = null;             // the route the pill is offering the alternative to
  let labelTimer = null;

  const on = () => { try { return d.on() === true; } catch { return false; } };
  const signals = () => { try { return d.signals() || {}; } catch { return {}; } };
  const input = (s, heard) => Object.assign({}, signals(), { heard, field: s.field, ours: s.ours });
  const words = (c) => String((c && (c.heard || c.text)) || "").trim();
  const heardOf = (s) => s.heard.filter(Boolean).join(" ").trim();

  function session(sid) { return sessions.get(sid) || null; }

  /** A dictation began. Any alternative still offered is over: the next
   *  thing they said is what they meant. A bot's task or a notes command
   *  waiting out its moment goes now. */
  function start(sid, o) {
    commit();
    sessions.set(sid, { ours: !!(o && o.ours), field: undefined, mode: null, chunks: [], heard: [], typed: 0, pasted: [] });
    for (const k of sessions.keys()) if (sessions.size > 16 && k !== sid) sessions.delete(k);
  }

  /** The field read answered: null (no text box), or { selection? }. */
  function field(sid, f) {
    const s = session(sid);
    if (s && s.field === undefined) s.field = f && typeof f === "object" ? { selection: typeof f.selection === "string" ? f.selection : "" } : null;
  }

  /** A stretch of a running session: "type" (paste it) or "hold". */
  function chunk(sid, c) {
    const s = session(sid);
    if (!on() || !s) return "type";
    if (c && c.heard) s.heard.push(String(c.heard));
    else if (c && c.text) s.heard.push(String(c.text));
    if (s.mode === null) {
      if (!words(c)) return "type";        // nothing said yet: nothing to decide on
      s.mode = router.firstLook(input(s, heardOf(s)));
    }
    if (s.mode === "hold") { s.chunks.push(c); return "hold"; }
    typed(s, c);
    return "type";
  }
  /** Pasted by main as it came: counted (for the undo), and kept (for typing it again). */
  function typed(s, c) {
    if (!c || !c.text) return;
    s.typed++;
    s.pasted.push({ text: c.text, join: c.join });
  }

  /**
   * The session's last stretch. "type": main pastes it as it always has and
   * shows the pill as before; "labelled": the same, but the pill shows what
   * was done (a close call) instead; "routed": this took the words, main
   * pastes nothing.
   */
  function end(sid, c, current) {
    const s = session(sid);
    if (!on() || !s) return "type";
    sessions.delete(sid);
    if (c && c.heard) s.heard.push(String(c.heard));
    else if (c && c.text) s.heard.push(String(c.text));
    const all = heardOf(s);
    // One stretch, all of it at the stop: the same first look as a pause gets.
    if (s.mode === null) {
      if (!all) return "type";
      s.mode = router.firstLook(input(s, all));
    }
    if (s.mode === "type") {
      typed(s, c);
      if (!current || !all) return "type";
      // Typed as it came. Said so only when it was a close call, with the
      // other thing beside it.
      const r = router.route(input(s, all));
      const other = r.to === "ask" || r.to === "unclear" ? "ask" : r.to === "bot" ? "bot" : r.close ? r.alt : null;
      if (!other || (other === "ask" && !signals().askOn)) return "type";
      // Nothing typed, nothing to take back; too much, and the app's undo is not to be trusted with it.
      if (!s.typed || s.typed > Math.max(1, num("desktop.route.undoMaxPastes", 3))) return "type";
      return label({ kind: "typed", sid, route: r, alt: other, typed: s.typed, message: r.message, chunks: s.pasted }) ? "labelled" : "type";
    }
    const chunks = s.chunks.concat(c && (c.text || c.heard) ? [c] : []);
    void perform(router.route(input(s, all)), sid, chunks, current);
    return "routed";
  }

  // ---- doing it ---------------------------------------------------------------------

  /** Paste the held words after all. */
  function typeAll(sid, chunks, message) {
    const written = chunks.filter((c) => c && c.text);
    return d.type(sid, written.length ? written : message ? [{ text: message }] : []);
  }

  /** `current`: the session is still the one in front. One answered after the
   *  next dictation began (`quiet`) is done all the same, but the pill is that
   *  dictation's: nothing is said on it, and there is no moment to take it back. */
  async function perform(r, sid, chunks, current) {
    const quiet = !current;
    log(`route: ${r.to} (${r.why})`);
    if (r.to === "type" || r.to === "rewrite") {
      const n = chunks.filter((c) => c && c.text).length;
      await typeAll(sid, chunks, "");
      if (r.close && r.alt && !quiet && n && n <= Math.max(1, num("desktop.route.undoMaxPastes", 3))) {
        label({ kind: "typed", sid, route: r, alt: r.alt, typed: n, message: r.message, chunks: chunks.filter((c) => c && c.text) });
      } else if (!quiet) d.pill("rest");
      return;
    }
    if (r.to === "ask") return toAsk(r, sid, chunks, quiet);
    if (r.to === "notesStart" || r.to === "notesStop") return toNotes(r, sid, chunks, quiet);
    if (r.to === "bot" || r.to === "unclear") return toBot(r, sid, chunks, quiet);
    await typeAll(sid, chunks, "");
    if (!quiet) d.pill("rest");
  }

  async function toAsk(r, sid, chunks, quiet) {
    // The label first: Ask's card then grows from a seed of its own instead
    // of taking the pill from under it (main.js pillAsk asks holdsPill).
    label({ kind: "asked", sid, route: r, alt: "type", message: r.message, chunks, quiet });
    const mine = offer;
    let took = false;
    try { took = !!(await d.ask(r.message)); } catch { took = false; }
    // Refused (a private window, a bank, not signed in): its card says why.
    if (!took && offer === mine && mine) { offer = null; cancelTimer(labelTimer); d.pillRest(); }
  }

  function toNotes(r, sid, chunks, quiet) {
    const start = r.to === "notesStart";
    // Held a moment, so "Type it instead" is simply not doing it.
    label({
      kind: "notes", sid, route: r, alt: "type", message: r.message, chunks, quiet,
      pending: () => d.notes(start), graceMs: num("desktop.route.notesGraceMs", 2000),
      done: start ? txt("desktop.route.notesOn", "Taking notes") : txt("desktop.route.notesOff", "Notes stopped"),
    });
  }

  async function toBot(r, sid, chunks, quiet) {
    // Which bot: the backend's own pick ("Ask any bot"), told the one they
    // named, if they named one. Unsure, or nobody fits: Ask, then typing.
    let who = null;
    try { who = await d.whichBot(r.message, r.named && r.slug ? r.slug : undefined); } catch { who = null; }
    const sure = who && who.slug && who.slug !== "tailzu" && !(r.to === "unclear" && Number(who.confidence) < num("desktop.route.botConfidence", 0.5));
    if (!sure) {
      if (signals().askOn) return toAsk(Object.assign({}, r, { to: "ask" }), sid, chunks, quiet);
      await typeAll(sid, chunks, r.message);
      if (!quiet) d.pill("rest");
      return;
    }
    const name = who.name || who.slug;
    label({
      kind: "bot", sid, route: r, alt: "type", message: r.message, chunks, bot: name, quiet,
      graceMs: num("desktop.route.botGraceMs", 3500),
      pending: () => {
        Promise.resolve().then(() => d.sendBot(r.message, who.slug)).then((reply) => {
          if (reply) { try { d.botAnswered(Object.assign({ name }, reply)); } catch { /* said nothing */ } }
          else d.pill("error", { label: txt("desktop.route.botFailed", "Couldn't reach your bots") });
        }, () => d.pill("error", { label: txt("desktop.route.botFailed", "Couldn't reach your bots") }));
      },
      done: txt("desktop.route.sent", "Sent to {bot}", { bot: name }),
    });
  }

  // ---- the pill's label and its alternative --------------------------------------------

  function labelText(o) {
    switch (o.kind) {
      case "typed": return o.route.to === "rewrite" ? txt("desktop.route.rewrote", "Rewrote it") : txt("desktop.route.typed", "Typed");
      case "asked": return txt("desktop.route.asked", "Asked Tailzu");
      case "notes": return o.route.to === "notesStart" ? txt("desktop.route.notesOn", "Taking notes") : txt("desktop.route.notesOff", "Notes stopped");
      case "bot": return txt("desktop.route.sent", "Sent to {bot}", { bot: o.bot });
      default: return "";
    }
  }
  function altText(a) {
    if (a === "ask") return txt("desktop.route.altAsk", "Ask instead");
    if (a === "bot") return txt("desktop.route.altBot", "Send to a bot");
    if (a === "type") return txt("desktop.route.altType", "Type it instead");
    return "";
  }

  /** Show what was done, with its alternative, for a while. A pending action
   *  (a bot's task, a notes command) goes when its moment is up, or at once
   *  when the next dictation starts; until then the alternative cancels it. */
  function label(o) {
    commit();
    // Not the session in front any more: done now, said nothing.
    if (o.quiet) { go(o); return false; }
    if (!bool("desktop.route.labels", true) && !o.pending) return false;
    offer = Object.assign({ at: Date.now() }, o);
    const shown = offer;
    if (bool("desktop.route.labels", true)) d.pill("routed", { label: labelText(o), alt: altText(o.alt) });
    const ms = Math.max(1000, num("desktop.route.labelMs", 5000));
    cancelTimer(labelTimer);
    if (o.pending) {
      shown.timer = later(() => {
        if (offer !== shown) return;
        go(shown);
        // Done now: the label stays a moment longer, with nothing to take back.
        if (bool("desktop.route.labels", true) && shown.done) d.pill("routed", { label: shown.done, alt: "" });
      }, Math.max(0, Math.min(ms, Number(o.graceMs) || 0)));
    }
    labelTimer = later(() => {
      if (offer !== shown) return;
      commit();
      offer = null;
      d.pillRest();
    }, ms);
    return true;
  }

  /** A held action, done (once). */
  function go(o) {
    if (!o || !o.pending || o.went) return;
    o.went = true;
    cancelTimer(o.timer);
    try { o.pending(); } catch (e) { log("route: " + ((e && e.message) || e)); }
  }
  /** Whatever is waiting goes now; the alternative is no longer offered. */
  function commit() {
    const o = offer;
    if (!o) return;
    offer = null;
    cancelTimer(labelTimer);
    go(o);
  }

  /** The pill's alternative was chosen: undo what was done, do the other. */
  async function alternative() {
    const o = offer;
    if (!o) return false;
    // Already gone out: there is nothing left to take back.
    if (o.pending && o.went) return false;
    offer = null;
    cancelTimer(labelTimer);
    cancelTimer(o.timer);
    log(`route: alternative to ${o.kind}: ${o.alt}`);
    d.pill("rest");
    if (o.kind === "typed") {
      // What was typed comes out with the app's own undo, once per paste.
      try { await d.undo(o.typed); } catch { /* the app had no undo; the other thing still happens */ }
      if (o.alt === "ask") return toAsk(Object.assign({}, o.route, { to: "ask" }), o.sid, o.chunks);
      if (o.alt === "bot") return toBot(Object.assign({}, o.route, { to: "bot" }), o.sid, o.chunks);
      return true;
    }
    if (o.kind === "asked") { try { d.askCancel(); } catch { /* already gone */ } }
    // asked, a bot's task held, a notes command held: typed instead.
    await typeAll(o.sid, o.chunks, o.message);
    return true;
  }

  /** The pill is showing our label (Ask leaves it be until it is gone). */
  function holdsPill() { return !!offer && bool("desktop.route.labels", true); }

  /** A session thrown away (✕, an error): forget it. */
  function forget(sid) { sessions.delete(sid); }

  return { start, field, chunk, end, alternative, holdsPill, forget, commit };
}

/**
 * The command that takes back the last `times` pastes in the app in front,
 * with its own undo (⌘Z, Ctrl+Z): [file, args] for execFile. The same way
 * main.js pastes (System Events, SendKeys, xdotool).
 */
function undoCommand(platform, times) {
  const n = Math.max(1, Math.min(10, Math.floor(Number(times) || 1)));
  if (platform === "darwin") {
    return ["osascript", ["-e", 'tell application "System Events"', "-e", `repeat ${n} times`, "-e", 'keystroke "z" using command down',
      "-e", "delay 0.05", "-e", "end repeat", "-e", "end tell"]];
  }
  if (platform === "win32") {
    return ["powershell", ["-NoProfile", "-WindowStyle", "Hidden", "-Command",
      `Add-Type -AssemblyName System.Windows.Forms; 1..${n} | ForEach-Object { [System.Windows.Forms.SendKeys]::SendWait('^z'); Start-Sleep -Milliseconds 50 }`]];
  }
  return ["xdotool", ["key", "--clearmodifiers", "--repeat", String(n), "--delay", "50", "ctrl+z"]];
}

module.exports = { createRouting, undoCommand };
