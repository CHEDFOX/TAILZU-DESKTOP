// Before the chat: Xode has to have read the project, and know where the owner wants to take it (or be told to suggest).
// GET /v1/bots/code/flow/:project/plan answers { gate, plan: null } until then; the direction is POST .../vision.

"use strict";

const { sleep } = require("../util/sleep");

/** Resolves { gate, plan, job } once the gate is open. Throws a sentence when it can't open from here. */
async function openGate({ flow, thread, input, out, pollMs = 1500, signal }) {
  let r = await flow.plan(thread);
  let said = "";
  while (!r.gate || !r.gate.open) {
    const g = r.gate || { reading: { status: "", pct: 0, phase: "" }, vision: "missing" };
    if (g.vision === "missing") {
      out.line("Where do you want to take this project? Your vision, the direction, what comes next.");
      out.note("Xode plans every piece of work toward it. Press Enter to let Xode suggest one.");
      const a = await input.ask("Your direction: ");
      if (a === null) throw new Error("No direction was given.");
      await flow.vision(a.trim() ? { vision: a.trim() } : { skip: true });
      out.note(a.trim() ? "Saved." : "Xode will suggest a direction.");
    } else if (g.reading && g.reading.status === "failed") {
      throw new Error("Xode couldn't read this project. Open X0 Bot to try again.");
    } else {
      const words = `Xode is reading the project (${(g.reading && g.reading.pct) || 0}%${g.reading && g.reading.phase ? `, ${g.reading.phase}` : ""}).`;
      if (words !== said) { out.note(words); said = words; }
      await sleep(Math.max(pollMs * 3, 50), signal);
      if (signal && signal.aborted) throw Object.assign(new Error("Cancelled."), { code: "cancelled" });
    }
    r = await flow.plan(thread);
  }
  return r;
}

module.exports = { openGate };
