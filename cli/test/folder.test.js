"use strict";

// The folder: which project it is (its git remote against the person's Xode projects), and the work branch coming back into it
// when a job ends. Real git, in temporary folders: a bare "GitHub" repository and a clone whose origin reads github.com
// (gitFixture.js).

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { createFakeServer, defaultScript, PROJECT_ID } = require("./fakeServer");
const { runCli, tempHome } = require("./runCli");
const { git } = require("./gitFixture");
const { createFileStore } = require("../src/auth/fileStore");
const { parseRemote } = require("../src/project/remoteUrl");

const FAKE = "xdt_fake_folder_test_token_abcdefghij";
const BRANCH = "xode/fix-cart-rounding";
// The job without its question, so a one-shot needs only its yes.
const SHORT = defaultScript().filter((s) => !s.question);

async function setup(opts = {}, homeOpts = {}) {
  const server = await createFakeServer({ script: SHORT, stepMs: 20, ...opts });
  const home = tempHome(homeOpts);
  server.addToken(FAKE);
  await createFileStore({ XDG_CONFIG_HOME: home.config }).set(new URL(server.url).host, FAKE);
  return { server, home, close: async () => { await server.close(); home.cleanup(); } };
}

const head = (dir) => git(dir, "rev-parse", "--abbrev-ref", "HEAD").trim();
const sha = (dir, ref) => git(dir, "rev-parse", ref).trim();

test("remote addresses: every common GitHub form, and others told apart", () => {
  const want = { owner: "Ana", repo: "Store-Front", fullName: "ana/store-front" };
  for (const u of [
    "https://github.com/Ana/Store-Front", "https://github.com/Ana/Store-Front.git", "https://github.com/Ana/Store-Front/",
    "https://github.com/Ana/Store-Front.git/", "http://github.com/Ana/Store-Front", "https://user:secret@github.com/Ana/Store-Front.git",
    "https://GitHub.com/Ana/Store-Front", "git@github.com:Ana/Store-Front.git", "git@github.com:Ana/Store-Front", "git@github.com:Ana/Store-Front/",
    "ssh://git@github.com/Ana/Store-Front.git", "ssh://git@github.com:22/Ana/Store-Front", "git://github.com/Ana/Store-Front.git",
    "github.com:Ana/Store-Front.git",
  ]) assert.deepStrictEqual(parseRemote(u), want, u);
  for (const u of ["git@gitlab.com:ana/store.git", "https://bitbucket.org/ana/store", "/srv/git/store.git", "file:///srv/git/store.git", "../store"]) {
    assert.deepStrictEqual(parseRemote(u), { notGithub: true }, u);
  }
  assert.strictEqual(parseRemote("https://github.com/ana"), null);
  assert.strictEqual(parseRemote("https://github.com/ana/store/tree/main"), null);
  assert.strictEqual(parseRemote(""), null);
});

test("outside a git repository: refused in one sentence, exit 2", async () => {
  const t = await setup();
  try {
    const r = await runCli(["fix the cart rounding"], { server: t.server, home: t.home, cwd: t.home.plain }).done;
    assert.strictEqual(r.code, 2, r.all);
    assert.strictEqual(r.stderr.trim(), "This isn't a git repository: run xode inside your project's folder.");
    assert.ok(!t.server.calls.some((c) => c.path.startsWith("/v1/bots/code/")));
  } finally {
    await t.close();
  }
});

test("a remote that isn't GitHub: refused in one sentence", async () => {
  const t = await setup();
  try {
    git(t.home.work, "remote", "set-url", "origin", "git@gitlab.com:ana/storefront.git");
    const r = await runCli(["fix the cart rounding"], { server: t.server, home: t.home }).done;
    assert.strictEqual(r.code, 2, r.all);
    assert.strictEqual(r.stderr.trim(), "This repository's remote isn't on GitHub: Xode works with GitHub repositories.");
  } finally {
    await t.close();
  }
});

test("the folder's project is found from its remote (case aside), from a subfolder too, and remembered for the top folder", async () => {
  const projects = [
    { id: "11111111-1111-4111-8111-111111111111", fullName: "ana/blog", defaultBranch: "main" },
    { id: PROJECT_ID, fullName: "ANA/storefront", defaultBranch: "main" },
  ];
  const t = await setup({ projects });
  try {
    const sub = path.join(t.home.work, "src", "cart");
    const run = runCli(["fix the cart rounding"], { server: t.server, home: t.home, cwd: sub, env: { XODE_RUNNER: "0" } });
    await run.waitFor("Start this plan?");
    run.type("y");
    run.end();
    const r = await run.done;
    assert.strictEqual(r.code, 0, r.all);
    assert.ok(t.server.calls.some((c) => c.path === `/v1/bots/code/flow/${PROJECT_ID}/say`));
    const state = JSON.parse(fs.readFileSync(path.join(t.home.config, "xode", "state.json"), "utf8"));
    const keys = Object.keys(state.folders);
    assert.strictEqual(keys.length, 1);
    assert.ok(keys[0].endsWith(" " + fs.realpathSync(t.home.work)), keys[0]);
    assert.strictEqual(state.folders[keys[0]].projectId, PROJECT_ID);
  } finally {
    await t.close();
  }
});

test("--project still wins over the folder's remote", async () => {
  const other = "11111111-1111-4111-8111-111111111111";
  const projects = [{ id: other, fullName: "ana/blog", defaultBranch: "main" }, { id: PROJECT_ID, fullName: "ana/storefront", defaultBranch: "main" }];
  const t = await setup({ projects });
  try {
    const run = runCli(["--project", other, "--no-runner", "fix it"], { server: t.server, home: t.home });
    await run.waitFor("Start this plan?");
    run.type("y");
    run.end();
    const r = await run.done;
    assert.strictEqual(r.code, 0, r.all);
    assert.ok(t.server.calls.some((c) => c.path === `/v1/bots/code/flow/${other}/say`));
    // Another repository's branch is not fetched into this folder.
    assert.strictEqual(head(t.home.work), "main");
    assert.match(r.stdout, new RegExp(`The work is on branch ${BRANCH}\\.`));
  } finally {
    await t.close();
  }
});

test("not connected yet: the connect link, a wait, and once the project appears the chat goes on", async () => {
  const t = await setup({ projects: [{ id: "11111111-1111-4111-8111-111111111111", fullName: "ana/blog", defaultBranch: "main" }] });
  try {
    const run = runCli(["fix the cart rounding"], { server: t.server, home: t.home, env: { XODE_RUNNER: "0" } });
    await run.waitFor("Waiting for ana/storefront to show up in Xode");
    assert.match(run.output, /ana\/storefront isn't connected to Xode yet\./);
    assert.ok(run.output.includes(t.server.options.installUrl), run.output);
    assert.ok(!/Open it in your browser/.test(run.output), "not asked when it isn't a terminal");
    assert.ok(t.server.calls.some((c) => c.method === "POST" && c.path === "/v1/code/github/connect"));
    // Connected in X0 Bot meanwhile.
    t.server.options.projects.push({ id: PROJECT_ID, fullName: "ana/storefront", defaultBranch: "main" });
    await run.waitFor("ana/storefront is connected.");
    await run.waitFor("Start this plan?");
    run.type("y");
    run.end();
    const r = await run.done;
    assert.strictEqual(r.code, 0, r.all);
    assert.ok(t.server.calls.some((c) => c.path === `/v1/bots/code/flow/${PROJECT_ID}/say`));
  } finally {
    await t.close();
  }
});

test("a repository GitHub already lets Xode see is added on a yes", async () => {
  const t = await setup({ projects: [], repos: [{ id: 77, fullName: "ana/storefront", defaultBranch: "main", private: true }] });
  try {
    const run = runCli(["--no-runner"], { server: t.server, home: t.home });
    await run.waitFor("Add it to your Xode projects?");
    run.type("y");
    await run.waitFor("Xode · ana/storefront");
    run.end();
    const r = await run.done;
    assert.strictEqual(r.code, 0, r.all);
    const add = t.server.calls.find((c) => c.method === "POST" && c.path === "/v1/code/projects");
    assert.deepStrictEqual(add.body, { repoId: 77 });
    assert.strictEqual(t.server.options.projects[0].fullName, "ana/storefront");
  } finally {
    await t.close();
  }
});

test("a clean folder: switched to the work branch, git's diff --stat, and the pull request; status remembers them", async () => {
  const t = await setup();
  try {
    const run = runCli(["fix the cart rounding"], { server: t.server, home: t.home });
    await run.waitFor("Start this plan?");
    run.type("y");
    run.end();
    const r = await run.done;
    assert.strictEqual(r.code, 0, r.all);
    assert.match(r.stdout, new RegExp(`Switched to ${BRANCH}, with Xode's changes\\.`));
    assert.match(r.stdout, /src\/cart\/total\.ts\s+\|\s+\d+/);
    assert.match(r.stdout, /2 files changed/);
    const at = (s) => r.stdout.indexOf(s);
    assert.ok(at("Switched to") < at("2 files changed") && at("2 files changed") < at("Pull request: https://github.com/ana/storefront/pull/42"), r.stdout);
    assert.strictEqual(r.stdout.split("Pull request:").length, 2, "the pull request once");
    assert.strictEqual(head(t.home.work), BRANCH);
    assert.strictEqual(sha(t.home.work, "HEAD"), sha(t.home.repos.bare, BRANCH));
    assert.match(fs.readFileSync(path.join(t.home.work, "src", "cart", "total.ts"), "utf8"), /return round\(lines\.reduce/);
    const st = await runCli(["status"], { server: t.server, home: t.home }).done;
    assert.match(st.stdout, /Last job here: done/);
    assert.match(st.stdout, new RegExp(`Work branch: ${BRANCH}`));
    assert.match(st.stdout, /Pull request: https:\/\/github\.com\/ana\/storefront\/pull\/42/);
  } finally {
    await t.close();
  }
});

test("uncommitted changes: nothing fetched, nothing touched, and the two commands to do it", async () => {
  // The job pushes again as it ends, so a fetch would show.
  let pushed = "";
  const t = await setup({ onJobEnd: () => { t.home.repos.addWork({ "NOTES.md": "more\n" }, "More"); pushed = sha(t.home.repos.bare, BRANCH); } });
  try {
    const before = sha(t.home.work, `refs/remotes/origin/${BRANCH}`);
    fs.writeFileSync(path.join(t.home.work, "scratch.txt"), "mine\n");
    const run = runCli(["fix the cart rounding"], { server: t.server, home: t.home, env: { XODE_RUNNER: "0" } });
    await run.waitFor("Start this plan?");
    run.type("y");
    run.end();
    const r = await run.done;
    assert.strictEqual(r.code, 0, r.all);
    assert.ok(r.stdout.includes("You have uncommitted changes, so I left your folder as it is."), r.stdout);
    assert.ok(r.stdout.includes(`\n  git fetch origin ${BRANCH} && git switch ${BRANCH}\n`), r.stdout);
    assert.match(r.stdout, /Pull request: https:\/\/github\.com\/ana\/storefront\/pull\/42/);
    assert.ok(pushed && pushed !== before);
    assert.strictEqual(sha(t.home.work, `refs/remotes/origin/${BRANCH}`), before, "nothing was fetched");
    assert.strictEqual(head(t.home.work), "main");
    assert.strictEqual(fs.readFileSync(path.join(t.home.work, "scratch.txt"), "utf8"), "mine\n");
    assert.match(git(t.home.work, "status", "--porcelain"), /^\?\? scratch\.txt/m);
  } finally {
    await t.close();
  }
});

test("already on the work branch: a fast-forward", async () => {
  const t = await setup({ onJobEnd: () => t.home.repos.addWork({ "src/cart/line.ts": "export const line = (p: number) => p;\n" }, "Keep line prices whole") });
  try {
    git(t.home.work, "switch", "-q", BRANCH);
    const mine = sha(t.home.work, "HEAD");
    const run = runCli(["fix the cart rounding"], { server: t.server, home: t.home, env: { XODE_RUNNER: "0" } });
    await run.waitFor("Start this plan?");
    run.type("y");
    run.end();
    const r = await run.done;
    assert.strictEqual(r.code, 0, r.all);
    assert.match(r.stdout, new RegExp(`Updated ${BRANCH} with Xode's changes\\.`));
    assert.strictEqual(head(t.home.work), BRANCH);
    assert.notStrictEqual(sha(t.home.work, "HEAD"), mine);
    assert.strictEqual(sha(t.home.work, "HEAD"), sha(t.home.repos.bare, BRANCH));
    assert.match(r.stdout, /src\/cart\/line\.ts/);
    git(t.home.work, "merge-base", "--is-ancestor", mine, "HEAD");
  } finally {
    await t.close();
  }
});

test("a local branch of the same name with commits of the person's own is left as it is", async () => {
  const t = await setup();
  try {
    git(t.home.work, "switch", "-q", "-c", BRANCH, "main");
    fs.writeFileSync(path.join(t.home.work, "mine.txt"), "mine\n");
    git(t.home.work, "add", "mine.txt");
    git(t.home.work, "commit", "-q", "-m", "Mine");
    const mine = sha(t.home.work, "HEAD");
    git(t.home.work, "switch", "-q", "main");
    const run = runCli(["fix the cart rounding"], { server: t.server, home: t.home, env: { XODE_RUNNER: "0" } });
    await run.waitFor("Start this plan?");
    run.type("y");
    run.end();
    const r = await run.done;
    assert.strictEqual(r.code, 0, r.all);
    assert.match(r.stdout, new RegExp(`Your own ${BRANCH} has commits Xode's doesn't, so I left it as it is\\. Xode's work is at origin/${BRANCH}\\.`));
    assert.strictEqual(sha(t.home.work, BRANCH), mine);
    assert.strictEqual(head(t.home.work), "main");
  } finally {
    await t.close();
  }
});

test("a failed job that pushed its branch brings it back too, with its draft pull request", async () => {
  const script = SHORT.filter((s) => !s.done).concat([{ fail: "The tests would not pass." }]);
  const t = await setup({ script });
  try {
    const run = runCli(["fix the cart rounding"], { server: t.server, home: t.home, env: { XODE_RUNNER: "0" } });
    await run.waitFor("Start this plan?");
    run.type("y");
    run.end();
    const r = await run.done;
    assert.strictEqual(r.code, 0, r.all);
    assert.match(r.stdout, /The job failed: The tests would not pass\./);
    assert.match(r.stdout, new RegExp(`Switched to ${BRANCH}, with Xode's changes\\.`));
    assert.match(r.stdout, /Pull request \(draft\): https:\/\/github\.com\/ana\/storefront\/pull\/42/);
  } finally {
    await t.close();
  }
});
