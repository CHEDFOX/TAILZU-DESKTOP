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
const agentCore = require("./agent.js");

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
  // The stream's final text is not waited for unless a test says so: most
  // of them hand over a clip and nothing else.
  const knobs = Object.assign({ "desktop.agent.serverVoice": false, "desktop.agent.settleMs": 0, "desktop.agent.doneMs": 50, "desktop.agent.finalTextMs": 0 }, opts.knobs);
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
  // The window's picture and its text, read at Alt twice, for the tests of
  // the picture path; without it the driver has no look, as v1's had not.
  if (opts.look) driver.look = async () => opts.look;
  const steps = opts.steps || [[{ t: "heard", text: "where's export", mode: "show" }, { t: "say", text: "Top right." }, { t: "point", id: "e1", caption: "Export" }, { t: "done" }]];
  let seq = 100;
  // The real agent, watched: what it is told (begin, preview, heard), and the
  // dependencies it is handed (the guide, the picture path).
  const calls = [];
  let deps = null;
  const allowed = (opts.allowed || []).slice();
  ask = createAsk({
    BrowserWindow: FakeWindow,
    platform: opts.platform,
    createAgent: (d) => {
      deps = d;
      const real = agentCore.createAgent(d);
      return Object.assign({}, real, {
        begin: (o) => { calls.push(["begin", o]); return real.begin(o); },
        heard: (a, o) => { calls.push(["heard", a, o]); return real.heard(a, o); },
        preview: (t) => { calls.push(["preview", t]); if (typeof real.preview === "function") return real.preview(t); return undefined; },
      });
    },
    nativeImage: opts.nativeImage,
    picturesAlways: () => allowed.slice(),
    allowPicturesAlways: (a) => allowed.push(a),
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
      const multipart = typeof body !== "string";
      const req = multipart ? JSON.parse(body.get("request")) : JSON.parse(body);
      // Every part a request carries, as it would leave: the picture's and
      // the recording's bytes too, so a test can say exactly what went.
      const parts = {};
      if (multipart) {
        for (const [k, v] of body.entries()) {
          parts[k] = typeof v === "string" ? v : { name: v.name, type: v.type, bytes: Buffer.from(await v.arrayBuffer()) };
        }
      }
      requests.push({ url, req, multipart, parts, raw: multipart ? body.get("request") : body });
      const script = steps[Math.min(requests.length - 1, steps.length - 1)];
      return ndjson(script);
    },
    paste: async () => {},
  });
  return { ask, sent, recorder, log, windows, requests, speakCalls, ipc, actions, calls, allowed, deps: () => deps,
    heardCalls: () => calls.filter((c) => c[0] === "heard"),
    previews: () => calls.filter((c) => c[0] === "preview").map((c) => c[1]),
    types: () => sent.map((m) => m.type),
    lastSession: () => { const s = recorder.filter(([c]) => c === "start-recording").pop(); return s && s[1].session; },
    starts: () => recorder.filter(([c]) => c === "start-recording").length,
    said: (re) => sent.some((m) => m.type === "say" && re.test(m.text)),
    clip: (data = new Uint8Array([1]).buffer) => ask.audioIn({ session: recorder.filter(([c]) => c === "start-recording").pop()[1].session, mime: "audio/webm", data }) };
}

test("Alt twice opens the microphone for a question: one clip, ask mode, streamed, no pause-writing", async () => {
  const h = harness();
  await h.ask.tap();
  const [ch, p] = h.recorder[0];
  assert.strictEqual(ch, "start-recording");
  assert.strictEqual(p.mode, "ask");
  assert.strictEqual(p.live, true, "the question goes to the live stream too (desktop.agent.liveStream)");
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

// ---- the live stream (v2: the instant layer) ---------------------------------------

test("liveStream off: the question records as one clip with no stream, as before", async () => {
  const h = harness({ knobs: { "desktop.agent.liveStream": false } });
  await h.ask.tap();
  assert.strictEqual(h.recorder[0][1].live, false);
  // A partial for it is still its own (never a dictation's caption), and shown to nobody.
  assert.strictEqual(h.ask.partial({ session: h.lastSession(), text: "where's" }), true);
  assert.deepStrictEqual(h.previews(), []);
  h.clip();
  await until(() => h.heardCalls().length === 1);
  assert.deepStrictEqual(h.heardCalls()[0][2], { text: "", final: false });
});

test("an ASK's reply records without the stream: it is only ever its audio", async () => {
  const h = harness({
    steps: [
      [{ t: "heard", text: "tell them it's ready", mode: "do" }, { t: "ask", text: "Which channel?" }],
      [{ t: "done", text: "Okay." }],
    ],
  });
  await h.ask.tap();
  h.clip();
  await until(() => h.starts() === 2);
  const starts = h.recorder.filter(([c]) => c === "start-recording").map(([, p]) => p);
  assert.deepStrictEqual(starts.map((p) => p.live), [true, false]);
  assert.deepStrictEqual(starts.map((p) => p.mode), ["ask", "ask"]);
});

test("partials go to the agent as previews while the question is said, and only that question's", async () => {
  const h = harness();
  await h.ask.tap();
  const sid = h.lastSession();
  assert.strictEqual(h.ask.partial({ session: sid, text: "where's" }), true);
  assert.strictEqual(h.ask.partial({ session: sid, text: "where's  ex" }), true);
  assert.strictEqual(h.ask.partial({ session: 3, text: "a dictation's words" }), false, "a dictation's captions stay the dictation's");
  assert.deepStrictEqual(h.previews(), ["where's", "where's ex"]);
  // Once the question has ended, late words from the stream change nothing on screen.
  await h.ask.tap();
  h.ask.partial({ session: sid, text: "where's export" });
  assert.deepStrictEqual(h.previews(), ["where's", "where's ex"]);
  h.ask.cancel("test over");
});

test("words said while the app was being named are shown to the run the moment it begins", async () => {
  const h = harness({ frontInfo: () => sleep(50).then(() => ({ label: "Keynote" })) });
  const tapped = h.ask.tap();
  await sleep(5);
  h.ask.partial({ session: h.lastSession(), text: "where is the exp" });
  assert.deepStrictEqual(h.previews(), [], "no run to show them to yet");
  await tapped;
  assert.deepStrictEqual(h.previews(), ["where is the exp"]);
  const order = h.calls.map((c) => c[0]);
  assert.ok(order.indexOf("begin") < order.indexOf("preview"));
  h.ask.cancel("test over");
});

test("the clip waits for the stream's final text, and the run hears both", async () => {
  const h = harness({ knobs: { "desktop.agent.finalTextMs": 1000 } });
  await h.ask.tap();
  const sid = h.lastSession();
  h.ask.audioIn({ session: sid, mime: "audio/webm", data: new Uint8Array([1, 2]).buffer, text: "where's the exp" });
  await sleep(30);
  assert.strictEqual(h.heardCalls().length, 0, "held for the final text");
  h.ask.textIn({ session: 9999, text: "someone else's", final: true });
  await sleep(10);
  assert.strictEqual(h.heardCalls().length, 0);
  h.ask.textIn({ session: sid, text: "where's the  export button", final: true });
  await until(() => h.heardCalls().length === 1);
  const [, audio, said] = h.heardCalls()[0];
  assert.ok(Buffer.isBuffer(audio.data) && audio.data.length === 2);
  assert.deepStrictEqual(said, { text: "where's the export button", final: true });
  h.ask.cancel("test over");
});

test("a final text that came before the clip is used at once", async () => {
  const h = harness({ knobs: { "desktop.agent.finalTextMs": 5000 } });
  await h.ask.tap();
  const sid = h.lastSession();
  h.ask.textIn({ session: sid, text: "explain this equation", final: true });
  h.ask.audioIn({ session: sid, mime: "audio/webm", data: new Uint8Array([1]).buffer, text: "explain this" });
  await until(() => h.heardCalls().length === 1, 300);
  assert.deepStrictEqual(h.heardCalls()[0][2], { text: "explain this equation", final: true });
  h.ask.cancel("test over");
});

test("by default it waits 400 ms for the final text, then goes with the text it has", async () => {
  const h = harness({ unset: ["desktop.agent.finalTextMs"] });
  await h.ask.tap();
  const t0 = Date.now();
  h.ask.audioIn({ session: h.lastSession(), mime: "audio/webm", data: new Uint8Array([1]).buffer, text: "what does this chart show" });
  await until(() => h.heardCalls().length === 1, 2000);
  const waited = Date.now() - t0;
  assert.ok(waited >= 380 && waited < 1500, `waited ${waited} ms`);
  assert.deepStrictEqual(h.heardCalls()[0][2], { text: "what does this chart show", final: false });
  h.ask.cancel("test over");
});

test("no voice in the clip and no words in the stream: it did not catch that, with no wait", async () => {
  const h = harness({ knobs: { "desktop.agent.finalTextMs": 5000, "desktop.agent.doneMs": 5000 } });
  await h.ask.tap();
  h.ask.audioIn({ session: h.lastSession(), data: null, text: "" });
  await until(() => h.said(/didn't catch/), 300);
  assert.strictEqual(h.heardCalls().length, 0);
  assert.strictEqual(h.requests.length, 0);
});

test("the stream's words alone are still a question when no clip came with them", async () => {
  const h = harness({ knobs: { "desktop.agent.finalTextMs": 0 } });
  await h.ask.tap();
  h.ask.audioIn({ session: h.lastSession(), data: null, text: "where's export" });
  await until(() => h.heardCalls().length === 1);
  assert.deepStrictEqual(h.heardCalls()[0].slice(1), [null, { text: "where's export", final: false }]);
  h.ask.cancel("test over");
});

test("Esc while the clip waits for its final text stops it there: the run never hears it", async () => {
  const h = harness({ knobs: { "desktop.agent.finalTextMs": 80 } });
  await h.ask.tap();
  h.ask.audioIn({ session: h.lastSession(), mime: "audio/webm", data: new Uint8Array([1]).buffer, text: "send it" });
  assert.ok(h.ask.active(), "a clip waiting for its text is a question still under way");
  assert.strictEqual(h.ask.escape(), true);
  h.ask.textIn({ session: h.lastSession(), text: "send it to design", final: true });
  await sleep(140);
  assert.strictEqual(h.heardCalls().length, 0);
  assert.strictEqual(h.requests.length, 0);
  assert.ok(!h.ask.active());
});

test("Alt twice while the clip waits for its final text stops the question too", async () => {
  const h = harness({ knobs: { "desktop.agent.finalTextMs": 80 } });
  await h.ask.tap();
  h.ask.audioIn({ session: h.lastSession(), mime: "audio/webm", data: new Uint8Array([1]).buffer, text: "undo" });
  await h.ask.tap();
  await sleep(140);
  assert.strictEqual(h.heardCalls().length, 0);
  assert.strictEqual(h.starts(), 1, "it stopped; it did not open the microphone again");
});

test("a recorder that never sends the clip back leaves the stream's words to answer from", async () => {
  const h = harness({ knobs: { "desktop.agent.clipWaitMs": 30 } });
  await h.ask.tap();
  h.ask.partial({ session: h.lastSession(), text: "what's this" });
  await h.ask.tap();   // stop: the clip is due, and never comes
  await until(() => h.heardCalls().length === 1, 1000);
  assert.deepStrictEqual(h.heardCalls()[0].slice(1), [null, { text: "what's this", final: false }]);
  h.ask.cancel("test over");
});

// ---- where the pointer is -------------------------------------------------------

test("begin gets where the pointer was at Alt twice, in the driver's units", async () => {
  const mac = harness({ platform: "darwin", screen: { getCursorScreenPoint: () => ({ x: 640, y: 300 }), getDisplayNearestPoint: () => ({ workArea: WORK, bounds: WORK }) } });
  await mac.ask.tap();
  assert.deepStrictEqual(mac.calls.find((c) => c[0] === "begin")[1].pointer, { x: 640, y: 300 });
  mac.ask.cancel("test over");
  // Windows: UI Automation's physical pixels, on a display at 150%.
  const win = harness({
    platform: "win32",
    screen: {
      getCursorScreenPoint: () => ({ x: 640, y: 300 }),
      getDisplayNearestPoint: () => ({ workArea: WORK }),
      screenToDipRect: (_w, r) => r,
      dipToScreenPoint: (p) => ({ x: p.x * 1.5, y: p.y * 1.5 }),
    },
  });
  await win.ask.tap();
  const begin = win.calls.find((c) => c[0] === "begin")[1];
  assert.deepStrictEqual(begin.pointer, { x: 960, y: 450 });
  assert.strictEqual(begin.app, "Keynote");
  win.ask.cancel("test over");
});

// ---- the picture (v2: the picture layer) ---------------------------------------

test("pictures: never by the knob; always for an app said yes to; else ask", () => {
  const h = harness({ allowed: ["Keynote"] });
  const pictures = h.deps().pictures;
  assert.strictEqual(pictures("Keynote"), "always");
  assert.strictEqual(pictures("  keynote "), "always", "the app's name, however it is cased");
  assert.strictEqual(pictures("Safari"), "ask");
  assert.strictEqual(pictures(""), "ask");
  assert.strictEqual(harness({ allowed: ["Keynote"], knobs: { "desktop.agent.pictures": "never" } }).deps().pictures("Keynote"), "never");
  assert.strictEqual(harness({ knobs: { "desktop.agent.pictures": "always" } }).deps().pictures("Safari"), "always");
  assert.strictEqual(harness({ knobs: { "desktop.agent.pictures": "sometimes" } }).deps().pictures("Safari"), "ask", "a value it does not know asks");
});

async function permitCard(opts) {
  const h = harness(Object.assign({ knobs: { "desktop.agent.doneMs": 5000 } }, opts));
  await h.ask.tap();
  await until(() => h.types().includes("show"));
  const answer = h.deps().permit("Keynote");
  await until(() => h.types().includes("permission"));
  return { h, answer, win: h.windows[0] };
}

test("the picture card asks, with the app's name; Always remembers the app, Allow once does not", async () => {
  {
    const { h, answer, win } = await permitCard();
    const card = h.sent.find((m) => m.type === "permission");
    assert.strictEqual(card.app, "Keynote");
    assert.ok(/picture/.test(card.text));
    h.ipc.emit("guide:permit", { sender: {} }, "always");   // not the guide's own window
    h.ipc.emit("guide:permit", { sender: win.webContents }, "always");
    assert.strictEqual(await answer, "always");
    assert.deepStrictEqual(h.allowed, ["Keynote"]);
    h.ask.cancel("test over");
  }
  {
    const { h, answer, win } = await permitCard();
    h.ipc.emit("guide:permit", { sender: win.webContents }, "once");
    assert.strictEqual(await answer, "once");
    assert.deepStrictEqual(h.allowed, []);
    h.ask.cancel("test over");
  }
  {
    const { h, answer, win } = await permitCard();
    h.ipc.emit("guide:permit", { sender: win.webContents }, "please");
    assert.strictEqual(await answer, "no", "only once and always are a yes");
    h.ask.cancel("test over");
  }
});

test("the picture card unanswered in confirmMs is no; Esc and Alt twice are no and stop the run", async () => {
  {
    const { h, answer } = await permitCard({ knobs: { "desktop.agent.confirmMs": 30, "desktop.agent.doneMs": 5000 } });
    assert.strictEqual(await answer, "no");
    h.ask.cancel("test over");
  }
  {
    const { h, answer } = await permitCard();
    assert.strictEqual(h.ask.escape(), true);
    assert.strictEqual(await answer, "no");
    assert.ok(!h.ask.active());
  }
  {
    const { h, answer } = await permitCard();
    await h.ask.tap();
    assert.strictEqual(await answer, "no");
    assert.ok(!h.ask.active(), "the gesture while it is up means stop");
    assert.strictEqual(h.starts(), 1);
    assert.deepStrictEqual(h.allowed, []);
  }
});

/** A stand-in for Electron's nativeImage: a picture is only its size, and
 *  what was done to it is written down. */
function fakeImages() {
  const done = [];
  const image = (w, h) => ({
    isEmpty: () => w === 0,
    getSize: () => ({ width: w, height: h }),
    crop: (r) => { done.push(["crop", r]); return image(r.width, r.height); },
    resize: (o) => {
      done.push(["resize", o]);
      const width = o.width || Math.round(w * (o.height / h)), height = o.height || Math.round(h * (o.width / w));
      return image(width, height);
    },
    toJPEG: (q) => { done.push(["jpeg", q, w, h]); return Buffer.from([0xff, 0xd8, w & 255, h & 255]); },
  });
  return { done, nativeImage: { createFromBuffer: (buf) => { done.push(["decode", buf.toString()]); return buf.length ? image(2400, 1600) : image(0, 0); } } };
}
// The window at [100, 40] 1200 x 800 in the driver's units, captured at 2x.
const LOOK = { ok: true, window: { frame: [100, 40, 1200, 800] }, image: { mime: "image/jpeg", data: Buffer.from("pic").toString("base64"), width: 2400, height: 1600 } };

test("crop: the frame mapped into the picture's own pixels, kept small, as a JPEG", () => {
  const f = fakeImages();
  const h = harness({ nativeImage: f.nativeImage });
  const out = h.deps().crop(LOOK, [400, 240, 300, 200]);
  assert.strictEqual(out.mime, "image/jpeg");
  assert.ok(Buffer.isBuffer(out.data) && out.data.length > 0);
  assert.deepStrictEqual(f.done, [
    ["decode", "pic"],
    ["crop", { x: 600, y: 400, width: 600, height: 400 }],
    ["jpeg", 82, 600, 400],
  ]);
});

test("crop: the whole window, scaled down to pictureMaxSide on its long side", () => {
  const f = fakeImages();
  const h = harness({ nativeImage: f.nativeImage });
  h.deps().crop(LOOK, [100, 40, 1200, 800]);
  assert.deepStrictEqual(f.done.slice(1), [["resize", { width: 1024, quality: "good" }], ["jpeg", 82, 1024, 683]]);
  // A tall picture is held by its height.
  const g = fakeImages();
  harness({ nativeImage: g.nativeImage, knobs: { "desktop.agent.pictureMaxSide": 500 } }).deps().crop(LOOK, [100, 40, 300, 800]);
  assert.deepStrictEqual(g.done[2], ["resize", { height: 500, quality: "good" }]);
});

test("crop: a frame off the window, or a sliver of one, is the whole window; nothing to crop is null", () => {
  const f = fakeImages();
  const h = harness({ nativeImage: f.nativeImage });
  assert.ok(h.deps().crop(LOOK, [3000, 3000, 50, 50]));
  assert.ok(h.deps().crop(LOOK, [400, 240, 2, 300]));
  assert.ok(!f.done.some((d) => d[0] === "crop"), "never a crop of nothing");
  // Part of it off the window's edge: only the part on it.
  h.deps().crop(LOOK, [1200, 700, 400, 400]);
  assert.deepStrictEqual(f.done.find((d) => d[0] === "crop")[1], { x: 2200, y: 1320, width: 200, height: 280 });
  assert.strictEqual(h.deps().crop({ ok: true, window: LOOK.window, image: null }, [400, 240, 300, 200]), null);
  assert.strictEqual(h.deps().crop(null, [400, 240, 300, 200]), null);
  assert.strictEqual(harness().deps().crop(LOOK, [400, 240, 300, 200]), null, "no nativeImage, no picture");
});

// ---- the guide's new messages ------------------------------------------------------

test("a tentative ring, an answer that grows, and the badge reach the guide as such", async () => {
  const h = harness({ knobs: { "desktop.agent.doneMs": 5000 } });
  await h.ask.tap();
  await until(() => h.types().includes("show"));
  // Stopped: nothing is said while the question's microphone is open.
  await h.ask.tap();
  const g = h.deps().guide;
  g.point([1100, 60, 80, 30], "Export", { tentative: true });
  g.point([1100, 60, 80, 30], "Export");
  g.say("It's the area under the curve.", { speak: true });
  g.say("The answer is a third.", { speak: true, append: true });
  g.badge("1 picture sent");
  const points = h.sent.filter((m) => m.type === "point");
  assert.deepStrictEqual(points[0], { type: "point", frame: [1000, 20, 80, 30], caption: "Export", tentative: true });
  assert.strictEqual(points[1].tentative, undefined, "the answer's own ring is not tentative");
  const says = h.sent.filter((m) => m.type === "say");
  assert.deepStrictEqual(says.slice(-2), [
    { type: "say", text: "It's the area under the curve." },
    { type: "say", text: "The answer is a third.", append: true },
  ]);
  assert.deepStrictEqual(h.sent.find((m) => m.type === "badge"), { type: "badge", text: "1 picture sent" });
  // Each appended sentence is said after the one before it.
  await until(() => h.sent.filter((m) => m.type === "voice").length === 2);
  assert.deepStrictEqual(h.sent.filter((m) => m.type === "voice").map((m) => m.text), ["It's the area under the curve.", "The answer is a third."]);
  h.ask.cancel("test over");
});

test("the run is handed the picture path: whether, the card, the crop", () => {
  const d = harness().deps();
  assert.strictEqual(typeof d.pictures, "function");
  assert.strictEqual(typeof d.permit, "function");
  assert.strictEqual(typeof d.crop, "function");
});

// ---- the whole instant layer, through agent.js ---------------------------------------

test("instant: the words ring Export while they are said, and the answer comes with no request", async () => {
  const h = harness({ knobs: { "desktop.agent.finalTextMs": 1000, "desktop.agent.doneMs": 5000 } });
  await h.ask.tap();
  const sid = h.lastSession();
  // The screen has been read by the time they get to the word.
  await sleep(20);
  h.ask.partial({ session: sid, text: "where's the export" });
  await until(() => h.sent.some((m) => m.type === "point" && m.tentative));
  assert.deepStrictEqual(h.sent.find((m) => m.type === "point").frame, [1100 - WORK.x, 60 - WORK.y, 80, 30]);
  await h.ask.tap();   // they stop
  h.ask.audioIn({ session: sid, mime: "audio/webm", data: new Uint8Array([1]).buffer, text: "where's the export" });
  h.ask.textIn({ session: sid, text: "where's the export button", final: true });
  await until(() => h.sent.some((m) => m.type === "point" && !m.tentative));
  assert.strictEqual(h.requests.length, 0, "answered here, with no /v1/agent call");
  assert.ok(h.said(/Export/));
});

test("text: the stream's words go as the utterance, with no audio to transcribe", async () => {
  const h = harness({ knobs: { "desktop.agent.finalTextMs": 1000 } });
  await h.ask.tap();
  const sid = h.lastSession();
  h.ask.audioIn({ session: sid, mime: "audio/webm", data: new Uint8Array([1]).buffer, text: "what does this error mean" });
  h.ask.textIn({ session: sid, text: "what does this error mean", final: true });
  await until(() => h.requests.length === 1);
  assert.strictEqual(h.requests[0].multipart, false);
  assert.strictEqual(h.requests[0].req.utterance, "what does this error mean");
  h.ask.cancel("test over");
});

// ---- the whole picture layer, through agent.js ---------------------------------------
// The window as both reads have it: its tree with an equation drawn in it
// (an image with no words, under the pointer at Alt twice), and its look:
// the title as a line of OCR at the top, a line of the page, and the
// window's whole picture. Only the equation's crop may leave, and only once
// the card says so; the title, the frames and the rest of the picture never.
const PIC_SNAP = Object.assign({}, SNAP, {
  window: { frame: [100, 40, 1200, 800], title: "Q3 launch — Keynote" },
  elements: SNAP.elements.concat([{ id: "e3", role: "image", label: "", frame: [400, 240, 300, 200] }]),
});
const PIC_LOOK = {
  ok: true, scale: "points", ms: 20,
  window: { frame: [100, 40, 1200, 800], title: "Q3 launch — Keynote" },
  lines: [
    { text: "Q3 launch — Keynote", frame: [600, 46, 220, 16], conf: 0.95 },
    { text: "Mockups, round two", frame: [320, 140, 220, 22], conf: 0.93 },
  ],
  image: { mime: "image/jpeg", data: Buffer.from("the whole window").toString("base64"), width: 2400, height: 1600 },
};
const PIC_ANSWER = [[
  { t: "heard", text: "explain this equation", mode: "show" },
  { t: "say", text: "It's the area under x² from 0 to 1." },
  { t: "say", text: "That's a third.", append: true },
  { t: "done" },
]];

/** "Explain this equation", said and streamed, the pointer on the equation. */
async function pictureQuestion(opts) {
  const f = fakeImages();
  const h = harness(Object.assign({
    snap: PIC_SNAP, look: PIC_LOOK, nativeImage: f.nativeImage, steps: PIC_ANSWER,
    knobs: { "desktop.agent.finalTextMs": 1000, "desktop.agent.doneMs": 5000 },
  }, opts));
  await h.ask.tap();
  const sid = h.lastSession();
  await sleep(20);      // the screen has been read, both ways
  await h.ask.tap();    // they stop
  h.ask.audioIn({ session: sid, mime: "audio/webm", data: new Uint8Array([1, 2, 3]).buffer, text: "explain this equation" });
  h.ask.textIn({ session: sid, text: "explain this equation", final: true });
  return { h, f };
}
/** Nothing of the window but what is allowed: no title, no frame, no picture
 *  of it but the one part, wherever in the request it might have gone. */
function assertNothingOfTheWindow(r) {
  const json = typeof r.raw === "string" ? r.raw : "";
  assert.ok(!/Q3 launch/.test(json), "the window's title never leaves, as text or as a line read off it");
  assert.ok(!/"frame"/.test(json), "no frame leaves");
  assert.ok(!json.includes(PIC_LOOK.image.data) && !/whole window/.test(json), "the window's picture never goes as text");
  for (const v of Object.values(r.parts)) {
    if (typeof v === "string") continue;
    assert.ok(!v.bytes.toString("latin1").includes("the whole window"), "nor as a part");
  }
}

test("picture: Allow once sends one crop of the equation with the words, and the answer grows", async () => {
  const { h, f } = await pictureQuestion();
  await until(() => h.types().includes("permission"));
  assert.strictEqual(h.requests.length, 0, "nothing goes while the card asks");
  const card = h.sent.find((m) => m.type === "permission");
  assert.strictEqual(card.app, "Keynote");
  h.ipc.emit("guide:permit", { sender: h.windows[0].webContents }, "once");
  await until(() => h.requests.length === 1 && h.sent.some((m) => m.type === "state" && m.state === "done"));
  const r = h.requests[0];
  assert.ok(r.multipart, "the picture goes as a part");
  assert.deepStrictEqual(Object.keys(r.parts).sort(), ["image", "request"], "the words went, not the recording");
  assert.strictEqual(r.parts.image.name, "picture.jpg");
  assert.strictEqual(r.parts.image.type, "image/jpeg");
  // The equation, at the look's 2x: [400, 240, 300, 200] in the window at
  // [100, 40] is 600 x 400 from (600, 400) in the picture.
  assert.deepStrictEqual(f.done.slice(0, 2), [["decode", "the whole window"], ["crop", { x: 600, y: 400, width: 600, height: 400 }]]);
  assert.deepStrictEqual(r.parts.image.bytes, Buffer.from([0xff, 0xd8, 600 & 255, 400 & 255]));
  assert.strictEqual(r.req.utterance, "explain this equation");
  assert.deepStrictEqual(r.req.picture, { region: "element" });
  // The page's line read off the window goes as text; the title's does not.
  assert.ok(r.req.screen.elements.some((e) => e.role === "text" && e.label === "Mockups, round two" && /^o\d+$/.test(e.id)));
  assertNothingOfTheWindow(r);
  // On screen: "Looking" lightly round the equation, the badge, then the
  // answer a sentence at a time.
  const looking = h.sent.find((m) => m.type === "point" && m.tentative);
  assert.deepStrictEqual(looking, { type: "point", frame: [400 - WORK.x, 240 - WORK.y, 300, 200], caption: "Looking", tentative: true });
  assert.ok(h.sent.some((m) => m.type === "badge" && m.text === "1 picture sent"));
  const says = h.sent.filter((m) => m.type === "say");
  assert.deepStrictEqual(says.map((m) => [m.text, !!m.append]), [["It's the area under x² from 0 to 1.", false], ["That's a third.", true]]);
  assert.deepStrictEqual(h.allowed, [], "Allow once is not remembered");
});

test("picture: Not now asks from the words alone, with nothing of the picture", async () => {
  const { h, f } = await pictureQuestion();
  await until(() => h.types().includes("permission"));
  h.ipc.emit("guide:permit", { sender: h.windows[0].webContents }, "no");
  await until(() => h.requests.length === 1);
  const r = h.requests[0];
  assert.strictEqual(r.multipart, false, "plain JSON: no picture, no recording");
  assert.strictEqual(r.req.utterance, "explain this equation");
  assert.ok(!("picture" in r.req));
  assertNothingOfTheWindow(r);
  assert.ok(!h.types().includes("badge"), "no picture sent, and the card does not say one was");
  // The crop was made here first (so a card never asks about a picture there
  // is not), and went nowhere.
  assert.ok(f.done.some((d) => d[0] === "crop"));
  h.ask.cancel("test over");
});

test("picture: a card nobody answers is no, and it stops asking before the answer comes", async () => {
  const { h } = await pictureQuestion({ knobs: { "desktop.agent.finalTextMs": 1000, "desktop.agent.doneMs": 5000, "desktop.agent.confirmMs": 40 } });
  await until(() => h.requests.length === 1);
  assert.strictEqual(h.requests[0].multipart, false);
  assert.ok(!("picture" in h.requests[0].req));
  // The card was taken off its question before anything of the answer.
  const i = h.sent.findIndex((m) => m.type === "permission");
  const next = h.sent.slice(i + 1).find((m) => m.type === "state" || m.type === "say");
  assert.deepStrictEqual(next, { type: "state", state: "thinking" });
  h.ask.cancel("test over");
});

test("picture: an app said Always to sends with no card; pictures never sends none and asks nothing", async () => {
  {
    const { h } = await pictureQuestion({ allowed: ["keynote"] });
    await until(() => h.requests.length === 1);
    assert.ok(!h.types().includes("permission"), "no card for an app already allowed");
    assert.strictEqual(h.requests[0].parts.image.type, "image/jpeg");
    assertNothingOfTheWindow(h.requests[0]);
    h.ask.cancel("test over");
  }
  {
    const { h, f } = await pictureQuestion({ knobs: { "desktop.agent.finalTextMs": 1000, "desktop.agent.doneMs": 5000, "desktop.agent.pictures": "never" } });
    await until(() => h.requests.length === 1);
    assert.ok(!h.types().includes("permission"));
    assert.strictEqual(h.requests[0].multipart, false);
    assert.ok(!f.done.some((d) => d[0] === "crop"), "not even cropped");
    h.ask.cancel("test over");
  }
});

test("picture: Always for an app with a long name is remembered by that whole name", async () => {
  const name = "Microsoft PowerPoint — Presenter View (Extended Display)";   // 56 characters
  const { h } = await pictureQuestion({ info: { label: name } });
  await until(() => h.types().includes("permission"));
  assert.strictEqual(h.sent.find((m) => m.type === "permission").app, name);
  h.ipc.emit("guide:permit", { sender: h.windows[0].webContents }, "always");
  await until(() => h.requests.length === 1);
  assert.deepStrictEqual(h.allowed, [name]);
  assert.strictEqual(h.deps().pictures(name), "always", "next time, no card");
  h.ask.cancel("test over");
});

test("a private window's picture is never cropped, asked about or sent", async () => {
  const { h, f } = await pictureQuestion({ info: { label: "Safari", private: true } });
  await sleep(60);
  assert.strictEqual(h.requests.length, 0);
  assert.ok(!h.types().includes("permission"));
  assert.ok(!f.done.length, "not even decoded");
});

test("a clip that never comes back, with the stream's final text already in, answers from that final text", async () => {
  const h = harness({ knobs: { "desktop.agent.clipWaitMs": 30 } });
  await h.ask.tap();
  const sid = h.lastSession();
  h.ask.partial({ session: sid, text: "what's th" });
  await h.ask.tap();   // stop: the clip is due, and never comes
  h.ask.textIn({ session: sid, text: "what's this error", final: true });
  await until(() => h.heardCalls().length === 1, 1000);
  assert.deepStrictEqual(h.heardCalls()[0].slice(1), [null, { text: "what's this error", final: true }]);
  h.ask.cancel("test over");
});

// ---- the recorder's side of a question (recorder.js, in a page of its own) ----------
// recorder.js has no tests of its own; what it hands Ask is tested here, run
// in a VM with a fake microphone, MediaRecorder, caption stream and meter.
// `out` is every message it sent the main process, in order. Plain
// dictation is run through the same page, to show it is as it was.
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const RECORDER_JS = fs.readFileSync(path.join(__dirname, "recorder.js"), "utf8");

function recorderPage(o = {}) {
  const opts = Object.assign({ voiced: true, finalText: "", done: true }, o);
  const out = [], on = {}, sockets = [], fetches = [];
  // Its timers never keep the test process alive.
  const soft = (t) => { if (t && t.unref) t.unref(); return t; };
  class FakeWS {
    constructor(url) {
      this.url = url; this.readyState = 0; this.sent = []; sockets.push(this);
      soft(setTimeout(() => { if (this.readyState !== 0) return; this.readyState = 1; if (this.onopen) this.onopen(); }, 1));
    }
    send(m) {
      this.sent.push(m);
      if (typeof m !== "string" || JSON.parse(m).type !== "stop" || !opts.done) return;
      // The server's last words on it, then its end.
      soft(setTimeout(() => { if (opts.finalText) this.say({ type: "final", text: opts.finalText }); }, 4));
      soft(setTimeout(() => this.say({ type: "done" }), 8));
    }
    close() { this.readyState = 3; }
    say(m) { if (this.onmessage) this.onmessage({ data: JSON.stringify(m) }); }
  }
  class FakeMR {
    constructor() { this.state = "inactive"; this.mimeType = "audio/webm;codecs=opus"; }
    start() { this.state = "recording"; }
    stop() {
      if (opts.stopThrows) throw new Error("InvalidStateError");
      this.state = "inactive";
      soft(setTimeout(() => { if (this.ondataavailable) this.ondataavailable({ data: new Blob(["abc"]) }); if (this.onstop) this.onstop(); }, 3));
    }
    static isTypeSupported() { return true; }
  }
  // The audio clock moves, so the meter reads what arrived; whether it hears
  // a voice in it is the test's to say.
  const t0 = Date.now();
  class FakeAC {
    constructor() { this.sampleRate = 48000; this.destination = {}; }
    get currentTime() { return (Date.now() - t0) / 1000; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() { return { connect() {}, disconnect() {} }; }
    createAnalyser() { return { connect() {}, fftSize: 2048, frequencyBinCount: 1024, getByteFrequencyData() {}, getFloatTimeDomainData() {} }; }
    close() {}
  }
  const tz = { token: async () => "tok" };
  for (const k of ["onStart", "onTarget", "onField", "onAround", "onStop", "onCancel"]) tz[k] = (cb) => { on[k] = cb; };
  // Copied out of the page's realm, so they compare as plain objects here.
  for (const k of ["segment", "idle", "result", "askAudio", "askPause", "askText", "error", "partial"]) tz[k] = (p) => out.push([k, p && typeof p === "object" ? Object.assign({}, p) : p]);
  const meter = () => ({ feed: () => ({ voicedMs: opts.voiced ? 500 : 0, loudMs: opts.voiced ? 500 : 0 }) });
  const win = { tailzu: tz, TailzuKnobs: require("./knobs.js"), TailzuSpeech: { createSpeechMeter: meter }, AudioContext: FakeAC, MediaRecorder: FakeMR };
  const page = vm.createContext({
    window: win,
    navigator: { platform: "Linux x86_64", mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
    MediaRecorder: FakeMR, WebSocket: FakeWS, AudioContext: FakeAC,
    Blob, FormData, AbortController, Response, console,
    setTimeout: (f, ms, ...a) => soft(setTimeout(f, ms, ...a)), clearTimeout,
    setInterval: (f, ms, ...a) => soft(setInterval(f, ms, ...a)), clearInterval,
    fetch: async (url, init) => {
      fetches.push(String(url));
      return new Response(JSON.stringify({ cleanedText: "Hello there.", transcript: "hello there" }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  vm.runInContext(RECORDER_JS, page);
  return {
    out, fetches, sockets,
    ws: () => sockets[sockets.length - 1],
    start: (p) => on.onStart(Object.assign({ baseUrl: "https://api.test", pauseFlush: false }, p)),
    stop: (session) => on.onStop({ session }),
    end: () => on.onCancel({}),
    kinds: () => out.map(([k]) => k),
    get: (k) => out.filter(([x]) => x === k).map(([, p]) => p),
  };
}
const bytesOf = (d) => (d ? d.byteLength : null);

test("recorder: a streamed question sends its partials, its clip with the stream's words, then the final text; nothing is written", async () => {
  const r = recorderPage({ finalText: "where's the export button" });
  r.start({ session: 7, live: true, mode: "ask" });
  await sleep(15);
  assert.ok(r.ws(), "the question went to the caption stream");
  assert.ok(r.ws().url.endsWith("/v1/transcribe-stream"));
  r.ws().say({ type: "partial", text: "where's the export" });
  assert.deepStrictEqual(r.get("partial"), [{ session: 7, text: "where's the export" }]);
  r.stop(7);
  await until(() => r.get("askText").length === 1, 1000);
  const [clip] = r.get("askAudio");
  assert.strictEqual(clip.session, 7);
  assert.strictEqual(bytesOf(clip.data), 3, "the whole clip, kept beside the stream");
  assert.strictEqual(clip.text, "where's the export", "the stream's words as of the clip");
  assert.deepStrictEqual(r.get("askText"), [{ session: 7, text: "where's the export button", final: true }]);
  assert.strictEqual(r.get("askAudio").length, 1);
  assert.deepStrictEqual(r.fetches, [], "a question is never sent to be written");
  assert.ok(!r.kinds().some((k) => k === "result" || k === "segment" || k === "error"));
  r.end();
});

test("recorder: a question whose stream dropped while it was said still hands over its clip, and its final text at once", async () => {
  const r = recorderPage();
  r.start({ session: 9, live: true, mode: "ask" });
  await sleep(15);
  r.ws().say({ type: "partial", text: "what's this" });
  r.ws().onclose();    // the stream went; the recording goes on
  r.stop(9);
  await until(() => r.get("askAudio").length === 1 && r.get("askText").length === 1, 1000);
  assert.strictEqual(bytesOf(r.get("askAudio")[0].data), 3);
  assert.strictEqual(r.get("askAudio")[0].text, "what's this");
  assert.deepStrictEqual(r.get("askText"), [{ session: 9, text: "what's this", final: true }]);
  assert.ok(!r.kinds().includes("error"), "nothing to tell them: the words were kept");
  r.end();
});

test("recorder: a stream error after the stop only means the final text is what it had", async () => {
  const r = recorderPage({ done: false });
  r.start({ session: 10, live: true, mode: "ask" });
  await sleep(15);
  r.ws().say({ type: "partial", text: "solve this" });
  r.stop(10);
  await sleep(10);
  r.ws().say({ type: "error", code: "upstream", message: "The stream broke." });
  await until(() => r.get("askText").length === 1, 1000);
  assert.deepStrictEqual(r.get("askText"), [{ session: 10, text: "solve this", final: true }]);
  assert.ok(!r.kinds().includes("error"));
  r.end();
});

test("recorder: a question with no voice in it hands over no audio and no words, whatever the stream made of it", async () => {
  const r = recorderPage({ voiced: false, finalText: "uh" });
  r.start({ session: 11, live: true, mode: "ask" });
  await sleep(15);
  r.ws().say({ type: "partial", text: "uh" });
  r.stop(11);
  await until(() => r.get("askText").length === 1 && r.get("askAudio").length === 1, 1000);
  assert.strictEqual(r.get("askAudio")[0].data, null);
  assert.strictEqual(r.get("askAudio")[0].text, "");
  assert.deepStrictEqual(r.get("askText"), [{ session: 11, text: "", final: true }]);
  r.end();
});

test("recorder: a recorder that will not stop hands the question over with the stream's words at once", async () => {
  const r = recorderPage({ stopThrows: true, finalText: "what does this chart show" });
  r.start({ session: 12, live: true, mode: "ask" });
  await sleep(15);
  r.ws().say({ type: "partial", text: "what does this chart" });
  r.stop(12);
  await until(() => r.get("askAudio").length === 1 && r.get("askText").length === 1, 1000);
  assert.deepStrictEqual([r.get("askAudio")[0].data, r.get("askAudio")[0].text], [null, "what does this chart"]);
  assert.strictEqual(r.get("askText")[0].text, "what does this chart show");
  r.end();
});

test("recorder: an ASK's reply records one clip with no stream, as before", async () => {
  const r = recorderPage();
  r.start({ session: 13, live: false, mode: "ask" });
  await sleep(15);
  r.stop(13);
  await until(() => r.get("askAudio").length === 1, 1000);
  assert.strictEqual(r.sockets.length, 0, "no caption stream");
  assert.strictEqual(bytesOf(r.get("askAudio")[0].data), 3);
  assert.strictEqual(r.get("askAudio")[0].text, "");
  await sleep(20);
  assert.deepStrictEqual(r.get("askText"), [], "no final text to wait for");
  assert.deepStrictEqual(r.fetches, []);
  r.end();
});

test("recorder: a live dictation is as it was: captions, the recording written once, nothing for Ask", async () => {
  const r = recorderPage({ finalText: "hello there" });
  r.start({ session: 14, live: true });
  await sleep(15);
  r.ws().say({ type: "partial", text: "hello" });
  r.stop(14);
  await until(() => r.get("result").length === 1, 1000);
  await sleep(20);
  // The captions, the stream's final words included.
  assert.deepStrictEqual(r.get("partial"), [{ session: 14, text: "hello" }, { session: 14, text: "hello there" }]);
  assert.deepStrictEqual(r.fetches, ["https://api.test/v1/transcribe-clean"]);
  assert.strictEqual(r.get("result")[0].text, "Hello there.");
  assert.ok(!r.kinds().some((k) => k === "askAudio" || k === "askText"));
  r.end();
});

test("recorder: a batch dictation is as it was", async () => {
  const r = recorderPage();
  r.start({ session: 15, live: false });
  await sleep(15);
  r.stop(15);
  await until(() => r.get("result").length === 1, 1000);
  assert.strictEqual(r.sockets.length, 0);
  assert.deepStrictEqual(r.fetches, ["https://api.test/v1/transcribe-clean"]);
  assert.ok(!r.kinds().some((k) => k === "askAudio" || k === "askText"));
  r.end();
});
