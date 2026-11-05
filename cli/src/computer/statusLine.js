// This computer's runner, said only when it matters: "Working on this computer." when a job starts here, or a problem
// (paused for the battery, taken over, signed out). Online, connecting or off say nothing. A state is said once it has held
// for a moment, so a socket that reconnects doesn't fill the chat.

"use strict";

/** The words for the runner's status(), or null when there is nothing worth saying. */
function wordsOf(st) {
  switch (st && st.state) {
    case "working": return "Working on this computer.";
    case "paused": return `This computer paused its work: ${st.pausedReason === "battery_low" ? "the battery is low" : "low power mode is on"}.`;
    case "replaced": return "Another xode or X0 Bot has taken this computer over.";
    case "signed_out": return "This computer isn't doing Xode's work: signed out.";
    default: return null;
  }
}

/** For /status: the runner's state in a few words. */
function stateWords(st, projectName) {
  switch (st && st.state) {
    case "working": return `working on ${st.project || projectName}`;
    case "online": return `online, for ${projectName} only`;
    case "paused": return "paused (power)";
    case "live_off": return "not offered (the server doesn't take computers yet)";
    case "replaced": return "taken over by another xode or X0 Bot";
    case "signed_out": return "not offered (signed out)";
    case "off": return "off";
    default: return "connecting";
  }
}

/** update() reads the status and says it once it has held for `holdMs`; stop() says nothing more. */
function createStatusLine({ out, status, holdMs = 1200, timers = { setTimeout, clearTimeout } }) {
  let said = null;
  let timer = null;
  let stopped = false;
  const sayNow = () => {
    timer = null;
    if (stopped) return;
    let w;
    try { w = wordsOf(status()); } catch { return; }
    if (w !== said) { said = w; if (w) out.note(w); }
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

module.exports = { createStatusLine, wordsOf, stateWords };
