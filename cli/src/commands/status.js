// xode status, and /status: who is signed in, on which device and server, and the job of this folder (the repository's top
// folder, as xode keeps it): where it is, or how it ended, with its work branch and pull request. /status also says the
// project and what this computer is doing.

"use strict";

const { createClient } = require("../api/client");
const { hostOf } = require("../config");
const { folderState } = require("../state/folders");
const { folderOf } = require("../state/folderOf");
const { stageOf, isOver, STAGES } = require("../chat/stages");
const { prOf } = require("../work/afterJob");

const STATE_WORDS = {
  queued: "waiting to start", running: "working", waiting_for_compute: "waiting for a computer", waiting_for_you: "waiting for you",
  paused: "paused", done: "done", failed: "failed", cancelled: "stopped",
};

/**
 * Prints the report. Resolves the exit code. extra: lines to put after the server's (the project, this computer).
 */
async function report({ client, server, cwd, env, out, extra = [] }) {
  let d;
  try { d = await client.get("/v1/auth/device"); } catch (err) { out.error(err.message); return 1; }
  const u = d.user || {};
  out.line(u.email || u.name ? `Signed in as ${u.email || u.name}` : "Signed in");
  out.line(`Device: ${d.name || "this computer"}`);
  out.line(`Server: ${server}`);
  for (const l of extra) out.line(l);

  const st = folderState(server, cwd, env);
  if (!st.jobId) return 0;
  try {
    const v = await client.get(`/v1/code/jobs/${encodeURIComponent(st.jobId)}`);
    const job = v.job || {};
    const words = STATE_WORDS[job.state] || job.state || "unknown";
    const task = String(job.task || "").split("\n")[0].slice(0, 70);
    if (isOver(job.state)) {
      const pr = prOf(v) || st.lastPr || "";
      const branch = st.lastBranch || "";
      out.line(`Last job here: ${words}${task ? ` · ${task}` : ""}`);
      if (branch) out.line(`Work branch: ${branch}`);
      if (pr) out.line(`Pull request: ${pr}`);
    } else {
      const s = Math.min(stageOf(v.agent && v.agent.phase, job.state), 4);
      out.line(`Job here: ${words} · stage ${s + 1} of 5, ${STAGES[s]}${task ? ` · ${task}` : ""}`);
    }
  } catch (err) {
    if (err.status !== 404) out.note(`The job of this folder couldn't be read: ${err.message}`);
    // What was kept when it ended, so the branch and the pull request can still be found.
    if (st.lastBranch) out.line(`Work branch: ${st.lastBranch}`);
    if (st.lastPr) out.line(`Pull request: ${st.lastPr}`);
  }
  return 0;
}

async function status({ server, store, out, cwd: here, env }) {
  const token = await store.get(hostOf(server));
  if (!token) { out.line("Not signed in. Run xode."); out.line(`Server: ${server}`); return 1; }
  return report({ client: createClient({ server, token }), server, cwd: await folderOf(here), env, out });
}

module.exports = { status, report };
