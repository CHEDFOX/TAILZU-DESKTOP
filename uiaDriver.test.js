// The Windows native driver, tested two ways: the Node side against a fake
// helper that speaks the protocol (and misbehaves on purpose), the way the
// real PowerShell cannot be run here; and the PowerShell script itself read as
// text for the pieces that matter, the way frontApp.test.js checks its scripts.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { createUiaDriver, scriptPath, defaultCommand, loaderText } = require("./uiaDriver.js");
const defaultExport = require("./uiaDriver.js");
const FAKE = path.join(__dirname, "native", "fake-uia-helper.js");

// A driver wired to the fake helper, spawned for real as a Node process.
function fakeDriver(mode, stateFile, extra = {}) {
  const args = [FAKE, mode];
  if (stateFile) args.push(stateFile);
  return createUiaDriver({
    spawn,
    command: { cmd: process.execPath, args },
    warmupMs: 3000,
    snapshotTimeout: 1500,
    actionTimeout: 1500,
    ...extra,
  });
}

test("a normal helper answers snapshot in the contract's shape", async () => {
  const d = fakeDriver("normal");
  try {
    const snap = await d.snapshot({ max: 20 });
    assert.strictEqual(snap.ok, true);
    assert.strictEqual(snap.scale, "pixels");
    assert.ok(Array.isArray(snap.elements));
    assert.deepStrictEqual(snap.app, { name: "Fake", pid: 42 });
    assert.strictEqual("id" in snap, false, "the request id is the driver's, not the caller's");
    assert.strictEqual(snap.echoMax, 20);
    // The window's title comes back for the device's own checks.
    assert.strictEqual(typeof snap.window.title, "string");
  } finally { d.stop(); }
});

test("a snapshot sends the walk a time budget well inside its own timeout", async () => {
  const d = fakeDriver("normal");
  try {
    // The default 1500 ms call: about 60% of it, so a huge tree comes back
    // truncated before the call would time out.
    assert.strictEqual((await d.snapshot({ max: 5 })).echoBudget, 900);
    assert.strictEqual((await d.snapshot({ max: 5, timeoutMs: 5000 })).echoBudget, 3000);
    // Never less than a usable minimum, and never past the call's own end.
    assert.strictEqual((await d.snapshot({ max: 5, timeoutMs: 150 })).echoBudget, 80);
    for (const t of [400, 1000, 1500, 3000, 10000]) {
      const b = (await d.snapshot({ max: 5, timeoutMs: t })).echoBudget;
      assert.ok(b >= 80 && b <= Math.max(80, t - 300), `budget ${b} for a ${t} ms call`);
    }
  } finally { d.stop(); }
});

test("a write to a helper that stopped reading is swallowed, and its exit settles every call", async () => {
  // Without an 'error' listener on the helper's stdin, the EPIPE from this
  // write is an uncaught exception (in Electron, the main-process error box).
  const uncaught = [];
  const onUncaught = (e) => uncaught.push(e);
  process.on("uncaughtException", onUncaught);
  // The fake answers the warm-up ping, then closes its end of the pipe and
  // lingers before exiting, so every one of these writes finds nobody reading.
  const d = fakeDriver("deaf", null, { actionTimeout: 3000 });
  try {
    const first = d.press("e1");
    await new Promise((r) => setTimeout(r, 200));
    const second = d.press("e2");
    const third = d.click("e3");
    const answers = await Promise.all([first, second, third]);
    for (const a of answers) assert.deepStrictEqual(a, { ok: false, error: "dead" });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepStrictEqual(uncaught.map(String), [], "no uncaught EPIPE");
  } finally {
    process.removeListener("uncaughtException", onUncaught);
    d.stop();
  }
});

test("a helper stopped and replaced cannot reap the one that replaced it", async () => {
  const d = fakeDriver("normal");
  try {
    assert.strictEqual((await d.snapshot({ max: 3 })).ok, true);
    // stop() kills the helper; its 'exit' arrives while the next call is
    // already talking to a new one, and must not settle that call as dead.
    d.stop();
    const again = await d.snapshot({ max: 4 });
    assert.strictEqual(again.ok, true, JSON.stringify(again));
    assert.strictEqual(again.echoMax, 4);
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual((await d.snapshot({ max: 5 })).echoMax, 5, "the new helper is still the live one");
  } finally { d.stop(); }
});

test("every action verb reaches the helper and resolves", async () => {
  const d = fakeDriver("normal");
  try {
    assert.strictEqual((await d.press("e1")).ok, true);
    assert.strictEqual((await d.click("e1")).ok, true);
    assert.strictEqual((await d.setValue("e1", "hi")).ok, true);
    assert.strictEqual((await d.focus("e1")).ok, true);
    assert.strictEqual((await d.scroll("e1", "down", 3)).ok, true);
    assert.strictEqual((await d.scroll(null, "up", 2)).ok, true);
    assert.strictEqual((await d.key("ctrl+k")).ok, true);
    assert.strictEqual((await d.open("Slack")).ok, true);
    const t = await d.trusted({ prompt: false });
    assert.deepStrictEqual(t, { ok: true, trusted: true });
  } finally { d.stop(); }
});

// ---- look (v2 §A) ----------------------------------------------------------------
test("look answers in the §A shape, with the contract's defaults sent", async () => {
  const d = fakeDriver("normal");
  try {
    const l = await d.look();
    assert.strictEqual(l.ok, true, JSON.stringify(l).slice(0, 200));
    assert.strictEqual("id" in l, false, "the request id is the driver's, not the caller's");
    assert.deepStrictEqual(l.window, { frame: [-1820, 50, 800, 600], title: "Fake window" });
    assert.strictEqual(l.scale, "pixels");
    assert.deepStrictEqual(l.lines, [
      { text: "Export as PDF", frame: [-1800, 70, 94, 18] },
      { text: "x\u00b2 + 1 = 0", frame: [-1700, 350, 120, 30] },
    ]);
    assert.deepStrictEqual(Object.keys(l.image).sort(), ["data", "height", "mime", "width"]);
    assert.strictEqual(l.image.mime, "image/jpeg");
    assert.ok(typeof l.image.data === "string" && l.image.data.length > 0);
    assert.strictEqual(l.image.width, 800);
    assert.strictEqual(typeof l.ms, "number");
    assert.strictEqual(l.ocr, "ok", "the helper's OCR state rides along");
    // { budgetMs = 1500, maxSide = 1600, quality = 0.82, ocr = true, image = true }
    assert.deepStrictEqual(l.echo, { budgetMs: 1500, maxSide: 1600, quality: 0.82, ocr: true, image: true });
  } finally { d.stop(); }
});

test("look's options are sent sane, and the budget always fits inside the call's timeout", async () => {
  const d = fakeDriver("normal");
  try {
    let e = (await d.look({ budgetMs: 900, maxSide: 1024, quality: 0.5, ocr: false, image: false })).echo;
    assert.deepStrictEqual(e, { budgetMs: 900, maxSide: 1024, quality: 0.5, ocr: false, image: false });
    e = (await d.look({ budgetMs: 5, maxSide: 99999, quality: 82 })).echo;
    assert.deepStrictEqual(e, { budgetMs: 100, maxSide: 4096, quality: 0.82, ocr: true, image: true }, "clamped; a percentage read as one");
    e = (await d.look({ budgetMs: "soon", maxSide: -3, quality: "x" })).echo;
    assert.deepStrictEqual(e, { budgetMs: 1500, maxSide: 64, quality: 0.82, ocr: true, image: true }, "junk falls back");
    // A longer budget is honoured (the timeout grows with it)...
    assert.strictEqual((await d.look({ budgetMs: 4000 })).echo.budgetMs, 4000);
    // ...but an explicit timeout wins, and the budget is cut to fit inside it.
    assert.strictEqual((await d.look({ budgetMs: 1500, timeoutMs: 1000 })).echo.budgetMs, 200);
    assert.strictEqual((await d.look({ timeoutMs: 500 })).echo.budgetMs, 100);
    assert.strictEqual((await d.look(null)).ok, true, "no options at all");
  } finally { d.stop(); }
  // The default timeout is the contract's 2500 ms.
  const js = fs.readFileSync(path.join(__dirname, "uiaDriver.js"), "utf8");
  assert.match(js, /lookTimeout: 2500/);
});

test("look has its own timeout, and a snapshot asked after it is not held behind it", async () => {
  // The fake makes a look as the real helper does, on its own, answering it
  // 400 ms later while it answers everything else at once.
  const d = fakeDriver("slowlook", null, { actionTimeout: 150, snapshotTimeout: 150 });
  try {
    const order = [];
    const look = d.look().then((r) => { order.push("look"); return r; });
    const snap = d.snapshot({ max: 3 }).then((r) => { order.push("snapshot"); return r; });
    const [l, s] = await Promise.all([look, snap]);
    assert.strictEqual(s.ok, true, "the snapshot answered inside its 150 ms");
    assert.strictEqual(l.ok, true, "the look outlived the action timeout on its own one");
    assert.deepStrictEqual(order, ["snapshot", "look"]);
    assert.strictEqual((await d.press("e1")).ok, true);
  } finally { d.stop(); }
});

test("a look that never comes back resolves timeout within its own timeout", async () => {
  const d = fakeDriver("hanglook", null, { lookTimeout: 500 });
  try {
    let t0 = Date.now();
    assert.deepStrictEqual(await d.look({ timeoutMs: 300 }), { ok: false, error: "timeout" });
    let took = Date.now() - t0;
    assert.ok(took >= 280 && took < 1200, `explicit: ${took} ms`);
    // Without one: the larger of lookTimeout and the budget plus the margin.
    t0 = Date.now();
    assert.deepStrictEqual(await d.look({ budgetMs: 100 }), { ok: false, error: "timeout" });
    took = Date.now() - t0;
    assert.ok(took >= 850 && took < 2000, `default: ${took} ms`);
    // The helper is still answering everything else.
    assert.strictEqual((await d.snapshot({ max: 2 })).ok, true);
  } finally { d.stop(); }
});

test("a window-sized picture arrives whole across many reads", async () => {
  const d = fakeDriver("biglook");
  try {
    const l = await d.look();
    assert.strictEqual(l.ok, true);
    assert.strictEqual(l.image.data.length, 2000000);
    assert.strictEqual(l.lines.length, 2);
  } finally { d.stop(); }
});

test("an answer read in small pieces, its newline arriving with the start of the next answer, is read whole and in order", async () => {
  const { EventEmitter } = require("node:events");
  const pieces = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stdin = new EventEmitter();
  child.stdin.end = () => {};
  child.kill = () => {};
  child.stdin.write = (s) => {
    const m = JSON.parse(s);
    if (m.cmd === "ping") { setImmediate(() => child.stdout.emit("data", JSON.stringify({ id: m.id, ok: true }) + "\n")); return; }
    if (m.cmd === "look") {
      const look = JSON.stringify({ id: m.id, ok: true, window: { frame: [0, 0, 800, 600], title: "" }, scale: "pixels", lines: [],
        image: { mime: "image/jpeg", data: "A".repeat(300000), width: 800, height: 600 }, ms: 1 });
      // A stray line for nobody, started in the same piece as the look's newline.
      const all = look + "\n" + JSON.stringify({ id: 999, ok: true }) + "\n";
      for (let i = 0; i < all.length; i += 4096) pieces.push(all.slice(i, i + 4096));
      setImmediate(function next() { if (pieces.length) { child.stdout.emit("data", pieces.shift()); setImmediate(next); } });
    }
  };
  const d = createUiaDriver({ spawn: () => child, command: { cmd: "x", args: [] }, warmupMs: 1000 });
  const l = await d.look({ timeoutMs: 3000 });
  assert.strictEqual(l.ok, true);
  assert.strictEqual(l.image.data.length, 300000);
  d.stop();
});

test("a look answer that keeps to nothing is made to keep to the contract", async () => {
  const d = fakeDriver("badlook");
  try {
    const l = await d.look();
    assert.strictEqual(l.ok, true);
    assert.strictEqual(l.window.title, "", "a title that is not a string is empty");
    assert.strictEqual(l.scale, "pixels", "Windows answers in physical pixels, always");
    assert.strictEqual(l.lines.length, 300, "at most 300 lines");
    assert.ok(l.lines.every((x) => typeof x.text === "string" && x.text.trim() && x.text.length <= 120 && x.frame.length === 4));
    assert.strictEqual(l.lines[0].text.slice(0, 7), "line 0 ", "the junk lines were dropped, the good ones kept in order");
    assert.strictEqual(l.lines[0].conf, 0.5, "a confidence is kept when one is sent");
    assert.strictEqual(l.image, null, "a picture with no data is none");
    assert.strictEqual(l.ms, 0);
  } finally { d.stop(); }
  const nw = fakeDriver("nowindow");
  try { assert.deepStrictEqual(await nw.look(), { ok: false, error: "no_window" }); } finally { nw.stop(); }
  const nf = fakeDriver("noframe");
  try { assert.deepStrictEqual(await nf.look(), { ok: false, error: "bad_answer" }, "no frame, nothing to measure against"); } finally { nf.stop(); }
});

test("look on a helper that cannot be spawned resolves unavailable", async () => {
  const d = createUiaDriver({ spawn() { throw new Error("no such binary"); }, command: { cmd: "nope", args: [] }, warmupMs: 200 });
  assert.deepStrictEqual(await d.look({ timeoutMs: 300 }), { ok: false, error: "unavailable" });
  d.stop();
});

test("answers are matched by id even when they come back out of order", async () => {
  const d = fakeDriver("reorder");
  try {
    // Two snapshots in flight; the helper answers the second one first.
    const [a, b] = await Promise.all([d.snapshot({ max: 11 }), d.snapshot({ max: 22 })]);
    assert.strictEqual(a.echoMax, 11, "first call got its own answer back");
    assert.strictEqual(b.echoMax, 22, "second call got its own answer back");
  } finally { d.stop(); }
});

test("a command the helper never answers resolves as a timeout, not a rejection", async () => {
  const d = fakeDriver("timeout");
  try {
    const snap = await d.snapshot({ max: 5, timeoutMs: 150 });
    assert.deepStrictEqual(snap, { ok: false, error: "timeout" });
  } finally { d.stop(); }
});

test("an answer that arrives after the timeout is ignored and does not break the driver", async () => {
  const d = fakeDriver("late");
  try {
    const snap = await d.snapshot({ max: 5, timeoutMs: 80 });
    assert.deepStrictEqual(snap, { ok: false, error: "timeout" });
    // The late answer (~300 ms) lands with no pending request; it must be
    // dropped, not mis-settle the next call or throw.
    await new Promise((r) => setTimeout(r, 400));
    const t = await d.trusted();
    assert.strictEqual(t.ok, true);
  } finally { d.stop(); }
});

test("a dead helper is respawned on the next call", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tz-uia-"));
  const stateFile = path.join(dir, "spawns");
  const d = fakeDriver("die", stateFile);
  try {
    const first = await d.snapshot({ max: 5 });
    assert.strictEqual(first.ok, false, "the first helper died mid-call");
    assert.strictEqual(first.error, "dead");
    const second = await d.snapshot({ max: 5 });
    assert.strictEqual(second.ok, true, "the next call respawned a working helper");
  } finally {
    d.stop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test("non-JSON lines from the helper are skipped, not mistaken for answers", async () => {
  const d = fakeDriver("garbage");
  try {
    const snap = await d.snapshot({ max: 7 });
    assert.strictEqual(snap.ok, true);
    assert.strictEqual(snap.echoMax, 7);
  } finally { d.stop(); }
});

test("a helper that cannot be spawned resolves unavailable, never throws", async () => {
  const d = createUiaDriver({
    spawn() { throw new Error("no such binary"); },
    command: { cmd: "nope", args: [] },
    warmupMs: 200,
  });
  const snap = await d.snapshot({ max: 5, timeoutMs: 200 });
  assert.deepStrictEqual(snap, { ok: false, error: "unavailable" });
  d.stop();
});

test("the module is the §1 API and start/stop are idempotent", () => {
  for (const name of ["available", "start", "stop", "trusted", "snapshot", "press", "click", "setValue", "focus", "scroll", "key", "open", "look"]) {
    assert.strictEqual(typeof defaultExport[name], "function", `exports.${name}`);
  }
  // Idempotent and non-throwing even on a platform with no helper.
  assert.doesNotThrow(() => { defaultExport.start(); defaultExport.start(); defaultExport.stop(); });
});

test("available() reflects the platform, but a fake-wired driver is available", () => {
  assert.strictEqual(fakeDriver("normal").available(), true);
  if (process.platform !== "win32") {
    assert.strictEqual(defaultExport.available(), false, "no Windows helper off Windows");
  }
});

test("the launch command runs the helper as encoded command text, never -File", () => {
  const c = defaultCommand();
  assert.strictEqual(c.cmd, "powershell.exe");
  assert.ok(c.args.includes("-NoProfile") && c.args.includes("-NonInteractive"));
  // A Group-Policy execution policy blocks an unsigned -File whatever
  // -ExecutionPolicy says; command text is not subject to it (frontApp's way).
  assert.ok(!c.args.includes("-File"), "no -File");
  const i = c.args.indexOf("-EncodedCommand");
  assert.ok(i >= 0 && i === c.args.length - 2, "-EncodedCommand is the last flag, with its text");
  const text = Buffer.from(c.args[i + 1], "base64").toString("utf16le");
  assert.strictEqual(text, loaderText(scriptPath()));
  assert.ok(text.includes("ReadAllText('" + scriptPath().replace(/'/g, "''") + "')"), text);
  assert.match(text, /^\. \(\[scriptblock\]::Create\(/, "dot-sourced, so the script's maps share one scope");
  // Well inside the command line's 32K characters, whatever the script's size.
  assert.ok(c.args.join(" ").length < 4000);
  assert.ok(scriptPath().endsWith(path.join("native", "uia-agent.ps1")) || scriptPath().endsWith("uia-agent.ps1"));
});

test("the loader quotes any path safely", () => {
  // A quote is the only character a single-quoted PowerShell string needs
  // escaped (doubled); $, backtick and spaces are literal there.
  const odd = "C:\\Users\\O'Brien $x `y\\AppData\\Tailzu\\uia-agent.ps1";
  const text = loaderText(odd);
  assert.strictEqual(text, ". ([scriptblock]::Create([System.IO.File]::ReadAllText('C:\\Users\\O''Brien $x `y\\AppData\\Tailzu\\uia-agent.ps1')))");
  const c = defaultCommand(odd);
  assert.strictEqual(Buffer.from(c.args[c.args.length - 1], "base64").toString("utf16le"), text);
  // PowerShell takes the typographic single quotes for quotes as well, so a
  // profile folder typed with one (O’Brien) is doubled the same way, each
  // quote with its own character, and nothing else in the path changes.
  for (const q of ["\u2018", "\u2019", "\u201A", "\u201B"]) {
    const curly = `C:\\Users\\O${q}Brien\\AppData\\Local\\Programs\\Tailzu\\resources\\uia-agent.ps1`;
    assert.strictEqual(loaderText(curly),
      `. ([scriptblock]::Create([System.IO.File]::ReadAllText('C:\\Users\\O${q}${q}Brien\\AppData\\Local\\Programs\\Tailzu\\resources\\uia-agent.ps1')))`);
  }
  assert.ok(loaderText("C:\\a\u2019'b.ps1").includes("('C:\\a\u2019\u2019''b.ps1')"));
});

// ---- The PowerShell script, read as text ---------------------------------------
test("the helper script carries the pieces the contract depends on", () => {
  const ps = fs.readFileSync(path.join(__dirname, "native", "uia-agent.ps1"), "utf8");

  // One cached cross-process walk.
  assert.match(ps, /New-Object System\.Windows\.Automation\.CacheRequest/);
  assert.match(ps, /BoundingRectangleProperty/);
  assert.match(ps, /ControlViewCondition/);
  assert.match(ps, /FindAll\(\$TS::Children/);

  // A password field is listed secure and never valued.
  assert.match(ps, /IsPasswordProperty/);
  assert.match(ps, /\$item\.secure = \$true/);

  // The selection is read from the focused element's TextPattern.
  assert.match(ps, /TextPattern/);
  assert.match(ps, /GetSelection\(\)/);

  // Physical pixels.
  assert.match(ps, /scale = 'pixels'/);

  // The elevated refusal, before any input action.
  assert.match(ps, /ProcElevated/);
  assert.match(ps, /error = 'elevated'/);

  // The key table and layout-aware character mapping.
  assert.match(ps, /'enter' = 0x0D/);
  assert.match(ps, /VkKeyScanEx/);
  assert.match(ps, /GetKeyboardLayout/);
  assert.match(ps, /SendInput/);

  // Invoke runs off the reader loop so a modal cannot wedge the helper.
  assert.match(ps, /TzInvokeBounded/);
  assert.match(ps, /BeginInvoke/);
  assert.match(ps, /pending = \$true/);

  // The foreground-lock workaround and its refusal.
  assert.match(ps, /ForceForeground/);
  assert.match(ps, /AttachThreadInput/);
  assert.match(ps, /not_foreground/);

  // A URL/address bar's value is label-only.
  assert.match(ps, /\$isUrlField/);

  // Its own process, launched the frontApp way.
  assert.match(ps, /OWN process/);
});

// The text of one PowerShell function, from its "function Name" line to the
// next top-level one, for checks that must hold inside that function.
function psFunction(ps, name) {
  const at = new RegExp(`\\nfunction ${name}\\b`).exec(ps);
  assert.ok(at, `function ${name} exists`);
  const start = at.index;
  const next = ps.indexOf("\nfunction ", start + 1);
  return ps.slice(start, next < 0 ? undefined : next);
}
const PS_TEXT = () => fs.readFileSync(path.join(__dirname, "native", "uia-agent.ps1"), "utf8");

test("the helper is per-monitor DPI aware before UI Automation loads", () => {
  const ps = PS_TEXT();
  // Per-monitor v2 (-4), with the older system-wide call as the fallback, so
  // SetCursorPos takes the physical pixels UI Automation gives.
  assert.match(ps, /SetProcessDpiAwarenessContext\(new IntPtr\(-4\)\)/);
  assert.match(ps, /SetProcessDPIAware\(\)/);
  const call = ps.indexOf("[TzAgent]::MakeDpiAware()");
  const uia = ps.indexOf("Add-Type -AssemblyName UIAutomationClient");
  assert.ok(call > 0 && uia > 0 && call < uia, "made aware first, then UI Automation");
  assert.match(ps, /pong = \$true; dpi = \$script:dpi/, "the ping says which awareness took");
});

test("the helper's C# stays C# 5, which Windows PowerShell 5.1 compiles", () => {
  const ps = PS_TEXT();
  // Every block: TzAgent's, and the look's own (TzShot).
  const blocks = [...ps.matchAll(/Add-Type[^\n]*-TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/g)].map((m) => m[1]);
  assert.strictEqual(blocks.length, 2, "two C# blocks");
  assert.ok(blocks.some((cs) => /class TzAgent\b/.test(cs)) && blocks.some((cs) => /class TzShot\b/.test(cs)));
  for (const cs of blocks) {
    assert.doesNotMatch(cs, /\$"/, "no interpolated strings");
    assert.doesNotMatch(cs, /=>/, "no expression-bodied members or lambdas");
    assert.doesNotMatch(cs, /\bout var\b/, "no out var");
    assert.doesNotMatch(cs, /\?\./, "no null-conditional");
    assert.doesNotMatch(cs, /\bnameof\(/, "no nameof");
    assert.doesNotMatch(cs, /\(\s*\w+\s*,\s*\w+\s*\)\s+\w+\s*\(/, "no tuple returns");
    assert.doesNotMatch(cs, /\{\s*get;[^}]*\}\s*=/, "no auto-property initializers");
    assert.doesNotMatch(cs, /\bcatch\s*\([^)]*\)\s*when\b/, "no exception filters");
    // C# reads U+2028/U+2029 as line breaks, so one typed into a char
    // literal splits it; they must be written as escapes.
    assert.doesNotMatch(cs, /[\u2028\u2029]/, "no raw line separators");
  }
});

test("no two variables in the helper differ only by case", () => {
  // PowerShell's names ignore case: a local $vp IS the script's $VP (the
  // ValuePattern type), and once assigned, $VP::Pattern reads as null. That
  // broke setValue and the selection before, and a look worker's $k once
  // overwrote its $K. So every spelling of a name must be the one spelling.
  const code = PS_TEXT().replace(/@'\r?\n[\s\S]*?\r?\n'@/g, "").replace(/#.*$/gm, "");
  const seen = new Map();
  for (const v of code.match(/\$(?:script:)?[A-Za-z_][A-Za-z0-9_]*/g) || []) {
    const k = v.toLowerCase();
    if (!seen.has(k)) seen.set(k, new Set());
    seen.get(k).add(v);
  }
  const clashes = [...seen.values()].filter((s) => s.size > 1).map((s) => [...s].join("/"));
  assert.deepStrictEqual(clashes, []);
  // The two that clashed, fixed where they were.
  assert.match(psFunction(PS_TEXT(), "TzSetValue"), /TryGetCurrentPattern\(\$VP::Pattern, \[ref\]\$valp\)/);
  assert.match(psFunction(PS_TEXT(), "TzSnapshot"), /TryGetCurrentPattern\(\$VP::Pattern, \[ref\]\$valp\)/);
});

test("the walk has a time budget and comes back truncated when it runs out", () => {
  const ps = PS_TEXT();
  const snap = psFunction(ps, "TzSnapshot");
  assert.match(snap, /function TzSnapshot\(\[int\]\$max, \[int\]\$budget\)/);
  // Both loop guards: inside a level and between levels.
  const guards = snap.match(/\$count -ge \$max -or \$visited -ge \$MAX_NODES -or \$sw\.ElapsedMilliseconds -ge \$budget\) \{ \$truncated = \$true; break \}/g) || [];
  assert.strictEqual(guards.length, 2, "both loop guards check the clock");
  // The command reads the budget the driver sends, with a default.
  assert.match(ps, /\$msg\.budgetMs/);
  assert.match(ps, /TzSnapshot \$max \$budget/);
  assert.match(ps, /\$BUDGET_MS = \d+/);
});

test("a web page's read-only root Document is not listed, and no title or URL is sent", () => {
  const ps = PS_TEXT();
  // Not mapped to an area wholesale.
  assert.doesNotMatch(ps, /'ControlType\.Document' = 'area'/);
  const snap = psFunction(ps, "TzSnapshot");
  // An area only when it can be typed into; otherwise no role (its children
  // are still walked).
  assert.match(snap, /if \(\$ctName -eq 'ControlType\.Document'\) \{\s*\$role = \$null\s*if \(\(TzGP \$el \$AE::IsValuePatternAvailableProperty\) -eq \$true -and \(TzGP \$el \$VP::IsReadOnlyProperty\) -eq \$false\) \{ \$role = 'area' \}/);
  // A window is never labelled with its title, a Document not with the
  // title or part of it, and a caption drawn as text is not listed.
  assert.match(snap, /if \(\$role -eq 'window'\) \{ \$label = '' \}/);
  assert.match(snap, /\$ctName -eq 'ControlType\.Document' -and \$title[\s\S]*?\$title\.IndexOf\(/);
  assert.match(snap, /\$role -eq 'text' -and \$title -and \(TzClean \$name \$TITLE_READ\) -ieq \$title\) \{ \$role = \$null \}/);
  // A value that is an address is never sent.
  assert.match(snap, /\$v -notmatch \$URL_VALUE/);
  const m = ps.match(/\$URL_VALUE = '([^']+)'/);
  assert.ok(m, "$URL_VALUE");
  const url = new RegExp(m[1].replace(/^\(\?i\)/, ""), "i");
  for (const v of ["https://docs.google.com/document/d/abc/edit", "  HTTP://x.example", "file:///C:/Users/me/a.pdf", "www.example.com/x"]) {
    assert.ok(url.test(v), `refused value ${v}`);
  }
  for (const v of ["Note: buy milk", "hello world", "Re: lunch", "3:30 pm"]) {
    assert.ok(!url.test(v), `kept value ${v}`);
  }
});

test("the snapshot carries the window's title locally, as window.title", () => {
  const ps = PS_TEXT();
  const snap = psFunction(ps, "TzSnapshot");
  assert.match(ps, /\$TITLE_MAX = 200/);
  assert.match(snap, /\[TzAgent\]::WindowTitle\(\$h\)\) \$TITLE_READ/);
  assert.match(snap, /\$window = \[ordered\]@\{ frame = \$frame; title = \(TzTitleCap "\$title"\) \}/);
  // Capped with its END kept: a browser marks a private window at the end of
  // its title, and agent.js refuses the window on that marker. The walk
  // compares against the whole title; only what goes out is capped.
  const cap = psFunction(ps, "TzTitleCap");
  assert.match(cap, /if \(\$t\.Length -le \$TITLE_MAX\) \{ return \$t \}/);
  assert.match(cap, /\$t\.Substring\(0, \$TITLE_MAX - \$tail - 5\) \+ ' \.\.\. ' \+ \$t\.Substring\(\$t\.Length - \$tail\)/);
  const tail = Number((cap.match(/\$tail = (\d+)/) || [])[1]);
  assert.ok(tail >= 40 && tail <= 120, "a tail long enough for the marker, short of the whole cap");
  // The same arithmetic, on a long private window's title.
  const capJs = (t) => (t.length <= 200 ? t : t.slice(0, 200 - tail - 5) + " ... " + t.slice(t.length - tail));
  const long = "Re: ".repeat(60) + "the quarterly plan - me@corp.com - Gmail - Mozilla Firefox Private Browsing";
  const out = capJs(long);
  assert.strictEqual(out.length, 200);
  assert.ok(out.endsWith("Mozilla Firefox Private Browsing") && out.startsWith("Re: Re: "));
  assert.strictEqual(capJs("Short - Microsoft Edge"), "Short - Microsoft Edge");
  assert.match(ps, /\$TITLE_READ = \d{3,}/);
  assert.match(ps, /new StringBuilder\(1024\)/);
  // Read without messaging the app, so a hung window cannot stall the walk.
  assert.match(ps, /GetWindowText\(IntPtr h, StringBuilder sb, int max\)/);
  assert.doesNotMatch(ps, /GetWindowTextLength/);
});

test("a click reads the element's rectangle live and refuses one that is gone", () => {
  const ps = PS_TEXT();
  const live = psFunction(ps, "TzLiveRect");
  // A method call, since PowerShell turns a property getter's exception into
  // $null; a dead element must throw, and say "gone".
  assert.match(live, /GetCurrentPropertyValue\(\$AE::IsOffscreenProperty\)/);
  assert.match(live, /GetCurrentPropertyValue\(\$AE::BoundingRectangleProperty\)/);
  assert.match(live, /catch \{ return @\{ error = 'gone' \} \}/);
  assert.match(live, /error = 'offscreen'/);
  assert.match(live, /error = 'no_rect'/);
  const click = psFunction(ps, "TzClickEl");
  assert.doesNotMatch(click, /TzRect /, "never the snapshot's cached rectangle");
  const first = click.indexOf("TzLiveRect");
  const fg = click.indexOf("TzEnsureForeground");
  const second = click.indexOf("TzLiveRect", first + 1);
  const cursor = click.indexOf("SetCursorPos");
  assert.ok(first >= 0 && first < fg && fg < second && second < cursor, "live before the foreground dance and again before the click");
  // An element whose own window cannot be found is checked against the
  // window that was in front when it was walked, never "whatever is".
  assert.match(click, /if \(\$top -eq \[IntPtr\]::Zero\) \{ \$top = \$root \}/);
  assert.match(ps, /TzClickEl \$el \(TzRootOf "\$\(\$msg\.target\)"\)/);
  assert.match(ps, /\$script:rootCur = \$h/);
  // The wheel fallback too.
  const scroll = psFunction(ps, "TzScrollEl");
  assert.match(scroll, /TzLiveRect \$el/);
  assert.doesNotMatch(scroll, /TzRect /);
  // A press on an element that is gone says so.
  assert.match(psFunction(ps, "TzPress"), /if \(TzIsGone \$_\) \{ return @\{ ok = \$false; error = 'gone' \} \}/);
});

test("the foreground check uses the top-level window (UWP frames, MDI children)", () => {
  const ps = PS_TEXT();
  assert.match(ps, /GetAncestor\(IntPtr h, uint flags\)/);
  assert.match(ps, /return GetAncestor\(h, 2\);/, "GA_ROOT, not GA_ROOTOWNER");
  const top = psFunction(ps, "TzTopWindow");
  const returns = top.match(/return \[TzAgent\]::TopLevel\(\[IntPtr\]\$wh\)/g) || [];
  assert.strictEqual(returns.length, 2, "both handle returns go to the top level");
  assert.doesNotMatch(top, /return \[IntPtr\]\$wh/);
});

test("OPEN launches only an app by its name: paths, shares, URLs and schemes are refused", () => {
  const ps = PS_TEXT();
  const m = ps.match(/\$OPEN_REFUSE = '([^']+)'/);
  assert.ok(m, "$OPEN_REFUSE");
  const refuse = new RegExp(m[1]);
  const refused = (n) => refuse.test(n) || n.startsWith(".") || /\p{Cc}/u.test(n);
  for (const n of ["\\\\attacker.example\\share\\Slack.exe", "https://evil.example/x", "ms-msdt:/id", "C:\\Users\\me\\Downloads\\x.exe",
    "%TEMP%\\x.exe", "..\\x", ".\\x.exe", "./x", "a/b", "Sl*ck", "Sl?ck", "[Slack]", "a`b", "~", "file:x", "a\tb"]) {
    assert.ok(refused(n), `refused ${JSON.stringify(n)}`);
  }
  for (const n of ["Slack", "Google Chrome", "Microsoft Teams (work or school)", "Notepad++", "Visual Studio Code", "Excel", "AT&T Thing"]) {
    assert.ok(!refused(n), `allowed ${n}`);
  }
  const open = psFunction(ps, "TzOpen");
  // The refusal comes first, and the raw name is never handed to Start-Process.
  assert.ok(open.indexOf("TzOpenRefused $name") < open.indexOf("Start-Process"));
  assert.doesNotMatch(open, /Start-Process \$name/);
  assert.match(psFunction(ps, "TzOpenRefused"), /\$name -match \$OPEN_REFUSE\) -or \$name\.StartsWith\('\.'\)/);
  // Start Menu shortcuts first, then installed apps, App Paths and the PATH
  // (never the current directory), and a loose match last, never an uninstaller.
  const lnk = open.indexOf("$lnk.BaseName -ieq $name");
  const store = open.indexOf("Get-StartApps");
  const appPaths = open.indexOf("App Paths");
  const onPath = open.indexOf("Get-Command -Name $exe -CommandType Application");
  const loose = open.indexOf("$OPEN_NOT_APP");
  assert.ok(lnk > 0 && lnk < store && store < appPaths && appPaths < onPath && onPath < loose, "lookup order");
  const notApp = new RegExp(ps.match(/\$OPEN_NOT_APP = '\(\?i\)([^']+)'/)[1], "i");
  assert.ok(notApp.test("Uninstall Slack") && notApp.test("Slack Readme") && !notApp.test("Slack"));
});

test("look: the command starts a worker off the reader loop, which answers its own line", () => {
  const ps = PS_TEXT();
  // The command: answered here only when there is nothing to look at.
  assert.match(ps, /'look' \{[\s\S]*?\$r = TzLookBegin \$id \$msg\s*if \(\$null -ne \$r\) \{ TzReply \$r \}/);
  const begin = psFunction(ps, "TzLookBegin");
  assert.match(begin, /error = 'no_capture'/);
  assert.match(begin, /error = 'no_window'/);
  assert.match(begin, /\[TzShot\]::Frame\(\$h\)/);
  // The title as the snapshot gives it, capped with its end kept; the whole
  // of it goes to the worker only as the key it keeps out of the lines.
  assert.match(begin, /\$whole = TzClean \(\[TzAgent\]::WindowTitle\(\$h\)\) \$TITLE_READ/);
  assert.match(begin, /\$title = TzTitleCap \$whole/);
  assert.match(begin, /\$titleKey = \[TzShot\]::Key\(\$whole\)/);
  // The budget kept sane, and the worker run on the pool (inline only when
  // the pool would not open).
  assert.match(begin, /\$msg\.budgetMs/);
  assert.match(begin, /if \(\$budget -lt 100\) \{ \$budget = 100 \} elseif \(\$budget -gt 10000\) \{ \$budget = 10000 \}/);
  assert.match(begin, /TzLookRun \$argv/);
  const run = psFunction(ps, "TzLookRun");
  assert.match(run, /\$psh\.RunspacePool = \$script:lookPool/);
  assert.match(run, /BeginInvoke\(\)/);
  assert.doesNotMatch(run, /EndInvoke|\.Wait\(/, "never waits for the worker");
  // The pool: opened at start, MTA, and the engine warmed in it.
  const pool = psFunction(ps, "TzOpenLookPool");
  assert.match(pool, /CreateRunspacePool\(1, 2,/);
  assert.match(pool, /ApartmentState\]::MTA/);
  assert.match(pool, /\$pool\.Open\(\)/);
  assert.ok(ps.indexOf("\nTzLookWarm\n") > 0 && ps.indexOf("\nTzLookWarm\n") < ps.indexOf("while ($true)"), "warmed before the loop");
  assert.match(psFunction(ps, "TzLookReap"), /EndInvoke[\s\S]*Dispose\(\)/);
  // One whole line under the console writer's own lock, so the worker's
  // answer and the loop's never run into one line.
  assert.match(ps, /lock \(o\) \{ o\.WriteLine\(line\); o\.Flush\(\); \}/);
});

test("look: the worker's waits are bounded by the budget, and it always answers", () => {
  const ps = PS_TEXT();
  const at = ps.indexOf("$TZ_LOOK_WORKER = {");
  const worker = ps.slice(at, ps.indexOf("\nfunction ", at));
  assert.ok(at > 0, "the worker");
  // Awaited only as long as is left; never frontApp's fixed 8 s.
  assert.match(worker, /function TzAwaitFor\(\$op, \$t, \$ms\)[\s\S]*?if \(-not \$task\.Wait\(\[int\]\[math\]::Max\(1, \$ms\)\)\) \{ return \$null \}/);
  assert.doesNotMatch(worker, /Wait\(8000\)/);
  const waits = worker.match(/\.Wait\(/g) || [];
  assert.strictEqual(waits.length, 2, "the await helper's and the OCR's, both bounded");
  assert.match(worker, /\$task\.Wait\(\[int\]\[math\]::Max\(1, \$budget - \$reserve - \$sw\.ElapsedMilliseconds\)\)/);
  assert.match(worker, /if \(\$sw\.ElapsedMilliseconds -ge \$budget\) \{ \$ocr = 'partial'; break \}/);
  // OCR from an in-memory stream: nothing of the screen is written to disk.
  assert.match(worker, /\$shot::Bmp\(\$src\)/);
  assert.match(worker, /AsRandomAccessStream\(\$mem\)/);
  assert.match(worker, /CreateAsync\(\$ras\)/);
  assert.match(worker, /GetSoftwareBitmapAsync\(\)/);
  assert.match(worker, /RecognizeAsync\(\$sbm\)/);
  assert.doesNotMatch(ps, /GetTempFileName|GetFileFromPathAsync|\.Save\("|\$env:TEMP/, "no file anywhere");
  // The engine for the user's languages, else the first Windows has.
  assert.match(worker, /TryCreateFromUserProfileLanguages\(\)/);
  assert.match(worker, /AvailableRecognizerLanguages/);
  assert.match(worker, /MaxImageDimension/);
  // Lines: the union of the words' boxes, moved to the screen, at most 300.
  assert.match(worker, /\$LINES_MAX = 300/);
  assert.match(worker, /foreach \(\$wd in \$ln\.Words\)[\s\S]*?\$wd\.BoundingRect/);
  assert.match(worker, /\$shot::Line\(\$ln\.Text, \$x0, \$y0, \$x1, \$y1, \$up, \$frame\[0\], \$frame\[1\]\)/);
  // Every way out answers: a capture that fails, and anything else.
  assert.match(worker, /\$shot::Fail\(\$idJson, 'capture_failed'\)/);
  assert.match(worker, /finally \{\s*if \(-not \$sent\) \{ try \{ \$shot::Send\(\$shot::Fail\(\$idJson, 'exception'\)\) \} catch \{\} \}/);
});

test("look: the worker is handed exactly what it takes, in its order", () => {
  // The worker runs in a runspace of its own and gets its arguments by
  // position (AddArgument), so a name added to one list and not the other, or
  // in another place, shifts every later one into the wrong parameter with no
  // error at all.
  const ps = PS_TEXT();
  const at = ps.indexOf("$TZ_LOOK_WORKER = {");
  const params = /param\(([^)]*)\)/.exec(ps.slice(at))[1].split(",").map((s) => s.trim());
  const argv = /\$argv = @\(([^)]*)\)/.exec(psFunction(ps, "TzLookBegin"))[1].split(",").map((s) => s.trim());
  assert.strictEqual(argv.length, params.length, `${argv.length} arguments for ${params.length} parameters`);
  assert.deepStrictEqual(argv.slice(0, 2), ["$script:lookKit", "$false"], "the kit, and not the warm-up");
  assert.deepStrictEqual(params.slice(0, 2), ["$kit", "$warm"]);
  assert.deepStrictEqual(argv.slice(2), params.slice(2), "the rest by the same names, in the same order");
  // The warm-up passes the first two only.
  assert.match(psFunction(ps, "TzLookWarm"), /TzLookRun @\(\$script:lookKit, \$true\)/);
});

test("look: the window's title is kept out of the lines, against the whole of it", () => {
  // The device drops a line that is its (200-character) title; the helper
  // has the whole title and also catches a long one, and one read together
  // with what is beside it in the title bar.
  const ps = PS_TEXT();
  const at = ps.indexOf("$TZ_LOOK_WORKER = {");
  const worker = ps.slice(at, ps.indexOf("\nfunction ", at));
  const skip = worker.indexOf("if ($shot::IsTitle($ln.Text, $titleKey)) { continue }");
  assert.ok(skip > 0, "a title line is skipped");
  assert.ok(skip < worker.indexOf("$shot::Line($ln.Text"), "before it becomes a line");
  const cs = [...ps.matchAll(/Add-Type[^\n]*-TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/g)].map((m) => m[1]).find((c) => /class TzShot\b/.test(c));
  const key = cs.slice(cs.indexOf("public static string Key("), cs.indexOf("public static bool IsTitle("));
  assert.match(key, /if \(!char\.IsWhiteSpace\(c\)\) sb\.Append\(char\.ToLowerInvariant\(c\)\)/, "case and spaces do not count");
  assert.match(key, /\\u2026/, "nor a trailing ellipsis");
  const is = cs.slice(cs.indexOf("public static bool IsTitle("), cs.indexOf("static string N("));
  assert.match(is, /if \(k == titleKey\) return true;/, "the title");
  assert.match(is, /k\.Length >= 8 && titleKey\.IndexOf\(k, StringComparison\.Ordinal\) >= 0/, "a piece of it");
  assert.match(is, /titleKey\.Length >= 8 && k\.IndexOf\(titleKey, StringComparison\.Ordinal\) >= 0/, "a line with it inside");
});

test("look: the worker calls no cmdlet", () => {
  // A pool runspace starts with the core commands only; anything else
  // (New-Object, ConvertTo-Json) is module-loaded on its first look.
  const ps = PS_TEXT();
  const at = ps.indexOf("$TZ_LOOK_WORKER = {");
  const code = ps.slice(at, ps.indexOf("\nfunction ", at)).replace(/#.*$/gm, "");
  assert.deepStrictEqual(code.match(/\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/g) || [], []);
});

test("look: the C# captures the window as drawn, and encodes with a quality", () => {
  const ps = PS_TEXT();
  const cs = [...ps.matchAll(/Add-Type[^\n]*-TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/g)].map((m) => m[1]).find((c) => /class TzShot\b/.test(c));
  assert.ok(cs, "TzShot");
  // Its own Add-Type, so a System.Drawing that will not load costs only look.
  assert.match(ps, /try \{\s*Add-Type -ReferencedAssemblies System\.Drawing -ErrorAction Stop -TypeDefinition @'/);
  assert.match(ps, /\$script:lookReady = \$true\s*\} catch \{\}/);
  // The visible frame (DWM), clipped to the desktop; the screen's pixels.
  assert.match(cs, /DWMWA_EXTENDED_FRAME_BOUNDS = 9/);
  assert.match(cs, /GetWindowRect\(h, out r\)/, "the plain rect when DWM has none");
  assert.match(cs, /SM_CXVIRTUALSCREEN/);
  assert.match(cs, /IsIconic\(h\)/);
  assert.match(cs, /CopyFromScreen\(f\[0\], f\[1\], 0, 0, new Size\(f\[2\], f\[3\]\), CopyPixelOperation\.SourceCopy\)/);
  // JPEG with a Quality parameter; long side brought down to maxSide.
  assert.match(cs, /System\.Drawing\.Imaging\.Encoder\.Quality/);
  assert.match(cs, /ImageFormat\.Jpeg\.Guid/);
  assert.match(cs, /if \(maxSide <= 0 \|\| longest <= maxSide\) return src;/);
  assert.match(cs, /InterpolationMode\.HighQualityBicubic/);
  // Lines at most 120 characters; the answer built as one JSON line.
  assert.match(cs, /const int LINE_MAX = 120;/);
  assert.match(cs, /\\"scale\\":\\"pixels\\"/);
  assert.match(cs, /\\"mime\\":\\"image\/jpeg\\"/);
  // The ping says whether look is ready, for the logs.
  assert.match(ps, /look = \[bool\]\$script:lookReady; ocr = \(\$null -ne \$script:winrt\)/);
});

// The look's answer is put together by TzShot.Json rather than ConvertTo-Json,
// so its escaper is the one thing between OCR'd text and a line the driver
// cannot parse. C# cannot run here; its switch is read from the script and
// played back, and what it makes goes through a real JSON parser.
test("look: TzShot's JSON escaper, as written, round-trips through a real parser", () => {
  const cs = [...PS_TEXT().matchAll(/Add-Type[^\n]*-TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/g)].map((m) => m[1]).find((c) => /class TzShot\b/.test(c));
  const body = cs.slice(cs.indexOf("public static string Json("), cs.indexOf("static readonly Regex Space"));
  // case '<char>': sb.Append("<escape>"); break;  (C#'s \" \\ \n \r \t read as JSON's)
  const lit = (s) => (s === '"' ? '"' : JSON.parse(`"${s}"`));
  const cases = new Map();
  for (const m of body.matchAll(/case '((?:\\.|[^'\\]))': sb\.Append\("((?:\\.|[^"\\])*)"\); break;/g)) cases.set(lit(m[1]), lit(m[2]));
  assert.deepStrictEqual([...cases.keys()].sort(), ["\t", "\n", "\r", '"', "\\"].sort(), "the switch's cases");
  // Everything else below a space, and the two separators JavaScript once
  // took for line ends, as \uXXXX; the rest as itself.
  assert.match(body, /if \(c < ' ' \|\| c == '\\u2028' \|\| c == '\\u2029'\) sb\.Append\("\\\\u"\)\.Append\(\(\(int\)c\)\.ToString\("x4"/);
  const esc = (s) => '"' + [...s].map((c) => cases.get(c) ??
    (c < " " || c === "\u2028" || c === "\u2029" ? "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0") : c)).join("") + '"';
  for (const s of ['say "hi"', "C:\\Users\\me", "two\nlines\r\n", "tab\there", "\u0001\u001f\u007f", "x\u2028y\u2029z",
    "x² + √2 ≤ π", "∫ f(x) dx", "日本語のテキスト", "😀 emoji", "</script>", ""]) {
    const out = esc(s);
    assert.ok(!/[\n\r]/.test(out), `one line for ${JSON.stringify(s)}`);
    assert.strictEqual(JSON.parse(out), s);
  }
});

test("the helper ends cleanly as command text", () => {
  // Run with -EncodedCommand, the exit code is the last statement's $? unless
  // the script says; nativeCheck wants 0 for a clean end.
  assert.match(PS_TEXT(), /\nexit 0\s*$/);
});
