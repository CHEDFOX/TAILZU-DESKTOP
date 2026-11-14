// node --test
//
// The data block: what the new callEndpoint options do, and what `subscribe` does with an event from the live
// socket. Nothing here reaches the network: the window's own api() stands in.
const test = require("node:test");
const assert = require("node:assert");
const { fakePage } = require("../../testkit.js");

/** A page on a screen that needs `data`, with api() written down and the action hook in place. */
function on(screen, api) {
  const page = fakePage();
  page.run("var __calls = []; var __fail = 0;");
  page.g.__api = api;
  page.run("api = function (path, body, method) { __calls.push([path, method]); return __api(path, body, method); };");
  page.run("repaint = function () {};");
  page.run("CURRENT_SCREEN = " + JSON.stringify(screen) + "; STATE = " + JSON.stringify(screen.state || {}) + ";");
  page.run('$("view").innerHTML = node(CURRENT_SCREEN.root); v2After();');
  return { page, calls: () => JSON.parse(page.run("JSON.stringify(__calls)")) };
}

const plain = { screenId: "s", needs: ["data", "expr"], state: {}, root: { type: "Text", props: { content: "x" } } };

test("a cached GET is asked for once while it is fresh", async () => {
  const p = on(plain, async () => ({ n: 1 }));
  const call = '{ kind: "callEndpoint", path: "/v1/stats", method: "GET", assignTo: "stats", cache: { key: "stats", ttlMs: 60000 } }';
  p.page.run("run(" + call + ")");
  await p.page.settle();
  p.page.run("run(" + call + ")");
  await p.page.settle();
  assert.strictEqual(p.calls().length, 1);
  assert.deepStrictEqual(JSON.parse(p.page.run("JSON.stringify(STATE.stats)")), { n: 1 });
});

test("a GET that fails is tried again, and a write is not", async () => {
  let tries = 0;
  const p = on(plain, async () => { tries += 1; if (tries < 3) throw new Error("no"); return { ok: true }; });
  p.page.run('run({ kind: "callEndpoint", path: "/v1/stats", method: "GET", retry: { times: 3, backoff: 1 } })');
  for (let i = 0; i < 6; i++) await p.page.settle(50);
  assert.strictEqual(tries, 3);
  tries = 0;
  const q = on(plain, async () => { tries += 1; throw new Error("no"); });
  q.page.run('run({ kind: "callEndpoint", path: "/v1/notes", method: "POST", retry: { times: 3, backoff: 1 } })');
  for (let i = 0; i < 6; i++) await q.page.settle(50);
  assert.strictEqual(tries, 1, "a write is never sent twice unless the screen says it is safe");
});

test("an optimistic value is put back when the call fails", async () => {
  const p = on(plain, async () => { throw new Error("no"); });
  p.page.run('STATE.liked = false;');
  p.page.run('run({ kind: "callEndpoint", path: "/v1/like", optimistic: { path: "liked", value: true } })');
  await p.page.settle(10);
  assert.strictEqual(p.page.run("STATE.liked"), false);
});

test("a path that is not ours is never called", async () => {
  const p = on(plain, async () => ({}));
  p.page.run('run({ kind: "callEndpoint", path: "https://evil.test/v1/x", retry: { times: 1 } })');
  await p.page.settle();
  assert.deepStrictEqual(p.calls(), []);
});

test("a `$t` path is filled, its holes encoded, and one that would climb is refused", async () => {
  const p = on({ screenId: "s", needs: ["data", "expr"], state: { note: { id: "n 1" } }, root: { type: "Text" } }, async () => ({}));
  p.page.run('run({ kind: "callEndpoint", path: { $t: "/v1/notes/{{ state.note.id }}" }, method: "GET", retry: { times: 0 } })');
  await p.page.settle();
  assert.deepStrictEqual(p.calls(), [["/v1/notes/n%201", "GET"]]);
  // An id of "../admin" encodes to %2E%2E%2F, which every URL this reaches reads back as "..": it never goes out.
  const q = on({ screenId: "s2", needs: ["data", "expr"], state: { note: { id: "../admin" } }, root: { type: "Text" } }, async () => ({}));
  q.page.run('run({ kind: "callEndpoint", path: { $t: "/v1/notes/{{ state.note.id }}" }, method: "GET", retry: { times: 0 } })');
  await q.page.settle();
  assert.deepStrictEqual(q.calls(), []);
});

test("subscribe writes what arrives where the screen asked, and nowhere else", () => {
  const p = on(plain, async () => ({}));
  p.page.run('run({ kind: "subscribe", topic: "job:7", into: "job" });');
  p.page.run('run({ kind: "subscribe", topic: "ask:7", into: "sneaky" });');
  p.page.run('v2LiveEvent("job:7", { data: { step: "running" } });');
  assert.deepStrictEqual(JSON.parse(p.page.run("JSON.stringify(STATE.job)")), { step: "running" });
  p.page.run('v2LiveEvent("ask:7", { data: "x" });');
  assert.strictEqual(p.page.run("STATE.sneaky"), undefined, "an answer's own stream is not a screen's to take");
});

test("an appended subscription keeps at most what it asked for", () => {
  const p = on(plain, async () => ({}));
  p.page.run('run({ kind: "subscribe", topic: "feed:*", into: "rows", mode: "append", max: 2 });');
  for (const n of [1, 2, 3]) p.page.run('v2LiveEvent("feed:a", { data: ' + n + " });");
  assert.deepStrictEqual(JSON.parse(p.page.run("JSON.stringify(STATE.rows)")), [2, 3]);
});
