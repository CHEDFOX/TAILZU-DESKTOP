// Is there a newer xode? The npm registry is asked at most once a day (GET .../@x0bot/xode/latest, given 1.5 s), in the
// background so it never holds up the start; the answer is kept in ~/.config/xode/update.json. A newer version is said in
// one dim line, at most once a day. XODE_NO_UPDATE_CHECK=1 turns it off (the tests do).

"use strict";

const path = require("path");
const { configDir } = require("../config");
const { writeFileAtomic, readJson } = require("../util/atomicWrite");

const LATEST_URL = "https://registry.npmjs.org/@x0bot/xode/latest";
const DAY = 24 * 60 * 60_000;
const WAIT_MS = 1500;
const UPDATE_COMMAND = "npm i -g @x0bot/xode@latest";

const fileOf = (env) => path.join(configDir(env), "update.json");

/** Is version `a` newer than `b`? ("1.2.10" > "1.2.9"; a version with a "-tag" counts as before the same one without.) */
function newer(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(String(v || "").trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? 0 : 1] : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 4; i += 1) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** The latest version on the registry, or "" (couldn't tell in time). */
async function fetchLatest({ fetchImpl = globalThis.fetch, timeoutMs = WAIT_MS } = {}) {
  try {
    const res = await fetchImpl(LATEST_URL, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return "";
    const j = await res.json();
    return j && typeof j.version === "string" ? j.version : "";
  } catch {
    return "";
  }
}

const off = (env) => env.XODE_NO_UPDATE_CHECK === "1" || !!env.NODE_TEST_CONTEXT;

/**
 * Starts the check when the kept answer is a day old. Returns { done, notice() }: notice() is the line to show now ("" for
 * none), from what is known by then; it marks the day as told.
 */
function startUpdateCheck({ env = process.env, version, fetchImpl, now = Date.now } = {}) {
  if (off(env)) return { done: Promise.resolve(), notice: () => "" };
  const file = fileOf(env);
  const kept = readJson(file, null);
  const cache = kept && typeof kept === "object" ? kept : {};
  const save = () => { try { writeFileAtomic(file, JSON.stringify(cache, null, 2) + "\n", 0o600); } catch { /* asked again next time */ } };
  const stale = !(Number(cache.checkedAt) > 0) || now() - Number(cache.checkedAt) > DAY;
  const done = stale
    ? fetchLatest({ fetchImpl }).then((v) => { cache.checkedAt = now(); if (v) cache.latest = v; save(); })
    : Promise.resolve();
  return {
    done,
    notice() {
      if (!newer(cache.latest, version)) return "";
      if (Number(cache.toldAt) > 0 && now() - Number(cache.toldAt) < DAY) return "";
      cache.toldAt = now();
      save();
      return `xode ${cache.latest} is out (you have ${version}): ${UPDATE_COMMAND}`;
    },
  };
}

module.exports = { startUpdateCheck, fetchLatest, newer, UPDATE_COMMAND, LATEST_URL };
