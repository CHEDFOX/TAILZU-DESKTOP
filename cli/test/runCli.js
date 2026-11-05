// Runs bin/xode.js as a person would, against the fake server: its output is collected, and lines can be typed when it asks
// (or, with XODE_KEYS=1, keys pressed one by one).

"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { makeRepos } = require("./gitFixture");

const BIN = path.join(__dirname, "..", "bin", "xode.js");

/**
 * A temporary home: a config folder, and the project's folder `work`, a clone of ana/storefront (gitFixture.js) with Xode's work
 * branch already on "GitHub". `plain` is a folder that is not a repository. o: makeRepos's options.
 */
function tempHome(o = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xode-test-"));
  const config = path.join(root, "config");
  const plain = path.join(root, "plain");
  fs.mkdirSync(plain);
  const repos = makeRepos(root, o);
  return { root, config, work: repos.work, plain, repos, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function runCli(args, { server, home, env = {}, cwd } = {}) {
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd: cwd || home.work,
    env: {
      PATH: process.env.PATH, HOME: home.root, XDG_CONFIG_HOME: home.config, XODE_CRED_STORE: "file", XODE_SERVER: server.url,
      XODE_POLL_MS: "30", XODE_TTY: "0", XDG_CACHE_HOME: path.join(home.root, "cache"), XODE_NO_UPDATE_CHECK: "1", ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let all = "";
  const waiters = [];
  const check = () => {
    for (const w of [...waiters]) {
      const hit = typeof w.what === "string" ? all.indexOf(w.what, w.from) : (all.slice(w.from).search(w.what));
      if (hit >= 0) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.t); w.resolve(); }
    }
  };
  child.stdout.on("data", (d) => { stdout += d; all += d; check(); });
  child.stderr.on("data", (d) => { stderr += d; all += d; check(); });
  // A run that never ends (a test that failed half way) is stopped, so the test file can end.
  const cap = setTimeout(() => child.kill("SIGKILL"), 60_000);
  cap.unref();
  const done = new Promise((resolve) => child.on("close", (code) => { clearTimeout(cap); resolve({ code, stdout, stderr, all }); }));
  return {
    child,
    done,
    get output() { return all; },
    /** Waits until `what` (text or a pattern) has been printed. */
    waitFor(what, ms = 8000, from = 0) {
      return new Promise((resolve, reject) => {
        const w = { what, from, resolve };
        w.t = setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1);
          child.kill("SIGKILL");
          reject(new Error(`Timed out waiting for ${what}\n--- output ---\n${all}`));
        }, ms);
        waiters.push(w);
        check();
      });
    },
    /** Waits for `what` printed after everything so far. */
    waitForNext(what, ms) { return this.waitFor(what, ms, all.length); },
    type(line) { child.stdin.write(line + "\n"); },
    /** Raw key presses (with XODE_KEYS=1): "\r" is Enter, "\x03" Ctrl+C, "\x04" Ctrl+D, "\x1b" Esc, "\x1b[A" Up. */
    keys(seq) { child.stdin.write(seq); },
    end() { child.stdin.end(); },
  };
}

module.exports = { runCli, tempHome, BIN };
