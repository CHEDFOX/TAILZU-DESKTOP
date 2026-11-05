// Runs bin/xode.js as a person would, against the fake server: its output is collected, and lines can be typed when it asks.

"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BIN = path.join(__dirname, "..", "bin", "xode.js");

/** A temporary home: a config folder and a project folder. */
function tempHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xode-test-"));
  const config = path.join(root, "config");
  const work = path.join(root, "work");
  fs.mkdirSync(work);
  return { root, config, work, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function runCli(args, { server, home, env = {}, cwd } = {}) {
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd: cwd || home.work,
    env: {
      PATH: process.env.PATH, HOME: home.root, XDG_CONFIG_HOME: home.config, XODE_CRED_STORE: "file", XODE_SERVER: server.url,
      XODE_POLL_MS: "30", XODE_TTY: "0", ...env,
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
  const done = new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr, all })));
  return {
    child,
    done,
    get output() { return all; },
    /** Waits until `what` (text or a pattern) has been printed. */
    waitFor(what, ms = 8000, from = 0) {
      return new Promise((resolve, reject) => {
        const w = { what, from, resolve };
        w.t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error(`Timed out waiting for ${what}\n--- output ---\n${all}`)); }, ms);
        waiters.push(w);
        check();
      });
    },
    /** Waits for `what` printed after everything so far. */
    waitForNext(what, ms) { return this.waitFor(what, ms, all.length); },
    type(line) { child.stdin.write(line + "\n"); },
    end() { child.stdin.end(); },
  };
}

module.exports = { runCli, tempHome, BIN };
