// The server's confirm card for a connected app: its words and buttons, and
// the only routes those buttons may call.

const { str, squash, clip } = require("./helpers.js");

/** The only routes a confirm card's button may call: a task's yes or no. */
const TASK_ROUTE = /^\/v1\/tasks\/([A-Za-z0-9_-]{1,64})\/(approve|deny)$/;
const isTaskRoute = (path) => TASK_ROUTE.test(str(path));
const CARD_BUTTONS = ["approve", "edit", "deny"];

/**
 * The card of an `approve` event, kept to what the guide may draw and the
 * routes it may call: the server's words (cut to what a card holds), and for
 * each button the one route it names, which must be this task's own approve
 * or deny. Null when it has no card, no way to say yes or no, or a route that
 * is not that: nothing is then asked, and nothing is called.
 */
function approvalOf(ev) {
  const c = ev && ev.card;
  if (!c || typeof c !== "object") return null;
  const taskId = str(ev.taskId);
  const buttons = [];
  for (const b of Array.isArray(c.buttons) ? c.buttons : []) {
    if (!b || typeof b !== "object" || !CARD_BUTTONS.includes(b.id) || buttons.some((x) => x.id === b.id)) continue;
    const label = clip(squash(b.label), 40);
    const call = b.call && typeof b.call === "object" ? b.call : {};
    const m = TASK_ROUTE.exec(str(call.path));
    if (!label || call.method !== "POST" || !m || m[1] !== taskId) continue;
    // The yes names its approval; no other body goes anywhere.
    const approvalId = call.body && typeof call.body === "object" ? str(call.body.approvalId) : "";
    if ((m[2] === "approve") !== (b.id === "approve")) continue;
    buttons.push({ id: b.id, label, call: { method: "POST", path: m[0], body: approvalId ? { approvalId: clip(approvalId, 64) } : {} }, then: b.then === "listen" });
  }
  const yes = buttons.find((b) => b.id === "approve");
  const no = buttons.find((b) => b.id === "deny");
  const preview = clip(squash(c.preview), 400);
  if (!yes || !no || !preview) return null;
  const after = c.after && typeof c.after === "object" ? c.after : {};
  const w = (v, n) => clip(squash(v), n);
  return {
    title: w(c.title, 80), app: w(c.app, 60), label: w(c.label, 60), preview, note: w(c.note, 200),
    buttons,
    after: { done: w(after.done, 60), left: w(after.left, 120), failed: w(after.failed, 120), change: w(after.change, 120) },
  };
}

module.exports = { isTaskRoute, CARD_BUTTONS, approvalOf };
