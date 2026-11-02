// node --test
//
// Nothing Tailzu Code starts is left behind (procs.js, watchdog.js): a group killed whole, a polite stop that escalates, everything at
// once and synchronously for a process that is exiting, and the watchdog that kills the groups when the app dies without a word.

const nodeTest = require("node:test");
const { afterEach } = nodeTest;
// A test that waits for ever fails after a minute and a half instead of hanging the run.
const SKIP = process.platform === "win32" ? "needs bash, git and process groups: not run on Windows" : false;
const test = (name, fn) => nodeTest(name, { timeout: 90000, skip: SKIP }, fn);
const assert = require("node:assert");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { createProcs } = require("./procs.js");
const { createWatchdog, WATCHDOG_SRC } = require("./watchdog.js");
const { tempDir, alive, until } = require("./testkit.js");

/** A detached shell running `script`, as a command is, with the pids it wrote down. */
const started = [];
afterEach(() => { for (const c of started.splice(0)) { try { process.kill(-c.pid, "SIGKILL"); } catch { /* gone */ } } });
function start(dir, script) {
  const child = childProcess.spawn("/bin/bash", ["-c", script], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.resume(); child.stderr.resume();
  started.push(child);
  return child;
}
const exited = (c) => (c.exitCode !== null || c.signalCode ? Promise.resolve() : new Promise((r) => c.once("exit", r)));
const pidOf = async (dir, name) => { await until(() => fs.existsSync(path.join(dir, name)) && fs.readFileSync(path.join(dir, name), "utf8").trim(), 4000, name); return Number(fs.readFileSync(path.join(dir, name), "utf8")); };

test("killing a child kills its whole group, the processes it started too", async () => {
  const t = tempDir("tzprocs-");
  const procs = createProcs({});
  const c = start(t.dir, "sleep 60 & echo $! > kid.pid; wait");
  procs.track(c, "x");
  const kid = await pidOf(t.dir, "kid.pid");
  assert.ok(alive(c.pid) && alive(kid));
  procs.kill(c);
  await until(() => !alive(c.pid) && !alive(kid), 3000, "both to die");
  t.remove();
});

test("a stop is polite first: SIGTERM, then SIGKILL for one that ignores it", async () => {
  const t = tempDir("tzprocs-");
  const procs = createProcs({});
  const c = start(t.dir, "trap '' TERM; echo ready > ready; while true; do sleep 0.1; done");
  procs.track(c, "stubborn");
  await pidOf(t.dir, "ready").catch(() => {});
  await until(() => fs.existsSync(path.join(t.dir, "ready")), 3000, "the trap to be set");
  procs.terminate(c, 400);
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(alive(c.pid), "it ignored the polite signal");
  await until(() => !alive(c.pid), 3000, "SIGKILL to finish it");
  t.remove();
});

test("killAll ends everything, killAllSync before it returns, and a finished child is forgotten", async () => {
  const t = tempDir("tzprocs-");
  const procs = createProcs({});
  const a = start(t.dir, "sleep 60");
  const b = start(t.dir, "sleep 60");
  const done = start(t.dir, "true");
  procs.track(a, "a"); procs.track(b, "b"); procs.track(done, "done");
  assert.strictEqual(procs.size, 3);
  await exited(done);
  procs.settle(done);
  assert.strictEqual(procs.size, 2, "a command that has ended and left nothing behind is forgotten");
  procs.killAllSync();
  assert.strictEqual(procs.size, 0);
  await until(() => !alive(a.pid) && !alive(b.pid), 3000, "all to be gone");
  t.remove();
});

test("a child with something still running in its group stays on the list until it is killed", async () => {
  const t = tempDir("tzprocs-");
  const procs = createProcs({});
  const c = start(t.dir, "sleep 60 > /dev/null 2>&1 & echo $! > bg.pid");
  procs.track(c, "leaves a process");
  const bg = await pidOf(t.dir, "bg.pid");
  await exited(c);
  procs.settle(c);
  assert.strictEqual(procs.size, 1);
  procs.killAll();
  await until(() => !alive(bg), 3000, "the leftover to be killed");
  t.remove();
});

test("on Windows a tree is ended with taskkill /T /F", () => {
  const calls = [];
  const procs = createProcs({ platform: "win32", spawnSync: (f, a) => { calls.push([f, a]); return {}; } });
  procs.track({ pid: 4242, kill() {} }, "x");
  procs.killAllSync();
  assert.deepStrictEqual(calls, [["taskkill", ["/pid", "4242", "/T", "/F"]]]);
});

test("a container is killed by name as well as the docker program that started it", () => {
  const spawned = [];
  const procs = createProcs({ platform: "linux", kill: () => { throw new Error("gone"); }, spawnSync: (f, a) => { spawned.push([f, a]); return {}; } });
  procs.track({ pid: 999999, kill() {} }, "x", "tailzu-abc");
  procs.killAllSync();
  assert.deepStrictEqual(spawned, [["docker", ["kill", "tailzu-abc"]]]);
});

test("THE WATCHDOG KILLS THE GROUPS WHEN THE APP DIES WITHOUT SAYING GOODBYE, and leaves them alone when it said it", async () => {
  const t = tempDir("tzdog-");
  // The app, as far as the watchdog can tell, is whoever holds its stdin.
  const spawnDog = () => childProcess.spawn(process.execPath, ["-e", WATCHDOG_SRC], { stdio: ["pipe", "ignore", "ignore"], env: { ELECTRON_RUN_AS_NODE: "1", PATH: process.env.PATH } });

  const a = start(t.dir, "sleep 60");
  const dog = spawnDog();
  dog.stdin.write("add " + a.pid + "\n");
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(alive(a.pid));
  dog.stdin.destroy();   // the pipe closes with no `exit`: the app is gone
  await until(() => !alive(a.pid), 4000, "the watchdog to kill the group");

  const b = start(t.dir, "sleep 60");
  const dog2 = spawnDog();
  dog2.stdin.write("add " + b.pid + "\ndel " + b.pid + "\nadd " + b.pid + "\nexit\n");
  dog2.stdin.end();
  await exited(dog2);
  assert.ok(alive(b.pid), "a clean goodbye kills nothing");
  process.kill(-b.pid, "SIGKILL");

  const c = start(t.dir, "sleep 60");
  const dog3 = spawnDog();
  dog3.stdin.write("add " + c.pid + "\ndel " + c.pid + "\n");
  dog3.stdin.destroy();
  await exited(dog3);
  assert.ok(alive(c.pid), "a group that was reported over is not touched");
  process.kill(-c.pid, "SIGKILL");
  t.remove();
});

test("the registry hands each group to the watchdog and tells it when it is over", async () => {
  const sent = [];
  const fakeChild = { stdin: { destroyed: false, write: (s) => sent.push(s), end() {}, on() {}, unref() {} }, on() {}, unref() {} };
  const dog = createWatchdog({ spawn: () => fakeChild });
  const t = tempDir("tzdog-");
  const procs = createProcs({ watchdog: dog });
  const c = start(t.dir, "true");
  procs.track(c, "x");
  await exited(c);
  procs.settle(c);
  procs.release();
  assert.deepStrictEqual(sent, ["add " + c.pid + "\n", "del " + c.pid + "\n", "exit\n"]);
  t.remove();
});
