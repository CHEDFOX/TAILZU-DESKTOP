// WHEN TO STAND DOWN: Tailzu Code is paused while this computer is on battery below 20%, or in a low-power mode.
//
// The person's computer is not a server. Running a build on a laptop at 15% battery, or one the person has put in Low Power
// Mode to make it last, is the opposite of a favour. So the gate watches two facts - on battery and how full, and whether the
// system's low-power mode is on - and says "paused" (with the reason) when either calls for it. The runner then goes offline for
// Xode, which sends the work somewhere else, and comes back by itself.
//
// Cheap on purpose: on mains power nothing is polled at all (the platform's on-ac / on-battery events wake it); on battery it
// looks every two minutes, every minute once the level is near the line. It stops looking when it is off.
//
//   - detectable only where the platform says: macOS (`pmset`), Linux (sysfs, and power-profiles-daemon's `power-saver`), Windows
//     (the battery from WMI; Battery Saver is not read). Where it cannot tell, it never pauses.
//   - a little hysteresis: paused below 20%, running again at 25%, so it does not flap at the line.

"use strict";

const childProcess = require("child_process");
const nodeFs = require("fs");

/**
 * The gate. `read()` resolves { onBattery: boolean | null, percent: number | null, lowPower: boolean | null } - the source of
 * truth, handed in so that tests can say what they like.
 */
function createPowerGate({ read, onChange, thresholdPct = 20, resumePct = 25, pollMs = 120000, nearPollMs = 60000, timers = { setTimeout, clearTimeout } } = {}) {
  let active = false;
  let timer = null;
  let current = { paused: false, reason: "", onBattery: null, percent: null, lowPower: null };
  let reading = null;

  function decide(s, wasPaused) {
    if (s.onBattery !== true) return { paused: false, reason: "" };
    if (s.lowPower === true) return { paused: true, reason: "low_power_mode" };
    if (typeof s.percent === "number" && s.percent < (wasPaused ? resumePct : thresholdPct)) return { paused: true, reason: "battery_low" };
    return { paused: false, reason: "" };
  }

  function schedule() {
    timers.clearTimeout(timer);
    timer = null;
    // Mains power: nothing to watch until an event says the cable came out.
    if (!active || current.onBattery !== true) return;
    const near = typeof current.percent === "number" && current.percent < resumePct + 10;
    timer = timers.setTimeout(() => { timer = null; void refresh(); }, near ? nearPollMs : pollMs);
    if (timer && timer.unref) timer.unref();
  }

  /** Reads the facts again and decides. Resolves the new state. */
  function refresh() {
    if (reading) return reading;
    reading = (async () => {
      let s;
      try { s = await read(); } catch { s = null; }
      reading = null;
      if (!s || typeof s !== "object") s = { onBattery: null, percent: null, lowPower: null };
      const d = decide(s, current.paused);
      const next = { paused: d.paused, reason: d.reason, onBattery: s.onBattery === true ? true : s.onBattery === false ? false : null, percent: typeof s.percent === "number" ? s.percent : null, lowPower: s.lowPower === true ? true : s.lowPower === false ? false : null };
      const changed = next.paused !== current.paused || next.reason !== current.reason;
      current = next;
      schedule();
      if (changed && onChange) { try { onChange(Object.assign({}, current)); } catch { /* a listener must not stop the gate */ } }
      return Object.assign({}, current);
    })();
    return reading;
  }

  return {
    /** Starts watching (reads once now). Safe to call again: it only reads the first time. */
    start() { if (active) return reading || Promise.resolve(Object.assign({}, current)); active = true; return refresh(); },
    /** Stops watching. The state counts as not paused until started again. */
    stop() { active = false; timers.clearTimeout(timer); timer = null; current = Object.assign({}, current, { paused: false, reason: "" }); },
    /** The platform said the power changed (on-ac, on-battery, resume, a speed-limit change). */
    poke() { return active ? refresh() : Promise.resolve(Object.assign({}, current)); },
    get paused() { return active && current.paused; },
    get reason() { return active ? current.reason : ""; },
    state() { return Object.assign({}, current, { paused: active && current.paused }); },
  };
}

// ---------------------------------------------------------------------------------------------- reading the system

/** `pmset -g batt` on a Mac. */
function parsePmsetBatt(text) {
  const t = String(text);
  if (!t.trim()) return { onBattery: null, percent: null };
  const onBattery = /drawing from 'Battery Power'/i.test(t) ? true : /drawing from 'AC Power'|drawing from 'UPS Power'/i.test(t) ? false : null;
  const m = /(\d{1,3})%/.exec(t);
  return { onBattery, percent: m ? Number(m[1]) : null };
}
/** `pmset -g` (the settings in force): Low Power Mode is `lowpowermode 1` on macOS 12 and later. */
function parsePmsetSettings(text) {
  const m = /lowpowermode\s+(\d)/i.exec(String(text));
  return m ? m[1] === "1" : null;
}
/** Linux: the batteries in /sys/class/power_supply as { type, status, capacity }. */
function parseSysfs(entries) {
  const batteries = entries.filter((e) => /battery/i.test(e.type || ""));
  if (!batteries.length) return { onBattery: false, percent: null };
  const discharging = batteries.some((b) => /discharging/i.test(b.status || ""));
  const mains = entries.some((e) => /mains|usb|ups/i.test(e.type || "") && String(e.online) === "1");
  const caps = batteries.map((b) => Number(b.capacity)).filter((n) => Number.isFinite(n));
  return { onBattery: discharging && !mains, percent: caps.length ? Math.min(...caps) : null };
}
/** Windows: Get-CimInstance Win32_Battery as JSON. BatteryStatus 1 is discharging. */
function parseWinBattery(text) {
  let j;
  try { j = JSON.parse(String(text)); } catch { return { onBattery: null, percent: null }; }
  const b = Array.isArray(j) ? j[0] : j;
  if (!b || typeof b !== "object") return { onBattery: false, percent: null };
  const pct = Number(b.EstimatedChargeRemaining);
  return { onBattery: Number(b.BatteryStatus) === 1, percent: Number.isFinite(pct) ? pct : null };
}

/**
 * The system's own answer. `powerMonitor` is Electron's (isOnBatteryPower is cheap and native); `execFile` / `fs` are the real ones
 * unless a test gives others.
 */
function createSystemSource({ platform = process.platform, execFile = childProcess.execFile, fs = nodeFs, powerMonitor = null } = {}) {
  const run = (file, args, timeout = 6000) => new Promise((resolve) => {
    try { execFile(file, args, { timeout, windowsHide: true }, (err, stdout) => resolve(err ? "" : String(stdout || ""))); } catch { resolve(""); }
  });
  const electronOnBattery = () => { try { return powerMonitor && typeof powerMonitor.isOnBatteryPower === "function" ? !!powerMonitor.isOnBatteryPower() : null; } catch { return null; } };
  return async function read() {
    if (platform === "darwin") {
      const batt = parsePmsetBatt(await run("/usr/bin/pmset", ["-g", "batt"]));
      const lowPower = batt.onBattery === null ? null : parsePmsetSettings(await run("/usr/bin/pmset", ["-g"]));
      return { onBattery: batt.onBattery, percent: batt.percent, lowPower };
    }
    if (platform === "linux") {
      const base = "/sys/class/power_supply";
      let names = [];
      try { names = fs.readdirSync(base); } catch { return { onBattery: null, percent: null, lowPower: null }; }
      const rd = (n, f) => { try { return String(fs.readFileSync(base + "/" + n + "/" + f, "utf8")).trim(); } catch { return ""; } };
      const s = parseSysfs(names.map((n) => ({ type: rd(n, "type"), status: rd(n, "status"), capacity: rd(n, "capacity"), online: rd(n, "online") })));
      let lowPower = null;
      if (s.onBattery) { const prof = (await run("powerprofilesctl", ["get"], 3000)).trim(); lowPower = prof ? prof === "power-saver" : null; }
      return { onBattery: s.onBattery, percent: s.percent, lowPower };
    }
    if (platform === "win32") {
      // The cheap native question first: on mains power there is nothing to ask PowerShell.
      const on = electronOnBattery();
      if (on === false) return { onBattery: false, percent: null, lowPower: null };
      const w = parseWinBattery(await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress"], 15000));
      return { onBattery: on === true ? true : w.onBattery, percent: w.percent, lowPower: null };
    }
    return { onBattery: electronOnBattery(), percent: null, lowPower: null };
  };
}

module.exports = { createPowerGate, createSystemSource, parsePmsetBatt, parsePmsetSettings, parseSysfs, parseWinBattery };
