// What the terminal can show: boxes and colour on a terminal, plain lines when piped, no colour with NO_COLOR.
// XODE_TTY=1 or 0 says it outright (demos, tests); COLUMNS sets the width.

"use strict";

const MIN_WIDTH = 40;
const MAX_WIDTH = 100;

function termOf(stream = process.stdout, env = process.env) {
  const tty = env.XODE_TTY === "1" ? true : env.XODE_TTY === "0" ? false : !!(stream && stream.isTTY);
  const noColor = typeof env.NO_COLOR === "string" && env.NO_COLOR !== "";
  const cols = () => Number(env.COLUMNS) || (stream && stream.columns) || 80;
  return {
    tty,
    color: tty && !noColor,
    /** The width to draw at: the terminal's, at least 40 and at most 100 columns. */
    width: () => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, cols())),
  };
}

module.exports = { termOf, MIN_WIDTH };
