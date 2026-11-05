// What xode remembers about each folder it was run in: the project, the chat (thread) and the last job.
// Kept in ~/.config/xode/state.json. No secrets go here.

"use strict";

const path = require("path");
const { configDir } = require("../config");
const { writeFileAtomic, readJson } = require("../util/atomicWrite");

const fileOf = (env) => path.join(configDir(env), "state.json");
const keyOf = (server, cwd) => `${server} ${path.resolve(cwd)}`;

function readAll(env) {
  const j = readJson(fileOf(env), null);
  return j && typeof j === "object" && j.folders && typeof j.folders === "object" ? j : { version: 1, folders: {} };
}

/** What is remembered for this folder on this server: { projectId?, jobId?, threads?: { [projectId]: threadId } }. */
function folderState(server, cwd, env = process.env) {
  return readAll(env).folders[keyOf(server, cwd)] || {};
}

/** Merges `patch` into this folder's entry. */
function saveFolderState(server, cwd, patch, env = process.env) {
  const all = readAll(env);
  const k = keyOf(server, cwd);
  all.folders[k] = { ...(all.folders[k] || {}), ...patch, at: new Date().toISOString() };
  writeFileAtomic(fileOf(env), JSON.stringify(all, null, 2) + "\n", 0o600);
  return all.folders[k];
}

module.exports = { folderState, saveFolderState };
