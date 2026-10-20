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
const { createAsk, pillAskMove, capsuleRect, createPeekWatch, createAskSetup } = require("./ask.js");
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
          // `sayMs`: how long each sentence takes it to say.
          if (m.type === "voice" && !opts.mute) {
            const spoke = () => ipc.emit("guide:spoken", { sender: self.webContents });
            if (opts.sayMs) setTimeout(spoke, opts.sayMs); else setImmediate(spoke);
          }
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
    // The setup card's yes for every app (main.js localState.askPicturesAlwaysAll),
    // and what a look said about Screen Recording, when a test plays them.
    picturesAlwaysAll: opts.alwaysAll != null ? () => opts.alwaysAll : undefined,
    lookPermission: opts.lookPermission,
    screen: opts.screen || {
      getCursorScreenPoint: () => ({ x: 500, y: 400 }),
      getDisplayNearestPoint: () => ({ workArea: WORK }),
      screenToDipRect: (_w, r) => r,
    },
    ipcMain,
    // Words from the server, when a test sends some (`labels`).
    knobs: { num: pick, bool: pick, str: pick, txt: (k, f, v) => { const w = opts.labels && k in opts.labels ? opts.labels[k] : f; return v ? w.replace(/\{(\w+)\}/g, (m, n) => v[n] ?? m) : w; } },
    webPrefs: (x) => Object.assign({}, x),
    hardenWindow() {}, raisePill() {}, setBoundsExactly(w, b) { w.bounds = b; },
    // main.js's pillAsk, when a test plays the pill (fakePill).
    pillAsk: opts.pill ? opts.pill.pillAsk : undefined,
    driver,
    sendToRecorder: (ch, p) => { recorder.push([ch, p]); log.push("recorder:" + ch); },
    createRecorderWindow() {},
    recorderReady: () => true,
    nextSession: () => ++seq,
    recorderStart: (sid) => ({ session: sid, knobs: {} }),
    frontInfo: opts.frontInfo || (async () => opts.info || { label: "Keynote", pictureKey: "Keynote" }),
    dictating: () => !!opts.dictating,
    names: opts.names,
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
    screenSettings: opts.screenSettings,
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

// An answer that came a sentence at a time, far faster than it is said.
const LONG_ANSWER = [[
  { t: "heard", text: "explain this equation, step by step", mode: "show" },
  { t: "say", text: "S1." }, { t: "say", text: "S2.", append: true }, { t: "say", text: "S3.", append: true },
  { t: "say", text: "S4.", append: true }, { t: "say", text: "S5.", append: true }, { t: "say", text: "S6.", append: true },
  { t: "done" },
]];

test("a long answer is said to its end before its card goes: doneMs counts from the last sentence said", async () => {
  const h = harness({ steps: LONG_ANSWER, sayMs: 40, knobs: { "desktop.agent.doneMs": 30 } });
  await h.ask.tap();
  h.clip();
  await until(() => h.types().includes("hide"), 3000);
  assert.deepStrictEqual(h.sent.filter((m) => m.type === "voice").map((m) => m.text), ["S1.", "S2.", "S3.", "S4.", "S5.", "S6."]);
  const t = h.types();
  assert.ok(t.lastIndexOf("voice") < t.indexOf("hide"), t.join(","));
});

test("a finished answer's card still talking is shown(), and Esc puts it away and stops the voice", async () => {
  const h = harness({ steps: LONG_ANSWER, sayMs: 40, knobs: { "desktop.agent.doneMs": 5000 } });
  await h.ask.tap();
  h.clip();
  await until(() => h.sent.some((m) => m.type === "state" && m.state === "done"));
  assert.strictEqual(h.ask.active(), false, "the run is over");
  assert.strictEqual(h.ask.shown(), true, "its card is not: a dictation starting puts it away (main.js)");
  assert.strictEqual(h.ask.escape(), true);
  const voiced = h.sent.filter((m) => m.type === "voice").length;
  assert.ok(h.types().includes("hide"));
  assert.strictEqual(h.ask.shown(), false);
  await sleep(150);
  assert.strictEqual(h.sent.filter((m) => m.type === "voice").length, voiced, "nothing more said");
});

test("nothing is said while a dictation records: its microphone would write it down", async () => {
  const opts = { steps: LONG_ANSWER, sayMs: 40, knobs: { "desktop.agent.doneMs": 5000 } };
  const h = harness(opts);
  await h.ask.tap();
  h.clip();
  await until(() => h.sent.some((m) => m.type === "voice"));
  opts.dictating = true;
  const voiced = h.sent.filter((m) => m.type === "voice").length;
  await sleep(250);
  assert.strictEqual(h.sent.filter((m) => m.type === "voice").length, voiced);
  h.ask.cancel("test over");
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

/** A question begun about the app in front (`info`), and its card up. */
async function begun(opts) {
  const h = harness(Object.assign({ knobs: { "desktop.agent.doneMs": 5000 } }, opts));
  await h.ask.tap();
  await until(() => h.types().includes("show"));
  return h;
}

test("pictures: never by the knob; always only for the question's app, said yes to on this computer; else ask", async () => {
  {
    const h = harness({ allowed: ["Keynote"] });
    assert.strictEqual(h.deps().pictures("Keynote"), "ask", "no question yet: no app to have said yes to");
  }
  {
    const h = await begun({ allowed: ["Keynote"] });
    const pictures = h.deps().pictures;
    assert.strictEqual(pictures("Keynote"), "always");
    assert.strictEqual(pictures("  keynote "), "always", "the app's name, however it is cased");
    assert.strictEqual(pictures("Safari"), "ask", "not the question's app");
    assert.strictEqual(pictures(""), "ask");
    h.ask.cancel("test over");
  }
  {
    // A browser's label is the page's title: nothing to remember Always by,
    // and a yes kept from before under that title is not one now.
    const h = await begun({ allowed: ["Chrome: Dashboard"], info: { label: "Chrome: Dashboard", pictureKey: null } });
    assert.strictEqual(h.deps().pictures("Chrome: Dashboard"), "ask");
    h.ask.cancel("test over");
  }
  {
    const h = await begun({ allowed: ["Keynote"], knobs: { "desktop.agent.pictures": "never" } });
    assert.strictEqual(h.deps().pictures("Keynote"), "never");
    h.ask.cancel("test over");
  }
  {
    // The server can turn pictures off; it can never skip the card.
    const h = await begun({ knobs: { "desktop.agent.pictures": "always" } });
    assert.strictEqual(h.deps().pictures("Keynote"), "ask");
    h.ask.cancel("test over");
  }
  assert.strictEqual(harness({ knobs: { "desktop.agent.pictures": "sometimes" } }).deps().pictures("Safari"), "ask", "a value it does not know asks");
});

test("a Mac that has not let Tailzu see the screen: the card says so, its one button opens Screen Recording and puts it away", async () => {
  // The real agent: a look refused for the permission, a text answer that
  // needs the picture (LOOK), and the card's words and button.
  const steps = [[{ t: "heard", text: "what does this graph show", mode: "show" }, { t: "look", why: "a chart" }], [{ t: "done" }]];
  const opened = [];
  const h = harness({ steps, look: { ok: false, error: "no_screen_permission" }, screenSettings: () => opened.push(1), knobs: { "desktop.agent.doneMs": 5000 } });
  await h.ask.tap();
  await until(() => h.types().includes("show"));
  h.clip();
  await until(() => h.types().includes("offer"));
  const offer = h.sent.find((m) => m.type === "offer");
  assert.deepStrictEqual(offer, { type: "offer", kind: "screenSettings", text: "Open Screen Recording settings" });
  assert.ok(h.said(/Screen Recording/), "the card says what to turn on");
  assert.strictEqual(h.requests.length, 1, "no picture went, nor a second step for one");
  const win = h.windows[0];
  // Not the guide's own window, or not the button it was given: nothing.
  h.ipc.emit("guide:offer", { sender: {} }, "screenSettings");
  h.ipc.emit("guide:offer", { sender: win.webContents }, "somethingElse");
  assert.deepStrictEqual(opened, []);
  assert.strictEqual(h.ask.shown(), true);
  h.ipc.emit("guide:offer", { sender: win.webContents }, "screenSettings");
  assert.deepStrictEqual(opened, [1], "opened once");
  assert.strictEqual(h.ask.shown(), false, "the card goes: the settings are over it");
  h.ipc.emit("guide:offer", { sender: win.webContents }, "screenSettings");
  assert.deepStrictEqual(opened, [1], "a second click is nothing");
});

test("no way to open the settings here (Windows): the words alone, no button", async () => {
  const steps = [[{ t: "heard", text: "what does this graph show", mode: "show" }, { t: "look", why: "a chart" }], [{ t: "done" }]];
  const h = harness({ steps, look: { ok: false, error: "no_screen_permission" }, knobs: { "desktop.agent.doneMs": 5000 } });
  await h.ask.tap();
  await until(() => h.types().includes("show"));
  h.clip();
  await until(() => h.said(/Screen Recording/));
  await sleep(20);
  assert.strictEqual(h.types().includes("offer"), false);
  h.ipc.emit("guide:offer", { sender: h.windows[0].webContents }, "screenSettings");
  assert.strictEqual(h.ask.shown(), true, "a click on a button never given is nothing");
  h.ask.cancel("test over");
});

async function permitCard(opts, about) {
  const h = await begun(opts);
  const app = (opts && opts.info && opts.info.label) || "Keynote";
  const answer = h.deps().permit(app, about);
  await until(() => h.types().includes("permission"));
  return { h, answer, win: h.windows[0] };
}

test("the picture card asks, with the app's name; Always remembers the app, Allow once does not", async () => {
  {
    const { h, answer, win } = await permitCard();
    const card = h.sent.find((m) => m.type === "permission");
    assert.strictEqual(card.app, "Keynote");
    assert.strictEqual(card.always, true);
    // One line, asking to see and nothing more: what goes where is the
    // privacy policy's to say, and no permission says send or picture.
    assert.strictEqual(card.text, "To answer that I need to see it.");
    assert.ok(!/\b(send|sent|picture|photo|screenshot)/i.test(card.text), card.text);
    h.ipc.emit("guide:permit", { sender: {} }, "always");   // not the guide's own window
    h.ipc.emit("guide:permit", { sender: win.webContents }, "always");
    assert.strictEqual(await answer, "always");
    assert.deepStrictEqual(h.allowed, ["Keynote"]);
    h.ask.cancel("test over");
  }
  {
    // The whole window has a knob of its own, worded the same by default.
    const { h, answer } = await permitCard(undefined, { region: "window" });
    assert.strictEqual(h.sent.find((m) => m.type === "permission").text, "To answer that I need to see it.");
    h.ask.cancel("test over");
    assert.strictEqual(await answer, "no");
  }
  {
    // Each card reads its own knob, so either can be reworded from the server.
    const labels = { "desktop.agent.permitText": "PART", "desktop.agent.permitWindowText": "WINDOW" };
    for (const [about, want] of [[undefined, "PART"], [{ region: "window" }, "WINDOW"], [{ region: "element" }, "PART"]]) {
      const { h, answer } = await permitCard({ labels }, about);
      assert.strictEqual(h.sent.find((m) => m.type === "permission").text, want, JSON.stringify(about));
      h.ask.cancel("test over");
      assert.strictEqual(await answer, "no");
    }
  }
  {
    // No key to remember it by (a browser's page): no Always on the card, and
    // an Always from a guide that still shows one is this once only.
    const { h, answer, win } = await permitCard({ info: { label: "Chrome: Dashboard", pictureKey: null } });
    const card = h.sent.find((m) => m.type === "permission");
    assert.strictEqual(card.app, "Chrome: Dashboard");
    assert.strictEqual(card.always, false);
    h.ipc.emit("guide:permit", { sender: win.webContents }, "always");
    assert.strictEqual(await answer, "once");
    assert.deepStrictEqual(h.allowed, [], "nothing remembered");
    h.ask.cancel("test over");
  }
  {
    // Remembered by the app's key, not by the label on the card.
    const { h, answer, win } = await permitCard({ info: { label: "Calculator", pictureKey: "Windows Calculator" } });
    h.ipc.emit("guide:permit", { sender: win.webContents }, "always");
    assert.strictEqual(await answer, "always");
    assert.deepStrictEqual(h.allowed, ["Windows Calculator"]);
    assert.strictEqual(h.deps().pictures("Calculator"), "always");
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
function fakeImages(width = 2400, height = 1600) {
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
  return { done, nativeImage: { createFromBuffer: (buf) => { done.push(["decode", buf.toString()]); return buf.length ? image(width, height) : image(0, 0); } } };
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

test("crop: a frame off the window, or too small in the picture to see, is no picture, never the whole window; nothing to crop is null", () => {
  const f = fakeImages();
  const h = harness({ nativeImage: f.nativeImage });
  assert.strictEqual(h.deps().crop(LOOK, [3000, 3000, 50, 50]), null);
  assert.strictEqual(h.deps().crop(LOOK, [400, 240, 2, 300]), null);
  assert.strictEqual(h.deps().crop(LOOK, [400, 240, 300]), null, "a frame that is not one");
  assert.ok(!f.done.some((d) => d[0] === "crop" || d[0] === "jpeg"), "never a crop of nothing, and nothing in its place");
  // An icon on a 4K window whose look came at 1600 px: 16 x 16 in the
  // driver's units is under 8 px of the picture. The whole window in its
  // place sent the title bar and the address bar with it.
  const g = fakeImages(1600, 875);
  const wide = { ok: true, window: { frame: [0, 0, 3840, 2100] }, image: LOOK.image };
  assert.strictEqual(harness({ nativeImage: g.nativeImage }).deps().crop(wide, [120, 300, 16, 16]), null);
  assert.ok(!g.done.some((d) => d[0] === "jpeg"));
  // Part of it off the window's edge: only the part on it.
  h.deps().crop(LOOK, [1200, 700, 400, 400]);
  assert.deepStrictEqual(f.done.find((d) => d[0] === "crop")[1], { x: 2200, y: 1320, width: 200, height: 280 });
  assert.strictEqual(h.deps().crop({ ok: true, window: LOOK.window, image: null }, [400, 240, 300, 200]), null);
  assert.strictEqual(h.deps().crop(null, [400, 240, 300, 200]), null);
  assert.strictEqual(harness().deps().crop(LOOK, [400, 240, 300, 200]), null, "no nativeImage, no picture");
});

test("crop: says which part of the window the picture shows, for the answer's marks in it", () => {
  const h = harness({ nativeImage: fakeImages().nativeImage });
  // What was asked for.
  assert.deepStrictEqual(h.deps().crop(LOOK, [400, 240, 300, 200]).frame, [400, 240, 300, 200]);
  // Cut to the window.
  assert.deepStrictEqual(h.deps().crop(LOOK, [1200, 700, 400, 400]).frame, [1200, 700, 100, 140]);
  // No frame at all: the whole window went, and its marks are places in
  // the whole window.
  assert.deepStrictEqual(h.deps().crop(LOOK, null).frame, [100, 40, 1200, 800]);
  // The window's own frame is never handed out to be changed.
  const out = h.deps().crop(LOOK, null);
  out.frame[0] = -1;
  assert.deepStrictEqual(LOOK.window.frame, [100, 40, 1200, 800]);
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

test("instant: the name they gave it is taken off the front, as its own is", async () => {
  const h = harness({ names: () => ["Tailzu", "Blip", "Jarvis"], knobs: { "desktop.agent.finalTextMs": 1000, "desktop.agent.doneMs": 5000 } });
  await h.ask.tap();
  const sid = h.lastSession();
  await sleep(20);
  h.ask.partial({ session: sid, text: "Jarvis, where's the export" });
  await until(() => h.sent.some((m) => m.type === "point" && m.tentative));
  await h.ask.tap();
  h.ask.audioIn({ session: sid, mime: "audio/webm", data: new Uint8Array([1]).buffer, text: "Jarvis, where's the export" });
  h.ask.textIn({ session: sid, text: "Jarvis, where's the export button", final: true });
  await until(() => h.sent.some((m) => m.type === "point" && !m.tentative));
  assert.strictEqual(h.requests.length, 0, "answered here, with no /v1/agent call");
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

test("picture: with no image to send alone, the card says the whole window, ringed on screen before it asks", async () => {
  const { h } = await pictureQuestion({ snap: Object.assign({}, PIC_SNAP, { elements: SNAP.elements }), labels: { "desktop.agent.permitWindowText": "WHOLE WINDOW" } });
  await until(() => h.types().includes("permission"));
  const card = h.sent.findIndex((m) => m.type === "permission");
  // The whole window's own knob (desktop.agent.permitWindowText).
  assert.strictEqual(h.sent[card].text, "WHOLE WINDOW");
  const ring = h.sent.findIndex((m) => m.type === "point" && m.tentative);
  assert.ok(ring !== -1 && ring < card, "what would go is on screen while the card asks");
  h.ipc.emit("guide:permit", { sender: h.windows[0].webContents }, "once");
  await until(() => h.requests.length === 1);
  assert.deepStrictEqual(h.requests[0].req.picture, { region: "window" });
  h.ask.cancel("test over");
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
  const { h } = await pictureQuestion({ info: { label: name, pictureKey: name } });
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
  const out = [], on = {}, sockets = [], fetches = [], procs = [];
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
    createScriptProcessor() { const p = { connect() {}, disconnect() {} }; procs.push(p); return p; }
    createAnalyser() { return { connect() {}, fftSize: 2048, frequencyBinCount: 1024, getByteFrequencyData() {}, getFloatTimeDomainData() {} }; }
    close() {}
  }
  // The main process's token (recorder:token): `opts.token` plays it.
  const tz = { token: opts.token || (async () => "tok") };
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
    // A frame of the microphone's audio, as the audio graph hands it over.
    audio: () => { const p = procs[procs.length - 1]; if (p && p.onaudioprocess) p.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4096) } }); },
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

test("recorder: the stream starts with the token as it is now, renewed when spent; what was said meanwhile, and a stop, go after the start", async () => {
  let release;
  const asked = [];
  // A token spent while the laptop slept: renewing it takes a moment.
  const r = recorderPage({ token: (renew) => { asked.push(renew); return new Promise((res) => { release = () => res("fresh"); }); } });
  r.start({ session: 7, live: true, mode: "ask", token: "spent" });
  await until(() => r.sockets.length === 1 && r.ws().readyState === 1 && release);
  r.audio(); r.audio();
  assert.deepStrictEqual(r.ws().sent, [], "nothing goes before the start: the server would drop it");
  r.stop(7);
  release();
  await until(() => r.ws().sent.length >= 4);
  const sent = r.ws().sent;
  const start = JSON.parse(sent[0]);
  assert.strictEqual(start.type, "start");
  assert.strictEqual(start.token, "fresh", "not the spent one it was started with");
  assert.strictEqual(start.purpose, "ask");
  assert.deepStrictEqual(asked, [false], "renewed only if spent: main decides");
  assert.ok([sent[1], sent[2]].every((f) => typeof f !== "string" && f.byteLength > 0), "the audio held for it, then");
  assert.strictEqual(JSON.parse(sent[3]).type, "stop", "the stop after it all");
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

// ---- v3: the card grows out of the pill ---------------------------------------------

// main.js's pillAsk, played by main's own rules (ask.js pillAskMove and
// capsuleRect) over a pill window at the foot of the work area: every phase
// the question asked of it, and what the pill is doing now.
const PILL_KNOBS = { num: (k, f) => f, bool: (k, f) => f };
function fakePill(o = {}) {
  const p = {
    state: "rest", phase: null, recording: false, calls: [], moved: 0, on: o.on !== false,
    bounds: o.bounds || { x: WORK.x, y: WORK.y + WORK.height - 132 - 4, width: WORK.width, height: 132 },
  };
  p.pillAsk = (phase, first) => {
    p.calls.push(phase);
    if (!p.on) return null;
    const move = pillAskMove(phase, { state: p.state, recording: p.recording, first });
    if (!move) return null;
    if (move === "rest") { p.state = "rest"; p.phase = null; return null; }
    // Put under the cursor: on the display it is on now (o.under).
    if (move === "take") { p.moved++; if (o.under) p.bounds = o.under(); }
    p.state = "ask"; p.phase = phase;
    return capsuleRect(p.bounds, PILL_KNOBS);
  };
  // What toggleDictation does to the pill when a dictation starts.
  p.dictate = () => { p.recording = true; p.state = "listening"; p.phase = null; };
  return p;
}
// The capsule of that pill (40 x 16, 14 above the window's foot), in the
// guide window's own coordinates (the window over WORK).
const DOCK = { x: 780 - WORK.x, y: 866 - WORK.y, w: 40, h: 16 };
const docks = (h) => h.sent.filter((m) => m.type === "dock").map((m) => Object.assign({}, m, { type: undefined }));
const FAST = { "desktop.guide.foldMs": 40, "desktop.agent.doneMs": 30 };

test("pillAskMove: dictation always wins the pill; closing and giving it back touch only a pill still the question's", () => {
  for (const phase of ["listening", "thinking", "showing", "closing", null]) {
    assert.strictEqual(pillAskMove(phase, { state: "rest", recording: true }), null, `recording, ${phase}`);
    assert.strictEqual(pillAskMove(phase, { state: "listening" }), null, `dictation listening, ${phase}`);
    assert.strictEqual(pillAskMove(phase, { state: "writing" }), null, `dictation writing, ${phase}`);
  }
  // The first phase takes the pill (and main puts it on the cursor's display first).
  assert.strictEqual(pillAskMove("listening", { state: "rest" }), "take");
  assert.strictEqual(pillAskMove("showing", { state: "error" }), "take");
  assert.strictEqual(pillAskMove("thinking", { state: "done" }), "take");
  // The next ones only move it on.
  assert.strictEqual(pillAskMove("thinking", { state: "ask" }), "ask");
  assert.strictEqual(pillAskMove("closing", { state: "ask" }), "ask");
  assert.strictEqual(pillAskMove(null, { state: "ask" }), "rest");
  // A new question's first phase while the last card still has it (up, or
  // folding) puts it under the cursor again; dictation still wins.
  assert.strictEqual(pillAskMove("listening", { state: "ask", first: true }), "take");
  assert.strictEqual(pillAskMove("closing", { state: "ask", first: true }), "ask");
  assert.strictEqual(pillAskMove("listening", { state: "listening", first: true }), null);
  assert.strictEqual(pillAskMove("listening", { state: "ask", recording: true, first: true }), null);
  // Not the question's: closing and letting go leave it as it is.
  assert.strictEqual(pillAskMove("closing", { state: "rest" }), null);
  assert.strictEqual(pillAskMove(null, { state: "rest" }), null);
  assert.strictEqual(pillAskMove(null, { state: "done" }), null);
  assert.strictEqual(pillAskMove("dancing", { state: "ask" }), null);
});

test("capsuleRect: the capsule centred across the pill window, bottomPad above its foot, from pill.js's knobs", () => {
  const b = { x: 100, y: 764, width: 1400, height: 132 };
  assert.deepStrictEqual(capsuleRect(b, PILL_KNOBS), { x: 780, y: 866, w: 40, h: 16 });
  const k = (flags) => ({ num: (n, f) => (n in flags ? flags[n] : f), bool: (n, f) => (n in flags ? flags[n] : f) });
  // The small pill's size without the capsule look (or without the split, which it needs).
  assert.deepStrictEqual(capsuleRect(b, k({ "desktop.pill.capsule": false })), { x: 777, y: 868, w: 46, h: 14 });
  assert.deepStrictEqual(capsuleRect(b, k({ "desktop.pill.split": false })), { x: 777, y: 868, w: 46, h: 14 });
  assert.deepStrictEqual(capsuleRect(b, k({ "desktop.pill.capsuleWidth": 50, "desktop.pill.capsuleHeight": 20, "desktop.pill.bottomPad": 10 })), { x: 775, y: 866, w: 50, h: 20 });
  assert.strictEqual(capsuleRect(null, PILL_KNOBS), null);
  assert.strictEqual(capsuleRect({ x: 0, y: 0, width: NaN, height: 10 }, PILL_KNOBS), null);
});

test("the card grows out of the pill: the pill parts first, the guide opens on its display and is told where it is before it shows", async () => {
  // The pointer has wandered onto a second display (B) since the pill was
  // put under it on the first (A): the card goes where the pill is.
  const A = { workArea: WORK, bounds: WORK };
  const B = { workArea: { x: 1500, y: 0, width: 1920, height: 1040 }, bounds: { x: 1500, y: 0, width: 1920, height: 1080 } };
  const pill = fakePill();
  const h = harness({ pill, screen: {
    getCursorScreenPoint: () => ({ x: 2000, y: 300 }),
    getDisplayNearestPoint: (p) => (p.x < 1500 ? A : B),
    screenToDipRect: (_w, r) => r,
  } });
  await h.ask.tap();
  await until(() => h.types().includes("show"));
  assert.deepStrictEqual(pill.calls, ["listening"]);
  assert.strictEqual(pill.moved, 1, "the first phase puts the pill under the cursor");
  const o = h.windows[0].o;
  assert.deepStrictEqual([o.x, o.y, o.width, o.height], [WORK.x, WORK.y, WORK.width, WORK.height], "on the pill's display");
  const t = h.types();
  assert.ok(t.indexOf("dock") !== -1 && t.indexOf("dock") < t.indexOf("show"), t.join(","));
  assert.deepStrictEqual(h.sent.find((m) => m.type === "dock").pill, DOCK);
  assert.strictEqual(h.types().filter((x) => x === "dock").length, 1, "told once");
});

test("the pill's phase follows the card: listening, thinking, showing; closing the moment it hides; given back once the fold is over", async () => {
  const pill = fakePill();
  const h = harness({ pill, knobs: { "desktop.guide.foldMs": 120, "desktop.agent.doneMs": 30 } });
  await h.ask.tap();
  h.clip();
  await until(() => pill.calls.includes("closing"));
  assert.deepStrictEqual(pill.calls, ["listening", "thinking", "showing", "closing"]);
  assert.strictEqual(pill.state, "ask");
  // The fold is still on screen: the window waits foldMs + 80 for it.
  await sleep(100);
  assert.strictEqual(h.windows[0].visible, true, "the card is still folding back into the pill");
  await until(() => pill.calls.length === 5, 1000);
  assert.strictEqual(h.windows[0].visible, false);
  assert.deepStrictEqual(pill.calls, ["listening", "thinking", "showing", "closing", null]);
  assert.strictEqual(pill.state, "rest");
});

test("an ASK's reply opens the microphone again: the bead goes back to listening", async () => {
  const pill = fakePill();
  const h = harness({ pill, knobs: FAST, steps: [
    [{ t: "heard", text: "tell them it's ready", mode: "do" }, { t: "ask", text: "Which channel?" }],
    [{ t: "done", text: "Okay." }],
  ] });
  await h.ask.tap();
  h.clip();
  await until(() => h.starts() === 2);
  assert.deepStrictEqual(pill.calls, ["listening", "thinking", "showing", "listening"]);
  h.clip();
  await until(() => pill.calls.includes(null), 2000);
  assert.deepStrictEqual(pill.calls, ["listening", "thinking", "showing", "listening", "thinking", "showing", "closing", null]);
});

test("a guess rung while they still talk leaves the bead listening; the answer's ring is showing", async () => {
  const pill = fakePill();
  const h = harness({ pill });
  await h.ask.tap();
  await until(() => h.types().includes("show"));
  const g = h.deps().guide;
  g.point([1100, 60, 80, 30], "", { tentative: true });
  assert.deepStrictEqual(pill.calls, ["listening"]);
  g.point([1100, 60, 80, 30], "Export");
  assert.deepStrictEqual(pill.calls, ["listening", "showing"]);
  h.ask.cancel("test");
});

test("a new question while the card folds turns it round: the same window, the pill never given back between", async () => {
  const pill = fakePill();
  const h = harness({ pill, knobs: { "desktop.guide.foldMs": 300, "desktop.agent.doneMs": 30 } });
  await h.ask.tap();
  h.clip();
  await until(() => pill.calls.includes("closing"));
  await h.ask.tap();
  await until(() => pill.calls.length === 5);
  assert.deepStrictEqual(pill.calls, ["listening", "thinking", "showing", "closing", "listening"]);
  assert.strictEqual(pill.moved, 2, "a new question's first phase: put under the cursor again, here the same display");
  await sleep(450);
  assert.ok(!pill.calls.includes(null), pill.calls.join(","));
  assert.strictEqual(h.windows.length, 1);
  assert.strictEqual(h.windows[0].visible, true);
  assert.strictEqual(pill.state, "ask");
  h.ask.cancel("test");
});

test("a new question while the last card is still up, the pointer now on another display: the pill and the card go there", async () => {
  const A = { workArea: WORK, bounds: WORK };
  const B = { workArea: { x: 1500, y: 0, width: 1920, height: 1040 }, bounds: { x: 1500, y: 0, width: 1920, height: 1080 } };
  let cursor = { x: 500, y: 400 };
  const displayAt = (p) => (p.x < 1500 ? A : B);
  // main's pillBounds: the foot of the work area under the cursor.
  const under = () => { const wa = displayAt(cursor).workArea; return { x: wa.x, y: wa.y + wa.height - 132 - 4, width: wa.width, height: 132 }; };
  const pill = fakePill({ under });
  const h = harness({ pill, platform: "darwin", knobs: { "desktop.agent.doneMs": 5000 }, screen: {
    getCursorScreenPoint: () => cursor, getDisplayNearestPoint: displayAt,
  } });
  await h.ask.tap();
  h.clip();
  await until(() => h.sent.some((m) => m.type === "state" && m.state === "done"));
  assert.strictEqual(h.windows[0].o.x, WORK.x, "the answer is up on A");
  // They move to B and ask again, the answer still up on A.
  cursor = { x: 2000, y: 300 };
  await h.ask.tap();
  await until(() => h.types().filter((t) => t === "show").length === 2);
  assert.strictEqual(pill.moved, 2);
  assert.deepStrictEqual(h.windows[0].bounds, B.bounds, "the new card opens where they are");
  const last = docks(h).pop();
  assert.ok(last.pill && last.pill.x > 0 && !("seed" in last), "tied to the pill, there");
  h.ask.cancel("test");
});

test("Esc folds the card into the pill and then gives it back; a crashed guide gives it back at once", async () => {
  const pill = fakePill();
  const h = harness({ pill, knobs: FAST });
  await h.ask.tap();
  await until(() => h.types().includes("show"));
  assert.ok(h.ask.escape());
  assert.deepStrictEqual(pill.calls, ["listening", "closing"]);
  await until(() => pill.calls.length === 3);
  assert.deepStrictEqual(pill.calls, ["listening", "closing", null]);
  assert.strictEqual(pill.state, "rest");

  const pill2 = fakePill();
  const h2 = harness({ pill: pill2, steps: RISKY });
  await h2.ask.tap();
  h2.clip();
  await until(() => h2.types().includes("confirm"));
  h2.windows[0].wc["render-process-gone"]();
  assert.deepStrictEqual(pill2.calls, ["listening", "thinking", "showing", null], "nothing left to fold: given back there and then");
  assert.strictEqual(pill2.state, "rest");
});

test("a dictation that starts mid-run ends with the pill the dictation's: never ask, never rest", async () => {
  const pill = fakePill();
  const h = harness({ pill, steps: RISKY, knobs: FAST });
  await h.ask.tap();
  h.clip();
  await until(() => h.types().includes("confirm"));
  const before = pill.calls.length;
  // toggleDictation, in main's order: the question is cancelled while the
  // pill is still its, then the dictation opens the microphone and takes it.
  assert.ok(h.ask.active());
  h.ask.cancel("dictation");
  pill.dictate();
  await sleep(250);
  assert.deepStrictEqual(pill.calls.slice(before), ["closing", null], "closed, then let go, and nothing else");
  assert.strictEqual(pill.state, "listening");
  assert.strictEqual(pill.recording, true);
  assert.deepStrictEqual(h.actions, []);
});

test("a dictation started under a finished card keeps the pill when the card goes, and a card put up meanwhile grows from a seed", async () => {
  const pill = fakePill();
  const h = harness({ pill, knobs: { "desktop.guide.foldMs": 40, "desktop.agent.doneMs": 200 } });
  await h.ask.tap();
  h.clip();
  await until(() => h.sent.some((m) => m.type === "state" && m.state === "done"));
  assert.ok(!h.ask.active(), "over: main does not cancel it for the dictation");
  pill.dictate();
  await until(() => pill.calls.includes(null), 2000);
  assert.strictEqual(pill.state, "listening", "the card's closing and letting go were refused");
  // A question's error said while the dictation has the pill: the card comes
  // up on its own, from a seed, and the pill is left alone.
  const before = docks(h).length;
  h.deps().guide.error("Something went wrong.");
  assert.strictEqual(pill.state, "listening");
  assert.deepStrictEqual(docks(h).slice(before).map((d) => d.pill), [null]);
  assert.ok(!("seed" in docks(h).slice(before)[0]), "a seed is fine here: the card is on the pill's display");
});

test("a ring on another display takes the guide there: the pill stays, no tether or seed there; back, it is tied again", async () => {
  const A = { workArea: WORK, bounds: WORK };
  const B = { workArea: { x: 1500, y: 0, width: 1920, height: 1040 }, bounds: { x: 1500, y: 0, width: 1920, height: 1080 } };
  const snap = Object.assign({}, SNAP, { elements: [
    { id: "e1", role: "button", label: "Export", frame: [1100, 60, 80, 30] },
    { id: "e2", role: "button", label: "Share", frame: [2400, 300, 80, 30] },
  ] });
  const pill = fakePill();
  const h = harness({ pill, snap, platform: "darwin", knobs: { "desktop.agent.doneMs": 5000 }, steps: [[
    { t: "heard", text: "where's share, and export", mode: "show" },
    { t: "say", text: "Share is on the other screen." }, { t: "point", id: "e2", caption: "Share" },
    { t: "say", text: "Export is here.", append: true }, { t: "point", id: "e1", caption: "Export" }, { t: "done" },
  ]], screen: {
    getCursorScreenPoint: () => ({ x: 500, y: 400 }),
    getDisplayNearestPoint: (p) => (p.x < 1500 ? A : B),
  } });
  await h.ask.tap();
  h.clip();
  await until(() => h.sent.filter((m) => m.type === "point").length === 2);
  assert.deepStrictEqual(docks(h).map((d) => d.pill), [DOCK, null, DOCK]);
  assert.strictEqual(docks(h)[1].seed, false, "off the pill's display: no seed either");
  assert.strictEqual(pill.moved, 1, "the pill never follows the guide");
  // Each move is said before the ring that caused it.
  const t = h.types();
  assert.ok(t.indexOf("dock", t.indexOf("dock") + 1) < t.indexOf("point"));
  h.ask.cancel("test");
});

test("desktop.guide.dock off: the pill is left alone and the card is what it was", async () => {
  const pill = fakePill();
  const h = harness({ pill, knobs: Object.assign({ "desktop.guide.dock": false }, FAST) });
  await h.ask.tap();
  h.clip();
  await until(() => h.sent.some((m) => m.type === "state" && m.state === "done"));
  await until(() => !h.windows[0].visible, 2000);
  assert.deepStrictEqual(pill.calls, []);
});

test("no pill to grow from (switched off): the card opens on the cursor's display, from a seed", async () => {
  const pill = fakePill({ on: false });
  const h = harness({ pill });
  await h.ask.tap();
  await until(() => h.types().includes("show"));
  assert.deepStrictEqual(pill.calls, ["listening"]);
  assert.deepStrictEqual(docks(h), [{ type: undefined, pill: null }]);
  h.ask.cancel("test");
});

// ---- v3: the marks --------------------------------------------------------------------

test("a mark goes to the guide in its window's own coordinates, with a fresh id each", async () => {
  const h = harness({ platform: "darwin", screen: { getCursorScreenPoint: () => ({ x: 500, y: 400 }), getDisplayNearestPoint: () => ({ workArea: WORK, bounds: WORK }) } });
  await h.ask.tap();
  await until(() => h.types().includes("show"));
  const g = h.deps().guide;
  g.draw({ kind: "circle", frame: [1100, 60, 80, 30], text: "90°" });
  g.draw({ kind: "arrow", from: [500, 400], to: [1100, 60, 80, 30], text: "c, what we want" });
  g.draw({ kind: "number", at: [300, 200], n: 2 });
  g.draw({ kind: "number", frame: [300, 200, 40, 20], n: 3.2 });
  g.draw({ kind: "path", points: [[200, 500], [400, 500], [400, 300]], closed: true, text: "the triangle" });
  g.draw({ kind: "label", at: [700, 140], text: "  a² + b²\n= c² \u0007 " });
  g.draw({ kind: "underline", frame: [600, 300, 120, 18] });
  g.clear();
  // From the card on: a new question's own clear, before it, is the agent's.
  const marks = h.sent.slice(h.sent.findIndex((m) => m.type === "show")).filter((m) => m.type === "draw" || m.type === "clear");
  const L = (x, y) => [x - WORK.x, y - WORK.y];
  assert.deepStrictEqual(marks, [
    { type: "draw", id: "d1", kind: "circle", frame: [1000, 20, 80, 30], text: "90°" },
    { type: "draw", id: "d2", kind: "arrow", from: L(500, 400), to: [1000, 20, 80, 30], text: "c, what we want" },
    { type: "draw", id: "d3", kind: "number", at: L(300, 200), n: 2 },
    { type: "draw", id: "d4", kind: "number", frame: [200, 160, 40, 20], n: 3 },
    { type: "draw", id: "d5", kind: "path", points: [L(200, 500), L(400, 500), L(400, 300)], closed: true, text: "the triangle" },
    { type: "draw", id: "d6", kind: "label", at: L(700, 140), text: "a² + b² = c²" },
    { type: "draw", id: "d7", kind: "underline", frame: [500, 260, 120, 18] },
    { type: "clear" },
  ]);
  h.ask.cancel("test");
});

test("a mark off the guide's window is dropped, and once one is drawn there the window never moves for another", async () => {
  const A = { workArea: WORK, bounds: WORK };
  const B = { workArea: { x: 1500, y: 0, width: 1920, height: 1040 }, bounds: { x: 1500, y: 0, width: 1920, height: 1080 } };
  const h = harness({ platform: "darwin", screen: { getCursorScreenPoint: () => ({ x: 500, y: 400 }), getDisplayNearestPoint: (p) => (p.x < 1500 ? A : B) } });
  await h.ask.tap();
  await until(() => h.types().includes("show"));
  const g = h.deps().guide;
  g.draw({ kind: "scribble", frame: [2400, 300, 10, 10] });                  // no such kind: it moves nothing
  g.draw({ kind: "box", frame: [1450, 800, 200, 200] });                     // partly on it: drawn
  g.draw({ kind: "box", frame: [2400, 300, 80, 30] });                       // on the other display
  g.draw({ kind: "arrow", from: [500, 400], to: [2400, 300] });              // one end off
  g.draw({ kind: "path", points: [[200, 500], [400, 500], [400, 9999]] });   // one point off
  g.draw({ kind: "label", at: [50, 20], text: "left of the window" });       // before its left edge
  g.draw({ kind: "scribble", frame: [300, 200, 10, 10] });                   // no such kind
  g.draw({ kind: "box" });                                                   // nowhere
  g.draw({ kind: "path", points: [[300, 200]] });                            // one point is no path
  const marks = h.sent.filter((m) => m.type === "draw");
  assert.deepStrictEqual(marks.map((m) => [m.id, m.kind]), [["d1", "box"]]);
  assert.strictEqual(h.windows.length, 1);
  assert.strictEqual(h.windows[0].bounds, undefined, "never moved");
  h.ask.cancel("test");
});

test("the pointer on one display and the app on the other: the first mark takes the guide to the app's, and the answer's marks are drawn there", async () => {
  // The pointer, and so the pill and the card, on A; the spreadsheet on B.
  // The answer only draws: three numbers, no ring.
  const A = { workArea: WORK, bounds: WORK };
  const B = { workArea: { x: 1500, y: 0, width: 1920, height: 1040 }, bounds: { x: 1500, y: 0, width: 1920, height: 1080 } };
  const snap = Object.assign({}, SNAP, { window: { frame: [1600, 40, 1600, 900] }, elements: [
    { id: "e8", role: "button", label: "Data", frame: [1900, 60, 60, 24] },
    { id: "e15", role: "button", label: "Filter", frame: [2300, 100, 60, 24] },
    { id: "e40", role: "cell", label: "Region", frame: [1700, 300, 120, 24] },
  ] });
  const h = harness({ snap, platform: "darwin", knobs: { "desktop.agent.doneMs": 5000 }, steps: [[
    { t: "heard", text: "how do I add a filter to this column", mode: "show" },
    { t: "say", text: "Select the column, open the Data tab, then press Filter." },
    { t: "draw", kind: "number", target: { id: "e40" }, n: 1 },
    { t: "draw", kind: "number", target: { id: "e8" }, n: 2 },
    { t: "draw", kind: "number", target: { id: "e15" }, n: 3 },
    { t: "done" },
  ]], screen: { getCursorScreenPoint: () => ({ x: 500, y: 400 }), getDisplayNearestPoint: (p) => (p.x < 1500 ? A : B) } });
  await h.ask.tap();
  h.clip();
  await until(() => h.sent.some((m) => m.type === "state" && m.state === "done"));
  const draws = h.sent.filter((m) => m.type === "draw");
  assert.deepStrictEqual(draws.map((m) => m.n), [1, 2, 3], "every step drawn");
  assert.deepStrictEqual(h.windows[0].bounds, B.bounds, "the guide went to the app's display");
  assert.deepStrictEqual(draws[0].frame, [1700 - 1500, 300, 120, 24], "in its own coordinates there");
  h.ask.cancel("test");
});

test("the guide taken to another display by a ring: the marks drawn on the last one go before it gets there", async () => {
  const A = { workArea: WORK, bounds: WORK };
  const B = { workArea: { x: 1500, y: 0, width: 1920, height: 1040 }, bounds: { x: 1500, y: 0, width: 1920, height: 1080 } };
  const snap = Object.assign({}, SNAP, { elements: [
    { id: "e1", role: "button", label: "File", frame: [300, 60, 40, 20] },
    { id: "e2", role: "button", label: "Share", frame: [2400, 300, 80, 30] },
  ] });
  const h = harness({ snap, platform: "darwin", knobs: { "desktop.agent.doneMs": 5000 }, steps: [[
    { t: "heard", text: "where's share", mode: "show" },
    { t: "say", text: "Under File, then Share." },
    { t: "draw", kind: "number", target: { id: "e1" }, n: 1 },
    { t: "point", id: "e2", caption: "Share" },
    { t: "draw", kind: "number", target: { id: "e2" }, n: 2 },
    { t: "done" },
  ]], screen: { getCursorScreenPoint: () => ({ x: 500, y: 400 }), getDisplayNearestPoint: (p) => (p.x < 1500 ? A : B) } });
  await h.ask.tap();
  h.clip();
  await until(() => h.sent.filter((m) => m.type === "draw").length === 2);
  const t = h.sent.slice(h.sent.findIndex((m) => m.type === "show")).map((m) => m.type);
  // The number on A, then the move to B (the marks there go first), the
  // ring, and the number on B in B's coordinates.
  assert.deepStrictEqual(t.filter((x) => ["draw", "clear", "area", "point"].includes(x)), ["draw", "clear", "area", "point", "draw"]);
  assert.deepStrictEqual(h.sent.filter((m) => m.type === "draw").map((m) => m.frame), [[200, 20, 40, 20], [900, 300, 80, 30]]);
  h.ask.cancel("test");
});

test("Windows, a display at 150%: frames and points in physical pixels are drawn in DIP", async () => {
  const D = { workArea: { x: 0, y: 0, width: 1280, height: 680 }, bounds: { x: 0, y: 0, width: 1280, height: 720 } };
  const h = harness({ platform: "win32", screen: {
    getCursorScreenPoint: () => ({ x: 500, y: 400 }),
    getDisplayNearestPoint: () => D,
    screenToDipRect: (_w, r) => ({ x: r.x / 1.5, y: r.y / 1.5, width: r.width / 1.5, height: r.height / 1.5 }),
    screenToDipPoint: (p) => ({ x: p.x / 1.5, y: p.y / 1.5 }),
  } });
  await h.ask.tap();
  await until(() => h.types().includes("show"));
  h.deps().guide.draw({ kind: "arrow", from: [300, 150], to: [900, 600, 150, 75] });
  assert.deepStrictEqual(h.sent.find((m) => m.type === "draw"), { type: "draw", id: "d1", kind: "arrow", from: [200, 100], to: [600, 400, 100, 50] });
  h.ask.cancel("test");
});

test("no card up, no marks: one drawn after the card has gone is dropped", async () => {
  const h = harness({ knobs: FAST });
  h.deps().guide.draw({ kind: "box", frame: [300, 200, 40, 20] });
  await h.ask.tap();
  await until(() => h.types().includes("show"));
  h.ask.cancel("test");
  h.deps().guide.draw({ kind: "box", frame: [300, 200, 40, 20] });
  assert.ok(!h.types().includes("draw"));
});

// ---- v3: dictation always wins the pill, whenever it starts ----------------------------

// Every moment of a question a dictation can start in. main.js's
// toggleDictation, in its order: a question still going is cancelled first
// (ask.active()), while the pill is still its; then the dictation opens the
// microphone and the pill is its. From then on nothing the question does (its
// late stream, its timers, its fold, a tap) may put the pill in "ask" or at
// "rest" under it, and once the dictation has written and given the pill
// back, nothing of the question takes it again.
const DICTATION_MOMENTS = [
  ["while the question is said", { knobs: FAST }, async (h) => { await h.ask.tap(); await until(() => h.types().includes("show")); }],
  ["while the app in front is being named", { knobs: FAST, slowFront: true }, async (h, o) => { void h.ask.tap(); await until(() => h.starts() === 1); o.later = () => o.release({ label: "Keynote" }); }],
  ["while it thinks, its answer on its way", { knobs: FAST }, async (h) => { await h.ask.tap(); h.clip(); }],
  ["on the Do it card", { knobs: FAST, steps: RISKY }, async (h) => { await h.ask.tap(); h.clip(); await until(() => h.types().includes("confirm")); }],
  ["while an ASK's reply records", { knobs: FAST, steps: [
    [{ t: "heard", text: "tell them it's ready", mode: "do" }, { t: "ask", text: "Which channel?" }],
    [{ t: "done", text: "Okay." }],
  ] }, async (h, o) => { await h.ask.tap(); h.clip(); await until(() => h.starts() === 2); o.later = () => h.clip(); }],
  ["while the card folds back into the pill", { knobs: { "desktop.guide.foldMs": 300, "desktop.agent.doneMs": 30 } }, async (h, o) => {
    await h.ask.tap(); h.clip(); await until(() => o.pill.calls.includes("closing"));
  }],
  ["under a card left up when its run is over", { knobs: { "desktop.guide.foldMs": 40, "desktop.agent.doneMs": 200 } }, async (h) => {
    await h.ask.tap(); h.clip(); await until(() => h.sent.some((m) => m.type === "state" && m.state === "done"));
  }],
];
for (const [moment, cfg, reach] of DICTATION_MOMENTS) {
  test(`a dictation that starts ${moment} keeps the pill: never ask, never rest under it`, async () => {
    const pill = fakePill();
    const answers = [];
    const ask = pill.pillAsk;
    pill.pillAsk = (phase, first) => { const r = ask(phase, first); answers.push([phase, pill.state, r]); return r; };
    const o = { pill, later: null, release: null };
    const opts = { pill, knobs: cfg.knobs, steps: cfg.steps, get dictating() { return pill.recording; } };
    if (cfg.slowFront) opts.frontInfo = () => new Promise((r) => { o.release = r; });
    const h = harness(opts);
    await reach(h, o);
    // toggleDictation: the question let go of while it still has the pill
    // (its closing is the only thing asked of it then), and the dictation in.
    // A finished answer's card still up is put away too: it may be talking.
    const took = answers.length;
    if (h.ask.active() || h.ask.shown()) h.ask.cancel("dictation");
    assert.ok(answers.slice(took).every(([phase]) => phase === "closing"), JSON.stringify(answers.slice(took)));
    const from = answers.length;
    pill.dictate();
    // Whatever the question had still coming comes now: the app named, a
    // reply's clip, a tap on the way in (refused: one microphone), and every
    // timer of the card's (the fold, doneMs) runs out.
    if (o.later) o.later();
    await h.ask.tap();
    await sleep(500);
    const during = answers.slice(from);
    assert.ok(during.every(([, state, r]) => state === "listening" && r === null), JSON.stringify(during));
    assert.strictEqual(pill.state, "listening");
    // Written, and the pill back at rest by the dictation's own hand: the
    // question that was cancelled for it never takes it again.
    pill.recording = false; pill.state = "writing";
    await sleep(60);
    pill.state = "rest";
    await sleep(400);
    assert.ok(answers.slice(from).every(([, , r]) => r === null), JSON.stringify(answers.slice(from)));
    assert.strictEqual(pill.state, "rest");
    assert.strictEqual(pill.moved, took > 0 ? 1 : 0, "taken once, by the question, before the dictation");
    assert.deepStrictEqual(h.actions, [], "the question did nothing");
    h.ask.cancel("test");
  });
}

test("the pill taken back mid-card, somewhere else: the card is told where it is now", async () => {
  // An error of dictation's said on the pill mid-question (out of words, at
  // a press of its key) leaves main's pill out of "ask"; the question's next
  // phase takes it back, under the cursor again, which is on another display
  // by now.
  const A = { workArea: WORK, bounds: WORK };
  const B = { workArea: { x: 1500, y: 0, width: 1920, height: 1040 }, bounds: { x: 1500, y: 0, width: 1920, height: 1080 } };
  const pill = fakePill();
  const h = harness({ pill, steps: RISKY, knobs: FAST, platform: "darwin", screen: {
    getCursorScreenPoint: () => ({ x: 500, y: 400 }),
    getDisplayNearestPoint: (p) => (p.x < 1500 ? A : B),
  } });
  await h.ask.tap();
  await until(() => h.types().includes("show"));
  assert.deepStrictEqual(docks(h).map((d) => d.pill), [DOCK]);
  pill.state = "error";
  pill.bounds = { x: 1500, y: 1040 - 136, width: 1920, height: 132 };
  h.clip();
  await until(() => h.types().includes("confirm"));
  assert.deepStrictEqual(pill.calls.slice(0, 3), ["listening", "thinking", "showing"]);
  assert.strictEqual(pill.moved, 2);
  // Off the guide's display now: no tether, no seed. Told once, not at
  // every phase after.
  assert.deepStrictEqual(docks(h).map((d) => [d.pill, d.seed]), [[DOCK, undefined], [null, false]]);
  h.ask.cancel("test");
});

test("marks: each kind needs its own geometry, a number its numeral and a label its words; broken ones are dropped, never sent half-made", async () => {
  const h = harness({ platform: "darwin", screen: { getCursorScreenPoint: () => ({ x: 500, y: 400 }), getDisplayNearestPoint: () => ({ workArea: WORK, bounds: WORK }) } });
  await h.ask.tap();
  await until(() => h.types().includes("show"));
  const g = h.deps().guide;
  const bad = [
    null, undefined, 7, "box", {}, { kind: {} }, { kind: "box", frame: null },
    { kind: "box", at: [300, 200] },                       // a box round a point: nothing to go round
    { kind: "circle", from: [300, 200], to: [400, 300] },
    { kind: "underline", points: [[300, 200], [400, 200]] },
    { kind: "highlight", frame: [300, 200, NaN, 20] },
    { kind: "box", frame: [300, 200, 40] },
    { kind: "box", frame: [300, "x", 40, 20] },
    { kind: "box", frame: [300, 200, Infinity, 20] },
    { kind: "arrow", from: [300, 200] },
    { kind: "arrow", to: [300, 200, 40, 20] },
    { kind: "arrow", from: { x: 300, y: 200 }, to: [400, 300] },
    { kind: "arrow", frame: [300, 200, 40, 20] },
    { kind: "path", points: "300,200 400,300" },
    { kind: "path", points: [[300, 200], [NaN, 300]] },
    { kind: "path", points: [[300, 200], null] },
    { kind: "path", frame: [300, 200, 40, 20] },
    { kind: "number", at: [300, 200] },                    // no numeral
    { kind: "number", at: [300, 200], n: 0 },
    { kind: "number", at: [300, 200], n: 12 },
    { kind: "number", at: [300, 200], n: "two" },
    { kind: "number", n: 2 },
    { kind: "label", at: [300, 200] },                     // no words
    { kind: "label", at: [300, 200], text: " \n\u0007 " },
    { kind: "label", at: [300, 200], text: { toString: () => "boo" } },
    { kind: "label", at: [NaN, 200], text: "x" },
  ];
  for (const m of bad) assert.doesNotThrow(() => g.draw(m), JSON.stringify(m));
  assert.deepStrictEqual(h.sent.filter((m) => m.type === "draw"), []);
  // The good ones, each in its own form.
  g.draw({ kind: "highlight", frame: [600, 300, 120, 18] });
  g.draw({ kind: "number", frame: [300, 200, 40, 20], n: "2" });
  g.draw({ kind: "label", frame: [300, 200, 40, 20], text: "here" });
  g.draw({ kind: "arrow", from: [300, 200, 40, 20], to: [700, 500] });
  assert.deepStrictEqual(h.sent.filter((m) => m.type === "draw").map((m) => [m.id, m.kind, m.frame || m.at || m.from]), [
    ["d1", "highlight", [500, 260, 120, 18]],
    ["d2", "number", [200, 160, 40, 20]],
    ["d3", "label", [200, 160, 40, 20]],
    ["d4", "arrow", [200, 160, 40, 20]],
  ]);
  h.ask.cancel("test");
});

// ---- the peek: Blip over the text box while a dictation records -------------------------

// The caret in the middle of a one-line message box, in screen points.
const CARET = [600, 300, 2, 18];
const FIELD = [400, 290, 500, 40];
const peeks = (h) => h.sent.filter((m) => m.type === "peek").map((m) => Object.assign({}, m, { type: undefined }));
const local = (f) => [f[0] - WORK.x, f[1] - WORK.y, f[2], f[3]];
// A new guide window has its messages held until its page has loaded.
const loaded = () => sleep(5);

test("peek: Blip over the field, in the guide window's own coordinates, on the field's display, and never a card", async () => {
  const h = harness();
  assert.strictEqual(h.ask.peek(CARET, FIELD, "listening"), true);
  await loaded();
  const win = h.windows[0];
  assert.ok(win && win.visible, "the guide's window is up for it");
  assert.strictEqual(win.file, "guide.html");
  assert.deepStrictEqual([win.o.x, win.o.y, win.o.width, win.o.height], [WORK.x, WORK.y, WORK.width, WORK.height]);
  assert.deepStrictEqual(peeks(h), [{ type: undefined, caret: local(CARET), field: local(FIELD), state: "listening" }]);
  // It never takes the pointer: the window stays click-through.
  assert.ok(win.ignore.every(([v]) => v === true), JSON.stringify(win.ignore));
  // Not a question: a dictation starting would not put it away, Esc is not its.
  assert.strictEqual(h.ask.active(), false);
  assert.strictEqual(h.ask.shown(), false);
  assert.strictEqual(h.ask.escape(), false);
  assert.strictEqual(h.ask.peeking(), true);
  // Only the guide's three states; anything else is listening.
  h.ask.peek(CARET, FIELD, "writing");
  h.ask.peek(CARET, FIELD, "done");
  h.ask.peek(CARET, FIELD, "dancing");
  assert.deepStrictEqual(peeks(h).map((m) => m.state), ["listening", "writing", "done", "listening"]);
  // Nothing of it went to the recorder, the server, or anywhere else.
  assert.deepStrictEqual(h.recorder, []);
  assert.deepStrictEqual(h.requests, []);
  h.ask.unpeek();
});

test("peek: never while a question has the guide, and a question ends it", async () => {
  {
    const h = harness();
    await h.ask.tap();
    await until(() => h.types().includes("show"));
    assert.strictEqual(h.ask.peek(CARET, FIELD, "listening"), false);
    h.ask.peekLevel(0.5);
    h.ask.unpeek();
    assert.deepStrictEqual(h.types().filter((t) => /peek/i.test(t)), [], "nothing of a peek while it asks");
    h.ask.cancel("test over");
  }
  {
    const h = harness({ knobs: { "desktop.agent.doneMs": 5000 } });
    h.ask.peek(CARET, FIELD, "done");
    await h.ask.tap();
    await until(() => h.types().includes("show"));
    assert.strictEqual(h.ask.peeking(), false, "the guide ends the peek itself on show");
    // The dictation's own "away" comes late: the card it does not touch.
    h.ask.unpeek();
    await sleep(400);
    assert.ok(!h.types().includes("unpeek"));
    assert.strictEqual(h.windows[0].visible, true, "the card keeps its window");
    h.ask.cancel("test over");
  }
});

test("peek: unpeek ducks at once and the window goes once Blip is down; a new peek meanwhile keeps it", async () => {
  const h = harness();
  h.ask.peek(CARET, FIELD, "listening");
  await loaded();
  const win = h.windows[0];
  h.ask.unpeek();
  assert.deepStrictEqual(h.types().slice(-1), ["unpeek"]);
  assert.strictEqual(win.visible, true, "still up while Blip ducks");
  await sleep(200);
  assert.strictEqual(win.visible, true);
  await sleep(250);
  assert.strictEqual(win.visible, false, "gone once it is down (about 300 ms)");
  h.ask.unpeek();
  assert.strictEqual(h.types().filter((t) => t === "unpeek").length, 1, "once");
  // Back up before the window went: it stays.
  h.ask.peek(CARET, FIELD, "listening");
  h.ask.unpeek();
  await sleep(100);
  h.ask.peek(CARET, FIELD, "listening");
  await sleep(450);
  assert.strictEqual(win.visible, true);
  assert.strictEqual(h.windows.length, 1, "the same window throughout");
  h.ask.unpeek();
});

test("peek: nothing to say where the cursor is, or numbers that make no sense, is no peek; one already up ducks", async () => {
  const h = harness();
  assert.strictEqual(h.ask.peek(null, null, "listening"), false);
  for (const bad of [[NaN, 1, 2, 3], [1, 2, 3], [1e9, 0, 2, 18], [0, 0, -5, 18], [0, 0, 2, 0], "600,300,2,18", { x: 1 }]) {
    assert.strictEqual(h.ask.peek(bad, bad, "listening"), false, JSON.stringify(bad));
  }
  assert.strictEqual(h.windows.length, 0, "no window for nothing");
  // One frame is enough: the field alone (the caret unknown), or the caret alone.
  assert.strictEqual(h.ask.peek(null, FIELD, "listening"), true);
  await loaded();
  assert.strictEqual(h.ask.peek([NaN, 0, 2, 18], FIELD, "listening"), true);
  assert.strictEqual(h.ask.peek(CARET, null, "listening"), true);
  assert.deepStrictEqual(peeks(h).map((m) => [m.caret, m.field]), [[null, local(FIELD)], [null, local(FIELD)], [local(CARET), null]]);
  // A password field took the focus: nothing says where the cursor is now.
  assert.strictEqual(h.ask.peek(null, null, "listening"), false);
  assert.deepStrictEqual(h.types().slice(-1), ["unpeek"]);
  assert.strictEqual(h.ask.peeking(), false);
});

test("peek: the antenna's level goes only while it peeks, kept to 0..1", async () => {
  const h = harness();
  h.ask.peekLevel(0.4);
  h.ask.peek(CARET, FIELD, "listening");
  await loaded();
  h.ask.peekLevel(0.4);
  h.ask.peekLevel(7);
  h.ask.peekLevel("loud");
  h.ask.unpeek();
  h.ask.peekLevel(0.4);
  assert.deepStrictEqual(h.sent.filter((m) => m.type === "peekLevel").map((m) => m.v), [0.4, 1, 0]);
});

test("peek: the voice's level is not queued for a page still loading (thirty a second, the whole dictation)", async () => {
  const h = harness();
  h.ask.peek(CARET, FIELD, "listening");
  // The window was just made: its page has not loaded yet.
  for (let i = 0; i < 30; i++) h.ask.peekLevel(0.3);
  await loaded();
  h.ask.peekLevel(0.6);
  assert.deepStrictEqual(h.sent.filter((m) => m.type === "peekLevel").map((m) => m.v), [0.6]);
  assert.deepStrictEqual(peeks(h).map((m) => m.state), ["listening"], "the peek itself waits for the page and goes");
  h.ask.unpeek();
});

test("peek: Windows reports physical pixels, and the guide is sent DIP", async () => {
  const h = harness({ platform: "win32", screen: {
    getCursorScreenPoint: () => ({ x: 500, y: 400 }),
    getDisplayNearestPoint: () => ({ workArea: WORK }),
    // A display at 150%.
    screenToDipRect: (_w, r) => ({ x: r.x / 1.5, y: r.y / 1.5, width: r.width / 1.5, height: r.height / 1.5 }),
  } });
  h.ask.peek([900, 450, 3, 27], [600, 435, 750, 60], "listening");
  await loaded();
  assert.deepStrictEqual(peeks(h)[0], { type: undefined, caret: [600 - WORK.x, 300 - WORK.y, 2, 18], field: [400 - WORK.x, 290 - WORK.y, 500, 40], state: "listening" });
  h.ask.unpeek();
});

test("peek: on the field's display; a document taller than the screen, on its caret's", async () => {
  const A = { workArea: WORK, bounds: WORK };
  const B = { workArea: { x: 1500, y: 0, width: 1920, height: 1040 }, bounds: { x: 1500, y: 0, width: 1920, height: 1080 } };
  const screen = {
    getCursorScreenPoint: () => ({ x: 500, y: 400 }),
    getDisplayNearestPoint: (p) => (p.x < 1500 ? A : B),
    screenToDipRect: (_w, r) => r,
  };
  {
    // A message box on the second display, the pointer still on the first.
    const h = harness({ screen });
    h.ask.peek([2000, 300, 2, 18], [1900, 290, 500, 40], "listening");
    await loaded();
    assert.deepStrictEqual([h.windows[0].o.x, h.windows[0].o.width], [1500, 1920]);
    assert.deepStrictEqual(peeks(h)[0].caret, [500, 300, 2, 18]);
    h.ask.unpeek();
  }
  {
    // A scrolled document whose text view's middle is on the first display's
    // side, its caret line on the second: Blip stands on the caret's line.
    const h = harness({ screen });
    h.ask.peek([1600, 500, 2, 18], [100, -4000, 1600, 9000], "listening");
    assert.deepStrictEqual([h.windows[0].o.x, h.windows[0].o.width], [1500, 1920]);
    h.ask.unpeek();
  }
});

test("peek: a card still folding into the pill when a dictation starts: the peek takes the window, the pill is given back at once", async () => {
  const pill = fakePill();
  const h = harness({ pill, knobs: Object.assign({}, FAST, { "desktop.guide.foldMs": 300 }) });
  await h.ask.tap();
  await until(() => h.types().includes("show"));
  h.ask.cancel("esc");                 // folding now
  pill.dictate();                      // a dictation has the pill
  h.ask.peek(CARET, FIELD, "listening");
  assert.strictEqual(pill.calls[pill.calls.length - 1], null, "the question lets go of the pill now");
  assert.strictEqual(pill.state, "listening", "and the dictation keeps it");
  await sleep(450);
  assert.strictEqual(h.windows[0].visible, true, "the fold's end does not take the peek's window down");
  assert.strictEqual(h.windows.length, 1);
  h.ask.unpeek();
});

test("peek: a guide page that crashes mid-peek is thrown away; the next caret builds a new one", async () => {
  const h = harness();
  h.ask.peek(CARET, FIELD, "listening");
  h.windows[0].wc["render-process-gone"]();
  assert.strictEqual(h.ask.peeking(), false);
  assert.strictEqual(h.ask.peek(CARET, FIELD, "listening"), true);
  assert.strictEqual(h.windows.length, 2);
  assert.strictEqual(h.windows[1].visible, true);
  h.ask.unpeek();
});

// The peek's watch (createPeekWatch), with a helper that answers from a script
// and an Ask that only records what it is told.
const NOTES = { label: "Notes", title: "Shopping list", private: false, sensitive: false, pictureKey: "Notes" };
const answer = (o = {}) => Object.assign({ ok: true, caret: CARET.slice(), field: FIELD.slice(), app: { name: "Notes", pid: 42 }, scale: "points" }, o);
function watched(o = {}) {
  const told = [];
  const asked = [];
  let inFlight = 0, most = 0;
  const knobs = Object.assign({ "desktop.dictation.peekEveryMs": 40, "desktop.dictation.peekDoneMs": 40, "desktop.dictation.peekBudgetMs": 50 }, o.knobs);
  const fakeAsk = o.ask || {
    peek: (c, f, s) => { told.push(["peek", c, f, s]); return o.peekAnswer !== undefined ? o.peekAnswer : true; },
    unpeek: () => { told.push(["unpeek"]); },
    peekLevel: (v) => { told.push(["level", v]); },
  };
  const next = o.answers ? o.answers.slice() : null;
  const driver = o.driver || {
    caret: (opt) => {
      asked.push(opt);
      inFlight++; most = Math.max(most, inFlight);
      const a = next ? (next.length > 1 ? next.shift() : next[0]) : answer();
      const settle = (v) => { inFlight--; return v; };
      if (typeof a === "function") return a().then(settle, (e) => { settle(); throw e; });
      return (o.slowMs ? sleep(o.slowMs) : Promise.resolve()).then(() => settle(a));
    },
  };
  const frontApp = require("./frontApp.js");
  const w = createPeekWatch({
    driver, ask: fakeAsk,
    knobs: { num: (k, f) => (k in knobs ? knobs[k] : f) },
    on: o.on || (() => true),
    labelOf: o.labelOf || frontApp.label,
    sensitive: frontApp.looksSensitive,
  });
  return { w, told, asked, most: () => most, kinds: () => told.map((t) => (t[0] === "peek" ? "peek:" + t[3] : t[0])) };
}

test("the watch: up while it listens, again after each pasted chunk and on the timer, writing on stop, done once pasted, then away", async () => {
  const moved = answer({ caret: [700, 300, 2, 18] });
  const p = watched({ answers: [answer(), moved], knobs: { "desktop.dictation.peekEveryMs": 1000 } });
  p.w.start(7, Promise.resolve(NOTES));
  await until(() => p.told.length === 1);
  assert.deepStrictEqual(p.told[0], ["peek", CARET, FIELD, "listening"]);
  assert.deepStrictEqual(p.asked[0], { budgetMs: 50 }, "the helper's budget is the peek's (peekBudgetMs)");
  // A chunk was pasted: the caret has moved on, and Blip follows.
  p.w.pasted(7);
  await until(() => p.told.length === 2);
  assert.deepStrictEqual(p.told[1], ["peek", moved.caret, FIELD, "listening"]);
  // Not another dictation's chunk.
  p.w.pasted(8);
  await sleep(20);
  assert.strictEqual(p.asked.length, 2);
  p.w.level(7, [0.2, 0.6]);
  p.w.level(8, [1, 1]);
  assert.deepStrictEqual(p.told[2], ["level", 0.4]);
  // They stop: it watches the words being written, where it was.
  p.w.stop(7);
  assert.deepStrictEqual(p.told[3], ["peek", moved.caret, FIELD, "writing"]);
  p.w.level(7, [1]);
  assert.strictEqual(p.told.length, 4, "no voice to show once the microphone is closed");
  // Pasted: where the caret is now, the hop, and away after peekDoneMs.
  p.w.done(7);
  await until(() => p.told.length === 5);
  assert.deepStrictEqual(p.told[4], ["peek", moved.caret, FIELD, "done"]);
  assert.strictEqual(p.w.watching(), 7);
  await sleep(20);
  assert.strictEqual(p.told.length, 5, "not away before peekDoneMs");
  await until(() => p.told.length === 6);
  assert.deepStrictEqual(p.told[5], ["unpeek"]);
  assert.strictEqual(p.w.watching(), 0);
});

test("the watch: asked on a timer while it records (desktop.dictation.peekEveryMs), and no more once it stops", async () => {
  const p = watched({ knobs: { "desktop.dictation.peekEveryMs": 100 } });
  p.w.start(3, NOTES);
  await sleep(460);
  const n = p.asked.length;
  assert.ok(n >= 4 && n <= 6, `asked ${n} times in 460 ms: once at the start, then one every 100`);
  p.w.stop(3);
  await sleep(250);
  assert.strictEqual(p.asked.length, n, "the timer stops with the microphone");
  p.w.end(3);
});

test("the watch: a server value past Node's timers is not a poll every millisecond, and a huge budget still waits for the helper", async () => {
  // 1e12 ms is past setInterval's limit, which Node runs every millisecond.
  const p = watched({ knobs: { "desktop.dictation.peekEveryMs": 1e12, "desktop.dictation.peekBudgetMs": 1e12 }, slowMs: 30 });
  p.w.start(5, NOTES);
  await sleep(150);
  assert.strictEqual(p.asked.length, 1, "asked at the start, and not again within 150 ms");
  assert.deepStrictEqual(p.asked[0], { budgetMs: 2000 }, "no more budget than the drivers allow");
  assert.deepStrictEqual(p.kinds(), ["peek:listening"], "the slow answer was waited for, not cut off at once");
  p.w.end(5);
});

test("the watch: an Ask that throws, or a knob read that does, is never a throw out of a timer or a promise", async () => {
  const seen = [];
  const onRej = (e) => seen.push(["rejection", String(e)]);
  const onExc = (e) => seen.push(["exception", String(e)]);
  process.on("unhandledRejection", onRej);
  process.on("uncaughtException", onExc);
  const warn = console.warn;
  console.warn = () => {};
  try {
    let reads = 0;
    const w = createPeekWatch({
      driver: { caret: async () => answer() },
      ask: { peek: () => { throw new Error("guide gone"); }, unpeek: () => { throw new Error("no"); }, peekLevel: () => { throw new Error("no"); } },
      // The timer's own read throws (a knob store that broke mid-dictation).
      knobs: { num: (k, f) => { if (k === "desktop.dictation.peekBudgetMs" && ++reads > 1) throw new Error("knobs"); return k === "desktop.dictation.peekEveryMs" ? 20 : f; } },
      on: () => true, labelOf: require("./frontApp.js").label, sensitive: require("./frontApp.js").looksSensitive,
    });
    w.start(9, NOTES);
    await sleep(120);
    w.level(9, [0.5]);
    w.stop(9);
    w.done(9);
    w.end(9);
    await sleep(40);
  } finally {
    console.warn = warn;
    process.off("unhandledRejection", onRej);
    process.off("uncaughtException", onExc);
  }
  assert.deepStrictEqual(seen, []);
});

test("the watch: one caret request at a time, however slow the helper; a chunk pasted meanwhile is asked right after", async () => {
  const p = watched({ slowMs: 60, knobs: { "desktop.dictation.peekEveryMs": 10, "desktop.dictation.peekBudgetMs": 200 } });
  p.w.start(5, NOTES);
  await sleep(30);
  p.w.pasted(5);
  p.w.pasted(5);
  await sleep(200);
  assert.strictEqual(p.most(), 1, "never two at once");
  assert.ok(p.asked.length >= 3 && p.asked.length <= 5, `asked ${p.asked.length} times in 230 ms at 60 ms each`);
  p.w.end(5);
});

test("the watch: a private window or a sensitive app is never asked about at all", async () => {
  for (const info of [Object.assign({}, NOTES, { private: true }), Object.assign({}, NOTES, { label: "Chase", sensitive: true }), null, "Notes"]) {
    const p = watched();
    p.w.start(9, Promise.resolve(info));
    await sleep(80);
    assert.deepStrictEqual([p.asked.length, p.told.length], [0, 0], JSON.stringify(info));
    assert.strictEqual(p.w.watching(), 0);
  }
  // Named by a promise that fails: the same.
  const p = watched();
  p.w.start(9, Promise.reject(new Error("System Events")));
  await sleep(40);
  assert.deepStrictEqual([p.asked.length, p.told.length], [0, 0]);
});

test("the watch: only the dictation's own app; another in front is no peek, and back in it, it peeks again", async () => {
  const safari = answer({ app: { name: "Safari", pid: 77 } });
  const p = watched({ answers: [answer(), safari, answer()], knobs: { "desktop.dictation.peekEveryMs": 1000 } });
  p.w.start(11, NOTES);
  await until(() => p.told.length === 1);
  p.w.pasted(11);
  await until(() => p.told.length === 2);
  assert.deepStrictEqual(p.told[1], ["unpeek"], "the front app moved: Blip goes");
  p.w.pasted(11);
  await until(() => p.told.length === 3);
  assert.deepStrictEqual(p.told[2][0], "peek");
  p.w.end(11);
  {
    // Known by its pid once it has answered: another process with the same
    // name is another app.
    const q = watched({ answers: [answer(), answer({ app: { name: "Notes", pid: 99 } })], knobs: { "desktop.dictation.peekEveryMs": 1000 } });
    q.w.start(12, NOTES);
    await until(() => q.told.length === 1);
    q.w.pasted(12);
    await until(() => q.told.length === 2);
    assert.deepStrictEqual(q.told[1], ["unpeek"]);
    q.w.end(12);
  }
  {
    // The front app had already moved by the first answer: nothing.
    const q = watched({ answers: [safari] });
    q.w.start(13, NOTES);
    await sleep(120);
    assert.ok(q.asked.length >= 2);
    assert.deepStrictEqual(q.told, []);
    q.w.end(13);
  }
  {
    // A browser is the browser on its site, as frontApp names it.
    const gmail = { label: "Chrome: Gmail", title: "Inbox (3) - you@gmail.com - Gmail - Google Chrome", private: false, sensitive: false };
    const q = watched({ answers: [answer({ app: { name: "Google Chrome", pid: 5 } })] });
    q.w.start(14, gmail);
    await until(() => q.told.length === 1);
    assert.strictEqual(q.told[0][0], "peek");
    q.w.end(14);
  }
  {
    // Tailzu's own window: by this process's id.
    const q = watched({ answers: [answer({ app: { name: "Electron", pid: process.pid } })] });
    q.w.start(15, { pid: process.pid });
    await until(() => q.told.length === 1);
    assert.strictEqual(q.told[0][0], "peek");
    q.w.end(15);
  }
});

test("the watch: a sensitive app's caret, a password field, or no caret and no field is no peek", async () => {
  {
    // Its own window, as the dictation's target, but 1Password has the keyboard.
    const p = watched({ answers: [answer({ app: { name: "1Password", pid: process.pid } })] });
    p.w.start(1, { pid: process.pid });
    await sleep(100);
    assert.deepStrictEqual(p.told, []);
    p.w.end(1);
  }
  {
    // Up, then a password field: the helper says nothing of where its caret is.
    const p = watched({ answers: [answer(), answer({ caret: null, field: null })], knobs: { "desktop.dictation.peekEveryMs": 1000 } });
    p.w.start(2, NOTES);
    await until(() => p.told.length === 1);
    p.w.pasted(2);
    await until(() => p.told.length === 2);
    assert.deepStrictEqual(p.told[1], ["unpeek"]);
    p.w.end(2);
    assert.strictEqual(p.told.length, 2, "down once");
  }
});

test("the watch: every failure is silent, and the dictation's calls into it never throw", async () => {
  const errors = [];
  const onUnhandled = (e) => errors.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    const failures = [
      () => { throw new Error("helper exploded"); },
      () => Promise.reject(new Error("pipe")),
      () => new Promise(() => {}),          // never answers
      () => Promise.resolve(null),
      () => Promise.resolve({}),
      () => Promise.resolve({ ok: false, error: "timeout" }),
      () => Promise.resolve({ ok: true, caret: "600,300", field: { x: 1 }, app: null }),
      () => Promise.resolve({ ok: true, caret: [NaN, 1, 2, 3], field: [1e12, 0, 1, 1], app: { name: "Notes", pid: 42 } }),
      () => Promise.resolve("garbage"),
    ];
    for (const fail of failures) {
      const p = watched({ driver: { caret: () => fail() }, knobs: { "desktop.dictation.peekBudgetMs": 30, "desktop.dictation.peekEveryMs": 20 } });
      assert.doesNotThrow(() => {
        p.w.start(21, NOTES);
        p.w.pasted(21); p.w.level(21, [0.5]); p.w.level(21, "x"); p.w.stop(21); p.w.done(21); p.w.end(21);
        p.w.start(22, NOTES);
      });
      await sleep(120);
      assert.deepStrictEqual(p.told, [], String(fail));
      p.w.end();
    }
    // An Ask that throws, a namer that throws: still nothing escapes.
    const boom = () => { throw new Error("guide gone"); };
    const p = watched({ ask: { peek: boom, unpeek: boom, peekLevel: boom }, labelOf: boom });
    assert.doesNotThrow(() => { p.w.start(31, NOTES); p.w.level(31, [1]); });
    await sleep(60);
    const q = watched({ ask: { peek: boom, unpeek: boom, peekLevel: boom } });
    q.w.start(32, NOTES);
    await sleep(60);
    assert.doesNotThrow(() => { q.w.pasted(32); q.w.stop(32); q.w.done(32); q.w.end(32); });
    // Called with nothing at all.
    const r = watched();
    assert.doesNotThrow(() => { r.w.start(); r.w.pasted(); r.w.stop(); r.w.done(); r.w.end(); r.w.level(); r.w.start(0, null); });
    await sleep(60);
    p.w.end(); q.w.end();
  } finally { process.off("unhandledRejection", onUnhandled); }
  assert.deepStrictEqual(errors, [], "no promise left rejected");
});

test("the watch: no helper running is asked once, then left alone for the rest of that dictation", async () => {
  const p = watched({ answers: [{ ok: false, error: "unavailable" }], knobs: { "desktop.dictation.peekEveryMs": 15 } });
  p.w.start(4, NOTES);
  await sleep(100);
  p.w.pasted(4);
  await sleep(30);
  assert.strictEqual(p.asked.length, 1);
  assert.deepStrictEqual(p.told, []);
  p.w.end(4);
  // A driver with no caret at all (an older one): nothing asked, nothing shown.
  const q = watched({ driver: {} });
  q.w.start(5, NOTES);
  await sleep(60);
  assert.deepStrictEqual(q.told, []);
});

test("the watch: cancelled, failed, or nothing written takes Blip down at once; another dictation's ending does nothing", async () => {
  const p = watched({ knobs: { "desktop.dictation.peekEveryMs": 1000 } });
  p.w.start(6, NOTES);
  await until(() => p.told.length === 1);
  p.w.end(5);
  assert.strictEqual(p.told.length, 1);
  p.w.end(6);
  assert.deepStrictEqual(p.told[1], ["unpeek"]);
  assert.strictEqual(p.w.watching(), 0);
  p.w.done(6); p.w.stop(6); p.w.pasted(6);
  await sleep(60);
  assert.strictEqual(p.told.length, 2, "nothing after its end");
  // A new dictation ends the last one's watch first.
  const q = watched({ knobs: { "desktop.dictation.peekEveryMs": 1000 } });
  q.w.start(1, NOTES);
  await until(() => q.told.length === 1);
  q.w.start(2, NOTES);
  assert.deepStrictEqual(q.told[1], ["unpeek"]);
  await until(() => q.told.length === 3);
  assert.strictEqual(q.w.watching(), 2);
  q.w.end();
});

test("the watch: a dictation that never showed Blip does not pop it up at its end; one stopped before its app was named never shows it", async () => {
  {
    const p = watched({ answers: [{ ok: false, error: "timeout" }, answer()] });
    p.w.start(1, NOTES);
    await sleep(10);
    p.w.stop(1);
    p.w.done(1);
    await sleep(80);
    assert.deepStrictEqual(p.told, []);
  }
  {
    let name;
    const p = watched();
    p.w.start(2, new Promise((r) => { name = r; }));
    p.w.stop(2);
    name(NOTES);
    await sleep(60);
    assert.deepStrictEqual(p.told, [], "writing moves a peek that is up; it never brings one up");
    p.w.done(2);
    await sleep(60);
    assert.deepStrictEqual(p.told, []);
  }
});

test("the watch: the last caret read failing at done hops where Blip was; the app gone by then is no hop", async () => {
  {
    const p = watched({ answers: [answer(), { ok: false, error: "timeout" }], knobs: { "desktop.dictation.peekEveryMs": 1000 } });
    p.w.start(1, NOTES);
    await until(() => p.told.length === 1);
    p.w.stop(1);
    p.w.done(1);
    await until(() => p.told.length === 4);
    assert.deepStrictEqual(p.kinds(), ["peek:listening", "peek:writing", "peek:done", "unpeek"]);
    assert.deepStrictEqual(p.told[2][1], CARET);
  }
  {
    const p = watched({ answers: [answer(), answer({ app: { name: "Mail", pid: 3 } })], knobs: { "desktop.dictation.peekEveryMs": 1000 } });
    p.w.start(1, NOTES);
    await until(() => p.told.length === 1);
    p.w.done(1);
    await until(() => p.told.length === 2);
    await sleep(80);
    assert.deepStrictEqual(p.kinds(), ["peek:listening", "unpeek"]);
  }
  {
    // A read still out when the words land lands first, and is asked again:
    // the hop is where the caret is after them.
    const after = answer({ caret: [800, 300, 2, 18] });
    const p = watched({ answers: [answer(), answer(), after], slowMs: 30, knobs: { "desktop.dictation.peekEveryMs": 1000 } });
    p.w.start(1, NOTES);
    await until(() => p.told.length === 1);
    p.w.pasted(1);
    p.w.done(1);
    await until(() => p.kinds().includes("unpeek"));
    assert.deepStrictEqual(p.kinds(), ["peek:listening", "peek:done", "unpeek"]);
    assert.deepStrictEqual(p.told[1][1], after.caret);
  }
});

test("the watch: off (desktop.dictation.peek, or Ask off) asks nothing", async () => {
  for (const on of [() => false, () => undefined, () => { throw new Error("knobs"); }]) {
    const p = watched({ on });
    p.w.start(1, NOTES);
    await sleep(60);
    assert.deepStrictEqual([p.asked.length, p.told.length, p.w.watching()], [0, 0, 0]);
  }
});

test("the watch and the guide together: listening, writing, done and away, in the guide's window, with nothing for the recorder", async () => {
  const h = harness();
  const moved = answer({ caret: [700, 300, 2, 18] });
  const p = watched({ ask: h.ask, answers: [answer(), moved], knobs: { "desktop.dictation.peekEveryMs": 1000 } });
  p.w.start(17, NOTES);
  await until(() => peeks(h).length === 1);
  p.w.level(17, [0.5, 0.7]);
  p.w.pasted(17);
  await until(() => peeks(h).length === 2);
  p.w.stop(17);
  p.w.done(17);
  await until(() => h.types().includes("unpeek"));
  assert.deepStrictEqual(peeks(h).map((m) => [m.caret, m.state]), [
    [local(CARET), "listening"], [local(moved.caret), "listening"], [local(moved.caret), "writing"], [local(moved.caret), "done"],
  ]);
  assert.deepStrictEqual(h.sent.filter((m) => m.type === "peekLevel").map((m) => m.v), [0.6]);
  await sleep(400);
  assert.strictEqual(h.windows[0].visible, false, "the window goes once Blip has ducked");
  assert.deepStrictEqual(h.recorder, [], "nothing of the dictation is touched");
  assert.deepStrictEqual(h.requests, []);
});

// ---- Ask's one-time setup card: the main process's side (createAskSetup) ---------------

function setupCard(o = {}) {
  const handles = new Map();
  const ons = new Map();
  const ipcMain = { handle: (ch, f) => handles.set(ch, f), on: (ch, f) => ons.set(ch, f) };
  const APP = { id: "app window" }, OTHER = { id: "the guide, the pill, the recorder" };
  const did = [];
  const pushed = [];
  const localState = Object.assign({}, o.localState);
  const flags = Object.assign({}, o.flags);
  const sp = {
    isTrustedAccessibilityClient: (prompt) => { did.push(["trusted?", prompt]); return o.trusted !== undefined ? o.trusted : true; },
    getMediaAccessStatus: (what) => { did.push(["media?", what]); return o.screen || "granted"; },
  };
  let denied = !!o.denied;
  const card = createAskSetup({
    ipcMain, fromApp: (e) => !!e && e.sender === APP,
    platform: o.platform || "darwin", systemPreferences: o.systemPreferences || sp,
    knobs: { str: (k, f) => (k in flags ? flags[k] : f) },
    localState, saveLocalState: () => did.push(["saved", Object.assign({}, localState)]),
    screenDenied: () => denied,
    openAccessibility: () => did.push(["open", "accessibility"]),
    openScreenRecording: () => did.push(["open", "screen recording"]),
    relaunch: () => did.push(["relaunch"]),
    send: (s) => pushed.push(s),
  });
  return {
    card, did, pushed, localState, flags,
    deny: (v) => { denied = v; },
    ask: (sender = APP) => handles.get("app:askSetup")({ sender }),
    act: (p, sender = APP) => ons.get("app:askSetupAction")({ sender }, p),
    APP, OTHER, channels: () => [...handles.keys(), ...ons.keys()],
  };
}

test("setup: the window's names, as fixed between the builders", () => {
  const c = setupCard();
  assert.deepStrictEqual(c.channels(), ["app:askSetup", "app:askSetupAction"]);
});

test("setup: a Mac's three rows from the system's own answers; Windows and Linux have nothing to allow but pictures", () => {
  assert.deepStrictEqual(setupCard().ask(), { platform: "mac", read: "on", see: "on", pictures: "off" });
  assert.deepStrictEqual(setupCard({ trusted: false, screen: "denied" }).ask(), { platform: "mac", read: "off", see: "off", pictures: "off" });
  assert.deepStrictEqual(setupCard({ screen: "not-determined" }).ask().see, "off");
  // Asked without a prompt: reading the state never puts up the system's dialog.
  const c = setupCard();
  c.ask();
  assert.deepStrictEqual(c.did, [["trusted?", false], ["media?", "screen"]]);
  // Granted, but the helper's last look was still refused: a restart finishes it.
  assert.deepStrictEqual(setupCard({ denied: true }).ask().see, "restart");
  assert.deepStrictEqual(setupCard({ denied: true, screen: "denied" }).ask().see, "off", "not granted is off, whatever the look said");
  // The setup card's yes for every app, and the server's never, which wins.
  assert.deepStrictEqual(setupCard({ localState: { askPicturesAlwaysAll: true } }).ask().pictures, "on");
  assert.deepStrictEqual(setupCard({ localState: { askPicturesAlwaysAll: true }, flags: { "desktop.agent.pictures": "never" } }).ask().pictures, "never");
  assert.deepStrictEqual(setupCard({ localState: { askPicturesAlwaysAll: "yes" } }).ask().pictures, "off", "only a real true");
  // No system permission to read or see on Windows and Linux.
  assert.deepStrictEqual(setupCard({ platform: "win32" }).ask(), { platform: "windows", read: "na", see: "na", pictures: "off" });
  assert.deepStrictEqual(setupCard({ platform: "linux", denied: true }).ask(), { platform: "linux", read: "na", see: "na", pictures: "off" });
  const w = setupCard({ platform: "win32" });
  w.ask();
  assert.deepStrictEqual(w.did, [], "the Mac's checks are not asked elsewhere");
  // A system call that throws is off, never a crash.
  const boom = () => { throw new Error("no"); };
  assert.deepStrictEqual(setupCard({ systemPreferences: { isTrustedAccessibilityClient: boom, getMediaAccessStatus: boom } }).ask(), { platform: "mac", read: "off", see: "off", pictures: "off" });
});

test("setup: only the app window may ask or act", () => {
  const c = setupCard({ platform: "darwin", denied: true });
  assert.strictEqual(c.ask(c.OTHER), null);
  assert.strictEqual(c.ask(null), null);
  for (const p of [{ kind: "openAccessibility" }, { kind: "openScreenRecording" }, { kind: "picturesAll", on: true }, { kind: "relaunch" }]) c.act(p, c.OTHER);
  assert.deepStrictEqual(c.did, []);
  assert.deepStrictEqual(c.pushed, []);
  assert.deepStrictEqual(c.localState, {});
});

test("setup: each button does its one thing, and the window is told the state after it", () => {
  const c = setupCard();
  c.act({ kind: "openAccessibility" });
  c.act({ kind: "openScreenRecording" });
  assert.deepStrictEqual(c.did.filter((d) => d[0] === "open"), [["open", "accessibility"], ["open", "screen recording"]]);
  assert.strictEqual(c.pushed.length, 2);
  // Look at the screen when it's needed: on, and off again. Saved each time.
  c.act({ kind: "picturesAll", on: true });
  assert.strictEqual(c.localState.askPicturesAlwaysAll, true);
  assert.deepStrictEqual(c.did.filter((d) => d[0] === "saved").pop(), ["saved", { askPicturesAlwaysAll: true }]);
  assert.strictEqual(c.pushed[c.pushed.length - 1].pictures, "on");
  c.act({ kind: "picturesAll", on: false });
  assert.strictEqual(c.localState.askPicturesAlwaysAll, false);
  assert.strictEqual(c.pushed[c.pushed.length - 1].pictures, "off");
  // Only a real yes or no.
  const before = c.pushed.length;
  for (const on of ["true", 1, null, undefined, {}]) c.act({ kind: "picturesAll", on });
  assert.strictEqual(c.localState.askPicturesAlwaysAll, false);
  // Anything else is ignored: other kinds, other shapes.
  for (const p of [{ kind: "openSystemAudio" }, { kind: "openExternal", url: "https://x.test" }, { kind: "__proto__" }, "relaunch", null, 7, {}]) c.act(p);
  assert.strictEqual(c.pushed.length, before, "nothing done, nothing said");
  assert.ok(!c.did.some((d) => d[0] === "relaunch"));
});

test("setup: the Mac's pages are opened only on a Mac", () => {
  const c = setupCard({ platform: "win32" });
  c.act({ kind: "openAccessibility" });
  c.act({ kind: "openScreenRecording" });
  assert.deepStrictEqual(c.did, []);
  assert.deepStrictEqual(c.pushed, []);
  c.act({ kind: "picturesAll", on: true });
  assert.strictEqual(c.localState.askPicturesAlwaysAll, true, "the pictures row is the same everywhere");
});

test("setup: restart only when the card offers it (granted, and a look still refused)", () => {
  const c = setupCard();
  c.act({ kind: "relaunch" });
  assert.ok(!c.did.some((d) => d[0] === "relaunch"), "nothing to finish: a window cannot restart Tailzu at will");
  c.deny(true);
  assert.strictEqual(c.ask().see, "restart");
  c.act({ kind: "relaunch" });
  assert.deepStrictEqual(c.did.filter((d) => d[0] === "relaunch"), [["relaunch"]]);
  const w = setupCard({ platform: "win32", denied: true });
  w.act({ kind: "relaunch" });
  assert.ok(!w.did.some((d) => d[0] === "relaunch"));
});

test("pictures: the setup card's yes is always, for every app, browser pages and unnamed apps included; the server's never still wins", async () => {
  {
    const h = await begun({ alwaysAll: true, info: { label: "Chrome: Dashboard", pictureKey: null } });
    assert.strictEqual(h.deps().pictures("Chrome: Dashboard"), "always");
    assert.strictEqual(h.deps().pictures("anything at all"), "always");
    h.ask.cancel("test over");
  }
  {
    const h = await begun({ alwaysAll: true, knobs: { "desktop.agent.pictures": "never" } });
    assert.strictEqual(h.deps().pictures("Keynote"), "never");
    h.ask.cancel("test over");
  }
  {
    const h = await begun({ alwaysAll: false });
    assert.strictEqual(h.deps().pictures("Keynote"), "ask");
    h.ask.cancel("test over");
  }
});

test("picture: with the setup card's yes, a picture question asks nothing on screen and the crop goes", async () => {
  const { h } = await pictureQuestion({ alwaysAll: true, info: { label: "Chrome: Notes", pictureKey: null } });
  await until(() => h.requests.length === 1);
  assert.ok(!h.types().includes("permission"), "the on-screen card is never shown");
  assert.ok(h.requests[0].multipart && h.requests[0].parts.image, "the picture went with the question");
  h.ask.cancel("test over");
});

test("a look's word on Screen Recording is kept, and the setup card told each time it changes", async () => {
  const told = [];
  let look = { ok: false, error: "no_screen_permission" };
  const h = harness({ look: { ok: false, error: "timeout" }, lookPermission: (d) => told.push(d) });
  // The harness's driver, with a look that says what this test says.
  const d = h.deps().driver;
  assert.strictEqual(typeof d.look, "function");
  const base = Object.getPrototypeOf(d);
  base.look = async () => look;
  assert.strictEqual(h.ask.screenDenied(), false);
  await d.look({});
  assert.deepStrictEqual([h.ask.screenDenied(), told], [true, [true]]);
  await d.look({});
  assert.deepStrictEqual(told, [true], "told once per change");
  // A look that says nothing about it (timed out, no window) changes nothing.
  for (look of [{ ok: false, error: "timeout" }, { ok: false, error: "no_window" }, null]) await d.look({});
  assert.deepStrictEqual([h.ask.screenDenied(), told], [true, [true]]);
  look = { ok: true, window: { frame: [0, 0, 10, 10] }, lines: [] };
  await d.look({});
  assert.deepStrictEqual([h.ask.screenDenied(), told], [false, [true, false]]);
});

test("a driver with no look keeps none: the run sees no look, as before", () => {
  const h = harness();
  assert.strictEqual(typeof h.deps().driver.look, "undefined");
});

// ---- main.js, run whole with Electron faked ----------------------------------------------
// The peek and the setup card are wired into main.js, which cannot run outside
// Electron. Here it does: its own source, every Electron module it uses
// played by a fake, the helper and the app in front scripted. What plain
// dictation RECORDS, SENDS and PASTES is all in three places, and each is
// written down in order: every message to the recorder's window (what to
// record, the app, the field, the screen around it, stop, cancel), every
// clipboard write, and every paste keystroke.
const os = require("node:os");
const { Module } = require("node:module");
const MAIN_JS = path.join(__dirname, "main.js");

function mainProcess(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tailzu-main-"));
  // Signed in, and far from needing a new token.
  fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify({ access_token: "tok", refresh_token: "ref", expires_at: 4102444800 }));
  // Always a bootstrap of its own: knobs.js keeps the last one it was given.
  fs.writeFileSync(path.join(dir, "bootstrap.json"), JSON.stringify({ labels: {}, flags: Object.assign({ "desktop.paste.delayMs": 1 }, o.flags) }));
  const dictation = [];   // what plain dictation records, sends and pastes
  const guide = [];       // what the guide's window was sent
  const carets = [];      // what the helper was asked
  const timers = new Set();
  const ipc = new EventEmitter();
  const handles = new Map();
  const shortcuts = [];
  const windows = [];
  const trayMenus = [];   // the tray's menus, as built (Menu.buildFromTemplate's template)
  const copy = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  class BW extends EventEmitter {
    constructor(opts) {
      super();
      this.opts = opts || {}; this.visible = false; this.destroyed = false; this.file = null;
      this.bounds = { x: this.opts.x || 0, y: this.opts.y || 0, width: this.opts.width || 100, height: this.opts.height || 100 };
      const self = this;
      this.webContents = Object.assign(new EventEmitter(), {
        send: (ch, m) => {
          if (self.file === "recorder.html") dictation.push(["recorder", ch, copy(m)]);
          else if (self.file === "guide.html") guide.push(copy(m));
          else if (self.file === "app.html") (self.appSent = self.appSent || []).push([ch, copy(m)]);
        },
        isLoading: () => false, isDestroyed: () => self.destroyed, getURL: () => "file://" + self.file,
        setWindowOpenHandler() {},
      });
      windows.push(this);
    }
    static getFocusedWindow() { return null; }
    loadFile(f) { this.file = f; setImmediate(() => this.webContents.emit("did-finish-load")); }
    setVisibleOnAllWorkspaces() {} setIgnoreMouseEvents() {} setContentProtection() {} setAlwaysOnTop() {} moveTop() {}
    isVisible() { return this.visible; } isDestroyed() { return this.destroyed; }
    show() { this.visible = true; } showInactive() { this.visible = true; } hide() { this.visible = false; } focus() {}
    destroy() { this.destroyed = true; } close() {}
    getBounds() { return Object.assign({}, this.bounds); } setBounds(b) { this.bounds = Object.assign({}, b); }
  }
  const img = { resize: () => img, setTemplateImage() {}, isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }) };
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true, getPath: () => dir, setPath() {}, getVersion: () => "0.4.0",
    requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(),
    quit() {}, exit() {}, relaunch() {}, dock: { hide() {} }, setAppUserModelId() {},
    getLoginItemSettings: () => ({ wasOpenedAtLogin: false }), setLoginItemSettings() {},
  });
  const electron = {
    app, BrowserWindow: BW, ipcMain: { on: (ch, f) => ipc.on(ch, f), handle: (ch, f) => handles.set(ch, f) },
    Tray: class { setImage() {} setToolTip() {} setContextMenu(m) { trayMenus.push(m); } setTitle() {} },
    Menu: { buildFromTemplate: (t) => ({ t }), setApplicationMenu() {} },
    globalShortcut: { register: (k, f) => { shortcuts.push(f); return true; }, unregisterAll() {} },
    screen: {
      getCursorScreenPoint: () => ({ x: 500, y: 400 }), getDisplayNearestPoint: () => ({ workArea: WORK, bounds: WORK }),
      getDisplayMatching: () => ({ workArea: WORK, bounds: WORK }), on() {}, screenToDipRect: (_w, r) => r,
    },
    clipboard: { writeText: (t) => dictation.push(["clipboard", t]) },
    Notification: class { show() {} on() {} },
    nativeImage: { createFromPath: () => img, createEmpty: () => img, createFromBuffer: () => img },
    session: { defaultSession: { setPermissionRequestHandler() {} } },
    shell: { openExternal: async () => {}, openPath: async () => {} },
    nativeTheme: { shouldUseDarkColors: false }, powerMonitor: { on() {} },
    desktopCapturer: { getSources: async () => [] },
    systemPreferences: { isTrustedAccessibilityClient: () => true, getMediaAccessStatus: () => "granted" },
  };
  const childProcess = {
    execFile: (cmd, args, opts, cb) => { dictation.push(["keystroke", cmd, args]); setImmediate(() => cb && cb(null, "", "")); },
    spawn: () => { throw new Error("nothing is spawned here"); },
  };
  const realFront = require("./frontApp.js");
  const infos = (o.infos || [NOTES]).slice();
  const frontApp = {
    frontInfo: async () => (infos.length > 1 ? infos.shift() : infos[0]),
    focusedField: async () => ({ kind: "message", label: "Message", before: "Dear Sam," }),
    warmUp() {}, shutDown() {}, label: realFront.label, looksSensitive: realFront.looksSensitive,
  };
  const driver = {
    available: () => true, start() {}, stop() {},
    snapshot: async () => ({ ok: false, error: "unsupported" }),
    // Which dictation it was asked during (how many had started by then).
    caret: (opt) => {
      carets.push(Object.assign({ during: dictation.filter(([w, ch]) => w === "recorder" && ch === "start-recording").length }, opt));
      return o.caret ? o.caret() : Promise.resolve(answer());
    },
  };
  const fakes = {
    electron, child_process: childProcess, "./frontApp.js": frontApp, "./driver.js": driver,
    "./screenRead.js": { readScreen: async () => "Sam: are we still on for Friday?" },
    "./updater.js": { canSelfUpdate: () => false, update: async () => ({ ok: false }) },
  };
  const req = (id) => {
    if (Object.prototype.hasOwnProperty.call(fakes, id)) return fakes[id];
    if (id === "uiohook-napi") throw new Error("no key hook in tests");
    return require(id.startsWith("./") ? path.join(__dirname, id) : id);
  };
  // Its timers never keep the tests alive, and all of them go with it.
  const T = (set) => (f, ms, ...a) => { const t = set(f, ms, ...a); if (t && t.unref) t.unref(); timers.add(t); return t; };
  const src = o.source || fs.readFileSync(MAIN_JS, "utf8");
  const wrapped = vm.runInThisContext("(function (exports, require, module, __filename, __dirname, setTimeout, setInterval, fetch) {" + src + "\n})", { filename: MAIN_JS });
  const mod = { exports: {} };
  const quiet = { log: console.log, warn: console.warn };
  console.warn = () => {}; console.log = () => {};
  try {
    wrapped(mod.exports, req, mod, MAIN_JS, __dirname, T(setTimeout), T(setInterval), async () => new Response("{}", { status: 503 }));
  } finally { Object.assign(console, quiet); }
  const win = (file) => windows.find((w) => w.file === file && !w.destroyed);
  const from = (file) => ({ sender: win(file).webContents });
  return {
    dictation, guide, carets, ipc, handles, windows, win, dir,
    /** The tray's menu as it is now: its template's items. */
    tray: () => (trayMenus.length ? trayMenus[trayMenus.length - 1].t : []),
    ready: () => sleep(20),
    // The hotkey (the first accelerator main registers is dictation's).
    hotkey: () => shortcuts[0](),
    fromRecorder: (ch, p) => ipc.emit(ch, from("recorder.html"), p),
    fromPill: (ch, p) => ipc.emit(ch, from("pill.html"), p),
    fromApp: (ch, ...a) => ipc.emit(ch, from("app.html"), ...a),
    invoke: (ch, sender, ...a) => handles.get(ch)({ sender }, ...a),
    sessions: () => dictation.filter(([w, ch]) => w === "recorder" && ch === "start-recording").map(([, , p]) => p.session),
    close: () => {
      for (const t of timers) clearTimeout(t);
      app.emit("will-quit");
      fs.rmSync(dir, { recursive: true, force: true });
      require("./knobs.js").setKnobs({ labels: {}, flags: {} });
    },
  };
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
    const appWin = m.win("app.html");
    const appWc = appWin.webContents, other = m.win("pill.html").webContents;
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
    assert.strictEqual(off.invoke("app:env", off.win("app.html").webContents).askSetup, false, "Ask off: no card");
  } finally { off.close(); }
});

test("main: the tray's \"Ask again for all of them\" takes back the setup card's yes for every app too, and the card is told", async () => {
  const m = mainProcess();
  try {
    await m.ready();
    const appWin = m.win("app.html");
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
