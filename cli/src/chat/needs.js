// When the job needs the person (state "waiting_for_you"): its question, or the yes it waits for, answered with a picker.
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

const OWN = "Type your own answer";

/**
 * Asks the person, with a picker (picker.js), and sends what they said. A question's own options come with a last one to
 * type an answer instead. Returns { done: Promise, cancel() }: cancel when the job stops waiting by itself (answered in the
 * app, say).
 */
function settleNeed(need, { jobId, jobs, input, out }) {
  let current = null;
  let cancelled = false;
  const pick = (title, options, o = {}) => { current = input.pick({ title, options, ...o }); return current; };
  const ask = (q, o) => { current = input.ask(q, o); return current; };
  const yesNo = async (q) => { const r = await pick(q, ["Yes", "No"]); return r === null || cancelled ? null : r === 0; };

  /** A two-step yes: the first call may come back as a question with an approvalId, to be sent again. */
  async function twoStep(call) {
    const r = await call();
    if (r && r.needsApproval && r.approvalId) {
      if (r.faceId) { out.warn("This one needs Face ID: say yes in X0 Bot on your phone."); return; }
      await call(r.approvalId);
    }
  }

  async function answer() {
    const options = need.options.length ? [...need.options, OWN] : [];
    for (;;) {
      let a = "";
      if (options.length) {
        const r = await pick(`Xode asks: ${need.question}`, options, { freeText: true });
        if (r === null || cancelled) return;
        if (typeof r === "string") a = r;
        else if (r < need.options.length) a = need.options[r];
        else {
          const t = await ask("Your answer: ", { escCancels: true });
          if (cancelled) return;
          if (t === null) { if (input.ended || input.closed) return; continue; }
          a = t.trim();
        }
      } else {
        out.warn(out.paint.bold("Xode asks: ") + need.question);
        const t = await ask("Your answer: ");
        if (t === null || cancelled) return;
        a = t.trim();
      }
      if (!a) continue;
      await jobs.answer(jobId, a);
      out.note(`Sent: ${a}`);
      return;
    }
  }

  const done = (async () => {
    try {
      if (need.kind === "answer") { await answer(); return; }
      if (need.kind === "other") { out.warn(need.question); return; }
      if (need.kind === "approval" && need.faceId) { out.warn(`${need.question} This one needs Face ID: say yes in X0 Bot on your phone.`); return; }
      const ok = await yesNo(need.question);
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

module.exports = { needOf, settleNeed, approvalLine, OWN };
