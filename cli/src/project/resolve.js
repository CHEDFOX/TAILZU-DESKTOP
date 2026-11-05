// Which project a run is about. Today: --project, then XODE_PROJECT, then a pick from the list.
// Later this is where a folder is matched to its project (its git remote against the projects' repos); `cwd` is here for that.

"use strict";

const { pickProject } = require("./picker");

/** Resolves { id, name }. `name` is filled in from the list when it can be. */
async function resolveProject(cwd, { flag, env = process.env, client, input, out }) {
  const given = (flag || env.XODE_PROJECT || "").trim();
  if (given) {
    let name = given;
    try {
      const { projects } = await client.get("/v1/code/projects");
      const p = (projects || []).find((x) => x && x.id === given);
      if (!p) throw new Error(`There is no project ${given} in your Xode projects.`);
      name = p.fullName || given;
    } catch (err) {
      if (/^There is no project/.test(err.message)) throw err;
      if (err.code === "signed_out") throw err;
    }
    return { id: given, name };
  }
  return pickProject({ client, input, out });
}

module.exports = { resolveProject };
