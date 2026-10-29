/**
 * LIVE UPDATES IN THE WINDOW: a change made on another device (the phone, another computer) shows on the screen that is up
 * within about a second.
 *
 * One socket to the backend's /v1/live while the window is signed in and showing (minimised or hidden in the tray, it closes;
 * back in view, it opens again and the screen that is up reloads once, since whatever was said in between was missed). The
 * server says which topic changed; when the screen that is up lists it in its `liveTopics`, the screen is fetched again and
 * painted QUIETLY: no loading line, no fade, the scroll where it was, the field being typed in still focused with its words and
 * its caret. The new state is written over the old except what was changed on this screen since it loaded (a half-typed field
 * keeps its words), and never while the person is typing. A burst of changes is one reload.
 *
 * The rules are the phone's (app/src/sdui/liveCore.ts) and are tested here on their own (live.test.js): the socket signs in with
 * its first message (never a token in the URL), answers pings, reconnects with backoff (1 s, 2 s, 4 s … 30 s), drops a socket
 * that has gone quiet; a reload waits 300 ms after the last event (at most a second after the first) and 1.2 s after the last
 * keystroke (at most 15 s).
 *
 * The pill and notes windows draw no server screens, so only this one listens. install() reads the window's session, stack,
 * state and painting from sdui.js, loaded first. Knobs: live.enabled (true), live.path ("/v1/live"), live.debounceMs (300),
 * live.typingQuietMs (1200).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.TailzuLive = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DELAY_MS = 300;
  const MAX_WAIT_MS = 1000;
  const QUIET_MS = 1200;
  const MAX_DEFER_MS = 15000;
  const CONNECT_TIMEOUT_MS = 15000;
  const DEFAULT_HEARTBEAT_MS = 25000;
  const CLOSE = { unauthorized: 4401, tooMany: 4008, renew: 4000 };

  /** A server message, or null for anything that is not one of ours. */
  function parseLiveMessage(raw) {
    if (typeof raw !== "string" || raw.length > 65536) return null;
    let m;
    try { m = JSON.parse(raw); } catch { return null; }
    if (!m || typeof m !== "object") return null;
    switch (m.type) {
      case "ready": return { type: "ready", heartbeatMs: Number(m.heartbeatMs) > 0 ? Number(m.heartbeatMs) : DEFAULT_HEARTBEAT_MS };
      case "event": return typeof m.topic === "string" && m.topic ? { type: "event", topic: m.topic, at: m.at, data: m.data } : null;
      case "ping": return { type: "ping" };
      case "error": return { type: "error", code: String(m.code || "") };
      default: return null;
    }
  }

  /** The socket's address on the API's host: https → wss, http → ws. */
  function wsUrlOf(base, path) {
    const p = path || "/v1/live";
    return String(base || "").replace(/\/+$/, "").replace(/^http/i, "ws") + (p[0] === "/" ? p : "/" + p);
  }

  /** Whether a screen listening to `topics` hears `topic` ("job:*" hears every job). */
  function hears(topics, topic) {
    if (!Array.isArray(topics) || !topics.length || !topic) return false;
    for (const t of topics) {
      if (t === topic) return true;
      if (typeof t === "string" && t.endsWith(":*") && topic.startsWith(t.slice(0, -1))) return true;
    }
    return false;
  }

  function backoffMs(attempt, random, baseMs, maxMs) {
    const r = typeof random === "function" ? random : Math.random;
    const cap = Math.min(maxMs || 30000, (baseMs || 1000) * Math.pow(2, Math.max(0, Math.min(attempt, 20))));
    return Math.round(cap * (0.5 + 0.5 * Math.min(1, Math.max(0, r()))));
  }

  const isPlain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  const same = (a, b) => { if (a === b) return true; try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; } };
  const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);

  /**
   * [path, value] pairs to write for the new copy of a screen: the server's new word, except what this screen changed since the
   * server last spoke (prev → local), which stays. Objects key by key; keys the new copy does not name are left alone.
   */
  function mergeLiveState(prev, local, next) {
    const out = [];
    const walk = (base, p, l, n) => {
      for (const k of Object.keys(n)) {
        if (UNSAFE.has(k) || k.indexOf(".") !== -1) continue;
        const path = base ? base + "." + k : k;
        const nv = n[k], lv = l[k], pv = p[k];
        if (isPlain(nv) && isPlain(lv) && (pv === undefined || isPlain(pv))) { walk(path, pv || {}, lv, nv); continue; }
        if (!same(lv, pv)) continue;
        if (!same(lv, nv)) out.push([path, nv]);
      }
    };
    walk("", prev || {}, local || {}, next || {});
    return out;
  }

  const realTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h), now: () => Date.now() };

  function reloadDelay(now, firstAt, lastAt, typedAt, o) {
    const settled = Math.min(lastAt + o.delayMs, firstAt + o.maxWaitMs);
    const quiet = typedAt > 0 ? Math.min(typedAt + o.quietMs, firstAt + o.maxDeferMs) : 0;
    return Math.max(0, Math.max(settled, quiet) - now);
  }

  /** One quiet reload per burst, never on top of typing, one at a time (an event during one brings one more). */
  class ReloadScheduler {
    constructor(opts) {
      this.opts = opts;
      this.t = opts.timers || realTimers;
      this.o = {
        delayMs: opts.delayMs != null ? opts.delayMs : DELAY_MS, maxWaitMs: opts.maxWaitMs != null ? opts.maxWaitMs : MAX_WAIT_MS,
        quietMs: opts.quietMs != null ? opts.quietMs : QUIET_MS, maxDeferMs: opts.maxDeferMs != null ? opts.maxDeferMs : MAX_DEFER_MS,
      };
      this.firstAt = 0; this.lastAt = 0; this.timer = null; this.running = false; this.again = false; this.stopped = false;
    }
    typedAt() { return this.opts.lastTypedAt ? this.opts.lastTypedAt() : 0; }
    poke() {
      if (this.stopped) return;
      if (this.running) { this.again = true; return; }
      const now = this.t.now();
      if (!this.firstAt) this.firstAt = now;
      this.lastAt = now;
      if (this.timer != null) this.t.clear(this.timer);
      this.timer = this.t.set(() => this.fire(), reloadDelay(now, this.firstAt, this.lastAt, this.typedAt(), this.o));
    }
    cancel() {
      this.stopped = true;
      if (this.timer != null) this.t.clear(this.timer);
      this.timer = null; this.firstAt = 0; this.again = false;
    }
    fire() {
      this.timer = null;
      if (this.stopped || !this.firstAt) return;
      const wait = reloadDelay(this.t.now(), this.firstAt, this.lastAt, this.typedAt(), this.o);
      if (wait > 0) { this.timer = this.t.set(() => this.fire(), wait); return; }
      this.firstAt = 0; this.running = true; this.again = false;
      let done;
      try { done = Promise.resolve(this.opts.run()); } catch { done = Promise.resolve(); }
      done.catch(() => undefined).then(() => {
        this.running = false;
        if (this.again && !this.stopped) { this.again = false; this.poke(); }
      });
    }
  }

  /** One live socket, kept up while started. opts: { open(url), url(), token(), onEvent(topic, m), onResume(), timers, random } */
  class LiveClient {
    constructor(o) {
      this.o = o; this.t = o.timers || realTimers;
      this.ws = null; this.running = false; this.ready = false; this.everReady = false; this.attempt = 0; this.gen = 0;
      this.heartbeatMs = DEFAULT_HEARTBEAT_MS; this.retry = null; this.dog = null;
    }
    get connected() { return this.ready; }
    start() { if (this.running) return; this.running = true; this.attempt = 0; this.connect(); }
    stop() {
      this.running = false; this.gen++;
      if (this.retry != null) this.t.clear(this.retry);
      this.retry = null;
      this.drop();
    }
    async connect() {
      this.retry = null;
      const gen = ++this.gen;
      let url = null, token = null;
      try { [url, token] = await Promise.all([this.o.url(), this.o.token()]); } catch { /* tried again below */ }
      if (!this.running || gen !== this.gen) return;
      if (!url || !token) { this.later(); return; }
      let ws;
      try { ws = this.o.open(url); } catch { this.later(); return; }
      this.ws = ws;
      ws.onopen = () => { if (this.ws === ws) { try { ws.send(JSON.stringify({ type: "auth", token })); } catch { /* close follows */ } } };
      ws.onmessage = (ev) => this.message(ws, ev && ev.data);
      ws.onclose = (ev) => this.closed(ws, ev && ev.code);
      ws.onerror = () => { /* a close follows */ };
      this.watch(CONNECT_TIMEOUT_MS);
    }
    message(ws, raw) {
      if (this.ws !== ws) return;
      const m = parseLiveMessage(raw);
      if (!m) return;
      if (m.type === "ready") {
        this.heartbeatMs = m.heartbeatMs; this.ready = true; this.attempt = 0;
        const resumed = this.everReady;
        this.everReady = true;
        this.watch(this.heartbeatMs * 2.5);
        if (resumed && this.o.onResume) { try { this.o.onResume(); } catch { /* the screen's own problem */ } }
        return;
      }
      if (!this.ready) return;
      this.watch(this.heartbeatMs * 2.5);
      if (m.type === "ping") { try { ws.send(JSON.stringify({ type: "pong" })); } catch { /* close follows */ } return; }
      if (m.type === "event") { try { this.o.onEvent(m.topic, m); } catch { /* never stops the socket */ } }
    }
    closed(ws, code) {
      if (this.ws !== ws) return;
      this.ws = null; this.ready = false;
      if (this.dog != null) this.t.clear(this.dog);
      this.dog = null;
      if (this.running) this.later(code);
    }
    later(code) {
      if (!this.running) return;
      if (this.retry != null) this.t.clear(this.retry);
      const r = this.o.random || Math.random;
      const ms = code === CLOSE.renew ? Math.round(200 + 800 * r())
        : code === CLOSE.tooMany ? backoffMs(30, r)
          : backoffMs(this.attempt++, r);
      this.retry = this.t.set(() => { this.connect(); }, ms);
    }
    watch(ms) {
      if (this.dog != null) this.t.clear(this.dog);
      const ws = this.ws;
      this.dog = this.t.set(() => {
        this.dog = null;
        if (this.ws !== ws) return;
        this.drop();
        this.later();
      }, ms);
    }
    drop() {
      if (this.dog != null) this.t.clear(this.dog);
      this.dog = null;
      const ws = this.ws;
      this.ws = null; this.ready = false;
      if (!ws) return;
      ws.onopen = null; ws.onmessage = null; ws.onclose = null; ws.onerror = null;
      try { ws.close(); } catch { /* already gone */ }
    }
  }

  /** Where an element sits under `root`, as child indexes; null when it is not under it. */
  function pathOf(el, root) {
    const path = [];
    let cur = el;
    while (cur && cur !== root) {
      const parent = cur.parentElement;
      if (!parent) return null;
      path.unshift(Array.prototype.indexOf.call(parent.children, cur));
      cur = parent;
    }
    return cur === root ? path : null;
  }

  function atPath(root, path) {
    let cur = root;
    for (const i of path || []) { cur = cur && cur.children ? cur.children[i] : null; if (!cur) return null; }
    return cur;
  }

  /** What a repaint would lose: the scroll of the view and of anything scrolled in it, and the field being typed in. */
  function holdView(doc) {
    const view = doc.getElementById("view");
    if (!view) return null;
    const scrolls = [];
    const main = doc.getElementById("main");
    if (main && (main.scrollTop || main.scrollLeft)) scrolls.push({ el: main, top: main.scrollTop, left: main.scrollLeft });
    scrolls.push({ path: [], top: view.scrollTop || 0, left: view.scrollLeft || 0 });
    for (const el of Array.from(view.querySelectorAll("*"))) {
      if (el.scrollTop || el.scrollLeft) { const p = pathOf(el, view); if (p) scrolls.push({ path: p, top: el.scrollTop, left: el.scrollLeft }); }
    }
    let focus = null;
    const a = doc.activeElement;
    const bind = a && view.contains(a) && a.getAttribute ? a.getAttribute("data-bind") : null;
    if (bind) {
      const same = Array.from(view.querySelectorAll("[data-bind]")).filter((e) => e.getAttribute("data-bind") === bind);
      focus = { bind, index: Math.max(0, same.indexOf(a)), start: a.selectionStart, end: a.selectionEnd };
    }
    return { scrolls, focus };
  }

  function restoreView(doc, held) {
    if (!held) return;
    const view = doc.getElementById("view");
    if (!view) return;
    if (held.focus) {
      const same = Array.from(view.querySelectorAll("[data-bind]")).filter((e) => e.getAttribute("data-bind") === held.focus.bind);
      const el = same[held.focus.index] || same[0];
      if (el && typeof el.focus === "function") {
        try { el.focus({ preventScroll: true }); } catch { /* not focusable */ }
        try { if (held.focus.start != null) el.setSelectionRange(held.focus.start, held.focus.end); } catch { /* not a text field */ }
      }
    }
    for (const s of held.scrolls) {
      const el = s.el || atPath(view, s.path);
      if (el) { el.scrollTop = s.top; el.scrollLeft = s.left; }
    }
  }

  /**
   * Wire the window. host: { window, document, enabled(), signedIn(), token(), baseUrl(), path(), screen(), target(),
   * fetch(screenId, params), state(), paintSeq(), apply(next, patch), busy(), stream(id, data) }
   */
  function install(host) {
    const win = host.window, doc = host.document;
    let typedAt = 0;
    doc.addEventListener("input", (e) => {
      const view = doc.getElementById("view");
      if (view && e.target && view.contains(e.target)) typedAt = Date.now();
    }, true);

    async function reloadQuietly() {
      if (host.busy && host.busy()) return;
      const shown = host.screen(), target = host.target();
      if (!shown || !target || shown.screenId !== target.screenId) return;
      const seq = host.paintSeq();
      const next = await host.fetch(target.screenId, target.params);
      // Another screen (or a navigation) came up while this was fetched: its own paint is the one that counts.
      if (!next || host.paintSeq() !== seq || host.screen() !== shown || next.screenId !== shown.screenId) return;
      if (host.busy && host.busy()) return;
      const patch = mergeLiveState(shown.state || {}, host.state() || {}, next.state || {});
      const held = holdView(doc);
      host.apply(next, patch);
      restoreView(doc, held);
    }

    const scheduler = new ReloadScheduler({
      delayMs: host.num ? host.num("live.debounceMs", DELAY_MS) : DELAY_MS,
      quietMs: host.num ? host.num("live.typingQuietMs", QUIET_MS) : QUIET_MS,
      lastTypedAt: () => typedAt,
      run: () => reloadQuietly().catch(() => undefined),
    });
    const listening = () => { const s = host.screen(); return s && s.liveTopics; };
    const client = new LiveClient({
      open: (url) => new win.WebSocket(url),
      url: () => { const b = host.baseUrl(); return b ? wsUrlOf(b, host.path()) : null; },
      token: () => (host.signedIn() ? host.token() : null),
      // An answer's words as they come (topic ask:<id>) are for the call that asked (host.stream), never a reload.
      onEvent: (topic, m) => {
        if (String(topic).indexOf("ask:") === 0) { if (host.stream) host.stream(String(topic).slice(4), m && m.data); return; }
        if (hears(listening(), topic)) scheduler.poke();
      },
      onResume: () => { const t = listening(); if (t && t.length) scheduler.poke(); },
    });
    // Open while signed in, switched on and in view; looked at again whenever that may have changed, and every few seconds
    // for a sign-in (nothing announces one).
    const follow = () => {
      if (host.enabled() && host.signedIn() && doc.visibilityState !== "hidden") client.start();
      else client.stop();
    };
    doc.addEventListener("visibilitychange", follow);
    win.addEventListener("focus", follow);
    const tick = setInterval(follow, 3000);
    follow();
    return { host, client, scheduler, reloadQuietly, stop: () => { clearInterval(tick); client.stop(); scheduler.cancel(); } };
  }

  return {
    DELAY_MS, MAX_WAIT_MS, QUIET_MS, MAX_DEFER_MS, CLOSE,
    parseLiveMessage, wsUrlOf, hears, backoffMs, mergeLiveState, reloadDelay, ReloadScheduler, LiveClient,
    pathOf, atPath, holdView, restoreView, install,
  };
});

// In the window: wire it to the app (sdui.js, loaded first, holds the session, the stack, the state and the painting).
/* global SESSION, STACK, ENV, K, STATE, CURRENT_SCREEN, CURRENT_ACTIONS, paint, repaint, bearer, fetchScreen, setStatePath, gateUp, askStreamTake */
if (typeof module === "undefined" && typeof window !== "undefined" && typeof repaint === "function" && window.TailzuLive) {
  window.TailzuLiveWindow = window.TailzuLive.install({
    window,
    document,
    enabled: () => K.bool("live.enabled", true),
    num: (k, d) => K.num(k, d),
    signedIn: () => !!SESSION && STACK.length > 0,
    token: () => bearer(),
    baseUrl: () => (ENV && ENV.baseUrl) || "",
    path: () => K.str("live.path", "/v1/live"),
    screen: () => CURRENT_SCREEN,
    target: () => STACK[STACK.length - 1],
    fetch: (id, params) => fetchScreen(id, params),
    state: () => STATE,
    paintSeq: () => paint._seq || 0,
    // The sign-in gate is up: its screen is not one of these.
    busy: () => (typeof gateUp === "function" && gateUp()),
    // An answer's words as they come: to the call listening (sdui.js askStreamTake).
    stream: (id, data) => { if (typeof askStreamTake === "function") askStreamTake(id, data); },
    apply: (next, patch) => {
      for (const [path, value] of patch) setStatePath(path, value);
      CURRENT_ACTIONS = next.actions || {};
      repaint(next);
    },
  });
}
