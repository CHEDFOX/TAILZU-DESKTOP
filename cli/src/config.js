// Where the server is and where xode keeps its files.

"use strict";

const os = require("os");
const path = require("path");

const DEFAULT_SERVER = "https://api.x0bot.com";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** The server's address, from XODE_SERVER or the default, with no trailing slash. Throws for one that isn't safe to send a sign-in to. */
function serverUrl(env = process.env) {
  const raw = String(env.XODE_SERVER || DEFAULT_SERVER).trim().replace(/\/+$/, "");
  let u;
  try { u = new URL(raw); } catch { throw new Error("XODE_SERVER is not a web address."); }
  // A sign-in sent in the clear could be read on the way; plain http is only for a server on this computer.
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) {
    throw new Error("XODE_SERVER must start with https:// (http:// only works for this computer).");
  }
  return raw;
}

/** The server's host and port, the name a sign-in is kept under. */
function hostOf(server) {
  return new URL(server).host;
}

/** ~/.config/xode, or $XDG_CONFIG_HOME/xode. */
function configDir(env = process.env) {
  const base = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(os.homedir(), ".config");
  return path.join(base, "xode");
}

/** Where xode keeps what can be made again (the runner's workspaces): $XDG_CACHE_HOME/xode, else the platform's cache folder. */
function cacheDir(env = process.env, platform = process.platform) {
  if (env.XDG_CACHE_HOME && path.isAbsolute(env.XDG_CACHE_HOME)) return path.join(env.XDG_CACHE_HOME, "xode");
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "xode");
  if (platform === "win32" && env.LOCALAPPDATA && path.isAbsolute(env.LOCALAPPDATA)) return path.join(env.LOCALAPPDATA, "xode", "Cache");
  return path.join(os.homedir(), ".cache", "xode");
}

/** How often to look again while following a job, in milliseconds (XODE_POLL_MS is for tests and demos). */
function pollMs(env = process.env) {
  const n = Number(env.XODE_POLL_MS);
  return Number.isFinite(n) && n >= 10 ? n : 1500;
}

module.exports = { serverUrl, hostOf, configDir, cacheDir, pollMs, DEFAULT_SERVER };
