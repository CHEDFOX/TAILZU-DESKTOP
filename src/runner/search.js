// `grep` and `glob` for a repository too big for the room's own copy (over 50 MB of text), answered from the workspace with git.
//
// The reference is gitGrep / gitGlob / secretish in the backend's runScript.ts. ripgrep's output form: `path:line:text` for a match
// and `path-line-text` for a context line, `--` between groups, `filesOnly` one path a line. Secret files (.env, keys, certificates,
// credentials) are never searched or listed. A path asked for must be inside the workspace (guard.checkPathInside).

"use strict";

const nodeFs = require("fs");
const nodePath = require("path");
const { checkPathInside } = require("./guard.js");

/** Paths whose text is never searched or listed: the same kinds the room never holds. */
function secretish(path) {
  const b = String(path).split("/").pop().toLowerCase();
  if (/^\.env(\..+)?$/.test(b) && !/\.(example|sample|template|dist|defaults?|schema)$/.test(b)) return true;
  if (/\.(pem|key|p12|pfx|pkcs12|jks|keystore|crt|cer|der|p8|p7b|asc|ppk|kdbx|tfstate)$/.test(b)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\.pem)?$/.test(b)) return true;
  return /^(\.npmrc|\.pypirc|\.netrc|\.htpasswd|\.pgpass|credentials|credentials\.json|secrets?\.(ya?ml|json|toml))$/.test(b);
}

/** git grep in the workspace, in ripgrep's output. PCRE where git has it, else POSIX. { ok, text, matches, files, partial } | { ok: false, error }. */
async function gitGrep(m, cwd, git) {
  const specs = [];
  const base = typeof m.path === "string" ? m.path.replace(/^\.\//, "").replace(/\/+$/, "") : "";
  if (base) {
    const inside = checkPathInside(cwd, base);
    if (!inside.ok) return { ok: false, error: inside.message };
  }
  if (m.glob) {
    if (String(m.glob).split("/").includes("..") || String(m.glob).startsWith("/")) return { ok: false, error: "That glob goes outside the workspace." };
    specs.push(":(glob)" + (String(m.glob).indexOf("/") >= 0 ? String(m.glob).replace(/^\//, "") : "**/" + m.glob));
  } else if (base) specs.push(":(literal)" + base);
  const run = async (engine) => {
    const args = ["grep", "-n", "-I", "--no-color", engine];
    if (m.ignoreCase) args.push("-i");
    if (m.filesOnly) args.push("-l");
    else if (m.context) args.push("-C", String(Math.min(5, m.context)));
    args.push("-e", m.pattern, "--", ...(specs.length ? specs : ["."]));
    if (m.glob && base) args.push(":(literal)" + base);
    const r = await git.run(args, { cwd, timeoutMs: 20000, maxBuffer: 8 * 1024 * 1024 });
    // 1 is "no match"; a cut-off (too much output) still has what was read.
    return { out: r.code === 1 ? "" : r.stdout, code: r.code === 124 && r.stdout ? 0 : r.code, err: r.stderr || r.error };
  };
  let r = await run("-P");
  if (r.code > 1 && /pcre|-P|perl/i.test(r.err || "")) r = await run("-E");
  if (r.code > 1 && !r.out) return { ok: false, error: "git grep would not run that pattern: " + String(r.err || "").trim().split("\n")[0].slice(0, 200) };
  const max = Math.max(1, Math.min(500, m.maxResults || 100));
  const rows = [];
  let matches = 0;
  let partial = false;
  const files = new Set();
  for (const row of r.out.split("\n")) {
    if (!row) continue;
    if (row === "--") { rows.push(row); continue; }
    const hit = /^(.*?)([:-])(\d+)([:-])/.exec(row);
    const path = m.filesOnly ? row : hit ? hit[1] : row;
    if (secretish(path)) continue;
    const isMatch = m.filesOnly || (hit && hit[2] === ":");
    if (isMatch) {
      if (matches >= max) { partial = true; break; }
      matches += 1;
      files.add(path);
    }
    rows.push(row.length > 300 ? row.slice(0, 299) + "…" : row);
  }
  while (rows.length && rows[rows.length - 1] === "--") rows.pop();
  return { ok: true, text: rows.join("\n"), matches, files: files.size, partial };
}

/** git ls-files for a glob, the most recently changed first, at most 500. */
async function gitGlob(m, cwd, git, fs = nodeFs) {
  const g = String(m.pattern).replace(/^\.\//, "").replace(/^\//, "");
  if (g.split("/").includes("..")) return { ok: false, error: "That glob goes outside the workspace." };
  const spec = ":(glob)" + (g.indexOf("/") >= 0 ? g : "**/" + g);
  const r = await git.run(["ls-files", "-z", "--", spec], { cwd, timeoutMs: 20000, maxBuffer: 16 * 1024 * 1024 });
  if (r.code !== 0) return { ok: false, error: "That glob is not one git can read." };
  const all = r.stdout.split("\0").filter((p) => p && !secretish(p));
  const stamp = (p) => { try { return fs.lstatSync(nodePath.join(cwd, p)).mtimeMs; } catch { return 0; } };
  const sorted = all.slice(0, 5000).map((p) => [p, stamp(p)]).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map((x) => x[0]);
  const paths = sorted.slice(0, 500);
  return { ok: true, text: paths.join("\n"), paths, total: all.length, partial: all.length > paths.length };
}

module.exports = { gitGrep, gitGlob, secretish };
