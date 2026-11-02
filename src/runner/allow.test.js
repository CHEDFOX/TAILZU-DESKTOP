// node --test
//
// The allow list (allow.js): which projects may run on this computer. Asked the first time, once at a time, remembered; a project never
// answered is not run; a project refused is left out of the hello; an answer that comes after the job gave up is still kept for the next.

const test = require("node:test");
const assert = require("node:assert");
const { createAllowList } = require("./allow.js");

function rig(o = {}) {
  let map = o.initial || {};
  const asked = [];
  const answers = [];
  const writes = [];
  let clock = 1000;
  const list = createAllowList({
    read: () => map, write: (m) => { map = m; writes.push(JSON.parse(JSON.stringify(m))); },
    ask: (p) => { asked.push(p); return new Promise((resolve) => answers.push(resolve)); },
    waitMs: o.waitMs === undefined ? 30 : o.waitMs, now: () => (clock += 1),
  });
  return { list, asked, answers, writes, get map() { return map; } };
}

test("a project nobody has answered for is asked about, and the answer is kept", async () => {
  const r = rig();
  assert.strictEqual(r.list.state("p1"), "ask");
  const pending = r.list.check({ projectId: "p1", name: "acme/app" });
  await new Promise((res) => setImmediate(res));
  assert.deepStrictEqual(r.asked, [{ projectId: "p1", name: "acme/app" }]);
  r.answers[0](true);
  assert.strictEqual(await pending, "allowed");
  assert.strictEqual(r.list.state("p1"), "allowed");
  assert.strictEqual(r.map.p1.name, "acme/app");
  // Not asked again.
  assert.strictEqual(await r.list.check({ projectId: "p1", name: "acme/app" }), "allowed");
  assert.strictEqual(r.asked.length, 1);
});

test("a refusal is kept too, and a refused project is never run and never asked about again", async () => {
  const r = rig();
  const pending = r.list.check({ projectId: "p2", name: "acme/secret" });
  await new Promise((res) => setImmediate(res));
  r.answers[0](false);
  assert.strictEqual(await pending, "denied");
  assert.strictEqual(await r.list.check({ projectId: "p2", name: "acme/secret" }), "denied");
  assert.strictEqual(r.asked.length, 1);
});

test("a project that was allowed before is allowed with no question; one the person closed the question on stays unanswered", async () => {
  const r = rig({ initial: { old: { name: "acme/old", allowed: true, at: 1 } } });
  assert.strictEqual(await r.list.check({ projectId: "old", name: "acme/old" }), "allowed");
  assert.strictEqual(r.asked.length, 0);
  const pending = r.list.check({ projectId: "later", name: "acme/later" });
  await new Promise((res) => setImmediate(res));
  r.answers[0](null);
  assert.strictEqual(await pending, "waiting");
  assert.strictEqual(r.list.state("later"), "ask");
  assert.deepStrictEqual(Object.keys(r.map), ["old"]);
});

test("a job does not wait for ever for the answer, and an answer that comes late is kept for the next job", async () => {
  const r = rig({ waitMs: 20 });
  const first = await r.list.check({ projectId: "p3", name: "acme/slow" });
  assert.strictEqual(first, "waiting");
  assert.strictEqual(r.list.state("p3"), "ask");
  r.answers[0](true);
  await new Promise((res) => setTimeout(res, 20));
  assert.strictEqual(r.list.state("p3"), "allowed");
  assert.strictEqual(await r.list.check({ projectId: "p3", name: "acme/slow" }), "allowed");
});

test("two offers for the same project while the question is open share it: one question", async () => {
  const r = rig({ waitMs: 200 });
  const a = r.list.check({ projectId: "p4", name: "acme/x" });
  const b = r.list.check({ projectId: "p4", name: "acme/x" });
  await new Promise((res) => setImmediate(res));
  assert.strictEqual(r.asked.length, 1);
  assert.strictEqual(r.list.asking, 1);
  r.answers[0](true);
  assert.deepStrictEqual(await Promise.all([a, b]), ["allowed", "allowed"]);
  assert.strictEqual(r.list.asking, 0);
});

test("a question that throws is no answer", async () => {
  const list = createAllowList({ read: () => ({}), write() {}, ask: async () => { throw new Error("no window"); }, waitMs: 50 });
  assert.strictEqual(await list.check({ projectId: "p5", name: "x" }), "waiting");
});

test("the person can change their mind: allow, refuse, ask again; the list is newest first", () => {
  const r = rig();
  r.list.decide("a", "acme/a", true);
  r.list.decide("b", "acme/b", false);
  assert.deepStrictEqual(r.list.list().map((p) => [p.id, p.state]), [["b", "denied"], ["a", "allowed"]]);
  r.list.forget("a");
  assert.strictEqual(r.list.state("a"), "ask");
  r.list.clear();
  assert.deepStrictEqual(r.list.list(), []);
});

test("the hello leaves out a refused project, when the person's projects are known; otherwise it says all and the refusal is enforced at the offer", () => {
  const r = rig();
  assert.strictEqual(r.list.helloProjects(["a", "b", "c"]), "all", "nothing refused: all");
  r.list.decide("b", "acme/b", false);
  assert.deepStrictEqual(r.list.helloProjects(["a", "b", "c"]), ["a", "c"]);
  assert.strictEqual(r.list.helloProjects([]), "all");
  assert.strictEqual(r.list.helloProjects(undefined), "all");
  assert.strictEqual(r.list.helloProjects(Array.from({ length: 300 }, (_, i) => "p" + i)).length, 200, "at most 200");
});
