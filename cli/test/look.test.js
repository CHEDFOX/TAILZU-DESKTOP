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

test("the stage line fits 60 columns", () => {
  const term = termOf({ isTTY: true }, { COLUMNS: "60" });
  for (let i = 0; i < 5; i += 1) assert.ok(visible(stageLine(i, { term, paint: painter(true) })) <= 60);
  assert.strictEqual(stageLine(1, { term: termOf({ isTTY: false }, {}), paint: painter(false) }), "Stage 2 of 5: Plan");
});

test("wrapping cuts a word longer than the line", () => {
  const lines = wrapLine("x".repeat(25), 10);
  assert.deepStrictEqual(lines, ["xxxxxxxxxx", "xxxxxxxxxx", "xxxxx"]);
});

test("a whole session at 60 columns: boxes in width, and NO_COLOR has no escape codes", async () => {
  const server = await createFakeServer({ live: true });
  const home = tempHome();
  server.addToken("xdt_fake_look_test_token_000000000000");
  await createFileStore({ XDG_CONFIG_HOME: home.config }).set(new URL(server.url).host, "xdt_fake_look_test_token_000000000000");
  try {
    for (const env of [{ XODE_TTY: "1", COLUMNS: "60" }, { XODE_TTY: "1", COLUMNS: "60", NO_COLOR: "1" }]) {
      const run = runCli(["--new", "fix the cart rounding"], { server, home, env });
      await run.waitFor("Approve? (y/n)");
      run.type("y");
      await run.waitFor("Your answer");
      run.type("1");
      const r = await run.done;
      assert.strictEqual(r.code, 0, r.all);
      const boxed = r.stdout.split("\n").filter((l) => /[┌│└]/.test(strip(l)));
      assert.ok(boxed.length > 6);
      for (const l of boxed) assert.strictEqual(visible(l), 60, JSON.stringify(strip(l)));
      for (const l of r.stdout.split("\n")) assert.ok(visible(l) <= 60, JSON.stringify(strip(l)));
      if (env.NO_COLOR) assert.ok(!ESC.test(r.all), "escape codes with NO_COLOR");
      else assert.ok(ESC.test(r.stdout));
    }
  } finally {
    await server.close();
    home.cleanup();
  }
});
