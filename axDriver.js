// THE MAC'S HANDS FOR ASK — the macOS half of driver.js (contract §1).
//
// Ask has to read the app in front as a list of elements with ids, and press,
// type into, scroll and focus them. The accessibility work is done by a small
// Swift helper (native/tzax.swift, built to build/tzax and shipped beside the
// app like audiotap and tzocr). Starting it costs more than asking it, so it is
// kept warm: one child process, one JSON command per line on its stdin, one
// JSON answer per line on its stdout, matched by the command's id.
//
// Every call here answers, and in time: a promise that always resolves (never
// rejects), within the call's own timeout, `{ ok:false, error:"timeout" }`
// when the helper was too slow. A helper that dies is started again by the
// next call; one that stops answering altogether is killed so the next call
// gets a fresh one. Nothing here throws into main.js.
const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

/** The default time each call waits for its answer. */
const SNAPSHOT_MS = 1500;
const ACTION_MS = 1200;
/** After a call timed out, how long the helper may stay silent before it is
 *  taken for hung and killed (its own watchdog answers before the caller
 *  gives up, so a silent helper is a stuck one). */
const WEDGE_MS = 3000;
/** One answer line is a snapshot at most: a few hundred elements. Anything
 *  this long without a newline is garbage and is dropped. */
const MAX_LINE = 4 << 20;

const DIRS = new Set(["up", "down", "left", "right"]);
const ELEMENT_ID = /^e\d{1,7}$/;

/** The built helper: in the app's Resources when packaged (extraResources in
 *  package.json), the source tree's build/ copy in dev. Plain Node (the tests)
 *  has no Electron app, so it is the build/ copy there too. */
function defaultBin() {
  let packaged = false;
  try {
    const electron = require("electron");
    packaged = !!(electron && typeof electron === "object" && electron.app && electron.app.isPackaged);
  } catch { /* not inside Electron */ }
  return packaged && process.resourcesPath ? path.join(process.resourcesPath, "tzax") : path.join(__dirname, "build", "tzax");
}

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (v == null || v === "" || !Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/** The answer as callers see it: the helper's fields without its id, and a
 *  failure for anything that is not a well-formed answer. */
function shape(cmd, msg) {
  const { id: _id, ...rest } = msg;
  if (typeof rest.ok !== "boolean") return { ok: false, error: "bad_answer" };
  if (!rest.ok) return { ...rest, error: typeof rest.error === "string" && rest.error ? rest.error : "failed" };
  if (cmd === "trusted") return { ok: true, trusted: rest.trusted === true };
  if (cmd === "snapshot" && !Array.isArray(rest.elements)) return { ok: false, error: "bad_answer" };
  return rest;
}

/**
 * A driver around one helper process. Everything it touches is injectable for
 * the tests: `bin` (the helper's path) and `args`, `spawn`, `platform`,
 * `exists`, and the timeouts (`snapshotTimeoutMs`, `actionTimeoutMs`,
 * `wedgeMs`).
 */
function createAxDriver(opts = {}) {
  const spawn = opts.spawn || childProcess.spawn;
  const platform = opts.platform || process.platform;
  const exists = opts.exists || fs.existsSync;
  const args = Array.isArray(opts.args) ? opts.args : [];
  const snapshotMs = clampInt(opts.snapshotTimeoutMs, 50, 60000, SNAPSHOT_MS);
  const actionMs = clampInt(opts.actionTimeoutMs, 50, 60000, ACTION_MS);
  const wedgeMs = clampInt(opts.wedgeMs, 50, 60000, WEDGE_MS);

  let child = null;
  let seq = 0;
  let heardAt = 0;
  const pending = new Map(); // id → { resolve, timer, child, cmd }

  const bin = () => opts.bin || defaultBin();

  function available() {
    try { return platform === "darwin" && !!exists(bin()); } catch { return false; }
  }

  function settle(id, answer) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(answer);
  }

  /** The helper `c` is gone: forget it, and answer everything it owed. */
  function gone(c, error) {
    if (child === c) child = null;
    for (const [id, p] of pending) if (p.child === c) settle(id, { ok: false, error });
  }

  function onLine(c, line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
    const p = pending.get(msg.id);
    if (!p || p.child !== c) return; // a stray line, or an answer nobody waits for any more
    settle(msg.id, shape(p.cmd, msg));
  }

  /** Spawn the warm helper if it is not running. Idempotent; never throws. */
  function start() {
    try {
      if (child) return true;
      if (!available()) return false;
      const c = spawn(bin(), args, { stdio: ["pipe", "pipe", "ignore"] });
      if (!c || !c.stdout || !c.stdin) return false;
      child = c;
      let buf = "";
      c.stdout.setEncoding("utf8");
      c.stdout.on("data", (d) => {
        if (child === c) heardAt = Date.now();
        buf += d;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) onLine(c, line);
        }
        if (buf.length > MAX_LINE) buf = "";
      });
      // A write to a helper that just died is an EPIPE on its stdin; unheard,
      // that would be an uncaught exception in the main process.
      c.stdin.on("error", () => {});
      c.stdout.on("error", () => {});
      c.on("error", () => gone(c, "helper_failed"));
      c.on("exit", () => gone(c, "helper_exited"));
      return true;
    } catch {
      child = null;
      return false;
    }
  }

  /** Kill the helper. Calls still waiting answer "stopped"; the next call
   *  starts a new one. */
  function stop() {
    const c = child;
    child = null;
    if (!c) return;
    gone(c, "stopped");
    try { c.stdin.end(); } catch { /* closed */ }
    try { c.kill(); } catch { /* gone */ }
  }

  /** A call timed out. The helper's own watchdog answers before we give up, so
   *  if it then stays silent it is stuck, not slow: kill it, and the next
   *  call starts a fresh one. */
  function suspect(c) {
    const at = Date.now();
    const t = setTimeout(() => {
      if (child !== c || heardAt >= at) return;
      gone(c, "helper_hung");
      try { c.kill("SIGKILL"); } catch { /* gone */ }
    }, wedgeMs);
    if (t && typeof t.unref === "function") t.unref();
  }

  function call(cmd, fields, timeoutMs) {
    return new Promise((resolve) => {
      try {
        if (!start()) {
          resolve({ ok: false, error: available() ? "spawn_failed" : "unavailable" });
          return;
        }
        const c = child;
        const id = ++seq;
        const timer = setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          resolve({ ok: false, error: "timeout" });
          suspect(c);
        }, timeoutMs);
        pending.set(id, { resolve, timer, child: c, cmd });
        // The helper hears the caller's limit too: it answers "timeout" a
        // moment before it, and never acts on a command it got to too late.
        c.stdin.write(JSON.stringify({ id, cmd, ...fields, timeoutMs }) + "\n", (err) => {
          if (err) settle(id, { ok: false, error: "helper_exited" });
        });
      } catch {
        resolve({ ok: false, error: "failed" });
      }
    });
  }

  const refuse = (error) => Promise.resolve({ ok: false, error });
  const elementId = (id) => (typeof id === "string" && ELEMENT_ID.test(id) ? id : null);

  /** Wraps a method so that a bug in argument handling still resolves. */
  const safe = (fn) => (...a) => {
    try { return fn(...a); } catch { return refuse("failed"); }
  };

  return {
    available,
    start,
    stop,
    trusted: safe((o) => call("trusted", { prompt: !!(o && o.prompt) }, actionMs)),
    snapshot: safe((o) => {
      const opt = o && typeof o === "object" ? o : {};
      const timeoutMs = clampInt(opt.timeoutMs, 100, 10000, snapshotMs);
      const max = clampInt(opt.max, 1, 500, 250);
      // The walk's own budget, well inside the call's: a huge tree (Slack,
      // Gmail) comes back truncated:true instead of timing out.
      const budgetMs = Math.max(80, Math.min(timeoutMs - 300, Math.round(timeoutMs * 0.6)));
      return call("snapshot", { max, budgetMs }, timeoutMs);
    }),
    press: safe((id) => (elementId(id) ? call("press", { el: id }, actionMs) : refuse("bad_id"))),
    click: safe((id) => (elementId(id) ? call("click", { el: id }, actionMs) : refuse("bad_id"))),
    setValue: safe((id, text) => {
      if (!elementId(id)) return refuse("bad_id");
      const t = text == null ? "" : String(text);
      if (t.length > 20000) return refuse("too_long");
      return call("setValue", { el: id, text: t }, actionMs);
    }),
    focus: safe((id) => (elementId(id) ? call("focus", { el: id }, actionMs) : refuse("bad_id"))),
    scroll: safe((id, dir, lines) => {
      if (id != null && !elementId(id)) return refuse("bad_id");
      const d = typeof dir === "string" ? dir.trim().toLowerCase() : "";
      if (!DIRS.has(d)) return refuse("bad_dir");
      return call("scroll", { el: id == null ? null : id, dir: d, lines: clampInt(lines, 1, 40, 5) }, actionMs);
    }),
    key: safe((chord) => {
      const c = typeof chord === "string" ? chord.trim() : "";
      if (!c || c.length > 64) return refuse("bad_chord");
      return call("key", { chord: c }, actionMs);
    }),
    open: safe((appName) => {
      const a = typeof appName === "string" ? appName.trim() : "";
      if (!a || a.length > 120) return refuse("bad_app");
      return call("open", { app: a }, actionMs);
    }),
  };
}

// The module IS the §1 API (driver.js hands it straight to agent.js);
// createAxDriver rides along unlisted, for the tests.
module.exports = createAxDriver();
Object.defineProperty(module.exports, "createAxDriver", { value: createAxDriver, enumerable: false });
