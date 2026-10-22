// The app window's Ask setup card (sdui.js DeskAskSetup), without a browser.
// sdui.js is a page script, not a module, so it is run here as the page runs
// it: knobs.js first, then sdui.js, in one context with a stand-in window and
// bridge. Its start() waits on env() forever, so nothing past the top level
// runs unless a test calls it.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const PROPS = {
  eyebrow: "Ask · one-time setup",
  title: "Let Ask see",
  titleEm: "what you see.",
  lede: "Allow these once and Ask answers straight away on any screen, without stopping to ask.",
  rows: [
    { key: "read", title: "Read the screen", sub: "Buttons, fields and text, so it can point at things and do small jobs." },
    { key: "see", title: "See the screen", sub: "Text in pictures, charts and diagrams. Opens the Mac's Screen Recording setting." },
    { key: "pictures", title: "Look at the screen when it's needed", sub: "When a question is about something on your screen, Ask looks without stopping to ask." },
  ],
  on: "On", allow: "Allow", turnOff: "Turn off",
  restart: "Restart Tailzu to finish", restartButton: "Restart",
  foot: "Change these any time in Settings. How Ask uses what it sees:",
  policyLabel: "Privacy policy", policyUrl: "https://tailzu.space/privacy",
};
const MAC = { platform: "mac", read: "on", see: "off", pictures: "off" };
const ALL_ON = { platform: "mac", read: "on", see: "on", pictures: "on" };
const WINDOWS = { platform: "windows", read: "na", see: "na", pictures: "off" };

/** A fresh page: its own module state, its own bridge. */
function page(env = { askSetup: true }, extra = {}) {
  const calls = [];
  const noop = () => {};
  // The page's clock, moved by hand: the card drops a second press inside
  // the moment of a double-click, so a test that presses twice says how far
  // apart.
  const clock = { now: 1_000_000 };
  class PageDate extends Date { static now() { return clock.now; } }
  const g = {
    console: { warn: noop, log: noop, error: noop },
    setTimeout, clearTimeout, setInterval, clearInterval, Promise, JSON, Object, Array, String, Number, Math, Date: PageDate, RegExp, Error,
    navigator: { language: "en-US" },
    innerWidth: 1120, innerHeight: 780, devicePixelRatio: 2,
    addEventListener: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop }),
    document: { addEventListener: noop, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], activeElement: null },
    fetch: extra.fetch,
    tailzuApp: {
      openExternal: (u) => { (extra.opened || []).push(u); },
      env: () => new Promise(() => {}),
      onKnobs: noop, onNavigate: noop, onDictated: noop, onNotes: noop,
      askSetup: async () => MAC,
      onAskSetup: (cb) => { g.__push = cb; },
      askSetupAction: (kind, on) => calls.push({ kind, on }),
    },
  };
  g.window = g;
  const ctx = vm.createContext(g);
  for (const f of ["knobs.js", "sdui.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx, { filename: f });
  }
  vm.runInContext("ENV = " + JSON.stringify(env), ctx);
  const run = (code) => vm.runInContext(code, ctx);
  return { ctx, g, calls, run, set: (st) => { ctx.__st = st; run("askSetupTook(__st)"); }, tick: (ms) => { clock.now += ms; } };
}

const card = (p, place) => {
  p.ctx.__n = { type: "DeskAskSetup", props: { ...PROPS, place } };
  return p.run("node(__n)");
};
const rows = (p, st) => { p.ctx.__p = PROPS; p.ctx.__st = st; return JSON.parse(p.run("JSON.stringify(askSetupRows(__p, __st))")); };

test("the window declares DeskAskSetup only when the main process says Ask is on", () => {
  const on = page({ askSetup: true });
  assert.ok(on.run("capabilities().components").includes("DeskAskSetup"));
  const off = page({ askSetup: false });
  assert.ok(!off.run("capabilities().components").includes("DeskAskSetup"));
  // The buttons' actions are declared, as notes.allowSystemAudio is.
  const actions = on.run("capabilities().actions");
  for (const a of ["ask.openAccessibility", "ask.openScreenRecording", "ask.picturesAll", "ask.relaunch"]) assert.ok(actions.includes(a), a);
});

test("each row takes its state and its one button from the main process", () => {
  const p = page();
  const mac = rows(p, MAC);
  assert.deepStrictEqual(mac.map((r) => [r.key, r.mode, r.done]), [["read", "on", true], ["see", "allow", false], ["pictures", "allow", false]]);
  assert.deepStrictEqual(mac[1].action, { kind: "ask.openScreenRecording" });
  assert.deepStrictEqual(mac[2].action, { kind: "ask.picturesAll", on: true });
  // Only the picture switch is this app's to turn off; the Mac's two are not.
  const on = rows(p, ALL_ON);
  assert.deepStrictEqual(on.map((r) => r.off), [null, null, { kind: "ask.picturesAll", on: false }]);
  // Windows has neither permission: those rows are simply on.
  assert.deepStrictEqual(rows(p, WINDOWS).map((r) => r.mode), ["on", "on", "allow"]);
  assert.deepStrictEqual(rows(p, WINDOWS).map((r) => r.off), [null, null, null]);
  // Granted, but the helper still could not look: a restart, and its button.
  const restart = rows(p, { ...MAC, see: "restart" })[1];
  assert.strictEqual(restart.mode, "restart");
  assert.deepStrictEqual(restart.action, { kind: "ask.relaunch" });
  // The server has pictures off for everyone: no button at all.
  const never = rows(p, { ...ALL_ON, pictures: "never" })[2];
  assert.strictEqual(never.mode, "never");
  assert.strictEqual(never.action, null);
  // Before the main process answers: no button that could move under the pointer.
  assert.deepStrictEqual(rows(p, null).map((r) => r.mode), ["wait", "wait", "wait"]);
});

test("a row the window has no state for is not drawn", () => {
  const p = page();
  p.ctx.__p = { ...PROPS, rows: [...PROPS.rows, { key: "camera", title: "x", sub: "y" }, { key: "__proto__", title: "x" }] };
  assert.strictEqual(p.run("askSetupRows(__p, " + JSON.stringify(MAC) + ").length"), 3);
});

test("the home card waits for the states, and goes once every row is on", () => {
  const p = page();
  assert.strictEqual(card(p, "home"), "", "nothing until the main process has answered");
  p.set(MAC);
  const html = card(p, "home");
  assert.match(html, /Let Ask see <em>what you see\.<\/em>/);
  assert.match(html, /data-ask="see" data-mode="allow"/);
  // The last row turned on while the card was up: it stays, ticked, for this visit.
  p.set(ALL_ON);
  assert.match(card(p, "home"), /data-ask="pictures" data-mode="on" data-done="1"/);
  // The next visit to the page (paint() clears the hold for another page).
  p.run("ASK_HOLD = false");
  assert.strictEqual(card(p, "home"), "");
  // One turned off again (in System Settings): it comes back.
  p.set({ ...ALL_ON, read: "off" });
  assert.match(card(p, "home"), /data-ask="read" data-mode="allow"/);
});

test("a picture switch the server has turned off does not keep the home card up", () => {
  const p = page();
  p.set({ ...ALL_ON, pictures: "never" });
  assert.strictEqual(card(p, "home"), "");
  assert.match(card(p, "settings"), /d-ask-never">Off</);
});

test("Settings always shows the rows, under its own heading", () => {
  const p = page();
  const waiting = card(p, "settings");
  assert.match(waiting, /data-place="settings"/);
  assert.doesNotMatch(waiting, /d-ask-btn/, "no buttons before the states are known");
  p.set(ALL_ON);
  const html = card(p, "settings");
  assert.doesNotMatch(html, /d-ask-title/, "the headline is the home page's");
  assert.match(html, /d-ask-quiet[^>]*>Turn off</);
  assert.strictEqual((html.match(/data-done="1"/g) || []).length, 3);
});

test("restart shows the server's line and its button", () => {
  const p = page();
  p.set({ ...MAC, see: "restart" });
  const html = card(p, "home");
  assert.match(html, /d-ask-note"><i><\/i>Restart Tailzu to finish</);
  assert.match(html, />Restart<\/button>/);
});

test("the buttons reach askSetupAction with the fixed kinds", async () => {
  const p = page();
  p.set(MAC);
  for (const a of [
    { kind: "ask.openAccessibility" }, { kind: "ask.openScreenRecording" },
    { kind: "ask.picturesAll", on: true }, { kind: "ask.picturesAll", on: false }, { kind: "ask.relaunch" },
  ]) { p.ctx.__a = a; await p.run("run(__a)"); p.tick(1000); }
  assert.deepStrictEqual(p.calls, [
    { kind: "openAccessibility", on: undefined }, { kind: "openScreenRecording", on: undefined },
    { kind: "picturesAll", on: true }, { kind: "picturesAll", on: false }, { kind: "relaunch", on: undefined },
  ]);
  // The picture switch is drawn at once; the main process's push confirms it.
  p.ctx.__a = { kind: "ask.picturesAll", on: true };
  await p.run("run(__a)");
  assert.strictEqual(p.run("ASK_SETUP.pictures"), "on");
});

test("the card's words are the server's, escaped", () => {
  const p = page();
  p.set(MAC);
  p.ctx.__n = { type: "DeskAskSetup", props: { ...PROPS, place: "home", title: "<img src=x onerror=alert(1)>", policyUrl: "javascript:alert(1)" } };
  const html = p.run("node(__n)");
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /d-ask-link/, "only an https policy address becomes a link");
});

test("the states are followed from env() on, and a push redraws only what changed", async () => {
  const p = page();
  p.run("askSetupWatch()");
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(p.run("ASK_SETUP.see"), "off");
  assert.strictEqual(typeof p.g.__push, "function");
  p.g.__push({ ...MAC, see: "on" });
  assert.strictEqual(p.run("ASK_SETUP.see"), "on");
  // A window whose main process has no Ask does not listen at all.
  const off = page({ askSetup: false });
  off.run("askSetupWatch()");
  assert.strictEqual(off.run("ASK_LISTENING"), false);
});

test("a second press inside a double-click is the same press", async () => {
  const p = page();
  p.set({ ...ALL_ON, pictures: "off" });
  // Allow, and the second click of the double-click on what took its place.
  p.ctx.__a = { kind: "ask.picturesAll", on: true };
  await p.run("run(__a)");
  p.tick(180);
  p.ctx.__a = { kind: "ask.picturesAll", on: false };
  await p.run("run(__a)");
  assert.deepStrictEqual(p.calls, [{ kind: "picturesAll", on: true }]);
  assert.strictEqual(p.run("ASK_SETUP.pictures"), "on", "the yes stands");
  // Restart twice is one relaunch.
  p.tick(1000);
  p.ctx.__a = { kind: "ask.relaunch" };
  await p.run("run(__a)");
  p.tick(120);
  await p.run("run(__a)");
  assert.strictEqual(p.calls.filter((c) => c.kind === "relaunch").length, 1);
  // A real second choice, a moment later, goes through.
  p.tick(1500);
  p.ctx.__a = { kind: "ask.picturesAll", on: false };
  await p.run("run(__a)");
  assert.deepStrictEqual(p.calls.at(-1), { kind: "picturesAll", on: false });
  // A clock set back is not a card that stops answering.
  p.tick(-3_600_000);
  p.ctx.__a = { kind: "ask.openScreenRecording" };
  await p.run("run(__a)");
  assert.deepStrictEqual(p.calls.at(-1), { kind: "openScreenRecording", on: undefined });
});

test("a malformed node or state draws what it can and never throws", () => {
  const p = page();
  p.set(MAC);
  for (const props of [
    {}, { rows: "x" }, { rows: [null, 3, "read", { key: "read" }] },
    { ...PROPS, rows: [{ key: "see", title: { x: 1 }, sub: 7 }], allow: null, on: undefined, cls: "d-page x-evil <b>", policyUrl: 5 },
  ]) {
    p.ctx.__n = { type: "DeskAskSetup", props };
    const html = p.run("node(__n)");
    assert.strictEqual(typeof html, "string");
    assert.doesNotMatch(html, /x-evil|<b>/);
  }
  // A row the server sent no words for is still drawn, with its state.
  p.ctx.__n = { type: "DeskAskSetup", props: { place: "settings", rows: [{ key: "read" }, { key: "see" }] } };
  assert.match(p.run("node(__n)"), /data-ask="read" data-mode="on".*data-ask="see" data-mode="allow"/);
  // Junk from the main process leaves every row waiting, with no button.
  for (const junk of [{ platform: 3, read: null, see: { x: 1 }, pictures: "maybe" }, null, "x", 4]) p.set(junk);
  assert.deepStrictEqual(rows(p, p.run("ASK_SETUP")).map((r) => r.mode), ["wait", "wait", "wait"]);
  p.ctx.__n = { type: "DeskAskSetup", props: { ...PROPS, place: "settings" } };
  assert.doesNotMatch(p.run("node(__n)"), /d-ask-btn/);
});

// ---- connected apps: the Connect button ------------------------------------------

const CONNECT_ENV = { baseUrl: "https://api.test" };
function connectPage(reply, state) {
  const requests = [];
  const opened = [];
  const fetch = async (url, init) => {
    requests.push({ url, method: init.method, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    return typeof reply === "function" ? reply(url) : reply;
  };
  const p = page(CONNECT_ENV, { fetch, opened });
  for (const [path, value] of Object.entries(state || {})) { p.ctx.__v = value; p.run(`setStatePath(${JSON.stringify(path)}, __v)`); }
  const connect = async (a) => { p.ctx.__a = a; await p.run("run(__a)"); };
  const reached = (path) => p.run(`stateAt(${JSON.stringify(path)})`);
  return { p, requests, opened, connect, reached };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const AFTER = { onSuccess: { kind: "setState", path: "flag", value: "yes" }, onError: { kind: "setState", path: "flag", value: "no" } };

test("the window says it shows the assistant's side, and can connect an app", () => {
  const p = page({ askSetup: false });
  assert.ok(p.run("capabilities().components").includes("DeskConnectors"));
  assert.ok(p.run("capabilities().actions").includes("connector.connect"));
});

test("Connect asks the API's own connect route and opens the sign-in page it answers with", async () => {
  const c = connectPage(json({ authorizeUrl: "https://mcp.notion.com/authorize?state=x" }));
  await c.connect(Object.assign({ kind: "connector.connect", id: "notion" }, AFTER));
  assert.deepStrictEqual(c.requests, [{ url: "https://api.test/v1/connectors/notion/connect", method: "POST", body: {} }]);
  assert.deepStrictEqual(c.opened, ["https://mcp.notion.com/authorize?state=x"]);
  assert.strictEqual(c.reached("flag"), "yes");
  // Coming back to the window redraws the page once (the focus handler).
  assert.strictEqual(c.p.run("CONNECT_PENDING"), true);
});

test("a sign-in page that is not https is never opened", async () => {
  for (const authorizeUrl of ["http://evil.test/x", "javascript:alert(1)", "file:///etc/passwd", "", undefined, 7]) {
    const c = connectPage(json({ authorizeUrl }));
    await c.connect(Object.assign({ kind: "connector.connect", id: "notion" }, AFTER));
    assert.deepStrictEqual(c.opened, [], String(authorizeUrl));
    assert.strictEqual(c.reached("flag"), "no", String(authorizeUrl));
  }
});

test("only an app's id goes into the route: nothing else is asked", async () => {
  for (const id of ["../v1/tasks", "notion/level", "a b", "", "Notion", undefined, "x".repeat(60), "https://evil.test"]) {
    const c = connectPage(json({ authorizeUrl: "https://ok.test/" }));
    await c.connect(Object.assign({ kind: "connector.connect", id }, AFTER));
    assert.deepStrictEqual(c.requests, [], String(id));
    assert.deepStrictEqual(c.opened, [], String(id));
    assert.strictEqual(c.reached("flag"), "no", String(id));
  }
});

test("an app that takes a pasted link sends what the field holds, and needs no browser", async () => {
  const c = connectPage(json({ connected: true }), { "link.zapier": "  https://mcp.zapier.com/api/mcp/s/abc  " });
  await c.connect(Object.assign({ kind: "connector.connect", id: "zapier", urlPath: "link.zapier" }, AFTER));
  assert.deepStrictEqual(c.requests, [{ url: "https://api.test/v1/connectors/zapier/connect", method: "POST", body: { url: "https://mcp.zapier.com/api/mcp/s/abc" } }]);
  assert.deepStrictEqual(c.opened, []);
  assert.strictEqual(c.reached("flag"), "yes");
});

test("a refusal, or an API that cannot be reached, is the action's onError", async () => {
  const refused = connectPage(json({ code: "bad_request", message: "Paste the link." }, 400));
  await refused.connect(Object.assign({ kind: "connector.connect", id: "zapier", urlPath: "link.zapier" }, AFTER));
  assert.strictEqual(refused.reached("flag"), "no");
  const gone = connectPage(() => { throw new TypeError("offline"); });
  await gone.connect(Object.assign({ kind: "connector.connect", id: "notion" }, AFTER));
  assert.strictEqual(gone.reached("flag"), "no");
  assert.deepStrictEqual(gone.opened, []);
});
