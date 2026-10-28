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
    document: extra.document || { addEventListener: noop, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], activeElement: null },
    fetch: extra.fetch,
    tailzuApp: {
      openExternal: (u) => { (extra.opened || []).push(u); },
      env: () => new Promise(() => {}),
      onKnobs: noop, onNavigate: noop, onDictated: noop, onNotes: noop,
      askSetup: async () => MAC,
      onAskSetup: (cb) => { g.__push = cb; },
      askSetupAction: (kind, on) => calls.push({ kind, on }),
      folders: async () => ({ custom: false, folders: [], error: "" }),
      onFolders: (cb) => { g.__pushFolders = cb; },
      foldersAction: (kind, i) => calls.push({ folders: kind, i }),
    },
  };
  // Whatever else a test needs the page to have (a microphone, a recorder, listeners to fire).
  Object.assign(g, extra.globals || {});
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

// ---- the onboarding: the stage, Blip's spot, and the sign-in that wears it ------------
//
// The two trees in test-fixtures are what the backend's onboard.ts makes for a
// window on a Mac (onboardAuthTree({ desktop: true, connectorsOn: true }) and
// buildScreen("onboard") for a desktop with five apps, one of them connected),
// so these draw the server's own JSON, not a shape written here to match the
// renderer. The browser-only parts (the walk, the glide) are checked on a page.
const AUTH_FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "test-fixtures", "onboard-auth.json"), "utf8"));
const ONBOARD = JSON.parse(fs.readFileSync(path.join(__dirname, "test-fixtures", "onboard-screen.json"), "utf8"));

const NOOP_DOM = { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], activeElement: null };
/** A page with a gate in it: the bits of the document the sign-in paints into. */
function gatePage(extra = {}) {
  const gateForm = { innerHTML: "", dataset: {}, querySelector: () => null, querySelectorAll: () => [] };
  const nodes = { gate: { hidden: false }, gateForm, gateErr: { textContent: "" } };
  const p = page({ baseUrl: "https://api.test" }, { ...extra, document: { ...NOOP_DOM, getElementById: (id) => nodes[id] || null } });
  p.ctx.__tree = AUTH_FIXTURE;
  p.run("AUTH_TREE = __tree; BOOT = { flags: { 'auth.enablePhone': true } }; AUTH.phoneOn = true;");
  return { p, gateForm, nodes };
}

/** The server's screen on a page, with its state in place. */
function screenPage(extra, mutate) {
  const p = page({ baseUrl: "https://api.test" }, extra);
  const st = JSON.parse(JSON.stringify(ONBOARD.state));
  if (mutate) mutate(st);
  p.ctx.__st = st; p.ctx.__root = ONBOARD.root;
  p.run("STATE = Object.assign({}, __st)");
  return p;
}
const drawn = (p) => p.run("handlers = []; node(__root)");
const unq = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** The spots in a drawn step, as the data they carry. */
const spotsIn = (html) => [...html.matchAll(/data-blip="([^"]*)"/g)].map((m) => JSON.parse(unq(m[1])));
const attr = (html, name) => { const m = new RegExp(name + '="([^"]*)"').exec(html); return m ? unq(m[1]) : null; };

test("the window says it can draw an OnboardStage and a BlipSpot", () => {
  const comps = page().run("capabilities().components");
  assert.ok(comps.includes("OnboardStage"));
  assert.ok(comps.includes("BlipSpot"));
});

test("a stage draws only the step it is on, and says which, and how far along", () => {
  const p = screenPage();
  let html = drawn(p);
  assert.strictEqual(attr(html, "data-stage"), "onboard");
  assert.deepStrictEqual(["data-step", "data-first", "data-of", "data-step-id"].map((a) => attr(html, a)), ["0", "3", "8", "languages"]);
  assert.match(html, /Which languages do you speak\?/);
  assert.doesNotMatch(html, /Try it once|Connect your apps|You’re all set/, "the other steps are not in the page");
  assert.strictEqual((html.match(/class="ob-step"/g) || []).length, 1);
  p.run("setStatePath('step', 1)");
  html = drawn(p);
  assert.strictEqual(attr(html, "data-step-id"), "try");
  assert.match(html, /Try it once/);
  assert.doesNotMatch(html, /Which languages/);
});

test("a stage never goes back on a refetch, and a step out of range is the nearest one", () => {
  const p = screenPage();
  p.run("setStatePath('step', 2)");
  assert.strictEqual(attr(drawn(p), "data-step-id"), "apps");
  // The screen is fetched again (an app was connected): its state starts over at 0, the stage does not.
  p.run("STATE = Object.assign({}, __st)");
  assert.strictEqual(attr(drawn(p), "data-step-id"), "apps");
  // Forward is forward.
  p.run("setStatePath('step', 3)");
  assert.strictEqual(attr(drawn(p), "data-step-id"), "careful");
  p.run("setStatePath('step', 99)");
  assert.strictEqual(attr(drawn(p), "data-step-id"), "done");
  // Each stage is remembered on its own.
  const q = page();
  q.ctx.__a = AUTH_FIXTURE;
  q.run("setStatePath('step', 1)");
  assert.strictEqual(attr(q.run("handlers = []; node(__a)"), "data-stage"), "onboard.auth");
  assert.strictEqual(attr(q.run("handlers = []; node(__a)"), "data-step"), "1");
});

test("the sign-in flow's phase picks the step while it runs, and is not remembered", () => {
  const p = page();
  p.ctx.__a = AUTH_FIXTURE;
  const at = (phase) => { p.run(`AUTH.phase = ${JSON.stringify(phase)}`); const h = p.run("handlers = []; node(__a)"); return [attr(h, "data-step"), attr(h, "data-step-id")]; };
  assert.deepStrictEqual(at("entry"), ["0", "welcome"]);
  p.run("setStatePath('step', 1)");
  assert.deepStrictEqual(at("entry"), ["1", "signin"]);
  assert.deepStrictEqual(at("sending"), ["1", "signin"], "a code on its way is still the sign-in step");
  assert.deepStrictEqual(at("verify"), ["2", "code"]);
  assert.deepStrictEqual(at("verifying"), ["2", "code"]);
  // "Change it" returns the flow to its entry, and the step with it.
  assert.deepStrictEqual(at("entry"), ["1", "signin"]);
});

test("a stage shows exactly one Blip in every state a step can be in", () => {
  const p = screenPage();
  const steps = ONBOARD.root.children.length;
  for (let step = 0; step < steps; step++) {
    // The Try step is the one whose spot depends on state: the mic's and what it wrote.
    for (const mic of ["idle", "recording", "busy"]) for (const tried of ["", "Haan bhai."]) {
      p.ctx.__v = { mic, tried };
      p.run("for (const k of Object.keys(OB_STEP)) delete OB_STEP[k]; STATE.mic = __v.mic; STATE.tried = __v.tried; STATE.step = " + step);
      const found = spotsIn(drawn(p));
      assert.strictEqual(found.length, 1, `step ${step} mic ${mic} tried "${tried}": ${found.length} Blips`);
    }
  }
  // Which one, on Try it.
  const pose = (mic, tried) => {
    p.ctx.__v = { mic, tried };
    p.run("for (const k of Object.keys(OB_STEP)) delete OB_STEP[k]; STATE.mic = __v.mic; STATE.tried = __v.tried; STATE.step = 1");
    return spotsIn(drawn(p))[0].pose;
  };
  assert.strictEqual(pose("idle", ""), "present");
  assert.strictEqual(pose("recording", ""), "listen");
  assert.strictEqual(pose("busy", ""), "listen");
  assert.strictEqual(pose("idle", "Haan bhai."), "tada");
  // …and the sign-in tree's, by phase.
  const a = page();
  a.ctx.__a = AUTH_FIXTURE;
  for (const [phase, step, pose2] of [["entry", 0, "wave"], ["entry", 1, "key"], ["verify", 0, "wait"], ["verifying", 0, "nod"]]) {
    a.run(`AUTH.phase = ${JSON.stringify(phase)}; for (const k of Object.keys(OB_STEP)) delete OB_STEP[k]; STATE.step = ${step}`);
    const found = spotsIn(a.run("handlers = []; node(__a)"));
    assert.deepStrictEqual(found.map((s) => s.pose), [pose2], `${phase} ${step}`);
  }
});

test("a BlipSpot is the box his figure needs, and carries what he does there", () => {
  const p = page();
  p.ctx.__n = { type: "BlipSpot", props: { pose: "tada", h: 190, say: "We did it!", bubble: "corner", burst: true }, style: { marginLeft: -46, marginRight: -30 } };
  const html = p.run("node(__n)");
  assert.deepStrictEqual(spotsIn(html), [{ pose: "tada", h: 190, say: "We did it!", bubble: "corner", burst: true }]);
  // ceil(1.4h) by ceil(1.16h + 4): 266 by 225.
  assert.match(html, /width:266px;height:225px;margin-left:-46px;margin-right:-30px/);
  assert.match(html, /class="bs"/);
  // The words are the server's; the box is not made of them.
  p.ctx.__n = { type: "BlipSpot", props: { pose: "x\" onmouseover=\"y", h: "tall", say: "<b>hi</b>", bubble: "nowhere" } };
  const odd = p.run("node(__n)");
  assert.doesNotMatch(odd, /<b>|onmouseover=/);
  assert.deepStrictEqual(spotsIn(odd), [{ pose: "present", h: 100, say: "<b>hi</b>", bubble: "side", burst: false }]);
});

test("when two spots are on show the last one is the one he goes to", () => {
  const p = page();
  assert.strictEqual(p.run("lastSpot(['a', 'b', 'c'])"), "c");
  assert.strictEqual(p.run("lastSpot(['a'])"), "a");
  assert.strictEqual(p.run("lastSpot([])"), null);
  assert.strictEqual(p.run("lastSpot(null)"), null);
});

test("a style value can follow state; one that is not a value is dropped", () => {
  const p = page();
  p.run("STATE = { langs: ['hi', 'en'] }");
  p.ctx.__s = {
    borderColor: { contains: ["langs", "en"], then: "#1C1A17", else: "rgba(28,26,23,0.13)" },
    backgroundColor: { contains: ["langs", "ta"], then: "#aaa", else: "#fff" },
    color: { truthy: "nothing", then: "red" },
    margin: { stray: 1 },
  };
  assert.strictEqual(p.run("css(__s)"), "border-color:#1C1A17;background-color:#fff");
});

test("in the onboarding a border with a width is a solid one, and nowhere else", () => {
  const p = page();
  p.ctx.__s = { borderWidth: 1.5, borderColor: "#111", borderBottomWidth: 1, borderStyle: "dashed" };
  assert.strictEqual(p.run("css(__s)"), "border-width:1.5px;border-color:#111;border-bottom-width:1px;border-style:dashed");
  p.run("IN_STAGE++");
  // Written first, so the node's own style still wins.
  assert.strictEqual(p.run("css(__s)"), "border-style:solid;border-bottom-style:solid;border-width:1.5px;border-color:#111;border-bottom-width:1px;border-style:dashed");
  p.ctx.__s = { fontFamily: "Tailzu Grotesk" };
  assert.strictEqual(p.run("css(__s)"), "font-family:Tailzu Grotesk,var(--f-ui),var(--f-deva)", "a face with only Latin letters has somewhere to fall back for Hindi");
  p.run("IN_STAGE--");
  assert.strictEqual(p.run("css(__s)"), "font-family:Tailzu Grotesk");
});

test("a line drawn from state is drawn from state in the onboarding, and a Grid with columns is a grid", () => {
  const p = page();
  p.run("STATE = { ln: { hi: 'Hindi' } }");
  p.ctx.__n = { type: "Text", props: { content: "" }, bind: { content: "ln.hi" } };
  assert.match(p.run("node(__n)"), />\s*<\/span>$/, "elsewhere the node's own words, as before");
  p.run("IN_STAGE++");
  assert.match(p.run("node(__n)"), />Hindi<\/span>$/);
  p.run("IN_STAGE--");
  p.ctx.__n = { type: "Grid", props: { columns: 3, gap: 8 }, children: [{ type: "Text", props: { content: "x" } }] };
  assert.match(p.run("node(__n)"), /display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\);gap:8px/);
  p.ctx.__n = { type: "Spacer", style: { flex: 1, minHeight: 12 } };
  assert.match(p.run("node(__n)"), /flex:1;min-height:12px/);
});

test("every step of the server's own screen draws, with nothing left unresolved", () => {
  const p = screenPage();
  const steps = ONBOARD.root.children.length;
  for (let step = 0; step < steps; step++) {
    p.run(`for (const k of Object.keys(OB_STEP)) delete OB_STEP[k]; STATE.step = ${step}`);
    const html = drawn(p);
    assert.doesNotMatch(html, /\[object|undefined|NaN/, `step ${step}`);
    assert.ok(html.length > 500, `step ${step} drew nothing`);
  }
  // The language chips and the app tiles are the screen's state, drawn as it says.
  p.run("for (const k of Object.keys(OB_STEP)) delete OB_STEP[k]; STATE.step = 0");
  const chips = drawn(p);
  assert.match(chips, />Hinglish</);
  assert.match(chips, /\+ 51 more/);
  // A picked chip is lit, one not picked is not: the conditional style, resolved.
  assert.match(chips, /border-color:#1C1A17;background-color:rgba\(57,255,20,0\.2\)[^>]*>(?:<svg[^>]*><path[^>]*><\/path><\/svg>)?<span[^>]*>Hindi</);
  p.run("STATE.step = 2");
  const apps = drawn(p);
  assert.match(apps, />Notion</);
  assert.match(apps, />Jira and Confluence</);
  assert.match(apps, /display:grid;grid-template-columns:repeat\(3/);
  assert.strictEqual((apps.match(/>Connected</g) || []).length, 1, "Linear is the one that is connected");
});

test("the sign-in step: Google and Apple wide with their words, a field and a button for email, the phone behind its switch", () => {
  const p = page();
  p.ctx.__a = AUTH_FIXTURE;
  p.run("STATE.step = 1; BOOT = { flags: { 'auth.enablePhone': true } }; AUTH.phoneOn = true");
  const html = p.run("handlers = []; node(__a)");
  assert.match(html, /data-oauth="google"[^>]*style="[^"]*width:100%/);
  assert.match(html, /<span>Continue with Google<\/span>/);
  assert.match(html, /data-oauth="apple"[^>]*style="[^"]*width:100%/);
  assert.match(html, /<span>Continue with Apple<\/span>/);
  // The email field and the button under it.
  assert.match(html, /<input class="ob-in" data-pill="email" data-field="1"[^>]*placeholder="Email address"/);
  assert.match(html, /<button type="button" class="ob-go" data-commit="email" data-field="1" data-ready="false" disabled>Continue with email<\/button>/);
  // The phone field starts at +91, and has its own button.
  assert.match(html, /class="ob-dial" data-dial="1" value="\+91"/);
  assert.match(html, /data-commit="phone"[^>]*>Continue with phone number</);
  // The consent line's two links are still links.
  assert.match(html, /Terms/);
  assert.match(html, /Privacy Policy/);
  // The phone is the backend's switch, and it is off.
  p.run("BOOT = { flags: { 'auth.enablePhone': false } }; AUTH.phoneOn = false");
  const off = p.run("handlers = []; node(__a)");
  assert.doesNotMatch(off, /data-commit="phone"|ob-dial/);
  assert.match(off, /data-commit="email"/);
});

test("the field's button lights up when the address is good, and is dim while a code is on its way", () => {
  const p = page();
  p.ctx.__n = { type: "SwipePill", props: { method: "email", variant: "field", submitLabel: "Go", placeholder: "Email" } };
  const btn = () => /<button[^>]*data-commit="email"[^>]*>/.exec(p.run("node(__n)"))[0];
  assert.match(btn(), /data-ready="false" disabled/);
  p.run("AUTH.email = 'me@x.org'");
  assert.match(btn(), /data-ready="true">/);
  assert.doesNotMatch(btn(), /disabled/);
  p.run("AUTH.phase = 'sending'");
  assert.match(btn(), /disabled aria-busy="true"/);
  // The number's country starts where the server says, once: the person's own edit is not undone.
  p.ctx.__n = { type: "SwipePill", props: { method: "phone", variant: "field", dial: "+91" } };
  p.run("AUTH.phoneOn = true; AUTH.phase = 'entry'");
  assert.match(p.run("node(__n)"), /class="ob-dial" data-dial="1" value="\+91"/);
  p.run("AUTH.dial = '+44'");
  assert.match(p.run("node(__n)"), /value="\+44"/);
});

test("the code in boxes: one for each digit, the one to fill next, the words, and the two ways out", () => {
  const p = page();
  p.ctx.__a = AUTH_FIXTURE;
  p.run("STATE.step = 1; AUTH.phase = 'verify'; AUTH.method = 'email'; AUTH.sentTo = 'a<b>@x.org'; AUTH.code = '123'");
  const html = p.run("handlers = []; node(__a)");
  const cells = [...html.matchAll(/<div class="ob-box([^"]*)">([^<]*)<\/div>/g)].map((m) => [m[1], m[2]]);
  assert.deepStrictEqual(cells, [[" f", "1"], [" f", "2"], [" f", "3"], [" cur", ""], ["", ""], ["", ""]]);
  // {len} and {to} are the flow's; the address is escaped and bold.
  assert.match(html, /I sent a 6-digit code to <b>a&lt;b&gt;@x\.org<\/b>\./);
  assert.match(html, /<span class="ob-st">Type it here when it comes\.<\/span>/);
  assert.match(html, /data-resend="1"[^>]*>.*Send it again/);
  assert.match(html, /Wrong email\?<\/span> <button type="button" class="ob-link" data-back="1">Change it/);
  assert.match(html, /<input data-code="1" inputmode="numeric" autocomplete="one-time-code" maxlength="6"/);
  // Complete, it says it is checking; a phone number says "number".
  p.run("AUTH.code = '123456'; AUTH.method = 'phone'");
  const done = p.run("handlers = []; node(__a)");
  assert.match(done, /<span class="ob-st">Got it\. Checking it now…<\/span>/);
  assert.match(done, /Wrong number\?/);
  assert.doesNotMatch(done, /class="ob-ck" hidden/);
  // A send that failed says so on the step, and the link is the way to try again.
  p.run("AUTH.code = ''; AUTH.sendFailed = true");
  assert.match(p.run("handlers = []; node(__a)"), /I couldn’t send the code\. Tap Send it again\./);
  // While it is being sent again, the link waits.
  p.run("AUTH.sendFailed = false; AUTH.resending = true");
  assert.match(p.run("handlers = []; node(__a)"), /data-resend="1" disabled/);
  // A wrong code shakes the boxes.
  p.run("AUTH.resending = false; AUTH.codeError = true");
  assert.match(p.run("handlers = []; node(__a)"), /class="ob-boxes tz-shake"/);
});

test("the old sign-in is drawn as it always was when the nodes carry none of the new props", () => {
  const p = page();
  p.run("AUTH.phoneOn = true; AUTH.phase = 'verify'; AUTH.code = '12'");
  p.ctx.__n = { type: "CodeEntry", props: {} };
  assert.match(p.run("node(__n)"), /data-codebox="1" style=";height:56px;border-radius:28px;cursor:text/);
  p.ctx.__n = { type: "SwipePill", props: { method: "email" } };
  p.run("AUTH.phase = 'entry'");
  assert.match(p.run("node(__n)"), /class="tz-disc" data-commit="email"/);
  p.ctx.__n = { type: "GoogleSignIn", props: { size: 52 } };
  assert.match(p.run("node(__n)"), /^<button class="tz-social tz-press" data-oauth="google" aria-label="Continue with Google" style=";width:52px;height:52px">/);
});

test("Send it again goes to the address the code went to, once, and the step stays the step", async () => {
  const requests = [];
  let release;
  const fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    await new Promise((r) => { release = r; });
    return json({});
  };
  const { p } = gatePage({ fetch });
  p.run("AUTH.phase = 'verify'; AUTH.method = 'email'; AUTH.sentTo = 'me@x.org'; AUTH.code = '12'");
  const first = p.run("resendCode()");
  // A second press while the first is in flight is the same press.
  const second = p.run("resendCode()");
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(requests.length, 1);
  assert.deepStrictEqual(requests[0], { url: "https://merzyohecmyfvlyahxaz.supabase.co/auth/v1/otp", body: { email: "me@x.org", create_user: true } });
  assert.strictEqual(p.run("AUTH.resending"), true);
  release();
  await Promise.all([first, second]);
  assert.strictEqual(p.run("AUTH.phase"), "verify", "the same step, asked a second time");
  assert.strictEqual(p.run("AUTH.resending"), false);
  assert.strictEqual(p.run("AUTH.code"), "", "the old code is spent");
  assert.strictEqual(p.run("AUTH.sendFailed"), false);
  // A number goes the way a number goes.
  p.run("AUTH.method = 'phone'; AUTH.sentTo = '+919876543210'");
  const again = p.run("resendCode()");
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(requests[1].body, { phone: "+919876543210", create_user: true });
  release(); await again;
  // Not on the code step, or with nowhere it went: nothing to send again.
  p.run("AUTH.phase = 'entry'");
  await p.run("resendCode()");
  p.run("AUTH.phase = 'verify'; AUTH.sentTo = ''");
  await p.run("resendCode()");
  assert.strictEqual(requests.length, 2);
});

test("a code that could not be sent again is said on the step", async () => {
  const { p } = gatePage({ fetch: async () => json({ msg: "boom" }, 500) });
  p.run("AUTH.phase = 'verify'; AUTH.method = 'email'; AUTH.sentTo = 'me@x.org'");
  await p.run("resendCode()");
  assert.strictEqual(p.run("AUTH.sendFailed"), true);
  assert.strictEqual(p.run("AUTH.phase"), "verify");
  assert.strictEqual(p.run("AUTH.resending"), false);
});

test("Change it, like Escape, goes back from the code to the address", () => {
  const { p } = gatePage();
  p.run("AUTH.phase = 'verify'; AUTH.code = '123'; AUTH.codeError = true; AUTH.sendFailed = true; AUTH.error = 'x'");
  p.run("gateBack()");
  assert.deepStrictEqual([...p.run("[AUTH.phase, AUTH.code, AUTH.codeError, AUTH.sendFailed, AUTH.error]")], ["entry", "", false, false, ""]);
  // On any other step it does nothing.
  p.run("AUTH.phase = 'sending'");
  p.run("gateBack()");
  assert.strictEqual(p.run("AUTH.phase"), "sending");
});

test("a state change while the sign-in stage is up repaints the gate, not a screen that is not there", async () => {
  const { p, gateForm } = gatePage();
  p.run("paintGate()");
  assert.strictEqual(attr(gateForm.innerHTML, "data-step"), "0");
  assert.match(gateForm.innerHTML, /Hi, I’m Tailzu\./);
  // Welcome's button: a haptic, then the stage's step.
  await p.run("run({ kind: 'sequence', actions: [{ kind: 'haptic', style: 'selection' }, { kind: 'setState', path: 'step', value: 1 }] })");
  assert.strictEqual(attr(gateForm.innerHTML, "data-step"), "1");
  assert.match(gateForm.innerHTML, /Let’s get you in\./);
  // The gate goes (signed in): the same change is no longer the gate's.
  p.run("document.getElementById('gate').hidden = true");
  assert.strictEqual(p.run("gateUp()"), false);
});

test("the window opens on the onboarding when the server says so, and on a tab otherwise", () => {
  const p = page();
  const tabs = [{ id: "desk_today", screenId: "desk_today" }, { id: "desk_words", screenId: "desk_words" }];
  p.ctx.__t = tabs;
  const at = (id) => { p.ctx.__b = { initialScreenId: id }; return p.run("landingFor(__b, __t)"); };
  assert.deepStrictEqual({ ...at("onboard") }, { tabId: "", screenId: "onboard", onboard: true });
  assert.deepStrictEqual({ ...at("desk_words") }, { tabId: "desk_words", screenId: "desk_words", onboard: false });
  // Not one of ours (an older backend's onboarding_keyboard): the first tab, as before.
  assert.deepStrictEqual({ ...at("onboarding_keyboard") }, { tabId: "desk_today", screenId: "desk_today", onboard: false });
  p.ctx.__t = [];
  assert.deepStrictEqual({ ...at("home") }, { tabId: "", screenId: "home", onboard: false });
});

test("the onboarding saves as it goes without fetching its own screen again", async () => {
  const requests = [];
  const p = page({ baseUrl: "https://api.test" }, { fetch: async (url, init) => { requests.push(init.method + " " + url.replace("https://api.test", "")); return json({}); } });
  p.run("STATE = { langs: ['hi'] }; STACK = [{ screenId: 'onboard' }]; CURRENT_SCREEN = { screenId: 'onboard', root: { type: 'OnboardStage' } }");
  const save = { kind: "callEndpoint", method: "PUT", path: "/v1/personality", body: { languages: "$state.langs" } };
  p.ctx.__a = save;
  await p.run("run(__a)");
  assert.deepStrictEqual(requests, ["PUT /v1/personality"], "no refetch under a half-finished step");
  // Another screen asks the server again after a write, as it always has.
  p.run("CURRENT_SCREEN = { screenId: 'x', root: { type: 'Screen' } }");
  const before = p.run("paint._seq || 0");
  await p.run("run(__a)");
  assert.ok(p.run("paint._seq || 0") > before, "any other screen is redrawn after a write");
});

// ---- the held mic ----------------------------------------------------------------------

/** A page with a microphone that can be held: a recorder that is a recorder, and a way to say when the device opened. */
function micPage(document) {
  const recs = [], seen = [], listeners = {};
  let open;
  class FakeRecorder {
    static isTypeSupported() { return true; }
    constructor(stream, o) { this.mimeType = (o && o.mimeType) || "audio/webm"; this.state = "inactive"; this.stopped = 0; recs.push(this); }
    start() { this.state = "recording"; }
    stop() { this.stopped++; this.state = "inactive"; setImmediate(() => { this.ondataavailable({ data: new Blob(["x"]) }); this.onstop(); }); }
  }
  const stream = { getTracks: () => [{ stop() {} }] };
  let p;
  const fetch = async () => { seen.push(p.run("stateAt('mic')")); return json({ cleanedText: " Haan bhai, 5 min mein aa raha hoon. " }); };
  p = page({ baseUrl: "https://api.test" }, {
    fetch, document,
    globals: {
      navigator: { language: "en-US", mediaDevices: { getUserMedia: () => new Promise((r) => { open = () => r(stream); }) } },
      MediaRecorder: FakeRecorder, FormData, Blob,
      addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
      removeEventListener: (t, f) => { listeners[t] = (listeners[t] || []).filter((x) => x !== f); },
    },
  });
  p.run("STATE = { mic: 'idle', tried: '' }");
  const node = { type: "VoiceButton", bind: { value: "tried", state: "mic" }, props: { hold: true }, on: { onError: { kind: "setState", path: "failed", value: "yes" } } };
  p.ctx.__sc = { root: node };
  const el = { handlers: {}, getAttribute: () => "tried", addEventListener(t, f) { this.handlers[t] = f; } };
  p.ctx.__el = el;
  p.run("wireHold(__el, __sc)");
  const settle = () => new Promise((r) => setTimeout(r, 15));
  const fire = (t) => (listeners[t] || []).slice().forEach((f) => f());
  return { p, recs, seen, el, open: () => open(), settle, fire, listeners };
}

test("a held mic says what it is doing, and what it heard lands where it was told", async () => {
  const m = micPage();
  m.el.handlers.pointerdown({ button: 0, preventDefault() {} });
  m.open(); await m.settle();
  assert.strictEqual(m.p.run("stateAt('mic')"), "recording");
  assert.strictEqual(m.recs[0].state, "recording");
  // Let go: the take is stopped, turned into text, and the mic is idle again with the words in place.
  m.fire("pointerup"); await m.settle();
  assert.strictEqual(m.recs[0].stopped, 1);
  assert.deepStrictEqual(m.seen, ["busy"], "while the words were being made");
  assert.strictEqual(m.p.run("stateAt('mic')"), "idle");
  assert.strictEqual(m.p.run("stateAt('tried')"), "Haan bhai, 5 min mein aa raha hoon.");
  assert.strictEqual(m.p.run("HELD"), false);
  // The listeners for the release are gone with it.
  assert.deepStrictEqual(["pointerup", "pointercancel", "keyup", "blur"].map((t) => (m.listeners[t] || []).length), [0, 0, 0, 0]);
});

test("letting go while the device is still opening stops the take the moment it starts", async () => {
  const m = micPage();
  m.el.handlers.pointerdown({ button: 0, preventDefault() {} });
  await m.settle();
  m.fire("pointerup");                 // the permission prompt, or the device, is still opening
  assert.strictEqual(m.recs.length, 0);
  m.open(); await m.settle();
  assert.strictEqual(m.recs.length, 1);
  assert.strictEqual(m.recs[0].stopped, 1, "not left running behind a hand that has gone");
  assert.strictEqual(m.p.run("stateAt('mic')"), "idle");
});

test("only one hold at a time, and losing the window is a let-go too", async () => {
  const m = micPage();
  m.el.handlers.pointerdown({ button: 0, preventDefault() {} });
  m.el.handlers.pointerdown({ button: 0, preventDefault() {} });
  m.open(); await m.settle();
  assert.strictEqual(m.recs.length, 1);
  m.fire("blur"); await m.settle();
  assert.strictEqual(m.recs[0].stopped, 1);
  // A right click does not start it.
  m.el.handlers.pointerdown({ button: 2, preventDefault() {} });
  assert.strictEqual(m.recs.length, 1);
});

test("a mic that cannot be opened is the node's own error, and says blocked when it is blocked", async () => {
  const toast = { textContent: "", classList: { add() {}, remove() {} } };
  const m = micPage({ ...NOOP_DOM, getElementById: (id) => (id === "toast" ? toast : null) });
  m.p.ctx.navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error("no"), { name: "NotFoundError" }));
  m.el.handlers.pointerdown({ button: 0, preventDefault() {} });
  await m.settle();
  assert.strictEqual(m.p.run("stateAt('failed')"), "yes", "the node's onError ran");
  assert.strictEqual(m.p.run("stateAt('mic')"), "idle");
  assert.strictEqual(m.p.run("HELD"), false);
  // Blocked by the system: not "I couldn't hear that".
  m.p.ctx.navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error("no"), { name: "NotAllowedError" }));
  m.p.run("setStatePath('failed', 'no')");
  m.el.handlers.pointerdown({ button: 0, preventDefault() {} });
  await m.settle();
  assert.strictEqual(m.p.run("stateAt('failed')"), "no", "its own words, not the node's");
  assert.match(toast.textContent, /microphone blocked/);
});

test("the held mic is a disc of the node's size with its own glyph, and says whether it is pressed", () => {
  const p = page();
  p.ctx.__n = { type: "VoiceButton", bind: { value: "tried", state: "mic" }, props: { hold: true, size: 88, radius: 44, background: "#1C1A17", label: "" }, style: { width: 88, height: 88 }, children: [{ type: "SVG" }] };
  const html = p.run("node(__n)");
  assert.match(html, /data-mic="tried" data-hold="1" aria-pressed="false" aria-label="Hold to speak"/);
  assert.match(html, /width:88px;height:88px;border-radius:44px/);
  assert.match(html, /background:#1C1A17/);
  assert.strictEqual((html.match(/<svg/g) || []).length, 1, "the window's own glyph, not the node's child");
  // A node without `hold` is the click-to-start button it always was.
  p.ctx.__n = { type: "VoiceButton", bind: { value: "x" }, props: {} };
  assert.doesNotMatch(p.run("node(__n)"), /data-hold/);
});

// ---- the folders row under Ask (sdui.js DeskFolders) --------------------------------

const FOLDER_PROPS = {
  title: "Folders Ask can use", lede: "Only inside these.", usual: "The usual three", add: "Add a folder", remove: "Remove",
  reset: "Back to the usual three", none: "No folders yet.", refused: "Ask can't use that folder.", foot: "How Ask uses your files:",
  policyLabel: "Privacy policy", policyUrl: "https://tailzu.space/privacy",
};
const USUAL = { custom: false, error: "", folders: [{ label: "Downloads", path: "~/Downloads" }, { label: "Desktop", path: "~/Desktop" }, { label: "Documents", path: "~/Documents" }] };
const folderRow = (p) => { p.ctx.__n = { type: "DeskFolders", props: FOLDER_PROPS }; return p.run("node(__n)"); };

test("the window declares DeskFolders with the setup card, and its three actions", () => {
  const on = page({ askSetup: true });
  assert.ok(on.run("capabilities().components").includes("DeskFolders"));
  for (const a of ["ask.folderAdd", "ask.folderRemove", "ask.folderReset"]) assert.ok(on.run("capabilities().actions").includes(a), a);
  assert.ok(!page({ askSetup: false }).run("capabilities().components").includes("DeskFolders"));
});

test("the folders row draws nothing until the main process answers, then each folder with its remove button", () => {
  const p = page();
  assert.strictEqual(folderRow(p), "");
  p.ctx.__st = USUAL;
  p.run("foldersTook(__st)");
  const html = folderRow(p);
  assert.match(html, /Folders Ask can use/);
  for (const f of ["Downloads", "Desktop", "Documents", "~/Downloads"]) assert.ok(html.includes(f), f);
  assert.strictEqual((html.match(/Remove/g) || []).length, 3 * 2 /* the label and the aria-label */);
  assert.match(html, /Add a folder/);
  assert.doesNotMatch(html, /Back to the usual three<\/button>/, "nothing to go back to while it is the usual three");
  assert.match(html, /href|d-ask-link/);
});

test("once the list is the person's own it can go back, an unsafe add says why, and the names are escaped", () => {
  const p = page();
  p.ctx.__st = { custom: true, error: "That's a system folder.", folders: [{ label: "<img src=x onerror=1>", path: "~/x" }] };
  p.run("foldersTook(__st)");
  const html = folderRow(p);
  assert.match(html, /Back to the usual three<\/button>/);
  assert.match(html, /Ask can.{1,6}t use that folder\. That.{1,6}s a system folder\./);
  assert.ok(!html.includes("<img src=x"), "a folder's name is text");
  p.ctx.__st = { custom: true, error: "", folders: [] };
  p.run("foldersTook(__st)");
  assert.match(folderRow(p), /No folders yet\./);
});

test("the buttons reach foldersAction with the fixed kinds and the row's place", async () => {
  const p = page();
  for (const a of [{ kind: "ask.folderAdd" }, { kind: "ask.folderRemove", i: 2 }, { kind: "ask.folderReset" }, { kind: "ask.folderRemove", i: "x" }]) {
    p.ctx.__a = a; await p.run("run(__a)");
  }
  assert.deepStrictEqual(p.calls, [{ folders: "add", i: -1 }, { folders: "remove", i: 2 }, { folders: "reset", i: -1 }, { folders: "remove", i: -1 }]);
});

test("a window with an older main process, with no folders bridge, does not break", () => {
  const p = page({ askSetup: true });
  p.run("delete window.tailzuApp.folders; delete window.tailzuApp.onFolders");
  assert.doesNotThrow(() => p.run("foldersWatch()"));
});

// ---- the Bots app's microphone card: the system's answer, and its prompt --------------------

/** A page whose main process reads the microphone (micStatus) and whose window can open one (getUserMedia). */
function micAskPage(status, getUserMedia) {
  const p = page({ askSetup: false }, { globals: { navigator: { language: "en-US", mediaDevices: { getUserMedia } } } });
  p.g.tailzuApp.micStatus = async () => status.value;
  p.run("globalThis.__repaints = 0; repaint = () => { globalThis.__repaints++; }");
  return p;
}
const MIC_ACTION = {
  kind: "requestPermission", permission: "microphone",
  onGranted: { kind: "setState", path: "flag", value: "granted" },
  onDenied: { kind: "setState", path: "flag", value: "denied" },
  onBlocked: { kind: "setState", path: "flag", value: "blocked" },
};
const stream = () => ({ getTracks: () => [{ stop() { stream.stopped = (stream.stopped || 0) + 1; } }] });

test("the window declares DeskMicAsk and requestPermission only with a main process that reads the microphone", () => {
  const on = micAskPage({ value: "granted" }, async () => stream());
  assert.ok(on.run("capabilities().components").includes("DeskMicAsk"));
  assert.ok(on.run("capabilities().actions").includes("requestPermission"));
  const old = page({ askSetup: false });
  assert.ok(!old.run("capabilities().components").includes("DeskMicAsk"));
});

test("asking opens the microphone once (the system's prompt) and closes it, then runs the page's answer", async () => {
  const status = { value: "granted" };
  stream.stopped = 0;
  const p = micAskPage(status, async () => stream());
  p.ctx.__a = MIC_ACTION;
  await p.run("run(__a)");
  assert.strictEqual(p.run("stateAt('flag')"), "granted");
  assert.strictEqual(stream.stopped, 1);
  // Refused at the system's switch: blocked (its settings are the only way back); no microphone at all: denied.
  const blocked = micAskPage(status, async () => { throw Object.assign(new Error("no"), { name: "NotAllowedError" }); });
  blocked.ctx.__a = MIC_ACTION;
  await blocked.run("run(__a)");
  assert.strictEqual(blocked.run("stateAt('flag')"), "blocked");
  const none = micAskPage(status, async () => { throw Object.assign(new Error("none"), { name: "NotFoundError" }); });
  none.ctx.__a = MIC_ACTION;
  await none.run("run(__a)");
  assert.strictEqual(none.run("stateAt('flag')"), "denied");
  // Anything but the microphone is not this window's to ask for.
  const cam = micAskPage(status, async () => stream());
  cam.ctx.__a = Object.assign({}, MIC_ACTION, { permission: "camera" });
  await cam.run("run(__a)");
  assert.strictEqual(cam.run("stateAt('flag')"), "denied");
});

test("a page that asks after the microphone gets the system's answer in $state.micGranted, and only such a page", async () => {
  const status = { value: "denied" };
  const p = micAskPage(status, async () => stream());
  const settle = () => new Promise((r) => setTimeout(r, 0));
  p.run("CURRENT_SCREEN = { state: { micGranted: true }, root: { type: 'Stack' } }; STATE = { micGranted: true }");
  p.run("micFollow()");
  await settle();
  assert.strictEqual(p.run("STATE.micGranted"), false);
  assert.strictEqual(p.run("__repaints"), 1);
  // Allowed in System Settings, then back to the window: read again, and the card goes.
  status.value = "granted";
  p.run("micFollow()");
  await settle();
  assert.strictEqual(p.run("STATE.micGranted"), true);
  // A system with no such switch is nothing to ask for.
  status.value = "unknown";
  p.run("micFollow()");
  await settle();
  assert.strictEqual(p.run("STATE.micGranted"), true);
  assert.strictEqual(p.run("__repaints"), 2);
  // A page that does not ask is left alone.
  p.run("CURRENT_SCREEN = { state: {}, root: { type: 'Stack' } }; STATE = {}");
  status.value = "denied";
  p.run("micFollow()");
  await settle();
  assert.strictEqual(p.run("STATE.micGranted"), undefined);
});
