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

const DEFAULTS = { snapshotTimeout: 1500, actionTimeout: 1200, openTimeout: 6000, warmupMs: 8000 };

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
  for (const k of ["snapshotTimeout", "actionTimeout", "openTimeout", "warmupMs"]) {
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

  function rawSend(cmd, extra, timeoutMs) {
    return new Promise((resolve) => {
      if (!child) { resolve({ ok: false, error: "dead" }); return; }
      const id = ++seq;
      const timer = setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); resolve({ ok: false, error: "timeout" }); }
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      try {
        child.stdin.write(JSON.stringify({ id, cmd, ...extra }) + "\n");
      } catch {
        if (pending.has(id)) { pending.delete(id); clearTimeout(timer); resolve({ ok: false, error: "dead" }); }
      }
    });
  }

  async function send(cmd, extra, timeoutMs) {
    start();
    if (!child) return { ok: false, error: "unavailable" };
    try { await ready; } catch { /* warm-up never rejects, but be safe */ }
    const r = await rawSend(cmd, extra, timeoutMs);
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
      return send("snapshot", { max, budgetMs }, t);
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
  };
}

// The default instance is the real Windows driver. Its methods are spread onto
// the exports so the module itself is the §1 API (available, start, stop,
// trusted, snapshot, press, click, setValue, focus, scroll, key, open).
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
  createUiaDriver,
  scriptPath,
  defaultCommand,
  loaderText,
};
