/**
 * The note-taker's logic that is not audio: what to upload, in what order, and
 * what to do when an upload fails. Loaded by notes.html (as TailzuNotes) and by
 * the tests (as a module), so the rules are checked without a microphone.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.TailzuNotes = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /** What an answer means for a job: done, worth another try, or the end of
   *  the note's uploads (out of words, signed out, the note gone). */
  function verdict(status, body) {
    if (status >= 200 && status < 300) return "done";
    if (status === 429 && String(body || "").indexOf("quota_exceeded") !== -1) return "quota";
    if (status === 401) return "auth";
    if (status === 403 || status === 404 || status === 409) return "gone";
    if (status === 400 || status === 413) return "skip";   // this stretch only; the next may be fine
    return "retry";                                        // 5xx, 429 rate limit, network
  }

  /**
   * Uploads, one at a time, in the order they were queued, each retried with a
   * growing wait. One at a time because the server appends each stretch to the
   * note: in order is in order, and a slow upload never lets a later stretch
   * overtake it.
   *
   * send(job) → Promise<{ status, body }> (a throw is a network failure).
   * renew() → Promise: called once on a 401 before the job is tried again.
   * onFatal(kind) → the note can take no more: "quota", "auth" or "gone".
   */
  function createQueue(opts) {
    const tries = opts.tries || 5;
    const backoff = opts.backoffMs || 1500;
    const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const jobs = [];
    let running = null, dead = null;
    const waiters = [];

    async function runOne(job) {
      let renewed = false;
      for (let i = 0; i < tries; i++) {
        let r;
        try { r = await opts.send(job); } catch (e) { r = { status: 0, body: String(e && e.message || e) }; }
        const v = verdict(r.status, r.body);
        if (v === "done") return { ok: true, result: r };
        if (v === "skip") return { ok: false, skipped: true };
        if (v === "auth" && !renewed && opts.renew) { renewed = true; await opts.renew(); i--; continue; }
        if (v !== "retry") return { ok: false, fatal: v === "auth" ? "auth" : v };
        await sleep(backoff * Math.pow(2, i));
      }
      return { ok: false, gaveUp: true };
    }

    async function pump() {
      while (jobs.length && !dead) {
        const job = jobs.shift();
        const out = await runOne(job);
        if (job.done) job.done(out);
        if (out.fatal) {
          dead = out.fatal;
          jobs.splice(0).forEach((j) => j.done && j.done({ ok: false, fatal: dead }));
          if (opts.onFatal) opts.onFatal(dead);
        }
      }
      running = null;
      waiters.splice(0).forEach((w) => w());
    }

    return {
      /** Queue a job; resolves with how it ended. */
      push(job) {
        return new Promise((resolve) => {
          if (dead) { resolve({ ok: false, fatal: dead }); return; }
          jobs.push(Object.assign({}, job, { done: resolve }));
          if (!running) running = pump();
        });
      },
      /** Everything queued so far has ended. */
      drain() {
        if (!running && !jobs.length) return Promise.resolve();
        return new Promise((r) => waiters.push(r));
      },
      get dead() { return dead; },
      get pending() { return jobs.length + (running ? 1 : 0); },
    };
  }

  /** A stretch worth sending: someone spoke in it for at least `minMs`. */
  function worthSending(voicedMs, minMs) { return voicedMs >= (minMs == null ? 400 : minMs); }

  /** "4:05", "1:02:09" — how long the note has run. */
  function elapsed(sec) {
    const t = Math.max(0, Math.floor(sec));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    const two = (n) => (n < 10 ? "0" : "") + n;
    return h ? h + ":" + two(m) + ":" + two(s) : m + ":" + two(s);
  }

  return { verdict, createQueue, worthSending, elapsed };
});
