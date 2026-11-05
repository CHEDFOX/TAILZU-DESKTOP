// node --test
//
// The window's own voice (windowVoice.js), with fakes for main.js's effects: a hold, a free turn, a chat turn after
// turn, quiet, the ends, the whole turn's words, and the recorder's messages that are not its own.

const test = require("node:test");
const assert = require("node:assert");
const { createWindowVoice, extend } = require("./windowVoice.js");

const tick = () => new Promise((r) => setImmediate(r));
async function settle() { for (let i = 0; i < 6; i++) await tick(); }

function rig(o = {}) {
  const did = [];
  const sent = [];
  let timers = [];
  let clock = 1000;
  let seq = 100;
  const knobs = Object.assign({}, o.knobs);
  const pick = (k, f) => (k in knobs ? knobs[k] : f);
  const v = createWindowVoice({
    nextSession: () => ++seq,
    record: (sid, opt) => did.push(["record", sid, opt.pauseEndMs]),
    stopRecording: (sid) => did.push(["stop", sid]),
    cancelRecording: (sid) => did.push(["cancel", sid]),
    send: (m) => sent.push(Object.assign({}, m)),
    requireAccount: () => o.signedIn !== false,
    blocked: () => o.blocked === true,
    changed: () => did.push(["changed"]),
    knobs: { num: pick, bool: pick, txt: (k, f) => f },
    now: () => clock,
    setTimeout: (f, ms) => { const tm = { f, at: clock + ms }; timers.push(tm); return tm; },
    clearTimeout: (tm) => { timers = timers.filter((x) => x !== tm); },
  });
  const wait = async (ms) => {
    const until = clock + ms;
    for (;;) {
      const due = timers.filter((x) => x.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((x) => x !== due);
      clock = due.at;
      due.f();
      await settle();
    }
    clock = until;
    await settle();
  };
  const sid = () => did.filter((x) => x[0] === "record").map((x) => x[1]).slice(-1)[0];
  const kinds = () => sent.map((m) => m.kind);
  const of = (kind) => sent.filter((m) => m.kind === kind);
  /** The recorder hears `words`, pauses, and its clip and final text come back. */
  const speak = async (words, paused = true) => {
    const s = sid();
    v.partial({ session: s, text: words });
    if (paused) v.paused({ session: s });
    v.audioIn({ session: s, text: words });
    v.textIn({ session: s, text: words });
    await settle();
  };
  return { v, did, sent, wait, sid, kinds, of, speak, tick: (ms) => { clock += ms; } };
}

test("a hold: listening while it is held, pauses and all; the words go once, at the release", async () => {
  const r = rig();
  assert.strictEqual(r.v.start("hold", "key"), true);
  assert.deepStrictEqual(r.sent[0], { kind: "listen", session: 1, mode: "hold", by: "key" });
  const s = r.sid();
  assert.deepStrictEqual(r.did.filter((x) => x[0] === "record"), [["record", s, 900]], "the ask mode's pause is about 0.9 s");
  r.v.partial({ session: s, text: "remind me" });
  r.v.paused({ session: s });
  assert.strictEqual(r.v.phase(), "listening", "a pause while it is held does not end the turn");
  r.v.partial({ session: s, text: "remind me to call Nani at six" });
  assert.deepStrictEqual(r.of("words").map((m) => m.text), ["remind me", "remind me to call Nani at six"]);
  // Nobody hurries a hold: no quiet end.
  await r.wait(30000);
  assert.strictEqual(r.v.active(), true);
  r.v.finish();
  assert.deepStrictEqual(r.did.filter((x) => x[0] === "stop"), [["stop", s]]);
  r.v.audioIn({ session: s, text: "remind me to call Nani at six" });
  r.v.textIn({ session: s, text: "Remind me to call Nani at six." });
  await settle();
  assert.deepStrictEqual(r.of("heard"), [{ kind: "heard", session: 1, text: "Remind me to call Nani at six." }]);
  assert.strictEqual(r.v.phase(), "waiting");
  assert.strictEqual(r.v.listening(), false, "the microphone is closed while the window sends them");
  assert.strictEqual(r.v.again(1), false, "a hold is one turn");
  r.v.end("tap");
  assert.deepStrictEqual(r.sent.slice(-1)[0], { kind: "end", session: 1, why: "tap" });
  assert.deepStrictEqual(r.did.filter((x) => x[0] === "cancel"), [], "nothing to cancel: the turn was over");
});

test("a held press that was short is a tap: hands-free until the first pause", async () => {
  const r = rig();
  r.v.start("hold", "key");
  r.v.free();
  assert.strictEqual(r.v.mode(), "free");
  await r.speak("what's on tomorrow");
  assert.deepStrictEqual(r.of("heard").map((m) => m.text), ["what's on tomorrow"]);
});

test("free: the first pause ends the turn; the next tap does too", async () => {
  const r = rig();
  r.v.start("free", "key");
  await r.speak("plan my saturday");
  assert.deepStrictEqual(r.of("heard").map((m) => m.text), ["plan my saturday"]);
  r.v.end("tap");
  const t = rig();
  t.v.start("free", "key");
  t.v.partial({ session: t.sid(), text: "plan my" });
  t.v.finish();
  t.v.audioIn({ session: t.sid(), text: "plan my" });
  await t.wait(400);
  assert.deepStrictEqual(t.of("heard").map((m) => m.text), ["plan my"], "the final text did not come: the clip's words go");
});

test("a chat: turn after turn; the window says again after each, and the key held takes a turn", async () => {
  const r = rig();
  r.v.start("chat", "click", { silenceMs: 700 });
  assert.deepStrictEqual(r.did.filter((x) => x[0] === "record").map((x) => x[2]), [700], "the screen's own pause");
  await r.speak("what's on tomorrow");
  assert.deepStrictEqual(r.of("heard").map((m) => m.text), ["what's on tomorrow"]);
  assert.strictEqual(r.v.again(99), false, "another session's again: nothing");
  assert.strictEqual(r.v.again(1), true);
  assert.strictEqual(r.v.phase(), "listening");
  await r.speak("move the dentist to friday");
  assert.deepStrictEqual(r.of("heard").map((m) => m.text), ["what's on tomorrow", "move the dentist to friday"]);
  assert.strictEqual(r.v.hold(), true, "waiting: the key held opens the next turn now");
  const s = r.sid();
  r.v.partial({ session: s, text: "and lunch" });
  r.v.paused({ session: s });
  assert.strictEqual(r.v.phase(), "listening", "held: the pause does not end it");
  r.v.release();
  assert.strictEqual(r.v.phase(), "hearing");
  await r.speak("and lunch", false);
  assert.deepStrictEqual(r.of("heard").map((m) => m.text).slice(-1), ["and lunch"]);
  r.v.end("tap");
  assert.deepStrictEqual(r.kinds().filter((k) => k === "listen"), ["listen"], "one listen: the session's own");
});

test("quiet: nobody speaks on the first turn (8 s) or between chat turns (12 s), and it ends", async () => {
  const r = rig();
  r.v.start("chat", "click");
  await r.wait(7900);
  assert.strictEqual(r.v.active(), true);
  await r.wait(200);
  assert.strictEqual(r.v.active(), false);
  assert.deepStrictEqual(r.sent.slice(-1)[0], { kind: "end", session: 1, why: "quiet" });
  assert.deepStrictEqual(r.did.filter((x) => x[0] === "cancel"), [["cancel", r.sid()]], "the microphone closes");

  const c = rig();
  c.v.start("chat", "click");
  await c.speak("hi there");
  c.v.again(1);
  await c.wait(11000);
  assert.strictEqual(c.v.active(), true);
  // A voice over the level counts as speaking.
  c.v.level({ session: c.sid(), bands: [0.1, 0.5] });
  await c.wait(5000);
  assert.strictEqual(c.v.active(), true);
});

test("nothing said in a turn: listening again (free), or the end (hold)", async () => {
  const r = rig();
  r.v.start("once", "click");
  const first = r.sid();
  r.v.paused({ session: first });
  r.v.audioIn({ session: first, text: "" });
  r.v.textIn({ session: first, text: "" });
  await settle();
  assert.strictEqual(r.v.phase(), "listening");
  assert.notStrictEqual(r.sid(), first, "a new recording");
  const h = rig();
  h.v.start("hold", "key");
  h.v.finish();
  h.v.audioIn({ session: h.sid(), text: "" });
  h.v.textIn({ session: h.sid(), text: "" });
  await settle();
  assert.strictEqual(h.v.active(), false);
  assert.strictEqual(h.sent.slice(-1)[0].why, "quiet");
});

test("the turn's words are the whole turn: every segment the recorder heard, in order", async () => {
  // The recorder's preview carries its finals and then the partial (recorder/live.js previewText).
  const r = rig();
  r.v.start("hold", "key");
  const s = r.sid();
  for (const t of ["pick up", "pick up the milk", "pick up the milk and", "pick up the milk and bread on the way"]) r.v.partial({ session: s, text: t });
  // A stream that began again: what was heard is kept in front of it.
  r.v.partial({ session: s, text: "home" });
  assert.deepStrictEqual(r.of("words").map((m) => m.text).slice(-1), ["pick up the milk and bread on the way home"]);
  r.v.finish();
  r.v.audioIn({ session: s, text: "" });
  await r.wait(400);
  assert.deepStrictEqual(r.of("heard").map((m) => m.text), ["pick up the milk and bread on the way home"]);
  // A revision of the last words replaces them; an empty preview never wipes what was heard.
  assert.strictEqual(extend("I want to", "I want two"), "I want two");
  assert.strictEqual(extend("send it to mom", ""), "send it to mom");
  assert.strictEqual(extend("", "hello"), "hello");
});

test("the level goes to the window at most 30 times a second, and only while he listens", () => {
  const r = rig();
  r.v.start("once", "click");
  const s = r.sid();
  r.v.level({ session: s, bands: [0.2, 0.9, 0.1] });
  r.v.level({ session: s, bands: [0.2, 0.5] });
  r.tick(40);
  r.v.level({ session: s, bands: [0.4] });
  assert.deepStrictEqual(r.of("level").map((m) => m.v), [0.9, 0.4]);
});

test("ends: Esc, a chord, an error (blocked or not), the recorder gone, the ceiling; each drops the turn and says why", async () => {
  for (const why of ["esc", "chord", "blur", "dictation"]) {
    const r = rig();
    r.v.start("chat", "key");
    r.v.partial({ session: r.sid(), text: "half a sente" });
    assert.strictEqual(r.v.end(why), true);
    assert.deepStrictEqual(r.did.filter((x) => x[0] === "cancel"), [["cancel", r.sid()]], why);
    assert.deepStrictEqual(r.sent.slice(-1)[0], { kind: "end", session: 1, why });
    assert.deepStrictEqual(r.of("heard"), [], why + ": nothing sent");
    assert.strictEqual(r.v.end(why), false, "once");
  }
  const e = rig({ blocked: false });
  e.v.start("once", "click");
  e.v.error({ session: e.sid(), message: "microphone is in use by another app" });
  assert.deepStrictEqual(e.of("error"), [{ kind: "error", session: 1, message: "microphone is in use by another app", blocked: false }]);
  assert.strictEqual(e.sent.slice(-1)[0].why, "error");
  const g = rig();
  g.v.start("once", "click");
  g.v.recorderGone();
  assert.strictEqual(g.v.active(), false);
  // The ceiling (20 minutes): a key held that long is let go.
  const m = rig({ knobs: { "desktop.window.turnMaxMs": 30 * 60 * 1000 } });
  m.v.start("hold", "key");
  await m.wait(20 * 60 * 1000);
  assert.strictEqual(m.v.active(), false);
  assert.strictEqual(m.sent.slice(-1)[0].why, "max");
});

test("refused: one already on, signed out, the microphone not allowed, switched off; the window is told at once", () => {
  const r = rig();
  r.v.start("once", "click");
  assert.strictEqual(r.v.start("chat", "key"), false, "one already on");
  const out = rig({ signedIn: false });
  assert.strictEqual(out.v.start("once", "click"), false);
  assert.deepStrictEqual(out.sent, [{ kind: "end", session: 1, why: "error" }]);
  assert.deepStrictEqual(out.did.filter((x) => x[0] === "record"), []);
  const b = rig({ blocked: true });
  assert.strictEqual(b.v.start("once", "click"), false);
  assert.deepStrictEqual(b.sent, [{ kind: "error", session: 1, message: "", blocked: true }, { kind: "end", session: 1, why: "error" }]);
  const off = rig({ knobs: { "desktop.window.voice": false } });
  assert.strictEqual(off.v.start("once", "click"), false);
  assert.deepStrictEqual(off.did.filter((x) => x[0] === "record"), []);
});

test("a recorder message that is not its own is not taken", () => {
  const r = rig();
  const other = { session: 9, text: "x", bands: [1] };
  for (const f of ["partial", "level", "paused", "audioIn", "textIn", "error"]) assert.strictEqual(r.v[f](other), false, f + " with none on");
  r.v.start("once", "click");
  for (const f of ["partial", "level", "paused", "audioIn", "textIn", "error"]) assert.strictEqual(r.v[f](other), false, f);
  assert.strictEqual(r.v.active(), true);
  assert.deepStrictEqual(r.of("words"), []);
});
