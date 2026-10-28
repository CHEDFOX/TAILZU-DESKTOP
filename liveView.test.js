// A live page and the outbox in the window (liveView.js, liveViewMain.js, outbox.js; the server's shared/types/sdui.ts 3e).
// The rules run on their own; the page scripts run as the page runs them: knobs.js, sdui.js, then these, in one context with a
// stand-in window (bots.test.js does the same).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { liveSourceOf, liveParse, liveSendScript, liveOpenableHost, liveKey } = require("./liveView.js");
const { lockPrefs, staysHome, LIVE_PARTITION } = require("./liveViewMain.js");
const { makeOutbox, outboxRetryable, outboxClock } = require("./outbox.js");

// ------------------------------------------------------------------ the rules

test("a live page comes only from http(s), data: or about:, or the html the server wrote (run as an https origin, or opaque)", () => {
  assert.deepStrictEqual(liveSourceOf({ url: "https://preview.example/app" }), { kind: "url", url: "https://preview.example/app" });
  assert.deepStrictEqual(liveSourceOf({ url: "data:text/html,<p>x</p>" }), { kind: "url", url: "data:text/html,<p>x</p>" });
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "tulmi://x", "https://u:p@x.example/", "", 7]) assert.strictEqual(liveSourceOf({ url }), null, String(url));
  assert.deepStrictEqual(liveSourceOf({ html: "<p>x</p>", origin: "https://tailzu.space/a" }), { kind: "html", html: "<p>x</p>", baseUrl: "https://tailzu.space/" });
  assert.deepStrictEqual(liveSourceOf({ html: "<p>x</p>", origin: "http://tailzu.space" }), { kind: "html", html: "<p>x</p>", baseUrl: "" });
  assert.notStrictEqual(liveKey(liveSourceOf({ html: "<p>a</p>" })), liveKey(liveSourceOf({ html: "<p>b</p>" })));
  assert.strictEqual(liveKey(liveSourceOf({ url: "https://a.example" })), liveKey(liveSourceOf({ url: "https://a.example" })));
});

test("what the page says is a small object with a t; what the app says back is one safe line", () => {
  assert.deepStrictEqual(liveParse('{"t":"select","id":"5:86"}'), { t: "select", id: "5:86" });
  for (const raw of ["", "x", "[1]", '{"x":1}', '{"t":""}', `{"t":"a","p":"${"x".repeat(9000)}"}`, null]) assert.strictEqual(liveParse(raw), null);
  assert.strictEqual(liveSendScript({ pick: false }), 'try { if (typeof window.tzLive === "function") window.tzLive({"pick":false}); } catch (e) {} true;');
  assert.strictEqual(liveSendScript(null), null);
  assert.strictEqual(liveOpenableHost("https://example.com:8443/x"), "example.com");
  assert.strictEqual(liveOpenableHost("https://u:p@example.com/"), null);
});

test("every webview runs locked down, whatever it asked for, and stays on its own site", () => {
  const wp = lockPrefs({ nodeIntegration: true, preload: "/evil.js", webSecurity: false, contextIsolation: false, sandbox: false, partition: "persist:app", zoomFactor: 1.25 }, "/app/liveViewGuest.js");
  assert.deepStrictEqual(
    { node: wp.nodeIntegration, sub: wp.nodeIntegrationInSubFrames, iso: wp.contextIsolation, sandbox: wp.sandbox, web: wp.webSecurity, insecure: wp.allowRunningInsecureContent, preload: wp.preload, partition: wp.partition, tag: wp.webviewTag, zoom: wp.zoomFactor },
    { node: false, sub: false, iso: true, sandbox: true, web: true, insecure: false, preload: "/app/liveViewGuest.js", partition: LIVE_PARTITION, tag: false, zoom: 1.25 },
  );
  assert.ok(!LIVE_PARTITION.startsWith("persist:"));
  assert.strictEqual(staysHome("https://preview.example/a", "https://preview.example/b"), true);
  assert.strictEqual(staysHome("https://preview.example/a", "https://other.example/"), false);
  assert.strictEqual(staysHome("data:text/html,x", "https://tailzu.space/"), false);
  assert.strictEqual(staysHome("https://preview.example/", "javascript:alert(1)"), false);
});

test("the main process attaches only the app window's webviews, from allowed addresses, and denies new windows and permissions", () => {
  const { setupLiveViews } = require("./liveViewMain.js");
  const on = {};
  const app = { on: (ev, f) => { on[ev] = f; } };
  const handlers = {};
  const ses = { setPermissionRequestHandler: (f) => { handlers.req = f; }, setPermissionCheckHandler: (f) => { handlers.check = f; }, on: (ev, f) => { handlers[ev] = f; } };
  const appContents = { on: (ev, f) => { appContents[ev] = f; }, send: (ch, m) => { appContents.sent = [ch, m]; }, isDestroyed: () => false };
  const other = { on: (ev, f) => { other[ev] = f; } };
  setupLiveViews({ app, session: { fromPartition: () => ses }, path: { join: (...a) => a.join("/") }, isAppWindow: (c) => c === appContents });
  on["web-contents-created"]({}, appContents);
  on["web-contents-created"]({}, other);
  const attach = (contents, src) => { let refused = false; const wp = { nodeIntegration: true }; contents["will-attach-webview"]({ preventDefault: () => { refused = true; } }, wp, { src }); return { refused, wp }; };
  assert.strictEqual(attach(other, "https://x.example").refused, true);
  assert.strictEqual(attach(appContents, "file:///etc/passwd").refused, true);
  assert.strictEqual(attach(appContents, "javascript:alert(1)").refused, true);
  const ok = attach(appContents, "about:blank");
  assert.strictEqual(ok.refused, false);
  assert.strictEqual(ok.wp.nodeIntegration, false);
  let granted = null;
  handlers.req({}, "media", (g) => { granted = g; });
  assert.strictEqual(granted, false);
  assert.strictEqual(handlers.check(), false);
  let stopped = false;
  handlers["will-download"]({ preventDefault: () => { stopped = true; } });
  assert.ok(stopped);
  const guest = { id: 7, on: (ev, f) => { guest[ev] = f; }, setWindowOpenHandler: (f) => { guest.open = f; }, getURL: () => "https://preview.example/" };
  appContents["did-attach-webview"]({}, guest);
  assert.deepStrictEqual(guest.open({ url: "https://other.example/" }), { action: "deny" });
  assert.deepStrictEqual(appContents.sent, ["live:open", { guestId: 7, url: "https://other.example/" }]);
  let blocked = false;
  guest["will-navigate"]({ preventDefault: () => { blocked = true; } }, "https://other.example/");
  assert.ok(blocked);
  blocked = false;
  guest["will-navigate"]({ preventDefault: () => { blocked = true; } }, "https://preview.example/cart");
  assert.ok(!blocked);
});

// ------------------------------------------------------------------ the outbox's core (the phone's rules)

function io(o = {}) {
  let t = Date.UTC(2026, 9, 28, 4, 8), n = 0;
  const disk = o.disk || { v: null };
  const sent = [];
  return {
    sent, disk, tick: (ms) => { t += ms; },
    load: async () => disk.v, save: async (j) => { disk.v = j; },
    send: async (p, b) => { const e = o.fail && o.fail(p, b); if (e) throw e; sent.push({ path: p, body: b }); return {}; },
    now: () => t, newId: () => (o.ids || "id") + "-" + String(++n).padStart(4, "0"), timeText: () => "9:38",
  };
}
const ask = (label) => ({ path: "/v1/shell/ask", body: { message: label, bot: "any", device: "desktop", mode: "text" }, label, sub: "Any bot · asked {time}" });

test("asks go out once, in order, with their id and when they were typed; a failure that may pass holds the rest", async () => {
  let down = true;
  const d = io({ fail: () => (down ? new TypeError("Failed to fetch") : null) });
  const box = makeOutbox(d);
  await box.ready();
  const a = box.add(ask("Move gym to 7 am on Thursday"));
  box.add(ask("Cab to the airport, Sat 4:30 am"));
  assert.strictEqual(a.sub, "Any bot · asked 9:38");
  assert.strictEqual(await box.flush(true), 0);
  assert.deepStrictEqual(box.view().outbox.map((x) => x.state), ["waiting", "waiting"]);
  down = false;
  d.tick(2000);
  assert.strictEqual(await box.flush(true), 2);
  assert.deepStrictEqual(d.sent.map((s) => [s.body.message, s.body.clientId, s.body.typedAt]), [
    ["Move gym to 7 am on Thursday", "id-0001", a.typedAt], ["Cab to the airport, Sat 4:30 am", "id-0002", a.typedAt],
  ]);
  assert.strictEqual(box.view().outboxWaiting, 0);
});

test("a refusal that will not change fails that ask and the next goes; kept across a restart; only /v1/ routes", async () => {
  const d = io({ fail: (_p, b) => (b.message === "bad" ? { status: 422 } : null) });
  const box = makeOutbox(d);
  box.add(ask("bad")); box.add(ask("good"));
  assert.strictEqual(await box.flush(true), 1);
  assert.deepStrictEqual(box.view().outbox.map((x) => x.state), ["failed", "sent"]);
  assert.strictEqual(box.retry("id-0001"), true);
  assert.strictEqual(box.add({ ...ask("x"), path: "https://evil.example/v1/x" }), null);
  const rows = JSON.parse(d.disk.v);
  rows[0].state = "sending";
  const again = makeOutbox(io({ disk: { v: JSON.stringify(rows) }, ids: "later" }));
  again.add(ask("typed now"));
  await again.ready();
  assert.deepStrictEqual(again.view().outbox.map((x) => [x.label, x.state]), [["bad", "waiting"], ["good", "sent"], ["typed now", "waiting"]]);
  assert.strictEqual(outboxRetryable({ status: 409 }), true);
  assert.strictEqual(outboxRetryable({ status: 400 }), false);
  assert.strictEqual(outboxClock(new Date(2026, 9, 28, 21, 5).getTime()), "9:05");
});

// ------------------------------------------------------------------ in the page

function page(o = {}) {
  const noop = () => {};
  const store = {};
  const g = {
    console: { warn: noop, log: noop, error: noop },
    setTimeout, clearTimeout, setInterval, clearInterval, Promise, JSON, Object, Array, String, Number, Math, Date, RegExp, Error, Proxy, Set, Map, TextEncoder, btoa, atob,
    navigator: { language: "en-IN", onLine: o.online !== false }, innerWidth: 1280, innerHeight: 800, devicePixelRatio: 2, addEventListener: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop }),
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    crypto: { randomUUID: (() => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`; })() },
    document: {
      addEventListener: noop, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], activeElement: null,
      createElement: (tag) => (tag === "webview" && o.webview ? { loadURL() {} } : { setAttribute: noop, style: {} }),
    },
    fetch: o.fetch,
    tailzuApp: { env: () => new Promise(() => {}), onKnobs: noop, onNavigate: noop, onDictated: noop, onNotes: noop, askSetup: async () => null, onAskSetup: noop, folders: async () => ({}), onFolders: noop, openExternal: noop },
  };
  g.window = g;
  const ctx = vm.createContext(g);
  for (const f of ["knobs.js", "sdui.js", "liveView.js", "outbox.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx, { filename: f });
  // A signed-in account (a token whose `sub` is the user), and the bootstrap's offline flags.
  const tok = "x." + Buffer.from(JSON.stringify({ sub: "u-1" })).toString("base64url") + ".y";
  vm.runInContext(`ENV = { baseUrl: 'https://api.test' }; SESSION = { access_token: ${JSON.stringify(tok)}, expires_at: 9999999999 };
    K.setKnobs({ labels: {}, flags: { "offline.screenId": "bots.offline", "offline.roots": ["bots.home"], "offline.bar": "You're offline", "offline.sentToast": "Sent." } });`, ctx);
  const run = (code) => vm.runInContext(code, ctx);
  return { ctx, run, store };
}

test("the window says it keeps an outbox, and draws LiveView only where it can make a webview", () => {
  const p = page();
  const caps = p.run("capabilities()");
  assert.ok(caps.components.includes("Outbox"));
  assert.ok(caps.actions.includes("outbox"));
  assert.ok(!caps.components.includes("LiveView"));
  assert.ok(page({ webview: true }).run("capabilities()").components.includes("LiveView"));
});

test("a LiveView is a slot in the page, with the state it is to be told; the page itself is a layer kept by its source", () => {
  const p = page({ webview: true });
  p.run("STATE = { liveSend: { pick: true } }");
  p.ctx.__n = { type: "LiveView", props: { html: "<p>host</p>", origin: "https://tailzu.space", messagePath: "live", title: "Pricing card" }, bind: { send: "liveSend" }, style: { height: 440 } };
  const html = p.run("node(__n)");
  assert.match(html, /^<div data-live="[a-z0-9-]+" style="height:440px;position:relative;" aria-label="Pricing card"><\/div>$/);
  const slots = JSON.parse(p.run("JSON.stringify(LIVE_SLOTS.map((x) => ({ key: x.key, props: x.props, src: x.src })))"));
  assert.strictEqual(slots.length, 1);
  assert.deepStrictEqual(slots[0].props.send, { pick: true });
  assert.deepStrictEqual(slots[0].src, { kind: "html", html: "<p>host</p>", baseUrl: "https://tailzu.space/" });
  // An address it may not show is the error's words, never a webview.
  p.ctx.__bad = { type: "LiveView", props: { url: "file:///etc/passwd", errorText: "Couldn't open the page." } };
  assert.match(p.run("node(__bad)"), /Couldn't open the page\./);
});

test("an ask kept in the window goes out with its own id, once online, and every screen reads the outbox", async () => {
  const sent = [];
  const p = page({ fetch: async (url, init) => { sent.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization }); return { ok: true, status: 200, json: async () => ({ shell: {} }) }; } });
  p.run("STATE = { later: 'Move gym to 7 am on Thursday' }");
  await p.run(`outboxRun({ kind: "outbox", op: "add", path: "/v1/shell/ask", body: { message: "$state.later", bot: "any", device: "desktop", mode: "text" }, label: "$state.later", sub: "Any bot · asked {time}" })`);
  for (let i = 0; i < 20 && !sent.length; i++) await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].url, "https://api.test/v1/shell/ask");
  assert.match(sent[0].auth, /^Bearer x\./);
  assert.deepStrictEqual({ ...sent[0].body, typedAt: 0 }, { message: "Move gym to 7 am on Thursday", bot: "any", device: "desktop", mode: "text", clientId: "00000000-0000-4000-8000-000000000001", typedAt: 0 });
  for (let i = 0; i < 20 && p.run("offlineState().outbox[0].state") !== "sent"; i++) await new Promise((r) => setTimeout(r, 5));
  const st = JSON.parse(p.run("JSON.stringify(offlineState())"));
  assert.strictEqual(st.online, true);
  assert.strictEqual(st.outboxWaiting, 0);
  assert.deepStrictEqual(st.outbox.map((x) => [x.label, x.state]), [["Move gym to 7 am on Thursday", "sent"]]);
  assert.ok(JSON.parse(p.store["tz.outbox.u-1"]).length === 1);   // kept per account
});

test("offline, Home is drawn as the kept Offline page, and the stack remembers what it stands in for", () => {
  const p = page({ online: false });
  p.run(`STACK = [{ screenId: "bots.home" }]; OFFLINE_KEPT = { owner: "u-1", screen: { screenId: "bots.offline", root: { type: "Stack" } } };`);
  const s = p.run(`offlineInstead(STACK[0])`);
  assert.strictEqual(s.screenId, "bots.offline");
  assert.deepStrictEqual(JSON.parse(p.run("JSON.stringify(STACK)")), [{ screenId: "bots.offline", auto: { screenId: "bots.home" } }]);
  // Back online, what it stood in for comes back, wherever it is in the stack.
  p.run(`STACK.push({ screenId: "bots.keybot" }); paint = () => {}; repaint = () => {}; offlineTurn(true)`);
  assert.deepStrictEqual(JSON.parse(p.run("JSON.stringify(STACK)")), [{ screenId: "bots.home" }, { screenId: "bots.keybot" }]);
  p.run("offlineTurn(false)");
  // Another screen is fetched as ever (and shows the line over it); online, nothing is swapped.
  assert.strictEqual(p.run(`offlineInstead({ screenId: "bots.activity" })`), null);
  assert.strictEqual(page().run(`OFFLINE_KEPT = { owner: "u-1", screen: { screenId: "bots.offline" } }; offlineInstead({ screenId: "bots.home" })`), null);
  // Another account's kept page is not drawn.
  assert.strictEqual(p.run(`OFFLINE_KEPT = { owner: "u-2", screen: { screenId: "bots.offline" } }; offlineInstead({ screenId: "bots.home" })`), null);
});
