// IN-PLACE UPDATES: fetch the published build, check it, put it where this
// one is, and restart on it. No browser, no installer to click through.
//
// electron-updater would do this on Windows and Linux, but on a Mac it goes
// through Squirrel, which refuses an app with no Developer ID signature — and
// this one has none. So the same small job is done here, the same way on all
// three:
//
//   1. download the installer the server named, from our site only
//      (x0bot.com, or tailzu.space, the address before it);
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
// NEVER BACKWARDS. A build is taken only when its version is greater than the
// running one (newerThan), whoever asks: the version the server names, and on
// a Mac the version written inside the .app itself, which must be the same
// one. An older genuine build at another address cannot be put in as an
// "update". (Windows and Linux are held to the server's word for the version
// inside the file; the SHA-512 is the server's word too: there is no
// publisher signature yet.)
//
// A copy that cannot replace itself — a Mac app run from the disk image, an
// Applications folder this user cannot write to, a Linux build that is not
// an AppImage — says so, and the window falls back to the download link.
//
// THE SAME STEPS, ON THEIR OWN. silentUpdate.js fetches the build in the
// background and puts it in place at a quiet moment (the computer idle and
// nothing of ours running, or the app quitting), with no click at all. It
// uses the pieces below, so there is one way a build gets in, whoever asks:
//
//   netGet    one GET over Electron's net, redirects handed back unfollowed
//             (the caller decides whether the next address is ours);
//   prepare   everything that can take a while and must not happen in the
//             moment of quitting: the .app copied out of the disk image
//             beside this one, the AppImage copied beside this one. Nothing
//             running is touched, so a prepared build can still be dropped
//             (discard) when something starts in the meantime;
//   commit    the quick, last step: the installer started, or the swap
//             script started, or the AppImage renamed over this one. Told
//             whether to start the new build when it is done (an install at
//             a quiet moment does; an install because the person quit does
//             not: they asked for the app to be closed).

const { app, net } = require("electron");
const { spawn, execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
// Which build may be taken and from where: the same rules for the card and
// for the silent updater (updateRules.js).
const { MIN_BYTES, trusted, checkRelease } = require("./updateRules.js");

// A download that stops sending for this long is given up on.
const STALL_MS = 45_000;

const writable = (p) => { try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; } };

/** Dotted versions as numbers: is `candidate` strictly greater than `current`? A part that is not a number counts as 0. */
function newerThan(candidate, current) {
  const a = String(candidate || "").split("."), b = String(current || "").split(".");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = parseInt(a[i], 10) || 0, y = parseInt(b[i], 10) || 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** Where this build lives and how it is replaced, or null when it cannot be. */
function target() {
  if (!app.isPackaged) return null;
  // A Microsoft Store install is updated by the Store, and its folder cannot
  // be written to. Replacing it with the website's installer would leave two
  // copies of Tailzu on the machine.
  if (process.windowsStore) return null;
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
    // A redirect is followed only to our own server. The address was checked
    // before asking, and "follow" would have taken the file from wherever the
    // answer pointed — the checksum is then the only thing between this and
    // running someone else's build.
    const req = net.request({ url, redirect: "manual", cache: "no-cache" });
    req.on("redirect", (_status, _method, to) => {
      let ok = false;
      try { ok = trusted(new URL(to)); } catch { /* not an address */ }
      if (ok) req.followRedirect(); else fail(new Error("redirected off our site"));
    });
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
// back if the new one cannot be moved in), and opens whichever is there — when
// $4 says to: an install because the person quit leaves the app closed.
const SWAP_MAC = `#!/bin/sh
i=0
while kill -0 "$1" 2>/dev/null && [ "$i" -lt 150 ]; do sleep 0.1; i=$((i+1)); done
old="$2.old-$$"
if mv "$2" "$old"; then
  if mv "$3" "$2"; then rm -rf "$old"; else mv "$old" "$2"; fi
fi
rm -rf "$3"
[ "$4" = "1" ] && open "$2"
exit 0
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

/**
 * The slow half of putting `file` (a verified download) in place, done while
 * this build still runs and touching nothing of it. Resolves a handle for
 * commit() or discard(), or rejects (the build could not be got ready: the
 * current one is untouched). `t` defaults to this copy's own target().
 */
async function prepare(file, t = target(), version = "") {
  if (!t) throw new Error("this copy cannot replace itself");
  // A NEW DIRECTORY, ONLY OURS, for the disk image's mount point and the
  // scripts. A fixed name in a shared /tmp could be made first by another
  // user. mkdtemp makes it fresh and private (0700).
  const dir = fs.mkdtempSync(path.join(app.getPath("temp"), "tailzu-update-"));
  const h = { t, file, dir, staged: null };
  try {
    if (t.kind === "app") {
      const mnt = path.join(dir, "mnt");
      fs.mkdirSync(mnt, { recursive: true });
      const staged = path.join(path.dirname(t.bundle), "." + path.basename(t.bundle, ".app") + "-update.app");
      h.staged = staged;
      await run("hdiutil", ["attach", file, "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mnt]);
      try {
        const name = fs.readdirSync(mnt).find((n) => n.endsWith(".app"));
        if (!name) throw new Error("no app in the disk image");
        fs.rmSync(staged, { recursive: true, force: true });
        await run("ditto", [path.join(mnt, name), staged]);
      } finally {
        await run("hdiutil", ["detach", mnt, "-force"]).catch(() => {});
      }
      // The version the build says it is, from its own Info.plist: the one the server named, or nothing is swapped.
      if (version) {
        const inside = String(await run("plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", path.join(staged, "Contents", "Info.plist")]).catch(() => "")).trim();
        if (inside !== version || !newerThan(inside, app.getVersion())) throw new Error("the disk image holds version " + (inside || "?") + ", not a newer " + version);
      }
      // Written by this process, not a browser, so it should carry none; if it
      // does, macOS would stop the new build at launch to ask about it.
      await run("xattr", ["-dr", "com.apple.quarantine", staged]).catch(() => {});
    } else if (t.kind === "appimage") {
      // Beside the old file, so the rename is on one filesystem and atomic. The
      // running build keeps its own copy open; it is only the name that moves.
      const staged = path.join(path.dirname(t.file), "." + path.basename(t.file) + ".update");
      h.staged = staged;
      // Written fresh, never through something already at that name (a link
      // left there would carry the verified build somewhere else).
      fs.rmSync(staged, { force: true });
      fs.copyFileSync(file, staged, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(staged, 0o755);
    }
    // nsis: nothing to get ready. The installer is the build, and it is run
    // from where it was verified.
    return h;
  } catch (err) {
    discard(h);
    throw err;
  }
}

/** A prepared build not used after all: what prepare() left goes. */
function discard(h) {
  if (!h) return;
  if (h.staged) try { fs.rmSync(h.staged, { recursive: true, force: true }); } catch { /* in use */ }
  if (h.dir) try { fs.rmSync(h.dir, { recursive: true, force: true }); } catch { /* in use */ }
}

/**
 * The quick half: start what puts the prepared build in place once this
 * process has gone. Resolves once that is under way; the caller then quits so
 * it can finish. `relaunch` starts the new build when it is done.
 */
async function commit(h, { relaunch = true } = {}) {
  const t = h.t;
  if (t.kind === "nsis") {
    // --updated: an update, so app data and the session stay (build/installer.nsh).
    // /S: silent, no window. --force-run: start the new build when done, only
    // when this install is to come back up.
    await detached(h.file, ["--updated", "/S"].concat(relaunch ? ["--force-run"] : []));
    return;
  }
  if (t.kind === "app") {
    const script = path.join(h.dir, "swap.sh");
    fs.writeFileSync(script, SWAP_MAC, { mode: 0o755 });
    await detached("/bin/sh", [script, String(process.pid), t.bundle, h.staged, relaunch ? "1" : "0"]);
    return;
  }
  if (t.kind === "appimage") {
    fs.renameSync(h.staged, t.file);
    if (!relaunch) return;
    const script = path.join(h.dir, "relaunch.sh");
    fs.writeFileSync(script, RELAUNCH, { mode: 0o755 });
    // The AppImage runtime sets these for the build it runs; the new one sets
    // its own.
    const env = { ...process.env };
    for (const k of ["APPDIR", "APPIMAGE", "ARGV0", "OWD"]) delete env[k];
    await detached("/bin/sh", [script, String(process.pid), t.file], env);
  }
}

/**
 * One GET over Electron's net, for silentUpdate.js. Redirects are NOT
 * followed: the answer comes back as `{ status, location }` and the caller
 * decides whether the next address is ours (the same rule as download()
 * above). Otherwise `{ status, header(name), body, abort }`, where `body` is
 * the response itself, read as an async iterable of Buffers.
 */
function netGet(url, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = net.request({ url, redirect: "manual", cache: "no-cache" });
    for (const [k, v] of Object.entries(headers)) req.setHeader(k, v);
    req.on("redirect", (status, _method, to) => {
      if (settled) return;
      settled = true;
      try { req.abort(); } catch { /* already over */ }
      resolve({ status, location: to, header: () => "", body: null, abort() {} });
    });
    req.on("response", (res) => {
      if (settled) return;
      settled = true;
      const header = (n) => { const v = res.headers[String(n).toLowerCase()]; return String(Array.isArray(v) ? v[0] : v == null ? "" : v); };
      resolve({ status: res.statusCode, header, body: res, abort: () => { try { req.abort(); } catch { /* over */ } } });
    });
    req.on("error", (err) => { if (!settled) { settled = true; reject(err); } });
    req.end();
  });
}

// One install at a time, whoever asks: the card's button, or the silent
// updater (claim / release).
let busy = false;

/**
 * Download, check and install `{ url, version, sha512 }`. `send` gets
 * `{ phase, pct }` as it goes. Resolves `{ ok: true }` when the new build is
 * being put in place (the caller quits), or `{ ok: false, reason }`:
 * "unsupported" (use the download link), "busy", "invalid", "current" (not newer than this build) or "failed".
 */
async function update(u, send) {
  if (busy) return { ok: false, reason: "busy" };
  const t = target();
  if (!t) return { ok: false, reason: "unsupported" };
  const rel = checkRelease(u, process.platform);
  if (!rel) return { ok: false, reason: "invalid" };
  // Never the same build again, never an older one.
  if (!newerThan(rel.version, app.getVersion())) return { ok: false, reason: "current" };
  busy = true;
  // A NEW DIRECTORY, ONLY OURS. A fixed name in a shared /tmp could be made
  // first by another user, who could then swap the file between the checksum
  // and the install. mkdtemp makes it fresh and private (0700).
  let dir = null, h = null;
  try {
    dir = fs.mkdtempSync(path.join(app.getPath("temp"), "tailzu-update-"));
    const file = path.join(dir, rel.name);
    send({ phase: "downloading", pct: 0 });
    const got = await download(rel.url, file, (pct) => send({ phase: "downloading", pct }));
    if (got.bytes < MIN_BYTES) throw new Error("download too small: " + got.bytes);
    if (got.sha512 !== rel.sha512) throw new Error("checksum does not match the published build");
    send({ phase: "installing", pct: 100 });
    h = await prepare(file, t, rel.version);
    await commit(h, { relaunch: true });
    return { ok: true };
  } catch (err) {
    console.warn("[update] " + ((err && err.message) || err));
    // A failed attempt leaves nothing behind; the next one starts clean.
    discard(h);
    if (dir) try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* in use */ }
    busy = false;
    return { ok: false, reason: "failed" };
  }
}

/** The silent updater's own install is starting: the card's button waits
 *  (false when one is already under way). */
function claim() { if (busy) return false; busy = true; return true; }
/** That install did not go ahead: the button works again. */
function release() { busy = false; }

module.exports = { update, canSelfUpdate, newerThan, prepare, commit, discard, netGet, claim, release };
