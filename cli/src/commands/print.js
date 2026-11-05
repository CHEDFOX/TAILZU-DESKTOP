// xode -p "question" (or --print): asks Xode once, in the folder's chat (POST /say), prints the answer as plain text and
// ends. It never approves a plan, never starts a job, and never offers this computer. Text piped in goes after the question
// (cat err.log | xode -p "why does this fail"), up to 20 KB.

"use strict";

const { createClient } = require("../api/client");
const { hostOf } = require("../config");
const { resolveProject } = require("../project/resolve");
const { flowApi } = require("../chat/flowApi");
const { threadFor } = require("../chat/thread");
const { plainLines } = require("../ui/markdown");

const LIMIT = 20 * 1024;

/** Everything piped in, up to `limit` bytes: { text, cut }. Nothing when stdin is a terminal. */
function readPiped(stdin, limit = LIMIT) {
  if (!stdin || stdin.isTTY) return Promise.resolve({ text: "", cut: false });
  return new Promise((resolve) => {
    const parts = [];
    let size = 0;
    let cut = false;
    stdin.on("data", (d) => {
      const b = Buffer.isBuffer(d) ? d : Buffer.from(String(d));
      if (size >= limit) { cut = true; return; }
      const room = limit - size;
      if (b.length > room) { parts.push(b.subarray(0, room)); size = limit; cut = true; } else { parts.push(b); size += b.length; }
    });
    stdin.on("end", () => resolve({ text: Buffer.concat(parts).toString("utf8"), cut }));
    stdin.on("error", () => resolve({ text: Buffer.concat(parts).toString("utf8"), cut }));
    stdin.resume();
  });
}

/** The question with the piped text after it. */
function questionOf(asked, piped) {
  const text = piped.text.replace(/\s+$/, "");
  if (!text) return asked;
  const note = piped.cut ? "\n[The piped text was cut to its first 20 KB.]" : "";
  return asked ? `${asked}\n\n${text}${note}` : `${text}${note}`;
}

async function print({ server, store, out, cwd, env, args, stdin = process.stdin }) {
  const token = await store.get(hostOf(server));
  if (!token) { out.error("Not signed in: run xode"); return 1; }
  const piped = await readPiped(stdin);
  const question = questionOf(args.message, piped);
  if (!question.trim()) { out.error('Nothing to ask: xode -p "your question"'); return 2; }
  if (piped.cut) out.error("Only the first 20 KB of the piped text was sent.");
  const client = createClient({ server, token });
  const quiet = { interactive: false, ended: true, ask: async () => null, pick: async () => null, onInterrupt: () => null };
  try {
    const project = await resolveProject(cwd, { flag: args.project, env, client, input: quiet, out, server, connect: false });
    const me = await client.get("/v1/auth/device", { timeoutMs: 10_000 }).catch((err) => { if (err.code === "signed_out") throw err; return null; });
    const userId = me && me.user && typeof me.user.id === "string" ? me.user.id : undefined;
    const thread = threadFor({ server, cwd: project.top, projectId: project.id, userId, fresh: args.fresh, env });
    const flow = flowApi(client, project.id);
    const r = await flow.plan(thread);
    if (!r.gate || !r.gate.open) { out.error("Xode hasn't read this project yet: run xode here first."); return 1; }
    const res = await flow.say(thread, question);
    for (const l of plainLines(res.answer || "")) out.line(l.code ? "    " + l.text : l.text);
    return 0;
  } catch (err) {
    out.error(err.message);
    return err.exitCode === 2 ? 2 : 1;
  }
}

module.exports = { print, readPiped, questionOf, LIMIT };
