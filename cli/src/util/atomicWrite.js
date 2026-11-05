// Writes a file in one step: to a temporary file beside it, then renamed over it, so a crash never leaves half a file.

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/** Makes the folder (and its parents) and keeps it to `mode`. */
function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
  try { fs.chmodSync(dir, mode); } catch { /* not ours to change */ }
}

/** Writes `text` to `file` with `mode`, in one step. */
function writeFileAtomic(file, text, mode = 0o600) {
  const dir = path.dirname(file);
  ensureDir(dir);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  const fd = fs.openSync(tmp, "wx", mode);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* gone */ }
    throw err;
  }
}

/** Reads a JSON file, or `fallback` when it is missing or broken. */
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

module.exports = { writeFileAtomic, ensureDir, readJson };
