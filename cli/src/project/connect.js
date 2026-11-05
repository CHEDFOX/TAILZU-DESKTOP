// A repository that isn't one of the person's Xode projects yet: the link the app would open to connect it, then a wait until it
// shows up (Ctrl+C stops waiting).
//
// The app's own logic (tulmi/src/experience/bots/screens/code.ts connectUrl, code/pickProjects.ts "Missing one?"):
//   GitHub not connected      POST /v1/code/github/connect -> { installUrl } (the GitHub App's install page); on a server with only
//                             "Sign in with GitHub", POST /v1/code/github/signin -> { authorizeUrl }
//   GitHub connected          the install's own settings page (GET /v1/code/github -> installations[0].manageUrl), to give it this repo
// A repository GitHub already lets Xode see (GET /v1/code/repos) is added as a project the way the app's "pick projects" does it:
// POST /v1/code/projects { repoId }.

"use strict";

const { openUrl } = require("../util/open");
const { sleep } = require("../util/sleep");

const WAIT_MS = 5 * 60_000;

/** The project in `projects` for the repository `fullName` (lower case), if there is one. */
function matchProject(projects, fullName) {
  return (Array.isArray(projects) ? projects : []).find((p) => p && typeof p.id === "string" && String(p.fullName || "").toLowerCase() === fullName) || null;
}

/** The repository among those GitHub lets Xode see, if it is there. */
async function visibleRepo(client, fullName) {
  try {
    const r = await client.get("/v1/code/repos", { timeoutMs: 20_000 });
    return ((r && r.repos) || []).find((x) => x && String(x.fullName || "").toLowerCase() === fullName && Number.isInteger(x.id)) || null;
  } catch (err) {
    if (err.code === "signed_out") throw err;
    return null;
  }
}

async function addProject(client, repo) {
  const r = await client.post("/v1/code/projects", { repoId: repo.id });
  if (!r || !r.project || typeof r.project.id !== "string") throw new Error(`${repo.fullName} couldn't be added to Xode. Add it in X0 Bot.`);
  return r.project;
}

/** The link the app would open to connect GitHub, or to give the install this repository. "" when there is none. */
async function connectLink(client) {
  const gh = await client.get("/v1/code/github").catch((err) => { if (err.code === "signed_out") throw err; return null; });
  if (gh && gh.connected) {
    const inst = Array.isArray(gh.installations) ? gh.installations[0] : null;
    if (inst && typeof inst.manageUrl === "string") return inst.manageUrl;
  }
  const install = await client.post("/v1/code/github/connect").then((r) => r && r.installUrl).catch(() => "");
  if (install) return install;
  if (gh && gh.oauth) return client.post("/v1/code/github/signin").then((r) => (r && r.authorizeUrl) || "").catch(() => "");
  return "";
}

/**
 * Resolves the project once the repository is one of the person's Xode projects. `found`: { owner, repo, fullName }.
 * Throws a sentence when it can't be, or { code: "cancelled" } on Ctrl+C.
 */
async function connectRepo({ client, found, input, out, pollMs = 1500, platform = process.platform, waitMs = WAIT_MS }) {
  const shown = `${found.owner}/${found.repo}`;
  out.line(`${shown} isn't connected to Xode yet.`);

  // GitHub lets Xode see it already: it only needs adding.
  const seen = await visibleRepo(client, found.fullName);
  if (seen) {
    const a = await input.pick({ title: "Add it to your Xode projects?", options: ["Yes", "No"] });
    if (a !== 0) throw Object.assign(new Error("Nothing was added. Run xode again when you want to."), { code: "cancelled" });
    const p = await addProject(client, seen);
    out.good(`Added ${p.fullName || shown} to Xode.`);
    return p;
  }

  const link = await connectLink(client);
  if (!link) throw new Error(`Connect ${shown} in X0 Bot first (Code, then add a project), then run xode again.`);
  out.line("Give Xode access to it on GitHub:");
  out.line(`  ${out.paint.bold(link)}`);
  if (input.interactive) {
    const a = await input.pick({ title: "Open it in your browser?", options: ["Yes", "No"] });
    if (a === null) throw Object.assign(new Error("Cancelled."), { code: "cancelled" });
    if (a === 0) openUrl(link, { platform }).then((ok) => { if (!ok) out.note("Couldn't open a browser: open the link above."); });
  }

  out.note(`Waiting for ${shown} to show up in Xode… (Ctrl+C to stop)`);
  const ctl = new AbortController();
  const prev = input.onInterrupt((kind) => { if (kind === "ctrl-c") ctl.abort(); });
  const every = Math.max(pollMs * 2, 50);
  const until = Date.now() + waitMs;
  let round = 0;
  try {
    while (!ctl.signal.aborted && Date.now() < until) {
      await sleep(every, ctl.signal);
      if (ctl.signal.aborted) break;
      round += 1;
      let projects = null;
      try { projects = (await client.get("/v1/code/projects", { signal: ctl.signal })).projects; } catch (err) {
        if (err.code === "signed_out") throw err;
      }
      const p = matchProject(projects, found.fullName);
      if (p) { out.good(`${p.fullName || shown} is connected.`); return p; }
      // Now that GitHub may let Xode see it, it is added here (asking GitHub less often than Xode).
      if (round % 4 === 0) {
        const r = await visibleRepo(client, found.fullName);
        if (r) { const added = await addProject(client, r); out.good(`${added.fullName || shown} is connected.`); return added; }
      }
    }
  } finally {
    input.onInterrupt(prev);
  }
  if (ctl.signal.aborted) throw Object.assign(new Error("Stopped waiting."), { code: "cancelled" });
  throw new Error(`${shown} didn't show up in Xode within ${Math.round(waitMs / 60_000)} minutes. Run xode again once it's connected.`);
}

module.exports = { connectRepo, connectLink, matchProject };
