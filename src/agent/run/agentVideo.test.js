// node --test
//
// Ask asked about something MOVING: the clip path of a run (agent.js
// allowedClip, recordClip) and the request it posts (stream.js makePost's
// `video` part). The driver, the guide, the server and the recorder are fakes
// that record what they were asked, as in agent.test.js.

const test = require("node:test");
const assert = require("node:assert");
const { createAgent, makePost } = require("./agent.js");
const { TEXT } = require("./text.js");

const WIN = [0, 0, 1280, 720];
const PLAY = { id: "e1", role: "button", label: "Pause", frame: [600, 680, 40, 30] };
const SEEK = { id: "e2", role: "slider", label: "Seek", frame: [100, 660, 1080, 10] };
const snap = (extra) => Object.assign({
  ok: true, app: { name: "VLC", pid: 7 }, window: { frame: WIN }, focused: null, selection: "",
  scale: "points", elements: [PLAY, SEEK], truncated: false, ms: 5,
}, extra);
const look = (title = "cats.mp4 - VLC media player", extra) => Object.assign({
  ok: true, window: { frame: WIN, title }, scale: "points", lines: [],
  image: { mime: "image/jpeg", data: Buffer.from("the whole window").toString("base64"), width: 1280, height: 720 }, ms: 90,
}, extra);
const CLIP = { mime: "video/webm", data: Buffer.from("\x1aE\xdf\xa3 a few seconds of cats"), sound: true, seconds: 6 };
const STILL = { mime: "image/jpeg", data: Buffer.from("one frame") };
const AUDIO = { mime: "audio/webm", data: Buffer.from("not really opus") };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rig(o = {}) {
  const calls = [];
  const driver = {
    snapshot: async () => o.snap || snap(),
    look: async (opts) => { calls.push(["look", opts]); return o.look || look(); },
  };
  for (const m of ["press", "click", "setValue", "focus", "scroll", "key", "open"]) driver[m] = async () => ({ ok: true });
  const guide = { calls };
  for (const m of ["show", "state", "heard", "say", "point", "unpoint", "steps", "hide", "error", "badge", "offer", "confirm"]) {
    guide[m] = (...args) => { calls.push([m, ...args]); return m === "confirm" ? Promise.resolve(true) : undefined; };
  }
  guide.of = (m) => calls.filter((c) => c[0] === m);
  const requests = [];
  async function* post(req, audio, signal, image, video) {
    requests.push({ req: JSON.parse(JSON.stringify(req)), audio, image: image || null, video: video || null });
    for (const ev of o.script || [{ t: "heard", text: "what's happening in this video?", mode: "show" }, { t: "say", text: "A cat knocks a glass off the table." }, { t: "done" }]) yield ev;
  }
  const clips = [], crops = [], permits = [], logs = [];
  const knobs = Object.assign({ "desktop.agent.doneMs": 1, "desktop.agent.confirmMs": 300, "desktop.agent.videoGraceMs": 200 }, o.knobs);
  const agent = createAgent({
    driver, guide, post,
    paste: async () => {}, listen: async () => null,
    knob: (name, fallback) => (name in knobs ? knobs[name] : fallback),
    platform: "mac", log: (l) => logs.push(l),
    sensitive: o.sensitive,
    pictures: o.pictures || (() => "always"),
    permit: o.permit || (async (app, about) => { permits.push([app, about]); return "once"; }),
    crop: (lk, frame) => { crops.push(frame); return STILL; },
    ...(o.noClip ? {} : { clip: async (lk, opts) => { clips.push([lk, opts]); return typeof o.clip === "function" ? o.clip(lk, opts) : o.clip === undefined ? CLIP : o.clip; } }),
  });
  return { agent, guide, requests, clips, crops, permits, logs, calls };
}

async function ask(r, text, begin = { app: "VLC media player" }) {
  assert.strictEqual(r.agent.begin(begin), true);
  await sleep(1);
  await r.agent.heard(AUDIO, { text, final: true });
}

test("clip: a question about a playing video records the window and sends ONE clip, said as it comes", async () => {
  const r = rig();
  await ask(r, "what's happening in this video?");
  assert.strictEqual(r.clips.length, 1);
  const [lk, opts] = r.clips[0];
  assert.strictEqual(lk.window.title, "cats.mp4 - VLC media player", "the look's window, found by its title in main");
  assert.deepStrictEqual(opts, { seconds: 6, maxSide: 960, fps: 4, maxBytes: 8000000, sound: true }, "the knobs' defaults");

  assert.strictEqual(r.requests.length, 1);
  const [{ req, audio, image, video }] = r.requests;
  assert.strictEqual(audio, null, "the words go, not the recording");
  assert.strictEqual(image, null, "a clip in place of the picture, never both");
  assert.deepStrictEqual(video, { mime: "video/webm", data: CLIP.data });
  assert.strictEqual(req.utterance, "what's happening in this video?");
  assert.deepStrictEqual(req.video, { seconds: 6, sound: true });
  assert.deepStrictEqual(req.picture, { region: "window" });
  assert.ok(!JSON.stringify(req).includes("cats.mp4"), "the window's title never leaves");
  assert.deepStrictEqual(r.crops, [], "no still is cut when the clip went");

  // "Watching…" on the window and the card while it records; then that it went.
  assert.deepStrictEqual(r.guide.of("point")[0], ["point", WIN, TEXT.watching, { tentative: true }]);
  assert.deepStrictEqual(r.guide.of("badge"), [["badge", TEXT.watching], ["badge", TEXT.clipSent]]);
  assert.strictEqual(TEXT.watching, "Watching…");
  assert.deepStrictEqual(r.guide.of("say"), [["say", "A cat knocks a glass off the table.", { speak: true, rate: 1.04 }]]);
  assert.strictEqual(r.guide.of("unpoint").length, 1, "the Watching ring goes with the answer");
});

test("clip: the knobs size it, and a clip without sound says so", async () => {
  const r = rig({
    clip: { mime: "video/webm;codecs=vp8", data: CLIP.data, sound: false, seconds: 3.9 },
    knobs: { "desktop.agent.videoSeconds": 4, "desktop.agent.videoMaxSide": 640, "desktop.agent.videoFps": 2, "desktop.agent.videoMaxBytes": 3000000, "desktop.agent.videoSound": false },
  });
  await ask(r, "explain this clip");
  assert.deepStrictEqual(r.clips[0][1], { seconds: 4, maxSide: 640, fps: 2, maxBytes: 3000000, sound: false });
  assert.deepStrictEqual(r.requests[0].req.video, { seconds: 4, sound: false });
  assert.strictEqual(r.requests[0].video.mime, "video/webm");
});

test("clip: too big to send, or nothing recorded: the still picture goes instead, without asking twice", async () => {
  for (const [name, clip] of [
    ["past the recorder's cap", { tooBig: true }],
    ["bigger than the knob anyway", { mime: "video/webm", data: Buffer.alloc(200001, 1), sound: true }],
    ["nothing recorded", null],
    ["not a video", { mime: "image/gif", data: Buffer.from("GIF89a") }],
    ["a recorder that throws", () => { throw new Error("no capture"); }],
  ]) {
    const r = rig({ clip, pictures: () => "ask", knobs: { "desktop.agent.videoMaxBytes": 200000 } });
    await ask(r, "what's happening in this video?");
    assert.strictEqual(r.permits.length, 1, `${name}: asked once, for the clip`);
    assert.deepStrictEqual(r.permits[0][1], { region: "window" }, `${name}: the card is told it is the whole window`);
    assert.strictEqual(r.requests.length, 1, name);
    const [{ req, image, video }] = r.requests;
    assert.strictEqual(video, null, name);
    assert.deepStrictEqual(image, STILL, `${name}: the still picture`);
    assert.strictEqual(req.video, undefined, name);
    assert.deepStrictEqual(r.guide.of("badge").at(-1), ["badge", TEXT.pictureSent], name);
  }
});

test("clip: a recorder that never answers is given up on, and the still goes", async () => {
  const r = rig({ clip: () => new Promise(() => {}), knobs: { "desktop.agent.videoSeconds": 1, "desktop.agent.videoGraceMs": 10 } });
  const t0 = Date.now();
  await ask(r, "what's happening in this video?");
  assert.ok(Date.now() - t0 < 2000);
  assert.deepStrictEqual(r.requests[0].image, STILL);
});

test("clip: never from a sensitive app (nothing is read), nor a private window (the picture's own rules then)", async () => {
  const bank = rig({ sensitive: () => true });
  assert.strictEqual(bank.agent.begin({ app: "Chase Bank", sensitive: true }), false);
  assert.deepStrictEqual(bank.clips, []);
  assert.deepStrictEqual(bank.requests, []);

  // A private window, told at Alt twice or read in a title: no clip at all.
  for (const [begin, lk] of [
    [{ app: "Google Chrome", privateWindow: true }, look("Funny cats - YouTube - Google Chrome")],
    [{ app: "Google Chrome" }, look("Funny cats - YouTube - Google Chrome (Incognito)")],
  ]) {
    const r = rig({ look: lk });
    await ask(r, "what's happening in this video?", begin);
    assert.deepStrictEqual(r.clips, [], JSON.stringify(begin));
    assert.strictEqual(r.requests[0].video, null);
    assert.strictEqual(r.requests[0].req.video, undefined);
    assert.ok(r.logs.some((l) => /private window: no clip/.test(l)));
  }
});

test("clip: a person who turned pictures off gets no clip; a no on the card records nothing", async () => {
  const off = rig({ pictures: () => "never" });
  await ask(off, "what's happening in this video?");
  assert.deepStrictEqual(off.clips, []);
  assert.strictEqual(off.requests[0].video, null);
  assert.strictEqual(off.requests[0].image, null);

  const no = rig({ pictures: () => "ask", permit: async () => "no" });
  await ask(no, "what's happening in this video?");
  assert.deepStrictEqual(no.clips, [], "nothing recorded without the yes");
  assert.strictEqual(no.requests[0].video, null);
  assert.strictEqual(no.requests[0].image, null, "nor a still: the no was to seeing it");
});

test("clip: not for an order, a still question in an ordinary app, or with the knob off; nor without a recorder", async () => {
  const order = rig({ script: [{ t: "heard", text: "pause the video", mode: "do" }, { t: "done" }] });
  await ask(order, "pause the video");
  assert.deepStrictEqual(order.clips, []);

  const slack = rig({ snap: snap({ app: { name: "Slack", pid: 9 } }), look: look("design | Slack") });
  await ask(slack, "what's happening?", { app: "Slack" });
  assert.deepStrictEqual(slack.clips, []);

  const off = rig({ knobs: { "desktop.agent.video": false } });
  await ask(off, "what's happening in this video?");
  assert.deepStrictEqual(off.clips, []);

  const none = rig({ noClip: true });
  await ask(none, "what is this?");
  assert.strictEqual(none.requests[0].video, null);
  assert.deepStrictEqual(none.requests[0].image, STILL, "the picture path, as before");
});

test("clip: in a player, \"what's this?\" is a clip; the server's player list replaces the built-in one", async () => {
  const vlc = rig();
  await ask(vlc, "what is this?");
  assert.strictEqual(vlc.clips.length, 1);

  const custom = rig({ snap: snap({ app: { name: "Stremio", pid: 3 } }), look: look("Stremio"), knobs: { "desktop.agent.videoApps": ["Stremio"] } });
  await ask(custom, "what just happened?", { app: "Stremio" });
  assert.strictEqual(custom.clips.length, 1);
});

test("makePost: the clip goes as one `video` part (clip.webm), after the request, and never beside a picture", async () => {
  const sent = [];
  const fetch = async (url, init) => { sent.push({ url, init }); return { status: 200, body: null }; };
  const post = makePost({ baseUrl: "https://api.example/", token: async () => "tok", fetch });
  for await (const _ of post({ runId: "r1", step: 0 }, null, undefined, STILL, { mime: "video/webm;codecs=vp8,opus", data: CLIP.data })) { /* drained */ }
  const body = sent[0].init.body;
  assert.ok(body instanceof FormData);
  assert.deepStrictEqual([...body.keys()], ["request", "video"]);
  const part = body.get("video");
  assert.strictEqual(part.name, "clip.webm");
  assert.strictEqual(part.type, "video/webm");
  assert.deepStrictEqual(Buffer.from(await part.arrayBuffer()), CLIP.data);
  assert.strictEqual(sent[0].init.headers.Authorization, "Bearer tok");

  sent.length = 0;
  for await (const _ of post({ runId: "r1", step: 0 }, AUDIO, undefined, null, { mime: "video/mp4", data: Buffer.from("mp4") })) { /* drained */ }
  const b2 = sent[0].init.body;
  assert.deepStrictEqual([...b2.keys()], ["request", "audio", "video"]);
  assert.strictEqual(b2.get("video").name, "clip.mp4");
});
