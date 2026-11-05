// The battery, for the runner, in a terminal: there is no Electron powerMonitor here. The runner reads the system itself where it
// can (power.js in the runner: pmset on macOS, sysfs on Linux); this stands in for the one question it asks Electron (Windows), and
// answers "not on battery", so a computer that can't tell is treated as on mains power and never paused.

"use strict";

const { EventEmitter } = require("events");

function createPowerMonitor() {
  const pm = new EventEmitter();
  pm.isOnBatteryPower = () => false;
  return pm;
}

module.exports = { createPowerMonitor };
