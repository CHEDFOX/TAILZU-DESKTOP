// The Bots app's kit in the window (sdui.js): SVG shapes and their motions, bound text, Enter in a field, navigate
// params from state, solid borders on a Bots page. sdui.js is a page script, so it runs here as the page runs it:
// knobs.js then sdui.js in one context with a stand-in window (sdui.test.js does the same).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function page() {
  const noop = () => {};
  const g = {
    console: { warn: noop, log: noop, error: noop },
    setTimeout, clearTimeout, setInterval, clearInterval, Promise, JSON, Object, Array, String, Number, Math, Date, RegExp, Error, Proxy,
    navigator: { language: "en-IN" }, innerWidth: 1280, innerHeight: 800, devicePixelRatio: 2, addEventListener: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop }),
    document: { addEventListener: noop, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], activeElement: null },
    tailzuApp: { env: () => new Promise(() => {}), onKnobs: noop, onNavigate: noop, onDictated: noop, onNotes: noop, askSetup: async () => null, onAskSetup: noop, folders: async () => ({}), onFolders: noop },
  };
  g.window = g;
  const ctx = vm.createContext(g);
  for (const f of ["knobs.js", "sdui.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx, { filename: f });
  vm.runInContext("ENV = { baseUrl: 'https://api.test' }", ctx);
  const run = (code) => vm.runInContext(code, ctx);
  const draw = (n, kit = true) => { ctx.__n = n; return run(`IN_KIT = ${kit}; try { node(__n) } finally { IN_KIT = false }`); };
  return { ctx, run, draw };
}

test("the window says it draws the Bots app's kit", () => {
  assert.ok(page().run("capabilities().components").includes("BotsKit"));
});

test("SVG shapes: circles and paths with their paint, the three motions as classes, a rotation on a group", () => {
  const p = page();
  const html = p.draw({
    type: "SVG", style: { width: 26, height: 26 },
    props: {
      viewBox: "0 0 24 24", accessibilityLabel: "Bots", shapes: [
        { circle: [7.5, 7.5, 3.6], fill: "#4F7A3A", motion: "breathe" },
        { circle: [16.5, 7.5, 3.9], fill: "#A9573A", motion: "pop", delayMs: 60 },
        { circle: [12, 12, 9], stroke: "#0a0a0a", strokeWidth: 2.2, dash: "20.9 56.55", rotate: -90, motion: "draw" },
        { d: "M1 1l6 6M7 1L1 7", stroke: "#0a0a0a", strokeWidth: 1.6 },
      ],
    },
  });
  assert.match(html, /^<svg viewBox="0 0 24 24" role="img" aria-label="Bots" style="width:26px;height:26px;display:block/);
  assert.match(html, /<circle cx="7.5" cy="7.5" r="3.6" class="tz-work" fill="#4F7A3A"/);
  assert.match(html, /class="tz-pop" style="animation-delay:60ms;" fill="#A9573A"/);
  assert.match(html, /<g transform="rotate\(-90 12 12\)"><circle cx="12" cy="12" r="9" class="tz-draw" style="--tz-c:56.55;" fill="none" stroke="#0a0a0a" stroke-width="2.2" stroke-dasharray="20.9 56.55"/);
  assert.match(html, /<path d="M1 1l6 6M7 1L1 7" fill="none" stroke="#0a0a0a" stroke-width="1.6"/);
  // A plain SVG is drawn as it always was.
  assert.match(p.draw({ type: "SVG", props: { d: "M0 0h1", stroke: "#000" } }, false), /<path d="M0 0h1"><\/path><\/svg>$/);
  // A malformed shape list draws what it can.
  assert.match(p.draw({ type: "SVG", props: { shapes: [null, { circle: ["x", 1, 2] }, { d: "\"><script>" }] } }), /cx="0"/);
  assert.doesNotMatch(p.draw({ type: "SVG", props: { shapes: [{ d: "\"><script>" }] } }), /<script>/);
});

test("on a Bots page a border with a width is solid and a press is a button to the keyboard; elsewhere as before", () => {
  const p = page();
  const box = { type: "Stack", style: { borderWidth: 1, borderColor: "#e6e6e6" }, on: { onPress: { kind: "navigateBack" } } };
  const kit = p.draw(box, true);
  assert.match(kit, /border-style:solid/);
  assert.match(kit, /role="button" tabindex="0"/);
  assert.match(p.draw({ ...box, props: { accessibilityLabel: "Speak" } }, true), /aria-label="Speak"/);
  const legacy = p.draw(box, false);
  assert.doesNotMatch(legacy, /border-style:solid/);
  assert.doesNotMatch(legacy, /role="button"/);
});

test("a Text bound to state shows the state's value on a Bots page, and clips to its lines", () => {
  const p = page();
  p.run("STATE = { asked: { result: { text: 'Supabase checks the email.' } } }");
  const html = p.draw({ type: "Text", props: { content: "…", numberOfLines: 1 }, bind: { content: "asked.result.text" } });
  assert.match(html, />Supabase checks the email\.<\/span>$/);
  assert.match(html, /white-space:nowrap;overflow:hidden;text-overflow:ellipsis/);
  assert.match(p.draw({ type: "Text", props: { content: "Hi", numberOfLines: 2 } }), /-webkit-line-clamp:2/);
  // Outside a Bots page (and the onboarding) a bound Text keeps its own words, as before.
  assert.match(p.draw({ type: "Text", props: { content: "Mine" }, bind: { content: "asked.result.text" } }, false), />Mine<\/span>$/);
});

test("Enter in a plain field runs its on.onSubmit", () => {
  const p = page();
  const html = p.draw({ type: "TextField", bind: { value: "ask" }, props: { placeholder: "Ask any bot…" }, on: { onSubmit: { kind: "refresh" } } });
  assert.match(html, /^<input value="" data-s="1" data-bind="ask" placeholder="Ask any bot…"/);
  assert.strictEqual(JSON.stringify(p.run("SUBMITS[0]")), JSON.stringify({ kind: "refresh" }));
  assert.doesNotMatch(p.draw({ type: "TextField", bind: { value: "x" }, props: {} }), /data-s=/);
});

test("navigate fills its params from state", async () => {
  const p = page();
  p.run("STATE = { ask: 'How does sign-in work?', asked: { id: 'd1' } }; __went = null; go = (id, params) => { __went = [id, params]; }");
  await p.run("run({ kind: 'navigate', screenId: 'bots.ask', params: { message: '$state.ask', id: '$state.asked.id', voice: true } })");
  assert.strictEqual(JSON.stringify(p.run("__went")), JSON.stringify(["bots.ask", { message: "How does sign-in work?", id: "d1", voice: true }]));
});
