// The Xode flow's routes (tulmi/src/routes/bots/botsXode.ts), the same calls the app's Xode chat makes.

"use strict";

function flowApi(client, projectId) {
  const base = `/v1/bots/code/flow/${encodeURIComponent(projectId)}`;
  const long = { timeoutMs: 180_000 };
  return {
    /** { gate: { open, reading: { status, pct, phase }, vision: "given" | "skipped" | "missing" } } */
    gate: () => client.get(`${base}/gate`),
    /** The owner's direction, or { skip: true } to let Xode suggest one. */
    vision: (body) => client.post(`${base}/vision`, body, long),
    /** { gate, plan, job }: the chat's plan (made the first time), and its job when it is being worked on. */
    plan: (thread) => client.get(`${base}/plan?thread=${encodeURIComponent(thread)}`, long),
    /** Before the work: { answer, next, plan, changed, mockup? } */
    say: (thread, text, o = {}) => client.post(`${base}/say`, { thread, text }, { ...long, ...o }),
    /** The plan's yes, by its version: { plan, job } */
    approve: (thread, v) => client.post(`${base}/approve`, { thread, v }, long),
    /** While the work goes on: { kind, say, plan?, affects?, artifact?, stop? } */
    work: (thread, text) => client.post(`${base}/work`, { thread, text }, long),
  };
}

module.exports = { flowApi };
