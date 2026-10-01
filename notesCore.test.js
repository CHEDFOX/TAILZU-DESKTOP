const test = require("node:test");
const assert = require("node:assert");
const { verdict, createQueue, worthSending, elapsed } = require("./notesCore.js");

const noSleep = () => Promise.resolve();

test("answers are read the same way everywhere", () => {
  assert.equal(verdict(200), "done");
  assert.equal(verdict(202), "done");
  assert.equal(verdict(429, '{"code":"quota_exceeded"}'), "quota");
  assert.equal(verdict(429, "rate limited"), "retry");
  assert.equal(verdict(401), "auth");
  assert.equal(verdict(409), "gone");
  assert.equal(verdict(413), "skip");
  assert.equal(verdict(503), "retry");
  assert.equal(verdict(0), "retry");
});

test("uploads go one at a time, in order, and a failure is retried", async () => {
  const seen = [];
  let fails = 2;
  const q = createQueue({
    sleep: noSleep,
    send: async (job) => {
      seen.push(job.n);
      if (job.n === 1 && fails-- > 0) throw new Error("offline");
      return { status: 200 };
    },
  });
  const outs = await Promise.all([q.push({ n: 1 }), q.push({ n: 2 }), q.push({ n: 3 })]);
  assert.deepEqual(seen, [1, 1, 1, 2, 3]);
  assert.ok(outs.every((o) => o.ok));
  await q.drain();
  assert.equal(q.pending, 0);
});

test("a spent token is renewed once; a second refusal ends the note's uploads", async () => {
  let renewals = 0;
  const statuses = [401, 200];
  const q = createQueue({ sleep: noSleep, renew: async () => { renewals++; }, send: async () => ({ status: statuses.shift() }) });
  assert.equal((await q.push({})).ok, true);
  assert.equal(renewals, 1);

  let fatal = null;
  const q2 = createQueue({ sleep: noSleep, renew: async () => {}, send: async () => ({ status: 401 }), onFatal: (k) => { fatal = k; } });
  const out = await q2.push({});
  assert.equal(out.fatal, "auth");
  assert.equal(fatal, "auth");
});

test("out of words stops everything still queued, and later pushes", async () => {
  let fatal = null;
  const q = createQueue({
    sleep: noSleep,
    send: async (job) => ({ status: job.n === 1 ? 429 : 200, body: "quota_exceeded" }),
    onFatal: (k) => { fatal = k; },
  });
  const [a, b] = await Promise.all([q.push({ n: 1 }), q.push({ n: 2 })]);
  assert.equal(a.fatal, "quota");
  assert.equal(b.fatal, "quota");
  assert.equal(fatal, "quota");
  assert.equal((await q.push({ n: 3 })).fatal, "quota");
});

test("a stretch that is refused on its own is skipped, and the next still goes", async () => {
  const q = createQueue({ sleep: noSleep, send: async (job) => ({ status: job.n === 1 ? 413 : 200 }) });
  const [a, b] = await Promise.all([q.push({ n: 1 }), q.push({ n: 2 })]);
  assert.equal(a.skipped, true);
  assert.equal(b.ok, true);
});

test("silence is not sent, and the clock reads like a clock", () => {
  assert.equal(worthSending(399, 400), false);
  assert.equal(worthSending(400, 400), true);
  assert.equal(elapsed(5), "0:05");
  assert.equal(elapsed(605), "10:05");
  assert.equal(elapsed(3729), "1:02:09");
});
