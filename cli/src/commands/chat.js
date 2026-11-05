// xode, and xode "words": a chat with Xode about a project (the words, when given, are its first message).

"use strict";

const { createClient } = require("../api/client");
const { hostOf } = require("../config");
const { resolveProject } = require("../project/resolve");
const { runSession } = require("../chat/session");

async function chat({ server, store, out, input, cwd, env, args, pollMs }) {
  const token = await store.get(hostOf(server));
  if (!token) { out.error("Not signed in: run xode login"); return 1; }
  const client = createClient({ server, token });
  try {
    const project = await resolveProject(cwd, { flag: args.project, env, client, input, out });
    // Who this is, for the chat the app shares (chat/thread.js); a server that does not say still has its own thread.
    const me = await client.get("/v1/auth/device", { timeoutMs: 10_000 }).catch(() => null);
    const userId = me && me.user && typeof me.user.id === "string" ? me.user.id : undefined;
    return await runSession({ client, server, cwd, env, input, out, project, userId, first: args.message, fresh: args.fresh, pollMs });
  } catch (err) {
    if (input.closed && err.code === "cancelled") return 0;
    out.error(err.message);
    return 1;
  }
}

module.exports = { chat };
