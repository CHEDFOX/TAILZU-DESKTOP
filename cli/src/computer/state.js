// What the runner keeps between runs (its computer id, its switch), per server and project: ~/.config/xode/runner/state.json, 600.
// Each folder's project is its own computer for Xode, so two terminals in two projects never take each other's place.
// No secrets go here.

"use strict";

const path = require("path");
const { configDir } = require("../config");
const { writeFileAtomic, readJson } = require("../util/atomicWrite");

const fileOf = (env) => path.join(configDir(env), "runner", "state.json");

function readAll(env) {
  const j = readJson(fileOf(env), null);
  return j && typeof j === "object" && j.runners && typeof j.runners === "object" ? j : { version: 1, runners: {} };
}

/** { state, save() }: `state` is the object the runner reads and changes in place; save() writes it back (only this entry). */
function runnerState(server, projectId, env = process.env) {
  const key = `${server} ${projectId}`;
  const kept = readAll(env).runners[key];
  const state = kept && typeof kept === "object" ? kept : {};
  return {
    state,
    file: fileOf(env),
    save() {
      const all = readAll(env);
      all.runners[key] = state;
      writeFileAtomic(fileOf(env), JSON.stringify(all, null, 2) + "\n", 0o600);
    },
  };
}

module.exports = { runnerState };
