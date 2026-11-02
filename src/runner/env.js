// The environment a command is given, and the folders it lives in.
//
// A command runs with a SCRUBBED environment: PATH, HOME, LANG and the tool caches (npm, pip, cargo), and what a
// platform cannot start a program without (a temp folder, and on Windows SystemRoot and friends). Nothing else is
// copied from this app's own environment: not a token, not a cloud credential, not a proxy password, not an
// ELECTRON_* or NODE_* setting.
//
// HOME is a PRIVATE folder inside this app's data (`<userData>/runner/home`), not the person's. A command that reads
// `~/.aws/credentials`, `~/.ssh/id_rsa` or `~/.npmrc` finds nothing, and the tool caches live there, kept from one job
// to the next so the second `npm ci` is fast.
//
// PATH is the person's own login PATH, read once from their shell (an app started from the Dock has a bare one), so
// `node`, `python`, `cargo` and `go` are found where they are. It is a list of absolute folders: an empty or relative
// entry (which would run a program out of the repository) is dropped.

"use strict";

const nodePath = require("path");
const nodeOs = require("os");
const nodeFs = require("fs");

/** The names a command can be given. Anything not here is never copied. */
const ALLOWED_NAMES = new Set([
  "PATH", "HOME", "LANG", "TMPDIR", "TEMP", "TMP",
  "npm_config_cache", "PIP_CACHE_DIR", "CARGO_HOME", "RUSTUP_HOME",
  // Windows cannot start a program without these.
  "SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
]);

const PLACES = {
  posix: ["/usr/local/bin", "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"],
  win32: [],
};

/** A PATH string as a list of absolute, distinct folders. */
function cleanPath(value, platform) {
  const sep = platform === "win32" ? ";" : ":";
  const seen = new Set();
  const out = [];
  for (const d of String(value || "").split(sep)) {
    const dir = d.trim().replace(/^"(.*)"$/, "$1");
    if (!dir) continue;
    const abs = platform === "win32" ? nodePath.win32.isAbsolute(dir) : nodePath.posix.isAbsolute(dir);
    if (!abs || seen.has(dir)) continue;
    seen.add(dir);
    out.push(dir);
  }
  return out.join(sep);
}

/**
 * The person's PATH as their shell sets it up, asked once. `execFile(file, args, opts, cb)` is child_process.execFile.
 * Falls back to this app's own PATH plus the usual places when the shell does not answer.
 */
function createLoginPath({ execFile, real, platform = process.platform, timeoutMs = 6000 }) {
  let cached = null;
  const fallback = () => {
    const sep = platform === "win32" ? ";" : ":";
    const base = cleanPath(real.PATH, platform);
    const extra = (PLACES[platform === "win32" ? "win32" : "posix"]).filter((d) => !base.split(sep).includes(d));
    return base + (base && extra.length ? sep : "") + extra.join(sep);
  };
  return {
    /** Resolves to the PATH to give commands. Asks the shell the first time only. */
    async get() {
      if (cached !== null) return cached;
      if (platform === "win32") { cached = fallback(); return cached; }
      const shell = real.SHELL && nodePath.posix.isAbsolute(real.SHELL) ? real.SHELL : "/bin/bash";
      const answer = await new Promise((resolve) => {
        try {
          execFile(shell, ["-ilc", 'printf "__TZ_PATH_START__%s__TZ_PATH_END__" "$PATH"'], {
            timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024,
            env: { ...real, DISABLE_AUTO_UPDATE: "true", ZSH_TMUX_AUTOSTART: "false", TERM: real.TERM || "dumb" },
          }, (err, stdout) => {
            const m = /__TZ_PATH_START__([\s\S]*?)__TZ_PATH_END__/.exec(String(stdout || ""));
            resolve(m ? m[1] : "");
          }).stdin?.end();
        } catch { resolve(""); }
      });
      const fromShell = cleanPath(answer, platform);
      cached = fromShell || fallback();
      return cached;
    },
    forget() { cached = null; },
  };
}

/** The private folders commands live in, under this app's data folder. */
function runnerPaths(userData) {
  const root = nodePath.join(userData, "runner");
  const home = nodePath.join(root, "home");
  return {
    root, home, tmp: nodePath.join(root, "tmp"), workspaces: nodePath.join(userData, "workspaces"),
    audit: nodePath.join(root, "audit"), npmCache: nodePath.join(home, ".npm"), pipCache: nodePath.join(home, ".cache", "pip"), cargoHome: nodePath.join(home, ".cargo"),
    containerCache: nodePath.join(root, "container-cache"),
  };
}

/** The tool caches a container is given (a folder on this computer, mounted at /cache); made only when a container is used. */
function ensureContainerCache(p, fs) {
  const f = fs || nodeFs;
  for (const d of ["home", "npm", "pip", "cargo"]) { try { f.mkdirSync(nodePath.join(p.containerCache, d), { recursive: true, mode: 0o700 }); } catch { /* docker says */ } }
}

/** Makes the private folders (idempotent). */
function ensurePaths(p, fs) {
  const f = fs || nodeFs;
  for (const d of [p.root, p.home, p.tmp, p.workspaces, p.audit]) { try { f.mkdirSync(d, { recursive: true, mode: 0o700 }); } catch { /* the command will say */ } }
}

/**
 * The environment for a command. `real` is the environment of this app (only PATH-like facts are taken from it: LANG,
 * RUSTUP_HOME and, on Windows, the system folders); `loginPath` the person's PATH.
 */
function commandEnv({ real = process.env, paths, loginPath, platform = process.platform, home = nodeOs.homedir() }) {
  const win = platform === "win32";
  const env = {
    PATH: cleanPath(loginPath || real.PATH, platform) || (win ? "" : PLACES.posix.join(":")),
    HOME: paths.home,
    LANG: typeof real.LANG === "string" && /^[A-Za-z0-9_.@-]{1,40}$/.test(real.LANG) ? real.LANG : win || platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8",
    TMPDIR: paths.tmp,
    npm_config_cache: paths.npmCache,
    PIP_CACHE_DIR: paths.pipCache,
    CARGO_HOME: paths.cargoHome,
  };
  // The Rust toolchains live in a folder of their own, apart from the registry credentials of CARGO_HOME. A toolchain is a
  // program, not a secret, so the person's is kept where rustup looks for it.
  const rustup = real.RUSTUP_HOME || nodePath.join(home, ".rustup");
  if (rustup && nodeFs.existsSync(rustup)) env.RUSTUP_HOME = rustup;
  if (win) {
    env.TEMP = paths.tmp; env.TMP = paths.tmp; env.USERPROFILE = paths.home;
    env.APPDATA = nodePath.join(paths.home, "AppData", "Roaming"); env.LOCALAPPDATA = nodePath.join(paths.home, "AppData", "Local");
    for (const k of ["SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "PATHEXT"]) if (real[k]) env[k] = real[k];
  }
  for (const k of Object.keys(env)) if (!ALLOWED_NAMES.has(k) || typeof env[k] !== "string") delete env[k];
  return env;
}

module.exports = { commandEnv, createLoginPath, runnerPaths, ensurePaths, ensureContainerCache, cleanPath, ALLOWED_NAMES };
