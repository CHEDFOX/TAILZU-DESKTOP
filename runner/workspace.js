// The workspace: the project's code on this computer, one folder per project, kept from job to job.
//
//   <userData>/workspaces/<projectId>
//
// It is a git repository (the reset between commands uses git). The first job for a project makes it; every later job
// FETCHES ONLY WHAT CHANGED: the new commit's objects, not the repository again, and not even that when the commit is already
// here. The checkout is the job's branch at the job's commit (`headSha`). Files git does not track - node_modules, build
// output, caches - are left where they are between jobs: that is the point of keeping it.
//
// The code comes with what the server gave this one job: a token that can READ ONE REPOSITORY AND NOTHING ELSE, good for an
// hour, or for a project connected by sign-in a one-time download link. The token goes to git in the environment of that one
// process, as an HTTP header (gitrun.js); it is never in the repository's config, a file or a command line. The person's own
// GitHub token is never involved: the server does not have it to give.

"use strict";

const nodeFs = require("fs");
const nodePath = require("path");
const crypto = require("crypto");
const childProcess = require("child_process");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { redact } = require("./redact.js");

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const TARBALL_MAX_BYTES = 800 * 1024 * 1024;

/** A branch name git would take, that cannot be mistaken for an option. */
function branchOk(b) {
  return typeof b === "string" && b.length > 0 && b.length <= 255 && !b.startsWith("-") && !b.startsWith("/") && !b.endsWith("/") && !b.endsWith(".") && !b.endsWith(".lock")
    && !/(^|\/)\.|\.\.|\/\/|@\{|[\u0000- \u007f~^:?*[\\]/.test(b);
}

/** Where the code may come from: https, no credentials in the address, GitHub. (The token is the server's, for GitHub's repo.) */
function defaultUrlPolicy(url, kind) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (kind === "tarball") return host === "github.com" || host.endsWith(".github.com") || host.endsWith(".githubusercontent.com");
  return host === "github.com";
}

const friendly = (text, known) => redact(String(text || "").trim().split("\n").slice(-4).join(" | "), known).slice(0, 400);

/**
 * The workspaces.
 *   root       <userData>/workspaces
 *   git        a runner from gitrun.js
 *   urlPolicy  (url, "clone" | "tarball") -> boolean. The default allows GitHub only; tests allow a local folder
 *   fetchFn    fetch, for the download link
 *   tar        (archive, folder) -> Promise<boolean>, to unpack a download link's tarball
 */
function createWorkspaces({ root, git, fs = nodeFs, urlPolicy = defaultUrlPolicy, fetchFn = globalThis.fetch, now = Date.now, tar, log = () => {} }) {
  const dirOf = (projectId) => {
    if (!PROJECT_ID.test(String(projectId)) || projectId === "." || projectId === "..") return null;
    return nodePath.join(root, projectId);
  };

  const unlock = (dir) => {
    for (const f of ["index.lock", "shallow.lock", "HEAD.lock", "config.lock"]) { try { fs.rmSync(nodePath.join(dir, ".git", f), { force: true }); } catch { /* fine */ } }
  };

  async function initIfNeeded(dir) {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(nodePath.join(dir, ".git"))) { unlock(dir); return true; }
    const r = await git.run(["init", "-q"], { cwd: dir, timeoutMs: 60000 });
    return r.code === 0;
  }

  async function checkout(dir, branch, commit) {
    const args = ["checkout", "--force", "-q"].concat(branchOk(branch) ? ["-B", branch, commit] : ["--detach", commit]);
    return git.run(args, { cwd: dir, timeoutMs: 300000 });
  }

  async function headIs(dir, sha) {
    const r = await git.run(["rev-parse", "HEAD"], { cwd: dir, timeoutMs: 30000 });
    return r.code === 0 && r.stdout.trim().toLowerCase() === sha.toLowerCase();
  }

  /** An App project: a read-only token for the repository, and the commit. */
  async function prepareApp(dir, repo, known) {
    const sha = repo.headSha.toLowerCase();
    if (!(await initIfNeeded(dir))) return { ok: false, error: "Tailzu could not set up the workspace folder." };
    let how = "cached";
    const have = await git.run(["cat-file", "-e", sha + "^{commit}"], { cwd: dir, timeoutMs: 30000 });
    if (have.code !== 0) {
      const local = !/^https:/i.test(repo.cloneUrl) ? ["-c", "protocol.file.allow=always"] : [];
      // The commit alone, with no history: and, of that, only the objects this workspace does not have.
      const f = await git.run(local.concat(["fetch", "--depth=1", "--no-tags", "--no-recurse-submodules", repo.cloneUrl, sha]), { cwd: dir, token: repo.readToken, timeoutMs: 600000 });
      if (f.code !== 0) return { ok: false, error: "Tailzu could not fetch the code: " + (f.error || friendly(f.stderr || f.stdout, known)), corrupt: /not a git repository|bad object|corrupt|loose object|unable to read|index file/i.test(f.stderr) };
      how = "fetch";
    }
    const c = await checkout(dir, repo.branch, sha);
    if (c.code !== 0) return { ok: false, error: "Tailzu could not check out the branch: " + friendly(c.stderr || c.stdout, known), corrupt: /bad object|corrupt|unable to read|index file/i.test(c.stderr) };
    if (!(await headIs(dir, sha))) return { ok: false, error: "The checkout is not at the commit the job named." };
    return { ok: true, dir, sha, how };
  }

  /** A sign-in project: a one-time link to the tarball of the commit. Made into a one-commit repository, so the rest works as for an App project. */
  async function prepareTarball(dir, repo, known) {
    const sha = repo.headSha.toLowerCase();
    if (!(await initIfNeeded(dir))) return { ok: false, error: "Tailzu could not set up the workspace folder." };
    const marker = nodePath.join(dir, ".git", "tailzu-snapshot");
    let snapshot = "";
    try { snapshot = fs.readFileSync(marker, "utf8").trim(); } catch { /* the first time */ }
    let how = "cached";
    const refName = "refs/tailzu/snapshot";
    if (snapshot !== sha) {
      if (!tar) return { ok: false, error: "This computer cannot unpack a download." };
      const tmp = nodePath.join(root, ".tmp-" + crypto.randomBytes(6).toString("hex"));
      const file = tmp + ".tgz";
      try {
        fs.mkdirSync(tmp, { recursive: true });
        const res = await fetchFn(repo.tarballUrl, { headers: { "User-Agent": "tailzu-desktop", Accept: "application/x-gzip" }, signal: AbortSignal.timeout(600000) });
        if (!res.ok || !res.body) return { ok: false, error: "The download of the code was refused (" + res.status + ")." };
        let size = 0;
        const body = Readable.fromWeb(res.body);
        body.on("data", (b) => { size += b.length; if (size > TARBALL_MAX_BYTES) body.destroy(new Error("The download is too big.")); });
        await pipeline(body, fs.createWriteStream(file));
        if (!(await tar(file, tmp))) return { ok: false, error: "Tailzu could not unpack the download." };
        // The tree of the unpacked folder, as a commit of its own: exactly what the tarball held, tracked or not by .gitignore.
        const gitDir = nodePath.join(dir, ".git");
        const env = { GIT_DIR: gitDir, GIT_WORK_TREE: tmp, GIT_INDEX_FILE: nodePath.join(gitDir, "tailzu-index"), GIT_AUTHOR_NAME: "Tailzu", GIT_AUTHOR_EMAIL: "runner@tailzu.invalid", GIT_COMMITTER_NAME: "Tailzu", GIT_COMMITTER_EMAIL: "runner@tailzu.invalid" };
        const added = await git.run(["add", "-A", "-f"], { cwd: tmp, extraEnv: env, timeoutMs: 300000 });
        const wrote = added.code === 0 ? await git.run(["write-tree"], { cwd: tmp, extraEnv: env, timeoutMs: 300000 }) : added;
        if (wrote.code !== 0) return { ok: false, error: "Tailzu could not read the download: " + friendly(wrote.stderr, known) };
        const commit = await git.run(["commit-tree", wrote.stdout.trim(), "-m", "Tailzu snapshot " + sha], { cwd: tmp, extraEnv: env, timeoutMs: 60000 });
        if (commit.code !== 0) return { ok: false, error: "Tailzu could not record the download." };
        const id = commit.stdout.trim();
        await git.run(["update-ref", refName, id], { cwd: dir, timeoutMs: 30000 });
        const c = await checkout(dir, repo.branch, id);
        if (c.code !== 0) return { ok: false, error: "Tailzu could not check out the download: " + friendly(c.stderr, known) };
        fs.writeFileSync(marker, sha);
        how = "tarball";
      } catch (err) {
        return { ok: false, error: "Tailzu could not download the code: " + friendly(err && err.message, known) };
      } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(file, { force: true }); fs.rmSync(nodePath.join(dir, ".git", "tailzu-index"), { force: true }); } catch { /* the next run removes it */ }
      }
    } else {
      const snap = await git.run(["rev-parse", refName], { cwd: dir, timeoutMs: 30000 });
      if (snap.code !== 0) { try { fs.rmSync(marker, { force: true }); } catch { /* */ } return prepareTarball(dir, repo, known); }
      const c = await checkout(dir, repo.branch, snap.stdout.trim());
      if (c.code !== 0) return { ok: false, error: "Tailzu could not check out the download: " + friendly(c.stderr, known) };
    }
    return { ok: true, dir, sha, how };
  }

  return {
    dirOf,
    /**
     * Makes the workspace ready for a job: clones or fetches, and checks out the branch at the commit.
     * Resolves { ok: true, dir, sha, how: "fetch" | "cached" | "tarball" } or { ok: false, error }.
     */
    async prepare({ projectId, repo, known = [] }) {
      const dir = dirOf(projectId);
      if (!dir) return { ok: false, error: "That project has an odd name, so it was not set up." };
      if (!SHA.test(String(repo.headSha))) return { ok: false, error: "The job did not name a commit." };
      if (repo.readTokenExpiresAt && repo.readTokenExpiresAt < now() + 5000) return { ok: false, error: "The read-only token for the code had already expired." };
      const kind = repo.kind === "oauth" ? "tarball" : "clone";
      const address = kind === "tarball" ? repo.tarballUrl : repo.cloneUrl;
      if (!address || !urlPolicy(address, kind)) return { ok: false, error: "The code is at an address this computer will not use." };
      fs.mkdirSync(root, { recursive: true });
      await git.detect();
      const go = () => (kind === "tarball" ? prepareTarball(dir, repo, known.concat(repo.readToken || [])) : prepareApp(dir, repo, known.concat(repo.readToken || [])));
      let r = await go();
      if (!r.ok && r.corrupt) {
        // A workspace that git cannot read is thrown away and made again, once.
        log("workspace " + projectId + " was damaged; making it again");
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
        r = await go();
      }
      if (r.ok) { try { fs.writeFileSync(nodePath.join(dir, ".git", "tailzu-used"), String(now())); } catch { /* only for tidying */ } }
      return r;
    },
    /** Removes workspaces nobody has used for `days` days (and the half-made ones a crash left). Resolves the project ids removed. */
    async prune(days = 30) {
      const gone = [];
      let names = [];
      try { names = await fs.promises.readdir(root); } catch { return gone; }
      for (const name of names) {
        const dir = nodePath.join(root, name);
        if (!PROJECT_ID.test(name)) { if (name.startsWith(".tmp-")) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {}); continue; }
        let last = 0;
        try { last = Number(await fs.promises.readFile(nodePath.join(dir, ".git", "tailzu-used"), "utf8")) || 0; } catch { try { last = (await fs.promises.stat(dir)).mtimeMs; } catch { continue; } }
        if (now() - last > days * 86400000) {
          try { await fs.promises.rm(dir, { recursive: true, force: true }); gone.push(name); } catch { /* in use or locked */ }
        }
      }
      return gone;
    },
  };
}

/** Unpacks a gzipped tarball into a folder, dropping its top folder. Resolves true when tar said yes. */
function tarExtract(file, folder, { spawn = childProcess.spawn } = {}) {
  return new Promise((resolve) => {
    try {
      const child = spawn("tar", ["-xzf", file, "-C", folder, "--strip-components=1", "--no-same-owner"], { stdio: "ignore", windowsHide: true });
      child.on("error", () => resolve(false));
      child.on("exit", (code) => resolve(code === 0));
    } catch { resolve(false); }
  });
}

module.exports = { createWorkspaces, tarExtract, defaultUrlPolicy, branchOk, PROJECT_ID, SHA };
