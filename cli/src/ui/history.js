// What was typed at the prompt, per folder, for Up and Down: ~/.config/xode/history.json (600), the last 200 of each folder.
// A line that looks like it holds a secret (it mentions a token, a password, a secret or "key=") is never kept.

"use strict";

const path = require("path");
const { configDir } = require("../config");
const { writeFileAtomic, readJson } = require("../util/atomicWrite");

const MAX = 200;
const SECRETISH = /token|password|secret|key=/i;

const fileOf = (env) => path.join(configDir(env), "history.json");

function readAll(env) {
  const j = readJson(fileOf(env), null);
  return j && typeof j === "object" && j.folders && typeof j.folders === "object" ? j : { version: 1, folders: {} };
}

/** Is this line one to keep? */
const keepable = (line) => !!String(line).trim() && !SECRETISH.test(line);

/** { list(), add(line) } for the folder `folder` (the repository's top). `env` picks the config folder. */
function createHistory(folder, env = process.env) {
  const key = path.resolve(folder);
  const saved = readAll(env).folders[key];
  let items = Array.isArray(saved) ? saved.filter((x) => typeof x === "string") : [];
  return {
    /** Oldest first. */
    list: () => items.slice(),
    add(line) {
      if (!keepable(line)) return false;
      if (items[items.length - 1] === line) return false;
      items = items.concat(line).slice(-MAX);
      try {
        const all = readAll(env);
        all.folders[key] = items;
        writeFileAtomic(fileOf(env), JSON.stringify(all, null, 2) + "\n", 0o600);
      } catch { /* kept for this run only */ }
      return true;
    },
  };
}

module.exports = { createHistory, keepable, MAX };
