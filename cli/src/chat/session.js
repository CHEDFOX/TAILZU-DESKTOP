// A session with Xode about one project, the way the app's Xode chat goes (tulmi/src/experience/bots/screens/codeWork/flow.ts):
// talk it over (POST /say), start the plan with a picker (POST /approve, by its version), then follow the job it starts while
// the prompt stays open. When a job ends with work to show, its branch comes into the folder (work/afterJob.js), and the
// session goes on until the person leaves.
//
// At the prompt: a message (to /say, or to /work while a job runs), a "/" command (slash.js), a "!" command (shell.js, kept
// for the next message). Keys: controls.js. Leaving never stops a job.

"use strict";

const { createClient } = require("../api/client");
const { flowApi } = require("./flowApi");
const { jobsApi } = require("./jobsApi");
const { openGate } = require("./gate");
const { followJob, reportEnd } = require("./follow");
const { isOver } = require("./stages");
const { threadFor } = require("./thread");
const { createControls } = require("./controls");
const { parseSlash, helpLines } = require("./slash");
const { runShell, withAttachments } = require("./shell");
const { branchDiff } = require("./diff");
const { createStatusBar } = require("../ui/statusBar");
const { folderState, saveFolderState } = require("../state/folders");
const { afterJob, hasWork } = require("../work/afterJob");
const { stateWords } = require("../computer/statusLine");
const { report } = require("../commands/status");
const { stopHere } = require("../commands/stop");
const { signIn } = require("../commands/login");
const { logout } = require("../commands/logout");

const KEEPS_WORKING = "Xode keeps working. Run xode here to follow it.";
const proposed = (p) => !!(p && p.status === "proposed" && Array.isArray(p.steps) && p.steps.length);

/**
 * Runs the session; resolves the exit code.
 * o: { client, server, cwd, env, input, out, project, userId, first, fresh, pollMs, store, computer() (the runner's handle or
 * null), onSignedIn(token) (after /login) }
 */
async function runSession(o) {
  const { server, cwd, env, input, out, project, userId, pollMs, store } = o;
  let client = o.client;
  let flow = flowApi(client, project.id);
  let jobs = jobsApi(client);
  let thread = threadFor({ server, cwd, projectId: project.id, userId, fresh: !!o.fresh, env });
  const bar = createStatusBar({ input, paint: out.paint });
  const followCtx = { get jobs() { return jobs; }, input, out, bar, pollMs };

  let plan = null;
  let offeredV = null;
  let job = null; // { id, handle, over, ended }
  let thinking = null; // the AbortController of a message in flight
  let running = null; // a "!" command
  let attachments = [];
  let leaving = false;
  let exitCode = 0;
  const quit = new AbortController();

  function leave() {
    if (leaving) return;
    leaving = true;
    quit.abort();
    if (thinking) thinking.abort();
    if (running) running.kill();
    input.cancelAll();
    input.stopWaiting();
  }

  input.onInterrupt(createControls({
    input,
    busy: () => !!thinking || !!running,
    cancel: () => { if (thinking) thinking.abort(); if (running) running.kill(); },
    job: () => !!(job && !job.over),
    stopJob: () => { stopJob(); },
    leave,
  }));

  // ------------------------------------------------------------------ the job

  /** How a job ended, and its branch into the folder; remembered, so it is said once. */
  async function ended(res) {
    saveFolderState(server, cwd, { endSeen: true }, env);
    const bring = hasWork(res.state, res.view);
    reportEnd(res, out, { prLater: bring });
    if (bring) await afterJob({ state: res.state, view: res.view, project, out, server, env });
  }

  /** The job this folder last started, when it ended while nobody was following it: said now, and its work brought in. */
  async function endedMeanwhile() {
    const st = folderState(server, cwd, env);
    if (!st.jobId || st.endSeen !== false) return;
    let view;
    try { view = await jobs.get(st.jobId); } catch { return; }
    if (!view || !view.job || !isOver(view.job.state)) return;
    out.note("The job started here ended while you were away.");
    await ended({ state: view.job.state, view });
  }

  function startFollow(jobId, f = {}) {
    // A new job here: what the last one brought back (afterJob.js) no longer describes it.
    saveFolderState(server, cwd, { projectId: project.id, jobId, lastBranch: "", lastPr: "", endSeen: false }, env);
    const me = { id: jobId, over: false, handle: followJob(followCtx, jobId, f) };
    me.ended = me.handle.done.then(async (res) => {
      me.over = true;
      // Left running: by leaving (said as xode ends), or with nobody left to answer its question.
      if (res.state === "detached") { if (!leaving) out.line(KEEPS_WORKING); return; }
      await ended(res);
      try { plan = (await flow.plan(thread)).plan || plan; } catch { /* the next message fetches it */ }
    }).catch((err) => {
      me.over = true;
      if (leaving) return;
      out.error(err.message);
      if (err.code === "signed_out") { exitCode = 1; leave(); }
    }).finally(() => { if (job === me) job = null; });
    job = me;
  }

  async function stopJob() {
    if (!job || job.over) return;
    out.note("Stopping the job…");
    try { await job.handle.stop(); } catch (err) { out.error(err.message); }
  }

  // ------------------------------------------------------------------ talking

  async function approve(p) {
    let res;
    try {
      res = await flow.approve(thread, p.v);
    } catch (err) {
      if (err.code === "plan_changed") {
        out.warn(err.message);
        plan = (await flow.plan(thread)).plan;
        if (plan) out.plan(plan);
        return;
      }
      throw err;
    }
    plan = res.plan || plan;
    const jobId = res.job && res.job.job && res.job.job.id;
    if (!jobId) { out.note("Approved."); return; }
    startFollow(jobId);
  }

  /** Shows the plan (unless shown already) and asks whether to start it. */
  async function offer(p, f = {}) {
    if (!f.shown) { out.line(""); out.plan(p, f); }
    offeredV = p.v;
    const r = await input.pick({ title: "Start this plan?", options: ["Yes", "No, tell Xode what to change"] });
    if (r === 0 && !leaving) await approve(p);
  }

  /** Sends what is to go with a message, and forgets it once sent. */
  async function sending(text, send) {
    const kept = attachments;
    const r = await send(withAttachments(text, kept));
    attachments = attachments.filter((a) => !kept.includes(a));
    return r;
  }

  async function say(text) {
    thinking = new AbortController();
    bar.show({ word: "Thinking", since: Date.now(), tail: "esc to cancel" });
    let res;
    try {
      res = await sending(text, (body) => flow.say(thread, body, { signal: thinking.signal }));
    } catch (err) {
      if (err.code === "cancelled") { if (!leaving) out.note("Cancelled."); return; }
      throw err;
    } finally {
      thinking = null;
      bar.hide();
    }
    if (res.answer) out.box(res.answer);
    if (res.mockup) out.note("Xode made a mockup for it: open X0 Bot to see it.");
    plan = res.plan || plan;
    if (proposed(plan)) {
      if (res.changed || plan.v !== offeredV) await offer(plan);
      else out.note("The plan is the same: /plan to start it.");
    }
  }

  /** A message while the job works: judged against the plan (POST /work). */
  async function work(text) {
    const r = await sending(text, (body) => flow.work(thread, body));
    if (r.say) out.box(r.say);
    if (r.kind === "change" && r.plan) {
      out.plan(r.plan);
      const c = await input.pick({ title: "Use the new plan?", options: ["Yes", "No, keep the plan as it was"] });
      if (c === 0) { await flow.approve(thread, r.plan.v); out.note("Xode will follow the new plan."); }
    }
    if (r.artifact) out.note("Xode made a mockup for it: open X0 Bot to see it.");
    if (r.stop) {
      const c = await input.pick({ title: "Stop the job?", options: ["Yes", "No"] });
      if (c === 0) await stopJob();
    }
  }

  // ------------------------------------------------------------------ "!" and "/"

  async function shell(cmd) {
    if (!cmd) { out.note("Type a command after !, like !npm test"); return; }
    running = runShell(cmd, { cwd, env });
    bar.show({ word: `Running ${cmd.length > 30 ? cmd.slice(0, 29) + "…" : cmd}`, since: Date.now(), tail: "esc to stop" });
    let r;
    try { r = await running.done; } finally { running = null; bar.hide(); }
    if (r.hidden > 0) out.note(`… ${r.hidden} earlier lines`);
    for (const l of r.shown) out.note(l);
    out.note(`exit ${r.code} (attached to your next message)`);
    attachments.push(r.attachment);
  }

  async function slash(text) {
    const c = parseSlash(text);
    if (c.list || c.name === "help") { out.lines(helpLines(out.paint)); return; }
    if (c.unknown) { out.line("Unknown command. /help lists them."); return; }
    switch (c.name) {
      case "exit": leave(); return;
      case "clear": {
        if (job) { out.note("A job is running here: /clear once it has ended."); return; }
        thread = threadFor({ server, cwd, projectId: project.id, userId, fresh: true, env });
        plan = null;
        offeredV = null;
        attachments = [];
        // The server makes a chat's first plan when it is first asked for it.
        plan = (await openGate({ flow, thread, input, out, pollMs, signal: quit.signal })).plan;
        out.note("A fresh chat for this folder.");
        return;
      }
      case "plan": {
        try { plan = (await flow.plan(thread)).plan || plan; } catch (err) { out.error(err.message); }
        if (!plan) { out.note("There is no plan yet. Tell Xode what you want."); return; }
        out.plan(plan, { opening: true });
        if (proposed(plan) && !job) await offer(plan, { shown: true });
        return;
      }
      case "approve": {
        if (proposed(plan) && !job) await approve(plan);
        else out.note("There is no plan waiting for a yes.");
        return;
      }
      case "diff": {
        const st = folderState(server, cwd, env);
        const r = await branchDiff({ top: cwd, remote: project.remote ? project.remote.name : "origin", branch: st.lastBranch, base: project.defaultBranch, paint: out.paint });
        if (r.lines) out.lines(r.lines);
        else out.note(r.message);
        return;
      }
      case "status": {
        const comp = o.computer ? o.computer() : null;
        let here = "not offered";
        try { if (comp) here = stateWords(comp.runner.status(), project.name); } catch { /* not offered */ }
        await report({ client, server, cwd, env, out, extra: [`Project: ${project.name}`, `This computer: ${here}`] });
        return;
      }
      case "stop": {
        if (job && !job.over) await stopJob();
        else await stopHere({ client, server, cwd, env, out });
        return;
      }
      case "login": {
        const r = await signIn({ server, store, out, input });
        if (!r.token) return;
        client = createClient({ server, token: r.token });
        flow = flowApi(client, project.id);
        jobs = jobsApi(client);
        if (o.onSignedIn) o.onSignedIn(r.token);
        return;
      }
      case "logout": {
        await logout({ server, store, out });
        leave();
        return;
      }
      default: out.line("Unknown command. /help lists them.");
    }
  }

  async function handle(text) {
    const t = text.trim();
    if (t.startsWith("/")) return slash(t);
    if (t.startsWith("!")) return shell(t.slice(1).trim());
    if (job && !job.over) return work(text.trim());
    return say(text.trim());
  }

  // ------------------------------------------------------------------ the session

  try {
    let r;
    try {
      r = await openGate({ flow, thread, input, out, pollMs, signal: quit.signal });
    } catch (err) {
      if (leaving) return exitCode;
      throw err;
    }
    plan = r.plan;
    input.showPrompt(true);
    // A job already going in this chat: follow it.
    if (plan && plan.status === "working" && r.job && r.job.job && !isOver(r.job.job.state)) startFollow(r.job.job.id, { resume: true });
    else await endedMeanwhile();

    const first = String(o.first || "").trim();
    if (first) {
      input.print(out.paint.dim(">") + " " + first);
      try { await handle(first); } catch (err) { if (!leaving) { out.error(err.message); if (err.code === "signed_out") return 1; } }
    }

    while (!leaving) {
      const ev = await input.next();
      if (leaving) break;
      if (ev.type === "none") continue;
      if (ev.type === "end") {
        // Nothing more will be typed: what is under way finishes (a job to its end, unless it needs an answer), then xode ends.
        if (job) await job.ended;
        break;
      }
      try {
        await handle(ev.text);
      } catch (err) {
        if (leaving) break;
        out.error(err.message);
        if (err.code === "signed_out") { exitCode = 1; break; }
      }
    }
  } finally {
    bar.hide();
    input.showPrompt(false);
    if (job && !job.over) {
      job.handle.detach();
      out.line(KEEPS_WORKING);
    } else if (job) {
      // Its branch is coming back into the folder: that finishes first.
      await job.ended;
    }
  }
  return exitCode;
}

module.exports = { runSession, KEEPS_WORKING };
