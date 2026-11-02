// The agent's staged edits, laid over the checkout; and the checkout put back between commands.
//
// The reference is applyOverlay / resetCheckout in the backend's runScript.ts. The overlay is the agent's WHOLE set of staged
// edits every time, not a difference, so each command sees "the branch plus the staged edits": tracked files are restored,
// the files the previous overlay created that git does not track are removed, then each entry is written (or the file is
// deleted when its content is null). Untracked and ignored files (node_modules, build output, caches) are left alone: that is
// what makes the second command fast.
//
// A path that is absolute, has `..` or a backslash, is under `.git/`, is `.tailzu/...`, is under `.github/workflows/`, or
// goes through a symbolic link out of the checkout is not written, and is named in the output.

"use strict";

const nodeFs = require("fs");
const nodePath = require("path");

const PATH_MAX = 500;
// eslint-disable-next-line no-control-regex
const BAD_PATH = /[\u0000-\u001f\u007f\\]/;

/** The files this runner's reference and its workflow are made of: never written. */
function isTailzuPath(p) {
  return /^\.tailzu(\/|$)/i.test(p) || p.toLowerCase() === ".github/workflows/tailzu-run.yml";
}

/** A path that may be written under the checkout: inside it, not .git, not Tailzu's own files, not a workflow. */
function overlayPathOk(p) {
  if (typeof p !== "string" || !p || p.length > PATH_MAX) return false;
  if (p.startsWith("/") || p.includes("\\") || BAD_PATH.test(p) || /^[A-Za-z]:/.test(p)) return false;
  if (p.split("/").some((x) => x === "" || x === "." || x === ".." || x.toLowerCase() === ".git")) return false;
  return !isTailzuPath(p) && !/^\.github\/workflows(\/|$)/i.test(p);
}

const inside = (root, p, sep) => p === root || p.startsWith(root + sep);

/**
 * Lays the files over the checkout: text written, or the file removed when its content is null. A path that is not allowed, or
 * whose folder is, or leads through, a symlink out of the checkout, is skipped. Returns { written, removed, skipped: [path] }.
 */
function applyOverlay(files, cwd, fs = nodeFs) {
  const root = fs.realpathSync(cwd);
  const out = { written: 0, removed: 0, skipped: [] };
  for (const f of Array.isArray(files) ? files : []) {
    const p = f && f.path;
    if (!overlayPathOk(p) || (f.content !== null && typeof f.content !== "string")) { out.skipped.push(String(p).slice(0, 120)); continue; }
    const target = nodePath.resolve(root, p);
    try {
      if (f.content === null) {
        let there;
        try { there = fs.realpathSync(nodePath.dirname(target)); } catch { continue; }
        if (!inside(root, there, nodePath.sep)) { out.skipped.push(p); continue; }
        fs.rmSync(target, { force: true });
        out.removed += 1;
        continue;
      }
      fs.mkdirSync(nodePath.dirname(target), { recursive: true });
      const folder = fs.realpathSync(nodePath.dirname(target));
      if (!inside(root, folder, nodePath.sep)) { out.skipped.push(p); continue; }
      // Never write through a symlink at the file itself.
      try { if (fs.lstatSync(target).isSymbolicLink()) fs.rmSync(target); } catch { /* not there yet */ }
      fs.writeFileSync(target, f.content);
      out.written += 1;
    } catch {
      out.skipped.push(p);
    }
  }
  return out;
}

/**
 * Puts the checkout back as the branch has it, before the next command: tracked files restored (the commands may have rewritten a
 * lockfile or run a formatter), and files the previous overlay CREATED removed. `laid` is the set of paths the last overlay touched;
 * it is emptied. `git` is a runner from gitrun.js.
 */
async function resetCheckout(cwd, laid, git, fs = nodeFs) {
  await git.run(["checkout", "--", "."], { cwd, timeoutMs: 120000 });
  const paths = [...laid].filter(overlayPathOk);
  for (let i = 0; i < paths.length; i += 40) {
    const chunk = paths.slice(i, i + 40);
    const r = await git.run(["ls-files", "-z", "--"].concat(chunk.map((p) => ":(literal)" + p)), { cwd, timeoutMs: 60000 });
    const tracked = new Set(r.code === 0 ? r.stdout.split("\0").filter(Boolean) : chunk);   // if git cannot say, remove nothing
    for (const p of chunk) {
      if (tracked.has(p)) continue;
      try { fs.rmSync(nodePath.resolve(cwd, p), { force: true }); } catch { /* gone already */ }
    }
  }
  laid.clear();
}

/** Resets the checkout and lays an overlay over it, remembering what was laid. Returns applyOverlay's result. */
async function layOverlay(cwd, overlay, laid, git, fs = nodeFs) {
  await resetCheckout(cwd, laid, git, fs);
  const lay = applyOverlay(overlay, cwd, fs);
  for (const f of Array.isArray(overlay) ? overlay : []) if (f && overlayPathOk(f.path)) laid.add(f.path);
  return lay;
}

module.exports = { overlayPathOk, applyOverlay, resetCheckout, layOverlay, isTailzuPath };
