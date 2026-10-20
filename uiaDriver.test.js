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
  for (const name of ["available", "start", "stop", "trusted", "snapshot", "press", "click", "setValue", "focus", "scroll", "key", "open"]) {
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
  const m = ps.match(/Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(m, "the C# block");
  const cs = m[1];
  assert.doesNotMatch(cs, /\$"/, "no interpolated strings");
  assert.doesNotMatch(cs, /=>/, "no expression-bodied members or lambdas");
  assert.doesNotMatch(cs, /\bout var\b/, "no out var");
  assert.doesNotMatch(cs, /\?\./, "no null-conditional");
  assert.doesNotMatch(cs, /\bnameof\(/, "no nameof");
  assert.doesNotMatch(cs, /\(\s*\w+\s*,\s*\w+\s*\)\s+\w+\s*\(/, "no tuple returns");
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

test("the helper ends cleanly as command text", () => {
  // Run with -EncodedCommand, the exit code is the last statement's $? unless
  // the script says; nativeCheck wants 0 for a clean end.
  assert.match(PS_TEXT(), /\nexit 0\s*$/);
});
