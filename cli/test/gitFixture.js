// Real git repositories in a temporary folder, for the tests and the demo: a bare "GitHub" repository (remotes/<owner>/<name>.git)
// and the person's clone of it, whose origin reads https://github.com/<owner>/<name>.git. The clone's own config sends that
// address to the bare repository (url.<remotes>/.insteadOf https://github.com/), so fetching works with no network.
//
//   makeRepos(root, { owner, name, branch, withBranch }) -> { work, bare, remotes, seed, git(cwd, ...args), addWork(files, message) }

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ID = ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"];

function git(cwd, ...args) {
  return execFileSync("git", [...ID, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}

function writeFiles(dir, files) {
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
}

const FIRST = {
  "README.md": "# storefront\n\nA small shop.\n",
  "src/cart/total.ts": "export function total(lines: number[]) {\n  return lines.map(round).reduce((a, b) => a + b, 0);\n}\n",
};
const WORK = {
  "src/cart/total.ts": "export function total(lines: number[]) {\n  return round(lines.reduce((a, b) => a + b, 0));\n}\n",
  "src/cart/total.test.ts": "test(\"19.995 + 0.005 is 20.00\", () => expect(total([19.995, 0.005])).toBe(20));\n",
};

function makeRepos(root, { owner = "ana", name = "storefront", branch = "xode/fix-cart-rounding", withBranch = true } = {}) {
  const remotes = path.join(root, "remotes");
  const seed = path.join(root, "seed");
  const bare = path.join(remotes, owner, `${name}.git`);
  const work = path.join(root, "work");
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  fs.mkdirSync(seed, { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  writeFiles(seed, FIRST);
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "First");
  git(root, "clone", "-q", "--bare", seed, bare);
  git(seed, "remote", "add", "origin", bare);

  /** A commit on the work branch, pushed to the "GitHub" repository (the job's push). */
  function addWork(files = WORK, message = "Round the total once") {
    const has = git(seed, "branch", "--list", branch).trim();
    git(seed, "switch", "-q", ...(has ? [branch] : ["-c", branch, "main"]));
    writeFiles(seed, files);
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", message);
    git(seed, "push", "-q", "origin", branch);
    git(seed, "switch", "-q", "main");
  }
  if (withBranch) addWork();

  if (fs.existsSync(work)) fs.rmSync(work, { recursive: true, force: true });
  git(root, "clone", "-q", "-c", `url.${remotes}/.insteadOf=https://github.com/`, `https://github.com/${owner}/${name}.git`, work);
  return { work, bare, remotes, seed, branch, git, addWork };
}

module.exports = { makeRepos, git, WORK };
