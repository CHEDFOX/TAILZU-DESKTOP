// node --test
//
// The allow list (allow.js): which projects may run on this computer. None may until the person allows it here: the first offer for a
// project nobody answered about says "ask" (once), later ones "asked"; a project the person said "Don't allow" to is never run and is
// left out of the hello, as is one waiting for an answer; forgetting what was said puts it back to not allowed.

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

test("a project nobody said anything about is not allowed: asked once, nothing written until the person answers", async () => {
  const r = rig();
  assert.strictEqual(r.list.state("p1"), "ask");
  assert.strictEqual(await r.list.check({ projectId: "p1", name: "acme/app" }), "ask", "the first offer asks");
  assert.strictEqual(await r.list.check({ projectId: "p1", name: "acme/app" }), "asked", "later ones do not ask again");
  assert.deepStrictEqual(r.writes, [], "nothing is kept for an unanswered project");
  assert.deepStrictEqual(r.list.list(), []);
  assert.deepStrictEqual(r.list.waiting(), [{ id: "p1", name: "acme/app" }]);
  r.list.decide("p1", "", true);
  assert.strictEqual(await r.list.check({ projectId: "p1" }), "allowed", "allowed once the person said so");
  assert.strictEqual(r.map.p1.name, "acme/app", "the name it asked with is kept");
  assert.deepStrictEqual(r.list.waiting(), []);
});

test("a project the person refused is denied, every time, and one allowed before is allowed", async () => {
  const r = rig({ initial: { no: { name: "acme/no", allowed: false, at: 1 }, yes: { name: "acme/yes", allowed: true, at: 2 } } });
  assert.strictEqual(await r.list.check({ projectId: "no", name: "acme/no" }), "denied");
  assert.strictEqual(await r.list.check({ projectId: "no", name: "acme/no" }), "denied");
  assert.strictEqual(await r.list.check({ projectId: "yes", name: "acme/yes" }), "allowed");
});

test("what is kept on disk can be edited by hand: an entry that is not an object, or has no yes or no, is no answer (ask)", async () => {
  const r = rig({ initial: { odd: "nope", half: { name: "acme/half" } } });
  assert.strictEqual(r.list.state("odd"), "ask");
  assert.strictEqual(r.list.state("half"), "ask", "only an explicit yes allows");
  assert.strictEqual(r.list.helloProjects(["odd", "half"]), "all", "nothing asked yet: the first offer is what asks");
});

test("the person can change their mind: refuse, allow again, forget; the list is newest first", () => {
  const r = rig();
  r.list.decide("a", "acme/a", true);
  r.list.decide("b", "acme/b", false);
  assert.deepStrictEqual(r.list.list().map((p) => [p.id, p.state]), [["b", "denied"], ["a", "allowed"]]);
  r.list.forget("b");
  assert.strictEqual(r.list.state("b"), "ask", "forgotten is back to the default: not allowed");
  r.list.decide("a", "acme/a", false);
  assert.strictEqual(r.list.state("a"), "denied");
  r.list.decide("a", "acme/a", true);
  assert.strictEqual(r.list.state("a"), "allowed");
  r.list.clear();
  assert.deepStrictEqual(r.list.list(), []);
  assert.strictEqual(r.list.state("a"), "ask");
});

test("the hello leaves out a refused project and one waiting for an answer, when the person's projects are known; otherwise it says all and the offer is declined here", async () => {
  const r = rig();
  assert.strictEqual(r.list.helloProjects(["a", "b", "c"]), "all", "nothing refused or waiting: all");
  r.list.decide("b", "acme/b", false);
  assert.deepStrictEqual(r.list.helloProjects(["a", "b", "c"]), ["a", "c"]);
  await r.list.check({ projectId: "c", name: "acme/c" });
  assert.deepStrictEqual(r.list.helloProjects(["a", "b", "c"]), ["a"], "a project waiting for an answer is not offered again");
  r.list.decide("c", "acme/c", true);
  assert.deepStrictEqual(r.list.helloProjects(["a", "b", "c"]), ["a", "c"]);
  assert.strictEqual(r.list.helloProjects([]), "all");
  assert.strictEqual(r.list.helloProjects(undefined), "all");
  assert.strictEqual(r.list.helloProjects(Array.from({ length: 300 }, (_, i) => "p" + i)).length, 200, "at most 200");
});
