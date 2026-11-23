// THE ALLOW LIST: which of the person's projects may run on this computer.
//
// No project may until the person says so here. The first offer for a project nobody answered about is declined and the person is
// asked (a notification that opens the runner's window, where the project waits with Allow and Don't allow); what they answer is kept
// per project on this computer. A project they said "Don't allow" to is never run and never offered again (it is left out of the list
// `hello` sends, so the server does not even try); one they allowed runs from then on. A project with no entry is not allowed ("ask").
//
// Nothing here knows where the answers are kept (the app's own state file): that is handed in. It is also the only thing that decides: a
// server that offers a project this list does not allow gets a `decline`, however it asks.

"use strict";

/**
 * o: {
 *   read()        -> { [projectId]: { name, allowed: boolean, at } }   what the person answered so far
 *   write(map)    keeps them
 *   now
 * }
 */
function createAllowList(o) {
  const now = o.now || Date.now;
  // Projects the person has been asked about and has not answered yet (this run of the app only): left out of the hello, so the
  // server stops offering them until the person answers.
  const asked = new Map();

  // What is kept on disk can be edited by hand: an entry that is not an object is no answer.
  const map = () => {
    const m = o.read();
    if (!m || typeof m !== "object") return {};
    return Object.fromEntries(Object.entries(m).filter(([, e]) => e && typeof e === "object"));
  };

  function decide(projectId, name, allowed) {
    const m = Object.assign({}, map());
    m[projectId] = { name: String(name || m[projectId]?.name || asked.get(projectId) || projectId).slice(0, 120), allowed: !!allowed, at: now() };
    asked.delete(projectId);
    o.write(m);
  }

  return {
    /** "allowed" only once the person said so here, "denied" when they said "Don't allow", "ask" before any answer. */
    state(projectId) {
      const e = map()[projectId];
      if (!e || typeof e.allowed !== "boolean") return "ask";
      return e.allowed ? "allowed" : "denied";
    },
    decide,
    /** Back to the default (not allowed, asked again on the next offer): whatever the person said about it is forgotten. */
    forget(projectId) {
      const m = Object.assign({}, map());
      delete m[projectId];
      asked.delete(projectId);
      o.write(m);
    },
    /** Forget everything (a different person signed in). */
    clear() { asked.clear(); o.write({}); },
    /** What the person answered, as the window lists it, newest first. */
    list() {
      return Object.entries(map()).filter(([, e]) => typeof e.allowed === "boolean")
        .map(([id, e]) => ({ id, name: e.name || id, state: e.allowed ? "allowed" : "denied", at: e.at || 0 })).sort((a, b) => b.at - a.at);
    },
    /** The projects waiting for an answer, as { id, name }. */
    waiting() { return [...asked].map(([id, name]) => ({ id, name })); },
    /**
     * Can this project's job run here? "allowed" only when the person allowed it here; "denied" when they refused; "ask" when they have
     * not answered, and then it is remembered as asked (true from `first` the first time, so the caller asks the person once).
     */
    async check({ projectId, name }) {
      const s = this.state(projectId);
      if (s !== "ask") return s;
      const first = !asked.has(projectId);
      asked.set(projectId, String(name || projectId).slice(0, 120));
      return first ? "ask" : "asked";
    },
    /**
     * The `projects` of the hello: "all" while nothing is refused or waiting, else the person's projects but the refused and waiting
     * ones. `known` is every project id the account has (the server's list); without it (it could not be fetched) "all" is sent and
     * the offer is declined here instead.
     */
    helloProjects(known) {
      const m = map();
      const out = new Set(Object.entries(m).filter(([, e]) => e.allowed === false).map(([id]) => id));
      for (const id of asked.keys()) if (this.state(id) === "ask") out.add(id);
      if (!out.size) return "all";
      if (!Array.isArray(known) || !known.length) return "all";
      const ids = known.filter((id) => !out.has(id));
      return ids.slice(0, 200);
    },
  };
}

module.exports = { createAllowList };
