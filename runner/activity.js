// THE ACTIVITY LOG: the last commands Tailzu Code ran on this computer, for the window that shows them.
//
// In memory only (the audit log is the record that lasts): newest first, at most 200. A command is listed the moment it starts,
// as "running", and filled in with its exit code and how long it took when it ends. The window is told on every change.

"use strict";

function createActivity({ max = 200, now = Date.now } = {}) {
  let seq = 0;
  let rows = [];
  const listeners = new Set();
  const changed = () => { for (const f of listeners) { try { f(); } catch { /* a listener of the window */ } } };
  return {
    /** A command began: returns its id. */
    start({ project, command, jobId, preview }) {
      seq += 1;
      rows.unshift({ id: seq, at: now(), project: String(project || ""), jobId: String(jobId || ""), command: String(command || "").slice(0, 400), state: "running", exitCode: null, ms: null, refused: "", preview: !!preview });
      if (rows.length > max) rows.length = max;
      changed();
      return seq;
    },
    /** It ended. */
    end(id, { exitCode, ms, timedOut, cancelled }) {
      const r = rows.find((x) => x.id === id);
      if (!r) return;
      Object.assign(r, { state: "done", exitCode, ms, timedOut: !!timedOut, cancelled: !!cancelled });
      changed();
    },
    /** One that was not run. */
    refused({ project, command, jobId, rule, message }) {
      seq += 1;
      rows.unshift({ id: seq, at: now(), project: String(project || ""), jobId: String(jobId || ""), command: String(command || "").slice(0, 400), state: "refused", exitCode: 126, ms: 0, refused: String(rule || ""), message: String(message || "").slice(0, 300), preview: false });
      if (rows.length > max) rows.length = max;
      changed();
    },
    /** Commands still marked running that will never end (the session was cut): closed with the given code. */
    settleRunning(exitCode = 130) {
      let any = false;
      for (const r of rows) if (r.state === "running") { r.state = "done"; r.exitCode = exitCode; r.cancelled = true; any = true; }
      if (any) changed();
    },
    list() { return rows.map((r) => Object.assign({}, r)); },
    onChange(f) { listeners.add(f); return () => listeners.delete(f); },
    clear() { rows = []; changed(); },
  };
}

module.exports = { createActivity };
