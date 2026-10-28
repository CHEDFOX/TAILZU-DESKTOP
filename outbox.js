/**
 * OFFLINE, IN THE WINDOW (the server's shared/types/sdui.ts 3e; docs/bots-app.md "Offline"). Loaded after sdui.js, whose session,
 * state, stack and painting it uses.
 *
 *   the outbox      asks typed while offline, kept in this window's storage (per account) with when they were typed, and sent once
 *                   the connection is back, IN ORDER, one at a time, as POST with each ask's own client id (the server answers an id
 *                   once, so a retry after a lost answer never asks twice). The same rules as the phone's (app/src/sdui/outboxCore.ts):
 *                   a refusal that will not change fails that ask and the next goes; anything else waits (2 s … a minute) and holds
 *                   the rest. Sent ones go after a day, or with "clear".
 *   every screen    gets `online`, `outbox` and `outboxWaiting` in its state.
 *   the Offline page while offline, a screen in the bootstrap's `offline.roots` (Home) is shown as `offline.screenId`, from the copy
 *                   kept the last time it was fetched; when the connection returns, what it stood in for comes back. Any other screen
 *                   gets the line `offline.bar` over it. When kept asks have gone, `offline.sentToast`.
 */
/* eslint-env browser */

// ------------------------------------------------------------------------- the core (pure; outbox.test.js)

const OUTBOX_MAX = 20;
const OUTBOX_KEEP_SENT_MS = 24 * 3600000;
const OUTBOX_BACKOFF_MS = [2000, 4000, 8000, 16000, 32000, 60000];
const OUTBOX_FOR_GOOD = [400, 403, 404, 405, 413, 422];

/** Whether a failure is worth another try: anything but a refusal that will not change. */
function outboxRetryable(err) {
  const status = err && typeof err.status === "number" ? err.status : null;
  return !(status !== null && OUTBOX_FOR_GOOD.indexOf(status) !== -1);
}

/** "9:38": as a clock shows it, 12-hour, no leading zero. */
function outboxClock(ms) {
  const d = new Date(ms);
  return (d.getHours() % 12 || 12) + ":" + String(d.getMinutes()).padStart(2, "0");
}

const OUTBOX_STATES = ["waiting", "sending", "sent", "failed"];
const outboxIsEntry = (e) => !!e && typeof e.id === "string" && typeof e.path === "string" && typeof e.label === "string" &&
  typeof e.typedAt === "number" && !!e.body && typeof e.body === "object" && OUTBOX_STATES.indexOf(e.state) !== -1;

/** An outbox over `io` ({ load, save, send, now, newId, timeText }). */
function makeOutbox(io, o) {
  o = o || {};
  let list = [];
  let loaded = null, didLoad = false, flushing = null;
  const listeners = new Set();

  const changed = () => {
    if (didLoad) Promise.resolve().then(() => io.save(JSON.stringify(list))).catch(() => { /* kept in memory still */ });
    else void ready();
    listeners.forEach((fn) => { try { fn(); } catch { /* a listener's own problem */ } });
  };
  const prune = () => {
    const keep = o.keepSentMs || OUTBOX_KEEP_SENT_MS, t = io.now();
    list = list.filter((e) => e.state !== "sent" || t - (e.sentAt || 0) < keep);
  };

  function ready() {
    if (!loaded) {
      loaded = (async () => {
        try {
          const raw = await io.load();
          const rows = raw ? JSON.parse(raw) : [];
          if (Array.isArray(rows)) {
            const kept = rows.filter(outboxIsEntry).map((e) => (e.state === "sending" ? Object.assign({}, e, { state: "waiting", nextAt: 0 }) : e));
            const ids = new Set(kept.map((e) => e.id));
            list = kept.concat(list.filter((e) => !ids.has(e.id)));
          }
        } catch { /* nothing readable was kept */ }
        didLoad = true;
        prune();
        changed();
      })();
    }
    return loaded;
  }

  return {
    ready,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    entries: () => list,
    view: () => ({
      outbox: list.map((e) => ({ id: e.id, label: e.label, sub: e.sub, state: e.state, typedAt: e.typedAt })),
      outboxWaiting: list.filter((e) => e.state === "waiting" || e.state === "sending").length,
    }),
    add(a) {
      const path = typeof a.path === "string" ? a.path : "";
      if (!/^\/v1\/[A-Za-z0-9/_.-]*$/.test(path) || path.indexOf("..") !== -1) return null;
      const label = typeof a.label === "string" ? a.label.trim() : "";
      if (!label) return null;
      prune();
      if (list.length >= (o.max || OUTBOX_MAX)) {
        const sent = list.findIndex((e) => e.state === "sent");
        if (sent < 0) return null;
        list.splice(sent, 1);
      }
      const typedAt = io.now();
      const body = a.body && typeof a.body === "object" && !Array.isArray(a.body) ? Object.assign({}, a.body) : {};
      const sub = (typeof a.sub === "string" ? a.sub : "").replace(/\{time\}/g, io.timeText(typedAt));
      const e = { id: io.newId(), path, body, label: label.slice(0, 2000), sub, state: "waiting", typedAt, tries: 0, nextAt: 0 };
      list.push(e);
      changed();
      return e;
    },
    remove(id) {
      const i = list.findIndex((e) => e.id === id && (e.state === "waiting" || e.state === "failed"));
      if (i < 0) return false;
      list.splice(i, 1);
      changed();
      return true;
    },
    retry(id) {
      const e = list.find((x) => x.id === id && x.state === "failed");
      if (!e) return false;
      e.state = "waiting"; e.tries = 0; e.nextAt = 0;
      changed();
      return true;
    },
    clear() { const n = list.length; list = list.filter((e) => e.state !== "sent"); if (list.length !== n) changed(); },
    clearAll() { list = []; changed(); },
    nextDue() { const w = list.find((e) => e.state === "waiting"); return w ? w.nextAt : null; },
    flush(online) {
      if (!online) return Promise.resolve(0);
      if (flushing) return flushing;
      flushing = (async () => {
        await ready();
        let sent = 0;
        for (;;) {
          const e = list.find((x) => x.state === "waiting" || x.state === "sending");
          if (!e || e.state !== "waiting" || e.nextAt > io.now()) break;
          e.state = "sending";
          changed();
          try {
            await io.send(e.path, Object.assign({}, e.body, { clientId: e.id, typedAt: e.typedAt }));
            e.state = "sent"; e.sentAt = io.now();
            sent++;
            changed();
          } catch (err) {
            if (outboxRetryable(err)) {
              e.state = "waiting";
              e.nextAt = io.now() + OUTBOX_BACKOFF_MS[Math.min(e.tries, OUTBOX_BACKOFF_MS.length - 1)];
              e.tries++;
              changed();
              break;
            }
            e.state = "failed";
            changed();
          }
        }
        return sent;
      })().finally(() => { flushing = null; });
      return flushing;
    },
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { makeOutbox, outboxRetryable, outboxClock, OUTBOX_MAX };
}

// ------------------------------------------------------------------------- the window

let ONLINE = typeof navigator !== "undefined" && navigator.onLine !== false;
let OUTBOX = null, OUTBOX_OWNER = null, OUTBOX_TIMER = 0;
/** The Offline page as last fetched, per account: { owner, screen }. */
let OFFLINE_KEPT = null;
let OFFLINE_FETCHED_AT = 0;

const offlineId = () => K.str("offline.screenId", "");
const offlineRoots = () => K.list("offline.roots", []);

function ls(fn) { try { return fn(window.localStorage); } catch { return null; } }

/** The signed-in account's outbox (another account gets its own; none signed in, none). */
function outboxBox() {
  const owner = typeof userId === "function" ? userId() : "";
  if (!owner) return null;
  if (OUTBOX && OUTBOX_OWNER === owner) return OUTBOX;
  const key = "tz.outbox." + owner;
  OUTBOX_OWNER = owner;
  OUTBOX = makeOutbox({
    load: async () => ls((s) => s.getItem(key)),
    save: async (j) => { ls((s) => s.setItem(key, j)); },
    send: outboxSend,
    now: () => Date.now(),
    newId: () => (window.crypto && typeof window.crypto.randomUUID === "function" ? window.crypto.randomUUID() : "o" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)),
    timeText: outboxClock,
  });
  OUTBOX.subscribe(() => { offlinePut(); if (typeof repaint === "function" && CURRENT_SCREEN) repaint(); });
  void OUTBOX.ready().then(() => outboxGo());
  return OUTBOX;
}

/** One ask out: the account's own token, the API's own address, the status when it fails. */
async function outboxSend(path, body) {
  const tok = await bearer();
  if (!tok) throw Object.assign(new Error("signed out"), { status: 401 });
  const res = await fetch(ENV.baseUrl + path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok }, body: JSON.stringify(body) });
  if (!res.ok) throw Object.assign(new Error("outbox " + res.status), { status: res.status });
  return res.json().catch(() => null);
}

/** Send what waits, if online, and come back for what has to wait its turn. */
async function outboxGo() {
  const box = outboxBox();
  if (!box || !ONLINE) return;
  const n = await box.flush(true).catch(() => 0);
  if (n > 0) { const said = K.str("offline.sentToast", ""); if (said) { try { toast(said); } catch { /* no toast to show it in */ } } }
  clearTimeout(OUTBOX_TIMER);
  const due = box.nextDue();
  if (due != null && ONLINE) OUTBOX_TIMER = setTimeout(outboxGo, Math.max(1000, due - Date.now()));
}

/** The `outbox` action (sdui.js run()): add · remove · retry · clear. */
function outboxRun(action) {
  const box = outboxBox();
  if (!box) return;
  const fill = (v) => (typeof v === "string" ? v.replace(/\$state\.[A-Za-z0-9_.]*[A-Za-z0-9_]/g, (m) => { const x = stateAt(m.slice(7)); return x == null ? "" : String(x); }) : "");
  switch (action.op) {
    case "add": {
      const e = box.add({ path: action.path, body: deepResolve(action.body || {}), label: fill(action.label), sub: fill(action.sub) });
      if (!e) { toast(K.txt("outbox.notKept", "Couldn't keep that ask.")); return; }
      void outboxGo();
      return;
    }
    case "remove": box.remove(resolveValue(action.id)); return;
    case "retry": if (box.retry(resolveValue(action.id))) void outboxGo(); return;
    case "clear": box.clear(); return;
  }
}

/** What every screen's state carries (sdui.js paint()). */
function offlineState() {
  const box = outboxBox();
  const v = box ? box.view() : { outbox: [], outboxWaiting: 0 };
  offlineBar();
  return { online: ONLINE, outbox: v.outbox, outboxWaiting: v.outboxWaiting };
}

function offlinePut() {
  if (typeof STATE === "undefined" || !STATE) return;
  Object.assign(STATE, offlineState());
}

/**
 * Before a paint fetches (sdui.js paint()): offline, a root screen is drawn as the kept Offline page instead (the stack remembers
 * what it stands in for), and the Offline page itself is drawn from what was kept. Null: fetch as usual.
 */
function offlineInstead(cur) {
  const id = offlineId();
  if (ONLINE || !id || !cur || !OFFLINE_KEPT || OFFLINE_KEPT.owner !== userId()) return null;
  if (cur.screenId !== id && offlineRoots().indexOf(cur.screenId) === -1) return null;
  if (cur.screenId !== id) STACK[STACK.length - 1] = { screenId: id, auto: { screenId: cur.screenId, params: cur.params } };
  return JSON.parse(JSON.stringify(OFFLINE_KEPT.screen));
}

/** After a paint fetched a screen, online: keep the Offline page when it is the one, and fetch it now and then to keep it fresh. */
function offlineKeep(cur, screen) {
  const id = offlineId();
  if (!id || !ONLINE) return;
  if (cur && cur.screenId === id && screen) { OFFLINE_KEPT = { owner: userId(), screen }; OFFLINE_FETCHED_AT = Date.now(); return; }
  if (Date.now() - OFFLINE_FETCHED_AT < K.num("offline.keepEveryMs", 300000) && OFFLINE_KEPT && OFFLINE_KEPT.owner === userId()) return;
  OFFLINE_FETCHED_AT = Date.now();
  fetchScreen(id).then((s) => { if (s) OFFLINE_KEPT = { owner: userId(), screen: s }; }).catch(() => { OFFLINE_FETCHED_AT = 0; });
}

/** The line over any other screen while offline. */
function offlineBar() {
  if (typeof document === "undefined" || typeof document.createElement !== "function") return;
  let bar = document.getElementById("offlineBar");
  const words = K.str("offline.bar", "");
  const top = typeof STACK !== "undefined" && STACK.length ? STACK[STACK.length - 1] : null;
  const show = !ONLINE && !!words && !!SESSION && !(top && top.screenId === offlineId());
  if (!bar) {
    if (!show || !document.body) return;
    bar = document.createElement("div");
    bar.id = "offlineBar";
    bar.setAttribute("role", "status");
    bar.setAttribute("style", "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:50;pointer-events:none;background:#ffffff;" +
      "border:1px solid #e6e6e6;border-radius:14px;padding:10px 14px;font-size:13px;line-height:18px;color:#0a0a0a;font-family:var(--f-ui),system-ui,sans-serif;white-space:nowrap");
    document.body.appendChild(bar);
  }
  bar.textContent = words;
  bar.style.display = show ? "block" : "none";
}

/** The connection came or went. */
function offlineTurn(on) {
  if (on === ONLINE) return;
  ONLINE = on;
  const top = typeof STACK !== "undefined" && STACK.length ? STACK[STACK.length - 1] : null;
  if (!SESSION || !top) { offlineBar(); return; }
  if (on) {
    // What the Offline page stood in for comes back, on top or further down (a page opened from it while offline).
    STACK = STACK.map((it) => it.auto || it);
    if (top.auto) void paint(true);
    else { offlinePut(); repaint(); }
    void outboxGo();
  } else if (offlineRoots().indexOf(top.screenId) !== -1 && OFFLINE_KEPT) {
    void paint(true);
  } else {
    offlinePut();
    repaint();
  }
}

if (typeof window !== "undefined" && typeof module === "undefined") {
  window.addEventListener("online", () => offlineTurn(true));
  window.addEventListener("offline", () => offlineTurn(false));
}
