// xode, and xode "words": a chat with Xode about the folder's project (the words, when given, are its first message).
// While it is open this computer is offered for the project's work (computer/host.js), unless --no-runner or XODE_RUNNER=0.

"use strict";

const { createClient } = require("../api/client");
const { hostOf } = require("../config");
const { resolveProject } = require("../project/resolve");
const { runSession } = require("../chat/session");
const { startComputer, wanted } = require("../computer/host");
const pkg = require("../../package.json");

/** deps: { createRunner, platform, hostname } for the tests; left out, the real ones. */
async function chat({ server, store, out, input, cwd, env, args, pollMs, deps = {} }) {
  const token = await store.get(hostOf(server));
  if (!token) { out.error("Not signed in: run xode login"); return 1; }
  const client = createClient({ server, token });
  let computer = null;
  try {
    const project = await resolveProject(cwd, { flag: args.project, env, client, input, out, server, pollMs, platform: deps.platform });
    if (wanted(args, env)) {
      computer = startComputer({ server, token, project, out, env, version: pkg.version, createRunner: deps.createRunner, hostname: deps.hostname, platform: deps.platform, holdMs: deps.holdMs });
    }
    // Who this is, for the chat the app shares (chat/thread.js); a server that does not say still has its own thread.
    const me = await client.get("/v1/auth/device", { timeoutMs: 10_000 }).catch(() => null);
    const userId = me && me.user && typeof me.user.id === "string" ? me.user.id : undefined;
    return await runSession({ client, server, cwd: project.top, env, input, out, project, userId, first: args.message, fresh: args.fresh, pollMs });
  } catch (err) {
    if (err.code === "cancelled") {
      if (!input.closed) out.line(err.message);
      return input.closed ? 0 : 130;
    }
    out.error(err.message);
    return err.exitCode || 1;
  } finally {
    if (computer) computer.stop();
  }
}

module.exports = { chat };
