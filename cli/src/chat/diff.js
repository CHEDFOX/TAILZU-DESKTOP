// /diff: everything the last work branch changed against the project's default branch (git's own `diff base...branch`),
// with added lines green, removed lines red and each hunk's head cyan. Printed straight out, no pager.
//
// The branch is the one the last job here brought back (state.json, work/afterJob.js): the local branch when there is one,
// else what was fetched from the remote.

"use strict";

const { git } = require("../git/run");

async function has(top, ref) {
  try { await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: top }); return true; } catch { return false; }
}

/** The first of `refs` that names a commit here, or "". */
async function firstRef(top, refs) {
  for (const r of refs) if (await has(top, r)) return r;
  return "";
}

/** A line of the diff in its colour. */
function paintDiffLine(l, paint) {
  if (/^(\+\+\+|---) /.test(l) || l.startsWith("diff --git")) return paint.bold(l);
  if (l.startsWith("+")) return paint.green(l);
  if (l.startsWith("-")) return paint.red(l);
  if (l.startsWith("@@")) return paint.cyan(l);
  return l;
}

/**
 * Resolves { lines } (painted) or { message } when there is nothing to show.
 * o: { top, remote (its name), branch, base, paint }
 */
async function branchDiff({ top, remote = "origin", branch, base, paint }) {
  if (!branch) return { message: "No work branch here yet: /diff shows one once a job has brought its work back." };
  const theirs = await firstRef(top, [`refs/heads/${branch}`, `refs/remotes/${remote}/${branch}`]);
  if (!theirs) return { message: `${branch} isn't in this folder: run git fetch ${remote} ${branch} first.` };
  const b = base || "main";
  const from = await firstRef(top, [`refs/remotes/${remote}/${b}`, `refs/heads/${b}`]);
  if (!from) return { message: `${b}, the branch to compare with, isn't in this folder.` };
  let out;
  try {
    out = (await git(["diff", "--no-color", "--no-ext-diff", `${from}...${theirs}`], { cwd: top, timeoutMs: 60_000, what: "show the changes" })).stdout;
  } catch (err) {
    return { message: err.message };
  }
  const body = out.replace(/\s+$/, "");
  if (!body) return { message: `${branch} has no changes against ${b}.` };
  return { lines: [paint.dim(`${branch} against ${b}`), ...body.split("\n").map((l) => paintDiffLine(l, paint))] };
}

module.exports = { branchDiff, paintDiffLine };
