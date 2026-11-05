// The chat a terminal talks in: a thread id (a UUID) the server keeps the plan and the talk under.
// The same one the app uses for the person and the project (tulmi/src/experience/bots/screens/codeWork/parts.ts threadFor), so
// the terminal and the app see one chat and one plan. --new starts a separate one, remembered per folder in state.json.

"use strict";

const crypto = require("crypto");
const { folderState, saveFolderState } = require("../state/folders");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The app's thread for this person and project: sha256 of "tailzu:code-chat:<user>:<project>", shaped as a UUID. */
function appThread(userId, projectId) {
  const h = crypto.createHash("sha256").update(`tailzu:code-chat:${userId}:${projectId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function threadFor({ server, cwd, projectId, userId, fresh = false, env = process.env }) {
  const st = folderState(server, cwd, env);
  const own = st.ownThread && st.ownThread[projectId];
  if (!fresh && UUID.test(own || "")) return own;
  if (!fresh && userId) return appThread(userId, projectId);
  const threads = st.threads && typeof st.threads === "object" ? st.threads : {};
  if (!fresh && UUID.test(threads[projectId] || "")) return threads[projectId];
  const id = crypto.randomUUID();
  saveFolderState(server, cwd, { projectId, threads: { ...threads, [projectId]: id }, ...(fresh ? { ownThread: { ...(st.ownThread || {}), [projectId]: id } } : {}) }, env);
  return id;
}

module.exports = { threadFor, appThread };
