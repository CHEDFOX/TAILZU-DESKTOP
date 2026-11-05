// This computer, offered to Xode while xode is open: the desktop app's runner (src/runner/index.js), run headless in this process,
// so the server's router can place this folder's job here. The runner's own rules stay as they are (guard.js, the audit log, the
// workspaces it fetches into, never this folder); this only hands it what Electron would:
//
//   api        the server, as this terminal's sign-in (the device token reaches /v1/code/runner/*, /v1/code/projects, /v1/code/jobs)
//   state      ~/.config/xode/runner/state.json (state.js), per server and project; userData under the cache folder
//   power      a stand-in for Electron's powerMonitor (power.js); notify and onChange: dim lines in the chat (statusLine.js)
//   the name   "<hostname> (terminal)", and this folder's project only (onlyProject)
//
// stop() shuts it down: at the end of the chat or the one-shot, on an error, and on SIGTERM / SIGHUP.

"use strict";

const os = require("os");
const path = require("path");
const { cacheDir } = require("../config");
const { redact } = require("../api/redact");
const { runnerState } = require("./state");
const { createPowerMonitor } = require("./power");
const { createStatusLine } = require("./statusLine");
const { loadCreateRunner } = require("./load");

/** Is this computer to be offered? --no-runner or XODE_RUNNER=0 says no. */
function wanted(args = {}, env = process.env) {
  return !args.noRunner && String(env.XODE_RUNNER || "").trim() !== "0";
}

/** fetch(path, init) to the server with the device token, the way the runner's api.fetch is used: it resolves a Response. */
function authorizedFetch(server, token, { fetchImpl = globalThis.fetch, version = "", timeoutMs = 60_000 } = {}) {
  return (p, init = {}) => {
    const headers = { ...(init.headers || {}), Authorization: `Bearer ${token}`, "User-Agent": `xode/${version} (${process.platform})` };
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal && typeof AbortSignal.any === "function" ? AbortSignal.any([init.signal, timeout]) : init.signal || timeout;
    return fetchImpl(server + p, { ...init, headers, signal });
  };
}

/** The name the server lists this computer under. */
function terminalName(hostname = os.hostname()) {
  const h = String(hostname || "").replace(/\.local$/i, "").trim() || "This computer";
  return `${h.slice(0, 66)} (terminal)`;
}

/**
 * Starts the runner for `project` ({ id, name }). Resolves { runner, stop() }, or null when this copy of xode has no runner.
 * o: { server, token, project, out, env, version, createRunner (tests), hostname, platform, holdMs, proc }
 */
function startComputer(o) {
  const env = o.env || process.env;
  const proc = o.proc || process;
  const createRunner = o.createRunner || loadCreateRunner();
  if (!createRunner) { o.out.note("This copy of xode can't offer this computer to Xode (its runner is missing)."); return null; }
  const kept = runnerState(o.server, o.project.id, env);
  // The terminal's switch is --no-runner: started, it is on.
  kept.state.enabled = true;
  kept.state.defaultOnV1 = true;
  let runner = null;
  const line = createStatusLine({ out: o.out, status: () => runner.status(), projectName: o.project.name, holdMs: o.holdMs });
  runner = createRunner({
    userData: path.join(cacheDir(env, o.platform), "runner"),
    version: `xode/${o.version || ""}`,
    platform: o.platform || process.platform,
    hostname: terminalName(o.hostname),
    state: kept.state,
    saveState: () => { try { kept.save(); } catch (err) { o.out.note(`Couldn't keep the runner's state: ${redact(err.message)}`); } },
    api: { fetch: authorizedFetch(o.server, o.token, { version: o.version }), signedIn: () => true },
    secrets: () => [o.token],
    notify: (text) => o.out.note(redact(text)),
    config: {},
    powerMonitor: createPowerMonitor(),
    onlyProject: o.project.id,
    onChange: () => line.update(),
    log: env.XODE_DEBUG_RUNNER ? (l) => proc.stderr && proc.stderr.write(`[runner] ${redact(l)}\n`) : () => {},
  });
  kept.save();

  let stopped = false;
  const onSignal = (sig) => {
    stop();
    proc.exit(sig === "SIGTERM" ? 143 : 129);
  };
  const signals = ["SIGTERM", "SIGHUP"];
  for (const s of signals) proc.on(s, onSignal);
  function stop() {
    if (stopped) return;
    stopped = true;
    line.stop();
    for (const s of signals) proc.removeListener(s, onSignal);
    try { runner.shutdown(); } catch { /* leaving anyway */ }
  }

  runner.installProcessHooks(proc);
  runner.start();
  return { runner, stop, get stopped() { return stopped; } };
}

module.exports = { startComputer, wanted, authorizedFetch, terminalName };
