"use strict";

// xode -p (one answer, then out), xode doctor and xode update.

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { createFakeServer } = require("./fakeServer");
const { runCli, tempHome } = require("./runCli");
const { createFileStore } = require("../src/auth/fileStore");
const { questionOf } = require("../src/commands/print");

const FAKE = "xdt_fake_upkeep_test_token_abcdefghi";

async function setup(opts = {}) {
  const server = await createFakeServer(opts);
  const home = tempHome();
  server.addToken(FAKE, "ana-laptop");
  await createFileStore({ XDG_CONFIG_HOME: home.config }).set(new URL(server.url).host, FAKE);
  return { server, home, close: async () => { await server.close(); home.cleanup(); } };
}

const neverStarts = (server) => {
  assert.ok(!server.calls.some((c) => c.path.endsWith("/approve")), "no plan approved");
  assert.strictEqual(server.jobs.size, 0, "no job");
  assert.ok(!server.calls.some((c) => c.path.startsWith("/v1/code/runner/") || c.path === "/v1/devices/connect"), "no runner");
  assert.strictEqual(server.devices.length, 0);
};

test("xode -p: Xode's answer as plain text, exit 0; never a plan approved, a job, or this computer offered", async () => {
  const t = await setup();
  try {
    const run = runCli(["-p", "why", "is", "the", "total", "off?"], { server: t.server, home: t.home, env: { XODE_TTY: "1" } });
    run.end();
    const r = await run.done;
    assert.strictEqual(r.code, 0, r.all);
    assert.strictEqual(r.stdout, [
      "The total is rounded per item in src/cart/total.ts:42, so a cart of many items drifts by a paisa or two.",
      "",
      "Rounding once, at the end, fixes it:",
      "",
      "- keep each line unrounded",
      "- round the sum, half up",
      "",
      "    return round(sum(lines))",
      "",
    ].join("\n"));
    assert.ok(!/\x1b\[/.test(r.all), "plain text");
    const say = t.server.calls.find((c) => c.path.endsWith("/say"));
    assert.strictEqual(say.body.text, "why is the total off?");
    neverStarts(t.server);
  } finally {
    await t.close();
  }
});

test("xode -p: piped text goes after the question, cut at 20 KB with a note", async () => {
  const t = await setup();
  try {
    const run = runCli(["--print", "why does this fail"], { server: t.server, home: t.home });
    run.child.stdin.end("TypeError: total is not a function\n    at cart.ts:3\n");
    const r = await run.done;
    assert.strictEqual(r.code, 0, r.all);
    const say = t.server.calls.find((c) => c.path.endsWith("/say"));
    assert.strictEqual(say.body.text, "why does this fail\n\nTypeError: total is not a function\n    at cart.ts:3");
    neverStarts(t.server);

    const big = runCli(["-p", "what is this"], { server: t.server, home: t.home });
    big.child.stdin.end("x".repeat(30 * 1024));
    const b = await big.done;
    assert.strictEqual(b.code, 0, b.all);
    assert.match(b.stderr, /Only the first 20 KB of the piped text was sent\./);
    const sent = t.server.calls.filter((c) => c.path.endsWith("/say"))[1].body.text;
    assert.ok(sent.startsWith("what is this\n\n" + "x".repeat(20 * 1024) + "\n[The piped text was cut"), sent.slice(-80));
  } finally {
    await t.close();
  }
  assert.strictEqual(questionOf("", { text: "only piped\n", cut: false }), "only piped");
});

test("xode -p signed out: exit 1, says to run xode; with nothing to ask: exit 2", async () => {
  const server = await createFakeServer();
  const home = tempHome();
  try {
    const r = await runCli(["-p", "hello"], { server, home }).done;
    assert.strictEqual(r.code, 1);
    assert.strictEqual(r.stderr.trim(), "Not signed in: run xode");
    assert.ok(!server.calls.some((c) => c.path.startsWith("/v1/bots/")));
    server.addToken(FAKE);
    await createFileStore({ XDG_CONFIG_HOME: home.config }).set(new URL(server.url).host, FAKE);
    const run = runCli(["-p"], { server, home });
    run.end();
    const empty = await run.done;
    assert.strictEqual(empty.code, 2);
  } finally {
    await server.close();
    home.cleanup();
  }
});

test("xode -p in a repository that isn't connected: says so, offers nothing, exit 1", async () => {
  const t = await setup({ projects: [] });
  try {
    const run = runCli(["-p", "hello"], { server: t.server, home: t.home });
    run.end();
    const r = await run.done;
    assert.strictEqual(r.code, 1, r.all);
    assert.strictEqual(r.stderr.trim(), "ana/storefront isn't connected to Xode yet: run xode here to connect it.");
  } finally {
    await t.close();
  }
});

test("xode doctor: one line per check, all ok", async () => {
  const t = await setup();
  try {
    const r = await runCli(["doctor"], { server: t.server, home: t.home }).done;
    assert.strictEqual(r.code, 0, r.all);
    const lines = r.stdout.trim().split("\n");
    assert.match(lines[0], /^ok {6}Node \d+\.\d+\.\d+$/);
    assert.strictEqual(lines[1], "ok      Signed in as ana@example.com (kept in");
    assert.strictEqual(lines[2], "        ~/config/xode/credentials.json)");
    assert.strictEqual(lines[3], "ok      The server answers (" + t.server.url + ")");
    assert.match(lines[4], /^ok {6}git \d/);
    assert.strictEqual(lines[5], "ok      This folder is ana/storefront");
    assert.strictEqual(lines[6], "ok      This computer can do the work (its runner is here)");
    assert.strictEqual(lines.length, 7);
    for (const l of lines) assert.ok(l.length <= 60, l);
    assert.ok(!r.all.includes(FAKE));
  } finally {
    await t.close();
  }
});

test("xode doctor: the problems, each with what to do, exit 1", async () => {
  const server = await createFakeServer();
  const home = tempHome();
  try {
    const r = await runCli(["doctor"], { server, home, cwd: home.plain, env: { XODE_RUNNER: "0" } }).done;
    assert.strictEqual(r.code, 1, r.all);
    assert.match(r.stdout, /^problem Not signed in: run xode\.$/m);
    assert.match(r.stdout, /^ok {6}The server answers/m);
    assert.match(r.stdout, /^problem This folder isn't a git repository: cd into your\n {8}project's folder\.$/m);
    assert.match(r.stdout, /^ok {6}This computer isn't offered \(XODE_RUNNER=0\)$/m);

    const away = await runCli(["doctor"], { server: { url: "http://127.0.0.1:9" }, home, cwd: path.join(home.work) }).done;
    assert.strictEqual(away.code, 1);
    assert.match(away.stdout, /^problem Can't reach 127\.0\.0\.1:9: check your connection and\n {8}XODE_SERVER\.$/m);
  } finally {
    await server.close();
    home.cleanup();
  }
});

test("xode update: the command to run, and the version here", async () => {
  const server = await createFakeServer();
  const home = tempHome();
  try {
    const r = await runCli(["update"], { server, home }).done;
    assert.strictEqual(r.code, 0, r.all);
    assert.match(r.stdout, /^This xode: \d+\.\d+\.\d+\nNewest: .+\nTo update:\n {2}npm i -g @xooteqlab\/xode@latest\n$/);
  } finally {
    await server.close();
    home.cleanup();
  }
});
