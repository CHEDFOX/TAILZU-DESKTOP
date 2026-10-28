// This computer's Accessibility in the window's screen state ($state.axGranted, sdui.js axFollow): the Bots app's
// arrival card moves on, and closes, once it is on. Run as the page runs sdui.js, with a stand-in bridge.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function page(axStatus) {
  const noop = () => {};
  const g = {
    console: { warn: noop, log: noop, error: noop },
    setTimeout, clearTimeout, setInterval, clearInterval, Promise, JSON, Object, Array, String, Number, Math, Date, RegExp, Error,
    navigator: { language: "en-US" },
    innerWidth: 1280, innerHeight: 800, devicePixelRatio: 2,
    addEventListener: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop }),
    document: { addEventListener: noop, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], activeElement: null },
    tailzuApp: { env: () => new Promise(() => {}), onKnobs: noop, onNavigate: noop, onDictated: noop, onNotes: noop },
  };
  if (axStatus) g.tailzuApp.axStatus = async () => axStatus.value;
  g.window = g;
  const ctx = vm.createContext(g);
  for (const f of ["knobs.js", "sdui.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx, { filename: f });
  vm.runInContext('ENV = { askSetup: false }; globalThis.__repaints = 0; repaint = () => { globalThis.__repaints++; }', ctx);
  return { run: (code) => vm.runInContext(code, ctx) };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

test("the window declares DeskAxState only with a main process that reads Accessibility", () => {
  assert.ok(page({ value: "granted" }).run("capabilities().components").includes("DeskAxState"));
  assert.ok(!page(null).run("capabilities().components").includes("DeskAxState"));
});

test("a page that asks after Accessibility gets the computer's answer in $state.axGranted, and only such a page", async () => {
  const status = { value: "denied" };
  const p = page(status);
  p.run("CURRENT_SCREEN = { state: { axGranted: null }, root: { type: 'Stack' } }; STATE = { axGranted: null }");
  p.run("axFollow()");
  await settle();
  assert.strictEqual(p.run("STATE.axGranted"), false);
  assert.strictEqual(p.run("__repaints"), 1);
  // Turned on in System Settings, then back to the window: read again, and the step goes.
  status.value = "granted";
  p.run("axFollow()");
  await settle();
  assert.strictEqual(p.run("STATE.axGranted"), true);
  assert.strictEqual(p.run("__repaints"), 2);
  // Unchanged: no repaint.
  p.run("axFollow()");
  await settle();
  assert.strictEqual(p.run("__repaints"), 2);
  // A system with no such switch (Windows, Linux) is nothing to ask for.
  const win = page({ value: "unknown" });
  win.run("CURRENT_SCREEN = { state: { axGranted: null }, root: { type: 'Stack' } }; STATE = { axGranted: null }");
  win.run("axFollow()");
  await settle();
  assert.strictEqual(win.run("STATE.axGranted"), true);
  // A page that does not ask is left alone.
  p.run("CURRENT_SCREEN = { state: {}, root: { type: 'Stack' } }; STATE = {}");
  status.value = "denied";
  p.run("axFollow()");
  await settle();
  assert.strictEqual(p.run("STATE.axGranted"), undefined);
});

test("a main process that cannot answer leaves the state as it was", async () => {
  const p = page({ value: "granted" });
  p.run("window.tailzuApp.axStatus = async () => { throw new Error('gone'); }");
  p.run("CURRENT_SCREEN = { state: { axGranted: null }, root: { type: 'Stack' } }; STATE = { axGranted: null }");
  p.run("axFollow()");
  await settle();
  assert.strictEqual(p.run("STATE.axGranted"), null);
});
