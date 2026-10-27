// node --test
//
// Standing down on a low battery (power.js), with THE SOURCE OF TRUTH STUBBED: paused under 20% on battery or in a low-power mode, back at 25%,
// never on mains power, never when the system cannot say; no polling at all on mains power; and the readers of the platforms' own answers
// (pmset, sysfs, PowerShell) run against what they print.

const test = require("node:test");
const assert = require("node:assert");
const { createPowerGate, createSystemSource, parsePmsetBatt, parsePmsetSettings, parseSysfs, parseWinBattery } = require("./power.js");
const { fakeTimers, tick } = require("./testkit.js");

function rig(initial) {
  let reading = initial;
  const changes = [];
  const timers = fakeTimers();
  const gate = createPowerGate({ read: async () => (reading instanceof Error ? Promise.reject(reading) : reading), onChange: (s) => changes.push([s.paused, s.reason]), timers });
  return { gate, timers, changes, set: (r) => { reading = r; } };
}

test("on battery below 20% it pauses; at 20% and above it does not", async () => {
  const r = rig({ onBattery: true, percent: 19, lowPower: false });
  await r.gate.start();
  assert.strictEqual(r.gate.paused, true);
  assert.strictEqual(r.gate.reason, "battery_low");
  r.set({ onBattery: true, percent: 20, lowPower: false });
  const fresh = rig({ onBattery: true, percent: 20, lowPower: false });
  await fresh.gate.start();
  assert.strictEqual(fresh.gate.paused, false);
  fresh.gate.stop();
  r.gate.stop();
});

test("a low-power mode pauses at any charge", async () => {
  const r = rig({ onBattery: true, percent: 90, lowPower: true });
  await r.gate.start();
  assert.deepStrictEqual([r.gate.paused, r.gate.reason], [true, "low_power_mode"]);
  r.gate.stop();
});

test("mains power never pauses, whatever the charge or the mode", async () => {
  const r = rig({ onBattery: false, percent: 3, lowPower: true });
  await r.gate.start();
  assert.strictEqual(r.gate.paused, false);
  r.gate.stop();
});

test("when the system cannot say, it never pauses", async () => {
  for (const reading of [{ onBattery: null, percent: null, lowPower: null }, { onBattery: true, percent: null, lowPower: null }, null, new Error("pmset missing")]) {
    const r = rig(reading);
    await r.gate.start();
    assert.strictEqual(r.gate.paused, false, JSON.stringify(reading));
    r.gate.stop();
  }
});

test("it has a little hysteresis: paused under 20, running again at 25, not before", async () => {
  const r = rig({ onBattery: true, percent: 18, lowPower: false });
  await r.gate.start();
  assert.strictEqual(r.gate.paused, true);
  for (const [pct, paused] of [[21, true], [24, true], [25, false], [22, false], [19, true]]) {
    r.set({ onBattery: true, percent: pct, lowPower: false });
    await r.gate.poke();
    assert.strictEqual(r.gate.paused, paused, pct + "%");
  }
  r.gate.stop();
});

test("plugging in resumes at once (the platform's on-ac event pokes it), and the change is announced once per change", async () => {
  const r = rig({ onBattery: true, percent: 10, lowPower: false });
  await r.gate.start();
  await r.gate.poke();
  assert.deepStrictEqual(r.changes, [[true, "battery_low"]], "announced once, not at every look");
  r.set({ onBattery: false, percent: 10, lowPower: false });
  await r.gate.poke();
  assert.strictEqual(r.gate.paused, false);
  assert.deepStrictEqual(r.changes, [[true, "battery_low"], [false, ""]]);
  r.gate.stop();
});

test("it looks again by itself only while on battery: every two minutes, every minute near the line, and never on mains", async () => {
  const r = rig({ onBattery: true, percent: 80, lowPower: false });
  await r.gate.start();
  assert.deepStrictEqual(r.timers.pending(), [120000]);
  r.set({ onBattery: true, percent: 30, lowPower: false });
  r.timers.fire();
  await tick(3);
  assert.deepStrictEqual(r.timers.pending(), [60000], "near the line: a minute");
  r.set({ onBattery: false, percent: 100, lowPower: false });
  r.timers.fire();
  await tick(3);
  assert.deepStrictEqual(r.timers.pending(), [], "on mains: no timer at all");
  r.gate.stop();
});

test("stopped, it costs nothing and says nothing: no timer, never paused, pokes are ignored", async () => {
  const r = rig({ onBattery: true, percent: 5, lowPower: true });
  await r.gate.poke();
  assert.strictEqual(r.gate.paused, false);
  assert.deepStrictEqual(r.timers.pending(), []);
  await r.gate.start();
  assert.strictEqual(r.gate.paused, true);
  r.gate.stop();
  assert.strictEqual(r.gate.paused, false);
  assert.deepStrictEqual(r.timers.pending(), []);
});

test("starting twice reads once", async () => {
  let reads = 0;
  const gate = createPowerGate({ read: async () => { reads += 1; return { onBattery: false }; }, timers: fakeTimers() });
  await gate.start(); await gate.start(); await gate.start();
  assert.strictEqual(reads, 1);
  gate.stop();
});

// ---- the platforms' own words ----

test("macOS: pmset -g batt and pmset -g", () => {
  assert.deepStrictEqual(parsePmsetBatt("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=4653155)\t17%; discharging; 1:12 remaining present: true\n"), { onBattery: true, percent: 17 });
  assert.deepStrictEqual(parsePmsetBatt("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t88%; charging; 0:40 remaining present: true\n"), { onBattery: false, percent: 88 });
  assert.deepStrictEqual(parsePmsetBatt("Now drawing from 'AC Power'\n"), { onBattery: false, percent: null }, "a desktop Mac has no battery line");
  assert.deepStrictEqual(parsePmsetBatt(""), { onBattery: null, percent: null });
  assert.strictEqual(parsePmsetSettings("System-wide power settings:\nCurrently in use:\n lowpowermode         1\n sleep                1\n"), true);
  assert.strictEqual(parsePmsetSettings(" lowpowermode         0\n"), false);
  assert.strictEqual(parsePmsetSettings("sleep 1\n"), null, "older macOS: no such setting");
});

test("Linux: the batteries and the mains in /sys/class/power_supply", () => {
  assert.deepStrictEqual(parseSysfs([{ type: "Battery", status: "Discharging", capacity: "14" }, { type: "Mains", online: "0" }]), { onBattery: true, percent: 14 });
  assert.deepStrictEqual(parseSysfs([{ type: "Battery", status: "Charging", capacity: "14" }, { type: "Mains", online: "1" }]), { onBattery: false, percent: 14 });
  assert.deepStrictEqual(parseSysfs([{ type: "Battery", status: "Discharging", capacity: "50" }, { type: "Mains", online: "1" }]), { onBattery: false, percent: 50 }, "mains wins");
  assert.deepStrictEqual(parseSysfs([{ type: "Mains", online: "1" }]), { onBattery: false, percent: null }, "a desktop");
  assert.deepStrictEqual(parseSysfs([{ type: "Battery", status: "Discharging", capacity: "60" }, { type: "Battery", status: "Discharging", capacity: "9" }, { type: "Mains", online: "0" }]), { onBattery: true, percent: 9 }, "the lowest of two");
});

test("Windows: Win32_Battery as PowerShell prints it", () => {
  assert.deepStrictEqual(parseWinBattery('{"EstimatedChargeRemaining":18,"BatteryStatus":1}'), { onBattery: true, percent: 18 });
  assert.deepStrictEqual(parseWinBattery('{"EstimatedChargeRemaining":18,"BatteryStatus":2}'), { onBattery: false, percent: 18 });
  assert.deepStrictEqual(parseWinBattery(""), { onBattery: null, percent: null });
  assert.deepStrictEqual(parseWinBattery("null"), { onBattery: false, percent: null });
});

test("the system source asks each platform in its own way, and only asks PowerShell when Electron says the cable is out", async () => {
  const ran = [];
  const execFile = (file, args, o, cb) => {
    ran.push(file + " " + args.join(" "));
    if (file === "/usr/bin/pmset" && args[1] === "batt") return cb(null, "Now drawing from 'Battery Power'\n -InternalBattery-0\t12%; discharging\n");
    if (file === "/usr/bin/pmset") return cb(null, " lowpowermode 1\n");
    if (file === "powershell.exe") return cb(null, '{"EstimatedChargeRemaining":11,"BatteryStatus":1}');
    if (file === "powerprofilesctl") return cb(null, "power-saver\n");
    return cb(new Error("no"));
  };
  assert.deepStrictEqual(await createSystemSource({ platform: "darwin", execFile })(), { onBattery: true, percent: 12, lowPower: true });
  const files = { "/sys/class/power_supply": ["BAT0", "AC"], "/sys/class/power_supply/BAT0/type": "Battery", "/sys/class/power_supply/BAT0/status": "Discharging", "/sys/class/power_supply/BAT0/capacity": "33", "/sys/class/power_supply/AC/type": "Mains", "/sys/class/power_supply/AC/online": "0" };
  const fs = { readdirSync: (p) => files[p], readFileSync: (p) => { if (p in files) return files[p]; throw new Error("ENOENT"); } };
  assert.deepStrictEqual(await createSystemSource({ platform: "linux", execFile, fs })(), { onBattery: true, percent: 33, lowPower: true });
  ran.length = 0;
  assert.deepStrictEqual(await createSystemSource({ platform: "win32", execFile, powerMonitor: { isOnBatteryPower: () => false } })(), { onBattery: false, percent: null, lowPower: null });
  assert.deepStrictEqual(ran, [], "on mains power PowerShell is not even started");
  assert.deepStrictEqual(await createSystemSource({ platform: "win32", execFile, powerMonitor: { isOnBatteryPower: () => true } })(), { onBattery: true, percent: 11, lowPower: null });
  assert.deepStrictEqual(await createSystemSource({ platform: "freebsd", execFile, powerMonitor: null })(), { onBattery: null, percent: null, lowPower: null });
  const noSys = { readdirSync() { throw new Error("ENOENT"); }, readFileSync() { throw new Error("ENOENT"); } };
  assert.deepStrictEqual(await createSystemSource({ platform: "linux", execFile, fs: noSys })(), { onBattery: null, percent: null, lowPower: null });
});
