// node --test
//
// The server's flow instructions (agent.js takeFlow, the `flow` event): each obeyed, the floors held whatever it says,
// and no flow event (or an unknown version, or desktop.agent.serverFlow off) is the run as it always was.

const test = require("node:test");
const assert = require("node:assert");
const { createAgent } = require("./agent.js");
const { classifyRisk, floorRisk } = require("./risk.js");

const WIN = [0, 0, 1280, 720];
const els = (app) => app === "VLC"
  ? [{ id: "e1", role: "button", label: "Pause", frame: [600, 680, 40, 30] }]
  : [{ id: "e1", role: "button", label: "Send", frame: [10, 10, 40, 20] }, { id: "e2", role: "button", label: "Delete account", frame: [60, 10, 40, 20] }];
const snapOf = (app) => ({ ok: true, app: { name: app, pid: 7 }, window: { frame: WIN }, focused: null, selection: "", scale: "points", elements: els(app), truncated: false, ms: 5 });
const lookOf = (title) => ({ ok: true, window: { frame: WIN, title }, scale: "points", lines: [], image: { mime: "image/jpeg", data: "eA==", width: 1280, height: 720 }, ms: 9 });
const CLIP = { mime: "video/webm", data: Buffer.from("\x1aE\xdf\xa3 cats"), sound: false, seconds: 3 };
const STILL = { mime: "image/jpeg", data: Buffer.from("one frame") };
const AUDIO = { mime: "audio/webm", data: Buffer.from("x") };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `steps`: one script per request, the last repeated. */
function rig(o = {}) {
  const app = o.app || "VLC";
  const confirms = [], clips = [], crops = [], requests = [], ends = [], listens = [], logs = [];
  const driver = { snapshot: async () => snapOf(app), look: async () => lookOf(app === "VLC" ? "cats.mp4 - VLC" : "Mail - Google Chrome") };
  for (const m of ["press", "click", "setValue", "focus", "scroll", "key", "open"]) driver[m] = async () => ({ ok: true });
  const guide = {};
  for (const m of ["show", "state", "heard", "say", "point", "unpoint", "steps", "hide", "error", "badge", "offer"]) guide[m] = () => {};
  guide.confirm = (text, risk) => { confirms.push(risk); return Promise.resolve(true); };
  let n = 0;
  async function* post(req, audio, signal, image, video) {
    requests.push({ req: JSON.parse(JSON.stringify(req)), image: image || null, video: video || null });
    const steps = o.steps;
    for (const ev of steps[Math.min(n++, steps.length - 1)]) yield ev;
  }
  const knobs = Object.assign({ "desktop.agent.doneMs": 1, "desktop.agent.settleMs": 0, "desktop.agent.confirmMs": 300, "desktop.agent.videoGraceMs": 200 }, o.knobs);
  const agent = createAgent({
    driver, guide, post, paste: async () => {},
    listen: async (opts) => { listens.push(opts); return null; },
    knob: (name, fallback) => (name in knobs ? knobs[name] : fallback),
    platform: "mac", log: (l) => logs.push(l),
    pictures: o.pictures || (() => "always"),
    permit: o.permit || (async () => "once"),
    crop: () => { crops.push(1); return STILL; },
    clip: async (lk, opts) => { clips.push(opts); return CLIP; },
    onEnd: (end) => { ends.push(end); return false; },
  });
  const ask = async (text) => {
    assert.strictEqual(agent.begin({ app }), true);
    await sleep(1);
    await agent.heard(AUDIO, { text, final: true });
  };
  return { agent, ask, confirms, clips, crops, requests, ends, listens, logs };
}

const FLOW = (f) => Object.assign({ t: "flow", v: 1 }, f);
const Q = [{ t: "heard", text: "what's happening in this video?", mode: "show" }];

test("flow: every step asks for it, saying what it could show; serverFlow off asks for nothing and obeys nothing", async () => {
  const r = rig({ steps: [[...Q, { t: "say", text: "A cat." }, { t: "done" }]] });
  await r.ask("what is the time");
  assert.deepStrictEqual(r.requests[0].req.flow, { v: 1, can: ["picture", "clip"] });

  const off = rig({ app: "Google Chrome", knobs: { "desktop.agent.serverFlow": false, "desktop.agent.trustCommands": false },
    steps: [[{ t: "heard", text: "send it", mode: "do" }, FLOW({ trusted: true }), { t: "action", kind: "press", id: "e1", risk: "confirm" }], [{ t: "done" }]] });
  await off.ask("send it");
  assert.strictEqual(off.requests[0].req.flow, undefined);
  assert.deepStrictEqual(off.confirms, ["confirm"], "its trusted was not taken");
});

test("flow trusted: a command's ordinary step goes without a yes; trusted false takes back what heard gave", async () => {
  const yes = rig({ app: "Google Chrome", knobs: { "desktop.agent.trustCommands": false },
    steps: [[{ t: "heard", text: "send it", mode: "do" }, FLOW({ trusted: true }), { t: "action", kind: "press", id: "e1", risk: "confirm" }], [{ t: "done" }]] });
  await yes.ask("send it");
  assert.deepStrictEqual(yes.confirms, []);

  const no = rig({ app: "Google Chrome",
    steps: [[{ t: "heard", text: "send it", mode: "do" }, FLOW({ trusted: false }), { t: "action", kind: "press", id: "e1", risk: "confirm" }], [{ t: "done" }]] });
  await no.ask("send it");
  assert.deepStrictEqual(no.confirms, ["confirm"]);
});

test("flow trusted: the floors still ask whatever the server says — delete, a chord that quits", async () => {
  for (const action of [{ t: "action", kind: "press", id: "e2", risk: "free" }, { t: "action", kind: "key", keys: "cmd+q", risk: "free" }]) {
    const r = rig({ app: "Google Chrome", steps: [[{ t: "heard", text: "do it", mode: "do" }, FLOW({ trusted: true }), action], [{ t: "done" }]] });
    await r.ask("do it");
    assert.strictEqual(r.confirms.length, 1, JSON.stringify(action));
  }
  const snap = snapOf("Google Chrome");
  for (const a of [{ kind: "press", id: "e2" }, { kind: "key", keys: "cmd+w" }, { kind: "type", text: "x" }]) {
    assert.notStrictEqual(floorRisk(a, snap, { trusted: true }), "free", JSON.stringify(a));
    assert.strictEqual(classifyRisk(a, snap, { trusted: true }), floorRisk(a, snap, { trusted: true }));
  }
  assert.strictEqual(classifyRisk({ kind: "press", id: "e1" }, snap, { trusted: true }), "free");
  assert.strictEqual(classifyRisk({ kind: "press", id: "e1" }, snap, {}), "confirm", "untrusted: as before");
});

test("flow media clip: once the server speaks flow, the words go first and the clip is recorded when it asks", async () => {
  const r = rig({ steps: [
    [...Q, FLOW({ media: "none" }), { t: "say", text: "Hm." }, { t: "done" }],
    [...Q, FLOW({ media: "clip", clipSeconds: 3 }), { t: "look", why: "something moving" }],
    [...Q, FLOW({}), { t: "say", text: "A cat." }, { t: "done" }],
  ] });
  await r.ask("what is the time");
  await r.ask("what's happening in this video?");
  const [, ask2, again] = r.requests;
  assert.strictEqual(ask2.video, null, "no local guess: the words went alone");
  assert.deepStrictEqual(ask2.req.flow.can, ["picture", "clip"]);
  assert.strictEqual(r.clips.length, 1);
  assert.strictEqual(r.clips[0].seconds, 3, "the server's seconds");
  assert.ok(again.video, "the same step again, with the clip");
  assert.strictEqual(again.req.step, 0);
  assert.deepStrictEqual(again.req.flow, { v: 1 }, "offering nothing more");
});

test("flow media picture refused by the person: the same step goes again with the words alone, offering nothing", async () => {
  const r = rig({ app: "Google Chrome", pictures: () => "ask", permit: async () => "no", steps: [
    [{ t: "heard", text: "hi", mode: "show" }, FLOW({}), { t: "done" }],
    [{ t: "heard", text: "explain this equation", mode: "show" }, FLOW({ media: "picture" }), { t: "look", why: "something drawn" }],
    [{ t: "heard", text: "explain this equation", mode: "show" }, FLOW({ media: "none" }), { t: "say", text: "From the words." }, { t: "done" }],
  ] });
  await r.ask("hi");
  await r.ask("explain this equation");
  assert.strictEqual(r.requests.length, 3);
  assert.strictEqual(r.requests[2].image, null);
  assert.deepStrictEqual(r.requests[2].req.flow, { v: 1 });
  assert.strictEqual(r.requests[2].req.utterance, "explain this equation");
});

test("no flow, an unknown version: the device decides as before (a local clip at once), and stops waiting for the server", async () => {
  const r = rig({ steps: [
    [...Q, FLOW({ media: "none" }), { t: "done" }],
    [...Q, { t: "done" }],
    [...Q, FLOW({ v: 2, trusted: true }), { t: "done" }],
    [...Q, { t: "done" }],
  ] });
  await r.ask("what is the time");
  await r.ask("what is the time");   // an older server answers: no flow
  await r.ask("what's happening in this video?");
  assert.ok(r.requests[2].video, "the local guess again, at once");
  await r.ask("what's happening in this video?");   // a v2 flow is ignored: still the local guess
  assert.ok(r.requests[3].video);
});

test("flow afterAnswer and idleMs go to the caller with the end; askReplyMic to listen", async () => {
  const r = rig({ steps: [[...Q, FLOW({ afterAnswer: "close", idleMs: 5000, askReplyMic: "key" }), { t: "ask", text: "Which one?" }]] });
  await r.ask("what is the time");
  assert.deepStrictEqual(r.listens, [{ mic: "key" }]);
  assert.deepStrictEqual(r.ends[0].flow, { afterAnswer: "close", idleMs: 5000, askReplyMic: "key" });
});
