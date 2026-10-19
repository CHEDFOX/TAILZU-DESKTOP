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

const { createUiaDriver, scriptPath, defaultCommand } = require("./uiaDriver.js");
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

test("the launch command points at the helper script with the warm flags", () => {
  const c = defaultCommand();
  assert.strictEqual(c.cmd, "powershell.exe");
  assert.ok(c.args.includes("-NoProfile") && c.args.includes("-NonInteractive"));
  assert.ok(c.args.includes("-File") && c.args[c.args.length - 1] === scriptPath());
  assert.ok(scriptPath().endsWith(path.join("native", "uia-agent.ps1")) || scriptPath().endsWith("uia-agent.ps1"));
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
