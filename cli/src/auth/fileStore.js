// The sign-in kept in a file: ~/.config/xode/credentials.json, the folder only yours (700) and the file only yours (600).
// Used where there is no keychain, or when XODE_CRED_STORE=file.

"use strict";

const fs = require("fs");
const path = require("path");
const { configDir } = require("../config");
const { writeFileAtomic, readJson } = require("../util/atomicWrite");

const fileOf = (env) => path.join(configDir(env), "credentials.json");

function readAll(env) {
  const j = readJson(fileOf(env), null);
  return j && typeof j === "object" && j.servers && typeof j.servers === "object" ? j : { servers: {} };
}

function createFileStore(env = process.env) {
  return {
    name: "file",
    file: fileOf(env),
    available: () => true,
    async get(host) {
      const t = readAll(env).servers[host];
      return t && typeof t.token === "string" ? t.token : null;
    },
    async set(host, token) {
      const all = readAll(env);
      all.servers[host] = { token, savedAt: new Date().toISOString() };
      writeFileAtomic(fileOf(env), JSON.stringify(all, null, 2) + "\n", 0o600);
    },
    async remove(host) {
      const all = readAll(env);
      if (!(host in all.servers)) return false;
      delete all.servers[host];
      if (Object.keys(all.servers).length) writeFileAtomic(fileOf(env), JSON.stringify(all, null, 2) + "\n", 0o600);
      else { try { fs.unlinkSync(fileOf(env)); } catch { /* gone */ } }
      return true;
    },
  };
}

module.exports = { createFileStore };
