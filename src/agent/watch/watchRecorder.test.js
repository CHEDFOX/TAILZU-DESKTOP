// node --test
//
// Ask's clip window (watchRecorder.js), run in a small stand-in for the
// browser: what it asks getUserMedia for (the window's capture source, and the
// computer's sound only as a desktop or monitor source, never an ordinary
// microphone), how it records, when it stops, and what it hands back.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function rig(o = {}) {
  const done = [];
  const asked = [];
  const recorders = [];
  const stopped = [];
  let onRecord = null, onStop = null;
  const track = (kind) => ({ kind, stop: () => stopped.push(kind) });
  const stream = (kinds) => {
    let tracks = kinds.map(track);
    return {
      getTracks: () => tracks,
      getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
      getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
      removeTrack: (t) => { tracks = tracks.filter((x) => x !== t); },
    };
  };
  class FakeRecorder {
    static isTypeSupported(t) { return !(o.unsupported || []).includes(t); }
    constructor(s, opts) { this.stream = s; this.opts = opts; this.state = "inactive"; recorders.push(this); }
    start(slice) {
      this.slice = slice;
      this.state = "recording";
      // A second's worth of data each tick, while it records.
      this.tick = setInterval(() => { if (this.ondataavailable) this.ondataavailable({ data: new Blob([Buffer.alloc(o.chunk || 100, 1)]) }); }, 5);
    }
    stop() {
      clearInterval(this.tick);
      this.state = "inactive";
      setTimeout(() => {
        if (this.ondataavailable) this.ondataavailable({ data: new Blob([Buffer.alloc(o.chunk || 100, 2)]) });
        if (this.onstop) this.onstop();
      }, 1);
    }
  }
  class FakeMediaStream {
    constructor(tracks) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter((t) => t.kind === "audio"); }
    getVideoTracks() { return this.tracks.filter((t) => t.kind === "video"); }
  }
  class FakeAudioContext {
    constructor(opts) { this.opts = opts; this.currentTime = 0; }
    createMediaStreamDestination() { return { stream: stream(["audio"]) }; }
    close() { this.closed = true; }
  }
  const window = {
    tailzuWatch: {
      onRecord: (cb) => { onRecord = cb; },
      onStop: (cb) => { onStop = cb; },
      onPcm: () => {},
      done: (p) => done.push(p),
    },
  };
  const ctx = {
    window, MediaRecorder: FakeRecorder, MediaStream: FakeMediaStream, AudioContext: FakeAudioContext,
    navigator: {
      mediaDevices: {
        getUserMedia: async (c) => {
          asked.push(c);
          if (o.refuse) throw new Error("Permission denied");
          return stream([c.video ? "video" : null, c.audio ? "audio" : null].filter(Boolean));
        },
        enumerateDevices: async () => o.devices || [],
      },
    },
    performance, Blob, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Uint8Array, Int16Array, Float32Array, console,
  };
  ctx.window.MediaRecorder = FakeRecorder;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "watchRecorder.js"), "utf8"), ctx);
  // Objects made inside the stand-in are of its own realm: compared as plain data.
  const plain = (v) => JSON.parse(JSON.stringify(v));
  return {
    get done() { return done.map((p) => (p.data ? Object.assign(plain(Object.assign({}, p, { data: undefined })), { data: p.data }) : plain(p))); },
    get asked() { return plain(asked); },
    recorders, stopped, record: (cfg) => onRecord(cfg), stop: (p) => onStop(p),
  };
}

const CFG = { id: 3, sourceId: "window:22:0", seconds: 0.05, maxSide: 960, fps: 4, maxBytes: 100000, videoBitrate: 900000, audioBitrate: 32000, sound: { system: "none" } };
const until = async (ok, ms = 2000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

test("records the window's source at the size and rate asked, for the seconds asked, and hands back a WebM", async () => {
  const r = rig();
  r.record(CFG);
  await until(() => r.done.length);
  assert.deepStrictEqual(r.asked, [{
    audio: false,
    video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: "window:22:0", maxWidth: 960, maxHeight: 960, maxFrameRate: 4 } },
  }]);
  const rec = r.recorders[0];
  assert.strictEqual(rec.opts.mimeType, "video/webm;codecs=vp8", "VP8, no sound track");
  assert.strictEqual(rec.opts.videoBitsPerSecond, 900000);
  assert.strictEqual(rec.opts.audioBitsPerSecond, undefined);
  const [p] = r.done;
  assert.strictEqual(p.id, 3);
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.mime, "video/webm");
  assert.strictEqual(p.sound, false);
  assert.ok(p.data.byteLength >= 100);
  assert.ok(p.seconds > 0);
  assert.ok(r.stopped.includes("video"), "the capture is let go");
});

test("Windows: the loopback as a desktop source, its video dropped; never an ordinary audio input", async () => {
  const r = rig();
  r.record(Object.assign({}, CFG, { sound: { system: "desktop", sourceId: "screen:0:0" } }));
  await until(() => r.done.length);
  assert.deepStrictEqual(r.asked[1], {
    audio: { mandatory: { chromeMediaSource: "desktop" } },
    video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: "screen:0:0", maxWidth: 8, maxHeight: 8, maxFrameRate: 1 } },
  });
  assert.strictEqual(r.recorders[0].opts.mimeType, "video/webm;codecs=vp8,opus");
  assert.strictEqual(r.recorders[0].opts.audioBitsPerSecond, 32000);
  assert.strictEqual(r.done[0].sound, true);
  // Every audio request was a desktop source: none asked for a microphone.
  for (const c of r.asked) if (c.audio) assert.strictEqual(c.audio.mandatory.chromeMediaSource, "desktop");
});

test("Linux: the output's monitor by name, and with no such device no sound at all (not the default input)", async () => {
  const withMonitor = rig({ devices: [{ kind: "audioinput", label: "Built-in Microphone", deviceId: "mic" }, { kind: "audioinput", label: "Monitor of Speakers", deviceId: "mon" }] });
  withMonitor.record(Object.assign({}, CFG, { sound: { system: "monitor", pattern: "monitor" } }));
  await until(() => withMonitor.done.length);
  assert.deepStrictEqual(withMonitor.asked[1].audio.deviceId, { exact: "mon" });
  assert.strictEqual(withMonitor.done[0].sound, true);

  const micOnly = rig({ devices: [{ kind: "audioinput", label: "Built-in Microphone", deviceId: "mic" }] });
  micOnly.record(Object.assign({}, CFG, { sound: { system: "monitor", pattern: "monitor" } }));
  await until(() => micOnly.done.length);
  assert.strictEqual(micOnly.asked.length, 1, "only the window was asked for");
  assert.strictEqual(micOnly.done[0].sound, false);
});

test("macOS: the helper's samples played into a 16 kHz stream", async () => {
  const r = rig();
  r.record(Object.assign({}, CFG, { sound: { system: "pcm" } }));
  await until(() => r.done.length);
  assert.strictEqual(r.asked.length, 1);
  assert.strictEqual(r.done[0].sound, true);
});

test("past maxBytes it stops there and keeps nothing; a refused capture says so", async () => {
  const big = rig({ chunk: 60000 });
  big.record(Object.assign({}, CFG, { seconds: 5, maxBytes: 100000 }));
  await until(() => big.done.length);
  assert.deepStrictEqual(big.done[0], { id: 3, ok: true, tooBig: true });

  const refused = rig({ refuse: true });
  refused.record(CFG);
  await until(() => refused.done.length);
  assert.strictEqual(refused.done[0].ok, false);
  assert.match(refused.done[0].error, /Permission denied/);
});

test("stopped by the main process: one answer, nothing more", async () => {
  const r = rig();
  r.record(Object.assign({}, CFG, { seconds: 5 }));
  await until(() => r.recorders.length);
  r.stop({ id: 3 });
  await new Promise((res) => setTimeout(res, 30));
  assert.deepStrictEqual(r.done, [{ id: 3, ok: false, error: "stopped" }]);
});
