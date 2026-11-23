// SILENT UPDATES: the new build comes down in the background, is checked, and
// goes in at a moment that interrupts nothing. Nobody clicks anything.
//
// Until this, a release was a notification ("X0 Bot 0.4.8 is ready. Click to
// update.") and the person had to act on it. Most did not, for weeks: this is
// a tray app, the notice comes while they are doing something else, and an
// update that waits for a click is an update that waits. Everything else in
// the app is the server's and changes the moment it deploys; the build itself
// was the one thing still waiting on a person.
//
// So, when the bootstrap's `desktop.update` names a newer `latest` and this
// copy can replace itself (updater.js canSelfUpdate: never a Microsoft Store
// install, which the Store updates itself; never a Mac app run from the disk
// image or a folder it cannot write; never a Linux build that is not an
// AppImage):
//
//   1. FETCH. The installer the server named, from our own site only, over
//      https, a redirect followed only back to our own site (updateRules.js),
//      into this app's own data folder (updates/<checksum>/), never a shared
//      temp folder. A cut connection picks up where it stopped (a Range
//      request against the part already on disk, which is hashed again first,
//      so the checksum still covers every byte); a failure is tried again
//      later, a minute, then two, then four, up to `maxRetries` times. Not
//      while the computer says it is offline or on battery, unless the update
//      is required.
//   2. CHECK. The SHA-512 of the whole file against the one the server
//      recorded when the build was published. A file that does not match is
//      deleted, never kept, never run. And checked AGAIN right before it is
//      run, because it may have sat on disk for a day.
//   3. WAIT for a quiet moment, and only then put it in:
//        - the app is quitting (the person chose Quit, or logged out of the
//          tray): the build goes in and the app stays closed, as they asked;
//          not while the system itself is shutting down, which could cut an
//          installer off half way;
//        - or the computer has had no keyboard or mouse for `idleMinutes`
//          (15) and nothing of ours is running: no dictation, no Ask, no
//          talk, no note being taken, no call or words typed into the app
//          window (main.js busy()). Then the build goes in and comes straight
//          back up, the tray and the pill where they were, the window open
//          only if it was, and one quiet notice: "Updated to 0.4.8."
//      Never in the middle of anything: idle and busy are asked again after
//      the slow half of the install is ready (a Mac's disk image copied out),
//      just before the quick half that quits.
//   4. A REQUIRED BUILD (`min` above this one) goes in at the first quiet
//      moment, `requiredIdleMinutes` (1) rather than 15, and on battery too.
//      If it still cannot go in after `requiredNagMinutes`, the person is
//      told, once a launch, with a click that does it now.
//
// ANYTHING THAT GOES WRONG LEAVES TODAY'S APP. A download that keeps failing,
// an install that fails to start, a build that did not come up after the
// restart (the next launch still finds the old version): that version is not
// tried silently again, and fallback() hands it back to the notification and
// the window's card, exactly as before. `desktop.update.silent` off is today's
// behaviour, the whole of it.
//
// Nothing here touches Electron. Everything it needs is handed in (the clock,
// the timers, the idle time, what is running, the GET, the install), so the
// whole flow is played in silentUpdate.test.js without a computer to update.

const fsDefault = require("fs");
const path = require("path");
const crypto = require("crypto");
const { MIN_BYTES, trusted, checkRelease, compareVersions } = require("./updateRules.js");

// Bigger than any build has been by an order of magnitude: a server that keeps
// sending is not filling the disk.
const MAX_BYTES = 1_500_000_000;
// The knobs' defaults, for whatever the server does not send.
const DEFAULTS = Object.freeze({
  silent: true,
  idleMinutes: 15,
  requiredIdleMinutes: 1,
  maxRetries: 6,
  retryMs: 60_000,
  retryMaxMs: 3_600_000,
  pollMs: 60_000,
  stallMs: 45_000,
  relaunchWindowMs: 600_000,
  requiredNagMinutes: 60,
});
// A server's number, held to something that cannot spin or stall the app.
const FLOORS = { pollMs: 5_000, retryMs: 1_000, retryMaxMs: 1_000, stallMs: 5_000 };

function settled(raw) {
  const s = Object.assign({}, DEFAULTS);
  for (const [k, v] of Object.entries(raw || {})) {
    if (!(k in DEFAULTS)) continue;
    if (typeof DEFAULTS[k] === "boolean") { if (typeof v === "boolean") s[k] = v; continue; }
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) s[k] = Math.max(FLOORS[k] || 0, v);
  }
  return s;
}

/**
 * o: {
 *   dir                 where staged builds and state.json live (userData/updates)
 *   platform            process.platform
 *   version()           this build's version
 *   canSelfUpdate()     updater.js's answer; isStore() whether this is the Store's copy
 *   get(url, {headers}) one GET, redirects not followed: { status, location } or
 *                       { status, header(name), body (async iterable), abort() }
 *   prepare(file) / commit(handle, {relaunch}) / discard(handle)   updater.js
 *   claim() / release() one install at a time with the window's card (optional)
 *   idleSeconds()       how long since the last key or mouse movement
 *   busy()              "" when nothing of ours is running, else what is (may be a Promise)
 *   constrained()       "" when a download may run now, else why not ("offline", "battery")
 *   windowShown()       whether the app window is up, to bring it back after a restart
 *   settings()          the knobs (DEFAULTS above for what is missing)
 *   quit()              the app quits now (after an install at a quiet moment)
 *   fallback(why)       silent gave up on this version: today's notification
 *   nag(version)        a required build still waiting: tell the person
 *   now, setTimeout, clearTimeout, log, fs, minBytes    for tests
 * }
 */
function createSilentUpdate(o) {
  const fs = o.fs || fsDefault;
  const now = o.now || Date.now;
  const later = o.setTimeout || setTimeout;
  const cancel = o.clearTimeout || clearTimeout;
  const log = (line) => { try { if (o.log) o.log(line); } catch { /* a log is never the failure */ } };
  const minBytes = typeof o.minBytes === "number" ? o.minBytes : MIN_BYTES;
  const dir = o.dir;
  const stateFile = path.join(dir, "state.json");
  const settings = () => settled(o.settings ? o.settings() : {});

  // What survives a restart: the release in hand, whether it is staged, the
  // versions given up on, and the install under way (pending), which is how
  // the next launch knows it was an update and whether it worked.
  let st = load();
  let required = false;          // the release in hand is below `min` (set by offer)
  let failures = 0;              // download attempts that failed, this launch
  let gen = 0;                   // bumped when the release in hand changes: a download for an older one stops
  let downloading = null;
  let retryTimer = null, pollTimer = null;
  let installing = false;
  let stagedAt = 0;              // when it was staged, this launch (for the required notice)
  let nagged = false;
  let launched = null;           // afterLaunch()'s answer, once

  function load() {
    let s = null;
    try { s = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { /* none yet, or unreadable: start clean */ }
    s = s && typeof s === "object" ? s : {};
    // The release is checked again as if the server had just said it: a
    // state file is only ever this app's, but nothing read from disk is taken
    // on trust when it decides what to run.
    const release = s.release ? checkRelease(s.release, o.platform) : null;
    return {
      release,
      staged: release && s.staged && s.staged.sha512 === release.sha512 ? { version: release.version, sha512: release.sha512 } : null,
      gaveUp: s.gaveUp && typeof s.gaveUp === "object" && !Array.isArray(s.gaveUp) ? s.gaveUp : {},
      pending: s.pending && typeof s.pending === "object" ? s.pending : null,
    };
  }
  function save() {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(stateFile + ".tmp", JSON.stringify(st));
      fs.renameSync(stateFile + ".tmp", stateFile);
    } catch (e) { log("state not saved: " + ((e && e.message) || e)); }
  }

  // One folder per build, named by its checksum: a file from another release
  // can never be resumed into this one, and the path is never read from disk.
  const folderFor = (rel) => path.join(dir, rel.sha512.slice(0, 32));
  const fileFor = (rel) => path.join(folderFor(rel), rel.name);
  const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  const sizeOf = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };
  const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* in use: the next tidy */ } };

  /** Everything in the folder but the state and the build in hand goes. */
  function tidy() {
    const keep = new Set(["state.json"]);
    if (st.release) keep.add(path.basename(folderFor(st.release)));
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) if (!keep.has(n)) rm(path.join(dir, n));
  }

  /** Feed a file on disk into `hash`. */
  function hashInto(file, hash) {
    return new Promise((resolve, reject) => {
      const s = fs.createReadStream(file);
      s.on("data", (c) => hash.update(c));
      s.on("end", resolve);
      s.on("error", reject);
    });
  }
  async function hashFile(file) {
    const h = crypto.createHash("sha512");
    await hashInto(file, h);
    return h.digest("hex");
  }

  /** A next() that gives up when nothing comes for `ms`. */
  function inTime(p, ms, res) {
    let t = null;
    const stall = new Promise((_, reject) => {
      t = later(() => { try { res.abort(); } catch { /* over */ } reject(new Error("download stalled")); }, ms);
    });
    return Promise.race([p, stall]).finally(() => cancel(t));
  }

  /**
   * Fetch `rel` into its folder, resuming what an earlier try left, and check
   * it. Resolves the verified file's path; rejects with the file deleted when
   * it does not match, or with the part kept when the connection only broke.
   */
  async function download(rel, my, s) {
    const folder = folderFor(rel);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const file = fileFor(rel), part = file + ".part";
    // Staged by a launch that was closed before it could say so: checked, not fetched again.
    if (exists(file)) {
      if ((await hashFile(file)) === rel.sha512) return file;
      rm(file);
    }
    let offset = sizeOf(part);
    let hash = crypto.createHash("sha512");
    // What came before is hashed again from the disk, so the checksum at the
    // end covers every byte of the file, not only the ones fetched now.
    if (offset > 0) await hashInto(part, hash);
    let url = rel.url, res = null;
    for (let hop = 0; ; hop++) {
      res = await o.get(url, { headers: offset > 0 ? { Range: "bytes=" + offset + "-" } : {} });
      if (!res || !(res.status >= 300 && res.status < 400)) break;
      // A redirect is followed only to our own server (updater.js, the same rule).
      if (hop >= 5) throw new Error("too many redirects");
      let next = null;
      try { next = new URL(String(res.location || ""), url); } catch { /* not an address */ }
      if (!trusted(next)) throw new Error("redirected off our site");
      url = next.toString();
    }
    const range = /^bytes (\d+)-/.exec(String((res && res.header && res.header("content-range")) || ""));
    let append = false;
    if (res && res.status === 206 && offset > 0 && range && Number(range[1]) === offset) append = true;
    else if (!res || res.status !== 200) {
      // 416: what is on disk is not a start of this file. It goes.
      if (res && res.status === 416) rm(part);
      try { if (res && res.abort) res.abort(); } catch { /* over */ }
      throw new Error("download status " + (res ? res.status : "none"));
    }
    if (!append) { offset = 0; hash = crypto.createHash("sha512"); }
    const expect = Number(res.header ? res.header("content-length") : 0) || 0;
    const fh = await fs.promises.open(part, append ? "a" : "w", 0o600);
    let got = 0;
    try {
      const it = res.body[Symbol.asyncIterator]();
      for (;;) {
        const r = await inTime(it.next(), s.stallMs, res);
        if (r.done) break;
        if (my !== gen) { try { res.abort(); } catch { /* over */ } throw new Error("superseded"); }
        const chunk = Buffer.isBuffer(r.value) ? r.value : Buffer.from(r.value);
        for (let at = 0; at < chunk.length;) at += (await fh.write(chunk, at, chunk.length - at)).bytesWritten;
        hash.update(chunk);
        got += chunk.length;
        if (offset + got > MAX_BYTES) { try { res.abort(); } catch { /* over */ } rm(part); throw new Error("download too big"); }
      }
    } finally {
      await fh.close().catch(() => {});
    }
    // Cut short: the part stays, and the next try picks up from it.
    if (expect && got !== expect) throw new Error("download ended early (" + got + " of " + expect + ")");
    const total = offset + got;
    if (total < minBytes) { rm(part); throw new Error("download too small: " + total); }
    if (hash.digest("hex") !== rel.sha512) { rm(part); throw new Error("checksum does not match the published build"); }
    fs.renameSync(part, file);
    return file;
  }

  function giveUp(why) {
    log("gave up on " + why + "; the notice takes over");
    try { if (o.fallback) o.fallback(why); } catch { /* the notice is best effort */ }
  }

  /** Fetch the release in hand, once at a time, with a backoff between tries. */
  async function fetchRelease() {
    cancel(retryTimer); retryTimer = null;
    const rel = st.release;
    if (!rel || st.staged || downloading || installing) return;
    const s = settings();
    if (!s.silent) return;
    // Offline, or on battery (main.js says which): later, and not counted as a
    // failure. A required build does not wait for the charger.
    let why = "";
    try { why = o.constrained ? String(o.constrained() || "") : ""; } catch { why = ""; }
    if (why === "offline" || (why && !required)) {
      log("download waits: " + why);
      retryTimer = later(() => { void fetchRelease(); }, s.pollMs);
      return;
    }
    const my = gen;
    downloading = (async () => {
      try {
        await download(rel, my, s);
        if (my !== gen) return;
        st.staged = { version: rel.version, sha512: rel.sha512 };
        stagedAt = now();
        failures = 0;
        save();
        tidy();
        log("staged " + rel.version);
        schedulePoll();
      } catch (e) {
        if (my !== gen) return;
        failures += 1;
        log("download failed (" + failures + "): " + ((e && e.message) || e));
        if (failures > s.maxRetries) {
          st.gaveUp[rel.version] = "download";
          save();
          giveUp("download");
        } else {
          retryTimer = later(() => { void fetchRelease(); }, Math.min(s.retryMaxMs, s.retryMs * 2 ** (failures - 1)));
        }
      }
    })();
    try { await downloading; } finally {
      downloading = null;
      // The release changed while this one was coming down: fetch the new one.
      if (my !== gen && st.release && !st.staged) void fetchRelease();
    }
  }

  function schedulePoll(ms) {
    if (pollTimer || !st.staged || installing) return;
    pollTimer = later(() => { pollTimer = null; void tick(); }, ms === undefined ? settings().pollMs : ms);
  }

  /** Idle long enough, and nothing of ours running. */
  async function quietNow(needSeconds) {
    let idle = 0;
    try { idle = Number(o.idleSeconds()) || 0; } catch { return false; }
    if (idle < needSeconds) return false;
    let why = "unknown";
    try { why = await o.busy(); } catch { why = "unknown"; }
    return !why;
  }

  /** Once a minute while a build is staged: is now the moment? */
  async function tick() {
    if (!st.staged || installing) return;
    const s = settings();
    if (!s.silent) return;   // switched off: nothing until offer() is told again with it on
    const need = (required ? s.requiredIdleMinutes : s.idleMinutes) * 60;
    if (!(await quietNow(need))) {
      if (required && !nagged && stagedAt && now() - stagedAt >= s.requiredNagMinutes * 60_000) {
        nagged = true;
        try { if (o.nag) o.nag(st.staged.version); } catch { /* best effort */ }
      }
      schedulePoll();
      return;
    }
    const r = await installStaged({ relaunch: true, check: () => quietNow(need) });
    if (r.ok) { try { o.quit(); } catch { /* the installer waits for us all the same */ } return; }
    if (r.reason === "busy") schedulePoll();
  }

  /**
   * Put the staged build in: checked again, the slow half (prepare), `check`
   * asked again, the install recorded as pending, the quick half (commit).
   * `{ ok: true }` means the caller quits now; otherwise `{ ok: false, reason }`:
   * "nothing", "busy" (try later), "invalid" (fetched again) or "failed"
   * (given up on: the notice takes over).
   */
  async function installStaged({ relaunch = true, check = null, reopenWindow } = {}) {
    const rel = st.release;
    if (!rel || !st.staged || installing) return { ok: false, reason: "nothing" };
    if (o.claim && !o.claim()) return { ok: false, reason: "busy" };
    installing = true;
    let ok = false, h = null, refetch = false;
    try {
      const file = fileFor(rel);
      // NEVER A FILE THAT DOES NOT MATCH. It was checked when it came down;
      // it is checked again now, the moment before it runs.
      if (!exists(file) || (await hashFile(file)) !== rel.sha512) {
        log("the staged build no longer matches; fetched again");
        rm(file);
        st.staged = null;
        save();
        refetch = true;
        return { ok: false, reason: "invalid" };
      }
      h = await o.prepare(file);
      if (check && !(await check())) {
        try { o.discard(h); } catch { /* best effort */ }
        h = null;
        return { ok: false, reason: "busy" };
      }
      let shown = false;
      try { shown = reopenWindow === undefined ? !!(o.windowShown && o.windowShown()) : !!reopenWindow; } catch { shown = false; }
      st.pending = { from: o.version(), to: rel.version, at: now(), relaunch: !!relaunch, reopenWindow: !!relaunch && shown };
      save();
      await o.commit(h, { relaunch: !!relaunch });
      ok = true;
      log("installing " + rel.version + (relaunch ? ", then back up" : ", app stays closed"));
      return { ok: true };
    } catch (e) {
      log("install failed: " + ((e && e.message) || e));
      if (h) try { o.discard(h); } catch { /* best effort */ }
      st.pending = null;
      st.gaveUp[rel.version] = "install";
      st.release = null;
      st.staged = null;
      save();
      tidy();
      giveUp("install");
      return { ok: false, reason: "failed" };
    } finally {
      if (!ok) {
        installing = false;
        try { if (o.release) o.release(); } catch { /* best effort */ }
        if (refetch) later(() => { void fetchRelease(); }, 0);
      }
    }
  }

  /**
   * Once, at launch: was the last run ended by an update of ours, and did it
   * work? `{ updated, from, reopenWindow, relaunched }` when this is the new
   * build (relaunched: it was started by the install itself, just now, so the
   * window comes back only if it was up), `{ failed }` when the old build is
   * still here (that version is not tried silently again), or null. Old
   * builds' files are cleared away.
   */
  function afterLaunch() {
    if (launched) return launched.result;
    launched = { result: null };
    const cur = o.version();
    const p = st.pending;
    if (p && p.to) {
      const at = Number(p.at) || 0;
      if (compareVersions(cur, p.to) >= 0) {
        launched.result = {
          updated: String(p.to), from: String(p.from || ""), reopenWindow: !!p.reopenWindow,
          relaunched: !!p.relaunch && now() >= at && now() - at < settings().relaunchWindowMs,
        };
      } else {
        launched.result = { failed: String(p.to) };
        st.gaveUp[String(p.to)] = "install";
        log("the install of " + p.to + " did not take; the notice takes over");
      }
      st.pending = null;
    }
    // A download given up on is tried again on a new launch; an install that
    // failed is not (the notice and the card take that version over). Either
    // is forgotten once this build has caught up with it.
    for (const [v, why] of Object.entries(st.gaveUp)) {
      if (why !== "install" || compareVersions(cur, v) >= 0) delete st.gaveUp[v];
    }
    if (st.release && compareVersions(cur, st.release.version) >= 0) { st.release = null; st.staged = null; }
    if (st.staged) stagedAt = now();
    save();
    tidy();
    return launched.result;
  }

  /**
   * The bootstrap's `desktop.update` ({ latest, min, url, sha512 }). True when
   * the silent updater has it in hand (main.js then says nothing); false when
   * it is today's notification's: switched off, a copy that cannot replace
   * itself (the Store's among them), nothing newer, no usable checksum or
   * address, or a version already given up on.
   */
  function offer(u) {
    afterLaunch();
    if (!settings().silent) return false;
    try { if (o.isStore && o.isStore()) return false; } catch { return false; }
    if (!o.canSelfUpdate()) return false;
    const latest = String((u && u.latest) || ""), min = String((u && u.min) || "");
    const rel = checkRelease({ url: u && u.url, version: latest, sha512: u && u.sha512 }, o.platform);
    if (!rel) return false;
    const cur = o.version();
    if (compareVersions(cur, rel.version) >= 0) return false;
    if (st.gaveUp[rel.version]) return false;
    required = !!min && compareVersions(cur, min) < 0;
    if (!st.release || st.release.sha512 !== rel.sha512) {
      // A newer release (or the same one republished) replaces the one in
      // hand: a download of the old one stops, its files go.
      gen += 1;
      cancel(retryTimer); retryTimer = null;
      cancel(pollTimer); pollTimer = null;
      st.release = rel;
      st.staged = null;
      failures = 0;
      nagged = false;
      save();
      tidy();
    }
    if (st.staged) schedulePoll();
    else if (!downloading && !retryTimer) void fetchRelease();
    return true;
  }

  /**
   * The app is quitting. A Promise that puts the staged build in and leaves
   * the app closed, or null when there is nothing to do. main.js holds the
   * quit until it settles (and not for ever).
   */
  function atQuit() {
    if (!st.staged || installing || !settings().silent) return null;
    try { if (!o.canSelfUpdate()) return null; } catch { return null; }
    return installStaged({ relaunch: false, reopenWindow: false });
  }

  /** Now, because the person asked (the card's button, or the required notice). */
  function installNow() {
    return installStaged({ relaunch: true, reopenWindow: true });
  }

  /** The version staged and ready, or "". */
  function staged() { return st.staged ? st.staged.version : ""; }

  /** What it is doing, for tests and the log. */
  function status() {
    return {
      release: st.release ? st.release.version : "", staged: staged(), required, failures,
      downloading: !!downloading, waiting: !!retryTimer, polling: !!pollTimer, installing,
      pending: st.pending ? Object.assign({}, st.pending) : null, gaveUp: Object.assign({}, st.gaveUp),
    };
  }

  function stop() {
    gen += 1;
    cancel(retryTimer); retryTimer = null;
    cancel(pollTimer); pollTimer = null;
  }

  return { offer, afterLaunch, atQuit, installNow, staged, status, stop, tick };
}

module.exports = { createSilentUpdate, DEFAULTS };
