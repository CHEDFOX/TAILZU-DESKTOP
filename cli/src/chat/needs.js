// When the job needs the person (state "waiting_for_you"): its question, answered inline, or the yes it waits for.
// The same choices as the app's job screen (tulmi/src/experience/bots/screens/codeWork/job.ts quickQuestion).

"use strict";

/** What a job view ({ job, agent }) waits on, or null. */
function needOf(view) {
  const job = view && view.job;
  if (!job || job.state !== "waiting_for_you") return null;
  const w = (view.agent && view.agent.waiting) || {};
  const on = job.waitingOn || (w.kind === "question" ? "answer" : w.kind) || "";
  if (on === "answer" || w.kind === "question") {
    const question = w.question || job.reason || "Xode has a question.";
    const options = (Array.isArray(w.options) ? w.options : []).filter((x) => typeof x === "string" && x.trim()).slice(0, 5);
    return { key: `answer|${question}`, kind: "answer", question, options };
  }
  if (on === "approval" || w.kind === "approval") {
    return { key: `approval|${w.action || ""}|${job.updatedAt || ""}`, kind: "approval", question: approvalLine(w.action || "", w.summary || {}), faceId: !!w.faceId };
  }
  if (on === "budget" || w.kind === "budget") {
    const more = (view.agent && view.agent.report && view.agent.report.continueWithPaise) || Math.max(1000, Math.round((job.spentPaise || 0) / 200) * 100);
    return { key: "budget", kind: "budget", question: "This job has used a lot of what it was given. Keep going?", more };
  }
  if (on === "paid") return { key: "paid", kind: "paid", question: job.reason || "No free computer is free. Use paid compute for this job?" };
  if (on === "commit") return { key: `commit|${job.updatedAt || ""}`, kind: "commit", question: job.reason || "Okay to commit what it made?" };
  return { key: `other|${job.reason || ""}`, kind: "other", question: job.reason || "Xode is waiting for you in X0 Bot." };
}

/** The words for a yes the agent asks for (tulmi/src/botsCodeWork/read.ts approvalLineOf). */
function approvalLine(action, summary) {
  const t = typeof summary.title === "string" ? summary.title : typeof summary.text === "string" ? summary.text : "";
  if (t.trim()) return t.trim().slice(0, 140);
  if (action === "job.plan") return "Go ahead with this plan?";
  if (!action) return "Okay to go ahead?";
  return `Okay to ${action.replace(/^[a-z]+\./, "").replace(/[._-]+/g, " ")}?`;
}

const yes = (a) => /^\s*y(es)?\s*$/i.test(a || "");

/**
 * Asks the person and sends what they said. Returns { done: Promise, cancel() }: cancel when the job stops waiting by itself
 * (answered in the app, say).
 */
function settleNeed(need, { jobId, jobs, input, out }) {
  let current = null;
  let cancelled = false;
  const ask = (q) => { current = input.ask(q); return current; };

  async function yesNo(q) {
    for (;;) {
      const a = await ask(`${q} (y/n) `);
      if (a === null || cancelled) return null;
      if (yes(a)) return true;
      if (/^\s*no?\s*$/i.test(a)) return false;
      out.note("Type y or n.");
    }
  }

  /** A two-step yes: the first call may come back as a question with an approvalId, to be sent again. */
  async function twoStep(call) {
    const r = await call();
    if (r && r.needsApproval && r.approvalId) {
      if (r.faceId) { out.warn("This one needs Face ID: say yes in X0 Bot on your phone."); return; }
      await call(r.approvalId);
    }
  }

  const done = (async () => {
    try {
      if (need.kind === "answer") {
        out.line("");
        out.warn(out.paint.bold("Xode asks: ") + need.question);
        need.options.forEach((o, i) => out.line(`  ${out.paint.cyan(String(i + 1))}. ${o}`));
        for (;;) {
          const a = await ask(need.options.length ? "Your answer (a number, or your own words): " : "Your answer: ");
          if (a === null || cancelled) return;
          const n = Number(a.trim());
          const answer = need.options.length && Number.isInteger(n) && n >= 1 && n <= need.options.length ? need.options[n - 1] : a.trim();
          if (!answer) continue;
          await jobs.answer(jobId, answer);
          out.note(`Sent: ${answer}`);
          return;
        }
      }
      if (need.kind === "other") { out.warn(need.question); return; }
      if (need.kind === "approval" && need.faceId) { out.warn(`${need.question} This one needs Face ID: say yes in X0 Bot on your phone.`); return; }
      out.line("");
      const ok = await yesNo(out.paint.yellow(need.question));
      if (ok === null) return;
      if (need.kind === "approval") {
        if (ok) { await twoStep((id) => jobs.approve(jobId, id)); out.note("Going ahead."); } else { await jobs.deny(jobId); out.note("Told Xode no."); }
      } else if (need.kind === "commit") {
        if (ok) { await twoStep((id) => jobs.commitOk(jobId, id)); out.note("Committing."); } else { await jobs.stop(jobId); out.note("Stopped the job."); }
      } else if (need.kind === "paid") {
        if (ok) { await jobs.computeOk(jobId); out.note("Going on with paid compute."); } else { await jobs.stop(jobId); out.note("Stopped the job."); }
      } else if (need.kind === "budget") {
        if (ok) { await jobs.budget(jobId, need.more); out.note("Going on."); } else { await jobs.stop(jobId); out.note("Stopped the job."); }
      }
    } catch (err) {
      // 409 not_waiting: it was settled somewhere else in the meantime.
      if (err.code !== "not_waiting") out.error(err.message);
    }
  })();

  return {
    done,
    cancel() { cancelled = true; if (current && current.cancel) current.cancel(); },
  };
}

module.exports = { needOf, settleNeed, approvalLine };
