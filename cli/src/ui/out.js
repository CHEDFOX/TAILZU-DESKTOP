// Printing: lines, Xode's boxes, plans, progress, and errors (always with secrets taken out).

"use strict";

const { painter } = require("./paint");
const { termOf } = require("./term");
const { boxLines } = require("./box");
const { planLines } = require("./plan");
const { stageLine, activityLine } = require("./progress");
const { redact } = require("../api/redact");

function createOut({ stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
  const term = termOf(stdout, env);
  const paint = painter(term.color);
  let input = null;
  const write = (text, stream = stdout) => (input ? input.print(text, stream) : stream.write(text + "\n"));
  const view = { term, paint };

  return {
    term,
    paint,
    /** Prints through the prompt from now on, so typing isn't broken by output. */
    attach(i) { input = i; },
    line(text = "") { write(text); },
    lines(list) { for (const l of list) write(l); },
    box(text, title) { for (const l of boxLines(text, { title, ...view })) write(l); },
    plan(plan, o = {}) { for (const l of planLines(plan, { ...view, ...o })) write(l); },
    stage(i) { write(stageLine(i, view)); },
    activity(text) { write(activityLine(text, view)); },
    note(text) { write(paint.dim(text)); },
    good(text) { write(paint.green(text)); },
    warn(text) { write(paint.yellow(text)); },
    /** An error, on stderr, with any secret taken out. */
    error(text) { write(paint.red(redact(text)), stderr); },
  };
}

module.exports = { createOut };
