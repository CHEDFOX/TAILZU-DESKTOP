// node --test
//
// A whole Ask run is a conversation between four things that are not here —
// the accessibility helper, the guide window, the server and the person — so
// each is a fake that records what it was asked and answers from a script:
//
//   driver  a queue of snapshots (the last one repeats) and canned answers;
//           a look, when the test gives one
//   guide   records every call; confirm answers yes, no, or never
//   post    one list of events per step, with optional gates to hold the
//           stream open mid-way; records every request it was sent, and the
//           picture that went with it
//
// Nothing in this file touches Electron, a screen or the network.

const test = require("node:test");
const assert = require("node:assert");
const {
  createAgent, approvalOf, isTaskRoute, classifyRisk, maxRisk, regionOf, toRequestElements, frameMap, describeChange,
  ocrElements, pictureRegion, resolveMark, readEvents, makePost, SCREEN_CHARS, TEXT,
} = require("./agent.js");

// ---- fixtures ---------------------------------------------------------------

const WIN = [0, 0, 900, 600];
function snap(elements, extra) {
  return Object.assign({
    ok: true, app: { name: "Slack", pid: 42 }, window: { frame: WIN }, focused: null, selection: "",
    scale: "points", elements, truncated: false, ms: 5,
  }, extra);
}
const EXPORT = { id: "e1", role: "button", label: "Export", frame: [700, 20, 80, 30] };          // top right
const COMPOSER = { id: "e2", role: "area", label: "Message #design", value: "", frame: [100, 520, 600, 40] }; // bottom
const SEND = { id: "e3", role: "button", label: "Send", frame: [720, 520, 60, 40] };              // bottom right
const HEADING = { id: "e4", role: "heading", label: "design", frame: [20, 20, 200, 30] };         // top left
const SLACK = snap([EXPORT, COMPOSER, SEND, HEADING], { focused: "e2" });

const AUDIO = { mime: "audio/webm", data: Buffer.from("not really opus") };
const REPLY = { mime: "audio/webm", data: Buffer.from("the reply") };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const never = () => new Promise(() => {});

// ---- fakes ------------------------------------------------------------------

function fakeDriver(snaps, results, look) {
  const calls = [];
  let n = 0;
  const drv = { calls };
  drv.snapshot = async (opts) => {
    calls.push(["snapshot", opts]);
    const s = snaps[Math.min(n, snaps.length - 1)];
    n++;
    return typeof s === "function" ? s(n) : s;
  };
  // Only a driver given a look has one, as the v1 drivers had none.
  if (look !== undefined) {
    drv.look = async (opts) => {
      calls.push(["look", opts]);
      return typeof look === "function" ? look(opts) : look;
    };
  }
  for (const m of ["press", "click", "setValue", "focus", "scroll", "key", "open"]) {
    drv[m] = async (...args) => {
      calls.push([m, ...args]);
      const r = results && results[m];
      return typeof r === "function" ? r(...args) : r || { ok: true };
    };
  }
  /** Everything but the reads. */
  drv.acts = () => calls.filter((c) => c[0] !== "snapshot" && c[0] !== "look");
  drv.snapshots = () => calls.filter((c) => c[0] === "snapshot").length;
  return drv;
}

function fakeGuide(confirm) {
  const calls = [];
  const g = { calls };
  for (const m of ["show", "state", "heard", "say", "point", "unpoint", "steps", "hide", "error", "badge", "offer"]) {
    g[m] = (...args) => { calls.push([m, ...args]); };
  }
  g.confirm = (text, risk) => {
    calls.push(["confirm", text, risk]);
    return typeof confirm === "function" ? confirm(text, risk) : Promise.resolve(confirm === undefined ? true : confirm);
  };
  g.of = (m) => calls.filter((c) => c[0] === m);
  return g;
}

/** scripts[k] is step k's events: an array (or a function of the request
 *  returning one). A function inside the array is awaited, not yielded —
 *  a gate that holds the stream open. */
function fakePost(scripts) {
  const requests = [];
  async function* post(req, audio, signal, image) {
    requests.push({ req: JSON.parse(JSON.stringify(req)), audio, signal, image: image || null });
    const step = requests.length - 1;
    const s = scripts[step];
    const list = typeof s === "function" ? s(req) : s || [{ t: "done" }];
    for (const ev of list) {
      if (typeof ev === "function") { await ev(signal); continue; }
      yield ev;
    }
  }
  post.requests = requests;
  post.reqs = () => requests.map((r) => r.req);
  return post;
}

function rig(o = {}) {
  let clock = 1_000_000;
  const logs = [];
  const pasted = [];
  const driver = fakeDriver(o.snaps || [SLACK], o.results, o.look);
  const guide = o.guide || fakeGuide(o.confirm);
  const post = fakePost(o.scripts || []);
  const knobs = Object.assign({
    "desktop.agent.settleMs": 0,
    "desktop.agent.doneMs": 1,
    "desktop.agent.confirmMs": 500,
    "desktop.agent.snapshotTimeoutMs": 200,
  }, o.knobs);
  const agent = createAgent({
    driver, guide, post,
    paste: o.paste || (async (t) => { pasted.push(t); }),
    listen: o.listen || (async () => null),
    knob: (name, fallback) => (name in knobs ? knobs[name] : fallback),
    platform: o.platform || "mac",
    now: () => clock,
    log: (l) => logs.push(l),
    sensitive: o.sensitive,
    crop: o.crop, pictures: o.pictures, permit: o.permit, names: o.names, afterSpeech: o.afterSpeech,
    call: o.call, approveElsewhere: o.approveElsewhere,
  });
  return { agent, driver, guide, post, pasted, logs, tick: (ms) => { clock += ms; } };
}

const heardDo = (text) => ({ t: "heard", text, mode: "do" });
const heardShow = (text) => ({ t: "heard", text, mode: "show" });
const press = (id, extra) => Object.assign({ t: "action", kind: "press", id, risk: "free" }, extra);

// ---- show runs ----------------------------------------------------------------

test("a show run says, points at the element's own frame, and finishes", async () => {
  const r = rig({
    scripts: [[
      heardShow("where's export?"),
      { t: "say", text: "Export is up here, top right." },
      { t: "point", id: "e1", caption: "Export" },
      { t: "point", id: "e99", caption: "not on this screen" },
      { t: "done" },
    ]],
  });
  assert.strictEqual(r.agent.begin({ app: "Slack" }), true);
  assert.strictEqual(r.agent.active(), true);
  assert.deepStrictEqual(r.guide.of("show"), [["show", "listening", { app: "Slack" }]]);
  await r.agent.heard(AUDIO);

  assert.deepStrictEqual(r.guide.of("heard"), [["heard", "where's export?"]]);
  assert.deepStrictEqual(r.guide.of("say"), [["say", "Export is up here, top right.", { speak: true, rate: 1.04 }]]);
  // The frame exactly as the driver gave it; the unknown id is skipped.
  assert.deepStrictEqual(r.guide.of("point"), [["point", [700, 20, 80, 30], "Export"]]);
  assert.deepStrictEqual(r.guide.of("state").at(-1), ["state", "done"]);
  assert.deepStrictEqual(r.driver.acts(), []);
  assert.strictEqual(r.agent.active(), false);

  await sleep(15);
  assert.deepStrictEqual(r.guide.calls.at(-1), ["hide"], "hidden after doneMs");
});

test("a finished answer stays up while it is still being said, and doneMs after; a new question or a cancel does not wait", async () => {
  let said = null;
  const speaking = () => new Promise((res) => { said = res; });
  const knobs = { "desktop.agent.doneMs": 5 };
  const long = [heardShow("explain this"), { t: "say", text: "First." }, { t: "say", text: "Second.", append: true }, { t: "done" }];
  const r = rig({ afterSpeech: speaking, knobs, scripts: [long] });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO);
  await sleep(30);
  assert.deepStrictEqual(r.guide.of("hide"), [], "not while the voice is still saying it");
  said();
  await sleep(1);
  assert.deepStrictEqual(r.guide.of("hide"), [], "doneMs after the voice, not at once");
  await sleep(30);
  assert.strictEqual(r.guide.of("hide").length, 1);

  // A new question while the last answer is still being said: its card is
  // not put away when that voice ends.
  const again = rig({ afterSpeech: speaking, knobs, scripts: [long] });
  again.agent.begin({ app: "Slack" });
  await again.agent.heard(AUDIO);
  again.agent.begin({ app: "Slack" });
  said();
  await sleep(30);
  assert.deepStrictEqual(again.guide.of("hide"), []);
  again.agent.cancel("test");

  // Esc while it is still being said: put away at once, and only once.
  const esc = rig({ afterSpeech: speaking, knobs, scripts: [long] });
  esc.agent.begin({ app: "Slack" });
  await esc.agent.heard(AUDIO);
  esc.agent.cancel("esc");
  assert.strictEqual(esc.guide.of("hide").length, 1);
  said();
  await sleep(30);
  assert.strictEqual(esc.guide.of("hide").length, 1);

  // A voice that fails to say when it is done holds nothing up.
  const broken = rig({ afterSpeech: () => { throw new Error("no voice"); }, knobs, scripts: [long] });
  broken.agent.begin({ app: "Slack" });
  await broken.agent.heard(AUDIO);
  await sleep(30);
  assert.strictEqual(broken.guide.of("hide").length, 1);
});

test("DONE's words come after an answer said a sentence at a time, not in its place; a DONE with no words says nothing", async () => {
  const answer = [heardShow("explain this"), { t: "say", text: "It's the area under the curve." }, { t: "say", text: "That's a third.", append: true }];
  const dot = rig({ scripts: [answer.concat([{ t: "done", text: "." }])] });
  dot.agent.begin({ app: "Slack" });
  await dot.agent.heard(AUDIO);
  assert.deepStrictEqual(dot.guide.of("say").map((c) => c[1]), ["It's the area under the curve.", "That's a third."]);
  assert.deepStrictEqual(dot.guide.of("state").at(-1), ["state", "done"]);

  const more = rig({ scripts: [answer.concat([{ t: "done", text: "The answer is a third." }])] });
  more.agent.begin({ app: "Slack" });
  await more.agent.heard(AUDIO);
  assert.deepStrictEqual(more.guide.of("say").at(-1), ["say", "The answer is a third.", { speak: true, rate: 1.04, append: true }]);
  assert.deepStrictEqual(more.guide.of("state").at(-1), ["state", "done"]);

  // A step that said nothing: DONE's words are the answer, as ever; "." alone is none.
  const only = rig({ scripts: [[heardDo("turn on captions"), { t: "done", text: "Captions are on." }]] });
  only.agent.begin({ app: "Slack" });
  await only.agent.heard(AUDIO);
  assert.deepStrictEqual(only.guide.of("state").at(-1), ["state", "done", "Captions are on."]);
  const bare = rig({ scripts: [[heardDo("turn on captions"), { t: "done", text: " . " }]] });
  bare.agent.begin({ app: "Slack" });
  await bare.agent.heard(AUDIO);
  assert.deepStrictEqual(bare.guide.of("state").at(-1), ["state", "done"]);
});

test("the request carries roles, labels and regions — never a frame", async () => {
  const r = rig({ scripts: [[heardShow("where's export?"), { t: "done" }]] });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO);
  const [{ req, audio, signal }] = r.post.requests;
  assert.strictEqual(audio, AUDIO);
  assert.ok(signal instanceof AbortSignal);
  assert.match(req.runId, /^[A-Za-z0-9_-]{6,64}$/);
  assert.strictEqual(req.step, 0);
  assert.strictEqual(req.platform, "mac");
  assert.strictEqual(req.app, "Slack");
  assert.strictEqual(req.utterance, undefined, "with audio, the audio is the words");
  assert.strictEqual(typeof req.tzOffsetMinutes, "number");
  assert.deepStrictEqual(req.screen.elements, [
    { id: "e1", role: "button", label: "Export", region: "tr" },
    { id: "e2", role: "area", label: "Message #design", region: "b", focused: true },
    { id: "e3", role: "button", label: "Send", region: "br" },
    { id: "e4", role: "heading", label: "design", region: "tl" },
  ]);
  assert.deepStrictEqual(req.screen.field, { kind: "message", label: "Message #design" });
  assert.ok(!JSON.stringify(req).includes("frame"), "no frame anywhere in the request");
  assert.ok(!JSON.stringify(req).includes("700"), "no coordinate anywhere in the request");
});

test("an action in a show run is refused and the run ends as done", async () => {
  const r = rig({ scripts: [[heardShow("where is send?"), press("e3")]] });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO);
  assert.deepStrictEqual(r.driver.acts(), []);
  assert.deepStrictEqual(r.guide.of("confirm"), []);
  assert.deepStrictEqual(r.guide.of("state").at(-1), ["state", "done"]);
  assert.deepStrictEqual(r.guide.of("say"), [], "nothing extra is said");
  assert.ok(r.logs.some((l) => /refused a press in a show run/.test(l)));
  assert.strictEqual(r.post.requests.length, 1);
});

// ---- do runs ----------------------------------------------------------------

test("a do run over two steps: history carried, the change noted, the new screen used", async () => {
  const DIALOG = snap([
    EXPORT, Object.assign({}, COMPOSER), SEND, HEADING,
    { id: "e5", role: "button", label: "Export as PDF", frame: [300, 250, 120, 30] },
    { id: "e6", role: "button", label: "Cancel", frame: [450, 250, 80, 30] },
  ], { focused: "e5" });
  const AFTER = snap([EXPORT, COMPOSER, SEND, HEADING], { focused: "e2" });
  const r = rig({
    snaps: [SLACK, DIALOG, AFTER],
    scripts: [
      [heardDo("export this as pdf"), { t: "steps", items: ["Open Export", "Choose PDF"] }, press("e1")],
      [heardDo("export this as pdf"), { t: "steps", items: ["Open Export", "Choose PDF"] }, press("e5")],
      [heardDo("export this as pdf"), { t: "done", text: "Exported." }],
    ],
  });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO);

  assert.deepStrictEqual(r.driver.acts(), [["press", "e1"], ["press", "e5"]]);
  assert.strictEqual(r.driver.snapshots(), 3, "one at begin, one after each action");
  const [req0, req1, req2] = r.post.reqs();
  assert.strictEqual(r.post.requests[1].audio, null);
  assert.strictEqual(req1.step, 1);
  assert.strictEqual(req1.utterance, "export this as pdf", "the goal goes with every later step");
  assert.strictEqual(req0.history, undefined);
  assert.deepStrictEqual(req1.history.map((h) => [h.said, h.did, h.result]), [["export this as pdf", "PRESS e1", "ok"]]);
  assert.match(req1.history[0].note, /focus moved to "Export as PDF"/);
  assert.match(req1.history[0].note, /2 new elements like "Export as PDF", "Cancel"/);
  // The re-read screen is the one sent, with its own ids.
  assert.ok(req1.screen.elements.some((e) => e.id === "e5" && e.label === "Export as PDF" && e.focused));
  assert.strictEqual(req2.history.length, 2);
  assert.deepStrictEqual([req2.history[1].did, req2.history[1].result], ["PRESS e5", "ok"]);
  assert.strictEqual(req2.history[1].said, undefined, "no new words on a later step");
  assert.match(req2.history[1].note, /2 elements gone/);
  // Pointed at each target while acting, at the frame from the snapshot the id came from.
  assert.deepStrictEqual(r.guide.of("point").map((c) => c[1]), [[700, 20, 80, 30], [300, 250, 120, 30]]);
  assert.strictEqual(r.guide.of("unpoint").length, 2);
  assert.ok(r.guide.of("state").some((c) => c[1] === "acting" && c[2] === "Pressing “Export”"));
  // The plan advances as actions land, and is all done at the end.
  assert.deepStrictEqual(r.guide.of("steps")[0][1], [{ text: "Open Export", state: "active" }, { text: "Choose PDF", state: "todo" }]);
  assert.deepStrictEqual(r.guide.of("steps").at(-1)[1], [{ text: "Open Export", state: "done" }, { text: "Choose PDF", state: "done" }]);
  assert.deepStrictEqual(r.guide.of("state").at(-1), ["state", "done", "Exported."]);
  assert.strictEqual(r.agent.active(), false);
});

test("typed words go as the utterance, on step 0 and again after", async () => {
  const AFTER = snap([EXPORT, COMPOSER, SEND, HEADING], { focused: "e1" });
  const r = rig({ snaps: [SLACK, AFTER], scripts: [[heardDo("export"), press("e1")], [{ t: "done" }]] });
  r.agent.begin({ app: "Slack" });
  await r.agent.typed("  export  ");
  const [a, b] = r.post.requests;
  assert.strictEqual(a.audio, null);
  assert.strictEqual(a.req.utterance, "export");
  assert.strictEqual(b.req.utterance, "export");
  assert.strictEqual(b.req.history[0].said, "export");
});

// ---- confirmation -------------------------------------------------------------

const AFTER_SEND = snap([EXPORT, COMPOSER, SEND, HEADING, { id: "e5", role: "text", label: "hi", frame: [100, 400, 100, 20] }], { focused: "e2" });

test("confirm accepted: the action runs", async () => {
  const r = rig({
    confirm: true,
    snaps: [SLACK, AFTER_SEND],
    scripts: [[heardDo("send it"), press("e3", { risk: "confirm", confirm: "Send to #design: “hi”" })], [{ t: "done" }]],
  });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO);
  assert.deepStrictEqual(r.guide.of("confirm"), [["confirm", "Send to #design: “hi”", "confirm"]]);
  assert.deepStrictEqual(r.driver.acts(), [["press", "e3"]]);
  // Pointed at Send while asking.
  assert.deepStrictEqual(r.guide.of("point")[0], ["point", [720, 520, 60, 40]]);
  assert.strictEqual(r.post.requests.length, 2);
});

test("confirm declined: nothing runs, the run ends with “Okay, I left it.”", async () => {
  const r = rig({ confirm: false, scripts: [[heardDo("send it"), press("e3", { risk: "confirm", confirm: "Send it?" })]] });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO);
  assert.deepStrictEqual(r.driver.acts(), []);
  assert.deepStrictEqual(r.guide.of("state").at(-1), ["state", "done", TEXT.declined]);
  assert.strictEqual(r.post.requests.length, 1);
  assert.strictEqual(r.agent.active(), false);
});

test("confirm timed out: silence is a no", async () => {
  const r = rig({
    confirm: () => never(),
    knobs: { "desktop.agent.confirmMs": 25 },
    scripts: [[heardDo("send it"), press("e3", { risk: "confirm" })]],
  });
  r.agent.begin({ app: "Slack" });
  const t0 = Date.now();
  await r.agent.heard(AUDIO);
  assert.ok(Date.now() - t0 >= 20);
  assert.deepStrictEqual(r.driver.acts(), []);
  assert.deepStrictEqual(r.guide.of("state").at(-1), ["state", "done", TEXT.declined]);
});

test("a confirm that throws, or answers anything but true, is a no", async () => {
  for (const answer of [() => { throw new Error("window gone"); }, () => Promise.reject(new Error("x")), () => Promise.resolve("yes"), () => Promise.resolve(1)]) {
    const r = rig({ confirm: answer, scripts: [[heardDo("send it"), press("e3", { risk: "confirm" })]] });
    r.agent.begin({ app: "Slack" });
    await r.agent.heard(AUDIO);
    assert.deepStrictEqual(r.driver.acts(), []);
  }
});

test("the server says free, the device says Send needs a yes", async () => {
  const r = rig({ confirm: true, snaps: [SLACK, AFTER_SEND], scripts: [[heardDo("send it"), press("e3", { risk: "free" })], [{ t: "done" }]] });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO);
  assert.deepStrictEqual(r.guide.of("confirm"), [["confirm", "Press “Send”?", "confirm"]]);
  assert.deepStrictEqual(r.driver.acts(), [["press", "e3"]]);
});

test("an always-risk action is shown with the server's own sentence", async () => {
  const DEL = { id: "e5", role: "menuitem", label: "Delete message", frame: [400, 300, 120, 24] };
  const r = rig({
    confirm: false,
    snaps: [snap([EXPORT, COMPOSER, SEND, DEL], { focused: "e2" })],
    scripts: [[heardDo("delete that"), press("e5", { risk: "always", confirm: "Delete this message from #design?" })]],
  });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO);
  assert.deepStrictEqual(r.guide.of("confirm"), [["confirm", "Delete this message from #design?", "always"]]);
});

test("the device raises free to always on a Delete label, and confirmAll raises everything", async () => {
  const DEL = { id: "e5", role: "button", label: "Delete", frame: [400, 300, 80, 24] };
  const r = rig({ confirm: false, snaps: [snap([EXPORT, DEL])], scripts: [[heardDo("delete"), press("e5")]] });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO);
  assert.deepStrictEqual(r.guide.of("confirm"), [["confirm", "Press “Delete”?", "always"]]);

  const all = rig({ confirm: false, knobs: { "desktop.agent.confirmAll": true }, scripts: [[heardDo("export"), press("e1")]] });
  all.agent.begin({ app: "Slack" });
  await all.agent.heard(AUDIO);
  assert.deepStrictEqual(all.guide.of("confirm"), [["confirm", "Press “Export”?", "confirm"]]);
});

// ---- running actions ----------------------------------------------------------

test("press falls back to a click when the element has no press action", async () => {
  const AFTER = snap([EXPORT, COMPOSER, SEND, HEADING], { focused: "e1" });
  const r = rig({
    snaps: [SLACK, AFTER],
    results: { press: { ok: false, error: "no AXPress" } },
    scripts: [[heardDo("export"), press("e1")], [{ t: "done" }]],
  });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO);
  assert.deepStrictEqual(r.driver.acts(), [["press", "e1"], ["click", "e1"]]);
  assert.strictEqual(r.post.reqs()[1].history[0].result, "ok");
});

test("a press that timed out, is pending or was slow is never clicked on top of; the screen is read again", async () => {
  const DIALOG = snap([EXPORT, COMPOSER, SEND, HEADING, { id: "e5", role: "button", label: "Save" }], { focused: "e2" });
  const answers = [
    { ok: false, error: "timeout" },
    { ok: false, error: "dead" },
    { ok: true, how: "invoke", pending: true },
    { ok: true, how: "AXPress", slow: true },
  ];
  for (const answer of answers) {
    const r = rig({ snaps: [SLACK, DIALOG], results: { press: answer }, scripts: [[heardDo("export"), press("e1")], [{ t: "done" }]] });
    r.agent.begin({ app: "Slack" });
    await r.agent.heard(AUDIO);
    const why = JSON.stringify(answer);
    assert.deepStrictEqual(r.driver.acts(), [["press", "e1"]], why + ": no click after it");
    assert.strictEqual(r.driver.snapshots(), 2, why + ": the screen is read again");
    const req1 = r.post.reqs()[1];
    assert.deepStrictEqual(req1.history[0], { said: "export", did: "PRESS e1", result: "failed", note: 'press may have happened; 1 new element like "Save"' }, why);
    assert.ok(req1.screen.elements.some((e) => e.label === "Save"), why + ": the next step plans from the screen as it is now");
  }
  // Nothing visibly changed: the note says only that it may have happened.
  const r = rig({ results: { press: { ok: false, error: "timeout" } }, scripts: [[heardDo("export"), press("e1")], [{ t: "done" }]] });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO);
  assert.deepStrictEqual(r.driver.acts(), [["press", "e1"]]);
  assert.deepStrictEqual(r.post.reqs()[1].history[0], { said: "export", did: "PRESS e1", result: "failed", note: "press may have happened" });
});

test("a press and a click that both fail are reported as failed, and the run goes on", async () => {
  const r = rig({
    results: { press: { ok: false, error: "no AXPress" }, click: { ok: false, error: "offscreen" } },
    scripts: [[heardDo("export"), press("e1")], [{ t: "done" }]],
  });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO);
  assert.deepStrictEqual(r.post.reqs()[1].history[0], { said: "export", did: "PRESS e1", result: "failed", note: "failed: offscreen" });
});

test("type goes through paste, after checking focus is still where it was planned", async () => {
  const TYPED = snap([EXPORT, Object.assign({}, COMPOSER, { value: "The mockups are ready!" }), SEND, HEADING], { focused: "e2" });
  const r = rig({
    snaps: [SLACK, SLACK, TYPED],
    scripts: [[heardDo("tell them the mockups are ready"), { t: "action", kind: "type", text: "The mockups are ready!", risk: "free" }], [{ t: "done" }]],
  });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO);
  assert.deepStrictEqual(r.pasted, ["The mockups are ready!"]);
  assert.deepStrictEqual(r.driver.acts(), [], "no setValue, no keys");
  assert.strictEqual(r.driver.snapshots(), 3, "begin, the focus check, after");
  assert.deepStrictEqual(r.guide.of("confirm"), []);
  const h = r.post.reqs()[1].history[0];
  assert.strictEqual(h.did, "TYPE The mockups are ready!");
  assert.match(h.note, /"Message #design" changed/);
});

test("a key is not sent when focus moved since the step was planned", async () => {
  const MOVED = snap([EXPORT, COMPOSER, SEND, { id: "e5", role: "field", label: "Search", frame: [300, 10, 300, 24] }], { focused: "e5" });
  const r = rig({
    confirm: true,
    snaps: [SLACK, MOVED],
    scripts: [[heardDo("send it"), { t: "action", kind: "key", keys: "enter", risk: "confirm" }], [{ t: "done" }]],
  });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO);
  assert.deepStrictEqual(r.driver.acts(), [], "Enter never pressed");
  const req1 = r.post.reqs()[1];
  assert.deepStrictEqual(req1.history[0], { said: "send it", did: "KEY enter", result: "failed", note: 'focus moved to "Search"' });
  assert.ok(req1.screen.elements.some((e) => e.id === "e5" && e.focused), "the next step plans from where focus is now");
});

test("a key goes ahead when focus is still on the same element", async () => {
  const r = rig({
    confirm: true,
    snaps: [SLACK, SLACK, snap([EXPORT, COMPOSER, SEND, HEADING, { id: "e5", role: "text", label: "sent!" }], { focused: "e2" })],
    scripts: [[heardDo("send it"), { t: "action", kind: "key", keys: "enter", risk: "free" }], [{ t: "done" }]],
  });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO);
  // Enter in a message field: the device asks, though the server said free.
  assert.deepStrictEqual(r.guide.of("confirm"), [["confirm", "Press Enter in “Message #design”?", "confirm"]]);
  assert.deepStrictEqual(r.driver.acts(), [["key", "enter"]]);
});

test("set in a web app is focus, select all, paste — never a value written from outside", async () => {
  for (const [platform, selectAll] of [["mac", "cmd+a"], ["win", "ctrl+a"]]) {
    const r = rig({ platform, scripts: [[heardDo("write hello"), { t: "action", kind: "set", id: "e2", text: "hello", risk: "free" }], [{ t: "done" }]] });
    r.agent.begin({ app: "Slack" });
    await r.agent.heard(AUDIO);
    assert.deepStrictEqual(r.driver.acts(), [["focus", "e2"], ["key", selectAll]]);
    assert.deepStrictEqual(r.pasted, ["hello"]);
    assert.strictEqual(r.driver.snapshots(), 3, "begin, the focus check after focusing, after");
  }
});

test("a set sends no select-all unless the field it names has focus after focusing it", async () => {
  // The focus call said yes, but the keys would go to the document body.
  const ELSEWHERE = snap([EXPORT, COMPOSER, SEND, HEADING, { id: "e5", role: "area", label: "Document body", frame: [0, 60, 900, 400] }], { focused: "e5" });
  const unread = { ok: false, error: "timeout" };
  for (const [after, note] of [[ELSEWHERE, "failed: focus didn't move"], [unread, "failed: couldn't read the focus"]]) {
    const r = rig({
      snaps: [SLACK, after, ELSEWHERE],
      scripts: [[heardDo("clear it"), { t: "action", kind: "set", id: "e2", text: "", risk: "free" }], [{ t: "done" }]],
    });
    r.agent.begin({ app: "Slack" });
    await r.agent.heard(AUDIO);
    assert.deepStrictEqual(r.driver.acts(), [["focus", "e2"]], "no Cmd+A, no Backspace");
    assert.deepStrictEqual(r.pasted, []);
    assert.deepStrictEqual(r.post.reqs()[1].history[0], { said: "clear it", did: "SET e2 | ", result: "failed", note });
  }
  // Focus that lands a moment late (a browser reports it on its next frame)
  // is looked for once more, and then the keys go.
  const FOCUSED = snap([EXPORT, COMPOSER, SEND, HEADING], { focused: "e2" });
  const WRITTEN = snap([EXPORT, Object.assign({}, COMPOSER, { value: "hi" }), SEND, HEADING], { focused: "e2" });
  const late = rig({
    snaps: [SLACK, ELSEWHERE, FOCUSED, WRITTEN],
    scripts: [[heardDo("write hi"), { t: "action", kind: "set", id: "e2", text: "hi", risk: "free" }], [{ t: "done" }]],
  });
  late.agent.begin({ app: "Slack" });
  await late.agent.heard(AUDIO);
  assert.deepStrictEqual(late.driver.acts(), [["focus", "e2"], ["key", "cmd+a"]]);
  assert.deepStrictEqual(late.pasted, ["hi"]);
  assert.strictEqual(late.driver.snapshots(), 4, "begin, two focus checks, after");
  assert.strictEqual(late.post.reqs()[1].history[0].result, "ok");
  // The same check guards the paste a native set falls back to.
  const NOTES = snap([{ id: "e1", role: "field", label: "Title", value: "", frame: [10, 10, 300, 20] }], { app: { name: "TextEdit", pid: 7 } });
  const OTHER = snap([{ id: "e1", role: "field", label: "Title", value: "" }, { id: "e2", role: "area", label: "Body", focused: true }], { app: { name: "TextEdit", pid: 7 }, focused: "e2" });
  const r = rig({
    snaps: [NOTES, OTHER],
    results: { setValue: { ok: false, error: "not settable" } },
    scripts: [[heardDo("title it Plan"), { t: "action", kind: "set", id: "e1", text: "Plan", risk: "free" }], [{ t: "done" }]],
  });
  r.agent.begin({ app: "TextEdit" });
  await r.agent.heard(AUDIO);
  assert.deepStrictEqual(r.driver.acts(), [["setValue", "e1", "Plan"], ["focus", "e1"]]);
  assert.deepStrictEqual(r.pasted, []);
});

test("set in a native app writes the value, and falls back to paste when that fails", async () => {
  const NOTES = snap([{ id: "e1", role: "field", label: "Title", value: "", frame: [10, 10, 300, 20] }], { app: { name: "TextEdit", pid: 7 } });
  const ok = rig({ snaps: [NOTES], scripts: [[heardDo("title it Plan"), { t: "action", kind: "set", id: "e1", text: "Plan", risk: "free" }], [{ t: "done" }]] });
  ok.agent.begin({ app: "TextEdit" });
  await ok.agent.heard(AUDIO);
  assert.deepStrictEqual(ok.driver.acts(), [["setValue", "e1", "Plan"]]);
  assert.deepStrictEqual(ok.pasted, []);

  const NOTES_FOCUSED = snap([{ id: "e1", role: "field", label: "Title", value: "", focused: true, frame: [10, 10, 300, 20] }], { app: { name: "TextEdit", pid: 7 }, focused: "e1" });
  const bad = rig({
    snaps: [NOTES, NOTES_FOCUSED],
    results: { setValue: { ok: false, error: "not settable" } },
    scripts: [[heardDo("title it Plan"), { t: "action", kind: "set", id: "e1", text: "Plan", risk: "free" }], [{ t: "done" }]],
  });
  bad.agent.begin({ app: "TextEdit" });
  await bad.agent.heard(AUDIO);
  assert.deepStrictEqual(bad.driver.acts(), [["setValue", "e1", "Plan"], ["focus", "e1"], ["key", "cmd+a"]]);
  assert.deepStrictEqual(bad.pasted, ["Plan"]);
});

test("a web set stops at the first step that fails: no select-all without focus", async () => {
  const r = rig({
    results: { focus: { ok: false, error: "gone" } },
    scripts: [[heardDo("write hi"), { t: "action", kind: "set", id: "e2", text: "hi", risk: "free" }], [{ t: "done" }]],
  });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO);
  assert.deepStrictEqual(r.driver.acts(), [["focus", "e2"]]);
  assert.deepStrictEqual(r.pasted, []);
  assert.strictEqual(r.post.reqs()[1].history[0].result, "failed");
});

test("key, scroll, focus and open go to the driver as given", async () => {
  const shots = [SLACK];
  for (let i = 0; i < 8; i++) shots.push(snap([EXPORT, COMPOSER, SEND, HEADING, { id: "e9", role: "text", label: "tick " + i }], { focused: "e2" }));
  const r = rig({
    confirm: true,
    snaps: shots,
    scripts: [
      [heardDo("do things"), { t: "action", kind: "key", keys: "cmd+k", risk: "free" }],
      [{ t: "action", kind: "scroll", dir: "down", id: "e4", risk: "free" }],
      [{ t: "action", kind: "focus", id: "e2", risk: "free" }],
      [{ t: "action", kind: "open", app: "Slack", risk: "free" }],
      [{ t: "done" }],
    ],
  });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO);
  assert.deepStrictEqual(r.driver.acts(), [["key", "cmd+k"], ["scroll", "e4", "down", 5], ["focus", "e2"], ["open", "Slack"]]);
  assert.deepStrictEqual(r.guide.of("confirm"), [], "opening the app the run is in needs no yes");
});

test("an action on an id that is not on this screen is not run", async () => {
  const r = rig({ scripts: [[heardDo("export"), press("e77")], [{ t: "done" }]] });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO);
  assert.deepStrictEqual(r.driver.acts(), []);
  assert.deepStrictEqual(r.post.reqs()[1].history[0], { said: "export", did: "PRESS e77", result: "failed", note: "no such element on screen" });
});

// ---- ask --------------------------------------------------------------------

test("ask: the question is said, the reply is recorded, and the next step carries it as audio", async () => {
  let listened = 0;
  const r = rig({
    listen: async () => { listened++; return REPLY; },
    scripts: [
      [heardDo("tell them it's ready"), { t: "ask", text: "Which channel?" }],
      [heardDo("design"), { t: "done", text: "Okay." }],
    ],
  });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO);
  assert.strictEqual(listened, 1);
  assert.ok(r.guide.of("say").some((c) => c[1] === "Which channel?"));
  const states = r.guide.of("state").map((c) => c[1]);
  assert.ok(states.indexOf("listening") > 0 && states.indexOf("listening") < states.lastIndexOf("thinking"));
  const [a, b] = r.post.requests;
  assert.strictEqual(a.audio, AUDIO);
  assert.strictEqual(b.audio, REPLY);
  assert.strictEqual(b.req.step, 1);
  assert.strictEqual(b.req.utterance, undefined, "the reply is the audio, not the goal");
  assert.deepStrictEqual(b.req.history, [{ said: "tell them it's ready", did: "ASK", note: "Which channel?" }]);
  assert.deepStrictEqual(r.guide.of("heard").map((c) => c[1]), ["tell them it's ready", "design"]);
});

test("ask with no reply ends the run quietly", async () => {
  const r = rig({ listen: async () => null, scripts: [[heardDo("tell them"), { t: "ask", text: "Who?" }]] });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO);
  assert.strictEqual(r.post.requests.length, 1);
  assert.deepStrictEqual(r.guide.calls.at(-1), ["hide"]);
  assert.strictEqual(r.agent.active(), false);
});

// ---- stops ------------------------------------------------------------------

/** A screen that is different every time it is read: a ticking clock. */
const ticking = (n) => snap([
  { id: "e1", role: "button", label: "Next", frame: [10, 10, 50, 20] },
  { id: "e2", role: "button", label: "Back", frame: [70, 10, 50, 20] },
  { id: "e3", role: "text", label: `12:0${n % 10}` },
], { app: { name: "Notes", pid: 3 } });

test("maxSteps stops the run", async () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ id: `e${i + 1}`, role: "button", label: `Option ${i + 1}`, frame: [10, 10 + i * 30, 100, 20] }));
  const moving = (n) => snap(many, { focused: `e${n}`, app: { name: "Notes", pid: 3 } });
  const r = rig({
    knobs: { "desktop.agent.maxSteps": 3 },
    snaps: [moving],
    scripts: [[heardDo("go"), press("e1")], [press("e2")], [press("e3")], [{ t: "done" }]],
  });
  r.agent.begin({ app: "Notes" });
  await r.agent.heard(AUDIO);
  assert.strictEqual(r.post.requests.length, 3);
  assert.deepStrictEqual(r.driver.acts().map((c) => c[1]), ["e1", "e2", "e3"]);
  assert.deepStrictEqual(r.guide.of("state").at(-1), ["state", "done", TEXT.steps]);
});

test("the same action to no effect twice in a row stops the run", async () => {
  const r = rig({ scripts: [[heardDo("export"), press("e1")], [press("e1")], [press("e1")]] });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO);
  assert.strictEqual(r.post.requests.length, 2);
  assert.deepStrictEqual(r.driver.acts(), [["press", "e1"], ["press", "e1"]]);
  assert.deepStrictEqual(r.post.reqs()[1].history[0], { said: "export", did: "PRESS e1", result: "nochange", note: "nochange" });
  assert.deepStrictEqual(r.guide.of("state").at(-1), ["state", "done", TEXT.stuck]);
});

test("A, B, A, B, A on a screen that always changes is a loop: the third A never runs", async () => {
  const r = rig({
    snaps: [ticking],
    scripts: [[heardDo("go"), press("e1")], [press("e2")], [press("e1")], [press("e2")], [press("e1")], [{ t: "done" }]],
  });
  r.agent.begin({ app: "Notes" });
  await r.agent.heard(AUDIO);
  assert.deepStrictEqual(r.driver.acts().map((c) => c[1]), ["e1", "e2", "e1", "e2"]);
  assert.strictEqual(r.post.requests.length, 5);
  assert.deepStrictEqual(r.guide.of("state").at(-1), ["state", "done", TEXT.loop]);
});

test("a third scroll the same way on a ticking screen is a loop", async () => {
  const scroll = { t: "action", kind: "scroll", dir: "down", risk: "free" };
  const r = rig({ snaps: [ticking], scripts: [[heardDo("find comments"), scroll], [scroll], [scroll], [{ t: "done" }]] });
  r.agent.begin({ app: "Notes" });
  await r.agent.heard(AUDIO);
  assert.strictEqual(r.driver.acts().length, 2);
  assert.deepStrictEqual(r.guide.of("state").at(-1), ["state", "done", TEXT.loop]);
});

test("the run deadline stops it between steps", async () => {
  let r;
  r = rig({
    snaps: [ticking],
    results: { press: () => { r.tick(61_000); return { ok: true }; } },
    scripts: [[heardDo("go"), press("e1")], [{ t: "done" }]],
  });
  r.agent.begin({ app: "Notes" });
  await r.agent.heard(AUDIO);
  assert.strictEqual(r.post.requests.length, 1);
  assert.deepStrictEqual(r.guide.of("state").at(-1), ["state", "done", TEXT.deadline]);
});

test("the run deadline also stops a stream that hangs", async () => {
  const r = rig({ knobs: { "desktop.agent.deadlineMs": 30 }, scripts: [[heardDo("go"), never]] });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO);
  assert.ok(r.post.requests[0].signal.aborted);
  assert.deepStrictEqual(r.guide.of("state").at(-1), ["state", "done", TEXT.deadline]);
});

test("history keeps the last 16 turns", async () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ id: `e${i + 1}`, role: "button", label: `Option ${i + 1}`, frame: [10, 10 + i * 20, 100, 18] }));
  const moving = (n) => snap(many, { focused: `e${n}`, app: { name: "Notes", pid: 3 } });
  const scripts = Array.from({ length: 18 }, (_, k) => [press(`e${k + 1}`)]);
  scripts[0].unshift(heardDo("go"));
  scripts.push([{ t: "done" }]);
  const r = rig({ knobs: { "desktop.agent.maxSteps": 30 }, snaps: [moving], scripts });
  r.agent.begin({ app: "Notes" });
  await r.agent.heard(AUDIO);
  const last = r.post.reqs().at(-1);
  assert.strictEqual(last.step, 18);
  assert.strictEqual(last.history.length, 16);
  assert.strictEqual(last.history[0].did, "PRESS e3");
  assert.strictEqual(last.history[15].did, "PRESS e18");
});

// ---- cancel and late events ---------------------------------------------------

test("cancel mid-stream: the request is aborted, the guide hides, and nothing after reaches it", async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  let reached;
  const atGate = new Promise((res) => { reached = res; });
  const r = rig({
    scripts: [[
      heardShow("where's export?"),
      { t: "say", text: "Looking…" },
      async () => { reached(); await gate; },
      { t: "point", id: "e1" },
      { t: "say", text: "late" },
      { t: "done", text: "late" },
    ]],
  });
  r.agent.begin({ app: "Slack" });
  const running = r.agent.heard(AUDIO);
  await atGate;
  const seen = r.guide.calls.length;
  assert.strictEqual(r.agent.cancel("esc"), true);
  assert.strictEqual(r.post.requests[0].signal.aborted, true);
  assert.strictEqual(r.agent.active(), false);
  assert.deepStrictEqual(r.guide.calls.slice(seen), [["hide"]]);
  release();
  await running;
  await sleep(10);
  assert.deepStrictEqual(r.guide.calls.slice(seen), [["hide"]], "no late event reached the guide");
  assert.ok(r.logs.some((l) => /cancelled \(esc\)/.test(l)));
});

test("cancel while waiting for a yes: the action never runs", async () => {
  let asked;
  const askedP = new Promise((res) => { asked = res; });
  const r = rig({ confirm: () => { asked(); return never(); }, scripts: [[heardDo("send"), press("e3", { risk: "confirm" })]] });
  r.agent.begin({ app: "Slack" });
  const running = r.agent.heard(AUDIO);
  await askedP;
  r.agent.cancel("esc");
  await running;
  assert.deepStrictEqual(r.driver.acts(), []);
  assert.strictEqual(r.guide.of("state").filter((c) => c[1] === "done").length, 0);
});

test("events after the terminal one are not read", async () => {
  const r = rig({ scripts: [[heardShow("hi"), { t: "done", text: "Hello." }, { t: "say", text: "late" }, { t: "point", id: "e1" }]] });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO);
  assert.deepStrictEqual(r.guide.of("say"), []);
  assert.deepStrictEqual(r.guide.of("point"), []);
});

test("a run begun while another is active replaces it", async () => {
  const r = rig({ scripts: [[heardShow("x"), never]] });
  r.agent.begin({ app: "Slack" });
  const first = r.agent.heard(AUDIO);
  await sleep(5);
  const firstSignal = r.post.requests[0].signal;
  assert.strictEqual(r.agent.begin({ app: "Slack" }), true);
  await first;
  assert.ok(firstSignal.aborted);
  assert.strictEqual(r.agent.active(), true);
  r.agent.cancel("done with the test");
});

// ---- refusals and failures ----------------------------------------------------

test("a private window or a sensitive app is refused at begin, before anything is read", async () => {
  for (const [opts, text] of [[{ app: "Chrome", privateField: true }, TEXT.private], [{ app: "Chase", sensitive: true }, TEXT.sensitive]]) {
    const r = rig();
    assert.strictEqual(r.agent.begin(opts), false);
    assert.deepStrictEqual(r.guide.of("error"), [["error", text]]);
    assert.deepStrictEqual(r.guide.of("show"), []);
    assert.strictEqual(r.driver.snapshots(), 0);
    assert.strictEqual(r.agent.active(), false);
    await r.agent.heard(AUDIO);
    assert.strictEqual(r.post.requests.length, 0);
  }
});

test("an OPEN that lands in a sensitive app ends the run without sending its screen", async () => {
  const VAULT = snap([{ id: "e1", role: "field", label: "Master password", secure: true }], { app: { name: "1Password", pid: 9 } });
  const r = rig({
    confirm: true,
    snaps: [SLACK, VAULT],
    scripts: [[heardDo("open 1password"), { t: "action", kind: "open", app: "1Password", risk: "confirm" }], [{ t: "done" }]],
  });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO);
  assert.deepStrictEqual(r.driver.acts(), [["open", "1Password"]]);
  assert.strictEqual(r.post.requests.length, 1);
  assert.deepStrictEqual(r.guide.of("state").at(-1), ["state", "done", TEXT.blocked]);
});

// A browser keeps its app name on every site and in every window, so these
// are told apart by the window's title, which the helpers report for this
// check only.
const CHROME = { name: "Google Chrome", pid: 5 };
const GMAIL = snap([
  { id: "e1", role: "tab", label: "Chase Online", frame: [200, 0, 160, 30] },
  { id: "e2", role: "text", label: "Inbox", frame: [20, 80, 100, 20] },
], { app: CHROME, window: { frame: WIN, title: "Inbox (3) - me@example.com - Gmail" } });

test("a press that lands on a bank site in the same browser ends the run without sending it", async () => {
  const BANK = snap([
    { id: "e1", role: "text", label: "Total checking balance $12,345.67", frame: [20, 80, 300, 20] },
    { id: "e2", role: "text", label: "Account ending 4321", frame: [20, 110, 300, 20] },
  ], { app: CHROME, window: { frame: WIN, title: "Chase Online - Accounts" } });
  const r = rig({
    confirm: true,
    snaps: [GMAIL, BANK],
    scripts: [[heardDo("switch to my chase tab"), press("e1")], [{ t: "done" }]],
  });
  r.agent.begin({ app: "Gmail" });
  await r.agent.heard(AUDIO);
  assert.deepStrictEqual(r.driver.acts(), [["press", "e1"]]);
  assert.strictEqual(r.post.requests.length, 1, "the bank page is never posted");
  assert.deepStrictEqual(r.guide.of("state").at(-1), ["state", "done", TEXT.blocked]);
  assert.strictEqual(r.agent.active(), false);
  const sent = JSON.stringify(r.post.reqs());
  for (const secret of ["12,345", "4321", "me@example.com", "Inbox (3)"]) assert.ok(!sent.includes(secret), secret);
  assert.ok(!r.logs.join("\n").includes("Chase Online - Accounts"), "the title is not logged either");
});

test("a key that opens a private window ends the run without sending it", async () => {
  const INCOGNITO = snap([{ id: "e1", role: "field", label: "Address and search bar", focused: true }], {
    app: CHROME, focused: "e1", window: { frame: WIN, title: "New Incognito Tab - Google Chrome" },
  });
  const r = rig({
    snaps: [GMAIL, GMAIL, INCOGNITO],
    scripts: [[heardDo("open an incognito window"), { t: "action", kind: "key", keys: "cmd+shift+n", risk: "free" }], [{ t: "done" }]],
  });
  r.agent.begin({ app: "Gmail" });
  await r.agent.heard(AUDIO);
  assert.deepStrictEqual(r.driver.acts(), [["key", "cmd+shift+n"]]);
  assert.strictEqual(r.post.requests.length, 1);
  assert.deepStrictEqual(r.guide.of("state").at(-1), ["state", "done", TEXT.blockedPrivate]);
});

test("no key, paste or select-all goes into a window that turned private while the step waited", async () => {
  const BAR = { id: "e1", role: "field", label: "Address and search bar", value: "", focused: true, frame: [100, 0, 600, 30] };
  const NORMAL = snap([BAR], { app: CHROME, focused: "e1", window: { frame: WIN, title: "New Tab - Google Chrome" } });
  const PRIVATE = snap([BAR], { app: CHROME, focused: "e1", window: { frame: WIN, title: "New Incognito Tab - Google Chrome" } });
  for (const action of [
    { t: "action", kind: "key", keys: "enter", risk: "free" },
    { t: "action", kind: "type", text: "tailzu.space", risk: "free" },
    { t: "action", kind: "set", id: "e1", text: "tailzu.space", risk: "free" },
  ]) {
    const r = rig({ snaps: [NORMAL, PRIVATE], scripts: [[heardDo("go to tailzu"), action], [{ t: "done" }]] });
    r.agent.begin({ app: "Chrome" });
    await r.agent.heard(AUDIO);
    assert.deepStrictEqual(r.driver.acts().filter((c) => c[0] === "key"), [], action.kind);
    assert.deepStrictEqual(r.pasted, [], action.kind);
    assert.strictEqual(r.post.requests.length, 1, action.kind);
    assert.deepStrictEqual(r.guide.of("state").at(-1), ["state", "done", TEXT.blockedPrivate], action.kind);
  }
});

test("a first screen that is private or sensitive by its title sends nothing at all", async () => {
  for (const [title, text] of [["Private Browsing - Safari", TEXT.blockedPrivate], ["Patient portal - MyClinic", TEXT.blocked]]) {
    const s = snap([{ id: "e1", role: "text", label: "Lab results" }], { app: { name: "Safari", pid: 3 }, window: { frame: WIN, title } });
    const r = rig({ snaps: [s], scripts: [[heardShow("what is this?"), { t: "done" }]] });
    r.agent.begin({ app: "Safari" });
    await r.agent.heard(AUDIO);
    assert.strictEqual(r.post.requests.length, 0, title);
    assert.deepStrictEqual(r.guide.of("state").at(-1), ["state", "done", text], title);
  }
});

test("the window's title is used on this computer only: never in a request", async () => {
  const TITLED = snap([EXPORT, COMPOSER, SEND, HEADING], { focused: "e2", window: { frame: WIN, title: "Q3 layoffs — draft" } });
  const r = rig({
    snaps: [TITLED, TITLED, TITLED],
    scripts: [[heardDo("export"), press("e1")], [{ t: "done" }]],
  });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO);
  assert.strictEqual(r.post.requests.length, 2);
  const sent = JSON.stringify(r.post.reqs());
  assert.ok(!sent.includes("layoffs"));
  assert.ok(!sent.includes("title"));
});

test("a failed snapshot still asks, with no elements and the reason in the log", async () => {
  const r = rig({ snaps: [{ ok: false, error: "not trusted" }], scripts: [[heardShow("what is this?"), { t: "say", text: "A chat app." }, { t: "done" }]] });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO);
  assert.deepStrictEqual(r.post.reqs()[0].screen, { elements: [] });
  assert.ok(r.logs.some((l) => /not trusted/.test(l)));
  assert.strictEqual(r.guide.of("say").length, 1);
});

test("a snapshot that never answers is given up on after its own timeout", async () => {
  const r = rig({ knobs: { "desktop.agent.snapshotTimeoutMs": 10 }, snaps: [never], scripts: [[heardShow("hi"), { t: "done" }]] });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO);
  assert.deepStrictEqual(r.post.reqs()[0].screen.elements, []);
  assert.ok(r.logs.some((l) => /timeout/.test(l)));
});

test("an error event is shown, and so is a stream that ends with no answer", async () => {
  const e = rig({ scripts: [[heardDo("x"), { t: "error", code: "quota_exceeded", message: "You're out of asks for today." }]] });
  e.agent.begin({ app: "Slack" });
  await e.agent.heard(AUDIO);
  assert.deepStrictEqual(e.guide.of("error"), [["error", "You're out of asks for today."]]);

  const cut = rig({ scripts: [[heardDo("x"), { t: "say", text: "Let me" }]] });
  cut.agent.begin({ app: "Slack" });
  await cut.agent.heard(AUDIO);
  assert.deepStrictEqual(cut.guide.of("error"), [["error", TEXT.incomplete]]);
});

test("a post that throws, or a stream that breaks, is a network error", async () => {
  const r = rig();
  r.post = null;
  const guide = fakeGuide(true);
  const agent = createAgent({
    driver: fakeDriver([SLACK]), guide, knob: (n, f) => f, platform: "mac",
    post: () => { throw new Error("offline"); },
  });
  agent.begin({ app: "Slack" });
  await agent.heard(AUDIO);
  assert.deepStrictEqual(guide.of("error"), [["error", TEXT.network]]);

  const guide2 = fakeGuide(true);
  const agent2 = createAgent({
    driver: fakeDriver([SLACK]), guide: guide2, knob: (n, f) => f, platform: "mac",
    post: async function* () { yield heardShow("x"); throw new Error("ECONNRESET"); },
  });
  agent2.begin({ app: "Slack" });
  await agent2.heard(AUDIO);
  assert.deepStrictEqual(guide2.of("error"), [["error", TEXT.network]]);
});

test("a guide that throws everywhere does not break the run", async () => {
  const guide = { confirm: async () => true };
  for (const m of ["show", "state", "heard", "say", "point", "unpoint", "steps", "hide", "error"]) {
    guide[m] = () => { throw new Error("renderer crashed"); };
  }
  guide.say = () => Promise.reject(new Error("speech failed"));
  const AFTER = snap([EXPORT, COMPOSER, SEND, HEADING], { focused: "e1" });
  const r = rig({
    guide,
    snaps: [SLACK, AFTER],
    scripts: [[heardDo("export"), { t: "say", text: "On it." }, { t: "steps", items: ["Export"] }, press("e1")], [{ t: "done", text: "Done." }]],
  });
  assert.strictEqual(r.agent.begin({ app: "Slack" }), true);
  await r.agent.heard(AUDIO);
  assert.deepStrictEqual(r.driver.acts(), [["press", "e1"]]);
  assert.strictEqual(r.post.requests.length, 2);
  assert.strictEqual(r.agent.active(), false);
  assert.ok(r.logs.some((l) => /guide\.\w+ threw/.test(l)));
});

test("empty audio, or empty words, ends the run quietly", async () => {
  const r = rig();
  r.agent.begin({ app: "Slack" });
  await r.agent.heard({ mime: "audio/webm", data: Buffer.alloc(0) });
  assert.strictEqual(r.post.requests.length, 0);
  assert.strictEqual(r.agent.active(), false);
  r.agent.begin({ app: "Slack" });
  await r.agent.typed("   ");
  assert.strictEqual(r.post.requests.length, 0);
});

test("a post given as an async function returning the stream works the same", async () => {
  const guide = fakeGuide(true);
  const agent = createAgent({
    driver: fakeDriver([SLACK]), guide, knob: (n, f) => (n === "desktop.agent.doneMs" ? 1 : f), platform: "win",
    post: async () => [heardShow("hi"), { t: "point", id: "e3" }, { t: "done" }],
  });
  agent.begin({ app: "Slack" });
  await agent.heard(AUDIO);
  assert.deepStrictEqual(guide.of("point"), [["point", [720, 520, 60, 40]]]);
});

// ---- the screen as it leaves --------------------------------------------------

test("regionOf: thirds of the window, by the centre; outside clamps to the edge", () => {
  const W = [100, 100, 900, 600];
  const at = (x, y) => regionOf([x - 5, y - 5, 10, 10], W);
  assert.deepStrictEqual(
    [at(150, 150), at(550, 150), at(950, 150), at(150, 400), at(550, 400), at(950, 400), at(150, 650), at(550, 650), at(950, 650)],
    ["tl", "t", "tr", "l", "c", "r", "bl", "b", "br"],
  );
  assert.strictEqual(at(50, 20), "tl", "a menu bar item above the window");
  assert.strictEqual(at(2000, 2000), "br");
  assert.strictEqual(regionOf([0, 0, 10, 10], null), undefined);
  assert.strictEqual(regionOf(null, W), undefined);
  assert.strictEqual(regionOf([0, 0, 10, 10], [0, 0, 0, 0]), undefined);
});

test("toRequestElements: no frames, no password values, no window titles, no address bar, no URL tokens", () => {
  const s = snap([
    { id: "e1", role: "window", label: "Q3 layoffs — draft.docx", frame: [0, 0, 900, 600] },
    { id: "e2", role: "field", label: "Password", value: "hunter2", secure: true, frame: [10, 10, 100, 20] },
    { id: "e3", role: "field", label: "Address and search bar", value: "https://mail.example.com/u/0?token=abc", frame: [10, 40, 400, 20] },
    { id: "e4", role: "link", label: "Reset https://example.com/reset?code=SECRET#frag here", frame: [10, 70, 400, 20] },
    { id: "e5", role: "field", label: "Website", value: "www.example.com/a/b?session=xyz", frame: [10, 100, 400, 20] },
    { id: "e6", role: "check", label: "Captions", checked: false, frame: [10, 130, 20, 20] },
    { id: "e7", role: "slider", label: "Volume", value: 40, frame: [10, 160, 100, 20], disabled: true, selected: true },
    { id: "bad", role: "button", label: "No id format" },
    { id: "e7", role: "button", label: "Duplicate id" },
    { id: "e8", role: "button", label: "  Lots \n of   space  ", frame: [10, 170, 50, 20] },
  ], { focused: "e8" });
  const out = toRequestElements(s);
  assert.deepStrictEqual(out, [
    { id: "e1", role: "window", region: "c" },
    { id: "e2", role: "field", label: "Password", region: "tl" },
    { id: "e3", role: "field", label: "Address and search bar", region: "tl" },
    { id: "e4", role: "link", label: "Reset https://example.com/reset here", region: "tl" },
    { id: "e5", role: "field", label: "Website", value: "www.example.com/a/b", region: "tl" },
    { id: "e6", role: "check", label: "Captions", region: "tl", checked: false },
    { id: "e7", role: "slider", label: "Volume", value: "40", region: "tl", disabled: true, selected: true },
    { id: "e8", role: "button", label: "Lots of space", region: "tl", focused: true },
  ]);
  const json = JSON.stringify(out);
  for (const secret of ["hunter2", "frame", "token=abc", "SECRET", "session", "layoffs", "#frag"]) assert.ok(!json.includes(secret), secret);
});

test("with a password field focused, neither the selection nor the field goes", async () => {
  const PW = snap([{ id: "e1", role: "field", label: "Password", secure: true, focused: true, frame: [10, 10, 100, 20] }], { focused: "e1", selection: "hunter2" });
  const r = rig({ snaps: [PW], scripts: [[heardShow("what is this?"), { t: "done" }]] });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO);
  const { screen } = r.post.reqs()[0];
  assert.strictEqual(screen.selection, undefined);
  assert.strictEqual(screen.field, undefined);
  assert.ok(!JSON.stringify(screen).includes("hunter2"));
});

test("an address bar's selection never goes, nor one carrying a URL's query; any other goes verbatim", async () => {
  const cases = [
    // Focusing the omnibox selects the whole URL, reset token and all.
    [{ id: "e1", role: "field", label: "Address and search bar", focused: true }, "https://accounts.example.com/reset?token=SECRET-RESET-TOKEN-123", undefined],
    // Safari's, by its own label; even a URL with no query is the address bar's.
    [{ id: "e1", role: "field", label: "Smart Search Field", focused: true }, "github.com/tailzu/desktop", undefined],
    [{ id: "e1", role: "combo", label: "Search Google or type a URL", focused: true }, "example.com/inbox", undefined],
    // Anywhere else, a query or a fragment keeps the whole selection home.
    [{ id: "e1", role: "area", label: "Message #design", focused: true }, "see https://x.example.com/a?session=abc123 here", undefined],
    [null, "https://example.com/cb#access_token=xyz", undefined],
    [{ id: "e1", role: "area", label: "Message #design", focused: true }, "www.example.com/watch?v=abc", undefined],
    // A selection with no URL secrets is sent as it is, edges and all: the
    // rewrite is pasted back over exactly this.
    [{ id: "e1", role: "area", label: "Message #design", focused: true }, "  the mockups are ready, see https://example.com/mockups  ", "  the mockups are ready, see https://example.com/mockups  "],
    [{ id: "e1", role: "area", label: "Message #design", focused: true }, "Are we there yet? #design", "Are we there yet? #design"],
  ];
  for (const [el, selection, want] of cases) {
    const s = snap(el ? [el] : [{ id: "e1", role: "text", label: "Docs" }], { focused: el ? "e1" : null, selection });
    const r = rig({ snaps: [s], scripts: [[heardShow("what is this?"), { t: "done" }]] });
    r.agent.begin({ app: "Chrome" });
    await r.agent.heard(AUDIO);
    const { screen } = r.post.reqs()[0];
    assert.strictEqual(screen.selection, want, selection);
    if (want === undefined) for (const secret of ["SECRET", "github.com/tailzu", "inbox", "session=", "access_token", "v=abc"]) assert.ok(!JSON.stringify(screen).includes(secret), selection + ": " + secret);
  }
  // The address bar is still named as one: the model knows where focus is.
  const r = rig({ snaps: [snap([cases[0][0]], { focused: "e1", selection: cases[0][1] })], scripts: [[heardShow("what is this?"), { t: "done" }]] });
  r.agent.begin({ app: "Chrome" });
  await r.agent.heard(AUDIO);
  assert.deepStrictEqual(r.post.reqs()[0].screen.field, { kind: "url", label: "Address and search bar" });
});

test("toRequestElements caps the list at max, and never above 250", () => {
  const many = Array.from({ length: 300 }, (_, i) => ({ id: `e${i + 1}`, role: "text", label: `t${i}` }));
  assert.strictEqual(toRequestElements(snap(many), 10).length, 10);
  assert.strictEqual(toRequestElements(snap(many), 1000).length, 250);
  assert.strictEqual(toRequestElements(snap(many)).length, 250);
  assert.deepStrictEqual(toRequestElements({ ok: false, error: "x" }), []);
  assert.deepStrictEqual(toRequestElements(null), []);
});

/** The screen as the server measures it against AGENT_SCREEN_MAX_CHARS: its
 *  prompt's line for each element (prompt.ts elementLine), and a line break. */
function serverChars(els) {
  return els.reduce((n, e) => {
    let line = `${e.id} ${e.role}`;
    if (e.label) line += ` "${e.label}"`;
    if (e.region) line += ` @${e.region}`;
    if (e.value) line += ` ="${e.value}"`;
    if (e.focused) line += " focused";
    if (e.disabled) line += " disabled";
    if (e.selected) line += " selected";
    if (e.checked === true) line += " checked";
    if (e.checked === false) line += " unchecked";
    return n + line.length + 1;
  }, 0);
}

test("toRequestElements: a page of text read off the window stops inside the server's screen budget; the tree is never cut for it", () => {
  const long = "The committee reviewed every line of the budget again and found nothing to change at all";
  const tree = [
    EXPORT,
    { id: "e2", role: "field", label: "Notes from the planning meeting, kept by the whole team", value: long + " " + long, frame: [500, 300, 300, 30], focused: true },
  ];
  // Three hundred long lines down the left of the window: the region of each
  // is two letters, the label 80 characters, about 97 each.
  const lines = Array.from({ length: 300 }, (_, i) => ({ id: `o${i + 1}`, role: "text", label: `${i} ${long}`, frame: [10, 40 + i * 1.8, 250, 2], ocr: true }));
  const out = toRequestElements(snap(tree.concat(lines)));
  assert.deepStrictEqual(out.slice(0, 2).map((e) => e.id), ["e1", "e2"]);
  const sent = out.slice(2);
  // The top of the page, in order, and well short of the 248 the count allows.
  assert.ok(sent.length > 150 && sent.length < 248, `${sent.length} lines`);
  assert.deepStrictEqual(sent.map((e) => e.id), sent.map((_, i) => `o${i + 1}`));
  assert.ok(serverChars(out) <= SCREEN_CHARS, `${serverChars(out)} chars`);
  // With every line in, the server would have refused the step (413).
  assert.ok(serverChars(toRequestElements(snap(tree.concat(lines)), 250, 1e9)) > 24000);
  // A tree over the budget on its own goes whole, as it always has; no line goes with it.
  const big = Array.from({ length: 200 }, (_, i) => ({ id: `e${i + 1}`, role: "field", label: "L".repeat(80), value: "V".repeat(60), frame: [10, 10, 10, 10] }));
  const both = toRequestElements(snap(big.concat(lines.slice(0, 10))));
  assert.strictEqual(both.length, 200);
  assert.ok(both.every((e) => e.id[0] === "e"));
  // The window's text takes its share of the budget first.
  assert.ok(toRequestElements(snap(tree.concat(lines)), 250, SCREEN_CHARS - 4000).length < out.length);
});

test("frameMap maps ids to frames for one snapshot, skipping bad frames", () => {
  const m = frameMap(snap([EXPORT, { id: "e9", role: "text", label: "x", frame: [1, 2] }]));
  assert.deepStrictEqual([...m], [["e1", [700, 20, 80, 30]]]);
});

test("describeChange: nochange, window, focus, new and gone, a switch turned on", () => {
  assert.strictEqual(describeChange(SLACK, SLACK), "nochange");
  assert.strictEqual(describeChange(SLACK, { ok: false, error: "timeout" }), "couldn't read the screen");
  const moved = snap(SLACK.elements, { window: { frame: [50, 50, 900, 600] }, focused: "e2" });
  assert.strictEqual(describeChange(SLACK, moved), "window changed");
  assert.strictEqual(describeChange(SLACK, snap(SLACK.elements, { app: { name: "Mail", pid: 7 }, focused: "e2" })), "switched to Mail");
  const off = snap([{ id: "e1", role: "switch", label: "Captions", checked: false }]);
  const on = snap([{ id: "e4", role: "switch", label: "Captions", checked: true }]);
  assert.strictEqual(describeChange(off, on), '"Captions" turned on');
  const more = snap([EXPORT, COMPOSER, SEND, HEADING, { id: "e5", role: "menuitem", label: "Export…" }, { id: "e6", role: "menuitem", label: "Print" }], { focused: "e5" });
  assert.strictEqual(describeChange(SLACK, more), 'focus moved to "Export…"; 2 new elements like "Export…", "Print"');
  assert.strictEqual(describeChange(more, SLACK), 'focus moved to "Message #design"; 2 elements gone');
  // Ids are renumbered on every walk; the same elements under new ids are no change.
  const renumbered = snap(SLACK.elements.map((e, i) => Object.assign({}, e, { id: `e${10 + i}` })), { focused: "e11" });
  assert.strictEqual(describeChange(SLACK, renumbered), "nochange");
});

// ---- risk ---------------------------------------------------------------------

function riskOf(action, elements, extra, ctx) {
  return classifyRisk(action, snap(elements || [], Object.assign({ app: { name: "Notes", pid: 1 } }, extra)), ctx);
}
const btn = (label, role = "button") => [{ id: "e1", role, label, frame: [0, 0, 10, 10] }];
const P = { kind: "press", id: "e1" };

const LABELS = [
  ["Export", "free"],
  ["Send", "confirm"],
  ["SEND", "confirm"],
  ["Send…", "confirm"],
  ["Sender", "free"],
  ["Resend code", "free"],
  ["Post", "confirm"],
  ["Postpone", "free"],
  ["Posts", "free"],
  ["Submit", "confirm"],
  ["Reply all", "confirm"],
  ["Reply", "free"],
  ["Share", "confirm"],
  ["Shared with me", "free"],
  ["Invite people", "confirm"],
  ["Publish", "confirm"],
  ["Merge pull request", "confirm"],
  ["Deploy", "confirm"],
  ["Sign out", "confirm"],
  ["Logout", "confirm"],
  ["Log out", "confirm"],
  ["Uninstall", "confirm"],
  ["Close without saving", "confirm"],
  ["Don't Save", "confirm"],
  ["Delete", "always"],
  ["Remove background", "always"],
  ["Erase", "always"],
  ["Empty Trash", "always"],
  ["Empty Recycle Bin", "always"],
  ["Pay now", "always"],
  ["Apple Pay", "always"],
  ["Payment methods", "free"],
  ["PayPal", "free"],
  ["Buy", "always"],
  ["Buyer details", "free"],
  ["Purchase", "always"],
  ["Place order", "always"],
  ["Checkout", "always"],
  ["Transfer", "always"],
  ["Subscribe", "always"],
  ["Unsubscribe", "free"],
  ["Cancel subscription", "always"],
  ["Cancel", "free"],
  ["Send and delete", "always"],
];
for (const [label, want] of LABELS) {
  test(`classifyRisk: press “${label}” → ${want}`, () => {
    assert.strictEqual(riskOf(P, btn(label)), want);
  });
}

test("classifyRisk: an “Ordered list” heading is not an order", () => {
  assert.strictEqual(riskOf(P, btn("Ordered list", "heading")), "free");
});

const field = (label, role = "field", extra) => Object.assign({ id: "e1", role, label, frame: [0, 0, 100, 20] }, extra);
const focusedIn = (el, more) => [[el].concat(more || []), { focused: el.id }];

const CASES = [
  // [name, action, [elements, extra], ctx, want]
  ["type: words from the list in the text", { kind: "type", text: "I'll send it tomorrow" }, focusedIn(field("Message #design", "area")), null, "confirm"],
  ["type: plain words into a field", { kind: "type", text: "The mockups are ready!" }, focusedIn(field("Message #design", "area")), null, "free"],
  ["key: Enter in a message field", { kind: "key", keys: "enter" }, focusedIn(field("Message #design", "area")), null, "confirm"],
  ["key: Return in a reply box", { kind: "key", keys: "return" }, focusedIn(field("Reply…")), null, "confirm"],
  ["key: Shift+Enter in a comment box", { kind: "key", keys: "shift+enter" }, focusedIn(field("Add a comment", "area")), null, "confirm"],
  ["key: Enter in a search box", { kind: "key", keys: "enter" }, focusedIn(field("Search messages")), null, "free"],
  ["key: Enter in a plain field", { kind: "key", keys: "enter" }, focusedIn(field("Subject")), null, "free"],
  ["key: Enter on a focused Send button", { kind: "key", keys: "enter" }, focusedIn(field("Send", "button")), null, "confirm"],
  ["key: Escape in a message field", { kind: "key", keys: "escape" }, focusedIn(field("Message #design", "area")), null, "free"],
  ["key: Cmd+Enter anywhere", { kind: "key", keys: "cmd+enter" }, focusedIn(field("Search")), null, "confirm"],
  ["key: Ctrl+Enter anywhere", { kind: "key", keys: "ctrl+enter" }, focusedIn(field("Body", "area")), null, "confirm"],
  ["key: Cmd+W", { kind: "key", keys: "cmd+w" }, focusedIn(field("Body", "area")), null, "confirm"],
  ["key: Ctrl+W", { kind: "key", keys: "ctrl+w" }, [[]], null, "confirm"],
  ["key: Cmd+Q", { kind: "key", keys: "cmd+q" }, [[]], null, "confirm"],
  ["key: Alt+F4", { kind: "key", keys: "alt+f4" }, [[]], null, "confirm"],
  ["key: Cmd+Delete is confirm, not always (a chord is not the word)", { kind: "key", keys: "cmd+delete" }, focusedIn(field("report.pdf", "row")), null, "confirm"],
  ["key: Shift+Delete", { kind: "key", keys: "shift+delete" }, focusedIn(field("report.pdf", "row")), null, "confirm"],
  ["key: Delete in a text field", { kind: "key", keys: "delete" }, focusedIn(field("Subject")), null, "free"],
  ["key: Delete on a file in a list", { kind: "key", keys: "delete" }, focusedIn(field("report.pdf", "row")), null, "confirm"],
  ["key: “#” with no text box focused (Gmail deletes)", { kind: "key", keys: "#" }, focusedIn(field("Inbox", "item")), null, "confirm"],
  ["key: “e” with nothing focused", { kind: "key", keys: "e" }, [[]], null, "confirm"],
  ["key: “e” in a text field", { kind: "key", keys: "e" }, focusedIn(field("Message", "area")), null, "free"],
  ["key: Tab with nothing focused", { kind: "key", keys: "tab" }, [[]], null, "free"],
  ["key: Cmd+K with nothing focused", { kind: "key", keys: "cmd+k" }, [[]], null, "free"],
  ["key: Down in a list", { kind: "key", keys: "down" }, focusedIn(field("Inbox", "item")), null, "free"],
  ["type: with no text box focused", { kind: "type", text: "hello" }, focusedIn(field("Inbox", "item")), null, "confirm"],
  ["type: into a combo box", { kind: "type", text: "hello" }, focusedIn(field("To", "combo")), null, "free"],
  ["press: anything in a browser", P, [btn("Export"), { app: { name: "Google Chrome" } }], null, "confirm"],
  ["press: anything in Safari", P, [btn("Next"), { app: { name: "Safari" } }], null, "confirm"],
  ["press: Delete in a browser is still always", P, [btn("Delete account"), { app: { name: "Firefox" } }], null, "always"],
  ["press: in Slack (not a browser)", P, [btn("Export"), { app: { name: "Slack" } }], null, "free"],
  ["press: in Arcade Studio (not Arc)", P, [btn("Export"), { app: { name: "Arcade Studio" } }], null, "free"],
  ["open: the app the run started in", { kind: "open", app: "Slack" }, [[]], { startApp: "Slack" }, "free"],
  ["open: another app", { kind: "open", app: "Mail" }, [[]], { startApp: "Slack" }, "confirm"],
  ["open: “Google Chrome” from a run begun in “Chrome”", { kind: "open", app: "Google Chrome" }, [[]], { startApp: ["Gmail", "Chrome"] }, "free"],
  ["open: with no context, the snapshot's own app", { kind: "open", app: "Notes" }, [[]], null, "free"],
  ["open: Uninstall Tool is another app and a keyword-free name", { kind: "open", app: "Mail" }, [[]], { startApp: [] }, "confirm"],
];
for (const [name, action, [els, extra], ctx, want] of CASES) {
  test(`classifyRisk: ${name} → ${want}`, () => {
    assert.strictEqual(riskOf(action, els, extra, ctx || undefined), want);
  });
}

test("classifyRisk: typing 12+ characters copied from another element is confirm; from its own field is free", () => {
  const composer = field("Message", "area", { value: "Here is the whole draft I wrote earlier" });
  const other = { id: "e2", role: "field", label: "Recovery email", value: "ana.lopez.backup@example.org", frame: [0, 30, 100, 20] };
  const els = [composer, other];
  const ex = { focused: "e1" };
  assert.strictEqual(riskOf({ kind: "type", text: "fyi ana.lopez.backup@exam" }, els, ex, { said: "" }), "confirm");
  assert.strictEqual(riskOf({ kind: "type", text: "Here is the whole draft, shorter" }, els, ex), "free", "a rewrite of its own text");
  assert.strictEqual(riskOf({ kind: "type", text: "lopez.backu" }, els, ex), "free", "eleven characters is not a copy");
  assert.strictEqual(
    riskOf({ kind: "type", text: "fyi ana.lopez.backup@example.org" }, els, ex, { said: "send fyi ana.lopez.backup@example.org" }),
    "free", "what they said is theirs to type",
  );
});

test("classifyRisk: setting text lifted from the window's text asks; a rewrite of the selection does not", () => {
  const els = [field("Notes", "area", { value: "" })];
  const ex = { focused: "e1", text: "Wire instructions: account 0012 3456 7890 sort code 40-11-22", selection: "Please rewrite this whole paragraph shorter" };
  assert.strictEqual(riskOf({ kind: "set", id: "e1", text: "account 0012 3456 7890 sort" }, els, ex), "confirm");
  assert.strictEqual(riskOf({ kind: "type", text: "Please rewrite this whole paragraph shorter and nicer" }, els, ex), "free");
});

test("classifyRisk: a one-time code on screen that was not said is confirm", () => {
  const els = [field("Message", "area"), { id: "e2", role: "text", label: "Your verification code is 482 913" }];
  const ex = { focused: "e1" };
  assert.strictEqual(riskOf({ kind: "type", text: "482913" }, els, ex, { said: "reply with the code" }), "confirm");
  assert.strictEqual(riskOf({ kind: "type", text: "code: 482-913" }, els, ex, { said: "" }), "confirm");
  assert.strictEqual(riskOf({ kind: "type", text: "482913" }, els, ex, { said: "type 482913" }), "free", "they said it");
  assert.strictEqual(riskOf({ kind: "type", text: "meet at 1530" }, els, ex, { said: "" }), "free", "not on screen");
});

test("classifyRisk: an email address on screen that was not said is confirm", () => {
  const els = [field("Message", "area"), { id: "e2", role: "link", label: "Contact ana@acme.com" }];
  const ex = { focused: "e1" };
  assert.strictEqual(riskOf({ kind: "type", text: "write to ANA@acme.com" }, els, ex, { said: "" }), "confirm");
  assert.strictEqual(riskOf({ kind: "type", text: "write to ana@acme.com" }, els, ex, { said: "tell them to write to ana@acme.com" }), "free");
});

test("classifyRisk: no action, or an unknown id, is judged on what there is", () => {
  assert.strictEqual(classifyRisk(null, SLACK), "free");
  assert.strictEqual(classifyRisk({ kind: "press", id: "e404" }, SLACK), "free");
  assert.strictEqual(classifyRisk({ kind: "press", id: "e404", text: "delete" }, SLACK), "always");
});

test("maxRisk only ever goes up, and an unknown risk is a confirm", () => {
  assert.strictEqual(maxRisk("free", "confirm"), "confirm");
  assert.strictEqual(maxRisk("always", "confirm"), "always");
  assert.strictEqual(maxRisk("confirm", "free"), "confirm");
  assert.strictEqual(maxRisk(undefined, "free"), "free");
  assert.strictEqual(maxRisk("free", "free"), "free");
  assert.strictEqual(maxRisk("high", "free"), "confirm");
  assert.strictEqual(maxRisk("high", "always"), "always");
});

// ---- the stream ---------------------------------------------------------------

const enc = new TextEncoder();
function byteStream(chunks, onCancel) {
  return new ReadableStream({
    start(c) { for (const ch of chunks) c.enqueue(typeof ch === "string" ? enc.encode(ch) : ch); c.close(); },
    cancel: onCancel,
  });
}
async function collect(it) { const out = []; for await (const ev of it) out.push(ev); return out; }

const NDJSON = [
  '{"t":"heard","text":"où est l’export ? 🙂","mode":"show"}',
  "",
  "not json at all",
  '{"t":"say","text":"Ici."}\r',
  "[1,2,3]",
  '{"no":"t field"}',
  "   ",
  '{"t":"point","id":"e1","caption":"Export"}',
  '{"t":"done"}',
].join("\n");
const WANT = [
  { t: "heard", text: "où est l’export ? 🙂", mode: "show" },
  { t: "say", text: "Ici." },
  { t: "point", id: "e1", caption: "Export" },
  { t: "done" },
];

test("readEvents: blank and broken lines are skipped; the last line needs no newline", async () => {
  assert.deepStrictEqual(await collect(readEvents(byteStream([NDJSON]))), WANT);
});

test("readEvents: a chunk can end anywhere — mid-line, mid-character — at every byte", async () => {
  const bytes = enc.encode(NDJSON);
  for (let k = 1; k < bytes.length; k++) {
    const got = await collect(readEvents(byteStream([bytes.slice(0, k), bytes.slice(k)])));
    assert.deepStrictEqual(got, WANT, `split at byte ${k}`);
  }
});

test("readEvents: one byte at a time, and odd-sized chunks", async () => {
  const bytes = enc.encode(NDJSON);
  const ones = Array.from(bytes, (b) => Uint8Array.of(b));
  assert.deepStrictEqual(await collect(readEvents(byteStream(ones))), WANT);
  const odd = [];
  for (let i = 0, n = 1; i < bytes.length; i += n, n = (n * 7) % 13 + 1) odd.push(bytes.slice(i, i + n));
  assert.deepStrictEqual(await collect(readEvents(byteStream(odd))), WANT);
});

test("readEvents: stopping early lets the stream go", async () => {
  // An open stream, as a live connection is: one more line every time it is read.
  let cancelled = false;
  const live = new ReadableStream({
    pull(c) { c.enqueue(enc.encode('{"t":"heard","text":"x","mode":"do"}\n')); },
    cancel() { cancelled = true; },
  });
  const it = readEvents(live);
  for await (const ev of it) { assert.strictEqual(ev.t, "heard"); break; }
  await sleep(0);
  assert.strictEqual(cancelled, true);
});

test("readEvents: an async iterable body works too, and no body is no events", async () => {
  async function* chunks() { yield enc.encode('{"t":"say","te'); yield 'xt":"hi"}\n{"t":"do'; yield enc.encode('ne"}'); }
  assert.deepStrictEqual(await collect(readEvents(chunks())), [{ t: "say", text: "hi" }, { t: "done" }]);
  assert.deepStrictEqual(await collect(readEvents(null)), []);
});

test("readEvents: an error from the stream reaches the reader", async () => {
  let pulls = 0;
  const broken = new ReadableStream({
    pull(c) {
      if (pulls++ === 0) c.enqueue(enc.encode('{"t":"say","text":"a"}\n'));
      else c.error(new Error("reset"));
    },
  });
  const got = [];
  await assert.rejects(async () => { for await (const ev of readEvents(broken)) got.push(ev); }, /reset/);
  assert.deepStrictEqual(got, [{ t: "say", text: "a" }]);
});

// ---- makePost -----------------------------------------------------------------

function fakeFetch(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return typeof r === "function" ? r(url, init) : r;
  };
  fetch.calls = calls;
  return fetch;
}
const ndjson = (events, status = 200) => () => new Response(byteStream([events.map((e) => JSON.stringify(e)).join("\n") + "\n"]), {
  status, headers: { "content-type": "application/x-ndjson" },
});
const jsonError = (status, body) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const REQ = { runId: "abc123def", step: 0, platform: "mac", app: "Slack", screen: { elements: [] }, utterance: "hi" };

test("makePost: JSON without audio, with the bearer token", async () => {
  const fetch = fakeFetch([ndjson([{ t: "heard", text: "hi", mode: "show" }, { t: "done" }])]);
  const tokens = [];
  const post = makePost({ baseUrl: "https://api.tailzu.space/", token: async (renew) => { tokens.push(renew); return "t1"; }, fetch });
  const ac = new AbortController();
  const events = await collect(post(REQ, null, ac.signal));
  assert.deepStrictEqual(events, [{ t: "heard", text: "hi", mode: "show" }, { t: "done" }]);
  const [{ url, init }] = fetch.calls;
  assert.strictEqual(url, "https://api.tailzu.space/v1/agent");
  assert.strictEqual(init.method, "POST");
  assert.strictEqual(init.signal, ac.signal);
  assert.strictEqual(init.headers.Authorization, "Bearer t1");
  assert.strictEqual(init.headers["Content-Type"], "application/json");
  assert.deepStrictEqual(JSON.parse(init.body), REQ);
  assert.deepStrictEqual(tokens, [false]);
});

test("makePost: multipart with audio — the request field first, then the recording", async () => {
  const fetch = fakeFetch([ndjson([{ t: "done" }])]);
  const post = makePost({ baseUrl: () => "http://127.0.0.1:8787", token: async () => "t1", fetch });
  await collect(post(REQ, AUDIO, undefined));
  const { url, init } = fetch.calls[0];
  assert.strictEqual(url, "http://127.0.0.1:8787/v1/agent");
  assert.ok(init.body instanceof FormData);
  assert.strictEqual(init.headers["Content-Type"], undefined, "fetch sets the multipart boundary itself");
  assert.deepStrictEqual([...init.body.keys()], ["request", "audio"]);
  assert.deepStrictEqual(JSON.parse(init.body.get("request")), REQ);
  const file = init.body.get("audio");
  assert.ok(file instanceof Blob);
  assert.strictEqual(file.type, "audio/webm");
  assert.strictEqual(file.name, "ask.webm");
  assert.strictEqual(Buffer.from(await file.arrayBuffer()).toString(), "not really opus");
});

test("makePost: the recording is named by its container, not its codec", async () => {
  const cases = [
    // What the recorder actually reports: Opus in WebM is a .webm.
    [{ mime: "audio/webm;codecs=opus", data: Buffer.from("x") }, "ask.webm", "audio/webm"],
    [{ mime: "audio/ogg;codecs=opus", data: Buffer.from("x") }, "ask.ogg", "audio/ogg"],
    [{ mime: "audio/opus", data: Buffer.from("x") }, "ask.ogg", "audio/ogg"],
    [{ mime: "audio/wav", data: Buffer.from("x") }, "ask.wav", "audio/wav"],
    [{ mime: "audio/mp4", data: Buffer.from("x") }, "ask.m4a", "audio/mp4"],
    [{ mime: "", data: Buffer.from("x") }, "ask.webm", "audio/webm"],
    // A Blob with no mime beside it goes by its own type.
    [{ data: new Blob(["x"], { type: "audio/webm;codecs=opus" }) }, "ask.webm", "audio/webm"],
    [{ data: new Blob(["x"], { type: "audio/ogg" }) }, "ask.ogg", "audio/ogg"],
  ];
  for (const [audio, name, type] of cases) {
    const fetch = fakeFetch([ndjson([{ t: "done" }])]);
    const post = makePost({ baseUrl: "http://127.0.0.1:8787", token: async () => "t1", fetch });
    await collect(post(REQ, audio, undefined));
    const file = fetch.calls[0].init.body.get("audio");
    assert.strictEqual(file.name, name, audio.mime || "blob " + audio.data.type);
    assert.strictEqual(file.type, type, audio.mime || "blob " + audio.data.type);
    assert.strictEqual(Buffer.from(await file.arrayBuffer()).toString(), "x");
  }
});

test("makePost: a 401 renews the token once and sends the step again", async () => {
  const fetch = fakeFetch([jsonError(401, { code: "unauthorized", message: "Missing or invalid token" }), ndjson([{ t: "done", text: "ok" }])]);
  const tokens = [];
  const post = makePost({ baseUrl: "https://x", token: async (renew) => { tokens.push(renew); return renew ? "fresh" : "stale"; }, fetch });
  const events = await collect(post(REQ, AUDIO, undefined));
  assert.deepStrictEqual(events, [{ t: "done", text: "ok" }]);
  assert.deepStrictEqual(tokens, [false, true]);
  assert.deepStrictEqual(fetch.calls.map((c) => c.init.headers.Authorization), ["Bearer stale", "Bearer fresh"]);
  assert.ok(fetch.calls[1].init.body instanceof FormData, "the body is built again for the retry");
});

test("makePost: a 401 that survives the renewal is one error event, in words for a person", async () => {
  const fetch = fakeFetch([jsonError(401, { code: "unauthorized", message: "Missing or invalid token" })]);
  const post = makePost({ baseUrl: "https://x", token: async () => "t", fetch });
  assert.deepStrictEqual(await collect(post(REQ, null)), [{ t: "error", code: "unauthorized", message: TEXT.signIn }]);
  assert.strictEqual(fetch.calls.length, 2);
});

test("makePost: no token to renew means no retry", async () => {
  const fetch = fakeFetch([jsonError(401, { code: "unauthorized" })]);
  const post = makePost({ baseUrl: "https://x", token: async (renew) => (renew ? null : "t"), fetch });
  const events = await collect(post(REQ, null));
  assert.strictEqual(events.length, 1);
  assert.strictEqual(fetch.calls.length, 1);
});

test("makePost: other refusals become one error event with the server's code and message", async () => {
  const post429 = makePost({ baseUrl: "https://x", token: async () => "t", fetch: fakeFetch([jsonError(429, { code: "quota_exceeded", message: "Daily limit reached." })]) });
  assert.deepStrictEqual(await collect(post429(REQ, null)), [{ t: "error", code: "quota_exceeded", message: "Daily limit reached." }]);
  const post500 = makePost({ baseUrl: "https://x", token: async () => "t", fetch: fakeFetch([() => new Response("<html>bad gateway</html>", { status: 502 })]) });
  assert.deepStrictEqual(await collect(post500(REQ, null)), [{ t: "error", code: "http_502", message: TEXT.failed }]);
  const post413 = makePost({ baseUrl: "https://x", token: async () => "t", fetch: fakeFetch([jsonError(413, { code: "bad_request" })]) });
  assert.strictEqual((await collect(post413(REQ, null)))[0].message, "There's too much on this screen to read.");
});

test("makePost: no network is an error event; an aborted request ends quietly", async () => {
  const down = makePost({ baseUrl: "https://x", token: async () => "t", fetch: async () => { throw new TypeError("fetch failed"); } });
  assert.deepStrictEqual(await collect(down(REQ, null)), [{ t: "error", code: "network", message: TEXT.network }]);
  const ac = new AbortController();
  ac.abort();
  const aborted = makePost({ baseUrl: "https://x", token: async () => "t", fetch: async () => { throw new DOMException("aborted", "AbortError"); } });
  assert.deepStrictEqual(await collect(aborted(REQ, null, ac.signal)), []);
});

test("makePost: a token function that fails sends no Authorization at all", async () => {
  const fetch = fakeFetch([ndjson([{ t: "done" }])]);
  const post = makePost({ baseUrl: "https://x", token: async () => { throw new Error("keychain"); }, fetch });
  await collect(post(REQ, null));
  assert.strictEqual(fetch.calls[0].init.headers.Authorization, undefined);
});

test("a whole run over makePost and a streamed body", async () => {
  const body = [
    '{"t":"heard","text":"where\'s export?","mode":"show"}\n{"t":"say","te',
    'xt":"Top right."}\n{"t":"point","id":"e1"}\n',
    '{"t":"done"}\n',
  ];
  const fetch = fakeFetch([() => new Response(byteStream(body), { status: 200 })]);
  const guide = fakeGuide(true);
  const agent = createAgent({
    driver: fakeDriver([SLACK]), guide, platform: "mac",
    knob: (n, f) => (n === "desktop.agent.doneMs" ? 1 : f),
    post: makePost({ baseUrl: "https://x", token: async () => "t", fetch }),
  });
  agent.begin({ app: "Slack" });
  await agent.heard(AUDIO);
  assert.deepStrictEqual(guide.of("say"), [["say", "Top right.", { speak: true, rate: 1.04 }]]);
  assert.deepStrictEqual(guide.of("point"), [["point", [700, 20, 80, 30]]]);
  assert.deepStrictEqual(guide.of("state").at(-1), ["state", "done"]);
  assert.ok(fetch.calls[0].init.body instanceof FormData);
});

// ---- v2: the look, the instant answer, the picture ------------------------------

/** A look at the Slack window: two lines of its text (one the Export button's
 *  own label, read again) and its picture. */
function lookOf(lines, extra) {
  return Object.assign({
    ok: true, window: { frame: WIN, title: "design | Slack" }, scale: "points",
    lines, image: { mime: "image/jpeg", data: Buffer.from("the whole window").toString("base64"), width: 900, height: 600 }, ms: 120,
  }, extra);
}
const L_EXPORT = { text: "Export", frame: [702, 22, 70, 24], conf: 0.9 };            // over the Export button
const L_REVENUE = { text: "Quarterly revenue", frame: [300, 200, 200, 20], conf: 0.95 }; // centre
const L_EQUATION = { text: "x² + 2x + 1 = 0", frame: [300, 300, 160, 24], conf: 0.8 };
const LOOK = lookOf([L_EXPORT, L_REVENUE, L_EQUATION]);
const CROPPED = { mime: "image/jpeg", data: Buffer.from("just the picture") };

test("begin reads the tree and looks at the window at once; the look's lines join as o elements", async () => {
  const r = rig({ look: LOOK, scripts: [[heardShow("what's the revenue?"), { t: "done" }]] });
  r.agent.begin({ app: "Slack" });
  await sleep(1);
  // Both reads are asked for at Alt twice, before a word has been heard.
  assert.deepStrictEqual(r.driver.calls.map((c) => c[0]).sort(), ["look", "snapshot"]);
  const lookOpts = r.driver.calls.find((c) => c[0] === "look")[1];
  assert.deepStrictEqual(lookOpts, { budgetMs: 1500, timeoutMs: 2500, ocr: true, image: false }, "no picture is asked for without a way to send one");
  await r.agent.heard(AUDIO);
  const [req] = r.post.reqs();
  assert.deepStrictEqual(req.screen.elements.slice(4), [
    { id: "o1", role: "text", label: "Quarterly revenue", region: "c" },
    { id: "o2", role: "text", label: "x² + 2x + 1 = 0", region: "c" },
  ], "after the tree; the line that only repeats the button's label is left out");
  assert.ok(!JSON.stringify(req).includes("frame"));
  assert.ok(!JSON.stringify(req).includes("design | Slack"), "the window's title never goes");
});

test("ocrElements: nothing over a password field or an address bar, and never the window's title", () => {
  const s = snap([
    { id: "e1", role: "field", label: "Password", secure: true, frame: [100, 100, 200, 30] },
    { id: "e2", role: "field", label: "Address and search bar", frame: [100, 40, 600, 30] },
    { id: "e3", role: "button", label: "Sign in", frame: [100, 150, 80, 30] },
  ], { window: { frame: WIN, title: "Q3 layoffs — draft" } });
  const look = lookOf([
    { text: "hunter2", frame: [110, 105, 60, 20] },                                  // the password, shown
    { text: "mail.google.com/mail/u/0/#inbox/FMfcgzQXJ", frame: [120, 45, 400, 20] }, // the URL
    { text: "Q3 layoffs — draft", frame: [300, 5, 200, 16] },                        // the title bar
    { text: "Q3 layoffs", frame: [300, 60, 100, 16] },                               // a cut-short title
    { text: "SIGN  IN", frame: [105, 155, 60, 20] },                                 // the button, again
    { text: "Sign in", frame: [500, 500, 60, 20] },                                  // the same words elsewhere
    { text: "Forgot it?", frame: [100, 200, 80, 20] },
    { text: "   ", frame: [100, 230, 80, 20] },
    { text: "no frame" },
  ], { window: { frame: WIN, title: "Q3 layoffs — draft" } });
  assert.deepStrictEqual(ocrElements(s, look), [
    { id: "o1", role: "text", label: "Sign in", frame: [500, 500, 60, 20], ocr: true },
    { id: "o2", role: "text", label: "Forgot it?", frame: [100, 200, 80, 20], ocr: true },
  ]);
  assert.deepStrictEqual(ocrElements(s, { ok: false, error: "timeout" }), []);

  // The title as OCR reads it: cut short with three dots, or run together
  // with the toolbar beside it.
  const titled = snap([], { window: { frame: WIN, title: "Q3 budget.xlsx - Excel" } });
  const bar = lookOf([
    { text: "Q3 budget.xls...", frame: [300, 5, 120, 16] },
    { text: "AutoSave Off Q3 budget.xlsx - Excel Search", frame: [0, 5, 900, 16] },
    { text: "Excel", frame: [10, 40, 40, 16] },                                      // too short to say
    { text: "Revenue", frame: [10, 80, 60, 16] },
  ], { window: { frame: WIN, title: "Q3 budget.xlsx - Excel" } });
  assert.deepStrictEqual(ocrElements(titled, bar).map((e) => e.label), ["Excel", "Revenue"]);

  // The title as OCR reads its dash: a hyphen for an em dash is still the title.
  const dashed = snap([], { window: { frame: WIN, title: "Q3 layoffs — draft.docx - Word" } });
  const read = lookOf([
    { text: "Q3 layoffs - draft.docx - Word", frame: [300, 4, 300, 20] },
    { text: "Revenue", frame: [10, 80, 60, 16] },
  ], { window: { frame: WIN, title: "Q3 layoffs — draft.docx - Word" } });
  assert.deepStrictEqual(ocrElements(dashed, read).map((e) => e.label), ["Revenue"]);
});

test("ocrElements: a control's label read nearly as it is (a letter misread, its ellipsis as dots, a mark beside it) is that label read again", () => {
  const { match } = require("./resolver.js");
  for (const [label, text] of [["Export", "Exp0rt"], ["Export…", "Export..."], ["Export", "Export ▾"], ["Name", "Name:"], ["Share", "↑ Share"]]) {
    const s = snap([{ id: "e1", role: "button", label, frame: [700, 20, 80, 30] }]);
    const lines = ocrElements(s, lookOf([{ text, frame: [705, 25, 70, 20] }]));
    assert.deepStrictEqual(lines, [], text);
    // …so a question that names it names one thing, not two that tie.
    const m = match(`where's the ${label.replace(/[…:]/g, "")}?`, s.elements.concat(lines));
    assert.strictEqual(m && m.id, "e1", text);
  }
  // Other words over it, or the same word somewhere else, are still lines.
  const s = snap([{ id: "e1", role: "button", label: "Export", frame: [700, 20, 80, 30] }]);
  const lines = ocrElements(s, lookOf([{ text: "Export to PDF and send", frame: [705, 25, 70, 20] }, { text: "Exp0rt", frame: [100, 300, 60, 20] }]));
  assert.deepStrictEqual(lines.map((e) => e.label), ["Export to PDF and send", "Exp0rt"]);
});

test("toRequestElements: a line goes as text with its words and region only, and its URL loses its query", () => {
  const s = snap([
    EXPORT,
    { id: "o1", role: "button", label: "Reset at https://x.test/r?token=abc#f", frame: [100, 100, 300, 20], ocr: true, value: "v", focused: true },
    { id: "o2", role: "text", label: "made up", frame: [100, 130, 300, 20] },   // an o id on a tree element
    { id: "e9", role: "text", label: "not a line", frame: [100, 160, 300, 20], ocr: true },
  ]);
  assert.deepStrictEqual(toRequestElements(s), [
    { id: "e1", role: "button", label: "Export", region: "tr" },
    { id: "o1", role: "text", label: "Reset at https://x.test/r", region: "tl" },
  ]);
  // An address as a browser draws it, with no scheme, loses its query and
  // fragment too; a sentence that ends in a question mark keeps it.
  const drawn = snap([
    { id: "o1", role: "text", label: "mail.google.com/mail/u/0/#inbox/FMfcgzQXJ", frame: [100, 40, 400, 20], ocr: true },
    { id: "o2", role: "text", label: "Open accounts.example.co.uk/reset?token=s3cr3t now", frame: [100, 70, 400, 20], ocr: true },
    { id: "o3", role: "text", label: "Is it on example.com?", frame: [100, 100, 400, 20], ocr: true },
  ]);
  assert.deepStrictEqual(toRequestElements(drawn).map((e) => e.label), [
    "mail.google.com/mail/u/0/", "Open accounts.example.co.uk/reset now", "Is it on example.com?",
  ]);
});

test("driver.js with no driver for the platform has every call the two drivers have, look included, each unsupported", async () => {
  const stub = require("./driver.js").pick("linux");
  for (const k of Object.keys(require("./axDriver.js"))) assert.strictEqual(typeof stub[k], "function", k);
  assert.deepStrictEqual(await stub.look({ ocr: true }), { ok: false, error: "unsupported" });
  // …which a run takes as no look at all, not as a failed one.
  const r = rig({ scripts: [[heardShow("hi"), { t: "done" }]] });
  r.driver.look = stub.look;
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO);
  assert.strictEqual(r.post.reqs().length, 1);
  assert.ok(!r.logs.some((l) => /no look/.test(l)));
});

test("the look knob off, or a driver with no look, reads the tree alone", async () => {
  const off = rig({ look: LOOK, knobs: { "desktop.agent.look": false }, scripts: [[heardShow("hi"), { t: "done" }]] });
  off.agent.begin({ app: "Slack" });
  await off.agent.heard(AUDIO);
  assert.ok(!off.driver.calls.some((c) => c[0] === "look"));
  assert.strictEqual(off.post.reqs()[0].screen.elements.length, 4);
  assert.ok(!off.logs.some((l) => /no look/.test(l)), "a look not taken is not a failure");
});

test("a look that fails, or never answers, is given up on: the run asks with the tree", async () => {
  const failed = rig({ look: { ok: false, error: "no_screen_permission" }, scripts: [[heardShow("hi"), { t: "done" }]] });
  failed.agent.begin({ app: "Slack" });
  await failed.agent.heard(AUDIO);
  assert.strictEqual(failed.post.reqs()[0].screen.elements.length, 4);
  assert.ok(failed.logs.some((l) => /no look \(no_screen_permission\)/.test(l)));

  const hung = rig({ look: () => never(), knobs: { "desktop.agent.lookTimeoutMs": 30 }, scripts: [[heardShow("hi"), { t: "done" }]] });
  hung.agent.begin({ app: "Slack" });
  const t0 = Date.now();
  await hung.agent.heard(AUDIO);
  assert.strictEqual(hung.post.requests.length, 1);
  assert.ok(Date.now() - t0 < 1500, "within the look's own timeout and a little");
  assert.ok(hung.logs.some((l) => /no look \(timeout\)/.test(l)));
});

test("a look of a window with the same frame but another title is another window: not used", async () => {
  // Two maximized windows share a frame; the titles tell them apart.
  const titled = snap([EXPORT, COMPOSER, SEND, HEADING], { focused: "e2", window: { frame: WIN, title: "design | Slack" } });
  const other = lookOf([L_REVENUE], { window: { frame: WIN, title: "Budget - Excel" } });
  const r = rig({
    snaps: [titled], look: other, crop: () => CROPPED, pictures: () => "always",
    scripts: [[heardShow("explain this equation"), { t: "done" }]],
  });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO, { text: "explain this equation", final: true });
  const [{ req, image }] = r.post.requests;
  assert.strictEqual(req.screen.elements.length, 4);
  assert.strictEqual(image, null);
  assert.ok(r.logs.some((l) => /another window/.test(l)));

  // The same title, one read of it cut short: the same window.
  const cut = lookOf([L_REVENUE], { window: { frame: WIN, title: "design | Sla" } });
  const same = rig({ snaps: [titled], look: cut, scripts: [[heardShow("hi"), { t: "done" }]] });
  same.agent.begin({ app: "Slack" });
  await same.agent.heard(AUDIO);
  assert.strictEqual(same.post.reqs()[0].screen.elements.length, 5);
});

test("a look of another window than the tree's is not used: no lines, no picture", async () => {
  const other = lookOf([L_REVENUE], { window: { frame: [1000, 0, 500, 400], title: "Notes" } });
  const r = rig({
    look: other, crop: () => CROPPED, pictures: () => "always",
    scripts: [[heardShow("explain this equation"), { t: "done" }]],
  });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO, { text: "explain this equation", final: true });
  const [{ req, image }] = r.post.requests;
  assert.strictEqual(req.screen.elements.length, 4);
  assert.strictEqual(image, null);
  assert.ok(r.logs.some((l) => /another window/.test(l)));
});

test("no tree, but a look: its lines are the screen, and can be pointed at instantly", async () => {
  const r = rig({ snaps: [{ ok: false, error: "timeout" }], look: lookOf([L_REVENUE]) });
  r.agent.begin({ app: "Figma" });
  await r.agent.heard(AUDIO, { text: "where's quarterly revenue?", final: true });
  assert.strictEqual(r.post.requests.length, 0);
  assert.deepStrictEqual(r.guide.of("point"), [["point", [300, 200, 200, 20], "Quarterly revenue"]]);
  assert.ok(r.logs.some((l) => /tree not read; using the text read off the window/.test(l)));
});

test("a private or sensitive window's look ends the run: nothing is sent, nothing pointed at, even instantly", async () => {
  for (const [title, text] of [["New Incognito Tab - Google Chrome", TEXT.blockedPrivate], ["Chase Online - Accounts", TEXT.blocked]]) {
    const r = rig({ look: lookOf([L_REVENUE], { window: { frame: WIN, title } }), crop: () => CROPPED, pictures: () => "always" });
    r.agent.begin({ app: "Slack" });
    await r.agent.heard(AUDIO, { text: "where's export?", final: true });
    assert.strictEqual(r.post.requests.length, 0, title);
    assert.deepStrictEqual(r.guide.of("point"), [], title);
    assert.deepStrictEqual(r.guide.of("say"), [], title);
    assert.deepStrictEqual(r.guide.of("state").at(-1), ["state", "done", text], title);
  }
});

// ---- the instant answer --------------------------------------------------------

test("instant: a clear “where's X?” in the caption is answered here — ring, words, done, no request", async () => {
  const r = rig({ look: LOOK });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO, { text: "Hey Tailzu, where's export?", final: true });
  assert.strictEqual(r.post.requests.length, 0, "no /v1/agent call at all");
  assert.deepStrictEqual(r.guide.of("heard"), [["heard", "Hey Tailzu, where's export?"]]);
  assert.deepStrictEqual(r.guide.of("say"), [["say", "Here's Export.", { speak: true, rate: 1.04 }]]);
  assert.deepStrictEqual(r.guide.of("point"), [["point", [700, 20, 80, 30], "Export"]]);
  assert.deepStrictEqual(r.guide.of("state").at(-1), ["state", "done"]);
  assert.deepStrictEqual(r.driver.acts(), []);
  assert.strictEqual(r.agent.active(), false);
  assert.ok(r.logs.some((l) => /: instant \(e1, score 1\.00/.test(l)));
  assert.ok(!r.logs.join("\n").includes("Export"), "the log carries ids, not the screen's words");
});

test("instant: a line read off the window is pointed at the same way", async () => {
  const r = rig({ look: LOOK });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO, { text: "where is quarterly revenue", final: true });
  assert.strictEqual(r.post.requests.length, 0);
  assert.deepStrictEqual(r.guide.of("say"), [["say", "Here's Quarterly revenue.", { speak: true, rate: 1.04 }]]);
  assert.deepStrictEqual(r.guide.of("point"), [["point", [300, 200, 200, 20], "Quarterly revenue"]]);
});

test("not instant — an order, no clear match, the knob off — goes the text way, with the caption's words as JSON", async () => {
  const cases = [
    ["click export", {}],
    ["where's save", { snaps: [snap([{ id: "e1", role: "button", label: "Save", frame: [0, 0, 50, 20] }, { id: "e2", role: "button", label: "Save", frame: [100, 0, 50, 20] }])] }],
    ["where's export", { knobs: { "desktop.agent.instant": false } }],
    ["turn on captions", {}],
  ];
  for (const [text, o] of cases) {
    const r = rig(Object.assign({ scripts: [[heardDo(text), { t: "done" }]] }, o));
    r.agent.begin({ app: "Slack" });
    await r.agent.heard(AUDIO, { text, final: true });
    assert.strictEqual(r.post.requests.length, 1, text);
    const [{ req, audio, image }] = r.post.requests;
    assert.strictEqual(audio, null, text);
    assert.strictEqual(image, null, text);
    assert.strictEqual(req.utterance, text, text);
    assert.strictEqual(req.picture, undefined, text);
  }
});

test("useStreamText off: the recording goes, as before; with no recording the words still do", async () => {
  const r = rig({ knobs: { "desktop.agent.useStreamText": false }, scripts: [[heardDo("turn on captions"), { t: "done" }]] });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO, { text: "turn on captions", final: true });
  assert.strictEqual(r.post.requests[0].audio, AUDIO);
  assert.strictEqual(r.post.reqs()[0].utterance, undefined);

  const words = rig({ knobs: { "desktop.agent.useStreamText": false }, scripts: [[heardDo("turn on captions"), { t: "done" }]] });
  words.agent.begin({ app: "Slack" });
  await words.agent.heard(null, { text: "turn on captions", final: true });
  assert.strictEqual(words.post.requests[0].audio, null);
  assert.strictEqual(words.post.reqs()[0].utterance, "turn on captions");
});

test("heard with no recording and no words ends quietly; the v1 call (audio only) works as it did", async () => {
  const r = rig();
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(null, { text: "  ", final: true });
  assert.strictEqual(r.post.requests.length, 0);
  assert.strictEqual(r.agent.active(), false);

  const v1 = rig({ look: LOOK, scripts: [[heardShow("where's export?"), { t: "done" }]] });
  v1.agent.begin({ app: "Slack" });
  await v1.agent.heard(AUDIO);
  assert.strictEqual(v1.post.requests[0].audio, AUDIO, "with no words, the recording is the words");
});

// ---- preview ----------------------------------------------------------------------

test("preview: a tentative ring as soon as the words name one thing, moved when they change, gone when they stop", async () => {
  const r = rig({ look: LOOK, scripts: [[heardDo("click send"), { t: "done" }]] });
  r.agent.begin({ app: "Slack" });
  await sleep(1);   // the reads begun at Alt twice have come back
  r.agent.preview("where's");
  r.agent.preview("where's exp");
  assert.deepStrictEqual(r.guide.of("point"), [], "half a word names nothing");
  r.agent.preview("where's export");
  r.agent.preview("where's export");
  r.agent.preview("Where's Export?");
  assert.deepStrictEqual(r.guide.of("point"), [["point", [700, 20, 80, 30], "Export", { tentative: true }]], "drawn once while the target stays");
  r.agent.preview("where's export as");
  assert.strictEqual(r.guide.of("unpoint").length, 1);
  r.agent.preview("where's quarterly revenue");
  r.agent.preview("click send");
  assert.deepStrictEqual(r.guide.of("point").slice(1), [
    ["point", [300, 200, 200, 20], "Quarterly revenue", { tentative: true }],
    ["point", [720, 520, 60, 40], "Send", { tentative: true }],
  ]);
  assert.strictEqual(r.guide.of("unpoint").length, 1, "moved, not put away and drawn again");
  assert.deepStrictEqual(r.driver.acts(), [], "never acts");
  assert.strictEqual(r.post.requests.length, 0, "never asks");

  // "click send" is an order: the text way. Its ring stood in for an answer
  // that came without one, so it goes when the answer is in.
  await r.agent.heard(AUDIO, { text: "click send", final: true });
  assert.strictEqual(r.post.requests.length, 1);
  assert.strictEqual(r.guide.of("unpoint").length, 2);
  r.agent.preview("where's export");
  assert.strictEqual(r.guide.of("point").length, 3, "nothing once the run has begun");
});

test("preview draws nothing before the tree is read, on a private screen, or with the instant knob off", async () => {
  let release;
  const late = new Promise((res) => { release = res; });
  const r = rig({ snaps: [() => late.then(() => SLACK)] });
  r.agent.begin({ app: "Slack" });
  r.agent.preview("where's export");
  assert.deepStrictEqual(r.guide.of("point"), []);
  release();
  await sleep(1);
  r.agent.preview("where's export");
  assert.strictEqual(r.guide.of("point").length, 1);
  r.agent.cancel("test");

  const priv = rig({ snaps: [snap([EXPORT], { window: { frame: WIN, title: "Private Browsing - Safari" } })] });
  priv.agent.begin({ app: "Safari" });
  await sleep(1);
  priv.agent.preview("where's export");
  assert.deepStrictEqual(priv.guide.of("point"), []);
  priv.agent.cancel("test");

  const privLook = rig({ look: lookOf([], { window: { frame: WIN, title: "InPrivate - Edge" } }) });
  privLook.agent.begin({ app: "Edge" });
  await sleep(1);
  privLook.agent.preview("where's export");
  assert.deepStrictEqual(privLook.guide.of("point"), [], "a private window's look rules out its tree too");
  privLook.agent.cancel("test");

  const off = rig({ knobs: { "desktop.agent.instant": false } });
  off.agent.begin({ app: "Slack" });
  await sleep(1);
  off.agent.preview("where's export");
  assert.deepStrictEqual(off.guide.of("point"), []);
  off.agent.cancel("test");
});

test("a ring preview drew off the tree goes when the look then shows a private window", async () => {
  let release;
  const late = new Promise((res) => { release = res; });
  const r = rig({ look: () => late.then(() => lookOf([], { window: { frame: WIN, title: "InPrivate - Microsoft Edge" } })) });
  r.agent.begin({ app: "Edge" });
  await sleep(1);
  r.agent.preview("where's export");
  assert.strictEqual(r.guide.of("point").length, 1, "the tree alone said where");
  release();
  await r.agent.heard(AUDIO, { text: "where's export", final: true });
  assert.strictEqual(r.post.requests.length, 0);
  assert.strictEqual(r.guide.of("point").length, 1, "not answered instantly either");
  assert.strictEqual(r.guide.of("unpoint").length, 1);
  assert.deepStrictEqual(r.guide.of("state").at(-1), ["state", "done", TEXT.blockedPrivate]);
});

test("a tentative ring does not outlive a request that failed", async () => {
  const r = rig({ look: LOOK });
  // Its own agent over the rig's driver and guide, with a post that throws.
  const agent = createAgent({
    driver: r.driver, guide: r.guide, knob: (_n, f) => (_n === "desktop.agent.doneMs" ? 1 : f), platform: "mac",
    post: () => { throw new Error("offline"); },
  });
  agent.begin({ app: "Slack" });
  await sleep(1);
  agent.preview("click send");
  assert.strictEqual(r.guide.of("point").length, 1);
  await agent.heard(AUDIO, { text: "click send", final: true });
  assert.strictEqual(r.guide.of("unpoint").length, 1);
  assert.strictEqual(r.guide.of("error").at(-1)[1], TEXT.network);
});

test("preview with no run, or a cancelled one, does nothing", () => {
  const r = rig();
  r.agent.preview("where's export");
  r.agent.begin({ app: "Slack" });
  r.agent.cancel("esc");
  r.agent.preview("where's export");
  assert.deepStrictEqual(r.guide.of("point"), []);
});

// ---- the picture ------------------------------------------------------------------

const CHART = { id: "e5", role: "image", label: "", frame: [250, 150, 400, 300] };       // under the pointer
const AVATAR = { id: "e6", role: "image", label: "Sam", frame: [20, 520, 32, 32] };
const PICTURED = snap([EXPORT, COMPOSER, SEND, HEADING, CHART, AVATAR], { focused: "e2" });

function pictureRig(o = {}) {
  const crops = [];
  const permits = [];
  const policies = [];
  const r = rig(Object.assign({
    snaps: [PICTURED],
    look: lookOf([L_REVENUE, L_EQUATION]),
    crop: (look, frame) => { crops.push([look, frame]); return CROPPED; },
    pictures: (app) => { policies.push(app); return "ask"; },
    permit: async (app) => { permits.push(app); return "once"; },
    scripts: [[
      heardShow("explain this equation"),
      { t: "say", text: "It's a quadratic." },
      { t: "say", text: "It factors as (x + 1)².", append: true },
      { t: "done" },
    ]],
  }, o));
  return Object.assign(r, { crops, permits, policies });
}

test("picture: a question about a drawing sends ONE crop of the image under the pointer, with permission, said as it comes", async () => {
  const r = pictureRig();
  r.agent.begin({ app: "Slack", pointer: { x: 400, y: 310 } });
  await sleep(1);
  const lookOpts = r.driver.calls.find((c) => c[0] === "look")[1];
  assert.strictEqual(lookOpts.image, true, "the picture is taken at Alt twice, when there is a way to send it");
  assert.strictEqual(lookOpts.maxSide, 4096, "at the screen's own size, for the crop to cut from");
  await r.agent.heard(AUDIO, { text: "explain this equation", final: true });

  assert.deepStrictEqual(r.policies, ["Slack", "Slack"], "at Alt twice, for the look; and again before the picture goes");
  assert.deepStrictEqual(r.permits, ["Slack"]);
  assert.strictEqual(r.crops.length, 1);
  assert.strictEqual(r.crops[0][0].image.data, LOOK.image.data, "the look itself, picture and window");
  assert.deepStrictEqual(r.crops[0][1], [250, 150, 400, 300]);

  assert.strictEqual(r.post.requests.length, 1);
  const [{ req, audio, image }] = r.post.requests;
  assert.strictEqual(audio, null, "the words go, not the recording");
  assert.deepStrictEqual(image, { mime: "image/jpeg", data: CROPPED.data });
  assert.strictEqual(req.utterance, "explain this equation");
  assert.deepStrictEqual(req.picture, { region: "element" });
  assert.ok(!JSON.stringify(req).includes("250"), "where the picture is stays here");

  assert.deepStrictEqual(r.guide.of("point")[0], ["point", [250, 150, 400, 300], "Looking", { tentative: true }]);
  assert.deepStrictEqual(r.guide.of("badge"), [["badge", "1 picture sent"]]);
  assert.deepStrictEqual(r.guide.of("say"), [
    ["say", "It's a quadratic.", { speak: true, rate: 1.04 }],
    ["say", "It factors as (x + 1)².", { speak: true, rate: 1.04, append: true }],
  ]);
  assert.strictEqual(r.guide.of("unpoint").length, 1, "the Looking ring goes with the answer");
  assert.deepStrictEqual(r.guide.of("state").at(-1), ["state", "done"]);
});

test("picture: the card asks with what would go already ringed, and is told which part it is; a no takes the ring away before the words go", async () => {
  let r = null;
  let atCard = null;
  let unpointsAtPost = -1;
  r = pictureRig({
    permit: async (app, o) => { atCard = [r.guide.of("point").at(-1), o]; return "no"; },
    scripts: [() => { unpointsAtPost = r.guide.of("unpoint").length; return [heardShow("explain this equation"), { t: "done" }]; }],
  });
  r.agent.begin({ app: "Slack", pointer: { x: 400, y: 310 } });
  await r.agent.heard(AUDIO, { text: "explain this equation", final: true });
  assert.deepStrictEqual(atCard, [["point", [250, 150, 400, 300], "Looking", { tentative: true }], { region: "element" }]);
  assert.strictEqual(unpointsAtPost, 1, "nothing stays ringed as if it were going");
  assert.strictEqual(r.post.requests[0].image, null);

  // A yes: the ring that was up is the picture's, drawn once; the whole
  // window, when that is what goes, is said to be.
  let yes = null;
  let told = null;
  yes = pictureRig({ snaps: [SLACK], permit: async (app, o) => { told = o; return "once"; } });
  yes.agent.begin({ app: "Slack", pointer: { x: 5, y: 5 } });
  await yes.agent.heard(AUDIO, { text: "what's this?", final: true });
  assert.deepStrictEqual(told, { region: "window" });
  assert.deepStrictEqual(yes.guide.of("point"), [["point", WIN, "Looking", { tentative: true }]]);
  assert.deepStrictEqual(yes.guide.of("badge"), [["badge", "1 picture sent"]]);
  assert.ok(yes.post.requests[0].image);
});

test("picture: permission refused goes the text way; never asks nobody and crops nothing; always asks nobody", async () => {
  const no = pictureRig({ permit: async () => "no" });
  no.agent.begin({ app: "Slack", pointer: { x: 400, y: 310 } });
  await no.agent.heard(AUDIO, { text: "explain this equation", final: true });
  assert.strictEqual(no.post.requests[0].image, null);
  assert.strictEqual(no.post.reqs()[0].picture, undefined);
  assert.strictEqual(no.post.reqs()[0].utterance, "explain this equation");
  assert.deepStrictEqual(no.guide.of("badge"), []);

  const never_ = pictureRig({ pictures: () => "never" });
  never_.agent.begin({ app: "Slack" });
  await never_.agent.heard(AUDIO, { text: "explain this equation", final: true });
  assert.deepStrictEqual(never_.permits, []);
  assert.deepStrictEqual(never_.crops, []);
  assert.strictEqual(never_.post.requests[0].image, null);
  assert.strictEqual(never_.driver.calls.find((c) => c[0] === "look")[1].image, false, "nor is one taken");

  const always = pictureRig({ pictures: async () => "always" });
  always.agent.begin({ app: "Slack" });
  await always.agent.heard(AUDIO, { text: "what does this chart show", final: true });
  assert.deepStrictEqual(always.permits, []);
  assert.ok(always.post.requests[0].image);

  const unanswered = pictureRig({ permit: () => never(), knobs: { "desktop.agent.confirmMs": 20 } });
  unanswered.agent.begin({ app: "Slack" });
  await unanswered.agent.heard(AUDIO, { text: "solve this", final: true });
  assert.strictEqual(unanswered.post.requests[0].image, null, "a card nobody answers is a no");
});

test("picture: without crop or pictures there is no picture path, and the look takes no picture", async () => {
  for (const missing of [{ crop: undefined }, { pictures: undefined }]) {
    const r = pictureRig(missing);
    r.agent.begin({ app: "Slack" });
    await sleep(1);
    assert.strictEqual(r.driver.calls.find((c) => c[0] === "look")[1].image, false);
    await r.agent.heard(AUDIO, { text: "explain this equation", final: true });
    assert.strictEqual(r.post.requests[0].image, null);
    assert.deepStrictEqual(r.permits, []);
  }
  // No permit with "ask" is a no.
  const noCard = pictureRig({ permit: undefined });
  noCard.agent.begin({ app: "Slack" });
  await noCard.agent.heard(AUDIO, { text: "explain this equation", final: true });
  assert.strictEqual(noCard.post.requests[0].image, null);
});

test("the look takes a picture only when one could go, at the screen's own size: not of an app whose pictures never go", async () => {
  for (const [pictures, want] of [
    [() => "never", false],
    [() => "ask", true],
    [() => "always", true],
    [async () => "never", true],                                  // not known yet: it may be allowed
    [async () => { throw new Error("no policy"); }, true],
    [() => { throw new Error("no policy"); }, false],             // a failing policy is never, as it is later
  ]) {
    const r = pictureRig({ pictures });
    r.agent.begin({ app: "Slack" });
    await sleep(1);
    const opts = r.driver.calls.find((c) => c[0] === "look")[1];
    assert.strictEqual(opts.image, want, String(pictures));
    assert.strictEqual(opts.maxSide, want ? 4096 : undefined, String(pictures));
    r.agent.cancel("test");
  }
  const smaller = pictureRig({ knobs: { "desktop.agent.lookMaxSide": 2048 } });
  smaller.agent.begin({ app: "Slack" });
  await sleep(1);
  assert.strictEqual(smaller.driver.calls.find((c) => c[0] === "look")[1].maxSide, 2048);
  smaller.agent.cancel("test");
});

test("picture: no words, a question that is not about a picture, or no picture in the look: no picture", async () => {
  const noWords = pictureRig();
  noWords.agent.begin({ app: "Slack" });
  await noWords.agent.heard(AUDIO);
  assert.strictEqual(noWords.post.requests[0].image, null);
  assert.deepStrictEqual(noWords.permits, []);

  const notVisual = pictureRig();
  notVisual.agent.begin({ app: "Slack" });
  await notVisual.agent.heard(AUDIO, { text: "what does this error mean", final: true });
  assert.strictEqual(notVisual.post.requests[0].image, null);

  const noImage = pictureRig({ look: lookOf([L_EQUATION], { image: null }) });
  noImage.agent.begin({ app: "Slack" });
  await noImage.agent.heard(AUDIO, { text: "explain this equation", final: true });
  assert.strictEqual(noImage.post.requests[0].image, null);
  assert.deepStrictEqual(noImage.policies, ["Slack"], "asked at Alt twice only, for the look");
});

test("picture: a crop that throws, comes back empty or is too big to send sends no picture", async () => {
  for (const crop of [
    () => { throw new Error("bad image"); },
    async () => null,
    () => ({ mime: "image/jpeg", data: Buffer.alloc(0) }),
    () => ({ mime: "text/plain", data: Buffer.from("x") }),
    () => ({ mime: "image/gif", data: Buffer.from("GIF89a") }),          // not a type the server takes
    () => ({ mime: "image/jpeg", data: Buffer.alloc(2000001) }),
  ]) {
    const r = pictureRig({ crop });
    r.agent.begin({ app: "Slack" });
    await r.agent.heard(AUDIO, { text: "explain this equation", final: true });
    assert.strictEqual(r.post.requests[0].image, null);
    assert.deepStrictEqual(r.permits, [], "nobody is asked to send a picture there is not");
  }
});

test("pictureRegion: the image under the pointer, else the largest big one, else the window", () => {
  const look = lookOf([]);
  // Under the pointer, the smallest of what nests there.
  const nest = snap([
    { id: "e1", role: "group", label: "", frame: [100, 100, 600, 400] },
    { id: "e2", role: "image", label: "", frame: [200, 200, 200, 150] },
  ]);
  assert.deepStrictEqual(pictureRegion(nest, look, { x: 250, y: 250 }), { frame: [200, 200, 200, 150], region: "element" });
  assert.deepStrictEqual(pictureRegion(nest, look, { x: 650, y: 450 }), { frame: [100, 100, 600, 400], region: "element" }, "a big wordless group");
  // A labelled or small group is not a picture; the largest big image is.
  const many = snap([
    { id: "e1", role: "group", label: "Sidebar", frame: [0, 0, 200, 600] },
    { id: "e2", role: "image", label: "", frame: [300, 50, 130, 90] },
    { id: "e3", role: "image", label: "", frame: [300, 200, 300, 200] },
    { id: "e4", role: "image", label: "", frame: [700, 10, 100, 60] },     // under the size
    { id: "o1", role: "image", label: "", frame: [0, 0, 900, 600], ocr: true },
  ]);
  assert.deepStrictEqual(pictureRegion(many, look, { x: 50, y: 50 }), { frame: [300, 200, 300, 200], region: "element" });
  assert.deepStrictEqual(pictureRegion(many, look, null), { frame: [300, 200, 300, 200], region: "element" });
  // Only what the picture has: cut to the window.
  const spilling = snap([{ id: "e1", role: "image", label: "", frame: [800, 500, 300, 300] }]);
  assert.deepStrictEqual(pictureRegion(spilling, look, { x: 850, y: 550 }), { frame: [800, 500, 100, 100], region: "element" });
  // Nothing at all: the window.
  assert.deepStrictEqual(pictureRegion(snap([EXPORT]), look, { x: 5, y: 5 }), { frame: [0, 0, 900, 600], region: "window" });
  assert.deepStrictEqual(pictureRegion({ ok: false, elements: [] }, look, null), { frame: [0, 0, 900, 600], region: "window" });
  // A sliver under the pointer is not the picture.
  const sliver = snap([{ id: "e1", role: "image", label: "", frame: [10, 10, 4, 300] }]);
  assert.strictEqual(pictureRegion(sliver, look, { x: 11, y: 50 }).region, "window");
});

test("pictureRegion: an element too small to see in the look's picture is grown about its middle, inside the window", () => {
  // A 4K window looked at 1600 wide: 2.4 window pixels to each of the
  // picture's. A 16 px icon was 7 of them, too few to crop, and the whole
  // window went in its place; it is grown to 32 of them (77 px), about its middle.
  const W4K = [0, 0, 3840, 2100];
  const look = lookOf([], { window: { frame: W4K, title: "" }, image: { mime: "image/jpeg", data: "eA==", width: 1600, height: 875 } });
  const icon = snap([{ id: "e1", role: "image", label: "", frame: [1001, 501, 16, 16] }], { window: { frame: W4K, title: "" } });
  const r = pictureRegion(icon, look, { x: 1008, y: 508 });
  assert.deepStrictEqual(r, { frame: [971, 471, 77, 77], region: "element" });
  assert.ok(r.frame[2] * 1600 / 3840 >= 32 && r.frame[3] * 875 / 2100 >= 32, "32 picture pixels each way");
  // In a corner: grown into the window, not off it.
  const corner = snap([{ id: "e1", role: "image", label: "", frame: [3820, 2080, 16, 16] }], { window: { frame: W4K, title: "" } });
  assert.deepStrictEqual(pictureRegion(corner, look, { x: 3825, y: 2085 }).frame, [3763, 2023, 77, 77]);
  // Below the chrome too: an icon just under the title bar grows down, not up into it.
  const titled = lookOf([], { window: { frame: W4K, title: "Paint" }, titleFrames: [[0, 0, 3840, 60]], image: look.image });
  const high = snap([{ id: "e1", role: "image", label: "", frame: [1000, 62, 16, 16] }], { window: { frame: W4K, title: "Paint" } });
  assert.deepStrictEqual(pictureRegion(high, titled, { x: 1005, y: 66 }).frame, [970, 60, 77, 77]);
  // At the screen's own size (the look at 4096 and the window under it) a
  // 16 px icon is cropped as it is, grown only to the 32 pixels.
  const full = lookOf([], { window: { frame: W4K, title: "" }, image: { mime: "image/jpeg", data: "eA==", width: 3840, height: 2100 } });
  assert.deepStrictEqual(pictureRegion(icon, full, { x: 1008, y: 508 }).frame, [993, 493, 32, 32]);
  // What is big enough already is left as it is; no image size, nothing to grow by.
  const big = snap([{ id: "e1", role: "image", label: "", frame: [200, 200, 300, 200] }], { window: { frame: W4K, title: "" } });
  assert.deepStrictEqual(pictureRegion(big, look, { x: 250, y: 250 }).frame, [200, 200, 300, 200]);
  assert.deepStrictEqual(pictureRegion(icon, Object.assign({}, look, { image: null }), { x: 1008, y: 508 }).frame, [1001, 501, 16, 16]);
});

test("pictureRegion: never the window's own chrome — its title bar, its tabs, its address bar", () => {
  // A browser: tabs, then the address bar, then the page.
  const browser = snap([
    { id: "e1", role: "image", label: "", frame: [8, 8, 16, 16] },                       // a tab's icon
    { id: "e2", role: "field", label: "Address and search bar", value: "https://bank.test/?s=1", frame: [80, 40, 700, 30] },
    { id: "e3", role: "group", label: "", frame: [0, 0, 900, 600] },                     // the whole window, wordless
  ], { app: { name: "Google Chrome", pid: 7 }, window: { frame: WIN, title: "Statement - Google Chrome" } });
  const look = lookOf([{ text: "Statement", frame: [30, 8, 120, 16] }], { window: { frame: WIN, title: "Statement - Google Chrome" } });
  // The window: from below the address bar down.
  assert.deepStrictEqual(pictureRegion(browser, look, null), { frame: [0, 70, 900, 530], region: "window" });
  // The pointer on a tab's icon: not a picture of the page, nor of the tab.
  assert.deepStrictEqual(pictureRegion(browser, look, { x: 12, y: 12 }), { frame: [0, 70, 900, 530], region: "window" });
  // A wordless group that covers the window is cut below the chrome too.
  assert.deepStrictEqual(pictureRegion(browser, look, { x: 400, y: 300 }), { frame: [0, 70, 900, 530], region: "element" });

  // No address bar: the title, as OCR read it in the title bar, is the edge.
  const doc = snap([], { window: { frame: WIN, title: "Q3 budget.xlsx - Excel" } });
  const bar = lookOf([
    { text: "AutoSave Off Q3 budget.xlsx - Excel Search", frame: [0, 4, 900, 20] },
    { text: "Q3 budget.xlsx - Excel", frame: [300, 500, 300, 20] },                      // far down: the page's own words
  ], { window: { frame: WIN, title: "Q3 budget.xlsx - Excel" } });
  assert.deepStrictEqual(pictureRegion(doc, bar, null), { frame: [0, 24, 900, 576], region: "window" });
  // A window that is all chrome goes as it is.
  const strip = lookOf([{ text: "Q3 budget.xlsx - Excel", frame: [0, 0, 900, 140] }], { window: { frame: [0, 0, 900, 200], title: "Q3 budget.xlsx - Excel" } });
  assert.deepStrictEqual(pictureRegion(doc, strip, null).frame, [0, 0, 900, 200]);
});

test("pictureRegion: the title the helper kept to itself, an address with no address bar to go by, a title read with another dash", () => {
  // Windows: the helper drops the title's lines before they get here, and
  // says where they were instead. One far down the window is not chrome.
  const title = "Q3 layoffs - Confidential.docx - Word";
  const word = snap([{ id: "e1", role: "button", label: "File", frame: [10, 40, 40, 20] }], { window: { frame: [0, 0, 1920, 1040], title } });
  const kept = lookOf([{ text: "File Home Insert", frame: [10, 40, 300, 20] }], { window: { frame: [0, 0, 1920, 1040], title }, titleFrames: [[700, 6, 520, 20], [0, 900, 100, 20]] });
  assert.deepStrictEqual(pictureRegion(word, kept, null), { frame: [0, 26, 1920, 1014], region: "window" });
  assert.deepStrictEqual(pictureRegion(word, Object.assign({}, kept, { titleFrames: "not frames" }), null).frame, [0, 0, 1920, 1040]);

  // No tree (a screen read off the picture alone): the line that reads as an
  // address is the address bar, query and all, and the edge of the chrome.
  const tab = "Statement - Google Chrome";
  const lines = lookOf([
    { text: "Statement", frame: [30, 8, 120, 16] },
    { text: "bank.test/statement?token=s3cr3t", frame: [120, 44, 500, 20] },
    { text: "Your balance", frame: [100, 200, 200, 20] },
  ], { window: { frame: WIN, title: tab } });
  assert.deepStrictEqual(pictureRegion({ ok: false, elements: [] }, lines, null), { frame: [0, 64, 900, 536], region: "window" });
  // With an address bar in the tree, an address on the page under it is the page's.
  const browser = snap([{ id: "e2", role: "field", label: "Address and search bar", frame: [80, 40, 700, 30] }], { window: { frame: WIN, title: tab } });
  const page = lookOf([{ text: "Start at docs.example.com/start", frame: [100, 100, 400, 20] }], { window: { frame: WIN, title: tab } });
  assert.deepStrictEqual(pictureRegion(browser, page, null).frame, [0, 70, 900, 530]);

  // The title with its em dash read as a hyphen is still the title.
  const dashed = snap([], { window: { frame: WIN, title: "Q3 layoffs — draft.docx - Word" } });
  const read = lookOf([{ text: "Q3 layoffs - draft.docx - Word", frame: [300, 4, 300, 20] }], { window: { frame: WIN, title: "Q3 layoffs — draft.docx - Word" } });
  assert.deepStrictEqual(pictureRegion(dashed, read, null).frame, [0, 24, 900, 576]);
});

test("picture: with no image on screen the window goes, as a window", async () => {
  const r = pictureRig({ snaps: [SLACK], pictures: () => "always" });
  r.agent.begin({ app: "Slack", pointer: { x: 5, y: 5 } });
  await r.agent.heard(AUDIO, { text: "what's this?", final: true });
  assert.deepStrictEqual(r.crops[0][1], WIN);
  assert.deepStrictEqual(r.post.reqs()[0].picture, { region: "window" });
});

// ---- LOOK: the text way asks for the picture ------------------------------------------

test("look: the text way decides it needs the picture — the same step again, with it", async () => {
  const r = pictureRig({
    scripts: [
      [heardShow("what does this mean?"), { t: "say", text: "Let me look." }, { t: "look", why: "it is a drawing" }],
      [heardShow("what does this mean?"), { t: "say", text: "A rising line." }, { t: "done" }],
    ],
  });
  r.agent.begin({ app: "Slack", pointer: { x: 400, y: 310 } });
  await r.agent.heard(AUDIO);
  assert.strictEqual(r.post.requests.length, 2);
  const [a, b] = r.post.requests;
  assert.strictEqual(a.image, null);
  assert.strictEqual(a.audio, AUDIO);
  assert.strictEqual(b.req.step, 0, "the same step");
  assert.strictEqual(b.req.runId, a.req.runId);
  assert.strictEqual(b.audio, null, "the words the server heard, not the recording again");
  assert.strictEqual(b.req.utterance, "what does this mean?");
  assert.deepStrictEqual(b.image, { mime: "image/jpeg", data: CROPPED.data });
  assert.deepStrictEqual(b.req.picture, { region: "element" });
  assert.deepStrictEqual(r.permits, ["Slack"]);
  assert.deepStrictEqual(r.guide.of("badge"), [["badge", "1 picture sent"]]);
  assert.deepStrictEqual(r.guide.of("state").at(-1), ["state", "done"]);
});

test("look: once a run; with no picture, no permission or an out-of-date one, it says it can't", async () => {
  const twice = pictureRig({
    pictures: () => "always",
    scripts: [[heardShow("what is that"), { t: "look", why: "" }], [heardShow("what is that"), { t: "look", why: "" }], [{ t: "done" }]],
  });
  twice.agent.begin({ app: "Slack" });
  await twice.agent.heard(AUDIO);
  assert.strictEqual(twice.post.requests.length, 2, "one picture a run");
  assert.deepStrictEqual(twice.guide.of("say").at(-1), ["say", TEXT.needLook, { speak: true, rate: 1.04 }]);
  assert.deepStrictEqual(twice.guide.of("state").at(-1), ["state", "done"]);

  for (const o of [{ look: undefined }, { pictures: () => "never" }, { permit: async () => "no" }, { crop: undefined }]) {
    const r = pictureRig(Object.assign({ scripts: [[heardShow("what is that"), { t: "look", why: "" }], [{ t: "done" }]] }, o));
    r.agent.begin({ app: "Slack" });
    await r.agent.heard(AUDIO);
    assert.strictEqual(r.post.requests.length, 1, JSON.stringify(Object.keys(o)));
    assert.deepStrictEqual(r.guide.of("say").at(-1), ["say", TEXT.needLook, { speak: true, rate: 1.04 }]);
    assert.strictEqual(r.agent.active(), false);
  }

  // A no on the card earlier in the run is not asked again.
  const declined = pictureRig({
    permit: async (app) => { declined.permits.push(app); return "no"; },
    scripts: [[heardShow("explain this equation"), { t: "look", why: "" }], [{ t: "done" }]],
  });
  declined.agent.begin({ app: "Slack" });
  await declined.agent.heard(AUDIO, { text: "explain this equation", final: true });
  assert.strictEqual(declined.permits.length, 1);
  assert.strictEqual(declined.post.requests.length, 1);

  // After an action the picture shows a screen that may be gone.
  const acted = pictureRig({
    pictures: () => "always",
    snaps: [PICTURED, PICTURED, PICTURED],
    scripts: [[heardDo("open export and explain the chart"), press("e1")], [heardDo("open export and explain the chart"), { t: "look", why: "" }], [{ t: "done" }]],
  });
  acted.agent.begin({ app: "Slack" });
  await acted.agent.heard(AUDIO);
  assert.strictEqual(acted.post.requests.length, 2);
  assert.ok(acted.post.requests.every((q) => q.image === null));
  assert.deepStrictEqual(acted.guide.of("say").at(-1), ["say", TEXT.needLook, { speak: true, rate: 1.04 }]);
});

test("look: a Mac that has not let Tailzu see the screen says so, with the way to Screen Recording", async () => {
  const noScreen = { ok: false, error: "no_screen_permission" };
  const r = pictureRig({ look: noScreen, scripts: [[heardShow("what does this graph show"), { t: "look", why: "a chart" }], [{ t: "done" }]] });
  r.agent.begin({ app: "Preview" });
  await r.agent.heard(AUDIO, { text: "what does this graph show", final: true });
  assert.strictEqual(r.post.requests.length, 1, "the words alone went; no picture to send");
  assert.strictEqual(r.post.requests[0].image, null);
  assert.deepStrictEqual(r.permits, [], "nobody is asked to send a picture there is not");
  assert.deepStrictEqual(r.guide.of("say").at(-1), ["say", TEXT.needScreen, { speak: true, rate: 1.04 }]);
  assert.match(TEXT.needScreen, /System Settings, Privacy & Security, Screen Recording/);
  assert.deepStrictEqual(r.guide.of("offer"), [["offer", "screenSettings"]]);
  assert.ok(r.guide.calls.findIndex((c) => c[0] === "offer") > r.guide.calls.findIndex((c) => c[0] === "say" && c[1] === TEXT.needScreen), "after the words");
  assert.deepStrictEqual(r.guide.of("state").at(-1), ["state", "done"]);
  assert.ok(r.logs.some((l) => /no Screen Recording permission/.test(l)));

  // Any other look that failed, and an app whose pictures never go: the plain "can't", no button.
  for (const o of [{ look: { ok: false, error: "timeout" } }, { look: noScreen, pictures: () => "never" }]) {
    const q = pictureRig(Object.assign({ scripts: [[heardShow("what is that"), { t: "look", why: "" }], [{ t: "done" }]] }, o));
    q.agent.begin({ app: "Preview" });
    await q.agent.heard(AUDIO);
    assert.deepStrictEqual(q.guide.of("say").at(-1), ["say", TEXT.needLook, { speak: true, rate: 1.04 }]);
    assert.deepStrictEqual(q.guide.of("offer"), []);
  }
  // A look that worked: no "can't" at all, the picture goes.
  const ok = pictureRig({ pictures: () => "always", scripts: [[heardShow("what is that"), { t: "look", why: "" }], [{ t: "done" }]] });
  ok.agent.begin({ app: "Preview" });
  await ok.agent.heard(AUDIO);
  assert.strictEqual(ok.post.requests.length, 2);
  assert.deepStrictEqual(ok.guide.of("offer"), []);
});

test("cancel while the permission card is up: nothing is sent", async () => {
  const r = pictureRig({ permit: () => never() });
  r.agent.begin({ app: "Slack" });
  const run = r.agent.heard(AUDIO, { text: "explain this equation", final: true });
  await sleep(5);
  r.agent.cancel("esc");
  await run;
  assert.strictEqual(r.post.requests.length, 0);
  assert.deepStrictEqual(r.guide.of("badge"), []);
});

// ---- a caption that is not the stream's final one ------------------------------------

test("a partial caption is no question to answer here or send a picture for: the recording goes, and says it whole", async () => {
  const menu = snap([
    { id: "e1", role: "menuitem", label: "Save", frame: [10, 30, 100, 20] },
    { id: "e2", role: "menuitem", label: "Save As…", frame: [10, 50, 100, 20] },
  ]);
  // "where is the save" of "where is the save as".
  const r = rig({ snaps: [menu], scripts: [[heardShow("where is the save as"), { t: "point", id: "e2" }, { t: "done" }]] });
  r.agent.begin({ app: "TextEdit" });
  await r.agent.heard(AUDIO, { text: "where is the save", final: false });
  assert.strictEqual(r.post.requests.length, 1, "not answered here on part of a question");
  assert.strictEqual(r.post.requests[0].audio, AUDIO);
  assert.strictEqual(r.post.reqs()[0].utterance, undefined);
  assert.deepStrictEqual(r.guide.of("point"), [["point", [10, 50, 100, 20]]]);

  // "what's this" of "what's this error message mean": no card, no picture.
  const pic = pictureRig();
  pic.agent.begin({ app: "Slack", pointer: { x: 400, y: 310 } });
  await pic.agent.heard(AUDIO, { text: "what's this", final: false });
  assert.deepStrictEqual(pic.permits, []);
  assert.strictEqual(pic.post.requests[0].image, null);
  assert.strictEqual(pic.post.requests[0].audio, AUDIO);

  // No recording: the words there are, are all there is.
  const words = rig({ scripts: [[heardDo("open settings"), { t: "done" }]] });
  words.agent.begin({ app: "Slack" });
  await words.agent.heard(null, { text: "open settings", final: false });
  assert.strictEqual(words.post.requests[0].audio, null);
  assert.strictEqual(words.post.reqs()[0].utterance, "open settings");
});

// ---- the rest of the run, with lines in it ----------------------------------------

test("an action on a line read off the screen is not run: it is text, not a control", async () => {
  const r = rig({ look: LOOK, scripts: [[heardDo("click quarterly revenue"), press("o1")], [{ t: "done" }]] });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO);
  assert.deepStrictEqual(r.driver.acts(), []);
  assert.deepStrictEqual(r.guide.of("confirm"), []);
  const [, second] = r.post.reqs();
  assert.deepStrictEqual([second.history[0].did, second.history[0].result], ["PRESS o1", "failed"]);
  assert.match(second.history[0].note, /o1 is text read off the screen/);
});

test("the server's point at a line rings the line's own frame", async () => {
  const r = rig({ look: LOOK, scripts: [[heardShow("what's the revenue?"), { t: "point", id: "o1", caption: "Here" }, { t: "done" }]] });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO);
  assert.deepStrictEqual(r.guide.of("point"), [["point", [300, 200, 200, 20], "Here"]]);
});

test("after an action, the lines from Alt twice are not counted as gone", () => {
  const before = snap([EXPORT, SEND].concat(ocrElements(SLACK, LOOK)));
  assert.strictEqual(before.elements.length, 4);
  assert.strictEqual(describeChange(before, snap([EXPORT, SEND])), "nochange");
});

test("a screen with lines in it still finds copying from them risky", () => {
  const lines = ocrElements(SLACK, lookOf([{ text: "Your code is 482 913", frame: [300, 100, 200, 20] }]));
  const s = Object.assign({}, SLACK, { elements: SLACK.elements.concat(lines) });
  assert.strictEqual(classifyRisk({ kind: "type", text: "482913", risk: "free" }, s), "confirm");
});

// ---- makePost: the picture ------------------------------------------------------

test("makePost: a picture makes it multipart, with or without audio; its part is named by its type", async () => {
  const fetch = fakeFetch([ndjson([{ t: "done" }])]);
  const post = makePost({ baseUrl: "https://x", token: async () => "t", fetch });
  await collect(post(REQ, null, undefined, { mime: "image/jpeg", data: Buffer.from("jpeg bytes") }));
  let { init } = fetch.calls[0];
  assert.ok(init.body instanceof FormData);
  assert.strictEqual(init.headers["Content-Type"], undefined);
  assert.deepStrictEqual([...init.body.keys()], ["request", "image"]);
  assert.deepStrictEqual(JSON.parse(init.body.get("request")), REQ);
  const pic = init.body.get("image");
  assert.strictEqual(pic.name, "picture.jpg");
  assert.strictEqual(pic.type, "image/jpeg");
  assert.strictEqual(Buffer.from(await pic.arrayBuffer()).toString(), "jpeg bytes");

  await collect(post(REQ, AUDIO, undefined, { mime: "image/png", data: Buffer.from("png") }));
  init = fetch.calls[1].init;
  assert.deepStrictEqual([...init.body.keys()], ["request", "audio", "image"], "the request first, then the files");
  assert.strictEqual(init.body.get("image").name, "picture.png");
  assert.strictEqual(init.body.get("image").type, "image/png");

  await collect(post(REQ, null, undefined, { data: new Blob(["w"], { type: "image/webp" }) }));
  assert.strictEqual(fetch.calls[2].init.body.get("image").name, "picture.webp");

  // An empty picture is no picture: plain JSON.
  await collect(post(REQ, null, undefined, { mime: "image/jpeg", data: Buffer.alloc(0) }));
  assert.strictEqual(fetch.calls[3].init.headers["Content-Type"], "application/json");
});

test("makePost: a 401 with a picture sends the picture again", async () => {
  const fetch = fakeFetch([jsonError(401, { code: "unauthorized" }), ndjson([{ t: "done" }])]);
  const post = makePost({ baseUrl: "https://x", token: async (renew) => (renew ? "fresh" : "stale"), fetch });
  await collect(post(REQ, null, undefined, { mime: "image/jpeg", data: Buffer.from("j") }));
  assert.strictEqual(fetch.calls.length, 2);
  assert.ok(fetch.calls[1].init.body.get("image"));
});

// ---- marks: the answer draws on the screen ------------------------------------------

/** A guide that can draw: the v3 one. The plain fakeGuide is an older guide,
 *  with neither draw nor clear. */
function inkGuide(confirm) {
  const g = fakeGuide(confirm);
  for (const m of ["draw", "clear"]) g[m] = (...args) => { g.calls.push([m, ...args]); };
  return g;
}
/** The picture's region in the picture tests: CHART, under the pointer. */
const REGION = [250, 150, 400, 300];
const FRAMES = new Map([["e1", [700, 20, 80, 30]], ["o1", [300, 200, 200, 20]]]);

test("resolveMark: an id is its element's frame, a line read off the window's included; an id not on this screen drops the mark", () => {
  assert.deepStrictEqual(resolveMark({ t: "draw", kind: "box", target: { id: "e1" }, text: "Export" }, FRAMES, null), { kind: "box", frame: [700, 20, 80, 30], text: "Export" });
  assert.deepStrictEqual(resolveMark({ kind: "underline", target: { id: "o1" } }, FRAMES, null), { kind: "underline", frame: [300, 200, 200, 20] });
  assert.strictEqual(resolveMark({ kind: "circle", target: { id: "e9" } }, FRAMES, REGION), null);
  // A copy: whatever the guide's side does with it, the run's map is untouched.
  resolveMark({ kind: "box", target: { id: "e1" } }, FRAMES, null).frame[0] = 0;
  assert.deepStrictEqual(FRAMES.get("e1"), [700, 20, 80, 30]);
});

test("resolveMark: a place in the picture goes through the region it was cropped from, and stays inside it", () => {
  // X = fx + x/1000·fw, Y = fy + y/1000·fh.
  assert.deepStrictEqual(resolveMark({ kind: "label", target: { pt: [500, 500] }, text: "here" }, FRAMES, REGION), { kind: "label", at: [450, 300], text: "here" });
  assert.deepStrictEqual(resolveMark({ kind: "circle", target: { box: [100, 200, 300, 400] } }, FRAMES, REGION), { kind: "circle", frame: [290, 210, 120, 120] });
  assert.deepStrictEqual(resolveMark({ kind: "number", target: { pt: [0, 1000] }, n: 2 }, FRAMES, REGION), { kind: "number", at: [250, 450], n: 2 });
  assert.deepStrictEqual(resolveMark({ kind: "label", target: { pt: [-50, 2000] }, text: "x" }, FRAMES, REGION), { kind: "label", at: [250, 450], text: "x" });
  assert.deepStrictEqual(resolveMark({ kind: "box", target: { box: [900, 900, 500, 500] } }, FRAMES, REGION), { kind: "box", frame: [610, 420, 40, 30] });
  assert.strictEqual(resolveMark({ kind: "box", target: { box: [1000, 0, 50, 50] } }, FRAMES, REGION), null, "nothing of it inside");
  // No picture sent on the run: a place in one means nothing.
  for (const target of [{ pt: [500, 500] }, { box: [1, 2, 30, 40] }]) {
    assert.strictEqual(resolveMark({ kind: "circle", target }, FRAMES, null), null);
    assert.strictEqual(resolveMark({ kind: "circle", target }, FRAMES, [0, 0, 0, 0]), null);
  }
});

test("resolveMark: a box, circle, underline or highlight at a place goes around a small square on it", () => {
  // 4% of the region's shorter side (300 → 12), centred on (450, 300).
  for (const kind of ["box", "circle", "underline", "highlight"]) {
    assert.deepStrictEqual(resolveMark({ kind, target: { pt: [500, 500] } }, FRAMES, REGION), { kind, frame: [444, 294, 12, 12] });
  }
  // Never smaller than 8, however small the picture.
  assert.deepStrictEqual(resolveMark({ kind: "circle", target: { pt: [500, 500] } }, FRAMES, [0, 0, 100, 50]), { kind: "circle", frame: [46, 21, 8, 8] });
});

test("resolveMark: an arrow's two ends, a path's points, a number's numeral, a label's words", () => {
  assert.deepStrictEqual(resolveMark({ kind: "arrow", from: { id: "o1" }, to: { pt: [500, 0] }, text: "this one" }, FRAMES, REGION),
    { kind: "arrow", from: [300, 200, 200, 20], to: [450, 150], text: "this one" });
  assert.strictEqual(resolveMark({ kind: "arrow", from: { id: "o1" }, to: { id: "e9" } }, FRAMES, REGION), null);
  assert.strictEqual(resolveMark({ kind: "arrow", from: { id: "o1" } }, FRAMES, REGION), null);
  assert.deepStrictEqual(resolveMark({ kind: "path", points: [[0, 0], [1000, 0], [500, 1000]], closed: true }, FRAMES, REGION),
    { kind: "path", points: [[250, 150], [650, 150], [450, 450]], closed: true });
  assert.deepStrictEqual(resolveMark({ kind: "path", points: [[0, 0], [1000, 1000]], closed: "yes" }, FRAMES, REGION), { kind: "path", points: [[250, 150], [650, 450]] });
  assert.strictEqual(resolveMark({ kind: "path", points: [[0, 0]] }, FRAMES, REGION), null);
  assert.strictEqual(resolveMark({ kind: "path", points: [[0, 0], [1, 1]] }, FRAMES, null), null, "a path is only ever in a picture");
  assert.strictEqual(resolveMark({ kind: "path", points: Array.from({ length: 33 }, (_, i) => [i, i]) }, FRAMES, REGION), null);
  assert.strictEqual(resolveMark({ kind: "path", points: [[0, 0], [1, "x"]] }, FRAMES, REGION), null);
  assert.deepStrictEqual(resolveMark({ kind: "number", target: { id: "e1" }, n: 3 }, FRAMES, null), { kind: "number", frame: [700, 20, 80, 30], n: 3 });
  for (const n of [0, 10, 2.5, "2", undefined]) assert.strictEqual(resolveMark({ kind: "number", target: { id: "e1" }, n }, FRAMES, null), null, String(n));
  assert.strictEqual(resolveMark({ kind: "label", target: { id: "e1" } }, FRAMES, null), null, "a label is its words");
  assert.strictEqual(resolveMark({ kind: "label", target: { id: "e1" }, text: " \u0007 " }, FRAMES, null), null);
  const long = resolveMark({ kind: "circle", target: { id: "e1" }, text: "two\nlines and " + "x".repeat(60) }, FRAMES, null);
  assert.ok(!/\n/.test(long.text) && long.text.length === 48 && long.text.endsWith("…"), long.text);
  for (const kind of ["blob", "clear", undefined]) assert.strictEqual(resolveMark({ kind, target: { id: "e1" } }, FRAMES, REGION), null);
  assert.strictEqual(resolveMark(null, FRAMES, REGION), null);
});

test("begin takes the last answer's marks away first, before it shows, and even when it refuses", () => {
  const r = rig({ guide: inkGuide() });
  r.agent.begin({ app: "Slack" });
  assert.deepStrictEqual(r.guide.calls.slice(0, 2).map((c) => c[0]), ["clear", "show"]);
  r.agent.cancel("test");
  const refused = rig({ guide: inkGuide() });
  refused.agent.begin({ app: "Slack", privateField: true });
  assert.deepStrictEqual(refused.guide.calls.map((c) => c[0]), ["clear", "error"]);
});

test("a show run's marks reach the guide as they come, among its sentences, on this screen's frames; what cannot be placed is dropped", async () => {
  const r = rig({
    guide: inkGuide(),
    look: LOOK,
    scripts: [[
      heardShow("how do I export the revenue?"),
      { t: "say", text: "Select the revenue, then press Export." },
      { t: "draw", kind: "number", target: { id: "o1" }, n: 1 },
      { t: "draw", kind: "number", target: { id: "e1" }, n: 2, text: "Export" },
      { t: "draw", kind: "circle", target: { id: "e42" } },
      { t: "draw", kind: "circle", target: { pt: [500, 500] } },
      { t: "say", text: "It saves a copy.", append: true },
      { t: "draw", kind: "arrow", from: { id: "o1" }, to: { id: "e1" } },
      { t: "done" },
    ]],
  });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO);
  const seq = r.guide.calls.filter((c) => ["say", "draw", "clear"].includes(c[0])).map((c) => (c[0] === "say" ? ["say", c[1]] : c));
  assert.deepStrictEqual(seq, [
    ["clear"],
    ["say", "Select the revenue, then press Export."],
    ["draw", { kind: "number", frame: [300, 200, 200, 20], n: 1 }],
    ["draw", { kind: "number", frame: [700, 20, 80, 30], n: 2, text: "Export" }],
    ["say", "It saves a copy."],
    ["draw", { kind: "arrow", from: [300, 200, 200, 20], to: [700, 20, 80, 30] }],
  ], "an id not on the screen, and a place in a picture never sent, are not drawn");
  assert.strictEqual(r.logs.filter((l) => /a circle dropped: not on this screen/.test(l)).length, 2);
  // Done: the marks stay up with the card, until it hides.
  assert.deepStrictEqual(r.guide.of("state").at(-1), ["state", "done"]);
  await sleep(15);
  assert.deepStrictEqual(r.guide.calls.at(-1), ["hide"]);
  assert.strictEqual(r.guide.of("clear").length, 1);
});

test("before an action the marks go, after its yes and before it runs; the next step draws on the screen it finds", async () => {
  const guide = inkGuide(true);
  const DIALOG = snap([EXPORT, COMPOSER, SEND, HEADING, { id: "e5", role: "button", label: "Export as PDF", frame: [300, 250, 120, 30] }], { focused: "e5" });
  const r = rig({
    guide,
    snaps: [SLACK, DIALOG],
    results: { press: () => { guide.calls.push(["pressed"]); return { ok: true }; } },
    scripts: [
      [heardDo("export this"), { t: "say", text: "Export is here." }, { t: "draw", kind: "number", target: { id: "e1" }, n: 1 },
        press("e1", { risk: "confirm", confirm: "Export it?" })],
      [{ t: "draw", kind: "circle", target: { id: "e5" } }, { t: "done" }],
    ],
  });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO);
  const seq = guide.calls.map((c) => c[0]).filter((m) => ["draw", "clear", "point", "confirm", "pressed"].includes(m));
  assert.deepStrictEqual(seq, ["clear", "draw", "point", "confirm", "clear", "pressed", "draw"]);
  assert.deepStrictEqual(guide.of("draw").map((c) => c[1]), [
    { kind: "number", frame: [700, 20, 80, 30], n: 1 },
    { kind: "circle", frame: [300, 250, 120, 30] },
  ]);
});

test("an action declined changes nothing, so its marks stay; an action with no marks up sends no clear", async () => {
  const no = rig({ guide: inkGuide(false), scripts: [[heardDo("send it"), { t: "draw", kind: "circle", target: { id: "e3" } }, press("e3", { risk: "confirm" })]] });
  no.agent.begin({ app: "Slack" });
  await no.agent.heard(AUDIO);
  assert.strictEqual(no.guide.of("draw").length, 1);
  assert.deepStrictEqual(no.guide.of("clear"), [["clear"]], "only begin's");
  assert.deepStrictEqual(no.guide.of("state").at(-1), ["state", "done", TEXT.declined]);

  const bare = rig({ guide: inkGuide(), snaps: [SLACK, AFTER_SEND], scripts: [[heardDo("export"), press("e1")], [{ t: "done" }]] });
  bare.agent.begin({ app: "Slack" });
  await bare.agent.heard(AUDIO);
  assert.deepStrictEqual(bare.driver.acts(), [["press", "e1"]]);
  assert.deepStrictEqual(bare.guide.of("clear"), [["clear"]], "only begin's");
});

test("every kind of action that changes the screen clears the marks first", async () => {
  const actions = [
    press("e1"),
    { t: "action", kind: "set", id: "e2", text: "hello", risk: "free" },
    { t: "action", kind: "type", text: "hello", risk: "free" },
    { t: "action", kind: "key", keys: "down", risk: "free" },
    { t: "action", kind: "scroll", dir: "down", risk: "free" },
    { t: "action", kind: "focus", id: "e2", risk: "free" },
    { t: "action", kind: "open", app: "Slack", risk: "free" },
  ];
  for (const a of actions) {
    const guide = inkGuide();
    const r = rig({
      guide,
      platform: "mac",
      results: Object.fromEntries(["press", "setValue", "key", "scroll", "focus", "open"].map((m) => [m, () => { guide.calls.push(["acted"]); return { ok: true }; }])),
      paste: async () => { guide.calls.push(["acted"]); },
      snaps: [SLACK, AFTER_SEND],
      scripts: [[heardDo("do it"), { t: "draw", kind: "box", target: { id: "e2" } }, a], [{ t: "done" }]],
    });
    r.agent.begin({ app: "Slack" });
    await r.agent.heard(AUDIO);
    const seq = guide.calls.map((c) => c[0]).filter((m) => ["draw", "clear", "acted"].includes(m));
    assert.deepStrictEqual(seq.slice(0, 4), ["clear", "draw", "clear", "acted"], a.kind);
  }
});

test("the server's DRAW CLEAR takes the marks away; with none up it sends nothing", async () => {
  const r = rig({
    guide: inkGuide(),
    scripts: [[heardShow("what's this?"), { t: "draw", kind: "clear" }, { t: "draw", kind: "box", target: { id: "e1" } }, { t: "draw", kind: "clear" }, { t: "draw", kind: "box", target: { id: "e3" } }, { t: "done" }]],
  });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO);
  assert.deepStrictEqual(r.guide.calls.map((c) => c[0]).filter((m) => m === "draw" || m === "clear"), ["clear", "draw", "clear", "draw"]);
});

test("picture: the answer's marks in the picture land on the region it was cropped from", async () => {
  const r = pictureRig({
    guide: inkGuide(),
    scripts: [[
      heardShow("how long is the long side of this triangle?"),
      { t: "say", text: "The long side is 5." },
      { t: "draw", kind: "arrow", from: { pt: [640, 450] }, to: { pt: [450, 620] }, text: "c, what we want" },
      { t: "draw", kind: "circle", target: { box: [150, 800, 50, 50] }, text: "90°" },
      { t: "draw", kind: "path", points: [[180, 820], [180, 420], [720, 820]], closed: true },
      { t: "draw", kind: "underline", target: { id: "o1" } },
      { t: "done" },
    ]],
  });
  r.agent.begin({ app: "Slack", pointer: { x: 400, y: 310 } });
  await r.agent.heard(AUDIO, { text: "how long is the long side of this triangle?", final: true });
  assert.ok(r.post.requests[0].image, "the picture went");
  assert.deepStrictEqual(r.guide.of("draw").map((c) => c[1]), [
    { kind: "arrow", from: [506, 285], to: [430, 336], text: "c, what we want" },
    { kind: "circle", frame: [310, 390, 20, 15], text: "90°" },
    { kind: "path", points: [[322, 396], [322, 276], [538, 396]], closed: true },
    { kind: "underline", frame: [300, 200, 200, 20] },
  ]);
  // Where the picture is never went: not in the request, not on the side.
  assert.ok(!JSON.stringify(r.post.reqs()[0]).includes("250"));
  assert.strictEqual(r.post.reqs()[0].pictureFrame, undefined);
});

test("picture: a crop that had to take the whole window says so, and the marks are places in what was sent", async () => {
  // An icon too small to crop (on a 4K window captured at 1600 px, a 16 px
  // icon is 7 picture pixels): ask.js's crop sends the window, and says it
  // did. A circle in the middle of the picture is in the middle of the window.
  const r = pictureRig({
    guide: inkGuide(),
    crop: (look, frame) => Object.assign({}, CROPPED, { frame: WIN.slice() }),
    scripts: [[
      heardShow("explain this equation"),
      { t: "say", text: "That's the middle of it." },
      { t: "draw", kind: "circle", target: { box: [400, 400, 200, 200] } },
      { t: "draw", kind: "number", target: { pt: [250, 250] }, n: 1 },
      { t: "done" },
    ]],
  });
  r.agent.begin({ app: "Slack", pointer: { x: 400, y: 310 } });
  await r.agent.heard(AUDIO, { text: "explain this equation", final: true });
  assert.deepStrictEqual(r.guide.of("point")[0], ["point", WIN, "Looking", { tentative: true }], "the ring is round what was sent");
  assert.deepStrictEqual(r.guide.of("draw").map((c) => c[1]), [
    { kind: "circle", frame: [360, 240, 180, 120] },
    { kind: "number", at: [225, 150], n: 1 },
  ]);
  // A crop that says nothing of it (or nonsense) is taken as the region it was asked for.
  for (const said of [undefined, null, [0, 0, 0, 0], "everything", [1, 2, 3]]) {
    const q = pictureRig({
      guide: inkGuide(),
      crop: () => Object.assign({}, CROPPED, { frame: said }),
      scripts: [[heardShow("explain this equation"), { t: "draw", kind: "number", target: { pt: [250, 250] }, n: 1 }, { t: "done" }]],
    });
    q.agent.begin({ app: "Slack", pointer: { x: 400, y: 310 } });
    await q.agent.heard(AUDIO, { text: "explain this equation", final: true });
    assert.deepStrictEqual(q.guide.of("draw")[0][1], { kind: "number", at: [350, 225], n: 1 }, JSON.stringify(said));
    assert.deepStrictEqual(q.guide.of("point")[0][1], REGION);
  }
});

test("look: the text answer's marks go before the same step comes again with the picture, whose marks are in it", async () => {
  const r = pictureRig({
    guide: inkGuide(),
    scripts: [
      [heardShow("what does this mean?"), { t: "say", text: "Let me look." }, { t: "draw", kind: "box", target: { id: "e5" } },
        { t: "draw", kind: "circle", target: { pt: [500, 500] } }, { t: "look", why: "a drawing" }],
      [heardShow("what does this mean?"), { t: "say", text: "A rising line." }, { t: "draw", kind: "circle", target: { pt: [500, 500] } }, { t: "done" }],
    ],
  });
  r.agent.begin({ app: "Slack", pointer: { x: 400, y: 310 } });
  await r.agent.heard(AUDIO);
  assert.strictEqual(r.post.requests.length, 2);
  assert.deepStrictEqual(r.guide.calls.map((c) => c[0]).filter((m) => ["draw", "clear", "badge"].includes(m)), ["clear", "draw", "clear", "badge", "draw"]);
  assert.deepStrictEqual(r.guide.of("draw").map((c) => c[1]), [
    { kind: "box", frame: [250, 150, 400, 300] },
    { kind: "circle", frame: [444, 294, 12, 12] },
  ], "the text step's place in a picture it had not sent is dropped");
  assert.strictEqual(r.post.reqs()[1].pictureFrame, undefined);
});

test("the draw knob off: no marks at all", async () => {
  const r = rig({
    guide: inkGuide(),
    knobs: { "desktop.agent.draw": false },
    snaps: [SLACK, AFTER_SEND],
    scripts: [[heardDo("export"), { t: "draw", kind: "circle", target: { id: "e1" } }, { t: "draw", kind: "clear" }, press("e1")], [{ t: "done" }]],
  });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO);
  assert.deepStrictEqual(r.guide.of("draw"), []);
  assert.deepStrictEqual(r.guide.of("clear"), [["clear"]], "only begin's, for a last answer drawn before the knob went off");
  assert.deepStrictEqual(r.driver.acts(), [["press", "e1"]]);
});

test("a guide with no draw or clear (an older one) is not called for them, and the run goes as before", async () => {
  const r = rig({
    snaps: [SLACK, AFTER_SEND],
    scripts: [[heardDo("export"), { t: "draw", kind: "circle", target: { id: "e1" } }, press("e1")], [{ t: "say", text: "Done." }, { t: "done" }]],
  });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO);
  assert.deepStrictEqual(r.driver.acts(), [["press", "e1"]]);
  assert.ok(!r.logs.some((l) => /guide\.(?:draw|clear)/.test(l)));
  assert.deepStrictEqual(r.guide.of("state").at(-1), ["state", "done"]);
});

test("marks never go back to the server: every request is what it would have been without them", async () => {
  const play = async (marks) => {
    const r = rig({
      guide: inkGuide(),
      look: LOOK,
      snaps: [SLACK, AFTER_SEND],
      scripts: [
        [heardDo("export"), ...(marks ? [{ t: "draw", kind: "circle", target: { id: "e1" }, text: "here" }, { t: "draw", kind: "box", target: { id: "o1" } }] : []), press("e1")],
        [...(marks ? [{ t: "draw", kind: "clear" }] : []), { t: "done" }],
      ],
    });
    r.agent.begin({ app: "Slack" });
    await r.agent.heard(AUDIO);
    return r.post.reqs().map((q) => Object.assign({}, q, { runId: "" }));
  };
  assert.deepStrictEqual(await play(true), await play(false));
});

test("resolveMark: an arrow with no length is dropped; a label that is not words is no label", () => {
  // A button and the line of text read off it share a frame.
  const same = new Map([["e1", [700, 20, 80, 30]], ["o2", [700, 20, 80, 30]]]);
  assert.strictEqual(resolveMark({ kind: "arrow", from: { id: "e1" }, to: { id: "o2" } }, same, null), null);
  // Two places the clamp makes one.
  assert.strictEqual(resolveMark({ kind: "arrow", from: { pt: [1200, 0] }, to: { pt: [1000, -5] } }, FRAMES, REGION), null);
  // A frame and a point at its corner are still two ends.
  assert.deepStrictEqual(resolveMark({ kind: "arrow", from: { id: "e1" }, to: { pt: [0, 0] } }, FRAMES, REGION), { kind: "arrow", from: [700, 20, 80, 30], to: [250, 150] });
  for (const text of [{ a: 1 }, ["x"], 5, true]) {
    assert.deepStrictEqual(resolveMark({ kind: "circle", target: { id: "e1" }, text }, FRAMES, null), { kind: "circle", frame: [700, 20, 80, 30] }, JSON.stringify(text));
    assert.strictEqual(resolveMark({ kind: "label", target: { id: "e1" }, text }, FRAMES, null), null, JSON.stringify(text));
  }
});

test("the next step starts with the last answer's marks taken away: an ASK's numbered choices once they have picked, before the reply is sent", async () => {
  const guide = inkGuide();
  const r = rig({
    guide,
    listen: async () => REPLY,
    scripts: [
      [heardDo("send it to one of them"), { t: "say", text: "Which one?" }, { t: "draw", kind: "number", target: { id: "e1" }, n: 1 },
        { t: "draw", kind: "number", target: { id: "e3" }, n: 2 }, { t: "ask", text: "The first or the second?" }],
      () => { guide.calls.push(["posted"]); return [heardDo("the second"), { t: "draw", kind: "circle", target: { id: "e3" } }, { t: "done" }]; },
    ],
  });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO);
  const seq = guide.calls.map((c) => (c[0] === "state" ? c[0] + ":" + c[1] : c[0])).filter((m) => ["draw", "clear", "posted", "state:listening", "state:thinking"].includes(m));
  assert.deepStrictEqual(seq, ["clear", "state:thinking", "draw", "draw", "state:listening", "clear", "state:thinking", "posted", "draw"],
    "up while they choose, gone once they have");
});

test("a step whose action never ran (the focus moved) leaves no marks for the next answer to draw over", async () => {
  const guide = inkGuide();
  const MOVED = snap([EXPORT, COMPOSER, SEND, HEADING], { focused: "e1" });
  const r = rig({
    guide,
    snaps: [SLACK, MOVED],
    scripts: [
      [heardDo("next line"), { t: "draw", kind: "underline", target: { id: "e2" } }, { t: "action", kind: "key", keys: "down", risk: "free" }],
      () => { guide.calls.push(["posted"]); return [{ t: "draw", kind: "underline", target: { id: "e2" } }, { t: "done" }]; },
    ],
  });
  r.agent.begin({ app: "Slack" });
  await r.agent.heard(AUDIO);
  assert.deepStrictEqual(r.driver.acts(), [], "the key did not go");
  assert.strictEqual(r.post.reqs()[1].history.at(-1).result, "failed");
  assert.deepStrictEqual(guide.calls.map((c) => c[0]).filter((m) => ["draw", "clear", "posted"].includes(m)), ["clear", "draw", "clear", "posted", "draw"]);
});

test("the answer's first mark puts the tentative ring away: the picture's pulsing \"Looking\" goes once the pen is on it", async () => {
  const r = pictureRig({
    guide: inkGuide(),
    scripts: [[
      heardShow("how long is the long side of this triangle?"),
      { t: "draw", kind: "circle", target: { id: "e42" } },
      { t: "say", text: "It's a right angle." },
      { t: "draw", kind: "circle", target: { box: [150, 800, 50, 50] }, text: "90°" },
      { t: "draw", kind: "label", target: { pt: [300, 700] }, text: "90°" },
      { t: "done" },
    ]],
  });
  r.agent.begin({ app: "Slack", pointer: { x: 400, y: 310 } });
  await r.agent.heard(AUDIO, { text: "how long is the long side of this triangle?", final: true });
  assert.ok(r.post.requests[0].image, "the picture went");
  const seq = r.guide.calls.filter((c) => ["point", "unpoint", "draw"].includes(c[0])).map((c) => (c[0] === "point" ? ["point", c[2], c[3]] : [c[0]]));
  // A mark that could not be placed is not the answer's pen: the ring stays
  // until one is drawn, and goes once.
  assert.deepStrictEqual(seq, [["point", TEXT.looking, { tentative: true }], ["unpoint"], ["draw"], ["draw"]]);
});

// ---- the server's confirm card, for a connected app ---------------------------------
//
// An "approve" event carries the card the server built: its words, its three
// buttons and the route each one calls. The guide draws it as it came; the
// answer calls the route that button names, and the result is shown on the
// card. Nothing here is the device's own wording.

const CARD = (id = "t1") => ({
  title: "Ready to send?", app: "Slack", label: "The exact message", preview: "Post message in Slack \u2014 channel: #design",
  note: "I\u2019ll do this in Slack, as you. I won\u2019t do anything else.",
  buttons: [
    { id: "approve", label: "Approve", call: { method: "POST", path: `/v1/tasks/${id}/approve`, body: { approvalId: "ap1" } } },
    { id: "edit", label: "Edit", call: { method: "POST", path: `/v1/tasks/${id}/deny` }, then: "listen" },
    { id: "deny", label: "Not now", call: { method: "POST", path: `/v1/tasks/${id}/deny` } },
  ],
  after: { done: "Done \u2713", left: "Okay, I left it.", failed: "That didn\u2019t go through.", change: "What should I change?" },
});
const approveEv = (o) => Object.assign({
  t: "approve", taskId: "t1",
  approval: { id: "ap1", connector: "slack", tool: "post_message", risk: "send", preview: "Post message in Slack" },
  card: CARD(),
}, o);

/** A run whose guide answers the card with `answer`, and a server that answers each route with `result`. */
function approvalRig(answer, result, o = {}) {
  const guide = fakeGuide();
  guide.approve = async (card) => {
    guide.calls.push(["approve", card]);
    return typeof answer === "function" ? answer(card) : answer;
  };
  const routes = [];
  const r = rig(Object.assign({
    guide,
    scripts: [[heardDo("post the summary"), approveEv()]],
    call: async (route) => { routes.push(route); return typeof result === "function" ? result(route) : result; },
    approveElsewhere: () => "I need your OK in Tailzu first.",
  }, o));
  r.routes = routes;
  return r;
}
const run = async (r) => { r.agent.begin({ app: "Slack" }); await r.agent.heard(AUDIO); };
const lastState = (r) => r.guide.of("state").at(-1);

test("approve: the card is drawn as the server sent it, and Approve calls its route", async () => {
  const r = approvalRig("approve", { status: 200, body: { ok: true, result: "Message posted.", task: {} } });
  await run(r);
  const [[, card]] = r.guide.of("approve");
  assert.strictEqual(card.title, "Ready to send?");
  assert.strictEqual(card.preview, "Post message in Slack \u2014 channel: #design");
  assert.deepStrictEqual(card.buttons.map((b) => b.label), ["Approve", "Edit", "Not now"]);
  assert.deepStrictEqual(r.routes, [{ method: "POST", path: "/v1/tasks/t1/approve", body: { approvalId: "ap1" } }]);
  // The result is on the card, after the server's own "Done".
  assert.deepStrictEqual(lastState(r), ["state", "done", "Done \u2713 Message posted."]);
  assert.strictEqual(r.agent.active(), false);
  // Nothing was done on the screen.
  assert.deepStrictEqual(r.driver.calls.filter((c) => c[0] === "press"), []);
});

test("approve: Not now calls the deny route and the card says it was left", async () => {
  const r = approvalRig("deny", { status: 200, body: { ok: true } });
  await run(r);
  assert.deepStrictEqual(r.routes, [{ method: "POST", path: "/v1/tasks/t1/deny", body: {} }]);
  assert.deepStrictEqual(lastState(r), ["state", "done", "Okay, I left it."]);
});

test("approve: no answer calls nothing and leaves the task waiting", async () => {
  const r = approvalRig("", { status: 200, body: {} });
  await run(r);
  assert.deepStrictEqual(r.routes, []);
  assert.deepStrictEqual(lastState(r), ["state", "done", "Okay, I left it."]);
  // A card nobody answers within confirmMs is no answer.
  const slow = approvalRig(() => never(), { status: 200, body: {} }, { knobs: { "desktop.agent.confirmMs": 30 } });
  await run(slow);
  assert.deepStrictEqual(slow.routes, []);
  assert.strictEqual(slow.agent.active(), false);
});

test("approve: a guide that throws, or answers with anything else, is no answer", async () => {
  for (const answer of [() => { throw new Error("gone"); }, "yes", true, undefined]) {
    const r = approvalRig(answer, { status: 200, body: {} });
    await run(r);
    assert.deepStrictEqual(r.routes, [], String(answer));
  }
});

test("approve: Edit says no to this one, then asks what to change and goes on with the reply", async () => {
  const r = approvalRig("edit", { status: 200, body: { ok: true } }, {
    listen: async () => REPLY,
    scripts: [[heardDo("post the summary"), approveEv()], [{ t: "say", text: "Changed." }, { t: "done" }]],
  });
  await run(r);
  assert.deepStrictEqual(r.routes, [{ method: "POST", path: "/v1/tasks/t1/deny", body: {} }]);
  assert.deepStrictEqual(r.guide.of("say")[0].slice(0, 2), ["say", "What should I change?"]);
  const second = r.post.requests[1];
  assert.strictEqual(second.audio, REPLY);
  // The planner is told what was declined, so "make it shorter" has something to change.
  assert.deepStrictEqual(second.req.history.at(-2), { said: "post the summary", did: "EDIT", result: "declined", note: "Post message in Slack \u2014 channel: #design" });
});

test("approve: an app that failed says so in the server's words", async () => {
  const r = approvalRig("approve", { status: 200, body: { ok: false, error: { code: "needs_reconnect", message: "Slack needs you to sign in again." } } });
  await run(r);
  assert.deepStrictEqual(r.guide.of("error").at(-1), ["error", "That didn\u2019t go through. Slack needs you to sign in again."]);
});

test("approve: an answer that came too late shows the server's message", async () => {
  const r = approvalRig("approve", { status: 410, body: { code: "expired", message: "That request expired. Ask me again." } });
  await run(r);
  assert.deepStrictEqual(r.guide.of("error").at(-1), ["error", "That request expired. Ask me again."]);
});

test("approve: a server that cannot be reached is the network's words", async () => {
  const r = approvalRig("approve", { status: 0, body: null });
  await run(r);
  assert.deepStrictEqual(r.guide.of("error").at(-1), ["error", TEXT.network]);
  const gone = approvalRig("approve", () => { throw new Error("offline"); });
  await run(gone);
  assert.deepStrictEqual(gone.guide.of("error").at(-1), ["error", TEXT.network]);
});

test("approve: only this task's own approve and deny routes are ever called", async () => {
  const other = CARD("t2");
  const evil = CARD();
  evil.buttons[0].call.path = "/v1/connectors/notion";
  const odd = CARD();
  odd.buttons[2].call.method = "DELETE";
  const swapped = CARD();
  swapped.buttons[2].call.path = "/v1/tasks/t1/approve";
  for (const [name, card] of [["another task", other], ["another route", evil], ["another method", odd], ["deny that approves", swapped], ["no card", undefined]]) {
    const r = approvalRig("approve", { status: 200, body: { ok: true } }, { scripts: [[heardDo("post"), approveEv({ card })]] });
    await run(r);
    assert.deepStrictEqual(r.routes, [], name);
    assert.deepStrictEqual(r.guide.of("approve"), [], name);
    assert.deepStrictEqual(lastState(r), ["state", "done", "I need your OK in Tailzu first."], name);
  }
  assert.strictEqual(isTaskRoute("/v1/tasks/abc-123/approve"), true);
  for (const bad of ["/v1/tasks/abc/approve/x", "/v1/tasks//deny", "/v1/tasks/a b/deny", "https://evil.test/v1/tasks/a/deny", "/v1/tasks/a/delete"]) assert.strictEqual(isTaskRoute(bad), false, bad);
});

test("approve: the card is cut to what it holds", () => {
  const long = CARD();
  long.preview = "x".repeat(900);
  long.title = "T".repeat(300);
  const c = approvalOf(approveEv({ card: long }));
  assert.strictEqual(c.preview.length, 400);
  assert.strictEqual(c.title.length, 80);
  assert.strictEqual(approvalOf(approveEv({ card: Object.assign(CARD(), { preview: "  " }) })), null);
});

test("approve: the run's deadline does not tick while the card is up", async () => {
  const r = approvalRig(async () => { await sleep(120); return "approve"; }, { status: 200, body: { ok: true, result: "Posted." } },
    { knobs: { "desktop.agent.deadlineMs": 40, "desktop.agent.confirmMs": 1000 } });
  await run(r);
  assert.deepStrictEqual(r.routes.map((x) => x.path), ["/v1/tasks/t1/approve"]);
  assert.deepStrictEqual(lastState(r), ["state", "done", "Done \u2713 Posted."]);
});
