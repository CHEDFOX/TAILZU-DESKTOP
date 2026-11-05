// A job's routes (tulmi/src/routes/code/codeJobs.ts).

"use strict";

function jobsApi(client) {
  const p = (id, tail = "") => `/v1/code/jobs/${encodeURIComponent(id)}${tail}`;
  return {
    /** { job, steps, agent? } */
    get: (id, o) => client.get(p(id), o),
    /** { entries: [{ seq, at, kind, text, files?, data? }] } */
    log: (id, o) => client.get(p(id, "/log"), o),
    answer: (id, answer) => client.post(p(id, "/answer"), { answer }),
    /** A yes: first a question { needsApproval, approvalId, faceId, ... }, then the same with approvalId. */
    approve: (id, approvalId) => client.post(p(id, "/approve"), approvalId ? { approvalId } : {}),
    deny: (id) => client.post(p(id, "/deny"), {}),
    commitOk: (id, approvalId) => client.post(p(id, "/commit-ok"), approvalId ? { approvalId } : {}),
    computeOk: (id) => client.post(p(id, "/compute-ok"), {}),
    budget: (id, addPaise) => client.post(p(id, "/budget"), { addPaise }),
    message: (id, text) => client.post(p(id, "/message"), { text }),
    stop: (id) => client.post(p(id, "/stop"), {}),
    /** { url, ticket, expiresAt }: a pass to watch the job's room over a WebSocket. 404 live_off where there is none. */
    live: (id) => client.post(p(id, "/live"), {}),
  };
}

module.exports = { jobsApi };
