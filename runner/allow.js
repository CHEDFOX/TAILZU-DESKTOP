// THE ALLOW LIST: which of the person's projects may run on this computer.
//
// Per project, and decided by the person here, on this computer. The first time Xode offers a project's work to this
// computer, a question is put to them ("Let Tailzu Code run this project's commands on this computer?") and the answer is
// remembered: allowed, or not. A project that was never answered is not run. A project that was refused is never offered again
// (it is left out of the list `hello` sends, so the server does not even try).
//
// Nothing here knows how the question is asked (a native dialog, in main.js) or where the answers are kept (the app's own
// state file): both are handed in. It is also the only thing that decides: a server that offers a project this list does not
// allow gets a `decline`, however it asks.

"use strict";

/**
 * o: {
 *   read()        -> { [projectId]: { name, allowed: boolean, at } }   the answers so far
 *   write(map)    keeps them
 *   ask({ projectId, name }) -> Promise<true | false | null>   null: the question was closed without an answer
 *   waitMs        how long a job's offer waits for the answer before it is declined (the lease is 90 s)
 *   now, timers
 * }
 */
function createAllowList(o) {
  const now = o.now || Date.now;
  const timers = o.timers || { setTimeout, clearTimeout };
  const waitMs = o.waitMs === undefined ? 45000 : o.waitMs;
  const asking = new Map();   // projectId -> Promise<boolean | null>

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
    /** "allowed", "denied" or "ask" (never answered). */
    state(projectId) {
      const e = map()[projectId];
      return !e ? "ask" : e.allowed ? "allowed" : "denied";
    },
    decide,
    /** Back to "ask": the next offer is asked about again. */
    forget(projectId) {
      const m = Object.assign({}, map());
      delete m[projectId];
      o.write(m);
    },
    /** Forget everything (a different person signed in). */
    clear() { o.write({}); },
    /** The answers as the window lists them, newest first. */
    list() {
      return Object.entries(map()).map(([id, e]) => ({ id, name: e.name || id, state: e.allowed ? "allowed" : "denied", at: e.at || 0 })).sort((a, b) => b.at - a.at);
    },
    /**
     * Can this project's job run here? Resolves "allowed", "denied", or "waiting" (it was asked about, the person has not
     * answered in time: the job is declined now, and the answer, when it comes, is kept for the next one).
     */
    async check({ projectId, name }) {
      const s = this.state(projectId);
      if (s === "allowed") return "allowed";
      if (s === "denied") return "denied";
      let pending = asking.get(projectId);
      if (!pending) {
        pending = (async () => {
          let answer = null;
          try { answer = await o.ask({ projectId, name }); } catch { answer = null; }
          if (answer === true || answer === false) decide(projectId, name, answer);
          return answer;
        })().finally(() => { asking.delete(projectId); });
        asking.set(projectId, pending);
      }
      let timer;
      const timeout = new Promise((resolve) => { timer = timers.setTimeout(() => resolve("waiting"), waitMs); });
      const answer = await Promise.race([pending, timeout]);
      timers.clearTimeout(timer);
      if (answer === "waiting" || answer === null) return "waiting";
      return answer ? "allowed" : "denied";
    },
    /**
     * The `projects` of the hello: "all" while nothing is refused, else the person's projects but the refused ones. `known` is every
     * project id the account has (the server's list); without it (it could not be fetched) "all" is sent and a refused project's
     * offer is declined here instead.
     */
    helloProjects(known) {
      const denied = new Set(Object.entries(map()).filter(([, e]) => !e.allowed).map(([id]) => id));
      if (!denied.size) return "all";
      if (!Array.isArray(known) || !known.length) return "all";
      const ids = known.filter((id) => !denied.has(id));
      return ids.slice(0, 200);
    },
    get asking() { return asking.size; },
  };
}

module.exports = { createAllowList };
