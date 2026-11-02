// What changed on the screen after an action, said back to the server, and
// where keyboard focus went.

const { str, squash, clip, isFrame, treeOf, focusedOf } = require("./helpers.js");

const keyOf = (e) => str(e.role) + "\u0001" + squash(e.label).toLowerCase();
const printable = (e) => e && e.role !== "window" && squash(e.label) ? `"${clip(squash(e.label), 30)}"` : "";

function sameFrame(a, b) {
  if (!isFrame(a) || !isFrame(b)) return !isFrame(a) && !isFrame(b);
  return a.every((v, i) => Math.abs(v - b[i]) <= 2);
}

/**
 * One short line for the history's `note`: what the action did to the
 * screen, so the next step plans from what happened rather than from what was
 * meant to. Elements are matched by role and label, not id — ids are
 * renumbered on every walk. "nochange" when nothing differs; that word is
 * also what stops a run that keeps pressing the same thing to no effect.
 */
function describeChange(before, after) {
  if (!before || before.ok !== true || !after || after.ok !== true) return "couldn't read the screen";
  const parts = [];
  const appA = before.app || {};
  const appB = after.app || {};
  if (str(appA.name) !== str(appB.name) || (appA.pid && appB.pid && appA.pid !== appB.pid)) {
    parts.push(appB.name ? `switched to ${clip(squash(appB.name), 40)}` : "app changed");
  } else if (!before.window !== !after.window) {
    parts.push(after.window ? "a window opened" : "the window closed");
  } else if (before.window && after.window && !sameFrame(before.window.frame, after.window.frame)) {
    parts.push("window changed");
  }

  const fa = focusedOf(before);
  const fb = focusedOf(after);
  if (fb && (!fa || keyOf(fa) !== keyOf(fb))) {
    const name = printable(fb);
    parts.push(name ? `focus moved to ${name}` : "focus moved");
  }

  // The tree only: the lines read off the first screen's picture are not read
  // again after an action, so they would all count as gone.
  const a = treeOf(before);
  const b = treeOf(after);
  const byKeyA = new Map();
  for (const e of a) {
    const k = keyOf(e);
    if (!byKeyA.has(k)) byKeyA.set(k, []);
    byKeyA.get(k).push(e);
  }
  const used = new Map();
  const named = [];
  const changes = [];
  let added = 0;
  for (const e of b) {
    const k = keyOf(e);
    const n = used.get(k) || 0;
    used.set(k, n + 1);
    const was = (byKeyA.get(k) || [])[n];
    if (!was) {
      added++;
      const name = printable(e);
      if (name && named.length < 3) named.push(name);
      continue;
    }
    // The same element, still there: did its state move?
    const name = printable(e) || `the ${str(e.role) || "element"}`;
    if (typeof e.checked === "boolean" && e.checked !== was.checked) changes.push(`${name} turned ${e.checked ? "on" : "off"}`);
    else if (e.selected === true && was.selected !== true) changes.push(`${name} selected`);
    else if (!e.secure && str(e.value) !== str(was.value)) changes.push(`${name} changed`);
    else if (!!e.disabled !== !!was.disabled) changes.push(`${name} ${e.disabled ? "disabled" : "enabled"}`);
  }
  let gone = 0;
  for (const [k, list] of byKeyA) gone += Math.max(0, list.length - (used.get(k) || 0));

  if (added) parts.push(`${added} new element${added === 1 ? "" : "s"}${named.length ? " like " + named.join(", ") : ""}`);
  if (gone) parts.push(`${gone} element${gone === 1 ? "" : "s"} gone`);
  parts.push(...changes.slice(0, 2));
  return parts.length ? clip(parts.join("; "), 200) : "nochange";
}

/** Null when keyboard focus is where it was in `before` (the same app, and
 *  an element of the same role and label, or none in both); otherwise the
 *  note that says where it went. */
function focusMoved(before, now) {
  if (!now || now.ok !== true) return "couldn't read the focus";
  const appA = squash(before && before.ok === true && before.app && before.app.name);
  const appB = squash(now.app && now.app.name);
  if (appA && appB && appA !== appB) return `switched to ${clip(appB, 40)}`;
  const fa = before && before.ok === true ? focusedOf(before) : null;
  const fb = focusedOf(now);
  if (!fa && !fb) return null;
  if (fa && fb && keyOf(fa) === keyOf(fb)) return null;
  const name = printable(fb);
  return name ? `focus moved to ${name}` : fb ? "focus moved" : "focus was lost";
}

/** True when `now` has keyboard focus on `target` (an element of `before`):
 *  the same app, and a focused element of the same role and label. Ids are
 *  renumbered on every walk, so the id cannot be compared. */
function focusLandedOn(target, before, now) {
  if (!target || !now || now.ok !== true) return false;
  const appA = squash(before && before.ok === true && before.app && before.app.name);
  const appB = squash(now.app && now.app.name);
  if (appA && appB && appA !== appB) return false;
  const f = focusedOf(now);
  return !!f && keyOf(f) === keyOf(target);
}

/** The window's title, for the checks on this computer only. It is never put
 *  in a request, a history note or a log line. "" when the helper gave none. */
const titleOf = (snapshot) => str(snapshot && snapshot.window && snapshot.window.title).slice(0, 200);

module.exports = { describeChange, focusMoved, focusLandedOn, titleOf };
