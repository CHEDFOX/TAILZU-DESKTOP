// THE WINDOWS NATIVE DRIVER FOR "ASK" (the §1 driver API, win32 half).
//
// It keeps one PowerShell helper (native/uia-agent.ps1) warm and talks JSON
// lines to it: one request object per line in, one answer object per line out,
// matched by a request id. This is Ask's OWN helper, never the PowerShell
// frontApp.js keeps for dictation — the two must not queue behind each other.
//
// The contract every method keeps: the returned promise ALWAYS resolves, never
// rejects, and within its timeout. A timed-out call resolves
// { ok:false, error:"timeout" }; a helper that has died is respawned on the
// next call. The first line after a spawn waits on Add-Type and the UI
// Automation assemblies loading, which is slow, so warm-up gets its own, longer
// budget and the snapshot that follows is timed from an already-ready helper.

const { spawn: nodeSpawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const DEFAULTS = { snapshotTimeout: 1500, actionTimeout: 1200, openTimeout: 6000, lookTimeout: 2500, warmupMs: 8000 };

/** What a look spends outside the helper's own budget: the capture and the
 *  JPEG, which the budget does not cut short, and an answer a few hundred KB
 *  long written by one process and read by the other. */
const LOOK_MARGIN_MS = 800;
/** The contract's caps on a look's lines (§A). The helper keeps to them; they
 *  are held here too so a caller never gets more whatever comes back. */
const LOOK_LINES_MAX = 300;
const LOOK_TEXT_MAX = 120;

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (v == null || v === "" || !Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

const isFrame = (f) => Array.isArray(f) && f.length === 4 && f.every((n) => typeof n === "number" && Number.isFinite(n));

/** A look's answer as callers get it (§A). The window's frame is what
 *  everything else is measured against (the picture is exactly that frame,
 *  scaled; the lines are in the same global pixels), so an answer without one
 *  is no answer. Lines with no text or no frame are dropped, and a picture
 *  without data is null. Windows' OCR gives no confidence, so a line carries
 *  `conf` only if the helper ever sends one. */
function shapeLook(r) {
  if (!r || typeof r !== "object") return { ok: false, error: "bad_answer" };
  if (r.ok !== true) return { ok: false, error: typeof r.error === "string" && r.error ? r.error : "failed" };
  const { id: _id, ...rest } = r;
  const w = rest.window;
  if (!w || typeof w !== "object" || !isFrame(w.frame) || !(w.frame[2] > 0) || !(w.frame[3] > 0)) return { ok: false, error: "bad_answer" };
  const lines = [];
  for (const l of Array.isArray(rest.lines) ? rest.lines : []) {
    if (lines.length >= LOOK_LINES_MAX) break;
    if (!l || typeof l !== "object" || typeof l.text !== "string" || !l.text.trim() || !isFrame(l.frame)) continue;
    const line = { text: l.text.slice(0, LOOK_TEXT_MAX), frame: l.frame };
    if (typeof l.conf === "number" && Number.isFinite(l.conf)) line.conf = l.conf;
    lines.push(line);
  }
  // Where the window's title is drawn (its title bar, the lines the helper
  // dropped for being the title): frames only, for the device to cut the
  // picture below them (agent.js chromeBottom).
  const titleFrames = (Array.isArray(rest.titleFrames) ? rest.titleFrames : [])
    .filter((f) => isFrame(f) && f[2] > 0 && f[3] > 0).slice(0, 8).map((f) => f.slice());
  const im = rest.image;
  const image = im && typeof im === "object" && typeof im.data === "string" && im.data &&
    typeof im.mime === "string" && /^image\//.test(im.mime) && im.width > 0 && im.height > 0
    ? { mime: im.mime, data: im.data, width: im.width, height: im.height }
    : null;
  return {
    ...rest,
    ok: true,
    window: { frame: w.frame, title: typeof w.title === "string" ? w.title.slice(0, 200) : "" },
    scale: "pixels",
    lines,
    titleFrames,
    image,
    ms: typeof rest.ms === "number" && Number.isFinite(rest.ms) ? rest.ms : 0,
  };
}

/** The helper script, found in dev (native/) and in the packaged app
 *  (process.resourcesPath, via the build.extraResources entry). Resolved
 *  without requiring electron, so this module loads under plain `node --test`. */
function scriptPath() {
  try {
    if (process.resourcesPath) {
      const packaged = path.join(process.resourcesPath, "uia-agent.ps1");
      if (fs.existsSync(packaged)) return packaged;
    }
  } catch { /* process.resourcesPath missing outside Electron */ }
  return path.join(__dirname, "native", "uia-agent.ps1");
}

/** The command text that runs the helper: read the script and dot-source it,
 *  so its $script: maps live in the one scope. The path sits in a
 *  single-quoted PowerShell string, where only a quote needs doubling, but
 *  PowerShell reads the typographic single quotes (‘ ’ ‚ ‛) as quotes too: a
 *  profile folder like C:\Users\O’Brien would otherwise end the string early
 *  and the helper would never start. Doubled, each stands for itself. */
function loaderText(file) {
  const p = String(file).replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&");
  return `. ([scriptblock]::Create([System.IO.File]::ReadAllText('${p}')))`;
}

/** How the default instance launches the helper: the same flags frontApp
 *  uses, -EncodedCommand included. A script run with -File is subject to the
 *  execution policy, and one set by Group Policy ("allow only signed
 *  scripts") overrides -ExecutionPolicy Bypass, so the unsigned helper would
 *  never start there; command text is not subject to it. The script is too big
 *  to encode whole (the command line stops at 32K characters), so what is
 *  encoded is a one-line loader. Injectable so tests speak to a fake. */
function defaultCommand(file = scriptPath()) {
  return {
    cmd: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-EncodedCommand", Buffer.from(loaderText(file), "utf16le").toString("base64")],
  };
}

/**
 * A driver over an injectable spawn and command, so the whole protocol can be
 * tested against a fake helper on any platform. `createUiaDriver()` with no
 * options is the real Windows driver; the module also exports a ready-made
 * default instance.
 */
function createUiaDriver(opts = {}) {
  const spawnFn = opts.spawn || nodeSpawn;
  const command = opts.command || defaultCommand();
  const cfg = { ...DEFAULTS };
  for (const k of ["snapshotTimeout", "actionTimeout", "openTimeout", "lookTimeout", "warmupMs"]) {
    if (opts[k] != null) cfg[k] = opts[k];
  }

  let child = null;
  let seq = 0;
  let ready = null;
  const pending = new Map();

  function onLine(line) {
    let msg;
    // A line the helper wrote that is not JSON (a stray warning, a half-line)
    // is dropped: it belongs to no request, and the request it would have
    // answered simply times out and is retried, rather than being mis-settled.
    try { msg = JSON.parse(line); } catch { return; }
    const id = msg && msg.id;
    if (id == null) return;
    const p = pending.get(id);
    // Matched by id, so answers that come back out of order each settle their
    // own request; an answer that arrives after its request already timed out
    // has no pending entry and is ignored (never a second resolve, never a throw).
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(msg);
  }

  // The helper is gone: forget it (the next call respawns) and settle everyone
  // still waiting, so no promise is ever left hanging.
  function reap(errLabel) {
    child = null;
    ready = null;
    const waiting = [...pending.values()];
    pending.clear();
    for (const p of waiting) { clearTimeout(p.timer); p.resolve({ ok: false, error: errLabel }); }
  }

  function start() {
    if (child) return;
    let c;
    try {
      c = spawnFn(command.cmd, command.args, { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      child = null;
      return;
    }
    if (!c || !c.stdout || !c.stdin) { child = null; return; }
    child = c;
    // A write to a helper that has just died (killed from Task Manager, by
    // antivirus, at logoff) is an EPIPE on its stdin, delivered after the
    // write returned, so rawSend's try cannot catch it. Unheard, it would be
    // an uncaught exception in Electron's main process and its error dialog.
    // The exit that follows settles whatever was waiting.
    c.stdin.on("error", () => {});
    c.stdout.on("error", () => {});
    // Each helper has its own line buffer, and its events count only while it
    // is still the current one: a helper stopped and replaced must not settle,
    // or reap, the requests of the one that came after it.
    let buf = "";
    c.stdout.setEncoding("utf8");
    c.stdout.on("data", (d) => {
      if (child !== c) return;
      buf += d;
      // Only a piece with a newline in it can end a line. A look's answer
      // (a JPEG in base64) comes in hundreds of pieces, and searching all
      // that came so far on each one also copies it: a 3 MB answer read 4 KB
      // at a time held the main process for half a second.
      if (d.indexOf("\n") < 0) return;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onLine(line);
      }
    });
    c.on("exit", () => { if (child === c) reap("dead"); });
    c.on("error", () => { if (child === c) reap("dead"); });
    ready = rawSend("ping", {}, cfg.warmupMs);
  }

  function rawSend(cmd, extra, timeoutMs, how = {}) {
    return new Promise((resolve) => {
      if (!child) { resolve({ ok: false, error: "dead" }); return; }
      const id = ++seq;
      const timer = setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); resolve({ ok: false, error: "timeout" }); }
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      // When this call gives up, by the clock the helper reads too, for a
      // command that can sit in the helper's queue behind another: it then
      // knows how much of its time is left (a look cuts its budget to fit).
      const line = how.deadline ? { id, cmd, ...extra, deadline: Date.now() + timeoutMs } : { id, cmd, ...extra };
      try {
        child.stdin.write(JSON.stringify(line) + "\n");
      } catch {
        if (pending.has(id)) { pending.delete(id); clearTimeout(timer); resolve({ ok: false, error: "dead" }); }
      }
    });
  }

  async function send(cmd, extra, timeoutMs, how = {}) {
    start();
    if (!child) return { ok: false, error: "unavailable" };
    try { await ready; } catch { /* warm-up never rejects, but be safe */ }
    // Written after whatever else was asked in this same turn (see snapshot).
    if (how.last) await new Promise((r) => setImmediate(r));
    const r = await rawSend(cmd, extra, timeoutMs, how);
    // The request id is the driver's bookkeeping; the contract's objects do not
    // carry it, so strip it before handing the answer up.
    if (r && typeof r === "object" && "id" in r) { const { id, ...rest } = r; return rest; }
    return r;
  }

  return {
    /** True when this driver could actually run: the helper script is present
     *  and the platform is Windows (or a fake command was injected for tests). */
    available() {
      if (opts.command) return true;
      if (process.platform !== "win32") return false;
      try { return fs.existsSync(scriptPath()); } catch { return false; }
    },
    /** Spawn the warm helper if it is not already up. Idempotent, never throws. */
    start() { try { start(); } catch { /* reported as unavailable on first call */ } },
    /** Kill the helper. The next call respawns it. */
    stop() {
      if (child) {
        try { child.stdin.end(); } catch { /* already gone */ }
        try { child.kill(); } catch { /* already gone */ }
      }
      reap("dead");
    },
    // Windows has no accessibility-permission gate, so trust never depends on
    // the helper being up: ask it (a cheap liveness check) but answer true
    // regardless, so the device never stalls here.
    trusted(/* { prompt } = {} */) {
      return send("trusted", {}, cfg.actionTimeout)
        .then((r) => (r && r.ok ? { ok: true, trusted: r.trusted !== false } : { ok: true, trusted: true }));
    },
    snapshot({ max = 250, timeoutMs } = {}) {
      const t = timeoutMs || cfg.snapshotTimeout;
      // The walk's own budget, well inside the call's, as axDriver sends it:
      // a huge tree (Slack, Teams, a long page) comes back truncated:true with
      // what was found instead of timing out with nothing, and the helper,
      // which does one thing at a time, is free again for the next call.
      const budgetMs = Math.max(80, Math.min(t - 300, Math.round(t * 0.6)));
      // The helper walks on the thread that reads its lines, and reads none
      // until the walk is done. Alt twice asks for a snapshot and then a look
      // in the same turn, so the snapshot's line goes after the look's: the
      // look's worker starts at once, beside the walk, instead of waiting out
      // the walk with its own timeout already running.
      return send("snapshot", { max, budgetMs }, t, { last: true });
    },
    press(id) { return send("press", { target: id }, cfg.actionTimeout); },
    click(id) { return send("click", { target: id }, cfg.actionTimeout); },
    setValue(id, text) { return send("setValue", { target: id, text: String(text == null ? "" : text) }, cfg.actionTimeout); },
    focus(id) { return send("focus", { target: id }, cfg.actionTimeout); },
    // id null → scroll whatever is under the pointer.
    scroll(id, dir, lines = 3) {
      const extra = { dir, lines };
      if (id) extra.target = id;
      return send("scroll", extra, cfg.actionTimeout);
    },
    key(chord) { return send("key", { chord }, cfg.actionTimeout); },
    open(appName) { return send("open", { app: appName }, cfg.openTimeout); },
    // The window in front as a picture and as the text in it (§A). Slower
    // than any other call, so it has its own timeout: by default the larger
    // of lookTimeout and the budget asked for plus what a look spends outside
    // it, so a longer budget is honoured; an explicit timeoutMs wins, and the
    // budget is then cut to fit inside it. The helper makes the look on a
    // thread of its own, so a snapshot asked at the same moment is not held;
    // the line carries its deadline, so a look that still waited behind
    // another command is cut to the time left, or not made once it is gone.
    look(o) {
      try {
        const opt = o && typeof o === "object" ? o : {};
        const asked = clampInt(opt.budgetMs, 100, 10000, 1500);
        const t = opt.timeoutMs != null
          ? clampInt(opt.timeoutMs, 200, 30000, cfg.lookTimeout)
          : Math.max(cfg.lookTimeout, asked + LOOK_MARGIN_MS);
        const budgetMs = Math.max(100, Math.min(asked, t - LOOK_MARGIN_MS));
        const maxSide = clampInt(opt.maxSide, 64, 4096, 1600);
        // 0..1, as the contract has it; a percentage is taken as one.
        let quality = Number(opt.quality);
        if (opt.quality == null || !(quality > 0)) quality = 0.82;
        else if (quality > 1) quality /= 100;
        quality = Math.max(0.1, Math.min(1, quality));
        return send("look", { budgetMs, maxSide, quality, ocr: opt.ocr !== false, image: opt.image !== false }, t, { deadline: true })
          .then(shapeLook, () => ({ ok: false, error: "failed" }));
      } catch {
        return Promise.resolve({ ok: false, error: "failed" });
      }
    },
  };
}

// The default instance is the real Windows driver. Its methods are spread onto
// the exports so the module itself is the §1 API (available, start, stop,
// trusted, snapshot, press, click, setValue, focus, scroll, key, open, look).
const instance = createUiaDriver();
module.exports = {
  available: instance.available,
  start: instance.start,
  stop: instance.stop,
  trusted: instance.trusted,
  snapshot: instance.snapshot,
  press: instance.press,
  click: instance.click,
  setValue: instance.setValue,
  focus: instance.focus,
  scroll: instance.scroll,
  key: instance.key,
  open: instance.open,
  look: instance.look,
  createUiaDriver,
  scriptPath,
  defaultCommand,
  loaderText,
};
