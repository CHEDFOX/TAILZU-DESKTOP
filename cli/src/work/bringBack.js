// Bringing a job's work branch into the person's folder, once the job is over.
//
//   1. Anything uncommitted (staged, unstaged, or new files git doesn't ignore): nothing is touched, nothing is fetched; the person
//      is told the two commands that would do it.
//   2. Clean: the branch is fetched from the project's remote. Already on it: a fast-forward only. Otherwise the local branch of the
//      same name is made (or moved forward, when Xode's has everything it has) and switched to.
//   3. What changed against the project's default branch: git's own `diff --stat`.
//
// Every git call is execFile with a time limit (git/run.js). Never a force-push, a reset of the person's own work, or a stash.

"use strict";

const { git } = require("../git/run");

/** A branch name git would take, that can't be read as an option. */
async function validBranch(top, name) {
  if (typeof name !== "string" || !name || name.startsWith("-") || name.length > 255) return false;
  try { await git(["check-ref-format", "--branch", name], { cwd: top, what: "read the branch name" }); return true; } catch { return false; }
}

async function revOf(top, ref) {
  try { return (await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: top })).stdout.trim(); } catch { return ""; }
}

async function currentBranch(top) {
  try { return (await git(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: top })).stdout.trim(); } catch { return ""; }
}

async function isAncestor(top, a, b) {
  try { await git(["merge-base", "--is-ancestor", a, b], { cwd: top }); return true; } catch { return false; }
}

/**
 * Resolves { state, branch }: state is "dirty", "switched", "updated", "same", "kept" (the person's own branch was left as it was)
 * or "failed" (said in one sentence). o: { top, remote (its name), branch, base (the default branch, may be ""), out }.
 */
async function bringBack({ top, remote, branch, base, out }) {
  const say = (state, line, how = "line") => { if (line) out[how](line); return { state, branch }; };
  if (!(await validBranch(top, branch))) return say("failed", "The job's branch name isn't one git takes, so I left your folder as it is.", "warn");
  const tracking = `refs/remotes/${remote}/${branch}`;
  try {
    const { stdout } = await git(["status", "--porcelain", "--untracked-files=normal"], { cwd: top, what: "read the folder's status" });
    if (stdout.trim()) {
      // The command on a line of its own, so it is not wrapped mid-word and copies whole.
      out.line("You have uncommitted changes, so I left your folder as it is.");
      out.line(`The work is on branch ${branch}. To get it when you're ready:`);
      return say("dirty", `  git fetch ${remote} ${branch} && git switch ${branch}`);
    }
    const before = await revOf(top, "HEAD");
    await git(["fetch", "--no-tags", remote, `+refs/heads/${branch}:${tracking}`], { cwd: top, timeoutMs: 120_000, what: `fetch ${branch} from ${remote}` });
    let baseRef = "";
    if (base && base !== branch && (await validBranch(top, base))) {
      try {
        await git(["fetch", "--no-tags", remote, `+refs/heads/${base}:refs/remotes/${remote}/${base}`], { cwd: top, timeoutMs: 120_000, what: `fetch ${base}` });
        baseRef = `refs/remotes/${remote}/${base}`;
      } catch { /* the stat below goes against where the folder was */ }
    }
    const theirs = await revOf(top, tracking);
    if (!theirs) return say("failed", `git fetched nothing for ${branch}, so I left your folder as it is.`, "warn");

    let result;
    const on = await currentBranch(top);
    if (on === branch) {
      if ((await revOf(top, "HEAD")) === theirs) result = say("same", `${branch} already has Xode's changes.`);
      else if (await isAncestor(top, "HEAD", theirs)) {
        await git(["merge", "--ff-only", "--quiet", theirs], { cwd: top, timeoutMs: 60_000, what: `bring ${branch} up to date` });
        result = say("updated", `Updated ${branch} with Xode's changes.`);
      } else {
        return say("kept", `Your ${branch} has commits Xode's doesn't, so I left it as it is. Xode's work is at ${remote}/${branch}.`);
      }
    } else {
      const mine = await revOf(top, `refs/heads/${branch}`);
      if (mine && mine !== theirs) {
        if (!(await isAncestor(top, mine, theirs))) {
          return say("kept", `Your own ${branch} has commits Xode's doesn't, so I left it as it is. Xode's work is at ${remote}/${branch}.`);
        }
        // Behind Xode's: moved forward (git refuses if it is checked out in another worktree).
        await git(["branch", "--force", branch, theirs], { cwd: top, what: `move ${branch} forward` });
      }
      if (mine) await git(["switch", "--quiet", branch], { cwd: top, timeoutMs: 60_000, what: `switch to ${branch}` });
      else await git(["switch", "--quiet", "-c", branch, tracking], { cwd: top, timeoutMs: 60_000, what: `switch to ${branch}` });
      result = say("switched", `Switched to ${branch}, with Xode's changes.`);
    }

    const from = baseRef || (before && before !== theirs ? before : "");
    if (from) {
      try {
        const { stdout: stat } = await git(["diff", "--stat", "--no-color", `${from}...${theirs}`], { cwd: top, what: "show what changed" });
        for (const l of stat.replace(/\s+$/, "").split("\n")) if (l) out.note(l);
      } catch { /* the branch is there all the same */ }
    }
    return result;
  } catch (err) {
    return say("failed", `${err.message} Your folder is as it was; the work is on branch ${branch}.`, "warn");
  }
}

module.exports = { bringBack };
