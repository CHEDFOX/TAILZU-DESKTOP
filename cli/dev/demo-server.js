#!/usr/bin/env node
// A pretend X0 Bot server for watching a session by hand: the sign-in approves itself after a few seconds, and the job takes
// about half a minute, with a question on the way. Everything is made up; nothing leaves this computer.
//
//   node dev/demo-server.js 4545
//   XODE_SERVER=http://127.0.0.1:4545 node bin/xode.js login
//   XODE_SERVER=http://127.0.0.1:4545 node bin/xode.js "fix the cart rounding"
//
// --no-live leaves the live room off, so the terminal polls instead.

"use strict";

const { createFakeServer, defaultScript } = require("../test/fakeServer");

const port = Number(process.argv[2]) || 4545;
const live = !process.argv.includes("--no-live");

// The same work as the tests, at a person's pace, with a few more things done along the way.
const slow = [];
for (const step of defaultScript()) {
  slow.push({ ...step, ms: step.done ? 2500 : step.question ? 2000 : 1800 });
  if (step.phase === "locate") slow.push({ phase: "locate", ms: 1500, log: { kind: "read", text: "Read the cart's lines", files: ["src/cart/line.ts"] }, tool: { name: "grep", brief: "round(" } });
  if (step.phase === "work" && step.tool && step.tool.name === "edit_file") slow.push({ phase: "work", ms: 2200, log: { kind: "edit", text: "Keep line prices whole", files: ["src/cart/line.ts"], data: { action: "edit" } }, tool: { name: "edit_file", brief: "src/cart/line.ts" } });
  if (step.phase === "verify") slow.push({ phase: "verify", ms: 2500, log: { kind: "command", text: "npm run typecheck", data: { kind: "typecheck", summary: "no errors", exitCode: 0 } }, tool: { name: "run", brief: "npm run typecheck" } });
}

createFakeServer({
  port, live, script: slow, stepMs: 1800, sayDelayMs: 1500, pollMs: 1000, pollHoldMs: 1500, approveAfterPolls: 3,
  onApproved: (name) => console.log(`demo: approved the sign-in for ${name}`),
  onSay: (text) => console.log(`demo: heard "${text.slice(0, 60)}"`),
}).then((s) => {
  console.log(`Demo server on ${s.url}${live ? " (live room on)" : " (polling)"}`);
  console.log(`  XODE_SERVER=${s.url} node bin/xode.js login`);
  console.log(`  XODE_SERVER=${s.url} node bin/xode.js "fix the cart rounding"`);
  const bye = () => s.close().then(() => process.exit(0));
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
});
