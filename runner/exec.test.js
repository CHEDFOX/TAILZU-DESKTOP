// node --test
//
// Running commands (exec.js) on this computer, for real: bash in a temporary workspace. The time limit and what happens at it, the
// scrubbed environment (a fake secret in this app's own environment never reaches a child), cancel, the process group that dies with its
// shell, a background process that must not hold the step up, and the container's `docker run` line.

const nodeTest = require("node:test");
const { afterEach } = nodeTest;
// A test that waits for ever fails after a minute and a half instead of hanging the run.
const SKIP = process.platform === "win32" ? "needs bash, git and process groups: not run on Windows" : false;
const test = (name, fn) => nodeTest(name, { timeout: 90000, skip: SKIP }, fn);
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { runCommands, createSpawner, hostShell } = require("./exec.js");
const { commandEnv, runnerPaths, ensurePaths } = require("./env.js");
const { createProcs } = require("./procs.js");
const { dockerRunArgs, dockerStatus, dockerClientEnv, DEFAULT_IMAGE } = require("./docker.js");
const { tempDir, alive, until } = require("./testkit.js");

function rig(realExtra = {}) {
  const t = tempDir("tzexec-");
  const paths = runnerPaths(path.join(t.dir, "ud"));
  ensurePaths(paths);
  const ws = path.join(paths.workspaces, "p1");
  fs.mkdirSync(ws, { recursive: true });
  const real = { PATH: process.env.PATH, HOME: "/home/someone", LANG: "C.UTF-8", ...realExtra };
  const env = commandEnv({ real, paths, platform: process.platform });
  const procs = createProcs({});
  const out = [];
  const spawnCommand = createSpawner({});
  const run = (commands, timeoutSec, extra = {}) => runCommands(commands, timeoutSec, { cwd: ws, env, echo: (s) => out.push(s), procs, spawnCommand, ...extra });
  const rigged = { t, paths, ws, env, procs, out, run, text: () => out.join(""), remove: () => { procs.killAll(); t.remove(); } };
  rigs.push(rigged);
  return rigged;
}
// A test that fails halfway must not leave a process running, or the run never ends.
const rigs = [];
afterEach(() => { for (const r of rigs.splice(0)) r.remove(); });

test("commands run in order in the workspace, each echoed, and the first failure stops the rest", async () => {
  const r = rig();
  const res = await r.run(["pwd", "echo second", "exit 3", "echo never"], 30);
  assert.strictEqual(res.exitCode, 3);
  assert.strictEqual(res.ran, 3);
  assert.match(r.text(), /\$ pwd\n/);
  assert.ok(r.text().includes(r.ws + "\n"), "the command ran in the workspace");
  assert.match(r.text(), /\$ echo second\nsecond\n/);
  assert.ok(!r.text().includes("never"));
  assert.strictEqual((await r.run(["true", "echo ok"], 30)).exitCode, 0);
  r.remove();
});

test("a command that cannot start is 127, not a crash", async () => {
  const r = rig();
  const res = await r.run(["this-program-does-not-exist-anywhere"], 30);
  assert.strictEqual(res.exitCode, 127);
  r.remove();
});

test("A SECRET IN THIS APP'S ENVIRONMENT NEVER REACHES THE CHILD", async () => {
  const fake = { FAKE_TOKEN: "fake-secret-value-do-not-leak", AWS_SECRET_ACCESS_KEY: "aws-fake-secret-value", GITHUB_TOKEN: "ghp_fakefakefakefakefakefakefakefakefake", ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--no-warnings" };
  const r = rig(fake);
  const res = await r.run(["env", "printenv FAKE_TOKEN || echo 'FAKE_TOKEN is not set'", "echo \"[$AWS_SECRET_ACCESS_KEY][$GITHUB_TOKEN][$NODE_OPTIONS]\"", "echo $HOME"], 30);
  assert.strictEqual(res.exitCode, 0);
  const t = r.text();
  for (const v of Object.values(fake).filter((x) => x.length >= 8)) assert.ok(!t.includes(v), "the value " + v + " reached the child");
  assert.ok(!/FAKE_TOKEN=|AWS_SECRET|GITHUB_TOKEN=|ELECTRON_RUN|NODE_OPTIONS=/.test(t.replace(/\$ .*\n/g, "")), "no such variable in the child's environment");
  assert.match(t, /FAKE_TOKEN is not set/);
  assert.match(t, /\[\]\[\]\[\]/);
  assert.ok(t.includes(r.paths.home + "\n"), "HOME is the private folder");
  assert.ok(!t.includes("/home/someone"));
  // What it does have: PATH, HOME, LANG and the caches.
  const names = t.split("\n").filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l)).map((l) => l.split("=")[0]);
  for (const n of ["PATH", "HOME", "LANG", "npm_config_cache", "PIP_CACHE_DIR", "CARGO_HOME"]) assert.ok(names.includes(n), n);
  for (const n of names) assert.ok(["PATH", "HOME", "LANG", "TMPDIR", "npm_config_cache", "PIP_CACHE_DIR", "CARGO_HOME", "RUSTUP_HOME", "PWD", "OLDPWD", "SHLVL", "_"].includes(n), "unexpected variable " + n);
  r.remove();
});

test("a command that runs past its time is killed with its whole group: exit 124, timedOut, and nothing left running", async () => {
  const r = rig();
  const t0 = Date.now();
  const res = await r.run(["echo $$ > shell.pid; sleep 30 & echo $! > child.pid; wait"], 1);
  assert.strictEqual(res.exitCode, 124);
  assert.strictEqual(res.timedOut, true);
  assert.ok(Date.now() - t0 < 5000, "stopped at the limit, not later");
  assert.match(r.text(), /\[X0 Bot: stopped after 1 seconds, the time this step had\]/);
  const shellPid = Number(fs.readFileSync(path.join(r.ws, "shell.pid"), "utf8"));
  const childPid = Number(fs.readFileSync(path.join(r.ws, "child.pid"), "utf8"));
  await until(() => !alive(shellPid) && !alive(childPid), 3000, "the shell and its child to be gone");
  r.remove();
});

test("each command gets the time the step has left, not the whole limit again", async () => {
  const r = rig();
  const res = await r.run(["sleep 0.7", "sleep 0.7", "echo not reached"], 1);
  assert.strictEqual(res.exitCode, 124);
  assert.ok(!r.text().includes("not reached"));
  assert.strictEqual(res.ran, 2);
  r.remove();
});

test("a cancel stops the running command with exit 130, and the group is gone", async () => {
  const r = rig();
  const ac = new AbortController();
  const done = r.run(["echo $$ > shell.pid; sleep 30"], 60, { signal: ac.signal });
  await until(() => fs.existsSync(path.join(r.ws, "shell.pid")) && fs.readFileSync(path.join(r.ws, "shell.pid"), "utf8").trim(), 4000, "the command to start");
  const pid = Number(fs.readFileSync(path.join(r.ws, "shell.pid"), "utf8"));
  ac.abort();
  const res = await done;
  assert.strictEqual(res.exitCode, 130);
  assert.strictEqual(res.cancelled, true);
  assert.match(r.text(), /\[X0 Bot: stopped\]/);
  await until(() => !alive(pid), 3000, "the shell to be gone");
  r.remove();
});

test("a background process does not hold the step up, and is killed when the session ends", async () => {
  const r = rig();
  const t0 = Date.now();
  const res = await r.run(["sleep 60 > /dev/null 2>&1 & echo $! > bg.pid; echo started"], 30, { graceMs: 200 });
  assert.strictEqual(res.exitCode, 0);
  assert.ok(Date.now() - t0 < 4000);
  const bg = Number(fs.readFileSync(path.join(r.ws, "bg.pid"), "utf8"));
  assert.ok(alive(bg), "it was left running");
  assert.ok(r.procs.size > 0, "and X0 Code knows of it");
  r.procs.killAll();
  await until(() => !alive(bg), 3000, "the background process to be killed");
  r.remove();
});

test("the hooks hear each command start and end, with its exit code and time", async () => {
  const r = rig();
  const events = [];
  await r.run(["true", "exit 5"], 30, { onStart: (e) => events.push(["start", e.command]), onEnd: (e) => events.push(["end", e.command, e.exitCode, typeof e.ms]) });
  assert.deepStrictEqual(events, [["start", "true"], ["end", "true", 0, "number"], ["start", "exit 5"], ["end", "exit 5", 5, "number"]]);
  r.remove();
});

test("the output sink gets the output as it comes, not at the end", async () => {
  const r = rig();
  const times = [];
  await r.run(["echo one; sleep 0.4; echo two"], 30, { echo: (s) => times.push([Date.now(), s]) });
  const one = times.find(([, s]) => s === "one\n");
  const two = times.find(([, s]) => s === "two\n");
  assert.ok(two[0] - one[0] >= 250, "one arrived well before two");
  r.remove();
});

test("the shell is bash where there is one, and cmd.exe on a Windows without it", () => {
  const sh = hostShell("linux", fs, process.env.PATH);
  assert.ok(/bash$/.test(sh.file));
  assert.deepStrictEqual(sh.args("echo hi"), ["-c", "echo hi"]);
  const noBash = hostShell("win32", { existsSync: () => false }, "C:\\Windows\\System32;C:\\Tools");
  assert.ok(/cmd/i.test(noBash.file));
  assert.deepStrictEqual(noBash.args("dir"), ["/d", "/s", "/c", "dir"]);
  const gitBash = hostShell("win32", { existsSync: (p) => p === "C:\\Program Files\\Git\\bin\\bash.exe" }, "C:\\Windows\\System32;C:\\Program Files\\Git\\bin");
  assert.strictEqual(gitBash.file, "C:\\Program Files\\Git\\bin\\bash.exe");
});

// ---- the container ----

test("the container's line mounts only the workspace, drops capabilities, inherits nothing, and publishes a dev server on 127.0.0.1 only", () => {
  const args = dockerRunArgs({ image: DEFAULT_IMAGE, name: "tailzu-abc", workspace: "/data/ws/p1", cache: "/data/cache", command: "npm test", uid: 501, gid: 20, ports: [5173], env: { PORT: "5173", HOST: "0.0.0.0" } });
  assert.deepStrictEqual(args.slice(0, 3), ["run", "--rm", "--init"]);
  assert.ok(args.includes("--rm"), "a throwaway container");
  const joined = args.join(" ");
  assert.match(joined, /-v \/data\/ws\/p1:\/workspace/);
  assert.match(joined, /-v \/data\/cache:\/cache/);
  assert.strictEqual(args.filter((a) => a === "-v").length, 2, "only the workspace and the cache are mounted");
  assert.match(joined, /--cap-drop ALL/);
  assert.match(joined, /--security-opt no-new-privileges/);
  assert.match(joined, /--user 501:20/);
  assert.match(joined, /-p 127\.0\.0\.1:5173:5173/);
  assert.match(joined, /--env HOME=\/cache\/home/);
  assert.match(joined, /--env PORT=5173/);
  assert.deepStrictEqual(args.slice(-4), [DEFAULT_IMAGE, "bash", "-c", "npm test"]);
  assert.ok(!args.some((a) => /GITHUB|TOKEN|SECRET|AWS|HOME=\/home/.test(a)), "nothing of this app's");
  assert.ok(!args.includes("--privileged") && !args.includes("--network=host") && !args.includes("--net=host"));
  assert.ok(!dockerRunArgs({ name: "n", workspace: "w", command: "c" }).includes("--user"), "no user mapping where there is none to give (Windows)");
});

test("a container command is started through docker, with the docker client's own environment and not the container's", () => {
  const spawned = [];
  const spawn = (file, args, opts) => { spawned.push([file, args, opts]); return { pid: 1, on() {}, stdout: null, stderr: null }; };
  const sp = createSpawner({ spawn, container: { image: "img", workspace: "/w", cache: "/c", clientEnv: { PATH: "/usr/bin", DOCKER_HOST: "unix:///x" }, uid: 1, gid: 2 } });
  const started = sp("make", { cwd: "/w", env: { SHOULD_NOT: "pass" } });
  assert.match(started.container, /^tailzu-[0-9a-f]{10}$/);
  assert.strictEqual(spawned[0][0], "docker");
  assert.deepStrictEqual(spawned[0][2].env, { PATH: "/usr/bin", DOCKER_HOST: "unix:///x" });
  assert.ok(spawned[0][1].includes("--name") && spawned[0][1].includes(started.container));
  assert.ok(!spawned[0][1].join(" ").includes("SHOULD_NOT"));
  assert.deepStrictEqual(dockerClientEnv({ PATH: "/p", HOME: "/h", GITHUB_TOKEN: "no", DOCKER_HOST: "tcp://d" }, "/login"), { PATH: "/login", HOME: "/h", DOCKER_HOST: "tcp://d" });
});

test("Docker is found, found but not running, or not there", async () => {
  const ok = await dockerStatus({ execFile: (f, a, o, cb) => cb(null, "27.1.1\n", "") });
  assert.deepStrictEqual([ok.installed, ok.running, ok.version], [true, true, "27.1.1"]);
  const down = await dockerStatus({ execFile: (f, a, o, cb) => cb(Object.assign(new Error("x"), { code: 1 }), "", "Cannot connect to the Docker daemon") });
  assert.deepStrictEqual([down.installed, down.running], [true, false]);
  assert.match(down.reason, /not running/);
  const none = await dockerStatus({ execFile: (f, a, o, cb) => cb(Object.assign(new Error("x"), { code: "ENOENT" }), "", "") });
  assert.deepStrictEqual([none.installed, none.running], [false, false]);
  assert.match(none.reason, /not installed/);
  const denied = await dockerStatus({ execFile: (f, a, o, cb) => cb(Object.assign(new Error("x"), { code: 1 }), "", "permission denied while trying to connect") });
  assert.match(denied.reason, /not allowed/);
});
