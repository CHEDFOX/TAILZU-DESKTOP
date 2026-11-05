// Following a job until it ends: a line per stage, short lines for what it does, its questions answered inline, messages typed
// meanwhile sent to it (judged against the plan: POST /work), and Ctrl+C to stop it.
//
// Live frames from the job's room when there is one; otherwise GET /v1/code/jobs/:id and its /log every ~1.5 s. With the room open,
// the job itself is still read every few seconds, for its questions and its end (the room's frames carry neither).

"use strict";

const { stageOf, isOver } = require("./stages");
const { logLine, toolLine } = require("./activity");
const { needOf, settleNeed } = require("./needs");
const { watchJob } = require("./live");
const { sleep } = require("../util/sleep");

const yes = (a) => /^\s*y(es)?\s*$/i.test(a || "");

/**
 * Resolves { state, view }: state is the job's own ("done", "failed", "cancelled"), or "stopped" (stopped here with Ctrl+C), or
 * "detached" (Ctrl+C twice: the job goes on).
 * ctx: { jobs, flow?, thread?, input, out, pollMs }. o.resume: the job was already running (show only its last few lines).
 */
async function followJob(ctx, jobId, o = {}) {
  const { jobs, flow, thread, input, out } = ctx;
  const pollMs = ctx.pollMs || 1500;
  let stage = -1;
  let lastSeq = o.resume ? null : 0;
  let need = null;
  let ending = null;
  let wakeCtl = new AbortController();
  const nudge = () => wakeCtl.abort();
  let live = null;
  let liveTries = 0;
  let liveSeen = false;
  let view = null;
  let misses = 0;
  let skipOld = false;

  const setStage = (i) => {
    if (i >= 0 && i < 5 && i !== stage) { stage = i; out.stage(i); }
  };

  const onEvent = (f) => {
    switch (f.t) {
      case "snapshot": {
        const phases = (Array.isArray(f.events) ? f.events : []).filter((e) => e && e.t === "phase");
        if (phases.length) setStage(stageOf(phases[phases.length - 1].phase, "running"));
        break;
      }
      case "phase": setStage(stageOf(f.phase, "running")); break;
      case "tool": { const l = toolLine(f); if (l) out.activity(l); break; }
      case "result": if (f.ok === false && f.brief) out.activity(`That didn't work: ${f.brief}`); break;
      case "session": if (f.state === "closed") nudge(); break;
      case "end": nudge(); break;
      default: break;
    }
  };

  // Messages typed while it works go to the plan's judge (or straight to the job when there is no chat).
  let chain = Promise.resolve();
  const sendWork = (text) => {
    const said = String(text || "").trim();
    if (!said) return;
    chain = chain.then(async () => {
      try {
        if (!flow || !thread) { await jobs.message(jobId, said); out.note("Sent to Xode."); return; }
        const r = await flow.work(thread, said);
        if (r.say) out.box(r.say);
        if (r.kind === "change" && r.plan) {
          out.plan(r.plan);
          const a = await input.ask("Approve the change? (y/n) ");
          if (yes(a)) { await flow.approve(thread, r.plan.v); out.note("Xode will follow the new plan."); }
          else if (a !== null) out.note("Kept the plan as it was.");
        }
        if (r.artifact) out.note("Xode made a mockup for it: open X0 Bot to see it.");
        if (r.stop) {
          const a = await input.ask("Stop the job? (y/n) ");
          if (yes(a)) { await jobs.stop(jobId); out.line("Stopping the job."); nudge(); }
        }
      } catch (err) {
        out.error(err.message);
      }
    });
  };

  // Ctrl+C: ask, then stop; twice: leave it running.
  let confirming = null;
  const prevInterrupt = input.onInterrupt(async () => {
    if (confirming) {
      ending = "detached";
      confirming.cancel();
      out.line("");
      out.note("The job goes on. Run xode stop to stop it.");
      nudge();
      return;
    }
    out.line("");
    confirming = input.ask("Stop the job? (y/n) ");
    const a = await confirming;
    confirming = null;
    if (ending) return;
    if (yes(a)) {
      // The end report says it ("The job was stopped."), once.
      try { await jobs.stop(jobId); } catch (err) { out.error(err.message); }
      ending = "stopped";
      nudge();
    } else {
      out.note("Following the job again.");
    }
  });
  input.setIdle(sendWork, "> ");

  try {
    for (;;) {
      if (ending) return { state: ending, view };
      if (!live && liveTries < (liveSeen ? 3 : 1)) {
        liveTries += 1;
        live = await watchJob(jobs, jobId, { onEvent, onClose: () => { live = null; nudge(); } });
        // The room says what it does from here; should it drop, the log picks up after what is there now.
        if (live) { liveSeen = true; skipOld = true; }
      }
      try {
        view = await jobs.get(jobId);
        misses = 0;
      } catch (err) {
        if (err.code === "signed_out" || err.status === 404 || ++misses > 8) throw err;
        await sleep(pollMs * 2);
        continue;
      }
      const job = view.job || {};
      // Polling: the log's new lines (once the room has dropped, an ended job's lines were already shown by it).
      if (!live && job.agent !== false && !(liveSeen && isOver(job.state))) await printLog();
      if (!isOver(job.state)) setStage(stageOf(view.agent && view.agent.phase, job.state));

      const n = needOf(view);
      if (n && (!need || need.key !== n.key)) {
        if (need) need.h.cancel();
        const h = settleNeed(n, { jobId, jobs, input, out });
        need = { key: n.key, h };
        h.done.then(() => nudge());
      } else if (!n && need) {
        need.h.cancel();
        need = null;
      }

      if (isOver(job.state)) {
        if (ending) return { state: ending, view };
        return { state: job.state, view };
      }
      await sleep(live ? pollMs * 4 : pollMs, wakeCtl.signal);
      if (wakeCtl.signal.aborted) wakeCtl = new AbortController();
    }
  } finally {
    if (live) live.close();
    if (need) need.h.cancel();
    if (confirming) confirming.cancel();
    input.setIdle(null);
    input.onInterrupt(prevInterrupt);
  }

  async function printLog() {
    let entries;
    try { entries = (await jobs.log(jobId)).entries; } catch { return; }
    if (!Array.isArray(entries)) return;
    const fresh = entries.filter((e) => e && typeof e.seq === "number" && (lastSeq === null || e.seq > lastSeq));
    // Joining a job that was already going: only its last few lines.
    const show = skipOld ? [] : lastSeq === null ? fresh.slice(-3) : fresh;
    skipOld = false;
    for (const e of show) { const l = logLine(e); if (l) out.activity(l); }
    if (entries.length) lastSeq = Math.max(lastSeq || 0, ...entries.map((e) => (typeof e.seq === "number" ? e.seq : 0)));
    else if (lastSeq === null) lastSeq = 0;
  }
}

/**
 * Says how the job ended: its summary and pull request, or that it failed or was stopped. Resolves the exit code.
 * o.prLater: the pull request is said after the work branch is brought into the folder (work/afterJob.js), not here.
 */
function reportEnd(result, out, o = {}) {
  const view = result.view || {};
  const job = view.job || {};
  const agent = view.agent || {};
  const report = agent.report || {};
  const pr = report.prUrl || (agent.pr && agent.pr.url) || "";
  out.line("");
  if (result.state === "done") {
    out.box(report.text || "The work is done.", "Done");
    if (pr && !o.prLater) out.good(`Pull request: ${pr}`);
    return 0;
  }
  if (result.state === "failed") {
    const why = job.reason || report.text || "it stopped before it finished";
    out.line(out.paint.red(`The job failed: ${why.replace(/\.$/, "")}.`));
    if (pr && !o.prLater) out.line(`Pull request (draft): ${pr}`);
    return 1;
  }
  if (result.state === "cancelled" || result.state === "stopped") {
    out.line("The job was stopped.");
    return result.state === "stopped" ? 130 : 1;
  }
  return 130;
}

module.exports = { followJob, reportEnd };
