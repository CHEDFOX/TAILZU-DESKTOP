// Running git: execFile, never a shell, in a given folder, with a time limit, and errors in one plain sentence.

"use strict";

const { execFile } = require("child_process");
const { redact } = require("../api/redact");

/** git's own refusal, or a git that could not run. `stderr` is git's words, with secrets taken out. */
class GitError extends Error {
  constructor(message, { code = "git_failed", stderr = "", exitCode = null } = {}) {
    super(redact(message));
    this.code = code;
    this.stderr = redact(stderr);
    this.exitCode = exitCode;
  }
}

/** The first line git wrote that says something ("fatal: ..." without the "fatal: "). */
function firstLine(text) {
  const line = String(text || "").split("\n").map((l) => l.trim()).find(Boolean) || "";
  return line.replace(/^(fatal|error):\s*/i, "");
}

/**
 * Runs `git <args>` in `cwd`. Resolves { stdout, stderr }; rejects a GitError.
 * o: { cwd, timeoutMs (default 15 s), env (added to this process's), what: words for the error ("fetch xode/fix") }
 */
function git(args, o = {}) {
  const timeout = o.timeoutMs || 15_000;
  // Never wait for a password nobody can type, and never page.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", PAGER: "cat", LC_ALL: "C", ...(o.env || {}) };
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = execFile("git", args, { cwd: o.cwd, env, timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        if (!err) { resolve({ stdout: String(stdout), stderr: String(stderr) }); return; }
        if (err.code === "ENOENT") { reject(new GitError("git isn't installed, or isn't on the PATH.", { code: "no_git" })); return; }
        if (err.killed || err.signal === "SIGTERM") {
          reject(new GitError(`git took too long${o.what ? ` to ${o.what}` : ""}, so I stopped it.`, { code: "git_timeout", stderr }));
          return;
        }
        const said = firstLine(stderr) || firstLine(stdout) || `it ended with code ${err.code}`;
        reject(new GitError(`git couldn't ${o.what || args[0]}: ${said.replace(/\.$/, "")}.`, { stderr, exitCode: typeof err.code === "number" ? err.code : null }));
      });
    } catch (err) {
      reject(new GitError(`git couldn't start: ${err.message}`, { code: "no_git" }));
      return;
    }
    if (child.stdin) child.stdin.end();
  });
}

/** The repository's top folder for `cwd`, or null when `cwd` is not inside one. Throws only when git itself is missing. */
async function topOf(cwd) {
  try {
    const { stdout } = await git(["rev-parse", "--show-toplevel"], { cwd, what: "find the repository" });
    return stdout.trim() || null;
  } catch (err) {
    if (err.code === "no_git") throw err;
    return null;
  }
}

module.exports = { git, topOf, GitError };
