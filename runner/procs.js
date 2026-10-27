// Every process Tailzu Code starts on this computer, so none is ever left behind.
//
// A command (and a dev server, and a container) is started in a process group of its own. This keeps the list of those
// groups and ends them: one by one (a timeout, a cancel, the end of a session, Stop), all together, or synchronously
// when the app is quitting or crashing - and, through the watchdog, even when the app is killed outright.
//
// On Windows there are no process groups: a tree is ended with `taskkill /T /F`.

"use strict";

const childProcess = require("child_process");

/** The registry. `sys` is for tests: { kill(pid, sig), spawnSync, platform }. */
function createProcs({ platform = process.platform, kill = process.kill.bind(process), spawnSync = childProcess.spawnSync, spawn = childProcess.spawn, watchdog = null } = {}) {
  const win = platform === "win32";
  /** pid -> { child, label, container } */
  const live = new Map();

  function signalGroup(pid, sig, child) {
    if (win) {
      try { spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5000 }); } catch { /* gone */ }
      return;
    }
    try { kill(-pid, sig); } catch { try { if (child) child.kill(sig); else kill(pid, sig); } catch { /* already gone */ } }
  }
  function killContainer(name, sync) {
    if (!name) return;
    try {
      if (sync) spawnSync("docker", ["kill", name], { windowsHide: true, timeout: 8000, stdio: "ignore" });
      else spawn("docker", ["kill", name], { windowsHide: true, stdio: "ignore", detached: true }).on("error", () => {}).unref();
    } catch { /* no docker, or the container is gone */ }
  }

  return {
    /** Remembers a started child (a group leader). `container` is the name of the container it runs, if any. */
    track(child, label, container) {
      if (!child || !Number.isInteger(child.pid)) return null;
      live.set(child.pid, { child, label: label || "", container: container || "" });
      if (watchdog) watchdog.watch(child.pid);
      return child.pid;
    },
    /** Forgets a child that is over, but only when nothing is left in its group (a background process keeps it). */
    settle(child) {
      if (!child || !Number.isInteger(child.pid)) return;
      let alive = false;
      if (!win) { try { kill(-child.pid, 0); alive = true; } catch { alive = false; } }
      if (!alive) { live.delete(child.pid); if (watchdog) watchdog.unwatch(child.pid); }
    },
    /** Ends one child's whole group: polite first (`sig`), or at once. */
    kill(child, sig = "SIGKILL") {
      if (!child || !Number.isInteger(child.pid)) return;
      const e = live.get(child.pid);
      if (e && e.container) killContainer(e.container, false);
      signalGroup(child.pid, sig, child);
    },
    /** Ends one child's group with SIGTERM, then SIGKILL after `graceMs`. */
    terminate(child, graceMs = 2000) {
      if (!child || !Number.isInteger(child.pid)) return;
      this.kill(child, "SIGTERM");
      const t = setTimeout(() => { this.kill(child, "SIGKILL"); this.settle(child); }, graceMs);
      if (t.unref) t.unref();
      child.once("exit", () => clearTimeout(t));
    },
    /** Ends everything that is running. */
    killAll(sig = "SIGKILL") {
      for (const [pid, e] of live) { if (e.container) killContainer(e.container, false); signalGroup(pid, sig, e.child); }
      live.clear();
    },
    /** The same, finished before it returns (a process that is exiting cannot wait). */
    killAllSync() {
      for (const [pid, e] of live) { if (e.container) killContainer(e.container, true); signalGroup(pid, "SIGKILL", e.child); }
      live.clear();
      if (watchdog) watchdog.close();
    },
    /** Tells the watchdog it may leave, once nothing is running. */
    release() { if (!live.size && watchdog) watchdog.close(); },
    get size() { return live.size; },
    pids() { return [...live.keys()]; },
  };
}

module.exports = { createProcs };
