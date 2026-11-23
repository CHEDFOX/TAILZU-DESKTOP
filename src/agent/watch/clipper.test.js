// node --test
//
// Ask's clip, in the main process (clipper.js): the window found by its title,
// the hidden window asked to record it with the computer's sound as this
// platform hears it, its answer taken only for the clip it was asked for, and
// the permission handler's two questions. Electron's pieces are fakes.

const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { createClipper } = require("./clipper.js");

function rig(o = {}) {
  const sent = [];
  const handlers = {};
  const wins = [];
  class FakeWindow {
    constructor(opts) {
      this.opts = opts;
      this.destroyed = false;
      this.webContents = Object.assign(new EventEmitter(), {
        isLoading: () => false,
        send: (channel, payload) => {
          sent.push([channel, payload]);
          if (channel === "watch:record" && typeof o.answer === "function") setTimeout(() => o.answer(payload, this.webContents, handlers), 1);
        },
      });
      wins.push(this);
    }
    loadFile(f) { this.file = f; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  const sources = o.sources || [
    { id: "window:11:0", name: "design | Slack" },
    { id: "window:22:0", name: "cats.mp4 - VLC media player" },
  ];
  const asked = [];
  const desktopCapturer = {
    getSources: async (q) => { asked.push(q); return q.types[0] === "screen" ? [{ id: "screen:0:0", name: "Entire screen" }] : sources; },
  };
  const spawned = [];
  const spawn = (bin, args, opts) => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stdin: { end: () => { child.ended = true; } }, kill: () => { child.killed = true; } });
    spawned.push({ bin, args, opts, child });
    return child;
  };
  const clipper = createClipper(Object.assign({
    BrowserWindow: FakeWindow,
    ipcMain: { on: (ch, fn) => { handlers[ch] = fn; } },
    desktopCapturer,
    webPrefs: (extra) => Object.assign({ preload: "preload.js", sandbox: true }, extra),
    hardenWindow: (w) => { w.hardened = true; },
    platform: o.platform || "win32",
    spawn, tapPath: () => (o.noTap ? null : "/app/audiotap"),
    notesBusy: () => o.notesBusy === true,
    knob: (name, fallback) => (o.knobs && name in o.knobs ? o.knobs[name] : fallback),
  }, o.deps));
  return { clipper, sent, handlers, wins, asked, spawned };
}

const OPTS = { title: "cats.mp4 - VLC media player", seconds: 6, maxSide: 960, fps: 4, maxBytes: 8000000, sound: true };
const reply = (p) => (cfg, wc, handlers) => handlers["watch:done"]({ sender: wc }, Object.assign({ id: cfg.id }, p));

test("records the window titled as the look's, with Windows' loopback for its sound, and hands the file back", async () => {
  const data = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);
  const r = rig({ answer: reply({ ok: true, mime: "video/webm", data, sound: true, seconds: 6.04 }) });
  const got = await r.clipper.record(OPTS);
  assert.deepStrictEqual(got, { mime: "video/webm", data: Buffer.from(data), sound: true, seconds: 6 });
  const [channel, cfg] = r.sent[0];
  assert.strictEqual(channel, "watch:record");
  assert.strictEqual(cfg.sourceId, "window:22:0", "the window of that title, not the first one");
  assert.deepStrictEqual(cfg.sound, { system: "desktop", sourceId: "screen:0:0" });
  assert.strictEqual(cfg.seconds, 6);
  assert.strictEqual(cfg.maxSide, 960);
  assert.strictEqual(cfg.fps, 4);
  assert.strictEqual(cfg.maxBytes, 8000000);
  assert.ok(cfg.types.sound[0].startsWith("video/webm"));
  // A hidden window, hardened, that keeps its timers when hidden.
  const w = r.wins[0];
  assert.strictEqual(w.opts.show, false);
  assert.strictEqual(w.opts.webPreferences.backgroundThrottling, false);
  assert.strictEqual(w.hardened, true);
  assert.match(w.file, /watch\.html$/);
  assert.strictEqual(r.clipper.recording(), false, "done");
});

test("no title, or no window of that title: nothing is recorded, and never the only window there is", async () => {
  const r = rig({ sources: [{ id: "window:9:0", name: "Some other app" }] });
  assert.strictEqual(await r.clipper.record(Object.assign({}, OPTS, { title: "" })), null);
  assert.strictEqual(await r.clipper.record(OPTS), null);
  assert.deepStrictEqual(r.sent, []);
  // A title cut short on one side still finds it.
  const cut = rig({ answer: reply({ ok: true, mime: "video/webm", data: new Uint8Array([1]), sound: false }) });
  await cut.clipper.record(Object.assign({}, OPTS, { title: "cats.mp4 - VLC" }));
  assert.strictEqual(cut.sent[0][1].sourceId, "window:22:0");
});

test("the computer's sound per platform, never the microphone: macOS's helper (not during a note), Linux's monitor, or none", async () => {
  const later = (f) => (cfg, wc, handlers) => setTimeout(() => f(cfg, wc, handlers), 30);
  const mac = rig({ platform: "darwin", answer: later(reply({ ok: true, mime: "video/webm", data: new Uint8Array([1]), sound: true })) });
  const pending = mac.clipper.record(OPTS);
  await new Promise((res) => setTimeout(res, 0));
  await new Promise((res) => setTimeout(res, 0));
  assert.strictEqual(mac.spawned.length, 1, "a helper of the clip's own");
  assert.strictEqual(mac.spawned[0].bin, "/app/audiotap");
  // Its PCM, whole samples only, goes to the hidden window as it comes.
  mac.spawned[0].child.stdout.emit("data", Buffer.from([1, 2, 3]));
  mac.spawned[0].child.stdout.emit("data", Buffer.from([4]));
  await pending;
  assert.deepStrictEqual(mac.sent[0][1].sound, { system: "pcm" });
  assert.deepStrictEqual(mac.sent.filter((s) => s[0] === "watch:pcm").map((s) => [...s[1]]), [[1, 2], [3, 4]]);
  assert.strictEqual(mac.spawned[0].child.ended, true, "stopped with the clip");

  const noting = rig({ platform: "darwin", notesBusy: true, answer: reply({ ok: true, mime: "video/webm", data: new Uint8Array([1]), sound: false }) });
  await noting.clipper.record(OPTS);
  assert.deepStrictEqual(noting.sent[0][1].sound, { system: "none" });
  assert.strictEqual(noting.spawned.length, 0);

  const linux = rig({ platform: "linux", answer: reply({ ok: true, mime: "video/webm", data: new Uint8Array([1]), sound: true }) });
  await linux.clipper.record(OPTS);
  assert.deepStrictEqual(linux.sent[0][1].sound, { system: "monitor", pattern: "monitor" });

  const quiet = rig({ answer: reply({ ok: true, mime: "video/webm", data: new Uint8Array([1]), sound: false }) });
  await quiet.clipper.record(Object.assign({}, OPTS, { sound: false }));
  assert.deepStrictEqual(quiet.sent[0][1].sound, { system: "none" });
});

test("past the cap: { tooBig }; a failure or no data: null", async () => {
  const big = rig({ answer: reply({ ok: true, tooBig: true }) });
  assert.deepStrictEqual(await big.clipper.record(OPTS), { tooBig: true });
  const failed = rig({ answer: reply({ ok: false, error: "Permission denied" }) });
  assert.strictEqual(await failed.clipper.record(OPTS), null);
  const empty = rig({ answer: reply({ ok: true, mime: "video/webm", data: new Uint8Array(0) }) });
  assert.strictEqual(await empty.clipper.record(OPTS), null);
});

test("only the hidden window's answer for this clip is taken; a window that never answers is given up on", async () => {
  const r = rig({
    knobs: { "desktop.agent.videoWaitMs": 1000 },
    answer: (cfg, wc, handlers) => {
      handlers["watch:done"]({ sender: { other: true } }, { id: cfg.id, ok: true, mime: "video/webm", data: new Uint8Array([9]) });
      handlers["watch:done"]({ sender: wc }, { id: cfg.id + 1, ok: true, mime: "video/webm", data: new Uint8Array([9]) });
    },
  });
  const t0 = Date.now();
  const got = await r.clipper.record(Object.assign({}, OPTS, { seconds: 1 }));
  assert.strictEqual(got, null);
  assert.ok(Date.now() - t0 >= 1900, "waited out the clip and the grace");
  assert.ok(r.sent.some((s) => s[0] === "watch:stop"), "and told the window to stop");
});

test("the permission handler's questions: its own window, only while a clip records; one clip at a time", async () => {
  let release;
  const r = rig({ answer: (cfg, wc, handlers) => { release = () => handlers["watch:done"]({ sender: wc }, { id: cfg.id, ok: true, mime: "video/webm", data: new Uint8Array([1]) }); } });
  assert.strictEqual(r.clipper.recording(), false);
  const first = r.clipper.record(OPTS);
  await new Promise((res) => setTimeout(res, 10));
  const wc = r.wins[0].webContents;
  assert.strictEqual(r.clipper.owns(wc), true);
  assert.strictEqual(r.clipper.owns({}), false);
  assert.strictEqual(r.clipper.recording(), true);
  assert.strictEqual(await r.clipper.record(OPTS), null, "a second at once is refused");
  release();
  await first;
  assert.strictEqual(r.clipper.recording(), false);
});
