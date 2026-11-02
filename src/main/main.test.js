// node --test
//
// main.js run whole with Electron faked (testkit.js): what plain dictation
// records, sends and pastes, and how the peek and Ask's setup card are wired.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { mainProcess, NOTES } = require("./testkit.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 2000) {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error("timed out waiting"); await sleep(5); }
}

const PRIVATE = Object.assign({}, NOTES, { label: "Chrome: New Incognito Tab", private: true });

/** The same four dictations, every time: one with a pause's chunk and its
 *  end; one thrown away with the pill's ✕; one the recorder fails; one into
 *  a private window. */
async function dictateFour(m) {
  await m.ready();
  const steps = async (n) => { await until(() => m.dictation.filter(([w, ch]) => ch === "recording-around" || ch === "recording-field").length >= n, 3000); };
  // 1: a chunk on a pause, then the end.
  m.hotkey();
  await steps(2);
  const s1 = m.sessions()[0];
  await sleep(40);
  m.fromRecorder("dictation-level", { session: s1, bands: [0.2, 0.6, 0.4] });
  m.fromRecorder("dictation-segment", { session: s1, text: "I'll be there at six.", join: true });
  await until(() => m.dictation.filter(([k]) => k === "keystroke").length === 1);
  await sleep(40);
  m.hotkey();
  m.fromRecorder("dictation-result", { session: s1, text: "See you Friday.", join: true });
  await until(() => m.dictation.filter(([k]) => k === "keystroke").length === 2);
  await sleep(80);
  // 2: thrown away from the pill.
  m.hotkey();
  await steps(4);
  await sleep(40);
  m.fromPill("pill:action", "cancel");
  await sleep(40);
  // 3: the recorder fails.
  m.hotkey();
  await steps(6);
  const s3 = m.sessions()[2];
  await sleep(40);
  m.fromRecorder("dictation-error", { session: s3, message: "no speech detected — check your microphone" });
  await sleep(40);
  // 4: a private window, written.
  m.hotkey();
  await until(() => m.dictation.filter(([w, ch]) => ch === "recording-target").length === 4, 3000);
  const s4 = m.sessions()[3];
  await sleep(40);
  m.hotkey();
  m.fromRecorder("dictation-result", { session: s4, text: "Private words.", join: false });
  await until(() => m.dictation.filter(([k]) => k === "keystroke").length === 3);
  await sleep(80);
  return m.dictation;
}

const PEEK_FAST = { "desktop.dictation.peekEveryMs": 100, "desktop.dictation.peekDoneMs": 30, "desktop.dictation.peekBudgetMs": 50 };
const FOUR = [NOTES, NOTES, NOTES, PRIVATE];

test("main: plain dictation records, sends and pastes byte-for-byte the same with the peek off, on, and failing every way it can", async () => {
  // The recorder is handed the server's knobs as they came (start-recording's
  // `knobs`), so the switch each run was given rides along in them: that one
  // input is set aside, and everything else must be identical.
  const asSent = (what) => what.map((e) => {
    const p = e[2] && e[2].knobs && e[2].knobs.flags;
    if (p) delete p["desktop.dictation.peek"];
    return e;
  });
  const run = async (o) => {
    const m = mainProcess(Object.assign({ infos: FOUR }, o, { flags: Object.assign({}, PEEK_FAST, o.flags) }));
    try { return { what: asSent(await dictateFour(m)), m }; } finally { m.close(); }
  };
  const off = await run({ flags: { "desktop.dictation.peek": false } });
  // What plain dictation did, for the record: four starts, the app and the
  // field and the screen around it for each, the chunk and the end pasted.
  const kinds = off.what.map(([k, ch]) => (k === "recorder" ? ch : k));
  assert.deepStrictEqual(kinds.filter((k) => k === "start-recording").length, 4);
  assert.deepStrictEqual(off.what.filter(([k]) => k === "clipboard").map(([, t]) => t), [" I'll be there at six.", " See you Friday.", "Private words."]);
  assert.deepStrictEqual(off.m.carets, [], "off: the helper is never asked");
  assert.deepStrictEqual(off.m.guide, []);

  const on = await run({ flags: { "desktop.dictation.peek": true } });
  assert.deepStrictEqual(on.what, off.what, "the peek on: exactly the same, in the same order");
  // And it really was on: Blip peeked, followed the chunk, wrote, hopped and
  // went; went at once on the ✕ and on the failure; and never looked at the
  // private window.
  const states = on.m.guide.filter((g) => g.type === "peek" || g.type === "unpeek").map((g) => g.type === "peek" ? g.state : "away");
  assert.ok(states.includes("listening") && states.includes("writing") && states.includes("done") && states.includes("away"), states.join(","));
  assert.strictEqual(states.filter((s) => s === "away").length, 3, "away after the first, at the ✕ and at the failure: " + states.join(","));
  assert.ok(on.m.guide.some((g) => g.type === "peekLevel" && Math.abs(g.v - 0.4) < 1e-9), "the voice's level, as the bands' mean");
  const during = on.m.carets.map((c) => c.during);
  assert.ok([1, 2, 3].every((n) => during.includes(n)), "asked during each of the first three: " + during);
  assert.ok(!during.includes(4), "never during the private window's: " + during);
  assert.ok(on.m.carets.every((c) => c.budgetMs === 50), "within its budget (desktop.dictation.peekBudgetMs)");

  const failing = [
    ["the helper throws", () => { throw new Error("exploded"); }],
    ["the helper fails", () => Promise.reject(new Error("pipe"))],
    ["the helper never answers", () => new Promise(() => {})],
    ["the helper is not running", () => Promise.resolve({ ok: false, error: "unavailable" })],
    ["the helper talks nonsense", () => Promise.resolve({ ok: true, caret: "x", field: [NaN], app: 7 })],
    ["another app in front", () => Promise.resolve(answer({ app: { name: "Safari", pid: 9 } }))],
  ];
  for (const [why, caret] of failing) {
    const r = await run({ caret });
    assert.deepStrictEqual(r.what, off.what, why);
    assert.ok(!r.m.guide.some((g) => g.type === "peek"), why + ": no peek");
  }
});

test("main: the setup card's wiring: the env says so, only the app window asks or acts, and it is told on focus, after each action and at sign-out", async () => {
  const m = mainProcess();
  try {
    await m.ready();
    const appWin = m.win("src/app/app.html");
    const appWc = appWin.webContents, other = m.win("src/dictation/pill/pill.html").webContents;
    assert.strictEqual(m.invoke("app:env", appWc).askSetup, true, "Ask is on: the window declares DeskAskSetup");
    const platform = process.platform === "darwin" ? "mac" : process.platform === "win32" ? "windows" : "linux";
    const want = (pictures) => (platform === "mac"
      ? { platform, read: "on", see: "on", pictures }
      : { platform, read: "na", see: "na", pictures });
    assert.deepStrictEqual(m.invoke("app:askSetup", appWc), want("off"));
    assert.strictEqual(m.invoke("app:askSetup", other), null);
    const told = () => (appWin.appSent || []).filter(([ch]) => ch === "ask-setup").map(([, s]) => s);
    // Another window's action: nothing.
    m.ipc.emit("app:askSetupAction", { sender: other }, { kind: "picturesAll", on: true });
    assert.deepStrictEqual(told(), []);
    // The app window's: saved on this computer, and the window told.
    m.ipc.emit("app:askSetupAction", { sender: appWc }, { kind: "picturesAll", on: true });
    assert.deepStrictEqual(told(), [want("on")]);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(m.dir, "desktop-state.json"), "utf8")).askPicturesAlwaysAll, true);
    // Back from System Settings: the window is told again.
    appWin.emit("focus");
    assert.deepStrictEqual(told(), [want("on"), want("on")]);
    // Signed out: the yes was theirs, and goes with them.
    await m.invoke("app:setSession", appWc, null);
    assert.deepStrictEqual(told().pop(), want("off"));
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(m.dir, "desktop-state.json"), "utf8")).askPicturesAlwaysAll, false);
  } finally { m.close(); }
  const off = mainProcess({ flags: { "desktop.agent.enabled": false } });
  try {
    await off.ready();
    assert.strictEqual(off.invoke("app:env", off.win("src/app/app.html").webContents).askSetup, false, "Ask off: no card");
  } finally { off.close(); }
});

test("main: the tray's \"Ask again for all of them\" takes back the setup card's yes for every app too, and the card is told", async () => {
  const m = mainProcess();
  try {
    await m.ready();
    const appWin = m.win("src/app/app.html");
    const appWc = appWin.webContents;
    const told = () => (appWin.appSent || []).filter(([ch]) => ch === "ask-setup").map(([, s]) => s.pictures);
    const pictures = () => m.tray().find((i) => i && i.label === "Pictures sent without asking");
    const saved = () => JSON.parse(fs.readFileSync(path.join(m.dir, "desktop-state.json"), "utf8")).askPicturesAlwaysAll;
    assert.strictEqual(pictures(), undefined, "nothing goes without asking: no list");
    // Yes for every app, from the setup card: the tray lists it at once.
    m.ipc.emit("app:askSetupAction", { sender: appWc }, { kind: "picturesAll", on: true });
    const menu = pictures();
    assert.ok(menu, "the tray says something goes without asking");
    const all = menu.submenu.find((i) => i.label === "Ask again for all of them");
    assert.ok(all);
    // Taken back from the tray: the card asks again everywhere, and the
    // setup card turns to off.
    all.click();
    assert.strictEqual(saved(), false);
    assert.deepStrictEqual(told(), ["on", "off"]);
    assert.strictEqual(pictures(), undefined);
    assert.strictEqual(m.invoke("app:askSetup", appWc).pictures, "off");
  } finally { m.close(); }
});

test("preload: the app window's bridge carries the setup card's three calls, by the names fixed between the builders", async () => {
  const exposed = {}, sent = [], invoked = [], listeners = {};
  const electron = {
    contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v; } },
    ipcRenderer: {
      send: (ch, p) => sent.push([ch, p]),
      invoke: (ch, ...a) => { invoked.push([ch, ...a]); return Promise.resolve({ platform: "mac", read: "on", see: "off", pictures: "off" }); },
      on: (ch, f) => { listeners[ch] = f; },
    },
  };
  const src = fs.readFileSync(path.join(__dirname, "preload.js"), "utf8");
  new Function("require", src)((id) => (id === "electron" ? electron : require(id)));
  const t = exposed.tailzuApp;
  assert.deepStrictEqual(await t.askSetup(), { platform: "mac", read: "on", see: "off", pictures: "off" });
  assert.deepStrictEqual(invoked, [["app:askSetup"]]);
  const got = [];
  t.onAskSetup((s) => got.push(s));
  listeners["ask-setup"]({}, { pictures: "on" });
  assert.deepStrictEqual(got, [{ pictures: "on" }]);
  t.askSetupAction("picturesAll", true);
  t.askSetupAction("picturesAll", false);
  t.askSetupAction("relaunch");
  t.askSetupAction("openAccessibility", "yes");
  t.askSetupAction();
  assert.deepStrictEqual(sent, [
    ["app:askSetupAction", { kind: "picturesAll", on: true }],
    ["app:askSetupAction", { kind: "picturesAll", on: false }],
    ["app:askSetupAction", { kind: "relaunch", on: null }],
    ["app:askSetupAction", { kind: "openAccessibility", on: null }],
    ["app:askSetupAction", { kind: "", on: null }],
  ]);
  // The other windows' bridges have none of it.
  for (const k of ["tailzu", "tailzuGuide", "tailzuNotes"]) assert.ok(!("askSetup" in exposed[k]) && !("askSetupAction" in exposed[k]), k);
});
