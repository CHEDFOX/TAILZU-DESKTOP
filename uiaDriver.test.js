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
    assert.deepStrictEqual(l.titleFrames, [[-1820, 50, 800, 31]], "where the title is drawn, frames only");
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

test("a look asked with a snapshot, as Alt twice asks (snapshot first), is not held behind the walk", async () => {
  // The fake reads its lines one at a time, as uia-agent.ps1 does, and a
  // snapshot holds the reader 500 ms; a look is answered 300 ms after its line
  // is read. Read behind the walk, a look with 700 ms would time out.
  const d = fakeDriver("walk");
  try {
    assert.strictEqual((await d.trusted()).ok, true, "warm");
    const t0 = Date.now();
    // agent.begin: takeSnapshot() then takeLook(), each one turn of the
    // microtask queue in.
    const snap = Promise.resolve().then(() => d.snapshot({ max: 3 }));
    const look = Promise.resolve().then(() => d.look({ timeoutMs: 700 }));
    const [s, l] = await Promise.all([snap, look]);
    assert.strictEqual(s.ok, true, JSON.stringify(s));
    assert.strictEqual(l.ok, true, `the look was read first and answered beside the walk: ${JSON.stringify(l).slice(0, 120)}`);
    assert.ok(l.readAt - t0 < 200, `the look's line was read at once (${l.readAt - t0} ms)`);
  } finally { d.stop(); }
});

test("a look's line carries the moment the driver stops waiting for it", async () => {
  const d = fakeDriver("normal");
  try {
    await d.trusted();
    let before = Date.now();
    let l = await d.look({ timeoutMs: 2000 });
    assert.ok(l.echoDeadline >= before + 2000 && l.echoDeadline <= l.readAt + 2000, `explicit: ${l.echoDeadline - before}`);
    before = Date.now();
    l = await d.look();
    assert.ok(l.echoDeadline >= before + 2500 && l.echoDeadline <= l.readAt + 2500, "the default timeout");
    // The other commands are as they were.
    assert.strictEqual((await d.snapshot({ max: 2 })).echoBudget, 900);
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
    assert.deepStrictEqual(l.titleFrames, Array.from({ length: 8 }, (_, i) => [0, i, 800, 31]), "frames only, with a size, at most 8");
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
  for (const name of ["available", "start", "stop", "trusted", "snapshot", "press", "click", "setValue", "focus", "scroll", "key", "open", "look", "caret"]) {
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
  // Every block: TzAgent's, the look's own (TzShot), and the caret's (TzCaret).
  const blocks = [...ps.matchAll(/Add-Type[^\n]*-TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/g)].map((m) => m[1]);
  assert.strictEqual(blocks.length, 3, "three C# blocks");
  for (const cls of ["TzAgent", "TzShot", "TzCaret"]) assert.ok(blocks.some((cs) => new RegExp(`class ${cls}\\b`).test(cs)), cls);
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
  assert.match(begin, /\$hwnd = \[TzAgent\]::GetForegroundWindow\(\)/);
  assert.match(begin, /\[TzShot\]::Frame\(\$hwnd\)/);
  // The title as the snapshot gives it, capped with its end kept; the whole
  // of it goes to the worker only as the key it keeps out of the lines.
  assert.match(begin, /\$whole = TzClean \(\[TzAgent\]::WindowTitle\(\$hwnd\)\) \$TITLE_READ/);
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
  // In a scope of its own, so nothing a look made (the window's pixels, its
  // JPEG) stays behind in the pool's long-lived runspace.
  assert.match(run, /\[void\]\$psh\.AddScript\(\$TZ_LOOK_WORKER, \$true\)/);
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

test("look: a look that waited behind another line is cut to the time the driver has left", () => {
  const ps = PS_TEXT();
  const begin = psFunction(ps, "TzLookBegin");
  // The deadline, read as the driver sends it (epoch ms), against the same clock.
  assert.match(begin, /\$msg\.deadline/);
  assert.match(begin, /\$left = \[long\]\$dl - \[DateTimeOffset\]::UtcNow\.ToUnixTimeMilliseconds\(\) - \$LOOK_MARGIN_MS/);
  assert.match(begin, /if \(\$left -lt 100\) \{ return @\{ id = \$id; ok = \$false; error = 'timeout' \} \}/, "given up on: not made");
  assert.match(begin, /if \(\$budget -gt \$left\) \{ \$budget = \[int\]\$left \}/);
  assert.ok(begin.indexOf("$msg.deadline") > begin.indexOf("$budget = 10000"), "cut after the budget is made sane");
  // The helper's margin is the driver's.
  const margin = Number(/\$LOOK_MARGIN_MS = (\d+)/.exec(ps)[1]);
  assert.strictEqual(margin, Number(/const LOOK_MARGIN_MS = (\d+);/.exec(fs.readFileSync(path.join(__dirname, "uiaDriver.js"), "utf8"))[1]));
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
  // The capture too: the window's own handle, waited for what is left.
  assert.match(worker, /\$shot::Capture\(\$hwnd, \$frame, \[int\]\[math\]::Max\(1, \$budget - \$sw\.ElapsedMilliseconds\)\)/);
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
  const skip = worker.indexOf("if ($shot::IsTitle($ln.Text, $titleKey)) {");
  assert.ok(skip > 0, "a title line is skipped");
  assert.ok(skip < worker.indexOf("$shot::Line($ln.Text"), "before it becomes a line");
  // Only where it was goes back (frames, no text), with the title bar's band:
  // the device cuts the picture below them (agent.js chromeBottom).
  const skipped = worker.slice(skip, worker.indexOf("$shot::Line($ln.Text"));
  assert.match(skipped, /\$titleFrames\.Add\(\$b\)/);
  assert.match(skipped, /\$shot::Box\(\$x0, \$y0, \$x1, \$y1, \$up, \$frame\[0\], \$frame\[1\]\)/, "moved as the lines are");
  assert.match(skipped, /continue/);
  assert.doesNotMatch(skipped, /\$ln\.Text[^,]/, "the title's text goes nowhere");
  assert.match(worker, /if \(\$titleBand\) \{ \$titleFrames\.Add\(\$titleBand\) \}/);
  assert.match(worker, /\$shot::Reply\(\$idJson, \$frame, \$title, \$lines\.ToArray\(\), \$titleFrames\.ToArray\(\), /);
  assert.match(psFunction(ps, "TzLookBegin"), /\$titleBand = \[TzShot\]::TitleBand\(\$hwnd, \$frame\)/);
  const cs = [...ps.matchAll(/Add-Type[^\n]*-TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/g)].map((m) => m[1]).find((c) => /class TzShot\b/.test(c));
  const key = cs.slice(cs.indexOf("public static string Key("), cs.indexOf("public static bool IsTitle("));
  assert.match(key, /if \(char\.IsWhiteSpace\(ch\)\) continue;/, "spaces do not count");
  assert.match(key, /sb\.Append\(char\.ToLowerInvariant\(c\)\)/, "nor case");
  assert.match(key, /\\u2026/, "nor a trailing ellipsis");
  // Nor which dash or quote it was read with: the same rule as agent.js textKey.
  assert.match(key, /\(c >= '\\u2010' && c <= '\\u2015'\) \|\| c == '\\u2212'\) c = '-'/);
  assert.match(key, /c == '\\u2018' \|\| c == '\\u2019' \|\| c == '\\u201a' \|\| c == '\\u201b' \|\| c == '\\u2032'\) c = '\\''/);
  assert.match(key, /\(c >= '\\u201c' && c <= '\\u201f'\) \|\| c == '\\u2033'\) c = '"'/);
  // The reply: at most 8 frames.
  const reply = cs.slice(cs.indexOf("public static string Reply("), cs.indexOf("public static string Fail("));
  assert.match(reply, /string\[\] titleFrames/);
  assert.match(reply, /boxes >= 8/);
  // The title bar: from the frame's top to the client area's, a quarter of the window at most.
  const band = cs.slice(cs.indexOf("public static string TitleBand("), cs.indexOf("public static string Box("));
  assert.match(band, /ClientToScreen\(h, ref p\)/);
  assert.match(band, /int band = p\.Y - f\[1\];/);
  assert.match(band, /if \(band < 1 \|\| band > f\[3\] \/ 4\) return null;/);
  const is = cs.slice(cs.indexOf("public static bool IsTitle("), cs.indexOf("static string N("));
  assert.match(is, /if \(k == titleKey\) return true;/, "the title");
  assert.match(is, /k\.Length >= 8 && titleKey\.IndexOf\(k, StringComparison\.Ordinal\) >= 0/, "a piece of it");
  assert.match(is, /titleKey\.Length >= 8 && k\.IndexOf\(titleKey, StringComparison\.Ordinal\) >= 0/, "a line with it inside");
});

test("snapshot: a Store app in its frame is named by the app inside, as frontApp.js names it", () => {
  const ps = PS_TEXT();
  const snap = psFunction(ps, "TzSnapshot");
  // One naming, the snapshot's and the caret's (TzCaretApp).
  assert.match(snap, /\$appName = TzAppName \$h \$procId/);
  assert.match(psFunction(ps, "TzCaretApp"), /name = \(TzAppName \$h \$procId\); pid = \[int\]\$procId/);
  const naming = psFunction(ps, "TzAppName");
  assert.match(naming, /function TzAppName\(\[IntPtr\]\$h, \[uint32\]\$procId\)/);
  assert.match(naming, /if \(\$p -and \$p\.ProcessName -eq 'ApplicationFrameHost'\)/);
  assert.match(naming, /\[TzAgent\]::FindWindowEx\(\$h, \[IntPtr\]::Zero, 'Windows\.UI\.Core\.CoreWindow', \[IntPtr\]::Zero\)/);
  assert.match(naming, /GetWindowThreadProcessId\(\$core, \[ref\]\$coreId\)/);
  assert.match(naming, /if \(\$coreId -ne 0 -and \$coreId -ne \$procId\)/);
  assert.ok(naming.indexOf("ApplicationFrameHost") < naming.indexOf("$appName = $p.ProcessName"), "before the name is read");
  assert.match(naming, /return \$appName/);
  // The pid stays the window's own.
  assert.match(snap, /\$o\.app = @\{ name = \$appName; pid = \[int\]\$procId \}/);
  assert.match(ps, /public static extern IntPtr FindWindowEx\(IntPtr parent, IntPtr after, string cls, IntPtr title\);/);
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
  // The visible frame (DWM), clipped to the desktop.
  assert.match(cs, /DWMWA_EXTENDED_FRAME_BOUNDS = 9/);
  assert.match(cs, /GetWindowRect\(h, out r\)/, "the plain rect when DWM has none");
  assert.match(cs, /SM_CXVIRTUALSCREEN/);
  assert.match(cs, /IsIconic\(h\)/);
  // The window's own pixels, never the screen's: what is over it (a toast,
  // another app's topmost window, Tailzu's card and pill) is not read or sent.
  assert.doesNotMatch(cs, /CopyFromScreen|BitBlt|GetDC\(|GetWindowDC/, "nothing copied off the screen");
  assert.match(cs, /static extern bool PrintWindow\(IntPtr h, IntPtr hdc, uint flags\)/);
  assert.match(cs, /const uint PW_RENDERFULLCONTENT = 2;/);
  assert.match(cs, /ok = PrintWindow\(h, hdc, PW_RENDERFULLCONTENT\)/);
  const capture = cs.slice(cs.indexOf("public static Bitmap Capture("), cs.indexOf("sealed class Printing"));
  assert.match(capture, /public static Bitmap Capture\(IntPtr h, int\[\] f, int ms\)/);
  // The frame cut out of the whole window rect, which must still hold it.
  assert.match(capture, /int cx = f\[0\] - wr\.Left, cy = f\[1\] - wr\.Top;/);
  assert.match(capture, /cx \+ f\[2\] > ww \|\| cy \+ f\[3\] > wh\) return null;/);
  assert.match(capture, /whole\.Clone\(new Rectangle\(cx, cy, f\[2\], f\[3\]\)/);
  // A window PrintWindow could not draw comes back black: no picture.
  assert.match(capture, /if \(Blank\(bmp\)\) \{ bmp\.Dispose\(\); return null; \}/);
  assert.match(cs, /if \(\(row\[x\] & 0xFFFFFF\) != 0\) return false;/);
  // Bounded: on a thread of its own, waited for no longer than it was given.
  const printing = cs.slice(cs.indexOf("sealed class Printing"), cs.indexOf("static bool Blank("));
  assert.match(printing, /t\.IsBackground = true;/);
  assert.match(printing, /t\.Join\(Math\.Max\(1, ms\)\);/);
  assert.match(printing, /if \(ok && !late\) \{ done = bmp; bmp = null; \}/, "a late picture is the thread's to throw away");
  // A window Windows scales for the screen is drawn at its own size: measured
  // in its own units, then brought to the frame's (webrtc bug 8112).
  assert.match(printing, /SetThreadDpiAwarenessContext\(GetWindowDpiAwarenessContext\(h\)\)/);
  assert.ok(printing.indexOf("SetThreadDpiAwarenessContext") < printing.indexOf("GetWindowRect(h, out r)"), "measured after taking on its awareness");
  assert.match(printing, /new Bitmap\(r\.Right - r\.Left, r\.Bottom - r\.Top, PixelFormat\.Format32bppRgb\)/, "no alpha to go black");
  assert.match(capture, /if \(whole\.Width != ww \|\| whole\.Height != wh\) \{\s*Bitmap big = Resized\(whole, ww, wh\);/);
  assert.ok(capture.indexOf("Resized(whole") < capture.indexOf("whole.Clone("), "scaled before the frame is cut");
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

// ---- caret (peek-spec §A) ------------------------------------------------------
// Where the text cursor and its box are, for Blip to peek over the box while
// the user dictates: asked every few hundred milliseconds, only of a helper
// Ask already has running, and answered with two rectangles and the app.

/** A fake-wired driver that keeps every line it writes and counts its spawns. */
function spiedDriver(mode, extra = {}) {
  const lines = [];
  let spawns = 0;
  const d = fakeDriver(mode, null, {
    spawn: (cmd, args, o) => {
      spawns++;
      const c = spawn(cmd, args, o);
      const write = c.stdin.write.bind(c.stdin);
      c.stdin.write = (line, ...rest) => { lines.push(JSON.parse(line)); return write(line, ...rest); };
      return c;
    },
    ...extra,
  });
  return { d, lines, spawns: () => spawns };
}

const CARET = { ok: true, caret: [1352, 148, 2, 27], field: [1120, 100, 600, 42], app: { name: "Fake", pid: 42 }, scale: "pixels" };

test("caret is asked only of a helper that is already running, and never starts one", async () => {
  const { d, lines, spawns } = spiedDriver("normal");
  try {
    assert.deepStrictEqual(await d.caret(), { ok: false, error: "unavailable" });
    assert.deepStrictEqual(await d.caret({ budgetMs: 400 }), { ok: false, error: "unavailable" });
    assert.strictEqual(spawns(), 0, "a dictation never starts the helper");
    assert.strictEqual(lines.length, 0);
    d.start();
    assert.deepStrictEqual(await d.caret(), CARET);
    assert.strictEqual(spawns(), 1);
    d.stop();
    assert.deepStrictEqual(await d.caret(), { ok: false, error: "unavailable" }, "nor after stop()");
    assert.strictEqual(spawns(), 1);
  } finally { d.stop(); }
  // The real default instance off Windows: nothing running, nothing started.
  assert.deepStrictEqual(await defaultExport.caret(), { ok: false, error: "unavailable" });
});

test("a caret comes back in the spec's shape and nothing else, asked with its budget and deadline", async () => {
  const { d, lines } = spiedDriver("normal");
  try {
    d.start();
    await d.trusted();
    const before = Date.now();
    const r = await d.caret();
    assert.deepStrictEqual(r, CARET);
    assert.deepStrictEqual(Object.keys(r).sort(), ["app", "caret", "field", "ok", "scale"], "no how, no ms, no id");
    const sent = lines.filter((l) => l.cmd === "caret");
    assert.strictEqual(sent.length, 1);
    assert.deepStrictEqual(Object.keys(sent[0]).sort(), ["budgetMs", "cmd", "deadline", "id"]);
    assert.ok(sent[0].budgetMs > 200 && sent[0].budgetMs <= 250, `budget ${sent[0].budgetMs}`);
    assert.ok(sent[0].deadline >= before + 200 && sent[0].deadline <= Date.now() + 250, "when the driver stops waiting");
    // The budget can be set (main.js passes desktop.dictation.peekBudgetMs), and is kept sane.
    for (const [o, lo, hi] of [[{ budgetMs: 600 }, 550, 600], [{ timeoutMs: 400 }, 350, 400], [{ budgetMs: 5 }, 50, 100],
      [{ budgetMs: 99999 }, 1950, 2000], [{ budgetMs: "soon" }, 200, 250], [null, 200, 250]]) {
      lines.length = 0;
      assert.deepStrictEqual(await d.caret(o), CARET);
      assert.ok(lines[0].budgetMs > lo && lines[0].budgetMs <= hi, `${JSON.stringify(o)}: ${lines[0].budgetMs}`);
    }
  } finally { d.stop(); }
});

test("a password field gives no caret and no field; junk is cleaned and no text gets through", async () => {
  const sec = fakeDriver("securecaret");
  try {
    sec.start();
    assert.deepStrictEqual(await sec.caret(), { ...CARET, caret: null, field: null });
  } finally { sec.stop(); }
  const bad = fakeDriver("badcaret");
  try {
    bad.start();
    const r = await bad.caret();
    assert.deepStrictEqual(r, { ok: true, caret: null, field: null, app: { name: "", pid: 0 }, scale: "pixels" });
    const out = JSON.stringify(r);
    for (const word of ["Priya", "hunter2", "offer", "InPrivate", "Bank", "Dear"]) assert.ok(!out.includes(word), word);
  } finally { bad.stop(); }
});

test("a caret the helper never answers resolves timeout within its budget, and the helper carries on", async () => {
  const d = fakeDriver("hangcaret");
  try {
    d.start();
    await d.trusted();
    const t0 = Date.now();
    assert.deepStrictEqual(await d.caret(), { ok: false, error: "timeout" });
    const took = Date.now() - t0;
    assert.ok(took >= 230 && took < 600, `took ${took} ms`);
    assert.strictEqual((await d.snapshot({ max: 2 })).ok, true);
  } finally { d.stop(); }
});

test("a caret keeps to its budget while the helper is still warming up, and is not sent late", async () => {
  const { d, lines } = spiedDriver("slowwarm");
  try {
    d.start();
    const t0 = Date.now();
    assert.deepStrictEqual(await d.caret(), { ok: false, error: "timeout" });
    const took = Date.now() - t0;
    assert.ok(took >= 230 && took < 500, `took ${took} ms, not the warm-up's 700`);
    assert.deepStrictEqual(lines.map((l) => l.cmd), ["ping"], "no caret line for a helper not ready");
    await new Promise((r) => setTimeout(r, 600));
    assert.deepStrictEqual(await d.caret(), CARET, "warm now");
  } finally { d.stop(); }
});

test("caret: the command begins a read on TzCaret's threads, which answer its line", () => {
  const ps = PS_TEXT();
  assert.match(ps, /'caret' \{[\s\S]*?\$r = TzCaretBegin \$id \$msg\s*if \(\$null -ne \$r\) \{ TzReply \$r \}/);
  const begin = psFunction(ps, "TzCaretBegin");
  assert.match(begin, /if \(-not \$script:caretReady\) \{ return @\{ id = \$id; ok = \$false; error = 'no_caret' \} \}/);
  assert.match(begin, /\$h = \[TzAgent\]::GetForegroundWindow\(\)/);
  assert.match(begin, /error = 'no_window'/);
  assert.match(begin, /\$appJson = TzCaretApp \$h \$procId/);
  // The budget kept sane, then cut to what the driver has left, after the name.
  assert.match(begin, /if \(\$budget -lt 50\) \{ \$budget = 50 \} elseif \(\$budget -gt 5000\) \{ \$budget = 5000 \}/);
  assert.match(begin, /\$left = \[long\]\$dl - \[DateTimeOffset\]::UtcNow\.ToUnixTimeMilliseconds\(\) - \$CARET_MARGIN_MS/);
  assert.match(begin, /if \(\$left -lt 20\) \{ return @\{ id = \$id; ok = \$false; error = 'timeout' \} \}/, "given up on: not read");
  assert.ok(begin.indexOf("TzCaretApp $h $procId") < begin.indexOf("$msg.deadline"), "cut after the name was had");
  assert.match(begin, /\$err = \[TzCaret\]::Begin\(\$idJson, \$appJson, \$budget\)/);
  assert.match(begin, /if \(\$null -ne \$err\) \{ return @\{ id = \$id; ok = \$false; error = "\$err" \} \}/);
  assert.match(ps, /\$CARET_MS = 250/);
  // The app's name is cached, by window and process, and kept small.
  const app = psFunction(ps, "TzCaretApp");
  assert.match(app, /\$key = "\$h\/\$procId"/);
  assert.match(app, /if \(\$script:caretApps\.Count -ge 64\) \{ \$script:caretApps\.Clear\(\) \}/);
  // The ping says whether the caret's C# loaded, for nativeCheck.
  assert.match(ps, /pool = \(\$null -ne \$script:lookPool\); caret = \[bool\]\$script:caretReady/);
  assert.match(ps, /\$script:caretReady = \$true\s*\} catch \{\}/);
  assert.match(ps, /try \{\s*Add-Type -ErrorAction Stop -TypeDefinition @'\r?\nusing System;[\s\S]*?public static class TzCaret \{/);
});

/** The caret's C#, with its comments taken out. */
function caretCs() {
  const cs = [...PS_TEXT().matchAll(/Add-Type[^\n]*-TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/g)].map((m) => m[1]).find((c) => /class TzCaret\b/.test(c));
  assert.ok(cs, "TzCaret");
  return cs.replace(/\/\/.*$/gm, "");
}

/** One COM interface of TzCaret's: its GUID and its methods, in vtable order. */
function comInterface(cs, name) {
  const m = new RegExp(`\\[ComImport, Guid\\("([0-9a-f-]+)"\\), InterfaceType\\(ComInterfaceType\\.InterfaceIsIUnknown\\)\\]\\s*internal interface ${name} \\{([\\s\\S]*?)\\n  \\}`).exec(cs);
  assert.ok(m, `interface ${name}`);
  const slots = [...m[2].matchAll(/(\w+)\s*(?:\(|\{ get;)/g)].map((x) => x[1]).filter((n) => !["MarshalAs", "return"].includes(n));
  return { guid: m[1], slots };
}

// The COM interfaces are declared by hand, only as far as the slots used, so
// a slot missed or added before one would call the wrong method with no error
// at all. These are UIAutomationClient.idl's IIDs and orders.
test("caret: each COM method sits on its slot of UIAutomationClient's vtables", () => {
  const cs = caretCs();
  const want = {
    IAutomation: ["30cbe57d-d9d0-452a-ab13-7ac5ac4825ee", { GetFocusedElement: 6 }],
    IElement: ["d22108aa-8ac5-49a5-837b-37bbb3d7591e", { GetCurrentPropertyValue: 8, GetCurrentPattern: 14 }],
    ITextPattern: ["32eba289-3583-42c9-9c59-3b6d9a1e9b6a", { GetSelection: 3 }],
    ITextPattern2: ["506a921a-fcc9-409f-b23b-37eb74106872", { GetCaretRange: 8 }],
    IRangeArray: ["ce4ae76a-e717-4c98-81ea-47371d028eb6", { Length: 1, GetElement: 2 }],
    IRange: ["a543cc6a-f4ae-494b-8239-c814481187a8", { Clone: 1, CompareEndpoints: 3, ExpandToEnclosingUnit: 4, GetBoundingRectangles: 8, MoveEndpointByRange: 13 }],
  };
  for (const [name, [guid, used]] of Object.entries(want)) {
    const { guid: g, slots } = comInterface(cs, name);
    assert.strictEqual(g, guid, `${name}'s IID`);
    for (const [method, slot] of Object.entries(used)) assert.strictEqual(slots.indexOf(method) + 1, slot, `${name}.${method} on slot ${slot}: ${slots.join(",")}`);
    assert.strictEqual(slots.length, Math.max(...Object.values(used)), `${name} declares nothing past its last slot used`);
    assert.ok(slots.every((n) => Object.keys(used).includes(n) || /^Gap\d+$/.test(n)), `${name}: ${slots.join(",")}`);
  }
  assert.match(cs, /IRange GetCaretRange\(out int isActive\);/);
  assert.match(cs, /\[return: MarshalAs\(UnmanagedType\.SafeArray, SafeArraySubType = VarEnum\.VT_R8\)\] double\[\] GetBoundingRectangles\(\);/);
  assert.match(cs, /new Guid\("ff48dba4-60ef-4201-aa87-54103eef594e"\)/, "CUIAutomation");
  for (const [k, v] of [["TextPatternId", 10014], ["TextPattern2Id", 10024], ["BoundingRectangleId", 30001], ["IsPasswordId", 30019],
    ["EndpointStart", 0], ["EndpointEnd", 1], ["UnitCharacter", 0]]) assert.match(cs, new RegExp(`const int ${k} = ${v};`));
});

test("caret: TextPattern2's caret range, the character's edge, then the system caret; a password gives nulls", () => {
  const cs = caretCs();
  const from = cs.slice(cs.indexOf("static int[] FromText("), cs.indexOf("static bool IsPasswordEdit("));
  const two = from.indexOf("el.GetCurrentPattern(TextPattern2Id)");
  const one = from.indexOf("el.GetCurrentPattern(TextPatternId)");
  assert.ok(two > 0 && two < one, "TextPattern2 first, TextPattern where there is none");
  assert.match(from, /range = held\.Keep\(tp2\.GetCaretRange\(out active\)\);/);
  // A selection is where it starts: the range collapsed there.
  assert.match(from, /range\.MoveEndpointByRange\(EndpointEnd, start, EndpointStart\);/);
  // No rectangle: a copy widened to the character, its left edge, or its right one when it is the one before.
  assert.match(from, /IRange ch = held\.Keep\(range\.Clone\(\)\);\s*ch\.ExpandToEnclosingUnit\(UnitCharacter\);/);
  assert.match(from, /before = ch\.CompareEndpoints\(EndpointStart, range, EndpointStart\) < 0;/);
  assert.match(from, /new int\[\] \{ before \? c\[0\] \+ c\[2\] : c\[0\], c\[1\], 2, c\[3\] \}/);
  const work = cs.slice(cs.indexOf("void Work() {"), cs.indexOf("static object Property("));
  const pw = work.indexOf("Property(el, IsPasswordId)");
  assert.ok(pw > 0 && pw < work.indexOf("FromText(el"), "the password check comes first");
  assert.match(work, /if \(pw is bool && \(bool\)pw\) \{\s*secure = true;/);
  assert.match(work, /Reply\(idJson, null, null, appJson, "secure", ms\)/);
  // The field is the element's BoundingRectangle.
  assert.match(work, /field = Box\(Property\(el, BoundingRectangleId\), false\);/);
  // The system caret: GetGUIThreadInfo on the foreground thread, rcCaret to the screen.
  assert.ok(work.indexOf("GetGUIThreadInfo(0, ref g)") > work.indexOf("FromText(el"), "only when the text patterns had none");
  assert.match(work, /if \(!secure && caret == null\)/);
  assert.match(work, /ToScreen\(g\.hwndCaret, ref a\) && ToScreen\(g\.hwndCaret, ref b\)/);
  assert.match(work, /if \(!uia && IsPasswordEdit\(g\.hwndCaret\)\)/);
  // Only a text box has a box: an element with neither text pattern and no
  // caret found (a window, a list, a button) gives no field, so Blip never
  // sits at the corner of something nobody types in.
  assert.match(work, /caret = FromText\(el, field, held, ref how, ref text\);/);
  const noBox = work.indexOf("if (!secure && caret == null && !text) field = null;");
  assert.ok(noBox > work.indexOf("GetGUIThreadInfo(0, ref g)") && noBox < work.indexOf("long ms = "), "after the system caret had its turn");
  assert.match(from, /ITextPattern2 tp2 = p as ITextPattern2;\s*if \(tp2 != null\) \{\s*text = true;/);
  assert.match(from, /ITextPattern tp = p as ITextPattern;\s*if \(tp != null\) \{\s*text = true;/);
  const screen = cs.slice(cs.indexOf("static bool ToScreen("), cs.indexOf("static string N("));
  assert.match(screen, /SetThreadDpiAwarenessContext\(GetWindowDpiAwarenessContext\(h\)\)/);
  assert.ok(screen.indexOf("ClientToScreen(h, ref p)") < screen.indexOf("LogicalToPhysicalPointForPerMonitorDPI(h, ref p)"));
  assert.match(cs, /public RECT rcCaret;/);
  assert.match(cs, /\[DllImport\("user32\.dll"\)\] static extern bool GetGUIThreadInfo\(uint idThread, ref GUITHREADINFO info\);/);
});

test("caret: the C# reads no text, and its answer has only rectangles, the app and its own words", () => {
  const cs = caretCs();
  // Not the range's words, not a value, not a name: the only properties read
  // are the bounding rectangle and IsPassword.
  assert.doesNotMatch(cs, /GetText|GetAttributeValue\(|FindText\(|ValuePattern|GetWindowText|SelectedText/);
  const ids = [...cs.matchAll(/GetCurrentPropertyValue\(|Property\(el, (\w+)\)/g)].map((m) => m[1]).filter(Boolean);
  assert.deepStrictEqual([...new Set(ids)].sort(), ["BoundingRectangleId", "IsPasswordId"]);
  const reply = cs.slice(cs.indexOf("static string Reply("), cs.indexOf("static string Fail("));
  assert.deepStrictEqual([...reply.matchAll(/\\"(\w+)\\":/g)].map((m) => m[1]), ["id", "ok", "caret", "field", "app", "scale", "how", "ms"]);
  // how is one of its own words.
  const hows = [...cs.matchAll(/how = "(\w+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual([...new Set(hows)].sort(), ["caret", "none", "selection", "system"]);
  assert.match(cs, /how = how \+ \(before \? "\+before" : "\+char"\);/);
});

test("caret: one read at a time, its work on a thread of its own and a watchdog answering for it in time", () => {
  const cs = caretCs();
  const begin = cs.slice(cs.indexOf("public static string Begin("), cs.indexOf("sealed class Read"));
  assert.match(begin, /if \(Interlocked\.CompareExchange\(ref busy, 1, 0\) != 0\) return "busy";/);
  const read = cs.slice(cs.indexOf("sealed class Read"), cs.indexOf("static object Property("));
  assert.match(read, /watchdog = new Timer\(new TimerCallback\(Late\), null, ms, Timeout\.Infinite\);/);
  assert.match(read, /void Late\(object state\) \{ Answer\(Fail\(idJson, "timeout"\)\); \}/);
  assert.match(read, /t\.IsBackground = true;/);
  // Whichever comes first answers, and only once.
  assert.match(read, /lock \(gate\) \{\s*if \(answered\) return;\s*answered = true;\s*\}/);
  // The slot is given back when the work is done, however it ended, and the
  // COM objects it made are released, each once (never the shared client).
  assert.match(read, /finally \{\s*held\.Release\(\);\s*Interlocked\.Exchange\(ref busy, 0\);\s*\}/);
  const held = cs.slice(cs.indexOf("sealed class Held"), cs.indexOf("static object Property("));
  assert.match(held, /if \(o != null && !all\.Contains\(o\)\) all\.Add\(o\);/);
  assert.match(held, /if \(Marshal\.IsComObject\(o\)\) Marshal\.ReleaseComObject\(o\);/);
  assert.doesNotMatch(cs, /held\.Keep\(Automation\(\)\)|held\.Keep\(automation\)/);
  // Every object a read gets from UI Automation is kept to be released.
  const made = cs.slice(cs.indexOf("void Work() {"), cs.indexOf("static bool IsPasswordEdit("));
  for (const call of ["GetFocusedElement()", "GetCurrentPattern(TextPattern2Id)", "GetCaretRange(out active)", "GetCurrentPattern(TextPatternId)",
    "GetSelection()", "GetElement(0)", "range.Clone()"]) {
    const at = made.indexOf(call);
    assert.ok(at > 0, call);
    assert.ok(/held\.Keep\([^;]*$/.test(made.slice(Math.max(0, at - 60), at)), `${call} is kept`);
  }
  assert.doesNotMatch(read, /\.Join\(|\.Wait\(|Sleep\(/, "nothing here waits");
  // One whole line under the console writer's lock, as TzShot's.
  assert.match(cs, /lock \(o\) \{ o\.WriteLine\(line\); o\.Flush\(\); \}/);
  // Nothing beyond mscorlib, so it compiles wherever TzAgent does.
  assert.doesNotMatch(cs, /Stopwatch|System\.Diagnostics|Regex/);
});

test("nativeCheck asks the real Windows helper for the caret, and its ping must say the C# loaded", () => {
  const nc = fs.readFileSync(path.join(__dirname, "nativeCheck.js"), "utf8");
  const win = nc.slice(nc.indexOf('} else if (which === "winagent")'));
  assert.match(win, /'\{"id":4,"cmd":"caret","budgetMs":3000\}'/);
  assert.match(win, /if \(ping\.caret !== true\)/);
  assert.match(win, /caret\.scale !== "pixels"/);
  assert.match(win, /byId\.has\(1\) && byId\.has\(2\) && byId\.has\(3\) && byId\.has\(4\)/);
});

test("the helper ends cleanly as command text", () => {
  // Run with -EncodedCommand, the exit code is the last statement's $? unless
  // the script says; nativeCheck wants 0 for a clean end.
  assert.match(PS_TEXT(), /\nexit 0\s*$/);
});
