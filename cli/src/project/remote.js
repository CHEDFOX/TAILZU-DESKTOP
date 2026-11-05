// Which remote of the repository is the project's: origin; else the only one; else the person says which.

"use strict";

const { git } = require("../git/run");

/**
 * Resolves { name, url, urls } of the remote, or null when the repository has none. Throws a sentence when no remote was chosen.
 * `urls`: the address as git uses it (after any url.*.insteadOf) and as it is written in the config, the two places a GitHub
 * address can show.
 */
async function chooseRemote(top, { input, out }) {
  const { stdout } = await git(["remote"], { cwd: top, what: "list the remotes" });
  const names = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!names.length) return null;
  let name;
  if (names.includes("origin")) name = "origin";
  else if (names.length === 1) name = names[0];
  else name = await ask(names, { input, out });
  const url = (await git(["remote", "get-url", name], { cwd: top, what: `read the address of ${name}` })).stdout.trim();
  const written = await git(["config", "--get", `remote.${name}.url`], { cwd: top }).then((r) => r.stdout.trim(), () => "");
  return { name, url, urls: [...new Set([url, written].filter(Boolean))] };
}

async function ask(names, { input, out }) {
  out.line("This repository has several remotes and none is called origin. Which one is the project's?");
  names.forEach((n, i) => out.line(`  ${out.paint.cyan(String(i + 1).padStart(String(names.length).length))}. ${n}`));
  for (;;) {
    const a = await input.ask(`Remote (1-${names.length}): `);
    if (a === null) throw Object.assign(new Error("No remote was chosen."), { code: "cancelled" });
    const t = a.trim();
    const n = Number(t);
    if (Number.isInteger(n) && n >= 1 && n <= names.length) return names[n - 1];
    if (names.includes(t)) return t;
    out.note(`Type a number from 1 to ${names.length}.`);
  }
}

module.exports = { chooseRemote };
