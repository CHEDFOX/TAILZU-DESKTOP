// node --test
//
// Talk mode (talk.js): turn after turn with fakes for main.js's effects; the
// stream read however it is cut; the ends (quiet, the ceiling, a tap or Esc,
// errors); barge-in; each handoff; and no screen from a private window.

const test = require("node:test");
const assert = require("node:assert");
const { createTalk, gestureFor, sentences, MOOD_GESTURE } = require("./talk.js");

const tick = () => new Promise((r) => setImmediate(r));
async function settle() { for (let i = 0; i < 12; i++) await tick(); }

/** A body that yields these chunks, as a fetch body read in pieces. */
function body(chunks) {
  return { async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; } };
}
const ok = (chunks) => ({ ok: true, status: 200, body: body(chunks) });
const lines = (...evs) => evs.map((e) => JSON.stringify(e) + "\n");
/** A body whose chunks are pushed by the test, for a turn still streaming. */
function gate() {
  const q = [];
  let wake = null, closed = false;
  return {
    push(c) { q.push(c); if (wake) { const w = wake; wake = null; w(); } },
    close() { closed = true; if (wake) { const w = wake; wake = null; w(); } },
    res: { ok: true, status: 200, body: { async *[Symbol.asyncIterator]() {
      for (;;) {
        while (q.length) yield q.shift();
        if (closed) return;
        await new Promise((r) => { wake = r; });
      }
    } } },
  };
}

function rig(o = {}) {
  const did = [];
  const pills = [];
  const posts = [];
  let timers = [];
  let clock = 1000;
  let seq = 0;
  let askBusy = false;
  const replies = (o.replies || []).slice();
  const knobs = Object.assign({}, o.knobs);
  const pick = (k, f) => (k in knobs ? knobs[k] : f);
  const t = createTalk({
    id: () => "talk-1",
    nextSession: () => ++seq,
    record: (sid, opt) => did.push(opt && opt.watch ? ["watch", sid] : ["record", sid]),
    stopRecording: (sid) => did.push(["stop", sid]),
    cancelRecording: (sid) => did.push(["cancel", sid]),
    front: async () => ("front" in o ? o.front : { label: "Notes", title: "Shopping list", private: false, sensitive: false }),
    field: async () => ("field" in o ? o.field : { selection: "milk" }),
    ours: () => !!o.ours,
    pageFor: async (info) => { did.push(["pageFor", info.label]); return o.page || null; },
    grants: () => o.grants,
    post: async (path, b, opt) => {
      posts.push([path, b]);
      if (path === "/v1/talk/stop") return { ok: true, status: 200 };
      const next = replies.length ? replies.shift() : ok(lines({ t: "text", text: "Sure." }, { t: "done", text: "Sure." }));
      return typeof next === "function" ? next(b, opt) : next;
    },
    voice: async (text, opt) => ({ text, lang: opt.lang }),
    play: (m) => { did.push(["say", m.text]); return o.play ? o.play(m) : Promise.resolve(); },
    hush: () => did.push(["hush"]),
    pill: (st, data) => pills.push([st, Object.assign({}, data)]),
    pillRest: () => pills.push(["rest"]),
    ask: async (goal, opt) => { did.push(["ask", goal, opt]); return o.askTakes !== false; },
    askBusy: () => askBusy,
    type: async (text) => { did.push(["type", text]); },
    routine: async (g) => { did.push(["routine", g]); return "routine" in o ? o.routine : { text: "Water the plants · every day" }; },
    notes: (start) => did.push(["notes", start]),
    bot: async (g, b) => { did.push(["bot", g, b]); return "botReply" in o ? o.botReply : { name: "Plan Ease", text: "Saturday is planned." }; },
    told: (r) => did.push(["told", r.name, r.text]),
    requireAccount: () => o.signedIn !== false,
    failed: (p) => did.push(["failed", p.message]),
    knobs: { num: pick, bool: pick, txt: (k, f) => f },
    now: () => clock,
    setTimeout: (f, ms) => { const tm = { f, at: clock + ms }; timers.push(tm); return tm; },
    clearTimeout: (tm) => { timers = timers.filter((x) => x !== tm); },
  });
  /** Time passes: the timers due fire, in order. */
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
  const recorded = () => did.filter((x) => x[0] === "record").map((x) => x[1]);
  const sid = () => recorded().slice(-1)[0];
  /** They say `words`: captions, the pause, the stream's final text. */
  const speak = async (words) => {
    const s = sid();
    t.partial({ session: s, text: words });
    t.paused({ session: s });
    t.textIn({ session: s, text: words });
    await settle();
  };
  const talks = () => posts.filter((p) => p[0] === "/v1/talk").map((p) => p[1]);
  const said = () => did.filter((x) => x[0] === "say").map((x) => x[1]);
  const lastPill = () => pills[pills.length - 1];
  return { t, did, pills, posts, talks, said, wait, speak, sid, recorded, lastPill, setAskBusy: (v) => { askBusy = v; } };
}

test("start: the microphone opens and the pill listens; not twice, and not signed out", () => {
  const r = rig();
  assert.strictEqual(r.t.start(), true);
  assert.strictEqual(r.t.active(), true);
  assert.deepStrictEqual(r.recorded(), [1]);
  assert.deepStrictEqual(r.lastPill(), ["talk", { phase: "listen", heard: "", said: "", gesture: "listen" }]);
  assert.strictEqual(r.t.start(), false, "already on");
  const out = rig({ signedIn: false });
  assert.strictEqual(out.t.start(), false);
  assert.deepStrictEqual(out.recorded(), []);
});

test("a turn: their words to /v1/talk, the answer shown and said sentence by sentence, then the microphone again", async () => {
  const r = rig({
    replies: [
      ok(lines({ t: "route", kind: "chat", depth: "quick", lang: "en" }, { t: "text", text: "Milk is on" }, { t: "text", text: "the list. Anything" },
        { t: "text", text: "else?" }, { t: "done", text: "Milk is on the list. Anything else?" })),
      ok(lines({ t: "text", text: "Done." }, { t: "done", text: "Done." })),
    ],
  });
  r.t.start();
  r.t.partial({ session: 1, text: "is milk on" });
  assert.deepStrictEqual(r.lastPill()[1].heard, "is milk on", "their words, as they speak");
  await r.speak("is milk on the list");
  assert.deepStrictEqual(r.did.filter((x) => x[0] === "stop"), [["stop", 1]]);
  const [first] = r.talks();
  assert.strictEqual(first.talkId, "talk-1");
  assert.strictEqual(first.turn, 1);
  assert.strictEqual(first.words, "is milk on the list");
  assert.strictEqual(first.tz, -new Date().getTimezoneOffset());
  assert.strictEqual(first.app, "Notes");
  assert.strictEqual(first.title, "Shopping list");
  assert.deepStrictEqual(first.field, { selection: "milk" });
  assert.strictEqual(first.ours, false);
  assert.ok(!("page" in first), "no page until pageFor has one");
  assert.deepStrictEqual(r.said(), ["Milk is on the list.", "Anything else?"]);
  const answer = r.pills.filter((p) => p[0] === "talk" && p[1].phase === "answer").pop();
  assert.strictEqual(answer[1].said, "Milk is on the list. Anything else?");
  // Listening again: the next turn has the same talk and the next number.
  assert.deepStrictEqual(r.recorded(), [1, 2]);
  assert.strictEqual(r.lastPill()[1].phase, "listen");
  await r.speak("add eggs");
  assert.deepStrictEqual(r.talks().map((b) => [b.talkId, b.turn, b.words]), [["talk-1", 1, "is milk on the list"], ["talk-1", 2, "add eggs"]]);
  assert.deepStrictEqual(r.said().slice(-1), ["Done."]);
});

test("the stream however it is cut: lines split across chunks, half an event, a stray line; the whole answer when nothing streamed", async () => {
  const r = rig({
    replies: [
      ok(['{"t":"route","kind":"chat","depth":"quick","lang":"en"}\n{"t":"te', 'xt","text":"Hello there. "}\n{"t":"text","text":"How are', ' you?"}\n',
        "not json\n", '{"t":"done","text":"Hello there. How are you?"}']),
      ok(lines({ t: "done", text: "Only at the end." })),
    ],
  });
  r.t.start();
  await r.speak("hi");
  assert.deepStrictEqual(r.said(), ["Hello there.", "How are you?"]);
  await r.speak("and now");
  assert.deepStrictEqual(r.said().slice(-1), ["Only at the end."]);
});

test("the turn ends on the clip too, waiting a moment for the stream's last word", async () => {
  const r = rig();
  r.t.start();
  r.t.partial({ session: 1, text: "what time" });
  r.t.paused({ session: 1 });
  r.t.audioIn({ session: 1, data: new Uint8Array(4), mime: "audio/webm", text: "what time is it" });
  await settle();
  assert.deepStrictEqual(r.talks(), [], "the final text may still come");
  await r.wait(400);
  assert.deepStrictEqual(r.talks().map((b) => b.words), ["what time is it"]);
});

test("nothing said: no request, the microphone opens again", async () => {
  const r = rig();
  r.t.start();
  r.t.paused({ session: 1 });
  r.t.textIn({ session: 1, text: "" });
  r.t.audioIn({ session: 1, data: null, text: "" });
  await settle();
  assert.deepStrictEqual(r.talks(), []);
  assert.deepStrictEqual(r.recorded(), [1, 2]);
});

test("mood: each of the server's moods is a gesture of Blip's", async () => {
  assert.deepStrictEqual(MOOD_GESTURE, { talk: "talk", laugh: "laugh", ponder: "ponder", done: "done", sorry: "facepalm", surprised: "sneeze", shy: "shy", nope: "nope" });
  assert.strictEqual(gestureFor("whatever"), "talk");
  assert.strictEqual(gestureFor("constructor"), "talk");
  const r = rig({ replies: [ok(lines({ t: "route", kind: "think", depth: "think", lang: "en" }, { t: "mood", mood: "sorry" }, { t: "text", text: "I can't do that." }, { t: "done", text: "" }))] });
  r.t.start();
  await r.speak("open the pod bay doors");
  const gestures = r.pills.filter((p) => p[0] === "talk").map((p) => p[1].gesture);
  assert.ok(gestures.includes("think"));
  assert.ok(gestures.includes("ponder"), "a deep think");
  assert.ok(gestures.includes("facepalm"), "sorry");
  assert.ok(gestures.indexOf("ponder") < gestures.indexOf("facepalm"));
});

test("quiet: silence after an answer ends it; a voice before then keeps it", async () => {
  const r = rig();
  r.t.start();
  await r.speak("hello");
  assert.deepStrictEqual(r.recorded(), [1, 2]);
  await r.wait(7900);
  assert.strictEqual(r.t.active(), true);
  await r.wait(200);
  assert.strictEqual(r.t.active(), false);
  assert.ok(r.did.some((x) => x[0] === "cancel" && x[1] === 2), "the microphone closed");
  assert.deepStrictEqual(r.lastPill(), ["rest"]);
  // They start speaking in time: it goes on.
  const k = rig();
  k.t.start();
  await k.wait(5000);
  k.t.level({ session: 1, bands: [0.1, 0.6, 0.2] });
  await k.wait(20000);
  assert.strictEqual(k.t.active(), true);
});

test("the ceiling: desktop.talk.maxMs ends it, whatever is going on", async () => {
  const r = rig({ knobs: { "desktop.talk.quietMs": 1e9, "desktop.talk.turnMaxMs": 1e9 } });
  r.t.start();
  await r.wait(20 * 60 * 1000 - 1);
  assert.strictEqual(r.t.active(), true);
  await r.wait(1);
  assert.strictEqual(r.t.active(), false);
});

test("a tap or Esc ends it: nothing more said, the microphone closed, the pill given back", async () => {
  const r = rig();
  r.t.start();
  assert.strictEqual(r.t.end("tap"), true);
  assert.strictEqual(r.t.active(), false);
  assert.ok(r.did.some((x) => x[0] === "hush"));
  assert.ok(r.did.some((x) => x[0] === "cancel" && x[1] === 1));
  assert.deepStrictEqual(r.lastPill(), ["rest"]);
  assert.strictEqual(r.t.end("esc"), false, "already off: Esc is not talk's");
  // Late messages for its sessions are not taken.
  assert.strictEqual(r.t.audioIn({ session: 1, data: null }), false);
});

test("ended in the middle of an answer: the turn is stopped on the server too", async () => {
  const g = gate();
  const r = rig({ replies: [g.res] });
  r.t.start();
  await r.speak("tell me a long story");
  g.push(JSON.stringify({ t: "text", text: "Once upon a time" }) + "\n");
  await settle();
  r.t.end("esc");
  await settle();
  assert.deepStrictEqual(r.posts.filter((p) => p[0] === "/v1/talk/stop"), [["/v1/talk/stop", { talkId: "talk-1" }]]);
});

test("barge-in: the key held while he speaks stops him at once, stops the turn, and the microphone is theirs until it comes up", async () => {
  const g = gate();
  let release = null;
  const r = rig({ replies: [g.res], play: () => new Promise((res) => { release = res; }) });
  r.t.start();
  await r.speak("tell me about Rome");
  g.push(JSON.stringify({ t: "text", text: "Rome was not built in a day. It took" }) + "\n");
  await settle();
  assert.deepStrictEqual(r.said(), ["Rome was not built in a day."]);
  assert.strictEqual(r.t.bargeIn("key"), true);
  assert.ok(r.did.some((x) => x[0] === "hush"), "his voice stopped");
  assert.deepStrictEqual(r.posts.filter((p) => p[0] === "/v1/talk/stop").length, 1);
  assert.deepStrictEqual(r.recorded(), [1, 2], "the microphone opened");
  // The rest of the stream and the sentence he was saying come to nothing.
  g.push(JSON.stringify({ t: "text", text: "centuries." }) + "\n");
  g.close();
  release();
  await settle();
  assert.deepStrictEqual(r.said(), ["Rome was not built in a day."]);
  // Held: a pause does not end their turn; the key coming up does.
  r.t.partial({ session: 2, text: "wait, what about" });
  r.t.paused({ session: 2 });
  assert.ok(!r.did.some((x) => x[0] === "stop" && x[1] === 2));
  r.t.release();
  assert.ok(r.did.some((x) => x[0] === "stop" && x[1] === 2));
  r.t.textIn({ session: 2, text: "wait, what about Paris" });
  await settle();
  assert.deepStrictEqual(r.talks().map((b) => [b.turn, b.words]), [[1, "tell me about Rome"], [2, "wait, what about Paris"]]);
});

test("barge-in by voice (desktop.talk.bargeVoice): the microphone listens while he speaks, and a voice over his takes the turn", async () => {
  const g = gate();
  const r = rig({ replies: [g.res], play: () => new Promise(() => {}), knobs: { "desktop.talk.bargeVoice": true, "desktop.talk.bargeLevel": 0.5 } });
  r.t.start();
  await r.speak("what's new");
  g.push(JSON.stringify({ t: "text", text: "Three things happened today. " }) + "\n");
  await settle();
  const watch = r.did.find((x) => x[0] === "watch");
  assert.ok(watch, "a watch opened as he started to speak");
  r.t.level({ session: watch[1], bands: [0.2, 0.3] });
  assert.ok(!r.did.some((x) => x[0] === "hush"), "under the level: nothing");
  r.t.level({ session: watch[1], bands: [0.2, 0.7] });
  assert.ok(r.did.some((x) => x[0] === "hush"));
  assert.ok(r.did.some((x) => x[0] === "cancel" && x[1] === watch[1]), "the watch is closed");
  assert.strictEqual(r.t.phase(), "listening");
  // Off (the default): no watch at all.
  const q = rig();
  q.t.start();
  await q.speak("hi");
  assert.ok(!q.did.some((x) => x[0] === "watch"));
});

test("handoffs: Ask with trusted as the server said, waiting for it before listening again", async () => {
  const r = rig({
    replies: [
      ok(lines({ t: "text", text: "Sending it." }, { t: "handoff", to: "agent", goal: "send Dev the deck", trusted: true }, { t: "done", text: "Sending it." })),
      ok(lines({ t: "text", text: "Let me look." }, { t: "handoff", to: "agent", goal: "what is this chart", trusted: false }, { t: "done", text: "Let me look." })),
    ],
  });
  r.t.start();
  r.setAskBusy(true);
  await r.speak("send Dev the deck");
  assert.deepStrictEqual(r.did.filter((x) => x[0] === "ask"), [["ask", "send Dev the deck", { trusted: true }]]);
  assert.deepStrictEqual(r.recorded(), [1], "Ask is still at it");
  assert.strictEqual(r.lastPill()[1].gesture, "work");
  r.setAskBusy(false);
  await r.wait(500);
  assert.deepStrictEqual(r.recorded(), [1, 2]);
  await r.speak("what is this chart");
  assert.deepStrictEqual(r.did.filter((x) => x[0] === "ask")[1], ["ask", "what is this chart", undefined]);
  assert.deepStrictEqual(r.recorded(), [1, 2, 3]);
});

test("handoffs: write pastes, routine saves, notes start and stop, a bot is sent to; each then listens again", async () => {
  const reply = (h) => ok(lines({ t: "text", text: "Okay." }, h, { t: "done", text: "Okay." }));
  const r = rig({
    replies: [
      reply({ t: "handoff", to: "write", goal: "Dear Sam, thanks for the notes." }),
      reply({ t: "handoff", to: "routine", goal: "water the plants every day" }),
      reply({ t: "handoff", to: "notes", goal: "", notes: "start" }),
      reply({ t: "handoff", to: "notes", goal: "", notes: "stop" }),
      reply({ t: "handoff", to: "bot", goal: "plan Saturday", bot: { slug: "plan", name: "Plan Ease" } }),
      reply({ t: "handoff", to: "nowhere", goal: "x" }),
    ],
  });
  r.t.start();
  for (const w of ["write it", "a routine", "take notes", "stop notes", "plan Saturday", "something"]) await r.speak(w);
  assert.deepStrictEqual(r.did.filter((x) => ["type", "routine", "notes", "bot", "told"].includes(x[0])), [
    ["type", "Dear Sam, thanks for the notes."],
    ["routine", "water the plants every day"],
    ["told", "Routines", "Water the plants · every day"],
    ["notes", true],
    ["notes", false],
    ["bot", "plan Saturday", { slug: "plan", name: "Plan Ease" }],
    ["told", "Plan Ease", "Saturday is planned."],
  ]);
  assert.deepStrictEqual(r.recorded(), [1, 2, 3, 4, 5, 6, 7], "listening again after each, an unknown handoff included");
});

test("a handoff that fails is said, and it listens again", async () => {
  const r = rig({ routine: null, replies: [ok(lines({ t: "handoff", to: "routine", goal: "x" }, { t: "done", text: "Saving it." }))] });
  r.t.start();
  await r.speak("save a routine");
  assert.deepStrictEqual(r.said(), ["Saving it.", "I couldn't save that routine."]);
  assert.deepStrictEqual(r.recorded(), [1, 2]);
});

test("a private window or a sensitive app: nothing of the screen goes, and the page is never asked for", async () => {
  for (const front of [{ label: "Chrome", title: "Incognito - Bank", private: true }, { label: "Chase", title: "Accounts", sensitive: true }]) {
    const r = rig({ front, page: { outline: ["x"], text: "secret", source: "tree" } });
    r.t.start();
    await r.speak("what's on screen");
    const [b] = r.talks();
    assert.deepStrictEqual(Object.keys(b).sort(), ["field", "ours", "talkId", "turn", "tz", "words"]);
    assert.deepStrictEqual(b.field, { private: true });
    assert.ok(!r.did.some((x) => x[0] === "pageFor"));
  }
  // An ordinary window: the page goes, when there is one.
  const ok2 = rig({ page: { outline: ["Inbox"], text: "3 unread", where: "top", source: "tree" } });
  ok2.t.start();
  await ok2.speak("anything new");
  assert.deepStrictEqual(ok2.talks()[0].page, { outline: ["Inbox"], text: "3 unread", where: "top", source: "tree" });
  // Our own window: not read either.
  const ours = rig({ ours: true });
  ours.t.start();
  await ours.speak("hello");
  assert.ok(!ours.did.some((x) => x[0] === "pageFor"));
  assert.strictEqual(ours.talks()[0].ours, true);
  assert.ok(!("title" in ours.talks()[0]));
});

test("a server error is said, and it listens again; two in a row end it", async () => {
  const r = rig({
    replies: [
      ok(lines({ t: "error", code: "busy", message: "try later" })),
      ok(lines({ t: "text", text: "Fine now." }, { t: "done", text: "Fine now." })),
      { ok: false, status: 500, body: null },
      () => Promise.reject(new Error("offline")),
    ],
  });
  r.t.start();
  await r.speak("one");
  assert.deepStrictEqual(r.said(), ["I couldn't get that."]);
  assert.deepStrictEqual(r.recorded(), [1, 2]);
  assert.strictEqual(r.pills.filter((p) => p[0] === "talk").pop()[1].phase, "listen");
  await r.speak("two");
  assert.deepStrictEqual(r.said().slice(-1), ["Fine now."], "a good turn clears the count");
  await r.speak("three");
  assert.strictEqual(r.t.active(), true);
  await r.speak("four");
  assert.deepStrictEqual(r.said().slice(-2), ["I couldn't get that.", "I couldn't get that."]);
  assert.strictEqual(r.t.active(), false);
});

test("the microphone failing ends it, and says why", () => {
  const r = rig();
  r.t.start();
  assert.strictEqual(r.t.error({ session: 1, message: "Microphone blocked" }), true);
  assert.strictEqual(r.t.active(), false);
  assert.deepStrictEqual(r.did.slice(-1), [["failed", "Microphone blocked"]]);
  assert.strictEqual(r.t.error({ session: 1, message: "late" }), false, "not talk's any more");
});

test("messages for other sessions (a dictation, a question) are left to them", () => {
  const r = rig();
  r.t.start();
  for (const f of ["partial", "level", "paused", "audioIn", "textIn", "error"]) assert.strictEqual(r.t[f]({ session: 99 }), false, f);
  assert.strictEqual(r.t.active(), true);
});

test("sentences: cut at the end of each, CJK marks too; a long run at its last comma or space", () => {
  assert.deepStrictEqual(sentences("One. Two! Three? Fo"), { said: ["One.", "Two!", "Three?"], rest: "Fo" });
  assert.deepStrictEqual(sentences("He said \"hi.\" Then"), { said: ["He said \"hi.\""], rest: "Then" });
  assert.deepStrictEqual(sentences("你好。今天"), { said: ["你好。"], rest: "今天" });
  assert.deepStrictEqual(sentences("pi is 3.14 and"), { said: [], rest: "pi is 3.14 and" });
  const long = sentences("a".repeat(30) + ", " + "b".repeat(30) + " c", 40);
  assert.deepStrictEqual(long.said, ["a".repeat(30) + ","]);
});
