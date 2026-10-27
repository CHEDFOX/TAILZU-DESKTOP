// node --test
//
// The workspace (workspace.js, gitrun.js): the project's code on this computer, from a LOCAL BARE REPOSITORY standing in for GitHub.
// The first job clones, every later job fetches only what changed (and nothing at all when the commit is already here), the job's branch is
// checked out at the job's commit, untracked files like node_modules survive from job to job, and the read-only token goes to git in its
// environment only - never into the repository's config, a file, or a command line.

const nodeTest = require("node:test");
// A test that waits for ever fails after a minute and a half instead of hanging the run.
const SKIP = process.platform === "win32" ? "needs bash, git and process groups: not run on Windows" : false;
const test = (name, fn) => nodeTest(name, { timeout: 90000, skip: SKIP }, fn);
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const http = require("node:http");
const { createWorkspaces, tarExtract, defaultUrlPolicy, branchOk } = require("./workspace.js");
const { createGit, gitEnv, basicHeader } = require("./gitrun.js");
const { bareRepo, tempDir, sh } = require("./testkit.js");

function rig(commits, o = {}) {
  const t = tempDir("tzws-");
  const remote = bareRepo(path.join(t.dir, "remote"), commits);
  const home = path.join(t.dir, "home");
  fs.mkdirSync(home);
  const calls = [];
  const realExecFile = childProcess.execFile;
  const execFile = (file, args, opts, cb) => { calls.push({ file, args, env: opts && opts.env }); return realExecFile(file, args, opts, cb); };
  const git = createGit({ execFile, real: process.env, home });
  const root = path.join(t.dir, "workspaces");
  const ws = createWorkspaces({ root, git, urlPolicy: () => true, tar: tarExtract, ...o });
  const repo = (i, extra = {}) => ({ kind: "app", cloneUrl: remote.url, branch: "tailzu/fix-login", headSha: remote.shas[i], ...extra });
  return { t, remote, git, ws, root, calls, repo, dir: path.join(root, "proj-1") };
}

test("the first job clones the code at the job's commit, on the job's branch", async () => {
  const r = rig([{ "a.txt": "one\n", "src/x.js": "x\n" }, { "b.txt": "two\n" }]);
  const res = await r.ws.prepare({ projectId: "proj-1", repo: r.repo(0) });
  assert.strictEqual(res.ok, true, res.error);
  assert.strictEqual(res.how, "fetch");
  assert.strictEqual(res.dir, r.dir);
  assert.deepStrictEqual(fs.readdirSync(r.dir).sort(), [".git", "a.txt", "src"]);
  assert.strictEqual(sh("git rev-parse HEAD", r.dir), r.remote.shas[0]);
  assert.strictEqual(sh("git branch --show-current", r.dir), "tailzu/fix-login");
  assert.match(sh("git rev-parse --is-shallow-repository", r.dir), /true/, "a shallow checkout: the commit and not the history");
  r.t.remove();
});

test("a later job fetches only what changed, and nothing at all for a commit it already has", async () => {
  const r = rig([{ "a.txt": "one\n" }, { "a.txt": "two\n", "new.txt": "n\n" }]);
  await r.ws.prepare({ projectId: "proj-1", repo: r.repo(0) });
  const fetches = () => r.calls.filter((c) => c.args.includes("fetch")).length;
  assert.strictEqual(fetches(), 1);
  const same = await r.ws.prepare({ projectId: "proj-1", repo: r.repo(0) });
  assert.strictEqual(same.how, "cached");
  assert.strictEqual(fetches(), 1, "the commit was here: no fetch");
  const next = await r.ws.prepare({ projectId: "proj-1", repo: r.repo(1) });
  assert.strictEqual(next.ok, true, next.error);
  assert.strictEqual(next.how, "fetch");
  assert.strictEqual(fetches(), 2);
  assert.strictEqual(fs.readFileSync(path.join(r.dir, "a.txt"), "utf8"), "two\n");
  assert.ok(fs.existsSync(path.join(r.dir, "new.txt")));
  // The fetch asked for the one commit, shallow.
  const f = r.calls.filter((c) => c.args.includes("fetch")).pop();
  assert.ok(f.args.includes("--depth=1") && f.args.includes(r.remote.shas[1]));
  // And the earlier commit can be had again without a fetch.
  const back = await r.ws.prepare({ projectId: "proj-1", repo: r.repo(0) });
  assert.strictEqual(back.how, "cached");
  assert.strictEqual(fs.readFileSync(path.join(r.dir, "a.txt"), "utf8"), "one\n");
  assert.ok(!fs.existsSync(path.join(r.dir, "new.txt")), "a file the other commit added is gone with it");
  r.t.remove();
});

test("the same workspace is reused: node_modules and other untracked files survive from job to job, local edits do not", async () => {
  const r = rig([{ "a.txt": "one\n", ".gitignore": "node_modules\n" }, { "a.txt": "two\n" }]);
  await r.ws.prepare({ projectId: "proj-1", repo: r.repo(0) });
  fs.mkdirSync(path.join(r.dir, "node_modules/dep"), { recursive: true });
  fs.writeFileSync(path.join(r.dir, "node_modules/dep/i.js"), "installed");
  fs.writeFileSync(path.join(r.dir, "build.log"), "log");
  fs.writeFileSync(path.join(r.dir, "a.txt"), "LOCAL EDIT BY A COMMAND\n");
  const res = await r.ws.prepare({ projectId: "proj-1", repo: r.repo(1) });
  assert.strictEqual(res.ok, true, res.error);
  assert.strictEqual(fs.readFileSync(path.join(r.dir, "a.txt"), "utf8"), "two\n");
  assert.strictEqual(fs.readFileSync(path.join(r.dir, "node_modules/dep/i.js"), "utf8"), "installed");
  assert.ok(fs.existsSync(path.join(r.dir, "build.log")));
  r.t.remove();
});

test("THE READ-ONLY TOKEN GOES TO GIT IN ITS ENVIRONMENT ONLY: not in the config, not on a command line, not in a file", async () => {
  const r = rig([{ "a.txt": "one\n" }]);
  const token = "ghs_ReadOnlyTokenForTheTest0123456789";
  const res = await r.ws.prepare({ projectId: "proj-1", repo: r.repo(0, { readToken: token, readTokenExpiresAt: Date.now() + 3600000 }) });
  assert.strictEqual(res.ok, true, res.error);
  const fetchCall = r.calls.find((c) => c.args.includes("fetch"));
  assert.ok(!fetchCall.args.join(" ").includes(token), "not on the command line");
  assert.ok(!fetchCall.args.join(" ").includes(Buffer.from("x-access-token:" + token).toString("base64")));
  assert.strictEqual(fetchCall.env.GIT_CONFIG_COUNT, "1");
  assert.strictEqual(fetchCall.env.GIT_CONFIG_KEY_0, "http.extraHeader");
  assert.strictEqual(fetchCall.env.GIT_CONFIG_VALUE_0, basicHeader(token));
  for (const c of r.calls.filter((x) => x !== fetchCall)) assert.ok(!JSON.stringify(c.env).includes(token), "other git calls do not carry it");
  // Nowhere on disk.
  const all = [];
  (function walk(d) { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); const st = fs.lstatSync(p); if (st.isDirectory()) walk(p); else if (st.isFile()) all.push(fs.readFileSync(p)); } })(r.dir);
  for (const b of all) { assert.ok(!b.includes(token)); assert.ok(!b.includes(Buffer.from("x-access-token:" + token).toString("base64"))); }
  assert.ok(!/extraheader|token|authorization/i.test(fs.readFileSync(path.join(r.dir, ".git/config"), "utf8")), "nor in the repository's config");
  r.t.remove();
});

test("git is kept apart from the person's own git setup: no global config, no credential helper, no prompt, no hooks", async () => {
  const env = gitEnv({ real: { PATH: "/usr/bin", HOME: "/home/a", GIT_ASKPASS: "/evil", HTTPS_PROXY: "http://p:1", SSH_AUTH_SOCK: "/s", GITHUB_TOKEN: "ghp_x" }, loginPath: "/opt/bin", home: "/private", platform: "linux" });
  assert.strictEqual(env.HOME, "/private");
  assert.strictEqual(env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.strictEqual(env.GIT_CONFIG_NOSYSTEM, "1");
  assert.strictEqual(env.GIT_TERMINAL_PROMPT, "0");
  assert.strictEqual(env.GIT_ASKPASS, "echo");
  assert.strictEqual(env.HTTPS_PROXY, "http://p:1", "a proxy is how the fetch gets out");
  assert.ok(!("SSH_AUTH_SOCK" in env) && !("GITHUB_TOKEN" in env));
  const r = rig([{ "a.txt": "x\n" }]);
  await r.ws.prepare({ projectId: "proj-1", repo: r.repo(0) });
  const args = r.calls.find((c) => c.args.includes("fetch")).args;
  assert.ok(args.includes("credential.helper="));
  assert.ok(args.some((a) => a.startsWith("core.hooksPath=")));
  r.t.remove();
});

test("an address that is not GitHub over https, an odd project name, an expired token and a missing commit are refused before git runs", async () => {
  const r = rig([{ "a.txt": "x\n" }], { urlPolicy: defaultUrlPolicy });
  const refused = await r.ws.prepare({ projectId: "proj-1", repo: r.repo(0) });
  assert.strictEqual(refused.ok, false);
  assert.match(refused.error, /address/);
  assert.strictEqual(r.calls.filter((c) => c.args.includes("fetch")).length, 0);
  assert.ok(defaultUrlPolicy("https://github.com/acme/app.git", "clone"));
  for (const bad of ["http://github.com/a/b.git", "https://evil.example/a/b.git", "https://user:pw@github.com/a/b.git", "https://github.com.evil.example/a.git", "git@github.com:a/b.git", "file:///etc", "ssh://git@github.com/a/b"]) assert.ok(!defaultUrlPolicy(bad, "clone"), bad);
  assert.ok(defaultUrlPolicy("https://codeload.github.com/acme/app/legacy.tar.gz/refs/heads/x?token=abc", "tarball"));
  assert.ok(!defaultUrlPolicy("https://evil.example/x.tgz", "tarball"));

  const ok = rig([{ "a.txt": "x\n" }]);
  for (const id of ["../x", "a/b", "", ".", "..", "a b", "x".repeat(101), "-rf"]) assert.strictEqual((await ok.ws.prepare({ projectId: id, repo: ok.repo(0) })).ok, false, JSON.stringify(id));
  assert.match((await ok.ws.prepare({ projectId: "p", repo: ok.repo(0, { readToken: "t", readTokenExpiresAt: Date.now() - 1000 }) })).error, /expired/);
  assert.match((await ok.ws.prepare({ projectId: "p", repo: ok.repo(0, { headSha: "main" }) })).error, /commit/);
  const missing = await ok.ws.prepare({ projectId: "p", repo: ok.repo(0, { headSha: "f".repeat(40) }) });
  assert.strictEqual(missing.ok, false);
  assert.match(missing.error, /could not fetch/);
  assert.ok(!fs.readdirSync(ok.root).includes("..") && !fs.existsSync(path.join(ok.t.dir, "x")));
  r.t.remove(); ok.t.remove();
});

test("branch names that git would take, and only those, are checked out by name", () => {
  for (const ok of ["tailzu/fix-login", "main", "feature/a_b.c", "tailzu/x-1a2b"]) assert.ok(branchOk(ok), ok);
  for (const bad of ["", "-rf", "a..b", "a b", "a~1", "a^", "a:b", "a?", "a*", "a[", "a\\b", "/a", "a/", "a.lock", "a.", "a//b", "a@{1}", ".hidden", "a/.b", "x".repeat(256)]) assert.ok(!branchOk(bad), JSON.stringify(bad));
});

test("a workspace git cannot read is thrown away and made again, once", async () => {
  const r = rig([{ "a.txt": "one\n" }]);
  await r.ws.prepare({ projectId: "proj-1", repo: r.repo(0) });
  // Wreck it: the objects are corrupt.
  const objects = path.join(r.dir, ".git", "objects");
  fs.writeFileSync(path.join(r.dir, ".git", "index"), "garbage");
  for (const d of fs.readdirSync(objects)) if (/^[0-9a-f]{2}$/.test(d)) fs.rmSync(path.join(objects, d), { recursive: true, force: true });
  const res = await r.ws.prepare({ projectId: "proj-1", repo: r.repo(0) });
  assert.strictEqual(res.ok, true, res.error);
  assert.strictEqual(sh("git rev-parse HEAD", r.dir), r.remote.shas[0]);
  r.t.remove();
});

test("a lock left by a killed git does not stop the next job", async () => {
  const r = rig([{ "a.txt": "one\n" }, { "a.txt": "two\n" }]);
  await r.ws.prepare({ projectId: "proj-1", repo: r.repo(0) });
  fs.writeFileSync(path.join(r.dir, ".git", "index.lock"), "");
  fs.writeFileSync(path.join(r.dir, ".git", "shallow.lock"), "");
  const res = await r.ws.prepare({ projectId: "proj-1", repo: r.repo(1) });
  assert.strictEqual(res.ok, true, res.error);
  r.t.remove();
});

test("workspaces nobody has used for a month are removed; recent ones and half-made ones are handled", async () => {
  const r = rig([{ "a.txt": "x\n" }]);
  let clock = Date.now();
  const ws = createWorkspaces({ root: r.root, git: r.git, urlPolicy: () => true, now: () => clock });
  await ws.prepare({ projectId: "old", repo: r.repo(0) });
  clock += 20 * 86400000;
  await ws.prepare({ projectId: "recent", repo: r.repo(0) });
  fs.mkdirSync(path.join(r.root, ".tmp-leftover"));
  clock += 15 * 86400000;
  assert.deepStrictEqual(await ws.prune(30), ["old"]);
  assert.deepStrictEqual(fs.readdirSync(r.root).sort(), ["recent"]);
  r.t.remove();
});

test("a project connected by sign-in comes as a one-time download link, and is made a repository too", async () => {
  const t = tempDir("tzws-");
  // The tarball GitHub would redirect to: one top folder holding the tree.
  const src = path.join(t.dir, "src", "acme-app-abc123");
  fs.mkdirSync(path.join(src, "lib"), { recursive: true });
  fs.writeFileSync(path.join(src, "main.js"), "console.log(1)\n");
  fs.writeFileSync(path.join(src, "lib", "util.js"), "u\n");
  fs.writeFileSync(path.join(src, ".gitignore"), "ignored.txt\n");
  fs.writeFileSync(path.join(src, "ignored.txt"), "tracked although ignored\n");
  const tgz = path.join(t.dir, "code.tgz");
  childProcess.execSync(`tar -czf ${JSON.stringify(tgz)} -C ${JSON.stringify(path.join(t.dir, "src"))} acme-app-abc123`);
  let hits = 0;
  const server = http.createServer((req, res) => { hits += 1; res.writeHead(200, { "Content-Type": "application/x-gzip" }); fs.createReadStream(tgz).pipe(res); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = "http://127.0.0.1:" + server.address().port + "/signed?token=once";
  try {
    const home = path.join(t.dir, "home");
    fs.mkdirSync(home);
    const git = createGit({ real: process.env, home });
    const ws = createWorkspaces({ root: path.join(t.dir, "workspaces"), git, urlPolicy: () => true, tar: tarExtract });
    const repo = { kind: "oauth", cloneUrl: "https://github.com/acme/app.git", branch: "tailzu/x", headSha: "a".repeat(40), tarballUrl: url };
    const res = await ws.prepare({ projectId: "proj-oauth", repo });
    assert.strictEqual(res.ok, true, res.error);
    assert.strictEqual(res.how, "tarball");
    assert.strictEqual(fs.readFileSync(path.join(res.dir, "lib", "util.js"), "utf8"), "u\n");
    assert.ok(fs.existsSync(path.join(res.dir, "ignored.txt")), "everything the download held is in, whatever .gitignore says");
    assert.strictEqual(sh("git status --porcelain", res.dir), "", "and it is a clean repository on the branch");
    assert.strictEqual(sh("git branch --show-current", res.dir), "tailzu/x");
    // The link is good once: the same commit again needs no second download.
    const again = await ws.prepare({ projectId: "proj-oauth", repo });
    assert.strictEqual(again.ok, true, again.error);
    assert.strictEqual(again.how, "cached");
    assert.strictEqual(hits, 1);
    // A refused link is an error, not a half-made workspace.
    const bad = await ws.prepare({ projectId: "proj-oauth2", repo: { ...repo, headSha: "b".repeat(40), tarballUrl: "http://127.0.0.1:1/nothing" } });
    assert.strictEqual(bad.ok, false);
  } finally { server.close(); t.remove(); }
});
