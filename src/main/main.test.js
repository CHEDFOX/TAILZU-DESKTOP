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
  // Private windows off (desktop.agent.privateWindows): the fourth is not
  // read or peeked at, as before they could be.
  const run = async (o) => {
    const m = mainProcess(Object.assign({ infos: FOUR }, o, { flags: Object.assign({ "desktop.agent.privateWindows": false }, PEEK_FAST, o.flags) }));
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

test("main: dictation in a private window is read and peeked at like any other, and the recorder is told it was one", async () => {
  const m = mainProcess({ infos: FOUR, flags: Object.assign({}, PEEK_FAST, { "desktop.dictation.peek": true }) });
  try {
    await dictateFour(m);
    const targets = m.dictation.filter(([w, ch]) => w === "recorder" && ch === "recording-target").map(([, , p]) => p);
    assert.strictEqual(targets.length, 4);
    assert.deepStrictEqual(targets.slice(0, 3).map((p) => [p.privateField, p.privateWindow]), [[false, false], [false, false], [false, false]]);
    assert.deepStrictEqual([targets[3].privateField, targets[3].privateWindow], [false, true], "not off limits, but marked a private window's");
    const s4 = m.sessions()[3];
    const field = m.dictation.find(([w, ch, p]) => w === "recorder" && ch === "recording-field" && p.session === s4);
    assert.ok(field && field[2].field && field[2].field.kind === "message", "its field is read");
    assert.ok(m.carets.some((c) => c.during === 4), "and Blip peeks at it");
  } finally { m.close(); }
});

test("main: the setup card's wiring: the env says so, pictures are on by default, only the app window asks or acts, and it is told on focus, after each action and at sign-out", async () => {
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
    // Nothing kept yet: pictures for every app are on (the default).
    assert.deepStrictEqual(m.invoke("app:askSetup", appWc), want("on"));
    assert.strictEqual(m.invoke("app:askSetup", other), null);
    const told = () => (appWin.appSent || []).filter(([ch]) => ch === "ask-setup").map(([, s]) => s);
    const saved = () => JSON.parse(fs.readFileSync(path.join(m.dir, "desktop-state.json"), "utf8"));
    // Another window's action: nothing.
    m.ipc.emit("app:askSetupAction", { sender: other }, { kind: "picturesAll", on: false });
    assert.deepStrictEqual(told(), []);
    // The app window's: saved on this computer, and the window told.
    m.ipc.emit("app:askSetupAction", { sender: appWc }, { kind: "picturesAll", on: false });
    assert.deepStrictEqual(told(), [want("off")]);
    assert.strictEqual(saved().askPicturesAlwaysAll, false);
    // Back from System Settings: the window is told again.
    appWin.emit("focus");
    assert.deepStrictEqual(told(), [want("off"), want("off")]);
    // Signed out: the off was theirs. The next person gets the default (on): the key is gone, not kept false.
    await m.invoke("app:setSession", appWc, null);
    assert.deepStrictEqual(told().pop(), want("on"));
    assert.ok(!("askPicturesAlwaysAll" in saved()), "back to the default");
    assert.deepStrictEqual(saved().askPicturesAlways, [], "and the per-app list is emptied");
  } finally { m.close(); }
  const off = mainProcess({ flags: { "desktop.agent.enabled": false } });
  try {
    await off.ready();
    assert.strictEqual(off.invoke("app:env", off.win("src/app/app.html").webContents).askSetup, false, "Ask off: no card");
  } finally { off.close(); }
});

test("main: pictures for every app are on by default, and the tray's \"Ask again for all of them\" turns them off, and the card is told", async () => {
  const m = mainProcess();
  try {
    await m.ready();
    const appWin = m.win("src/app/app.html");
    const appWc = appWin.webContents;
    const told = () => (appWin.appSent || []).filter(([ch]) => ch === "ask-setup").map(([, s]) => s.pictures);
    const pictures = () => m.tray().find((i) => i && i.label === "Pictures sent without asking");
    const saved = () => JSON.parse(fs.readFileSync(path.join(m.dir, "desktop-state.json"), "utf8")).askPicturesAlwaysAll;
    // Nothing kept (absent is on): the tray says pictures go without asking, with the way to turn that off.
    assert.strictEqual(saved(), undefined);
    const menu = pictures();
    assert.ok(menu, "the tray says something goes without asking");
    const all = menu.submenu.find((i) => i.label === "Ask again for all of them");
    assert.ok(all);
    // Turned off from the tray: the card asks again everywhere, false is
    // kept, and the setup card turns to off.
    all.click();
    assert.strictEqual(saved(), false);
    assert.deepStrictEqual(told(), ["off"]);
    assert.strictEqual(pictures(), undefined);
    assert.strictEqual(m.invoke("app:askSetup", appWc).pictures, "off");
    // On again from the setup card: the tray lists it again.
    m.ipc.emit("app:askSetupAction", { sender: appWc }, { kind: "picturesAll", on: true });
    assert.deepStrictEqual(told(), ["off", "on"]);
    assert.ok(pictures());
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
  // The folders row and the runner's card are gone from the app window: no calls for them. The runner's own window keeps its own.
  for (const k of ["folders", "onFolders", "foldersAction", "runner", "onRunner", "runnerSet", "runnerProject", "runnerCheckDocker", "runnerStop", "runnerOpenAudit"]) {
    assert.ok(!(k in t), k);
  }
  for (const k of ["state", "set", "project", "checkDocker", "stop", "openAudit", "onUpdate"]) assert.strictEqual(typeof exposed.tailzuRunner[k], "function", k);
  // The bot on the screen listens (windowVoice.js): voice, talkTo, onVoice, with what each sends pinned.
  sent.length = 0;
  t.voice("start", { mode: "chat", silenceMs: 900 });
  t.voice("stop", { session: 3 });
  t.voice("again", { mode: "loud", session: "2" });
  t.voice();
  t.talkTo({ hold: true, chat: true, extra: 1 });
  t.talkTo({ hold: "yes" });
  t.talkTo(null);
  assert.deepStrictEqual(sent, [
    ["app:voice", { cmd: "start", mode: "chat", silenceMs: 900, session: 0 }],
    ["app:voice", { cmd: "stop", mode: "once", silenceMs: 0, session: 3 }],
    ["app:voice", { cmd: "again", mode: "once", silenceMs: 0, session: 2 }],
    ["app:voice", { cmd: "", mode: "once", silenceMs: 0, session: 0 }],
    ["app:talkTo", { hold: true, chat: true }],
    ["app:talkTo", { hold: false, chat: false }],
    ["app:talkTo", null],
  ]);
  const heard = [];
  t.onVoice((m) => heard.push(m));
  listeners["app:voice"]({}, { kind: "words", session: 1, text: "hi" });
  assert.deepStrictEqual(heard, [{ kind: "words", session: 1, text: "hi" }]);
  for (const k of ["tailzu", "tailzuGuide", "tailzuNotes"]) assert.ok(!("voice" in exposed[k]) && !("talkTo" in exposed[k]), k);
});

test("main: what older copies kept and nothing reads is dropped at launch: the folders Ask could use, and the runner's explained mark", async () => {
  const m = mainProcess({ state: { askFolders: ["/somewhere/Photos"], runner: { enabled: false, explained: true }, launchCount: 3 } });
  try {
    await m.ready();
    const saved = JSON.parse(fs.readFileSync(path.join(m.dir, "desktop-state.json"), "utf8"));
    assert.ok(!("askFolders" in saved), "no folder list stays on disk");
    assert.ok(!("explained" in saved.runner));
    assert.strictEqual(saved.launchCount, 4, "the rest is kept");
  } finally { m.close(); }
});

test("main: Xode on this computer is on by default, its tray item opens its own window, and only that window may ask anything of it", async () => {
  // An install that kept the old default (off) and never chose: turned on, once.
  const m = mainProcess({ state: { runner: { enabled: false } } });
  try {
    await m.ready();
    const use = m.tray().find((i) => i && i.label === "Use this computer for Xode");
    assert.ok(use && use.checked === true, "on by default");
    const saved = JSON.parse(fs.readFileSync(path.join(m.dir, "desktop-state.json"), "utf8"));
    assert.strictEqual(saved.runner.enabled, true);
    assert.strictEqual(saved.runner.defaultOnV1, true);
    // Turned off from the tray: at once, nothing asked, and kept.
    use.click({ checked: false });
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(m.dir, "desktop-state.json"), "utf8")).runner.enabled, false);
    assert.strictEqual(m.tray().find((i) => i && i.label === "Use this computer for Xode").checked, false);
    // "Xode activity…" opens the runner's own window, whatever the server sends.
    m.tray().find((i) => i && i.label === "Xode activity…").click();
    const runnerWin = m.win("src/runner/runner.html");
    assert.ok(runnerWin, "the runner's window");
    // The app window may not ask anything of the runner; its own window may.
    const appWc = m.win("src/app/app.html").webContents;
    assert.strictEqual(await m.invoke("runner:state", appWc), null);
    assert.strictEqual(await m.invoke("runner:set", appWc, "enabled", true), null);
    assert.strictEqual(await m.invoke("runner:project", appWc, "proj-1", "acme/app", "deny"), null);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(m.dir, "desktop-state.json"), "utf8")).runner.enabled, false, "the app window turned nothing on");
    const snap = await m.invoke("runner:set", runnerWin.webContents, "enabled", true);
    assert.strictEqual(snap.status.enabled, true);
    await m.invoke("runner:set", runnerWin.webContents, "enabled", false);
  } finally { m.close(); }
});

// ---- The window's own voice (windowVoice.js): the one key and a double-click talk to the bot on X0's screen ----------
const APP = "src/app/app.html";
// The one key this test binds (config.json), and its name on the fake key hook.
const KEY = process.platform === "darwin" ? { id: "rightCommand", hook: "MetaRight" } : { id: "rightCtrl", hook: "CtrlRight" };
const FAST_KEY = { "desktop.oneKey.armMs": 20, "desktop.oneKey.tapMs": 60, "desktop.talk.doubleTapMs": 150, "desktop.talk.enabled": false };

/** main.js with a key hook, X0's window shown, in front (or not), its screen taking the one key (or not). */
async function keyed(o = {}) {
  const m = mainProcess({ hook: true, config: { oneKey: KEY.id }, flags: Object.assign({}, FAST_KEY, o.flags) });
  await m.ready();
  m.win(APP).show();
  if (o.front !== false) m.focus(APP);
  if (o.talkTo !== false) m.fromApp("app:talkTo", { hold: true, chat: true });
  return m;
}
const starts = (m) => m.dictation.filter(([w, ch]) => w === "recorder" && ch === "start-recording").map(([, , p]) => p);
const keyDown = async (m, ms) => { m.key(KEY.hook, "down"); await sleep(ms); };
const keyUp = async (m, ms = 10) => { m.key(KEY.hook, "up"); await sleep(ms); };
const pasted = (m) => m.dictation.filter(([k]) => k === "clipboard" || k === "keystroke");
const pillStates = (m) => m.pills.filter(([ch, p]) => ch === "pill" && p && p.state).map(([, p]) => p.state);

test("main: X0 in front on a screen that takes the one key: a hold is his to hear, in the ask mode, with no pill, no paste and no clipboard", async () => {
  const m = await keyed();
  try {
    await keyDown(m, 80);
    const [rec] = starts(m);
    assert.ok(rec, "the microphone opened");
    assert.strictEqual(rec.mode, "ask");
    assert.strictEqual(rec.pauseEndMs, 900);
    assert.strictEqual(rec.live, true);
    const [listen] = m.appSent("app:voice");
    assert.deepStrictEqual(listen, { kind: "listen", session: 1, mode: "hold", by: "key" });
    m.fromRecorder("live-partial", { session: rec.session, text: "remind me to call" });
    m.fromRecorder("ask-pause", { session: rec.session });
    m.fromRecorder("live-partial", { session: rec.session, text: "remind me to call Nani at six" });
    await keyUp(m);
    assert.ok(m.dictation.some(([w, ch, p]) => w === "recorder" && ch === "stop-recording" && p.session === rec.session), "stopped at the release");
    m.fromRecorder("ask-audio", { session: rec.session, data: null, text: "remind me to call Nani at six" });
    m.fromRecorder("ask-text", { session: rec.session, text: "Remind me to call Nani at six.", final: true });
    await sleep(10);
    const voice = m.appSent("app:voice");
    assert.deepStrictEqual(voice.filter((v) => v.kind === "words").map((v) => v.text), ["remind me to call", "remind me to call Nani at six"]);
    assert.deepStrictEqual(voice.filter((v) => v.kind === "heard"), [{ kind: "heard", session: 1, text: "Remind me to call Nani at six." }]);
    assert.deepStrictEqual(pasted(m), [], "nothing pasted, nothing on the clipboard");
    assert.ok(!pillStates(m).includes("listening"), "no pill");
    // The window ran its action: it says stop, and the session ends.
    m.fromApp("app:voice", { cmd: "stop", session: 1 });
    assert.strictEqual(m.appSent("app:voice").slice(-1)[0].kind, "end");
  } finally { m.close(); }
});

test("main: X0 in front with no talkTo types as today; X0 not in front, the pill as today", async () => {
  for (const o of [{ talkTo: false }, { front: false }]) {
    const m = await keyed(o);
    try {
      await keyDown(m, 80);
      const [rec] = starts(m);
      assert.ok(rec, JSON.stringify(o));
      assert.notStrictEqual(rec.mode, "ask", "a dictation, not the bot's turn");
      await keyUp(m);
      m.fromRecorder("dictation-result", { session: rec.session, text: "See you Friday.", join: false });
      await until(() => m.dictation.some(([k]) => k === "keystroke"));
      assert.deepStrictEqual(m.appSent("app:voice"), [], "the window heard nothing");
      assert.ok(pasted(m).some(([k, t]) => k === "clipboard" && t === "See you Friday."), "pasted");
      assert.ok(pillStates(m).includes("listening"), "the pill listened");
    } finally { m.close(); }
  }
});

test("main: two taps make a voice chat with the bot on screen, talk mode off; Esc ends it and cancels the recording", async () => {
  const m = await keyed();
  try {
    // Tap, tap.
    m.key(KEY.hook, "down"); await sleep(5); await keyUp(m, 20);
    m.key(KEY.hook, "down"); await sleep(5); await keyUp(m, 20);
    const voice = m.appSent("app:voice");
    assert.deepStrictEqual(voice.filter((v) => v.kind === "listen").map((v) => v.mode), ["free", "chat"], "the first tap's turn gives way to the chat");
    assert.ok(!pillStates(m).includes("talk"), "not talk mode");
    const rec = starts(m).slice(-1)[0];
    assert.strictEqual(rec.mode, "ask");
    m.key("Escape", "down");
    await sleep(5);
    const end = m.appSent("app:voice").slice(-1)[0];
    assert.strictEqual(end.kind, "end");
    assert.strictEqual(end.why, "esc");
    assert.ok(m.dictation.some(([w, ch, p]) => w === "recorder" && ch === "cancel-recording" && p.session === rec.session), "the recording cancelled");
  } finally { m.close(); }
});

test("main: a double-click's voice chat ends when X0 leaves the front; another window's app:voice or app:talkTo does nothing", async () => {
  const m = await keyed({ talkTo: false });
  try {
    m.fromApp("app:voice", { cmd: "start", mode: "chat", silenceMs: 900 });
    const rec = starts(m)[0];
    assert.deepStrictEqual(m.appSent("app:voice")[0], { kind: "listen", session: 1, mode: "chat", by: "click" });
    m.win(APP).emit("blur");
    assert.deepStrictEqual(m.appSent("app:voice").slice(-1)[0], { kind: "end", session: 1, why: "blur" });
    assert.ok(m.dictation.some(([w, ch, p]) => w === "recorder" && ch === "cancel-recording" && p.session === rec.session));
    // A foreign sender: nothing starts, and the key still types.
    m.fromPill("app:voice", { cmd: "start", mode: "chat" });
    m.fromPill("app:talkTo", { hold: true, chat: true });
    assert.strictEqual(starts(m).length, 1);
    await keyDown(m, 80);
    assert.notStrictEqual(starts(m).slice(-1)[0].mode, "ask", "the pill's talkTo was not taken");
    await keyUp(m);
  } finally { m.close(); }
});
