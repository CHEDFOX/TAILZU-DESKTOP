// IN-PLACE UPDATES: fetch the published build, check it, put it where this
// one is, and restart on it. No browser, no installer to click through.
//
// electron-updater would do this on Windows and Linux, but on a Mac it goes
// through Squirrel, which refuses an app with no Developer ID signature — and
// this one has none. So the same small job is done here, the same way on all
// three:
//
//   1. download the installer the server named, from tailzu.space only;
//   2. check its SHA-512 against the one the server recorded when the build
//      was published (deploy/receive-download.sh in the backend);
//   3. put it in place of the running build:
//        Windows  the NSIS installer, run silently over this install. It is
//                 told it is an update (--updated), so it keeps app data and
//                 the session, and it starts the new build when done
//                 (--force-run).
//        macOS    the .app out of the .dmg, copied beside this one, and
//                 swapped in by a small script once this process has exited.
//        Linux    the AppImage, renamed over this one, started once this
//                 process has exited.
//
// A copy that cannot replace itself — a Mac app run from the disk image, an
// Applications folder this user cannot write to, a Linux build that is not
// an AppImage — says so, and the window falls back to the download link.

const { app, net } = require("electron");
const { spawn, execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const HOSTS = new Set(["tailzu.space", "www.tailzu.space"]);
const FILES = { win32: "Tailzu-Setup.exe", darwin: "Tailzu.dmg", linux: "Tailzu.AppImage" };
// receive-download.sh refuses anything smaller; so does this.
const MIN_BYTES = 5_000_000;
// A download that stops sending for this long is given up on.
const STALL_MS = 45_000;

const writable = (p) => { try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; } };

/** Where this build lives and how it is replaced, or null when it cannot be. */
function target() {
  if (!app.isPackaged) return null;
  if (process.platform === "win32") return { kind: "nsis" };
  if (process.platform === "darwin") {
    // …/Tailzu.app/Contents/MacOS/Tailzu → …/Tailzu.app
    const bundle = path.resolve(process.execPath, "..", "..", "..");
    if (!bundle.endsWith(".app") || bundle.startsWith("/Volumes/")) return null;
    if (!writable(bundle) || !writable(path.dirname(bundle))) return null;
    return { kind: "app", bundle };
  }
  if (process.platform === "linux") {
    const file = process.env.APPIMAGE;
    if (!file || !fs.existsSync(file) || !writable(path.dirname(file))) return null;
    return { kind: "appimage", file };
  }
  return null;
}

/** Whether this copy can install its own update — reported to the server. */
function canSelfUpdate() {
  return !!target();
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/** Stream `url` to `file`, hashing as it goes. */
function download(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha512");
    let got = 0, total = 0, shown = -1, out = null, stall = null, done = false;
    const fail = (err) => {
      if (done) return;
      done = true; clearTimeout(stall);
      try { req.abort(); } catch { /* already over */ }
      if (out) out.destroy();
      reject(err);
    };
    const alive = () => { clearTimeout(stall); stall = setTimeout(() => fail(new Error("download stalled")), STALL_MS); };
    const req = net.request({ url, redirect: "follow", cache: "no-cache" });
    req.on("response", (res) => {
      if (res.statusCode !== 200) return fail(new Error("download status " + res.statusCode));
      const len = res.headers["content-length"];
      total = Number(Array.isArray(len) ? len[0] : len) || 0;
      out = fs.createWriteStream(file);
      out.on("error", fail);
      alive();
      res.on("data", (chunk) => {
        got += chunk.length;
        hash.update(chunk);
        out.write(chunk);
        alive();
        const pct = total ? Math.min(99, Math.floor((got / total) * 100)) : 0;
        if (pct !== shown) { shown = pct; onProgress(pct); }
      });
      res.on("end", () => {
        if (done) return;
        clearTimeout(stall);
        out.end(() => { done = true; resolve({ bytes: got, sha512: hash.digest("hex") }); });
      });
      res.on("error", fail);
    });
    req.on("error", fail);
    alive();
    req.end();
  });
}

// Waits for the old process to be gone, swaps the bundles (putting the old one
// back if the new one cannot be moved in), and opens whichever is there.
const SWAP_MAC = `#!/bin/sh
i=0
while kill -0 "$1" 2>/dev/null && [ "$i" -lt 150 ]; do sleep 0.1; i=$((i+1)); done
old="$2.old-$$"
if mv "$2" "$old"; then
  if mv "$3" "$2"; then rm -rf "$old"; else mv "$old" "$2"; fi
fi
rm -rf "$3"
open "$2"
`;
// The file is already replaced; this only waits for the old process to exit,
// so the new one is not turned away by the single-instance lock.
const RELAUNCH = `#!/bin/sh
i=0
while kill -0 "$1" 2>/dev/null && [ "$i" -lt 150 ]; do sleep 0.1; i=$((i+1)); done
exec "$2"
`;

function detached(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", ...(env ? { env } : {}) });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

/** Put the downloaded build in place. Resolves once the swap is under way;
 *  the caller then quits so it can finish. */
async function install(t, file, dir) {
  if (t.kind === "nsis") {
    await detached(file, ["--updated", "/S", "--force-run"]);
    return;
  }
  if (t.kind === "app") {
    const mnt = path.join(dir, "mnt");
    fs.mkdirSync(mnt, { recursive: true });
    const staged = path.join(path.dirname(t.bundle), "." + path.basename(t.bundle, ".app") + "-update.app");
    await run("hdiutil", ["attach", file, "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mnt]);
    try {
      const name = fs.readdirSync(mnt).find((n) => n.endsWith(".app"));
      if (!name) throw new Error("no app in the disk image");
      fs.rmSync(staged, { recursive: true, force: true });
      await run("ditto", [path.join(mnt, name), staged]);
    } finally {
      await run("hdiutil", ["detach", mnt, "-force"]).catch(() => {});
    }
    // Written by this process, not a browser, so it should carry none; if it
    // does, macOS would stop the new build at launch to ask about it.
    await run("xattr", ["-dr", "com.apple.quarantine", staged]).catch(() => {});
    const script = path.join(dir, "swap.sh");
    fs.writeFileSync(script, SWAP_MAC, { mode: 0o755 });
    await detached("/bin/sh", [script, String(process.pid), t.bundle, staged]);
    return;
  }
  if (t.kind === "appimage") {
    // Beside the old file, so the rename is on one filesystem and atomic. The
    // running build keeps its own copy open; it is only the name that moves.
    const staged = path.join(path.dirname(t.file), "." + path.basename(t.file) + ".update");
    fs.copyFileSync(file, staged);
    fs.chmodSync(staged, 0o755);
    fs.renameSync(staged, t.file);
    const script = path.join(dir, "relaunch.sh");
    fs.writeFileSync(script, RELAUNCH, { mode: 0o755 });
    // The AppImage runtime sets these for the build it runs; the new one sets
    // its own.
    const env = { ...process.env };
    for (const k of ["APPDIR", "APPIMAGE", "ARGV0", "OWD"]) delete env[k];
    await detached("/bin/sh", [script, String(process.pid), t.file], env);
  }
}

let busy = false;

/**
 * Download, check and install `{ url, version, sha512 }`. `send` gets
 * `{ phase, pct }` as it goes. Resolves `{ ok: true }` when the new build is
 * being put in place (the caller quits), or `{ ok: false, reason }`:
 * "unsupported" (use the download link), "busy", "invalid" or "failed".
 */
async function update(u, send) {
  if (busy) return { ok: false, reason: "busy" };
  const t = target();
  if (!t) return { ok: false, reason: "unsupported" };
  const name = FILES[process.platform];
  const sha512 = String((u && u.sha512) || "").toLowerCase();
  const version = String((u && u.version) || "");
  let url;
  try { url = new URL(String((u && u.url) || "")); } catch { return { ok: false, reason: "invalid" }; }
  if (url.protocol !== "https:" || !HOSTS.has(url.hostname) || path.posix.basename(url.pathname) !== name ||
      !/^[a-f0-9]{128}$/.test(sha512) || !/^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(version)) {
    return { ok: false, reason: "invalid" };
  }
  busy = true;
  const dir = path.join(app.getPath("temp"), "tailzu-update-" + version);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    send({ phase: "downloading", pct: 0 });
    const got = await download(url.toString(), file, (pct) => send({ phase: "downloading", pct }));
    if (got.bytes < MIN_BYTES) throw new Error("download too small: " + got.bytes);
    if (got.sha512 !== sha512) throw new Error("checksum does not match the published build");
    send({ phase: "installing", pct: 100 });
    await install(t, file, dir);
    return { ok: true };
  } catch (err) {
    console.warn("[update] " + ((err && err.message) || err));
    busy = false;
    return { ok: false, reason: "failed" };
  }
}

module.exports = { update, canSelfUpdate };
