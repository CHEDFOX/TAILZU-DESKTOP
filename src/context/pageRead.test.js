// node --test
//
// The whole page, read with every dependency faked: the helper's page read,
// a window that scrolls a document a line per wheel line under a toolbar and
// a status bar, and the picture read of whatever it shows. No Electron, no
// screen.

const test = require("node:test");
const assert = require("node:assert");
const K = require("../../knobs.js");
const { readPage, needsWhole, reducePage, overlap, offsetFrom } = require("./pageRead.js");

/** Knobs for one test; the defaults again after it. */
function knobs(t, flags) {
  K.setKnobs({ labels: {}, flags: Object.assign({}, flags) });
  t.after(() => K.setKnobs({ labels: {}, flags: {} }));
}

const DOC = Array.from({ length: 100 }, (_, i) => `Line ${i + 1} of the plan`);

/**
 * A window showing `view` lines of DOC from `top`, under two toolbar lines and
 * over a status line. A wheel line moves one line; `drift` more on each wheel
 * up, as a page with inertia does. The tree has only the title.
 */
function fakeWindow(o = {}) {
  const view = o.view || 20;
  const st = { top: o.top == null ? 37 : o.top, scrolls: [], reads: 0, pages: 0 };
  const max = DOC.length - view;
  const deps = {
    front: async () => o.front === undefined ? { label: "Docs", title: "Plan - Google Docs", private: false, sensitive: false } : o.front,
    page: async (opts) => {
      st.pages++;
      st.pageOpts = opts;
      return o.tree || {
        ok: true, text: "Plan", headings: [], approxWhere: "", whereOffset: -1, truncated: false,
        app: { name: "Google Chrome", pid: 7 }, window: { title: "Plan - Google Docs", frame: [0, 0, 800, 600] }, scale: "points",
      };
    },
    scroll: async (dir, lines) => {
      st.scrolls.push([dir, lines]);
      const by = (dir === "down" ? lines : -lines - (o.drift || 0));
      st.top = Math.max(0, Math.min(max, st.top + by));
      if (o.onScroll) o.onScroll(st);
      return { ok: true };
    },
    ocr: async () => {
      st.reads++;
      return ["File  Edit  View  Insert", "Normal text | Arial | 11", ...DOC.slice(st.top, st.top + view), "Page 2 of 5"].join("\n");
    },
    dictating: () => !!(o.dictating && o.dictating(st)),
    canScroll: async () => o.canScroll !== false,
    sleep: async () => {},
  };
  return { st, deps };
}

test("the tree's text is the page when it has enough: no scrolling, no picture", async (t) => {
  knobs(t, {});
  const text = ["# Q3 plan", "Revenue grew in every region this quarter.", "## Risks", "Hiring is behind.", "## Next", "Ship the export."]
    .join("\n") + "\n" + "More words on the plan. ".repeat(30);
  const w = fakeWindow({
    tree: {
      ok: true, text, headings: [{ level: 1, text: "Q3 plan" }, { level: 2, text: "Risks" }, { level: 2, text: "Next" }],
      approxWhere: "Hiring is behind.", whereOffset: text.indexOf("Hiring"), truncated: false,
      app: { name: "Notes", pid: 3 }, window: { title: "Q3 plan", frame: [0, 0, 800, 600] }, scale: "points",
    },
  });
  const p = await readPage(w.deps, { question: "summarise this" });
  assert.strictEqual(p.source, "tree");
  assert.deepStrictEqual(p.outline, ["# Q3 plan", "## Risks", "## Next"]);
  assert.strictEqual(p.text, text.trim());
  assert.strictEqual(p.where, "Hiring is behind.");
  assert.strictEqual(p.truncated, false);
  assert.deepStrictEqual([w.st.scrolls.length, w.st.reads], [0, 0]);
  assert.deepStrictEqual(w.st.pageOpts, { chars: 40000, budgetMs: 1200 });
});

test("a thin tree and a question about the whole page: read a screen at a time, each line once, and put back where it was", async (t) => {
  knobs(t, { "desktop.page.maxScreens": 40 });
  const w = fakeWindow();
  const p = await readPage(w.deps, { question: "summarise this page" });
  assert.strictEqual(p.source, "scroll");
  assert.strictEqual(p.text, DOC.join("\n"), "the whole document, in order, each line once, no toolbar or status line");
  assert.strictEqual(p.where, "Line 38 of the plan", "the first line they could see");
  assert.strictEqual(p.truncated, false);
  assert.deepStrictEqual(p.outline, []);
  assert.strictEqual(w.st.top, 37, "scrolled back to exactly where they were");
  // Down to the end, back, up to the top, back: never more than the driver's 40 lines at once.
  assert.ok(w.st.scrolls.every(([, n]) => n >= 1 && n <= 40));
  assert.ok(w.st.scrolls.some(([d]) => d === "down") && w.st.scrolls.some(([d]) => d === "up"));
});

test("the read stops at its caps, says it was cut, and still goes back", async (t) => {
  knobs(t, { "desktop.page.maxScreens": 4 });
  const w = fakeWindow();
  const p = await readPage(w.deps, { question: "summarise this page" });
  assert.strictEqual(p.source, "scroll");
  assert.strictEqual(p.truncated, true);
  assert.strictEqual(w.st.reads <= 4 + 2, true, "four screens, and the check that it is back");
  const lines = p.text.split("\n");
  assert.deepStrictEqual(lines, DOC.slice(37, 37 + 20 + 3 * 8), "from where they were, three steps down");
  assert.strictEqual(w.st.top, 37);

  knobs(t, { "desktop.page.maxChars": 600, "desktop.page.maxScreens": 40 });
  const c = fakeWindow();
  const q = await readPage(c.deps, { question: "find the budget here" });
  assert.strictEqual(q.truncated, true);
  assert.ok(q.text.length < 600 + 8 * 25);
  assert.strictEqual(c.st.top, 37);

  knobs(t, { "desktop.page.maxMs": 0, "desktop.page.maxScreens": 40 });
  const m = fakeWindow();
  const r = await readPage(m.deps, { question: "find the budget here" });
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(m.st.scrolls.length, 0, "out of time before the first step");
});

test("a wheel that overshoots on the way back is put right against the first screen", async (t) => {
  knobs(t, { "desktop.page.maxScreens": 40 });
  const w = fakeWindow({ drift: 1 });
  const p = await readPage(w.deps, { question: "what does the whole document say" });
  assert.strictEqual(p.source, "scroll");
  assert.strictEqual(w.st.top, 37);
  assert.strictEqual(p.text, DOC.join("\n"));
});

test("no read a screen at a time unless the question needs the whole page", async (t) => {
  knobs(t, {});
  const w = fakeWindow();
  const p = await readPage(w.deps, { question: "where's the share button?" });
  assert.deepStrictEqual(p, { outline: [], text: "Plan", where: "Plan", source: "tree", truncated: false });
  assert.deepStrictEqual([w.st.scrolls.length, w.st.reads], [0, 0]);
  const forced = fakeWindow();
  await readPage(forced.deps, { question: "summarise this", needWhole: false });
  assert.strictEqual(forced.st.scrolls.length, 0, "needWhole false wins over the words");
  const off = fakeWindow();
  knobs(t, { "desktop.page.scroll": false });
  await readPage(off.deps, { question: "summarise this" });
  assert.strictEqual(off.st.scrolls.length, 0, "the knob turns it off");
});

test("nothing from a private window or a sensitive app; no scrolling while dictating or with the pointer elsewhere", async (t) => {
  knobs(t, { "desktop.page.maxScreens": 40 });
  const NONE = { outline: [], text: "", where: "", source: "none", truncated: false };
  const priv = fakeWindow({ front: { label: "Chrome", title: "New Incognito Tab", private: true, sensitive: false } });
  assert.deepStrictEqual(await readPage(priv.deps, { question: "summarise this" }), NONE);
  assert.strictEqual(priv.st.pages, 0, "not even the tree");
  const bank = fakeWindow({ front: { label: "Chase", title: "Chase", private: false, sensitive: true } });
  assert.deepStrictEqual(await readPage(bank.deps, { question: "summarise this" }), NONE);
  // The page's own window, by its title, as a snapshot's is checked.
  const late = fakeWindow({
    tree: { ok: true, text: "Balance 1,000", headings: [], approxWhere: "", whereOffset: -1, truncated: false,
      app: { name: "Google Chrome", pid: 7 }, window: { title: "Chase Online - Accounts", frame: [0, 0, 800, 600] }, scale: "points" },
  });
  assert.deepStrictEqual(await readPage(late.deps, { question: "summarise this" }), NONE);
  assert.strictEqual(late.st.reads, 0);

  const talking = fakeWindow({ dictating: () => true });
  const p = await readPage(talking.deps, { question: "summarise this" });
  assert.strictEqual(p.source, "tree");
  assert.deepStrictEqual([talking.st.scrolls.length, talking.st.reads], [0, 0]);

  const away = fakeWindow({ canScroll: false });
  await readPage(away.deps, { question: "summarise this" });
  assert.strictEqual(away.st.scrolls.length, 0);

  // A dictation that starts part way stops the read, and the page is still put back.
  const midway = fakeWindow({ dictating: (st) => st.scrolls.length >= 2 });
  const q = await readPage(midway.deps, { question: "summarise this" });
  assert.strictEqual(q.source, "scroll");
  assert.strictEqual(midway.st.top, 37);
  assert.ok(midway.st.scrolls.filter(([d]) => d === "down").length <= 2);
});

test("the page for the server: the outline first, then the start and around where they are, to the cap", async (t) => {
  knobs(t, {});
  const lines = Array.from({ length: 2000 }, (_, i) => `Paragraph ${i} says something about the plan.`);
  const headings = Array.from({ length: 40 }, (_, i) => ({ level: 1 + (i % 3), text: `Section ${i}` }));
  const p = reducePage({ lines, headings, whereLine: 1000, where: "", source: "tree", truncated: false }, 20000);
  assert.strictEqual(p.truncated, true);
  assert.strictEqual(p.outline[0], "# Section 0");
  assert.strictEqual(p.outline[1], "## Section 1");
  const used = p.outline.reduce((n, l) => n + l.length + 1, 0);
  assert.ok(used + p.text.length <= 20000, `${used} + ${p.text.length}`);
  const out = p.text.split("\n");
  assert.strictEqual(out[0], lines[0], "the page's start");
  assert.ok(out.includes(lines[1000]) && out.includes(lines[999]) && out.includes(lines[1001]), "around where they are");
  assert.ok(!out.includes(lines[500]) && !out.includes(lines[1900]), "the far parts left out");
  assert.ok(out.includes("…"));
  // In the page's order.
  const idx = out.filter((l) => l !== "…").map((l) => Number(/Paragraph (\d+)/.exec(l)[1]));
  assert.deepStrictEqual(idx, idx.slice().sort((a, b) => a - b));
  assert.strictEqual(p.where, lines[1000]);

  // Small enough: all of it, as it is.
  const small = reducePage({ lines: ["a", "b"], headings: [], whereLine: 1, where: "b", source: "scroll", truncated: false }, 20000);
  assert.deepStrictEqual(small, { outline: [], text: "a\nb", where: "b", source: "scroll", truncated: false });

  // A URL's query never goes.
  const url = reducePage({ lines: ["Reset: https://x.example/reset?token=abc and mail.example.com/u/0?tok=1"], headings: [], whereLine: 0, source: "tree" }, 20000);
  assert.strictEqual(url.text, "Reset: https://x.example/reset and mail.example.com/u/0");

  // The cap is a knob.
  knobs(t, { "desktop.page.sendChars": 3000 });
  const w = fakeWindow({
    tree: { ok: true, text: lines.join("\n"), headings, approxWhere: lines[1000], whereOffset: -1, truncated: false,
      app: { name: "Notes", pid: 3 }, window: { title: "Plan", frame: [0, 0, 800, 600] }, scale: "points" },
  });
  const q = await readPage(w.deps, { question: "" });
  assert.ok(q.outline.reduce((n, l) => n + l.length + 1, 0) + q.text.length <= 3000);
  assert.ok(q.text.includes(lines[1000]));
});

test("needsWhole: summarise, the whole thing, find — in English, Hinglish and Hindi", () => {
  for (const s of ["Summarise this", "summarize the doc", "give me a summary", "tl;dr", "what does the whole page say",
    "find the budget here", "search this for Priya", "is it mentioned anywhere?", "what's in this document",
    "is page mein kya likha hai", "poora padh ke batao", "summary do", "budget dhoondo", "isme Priya ka naam khojo", "saara thread padho",
    "इस पेज का सारांश बताओ", "पूरा दस्तावेज़ पढ़ो", "इसमें बजट ढूंढो"]) {
    assert.strictEqual(needsWhole(s), true, s);
  }
  for (const s of ["where's export?", "click send", "make this bold", "kya haal hai", "isko bold karo", "भेज दो", "", null]) {
    assert.strictEqual(needsWhole(s), false, String(s));
  }
});

test("the overlap between two screens, and where a screen is from the first", () => {
  assert.strictEqual(overlap(["a", "b", "c", "d"], ["c", "d", "e"]), 2);
  assert.strictEqual(overlap(["a", "b"], ["x", "y"]), 0);
  assert.strictEqual(overlap(["A  b!", "c"], ["c", "d"]), 1, "case and marks aside");
  assert.strictEqual(offsetFrom(["c", "d", "e"], ["c", "d", "e"]), 0);
  assert.strictEqual(offsetFrom(["c", "d", "e"], ["a", "b", "c"]), 2, "above it: down two");
  assert.strictEqual(offsetFrom(["c", "d", "e"], ["d", "e", "f"]), -1, "below it: up one");
  assert.strictEqual(offsetFrom(["c"], ["x"]), null);
});
