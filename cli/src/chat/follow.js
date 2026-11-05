// Following a job until it ends, quietly: one short line when its stage changes ("● Build"), a dim line for each thing it
// does, and under them the status line (statusBar.js: spinner, stage, time, "esc to stop"). Its questions and yeses come up as
// pickers (needs.js). Messages typed meanwhile, Esc and leaving are the session's (session.js).
//
// Live frames from the job's room when there is one; otherwise GET /v1/code/jobs/:id and its /log every ~1.5 s. With the room
// open, the job itself is still read every few seconds, for its questions and its end (the room's frames carry neither).

"use strict";

const { stageOf, isOver, STAGES } = require("./stages");
const { logLine, toolLine } = require("./activity");
const { needOf, settleNeed } = require("./needs");
const { watchJob } = require("./live");
const { sleep } = require("../util/sleep");

const DAY = 24 * 60 * 60_000;

/**
 * Starts following job `jobId`. Returns { done, stop(), detach() }: done resolves { state, view } once it ends, where state is
 * the job's own ("done", "failed", "cancelled"), or "detached" (left running: detach(), or a question with no one to answer it).
 * ctx: { jobs (or a getter: the sign-in can change), input, out, bar, pollMs }. o.resume: the job was already going (show only
 * its last few lines).
 */
function followJob(ctx, jobId, o = {}) {
  const { input, out, bar } = ctx;
  const jobs = () => ctx.jobs;
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
  let since = 0;

  const setStage = (i) => {
    if (i >= 0 && i < 5 && i !== stage) {
      stage = i;
      out.stage(i);
      if (bar) bar.update({ word: STAGES[i] });
    }
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

  async function printLog() {
    let entries;
    try { entries = (await jobs().log(jobId)).entries; } catch { return; }
    if (!Array.isArray(entries)) return;
    const fresh = entries.filter((e) => e && typeof e.seq === "number" && (lastSeq === null || e.seq > lastSeq));
    // Joining a job that was already going: only its last few lines.
    const show = skipOld ? [] : lastSeq === null ? fresh.slice(-3) : fresh;
    skipOld = false;
    for (const e of show) { const l = logLine(e); if (l) out.activity(l); }
    if (entries.length) lastSeq = Math.max(lastSeq || 0, ...entries.map((e) => (typeof e.seq === "number" ? e.seq : 0)));
    else if (lastSeq === null) lastSeq = 0;
  }

  async function loop() {
    if (bar) bar.show({ word: "Starting", since: Date.now(), tail: "esc to stop" });
    for (;;) {
      if (ending) return { state: ending, view };
      if (!live && liveTries < (liveSeen ? 3 : 1)) {
        liveTries += 1;
        live = await watchJob(jobs(), jobId, { onEvent, onClose: () => { live = null; nudge(); } });
        // The room says what it does from here; should it drop, the log picks up after what is there now.
        if (live) { liveSeen = true; skipOld = true; }
        if (ending) return { state: ending, view };
      }
      try {
        view = await jobs().get(jobId);
        misses = 0;
      } catch (err) {
        if (err.code === "signed_out" || err.status === 404 || ++misses > 8) throw err;
        await sleep(pollMs * 2, wakeCtl.signal);
        if (wakeCtl.signal.aborted) wakeCtl = new AbortController();
        continue;
      }
      if (ending) return { state: ending, view };
      const job = view.job || {};
      // The time on the status line counts from when the job was made (when the server's clock says something sensible).
      if (!since) {
        const made = Number(job.createdAt);
        since = Number.isFinite(made) && made <= Date.now() && Date.now() - made < DAY ? made : Date.now();
        if (bar) bar.update({ since });
      }
      // Polling: the log's new lines (once the room has dropped, an ended job's lines were already shown by it).
      if (!live && job.agent !== false && !(liveSeen && isOver(job.state))) await printLog();
      if (!isOver(job.state)) setStage(stageOf(view.agent && view.agent.phase, job.state));

      const n = needOf(view);
      if (n && (!need || need.key !== n.key)) {
        if (need) need.h.cancel();
        // Nobody left to answer (the input has ended): the job goes on without this terminal.
        if (input.ended || input.closed) return { state: "detached", view };
        if (bar) bar.pause();
        const h = settleNeed(n, { jobId, jobs: jobs(), input, out });
        need = { key: n.key, h };
        h.done.then(() => { if (bar && !ending) bar.resume(); nudge(); });
      } else if (!n && need) {
        need.h.cancel();
        need = null;
      }

      if (isOver(job.state)) return { state: job.state, view };
      await sleep(live ? pollMs * 4 : pollMs, wakeCtl.signal);
      if (wakeCtl.signal.aborted) wakeCtl = new AbortController();
    }
  }

  const done = loop().finally(() => {
    if (live) live.close();
    if (need) need.h.cancel();
    if (bar) bar.hide();
  });

  return {
    done,
    jobId,
    /** Stops the job (POST /stop); the end it reaches says so. */
    async stop() {
      try { await jobs().stop(jobId); } finally { nudge(); }
    },
    /** Stops following; the job goes on. */
    detach() { ending = "detached"; nudge(); },
  };
}

/**
 * Says how the job ended: its summary and pull request, or that it failed or was stopped.
 * o.prLater: the pull request is said after the work branch is brought into the folder (work/afterJob.js), not here.
 */
function reportEnd(result, out, o = {}) {
  const view = result.view || {};
  const job = view.job || {};
  const agent = view.agent || {};
  const report = agent.report || {};
  const pr = report.prUrl || (agent.pr && agent.pr.url) || "";
  if (result.state === "done") {
    out.box(report.text || "The work is done.", "Done");
    if (pr && !o.prLater) out.good(`Pull request: ${pr}`);
    return;
  }
  if (result.state === "failed") {
    const why = job.reason || report.text || "it stopped before it finished";
    out.line(out.paint.red(`The job failed: ${why.replace(/\.$/, "")}.`));
    if (pr && !o.prLater) out.line(`Pull request (draft): ${pr}`);
    return;
  }
  if (result.state === "cancelled") out.line("The job was stopped.");
}

module.exports = { followJob, reportEnd };
