// What an ordinary step changed, to hand back to the server.
//
// An ORDINARY step (an offer with no `session`) runs its commands and reports; if they all passed and the step is not a trial
// (`discard`), the files they changed come back in the result and the SERVER commits them, through its own policy. This computer
// holds no token that can write. The reference is changesAgainst / collectChanges in the backend's runScript.ts, with its limits:
// no file over 1 MB, no binary file, no symlink, at most 200 files, at most 3 MB in all; whatever is left out is named in the
// output, so nothing is lost silently. `.tailzu/` and the runner's workflow are never changes.

"use strict";

const nodeFs = require("fs");
const nodePath = require("path");
const { isTailzuPath } = require("./overlay.js");

const FILE_MAX_BYTES = 1024 * 1024;
const TOTAL_MAX_BYTES = 3 * 1024 * 1024;
const FILES_MAX = 200;
const PATH_MAX = 500;
// eslint-disable-next-line no-control-regex
const BAD_PATH = /[\u0000-\u001f\u007f\\]/;

/** git diff --name-status --no-renames -z, read: [{ status: "A", path }, ...]. */
function parseNameStatus(raw) {
  const parts = String(raw).split("\0");
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (!parts[i]) break;
    out.push({ status: parts[i].charAt(0), path: parts[i + 1] });
  }
  return out;
}

/** The changes to send, from the diff entries. `read(path)` gives { size, symlink, notFile, bytes } or null when it is gone. */
function collectChanges(entries, read, limits) {
  const lim = Object.assign({ fileMax: FILE_MAX_BYTES, totalMax: TOTAL_MAX_BYTES, filesMax: FILES_MAX }, limits || {});
  const changes = [];
  const skipped = [];
  let total = 0;
  for (const e of entries) {
    if (isTailzuPath(e.path)) continue;
    if (e.path.length > PATH_MAX || BAD_PATH.test(e.path) || e.path.startsWith("/")) { skipped.push({ path: e.path, why: "odd path" }); continue; }
    if (changes.length >= lim.filesMax) { skipped.push({ path: e.path, why: "too many files" }); continue; }
    if (e.status === "D") { changes.push({ path: e.path, content: null }); continue; }
    if (e.status !== "A" && e.status !== "M") { skipped.push({ path: e.path, why: "not a plain file change" }); continue; }
    const f = read(e.path);
    if (!f) { skipped.push({ path: e.path, why: "gone before it was read" }); continue; }
    if (f.symlink || f.notFile) { skipped.push({ path: e.path, why: "not a plain file" }); continue; }
    if (f.size > lim.fileMax) { skipped.push({ path: e.path, why: "over 1 MB" }); continue; }
    let text;
    try {
      if (f.bytes.includes(0)) throw new Error("binary");
      text = new TextDecoder("utf-8", { fatal: true }).decode(f.bytes);
    } catch {
      skipped.push({ path: e.path, why: "not text" });
      continue;
    }
    const cost = Buffer.byteLength(JSON.stringify(text), "utf8");
    if (total + cost > lim.totalMax) { skipped.push({ path: e.path, why: "over the 3 MB total" }); continue; }
    total += cost;
    changes.push({ path: e.path, content: text });
  }
  return { changes, skipped };
}

/** One line for the output tail about what was left out; empty when nothing was. */
function skippedNote(skipped) {
  if (!skipped.length) return "";
  const names = skipped.slice(0, 8).map((s) => s.path + " (" + s.why + ")").join(", ");
  return "\n[X0 Bot: " + skipped.length + " changed file" + (skipped.length === 1 ? " was" : "s were") + " not sent: " + names + (skipped.length > 8 ? ", and more" : "") + "]";
}

function readFromTree(cwd, fs) {
  return (path) => {
    let st;
    try { st = fs.lstatSync(nodePath.join(cwd, path)); } catch { return null; }
    if (st.isSymbolicLink()) return { symlink: true };
    if (!st.isFile()) return { notFile: true };
    if (st.size > FILE_MAX_BYTES) return { size: st.size };
    return { size: st.size, bytes: fs.readFileSync(nodePath.join(cwd, path)) };
  };
}

/** What the commands changed in the working tree against `baseSha`, as changes to send. */
async function changesAgainst(baseSha, cwd, git, fs = nodeFs) {
  // Make new files show up in the diff (they are not tracked yet); what .gitignore hides stays hidden.
  await git.run(["add", "-A", "-N"], { cwd, timeoutMs: 120000 });
  const r = await git.run(["-c", "core.fileMode=false", "diff", "--name-status", "--no-renames", "-z", baseSha], { cwd, timeoutMs: 120000, maxBuffer: 256 * 1024 * 1024 });
  if (r.code !== 0) throw new Error("git could not say what changed");
  return collectChanges(parseNameStatus(r.stdout), readFromTree(cwd, fs));
}

module.exports = { changesAgainst, collectChanges, parseNameStatus, skippedNote, FILE_MAX_BYTES, TOTAL_MAX_BYTES, FILES_MAX };
