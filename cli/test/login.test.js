"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { createFakeServer } = require("./fakeServer");
const { runCli, tempHome } = require("./runCli");

const credFile = (home) => path.join(home.config, "xode", "credentials.json");

test("login prints the code, keeps the token in a 600 file, and never prints it", async () => {
  const server = await createFakeServer({ approveAfterPolls: 3 });
  const home = tempHome();
  try {
    const r = await runCli(["login"], { server, home }).done;
    assert.strictEqual(r.code, 0, r.all);
    assert.ok(r.stdout.startsWith(
      "To sign in, open x0bot.com/device and enter the code\n  ABCD-EFGH\n(or open https://x0bot.com/device?code=ABCD-EFGH)\nWaiting for you to approve it in X0 Bot…\n",
    ), r.stdout);
    assert.match(r.stdout, /Signed in as ana@example\.com/);

    const polls = server.calls.filter((c) => c.path === "/v1/auth/link/poll");
    assert.strictEqual(polls.length, 3);
    assert.strictEqual(polls[0].body.wait, 25000);
    const link = server.calls.find((c) => c.path === "/v1/auth/link");
    assert.strictEqual(link.body.kind, "cli");
    assert.ok(link.body.deviceName);
    assert.ok(link.body.platform);

    const saved = JSON.parse(fs.readFileSync(credFile(home), "utf8"));
    const host = new URL(server.url).host;
    const token = saved.servers[host].token;
    assert.match(token, /^xdt_/);
    assert.ok(server.tokens.has(token));
    assert.strictEqual(fs.statSync(credFile(home)).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(path.dirname(credFile(home))).mode & 0o777, 0o700);
    assert.ok(!r.all.includes(token), "the token was printed");
    assert.ok(!r.all.includes(token.slice(4, 20)), "part of the token was printed");

    // Nothing else holds it: no stray temporary files beside it.
    assert.deepStrictEqual(fs.readdirSync(path.dirname(credFile(home))), ["credentials.json"]);
  } finally {
    await server.close();
    home.cleanup();
  }
});

for (const [outcome, words] of [["denied", /turned down/], ["expired", /ran out/], ["failed", /didn't go through/]]) {
  test(`a ${outcome} sign-in says so in one sentence, exits 1 and keeps nothing`, async () => {
    const server = await createFakeServer({ linkOutcome: outcome, approveAfterPolls: 2 });
    const home = tempHome();
    try {
      const r = await runCli(["login"], { server, home }).done;
      assert.strictEqual(r.code, 1, r.all);
      assert.match(r.stderr, words);
      assert.strictEqual(r.stderr.trim().split("\n").length, 1);
      assert.ok(!fs.existsSync(credFile(home)));
    } finally {
      await server.close();
      home.cleanup();
    }
  });
}

test("Ctrl+C while waiting cancels the sign-in cleanly", async () => {
  const server = await createFakeServer({ approveAfterPolls: 1000, pollHoldMs: 100 });
  const home = tempHome();
  try {
    const run = runCli(["login"], { server, home });
    await run.waitFor("Waiting for you to approve it");
    run.child.kill("SIGINT");
    const r = await run.done;
    assert.strictEqual(r.code, 130);
    assert.match(r.stdout, /Sign-in cancelled\./);
    assert.ok(!fs.existsSync(credFile(home)));
  } finally {
    await server.close();
    home.cleanup();
  }
});
