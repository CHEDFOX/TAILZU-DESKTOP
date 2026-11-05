// The job's progress as lines above the status line: one short line when the stage changes ("● Build"), and a dim line for
// each thing it does ("· Edited src/cart/total.ts").

"use strict";

const { STAGES } = require("../chat/stages");
const { highlightRefs } = require("./refs");

/** "● Build". */
function stageLine(i, { paint }) {
  const at = Math.min(Math.max(0, i), STAGES.length - 1);
  return `${paint.cyan("●")} ${paint.bold(STAGES[at])}`;
}

/** "  · Read src/cart/total.ts" (dim on a terminal), cut to the width. */
function activityLine(text, { term, paint }) {
  const max = term.tty ? term.width() - 4 : 200;
  const one = String(text).replace(/\s+/g, " ").trim();
  const s = one.length > max ? one.slice(0, max - 1) + "…" : one;
  return term.tty ? "  " + paint.dim("· ") + highlightRefs(paint.dim(s), paint) : "  · " + s;
}

module.exports = { stageLine, activityLine };
