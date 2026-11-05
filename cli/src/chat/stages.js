// The five stages a person sees, from the job's own phase. The same mapping as the app's job screen
// (tulmi/src/botsCodeWork/read.ts stageOf, used by experience/bots/screens/codeWork/job.ts).

"use strict";

const STAGES = ["Understand", "Plan", "Build", "Check", "Ship"];
const ENDED = new Set(["done", "failed", "cancelled"]);

/** The stage index for an agent phase and a job state: 0..4, or 5 once the job is done. */
function stageOf(phase, state) {
  if (state === "done") return 5;
  switch (phase) {
    case "plan": case "split": return 1;
    case "work": case "team": return 2;
    case "verify": case "design": return 3;
    case "commit": case "pr": case "report": return 4;
    case "done": return 5;
    default: return 0;
  }
}

const isOver = (state) => ENDED.has(state);

module.exports = { STAGES, stageOf, isOver };
