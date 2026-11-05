// A plan as numbered steps: its goal, what changed, and (the first time) where the project stands and where it is heading.

"use strict";

const { wrapLine } = require("./wrap");
const { highlightRefs } = require("./refs");

/**
 * The lines for a plan (GET /v1/bots/code/flow/:project/plan → plan: { v, goal, state, direction, suggested, steps, status, change?, mockup? }).
 * o.opening: also say where it stands and where it heads (the first plan of a chat).
 */
function planLines(plan, { term, paint, opening = false }) {
  const W = term.tty ? term.width() : Infinity;
  const fit = (text, indent = 0, first = "") => (W === Infinity ? [first + text] : wrapLine(first + text, W, indent));
  const out = [];
  if (opening && plan.v === 1) {
    if (plan.state) { out.push(paint.dim("Where it stands")); out.push(...fit(plan.state, 2, "  ")); }
    if (plan.direction) { out.push(paint.dim(plan.suggested ? "Where it could go (Xode's suggestion)" : "Where you're taking it")); out.push(...fit(plan.direction, 2, "  ")); }
  }
  const head = plan.status === "done" ? "Done" : plan.v > 1 ? `The plan · version ${plan.v}` : "The plan";
  out.push(paint.bold(head));
  if (plan.goal) out.push(...fit(plan.goal, 2, "  ").map((l) => paint.bold(l)));
  if (plan.change) out.push(...fit(`Changed: ${plan.change}`, 2, "  ").map((l) => paint.dim(l)));
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const numW = String(steps.length).length;
  steps.forEach((s, i) => {
    const n = `  ${String(i + 1).padStart(numW)}. `;
    out.push(...fit(String(s), n.length, n).map((l, j) => (j === 0 ? paint.cyan(l.slice(0, n.length)) + highlightRefs(l.slice(n.length), paint) : highlightRefs(l, paint))));
  });
  if (plan.mockup) out.push(paint.dim("  A mockup was made for it: open X0 Bot to see it."));
  return out;
}

module.exports = { planLines };
