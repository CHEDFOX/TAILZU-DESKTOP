// node --test
//
// Tailzu Code on this computer, the whole of it (index.js): the switch that is OFF until the person turns it on, presence, the first-time question for
// a project and the allow list after it, an offer for a live session from a fake Worker made into a real workspace (a local bare repository), a command
// run through a fake room and its result reported with the real minutes, an ordinary step with the changes handed back, Stop and quit killing
// everything, the server taking a step back, the battery pausing it, a Docker that is not there failing closed, and the audit log and the activity
// list that show it all.

const test = require("node:test");
const { afterEach } = test;
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createRunner, repoName } = require("./index.js");
const { startFakeCloud, bareRepo, tempDir, alive, until, tick } = require("./testkit.js");
const { isDeviceId } = require("./protocol.js");

const rigs = [];
afterEach(async () => { for (const r of rigs.splice(0)) await r.remove(); });
const SKIP = process.platform === "win32" ? "needs bash, git and process groups: not run on Windows" : false;
const withTimeout = (name, fn) => test(name, { timeout: 90000, skip: SKIP }, fn);

/** The runner, wired to a fake Worker and a fake VPS, with a local bare repository standing in for the project's GitHub. */
async function rig(o = {}) {
  const t = tempDir("tzrunner-");
  const owner = path.join(t.dir, "remote", "acme");
  fs.mkdirSync(owner, { recursive: true });
  const remote = bareRepo(owner, o.commits || [{ "a.txt": "A\n", "package.json": "{}\n", ".gitignore": "node_modules\n" }, { "a.txt": "A2\n" }], "main", "app");
  const cloud = await startFakeCloud({ jobs: o.jobs || { "job-1": { projectId: "proj-1" }, "job-2": { projectId: "proj-2" } }, projects: o.projects || [{ id: "proj-1", fullName: "acme/app" }, { id: "proj-2", fullName: "acme/other" }] });
  const state = o.state || {};
  const notes = [];
  const asked = [];
  const answers = o.answers || { "proj-1": true, "proj-2": true };
  const sig = { in: o.signedIn !== false };
  const power = { reading: o.power || { onBattery: false, percent: 100, lowPower: false } };
  const dockerState = { value: o.docker || { installed: true, running: true, version: "27", reason: "" } };
  let saves = 0;
  const runner = createRunner({
    userData: path.join(t.dir, "ud"), version: "1.2.3", platform: process.platform, hostname: "Work-Laptop.local",
    state, saveState: () => { saves += 1; },
    api: { fetch: (p, init) => fetch(cloud.url + p, init), signedIn: () => sig.in },
    secrets: () => ["the-apps-own-access-token-123"],
    ask: async (p) => { asked.push(p); return typeof answers[p.projectId] === "function" ? answers[p.projectId]() : answers[p.projectId] === undefined ? null : answers[p.projectId]; },
    notify: (m) => notes.push(m),
    config: o.config || {},
    urlPolicy: () => true, power: { read: async () => power.reading }, dockerStatus: async () => dockerState.value,
    noWatchdog: true, sleep: async () => {}, leaseEveryMs: o.leaseEveryMs || 30000, graceMs: o.graceMs === undefined ? 100 : o.graceMs,
    baseMs: 20, maxMs: 80, pingEveryMs: o.pingEveryMs, askWaitMs: o.askWaitMs || 500, real: { PATH: process.env.PATH, HOME: "/home/someone", LANG: "C.UTF-8", ...(o.real || {}) },
    previewLimits: { probeEveryMs: 50, probeMs: 500, readyMinSec: 1 },
  });
  const rigged = {
    t, cloud, runner, remote, state, notes, asked, sig, power, dockerState, answers, saves: () => saves,
    offer: (jobId, extra = {}) => {
      const offer = cloud.sessionOffer(jobId, { repo: { cloneUrl: remote.url, headSha: remote.shas[1], branch: "tailzu/fix" }, ...extra });
      return offer;
    },
    online: async () => { runner.setEnabled(true); await cloud.deviceWaiter.until(1, 8000); await until(() => runner.status().state === "online", 5000, "online"); return cloud.devices[cloud.devices.length - 1]; },
    workspace: (id = "proj-1") => path.join(t.dir, "ud", "workspaces", id),
    auditText: () => { const d = path.join(t.dir, "ud", "runner", "audit"); try { return fs.readdirSync(d).map((n) => fs.readFileSync(path.join(d, n), "utf8")).join(""); } catch { return ""; } },
    auditLines: () => rigged.auditText().trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    remove: async () => { try { runner.shutdown(); } catch { /* */ } await cloud.close(); t.remove(); },
  };
  rigs.push(rigged);
  return rigged;
}

withTimeout("OFF BY DEFAULT: nothing connects, nothing is asked of the server, until the person turns it on", async () => {
  const r = await rig();
  r.runner.start();
  await tick(5);
  await new Promise((res) => setTimeout(res, 150));
  assert.strictEqual(r.runner.status().enabled, false);
  assert.strictEqual(r.runner.status().state, "off");
  assert.strictEqual(r.state.enabled, false);
  assert.strictEqual(r.cloud.api.tickets.length, 0);
  assert.strictEqual(r.cloud.devices.length, 0);
  assert.strictEqual(r.state.container, false, "and the container setting is off too");
  assert.ok(isDeviceId(r.state.deviceId), "this computer has an id: " + r.state.deviceId);
  assert.ok(r.saves() >= 1, "the id was kept");
});

withTimeout("the computer's id is made once and kept; its name is the machine's, without .local", async () => {
  const r = await rig({ state: { deviceId: "desk-existing0001" } });
  assert.strictEqual(r.runner.status().deviceId, "desk-existing0001");
  assert.strictEqual(r.runner.status().deviceName, "Work-Laptop");
  const named = await rig({ config: { name: "Studio iMac" } });
  assert.strictEqual(named.runner.status().deviceName, "Studio iMac");
});

withTimeout("turned on, it goes online: a ticket for its device, the hello, and the state; turned off, it says bye and stays off", async () => {
  const r = await rig();
  const dev = await r.online();
  assert.deepStrictEqual(r.cloud.api.tickets, [{ deviceId: r.state.deviceId }]);
  const hello = await dev.waitFor("hello");
  assert.deepStrictEqual(hello, { t: "hello", v: 1, deviceId: r.state.deviceId, name: "Work-Laptop", allowRun: true, projects: "all", busy: false, app: "tailzu-desktop 1.2.3" });
  assert.strictEqual(r.state.enabled, true);
  r.runner.setEnabled(false);
  await dev.waitFor("bye");
  assert.strictEqual((await dev.waitClosed()).code, 1000);
  assert.strictEqual(r.runner.status().state, "off");
  await new Promise((res) => setTimeout(res, 200));
  assert.strictEqual(r.cloud.devices.length, 1, "it did not come back");
});

withTimeout("a LIVE SESSION, end to end: asked once, the code fetched, the room joined, a command run, the result reported with the real minutes", async () => {
  const r = await rig({ leaseEveryMs: 60 });
  const dev = await r.online();
  const offer = r.offer("job-1");
  dev.send({ t: "offer", offer });

  // The step's lease is kept from the first moment, and the question is put to the person about THIS project, by name.
  await until(() => r.cloud.api.progress.length >= 1, 5000, "the first progress");
  assert.deepStrictEqual(r.cloud.api.progress[0], { jobId: "job-1", epoch: 3 });
  await r.cloud.roomWaiter.until(1, 15000);
  assert.deepStrictEqual(r.asked, [{ projectId: "proj-1", name: "acme/app" }]);
  assert.strictEqual(r.state.projects["proj-1"].allowed, true, "the answer is kept");
  const state = await dev.waitFor((f) => f.t === "state" && f.busy === true);
  assert.deepStrictEqual(state, { t: "state", busy: true });

  const room = r.cloud.rooms[0];
  const hello = await room.waitFor("hello");
  assert.strictEqual(hello.kind, "desktop");
  assert.strictEqual(hello.name, "Work-Laptop");
  // The code is in the workspace, at the job's commit, on the job's branch.
  const ws = r.workspace();
  assert.strictEqual(fs.readFileSync(path.join(ws, "a.txt"), "utf8"), "A2\n");
  assert.strictEqual(require("./testkit.js").sh("git rev-parse HEAD", ws), r.remote.shas[1]);
  assert.strictEqual(require("./testkit.js").sh("git branch --show-current", ws), "tailzu/fix");
  assert.deepStrictEqual(r.runner.status().state, "working");
  assert.strictEqual(r.runner.status().project, "acme/app", "the tray says: X0 Bot is working on acme/app");

  room.send({ t: "exec", id: "e-1", commands: ["cat a.txt", "echo $HOME"], timeoutSec: 30, overlay: [{ path: "o.txt", content: "overlaid\n" }], discard: true });
  const done = await room.waitFor((f) => f.t === "done" && f.id === "e-1");
  assert.strictEqual(done.exitCode, 0);
  assert.match(room.output("e-1"), /A2\n/);
  assert.ok(room.output("e-1").includes(path.join(r.t.dir, "ud", "runner", "home")), "HOME is the private folder");

  // The progress calls go on while it lasts, and stop when it ends.
  await until(() => r.cloud.api.progress.length >= 3, 5000, "more progress");
  room.send({ t: "close", reason: "idle", message: "quiet" });
  await until(() => r.cloud.api.results.length === 1, 8000, "the result");
  const res = r.cloud.api.results[0];
  assert.deepStrictEqual([res.jobId, res.stepIdx, res.epoch, res.exitCode], ["job-1", 5, 3, 0]);
  assert.strictEqual(res.outputTail, "[X0 Bot: live session ended (idle); 1 command(s) run]");
  assert.deepStrictEqual(res.changes, []);
  assert.ok(typeof res.minutes === "number" && res.minutes >= 0 && res.minutes < 1);
  await dev.waitFor((f) => f.t === "state" && f.busy === false);
  await until(() => r.runner.status().state === "online", 3000, "back to online");
  const calls = r.cloud.api.progress.length;
  await new Promise((s) => setTimeout(s, 250));
  assert.strictEqual(r.cloud.api.progress.length, calls, "no more progress once the step has ended");
  assert.strictEqual(r.runner._internals.procs.size, 0);

  // The audit log has every command, with its exit code; the activity list too.
  const lines = r.auditLines();
  const events = lines.map((l) => l.event + (l.command ? ":" + l.command : ""));
  for (const want of ["accepted", "start:cat a.txt", "end:cat a.txt", "start:echo $HOME", "end:echo $HOME", "session_ended", "reported"]) assert.ok(events.includes(want), want + " in " + events.join(" | "));
  const end = lines.find((l) => l.event === "end" && l.command === "cat a.txt");
  assert.deepStrictEqual([end.exitCode, end.project, end.projectId, end.jobId], [0, "acme/app", "proj-1", "job-1"]);
  const act = r.runner._internals.activity.list();
  assert.deepStrictEqual(act.map((a) => [a.command, a.state, a.exitCode, a.project]).reverse(), [["cat a.txt", "done", 0, "acme/app"], ["echo $HOME", "done", 0, "acme/app"]]);
});

withTimeout("the second job for an allowed project is not asked about, and reuses the workspace (nothing re-fetched for a commit it has)", async () => {
  const r = await rig();
  const dev = await r.online();
  for (let n = 1; n <= 2; n += 1) {
    dev.send({ t: "offer", offer: r.offer("job-1") });
    await r.cloud.roomWaiter.until(n, 15000);
    const room = r.cloud.rooms[n - 1];
    room.send({ t: "close", reason: "job_end" });
    await until(() => r.cloud.api.results.length === n, 8000, "result " + n);
    await until(() => r.runner.status().state === "online", 3000);
    if (n === 1) fs.writeFileSync(path.join(r.workspace(), "node_modules-like.txt"), "kept");
  }
  assert.strictEqual(r.asked.length, 1);
  assert.ok(fs.existsSync(path.join(r.workspace(), "node_modules-like.txt")), "the workspace was reused");
});

withTimeout("a project the person says no to is declined, never fetched, never run, and not asked about again", async () => {
  const r = await rig({ answers: { "proj-1": false } });
  const dev = await r.online();
  dev.send({ t: "offer", offer: r.offer("job-1") });
  const decline = await dev.waitFor("decline");
  assert.deepStrictEqual([decline.jobId, decline.epoch, decline.reason], ["job-1", 3, "project_not_allowed"]);
  assert.strictEqual(r.state.projects["proj-1"].allowed, false);
  assert.ok(!fs.existsSync(r.workspace()), "nothing was fetched");
  assert.strictEqual(r.cloud.rooms.length, 0);
  assert.strictEqual(r.cloud.api.results.length, 0, "a declined step is not reported");
  await until(() => r.runner.status().state === "online", 3000);
  // The server is told the project is off the list, so it stops offering it.
  const st = await dev.waitFor((f) => f.t === "state" && Array.isArray(f.projects));
  assert.ok(!st.projects.includes("proj-1"));
  dev.send({ t: "offer", offer: r.offer("job-1") });
  await until(() => dev.of("decline").length === 2, 5000, "the second decline");
  assert.strictEqual(r.asked.length, 1, "asked once");
});

withTimeout("a project whose question is left unanswered is declined in time, and answering later allows the next job", async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const r = await rig({ answers: { "proj-1": () => gate }, askWaitMs: 150 });
  const dev = await r.online();
  dev.send({ t: "offer", offer: r.offer("job-1") });
  const decline = await dev.waitFor("decline");
  assert.strictEqual(decline.reason, "not_asked_in_time");
  assert.ok(!fs.existsSync(r.workspace()));
  release(true);
  await until(() => r.state.projects["proj-1"] && r.state.projects["proj-1"].allowed === true, 3000, "the late answer to be kept");
  await until(() => r.runner.status().state === "online", 3000);
  dev.send({ t: "offer", offer: r.offer("job-1") });
  await r.cloud.roomWaiter.until(1, 15000);
  r.cloud.rooms[0].send({ t: "close", reason: "job_end" });
  await until(() => r.cloud.api.results.length === 1, 8000);
});

withTimeout("an offer for a job the server does not know, or one that is already being run, is declined", async () => {
  const r = await rig({ answers: { "proj-1": true } });
  const dev = await r.online();
  dev.send({ t: "offer", offer: r.offer("job-nobody") });
  assert.strictEqual((await dev.waitFor("decline")).reason, "unknown_project");
  await until(() => r.runner.status().state === "online", 3000);
  // Busy with one, offered another.
  dev.send({ t: "offer", offer: r.offer("job-1") });
  await r.cloud.roomWaiter.until(1, 15000);
  dev.send({ t: "offer", offer: { ...r.offer("job-2"), epoch: 7 } });
  const busy = await dev.waitFor((f) => f.t === "decline" && f.jobId === "job-2");
  assert.deepStrictEqual([busy.reason, busy.epoch], ["busy", 7]);
  r.cloud.rooms[0].send({ t: "close", reason: "job_end" });
  await until(() => r.cloud.api.results.length === 1, 8000);
});

withTimeout("STOP: the command running is killed, the room is told bye, the step is reported stopped, and this computer stands down until turned on again", async () => {
  const r = await rig();
  const dev = await r.online();
  dev.send({ t: "offer", offer: r.offer("job-1") });
  await r.cloud.roomWaiter.until(1, 15000);
  const room = r.cloud.rooms[0];
  await room.waitFor("hello");
  room.send({ t: "exec", id: "e-1", commands: ["echo $$ > shell.pid; sleep 60"], timeoutSec: 60, overlay: [], discard: true });
  await until(() => fs.existsSync(path.join(r.workspace(), "shell.pid")) && fs.readFileSync(path.join(r.workspace(), "shell.pid"), "utf8").trim(), 8000, "the command to start");
  const pid = Number(fs.readFileSync(path.join(r.workspace(), "shell.pid"), "utf8"));
  assert.ok(alive(pid));
  assert.strictEqual(r.runner.status().working, true);
  r.runner.stopWork();
  const bye = await room.waitFor("bye");
  assert.match(bye.reason, /stopped on this computer/);
  await until(() => !alive(pid), 4000, "the command to be killed");
  await until(() => r.cloud.api.results.length === 1, 8000, "the stopped step to be reported");
  assert.strictEqual(r.cloud.api.results[0].exitCode, 1);
  assert.match(r.cloud.api.results[0].outputTail, /live session ended \(stopped on this computer\)/);
  assert.strictEqual(r.runner.status().enabled, false);
  assert.strictEqual(r.state.enabled, false);
  assert.ok(r.notes.some((n) => /stopped/i.test(n)));
  await dev.waitFor("bye");
  assert.strictEqual(r.runner._internals.procs.size, 0);
  // And it does not take the next one.
  await new Promise((s) => setTimeout(s, 200));
  assert.strictEqual(r.runner.status().state, "off");
  await until(() => r.auditLines().some((l) => l.event === "end" && l.command.includes("sleep 60") && l.exitCode === 130 && l.cancelled === true), 4000, "the command's end in the audit log");
});

withTimeout("QUIT kills everything that is running, and reports nothing (the lease runs out and the router moves the step)", async () => {
  const r = await rig();
  const dev = await r.online();
  dev.send({ t: "offer", offer: r.offer("job-1") });
  await r.cloud.roomWaiter.until(1, 15000);
  const room = r.cloud.rooms[0];
  room.send({ t: "exec", id: "e-1", commands: ["echo $$ > shell.pid; sleep 60 & echo $! > kid.pid; wait"], timeoutSec: 60, overlay: [], discard: true });
  await until(() => fs.existsSync(path.join(r.workspace(), "kid.pid")) && fs.readFileSync(path.join(r.workspace(), "kid.pid"), "utf8").trim(), 8000);
  const shell = Number(fs.readFileSync(path.join(r.workspace(), "shell.pid"), "utf8"));
  const kid = Number(fs.readFileSync(path.join(r.workspace(), "kid.pid"), "utf8"));
  r.runner.shutdown();
  await until(() => !alive(shell) && !alive(kid), 4000, "both to be killed");
  await new Promise((s) => setTimeout(s, 300));
  assert.strictEqual(r.cloud.api.results.length, 0);
});

withTimeout("CRASH: when the process exits, or an error nobody caught takes it down, what was started is killed first", async () => {
  const r = await rig();
  const fake = new EventEmitter();
  r.runner.installProcessHooks(fake);
  assert.deepStrictEqual(fake.eventNames().sort(), ["exit", "uncaughtExceptionMonitor"]);
  const dev = await r.online();
  dev.send({ t: "offer", offer: r.offer("job-1") });
  await r.cloud.roomWaiter.until(1, 15000);
  r.cloud.rooms[0].send({ t: "exec", id: "e-1", commands: ["echo $$ > shell.pid; sleep 60"], timeoutSec: 60, overlay: [], discard: true });
  await until(() => fs.existsSync(path.join(r.workspace(), "shell.pid")) && fs.readFileSync(path.join(r.workspace(), "shell.pid"), "utf8").trim(), 8000);
  const pid = Number(fs.readFileSync(path.join(r.workspace(), "shell.pid"), "utf8"));
  fake.emit("uncaughtExceptionMonitor", new Error("boom"));
  assert.ok(!alive(pid) || (await until(() => !alive(pid), 2000, "killed")), "gone");
});

withTimeout("when the server takes the step back (a cancel, or progress refused as stale) the session ends and nothing is reported", async () => {
  const r = await rig({ leaseEveryMs: 60 });
  const dev = await r.online();
  dev.send({ t: "offer", offer: r.offer("job-1") });
  await r.cloud.roomWaiter.until(1, 15000);
  const room = r.cloud.rooms[0];
  await room.waitFor("hello");
  dev.send({ t: "cancel", jobId: "job-1", epoch: 3 });
  await room.waitFor("bye");
  assert.strictEqual((await room.waitClosed()).code, 1000);
  await until(() => r.runner.status().state === "online", 4000);
  assert.strictEqual(r.cloud.api.results.length, 0);

  r.cloud.progressStatus = 409;
  dev.send({ t: "offer", offer: r.offer("job-2", {}) });
  await r.cloud.roomWaiter.until(2, 15000).catch(() => {});
  await until(() => r.cloud.rooms.length < 2 || r.cloud.rooms[1].closed, 8000, "the second session to end");
  await until(() => r.runner.status().state === "online", 4000);
  assert.strictEqual(r.cloud.api.results.length, 0);
});

withTimeout("a cancel for another epoch of the job does not stop this one", async () => {
  const r = await rig();
  const dev = await r.online();
  dev.send({ t: "offer", offer: r.offer("job-1") });
  await r.cloud.roomWaiter.until(1, 15000);
  dev.send({ t: "cancel", jobId: "job-1", epoch: 2 });
  dev.send({ t: "cancel", jobId: "someone-else", epoch: 9 });
  await new Promise((s) => setTimeout(s, 300));
  assert.ok(!r.cloud.rooms[0].closed);
  r.cloud.rooms[0].send({ t: "close", reason: "job_end" });
  await until(() => r.cloud.api.results.length === 1, 8000);
});

withTimeout("a step the code cannot be fetched for is reported failed with a sentence, not left to run out its lease", async () => {
  const r = await rig();
  const dev = await r.online();
  dev.send({ t: "offer", offer: r.offer("job-1", { repo: { headSha: "f".repeat(40) } }) });
  await until(() => r.cloud.api.results.length === 1, 15000, "the result");
  assert.strictEqual(r.cloud.api.results[0].exitCode, 1);
  assert.match(r.cloud.api.results[0].outputTail, /could not get the code: X0 Bot could not fetch the code/);
  const expired = r.offer("job-1", { repo: { readTokenExpiresAt: Date.now() - 1000 } });
  await until(() => r.runner.status().state === "online", 4000);
  dev.send({ t: "offer", offer: expired });
  await until(() => r.cloud.api.results.length === 2, 15000);
  assert.match(r.cloud.api.results[1].outputTail, /expired/);
  assert.strictEqual(r.cloud.rooms.length, 0);
});

withTimeout("an ordinary step (no session) runs its commands and hands back what they changed; a trial hands back nothing", async () => {
  const r = await rig();
  const dev = await r.online();
  const base = { commands: ["echo hello > out.txt", "cat a.txt", "rm package.json"], timeoutSec: 30 };
  dev.send({ t: "offer", offer: { ...r.offer("job-1"), ...base, session: undefined } });
  await until(() => r.cloud.api.results.length === 1, 15000, "the result");
  const res = r.cloud.api.results[0];
  assert.strictEqual(res.exitCode, 0);
  assert.match(res.outputTail, /\$ echo hello > out\.txt\n\$ cat a\.txt\nA2\n/);
  const byPath = Object.fromEntries(res.changes.map((c) => [c.path, c.content]));
  assert.deepStrictEqual(byPath, { "out.txt": "hello\n", "package.json": null });
  assert.strictEqual(r.cloud.rooms.length, 0, "no room for a plain step");
  await until(() => r.runner.status().state === "online", 4000);

  dev.send({ t: "offer", offer: { ...r.offer("job-1"), epoch: 4, commands: ["echo trial > t.txt", "cat o.txt"], timeoutSec: 30, session: undefined, discard: true, overlay: [{ path: "o.txt", content: "overlaid\n" }] } });
  await until(() => r.cloud.api.results.length === 2, 15000);
  const trial = r.cloud.api.results[1];
  assert.strictEqual(trial.exitCode, 0);
  assert.deepStrictEqual(trial.changes, []);
  assert.match(trial.outputTail, /overlaid/);

  await until(() => r.runner.status().state === "online", 4000);
  dev.send({ t: "offer", offer: { ...r.offer("job-1"), epoch: 5, commands: ["echo partial > p.txt", "exit 3", "echo never"], timeoutSec: 30, session: undefined } });
  await until(() => r.cloud.api.results.length === 3, 15000);
  assert.strictEqual(r.cloud.api.results[2].exitCode, 3);
  assert.deepStrictEqual(r.cloud.api.results[2].changes, [], "a failed step sends no files");
  assert.ok(!r.cloud.api.results[2].outputTail.includes("never"));
});

withTimeout("an ordinary step is guarded like a session: a refused command is 126 and nothing ran", async () => {
  const r = await rig();
  const dev = await r.online();
  dev.send({ t: "offer", offer: { ...r.offer("job-1"), commands: ["touch ran.txt", "git push origin main"], timeoutSec: 30, session: undefined } });
  await until(() => r.cloud.api.results.length === 1, 15000);
  assert.strictEqual(r.cloud.api.results[0].exitCode, 126);
  assert.match(r.cloud.api.results[0].outputTail, /git push isn't allowed/);
  assert.ok(!fs.existsSync(path.join(r.workspace(), "ran.txt")));
  assert.ok(r.auditLines().some((l) => l.event === "refused" && l.rule === "push"));
});

withTimeout("the live-session mark is never run as a command", async () => {
  const r = await rig();
  const dev = await r.online();
  dev.send({ t: "offer", offer: { ...r.offer("job-1"), session: undefined } });
  await until(() => r.cloud.api.results.length === 1, 15000);
  assert.strictEqual(r.cloud.api.results[0].exitCode, 1);
  assert.match(r.cloud.api.results[0].outputTail, /without a way into the room/);
  assert.ok(!r.auditLines().some((l) => l.event === "start"), "nothing was started");
});

withTimeout("a result that the server answers with an error is tried again; one it refuses as stale is final", async () => {
  const r = await rig();
  let attempts = 0;
  r.cloud.resultStatus = (n) => { attempts = n; return n < 3 ? 503 : 200; };
  const dev = await r.online();
  dev.send({ t: "offer", offer: { ...r.offer("job-1"), commands: ["true"], timeoutSec: 10, session: undefined } });
  await until(() => r.cloud.api.results.length === 1, 15000, "the result after retries");
  assert.strictEqual(attempts, 3);
  await until(() => r.runner.status().state === "online", 4000);
  r.cloud.api.results.length = 0;
  r.cloud.api.resultAttempts = 0;
  r.cloud.resultStatus = 409;
  dev.send({ t: "offer", offer: { ...r.offer("job-1"), epoch: 6, commands: ["true"], timeoutSec: 10, session: undefined } });
  await until(() => r.cloud.api.resultAttempts === 1, 15000);
  await new Promise((s) => setTimeout(s, 200));
  assert.strictEqual(r.cloud.api.resultAttempts, 1, "stale_lease is not retried: the step went to another computer");
  await until(() => r.runner.status().state === "online", 4000);
});

withTimeout("BATTERY: paused on a low battery (offline, no ticket asked for), back by itself on mains power, and stands down mid-job without stopping it", async () => {
  const r = await rig({ power: { onBattery: true, percent: 12, lowPower: false } });
  r.runner.setEnabled(true);
  await until(() => r.runner.status().state === "paused", 5000, "paused");
  assert.strictEqual(r.runner.status().pausedReason, "battery_low");
  await new Promise((s) => setTimeout(s, 150));
  assert.strictEqual(r.cloud.api.tickets.length, 0, "no ticket, no socket: it costs nothing");
  assert.strictEqual(r.cloud.devices.length, 0);
  // Plugged in.
  r.power.reading = { onBattery: false, percent: 12, lowPower: false };
  r.runner.powerEvent("on-ac");
  const dev = await (async () => { await r.cloud.deviceWaiter.until(1, 8000); return r.cloud.devices[0]; })();
  await until(() => r.runner.status().state === "online", 5000);
  // A job starts; the battery drops; the job goes on and no new offers come.
  dev.send({ t: "offer", offer: r.offer("job-1") });
  await r.cloud.roomWaiter.until(1, 15000);
  const room = r.cloud.rooms[0];
  r.power.reading = { onBattery: true, percent: 8, lowPower: false };
  r.runner.powerEvent("on-battery");
  const off = await dev.waitFor((f) => f.t === "state" && f.allowRun === false);
  assert.strictEqual(off.allowRun, false);
  room.send({ t: "exec", id: "e-1", commands: ["echo still running"], timeoutSec: 20, overlay: [], discard: true });
  assert.strictEqual((await room.waitFor((f) => f.t === "done" && f.id === "e-1")).exitCode, 0, "the job was not stopped");
  room.send({ t: "close", reason: "job_end" });
  await until(() => r.cloud.api.results.length === 1, 8000);
  // With the job over, the socket is closed: paused means offline.
  await dev.waitClosed();
  await until(() => r.runner.status().state === "paused", 4000);
  // Low-power mode pauses at any charge.
  r.power.reading = { onBattery: true, percent: 95, lowPower: true };
  r.runner.powerEvent("on-battery");
  await new Promise((s) => setTimeout(s, 100));
  assert.strictEqual(r.runner.status().state, "paused");
  assert.strictEqual(r.runner.status().pausedReason, "low_power_mode");
});

withTimeout("an offer that arrives while paused is declined", async () => {
  const r = await rig();
  const dev = await r.online();
  r.power.reading = { onBattery: true, percent: 5, lowPower: false };
  await r.runner.powerEvent("on-battery");
  await until(() => r.runner.status().state === "paused", 4000);
  await dev.waitClosed();
  assert.ok(r.cloud.devices.length === 1);
});

withTimeout("signed out: nothing connects; signing out takes it down and forgets who allowed what", async () => {
  const r = await rig({ signedIn: false });
  r.runner.setEnabled(true);
  await until(() => r.runner.status().state === "signed_out", 3000);
  assert.strictEqual(r.cloud.api.tickets.length, 0);
  r.sig.in = true;
  r.runner.sessionChanged();
  await r.cloud.deviceWaiter.until(1, 8000);
  await until(() => r.runner.status().state === "online", 5000);
  r.runner.setProject("proj-1", "acme/app", "allow");
  assert.strictEqual(r.state.projects["proj-1"].allowed, true);
  r.sig.in = false;
  r.runner.sessionChanged();
  await r.cloud.devices[0].waitClosed();
  assert.strictEqual(r.runner.status().state, "off");
  assert.strictEqual(r.state.enabled, false);
  assert.deepStrictEqual(r.state.projects, {}, "the next person to sign in is asked for themselves");
});

withTimeout("replaced: another copy took this computer, so it stays off even when the sign-in is refreshed, until the person turns it on again", async () => {
  const r = await rig();
  const dev = await r.online();
  dev.send({ t: "replaced" });
  dev.close(4000, "replaced");
  await until(() => r.runner.status().state === "replaced", 4000, "replaced");
  r.runner.sessionChanged();   // what the hourly renewal of the sign-in does
  await new Promise((s) => setTimeout(s, 250));
  assert.strictEqual(r.cloud.devices.length, 1, "it did not reconnect on its own");
  assert.strictEqual(r.runner.status().state, "replaced");
  r.runner.setEnabled(false);
  r.runner.setEnabled(true);
  await r.cloud.deviceWaiter.until(2, 8000);
  await until(() => r.runner.status().state === "online", 4000);
});

withTimeout("a Worker with no live session (404 live_off) leaves the computer idle with a word for it", async () => {
  const r = await rig();
  r.cloud.liveOff = true;
  r.runner.setEnabled(true);
  await until(() => r.runner.status().state === "live_off", 5000);
  assert.strictEqual(r.cloud.devices.length, 0);
});

withTimeout("RUN IN A CONTAINER fails closed: Docker missing or stopped means the job is declined and nothing runs on this computer", async () => {
  const r = await rig({ docker: { installed: false, running: false, version: "", reason: "Docker is not installed on this computer." } });
  r.runner.setContainer(true);
  assert.strictEqual(r.state.container, true);
  const dev = await r.online();
  dev.send({ t: "offer", offer: r.offer("job-1") });
  const decline = await dev.waitFor("decline");
  assert.strictEqual(decline.reason, "docker_unavailable");
  assert.ok(r.notes.some((n) => /Docker is not installed/.test(n)));
  assert.ok(!fs.existsSync(r.workspace()), "not even fetched");
  assert.strictEqual(r.cloud.rooms.length, 0);
  assert.ok(!r.auditLines().some((l) => l.event === "start"));
});

withTimeout("the window's snapshot lists the projects with what the person said, the activity, the power state and the container", async () => {
  const r = await rig({ answers: { "proj-1": true } });
  const dev = await r.online();
  dev.send({ t: "offer", offer: r.offer("job-1") });
  await r.cloud.roomWaiter.until(1, 15000);
  r.cloud.rooms[0].send({ t: "exec", id: "e-1", commands: ["echo hi"], timeoutSec: 10, overlay: [], discard: true });
  await r.cloud.rooms[0].waitFor((f) => f.t === "done");
  r.cloud.rooms[0].send({ t: "close", reason: "job_end" });
  await until(() => r.cloud.api.results.length === 1, 8000);
  await until(() => r.runner.status().state === "online", 3000);
  const snap = await r.runner.snapshot();
  assert.deepStrictEqual(snap.projects.map((p) => [p.id, p.name, p.state]), [["proj-1", "acme/app", "allowed"], ["proj-2", "acme/other", "ask"]]);
  assert.strictEqual(snap.activity[0].command, "echo hi");
  assert.strictEqual(snap.container.on, false);
  assert.strictEqual(snap.container.image, "node:22-bookworm");
  assert.strictEqual(snap.status.state, "online");
  assert.ok(snap.auditDir.endsWith(path.join("runner", "audit")));
  // The person changes their mind from the window.
  await r.runner.setProject("proj-2", "acme/other", "deny");
  await r.runner.setProject("proj-1", "acme/app", "ask");
  const again = await r.runner.snapshot({ fetchProjects: false });
  assert.deepStrictEqual(again.projects.map((p) => [p.id, p.state]), [["proj-1", "ask"], ["proj-2", "denied"]]);
  await r.runner.setProject("../etc", "x", "allow");
  assert.ok(!("../etc" in r.state.projects));
});

withTimeout("a refused project is left out of the hello after a reconnect, once the person's projects are known", async () => {
  const r = await rig({ state: { enabled: false, projects: { "proj-2": { name: "acme/other", allowed: false, at: 1 } } } });
  const dev = await r.online();
  const hello = await dev.waitFor("hello");
  assert.deepStrictEqual(hello.projects, ["proj-1"]);
  dev.close(1012, "restart");
  await r.cloud.deviceWaiter.until(2, 8000);
  assert.deepStrictEqual((await r.cloud.devices[1].waitFor("hello")).projects, ["proj-1"]);
});

withTimeout("repoName reads the project's name from its address", () => {
  assert.strictEqual(repoName("https://github.com/acme/app.git"), "acme/app");
  assert.strictEqual(repoName("https://github.com/acme/app"), "acme/app");
  assert.strictEqual(repoName(""), "");
});
