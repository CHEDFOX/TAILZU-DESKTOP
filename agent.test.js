// node --test
//
// A whole Ask run is a conversation between four things that are not here —
// the accessibility helper, the guide window, the server and the person — so
// each is a fake that records what it was asked and answers from a script:
//
//   driver  a queue of snapshots (the last one repeats) and canned answers
//   guide   records every call; confirm answers yes, no, or never
//   post    one list of events per step, with optional gates to hold the
//           stream open mid-way; records every request it was sent
//
// Nothing in this file touches Electron, a screen or the network.

const test = require("node:test");
const assert = require("node:assert");
const {
  createAgent, classifyRisk, maxRisk, regionOf, toRequestElements, frameMap, describeChange,
  readEvents, makePost, TEXT,
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

function fakeDriver(snaps, results) {
  const calls = [];
  let n = 0;
  const drv = { calls };
  drv.snapshot = async (opts) => {
    calls.push(["snapshot", opts]);
    const s = snaps[Math.min(n, snaps.length - 1)];
    n++;
    return typeof s === "function" ? s(n) : s;
  };
  for (const m of ["press", "click", "setValue", "focus", "scroll", "key", "open"]) {
    drv[m] = async (...args) => {
      calls.push([m, ...args]);
      const r = results && results[m];
      return typeof r === "function" ? r(...args) : r || { ok: true };
    };
  }
  /** Everything but the snapshots. */
  drv.acts = () => calls.filter((c) => c[0] !== "snapshot");
  drv.snapshots = () => calls.filter((c) => c[0] === "snapshot").length;
  return drv;
}

function fakeGuide(confirm) {
  const calls = [];
  const g = { calls };
  for (const m of ["show", "state", "heard", "say", "point", "unpoint", "steps", "hide", "error"]) {
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
  async function* post(req, audio, signal) {
    requests.push({ req: JSON.parse(JSON.stringify(req)), audio, signal });
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
  const driver = fakeDriver(o.snaps || [SLACK], o.results);
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
  }
});

test("set in a native app writes the value, and falls back to paste when that fails", async () => {
  const NOTES = snap([{ id: "e1", role: "field", label: "Title", value: "", frame: [10, 10, 300, 20] }], { app: { name: "TextEdit", pid: 7 } });
  const ok = rig({ snaps: [NOTES], scripts: [[heardDo("title it Plan"), { t: "action", kind: "set", id: "e1", text: "Plan", risk: "free" }], [{ t: "done" }]] });
  ok.agent.begin({ app: "TextEdit" });
  await ok.agent.heard(AUDIO);
  assert.deepStrictEqual(ok.driver.acts(), [["setValue", "e1", "Plan"]]);
  assert.deepStrictEqual(ok.pasted, []);

  const bad = rig({
    snaps: [NOTES],
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

test("toRequestElements caps the list at max, and never above 250", () => {
  const many = Array.from({ length: 300 }, (_, i) => ({ id: `e${i + 1}`, role: "text", label: `t${i}` }));
  assert.strictEqual(toRequestElements(snap(many), 10).length, 10);
  assert.strictEqual(toRequestElements(snap(many), 1000).length, 250);
  assert.strictEqual(toRequestElements(snap(many)).length, 250);
  assert.deepStrictEqual(toRequestElements({ ok: false, error: "x" }), []);
  assert.deepStrictEqual(toRequestElements(null), []);
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
