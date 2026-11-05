// xode status: who is signed in, on which device and server, and the job of this folder.

"use strict";

const { createClient } = require("../api/client");
const { hostOf } = require("../config");
const { folderState } = require("../state/folders");
const { stageOf, isOver, STAGES } = require("../chat/stages");

const STATE_WORDS = {
  queued: "waiting to start", running: "working", waiting_for_compute: "waiting for a computer", waiting_for_you: "waiting for you",
  paused: "paused", done: "done", failed: "failed", cancelled: "stopped",
};

async function status({ server, store, out, cwd, env }) {
  const token = await store.get(hostOf(server));
  if (!token) { out.line("Not signed in. Run xode login."); out.line(`Server: ${server}`); return 1; }
  const client = createClient({ server, token });
  let d;
  try { d = await client.get("/v1/auth/device"); } catch (err) { out.error(err.message); return 1; }
  const u = d.user || {};
  out.line(u.email || u.name ? `Signed in as ${u.email || u.name}` : "Signed in")
  out.line(`Device: ${d.name || "this computer"}`);
  out.line(`Server: ${server}`);

  const st = folderState(server, cwd, env);
  if (!st.jobId) return 0;
  try {
    const v = await client.get(`/v1/code/jobs/${encodeURIComponent(st.jobId)}`);
    const job = v.job || {};
    const words = STATE_WORDS[job.state] || job.state || "unknown";
    const task = String(job.task || "").split("\n")[0].slice(0, 70);
    if (isOver(job.state)) {
      const pr = (v.agent && ((v.agent.report && v.agent.report.prUrl) || (v.agent.pr && v.agent.pr.url))) || "";
      out.line(`Last job here: ${words}${task ? ` · ${task}` : ""}`);
      if (pr) out.line(`Pull request: ${pr}`);
    } else {
      const s = Math.min(stageOf(v.agent && v.agent.phase, job.state), 4);
      out.line(`Job here: ${words} · stage ${s + 1} of 5, ${STAGES[s]}${task ? ` · ${task}` : ""}`);
    }
  } catch (err) {
    if (err.status !== 404) out.note(`The job of this folder couldn't be read: ${err.message}`);
  }
  return 0;
}

module.exports = { status };
