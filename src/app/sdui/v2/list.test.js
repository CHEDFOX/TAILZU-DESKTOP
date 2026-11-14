// node --test
//
// Lists: the arithmetic of what is in view, the rules about where a page may come from, and a drawn list that
// fetches its first page and keeps the rows.
const test = require("node:test");
const assert = require("node:assert");
const { fakePage } = require("../../testkit.js");

function paint(page, screen) {
  page.run("CURRENT_SCREEN = " + JSON.stringify(screen) + "; STATE = " + JSON.stringify(screen.state || {}) + ";");
  page.run('$("view").innerHTML = node(CURRENT_SCREEN.root);');
}

test("only the rows in view are drawn, with the right empty space above and below", () => {
  const page = fakePage();
  const plan = (count, size, viewH, top, at) => JSON.parse(page.run(`JSON.stringify(v2WindowRows(${count}, ${size}, ${viewH}, ${top}, ${at}))`));
  const first = plan(1000, 50, 500, 0, 0);
  assert.strictEqual(first.first, 0);
  assert.strictEqual(first.before, 0);
  assert.ok(first.last >= 10 && first.last < 40, "a screenful and its overscan, not a thousand rows");
  assert.strictEqual(first.after, (1000 - 1 - first.last) * 50);
  const deep = plan(1000, 50, 500, 10000, 0);
  assert.strictEqual(deep.first, 200 - 10);
  assert.strictEqual(deep.before, (200 - 10) * 50);
  // A list riding the page's scroller starts where it sits in it.
  assert.deepStrictEqual(plan(100, 20, 200, 300, 300), plan(100, 20, 200, 0, 0));
  assert.deepStrictEqual(plan(0, 50, 500, 0, 0), { first: 0, last: -1, before: 0, after: 0 });
});

test("a page comes from our own API and nowhere else", () => {
  const page = fakePage();
  const ok = (p) => page.run("v2ApiPath(" + JSON.stringify(p) + ")");
  assert.strictEqual(ok("/v1/feed?cursor=2026-11-13T10:00:00Z"), "/v1/feed?cursor=2026-11-13T10:00:00Z");
  assert.strictEqual(ok("https://evil.test/v1/feed"), null);
  assert.strictEqual(ok("/v2/feed"), null);
  assert.strictEqual(ok("/v1/../admin"), null);
  assert.strictEqual(ok("/v1/%2e%2e/admin"), null);
  assert.strictEqual(ok("/v1//evil.test/x"), null);
});

test("a page's rows are merged without repeating a row, and never past the ceiling", () => {
  const page = fakePage();
  const got = (held, incoming, mode) => JSON.parse(page.run(`JSON.stringify(v2Merged(${JSON.stringify(held)}, ${JSON.stringify(incoming)}, "${mode}", "id"))`));
  assert.deepStrictEqual(got([{ id: "a" }], [{ id: "a" }, { id: "b" }], "append"), [{ id: "a" }, { id: "b" }]);
  assert.deepStrictEqual(got([{ id: "a" }], [{ id: "b" }], "prepend"), [{ id: "b" }, { id: "a" }]);
  assert.deepStrictEqual(got([{ id: "a" }], [{ id: "c" }], "replace"), [{ id: "c" }]);
  const body = JSON.parse(page.run('JSON.stringify(v2PageBody({ rows: [1, 2], next: "/v1/feed?p=2" }))'));
  assert.deepStrictEqual(body, { items: [1, 2], next: "/v1/feed?p=2" });
  assert.strictEqual(JSON.parse(page.run('JSON.stringify(v2PageBody({ items: [], next: "https://evil.test" }))')).next, null);
});

test("a List draws one template per row, with the row in scope", () => {
  const page = fakePage();
  paint(page, {
    screenId: "feed", needs: ["expr", "list"],
    state: { feed: [{ id: "a", name: "Ash" }, { id: "b", name: "Bea" }] },
    root: {
      type: "List",
      props: { data: { $: "state.feed" }, key: "id", estimatedSize: 40, item: { type: "Text", props: { content: { $: "item.name" } } } },
    },
  });
  page.run("v2WireIn($(\"view\"))");
  const html = page.run('$("view").querySelector("[data-v2-list]").innerHTML');
  assert.match(html, /Ash/);
  assert.match(html, /Bea/);
});

test("Each repeats a small array and stops at its cap", () => {
  const page = fakePage();
  paint(page, {
    screenId: "chips", needs: ["expr", "list"], state: { words: ["one", "two", "three"] },
    root: { type: "Each", props: { data: { $: "state.words" }, max: 2, item: { type: "Text", props: { content: { $: "item" } } } } },
  });
  const html = page.run('$("view").innerHTML');
  assert.match(html, /one/);
  assert.match(html, /two/);
  assert.doesNotMatch(html, /three/);
});

test("a list with a page asks for it once and keeps what came back", async () => {
  const page = fakePage();
  page.run("var __asked = [];");
  page.run('api = async function (path) { __asked.push(path); return { items: [{ id: "a", name: "Ash" }], next: null }; };');
  paint(page, {
    screenId: "paged", needs: ["expr", "list"], state: { feed: [] },
    root: {
      type: "List",
      props: {
        data: { $: "state.feed" }, key: "id", item: { type: "Text", props: { content: { $: "item.name" } } },
        page: { endpoint: "/v1/feed", into: "feed", cursor: "feedCursor" },
      },
    },
  });
  page.run("v2WireIn($(\"view\"))");
  await page.settle();
  assert.deepStrictEqual(JSON.parse(page.run("JSON.stringify(__asked)")), ["/v1/feed"]);
  assert.deepStrictEqual(JSON.parse(page.run("JSON.stringify(STATE.feed)")), [{ id: "a", name: "Ash" }]);
  assert.strictEqual(page.run("STATE.feedCursor"), null);
  assert.match(page.run('$("view").querySelector("[data-v2-list]").innerHTML'), /Ash/);
});
