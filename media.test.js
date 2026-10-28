// The app window's media actions (media.js): sending a picked file with its
// progress, playing one sound at a time, and both stopping with their screen.
// media.js is a page script loaded after sdui.js; here it runs in one context
// with stand-ins for what it uses of sdui.js (state, painting, run, the
// session) and of the page (the chooser, XMLHttpRequest, fetch, Web Audio).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = fs.readFileSync(path.join(__dirname, "media.js"), "utf8");

function page(o = {}) {
  const state = {};
  const ran = [];
  const toasts = [];
  let paints = 0;
  const xhrs = [];
  const get = (p) => p.split(".").reduce((a, k) => (a == null ? undefined : a[k]), state);
  const put = (p, v) => {
    const ks = p.split(".");
    let cur = state;
    for (let i = 0; i < ks.length - 1; i++) { if (typeof cur[ks[i]] !== "object" || cur[ks[i]] == null) cur[ks[i]] = {}; cur = cur[ks[i]]; }
    cur[ks[ks.length - 1]] = v;
  };
  class FakeXHR {
    constructor() { this.upload = {}; this.headers = {}; xhrs.push(this); }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(k, v) { this.headers[k] = v; }
    send(form) {
      this.form = form;
      const answer = o.answer || { status: 201, body: JSON.stringify({ file: { id: "f1", bytes: 2048 }, attachment: { id: "f1", kind: "pdf" }, cached: false }) };
      (o.slow ? (fn) => setTimeout(fn, 200) : setImmediate)(() => {
        if (this.aborted) return;
        this.upload.onprogress && this.upload.onprogress({ lengthComputable: true, loaded: 1024, total: 2048 });
        this.upload.onprogress && this.upload.onprogress({ lengthComputable: true, loaded: 2048, total: 2048 });
        this.status = answer.status;
        this.responseText = answer.body;
        this.onload && this.onload();
      });
    }
    abort() { this.aborted = true; this.onabort && this.onabort(); }
  }
  class FakeFormData { constructor() { this.parts = []; } append(k, v, n) { this.parts.push([k, v, n]); } }
  class FakeFile { constructor(bits, name, opts) { this.bits = bits; this.name = name; this.type = opts && opts.type; this.size = 10; } }
  const chosen = o.file === undefined ? { name: "Price list.pdf", size: 2048 } : o.file;
  const document = {
    activeElement: null,
    body: { appendChild: () => {} },
    querySelectorAll: () => [],
    createElement: () => {
      const listeners = {};
      return {
        style: {},
        addEventListener: (ev, fn) => { listeners[ev] = fn; },
        remove: () => {},
        click() {
          setImmediate(() => {
            if (chosen) { this.files = [chosen]; listeners.change && listeners.change(); } else { listeners.cancel && listeners.cancel(); }
          });
        },
      };
    },
  };
  class FakeAC {
    constructor() { this.currentTime = 0; this.state = "running"; this.destination = {}; }
    decodeAudioData() { return Promise.resolve({ duration: 5 }); }
    createBufferSource() { const n = { connect() {}, disconnect() {}, start() { n.started = true; }, stop() { n.stopped = true; } }; sounds.push(n); return n; }
    resume() { return Promise.resolve(); }
  }
  const sounds = [];
  const fetched = [];
  const ctx = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, Promise, JSON, Object, Array, String, Number, Math, Date, RegExp, Error, Map,
    encodeURIComponent,
    window: { addEventListener: () => {}, tailzuApp: o.bridge || {} },
    document,
    XMLHttpRequest: FakeXHR, FormData: FakeFormData, File: FakeFile, AudioContext: FakeAC,
    fetch: async (url, init) => { fetched.push({ url, init }); return o.sound || { ok: true, arrayBuffer: async () => new ArrayBuffer(8), text: async () => "" }; },
    K: { txt: (_k, f) => f, num: (_k, f) => f },
    ENV: { baseUrl: "https://api.tailzu.space" },
    STACK: [{ screenId: "bots.ask" }],
    COMPONENTS: ["Screen"], ACTIONS: ["navigate"],
    stateAt: get, setStatePath: put,
    repaint: () => { paints += 1; },
    run: async (ref, ev) => { if (ref) ran.push(arguments.length > 1 ? [ref, ev] : [ref]); },
    bearer: async () => "tok",
    toast: (m) => toasts.push(m),
  };
  ctx.run = async function (ref, ev) { if (ref) ran.push(arguments.length > 1 ? [ref, ev] : [ref]); };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const m = vm.runInContext("({ mediaRun, mediaLeave, mediaSize, mediaClock, mediaRefusal, mediaSource, mediaName, mediaPlayState })", ctx);
  return { m, ctx, state, ran, toasts, xhrs, sounds, fetched, paints: () => paints };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

test("it says it can, to the server", () => {
  const p = page();
  assert.ok(p.ctx.COMPONENTS.includes("FileUpload") && p.ctx.COMPONENTS.includes("AudioPlay"));
  assert.ok(["uploadFile", "playAudio", "stopAudio"].every((a) => p.ctx.ACTIONS.includes(a)));
});

test("sizes, times and refusals, written for a person", () => {
  const { m } = page();
  assert.equal(m.mediaSize(412 * 1024), "412 KB");
  assert.equal(m.mediaSize(3.4 * 1024 * 1024), "3.4 MB");
  assert.equal(m.mediaClock(65), "1:05");
  assert.deepEqual({ ...m.mediaPlayState("sage", 2, 5) }, { id: "sage", pct: 40, at: "0:02", of: "0:05", time: "0:02 / 0:05" });
  assert.equal(m.mediaRefusal(413, JSON.stringify({ code: "too_big", message: "That video is over 50 MB, which is the most I read of its kind." })),
    "That video is over 50 MB, which is the most I read of its kind.");
  assert.equal(m.mediaRefusal(401, JSON.stringify({ message: "Missing or invalid token" })), "Your session has expired. Sign in again to continue.");
  assert.equal(m.mediaRefusal(400, JSON.stringify({ message: "Send the file as a multipart form with one `file` part." })), "Couldn't send that file. Try again.");
  assert.equal(m.mediaRefusal(404, JSON.stringify({ code: "media_off" })), "Sending files isn't switched on yet.");
  assert.deepEqual({ ...m.mediaSource("/v1/keybot/voices/sage/sample") }, { path: "/v1/keybot/voices/sage/sample" });
  assert.equal(m.mediaSource("//evil.com/x"), null);
  assert.equal(m.mediaSource("http://evil.com/x"), null);
  assert.equal(m.mediaName("../../a/b?.pdf", "file"), "b.pdf");
});

test("a chosen file goes up with its progress, and the answer lands in state", async () => {
  const p = page();
  const a = { kind: "uploadFile", pick: "file", path: "/v1/files", assignTo: "sent", progressTo: "up", onSuccess: { kind: "toast", message: "ok" }, onError: { kind: "toast", message: "$event" } };
  const seen = [];
  p.ctx.setStatePath = ((put) => (k, v) => { if (k === "up" && v) seen.push(v.percent); put(k, v); })(p.ctx.setStatePath);
  await p.m.mediaRun(a);
  const x = p.xhrs[0];
  assert.equal(x.method, "POST");
  assert.equal(x.url, "https://api.tailzu.space/v1/files");
  assert.equal(x.headers.Authorization, "Bearer tok");
  assert.equal(x.form.parts[0][0], "file");
  assert.equal(x.form.parts[0][2], "Price list.pdf");
  assert.equal(p.state.up, undefined);
  assert.equal(p.state.sent.name, "Price list.pdf");
  assert.equal(p.state.sent.size, "2 KB");
  assert.deepEqual({ ...p.state.sent.attachment }, { id: "f1", kind: "pdf" });
  assert.deepEqual(p.ran.map((r) => r[0].message), ["ok"]);
  assert.ok(p.paints() >= 2);
});

test("a refusal is said, in the server's words when they are for a person", async () => {
  const p = page({ answer: { status: 422, body: JSON.stringify({ code: "password", message: "That PDF is password-protected." }) } });
  await p.m.mediaRun({ kind: "uploadFile", pick: "file", assignTo: "sent", progressTo: "up", onError: { kind: "toast", message: "$event" } });
  assert.equal(p.state.up, undefined);
  assert.equal(p.state.sent, undefined);
  assert.equal(p.ran[0][1], "That PDF is password-protected.");
});

test("nothing chosen is nothing sent; too big is said before sending", async () => {
  const none = page({ file: null });
  await none.m.mediaRun({ kind: "uploadFile", pick: "photo", assignTo: "sent", onCancel: { kind: "toast", message: "none" } });
  assert.equal(none.xhrs.length, 0);
  assert.equal(none.ran[0][0].message, "none");
  const big = page({ file: { name: "movie.mov", size: 60 * 1024 * 1024 } });
  await big.m.mediaRun({ kind: "uploadFile", pick: "video", assignTo: "sent", onError: { kind: "toast", message: "$event" } });
  assert.equal(big.xhrs.length, 0);
  assert.equal(big.ran[0][1], "That file is over 50 MB, the most Tailzu takes.");
});

test("a screenshot is the Mac's own picker; refused Screen Recording offers a picture", async () => {
  const mac = page({ bridge: { captureScreen: async () => ({ name: "Screenshot 2026-10-28 at 20.15.png", bytes: new Uint8Array(100) }) } });
  await mac.m.mediaRun({ kind: "uploadFile", pick: "screenshot", assignTo: "sent", progressTo: "up" });
  assert.equal(mac.xhrs[0].form.parts[0][2], "Screenshot 2026-10-28 at 20.15.png");
  const off = page({ bridge: { captureScreen: async () => ({ unavailable: true, why: "screen" }) } });
  await off.m.mediaRun({ kind: "uploadFile", pick: "screenshot", assignTo: "sent" });
  assert.equal(off.toasts[0], "Screen Recording is off for Tailzu, so pick a picture instead.");
  assert.equal(off.xhrs[0].form.parts[0][2], "Price list.pdf");
  const esc = page({ bridge: { captureScreen: async () => ({ cancelled: true }) } });
  await esc.m.mediaRun({ kind: "uploadFile", pick: "screenshot", assignTo: "sent" });
  assert.equal(esc.xhrs.length, 0);
});

test("one sound at a time, from the app's own path with the session; it stops with its screen", async () => {
  const p = page();
  p.state.read = { speed: "1.25" };
  await p.m.mediaRun({ kind: "playAudio", url: "/v1/keybot/voices/sage/sample?speed=$state.read.speed", id: "sage", statePath: "playing" });
  assert.equal(p.fetched[0].url, "https://api.tailzu.space/v1/keybot/voices/sage/sample?speed=1.25");
  assert.equal(p.fetched[0].init.headers.Authorization, "Bearer tok");
  assert.equal(p.state.playing.id, "sage");
  assert.ok(p.sounds[0].started);

  // Another: the first stops.
  await p.m.mediaRun({ kind: "playAudio", url: "/v1/keybot/voices/nova/sample", id: "nova", statePath: "playing" });
  assert.ok(p.sounds[0].stopped);
  assert.equal(p.state.playing.id, "nova");

  // Stop.
  await p.m.mediaRun({ kind: "stopAudio" });
  assert.equal(p.state.playing, undefined);
  assert.ok(p.sounds[1].stopped);

  // Painting the same screen again keeps it; another screen stops it.
  await p.m.mediaRun({ kind: "playAudio", url: "/v1/keybot/voices/nova/sample", id: "nova", statePath: "playing" });
  assert.equal(p.fetched.length, 2); // decoded once, kept
  p.m.mediaLeave(p.ctx.STACK[0]);
  assert.equal(p.state.playing.id, "nova");
  p.m.mediaLeave({ screenId: "bots.home" });
  assert.equal(p.state.playing, undefined);
  assert.ok(p.sounds[2].stopped);
});

test("a sound that cannot be had is said plainly", async () => {
  const p = page({ sound: { ok: false, status: 503, text: async () => JSON.stringify({ message: "Couldn't play that voice right now. Try again." }) } });
  await p.m.mediaRun({ kind: "playAudio", url: "/v1/keybot/voices/sage/sample", id: "sage", statePath: "playing", onError: { kind: "toast", message: "$event" } });
  assert.equal(p.state.playing, undefined);
  assert.equal(p.ran[0][1], "Couldn't play that voice right now. Try again.");
  const bad = page();
  await bad.m.mediaRun({ kind: "playAudio", url: "http://evil.com/a.mp3", statePath: "playing", onError: { kind: "toast", message: "$event" } });
  assert.equal(bad.fetched.length, 0);
  assert.equal(bad.ran[0][1], "Couldn't play that. Try again.");
});

test("an upload from a screen that went is dropped", async () => {
  const p = page({ slow: true });
  const going = p.m.mediaRun({ kind: "uploadFile", pick: "file", assignTo: "sent", progressTo: "up", onSuccess: { kind: "toast", message: "ok" } });
  while (!(p.xhrs[0] && p.xhrs[0].form)) await flush();
  p.m.mediaLeave({ screenId: "bots.home" });
  await going;
  assert.ok(p.xhrs[0].aborted);
  assert.equal(p.ran.length, 0);
});
