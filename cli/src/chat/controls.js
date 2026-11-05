// What Ctrl+C, Ctrl+D and Esc mean in a session (the input layer hands them over when nothing typed takes them):
//
//   Xode thinking (a message in flight), or a "!" command running   Esc or Ctrl+C cancels it, back to the prompt
//   a job running                                                    Esc: "Press Esc again to stop the job"; again stops it
//                                                                    Ctrl+C: the same first step, and the hint says that a
//                                                                    second Ctrl+C leaves instead (the job goes on)
//   at the prompt                                                    Ctrl+C or Ctrl+D: "Press Ctrl+C again to exit"; again
//                                                                    leaves
//
// "Again" is within two seconds (twoPress.js). Leaving never stops a job: the session says it goes on.

"use strict";

const { createTwoPress } = require("../ui/twoPress");

/**
 * Returns fn(kind) for input.onInterrupt. s: { input, busy() (a request or a command to cancel), cancel(), job() (a job
 * running?), stopJob(), leave(), ms, now }.
 */
function createControls(s) {
  const press = createTwoPress({ ms: s.ms || 2000, now: s.now });
  const hint = (text) => s.input.hint(text, press.ms);
  const fire = (fn) => { press.reset(); s.input.clearHint(); fn(); };

  const handle = (kind) => {
    if (s.busy() && (kind === "esc" || kind === "ctrl-c")) { fire(s.cancel); return; }
    const armed = press.armed();
    if (s.job()) {
      if (kind === "esc") {
        if (armed === "esc" || armed === "ctrl-c") fire(s.stopJob);
        else { press.arm("esc"); hint("Press Esc again to stop the job"); }
        return;
      }
      if (kind === "ctrl-c") {
        if (armed === "esc") fire(s.stopJob);
        else if (armed === "ctrl-c") fire(s.leave);
        else { press.arm("ctrl-c"); hint("Press Esc to stop the job, or Ctrl+C again to exit"); }
        return;
      }
    }
    if (kind === "esc") return;
    if (armed === kind) fire(s.leave);
    else { press.arm(kind); hint(kind === "ctrl-d" ? "Press Ctrl+D again to exit" : "Press Ctrl+C again to exit"); }
  };
  handle.reset = () => press.reset();
  return handle;
}

module.exports = { createControls };
