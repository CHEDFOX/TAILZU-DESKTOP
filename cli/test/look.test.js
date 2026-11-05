"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { boxLines } = require("../src/ui/box");
const { planLines } = require("../src/ui/plan");
const { stageLine } = require("../src/ui/progress");
const { painter, visible, strip } = require("../src/ui/paint");
const { termOf } = require("../src/ui/term");
const { wrapLine } = require("../src/ui/wrap");
const { highlightRefs } = require("../src/ui/refs");
const { createFakeServer } = require("./fakeServer");
const { runCli, tempHome } = require("./runCli");
const { createFileStore } = require("../src/auth/fileStore");
const { screenRows } = require("./screen");

const ESC = /\x1b\[/;
const ANSWER = "The total is rounded per item in `src/cart/total.ts:42`, so a long cart drifts. Rounding **once** at the end, see https://github.com/ana/storefront/blob/main/src/cart/total.ts#L42 fixes it.\n\n- keep each line unrounded until the very end of the sum, whatever the cart holds\n- round half up";

test("boxes wrap to a 60-column terminal", () => {
  const term = termOf({ isTTY: true }, { COLUMNS: "60" });
  const lines = boxLines(ANSWER, { term, paint: painter(true) });
  assert.ok(lines.length > 5);
  for (const l of lines) assert.strictEqual(visible(l), 60, JSON.stringify(strip(l)));
  assert.ok(strip(lines[0]).startsWith("┌─ Xode ─"));
  assert.ok(strip(lines[lines.length - 1]).startsWith("└─"));
  assert.ok(lines.slice(1, -1).every((l) => strip(l).startsWith("│ ") && strip(l).endsWith(" │")));
  // A list item's next line sits under its words.
  const item = lines.map(strip).findIndex((l) => l.includes("- keep each line"));
  assert.ok(strip(lines[item + 1]).startsWith("│   "), strip(lines[item + 1]));
});

test("never narrower than 40 columns", () => {
  const term = termOf({ isTTY: true }, { COLUMNS: "20" });
  for (const l of boxLines(ANSWER, { term, paint: painter(false) })) assert.strictEqual(visible(l), 40);
});

test("file:line references stand out", () => {
  const out = highlightRefs("see src/cart/total.ts:42 and util.js:3-9.", painter(true));
  assert.match(out, /\x1b\[1m\x1b\[36msrc\/cart\/total\.ts:42/);
  assert.match(out, /\x1b\[36mutil\.js:3-9\x1b/);
  assert.strictEqual(highlightRefs("at 10:30 today", painter(true)), "at 10:30 today");
});

test("not a terminal: plain lines, no box art, no colour", () => {
  const term = termOf({ isTTY: false }, {});
  const lines = boxLines(ANSWER, { term, paint: painter(term.color) });
  assert.strictEqual(lines[0], "Xode:");
  assert.ok(lines.every((l) => !/[┌┐└┘│]/.test(l) && !ESC.test(l)));
});

test("NO_COLOR: boxes on a terminal, but no escape codes", () => {
  const term = termOf({ isTTY: true }, { NO_COLOR: "1", COLUMNS: "60" });
  assert.strictEqual(term.color, false);
  const paint = painter(term.color);
  const all = [...boxLines(ANSWER, { term, paint }), ...planLines({ v: 2, goal: "Fix it", steps: ["a", "b"], status: "proposed", change: "x" }, { term, paint }), stageLine(2, { term, paint })];
  assert.ok(all.every((l) => !ESC.test(l)));
  assert.ok(all.some((l) => l.includes("┌")));
});

test("plan steps wrap under their words at 60 columns", () => {
  const term = termOf({ isTTY: true }, { COLUMNS: "60" });
  const lines = planLines({ v: 3, goal: "Fix the cart rounding", steps: ["Round the total once, at the very end of the sum, in src/cart/total.ts:42, and nowhere else", "Test it"], status: "proposed" }, { term, paint: painter(false) });
  assert.deepStrictEqual(lines.slice(0, 2), ["The plan · version 3", "  Fix the cart rounding"]);
  assert.ok(lines[2].startsWith("  1. Round"));
  assert.ok(lines[3].startsWith("     "));
  assert.ok(lines.every((l) => l.length <= 60));
});

test("a stage is one short line", () => {
  const term = termOf({ isTTY: true }, { COLUMNS: "60" });
  assert.strictEqual(strip(stageLine(2, { term, paint: painter(true) })), "● Build");
  assert.strictEqual(stageLine(1, { term: termOf({ isTTY: false }, {}), paint: painter(false) }), "● Plan");
});

test("wrapping cuts a word longer than the line", () => {
  const lines = wrapLine("x".repeat(25), 10);
  assert.deepStrictEqual(lines, ["xxxxxxxxxx", "xxxxxxxxxx", "xxxxx"]);
});

const SIGNED = "xdt_fake_look_test_token_000000000000";

async function lookSetup(opts = {}) {
  const server = await createFakeServer({ live: true, ...opts });
  const home = tempHome();
  server.addToken(SIGNED);
  await createFileStore({ XDG_CONFIG_HOME: home.config }).set(new URL(server.url).host, SIGNED);
  return { server, home, close: async () => { await server.close(); home.cleanup(); } };
}

test("a whole session through a pipe, drawn for 60 columns: boxes in width, and NO_COLOR has no escape codes", async () => {
  const t = await lookSetup();
  try {
    for (const env of [{ XODE_TTY: "1", COLUMNS: "60" }, { XODE_TTY: "1", COLUMNS: "60", NO_COLOR: "1" }]) {
      const run = runCli(["--new", "fix the cart rounding"], { server: t.server, home: t.home, env });
      await run.waitFor("Start this plan?");
      run.type("1");
      await run.waitFor("Xode asks");
      run.type("1");
      await run.waitFor("Pull request:");
      run.end();
      const r = await run.done;
      assert.strictEqual(r.code, 0, r.all);
      // Xode's boxes, after the small welcome box (its first four lines).
      const boxed = r.stdout.split("\n").slice(4).filter((l) => /[┌│└]/.test(strip(l)));
      assert.match(strip(r.stdout.split("\n")[1]), /^│ Xode · ana\/storefront +│$/);
      assert.ok(boxed.length > 6);
      for (const l of boxed) assert.strictEqual(visible(l), 60, JSON.stringify(strip(l)));
      for (const l of r.stdout.split("\n")) assert.ok(visible(l) <= 60, JSON.stringify(strip(l)));
      // A pipe for input: nothing is redrawn, so nothing but colour is ever sent.
      assert.ok(!/\x1b\[[0-9;?]*[A-HJKhl]/.test(r.all), "no cursor moves without a keyboard");
      if (env.NO_COLOR) assert.ok(!ESC.test(r.all), "escape codes with NO_COLOR");
      else assert.ok(ESC.test(r.stdout));
    }
  } finally {
    await t.close();
  }
});

/** The rows a person sees once `run` has written `what`. */
const rowsOf = (run, cols) => screenRows(run.output, cols);

for (const cols of [76, 60]) {
  test(`on a terminal ${cols} columns wide: the welcome box, the status line redrawn in place, the pickers, the two-press exit`, async () => {
    const t = await lookSetup({ stepMs: 120 });
    try {
      const env = { XODE_TTY: "1", XODE_KEYS: "1", COLUMNS: String(cols) };
      const run = runCli([], { server: t.server, home: t.home, env });
      await run.waitFor("Ctrl+C twice to exit");
      await pause(100);
      let rows = rowsOf(run, cols);
      assert.match(rows[0], /^╭─+╮$/);
      assert.match(rows[1], /^│ Xode · ana\/storefront +│$/);
      assert.match(rows[2], /^│ .*work +│$/);
      assert.strictEqual(rows[4], "Type what you want · / for commands · Ctrl+C twice to exit");
      assert.strictEqual(rows[5], ">");
      assert.strictEqual(rows.length, 6, "nothing else at the start");

      run.keys("fix the cart rounding");
      await pause(60);
      run.keys("\r");
      await run.waitFor("Start this plan?");
      await pause(60);
      rows = rowsOf(run, cols);
      assert.deepStrictEqual(rows.slice(-3), ["Start this plan?", "❯ 1. Yes", "  2. No, tell Xode what to change"]);
      run.keys("\x1b[B");
      await pause(60);
      assert.deepStrictEqual(rowsOf(run, cols).slice(-2), ["  1. Yes", "❯ 2. No, tell Xode what to change"]);
      run.keys("\x1b[A\r");
      await run.waitFor(/●.*Understand/);
      await pause(250);
      rows = rowsOf(run, cols);
      // One status line, redrawn, the prompt under it; what was done above.
      assert.match(rows[rows.length - 2], /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] (Understand|Plan|Build|Check) · \d+s · esc to stop$/);
      assert.strictEqual(rows[rows.length - 1], ">");
      assert.strictEqual(rows.filter((l) => /esc to stop/.test(l)).length, 1, "drawn once, not stacked");
      assert.ok(rows.includes("● Understand"));
      assert.ok(rows.some((l) => l.startsWith("  · ")));

      await run.waitFor("Type your own answer");
      await pause(60);
      rows = rowsOf(run, cols);
      assert.deepStrictEqual(rows.slice(-4), ["Xode asks: Should prices round half up, or half to even?", "❯ 1. Half up", "  2. Half to even", "  3. Type your own answer"]);
      assert.ok(!rows.some((l) => /esc to stop$/.test(l)), "no status line frozen above the question while it is asked");
      run.keys("1");
      await run.waitFor("Pull request:");
      await pause(150);
      rows = rowsOf(run, cols);
      assert.strictEqual(rows[rows.length - 1], ">");
      assert.ok(!rows.some((l) => /esc to stop/.test(l)), "the status line goes with the job");

      run.keys("\x03");
      await pause(80);
      assert.deepStrictEqual(rowsOf(run, cols).slice(-2), [">", "Press Ctrl+C again to exit"]);
      run.keys("\x03");
      const r = await run.done;
      assert.strictEqual(r.code, 0, r.all);
      rows = screenRows(r.all, cols);
      for (const l of rows) assert.ok(l.length <= cols, JSON.stringify(l));
      assert.ok(!rows.some((l) => /Press Ctrl\+C again/.test(l)), "the hint is gone once out");
    } finally {
      await t.close();
    }
  });
}

test("NO_COLOR on a terminal: redrawn in place, but no colour codes", async () => {
  const t = await lookSetup({ stepMs: 60 });
  try {
    const run = runCli(["fix the cart rounding"], { server: t.server, home: t.home, env: { XODE_TTY: "1", XODE_KEYS: "1", COLUMNS: "60", NO_COLOR: "1" } });
    await run.waitFor("Start this plan?");
    run.keys("\r");
    await run.waitFor("● Understand");
    await pause(200);
    run.keys("\x03\x03");
    const r = await run.done;
    assert.strictEqual(r.code, 0, r.all);
    assert.ok(!/\x1b\[[0-9;]*m/.test(r.all), "a colour code with NO_COLOR");
    assert.match(screenRows(r.all, 60).join("\n"), /Xode keeps working\. Run xode here to follow it\./);
  } finally {
    await t.close();
  }
});

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
