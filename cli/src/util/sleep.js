// Waits, and can be cut short.

"use strict";

/** Resolves after `ms`, or at once when `signal` aborts. */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); if (signal) signal.removeEventListener("abort", done); resolve(); }
    if (signal) signal.addEventListener("abort", done, { once: true });
  });
}

module.exports = { sleep };
