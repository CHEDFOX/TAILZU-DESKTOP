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
  const windows = [];
  const requests = [];      // /v1/agent bodies
  const speakCalls = [];
  const ipc = new EventEmitter();
  const ipcMain = { on: (ch, f) => ipc.on(ch, f) };
  class FakeWindow {
    constructor(o) {
      this.o = o; this.visible = false; this.destroyed = false; this.ignore = [];
      const self = this;
      this.webContents = {
        send: (ch, m) => { if (ch === "guide") sent.push(m); },
        once: (ev, f) => { if (ev === "did-finish-load") setImmediate(f); },
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
    on() {}
  }
  const knobs = Object.assign({ "desktop.agent.serverVoice": false, "desktop.agent.settleMs": 0, "desktop.agent.doneMs": 50 }, opts.knobs);
  const pick = (k, f) => (k in knobs ? knobs[k] : f);
  const actions = [];
  const driver = {
    available: () => true, start() {}, stop() {},
    snapshot: async () => SNAP,
    press: async (id) => { actions.push(["press", id]); return { ok: true, how: "AXPress" }; },
    click: async (id) => { actions.push(["click", id]); return { ok: true }; },
    setValue: async () => ({ ok: true }), focus: async () => ({ ok: true }), scroll: async () => ({ ok: true }),
    key: async (k) => { actions.push(["key", k]); return { ok: true }; }, open: async () => ({ ok: true }),
  };
  const steps = opts.steps || [[{ t: "heard", text: "where's export", mode: "show" }, { t: "say", text: "Top right." }, { t: "point", id: "e1", caption: "Export" }, { t: "done" }]];
  let seq = 100;
  const ask = createAsk({
    BrowserWindow: FakeWindow,
    screen: {
      getCursorScreenPoint: () => ({ x: 500, y: 400 }),
      getDisplayNearestPoint: () => ({ workArea: WORK }),
      screenToDipRect: (_w, r) => r,
    },
    ipcMain,
    knobs: { num: pick, bool: pick, str: pick, txt: (k, f, v) => (v ? f.replace(/\{(\w+)\}/g, (m, n) => v[n] ?? m) : f) },
    webPrefs: (x) => Object.assign({}, x),
    hardenWindow() {}, raisePill() {}, setBoundsExactly(w, b) { w.bounds = b; },
    driver,
    sendToRecorder: (ch, p) => recorder.push([ch, p]),
    createRecorderWindow() {},
    recorderReady: () => true,
    nextSession: () => ++seq,
    recorderStart: (sid) => ({ session: sid, knobs: {} }),
    frontInfo: async () => opts.info || { label: "Keynote" },
    requireAccount: () => opts.signedIn !== false,
    baseUrl: () => "https://api.test",
    token: async () => "tok",
    authorizedFetch: async (p) => { speakCalls.push(p); return new Response(new Uint8Array([1, 2, 3]), { status: 200 }); },
    fetch: async (url, init) => {
      const body = init.body;
      const req = typeof body === "string" ? JSON.parse(body) : JSON.parse(body.get("request"));
      requests.push({ url, req, multipart: typeof body !== "string" });
      const script = steps[Math.min(requests.length - 1, steps.length - 1)];
      return ndjson(script);
    },
    paste: async () => {},
  });
  const recorderSender = {};
  return { ask, sent, recorder, windows, requests, speakCalls, ipc, actions, recorderSender,
    types: () => sent.map((m) => m.type),
    lastSession: () => { const s = recorder.filter(([c]) => c === "start-recording").pop(); return s && s[1].session; } };
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

test("a risky action waits for Do it; Alt twice is Do it", async () => {
  const h = harness({ steps: [
    [{ t: "heard", text: "send it", mode: "do" }, { t: "action", kind: "press", id: "e2", risk: "confirm", confirm: "Send to #design: “ready”" }],
    [{ t: "done", text: "Sent." }],
  ] });
  await h.ask.tap();
  h.ask.audioIn({ session: h.lastSession(), data: new Uint8Array([1]).buffer });
  await until(() => h.types().includes("confirm"));
  assert.deepStrictEqual(h.actions, [], "nothing is pressed before the answer");
  await h.ask.tap();   // Alt twice
  await until(() => h.actions.length > 0);
  assert.deepStrictEqual(h.actions[0], ["press", "e2"]);
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
