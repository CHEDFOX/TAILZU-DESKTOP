// Which project a run is about: the folder's own. xode works from the top of the git repository it was started in, reads its
// remote (origin; else the only one; else the person says which) and finds the Xode project of that GitHub repository
// (GET /v1/code/projects: { id, fullName "owner/name", defaultBranch, ... }). --project or XODE_PROJECT still wins.
// A repository that isn't a project yet is connected first (connect.js).

"use strict";

const { topOf } = require("../git/run");
const { chooseRemote } = require("./remote");
const { parseRemote } = require("./remoteUrl");
const { connectRepo, matchProject } = require("./connect");
const { saveFolderState } = require("../state/folders");

/** A refusal: one sentence, and the exit code it ends with. */
const refuse = (message, exitCode = 2) => Object.assign(new Error(message), { code: "refused", exitCode });

const NOT_A_REPO = "This isn't a git repository: run xode inside your project's folder.";
const NOT_GITHUB = "This repository's remote isn't on GitHub: Xode works with GitHub repositories.";
const NO_REMOTE = "This repository has no remote: Xode works with GitHub repositories, so push it to GitHub first.";

/** The folder xode works from: the repository's top folder (status and stop use it too). Null outside a repository. */
async function repoTop(cwd) {
  return topOf(cwd);
}

/**
 * Resolves { id, name, defaultBranch, top, remote: { name, url } | null, repo: { owner, repo, fullName } | null }.
 * `repo` is the folder's GitHub repository when it is this project's, so its work can be brought back (null otherwise).
 */
async function resolveProject(cwd, { flag, env = process.env, client, input, out, server, pollMs, platform }) {
  const top = await topOf(cwd);
  if (!top) throw refuse(NOT_A_REPO);
  const given = (flag || env.XODE_PROJECT || "").trim();

  const remote = await chooseRemote(top, { input, out });
  const read = remote ? (remote.urls || [remote.url]).map(parseRemote) : [];
  const found = read.find((r) => r && !r.notGithub) || read.find(Boolean) || null;
  const github = found && !found.notGithub ? found : null;

  const { projects } = await client.get("/v1/code/projects");
  let project;
  if (given) {
    project = (projects || []).find((x) => x && x.id === given);
    if (!project) throw new Error(`There is no project ${given} in your Xode projects.`);
  } else {
    if (!remote) throw refuse(NO_REMOTE);
    if (!github) throw refuse(found && found.notGithub ? NOT_GITHUB : `xode can't read this repository's remote (${remote.name}): Xode works with GitHub repositories.`);
    project = matchProject(projects, github.fullName) || (await connectRepo({ client, found: github, input, out, pollMs, platform }));
  }

  const same = !!github && String(project.fullName || "").toLowerCase() === github.fullName;
  if (server) saveFolderState(server, top, { projectId: project.id }, env);
  return {
    id: project.id,
    name: project.fullName || project.id,
    defaultBranch: typeof project.defaultBranch === "string" ? project.defaultBranch : "",
    top,
    remote,
    repo: same ? github : null,
  };
}

module.exports = { resolveProject, repoTop, NOT_A_REPO, NOT_GITHUB };
