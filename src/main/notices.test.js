// node --test
//
// The server's notifications on this computer (notices.js): its own live socket, what it says after "ready", a notice shown with its
// buttons on a Mac and none elsewhere, a click and a button, an answer kept until it lands, and nothing at all until the server says
// it sends them. A fake socket and fake clocks throughout.
const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { createNotices, cleanNotice, buttonsFor, actKey, retryable } = require("./notices.js");

const tick = () => new Promise((r) => setImmediate(r));
async function settle() { for (let i = 0; i < 8; i++) await tick(); }

const CATEGORIES = [
  { id: "x0_todo", actions: [
    { id: "p_done", title: "Done", act: "done", foreground: false },
    { id: "p_later", title: "Later", act: "later", foreground: false },
  ] },
  { id: "x0_leave", actions: [{ id: "p_map", title: "Open map", open: true, foreground: true }] },
  { id: "x0_reply", actions: [{ id: "reply", title: "Reply", act: "reply", input: { placeholder: "Reply…", send: "Send" } }] },
  { id: "x0_three", actions: [{ id: "a1", title: "One", act: "one" }, { id: "a2", title: "Two", act: "two" }, { id: "a3", title: "Three", act: "three" }] },
];
const TODO = { id: "plan_todo:t1:1", kind: "plan_todo", title: "Buy the fruit costume", body: "Today", screenId: "bots.plan", item: "pt:t1", category: "x0_todo" };

function rig(o = {}) {
  let clock = o.now || 1_700_000_000_000;
  let timers = [];
  const timersApi = {
    set: (fn, ms) => { const h = { fn, at: clock + ms }; timers.push(h); return h; },
    clear: (h) => { timers = timers.filter((x) => x !== h); },
    now: () => clock,
  };
  const conns = [];
  const notes = [];
  const opened = [];
  const posts = [];
  let owed = o.owed || [];
  const state = { signedIn: o.signedIn !== false, on: o.on !== false, idle: 4000 };
  class Note extends EventEmitter {
    constructor(opts) { super(); this.opts = opts; this.closed = false; this.shown = false; notes.push(this); }
    show() { this.shown = true; }
    close() { this.closed = true; }
  }
  const n = createNotices({
    signedIn: () => state.signedIn,
    on: () => state.on,
    baseUrl: () => "https://api.example",
    token: async () => (state.signedIn ? "tok" : null),
    connect: async (url) => {
      const c = Object.assign(new EventEmitter(), { url, sent: [], open: true });
      c.send = (text) => { if (!c.open) return false; c.sent.push(JSON.parse(text)); return true; };
      c.close = () => { c.open = false; };
      conns.push(c);
      return c;
    },
    Notification: Note,
    buttons: o.buttons !== false,
    categories: () => CATEGORIES,
    post: async (path, body) => { posts.push([path, body]); return { status: o.status ? o.status(posts.length) : 200 }; },
    open: (target) => opened.push(target),
    idleMs: () => state.idle,
    locked: () => !!state.locked,
    owed: { read: () => owed, write: (l) => { owed = l; } },
    knobs: { num: (_k, f) => f, bool: (_k, f) => f, str: (_k, f) => f, txt: (_k, f) => f },
    title: () => "X0 Bot",
    timers: timersApi,
    random: () => 0.5,
  });
  /** The socket up and signed in: the server says ready. */
  async function ready() {
    await settle();
    const c = conns[conns.length - 1];
    c.emit("message", JSON.stringify({ type: "ready", heartbeatMs: 25000 }));
    await settle();
    return c;
  }
  const say = (c, data) => c.emit("message", JSON.stringify({ type: "event", topic: "notice", at: clock, data }));
  /** Move the clock on, running every timer that falls due, in order. */
  function advance(ms) {
    const end = clock + ms;
    for (;;) {
      const due = timers.filter((h) => h.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((h) => h !== due);
      clock = due.at;
      due.fn();
    }
    clock = end;
  }
  return { n, conns, notes, opened, posts, state, ready, say, advance, owed: () => owed };
}

test("a notice, cleaned: its words cut to length, only our own shapes, and the gone form", () => {
  assert.strictEqual(cleanNotice(null), null);
  assert.strictEqual(cleanNotice({ id: "bad id!", title: "x" }), null, "an id of ours only");
  assert.strictEqual(cleanNotice({ id: "a1", title: "", body: "" }), null, "nothing to say");
  assert.deepStrictEqual(cleanNotice({ id: "a1", gone: true, title: "ignored" }), { id: "a1", gone: true });
  const n = cleanNotice({ id: "plan_leave:e1:2", kind: "plan_leave", title: "Leave by 5:30 pm for the dentist\u0007", body: "x".repeat(500),
    screenId: "bots.plan.go", params: { item: "pe:e1:2026-11-13", n: 3, bad: { a: 1 }, "no way": "x" }, item: "pe:e1:2026-11-13", category: "x0_leave", until: 5 });
  assert.strictEqual(n.title, "Leave by 5:30 pm for the dentist");
  assert.strictEqual(n.body.length, 400);
  assert.ok(n.body.endsWith("…"));
  assert.deepStrictEqual(n.params, { item: "pe:e1:2026-11-13", n: "3" });
  assert.strictEqual(n.item, "pe:e1:2026-11-13");
  assert.strictEqual(n.category, "x0_leave");
  assert.strictEqual(n.until, 5);
  assert.strictEqual(n.silent, false);
  const odd = cleanNotice({ id: "a2", title: "Hi", screenId: "../../etc", item: "pt:1/../x", category: "x0-todo", kind: "Plan Todo" });
  assert.strictEqual(odd.screenId, undefined);
  assert.strictEqual(odd.item, undefined);
  assert.strictEqual(odd.category, undefined);
  assert.strictEqual(odd.kind, "");
});

test("a notice's buttons: its category's first two that do something here; act needs the item; no typed replies", () => {
  assert.deepStrictEqual(buttonsFor(CATEGORIES, { category: "x0_todo", item: "pt:t1" }), [
    { id: "p_done", title: "Done", act: "done" }, { id: "p_later", title: "Later", act: "later" }]);
  assert.deepStrictEqual(buttonsFor(CATEGORIES, { category: "x0_todo" }), [], "no item, nothing to answer");
  assert.deepStrictEqual(buttonsFor(CATEGORIES, { category: "x0_leave" }), [{ id: "p_map", title: "Open map", open: true }]);
  assert.deepStrictEqual(buttonsFor(CATEGORIES, { category: "x0_reply", item: "thread:1" }), []);
  assert.strictEqual(buttonsFor(CATEGORIES, { category: "x0_three", item: "pt:t1" }).length, 2, "two at most");
  assert.deepStrictEqual(buttonsFor(CATEGORIES, { category: "x0_nope", item: "pt:t1" }), []);
  assert.deepStrictEqual(buttonsFor(null, { category: "x0_todo", item: "pt:t1" }), []);
});

test("a key the act door takes, and which failures are worth sending again", () => {
  const k = actKey(() => 0.25, 1_700_000_000_000);
  assert.match(k, /^[A-Za-z0-9_.:-]{8,120}$/);
  assert.notStrictEqual(actKey(() => 0.1, 1), actKey(() => 0.9, 1));
  for (const s of [undefined, 0, 408, 425, 429, 500, 503]) assert.ok(retryable(s), String(s));
  for (const s of [400, 401, 403, 404, 409]) assert.ok(!retryable(s), String(s));
});

test("off until the server sends them: no socket, nothing said; on, its own socket, signed in by its first message", async () => {
  const h = rig({ on: false });
  h.n.sync();
  await settle();
  assert.strictEqual(h.conns.length, 0, "a server that never will is never told anything");
  h.state.on = true;
  h.n.sync();
  const c = await h.ready();
  assert.strictEqual(c.url, "wss://api.example/v1/live");
  assert.deepStrictEqual(c.sent, [
    { type: "auth", token: "tok" },
    { type: "notices", v: 1, buttons: true },
    { type: "here", idleMs: 4000 },
  ]);
  // Every minute while it is up: how long since the computer was used.
  h.state.idle = 75000;
  h.advance(60000);
  assert.deepStrictEqual(c.sent[c.sent.length - 1], { type: "here", idleMs: 75000 });
  // Locked, or going to sleep: away, so the phone rings; unlocked: here again at once.
  h.n.away();
  assert.deepStrictEqual(c.sent[c.sent.length - 1], { type: "here", away: true });
  // The server's pings keep the socket (a quiet one is dropped and made again).
  c.emit("message", JSON.stringify({ type: "ping" }));
  h.advance(60000);
  assert.deepStrictEqual(c.sent[c.sent.length - 1], { type: "here", away: true }, "still away while locked");
  h.state.idle = 0;
  h.n.back();
  assert.deepStrictEqual(c.sent[c.sent.length - 1], { type: "here", idleMs: 0 });
  // The server turns it off: the socket goes.
  h.state.on = false;
  h.n.sync();
  assert.strictEqual(c.open, false);
});

test("a notice on a Mac: shown with its words and its two buttons; Done answers at the act door with its item and a key", async () => {
  const h = rig();
  h.n.sync();
  const c = await h.ready();
  h.say(c, TODO);
  assert.strictEqual(h.notes.length, 1);
  const note = h.notes[0];
  assert.ok(note.shown);
  assert.deepStrictEqual(note.opts, { title: "Buy the fruit costume", body: "Today", silent: false,
    actions: [{ type: "button", text: "Done" }, { type: "button", text: "Later" }] });
  note.emit("action", {}, 0);
  await settle();
  assert.strictEqual(h.posts.length, 1);
  const [path, body] = h.posts[0];
  assert.strictEqual(path, "/v1/widgets/act");
  assert.strictEqual(body.item, "pt:t1");
  assert.strictEqual(body.action, "done");
  assert.match(body.key, /^[A-Za-z0-9_.:-]{8,120}$/);
  assert.deepStrictEqual(h.owed(), [], "landed: nothing owed");
  assert.deepStrictEqual(h.opened, [], "answered where it was: the app stays shut");
});

test("a click opens the page it is about; an open button (Open map) is a click", async () => {
  const h = rig();
  h.n.sync();
  const c = await h.ready();
  h.say(c, TODO);
  h.notes[0].emit("click");
  assert.deepStrictEqual(h.opened, [{ screenId: "bots.plan", params: {} }]);
  h.say(c, { id: "plan_leave:e1", kind: "plan_leave", title: "Leave by 5:30 pm for the dentist", body: "30 min drive to Indiranagar",
    screenId: "bots.plan.go", params: { item: "pe:e1:2026-11-13" }, item: "pe:e1:2026-11-13", category: "x0_leave" });
  assert.deepStrictEqual(h.notes[1].opts.actions, [{ type: "button", text: "Open map" }]);
  h.notes[1].emit("action", {}, 0);
  await settle();
  assert.deepStrictEqual(h.opened[1], { screenId: "bots.plan.go", params: { item: "pe:e1:2026-11-13" } });
  assert.strictEqual(h.posts.length, 0, "a hand-off is the screen's, never the act door's");
});

test("Windows and Linux: no buttons (Electron's are a Mac's), and a click opens the Plan page where the question waits", async () => {
  const h = rig({ buttons: false });
  h.n.sync();
  const c = await h.ready();
  assert.deepStrictEqual(c.sent[1], { type: "notices", v: 1, buttons: false });
  h.say(c, TODO);
  assert.strictEqual(h.notes[0].opts.actions, undefined);
  h.notes[0].emit("click");
  assert.deepStrictEqual(h.opened, [{ screenId: "bots.plan", params: {} }]);
});

test("the morning note comes without a sound; answered elsewhere, it goes from here too; the same id again takes its place", async () => {
  const h = rig();
  h.n.sync();
  const c = await h.ready();
  h.say(c, { id: "plan_morning:2026-11-13", kind: "plan_morning", title: "Today: leave by 8:10 am", body: "School drop 8:30.", silent: true, screenId: "bots.plan" });
  assert.strictEqual(h.notes[0].opts.silent, true);
  h.say(c, { id: "plan_morning:2026-11-13", kind: "plan_morning", title: "Today: leave by 8:10 am", body: "New: standup moved to 10:30.", silent: true });
  assert.ok(h.notes[0].closed, "the older copy is taken off");
  assert.ok(!h.notes[1].closed);
  h.say(c, { id: "plan_morning:2026-11-13", gone: true });
  assert.ok(h.notes[1].closed);
  assert.strictEqual(h.n.shownCount(), 0);
});

test("a notice whose moment passes is taken off by itself, and one heard after it is never shown", async () => {
  const h = rig();
  h.n.sync();
  const c = await h.ready();
  h.say(c, Object.assign({}, TODO, { id: "plan_leave:e2", until: 1_700_000_000_000 + 20 * 60000 }));
  assert.ok(!h.notes[0].closed);
  h.advance(20 * 60000);
  assert.ok(h.notes[0].closed);
  h.say(c, Object.assign({}, TODO, { id: "plan_leave:e3", until: 1_700_000_000_000 }));
  assert.strictEqual(h.notes.length, 1, "already over: nothing shown");
});

test("an answer that cannot land yet is kept, with its key, and goes again when the socket is back; a refusal says to finish in the app", async () => {
  let fail = true;
  const h = rig({ status: () => (fail ? 503 : 200) });
  h.n.sync();
  const c = await h.ready();
  h.say(c, TODO);
  h.notes[0].emit("action", {}, 1);
  await settle();
  assert.strictEqual(h.owed().length, 1);
  const key = h.owed()[0].key;
  assert.strictEqual(h.owed()[0].body.action, "later");
  // The socket drops and comes back: what was owed goes, with the same key.
  fail = false;
  c.emit("close", { code: 1006 });
  h.advance(60000);
  const c2 = await h.ready();
  assert.notStrictEqual(c2, c);
  await settle();
  assert.strictEqual(h.posts.length, 2);
  assert.strictEqual(h.posts[1][1].key, key, "never acted on twice");
  assert.deepStrictEqual(h.owed(), []);

  const no = rig({ status: () => 409 });
  no.n.sync();
  const c3 = await no.ready();
  no.say(c3, TODO);
  no.notes[0].emit("action", {}, 0);
  await settle();
  assert.deepStrictEqual(no.owed(), [], "a refusal is not tried again");
  const said = no.notes[1];
  assert.deepStrictEqual(said.opts, { title: "Couldn't do that from here", body: "Open X0 to finish it.", silent: true });
  said.emit("click");
  assert.deepStrictEqual(no.opened, [{ screenId: "bots.plan", params: {} }]);
});

test("signed out: the socket goes, nothing of that account stays on the screen, and nothing it owed goes as the next one", async () => {
  const h = rig({ status: () => 503 });
  h.n.sync();
  const c = await h.ready();
  h.say(c, TODO);
  h.say(c, Object.assign({}, TODO, { id: "plan_todo:t2:1", item: "pt:t2" }));
  h.notes[1].emit("action", {}, 0);
  await settle();
  assert.strictEqual(h.owed().length, 1);
  h.state.signedIn = false;
  h.n.sync();
  assert.strictEqual(c.open, false);
  assert.ok(h.notes[0].closed);
  assert.deepStrictEqual(h.owed(), []);
});

test("other topics are the window's: heard and left alone; never a pile of notices", async () => {
  const h = rig();
  h.n.sync();
  const c = await h.ready();
  c.emit("message", JSON.stringify({ type: "event", topic: "calendar", at: 1 }));
  c.emit("message", JSON.stringify({ type: "event", topic: "bot:plan", at: 1, data: { id: "x", title: "Nope" } }));
  assert.strictEqual(h.notes.length, 0);
  for (let i = 0; i < 10; i++) h.say(c, Object.assign({}, TODO, { id: "plan_todo:t" + i + ":1", item: "pt:t" + i }));
  assert.strictEqual(h.n.shownCount(), 8);
  assert.ok(h.notes[0].closed && h.notes[1].closed && !h.notes[2].closed, "the oldest go first");
});

test("woken before the unlock: still away while the screen is locked; and an answer that failed a moment ago goes with the next here", async () => {
  let fail = true;
  const h = rig({ status: () => (fail ? 503 : 200) });
  h.n.sync();
  const c = await h.ready();
  h.state.locked = true;
  h.n.back();
  assert.deepStrictEqual(c.sent[c.sent.length - 1], { type: "here", away: true });
  h.state.locked = false;
  h.say(c, TODO);
  h.notes[0].emit("action", {}, 0);
  await settle();
  assert.strictEqual(h.owed().length, 1);
  fail = false;
  c.emit("message", JSON.stringify({ type: "ping" }));
  h.advance(60000);
  await settle();
  assert.strictEqual(h.posts.length, 2, "sent again on the minute, without waiting for a new socket");
  assert.deepStrictEqual(h.owed(), []);
});
