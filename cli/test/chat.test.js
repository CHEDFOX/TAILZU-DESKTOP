"use strict";

// The session: talk, the plan's picker, the job followed quietly, its question, the end; and the ways out: Esc to stop a job,
// Ctrl+C twice to leave (the job going on), /exit. Lines typed through a pipe, or keys pressed one by one (XODE_KEYS=1).

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { createFakeServer, defaultScript } = require("./fakeServer");
const { runCli, tempHome } = require("./runCli");
const { createFileStore } = require("../src/auth/fileStore");

const FAKE = "xdt_fake_chat_test_token_abcdefghijkl";
const KEYS = { XODE_KEYS: "1" };
const SHORT = defaultScript().filter((s) => !s.question);

async function setup(opts = {}) {
  const server = await createFakeServer(opts);
  const home = tempHome();
  server.addToken(FAKE);
  await createFileStore({ XDG_CONFIG_HOME: home.config }).set(new URL(server.url).host, FAKE);
  return { server, home, close: async () => { await server.close(); home.cleanup(); } };
}

const positions = (text, list) => list.map((s) => text.indexOf(s));
const STAGE_LINES = ["● Understand", "● Plan", "● Build", "● Check", "● Ship"];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const says = (server) => server.calls.filter((c) => c.path.endsWith("/say"));
const stops = (server) => server.calls.filter((c) => c.method === "POST" && /\/v1\/code\/jobs\/[^/]+\/stop$/.test(c.path));

for (const live of [false, true]) {
  test(`xode "words": the answer, the plan's picker, the stages, the question, the end, and the session stays (${live ? "live room" : "polling"})`, async () => {
    const t = await setup({ live });
    try {
      const run = runCli(["fix the cart rounding"], { server: t.server, home: t.home });
      await run.waitFor("Start this plan?");
      run.type("1");
      await run.waitFor("Xode asks: Should prices round half up");
      run.type("1");
      await run.waitFor("Pull request:");
      await pause(100);
      assert.strictEqual(run.child.exitCode, null, "the end of the job doesn't end the session");
      run.type("/exit");
      const r = await run.done;
      assert.strictEqual(r.code, 0, r.all);

      assert.ok(r.stdout.startsWith("Xode · ana/storefront\n> fix the cart rounding\n"), r.stdout.slice(0, 200));
      assert.ok(!/Using|This computer: online/.test(r.stdout), "nothing said about what went well");
      // Xode's answer, then the plan's steps, numbered, then the picker.
      assert.match(r.stdout, /The total is rounded per item in src\/cart\/total\.ts:42/);
      assert.match(r.stdout, /The plan · version 2/);
      assert.match(r.stdout, / 1\. Round the total once/);
      assert.match(r.stdout, /Start this plan\?\n {2}1\. Yes\n {2}2\. No, tell Xode what to change\n {2}❯ Yes\n/);
      // The stages: one short line each, once, in order.
      const at = positions(r.stdout, STAGE_LINES);
      assert.ok(at.every((p) => p >= 0), r.stdout);
      assert.deepStrictEqual([...at].sort((a, b) => a - b), at);
      for (const s of STAGE_LINES) assert.strictEqual(r.stdout.split(s).length, 2, `${s} more than once`);
      assert.ok(!/Stage \d of 5/.test(r.stdout));
      // What it did, in short lines.
      assert.match(r.stdout, /src\/cart\/total\.ts/);
      assert.match(r.stdout, live ? / {2}· Ran npm test/ : / {2}· Ran the tests · 18 passed/);
      // The question, as a picker with a way to answer in one's own words.
      assert.match(r.stdout, /Xode asks: Should prices round half up, or half to even\?\n {2}1\. Half up\n {2}2\. Half to even\n {2}3\. Type your own answer\n/);
      const job = [...t.server.jobs.values()][0];
      assert.deepStrictEqual(job.answers, ["Half up"]);
      // The end: the summary, the branch, the pull request.
      assert.match(r.stdout, /Fixed the cart rounding/);
      assert.match(r.stdout, /Pull request: https:\/\/github\.com\/ana\/storefront\/pull\/42/);

      const say = says(t.server)[0];
      assert.strictEqual(say.body.text, "fix the cart rounding");
      assert.match(say.body.thread, /^[0-9a-f-]{36}$/);
      const approve = t.server.calls.find((c) => c.path.endsWith("/approve") && c.path.includes("/flow/"));
      assert.deepStrictEqual(approve.body, { thread: say.body.thread, v: 2 });
      assert.strictEqual(t.server.calls.some((c) => c.method === "WS" && c.path.endsWith("/watch")), live);
      assert.ok(!r.all.includes(FAKE));
    } finally {
      await t.close();
    }
  });
}

test("Ctrl+C twice while a job runs: xode leaves, the job keeps going (no stop)", async () => {
  const t = await setup({ stepMs: 300 });
  try {
    const run = runCli(["fix the cart rounding"], { server: t.server, home: t.home });
    await run.waitFor("Start this plan?");
    run.type("1");
    await run.waitFor("● Understand");
    run.child.kill("SIGINT");
    await run.waitFor("Press Esc to stop the job, or Ctrl+C again to exit");
    run.child.kill("SIGINT");
    const r = await run.done;
    assert.strictEqual(r.code, 0, r.all);
    assert.match(r.stdout, /Xode keeps working\. Run xode here to follow it\.\n$/);
    assert.deepStrictEqual(stops(t.server), []);
    const job = [...t.server.jobs.values()][0];
    assert.ok(!["cancelled", "done", "failed"].includes(job.state), job.state);
  } finally {
    await t.close();
  }
});

test("keys: Ctrl+C twice at the prompt leaves; with a job running it is left running", async () => {
  const t = await setup({ stepMs: 300 });
  try {
    // Nothing going on: two presses, out.
    const quiet = runCli([], { server: t.server, home: t.home, env: KEYS });
    await quiet.waitFor("Xode · ana/storefront");
    await pause(150);
    quiet.keys("\x03");
    await quiet.waitFor("Press Ctrl+C again to exit");
    quiet.keys("\x03");
    const q = await quiet.done;
    assert.strictEqual(q.code, 0, q.all);
    assert.ok(!/keeps working/.test(q.stdout));

    // Ctrl+D on an empty line: the same.
    const d = runCli([], { server: t.server, home: t.home, env: KEYS });
    await d.waitFor("Xode · ana/storefront");
    await pause(150);
    d.keys("\x04");
    await d.waitFor("Press Ctrl+D again to exit");
    d.keys("\x04");
    assert.strictEqual((await d.done).code, 0);

    // A job running: the job goes on.
    const run = runCli(["fix the cart rounding"], { server: t.server, home: t.home, env: KEYS });
    await run.waitFor("Start this plan?");
    run.keys("1");
    await run.waitFor("● Understand");
    run.keys("\x03");
    await run.waitFor("Ctrl+C again to exit");
    run.keys("\x03");
    const r = await run.done;
    assert.strictEqual(r.code, 0, r.all);
    assert.match(r.stdout, /Xode keeps working\. Run xode here to follow it\./);
    assert.deepStrictEqual(stops(t.server), []);
  } finally {
    await t.close();
  }
});

test("keys: Esc twice stops the job; the session goes on", async () => {
  const t = await setup({ stepMs: 250 });
  try {
    const run = runCli(["fix the cart rounding"], { server: t.server, home: t.home, env: KEYS });
    await run.waitFor("Start this plan?");
    run.keys("\r");
    await run.waitFor("● Understand");
    run.keys("\x1b");
    await run.waitFor("Press Esc again to stop the job");
    run.keys("\x1b");
    await run.waitFor("The job was stopped.");
    const job = [...t.server.jobs.values()][0];
    assert.strictEqual(stops(t.server).length, 1);
    assert.strictEqual(stops(t.server)[0].path, `/v1/code/jobs/${job.id}/stop`);
    assert.strictEqual(job.state, "cancelled");
    await pause(100);
    run.keys("/exit\r");
    const r = await run.done;
    assert.strictEqual(r.code, 0, r.all);
    assert.ok(!/keeps working/.test(r.stdout), "nothing left running");
    assert.strictEqual((r.stdout.match(/The job was stopped\./g) || []).length, 1, "said once");
  } finally {
    await t.close();
  }
});

test("keys: the plan's picker by number and by Enter on the default; a question answered in one's own words", async () => {
  const t = await setup({ stepMs: 30 });
  try {
    const run = runCli([], { server: t.server, home: t.home, env: KEYS });
    await run.waitFor("Xode · ana/storefront");
    await pause(100);
    run.keys("fix the cart rounding\r");
    await run.waitFor("Start this plan?");
    run.keys("2");
    await run.waitFor("❯ No, tell Xode what to change");
    assert.ok(!t.server.calls.some((c) => c.path.endsWith("/approve")));
    await pause(50);
    run.keys("round it once, at the end\r");
    await run.waitForNext("Start this plan?");
    run.keys("\r");
    await run.waitFor("Xode asks:");
    run.keys("3");
    await run.waitFor("Your answer:");
    run.keys("half up, like the till\r");
    await run.waitFor("Pull request:");
    await pause(100);
    run.keys("/exit\r");
    const r = await run.done;
    assert.strictEqual(r.code, 0, r.all);
    const approves = t.server.calls.filter((c) => c.path.endsWith("/approve") && c.path.includes("/flow/"));
    assert.strictEqual(approves.length, 1);
    assert.strictEqual(approves[0].body.v, 3);
    assert.deepStrictEqual([...t.server.jobs.values()][0].answers, ["half up, like the till"]);
    assert.match(r.stdout, /❯ Type your own answer/);
  } finally {
    await t.close();
  }
});

test("keys: Esc while Xode is thinking cancels that message and the prompt is back", async () => {
  const t = await setup({ sayDelayMs: 1500 });
  try {
    const run = runCli([], { server: t.server, home: t.home, env: KEYS });
    await run.waitFor("Xode · ana/storefront");
    await pause(100);
    run.keys("a slow question\r");
    await pause(300);
    run.keys("\x1b");
    await run.waitFor("Cancelled.");
    run.keys("/exit\r");
    const r = await run.done;
    assert.strictEqual(r.code, 0, r.all);
    assert.ok(!/Start this plan/.test(r.stdout));
  } finally {
    await t.close();
  }
});

test("a message typed while it works goes to the plan's judge", async () => {
  const t = await setup({ stepMs: 200 });
  try {
    const run = runCli(["fix the cart rounding"], { server: t.server, home: t.home });
    await run.waitFor("Start this plan?");
    run.type("1");
    await run.waitFor("● Understand");
    run.type("keep the old helper too");
    await run.waitFor("Noted. I'll keep that in mind");
    await run.waitFor("Xode asks");
    run.type("2");
    await run.waitFor("Pull request:");
    run.end();
    const r = await run.done;
    assert.strictEqual(r.code, 0, r.all);
    const work = t.server.calls.find((c) => c.path.endsWith("/work"));
    assert.strictEqual(work.body.text, "keep the old helper too");
    assert.deepStrictEqual([...t.server.jobs.values()][0].answers, ["Half to even"]);
  } finally {
    await t.close();
  }
});

test("a failed job says so plainly, and the session goes on", async () => {
  const script = defaultScript().slice(0, 3).concat([{ fail: "The tests would not pass." }]);
  const t = await setup({ script });
  try {
    const run = runCli(["fix the cart rounding"], { server: t.server, home: t.home });
    await run.waitFor("Start this plan?");
    run.type("y");
    await run.waitFor("The job failed");
    run.end();
    const r = await run.done;
    assert.strictEqual(r.code, 0, r.all);
    assert.match(r.stdout, /The job failed: The tests would not pass\./);
  } finally {
    await t.close();
  }
});

test("xode: the folder's project among several, nothing pushed at the start, /plan offers it, Ctrl+C twice leaves", async () => {
  const projects = [
    { id: "11111111-1111-4111-8111-111111111111", fullName: "ana/blog", defaultBranch: "main" },
    { id: "6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7", fullName: "Ana/StoreFront", defaultBranch: "main" },
  ];
  const t = await setup({ projects });
  try {
    const run = runCli([], { server: t.server, home: t.home });
    await run.waitFor("Xode · Ana/StoreFront");
    await pause(200);
    assert.ok(!/Which project|Start this plan|The plan/.test(run.output), run.output);
    run.type("/plan");
    await run.waitFor("Start this plan?");
    assert.match(run.output, /Where it stands/);
    run.type("2");
    await run.waitFor("❯ No, tell Xode what to change");
    run.child.kill("SIGINT");
    await run.waitFor("Press Ctrl+C again to exit");
    run.child.kill("SIGINT");
    const r = await run.done;
    assert.strictEqual(r.code, 0, r.all);
    assert.ok(t.server.calls.some((c) => c.path === `/v1/bots/code/flow/${projects[1].id}/plan`));
    assert.ok(!t.server.calls.some((c) => c.path.endsWith("/approve")));
  } finally {
    await t.close();
  }
});

test("slash commands: the list, /help, an unknown one, /status, /clear starts a fresh chat, /quit", async () => {
  const t = await setup({ script: SHORT, stepMs: 20 });
  try {
    const run = runCli([], { server: t.server, home: t.home });
    await run.waitFor("Xode · ana/storefront");
    run.type("/");
    await run.waitFor("/exit     leave (or /quit)");
    for (const n of ["/help", "/clear", "/plan", "/diff", "/status", "/stop", "/login", "/logout", "/exit"]) assert.ok(run.output.includes(n), n);
    run.type("/frobnicate");
    await run.waitFor("Unknown command. /help lists them.");
    run.type("/diff");
    await run.waitFor("No work branch here yet");
    run.type("/status");
    await run.waitFor("This computer:");
    assert.match(run.output, /Signed in as ana@example\.com\nDevice: test-box\nServer: .*\nProject: ana\/storefront\nThis computer: /);
    run.type("first thread");
    await run.waitFor("Start this plan?");
    run.type("2");
    await run.waitFor("❯ No");
    run.type("/clear");
    await run.waitFor("A fresh chat for this folder.");
    run.type("second thread");
    await run.waitForNext("Start this plan?");
    run.type("2");
    await run.waitForNext("❯ No");
    run.type("/quit");
    const r = await run.done;
    assert.strictEqual(r.code, 0, r.all);
    const [a, b] = says(t.server);
    assert.notStrictEqual(a.body.thread, b.body.thread);
    assert.strictEqual(b.body.text, "second thread");
  } finally {
    await t.close();
  }
});

test("/diff: the last work branch against the default branch, in full", async () => {
  const t = await setup({ script: SHORT, stepMs: 20 });
  try {
    const run = runCli(["fix the cart rounding"], { server: t.server, home: t.home });
    await run.waitFor("Start this plan?");
    run.type("1");
    await run.waitFor("Pull request:");
    run.type("/diff");
    await run.waitFor("+  return round(lines.reduce");
    run.type("/exit");
    const r = await run.done;
    assert.strictEqual(r.code, 0, r.all);
    assert.match(r.stdout, /xode\/fix-cart-rounding against main\ndiff --git a\/src\/cart\/total\.test\.ts/);
    assert.match(r.stdout, /\n-  return lines\.map\(round\)/);
  } finally {
    await t.close();
  }
});

test("! runs a command in the project's folder; its output goes in front of the next message", async () => {
  const t = await setup();
  try {
    const run = runCli([], { server: t.server, home: t.home });
    await run.waitFor("Xode · ana/storefront");
    run.type("!echo from-the-shell && git rev-parse --show-toplevel && exit 4");
    await run.waitFor("(attached to your next message)");
    assert.match(run.output, /from-the-shell\n/);
    assert.match(run.output, /exit 4 \(attached to your next message\)/);
    run.type("why does it end with 4?");
    await run.waitFor("Start this plan?");
    run.type("2");
    run.type("and this one?");
    await run.waitForNext("Start this plan?");
    run.type("2");
    run.end();
    const r = await run.done;
    assert.strictEqual(r.code, 0, r.all);
    const [first, second] = says(t.server);
    const top = fs.realpathSync(t.home.work);
    assert.strictEqual(first.body.text, `I ran: echo from-the-shell && git rev-parse --show-toplevel && exit 4\nexit 4\nfrom-the-shell\n${top}\n\nwhy does it end with 4?`);
    assert.strictEqual(second.body.text, "and this one?", "sent once, with the next message only");
  } finally {
    await t.close();
  }
});

test("keys: history per folder, Up brings it back, and a line that looks like a secret is never kept", async () => {
  const t = await setup();
  try {
    const run = runCli([], { server: t.server, home: t.home, env: KEYS });
    await run.waitFor("Xode · ana/storefront");
    await pause(100);
    run.keys("/status\r");
    await run.waitFor("This computer:");
    run.keys("my token is xyz, use it\r");
    await run.waitFor("Start this plan?");
    run.keys("2");
    await pause(100);
    run.keys("/exit\r");
    assert.strictEqual((await run.done).code, 0);
    const file = path.join(t.home.config, "xode", "history.json");
    const kept = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepStrictEqual(Object.values(kept.folders), [["/status", "/exit"]]);
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);

    // Next time, Up goes back through them (the last first) and Enter sends one again.
    const again = runCli([], { server: t.server, home: t.home, env: KEYS });
    await again.waitFor("Xode · ana/storefront");
    await pause(100);
    again.keys("\x1b[A");
    await pause(50);
    again.keys("\x1b[A");
    await pause(50);
    again.keys("\r");
    await again.waitFor("This computer:");
    again.keys("\x03\x03");
    assert.strictEqual((await again.done).code, 0);
  } finally {
    await t.close();
  }
});

test("keys: a paste of several lines is one message", async () => {
  const t = await setup();
  try {
    const run = runCli([], { server: t.server, home: t.home, env: KEYS });
    await run.waitFor("Xode · ana/storefront");
    await pause(100);
    run.keys("\x1b[200~the cart total is wrong\nwhen there are 3 items\x1b[201~");
    await pause(50);
    run.keys("\r");
    await run.waitFor("Start this plan?");
    run.keys("2");
    await pause(50);
    run.keys("/exit\r");
    assert.strictEqual((await run.done).code, 0);
    assert.deepStrictEqual(says(t.server).map((c) => c.body.text), ["the cart total is wrong\nwhen there are 3 items"]);
  } finally {
    await t.close();
  }
});

test("xode stop stops this folder's job; status shows it", async () => {
  const t = await setup({ stepMs: 400 });
  try {
    const run = runCli(["--project", t.server.projectId, "fix the cart rounding"], { server: t.server, home: t.home });
    await run.waitFor("Start this plan?");
    run.type("1");
    await run.waitFor("● Understand");
    const st = await runCli(["status"], { server: t.server, home: t.home }).done;
    assert.match(st.stdout, /Job here: working · stage \d of 5/);
    const s = await runCli(["stop"], { server: t.server, home: t.home }).done;
    assert.strictEqual(s.code, 0, s.all);
    assert.match(s.stdout, /Stopped the job\./);
    await run.waitFor("The job was stopped.");
    run.end();
    const r = await run.done;
    assert.strictEqual(r.code, 0);
    const again = await runCli(["stop"], { server: t.server, home: t.home }).done;
    assert.match(again.stdout, /No job is running in this folder\./);
  } finally {
    await t.close();
  }
});

test("a job left running is followed again by the next xode here, or, ended meanwhile, brought in", async () => {
  const t = await setup({ script: SHORT, stepMs: 150 });
  try {
    const run = runCli(["fix the cart rounding"], { server: t.server, home: t.home, env: { XODE_RUNNER: "0" } });
    await run.waitFor("Start this plan?");
    run.type("1");
    await run.waitFor("● Understand");
    run.type("/exit");
    assert.match((await run.done).stdout, /Xode keeps working/);
    const job = [...t.server.jobs.values()][0];
    while (job.state !== "done") await pause(50);
    const back = runCli([], { server: t.server, home: t.home, env: { XODE_RUNNER: "0" } });
    await back.waitFor("Pull request:");
    back.end();
    const r = await back.done;
    assert.strictEqual(r.code, 0, r.all);
    assert.match(r.stdout, /The job started here ended while you were away\./);
    assert.match(r.stdout, /Switched to xode\/fix-cart-rounding, with Xode's changes\./);
    // Said once: the next time, nothing.
    const third = runCli([], { server: t.server, home: t.home, env: { XODE_RUNNER: "0" } });
    await third.waitFor("Xode · ana/storefront");
    third.end();
    assert.ok(!/while you were away/.test((await third.done).stdout));
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
    await run.waitFor("Start this plan?");
    run.end();
    const r = await run.done;
    assert.strictEqual(r.code, 0, r.all);
    const v = t.server.calls.find((c) => c.path.endsWith("/vision"));
    assert.deepStrictEqual(v.body, { vision: "Checkout that never gets a total wrong" });
  } finally {
    await t.close();
  }
});
