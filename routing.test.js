// node --test
//
// The one key's words, session by session (routing.js): what is pasted as it
// comes, what is held until the stop, what is handed to Ask, notes or a bot,
// and the pill's one-tap fix, each with fakes for main.js's effects.

const test = require("node:test");
const assert = require("node:assert");
const { createRouting, undoCommand } = require("./routing.js");

const tick = () => new Promise((r) => setImmediate(r));
async function settle() { for (let i = 0; i < 6; i++) await tick(); }

function rig(o = {}) {
  const did = [];
  const pills = [];
  let timers = [];
  const knobs = Object.assign({ "desktop.route.labelMs": 5000, "desktop.route.botGraceMs": 3500, "desktop.route.notesGraceMs": 2000 }, o.knobs);
  const pick = (k, f) => (k in knobs ? knobs[k] : f);
  const r = createRouting({
    on: () => o.on !== false,
    signals: () => ({ names: ["X0", "Blip"], askOn: o.askOn !== false, notesOn: !!o.notesOn }),
    type: (sid, chunks) => { did.push(["type", sid, chunks.map((c) => c.text)]); return Promise.resolve(); },
    undo: (n) => { did.push(["undo", n]); return Promise.resolve(); },
    ask: (m) => { did.push(["ask", m]); return o.askTakes !== false; },
    askCancel: () => did.push(["askCancel"]),
    notes: (start) => did.push(["notes", start]),
    whichBot: async (m, slug) => { did.push(["whichBot", m, slug]); if (o.whichBot) return o.whichBot(m, slug); return { slug: "plan", name: "Plan Ease", confidence: 0.9 }; },
    sendBot: async (m, slug) => { did.push(["sendBot", m, slug]); return o.sendBot ? o.sendBot() : { name: "Plan Ease", text: "Saturday is planned." }; },
    botAnswered: (a) => did.push(["answered", a.name, a.text]),
    pill: (state, data) => pills.push([state, data || {}]),
    pillRest: () => pills.push(["rest?"]),
    knobs: { num: pick, bool: pick, txt: (k, f, v) => (v ? f.replace(/\{(\w+)\}/g, (m, n) => v[n] ?? m) : f) },
    setTimeout: (f, ms) => { const t = { f, ms }; timers.push(t); return t; },
    clearTimeout: (t) => { timers = timers.filter((x) => x !== t); },
  });
  /** Run the timers, shortest first (the grace before the label's end). */
  const elapse = () => { const ts = timers.slice().sort((a, b) => a.ms - b.ms); timers = []; for (const t of ts) t.f(); };
  return { r, did, pills, elapse, timers: () => timers, lastPill: () => pills[pills.length - 1] };
}
const BOX = { kind: "text", selection: "" };

test("off (Linux, or the server's switch): every stretch typed, nothing held, nothing said", () => {
  const h = rig({ on: false });
  h.r.start(1, {});
  h.r.field(1, null);
  assert.strictEqual(h.r.chunk(1, { text: "What is this?", heard: "X0 what is this" }), "type");
  assert.strictEqual(h.r.end(1, { text: "Done.", heard: "done" }, true), "type");
  assert.deepStrictEqual(h.did, []);
  assert.deepStrictEqual(h.pills, []);
});

test("a text box and plain words: each stretch pasted as it comes, the stop too, and no label", () => {
  const h = rig();
  h.r.start(1, {});
  h.r.field(1, BOX);
  assert.strictEqual(h.r.chunk(1, { text: "Running late,", heard: "running late" }), "type");
  assert.strictEqual(h.r.chunk(1, { text: "be there in ten.", heard: "be there in ten" }), "type");
  assert.strictEqual(h.r.end(1, { text: "Sorry!", heard: "sorry" }, true), "type");
  assert.deepStrictEqual(h.did, [], "main pastes them; nothing else happens");
  assert.deepStrictEqual(h.pills, []);
});

test("a stretch with nothing in it decides nothing; the next one does", () => {
  const h = rig();
  h.r.start(1, {});
  h.r.field(1, BOX);
  assert.strictEqual(h.r.chunk(1, { text: "", heard: "" }), "type");
  assert.strictEqual(h.r.chunk(1, { text: "", heard: "X0" }), "hold", "the name alone, written as nothing: held");
  assert.strictEqual(h.r.chunk(1, { text: "What is this error?", heard: "what is this error" }), "hold");
});

test("X0 by name: held, then Ask with the name taken off; the pill says so, with Type it instead", async () => {
  const h = rig();
  h.r.start(1, {});
  h.r.field(1, BOX);
  assert.strictEqual(h.r.chunk(1, { text: "", heard: "X0," }), "hold");
  assert.strictEqual(h.r.end(1, { text: "What does this error mean?", heard: "what does this error mean" }, true), "routed");
  await settle();
  assert.deepStrictEqual(h.did, [["ask", "What does this error mean"]]);
  assert.deepStrictEqual(h.pills[0], ["routed", { label: "Asked X0", alt: "Type it instead" }]);
  assert.ok(h.r.holdsPill(), "Ask's card grows from its own seed meanwhile");
  // Type it instead: the question is put away, the written words typed.
  await h.r.alternative();
  assert.deepStrictEqual(h.did.slice(1), [["askCancel"], ["type", 1, ["What does this error mean?"]]]);
  assert.ok(!h.r.holdsPill());
  assert.strictEqual(await h.r.alternative(), false, "once");
});

test("Ask refused (a private window, a bank): its card says why; the label goes", async () => {
  const h = rig({ askTakes: false });
  h.r.start(1, {});
  h.r.field(1, null);
  assert.strictEqual(h.r.end(1, { text: "How far is Goa?", heard: "how far is goa" }, true), "routed");
  await settle();
  assert.deepStrictEqual(h.did, [["ask", "how far is goa"]]);
  assert.deepStrictEqual(h.lastPill(), ["rest?"]);
  assert.ok(!h.r.holdsPill());
});

test("no text box and a sentence: typed after all, said so, and Ask instead takes it back with the app's undo", async () => {
  const h = rig();
  h.r.start(1, {});
  h.r.field(1, null);
  assert.strictEqual(h.r.chunk(1, { text: "Hello there,", heard: "hello there" }), "type");
  assert.strictEqual(h.r.end(1, { text: "how are you", heard: "how are you" }, true), "labelled");
  assert.deepStrictEqual(h.lastPill(), ["routed", { label: "Typed", alt: "Ask instead" }]);
  await h.r.alternative();
  assert.deepStrictEqual(h.did, [["undo", 2], ["ask", "hello there how are you"]]);
  // Asked now, and the pill offers to type it again.
  assert.deepStrictEqual(h.lastPill(), ["routed", { label: "Asked X0", alt: "Type it instead" }]);
  await h.r.alternative();
  assert.deepStrictEqual(h.did.slice(2), [["askCancel"], ["type", 1, ["Hello there,", "how are you"]]]);
});

test("typed too much to take back cleanly: no alternative offered", () => {
  const h = rig({ knobs: { "desktop.route.undoMaxPastes": 2 } });
  h.r.start(1, {});
  h.r.field(1, null);
  for (const w of ["One.", "Two.", "Three."]) h.r.chunk(1, { text: w, heard: w });
  assert.strictEqual(h.r.end(1, { text: "Four.", heard: "four" }, true), "type");
  assert.deepStrictEqual(h.pills, []);
});

test("a late answer from an older session is pasted without a label", () => {
  const h = rig();
  h.r.start(1, {});
  h.r.field(1, null);
  assert.strictEqual(h.r.end(1, { text: "Hello.", heard: "hello" }, false), "type");
  assert.deepStrictEqual(h.pills, []);
});

test("held, and routed to typing after all (X0, reply …): the held stretches pasted in order", async () => {
  const h = rig();
  h.r.start(1, {});
  h.r.field(1, BOX);
  assert.strictEqual(h.r.chunk(1, { text: "Sure,", heard: "X0 reply saying sure" }), "hold");
  assert.strictEqual(h.r.end(1, { text: "see you at six.", heard: "see you at six" }, true), "routed");
  await settle();
  assert.deepStrictEqual(h.did[0], ["type", 1, ["Sure,", "see you at six."]]);
  assert.deepStrictEqual(h.lastPill(), ["routed", { label: "Typed", alt: "Ask instead" }], "addressed: a close call, said");
});

test("take notes: held a moment so Type it instead is simply not starting them; then started", async () => {
  const h = rig();
  h.r.start(1, {});
  h.r.field(1, BOX);
  assert.strictEqual(h.r.end(1, { text: "Take notes.", heard: "take notes" }, true), "routed");
  await settle();
  assert.deepStrictEqual(h.did, []);
  assert.deepStrictEqual(h.lastPill(), ["routed", { label: "Taking notes", alt: "Type it instead" }]);
  h.elapse();
  assert.deepStrictEqual(h.did, [["notes", true]]);
  assert.deepStrictEqual(h.pills.slice(-2), [["routed", { label: "Taking notes", alt: "" }], ["rest?"]]);
  assert.strictEqual(await h.r.alternative(), false, "gone out: nothing to take back");
  // And the alternative in time: typed, notes never started.
  const t = rig();
  t.r.start(2, {});
  t.r.field(2, BOX);
  t.r.end(2, { text: "Stop meeting notes.", heard: "stop meeting notes" }, true);
  await settle();
  await t.r.alternative();
  t.elapse();
  assert.deepStrictEqual(t.did, [["type", 2, ["Stop meeting notes."]]]);
});

test("a new dictation sends what was waiting at once", async () => {
  const h = rig();
  h.r.start(1, {});
  h.r.field(1, BOX);
  h.r.end(1, { text: "Take notes.", heard: "take notes" }, true);
  await settle();
  h.r.start(2, {});
  assert.deepStrictEqual(h.did, [["notes", true]]);
  assert.ok(!h.r.holdsPill());
});

test("a bot's task with no text box: the backend picks the bot, the pill names it, it goes after a moment, and the answer is said", async () => {
  const h = rig();
  h.r.start(1, {});
  h.r.field(1, null);
  assert.strictEqual(h.r.chunk(1, { text: "Plan my Saturday.", heard: "plan my saturday" }), "hold");
  assert.strictEqual(h.r.end(1, { text: "", heard: "" }, true), "routed");
  await settle();
  // Not named: the backend's own pick, not this file's guess.
  assert.deepStrictEqual(h.did, [["whichBot", "plan my saturday", undefined]]);
  assert.deepStrictEqual(h.lastPill(), ["routed", { label: "Sent to Plan Ease", alt: "Type it instead" }]);
  h.elapse();
  await settle();
  assert.deepStrictEqual(h.did.slice(1), [["sendBot", "plan my saturday", "plan"], ["answered", "Plan Ease", "Saturday is planned."]]);
});

test("Type it instead in time: the bot is never asked; the words are typed", async () => {
  const h = rig();
  h.r.start(1, {});
  h.r.field(1, null);
  h.r.end(1, { text: "Book a flight to Goa.", heard: "book a flight to goa" }, true);
  await settle();
  await h.r.alternative();
  h.elapse();
  await settle();
  assert.deepStrictEqual(h.did.map((d) => d[0]), ["whichBot", "type"]);
  assert.deepStrictEqual(h.did[1], ["type", 1, ["Book a flight to Goa."]]);
});

test("the bot could not be reached: the pill says so", async () => {
  const h = rig({ sendBot: () => { throw new Error("503"); } });
  h.r.start(1, {});
  h.r.field(1, null);
  h.r.end(1, { text: "Plan my day.", heard: "plan my day" }, true);
  await settle();
  h.elapse();
  await settle();
  assert.deepStrictEqual(h.pills.find((p) => p[0] === "error"), ["error", { label: "Couldn't reach your bots" }]);
});

test("unclear (a command, no text box): the backend's pick when it is sure, else Ask", async () => {
  const sure = rig({ whichBot: () => ({ slug: "travel", name: "Travel bot", confidence: 0.8 }) });
  sure.r.start(1, {});
  sure.r.field(1, null);
  sure.r.end(1, { text: "Open Gmail.", heard: "open gmail" }, true);
  await settle();
  assert.deepStrictEqual(sure.did, [["whichBot", "open gmail", undefined]]);
  assert.deepStrictEqual(sure.lastPill()[1].label, "Sent to Travel bot");
  for (const who of [{ slug: "travel", name: "Travel bot", confidence: 0.3 }, { slug: "tailzu", name: "X0", confidence: 1 }, null, () => { throw new Error("offline"); }]) {
    const h = rig({ whichBot: typeof who === "function" ? who : () => who });
    h.r.start(1, {});
    h.r.field(1, null);
    h.r.end(1, { text: "Open Gmail.", heard: "open gmail" }, true);
    await settle();
    assert.deepStrictEqual(h.did[1], ["ask", "open gmail"], JSON.stringify(who));
  }
  // Ask off too: typed.
  const off = rig({ askOn: false, whichBot: () => null });
  off.r.start(1, {});
  off.r.field(1, null);
  off.r.end(1, { text: "Open Gmail.", heard: "open gmail" }, true);
  await settle();
  assert.deepStrictEqual(off.did[1], ["type", 1, ["Open Gmail."]]);
});

test("typed into a text box but a bot's task: said, with Send to a bot, which takes it back and asks the backend", async () => {
  const h = rig();
  h.r.start(1, {});
  h.r.field(1, BOX);
  assert.strictEqual(h.r.chunk(1, { text: "Plan my Saturday.", heard: "plan my saturday" }), "type");
  assert.strictEqual(h.r.end(1, { text: "", heard: "" }, true), "labelled");
  assert.deepStrictEqual(h.lastPill(), ["routed", { label: "Typed", alt: "Send to a bot" }]);
  await h.r.alternative();
  await settle();
  assert.deepStrictEqual(h.did.slice(0, 2), [["undo", 1], ["whichBot", "plan my saturday", undefined]]);
});

test("a bot by name: the backend is told which, so it is that bot", async () => {
  const h = rig({ whichBot: (m, slug) => ({ slug, name: "Xode", confidence: 1 }) });
  h.r.start(1, {});
  h.r.field(1, BOX);
  h.r.end(1, { text: "Xode, fix the build.", heard: "code bot fix the build" }, true);
  await settle();
  assert.deepStrictEqual(h.did, [["whichBot", "code bot fix the build", "code"]]);
  h.elapse();
  await settle();
  assert.deepStrictEqual(h.did[1], ["sendBot", "code bot fix the build", "code"]);
});

test("a selection and an instruction: the server's rewrite, pasted as it comes", () => {
  const h = rig();
  h.r.start(1, {});
  h.r.field(1, { kind: "text", selection: "The numbers were up." });
  assert.strictEqual(h.r.end(1, { text: "Numbers: up.", heard: "make this shorter" }, true), "type");
  assert.deepStrictEqual(h.pills, []);
});

test("the label goes by itself, and a forgotten session leaves nothing behind", () => {
  const h = rig();
  h.r.start(1, {});
  h.r.field(1, null);
  h.r.end(1, { text: "Hello.", heard: "hello" }, true);
  assert.ok(h.r.holdsPill());
  h.elapse();
  assert.ok(!h.r.holdsPill());
  assert.deepStrictEqual(h.lastPill(), ["rest?"]);
  h.r.start(2, {});
  h.r.field(2, null);
  h.r.chunk(2, { text: "What is this?", heard: "what is this" });
  h.r.forget(2);
  assert.strictEqual(h.r.end(2, { text: "x", heard: "x" }, true), "type");
});

test("labels off: nothing is said, a held action still goes", async () => {
  const h = rig({ knobs: { "desktop.route.labels": false } });
  h.r.start(1, {});
  h.r.field(1, null);
  assert.strictEqual(h.r.end(1, { text: "Hello.", heard: "hello" }, true), "type");
  h.r.start(2, {});
  h.r.field(2, BOX);
  h.r.end(2, { text: "Take notes.", heard: "take notes" }, true);
  await settle();
  assert.ok(!h.pills.some((p) => p[0] === "routed"));
  h.elapse();
  assert.deepStrictEqual(h.did, [["notes", true]]);
});

test("the app's own undo, the way each system pastes", () => {
  const [mac, macArgs] = undoCommand("darwin", 2);
  assert.strictEqual(mac, "osascript");
  assert.ok(macArgs.includes("repeat 2 times") && macArgs.includes('keystroke "z" using command down'));
  const [win, winArgs] = undoCommand("win32", 3);
  assert.strictEqual(win, "powershell");
  assert.match(winArgs[winArgs.length - 1], /1\.\.3 \| ForEach-Object \{ \[System\.Windows\.Forms\.SendKeys\]::SendWait\('\^z'\)/);
  assert.deepStrictEqual(undoCommand("linux", 1), ["xdotool", ["key", "--clearmodifiers", "--repeat", "1", "--delay", "50", "ctrl+z"]]);
  // Kept between one and ten, whole.
  assert.ok(undoCommand("darwin", 0)[1].includes("repeat 1 times"));
  assert.ok(undoCommand("darwin", 99)[1].includes("repeat 10 times"));
  assert.ok(undoCommand("darwin", "2; do shell script")[1].includes("repeat 1 times"));
});

test("a held session answered after the next dictation began: done at once, the new dictation's pill left alone", async () => {
  const h = rig();
  h.r.start(1, {});
  h.r.field(1, BOX);
  h.r.chunk(1, { text: "", heard: "take notes" });
  h.r.start(2, {});                       // pressed again before the answer came
  assert.strictEqual(h.r.end(1, { text: "", heard: "" }, false), "routed");
  await settle();
  assert.deepStrictEqual(h.did, [["notes", true]]);
  assert.deepStrictEqual(h.pills, []);
  assert.ok(!h.r.holdsPill());
});

test("nothing was typed (the writer wrote nothing): no label offering to take it back", () => {
  const h = rig();
  h.r.start(1, {});
  h.r.field(1, null);
  h.r.chunk(1, { text: "", heard: "hmm" });
  assert.strictEqual(h.r.end(1, { text: "", heard: "okay" }, true), "type");
  assert.deepStrictEqual(h.pills, []);
});
