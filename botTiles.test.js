// botTiles.js: the living bot tiles' physics and drawing, GENERATED from the phone's core
// (TAILZU-FRONTEND/app/src/botTiles/core.ts). Here: the file is exactly what was generated (a hand edit fails),
// the core runs in node as the window loads it, and sdui.js draws the BotTiles and BotCard nodes around it.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const FILE = path.join(__dirname, "botTiles.js");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

test("botTiles.js is the generated file, untouched (regenerate it from the phone's core.ts, never edit it)", () => {
  const text = fs.readFileSync(FILE, "utf8");
  const src = /core\.ts sha256 ([0-9a-f]{64})/.exec(text);
  const body = /body sha256 ([0-9a-f]{64})/.exec(text);
  assert.ok(src && body, "the header names the source and the body");
  const at = text.indexOf("\n(function (root, factory)");
  assert.ok(at > 0);
  assert.strictEqual(sha(text.slice(at + 1)), body[1], "botTiles.js was edited by hand: run `node src/botTiles/genDesktop.mjs` in TAILZU-FRONTEND/app");
  const phone = path.resolve(__dirname, "../TAILZU-FRONTEND/app/src/botTiles/core.ts");
  if (fs.existsSync(phone)) assert.strictEqual(sha(fs.readFileSync(phone, "utf8")), src[1], "the phone's core.ts changed: regenerate botTiles.js");
});

test("the core runs as the window loads it: every bot, a few seconds, finite and inside its tile", () => {
  const api = require("./botTiles.js");
  for (const kind of ["code", "keybot", "plan", "travel", "make", "custom"]) {
    const t = new api.BotTile({ kind, color: "#3E6E8E", mood: "working", seed: 4 });
    t.resize(209, 150, 92);
    for (let f = 0; f < 600; f++) t.step(1 / 60);
    assert.ok(t.finite(), kind);
    assert.ok(t.inside(), kind);
  }
  assert.strictEqual(api.TAP.holdMs, 1000);
  assert.strictEqual(api.kindOf("travel"), "travel");
  assert.strictEqual(api.kindOf("gym"), "custom");
});

/** sdui.js as the page runs it, with botTiles.js loaded first. */
function page() {
  const noop = () => {};
  const g = {
    console: { warn: noop, log: noop, error: noop },
    setTimeout, clearTimeout, setInterval, clearInterval, Promise, JSON, Object, Array, String, Number, Math, Date, RegExp, Error, Map, Set,
    navigator: { language: "en-US" }, innerWidth: 1280, innerHeight: 800, devicePixelRatio: 2,
    addEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }),
    document: { addEventListener: noop, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], activeElement: null },
    localStorage: { getItem: () => null, setItem: noop }, requestAnimationFrame: () => 0, cancelAnimationFrame: noop, performance: { now: () => 0 },
    // start() waits on env() forever, so nothing past the top level runs.
    tailzuApp: { env: () => new Promise(() => {}) },
  };
  g.window = g;
  const ctx = vm.createContext(g);
  for (const f of ["knobs.js", "botTiles.js", "botLooks.js", "sdui.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx, { filename: f });
  return { ctx, run: (code) => vm.runInContext(code, ctx) };
}

test("the window says it draws them", () => {
  const p = page();
  const comps = p.run("COMPONENTS");
  for (const c of ["BotsMotion", "BotTiles", "BotCard", "BotBuddy", "BotTilesStrip", "BotBuddyCarry", "BotMoments"]) assert.ok(comps.includes(c), c);
});

test("BotTiles: a tile per bot, its words, its canvas, its status mark; the make tile dashed", () => {
  const p = page();
  p.ctx.__n = {
    type: "BotTiles",
    props: {
      columns: 4, height: 150, padding: 18, gap: 14, faces: { regular: "Tailzu Geist", medium: "Tailzu Geist Medium", semibold: "Tailzu Geist SemiBold" },
      tiles: [
        { slug: "code", name: "Xode", sub: "Working · fixing cart", color: "#4F7A3A", kind: "code", state: "working", action: { kind: "navigate", screenId: "bots.code" } },
        { slug: "plan", name: "Plan Ease", sub: "Needs you · 1 question", color: "#8F6A1F", kind: "plan", state: "needs" },
        { slug: "make", name: "Make a bot", sub: "Say what it should do", color: "#0a0a0a", kind: "make", state: "idle" },
      ],
    },
  };
  const html = p.run("node(__n)");
  assert.strictEqual((html.match(/class="tz-bt-tile"/g) || []).length, 3);
  assert.strictEqual((html.match(/<canvas class="tz-bt-c"/g) || []).length, 3);
  assert.match(html, /Working · fixing cart/);
  assert.match(html, /grid-template-columns:repeat\(4/);
  assert.match(html, /background:#4F7A3A/, "working: a dot in its colour");
  assert.match(html, /background:#0a0a0a/, "needs you: an ink dot");
  assert.match(html, /border:1\.5px dashed #c9c9c9/, "Make a bot: dashed");
  assert.match(html, /role="button" tabindex="0" aria-label="Xode\. Working · fixing cart"/);
});

test("BotCard: waits for readings, shows its visible step over a blur, and is gone once closed", () => {
  const p = page();
  p.run('STATE = { micGranted: null, micAsked: false, permitClosed: false }');
  p.ctx.__n = {
    type: "BotCard",
    props: { color: "#3d3d3d", stageHeight: 128, overlay: true, width: 340, readyWhen: { neq: ["micGranted", null] }, closeWhen: { truthy: "permitClosed" }, doneWhen: { truthy: "micGranted" }, once: "test.arrival" },
    children: [
      { type: "Text", props: { content: "Can Tailzu hear you?" }, visibleIf: { all: [{ falsy: "micGranted" }, { falsy: "micAsked" }] } },
      { type: "Text", props: { content: "Add the keyboard" }, visibleIf: { truthy: "micAsked" } },
    ],
  };
  assert.strictEqual(p.run("node(__n)"), "", "no readings yet: nothing");
  p.run("STATE.micGranted = false");
  let html = p.run("node(__n)");
  assert.match(html, /tz-bc-veil/);
  assert.match(html, /backdrop-filter:blur\(10px\)/);
  assert.match(html, /Can Tailzu hear you\?/);
  assert.doesNotMatch(html, /Add the keyboard/);
  p.run("STATE.micAsked = true");
  html = p.run("node(__n)");
  assert.match(html, /Add the keyboard/);
  p.run("STATE.permitClosed = true");
  html = p.run("node(__n)");
  assert.match(html, /tz-bc/, "closing: drawn once more, to fade out");
});

/** A painted grid as mountBotTiles finds it: the tiles, their words and canvases; clicks and the window's visibility by hand. */
function fakeGrid(p, html) {
  const id = /data-bt="(\d+)"/.exec(html)[1];
  const n = (html.match(/class="tz-bt-tile"/g) || []).length;
  const box = (x, y, w, h) => ({ left: x, top: y, width: w, height: h });
  const els = Array.from({ length: n }, (_, i) => {
    const words = { style: { opacity: "1" }, getBoundingClientRect: () => box(i * 220, 100, 200, 40) };
    const on = {};
    return {
      on, words, clientWidth: 200, clientHeight: 150, style: {},
      getBoundingClientRect: () => box(i * 220, 0, 200, 150),
      querySelector: (q) => (q === ".tz-bt-w" ? words : { getContext: () => null, style: {} }),
      addEventListener: (k, f) => { on[k] = f; },
    };
  });
  const grid = { isConnected: true, getAttribute: () => id, getBoundingClientRect: () => box(0, 0, 900, 150), querySelectorAll: () => els };
  const root = { querySelectorAll: (q) => (q === "[data-bt]" ? [grid] : []) };
  return { grid, els, root };
}

const HOME = {
  type: "BotTiles",
  props: {
    columns: 4, height: 150, padding: 18, gap: 14,
    tiles: [
      { slug: "code", name: "Xode", sub: "Idle", color: "#4F7A3A", kind: "code", state: "idle", action: { kind: "navigate", screenId: "bots.code" } },
      { slug: "plan", name: "Plan Ease", sub: "Idle", color: "#8F6A1F", kind: "plan", state: "idle", action: { kind: "navigate", screenId: "bots.plan" } },
      { slug: "keybot", name: "Keylessbord", sub: "Idle", color: "#A9573A", kind: "keybot", state: "idle" },
    ],
  },
};

test("BotTiles: after a tap, a return to Home and the window shown again let the look go at once", () => {
  const p = page();
  const handlers = [];
  p.ctx.document.addEventListener = (k, f) => { if (k === "visibilitychange") handlers.push(f); };
  p.ctx.document.hidden = false;
  p.ctx.setTimeout = () => 0; // the tap's own timers (its action, its letting-go) never come: the cases below must do it
  p.ctx.__n = HOME;
  const first = fakeGrid(p, p.run("node(__n)"));
  p.ctx.__root = first.root;
  p.run("mountBotTiles(__root)");
  first.els[0].on.click({ clientX: 50, clientY: 50 });
  const lives = p.run('["code", "plan", "keybot"].map((s) => Array.from(BT_LIVES.entries()).find(([k]) => k.startsWith(s + "|"))[1])');
  assert.ok(lives.slice(1).every((t) => t.focusX === t.focusX), "the others look at the tapped tile");
  assert.strictEqual(first.els[1].words.style.opacity, "0.35", "their words fade");
  // The window comes back to the front while the look is up: let go, words back.
  handlers.forEach((f) => f());
  assert.ok(lives.every((t) => t.focusX !== t.focusX), "shown again: let go");
  assert.strictEqual(first.els[1].words.style.opacity, "1");
  // Tap again, and Home is painted again (the tapped tile's screen was left): the new grid starts released.
  first.els[1].on.click({ clientX: 50, clientY: 50 });
  assert.ok(lives[0].focusX === lives[0].focusX);
  first.grid.isConnected = false;
  const again = fakeGrid(p, p.run("node(__n)"));
  p.ctx.__root = again.root;
  p.run("mountBotTiles(__root)");
  assert.ok(lives.every((t) => t.focusX !== t.focusX && t.focusGoal !== t.focusGoal), "back on Home: every bot at its own again");
  assert.ok(again.els.every((e) => e.words.style.opacity === "1"));
});

test("BotTiles' strip (Notes): a full-width row under the grid, its bot on a stage at the left, in the same world as the tiles", () => {
  const p = page();
  p.ctx.document.hidden = false;
  p.ctx.setTimeout = () => 0;
  p.ctx.__n = { ...HOME, props: { ...HOME.props, stripHeight: 112,
    strip: { slug: "notes", name: "Notes", sub: "Taking notes now", color: "#6E4A6B", kind: "notes", state: "working", action: { kind: "navigate", screenId: "bots.notes" } } } };
  const html = p.run("node(__n)");
  assert.strictEqual((html.match(/class="tz-bt-tile"/g) || []).length, 4, "three tiles and the strip");
  assert.match(html, /data-i="3" data-strip="1"[^>]*aria-label="Notes\. Taking notes now"/);
  assert.match(html, /grid-column:1\/-1;height:112px/);
  assert.match(html, /left:clamp\(140px,34%,220px\)/, "its words on the right of its stage");
  assert.match(html, /background:#6E4A6B/, "working: a dot in its colour");
  // Mounted: the strip is the world's fourth bot, on its stage only (the part left of its words), near the stage's foot.
  const g = fakeGrid(p, html);
  const strip = g.els[3];
  strip.getBoundingClientRect = () => ({ left: 0, top: 164, width: 900, height: 112 });
  strip.clientWidth = 900; strip.clientHeight = 112;
  strip.words.getBoundingClientRect = () => ({ left: 220, top: 164, width: 640, height: 112 });
  p.ctx.__root = g.root;
  p.run("mountBotTiles(__root)");
  const notes = p.run('Array.from(BT_LIVES.entries()).find(([k]) => k.startsWith("notes|"))[1]');
  assert.strictEqual(notes.kind, "notes");
  assert.strictEqual(notes.w, 220, "the stage is the part left of the words");
  assert.ok(notes.floor > 112 - 18, "standing near its foot");
  // A tap on the strip (on its words): the others look at it, their words fade; its own press lands on its stage.
  strip.on.click({ clientX: 600, clientY: 200 });
  const code = p.run('Array.from(BT_LIVES.entries()).find(([k]) => k.startsWith("code|"))[1]');
  assert.ok(code.focusY > 100, "a tile's bot looks down at the strip");
  assert.strictEqual(g.els[0].words.style.opacity, "0.35");
  assert.strictEqual(strip.words.style.opacity, "1");
});

test("BotBuddy: a stage of its own, sized; thinking while its condition holds; the page's moment otherwise", () => {
  const p = page();
  p.run("STATE = { sending: false }");
  p.ctx.__n = { type: "BotBuddy", props: { kind: "custom", color: "#6E4A6B", life: "gym-bot", width: 150, height: 56, size: 34, state: "working", act: "play", thinkWhen: { truthy: "sending" }, lookTo: "down", label: "Gym bot" } };
  const html = p.run("node(__n)");
  assert.match(html, /data-bb="\d+"/);
  assert.match(html, /width:150px;flex-shrink:0;height:56px/);
  assert.match(html, /<canvas class="tz-bt-c"/);
  assert.match(html, /aria-label="Gym bot"/);
  assert.strictEqual(p.run("BT_PENDING[BT_PENDING.length - 1].act"), "play");
  p.run("STATE.sending = true; node(__n)");
  assert.strictEqual(p.run("BT_PENDING[BT_PENDING.length - 1].act"), "think");
});

test("BotBuddy carrying: a full-width lane while the ask is out; folded once the answer is here and he has gone", () => {
  const p = page();
  p.run("STATE = { reply: null }");
  p.ctx.__n = { type: "BotBuddy", props: { kind: "code", color: "#4F7A3A", life: "carry.code", height: 68, size: 44, state: "idle", act: "carry", doneWhen: { truthy: "reply.text" }, label: "Working on it…" } };
  const html = p.run("node(__n)");
  assert.match(html, /align-self:stretch;height:68px;overflow:hidden;transition:height/, "a lane: its row's width, its own height");
  assert.match(html, /aria-label="Working on it…"/);
  const cfg = p.run("BT_PENDING[BT_PENDING.length - 1]");
  assert.strictEqual(cfg.act, "carry");
  assert.strictEqual(cfg.done, false);
  // The answer came before he was ever drawn: nothing to see, the lane is folded.
  p.run('STATE.reply = { text: "Here" }');
  assert.match(p.run("node(__n)"), /height:0px/);
  assert.strictEqual(p.run("BT_PENDING[BT_PENDING.length - 1]").done, true);
  // The core, as the window loads it: a haul, then the delivery, then gone.
  const api = require("./botTiles.js");
  const t = new api.BotTile({ kind: "code", color: "#4F7A3A", seed: 2, size: 44 });
  t.resize(600, 68, 66);
  t.setAct("carry");
  for (let f = 0; f < 60 * 4; f++) t.step(1 / 60);
  assert.ok(t.x[2] < 600 && t.held === 0, "walking across with the bag");
  t.deliver();
  for (let f = 0; f < 60 * 8 && !t.carryDone(); f++) t.step(1 / 60);
  assert.ok(t.carryDone() && t.finite());
});

test("an answer as it is written: pieces in order into state, the bound line changed in place; a gap stops it", () => {
  const p = page();
  p.run("STATE = { reply: null }");
  const off = p.run('setStatePath("reply", { id: "x", text: "", step: "" }); askStreamListen("abcdefghijklmnop12", "reply")');
  p.run('askStreamTake("abcdefghijklmnop12", { n: 0, step: "Reading the project…" })');
  p.run('askStreamTake("abcdefghijklmnop12", { n: 1, text: "Hello " })');
  p.run('askStreamTake("abcdefghijklmnop12", { n: 1, text: "Hello " })');
  p.run('askStreamTake("abcdefghijklmnop12", { n: 2, text: "there." })');
  assert.deepStrictEqual(JSON.parse(p.run("JSON.stringify(STATE.reply)")), { id: "x", text: "Hello there.", step: "Reading the project…" });
  p.run('askStreamTake("abcdefghijklmnop12", { n: 4, text: " lost" })');
  p.run('askStreamTake("abcdefghijklmnop12", { n: 5, text: " more" })');
  assert.strictEqual(p.run("STATE.reply.text"), "Hello there.");
  off();
  p.run('askStreamTake("abcdefghijklmnop12", { n: 3, text: "x" })');
  assert.strictEqual(p.run("STATE.reply.text"), "Hello there.");
  assert.ok(p.run("COMPONENTS").includes("AskStream"));
  // A bound line in a kit page carries its path, so it can be changed in place.
  p.run("IN_KIT = true");
  p.ctx.__n = { type: "Text", bind: { content: "reply.text" }, props: { content: "" } };
  assert.match(p.run("node(__n)"), /data-tb="reply\.text"[^>]*>Hello there\.</);
  p.run("IN_KIT = false");
});

test("Home's header alive: the line in words with Keylessbord's caret, the living mark as a button, the bar hidden until a scroll", () => {
  const p = page();
  const comps = p.run("COMPONENTS");
  for (const c of ["WriteOn", "LiveMark", "HeadBar"]) assert.ok(comps.includes(c), c);
  p.ctx.__n = { type: "WriteOn", props: { content: "Anything to write up before the day ends?", size: 40, lineHeight: 46, tracking: -1.2, fontFamily: "Tailzu Geist Bold", caretColor: "#A9573A", once: "home.evening" } };
  const line = p.run("node(__n)");
  assert.strictEqual((line.match(/class="tz-wo-w"/g) || []).length, 8, "a span per word");
  assert.match(line, /aria-label="Anything to write up before the day ends\?"/);
  assert.match(line, /class="tz-wo-c"[^>]*background:#A9573A/, "Keylessbord's clay caret");
  p.ctx.__n = { type: "LiveMark", props: { size: 56, lit: ["#4F7A3A"], label: "Tailzu. Ask anything" }, on: { onPress: { kind: "navigate", screenId: "bots.ask" } } };
  const mark = p.run("node(__n)");
  assert.match(mark, /data-lm="\d+" role="button" tabindex="0" aria-label="Tailzu\. Ask anything"/);
  assert.match(mark, /width:56px;height:56px/);
  p.ctx.__n = { type: "HeadBar", props: { at: 170 }, children: [{ type: "Text", props: { content: "Your bots" } }] };
  const bar = p.run("node(__n)");
  assert.match(bar, /data-hb="\d+" style="position:absolute;left:0;right:0;top:0;height:0;z-index:5"/);
  assert.match(bar, /class="tz-hb"[^>]*opacity:0/);
  assert.match(bar, /Your bots/);
  // The mark's physics, as the window loads it.
  const api = require("./botTiles.js");
  const m = new api.LiveMark(3);
  for (let f = 0; f < 120; f++) m.step(1 / 60);
  assert.ok(m.finite());
  assert.strictEqual(api.writeOnTimes(["a", "b"], 1).length, 2);
});

// ---------------------------------------------------------------- the bots' looks and moments

test("botLooks.js is the generated starter pack, untouched, and the server's catalog when the backend is beside", () => {
  const text = fs.readFileSync(path.join(__dirname, "botLooks.js"), "utf8");
  const src = /looks\.json sha256 ([0-9a-f]{64})/.exec(text), body = /body sha256 ([0-9a-f]{64})/.exec(text);
  assert.ok(src && body, "the header names the source and the body");
  const at = text.indexOf("\n// --\n");
  assert.ok(at > 0);
  assert.strictEqual(sha(text.slice(at + 7)), body[1], "botLooks.js was edited by hand: run `node src/botTiles/genStarter.mjs` in TAILZU-FRONTEND/app");
  const server = path.resolve(__dirname, "../TAILZU-BACKEND/shared/bots/looks.json");
  if (fs.existsSync(server)) {
    const json = fs.readFileSync(server, "utf8");
    assert.strictEqual(sha(json), src[1], "the server's looks.json changed: regenerate botLooks.js");
    assert.deepStrictEqual(require("./botLooks.js"), JSON.parse(json));
  }
});

test("the window plays the catalog: it compiles clean, every moment plays finite and inside, every look draws", () => {
  const api = require("./botTiles.js");
  const L = api.compileLooks(require("./botLooks.js"));
  assert.deepStrictEqual(L.errors, []);
  for (const k of ["code", "keybot", "plan", "travel", "notes", "make", "custom"]) assert.ok(L.avatars.has(L.kinds[k]), k);
  for (const [id, m] of L.moments) {
    if (m.react) continue;
    const t = new api.BotTile({ kind: "custom", color: "#3E6E8E", mood: "idle", seed: 4, avatar: L.avatar("custom", "pip") });
    t.resize(209, 150, 92);
    assert.ok(t.playMoment(m, "once"), id);
    for (let f = 0; f < (m.dur + 0.5) * 60; f++) t.step(1 / 60);
    assert.ok(t.finite() && t.inside(), id);
    assert.ok(t.momentDone(), id + " once: over");
  }
});

test("the window's nodes: a tile's look and moment, Home's surprises, a BotBuddy's moment and its end, and the plain act for one it cannot play", () => {
  const p = page();
  p.ctx.document.hidden = false;
  p.ctx.setTimeout = () => 0;
  p.ctx.__n = { ...HOME, props: { ...HOME.props, surprises: { every: 30, chance: 0.2, moments: ["fart", "sneeze", "nothing"] },
    tiles: HOME.props.tiles.map((t, i) => (i === 0 ? { ...t, avatar: "scout", moment: "dance", momentMode: "loop" } : t)) } };
  const g = fakeGrid(p, p.run("node(__n)"));
  p.ctx.__root = g.root;
  p.run("mountBotTiles(__root)");
  const code = p.run('Array.from(BT_LIVES.entries()).find(([k]) => k.startsWith("code|"))[1]');
  assert.strictEqual(code.av.id, "scout", "its own look");
  assert.strictEqual(code.momentId(), "dance", "its moment, once placed");
  const plan = p.run('Array.from(BT_LIVES.entries()).find(([k]) => k.startsWith("plan|"))[1]');
  assert.strictEqual(plan.av.id, "plan", "his kind's look");
  // Painted again: the moment is not started over.
  const t0 = code.moT;
  code.step(0.5);
  p.run("mountBotTiles(__root)");
  assert.ok(code.moT > t0, "a repaint keeps it going");
  // BotBuddy: a moment, its end when the condition holds; one this build cannot play is its plain act.
  p.run("STATE = { done: false }");
  p.ctx.__b = { type: "BotBuddy", props: { kind: "code", color: "#4F7A3A", life: "page.code", width: 150, height: 56, size: 34, state: "idle", moment: "sweat", momentEndWhen: { truthy: "done" } } };
  const html = p.run("node(__b)");
  assert.match(html, /data-bb=/);
  assert.strictEqual(p.run("BT_PENDING[BT_PENDING.length - 1].act"), "play");
  assert.strictEqual(p.run("BT_PENDING[BT_PENDING.length - 1].momentEnd"), false, "not yet");
  p.ctx.__u = { type: "BotBuddy", props: { kind: "code", color: "#4F7A3A", life: "page.x", width: 150, height: 56, state: "idle", moment: "teleport", act: "wave" } };
  p.run("node(__u)");
  assert.strictEqual(p.run("BT_PENDING[BT_PENDING.length - 1].act"), "wave", "a moment the catalog does not have: the page's own act");
  p.ctx.__f = { type: "BotBuddy", props: { kind: "code", color: "#4F7A3A", life: "page.y", width: 150, height: 56, state: "idle", moment: "sneeze" } };
  p.run("BT_LOOKS.moments.get('sneeze').ok = false; node(__f)");
  assert.strictEqual(p.run("BT_PENDING[BT_PENDING.length - 1].act"), "settle", "one it cannot play: the recipe's plain act");
  p.run("BT_LOOKS.moments.get('sneeze').ok = true");
  p.run("STATE.done = true; node(__b)");
  assert.strictEqual(p.run("BT_PENDING[BT_PENDING.length - 1].momentEnd"), true);
});

