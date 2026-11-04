// THE ALLOW LIST: which of the person's projects may run on this computer.
//
// Every project may, by default: nothing is asked before Xode runs a project's work here (it is said in the privacy policy, x0bot.com/privacy
// section 10, not in a dialog). What is kept here is what the person changed in the runner's window: a project they said "Don't allow" to is
// never run and never offered again (it is left out of the list `hello` sends, so the server does not even try), and one they allowed again
// is allowed. A project with no entry is allowed.
//
// Nothing here knows where the answers are kept (the app's own state file): that is handed in. It is also the only thing that decides: a
// server that offers a project this list refuses gets a `decline`, however it asks.

"use strict";

/**
 * o: {
 *   read()        -> { [projectId]: { name, allowed: boolean, at } }   what the person changed so far
 *   write(map)    keeps them
 *   now
 * }
 */
function createAllowList(o) {
  const now = o.now || Date.now;

  // What is kept on disk can be edited by hand: an entry that is not an object is no answer.
  const map = () => {
    const m = o.read();
    if (!m || typeof m !== "object") return {};
    return Object.fromEntries(Object.entries(m).filter(([, e]) => e && typeof e === "object"));
  };

  function decide(projectId, name, allowed) {
    const m = Object.assign({}, map());
    m[projectId] = { name: String(name || m[projectId]?.name || projectId).slice(0, 120), allowed: !!allowed, at: now() };
    o.write(m);
  }

  return {
    /** "allowed" (the default, and a project allowed again) or "denied" (the person said "Don't allow"). */
    state(projectId) {
      const e = map()[projectId];
      return e && e.allowed === false ? "denied" : "allowed";
    },
    decide,
    /** Back to the default (allowed): whatever the person said about it is forgotten. */
    forget(projectId) {
      const m = Object.assign({}, map());
      delete m[projectId];
      o.write(m);
    },
    /** Forget everything (a different person signed in). */
    clear() { o.write({}); },
    /** What the person changed, as the window lists it, newest first. */
    list() {
      return Object.entries(map()).map(([id, e]) => ({ id, name: e.name || id, state: e.allowed === false ? "denied" : "allowed", at: e.at || 0 })).sort((a, b) => b.at - a.at);
    },
    /** Can this project's job run here? "allowed", unless the person said "Don't allow" to it here ("denied"). Nothing is asked. */
    async check({ projectId }) {
      return this.state(projectId);
    },
    /**
     * The `projects` of the hello: "all" while nothing is refused, else the person's projects but the refused ones. `known` is every
     * project id the account has (the server's list); without it (it could not be fetched) "all" is sent and a refused project's
     * offer is declined here instead.
     */
    helloProjects(known) {
      const denied = new Set(Object.entries(map()).filter(([, e]) => e.allowed === false).map(([id]) => id));
      if (!denied.size) return "all";
      if (!Array.isArray(known) || !known.length) return "all";
      const ids = known.filter((id) => !denied.has(id));
      return ids.slice(0, 200);
    },
  };
}

module.exports = { createAllowList };
