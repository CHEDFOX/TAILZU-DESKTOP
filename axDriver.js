// THE MAC'S HANDS FOR ASK — the macOS half of driver.js (contract §1).
//
// Ask has to read the app in front as a list of elements with ids, and press,
// type into, scroll and focus them; and, for the questions a list of buttons
// cannot answer, look at the window itself (look: its picture and the text
// in it, read on this machine). The accessibility work is done by a small
// Swift helper (native/tzax.swift, built to build/tzax and shipped beside the
// app like audiotap and tzocr). Starting it costs more than asking it, so it is
// kept warm: one child process, one JSON command per line on its stdin, one
// JSON answer per line on its stdout, matched by the command's id.
//
// And, while a dictation records, where the text cursor is (caret), for Blip
// to peek over the text box: two rectangles and the app, never any text.
//
// Every call here answers, and in time: a promise that always resolves (never
// rejects), within the call's own timeout, `{ ok:false, error:"timeout" }`
// when the helper was too slow. A helper that dies is started again by the
// next call; one that stops answering altogether is killed so the next call
// gets a fresh one. Nothing here throws into main.js.
const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

/** The default time each call waits for its answer. A look takes a picture
 *  and reads it, slower than anything else, so it has its own. */
const SNAPSHOT_MS = 1500;
const ACTION_MS = 1200;
const LOOK_MS = 2500;
/** A caret read's whole time, the helper's watchdog included: it is asked
 *  every few hundred milliseconds while the user dictates, and a peek that
 *  comes late is worth nothing (peek-spec §A, desktop.dictation.peekBudgetMs). */
const CARET_MS = 250;
/** After a call timed out, how long the helper may stay silent before it is
 *  taken for hung and killed (its own watchdog answers before the caller
 *  gives up, so a silent helper is a stuck one). */
const WEDGE_MS = 3000;
/** The longest answer line is a look's: a JPEG in base64 (the helper keeps
 *  it under 6 MB, about 8 in base64) and a few hundred lines of text.
 *  Anything this long without a newline is garbage and is dropped. */
const MAX_LINE = 12 << 20;
/** What a look's lines and picture may be, whatever the helper sent. */
const LOOK_LINES = 300;
const LOOK_TEXT = 120;
const LOOK_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

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

function clampNum(v, lo, hi, fallback) {
  const n = typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
}

/** [x, y, w, h] of finite numbers with no negative size, or null. */
function rect(f) {
  if (!Array.isArray(f) || f.length !== 4 || !f.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return f[2] >= 0 && f[3] >= 0 ? f.slice() : null;
}

/** A look as callers see it. The window and its frame are what everything
 *  else is placed by, so a look without them is no look; a line that cannot
 *  be placed is dropped, and a picture that is not one is null. The title is
 *  for agent.js to refuse a private window by, as a snapshot's is. */
function lookShape(rest) {
  const w = rest.window;
  const frame = w && typeof w === "object" && !Array.isArray(w) ? rect(w.frame) : null;
  if (!frame) return { ok: false, error: "bad_answer" };
  const lines = [];
  for (const l of Array.isArray(rest.lines) ? rest.lines : []) {
    if (lines.length >= LOOK_LINES) break;
    const f = l && typeof l === "object" ? rect(l.frame) : null;
    if (!f || typeof l.text !== "string" || !l.text.trim()) continue;
    lines.push({ text: l.text.slice(0, LOOK_TEXT), frame: f, conf: clampNum(l.conf, 0, 1, 0) });
  }
  // Where the title bar is (frames only), for agent.js to cut the picture below.
  const titleFrames = (Array.isArray(rest.titleFrames) ? rest.titleFrames : []).map(rect).filter((f) => f && f[2] > 0 && f[3] > 0).slice(0, 8);
  const im = rest.image;
  const image = im && typeof im === "object" && LOOK_MIMES.has(im.mime) && typeof im.data === "string" && im.data
    && Number.isInteger(im.width) && im.width > 0 && Number.isInteger(im.height) && im.height > 0
    ? { mime: im.mime, data: im.data, width: im.width, height: im.height }
    : null;
  return {
    ...rest,
    window: { frame, title: typeof w.title === "string" ? w.title.slice(0, 200) : "" },
    scale: rest.scale === "pixels" ? "pixels" : "points",
    lines,
    titleFrames,
    image,
    ms: Number.isFinite(rest.ms) ? rest.ms : 0,
  };
}

/** A caret answer's rectangle: [x, y, w, h] of finite numbers within the
 *  helper's own bounds (frameJ's million points either way), a size that is
 *  not negative and a height that is not zero; anything else is null. */
function caretBox(f) {
  const r = rect(f);
  return r && r[3] > 0 && r.every((n) => Math.abs(n) <= 1e6) ? r : null;
}

/** A caret answer as callers see it (peek-spec §A): exactly these fields,
 *  built afresh, so nothing else the helper wrote (least of all any text)
 *  ever reaches the caller. A failure is its error alone. */
function caretShape(rest) {
  if (typeof rest.ok !== "boolean") return { ok: false, error: "bad_answer" };
  // The helper's errors are words like no_focus; anything else is not passed on.
  if (!rest.ok) return { ok: false, error: typeof rest.error === "string" && /^[a-z_]{1,40}$/.test(rest.error) ? rest.error : "failed" };
  const a = rest.app && typeof rest.app === "object" && !Array.isArray(rest.app) ? rest.app : {};
  return {
    ok: true,
    caret: caretBox(rest.caret),
    field: caretBox(rest.field),
    app: { name: typeof a.name === "string" ? a.name.slice(0, 200) : "", pid: Number.isInteger(a.pid) && a.pid > 0 ? a.pid : 0 },
    scale: "points",
  };
}

/** The answer as callers see it: the helper's fields without its id, and a
 *  failure for anything that is not a well-formed answer. */
function shape(cmd, msg) {
  const { id: _id, ...rest } = msg;
  if (cmd === "caret") return caretShape(rest);
  if (typeof rest.ok !== "boolean") return { ok: false, error: "bad_answer" };
  if (!rest.ok) return { ...rest, error: typeof rest.error === "string" && rest.error ? rest.error : "failed" };
  if (cmd === "trusted") return { ok: true, trusted: rest.trusted === true };
  if (cmd === "snapshot") {
    if (!Array.isArray(rest.elements)) return { ok: false, error: "bad_answer" };
    // The window's title is for agent.js to check on every read (a private
    // window, a bank's site) and never to send. It is always a string, ""
    // when unknown (an older helper sent none), so a check never sees junk.
    const w = rest.window;
    rest.window = w && typeof w === "object" && !Array.isArray(w)
      ? { ...w, title: typeof w.title === "string" ? w.title.slice(0, 200) : "" }
      : null;
  }
  if (cmd === "look") return lookShape(rest);
  return rest;
}

/**
 * A driver around one helper process. Everything it touches is injectable for
 * the tests: `bin` (the helper's path) and `args`, `spawn`, `platform`,
 * `exists`, and the timeouts (`snapshotTimeoutMs`, `actionTimeoutMs`,
 * `lookTimeoutMs`, `wedgeMs`).
 */
function createAxDriver(opts = {}) {
  const spawn = opts.spawn || childProcess.spawn;
  const platform = opts.platform || process.platform;
  const exists = opts.exists || fs.existsSync;
  const args = Array.isArray(opts.args) ? opts.args : [];
  const snapshotMs = clampInt(opts.snapshotTimeoutMs, 50, 60000, SNAPSHOT_MS);
  const actionMs = clampInt(opts.actionTimeoutMs, 50, 60000, ACTION_MS);
  const lookMs = clampInt(opts.lookTimeoutMs, 50, 60000, LOOK_MS);
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
        // Only a piece with a newline in it can end a line, so the others are
        // only added on. A look's answer comes in a hundred pieces, and
        // searching what came so far on each one also copies it whole: a
        // quarter of a second of the main process on a big picture.
        buf += d;
        if (d.indexOf("\n") >= 0) {
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (line.trim()) onLine(c, line);
          }
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
    // Where the caret and its text box are, for the peek. Only of a helper
    // that is already running: a dictation never starts one (the peek shows
    // only while Ask's helper is up), so without one it answers unavailable
    // at once. The whole call keeps to its budget, the helper's watchdog
    // answering a moment before it.
    caret: safe((o) => {
      if (!child) return refuse("unavailable");
      const opt = o && typeof o === "object" ? o : {};
      return call("caret", {}, clampInt(opt.budgetMs != null ? opt.budgetMs : opt.timeoutMs, 100, 2000, CARET_MS));
    }),
    look: safe((o) => {
      const opt = o && typeof o === "object" ? o : {};
      const timeoutMs = clampInt(opt.timeoutMs, 100, 10000, lookMs);
      // The helper's budget for the picture and its text, well inside the
      // call's time: it answers with the picture and whatever text it has
      // read by then, rather than nothing.
      const budgetMs = Math.max(50, Math.min(clampInt(opt.budgetMs, 50, 8000, 1500), timeoutMs - 400));
      return call("look", {
        budgetMs,
        maxSide: clampInt(opt.maxSide, 64, 4096, 1600),
        quality: clampNum(opt.quality, 0.3, 0.95, 0.82),
        ocr: opt.ocr !== false,
        image: opt.image !== false,
      }, timeoutMs);
    }),
  };
}

// The module IS the §1 API (driver.js hands it straight to agent.js);
// createAxDriver rides along unlisted, for the tests.
module.exports = createAxDriver();
Object.defineProperty(module.exports, "createAxDriver", { value: createAxDriver, enumerable: false });
