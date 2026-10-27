// node --test
//
// The audit log and the activity list (audit.js, activity.js): every command on disk, one line of JSON each, a file a day, the command text
// redacted, files older than 7 days deleted as the days roll, a day's file that grows too big continued in another, and a log that cannot be
// written never stops the work. The activity list keeps the last commands for the window.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { createAudit, dayOf } = require("./audit.js");
const { createActivity } = require("./activity.js");
const { redact } = require("./redact.js");
const { tempDir } = require("./testkit.js");

const DAY = 86400000;

test("each event is a line of JSON in the day's file, the command redacted", () => {
  const t = tempDir("tzaudit-");
  const now = new Date(2026, 9, 27, 10, 0, 0).getTime();
  const audit = createAudit({ dir: path.join(t.dir, "audit"), now: () => now, redact: (x) => redact(x, []) });
  assert.ok(audit.log({ event: "start", jobId: "j1", project: "acme/app", command: "curl -H 'Authorization: Bearer abcdefghijkl' https://x && echo ghp_" + "a".repeat(36) }));
  assert.ok(audit.log({ event: "end", jobId: "j1", exitCode: 0, ms: 12 }));
  const file = path.join(t.dir, "audit", "audit-2026-10-27.log");
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0].event, "start");
  assert.match(lines[0].ts, /^2026-10-27T/);
  assert.ok(!lines[0].command.includes("abcdefghijkl") && !lines[0].command.includes("ghp_"));
  assert.match(lines[0].command, /\[redacted\]/);
  assert.strictEqual(lines[1].exitCode, 0);
  if (process.platform !== "win32") {
    assert.strictEqual(fs.statSync(file).mode & 0o077, 0, "readable only by the person");
    assert.strictEqual(fs.statSync(path.join(t.dir, "audit")).mode & 0o077, 0);
  }
  t.remove();
});

test("it ROTATES: a new file each day, and files older than seven days are deleted", () => {
  const t = tempDir("tzaudit-");
  const dir = path.join(t.dir, "audit");
  fs.mkdirSync(dir);
  const today = new Date(2026, 9, 27, 12, 0, 0).getTime();
  for (let ago = 0; ago <= 12; ago += 1) fs.writeFileSync(path.join(dir, "audit-" + dayOf(today - ago * DAY) + ".log"), "{}\n");
  fs.writeFileSync(path.join(dir, "notes.txt"), "not mine");
  let clock = today;
  const audit = createAudit({ dir, now: () => clock });
  audit.log({ event: "x" });
  const kept = fs.readdirSync(dir).filter((n) => n.startsWith("audit-")).sort();
  assert.strictEqual(kept.length, 8, "today and the seven days before it");
  assert.ok(kept.includes("audit-" + dayOf(today - 7 * DAY) + ".log"));
  assert.ok(!kept.includes("audit-" + dayOf(today - 8 * DAY) + ".log"));
  assert.ok(fs.existsSync(path.join(dir, "notes.txt")), "only its own files");
  // The next day: a new file, and the oldest goes.
  clock = today + DAY;
  audit.log({ event: "y" });
  assert.ok(fs.existsSync(path.join(dir, "audit-" + dayOf(clock) + ".log")));
  assert.ok(!fs.existsSync(path.join(dir, "audit-" + dayOf(today - 7 * DAY) + ".log")));
  assert.strictEqual(audit.files()[0], "audit-" + dayOf(clock) + ".log");
  t.remove();
});

test("a day's file that has grown too big is continued in the next, so the log cannot fill a disk", () => {
  const t = tempDir("tzaudit-");
  const dir = path.join(t.dir, "audit");
  const audit = createAudit({ dir, now: () => new Date(2026, 9, 27, 9, 0, 0).getTime(), maxFileBytes: 400 });
  for (let i = 0; i < 20; i += 1) audit.log({ event: "start", jobId: "j", command: "echo " + i });
  const files = fs.readdirSync(dir).sort();
  assert.ok(files.length >= 3, files.join(","));
  for (const f of files) assert.ok(fs.statSync(path.join(dir, f)).size <= 400 + 200, f);
  const lines = files.flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n"));
  assert.strictEqual(lines.length, 20, "nothing lost between files");
  // A new Audit on the same day carries on in the file with room.
  const again = createAudit({ dir, now: () => new Date(2026, 9, 27, 9, 30, 0).getTime(), maxFileBytes: 400 });
  again.log({ event: "later" });
  assert.strictEqual(fs.readdirSync(dir).length >= files.length, true);
  t.remove();
});

test("a log that cannot be written says so and does not throw", () => {
  const t = tempDir("tzaudit-");
  const blocker = path.join(t.dir, "file");
  fs.writeFileSync(blocker, "x");
  const errors = [];
  const audit = createAudit({ dir: path.join(blocker, "inside"), onError: (e) => errors.push(e.message) });
  assert.strictEqual(audit.log({ event: "x" }), false);
  assert.strictEqual(errors.length, 1);
  t.remove();
});

test("the activity list shows a command running, then its exit code and time; newest first; capped", () => {
  let clock = 1000;
  const a = createActivity({ max: 3, now: () => clock });
  const seen = [];
  a.onChange(() => seen.push(a.list().length));
  const id = a.start({ project: "acme/app", command: "npm test", jobId: "j1" });
  assert.deepStrictEqual(a.list().map((r) => [r.command, r.state, r.exitCode]), [["npm test", "running", null]]);
  clock = 1500;
  a.end(id, { exitCode: 1, ms: 500 });
  assert.deepStrictEqual(a.list().map((r) => [r.state, r.exitCode, r.ms]), [["done", 1, 500]]);
  a.refused({ project: "acme/app", command: "sudo ls", rule: "sudo", message: "no" });
  assert.deepStrictEqual(a.list().map((r) => [r.command, r.state, r.exitCode, r.refused]), [["sudo ls", "refused", 126, "sudo"], ["npm test", "done", 1, ""]]);
  for (let i = 0; i < 5; i += 1) a.start({ project: "p", command: "c" + i });
  assert.strictEqual(a.list().length, 3);
  assert.strictEqual(a.list()[0].command, "c4");
  a.settleRunning(130);
  assert.ok(a.list().every((r) => r.state !== "running"));
  assert.ok(seen.length >= 5, "the window is told of each change");
  a.clear();
  assert.deepStrictEqual(a.list(), []);
});
