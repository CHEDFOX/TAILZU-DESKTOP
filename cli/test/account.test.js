"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { createFakeServer } = require("./fakeServer");
const { runCli, tempHome } = require("./runCli");
const { createFileStore } = require("../src/auth/fileStore");

const FAKE = "xdt_fake_account_test_token_0123456789";

async function signedIn(server, home, token = FAKE) {
  server.addToken(token, "ana-laptop");
  await createFileStore({ XDG_CONFIG_HOME: home.config }).set(new URL(server.url).host, token);
}

test("status says who is signed in, on which device and server", async () => {
  const server = await createFakeServer();
  const home = tempHome();
  try {
    await signedIn(server, home);
    const r = await runCli(["status"], { server, home }).done;
    assert.strictEqual(r.code, 0, r.all);
    assert.match(r.stdout, /Signed in as ana@example\.com/);
    assert.match(r.stdout, /Device: ana-laptop/);
    assert.ok(r.stdout.includes(`Server: ${server.url}`));
    assert.ok(!r.all.includes(FAKE));
  } finally {
    await server.close();
    home.cleanup();
  }
});

test("status when signed out", async () => {
  const server = await createFakeServer();
  const home = tempHome();
  try {
    const r = await runCli(["status"], { server, home }).done;
    assert.strictEqual(r.code, 1);
    assert.match(r.stdout, /Not signed in\. Run xode\./);
  } finally {
    await server.close();
    home.cleanup();
  }
});

test("a token the server no longer takes reads as signed out", async () => {
  const server = await createFakeServer();
  const home = tempHome();
  try {
    await createFileStore({ XDG_CONFIG_HOME: home.config }).set(new URL(server.url).host, FAKE);
    const r = await runCli(["status"], { server, home }).done;
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /Signed out: run xode to sign in again\./);
    assert.ok(!r.all.includes(FAKE));
  } finally {
    await server.close();
    home.cleanup();
  }
});

test("logout revokes the token on the server and deletes it here", async () => {
  const server = await createFakeServer();
  const home = tempHome();
  try {
    await signedIn(server, home);
    const r = await runCli(["logout"], { server, home }).done;
    assert.strictEqual(r.code, 0, r.all);
    assert.match(r.stdout, /Signed out\./);
    const revoke = server.calls.find((c) => c.path === "/v1/auth/device/revoke");
    assert.ok(revoke && revoke.auth);
    assert.ok(!server.tokens.has(FAKE));
    assert.ok(!fs.existsSync(path.join(home.config, "xode", "credentials.json")));
    const again = await runCli(["logout"], { server, home }).done;
    assert.match(again.stdout, /not signed in/);
  } finally {
    await server.close();
    home.cleanup();
  }
});
