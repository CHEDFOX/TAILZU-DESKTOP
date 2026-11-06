// THE SERVER'S NOTIFICATIONS ON THIS COMPUTER: Plan Ease's reminders and day notes, with their buttons (the backend's
// docs/plan-ease.md; design A4 "Desktop" and B11).
//
// The phone gets Plan Ease's pushes. This computer gets the same ones as its own notifications while the person is at it: the server
// sends a notice here only when this computer was used in the last 10 minutes, and the phone's copy then comes without a sound, so
// nothing rings twice. A click opens the page it is about (the Plan page, or the hand-off screen that opens Maps). On a Mac its
// buttons (Done, Later, Move it, Keep, ...) answer it where it is, through the door the phone's buttons use (POST /v1/widgets/act,
// with the account's session and a key, so a retried press never acts twice). Windows and Linux get no buttons, because Electron's
// are macOS only: a click opens the Plan page, where the same question waits.
//
// ONE SOCKET OF ITS OWN to WS /v1/live. The window's closes when the window is put away, and this is a tray app, so the main process
// keeps one while signed in. It signs in with its first message, reconnects, answers pings and renews exactly as the window's does
// (src/app/live.js LiveClient), over src/runner/ws.js (Electron 31's Node has no WebSocket). After each "ready" it says:
//
//   { type: "notices", v: 1, buttons }   this socket shows notices; buttons: true on a Mac
//   { type: "here", idleMs }             how long since the person last used this computer (keyboard or pointer): at once, then
//                                        every desktop.notices.hereMs (60 s), and again on unlock and on waking
//   { type: "here", away: true }         the screen locked, or the computer is going to sleep: the phone rings again
//
// and hears, among the topics every socket hears (the rest are the window's business, not this one's):
//
//   { type: "event", topic: "notice", data: { id, kind, title, body, screenId?, params?, item?, category?, silent?, until? } }
//   { type: "event", topic: "notice", data: { id, gone: true } }    answered somewhere else: taken off this screen too
//
// The words arrive lock-safe (the server's planSafe.ts: no amount, a health title as "Appointment", nobody else's words): this file
// only cuts them to length. A button comes from the bootstrap's push.categories, the same list the phone registers, so a renamed
// button needs no release here either; a notice names its category and the item its buttons answer. At most 2 buttons.
//
// OFF until the server says it sends them (desktop.notices.enabled, set only by a server that does), so a server that never will
// is never told anything and costs nothing. Every effect is handed in, so the tests run it with a fake socket and fake clocks.

"use strict";

const { LiveClient, wsUrlOf } = require("../app/live.js");

const CAT_ID = /^[A-Za-z0-9_]{1,40}$/;
const BUTTON_ID = /^[a-z0-9_]{1,24}$/;
const NOTICE_ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const KIND = /^[a-z0-9_]{1,40}$/;
const SCREEN_ID = /^[A-Za-z0-9_.-]{1,80}$/;
const PARAM_KEY = /^[A-Za-z0-9_]{1,40}$/;
// The act door's items (the backend's widgets/items.ts): a kind and its parts, letters, digits, _ . - between the ":".
const ITEM = /^[a-z][a-z0-9_]{0,15}(?::[A-Za-z0-9_.-]{1,80}){1,4}$/;
const MAX_BUTTONS = 2;
const TITLE_MAX = 120;
const BODY_MAX = 400;
const DAY_MS = 86400000;
const HOUR_MS = 3600000;

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const oneLine = (s, max) => {
  const t = String(s || "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, " ").replace(/[ \t]+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
};

/** A notice as it is shown, or null for anything that is not one of ours. `gone` takes one off the screen. */
function cleanNotice(data) {
  if (!isObj(data) || typeof data.id !== "string" || !NOTICE_ID.test(data.id)) return null;
  if (data.gone === true) return { id: data.id, gone: true };
  const title = oneLine(data.title, TITLE_MAX);
  const body = oneLine(data.body, BODY_MAX);
  if (!title && !body) return null;
  const out = { id: data.id, kind: typeof data.kind === "string" && KIND.test(data.kind) ? data.kind : "", title, body, silent: data.silent === true };
  if (typeof data.screenId === "string" && SCREEN_ID.test(data.screenId)) {
    out.screenId = data.screenId;
    const params = {};
    if (isObj(data.params)) {
      for (const [k, v] of Object.entries(data.params).slice(0, 8)) {
        if (PARAM_KEY.test(k) && (typeof v === "string" || typeof v === "number")) params[k] = String(v).slice(0, 200);
      }
    }
    out.params = params;
  }
  if (typeof data.item === "string" && ITEM.test(data.item)) out.item = data.item;
  if (typeof data.category === "string" && CAT_ID.test(data.category)) out.category = data.category;
  const until = Number(data.until);
  if (Number.isFinite(until) && until > 0) out.until = until;
  return out;
}

/**
 * The notice's buttons, from the server's categories (the bootstrap's push.categories): the category it names, its first two
 * buttons that do something here. `act` needs the item it answers; `open` is a click. A typed reply or a call is the phone's only.
 */
function buttonsFor(categories, notice) {
  if (!notice || !notice.category || !Array.isArray(categories)) return [];
  const cat = categories.find((c) => isObj(c) && c.id === notice.category);
  if (!cat || !Array.isArray(cat.actions)) return [];
  const out = [];
  for (const a of cat.actions) {
    if (out.length >= MAX_BUTTONS) break;
    if (!isObj(a) || typeof a.id !== "string" || !BUTTON_ID.test(a.id) || isObj(a.input)) continue;
    const title = oneLine(a.title, 40);
    if (!title) continue;
    if (typeof a.act === "string" && BUTTON_ID.test(a.act)) { if (notice.item) out.push({ id: a.id, title, act: a.act }); }
    else if (a.open === true) out.push({ id: a.id, title, open: true });
  }
  return out;
}

/** An answer's one-time key, in the phone's shape (the act door's KEY_RE: 8 to 120 of letters, digits, _ . : -). */
function actKey(random = Math.random, now = Date.now()) {
  let r = "";
  while (r.length < 12) r += Math.floor(random() * 36).toString(36);
  return "d" + now.toString(36) + r.slice(0, 12);
}

/** Worth sending again: the network's trouble or the server's, never a refusal. */
function retryable(status) {
  return status === undefined || status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * A ws.js connection as live.js's LiveClient expects a socket to look (onopen, onmessage, onclose, send, close). The connection
 * is made asynchronously; a close asked for before it lands closes it as it lands.
 */
function socketOf(connect, url) {
  const s = {
    onopen: null, onmessage: null, onclose: null, onerror: null, conn: null, closed: false,
    send(text) { if (!s.conn || s.conn.send(text) === false) throw new Error("not open"); },
    close() { s.closed = true; if (s.conn) { try { s.conn.close(1000, ""); } catch { /* gone */ } } },
  };
  Promise.resolve().then(() => connect(url)).then((conn) => {
    if (s.closed) { try { conn.close(1000, ""); } catch { /* gone */ } return; }
    s.conn = conn;
    conn.on("message", (data) => { if (s.onmessage) s.onmessage({ data }); });
    conn.on("close", (info) => { if (s.onclose) s.onclose({ code: info && info.code }); });
    conn.on("error", () => { if (s.onerror) s.onerror(); });
    if (s.onopen) s.onopen();
  }, () => { if (!s.closed && s.onclose) s.onclose({ code: 1006 }); });
  return s;
}

const realTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h), now: () => Date.now() };

/**
 * d: {
 *   signedIn(), on()          signed in, and the server sends notices (desktop.notices.enabled) to a computer that can show them
 *   baseUrl()                 the API's address (config.json's baseUrl)
 *   token()                   the account's access token now (may be a promise), or null
 *   connect(url)              a ws.js connection (connectWs)
 *   Notification              Electron's
 *   buttons                   a Mac: its notifications can carry buttons
 *   categories()              the bootstrap's push.categories
 *   post(path, body)          → { status } as the signed-in person
 *   open(target)              the app window, on { screenId, params } (null: as it is)
 *   idleMs()                  since the person last used this computer
 *   locked()                  optional: the screen is locked now (a wake can come before the unlock)
 *   owed: { read(), write(list) }   answers still on their way, kept across a restart
 *   knobs: { num, bool, txt, str }, title()   the fallback title (the app's name)
 *   timers, random, log
 * }
 */
function createNotices(d) {
  const t = d.timers || realTimers;
  const random = d.random || Math.random;
  const log = d.log || (() => {});
  const { num, txt, str } = d.knobs;
  const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  const shown = new Map();   // id → { note, timer }; held here so a click is not collected before it fires
  let running = false;
  let locked = false;
  let hereTimer = null;

  const client = new LiveClient({
    open: (url) => socketOf(d.connect, url),
    url: () => { const b = safe(d.baseUrl, ""); return b ? wsUrlOf(b, str("live.path", "/v1/live")) : null; },
    token: () => (safe(d.signedIn, false) ? d.token() : null),
    onEvent: (topic, m) => { if (topic === "notice") heard(m && m.data); },
    onReady: () => {
      client.send({ type: "notices", v: 1, buttons: !!d.buttons });
      here();
      void flushOwed();
    },
    timers: t,
    random,
  });

  /** How long since the person used this computer, or away while it is locked or asleep. */
  function here() {
    if (!running) return;
    if (locked || safe(() => !!(d.locked && d.locked()), false)) { client.send({ type: "here", away: true }); return; }
    const idle = Math.max(0, Math.round(Number(safe(d.idleMs, 0)) || 0));
    client.send({ type: "here", idleMs: idle });
  }
  function tick() {
    if (hereTimer != null) t.clear(hereTimer);
    hereTimer = null;
    if (!running) return;
    // An answer that could not land a moment ago goes again with it.
    hereTimer = t.set(() => { here(); void flushOwed(); tick(); }, Math.max(15000, num("desktop.notices.hereMs", 60000)));
  }

  // ---- showing one ----------------------------------------------------------------------------

  function heard(data) {
    const n = cleanNotice(data);
    if (!n || !running) return;
    if (n.gone) { close(n.id); return; }
    show(n);
  }

  function openFor(n) {
    safe(() => d.open(n && n.screenId ? { screenId: n.screenId, params: n.params || {} } : null));
  }

  function forget(id, entry) {
    const e = shown.get(id);
    if (!e || (entry && e !== entry)) return;
    if (e.timer != null) t.clear(e.timer);
    shown.delete(id);
  }

  function close(id) {
    const e = shown.get(id);
    if (!e) return;
    forget(id, e);
    try { e.note.close(); } catch { /* already gone */ }
  }

  function show(n) {
    // The same notice again (said twice, or changed): the new one takes the old one's place.
    close(n.id);
    // Its moment already over (a leave-by heard late): nothing to show.
    const left = n.until ? n.until - t.now() : Infinity;
    if (left <= 0) return;
    const btns = d.buttons ? buttonsFor(safe(d.categories, []), n) : [];
    let note;
    try {
      note = new d.Notification(Object.assign(
        { title: n.title || safe(d.title, "") || "X0 Bot", body: n.body, silent: n.silent },
        btns.length ? { actions: btns.map((b) => ({ type: "button", text: b.title })) } : {},
      ));
    } catch (e) { log("notices: could not make one: " + ((e && e.message) || e)); return; }
    const entry = { note, timer: null };
    shown.set(n.id, entry);
    note.on("click", () => { forget(n.id, entry); openFor(n); });
    note.on("action", (_e, index) => {
      const b = btns[Number(index)];
      forget(n.id, entry);
      if (!b) { openFor(n); return; }
      if (b.open) { openFor(n); return; }
      void press(n, b);
    });
    note.on("close", () => forget(n.id, entry));
    note.on("failed", () => forget(n.id, entry));
    try { note.show(); } catch (e) { forget(n.id, entry); log("notices: not shown: " + ((e && e.message) || e)); return; }
    // Its moment over (a leave-by is no use after it): taken off by itself.
    if (left <= DAY_MS) entry.timer = t.set(() => close(n.id), left);
    // Never a pile: the oldest go first.
    const max = Math.max(1, num("desktop.notices.max", 8));
    while (shown.size > max) close(shown.keys().next().value);
  }

  // ---- a button pressed -------------------------------------------------------------------------

  const readOwed = () => { const l = safe(() => d.owed.read(), []); return Array.isArray(l) ? l.filter((o) => isObj(o) && isObj(o.body)) : []; };
  const writeOwed = (l) => safe(() => d.owed.write(l.slice(-20)));

  async function sendOne(o) {
    let status;
    try {
      const res = await d.post(str("push.actions.path", "/v1/widgets/act"), o.body);
      status = res && typeof res.status === "number" ? res.status : undefined;
    } catch { status = undefined; }
    if (status !== undefined && status >= 200 && status < 300) return "done";
    return retryable(status) ? "again" : "refused";
  }

  function settle(o, outcome) {
    const rest = readOwed().filter((x) => x.key !== o.key);
    if (outcome === "again") { writeOwed(rest.concat([Object.assign({}, o, { tries: (Number(o.tries) || 0) + 1 })])); return; }
    writeOwed(rest);
    if (outcome !== "refused") return;
    // Already answered, or not theirs any more: said quietly, and a click finishes it in the app.
    try {
      const note = new d.Notification({
        title: txt("push.actions.failedTitle", "Couldn't do that from here"),
        body: txt("push.actions.failedBody", "Open X0 to finish it."),
        silent: true,
      });
      note.on("click", () => openFor(o));
      note.show();
    } catch { /* said nothing */ }
  }

  /** Written down first, then sent: offline, it goes again the next time the socket is up, with the same key. */
  async function press(n, b) {
    const key = actKey(random, t.now());
    const o = { key, body: { item: n.item, action: b.act, key }, at: t.now(), tries: 0 };
    if (n.screenId) { o.screenId = n.screenId; o.params = n.params || {}; }
    writeOwed(readOwed().filter((x) => x.key !== key).concat([o]));
    settle(o, await sendOne(o));
  }

  let flushing = false;
  async function flushOwed() {
    if (flushing || !safe(d.signedIn, false)) return;
    flushing = true;
    try {
      const now = t.now();
      const keep = Math.max(1, num("push.actions.keepHours", 24)) * HOUR_MS;
      const tries = Math.max(1, num("push.actions.maxTries", 5));
      const all = readOwed();
      const live = all.filter((o) => now - Number(o.at) < keep && (Number(o.tries) || 0) < tries);
      if (live.length !== all.length) writeOwed(live);
      for (const o of live) settle(o, await sendOne(o));
    } finally { flushing = false; }
  }

  // ---- on and off -------------------------------------------------------------------------------

  /** Looked at whenever the sign-in or the knobs may have changed: up while both say so, down otherwise. */
  function sync() {
    const want = !!safe(d.signedIn, false) && !!safe(d.on, false);
    if (want && !running) {
      running = true;
      client.start();
      tick();
      log("notices: on");
    } else if (!want && running) {
      stop();
      log("notices: off");
    }
    // Signed out: nothing of that account stays on the screen, and nothing it owed goes as the next one.
    if (!safe(d.signedIn, false)) { for (const id of [...shown.keys()]) close(id); if (readOwed().length) writeOwed([]); }
  }

  function stop() {
    running = false;
    client.stop();
    if (hereTimer != null) t.clear(hereTimer);
    hereTimer = null;
  }

  /** The screen locked, or the computer is going to sleep: the phone is the one to ring. */
  function away() { locked = true; here(); }
  /** Back at it (unlocked, awake): said at once; after a sleep the socket is made again rather than waited on. */
  function back(o) {
    locked = false;
    if (!running) return;
    if (o && o.woke) { client.stop(); client.start(); return; }
    here();
  }

  return { sync, away, back, stop, client, shownCount: () => shown.size };
}

module.exports = { createNotices, cleanNotice, buttonsFor, actKey, retryable, socketOf };
