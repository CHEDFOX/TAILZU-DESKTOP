#!/usr/bin/env node
// A pretend X0 Bot server for watching a session by hand: the sign-in approves itself after a few seconds, and the job takes
// about half a minute, with a question on the way. Everything is made up; nothing leaves this computer.
//
// It also makes a project folder to run xode in: a clone of ana/storefront whose "GitHub" is a bare repository in a temporary
// folder (test/gitFixture.js). When the job ends, its work branch is pushed there, so the branch comes back into the folder.
//
//   node dev/demo-server.js 4545
//   cd <the folder it prints>
//   XODE_SERVER=http://127.0.0.1:4545 node <this package>/bin/xode.js        (signs in first: approved by itself)
//
// --no-live leaves the live room off, so the terminal polls instead.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createFakeServer, defaultScript } = require("../test/fakeServer");
const { makeRepos, WORK } = require("../test/gitFixture");

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

// The project's folder, and its "GitHub", in a temporary folder that goes when the demo does.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "xode-demo-"));
const repos = makeRepos(root, { withBranch: false });
let pushes = 0;
const pushWork = (job) => {
  pushes += 1;
  try {
    repos.addWork(pushes === 1 ? WORK : { "NOTES.md": `What job ${pushes} changed.\n` }, pushes === 1 ? "Round the total once" : `Job ${pushes}`);
    console.log(`demo: pushed ${job.branch} to the folder's "GitHub"`);
  } catch (err) {
    console.log(`demo: couldn't push ${job.branch}: ${err.message.split("\n")[0]}`);
  }
};

createFakeServer({
  port, live, script: slow, stepMs: 1800, sayDelayMs: 1500, pollMs: 1000, pollHoldMs: 1500, approveAfterPolls: 3,
  onApproved: (name) => console.log(`demo: approved the sign-in for ${name}`),
  onSay: (text) => console.log(`demo: heard "${text.slice(0, 60)}"`),
  onJobEnd: pushWork,
}).then((s) => {
  const bin = path.resolve(__dirname, "..", "bin", "xode.js");
  console.log(`Demo server on ${s.url}${live ? " (live room on)" : " (polling)"}`);
  console.log(`  cd ${repos.work}`);
  console.log(`  XODE_SERVER=${s.url} node ${bin}`);
  const bye = () => s.close().then(() => { fs.rmSync(root, { recursive: true, force: true }); process.exit(0); });
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
});
