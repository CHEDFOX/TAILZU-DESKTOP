// The watchdog: a tiny process that kills the commands' process groups if this app dies without saying goodbye.
//
// A command is run in a process group of its own so a timeout, a Stop or the end of a session can kill all of it. That
// does nothing when the app itself is killed (a crash that skips every handler, a power button, Task Manager): the
// children are detached and would carry on. So the app starts one small helper, hands it each group's id through a
// pipe, and the helper waits. If the pipe closes without an `exit` line the app is gone, and it kills every group it
// was told about. Idle, it costs nothing: it is blocked reading a pipe.
//
// The helper is this same executable run as plain Node (`ELECTRON_RUN_AS_NODE`), given the script below with `-e`.

"use strict";

const childProcess = require("child_process");

/** The helper's program. A line is `add <pid>`, `del <pid>` or `exit`; the end of the pipe, without `exit`, is a crash. */
const WATCHDOG_SRC = `
const cp = require("child_process");
const groups = new Set();
let clean = false;
let buf = "";
const killAll = () => {
  for (const pid of groups) {
    try {
      if (process.platform === "win32") cp.spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
      else process.kill(-pid, "SIGKILL");
    } catch (e) { /* already gone */ }
  }
  process.exit(0);
};
const done = () => { if (clean) process.exit(0); killAll(); };
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let at;
  while ((at = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, at).trim();
    buf = buf.slice(at + 1);
    const m = /^(add|del) (\\d+)$/.exec(line);
    if (m) { if (m[1] === "add") groups.add(Number(m[2])); else groups.delete(Number(m[2])); }
    else if (line === "exit") clean = true;
  }
});
process.stdin.on("end", done);
process.stdin.on("close", done);
process.stdin.on("error", done);
`;

/**
 * The parent's end. `watch(pid)` starts the helper if it is not running and tells it a group; `unwatch(pid)` tells it the
 * group is over; `close()` tells it to leave without killing anything (the app has already ended its commands).
 */
function createWatchdog({ spawn = childProcess.spawn, execPath = process.execPath, env = process.env } = {}) {
  let child = null;
  const send = (line) => { try { if (child && child.stdin && !child.stdin.destroyed) child.stdin.write(line + "\n"); } catch { /* the helper is gone */ } };
  function start() {
    if (child) return;
    try {
      child = spawn(execPath, ["-e", WATCHDOG_SRC], {
        stdio: ["pipe", "ignore", "ignore"], detached: true, windowsHide: true,
        env: { ELECTRON_RUN_AS_NODE: "1", PATH: env.PATH || "", SystemRoot: env.SystemRoot || "" },
      });
      const mine = child;
      mine.on("exit", () => { if (child === mine) child = null; });
      mine.on("error", () => { if (child === mine) child = null; });
      if (mine.stdin) mine.stdin.on("error", () => { /* broken pipe: the helper is gone */ });
      mine.unref();
      if (mine.stdin && typeof mine.stdin.unref === "function") mine.stdin.unref();
    } catch { child = null; }
  }
  return {
    watch(pid) { if (!Number.isInteger(pid) || pid <= 0) return; start(); send("add " + pid); },
    unwatch(pid) { if (child && Number.isInteger(pid)) send("del " + pid); },
    close() {
      const c = child;
      child = null;
      if (!c) return;
      try { if (c.stdin && !c.stdin.destroyed) { c.stdin.write("exit\n"); c.stdin.end(); } } catch { /* gone */ }
    },
    get running() { return !!child; },
  };
}

module.exports = { createWatchdog, WATCHDOG_SRC };
