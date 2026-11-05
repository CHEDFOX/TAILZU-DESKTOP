// "Press … again": a key that acts only when it is pressed twice within a moment. The first press arms it (the caller says
// so in a hint); a second press of the same kind within `ms` fires it; after that the moment has passed.

"use strict";

function createTwoPress({ ms = 2000, now = Date.now } = {}) {
  let armed = null; // { kind, at }
  const live = () => (armed && now() - armed.at <= ms ? armed.kind : null);
  return {
    ms,
    /** The kind armed now, or null. */
    armed: live,
    /** True when this press is the second of `kind` in time; otherwise it arms `kind` and is false. */
    press(kind) {
      if (live() === kind) { armed = null; return true; }
      armed = { kind, at: now() };
      return false;
    },
    /** Arms `kind` without asking whether it fires. */
    arm(kind) { armed = { kind, at: now() }; },
    reset() { armed = null; },
  };
}

module.exports = { createTwoPress };
