"use strict";

// The prompt's parts on their own: editing, history, "press again", pickers, Tab, the status line, the welcome box, the
// screen's redraws, "!" commands, and the update check.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PassThrough, Writable } = require("stream");
const { createEditor } = require("../src/ui/editor");
const { createHistory } = require("../src/ui/history");
const { createTwoPress } = require("../src/ui/twoPress");
const { pickerLines, pickerKey, typedPick } = require("../src/ui/picker");
const { createCompleter, pathMatches } = require("../src/ui/complete");
const { elapsed, barLine } = require("../src/ui/statusBar");
const { welcomeLines, TIP } = require("../src/ui/welcome");
const { createScreen } = require("../src/ui/screen");
const { createInput } = require("../src/ui/input");
const { painter, visible, strip } = require("../src/ui/paint");
const { termOf } = require("../src/ui/term");
const { runShell, withAttachments } = require("../src/chat/shell");
const { parseSlash, helpLines, NAMES } = require("../src/chat/slash");
const { createControls } = require("../src/chat/controls");
const { startUpdateCheck, newer } = require("../src/upkeep/updateCheck");
const { TEXT: HELP } = require("../src/commands/help");
const { play } = require("./screen");

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `xode-${name}-`));

test("editing: words, lines, and the usual keys", () => {
  const e = createEditor();
  e.insert("fix the cart");
  e.wordLeft();
  assert.strictEqual(e.pos, 8);
  e.killWord();
  assert.strictEqual(e.text, "fix cart");
  e.end();
  e.insert("\nand the total");
  assert.deepStrictEqual(e.where(), { line: 1, col: 13 });
  assert.ok(e.up());
  assert.deepStrictEqual(e.where(), { line: 0, col: 8 });
  assert.ok(!e.up());
  e.home();
  e.killRight();
  assert.strictEqual(e.text, "\nand the total");
  assert.ok(e.down());
  e.end();
  e.killLeft();
  assert.strictEqual(e.text, "\n");
  e.killLeft();
  assert.strictEqual(e.text, "", "Ctrl+U at a line's start joins it to the one before");
});

test("history: per folder, the last 200, never a line that looks like a secret", () => {
  const dir = tmp("history");
  try {
    const env = { XDG_CONFIG_HOME: dir };
    const h = createHistory("/work/shop", env);
    assert.ok(h.add("fix the cart"));
    assert.ok(!h.add("fix the cart"), "the same line twice in a row is kept once");
    for (const secret of ["my token is abc", "PASSWORD hunter2", "the Secret", "!export API_KEY=abc"]) assert.ok(!h.add(secret), secret);
    assert.ok(!h.add("   "));
    for (let i = 0; i < 205; i += 1) h.add(`line ${i}`);
    const again = createHistory("/work/shop", env).list();
    assert.strictEqual(again.length, 200);
    assert.strictEqual(again[199], "line 204");
    assert.deepStrictEqual(createHistory("/work/blog", env).list(), []);
    const file = path.join(dir, "xode", "history.json");
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(!/hunter2|API_KEY|token/i.test(fs.readFileSync(file, "utf8")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("press again: within the moment it fires, after it, it arms again", () => {
  let t = 0;
  const p = createTwoPress({ ms: 2000, now: () => t });
  assert.strictEqual(p.press("ctrl-c"), false);
  t = 1500;
  assert.strictEqual(p.press("ctrl-c"), true);
  assert.strictEqual(p.press("ctrl-c"), false);
  t = 4000;
  assert.strictEqual(p.press("ctrl-c"), false, "too late: armed again");
  assert.strictEqual(p.press("esc"), false, "another key arms its own");
});

test("what Ctrl+C, Ctrl+D and Esc mean", () => {
  const did = [];
  let job = false;
  let busy = false;
  const hints = [];
  const input = { hint: (h) => hints.push(h), clearHint: () => {} };
  const c = createControls({ input, busy: () => busy, cancel: () => did.push("cancel"), job: () => job, stopJob: () => did.push("stop"), leave: () => did.push("leave") });
  c("esc");
  assert.deepStrictEqual(did, [], "Esc at the prompt does nothing");
  c("ctrl-c");
  assert.strictEqual(hints.pop(), "Press Ctrl+C again to exit");
  c("ctrl-c");
  assert.deepStrictEqual(did.splice(0), ["leave"]);
  c("ctrl-d");
  assert.strictEqual(hints.pop(), "Press Ctrl+D again to exit");
  c("ctrl-d");
  assert.deepStrictEqual(did.splice(0), ["leave"]);
  busy = true;
  c("esc");
  c("ctrl-c");
  assert.deepStrictEqual(did.splice(0), ["cancel", "cancel"], "a message in flight is cancelled at once");
  busy = false;
  job = true;
  c("esc");
  assert.strictEqual(hints.pop(), "Press Esc again to stop the job");
  c("esc");
  assert.deepStrictEqual(did.splice(0), ["stop"]);
  c("ctrl-c");
  assert.strictEqual(hints.pop(), "Press Esc to stop the job, or Ctrl+C again to exit");
  c("esc");
  assert.deepStrictEqual(did.splice(0), ["stop"], "Ctrl+C then Esc stops, as Esc twice would");
  c("esc");
  c("ctrl-c");
  assert.deepStrictEqual(did.splice(0), ["stop"], "Esc then Ctrl+C stops too");
  c("ctrl-c");
  c("ctrl-c");
  assert.deepStrictEqual(did.splice(0), ["leave"], "Ctrl+C twice leaves, the job going on");
});

test("the picker: lines, keys, typed answers", () => {
  const paint = painter(false);
  assert.deepStrictEqual(pickerLines({ title: "Start this plan?", options: ["Yes", "No, tell Xode what to change"], at: 0, paint }), [
    "Start this plan?", "❯ 1. Yes", "  2. No, tell Xode what to change",
  ]);
  const st = { at: 0, count: 3 };
  assert.deepStrictEqual(pickerKey({ name: "down" }, st), { at: 1 });
  assert.deepStrictEqual(pickerKey({ name: "up" }, st), { at: 2 });
  assert.deepStrictEqual(pickerKey({ name: "return" }, st), { pick: 0 });
  assert.deepStrictEqual(pickerKey({ name: "escape" }, st), { pick: 2 });
  assert.deepStrictEqual(pickerKey({ name: "2", sequence: "2" }, st), { pick: 1 });
  assert.strictEqual(pickerKey({ name: "9", sequence: "9" }, st), null);
  const opts = ["Yes", "No, tell Xode what to change"];
  assert.deepStrictEqual(["2", "yes", "n", "No, tell Xode what to change", "maybe"].map((t) => typedPick(t, opts)), [1, 0, 1, 1, -1]);
});

test("Tab: a command after /, a path after @", async () => {
  const paths = async () => ["README.md", "src/", "src/cart/", "src/cart/line.ts", "src/cart/total.ts", "src/catalog.ts"];
  const c = createCompleter({ cwd: "/x", commands: NAMES, paths });
  assert.deepStrictEqual(await c("/st", 3), { text: "/st", pos: 3, options: ["/status", "/stop"] });
  assert.deepStrictEqual(await c("/he", 3), { text: "/help ", pos: 6, options: [] });
  assert.deepStrictEqual(await c("look at @sr", 11), { text: "look at @src/", pos: 13, options: [] });
  assert.deepStrictEqual(await c("look at @src/ca", 15), { text: "look at @src/ca", pos: 15, options: ["src/cart/", "src/catalog.ts"] });
  assert.deepStrictEqual(await c("@src/cart/t", 11), { text: "@src/cart/total.ts ", pos: 19, options: [] });
  assert.deepStrictEqual(await c("@total", 6), { text: "@src/cart/total.ts ", pos: 19, options: [] }, "a file's name, wherever it is");
  assert.strictEqual(await c("no at sign", 10), null);
  assert.deepStrictEqual(pathMatches(await paths(), ""), ["README.md", "src/"]);
});

test("the status line: spinner, stage, time, how to stop", () => {
  assert.deepStrictEqual([elapsed(4000), elapsed(72_000), elapsed(3_780_000)], ["4s", "1m 12s", "1h 3m"]);
  assert.strictEqual(barLine({ word: "Build", since: 1000, tail: "esc to stop" }, 0, painter(false), 73_000), "⠋ Build · 1m 12s · esc to stop");
});

test("the welcome box: Xode, the repository, the folder with ~, one tip; fits 60 columns", () => {
  const home = "/home/ana";
  const term = termOf({ isTTY: true }, { COLUMNS: "60" });
  const lines = welcomeLines({ repo: "ana/storefront", folder: "/home/ana/code/storefront", term, paint: painter(true), home });
  const plain = lines.map(strip);
  assert.ok(plain[0].startsWith("╭") && plain[3].startsWith("╰"));
  assert.match(plain[1], /^│ Xode · ana\/storefront +│$/);
  assert.match(plain[2], /^│ ~\/code\/storefront +│$/);
  assert.strictEqual(plain[4], TIP);
  assert.strictEqual(TIP, "Type what you want · / for commands · Ctrl+C twice to exit");
  for (const l of lines) assert.ok(visible(l) <= 60, l);
  const deep = welcomeLines({ repo: "ana/storefront", folder: "/srv/" + "very-long-folder-name/".repeat(5), term, paint: painter(false), home });
  for (const l of deep) assert.ok(visible(l) <= 60, l);
  assert.deepStrictEqual(welcomeLines({ repo: "ana/storefront", folder: "/x", term: termOf({ isTTY: false }, {}), paint: painter(false) }), ["Xode · ana/storefront"]);
});

test("help: the four ways in and the keys, within 60 columns", () => {
  for (const l of HELP.split("\n")) assert.ok(l.length <= 60, l);
  assert.match(HELP, /xode -p "question" +answer once and exit/);
  assert.match(HELP, /Ctrl\+C twice to exit/);
  assert.ok(!/login/.test(HELP), "the sign-in happens by itself");
  for (const l of helpLines(painter(false))) assert.ok(l.length <= 60, l);
});

test("slash commands: names, aliases, the list, unknown ones", () => {
  assert.deepStrictEqual(parseSlash("/"), { list: true });
  assert.deepStrictEqual(parseSlash("/quit"), { name: "exit" });
  assert.deepStrictEqual(parseSlash("/new"), { name: "clear" });
  assert.deepStrictEqual(parseSlash("/Diff please"), { name: "diff" });
  assert.deepStrictEqual(parseSlash("/frobnicate"), { unknown: "frobnicate" });
});

test("the screen: lines redrawn in place, printing above them, the cursor where the typing is", () => {
  let out = "";
  const sink = { write: (s) => { out += s; } };
  const s = createScreen({ stdout: sink, width: () => 30 });
  s.set(["⠋ Build · 3s · esc to stop", "> hel"], { line: 1, col: 5 });
  s.set(["⠙ Build · 4s · esc to stop", "> hello"], { line: 1, col: 7 });
  s.print("● Check");
  s.print("  · Ran npm test");
  s.set(["⠹ Check · 5s · esc to stop", "> " + "x".repeat(40)], { line: 1, col: 42 });
  const r = play(out, 30);
  assert.deepStrictEqual(r.rows, ["● Check", "  · Ran npm test", "⠹ Check · 5s · esc to stop", "> " + "x".repeat(28), "x".repeat(12)]);
  assert.deepStrictEqual([r.row, r.col], [4, 12]);
  s.clear();
  assert.deepStrictEqual(play(out, 30).rows.filter(Boolean), ["● Check", "  · Ran npm test"]);
});

test("the input layer in keys mode: typing, Ctrl+C clears, a paste is one message, Up brings back the last", async () => {
  const stdin = new PassThrough();
  let text = "";
  const stdout = new Writable({ write(c, e, cb) { text += c; cb(); } });
  const term = termOf({ isTTY: false }, {});
  const input = createInput({ stdin, stdout, env: { XODE_KEYS: "1" }, term, paint: painter(false) });
  const kinds = [];
  input.onInterrupt((k) => kinds.push(k));
  const kept = [];
  input.setHistory({ list: () => kept.slice(), add: (l) => kept.push(l) });
  input.showPrompt(true);
  const tick = () => new Promise((r) => setTimeout(r, 20));
  stdin.write("hello");
  await tick();
  stdin.write("\x03");
  await tick();
  stdin.write("\x03");
  await tick();
  assert.deepStrictEqual(kinds, ["ctrl-c"], "the first Ctrl+C cleared the line; the second is the session's");
  stdin.write("one\rtwo\r");
  assert.deepStrictEqual(await input.next(), { type: "line", text: "one\ntwo" });
  stdin.write("\x1b[200~a\rb\x1b[201~");
  await tick();
  stdin.write("\r");
  assert.deepStrictEqual(await input.next(), { type: "line", text: "a\nb" });
  stdin.write("first \\");
  await tick();
  stdin.write("\r");
  await tick();
  stdin.write("second");
  await tick();
  stdin.write("\r");
  assert.deepStrictEqual(await input.next(), { type: "line", text: "first \nsecond" });
  stdin.write("\x1b[A");
  await tick();
  stdin.write("\r");
  assert.deepStrictEqual(await input.next(), { type: "line", text: "first \nsecond" });
  stdin.write("\x1b");
  await tick();
  stdin.write("\x04");
  await tick();
  assert.deepStrictEqual(kinds, ["ctrl-c", "esc", "ctrl-d"]);
  const picked = input.pick({ title: "Start this plan?", options: ["Yes", "No, tell Xode what to change"] });
  await tick();
  stdin.write("\x1b[B\r");
  assert.strictEqual(await picked, 1);
  const esc = input.pick({ title: "Stop?", options: ["Yes", "No"] });
  stdin.write("\x1b");
  assert.strictEqual(await esc, 1, "Esc takes the last");
  assert.match(text, /> one\n  two/);
  input.close();
});

test("! commands: output kept, the exit code, and what goes in front of the next message", async () => {
  const dir = tmp("shell");
  try {
    const r = await runShell("echo one; echo two 1>&2; sleep 0.05; printf 'xdt_shouldnotshow\\n'; exit 3", { cwd: dir }).done;
    assert.strictEqual(r.code, 3);
    assert.deepStrictEqual(r.shown.slice(0, 2).sort(), ["one", "two"]);
    assert.ok(!r.attachment.includes("xdt_shouldnotshow"), "anything shaped like a sign-in is taken out");
    assert.match(r.attachment, /^I ran: echo one; .*\nexit 3\n(one\ntwo|two\none)\n/);
    const long = await runShell("seq 1 300", { cwd: dir }).done;
    assert.strictEqual(long.shown.length, 200);
    assert.strictEqual(long.hidden, 100);
    assert.strictEqual(long.attachment.split("\n").length, 62);
    assert.strictEqual(withAttachments("why?", ["I ran: x\nexit 0"]), "I ran: x\nexit 0\n\nwhy?");
    assert.strictEqual(withAttachments("why?", []), "why?");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("update check: once a day, cached, said once a day, and off by XODE_NO_UPDATE_CHECK", async () => {
  const dir = tmp("update");
  try {
    let asked = 0;
    let t = Date.UTC(2026, 10, 5);
    const fetchImpl = async (url) => { asked += 1; assert.strictEqual(url, "https://registry.npmjs.org/@xooteqlab/xode/latest"); return { ok: true, json: async () => ({ version: "0.2.0" }) }; };
    const env = { XDG_CONFIG_HOME: dir };
    const a = startUpdateCheck({ env, version: "0.1.0", fetchImpl, now: () => t });
    await a.done;
    assert.strictEqual(asked, 1);
    assert.strictEqual(a.notice(), "xode 0.2.0 is out (you have 0.1.0): npm i -g @xooteqlab/xode@latest");
    const kept = JSON.parse(fs.readFileSync(path.join(dir, "xode", "update.json"), "utf8"));
    assert.strictEqual(kept.latest, "0.2.0");
    t += 60_000;
    const b = startUpdateCheck({ env, version: "0.1.0", fetchImpl, now: () => t });
    await b.done;
    assert.strictEqual(asked, 1, "the kept answer is used within the day");
    assert.strictEqual(b.notice(), "", "said once a day");
    t += 25 * 60 * 60_000;
    const c = startUpdateCheck({ env, version: "0.1.0", fetchImpl, now: () => t });
    await c.done;
    assert.strictEqual(asked, 2);
    assert.match(c.notice(), /0\.2\.0 is out/);
    const off = startUpdateCheck({ env: { ...env, XODE_NO_UPDATE_CHECK: "1" }, version: "0.1.0", fetchImpl, now: () => t + 3 * 86_400_000 });
    await off.done;
    assert.strictEqual(asked, 2);
    assert.strictEqual(off.notice(), "");
    // A registry that doesn't answer in time holds nothing up.
    const slow = startUpdateCheck({ env: { XDG_CONFIG_HOME: tmp("update-slow") }, version: "0.1.0", fetchImpl: () => new Promise(() => {}), now: () => t });
    assert.strictEqual(slow.notice(), "");
    assert.ok(newer("0.10.0", "0.9.9") && !newer("0.1.0", "0.1.0") && newer("1.0.0", "1.0.0-rc.1") && !newer("x", "0.1.0"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
