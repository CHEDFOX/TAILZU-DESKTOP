// Running the commands of a job on this computer.
//
// The behaviour is the reference's (runCommands and runOne in the backend's runScript.ts, the GitHub runner), in the
// app's terms:
//
//   - each command is run by a shell in the workspace, in a process group of its own, so a timeout, a cancel, Stop or the
//     end of a session can end all of it;
//   - each gets the time the whole step has left, not the full timeoutSec again; the first that fails stops the rest;
//   - a timeout is exit code 124, a cancel 130, a command that could not start 127;
//   - a command that leaves a process running in the background does not hold the step up: the step goes on when the shell
//     has exited and its output has been read (a short grace, then the pipes are let go);
//   - the output goes to `onOutput` as it comes; this keeps only a tail of it.
//
// Not the reference: the shell is `bash -c`, not `bash -lc`. The login shell would read the person's profile files from
// the private HOME (there are none) and on some systems reset PATH; the PATH a command gets is the person's own login PATH,
// worked out once (env.js). Windows uses bash when the person has it (Git for Windows) and cmd.exe when not.

"use strict";

const childProcess = require("child_process");
const nodeFs = require("fs");
const crypto = require("crypto");
const { dockerRunArgs } = require("./docker.js");
const { checkCommand } = require("./guard.js");

const HOLD_CHARS = 256 * 1024;
const GRACE_MS = 1500;

/** The shell for the host: { file, args(command), verbatim }. */
function hostShell(platform, fs, pathEnv) {
  if (platform === "win32") {
    const dirs = String(pathEnv || "").split(";").filter(Boolean);
    for (const d of dirs) {
      const p = d.replace(/[\\/]+$/, "") + "\\bash.exe";
      if (/system32/i.test(d)) continue;   // WSL's launcher, not a shell for this checkout
      try { if (fs.existsSync(p)) return { file: p, args: (c) => ["-c", c], verbatim: false }; } catch { /* next */ }
    }
    return { file: process.env.ComSpec || "cmd.exe", args: (c) => ["/d", "/s", "/c", c], verbatim: true };
  }
  try { if (fs.existsSync("/bin/bash")) return { file: "/bin/bash", args: (c) => ["-c", c], verbatim: false }; } catch { /* next */ }
  return { file: "bash", args: (c) => ["-c", c], verbatim: false };
}

/**
 * How to start one command: on the host, or in a container. Returns spawnCommand(command, { cwd, env, extraEnv, ports }) ->
 * { child, container }.
 *   container   null, or { image, name?(), workspace, cache, clientEnv, uid, gid }
 */
function createSpawner({ platform = process.platform, fs = nodeFs, spawn = childProcess.spawn, container = null, pathEnv = process.env.PATH } = {}) {
  const shell = container ? null : hostShell(platform, fs, pathEnv);
  return function spawnCommand(command, opts) {
    if (container) {
      const name = "tailzu-" + crypto.randomBytes(5).toString("hex");
      const args = dockerRunArgs({
        image: container.image, name, workspace: container.workspace, cache: container.cache, command,
        env: opts.extraEnv || {}, ports: opts.ports || [], uid: container.uid, gid: container.gid, lang: container.lang,
      });
      const child = spawn("docker", args, { env: container.clientEnv, stdio: ["ignore", "pipe", "pipe"], detached: platform !== "win32", windowsHide: true });
      return { child, container: name };
    }
    const child = spawn(shell.file, shell.args(command), {
      cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"], detached: platform !== "win32", windowsHide: true,
      ...(shell.verbatim ? { windowsVerbatimArguments: true } : {}),
    });
    return { child, container: "" };
  };
}

/**
 * One command, killed (its whole group) if it runs past `ms`. Resolves { code, timedOut } when the command has exited and its
 * output has been read, or a moment after it exited if something it left running still holds the pipes open.
 *   o: { cwd, env, onOutput(chunk), signal (AbortSignal), procs, spawnCommand, graceMs }
 */
function runOne(command, ms, o) {
  return new Promise((resolve) => {
    let started;
    try { started = o.spawnCommand(command, { cwd: o.cwd, env: o.env }); } catch (err) {
      o.onOutput("[X0 Bot: could not start the command: " + String((err && err.message) || err).slice(0, 200) + "]\n");
      resolve({ code: 127, timedOut: false });
      return;
    }
    const { child } = started;
    o.procs.track(child, command.slice(0, 80), started.container);
    let timedOut = false;
    let gone = null;
    let finished = false;
    let timer = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (o.signal) o.signal.removeEventListener("abort", kill);
      try { child.stdout.destroy(); child.stderr.destroy(); } catch { /* closed */ }
      o.procs.settle(child);
      const g = gone || { code: 1, signal: null };
      resolve({ code: timedOut ? 124 : g.code === null ? (g.signal ? 128 : 1) : g.code, timedOut });
    };
    function kill() { o.procs.kill(child, "SIGKILL"); }
    const take = (stream) => {
      if (!stream) return;
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => { try { o.onOutput(chunk); } catch { /* the output sink must not stop the command */ } });
      stream.on("error", () => {});
    };
    take(child.stdout);
    take(child.stderr);
    timer = setTimeout(() => { timedOut = true; kill(); }, Math.max(1, ms));
    if (o.signal) { if (o.signal.aborted) kill(); else o.signal.addEventListener("abort", kill, { once: true }); }
    child.on("error", (err) => {
      gone = { code: 127, signal: null };
      try { o.onOutput("[X0 Bot: could not start the command: " + String((err && err.message) || err).slice(0, 200) + "]\n"); } catch { /* sink */ }
      finish();
    });
    child.on("exit", (code, signal) => { gone = { code, signal }; const t = setTimeout(finish, o.graceMs === undefined ? GRACE_MS : o.graceMs); if (t.unref) t.unref(); });
    child.on("close", finish);
  });
}

/**
 * Runs the commands in order, stopping at the first that fails. Resolves { exitCode, output, ran, timedOut, cancelled } with
 * the last part of what was printed (before redaction).
 *   o: { cwd, env, echo(chunk), signal, procs, spawnCommand, now, onStart({command, index}), onEnd({command, index, exitCode, ms, timedOut, cancelled}) }
 */
async function runCommands(commands, timeoutSec, o) {
  const now = o.now || Date.now;
  const deadline = now() + timeoutSec * 1000;
  let held = "";
  const add = (s) => {
    held += s;
    if (held.length > HOLD_CHARS * 2) held = held.slice(-HOLD_CHARS);
    if (o.echo) o.echo(s);
  };
  let ran = 0;
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];
    const left = deadline - now();
    if (left <= 0) {
      add("\n[X0 Bot: the step ran out of time before: " + command + "]\n");
      return { exitCode: 124, output: held, ran, timedOut: true, cancelled: false };
    }
    add("$ " + command + "\n");
    const t0 = now();
    if (o.onStart) o.onStart({ command, index });
    const r = await runOne(command, left, { cwd: o.cwd, env: o.env, onOutput: add, signal: o.signal, procs: o.procs, spawnCommand: o.spawnCommand, graceMs: o.graceMs });
    ran += 1;
    const cancelled = !!(o.signal && o.signal.aborted);
    let exitCode = r.code;
    if (cancelled) { add("\n[X0 Bot: stopped]\n"); exitCode = 130; }
    else if (r.timedOut) { add("\n[X0 Bot: stopped after " + timeoutSec + " seconds, the time this step had]\n"); exitCode = 124; }
    if (o.onEnd) o.onEnd({ command, index, exitCode, ms: now() - t0, timedOut: r.timedOut && !cancelled, cancelled });
    if (cancelled) return { exitCode: 130, output: held, ran, timedOut: false, cancelled: true };
    if (r.timedOut) return { exitCode: 124, output: held, ran, timedOut: true, cancelled: false };
    if (r.code !== 0) return { exitCode: r.code, output: held, ran, timedOut: false, cancelled: false };
  }
  return { exitCode: 0, output: held, ran, timedOut: false, cancelled: false };
}

/** The first command the guard rails refuse, or null: { index, command, rule, message }. All are read before any is run. */
function firstRefusal(commands, guardOpts, check = checkCommand) {
  for (let index = 0; index < commands.length; index += 1) {
    const r = check(commands[index], guardOpts);
    if (!r.ok) return { index, command: commands[index], rule: r.rule, message: r.message };
  }
  return null;
}

module.exports = { runCommands, runOne, createSpawner, hostShell, firstRefusal, HOLD_CHARS };
