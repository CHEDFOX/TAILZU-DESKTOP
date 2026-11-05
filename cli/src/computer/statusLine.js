// One dim line about this computer ("This computer: online…"), said once at the start and again only when it changes for a moment,
// so a socket that reconnects doesn't fill the chat.

"use strict";

/** The words for the runner's status(). */
function wordsOf(st, projectName) {
  switch (st && st.state) {
    case "working": return `This computer: working on ${st.project || projectName}.`;
    case "online": return `This computer: online for Xode, for ${projectName} only.`;
    case "paused": return `This computer: paused (${st.pausedReason === "battery_low" ? "the battery is low" : "low power mode is on"}).`;
    case "live_off": return "This computer: not offered, the server doesn't take computers yet.";
    case "replaced": return "This computer: another xode or X0 Bot has taken it over.";
    case "signed_out": return "This computer: not offered, signed out.";
    case "off": return "This computer: off for Xode.";
    default: return "This computer: connecting…";
  }
}

/** update() reads the status and says it once it has held for `holdMs`; stop() says nothing more. */
function createStatusLine({ out, status, projectName, holdMs = 1200, timers = { setTimeout, clearTimeout } }) {
  let said = "";
  let timer = null;
  let stopped = false;
  const sayNow = () => {
    timer = null;
    if (stopped) return;
    let w;
    try { w = wordsOf(status(), projectName); } catch { return; }
    if (w !== said) { said = w; out.note(w); }
  };
  return {
    update() {
      if (stopped) return;
      timers.clearTimeout(timer);
      timer = timers.setTimeout(sayNow, holdMs);
      if (timer && timer.unref) timer.unref();
    },
    get said() { return said; },
    stop() { stopped = true; timers.clearTimeout(timer); timer = null; },
  };
}

module.exports = { createStatusLine, wordsOf };
