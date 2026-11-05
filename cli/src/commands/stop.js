// xode stop: stops the job running in this folder (the last one started here, from state.json).

"use strict";

const { createClient } = require("../api/client");
const { hostOf } = require("../config");
const { folderState } = require("../state/folders");
const { isOver } = require("../chat/stages");

async function stop({ server, store, out, cwd, env }) {
  const token = await store.get(hostOf(server));
  if (!token) { out.error("Not signed in: run xode login"); return 1; }
  const st = folderState(server, cwd, env);
  if (!st.jobId) { out.line("No job is running in this folder."); return 0; }
  const client = createClient({ server, token });
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

module.exports = { stop };
