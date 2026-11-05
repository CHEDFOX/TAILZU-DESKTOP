// The job's progress: one line when the stage changes, and short lines for what it is doing.

"use strict";

const { STAGES } = require("../chat/stages");
const { highlightRefs } = require("./refs");

/** "Stage 2 of 5: Plan", and on a terminal the five stages with this one picked out. */
function stageLine(i, { term, paint }) {
  const at = Math.min(i, STAGES.length - 1);
  const head = paint.bold(`Stage ${at + 1} of ${STAGES.length}: ${STAGES[at]}`);
  if (!term.tty) return head;
  const trail = STAGES.map((s, j) => (j < at ? paint.green(s) : j === at ? paint.bold(paint.cyan(s)) : paint.dim(s))).join(paint.dim(" · "));
  // At 60 columns the trail and the head don't fit on one line: the trail alone says it.
  return term.width() >= 70 ? `${head}   ${trail}` : trail + paint.dim(`  (${at + 1}/${STAGES.length})`);
}

/** "  - Read src/cart/total.ts" (dim on a terminal), cut to the width. */
function activityLine(text, { term, paint }) {
  const max = term.tty ? term.width() - 4 : 200;
  const one = String(text).replace(/\s+/g, " ").trim();
  const s = one.length > max ? one.slice(0, max - 1) + "…" : one;
  return term.tty ? "  " + paint.dim("· ") + highlightRefs(paint.dim(s), paint) : "  - " + s;
}

module.exports = { stageLine, activityLine };
