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
    localStorage: { getItem: () => null, setItem: noop },
    // start() waits on env() forever, so nothing past the top level runs.
    tailzuApp: { env: () => new Promise(() => {}) },
  };
  g.window = g;
  const ctx = vm.createContext(g);
  for (const f of ["knobs.js", "botTiles.js", "sdui.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx, { filename: f });
  return { ctx, run: (code) => vm.runInContext(code, ctx) };
}

test("the window says it draws them", () => {
  const p = page();
  const comps = p.run("COMPONENTS");
  for (const c of ["BotsMotion", "BotTiles", "BotCard"]) assert.ok(comps.includes(c), c);
});

test("BotTiles: a tile per bot, its words, its canvas, its status mark; the make tile dashed", () => {
  const p = page();
  p.ctx.__n = {
    type: "BotTiles",
    props: {
      columns: 4, height: 150, padding: 18, gap: 14, faces: { regular: "Tailzu Geist", medium: "Tailzu Geist Medium", semibold: "Tailzu Geist SemiBold" },
      tiles: [
        { slug: "code", name: "Code bot", sub: "Working · fixing cart", color: "#4F7A3A", kind: "code", state: "working", action: { kind: "navigate", screenId: "bots.code" } },
        { slug: "plan", name: "Plan bot", sub: "Needs you · 1 question", color: "#8F6A1F", kind: "plan", state: "needs" },
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
  assert.match(html, /role="button" tabindex="0" aria-label="Code bot\. Working · fixing cart"/);
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
