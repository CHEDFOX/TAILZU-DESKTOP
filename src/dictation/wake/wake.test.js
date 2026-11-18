// node --test
//
// "Hey X0": when a heard word is really them, and when it is the television.
// The policy only — nothing here opens a microphone.
const test = require("node:test");
const assert = require("node:assert");
const { makeWake, DEFAULTS } = require("./wake.js");

/** A wake with a clock a test moves by hand, listening and otherwise unblocked. */
function rig(settings) {
  let t = 1_000_000;
  const w = makeWake({ now: () => t, ...(settings ? { settings } : {}) });
  w.context({ on: true });
  return { w, move: (ms) => { t += ms; }, at: () => t };
}

test("it is off until the person turns it on: asking for a microphone is not permission to listen all day", () => {
  let t = 0;
  const w = makeWake({ now: () => t });
  assert.strictEqual(w.state().on, false);
  assert.strictEqual(w.state().reason, "off");
  // Even a certain hit does nothing.
  assert.strictEqual(w.heard(1), "ignored");
  w.context({ on: true });
  assert.strictEqual(w.state().on, true);
  assert.strictEqual(w.heard(1), "fire");
});

test("a sure hit fires; a quiet one is nothing at all", () => {
  const { w } = rig();
  assert.strictEqual(w.heard(DEFAULTS.sureHeard), "fire");
  const b = rig();
  assert.strictEqual(b.w.heard(DEFAULTS.minHeard - 0.01), "ignored");
  assert.strictEqual(b.w.state().on, true, "a hit too quiet to count leaves it listening");
});

test("a middling hit waits for speech, and speech within the window starts it", () => {
  const { w, move } = rig();
  assert.strictEqual(w.heard(0.6), "waiting");
  assert.strictEqual(w.state().phase, "waiting");
  move(DEFAULTS.confirmMs - 1);
  assert.strictEqual(w.speech(), "fire");
});

test("a middling hit with no speech after it lapses, and the television is not answered", () => {
  const { w, move } = rig();
  assert.strictEqual(w.heard(0.6), "waiting");
  move(DEFAULTS.confirmMs + 1);
  assert.strictEqual(w.tick(), "lapsed");
  assert.strictEqual(w.state().phase, "idle");
  // Speech long after the word means nothing: the moment has gone.
  assert.strictEqual(w.speech(), "ignored");
});

test("speech on its own can never start anything: it only ever confirms a word", () => {
  const { w } = rig();
  assert.strictEqual(w.speech(), "ignored");
  assert.strictEqual(w.speech(), "ignored");
});

test("after a start it is deaf for a moment, so saying the name twice is one start", () => {
  const { w, move } = rig();
  assert.strictEqual(w.heard(1), "fire");
  assert.strictEqual(w.heard(1), "ignored", "a second hit inside the cooldown");
  move(DEFAULTS.cooldownMs - 1);
  assert.strictEqual(w.heard(1), "ignored");
  move(2);
  assert.strictEqual(w.heard(1), "fire", "and it listens again after it");
});

test("the brake: a programme that keeps saying the name makes it rest, and say why", () => {
  const { w, move } = rig();
  // Each hit is loud enough to count. The cooldown swallows the fires; the brake counts them all the same.
  for (let i = 0; i <= DEFAULTS.restAfter; i += 1) { w.heard(0.9); move(100); }
  const st = w.state();
  assert.strictEqual(st.on, false);
  assert.strictEqual(st.reason, "resting");
  assert.match(st.why, /false starts/);
  assert.strictEqual(w.heard(1), "ignored");
  // It comes back by itself.
  move(DEFAULTS.restMs + 1);
  assert.strictEqual(w.state().on, true);
  assert.strictEqual(w.heard(1), "fire");
});

test("hits too quiet to count never feed the brake, or noise alone would rest it all day", () => {
  const { w, move } = rig();
  for (let i = 0; i < DEFAULTS.restAfter * 5; i += 1) { w.heard(DEFAULTS.minHeard - 0.1); move(100); }
  assert.strictEqual(w.state().on, true);
  assert.strictEqual(w.state().reason, null);
});

test("hits spread out beyond the watch window do not add up", () => {
  const { w, move } = rig();
  for (let i = 0; i <= DEFAULTS.restAfter + 2; i += 1) { w.heard(0.9); move(DEFAULTS.watchMs + 1); }
  assert.strictEqual(w.state().on, true, "a name heard once a minute all day is not a television");
});

test("one microphone: it will not fire while a dictation, Ask or a call has it", () => {
  for (const busy of ["recording", "askUp", "callUp"]) {
    const { w } = rig();
    w.context({ [busy]: true });
    assert.strictEqual(w.state().on, false, busy);
    assert.strictEqual(w.heard(1), "ignored", busy);
    w.context({ [busy]: false });
    assert.strictEqual(w.heard(1), "fire", busy);
  }
});

test("it will not listen in an app that is off limits, or on a locked machine", () => {
  for (const no of ["offLimits", "locked"]) {
    const { w } = rig();
    w.context({ [no]: true });
    assert.strictEqual(w.heard(1), "ignored", no);
    assert.strictEqual(w.state().reason, no === "offLimits" ? "limits" : "locked");
  }
});

test("a word waiting for speech is dropped when the microphone goes to something else", () => {
  const { w } = rig();
  assert.strictEqual(w.heard(0.6), "waiting");
  // A dictation starts in the gap. By the time they speak, the microphone is not ours to take.
  w.context({ recording: true });
  assert.strictEqual(w.speech(), "ignored");
  w.context({ recording: false });
  assert.strictEqual(w.state().phase, "idle");
  assert.strictEqual(w.speech(), "ignored", "and the dropped word cannot be confirmed late");
});

test("the person's switch is read before everything else, so 'off' is the reason even in a busy moment", () => {
  let t = 0;
  const w = makeWake({ now: () => t });
  w.context({ recording: true, offLimits: true });
  assert.strictEqual(w.state().reason, "off");
});

test("reset forgets the brake and anything half-heard", () => {
  const { w } = rig();
  for (let i = 0; i <= DEFAULTS.restAfter; i += 1) w.heard(0.9);
  assert.strictEqual(w.state().reason, "resting");
  w.reset();
  assert.strictEqual(w.state().on, true);
  assert.strictEqual(w.heard(1), "fire");
});

test("its settings are knobs, and a nonsense one falls back to the default", () => {
  const { w } = rig({ sureHeard: 0.5, cooldownMs: "soon", minHeard: null });
  // sureHeard honoured…
  assert.strictEqual(w.heard(0.5), "fire");
  // …and the bad ones ignored, so the cooldown is still the default's length.
  assert.strictEqual(w.heard(1), "ignored");
});
