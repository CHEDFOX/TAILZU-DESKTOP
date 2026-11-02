// node --test
//
// The recorder's side of a question (and of plain dictation), run in a VM
// with a fake microphone, MediaRecorder, caption stream and meter.
// `out` is every message it sent the main process, in order. Plain
// dictation is run through the same page, to show it is as it was.
const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const { recorderFiles } = require("./testkit.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 2000) {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error("timed out waiting"); await sleep(5); }
}
const RECORDER_JS = recorderFiles().map((f) => [f, fs.readFileSync(f, "utf8")]);

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
  const win = { tailzu: tz, TailzuKnobs: require("../../../knobs.js"), TailzuSpeech: { createSpeechMeter: meter }, AudioContext: FakeAC, MediaRecorder: FakeMR };
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
  for (const [f, src] of RECORDER_JS) vm.runInContext(src, page, { filename: f });
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
