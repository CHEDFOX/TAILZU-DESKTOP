// node --test
//
// The window's half of his listening (sdui/listen.js): voiceLive and its turns, LiveWords written in place, the ends (main's end,
// a tap on him, Escape, another screen), the one key's session adopted with the key's own mode, and talkTo told to main after
// every paint. The main process is the stand-in bridge of the test kit: what the window sends is written down, and main's
// messages are handed to the window's own listener.
const test = require("node:test");
const assert = require("node:assert");
const { fakePage } = require("./testkit.js");

const set = (path, value) => ({ kind: "setState", path, value });
const voiceAction = (mode, extra) => Object.assign({
  kind: "voiceLive", mode, statePath: "voice", into: "heard", silenceMs: 900,
  onHeard: { kind: "appendState", path: "said", value: "$state.heard" },
  onEnd: set("ended", true), onError: set("failed", true), onBlocked: set("blocked", true),
}, extra || {});

/** A screen with LiveWords in it (and a field, to take the focus), its talkTo, and the voice's state. */
function page(o = {}) {
  const p = fakePage(o);
  p.view.rect = { left: 0, top: 0, width: 720, height: 800 };
  const root = { type: "Stack", children: [
    { type: "LiveWords", props: { size: 17, lineHeight: 24, fontFamily: "Tailzu Geist", color: "#0a0a0a", freshColor: "#b5b5b5", settleMs: 600 } },
    { type: "TextField", id: "name", bind: { value: "name" }, props: { placeholder: "Its name" } },
  ] };
  p.ctx.__sc = { screenId: o.screenId || "bots.spaces", look: "bots", root, state: { voice: "", heard: "", said: [] }, talkTo: o.talkTo === false ? undefined : { voice: voiceAction("once") } };
  p.run("ENV = { baseUrl: 'https://api.test' }; STACK = [{ screenId: __sc.screenId, params: { id: 's1' } }]; STATE = Object.assign({}, __sc.state); repaint(__sc)");
  p.run("var __paints = 0; var __repaint = repaint; repaint = function (s) { __paints++; return __repaint(s); }");
  const main = (m) => p.run("__voice")(m);
  const voiceSent = () => JSON.parse(JSON.stringify(p.sent.filter(([k]) => k === "voice").map(([, cmd, opts]) => [cmd, opts])));
  const talkTo = () => JSON.parse(JSON.stringify(p.sent.filter(([k]) => k === "talkTo").map(([, t]) => t)));
  return { p, main, voiceSent, talkTo, words: () => p.view.querySelector("[data-lw]"), paints: () => p.run("__paints") };
}

test("voiceLive starts a session with main; its words are written into LiveWords in place, the newest grey settling to ink", async () => {
  const { p, main, voiceSent, words, paints } = page();
  p.ctx.__a = voiceAction("chat");
  p.run("run(__a)");
  assert.deepStrictEqual(voiceSent(), [["start", { mode: "chat", silenceMs: 900 }]]);
  assert.strictEqual(p.run("STATE.voice"), "listening");
  main({ kind: "listen", session: 4, mode: "chat", by: "click" });
  const before = paints();
  main({ kind: "words", session: 4, text: "what's on" });
  main({ kind: "level", session: 4, v: 0.6 });
  main({ kind: "words", session: 4, text: "what's on tomorrow" });
  assert.strictEqual(paints(), before, "no repaint for words or the level");
  const spans = words().children;
  assert.deepStrictEqual(spans.map((s) => s.textContent), ["what's", " on", " tomorrow"], "one span per word");
  assert.strictEqual(spans[2].style.color, "#b5b5b5", "the newest light grey");
  p.tick(20);
  assert.strictEqual(spans[2].style.color, "#0a0a0a", "settling to ink");
  assert.match(spans[2].style.transition, /color \d+ms/);
  assert.ok(p.run("voiceLevel()") > 0.5, "the level is on the voice bus, never in state");
  assert.strictEqual(p.run("STATE.level"), undefined);
  // A word a later partial changed starts fresh again; another session's words are nothing.
  main({ kind: "words", session: 4, text: "what's on Friday" });
  assert.strictEqual(words().children[2].style.color, "#b5b5b5");
  main({ kind: "words", session: 9, text: "someone else" });
  assert.deepStrictEqual(words().children.map((s) => s.textContent), ["what's", " on", " Friday"]);
});

test("heard: the turn's words into `into`, \"sending\" while onHeard runs, then again (a chat) or stop (once, or stopWhen)", async () => {
  const { p, main, voiceSent } = page();
  p.ctx.__a = voiceAction("chat", { stopWhen: { truthy: "said.confirm" } });
  p.run("run(__a)");
  main({ kind: "listen", session: 2, mode: "chat", by: "click" });
  main({ kind: "heard", session: 2, text: "what's on tomorrow" });
  assert.strictEqual(p.run("STATE.heard"), "what's on tomorrow");
  await p.settle();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(p.run("STATE.said"))), ["what's on tomorrow"], "onHeard ran with it");
  assert.deepStrictEqual(voiceSent().slice(-1)[0], ["again", { session: 2 }]);
  assert.strictEqual(p.run("STATE.voice"), "listening", "the next turn");
  // stopWhen holds after a turn (the server asked "Send this to Mom only?", an object in state: true, as on the phone): it stops.
  assert.strictEqual(p.run("visible({ truthy: 'q' })"), false);
  p.run("STATE.q = { line: 'x' }");
  assert.strictEqual(p.run("visible({ truthy: 'q' })"), true, "an object kept in state holds");
  p.run("STATE.said = { confirm: { line: 'Send this to Mom only?' } }");
  p.ctx.__b = voiceAction("chat", { stopWhen: { truthy: "said.confirm" }, onHeard: { kind: "toast", message: "sent" } });
  p.run("VOICE.action = __b");
  main({ kind: "heard", session: 2, text: "mom see you at 7" });
  await p.settle();
  assert.deepStrictEqual(voiceSent().slice(-1)[0], ["stop", { session: 2 }]);
  assert.strictEqual(p.run("STATE.voice"), "");
  assert.strictEqual(p.run("STATE.ended"), true, "onEnd");
  // main's end for the session it already finished: nothing more.
  p.run("STATE.ended = false");
  main({ kind: "end", session: 2, why: "tap" });
  assert.strictEqual(p.run("STATE.ended"), false);
  // Once: one turn, then stop.
  const q = page();
  q.p.ctx.__a = voiceAction("once");
  q.p.run("run(__a)");
  q.main({ kind: "listen", session: 7, mode: "once", by: "click" });
  q.main({ kind: "heard", session: 7, text: "remind me to call Nani at six" });
  await q.p.settle();
  assert.deepStrictEqual(q.voiceSent().slice(-1)[0], ["stop", { session: 7 }]);
  assert.strictEqual(q.p.run("STATE.voice"), "");
});

test("ends: main's end (quiet, Esc, blur), a tap on him (voiceStop), the window's Escape; a refused start; no microphone; no bridge", async () => {
  const { p, main, voiceSent } = page();
  p.ctx.__a = voiceAction("chat");
  p.run("run(__a)");
  main({ kind: "listen", session: 3, mode: "chat", by: "click" });
  main({ kind: "end", session: 3, why: "quiet" });
  assert.strictEqual(p.run("STATE.voice"), "");
  assert.strictEqual(p.run("STATE.ended"), true);
  // A tap on him: voiceStop sends stop for its session, and it is over here at once.
  p.run("STATE.ended = false; run(__a)");
  main({ kind: "listen", session: 5, mode: "chat", by: "click" });
  p.run("run({ kind: 'voiceStop' })");
  assert.deepStrictEqual(voiceSent().slice(-1)[0], ["stop", { session: 5 }]);
  assert.strictEqual(p.run("STATE.voice"), "");
  p.run("run({ kind: 'voiceStop' })");
  assert.strictEqual(voiceSent().filter(([c]) => c === "stop").length, 1, "stop is idempotent");
  // Escape on the window: cancel.
  p.run("run(__a)");
  main({ kind: "listen", session: 6, mode: "chat", by: "click" });
  p.document.body.dispatchEvent(new p.dom.Ev("keydown", { key: "Escape" }));
  assert.deepStrictEqual(voiceSent().slice(-1)[0], ["cancel", { session: 6 }]);
  assert.strictEqual(p.run("STATE.voice"), "");
  // Refused (signed out, out of words): main says end at once for the session it numbered.
  p.run("STATE.ended = false; run(__a)");
  main({ kind: "end", session: 8, why: "error" });
  assert.strictEqual(p.run("STATE.voice"), "");
  assert.strictEqual(p.run("STATE.ended"), true);
  // No microphone allowed: onBlocked.
  p.run("run(__a)");
  main({ kind: "error", session: 9, message: "", blocked: true });
  main({ kind: "end", session: 9, why: "error" });
  assert.strictEqual(p.run("STATE.blocked"), true);
  // A main process without the voice: onError, nothing started.
  const old = page({ bridge: { voice: undefined } });
  old.p.ctx.__a = voiceAction("once");
  old.p.run("run(__a)");
  assert.strictEqual(old.p.run("STATE.failed"), true);
  assert.strictEqual(old.p.run("STATE.voice"), "");
});

test("talkTo: told after a paint with it, null after one without, and null while another text field has the focus", async () => {
  const { p, talkTo } = page();
  assert.deepStrictEqual(talkTo(), [{ hold: true, chat: true }]);
  p.view.querySelector("input").focus();
  p.tick(1);
  assert.deepStrictEqual(talkTo().slice(-1)[0], null, "typing in another field: the key types");
  p.view.querySelector("input").blur();
  p.tick(1);
  assert.deepStrictEqual(talkTo().slice(-1)[0], { hold: true, chat: true });
  const n = talkTo().length;
  p.run("__repaint()");
  assert.strictEqual(talkTo().length, n, "told again only when it changes");
  p.ctx.__other = { screenId: "bots.you", look: "bots", root: { type: "Text", props: { content: "You" } }, state: {} };
  p.run("STACK.push({ screenId: 'bots.you' }); __repaint(__other)");
  assert.deepStrictEqual(talkTo().slice(-1)[0], null, "a screen with no talkTo");
  const none = page({ talkTo: false });
  assert.deepStrictEqual(none.talkTo(), [null]);
});

test("the one key: main's listen by key adopts the screen's talkTo.voice, in the key's mode (two taps: a chat, whatever voice.mode says)", async () => {
  const { p, main, voiceSent } = page();
  main({ kind: "listen", session: 11, mode: "chat", by: "key" });
  assert.strictEqual(p.run("STATE.voice"), "listening");
  assert.deepStrictEqual(voiceSent(), [], "adopted: no second start");
  assert.strictEqual(p.run("VOICE.mode"), "chat", "the key's mode, not talkTo.voice's once");
  main({ kind: "heard", session: 11, text: "what's on tomorrow" });
  await p.settle();
  assert.deepStrictEqual(voiceSent(), [["again", { session: 11 }]]);
  // A hold is one turn.
  const q = page();
  q.main({ kind: "listen", session: 12, mode: "hold", by: "key" });
  q.main({ kind: "heard", session: 12, text: "remind me" });
  await q.p.settle();
  assert.deepStrictEqual(q.voiceSent(), [["stop", { session: 12 }]]);
  // A screen with no talkTo: the session main opened is stopped.
  const r = page({ talkTo: false });
  r.main({ kind: "listen", session: 13, mode: "hold", by: "key" });
  assert.deepStrictEqual(r.voiceSent(), [["stop", { session: 13 }]]);
  assert.strictEqual(r.p.run("STATE.voice"), "");
});

test("the voice lives through a write's paint(true) and a quiet reload of the same screen, and stops on a navigation", async () => {
  let n = 0;
  const screen = () => ({ screenId: "bots.spaces", look: "bots", root: { type: "Text", props: { content: "feed " + (++n) } }, state: { voice: "" }, talkTo: { voice: voiceAction("once") } });
  const fetch = async (url) => ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => (url.endsWith("/v1/app/screen") ? screen() : {}) });
  const { p, main, voiceSent } = page({ fetch });
  p.ctx.__a = voiceAction("chat");
  p.run("run(__a)");
  main({ kind: "listen", session: 21, mode: "chat", by: "click" });
  await p.run("paint(true)");
  await p.settle();
  assert.match(p.view.textContent, /feed 1/, "the screen was fetched again");
  assert.ok(!voiceSent().some(([c]) => c === "stop"), "still listening");
  // A quiet reload (live.js) applies the new tree with repaint.
  p.ctx.__q = screen();
  p.run("__repaint(__q)");
  assert.ok(!voiceSent().some(([c]) => c === "stop"));
  assert.strictEqual(p.run("VOICE && VOICE.session"), 21);
  // Another space: it stops.
  p.run("go('bots.spaces', { id: 's2' })");
  await p.settle();
  assert.deepStrictEqual(voiceSent().slice(-1)[0], ["stop", { session: 21 }]);
  assert.strictEqual(p.run("VOICE"), null);
});
