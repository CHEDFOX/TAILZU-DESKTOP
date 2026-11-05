// Choosing a project by number from the person's Xode projects (GET /v1/code/projects -> { projects: [{ id, fullName, ... }] }).

"use strict";

/** Resolves { id, name } of the chosen project, or throws a sentence. */
async function pickProject({ client, input, out }) {
  const { projects } = await client.get("/v1/code/projects");
  const list = Array.isArray(projects) ? projects.filter((p) => p && typeof p.id === "string") : [];
  if (!list.length) throw new Error("You have no projects in Xode yet. Add one in X0 Bot first.");
  const nameOf = (p) => p.fullName || p.id;
  if (list.length === 1) {
    out.note(`Using ${nameOf(list[0])}.`);
    return { id: list[0].id, name: nameOf(list[0]) };
  }
  out.line("Which project?");
  list.forEach((p, i) => out.line(`  ${out.paint.cyan(String(i + 1).padStart(String(list.length).length))}. ${nameOf(p)}`));
  for (;;) {
    const a = await input.ask(`Project (1-${list.length}): `);
    if (a === null) throw new Error("No project was chosen.");
    const n = Number(a.trim());
    if (Number.isInteger(n) && n >= 1 && n <= list.length) return { id: list[n - 1].id, name: nameOf(list[n - 1]) };
    const byName = list.find((p) => nameOf(p) === a.trim() || nameOf(p).split("/").pop() === a.trim());
    if (byName) return { id: byName.id, name: nameOf(byName) };
    out.note(`Type a number from 1 to ${list.length}.`);
  }
}

module.exports = { pickProject };
