// Stopping notes closes the microphone at once, whatever the network is doing: the recorder window (notesRecorder.js) is
// run in a small stand-in for the browser, with uploads that never answer, as on a connection that has gone slow.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function rig() {
  const status = [], done = [], stopped = [];
  let onStart = null, onStop = null;
  class FakeRecorder {
    static isTypeSupported() { return true; }
    constructor() { this.state = "inactive"; }
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      setTimeout(() => {
        if (this.ondataavailable) this.ondataavailable({ data: { size: 10 } });
        if (this.onstop) this.onstop();
      }, 5);
    }
  }
  const stream = () => ({ getTracks: () => [{ stop: () => stopped.push(Date.now()) }], getAudioTracks: () => [], getVideoTracks: () => [] });
  const window = {
    TailzuKnobs: { num: (_k, d) => d, list: (_k, d) => d, str: (_k, d) => d },
    TailzuNotes: require("./notesCore.js"),
    TailzuSpeech: { createSpeechMeter: () => ({ feed: () => ({ voicedMs: 2000 }) }) },
    tailzuNotes: {
      token: async () => "t",
      status: (p) => status.push(p),
      done: (p) => done.push(p),
      onStart: (cb) => { onStart = cb; },
      onStop: (cb) => { onStop = cb; },
      onPcm: () => {},
      onSystem: () => {},
    },
  };
  class FakeAudioContext {
    constructor() { this.currentTime = 0; this.sampleRate = 16000; }
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() { return { fftSize: 8192, getFloatTimeDomainData() {} }; }
    close() {}
  }
  const ctx = {
    window, MediaRecorder: FakeRecorder, AudioContext: FakeAudioContext,
    navigator: { mediaDevices: { getUserMedia: async () => stream(), enumerateDevices: async () => [] } },
    // A connection that never answers.
    fetch: () => new Promise(() => {}),
    performance, Blob, FormData, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, Promise, console,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "notesRecorder.js"), "utf8"), ctx);
  return { status, done, stopped, start: (cfg) => onStart(cfg), stop: () => onStop() };
}

const until = async (ok, ms = 2000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

test("Stop closes the microphone and says so before any upload has gone", async () => {
  const r = rig();
  r.start({ id: "n1", baseUrl: "https://api.local", system: "none" });
  await until(() => r.status.some((s) => s.state === "recording"));
  r.stop();
  await until(() => r.status.some((s) => s.state === "stopped"));
  assert.ok(r.stopped.length >= 1, "the microphone's tracks were stopped");
  assert.deepStrictEqual(r.status.map((s) => s.state), ["recording", "saving", "stopped"]);
  // The uploads are still waiting on the network: the note is not done, but nothing is listening any more.
  assert.strictEqual(r.done.length, 0);
});
