// xode update: the command that updates xode, and the version here against the newest on npm.

"use strict";

const { fetchLatest, newer, UPDATE_COMMAND } = require("../upkeep/updateCheck");
const pkg = require("../../package.json");

async function update({ out, deps = {} }) {
  const latest = await fetchLatest({ fetchImpl: deps.fetchImpl, timeoutMs: 5000 });
  out.line(`This xode: ${pkg.version}`);
  if (!latest) out.line("Newest: couldn't ask the npm registry just now.");
  else out.line(`Newest: ${latest}${newer(latest, pkg.version) ? "" : " (you have it)"}`);
  out.line("To update:");
  out.line(`  ${UPDATE_COMMAND}`);
  return 0;
}

module.exports = { update };
