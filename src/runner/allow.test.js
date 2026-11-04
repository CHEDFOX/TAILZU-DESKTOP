// node --test
//
// The allow list (allow.js): which projects may run on this computer. Every project may by default, with nothing asked; a project the
// person said "Don't allow" to in the window is never run and is left out of the hello; allowing it again, or forgetting what was said,
// puts it back.

const test = require("node:test");
const assert = require("node:assert");
const { createAllowList } = require("./allow.js");

function rig(o = {}) {
  let map = o.initial || {};
  const writes = [];
  let clock = 1000;
  const list = createAllowList({
    read: () => map, write: (m) => { map = m; writes.push(JSON.parse(JSON.stringify(m))); },
    now: () => (clock += 1),
  });
  return { list, writes, get map() { return map; } };
}

test("a project nobody said anything about is allowed, with no question and nothing written", async () => {
  const r = rig();
  assert.strictEqual(r.list.state("p1"), "allowed");
  assert.strictEqual(await r.list.check({ projectId: "p1", name: "acme/app" }), "allowed");
  assert.deepStrictEqual(r.writes, [], "nothing is kept for the default");
  assert.deepStrictEqual(r.list.list(), []);
});

test("a project the person refused is denied, every time, and one allowed before is allowed", async () => {
  const r = rig({ initial: { no: { name: "acme/no", allowed: false, at: 1 }, yes: { name: "acme/yes", allowed: true, at: 2 } } });
  assert.strictEqual(await r.list.check({ projectId: "no", name: "acme/no" }), "denied");
  assert.strictEqual(await r.list.check({ projectId: "no", name: "acme/no" }), "denied");
  assert.strictEqual(await r.list.check({ projectId: "yes", name: "acme/yes" }), "allowed");
});

test("what is kept on disk can be edited by hand: an entry that is not an object is no entry (allowed)", async () => {
  const r = rig({ initial: { odd: "nope", half: { name: "acme/half" } } });
  assert.strictEqual(r.list.state("odd"), "allowed");
  assert.strictEqual(r.list.state("half"), "allowed", "only an explicit no refuses");
  assert.strictEqual(r.list.helloProjects(["odd", "half"]), "all");
});

test("the person can change their mind: refuse, allow again, forget; the list is newest first", () => {
  const r = rig();
  r.list.decide("a", "acme/a", true);
  r.list.decide("b", "acme/b", false);
  assert.deepStrictEqual(r.list.list().map((p) => [p.id, p.state]), [["b", "denied"], ["a", "allowed"]]);
  r.list.forget("b");
  assert.strictEqual(r.list.state("b"), "allowed", "forgotten is back to the default");
  r.list.decide("a", "acme/a", false);
  assert.strictEqual(r.list.state("a"), "denied");
  r.list.decide("a", "acme/a", true);
  assert.strictEqual(r.list.state("a"), "allowed");
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
