// Running git for the app's own work on a workspace (clone, fetch, checkout, reset, search, diff).
//
// Not for the commands of a job: those get the scrubbed environment (env.js) and a shell. This is the app calling git,
// and it keeps the person's own git setup out of it too: no global or system config (an `insteadOf` rewriting
// https://github.com/ to an ssh address would send the fetch down the person's SSH keys), no credential helper (the
// read-only token must never reach a keychain), no prompt, no hooks. The token, when there is one, is passed in the
// ENVIRONMENT of that one process as an HTTP header, never on the command line and never written to the repository's
// config, so it is in no file and in no process list.

"use strict";

const childProcess = require("child_process");
const nodeOs = require("os");

const PASS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "GIT_SSL_CAINFO", "GIT_SSL_CAPATH", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR"];

/** `x-access-token:<token>` as HTTP Basic, the way GitHub takes an App's installation token. */
const basicHeader = (token) => "Authorization: Basic " + Buffer.from("x-access-token:" + token).toString("base64");

/**
 * The environment for one git process. `token`, if given, rides as `http.extraHeader` through GIT_CONFIG_COUNT (git 2.31 and
 * newer); `argvHeader` is for an older git, which has to be told on the command line (see run()).
 */
function gitEnv({ real = process.env, loginPath, home, token, platform = process.platform }) {
  const env = { PATH: loginPath || real.PATH || "", HOME: home, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: platform === "win32" ? "NUL" : "/dev/null", GIT_ASKPASS: "echo", SSH_ASKPASS: "echo", GIT_LFS_SKIP_SMUDGE: "1", GIT_CONFIG_COUNT: "0" };
  if (platform === "win32") env.USERPROFILE = home;
  for (const k of PASS) if (typeof real[k] === "string" && real[k]) env[k] = real[k];
  if (token) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.extraHeader";
    env.GIT_CONFIG_VALUE_0 = basicHeader(token);
  }
  return env;
}

/** Arguments every git call carries: no credential helper, no hooks, no fsmonitor, no background gc, nothing from the checkout's own config that runs code. */
const SAFE = ["-c", "credential.helper=", "-c", "core.hooksPath=" + (process.platform === "win32" ? "NUL" : "/dev/null"), "-c", "core.fsmonitor=false", "-c", "gc.auto=0", "-c", "protocol.ext.allow=never"];

/**
 * A git runner. run(args, { cwd, token, timeoutMs, input, maxBuffer, extraEnv }) never rejects on a non-zero exit: it resolves
 * { code, stdout, stderr, error }. The token, if any, is put in the environment of that call only.
 */
function createGit({ execFile = childProcess.execFile, real = process.env, home, getPath, platform = process.platform } = {}) {
  let version = null;
  async function run(args, o = {}) {
    const loginPath = getPath ? await getPath() : real.PATH;
    const env = Object.assign(gitEnv({ real, loginPath, home, token: version && version.older ? "" : o.token, platform }), o.extraEnv || {});
    let full = SAFE.concat(args);
    // An old git cannot take the header through the environment: it goes on the command line for that one call.
    if (o.token && version && version.older) full = ["-c", "http.extraHeader=" + basicHeader(o.token)].concat(full);
    return new Promise((resolve) => {
      const child = execFile("git", full, { cwd: o.cwd, env, timeout: o.timeoutMs || 300000, maxBuffer: o.maxBuffer || 64 * 1024 * 1024, encoding: "utf8", windowsHide: true }, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : err.killed ? 124 : 127) : 0;
        resolve({ code, stdout: String(stdout || ""), stderr: String(stderr || ""), error: err && err.code === "ENOENT" ? "git is not installed" : err && err.killed ? "git took too long" : "" });
      });
      if (o.input !== undefined && child.stdin) { child.stdin.on("error", () => {}); child.stdin.end(o.input); }
      else if (child.stdin) child.stdin.end();
    });
  }
  /** git's version as [major, minor], once. */
  async function detect() {
    if (version) return version;
    const r = await run(["--version"], { timeoutMs: 15000 });
    const m = /(\d+)\.(\d+)/.exec(r.stdout);
    version = { major: m ? Number(m[1]) : 0, minor: m ? Number(m[2]) : 0, found: r.code === 0 };
    version.older = version.found && (version.major < 2 || (version.major === 2 && version.minor < 31));
    return version;
  }
  return { run, detect, home: () => home || nodeOs.homedir() };
}

module.exports = { createGit, gitEnv, basicHeader, SAFE };
