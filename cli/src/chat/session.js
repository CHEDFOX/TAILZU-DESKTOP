// A chat with Xode about one project, the way the app's Xode chat goes (tulmi/src/experience/bots/screens/codeWork/flow.ts):
// talk the plan over (POST /say), approve it by its version (POST /approve), then follow the job it starts.
//
// `first`: a one-shot run (xode "fix the cart rounding") sends it as the first message and ends with the job.
// When a job ends with work to show, its branch comes into the folder (work/afterJob.js).

"use strict";

const { flowApi } = require("./flowApi");
const { jobsApi } = require("./jobsApi");
const { openGate } = require("./gate");
const { followJob, reportEnd } = require("./follow");
const { isOver } = require("./stages");
const { threadFor } = require("./thread");
const { saveFolderState } = require("../state/folders");
const { afterJob, hasWork } = require("../work/afterJob");

const yes = (a) => /^\s*y(es)?\s*$/i.test(a || "");
const HELP = [
  "Type a message to talk the plan over with Xode.",
  "  /approve   approve the plan as it stands",
  "  /plan      show the plan",
  "  /exit      leave (Ctrl+C at the prompt too)",
];

/** Runs the chat; resolves the exit code. */
async function runSession({ client, server, cwd, env, input, out, project, userId, first = "", fresh = false, pollMs }) {
  const flow = flowApi(client, project.id);
  const jobs = jobsApi(client);
  const thread = threadFor({ server, cwd, projectId: project.id, userId, fresh, env });
  const oneShot = !!first;
  const ctx = { jobs, flow, thread, input, out, pollMs };
  let quitting = false;
  let inFlight = null;
  const quit = new AbortController();

  input.onInterrupt(() => {
    quitting = true;
    quit.abort();
    if (inFlight) inFlight.abort();
    input.close();
  });

  out.line(out.paint.bold("Xode") + out.paint.dim(` · ${project.name}`));
  let r;
  try {
    r = await openGate({ flow, thread, input, out, pollMs, signal: quit.signal });
  } catch (err) {
    if (quitting) return 0;
    throw err;
  }
  let plan = r.plan;
  let offeredV = null;

  /** Follows a job to its end. Resolves an exit code when the run should end, or null to go on chatting. */
  async function follow(jobId, o = {}) {
    // A new job here: what the last one brought back (afterJob.js) no longer describes it.
    saveFolderState(server, cwd, { projectId: project.id, jobId, lastBranch: "", lastPr: "" }, env);
    const res = await followJob(ctx, jobId, o);
    if (res.state === "detached") return 130;
    const bring = hasWork(res.state, res.view);
    const code = reportEnd(res, out, { prLater: bring });
    if (bring) await afterJob({ state: res.state, view: res.view, project, out, server, env });
    if (res.state === "stopped") return code;
    try { plan = (await flow.plan(thread)).plan || plan; } catch { /* the next message fetches it */ }
    return oneShot ? code : null;
  }

  async function approve(p) {
    let res;
    try {
      res = await flow.approve(thread, p.v);
    } catch (err) {
      if (err.code === "plan_changed") {
        out.warn(err.message);
        plan = (await flow.plan(thread)).plan;
        if (plan) out.plan(plan);
        return null;
      }
      throw err;
    }
    plan = res.plan || plan;
    const jobId = res.job && res.job.job && res.job.job.id;
    if (!jobId) { out.note("Approved."); return null; }
    out.good("Approved. Xode is on it.");
    out.note("Type a message any time; Ctrl+C to stop the job.");
    return follow(jobId);
  }

  /** Shows the plan and asks for its yes. */
  async function offer(p, o = {}) {
    out.line("");
    out.plan(p, o);
    offeredV = p.v;
    const a = await input.ask("Approve? (y/n) ");
    if (a === null) return 0;
    if (yes(a)) return approve(p);
    out.note("Tell Xode what you'd like instead, or type /approve later.");
    return null;
  }

  async function say(text) {
    out.note("Xode is thinking…");
    inFlight = new AbortController();
    let res;
    try {
      res = await flow.say(thread, text, { signal: inFlight.signal });
    } finally {
      inFlight = null;
    }
    if (res.answer) out.box(res.answer);
    if (res.mockup) out.note("Xode made a mockup for it: open X0 Bot to see it.");
    plan = res.plan || plan;
    if (plan && plan.status === "proposed" && plan.steps && plan.steps.length) {
      if (res.changed || plan.v !== offeredV) return offer(plan);
      out.note("The plan is the same. Type /approve to start it.");
    }
    return null;
  }

  try {
    // A job already going in this chat: follow it first.
    if (plan && plan.status === "working" && r.job && r.job.job && !isOver(r.job.job.state)) {
      out.note("Xode is already working on this chat's plan. Following it.");
      const code = await follow(r.job.job.id, { resume: true });
      if (code !== null) return code;
    }
    if (oneShot) {
      const code = await say(first);
      if (code !== null) return code;
    } else if (plan && plan.status === "proposed" && plan.steps && plan.steps.length) {
      const code = await offer(plan, { opening: true });
      if (code !== null) return code;
    } else {
      out.note("Tell Xode what you want to do next. /help for more.");
    }

    for (;;) {
      const line = await input.ask("> ");
      if (line === null || quitting) return 0;
      const t = line.trim();
      if (!t) continue;
      let code = null;
      try {
        if (t === "/exit" || t === "/quit") return 0;
        if (t === "/help") { out.lines(HELP); continue; }
        if (t === "/plan") { if (plan) out.plan(plan, { opening: true }); else out.note("There is no plan yet."); continue; }
        if (t === "/approve") {
          if (plan && plan.status === "proposed" && plan.steps && plan.steps.length) code = await approve(plan);
          else out.note("There is no plan waiting for a yes.");
        } else {
          code = await say(t);
        }
      } catch (err) {
        if (quitting) return 0;
        out.error(err.message);
        if (err.code === "signed_out") return 1;
      }
      if (code !== null) return code;
    }
  } catch (err) {
    if (quitting && (err.code === "cancelled" || !err.status)) return 0;
    throw err;
  }
}

module.exports = { runSession };
