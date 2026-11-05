// After a job: its work branch into the folder (bringBack.js), then its pull request, and both remembered for xode status.
//
// The server's fields (GET /v1/code/jobs/:id, tulmi/src/routes/code/codeJobs.ts): job.branch is the work branch; the pull request is
// agent.pr.url, or agent.report.prUrl once the job has reported; agent.commits, the commits it pushed.

"use strict";

const { bringBack } = require("./bringBack");
const { saveFolderState } = require("../state/folders");

/** The job's pull request link, or "". */
function prOf(view) {
  const agent = (view && view.agent) || {};
  const url = (agent.report && agent.report.prUrl) || (agent.pr && agent.pr.url) || "";
  return typeof url === "string" && /^https:\/\//i.test(url) ? url : "";
}

/** The job's work branch, or "". */
function branchOf(view) {
  const b = view && view.job && view.job.branch;
  return typeof b === "string" ? b : "";
}

/** Is there work to bring back? A job that is done; or one that failed after it pushed (a pull request, or commits). */
function hasWork(state, view) {
  if (!branchOf(view)) return false;
  if (state === "done") return true;
  if (state !== "failed") return false;
  const agent = (view && view.agent) || {};
  return !!prOf(view) || (Array.isArray(agent.commits) && agent.commits.length > 0);
}

/**
 * Brings the work into the folder and prints the pull request. `project`: { top, remote, repo, defaultBranch } (resolve.js);
 * `state`: how the job ended. Resolves what bringBack said, or null when there was nothing to bring.
 */
async function afterJob({ state, view, project, out, server, env }) {
  if (!hasWork(state, view)) return null;
  const branch = branchOf(view);
  const pr = prOf(view);
  let r = null;
  if (project.top && project.remote && project.repo) {
    r = await bringBack({ top: project.top, remote: project.remote.name, branch, base: project.defaultBranch, out });
  } else {
    out.line(`The work is on branch ${branch}.`);
  }
  if (pr) out.line(out.paint.bold(`${state === "done" ? "Pull request" : "Pull request (draft)"}: ${pr}`));
  if (server && project.top) {
    try { saveFolderState(server, project.top, { lastBranch: branch, lastPr: pr }, env); } catch { /* status just won't show it */ }
  }
  return r;
}

module.exports = { afterJob, prOf, branchOf, hasWork };
