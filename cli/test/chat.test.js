"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { createFakeServer, defaultScript } = require("./fakeServer");
const { runCli, tempHome } = require("./runCli");
const { createFileStore } = require("../src/auth/fileStore");

const FAKE = "xdt_fake_chat_test_token_abcdefghijkl";

async function setup(opts = {}) {
  const server = await createFakeServer(opts);
  const home = tempHome();
  server.addToken(FAKE);
  await createFileStore({ XDG_CONFIG_HOME: home.config }).set(new URL(server.url).host, FAKE);
  return { server, home, close: async () => { await server.close(); home.cleanup(); } };
}

const positions = (text, list) => list.map((s) => text.indexOf(s));
const STAGE_LINES = ["Stage 1 of 5: Understand", "Stage 2 of 5: Plan", "Stage 3 of 5: Build", "Stage 4 of 5: Check", "Stage 5 of 5: Ship"];

for (const live of [false, true]) {
  test(`one-shot: answer, plan, approve, stages, question, pull request (${live ? "live room" : "polling"})`, async () => {
    const t = await setup({ live });
    try {
      const run = runCli(["fix the cart rounding"], { server: t.server, home: t.home });
      await run.waitFor("Approve? (y/n)");
      run.type("y");
      await run.waitFor("Your answer");
      run.type("1");
      const r = await run.done;
      assert.strictEqual(r.code, 0, r.all);

      // Xode's answer, then the plan's steps, numbered.
      assert.match(r.stdout, /The total is rounded per item in src\/cart\/total\.ts:42/);
      assert.match(r.stdout, /The plan · version 2/);
      assert.match(r.stdout, / 1\. Round the total once/);
      assert.match(r.stdout, / 2\. Keep each line's price/);
      assert.match(r.stdout, / 3\. Add a test/);
      // The stages, once each, in order.
      const at = positions(r.stdout, STAGE_LINES);
      assert.ok(at.every((p) => p >= 0), r.stdout);
      assert.deepStrictEqual([...at].sort((a, b) => a - b), at);
      for (const s of STAGE_LINES) assert.strictEqual(r.stdout.split(s).length, 2, `${s} more than once`);
      // What it did, in short lines.
      assert.match(r.stdout, /src\/cart\/total\.ts/);
      assert.match(r.stdout, live ? /Ran npm test/ : /Ran the tests · 18 passed/);
      // The question, answered inline.
      assert.match(r.stdout, /Xode asks: Should prices round half up, or half to even\?/);
      const job = [...t.server.jobs.values()][0];
      assert.deepStrictEqual(job.answers, ["Half up"]);
      // The end: the summary and the pull request.
      assert.match(r.stdout, /Fixed the cart rounding/);
      assert.match(r.stdout, /Pull request: https:\/\/github\.com\/ana\/storefront\/pull\/42/);

      const say = t.server.calls.find((c) => c.path.endsWith("/say"));
      assert.strictEqual(say.body.text, "fix the cart rounding");
      assert.match(say.body.thread, /^[0-9a-f-]{36}$/);
      const approve = t.server.calls.find((c) => c.path.endsWith("/approve") && c.path.includes("/flow/"));
      assert.deepStrictEqual(approve.body, { thread: say.body.thread, v: 2 });
      assert.strictEqual(t.server.calls.some((c) => c.method === "WS"), live);
      assert.ok(!r.all.includes(FAKE));
    } finally {
      await t.close();
    }
  });
}

test("Ctrl+C during a job asks, then stops it", async () => {
  const t = await setup({ stepMs: 250 });
  try {
    const run = runCli(["fix the cart rounding"], { server: t.server, home: t.home });
    await run.waitFor("Approve? (y/n)");
    run.type("y");
    await run.waitFor("Stage 1 of 5");
    run.child.kill("SIGINT");
    await run.waitFor("Stop the job? (y/n)");
    run.type("y");
    const r = await run.done;
    assert.strictEqual(r.code, 130, r.all);
    assert.match(r.stdout, /The job was stopped\./);
    assert.strictEqual((r.stdout.match(/stopped/gi) || []).length, 1, "said once");
    const job = [...t.server.jobs.values()][0];
    assert.ok(t.server.calls.some((c) => c.method === "POST" && c.path === `/v1/code/jobs/${job.id}/stop`));
    assert.strictEqual(job.state, "cancelled");
  } finally {
    await t.close();
  }
});

test("Ctrl+C answered no keeps following the job", async () => {
  const t = await setup({ stepMs: 150 });
  try {
    const run = runCli(["fix the cart rounding"], { server: t.server, home: t.home });
    await run.waitFor("Approve? (y/n)");
    run.type("y");
    await run.waitFor("Stage 1 of 5");
    run.child.kill("SIGINT");
    await run.waitFor("Stop the job? (y/n)");
    run.type("n");
    await run.waitFor("Your answer");
    run.type("Half to even");
    const r = await run.done;
    assert.strictEqual(r.code, 0, r.all);
    assert.ok(!t.server.calls.some((c) => c.path.endsWith("/stop")));
    assert.deepStrictEqual([...t.server.jobs.values()][0].answers, ["Half to even"]);
  } finally {
    await t.close();
  }
});

test("a message typed while it works goes to the plan's judge", async () => {
  const t = await setup({ stepMs: 200 });
  try {
    const run = runCli(["fix the cart rounding"], { server: t.server, home: t.home });
    await run.waitFor("Approve? (y/n)");
    run.type("y");
    await run.waitFor("Stage 1 of 5");
    run.type("keep the old helper too");
    await run.waitFor("Noted. I'll keep that in mind");
    await run.waitFor("Your answer");
    run.type("2");
    const r = await run.done;
    assert.strictEqual(r.code, 0, r.all);
    const work = t.server.calls.find((c) => c.path.endsWith("/work"));
    assert.strictEqual(work.body.text, "keep the old helper too");
  } finally {
    await t.close();
  }
});

test("a failed job says so plainly", async () => {
  const script = defaultScript().slice(0, 3).concat([{ fail: "The tests would not pass." }]);
  const t = await setup({ script });
  try {
    const run = runCli(["fix the cart rounding"], { server: t.server, home: t.home });
    await run.waitFor("Approve? (y/n)");
    run.type("y");
    const r = await run.done;
    assert.strictEqual(r.code, 1);
    assert.match(r.stdout, /The job failed: The tests would not pass\./);
  } finally {
    await t.close();
  }
});

test("chat: picks a project by number, offers the opening plan, Ctrl+C at the prompt leaves", async () => {
  const projects = [
    { id: "11111111-1111-4111-8111-111111111111", fullName: "ana/blog" },
    { id: "6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7", fullName: "ana/storefront" },
  ];
  const t = await setup({ projects });
  try {
    const run = runCli([], { server: t.server, home: t.home });
    await run.waitFor("Which project?");
    run.type("2");
    await run.waitFor("Approve? (y/n)");
    assert.match(run.output, /Where it stands/);
    assert.match(run.output, /The plan\n/);
    run.type("n");
    await run.waitFor("Tell Xode what you'd like instead");
    run.child.kill("SIGINT");
    const r = await run.done;
    assert.strictEqual(r.code, 0, r.all);
    assert.ok(t.server.calls.some((c) => c.path === `/v1/bots/code/flow/${projects[1].id}/plan`));
    assert.ok(!t.server.calls.some((c) => c.path.endsWith("/approve")));
  } finally {
    await t.close();
  }
});

test("xode stop stops this folder's job; status shows it", async () => {
  const t = await setup({ stepMs: 400 });
  try {
    const run = runCli(["--project", t.server.projectId, "fix the cart rounding"], { server: t.server, home: t.home });
    await run.waitFor("Approve? (y/n)");
    run.type("y");
    await run.waitFor("Stage 1 of 5");
    const st = await runCli(["status"], { server: t.server, home: t.home }).done;
    assert.match(st.stdout, /Job here: working · stage \d of 5/);
    const s = await runCli(["stop"], { server: t.server, home: t.home }).done;
    assert.strictEqual(s.code, 0, s.all);
    assert.match(s.stdout, /Stopped the job\./);
    const r = await run.done;
    assert.strictEqual(r.code, 1);
    assert.match(r.stdout, /The job was stopped\./);
    const again = await runCli(["stop"], { server: t.server, home: t.home }).done;
    assert.match(again.stdout, /No job is running in this folder\./);
  } finally {
    await t.close();
  }
});

test("a device token used outside Xode's routes is refused with device_scope", async () => {
  const t = await setup();
  try {
    const { createClient } = require("../src/api/client");
    const c = createClient({ server: t.server.url, token: FAKE });
    await assert.rejects(c.get("/v1/me"), (err) => err.code === "device_scope" && /only works for Xode/.test(err.message) && !err.message.includes(FAKE));
  } finally {
    await t.close();
  }
});

test("before the first plan: asks where to take the project, then goes on", async () => {
  const t = await setup({ gate: { open: false, reading: { status: "ready", pct: 100, phase: "" }, vision: "missing" } });
  try {
    const run = runCli(["fix the cart rounding"], { server: t.server, home: t.home });
    await run.waitFor("Your direction:");
    run.type("Checkout that never gets a total wrong");
    await run.waitFor("Approve? (y/n)");
    run.end();
    const r = await run.done;
    assert.strictEqual(r.code, 0, r.all);
    const v = t.server.calls.find((c) => c.path.endsWith("/vision"));
    assert.deepStrictEqual(v.body, { vision: "Checkout that never gets a total wrong" });
  } finally {
    await t.close();
  }
});
