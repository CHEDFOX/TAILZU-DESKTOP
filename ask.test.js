// node --test
//
// ask.js is the wiring between the recorder, the guide's window, the driver
// and agent.js, so its tests are runs of a whole question with each of those
// faked: a BrowserWindow that records what it is sent, a screen with one
// display, a recorder that is only a list of messages, a driver with one
// snapshot, and a server (fetch) that answers /v1/agent from a script.

const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { createAsk } = require("./ask.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 2000) {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error("timed out waiting"); await sleep(5); }
}

const WORK = { x: 100, y: 40, width: 1400, height: 860 };
const SNAP = {
  ok: true, app: { name: "Keynote", pid: 7 }, window: { frame: [100, 40, 1200, 800] }, focused: null, selection: "",
  scale: "points", truncated: false, ms: 4,
  elements: [
    { id: "e1", role: "button", label: "Export", frame: [1100, 60, 80, 30] },
    { id: "e2", role: "button", label: "Send", frame: [1180, 780, 60, 30] },
  ],
};

function ndjson(events) {
  const body = events.map((e) => JSON.stringify(e) + "\n").join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
}

function harness(opts = {}) {
  const sent = [];          // what the guide window was sent
  const recorder = [];      // what the recorder was sent
  const log = [];           // both, in the order they happened
  const windows = [];
  const requests = [];      // /v1/agent bodies
  const speakCalls = [];
  const ipc = new EventEmitter();
  const ipcMain = { on: (ch, f) => ipc.on(ch, f) };
  class FakeWindow {
    constructor(o) {
      this.o = o; this.visible = false; this.destroyed = false; this.ignore = []; this.handlers = {}; this.wc = {};
      const self = this;
      this.webContents = {
        send: (ch, m) => {
          if (ch !== "guide" || self.destroyed) return;
          sent.push(m); log.push("guide:" + m.type);
          // The page says when it has finished saying something.
          if (m.type === "voice" && !opts.mute) setImmediate(() => ipc.emit("guide:spoken", { sender: self.webContents }));
        },
        once: (ev, f) => { if (ev === "did-finish-load") setImmediate(f); },
        on: (ev, f) => { self.wc[ev] = f; },
      };
      windows.push(self);
    }
    setVisibleOnAllWorkspaces() {}
    setIgnoreMouseEvents(v, o) { this.ignore.push([v, o]); }
    setContentProtection(v) { this.protected = v; }
    loadFile(f) { this.file = f; }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    destroy() { this.destroyed = true; this.visible = false; }
    on(ev, f) { this.handlers[ev] = f; }
  }
  const knobs = Object.assign({ "desktop.agent.serverVoice": false, "desktop.agent.settleMs": 0, "desktop.agent.doneMs": 50 }, opts.knobs);
  for (const k of opts.unset || []) delete knobs[k];
  const pick = (k, f) => (k in knobs ? knobs[k] : f);
  const actions = [];
  let ask = null;
  const driver = {
    available: () => true, start() {}, stop() {},
    snapshot: async () => opts.snap || SNAP,
    press: async (id) => { actions.push(["press", id]); return { ok: true, how: "AXPress" }; },
    click: async (id) => { actions.push(["click", id]); return { ok: true }; },
    setValue: async () => ({ ok: true }), focus: async () => ({ ok: true }), scroll: async () => ({ ok: true }),
    key: async (k) => { actions.push(["key", k]); if (opts.onKey) opts.onKey(k, ask); return { ok: true }; }, open: async () => ({ ok: true }),
  };
  const steps = opts.steps || [[{ t: "heard", text: "where's export", mode: "show" }, { t: "say", text: "Top right." }, { t: "point", id: "e1", caption: "Export" }, { t: "done" }]];
  let seq = 100;
  ask = createAsk({
    BrowserWindow: FakeWindow,
    platform: opts.platform,
    screen: opts.screen || {
      getCursorScreenPoint: () => ({ x: 500, y: 400 }),
      getDisplayNearestPoint: () => ({ workArea: WORK }),
      screenToDipRect: (_w, r) => r,
    },
    ipcMain,
    knobs: { num: pick, bool: pick, str: pick, txt: (k, f, v) => (v ? f.replace(/\{(\w+)\}/g, (m, n) => v[n] ?? m) : f) },
    webPrefs: (x) => Object.assign({}, x),
    hardenWindow() {}, raisePill() {}, setBoundsExactly(w, b) { w.bounds = b; },
    driver,
    sendToRecorder: (ch, p) => { recorder.push([ch, p]); log.push("recorder:" + ch); },
    createRecorderWindow() {},
    recorderReady: () => true,
    nextSession: () => ++seq,
    recorderStart: (sid) => ({ session: sid, knobs: {} }),
    frontInfo: opts.frontInfo || (async () => opts.info || { label: "Keynote" }),
    dictating: () => !!opts.dictating,
    language: opts.language,
    requireAccount: () => opts.signedIn !== false,
    baseUrl: () => "https://api.test",
    token: async () => "tok",
    authorizedFetch: async (p, init) => {
      speakCalls.push(p);
      const text = JSON.parse(init.body).text;
      if (opts.speakMs) await sleep(typeof opts.speakMs === "function" ? opts.speakMs(text) : opts.speakMs);
      // The "audio" is the sentence itself, when a test needs to know which it is.
      return new Response(opts.echo ? new TextEncoder().encode(text) : new Uint8Array([1, 2, 3]), { status: 200 });
    },
    fetch: async (url, init) => {
      const body = init.body;
      const req = typeof body === "string" ? JSON.parse(body) : JSON.parse(body.get("request"));
      requests.push({ url, req, multipart: typeof body !== "string" });
      const script = steps[Math.min(requests.length - 1, steps.length - 1)];
      return ndjson(script);
    },
    paste: async () => {},
  });
  return { ask, sent, recorder, log, windows, requests, speakCalls, ipc, actions,
    types: () => sent.map((m) => m.type),
    lastSession: () => { const s = recorder.filter(([c]) => c === "start-recording").pop(); return s && s[1].session; },
    starts: () => recorder.filter(([c]) => c === "start-recording").length,
    said: (re) => sent.some((m) => m.type === "say" && re.test(m.text)),
    clip: (data = new Uint8Array([1]).buffer) => ask.audioIn({ session: recorder.filter(([c]) => c === "start-recording").pop()[1].session, mime: "audio/webm", data }) };
}

test("Alt twice opens the microphone for a question: one clip, ask mode, no captions, no pause-writing", async () => {
  const h = harness();
  await h.ask.tap();
  const [ch, p] = h.recorder[0];
  assert.strictEqual(ch, "start-recording");
  assert.strictEqual(p.mode, "ask");
  assert.strictEqual(p.live, false);
  assert.strictEqual(p.pauseFlush, false);
  assert.ok(h.ask.active());
  // The guide came up, listening, over the work area.
  await until(() => h.types().includes("show"));
  assert.deepStrictEqual(h.sent.find((m) => m.type === "show").state, "listening");
  assert.deepStrictEqual(h.windows[0].o.focusable, false);
  assert.deepStrictEqual([h.windows[0].o.x, h.windows[0].o.y], [WORK.x, WORK.y]);
});

test("Alt twice again ends the question, as the pause would", async () => {
  const h = harness();
  await h.ask.tap();
  await h.ask.tap();
  assert.deepStrictEqual(h.recorder[1], ["stop-recording", { session: h.lastSession() }]);
});

test("the recorder's pause ends only its own question", async () => {
  const h = harness();
  await h.ask.tap();
  h.ask.paused({ session: 1 });
  assert.strictEqual(h.recorder.length, 1);
  h.ask.paused({ session: h.lastSession() });
  assert.deepStrictEqual(h.recorder[1][0], "stop-recording");
});

test("a whole show run: the clip goes to /v1/agent with the screen, the ring lands in the window's own coordinates", async () => {
  const h = harness();
  await h.ask.tap();
  h.ask.audioIn({ session: h.lastSession(), mime: "audio/webm", data: new Uint8Array([9, 9, 9]).buffer });
  await until(() => h.types().includes("point") && h.sent.some((m) => m.type === "state" && m.state === "done"));
  const r = h.requests[0];
  assert.strictEqual(r.url, "https://api.test/v1/agent");
  assert.ok(r.multipart, "the first step carries the audio");
  assert.strictEqual(r.req.step, 0);
  assert.ok(r.req.screen.elements.every((e) => !("frame" in e)), "frames never leave the machine");
  const point = h.sent.find((m) => m.type === "point");
  // Export at [1100, 60] on screen, the window at the work area's corner.
  assert.deepStrictEqual(point.frame, [1100 - WORK.x, 60 - WORK.y, 80, 30]);
  assert.strictEqual(point.caption, "Export");
  assert.ok(h.sent.some((m) => m.type === "say" && m.text === "Top right."));
  // Spoken with the built-in voice when the server's is off.
  assert.ok(h.sent.some((m) => m.type === "voice" && m.speak && m.text === "Top right."));
});

test("the server's voice, when on, is fetched and handed to the guide as audio", async () => {
  const h = harness({ knobs: { "desktop.agent.serverVoice": true } });
  await h.ask.tap();
  h.ask.audioIn({ session: h.lastSession(), mime: "audio/webm", data: new Uint8Array([1]).buffer });
  await until(() => h.sent.some((m) => m.type === "voice"));
  assert.deepStrictEqual(h.speakCalls, ["/v1/speak"]);
  const v = h.sent.find((m) => m.type === "voice");
  assert.ok(v.audio instanceof Uint8Array && v.audio.length === 3);
});

test("a private window is refused before anything is read: the microphone closes, the card says why", async () => {
  const h = harness({ info: { label: "Chrome", private: true } });
  await h.ask.tap();
  assert.ok(h.recorder.some(([c]) => c === "cancel-recording"), "the question's microphone is closed");
  await until(() => h.sent.some((m) => m.type === "state" && m.state === "error"));
  assert.ok(h.sent.some((m) => m.type === "say" && /private/i.test(m.text)));
  assert.strictEqual(h.requests.length, 0);
});

test("a question with no voice in it ends the run and says it did not catch that", async () => {
  const h = harness();
  await h.ask.tap();
  h.ask.audioIn({ session: h.lastSession(), data: null });
  await until(() => h.sent.some((m) => m.type === "say" && /didn't catch/.test(m.text)));
  assert.strictEqual(h.requests.length, 0);
  assert.ok(!h.ask.active());
});

const RISKY = [
  [{ t: "heard", text: "send it", mode: "do" }, { t: "action", kind: "press", id: "e2", risk: "confirm", confirm: "Send to #design: “ready”" }],
  [{ t: "done", text: "Sent." }],
];

test("a risky action waits for Do it; Alt twice, once the card has been up a moment, is Do it", async () => {
  const h = harness({ steps: RISKY, knobs: { "desktop.agent.confirmTapMs": 40 } });
  await h.ask.tap();
  h.ask.audioIn({ session: h.lastSession(), data: new Uint8Array([1]).buffer });
  await until(() => h.types().includes("confirm"));
  assert.deepStrictEqual(h.actions, [], "nothing is pressed before the answer");
  await sleep(60);
  await h.ask.tap();   // Alt twice
  await until(() => h.actions.length > 0);
  assert.deepStrictEqual(h.actions[0], ["press", "e2"]);
});

test("Alt twice the moment the card comes up is the stop gesture it was begun as, not Do it", async () => {
  const h = harness({ steps: RISKY });
  await h.ask.tap();
  h.ask.audioIn({ session: h.lastSession(), data: new Uint8Array([1]).buffer });
  await until(() => h.types().includes("confirm"));
  await h.ask.tap();
  await sleep(30);
  assert.deepStrictEqual(h.actions, [], "nothing was sent");
  assert.ok(!h.ask.active(), "the run stopped");
  assert.strictEqual(h.requests.length, 1);
});

test("by default the card must have been up 800 ms before Alt twice is Do it", async () => {
  const realNow = Date.now;
  for (const [after, yes] of [[750, false], [850, true]]) {
    const h = harness({ steps: RISKY });
    await h.ask.tap();
    h.clip();
    await until(() => h.types().includes("confirm"));
    // The clock moved on by `after` since the card went up.
    Date.now = () => realNow() + after;
    try { await h.ask.tap(); } finally { Date.now = realNow; }
    if (yes) {
      await until(() => h.actions.length > 0);
      assert.deepStrictEqual(h.actions[0], ["press", "e2"], `${after} ms: Do it`);
    } else {
      await sleep(30);
      assert.deepStrictEqual(h.actions, [], `${after} ms: still the stop gesture`);
      assert.ok(!h.ask.active());
    }
  }
});

test("the tray's Ask item never answers a card: it stops the run", async () => {
  const h = harness({ steps: RISKY, knobs: { "desktop.agent.confirmTapMs": 0 } });
  await h.ask.tap();
  h.clip();
  await until(() => h.types().includes("confirm"));
  await sleep(10);
  await h.ask.tap({ menu: true });
  await sleep(30);
  assert.deepStrictEqual(h.actions, []);
  assert.ok(!h.ask.active());
});

test("a card nobody answered in confirmMs lets go: the next Alt twice is a new question", async () => {
  const h = harness({ steps: RISKY, knobs: { "desktop.agent.confirmMs": 40, "desktop.agent.doneMs": 5000 } });
  await h.ask.tap();
  h.ask.audioIn({ session: h.lastSession(), data: new Uint8Array([1]).buffer });
  await until(() => h.types().includes("confirm"));
  await until(() => h.sent.some((m) => m.type === "state" && m.state === "done"));
  assert.ok(!h.ask.active());
  assert.strictEqual(h.starts(), 1);
  await h.ask.tap();
  assert.strictEqual(h.starts(), 2, "the tap opened the microphone instead of answering a dead card");
  assert.deepStrictEqual(h.actions, []);
});

test("Not now leaves it", async () => {
  const h = harness({ steps: [
    [{ t: "heard", text: "send it", mode: "do" }, { t: "action", kind: "press", id: "e2", risk: "confirm", confirm: "Send?" }],
  ] });
  await h.ask.tap();
  h.ask.audioIn({ session: h.lastSession(), data: new Uint8Array([1]).buffer });
  await until(() => h.types().includes("confirm"));
  const win = h.windows[0];
  h.ipc.emit("guide:confirm", { sender: win.webContents }, false);
  await until(() => h.sent.some((m) => m.type === "state" && m.state === "done"));
  assert.deepStrictEqual(h.actions, []);
});

test("only the guide's own window can answer for it", async () => {
  const h = harness({ steps: [
    [{ t: "heard", text: "send it", mode: "do" }, { t: "action", kind: "press", id: "e2", risk: "confirm", confirm: "Send?" }],
  ] });
  await h.ask.tap();
  h.ask.audioIn({ session: h.lastSession(), data: new Uint8Array([1]).buffer });
  await until(() => h.types().includes("confirm"));
  h.ipc.emit("guide:confirm", { sender: {} }, true);
  await sleep(30);
  assert.deepStrictEqual(h.actions, []);
  h.ask.cancel("test over");
});

test("Esc stops a run and puts the card away", async () => {
  const h = harness();
  await h.ask.tap();
  assert.strictEqual(h.ask.escape(), true);
  assert.ok(!h.ask.active());
  assert.ok(h.recorder.some(([c]) => c === "cancel-recording"));
  await until(() => h.types().includes("hide"));
  assert.strictEqual(h.ask.escape(), false, "Esc with nothing running is left alone");
});

test("the pointer over the card takes clicks; off it, they go through", async () => {
  const h = harness();
  await h.ask.tap();
  const win = h.windows[0];
  h.ipc.emit("guide:mouse", { sender: win.webContents }, true);
  h.ipc.emit("guide:mouse", { sender: win.webContents }, false);
  const last2 = win.ignore.slice(-2);
  assert.deepStrictEqual(last2[0], [false, undefined]);
  assert.deepStrictEqual(last2[1], [true, { forward: true }]);
});

test("a question's voice level and errors are routed to it, a dictation's are not", async () => {
  const h = harness();
  await h.ask.tap();
  const sid = h.lastSession();
  assert.strictEqual(h.ask.level({ session: sid, bands: [0.2, 0.4] }), true);
  await until(() => h.sent.some((m) => m.type === "level" && Math.abs(m.v - 0.3) < 1e-9));
  assert.strictEqual(h.ask.level({ session: 3, bands: [1] }), false);
  assert.strictEqual(h.ask.error({ session: 3, message: "x" }), false);
  assert.strictEqual(h.ask.error({ session: sid, message: "The microphone is busy." }), true);
  await until(() => h.sent.some((m) => m.type === "say" && m.text === "The microphone is busy."));
});

test("signed out, Alt twice opens nothing", async () => {
  const h = harness({ signedIn: false });
  await h.ask.tap();
  assert.strictEqual(h.recorder.length, 0);
  assert.strictEqual(h.windows.length, 0);
});

// ---- which window it is ---------------------------------------------------------

test("a front window that cannot be named is asked about once more, then refused: nothing is read", async () => {
  let asked = 0;
  const h = harness({ frontInfo: async () => { asked++; return null; }, knobs: { "desktop.agent.doneMs": 5000 } });
  await h.ask.tap();
  assert.strictEqual(asked, 2);
  assert.ok(h.recorder.some(([c]) => c === "cancel-recording"), "the question's microphone is closed");
  await until(() => h.said(/couldn't tell which window/));
  assert.ok(h.sent.some((m) => m.type === "state" && m.state === "error"));
  h.clip();
  await sleep(30);
  assert.strictEqual(h.requests.length, 0);
  assert.ok(!h.ask.active());
});

test("a front window named on the second asking goes ahead as usual", async () => {
  let asked = 0;
  const h = harness({ frontInfo: async () => (++asked === 1 ? null : { label: "Keynote" }) });
  await h.ask.tap();
  h.clip();
  await until(() => h.requests.length === 1);
  assert.strictEqual(h.requests[0].req.app, "Keynote");
});

test("a clip that comes back before the app is named is kept for the run, not dropped", async () => {
  const h = harness({ frontInfo: () => sleep(80).then(() => ({ label: "Keynote" })) });
  const tapped = h.ask.tap();
  await sleep(10);
  await h.ask.tap();   // Alt twice again: the question ends
  h.clip();
  await tapped;
  await until(() => h.requests.length === 1 && h.types().includes("point"));
});

test("a short silence that comes back before the app is named still says it did not catch that", async () => {
  const h = harness({ frontInfo: () => sleep(60).then(() => ({ label: "Keynote" })), knobs: { "desktop.agent.doneMs": 5000 } });
  const tapped = h.ask.tap();
  await sleep(10);
  h.ask.audioIn({ session: h.lastSession(), data: null });
  await tapped;
  await until(() => h.said(/didn't catch/));
  assert.strictEqual(h.requests.length, 0);
});

test("Esc while the app is being named stops it there, a clip already back or not", async () => {
  const h = harness({ frontInfo: () => sleep(60).then(() => ({ label: "Keynote" })) });
  const tapped = h.ask.tap();
  await sleep(10);
  h.clip();
  assert.strictEqual(h.ask.escape(), true);
  await tapped;
  await sleep(20);
  assert.strictEqual(h.requests.length, 0);
  assert.ok(!h.types().includes("show"));
});

// ---- the card --------------------------------------------------------------------

test("the not-heard card stays doneMs: the run's own hide does not take the window down after it", async () => {
  const h = harness({ knobs: { "desktop.agent.doneMs": 3000 } });
  await h.ask.tap();
  h.ask.audioIn({ session: h.lastSession(), data: null });
  await until(() => h.said(/didn't catch/));
  await sleep(700);
  assert.strictEqual(h.windows[0].visible, true, "the window is still up");
  assert.strictEqual(h.types().lastIndexOf("hide") < h.types().lastIndexOf("show"), true);
});

test("a recorder error's card stays up too", async () => {
  const h = harness({ knobs: { "desktop.agent.doneMs": 3000 } });
  await h.ask.tap();
  h.ask.error({ session: h.lastSession(), message: "Tailzu can't use the microphone." });
  await until(() => h.said(/microphone/));
  await sleep(700);
  assert.strictEqual(h.windows[0].visible, true);
});

test("a stopped question whose clip never comes back ends as not heard", async () => {
  const h = harness({ knobs: { "desktop.agent.clipWaitMs": 40, "desktop.agent.doneMs": 5000 } });
  await h.ask.tap();
  await h.ask.tap();   // stop: the clip is now due
  await until(() => h.said(/didn't catch/), 1000);
  assert.ok(!h.ask.active());
  assert.strictEqual(h.requests.length, 0);
});

test("the recorder's page going away ends the question it was recording at once", async () => {
  const h = harness({ knobs: { "desktop.agent.doneMs": 5000 } });
  await h.ask.tap();
  h.ask.recorderGone();
  await until(() => h.said(/didn't catch/), 500);
  assert.ok(!h.ask.active());
});

test("a guide page that crashes is thrown away with its run, and the next question builds a new one", async () => {
  const h = harness({ steps: RISKY });
  await h.ask.tap();
  h.clip();
  await until(() => h.types().includes("confirm"));
  h.windows[0].wc["render-process-gone"]();
  assert.ok(h.windows[0].destroyed);
  assert.ok(!h.ask.active(), "nobody can see the card, so nothing waits on it");
  await h.ask.tap();
  await sleep(30);
  assert.deepStrictEqual(h.actions, [], "the next Alt twice did not answer the unseen card");
  assert.strictEqual(h.windows.length, 2);
  assert.ok(h.ask.active());
});

// ---- the microphone and the keys ------------------------------------------------

test("while a dictation records, Alt twice leaves its microphone alone", async () => {
  const h = harness({ dictating: true });
  await h.ask.tap();
  assert.strictEqual(h.recorder.length, 0);
  assert.strictEqual(h.windows.length, 0);
});

test("the agent's own Escape is not the person's: the run goes on", async () => {
  const esc = [];
  const h = harness({
    onKey: (k, ask) => esc.push(ask.escape()),   // the key hook hears it, as main's does
    steps: [
      [{ t: "heard", text: "close this and open settings", mode: "do" }, { t: "action", kind: "key", keys: "escape", risk: "free" }],
      [{ t: "action", kind: "press", id: "e1", risk: "free" }],
      [{ t: "done", text: "Open." }],
    ],
  });
  await h.ask.tap();
  h.clip();
  await until(() => h.sent.some((m) => m.type === "state" && m.state === "done"));
  assert.deepStrictEqual(esc, [false]);
  assert.strictEqual(h.requests.length, 3);
  assert.deepStrictEqual(h.actions, [["key", "escape"], ["press", "e1"]]);
});

test("the desktop's language goes with every step", async () => {
  const h = harness({ language: () => "hi" });
  await h.ask.tap();
  h.clip();
  await until(() => h.requests.length === 1);
  assert.strictEqual(h.requests[0].req.language, "hi");
});

// ---- the voice -------------------------------------------------------------------

test("the built-in voice by default: the server's would count Ask's words against dictation's", async () => {
  const h = harness({ unset: ["desktop.agent.serverVoice"] });
  await h.ask.tap();
  h.clip();
  await until(() => h.sent.some((m) => m.type === "voice"));
  assert.deepStrictEqual(h.speakCalls, []);
  assert.ok(h.sent.find((m) => m.type === "voice").speak);
});

test("an answer whose voice arrives after Esc is not played", async () => {
  const h = harness({ knobs: { "desktop.agent.serverVoice": true }, speakMs: 60 });
  await h.ask.tap();
  h.clip();
  await until(() => h.said(/Top right/));
  h.ask.escape();
  await sleep(120);
  assert.strictEqual(h.speakCalls.length, 1);
  assert.ok(!h.types().includes("voice"));
});

test("two sentences are said in the order they were written, however their audio arrives", async () => {
  const h = harness({
    knobs: { "desktop.agent.serverVoice": true, "desktop.agent.doneMs": 5000 },
    echo: true,
    speakMs: (text) => (text === "First." ? 80 : 5),
    steps: [[{ t: "heard", text: "what's this", mode: "show" }, { t: "say", text: "First." }, { t: "done", text: "Second." }]],
  });
  await h.ask.tap();
  h.clip();
  await until(() => h.sent.filter((m) => m.type === "voice").length === 2);
  const said = h.sent.filter((m) => m.type === "voice").map((m) => new TextDecoder().decode(m.audio));
  assert.deepStrictEqual(said, ["First.", "Second."]);
  assert.deepStrictEqual(h.speakCalls, ["/v1/speak", "/v1/speak"], "both fetched at once");
});

test("the next sentence waits until the guide has said the one before", async () => {
  const h = harness({
    mute: true,   // a guide that never says it has finished
    knobs: { "desktop.agent.doneMs": 5000, "desktop.agent.voiceWaitMs": 120 },
    steps: [[{ t: "heard", text: "what's this", mode: "show" }, { t: "say", text: "First." }, { t: "done", text: "Second." }]],
  });
  await h.ask.tap();
  h.clip();
  await until(() => h.types().includes("voice"));
  await sleep(40);
  assert.deepStrictEqual(h.sent.filter((m) => m.type === "voice").map((m) => m.text), ["First."]);
  await until(() => h.sent.filter((m) => m.type === "voice").length === 2, 1000);
  assert.deepStrictEqual(h.sent.filter((m) => m.type === "voice").map((m) => m.text), ["First.", "Second."]);
});

test("an ASK's question is said before the microphone opens for the reply, never while it records", async () => {
  const h = harness({
    knobs: { "desktop.agent.serverVoice": true },
    speakMs: 40,
    steps: [
      [{ t: "heard", text: "tell them it's ready", mode: "do" }, { t: "ask", text: "Which channel?" }],
      [{ t: "done", text: "Okay." }],
    ],
  });
  await h.ask.tap();
  h.clip();
  await until(() => h.starts() === 2);
  const voiceAt = h.log.indexOf("guide:voice"), secondStart = h.log.lastIndexOf("recorder:start-recording");
  assert.ok(voiceAt !== -1 && voiceAt < secondStart, h.log.join(","));
  h.clip();
  await until(() => h.requests.length === 2);
  assert.ok(h.requests[1].multipart, "the reply went as the next step's audio");
});

// ---- where the guide goes ----------------------------------------------------------

test("Windows, a scaled display: the ring's display is found from DIP, so the guide stays where the button is", async () => {
  // A laptop at 150% (1920x1080 physical, 1280x720 DIP) and a monitor at
  // 100% to its right, from DIP x 1280.
  const A = { workArea: { x: 0, y: 0, width: 1280, height: 680 }, bounds: { x: 0, y: 0, width: 1280, height: 720 } };
  const B = { workArea: { x: 1280, y: 0, width: 1920, height: 1040 }, bounds: { x: 1280, y: 0, width: 1920, height: 1080 } };
  const snap = Object.assign({}, SNAP, { scale: "pixels", window: { frame: [0, 0, 1920, 1080] },
    elements: [{ id: "e1", role: "button", label: "Export", frame: [1800, 100, 60, 30] }] });
  const h = harness({
    platform: "win32", snap,
    screen: {
      getCursorScreenPoint: () => ({ x: 500, y: 400 }),
      getDisplayNearestPoint: (p) => (p.x < 1280 ? A : B),
      screenToDipRect: (_w, r) => (r.x < 1920 ? { x: r.x / 1.5, y: r.y / 1.5, width: r.width / 1.5, height: r.height / 1.5 } : { x: r.x - 640, y: r.y, width: r.width, height: r.height }),
    },
  });
  await h.ask.tap();
  h.clip();
  await until(() => h.types().includes("point"));
  const point = h.sent.find((m) => m.type === "point");
  assert.deepStrictEqual(point.frame, [1200, 100 / 1.5, 40, 20]);
  assert.strictEqual(h.windows.length, 1);
  assert.strictEqual(h.windows[0].bounds, undefined, "the guide never moved to the other monitor");
  assert.deepStrictEqual([h.windows[0].o.x, h.windows[0].o.width], [0, 1280]);
});

test("Mac: the guide covers the whole display, menu bar included, and tells the card where the work area is", async () => {
  const D = { bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 25, width: 1440, height: 800 } };
  const snap = Object.assign({}, SNAP, { elements: [{ id: "m1", role: "menu", label: "File", frame: [80, 2, 34, 22] }] });
  const h = harness({
    platform: "darwin", snap,
    steps: [[{ t: "heard", text: "where's save", mode: "show" }, { t: "say", text: "Under File." }, { t: "point", id: "m1", caption: "File" }, { t: "done" }]],
    screen: { getCursorScreenPoint: () => ({ x: 500, y: 400 }), getDisplayNearestPoint: () => D },
  });
  await h.ask.tap();
  h.clip();
  await until(() => h.types().includes("point"));
  const o = h.windows[0].o;
  assert.deepStrictEqual([o.x, o.y, o.width, o.height], [0, 0, 1440, 900]);
  assert.strictEqual(o.type, "panel");
  assert.strictEqual(o.enableLargerThanScreen, true);
  assert.deepStrictEqual(h.sent.find((m) => m.type === "area").inset, { top: 25, left: 0, right: 0, bottom: 75 });
  assert.deepStrictEqual(h.sent.find((m) => m.type === "point").frame, [80, 2, 34, 22]);
});

test("Windows keeps the work area", async () => {
  const D = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
  const h = harness({ platform: "win32", screen: { getCursorScreenPoint: () => ({ x: 5, y: 5 }), getDisplayNearestPoint: () => D, screenToDipRect: (_w, r) => r } });
  await h.ask.tap();
  const o = h.windows[0].o;
  assert.deepStrictEqual([o.x, o.y, o.width, o.height], [0, 0, 1920, 1040]);
  assert.strictEqual(o.enableLargerThanScreen, undefined);
  await until(() => h.types().includes("area"));
  assert.deepStrictEqual(h.sent.find((m) => m.type === "area").inset, { top: 0, left: 0, right: 0, bottom: 0 });
});
