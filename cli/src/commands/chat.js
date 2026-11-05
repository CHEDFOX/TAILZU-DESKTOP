// xode, and xode "words": the session in this folder. Signs in first when nobody is (the code, a wait, then straight on),
// finds the folder's project without a word unless something is wrong, shows the welcome box, and opens the prompt (with the
// words as its first message, when given). While it is open this computer is offered for the project's work
// (computer/host.js), unless --no-runner or XODE_RUNNER=0.

"use strict";

const { createClient } = require("../api/client");
const { hostOf } = require("../config");
const { resolveProject } = require("../project/resolve");
const { runSession } = require("../chat/session");
const { NAMES } = require("../chat/slash");
const { startComputer, wanted } = require("../computer/host");
const { signIn } = require("./login");
const { welcomeLines } = require("../ui/welcome");
const { createHistory } = require("../ui/history");
const { createCompleter } = require("../ui/complete");
const { startUpdateCheck } = require("../upkeep/updateCheck");
const pkg = require("../../package.json");

/** deps: { createRunner, platform, hostname, holdMs, home } for the tests; left out, the real ones. */
async function chat({ server, store, out, input, cwd, env, args, pollMs, deps = {} }) {
  const updates = startUpdateCheck({ env, version: pkg.version });
  let token = await store.get(hostOf(server));
  if (!token) {
    const r = await signIn({ server, store, out, input });
    if (!r.token) return r.cancelled ? 0 : r.code;
    token = r.token;
  }
  let client = createClient({ server, token });
  // Who this is, for the chat the app shares (chat/thread.js). A sign-in the server no longer takes is made again here.
  let me = await client.get("/v1/auth/device", { timeoutMs: 10_000 }).catch((err) => (err.code === "signed_out" ? "signed_out" : null));
  if (me === "signed_out") {
    out.line("This computer's sign-in was switched off. Sign in again:");
    const r = await signIn({ server, store, out, input });
    if (!r.token) return r.cancelled ? 0 : r.code;
    token = r.token;
    client = createClient({ server, token });
    me = await client.get("/v1/auth/device", { timeoutMs: 10_000 }).catch(() => null);
  }
  const userId = me && me.user && typeof me.user.id === "string" ? me.user.id : undefined;

  let computer = null;
  try {
    const project = await resolveProject(cwd, { flag: args.project, env, client, input, out, server, pollMs, platform: deps.platform });
    const offer = (tok) => (wanted(args, env)
      ? startComputer({ server, token: tok, project, out, env, version: pkg.version, createRunner: deps.createRunner, hostname: deps.hostname, platform: deps.platform, holdMs: deps.holdMs })
      : null);
    computer = offer(token);

    out.lines(welcomeLines({ repo: project.name, folder: project.top, term: out.term, paint: out.paint, home: deps.home }));
    const news = updates.notice();
    if (news) out.note(news);

    input.setHistory(createHistory(project.top, env));
    input.setCompleter(createCompleter({ cwd: project.top, commands: NAMES }));
    return await runSession({
      client, server, cwd: project.top, env, input, out, project, userId, first: args.message, fresh: args.fresh, pollMs, store,
      computer: () => computer,
      onSignedIn: (tok) => { if (computer) { computer.stop(); computer = offer(tok); } },
    });
  } catch (err) {
    if (err.code === "cancelled") {
      if (!input.closed) out.line(err.message);
      return 0;
    }
    out.error(err.message);
    return err.exitCode || 1;
  } finally {
    if (computer) computer.stop();
  }
}

module.exports = { chat };
