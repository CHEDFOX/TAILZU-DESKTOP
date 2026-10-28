// Live updates in the window (live.js): which events the screen that is up hears, one quiet reload per burst and never on top of
// typing, a half-typed field kept through a reload with its focus and the scroll where it was, and the socket: signed in by its
// first message, answering pings, reconnecting with backoff, saying when it is back after a gap.
const test = require("node:test");
const assert = require("node:assert");
const L = require("./live.js");

function clock(start = 1_000_000) {
  let now = start, seq = 0;
  const due = new Map();
  const timers = {
    set: (fn, ms) => { const id = ++seq; due.set(id, { at: now + ms, fn }); return id; },
    clear: (h) => { due.delete(h); },
    now: () => now,
  };
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  const advance = async (ms) => {
    const end = now + ms;
    for (;;) {
      const next = [...due.entries()].filter(([, d]) => d.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      due.delete(next[0]);
      now = next[1].at;
      next[1].fn();
      await flush();
    }
    now = end;
    await flush();
  };
  return { timers, advance, flush, pending: () => due.size };
}

test("hears its own topics and a wildcard's family", () => {
  assert.equal(L.hears(["home", "bots"], "bots"), true);
  assert.equal(L.hears(["home"], "keybot"), false);
  assert.equal(L.hears(["job:*"], "job:7"), true);
  assert.equal(L.hears(undefined, "home"), false);
});

test("the socket's address: the API's host, ws or wss, no token", () => {
  assert.equal(L.wsUrlOf("https://api.tailzu.space/", "/v1/live"), "wss://api.tailzu.space/v1/live");
  assert.equal(L.wsUrlOf("http://localhost:8787"), "ws://localhost:8787/v1/live");
});

test("reads only the server's messages; backs off 1 s to 30 s", () => {
  assert.deepEqual(L.parseLiveMessage('{"type":"ready","heartbeatMs":10}'), { type: "ready", heartbeatMs: 10 });
  assert.equal(L.parseLiveMessage("{"), null);
  assert.equal(L.parseLiveMessage('{"type":"event"}'), null);
  assert.equal(L.backoffMs(0, () => 1), 1000);
  assert.equal(L.backoffMs(2, () => 0), 2000);
  assert.equal(L.backoffMs(12, () => 1), 30000);
});

test("mergeLiveState keeps what was typed here and takes the server's new word for the rest", () => {
  const prev = { ask: "", prefs: { look: "light" }, n: 1 };
  const local = { ask: "half typ", prefs: { look: "light" }, n: 1, desktop: { pill: true } };
  const next = { ask: "", prefs: { look: "dark" }, n: 2 };
  assert.deepEqual(L.mergeLiveState(prev, local, next), [["prefs.look", "dark"], ["n", 2]]);
  assert.deepEqual(L.mergeLiveState({}, {}, JSON.parse('{"__proto__":{"a":1},"x.y":1,"ok":true}')), [["ok", true]]);
});

test("a burst is one reload: 300 ms after the last event, at most a second after the first", async () => {
  const c = clock();
  let runs = 0;
  const s = new L.ReloadScheduler({ run: () => { runs++; }, timers: c.timers });
  s.poke(); await c.advance(200); s.poke(); await c.advance(299);
  assert.equal(runs, 0);
  await c.advance(1);
  assert.equal(runs, 1);
  for (let i = 0; i < 10; i++) { s.poke(); await c.advance(200); }
  assert.equal(runs, 3);
  s.cancel();
});

test("waits for a pause in the typing (at most 15 s), and one reload at a time", async () => {
  const c = clock();
  let typed = 0, runs = 0, finish = () => {};
  const s = new L.ReloadScheduler({ run: () => { runs++; return new Promise((r) => { finish = r; }); }, lastTypedAt: () => typed, timers: c.timers });
  typed = c.timers.now();
  s.poke();
  await c.advance(1199);
  assert.equal(runs, 0);
  await c.advance(1);
  assert.equal(runs, 1);
  s.poke();
  await c.advance(3000);
  assert.equal(runs, 1);
  finish();
  await c.flush();
  await c.advance(300);
  assert.equal(runs, 2);
  finish();
  s.poke();
  for (let i = 0; i < 40; i++) { typed = c.timers.now(); await c.advance(500); }
  assert.equal(runs, 3);
  s.cancel();
});

class FakeSocket {
  constructor(url) { this.url = url; this.sent = []; this.closedByClient = false; this.onopen = this.onmessage = this.onclose = this.onerror = null; }
  send(d) { this.sent.push(d); }
  close() { this.closedByClient = true; }
  open() { this.onopen && this.onopen(); }
  say(m) { this.onmessage && this.onmessage({ data: JSON.stringify(m) }); }
  drop(code) { this.onclose && this.onclose({ code }); }
}
function client(token = "jwt") {
  const c = clock();
  const sockets = [], topics = [];
  let resumed = 0;
  const lc = new L.LiveClient({
    open: (u) => { const s = new FakeSocket(u); sockets.push(s); return s; },
    url: () => "wss://api.tailzu.space/v1/live", token: () => token,
    onEvent: (t) => topics.push(t), onResume: () => { resumed++; }, timers: c.timers, random: () => 1,
  });
  return { lc, c, sockets, topics, resumed: () => resumed };
}

test("signs in by its first message, hears events once ready, answers pings", async () => {
  const { lc, c, sockets, topics } = client();
  lc.start();
  await c.flush();
  assert.equal(sockets[0].url, "wss://api.tailzu.space/v1/live");
  sockets[0].open();
  assert.deepEqual(JSON.parse(sockets[0].sent[0]), { type: "auth", token: "jwt" });
  sockets[0].say({ type: "ready", heartbeatMs: 1000 });
  sockets[0].say({ type: "event", topic: "keybot" });
  sockets[0].say({ type: "ping" });
  assert.deepEqual(topics, ["keybot"]);
  assert.deepEqual(JSON.parse(sockets[0].sent[1]), { type: "pong" });
  lc.stop();
  assert.equal(sockets[0].closedByClient, true);
  assert.equal(c.pending(), 0);
});

test("reconnects with backoff, drops a quiet socket, says it is back", async () => {
  const { lc, c, sockets, resumed } = client();
  lc.start();
  await c.flush();
  sockets[0].open();
  sockets[0].say({ type: "ready", heartbeatMs: 1000 });
  sockets[0].drop(1006);
  await c.advance(1000);
  assert.equal(sockets.length, 2);
  sockets[1].open();
  sockets[1].say({ type: "ready", heartbeatMs: 1000 });
  assert.equal(resumed(), 1);
  await c.advance(2500);                       // nothing heard for two and a half heartbeats
  assert.equal(sockets[1].closedByClient, true);
  await c.advance(1000);
  assert.equal(sockets.length, 3);
  lc.stop();
});

test("signed out: no socket", async () => {
  const { lc, c, sockets } = client(null);
  lc.start();
  await c.advance(60000);
  assert.equal(sockets.length, 0);
  lc.stop();
});

/** A tiny DOM: elements with children, attributes, scroll and focus; enough for holdView/restoreView. */
function el(tag, attrs = {}, kids = []) {
  const e = {
    tag, attrs: { ...attrs }, children: [], parentElement: null, scrollTop: 0, scrollLeft: 0, selectionStart: null, selectionEnd: null,
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    contains(x) { for (let c = x; c; c = c.parentElement) if (c === this) return true; return false; },
    querySelectorAll(sel) {
      const all = [];
      const walk = (n) => { for (const k of n.children) { all.push(k); walk(k); } };
      walk(this);
      return sel === "*" ? all : all.filter((n) => n.getAttribute("data-bind") !== null);
    },
    focus() { doc.activeElement = this; },
    setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; },
  };
  for (const k of kids) { k.parentElement = e; e.children.push(k); }
  return e;
}
let doc;

test("holdView/restoreView: the focused field and its caret, and every scroll, survive a repaint", () => {
  const field = el("input", { "data-bind": "ask" });
  const list = el("div", {}, [el("p"), el("p")]);
  const view = el("div", { id: "view" }, [el("div", {}, [list, field])]);
  doc = { activeElement: field, getElementById: (id) => (id === "view" ? view : null) };
  view.scrollTop = 420;
  list.scrollTop = 80;
  field.selectionStart = 3; field.selectionEnd = 5;
  const held = L.holdView(doc);
  // The repaint: a new tree of the same shape.
  const field2 = el("input", { "data-bind": "ask" });
  const list2 = el("div", {}, [el("p"), el("p"), el("p")]);
  const view2 = el("div", { id: "view" }, [el("div", {}, [list2, field2])]);
  doc.getElementById = (id) => (id === "view" ? view2 : null);
  doc.activeElement = null;
  L.restoreView(doc, held);
  assert.equal(doc.activeElement, field2);
  assert.deepEqual([field2.selectionStart, field2.selectionEnd], [3, 5]);
  assert.equal(view2.scrollTop, 420);
  assert.equal(list2.scrollTop, 80);
});

function host(o = {}) {
  const listeners = {};
  const view = el("div", { id: "view" });
  doc = {
    activeElement: null, visibilityState: "visible",
    getElementById: (id) => (id === "view" ? view : null),
    addEventListener: (k, fn) => { (listeners[k] = listeners[k] || []).push(fn); },
  };
  const shown = { screenId: "bots.home", liveTopics: ["home"], state: { ask: "", n: 1 } };
  const h = {
    window: { WebSocket: FakeSocket, addEventListener: () => {} },
    document: doc,
    enabled: () => true, signedIn: () => false, token: () => "jwt", baseUrl: () => "https://api.tailzu.space", path: () => "/v1/live",
    current: shown, stack: [{ screenId: "bots.home" }], STATE: { ask: "kal", n: 1, desktop: {} }, seq: 1, applied: [],
    screen: () => h.current, target: () => h.stack[h.stack.length - 1], state: () => h.STATE, paintSeq: () => h.seq,
    fetch: async () => o.next || { screenId: "bots.home", liveTopics: ["home"], state: { ask: "", n: 2 } },
    apply: (next, patch) => { h.applied.push(patch); h.current = next; },
    ...o,
  };
  return h;
}

test("a quiet reload writes the server's new state but keeps the half-typed field", async () => {
  const h = host();
  const live = L.install(h);
  await live.reloadQuietly();
  assert.deepEqual(h.applied, [[["n", 2]]]);
  assert.equal(h.current.state.n, 2);
  live.stop();
});

test("a quiet reload stands down when another screen came up while it fetched", async () => {
  const h = host();
  h.fetch = async () => { h.seq++; return { screenId: "bots.home", state: {} }; };
  const live = L.install(h);
  await live.reloadQuietly();
  assert.deepEqual(h.applied, []);
  h.stack.push({ screenId: "bots.you" });
  h.fetch = async () => ({ screenId: "bots.you", state: {} });
  await live.reloadQuietly();
  assert.deepEqual(h.applied, []);
  live.stop();
});

test("in the window: wired to sdui.js's own session, stack, state and painting", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const vm = require("node:vm");
  const noop = () => {};
  const listeners = {};
  const g = {
    console: { warn: noop, log: noop, error: noop },
    setTimeout, clearTimeout, setInterval, clearInterval, Promise, JSON, Object, Array, String, Number, Math, Date, RegExp, Error, Set, Map, WeakMap,
    navigator: { language: "en-US" }, innerWidth: 1120, innerHeight: 780, devicePixelRatio: 2,
    addEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }),
    document: {
      addEventListener: (k) => { listeners[k] = (listeners[k] || 0) + 1; }, getElementById: () => null, querySelector: () => null,
      querySelectorAll: () => [], activeElement: null, visibilityState: "hidden",
    },
    tailzuApp: { env: () => new Promise(() => {}), onKnobs: noop, onNavigate: noop, onDictated: noop, onNotes: noop, onAskSetup: noop, onFolders: noop },
  };
  g.window = g;
  const ctx = vm.createContext(g);
  for (const f of ["knobs.js", "sdui.js", "live.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx, { filename: f });
  const run = (code) => vm.runInContext(code, ctx);
  try {
    assert.equal(run("typeof TailzuLiveWindow"), "object");
    assert.ok(listeners.input >= 1 && listeners.visibilitychange >= 1);
    // Signed out (no session): no socket.
    assert.equal(run("TailzuLiveWindow.host.signedIn()"), false);
    run("SESSION = { access_token: 't' }; STACK = [{ screenId: 'bots.home' }]; CURRENT_SCREEN = { screenId: 'bots.home', liveTopics: ['home'], state: { n: 1 } }; STATE = { n: 1, ask: 'kal' };");
    assert.equal(run("TailzuLiveWindow.host.signedIn()"), true);
    assert.equal(run("TailzuLiveWindow.host.screen().screenId"), "bots.home");
    assert.equal(run("TailzuLiveWindow.host.target().screenId"), "bots.home");
    // Applying a quiet reload writes into sdui.js's own state and actions, and paints with its own repaint.
    run("var __painted = null; repaint = function (s) { __painted = s; };");
    run("TailzuLiveWindow.host.apply({ screenId: 'bots.home', actions: { go: { kind: 'refresh' } }, state: { n: 2 } }, [['n', 2]]);");
    assert.equal(run("STATE.n"), 2);
    assert.equal(run("STATE.ask"), "kal");
    assert.equal(run("CURRENT_ACTIONS.go.kind"), "refresh");
    assert.equal(run("__painted.state.n"), 2);
  } finally {
    run("TailzuLiveWindow.stop()");
  }
});
