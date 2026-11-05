// xode doctor: checks the setup, one line each, "ok" or "problem" with what to do about it:
// Node, the sign-in (and where it is kept), the server, git, this folder's project, and this computer's runner.
// Ends 0 when all is well, 1 when something isn't.

"use strict";

const { createClient } = require("../api/client");
const { hostOf } = require("../config");
const { git, topOf } = require("../git/run");
const { parseRemote } = require("../project/remoteUrl");
const { matchProject } = require("../project/connect");
const { loadCreateRunner } = require("../computer/load");
const { wrapLine } = require("../ui/wrap");

const MIN_NODE = 20;

/** The folder's GitHub repository: { found } or { problem }. */
async function folderRepo(cwd) {
  let top;
  try { top = await topOf(cwd); } catch { return { problem: "No git, so this folder's project can't be read." }; }
  if (!top) return { problem: "This folder isn't a git repository: cd into your project's folder." };
  let names = [];
  try { names = (await git(["remote"], { cwd: top })).stdout.split("\n").map((s) => s.trim()).filter(Boolean); } catch { /* none */ }
  if (!names.length) return { problem: "This repository has no remote: push it to GitHub first." };
  const name = names.includes("origin") ? "origin" : names.length === 1 ? names[0] : "";
  if (!name) return { ok: "This repository has several remotes: xode will ask which is the project's." };
  // The address as git uses it and as it is written (a url.*.insteadOf can stand between them), as project/remote.js reads it.
  const urls = [];
  for (const args of [["remote", "get-url", name], ["config", "--get", `remote.${name}.url`]]) {
    try { urls.push((await git(args, { cwd: top })).stdout.trim()); } catch { /* unreadable */ }
  }
  const read = urls.map(parseRemote);
  const r = read.find((x) => x && !x.notGithub) || read.find(Boolean);
  if (!r) return { problem: `xode can't read the address of ${name}.` };
  if (r.notGithub) return { problem: "This repository's remote isn't on GitHub: Xode works with GitHub repositories." };
  return { found: r };
}

async function doctor({ server, store, out, cwd, env, deps = {} }) {
  const rows = [];
  const ok = (text) => rows.push({ ok: true, text });
  const problem = (text) => rows.push({ ok: false, text });

  const major = Number(String(deps.nodeVersion || process.versions.node).split(".")[0]);
  if (major >= MIN_NODE) ok(`Node ${deps.nodeVersion || process.versions.node}`);
  else problem(`Node ${deps.nodeVersion || process.versions.node} is too old: install Node ${MIN_NODE} or newer.`);

  const host = hostOf(server);
  const token = await store.get(host).catch(() => null);
  let client = null;
  let device = null;
  let reachable = true;
  try {
    device = await createClient({ server, token, timeoutMs: 10_000 }).get("/v1/auth/device");
  } catch (err) {
    if (err.code === "unreachable" || err.code === "timeout") reachable = false;
    else if (err.code !== "signed_out") problem(`The server answered oddly: ${err.message}`);
    if (err.code === "signed_out" && token) device = { signedOut: true };
  }
  if (!token) problem("Not signed in: run xode.");
  else if (device && device.signedOut) problem("The sign-in here was switched off: run xode to sign in again.");
  else if (device) {
    const u = device.user || {};
    const where = store.where ? await store.where(host).catch(() => "") : "";
    ok(`Signed in${u.email || u.name ? ` as ${u.email || u.name}` : ""}${where ? ` (kept in ${where})` : ""}`);
    client = createClient({ server, token });
  }
  if (reachable) ok(`The server answers (${server})`);
  else problem(`Can't reach ${host}: check your connection${env.XODE_SERVER ? " and XODE_SERVER" : ""}.`);

  let gitOk = true;
  try { ok((await git(["--version"])).stdout.trim().replace(/^git version /, "git ")); } catch { gitOk = false; problem("git isn't installed (or isn't on the PATH): install git."); }

  if (gitOk) {
    const f = await folderRepo(cwd);
    if (f.problem) problem(f.problem);
    else if (f.ok) ok(f.ok);
    else if (client) {
      let projects = null;
      try { projects = (await client.get("/v1/code/projects")).projects; } catch { /* said below */ }
      if (!projects) problem(`${f.found.owner}/${f.found.repo}: your Xode projects couldn't be read just now.`);
      else if (matchProject(projects, f.found.fullName)) ok(`This folder is ${f.found.owner}/${f.found.repo}`);
      else problem(`${f.found.owner}/${f.found.repo} isn't connected to Xode yet: run xode here to connect it.`);
    } else ok(`This folder is ${f.found.owner}/${f.found.repo} on GitHub`);
  }

  if (String(env.XODE_RUNNER || "").trim() === "0") ok("This computer isn't offered (XODE_RUNNER=0)");
  else {
    let make = null;
    try { make = (deps.loadCreateRunner || loadCreateRunner)(); } catch { make = null; }
    if (typeof make === "function") ok("This computer can do the work (its runner is here)");
    else problem("This copy of xode has no runner: reinstall it (npm i -g @xooteqlab/xode@latest).");
  }

  const W = out.term.tty ? out.term.width() : 60;
  for (const r of rows) {
    const label = r.ok ? "ok" : "problem";
    const pad = " ".repeat(8);
    wrapLine(r.text, W - pad.length).forEach((l, i) => {
      if (i > 0) { out.line(pad + l); return; }
      const paint = r.ok ? out.paint.green : out.paint.red;
      out.line(paint(label) + " ".repeat(pad.length - label.length) + l);
    });
  }
  return rows.every((r) => r.ok) ? 0 : 1;
}

module.exports = { doctor };
