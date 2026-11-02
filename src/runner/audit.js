// THE AUDIT LOG: every command Tailzu Code runs on this computer, kept on this computer.
//
// One line of JSON per event, in a file per day (`audit-YYYY-MM-DD.log`) under `<userData>/runner/audit`, readable only by the
// person. Files older than 7 days are deleted as the days roll, and a day's file that grows past its size is started again as
// `audit-YYYY-MM-DD.1.log` and so on, so the log can never fill a disk. The command text is redacted before it is written, as
// output is before it is sent. Nothing in here leaves the computer.

"use strict";

const nodeFs = require("fs");
const nodePath = require("path");

const NAME = /^audit-(\d{4})-(\d{2})-(\d{2})(?:\.(\d+))?\.log$/;
const pad = (n) => String(n).padStart(2, "0");
const dayOf = (ms) => { const d = new Date(ms); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };

/** o: { dir, fs, now, keepDays (7), maxFileBytes (2 MB), redact(text) } */
function createAudit(o) {
  const fs = o.fs || nodeFs;
  const now = o.now || Date.now;
  const keepDays = o.keepDays || 7;
  const maxBytes = o.maxFileBytes || 2 * 1024 * 1024;
  const redact = o.redact || ((t) => t);
  let day = "";
  let part = 0;
  let size = 0;
  let pruned = "";

  function fileFor(d, p) { return nodePath.join(o.dir, "audit-" + d + (p ? "." + p : "") + ".log"); }

  /** Deletes the files older than keepDays (by the date in their name). Returns the names removed. */
  function prune() {
    const gone = [];
    let names = [];
    try { names = fs.readdirSync(o.dir); } catch { return gone; }
    const cutoff = now() - keepDays * 86400000;
    for (const n of names) {
      const m = NAME.exec(n);
      if (!m) continue;
      const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
      if (at + 86400000 <= cutoff) { try { fs.rmSync(nodePath.join(o.dir, n), { force: true }); gone.push(n); } catch { /* in use */ } }
    }
    return gone;
  }

  function open() {
    const d = dayOf(now());
    if (d !== day) {
      day = d; part = 0; size = 0;
      try { fs.mkdirSync(o.dir, { recursive: true, mode: 0o700 }); } catch { /* the write says */ }
      // Carry on in the day's file if it is there and has room.
      for (; ; part += 1) {
        let s = 0;
        try { s = fs.statSync(fileFor(day, part)).size; } catch { s = 0; }
        if (s < maxBytes) { size = s; break; }
      }
    }
    if (pruned !== d) { pruned = d; prune(); }
  }

  return {
    /** Appends one event. Never throws: a log that cannot be written must not stop the work (and says so once, to the caller's log). */
    log(event) {
      try {
        open();
        const line = JSON.stringify(Object.assign({ ts: new Date(now()).toISOString() }, event, event && typeof event.command === "string" ? { command: redact(event.command).slice(0, 2000) } : {})) + "\n";
        if (size + line.length > maxBytes) { part += 1; size = 0; }
        fs.appendFileSync(fileFor(day, part), line, { mode: 0o600 });
        size += line.length;
        return true;
      } catch (err) {
        if (o.onError) o.onError(err);
        return false;
      }
    },
    prune,
    /** The files, newest first. */
    files() {
      try { return fs.readdirSync(o.dir).filter((n) => NAME.test(n)).sort().reverse(); } catch { return []; }
    },
    dir: o.dir,
  };
}

module.exports = { createAudit, dayOf };
