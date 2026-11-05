// xode stop, and /stop when the session isn't following a job: stops the job running in this folder (the last one started
// here, from state.json).

"use strict";

const { createClient } = require("../api/client");
const { hostOf } = require("../config");
const { folderState } = require("../state/folders");
const { folderOf } = require("../state/folderOf");
const { isOver } = require("../chat/stages");

/** Stops this folder's job with `client`. Resolves the exit code (said already). */
async function stopHere({ client, server, cwd, env, out }) {
  const st = folderState(server, cwd, env);
  if (!st.jobId) { out.line("No job is running in this folder."); return 0; }
  const path = `/v1/code/jobs/${encodeURIComponent(st.jobId)}`;
  try {
    const v = await client.get(path);
    if (v.job && isOver(v.job.state)) { out.line("No job is running in this folder."); return 0; }
    await client.post(`${path}/stop`, {});
    out.line("Stopped the job.");
    return 0;
  } catch (err) {
    if (err.status === 404) { out.line("No job is running in this folder."); return 0; }
    out.error(err.message);
    return 1;
  }
}

async function stop({ server, store, out, cwd: here, env }) {
  const token = await store.get(hostOf(server));
  if (!token) { out.error("Not signed in: run xode"); return 1; }
  return stopHere({ client: createClient({ server, token }), server, cwd: await folderOf(here), env, out });
}

module.exports = { stop, stopHere };
