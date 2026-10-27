// "Run in a container": each command in a throwaway Docker container with the workspace mounted.
//
// The one setting that gives Tailzu Code a wall. A command then sees the container's files, not this computer's: not the
// person's home folder, not their other projects, not their programs. The workspace is mounted at /workspace and is the
// only part of this computer a command can change. The container is thrown away (`--rm`) when the command ends.
//
// If the person turns this on and Docker is not there, nothing runs: it fails closed, it does not quietly fall back to
// running on the computer itself.

"use strict";

const childProcess = require("child_process");

const DEFAULT_IMAGE = "node:22-bookworm";

/** Is there a Docker that answers? { installed, running, version, reason }. */
function dockerStatus({ execFile = childProcess.execFile, env = process.env, timeoutMs = 7000 } = {}) {
  return new Promise((resolve) => {
    try {
      execFile("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: timeoutMs, windowsHide: true, env }, (err, stdout, stderr) => {
        if (!err) { resolve({ installed: true, running: true, version: String(stdout || "").trim().slice(0, 40), reason: "" }); return; }
        if (err.code === "ENOENT") { resolve({ installed: false, running: false, version: "", reason: "Docker is not installed on this computer." }); return; }
        resolve({ installed: true, running: false, version: "", reason: /permission denied/i.test(String(stderr)) ? "This account is not allowed to use Docker." : "Docker is installed but not running. Start it, then try again." });
      });
    } catch {
      resolve({ installed: false, running: false, version: "", reason: "Docker is not installed on this computer." });
    }
  });
}

/** What the docker program itself needs from the environment (not what the container gets: that is --env below). */
function dockerClientEnv(real, loginPath) {
  const out = { PATH: loginPath || real.PATH || "" };
  for (const k of ["HOME", "USERPROFILE", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY", "SystemRoot", "SYSTEMROOT", "APPDATA", "LOCALAPPDATA", "XDG_RUNTIME_DIR", "TMPDIR", "TEMP", "TMP"]) {
    if (typeof real[k] === "string" && real[k]) out[k] = real[k];
  }
  return out;
}

/**
 * The arguments of `docker run` for one command.
 *   image, name       the image, and the container's name (so it can be killed)
 *   workspace         the folder on this computer, mounted at /workspace
 *   cache             a folder on this computer, mounted at /cache: the tool caches, kept from job to job
 *   command           the shell line, run with `bash -c`
 *   env               extra variables for the container (PORT, HOST, ... for a dev server); never this app's
 *   ports             host ports published on 127.0.0.1 only (a dev server)
 *   uid, gid          who the command runs as (the person, so the workspace's files stay theirs); none on Windows
 * Nothing is inherited from this app's environment: the container gets exactly what is listed here.
 */
function dockerRunArgs({ image = DEFAULT_IMAGE, name, workspace, cache, command, env = {}, ports = [], uid, gid, lang = "C.UTF-8" }) {
  const args = ["run", "--rm", "--init", "--name", name, "--workdir", "/workspace",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "4096",
    "-v", workspace + ":/workspace"];
  if (cache) args.push("-v", cache + ":/cache");
  if (Number.isInteger(uid) && Number.isInteger(gid)) args.push("--user", uid + ":" + gid);
  for (const p of ports) if (Number.isInteger(p) && p > 0 && p < 65536) args.push("-p", "127.0.0.1:" + p + ":" + p);
  const full = {
    HOME: "/cache/home", LANG: lang, TMPDIR: "/tmp", npm_config_cache: "/cache/npm", PIP_CACHE_DIR: "/cache/pip", CARGO_HOME: "/cache/cargo",
    ...env,
  };
  for (const [k, v] of Object.entries(full)) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === "string") args.push("--env", k + "=" + v);
  args.push(image, "bash", "-c", command);
  return args;
}

module.exports = { dockerStatus, dockerRunArgs, dockerClientEnv, DEFAULT_IMAGE };
