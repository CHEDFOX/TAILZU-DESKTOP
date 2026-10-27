// node --test
//
// The agent's staged edits over a checkout (overlay.js), on a real git repository in a temporary folder: what is written, what is
// refused and named, links that lead out, the reset between commands (tracked files restored, files the last overlay made removed,
// node_modules left), and a deletion that is undone by the next reset.

const nodeTest = require("node:test");
const test = (name, fn) => nodeTest(name, { skip: process.platform === "win32" ? "needs git and links: not run on Windows" : false }, fn);
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { overlayPathOk, applyOverlay, resetCheckout, layOverlay } = require("./overlay.js");
const { createGit } = require("./gitrun.js");
const { bareRepo, tempDir } = require("./testkit.js");

function rig() {
  const t = tempDir("tzover-");
  // A working checkout with two tracked files, as the workspace is.
  const src = bareRepo(path.join(t.dir, "src"), [{ "a.txt": "A\n", "src/b.js": "B\n", ".gitignore": "node_modules\n" }]);
  const ws = path.join(t.dir, "ws");
  fs.mkdirSync(ws);
  const home = path.join(t.dir, "home");
  fs.mkdirSync(home);
  const git = createGit({ home, real: process.env });
  return { t, ws, git, src, laid: new Set(), async checkout() {
    await git.run(["init", "-q"], { cwd: ws });
    await git.run(["-c", "protocol.file.allow=always", "fetch", "-q", "--depth=1", src.url, src.shas[0]], { cwd: ws });
    await git.run(["checkout", "-q", "--force", src.shas[0]], { cwd: ws });
  } };
}

test("a path may be written only if it is inside the checkout and is not git's, Tailzu's, or a workflow", () => {
  for (const ok of ["a.txt", "src/b.js", "deep/er/file.ts", ".gitignore", ".github/CODEOWNERS", "report..v2.txt"]) assert.ok(overlayPathOk(ok), ok);
  for (const bad of ["", "/etc/passwd", "../x", "a/../../x", "a\\b", ".git/config", "a/.git/hooks/pre-commit", ".GIT/x", ".tailzu/run.mjs", ".Tailzu/step.json", ".github/workflows/ci.yml", ".github/workflows/tailzu-run.yml", "a//b", "./a", "a/./b", "C:\\x", "a\u0000b", "x".repeat(501)]) {
    assert.ok(!overlayPathOk(bad), JSON.stringify(bad));
  }
});

test("the edits are written, a null deletes, and what could not be laid is named", async () => {
  const r = rig();
  await r.checkout();
  fs.symlinkSync(r.t.dir, path.join(r.ws, "out"));
  const lay = applyOverlay([
    { path: "a.txt", content: "A2\n" }, { path: "new/dir/c.txt", content: "C\n" }, { path: "src/b.js", content: null },
    { path: ".git/config", content: "evil" }, { path: "../escape.txt", content: "x" }, { path: ".github/workflows/x.yml", content: "x" }, { path: "out/inside-link.txt", content: "x" },
  ], r.ws);
  assert.strictEqual(fs.readFileSync(path.join(r.ws, "a.txt"), "utf8"), "A2\n");
  assert.strictEqual(fs.readFileSync(path.join(r.ws, "new/dir/c.txt"), "utf8"), "C\n");
  assert.ok(!fs.existsSync(path.join(r.ws, "src/b.js")));
  assert.deepStrictEqual([lay.written, lay.removed], [2, 1]);
  assert.deepStrictEqual(lay.skipped.sort(), ["../escape.txt", ".git/config", ".github/workflows/x.yml", "out/inside-link.txt"]);
  assert.ok(!fs.existsSync(path.join(r.t.dir, "inside-link.txt")), "nothing was written through the link");
  assert.ok(!fs.existsSync(path.join(r.t.dir, "escape.txt")));
  r.t.remove();
});

test("a file that is a link is replaced, not written through", async () => {
  const r = rig();
  await r.checkout();
  const outside = path.join(r.t.dir, "outside.txt");
  fs.writeFileSync(outside, "keep\n");
  fs.symlinkSync(outside, path.join(r.ws, "link.txt"));
  const lay = applyOverlay([{ path: "link.txt", content: "new\n" }], r.ws);
  assert.strictEqual(lay.written, 1);
  assert.strictEqual(fs.readFileSync(outside, "utf8"), "keep\n");
  assert.strictEqual(fs.readFileSync(path.join(r.ws, "link.txt"), "utf8"), "new\n");
  r.t.remove();
});

test("between commands the checkout goes back to the branch: tracked files restored, files the overlay made removed, node_modules kept", async () => {
  const r = rig();
  await r.checkout();
  const overlay = [{ path: "a.txt", content: "EDITED\n" }, { path: "created.txt", content: "NEW\n" }, { path: "src/b.js", content: null }];
  const lay = await layOverlay(r.ws, overlay, r.laid, r.git);
  assert.strictEqual(lay.written, 2);
  fs.mkdirSync(path.join(r.ws, "node_modules/x"), { recursive: true });
  fs.writeFileSync(path.join(r.ws, "node_modules/x/index.js"), "installed");
  fs.writeFileSync(path.join(r.ws, "a-command-wrote-this.log"), "log");
  fs.writeFileSync(path.join(r.ws, "src/b.js"), "REWRITTEN BY A COMMAND\n");
  // The next exec has a different overlay: the first one's edits are gone, its created file too.
  await layOverlay(r.ws, [{ path: "other.txt", content: "O\n" }], r.laid, r.git);
  assert.strictEqual(fs.readFileSync(path.join(r.ws, "a.txt"), "utf8"), "A\n", "a tracked file the last overlay edited is restored");
  assert.strictEqual(fs.readFileSync(path.join(r.ws, "src/b.js"), "utf8"), "B\n", "a tracked file the commands rewrote is restored");
  assert.ok(!fs.existsSync(path.join(r.ws, "created.txt")), "a file the last overlay created is removed");
  assert.strictEqual(fs.readFileSync(path.join(r.ws, "other.txt"), "utf8"), "O\n");
  assert.strictEqual(fs.readFileSync(path.join(r.ws, "node_modules/x/index.js"), "utf8"), "installed", "ignored files stay: that is what makes the second command fast");
  assert.ok(fs.existsSync(path.join(r.ws, "a-command-wrote-this.log")), "untracked files a command made stay too");
  // Reset alone, with nothing laid, leaves the branch.
  await resetCheckout(r.ws, r.laid, r.git);
  assert.ok(r.laid.size === 0);
  r.t.remove();
});

test("a file that the overlay made and git now tracks is not removed by the reset", async () => {
  const r = rig();
  await r.checkout();
  const laid = new Set(["a.txt"]);
  await resetCheckout(r.ws, laid, r.git);
  assert.strictEqual(fs.readFileSync(path.join(r.ws, "a.txt"), "utf8"), "A\n");
  r.t.remove();
});
