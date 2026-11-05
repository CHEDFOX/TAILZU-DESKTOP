// Finding the desktop app's runner: the copy packed beside xode (runner/, made by scripts/bundle-runner.js when the package is
// packed), else the app's own, when xode runs from the repository (../src/runner).

"use strict";

const fs = require("fs");
const path = require("path");

const PACKAGE = path.resolve(__dirname, "..", "..");
const PLACES = [["runner"], ["..", "src", "runner"]];

/** The folder of the runner, or "" when this copy of xode has none. */
function runnerDir(root = PACKAGE) {
  for (const parts of PLACES) {
    const dir = path.join(root, ...parts);
    if (fs.existsSync(path.join(dir, "index.js"))) return dir;
  }
  return "";
}

/** The runner's createRunner, or null. */
function loadCreateRunner(root = PACKAGE) {
  const dir = runnerDir(root);
  return dir ? require(path.join(dir, "index.js")).createRunner : null;
}

module.exports = { runnerDir, loadCreateRunner };
