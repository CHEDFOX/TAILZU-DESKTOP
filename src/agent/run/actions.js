// An action in words: its line in the history, the sentence it is confirmed
// with, and what the guide shows while it runs.

const { str, squash, clip } = require("./helpers.js");
const { appWords } = require("./risk.js");

/** The action line for the history, in the server's own line protocol. */
function actionLine(a) {
  const id = str(a.id);
  switch (a.kind) {
    case "press": return `PRESS ${id}`;
    case "set": return `SET ${id} | ${clip(squash(a.text), 80)}`;
    case "type": return `TYPE ${clip(squash(a.text), 80)}`;
    case "key": return `KEY ${squash(a.keys || a.text)}`;
    case "scroll": return `SCROLL ${squash(a.dir) || "down"}${id ? " " + id : ""}`;
    case "focus": return `FOCUS ${id}`;
    case "open": return `OPEN ${clip(squash(a.app || a.text), 60)}`;
    default: return clip(str(a.kind).toUpperCase(), 20);
  }
}

const prettyKeys = (k) => squash(k).split("+").map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p)).join("+");
const quoted = (el) => (el && el.role !== "window" && squash(el.label) ? `“${clip(squash(el.label), 60)}”` : "");

/** What an action is, for spotting the run doing it again: its kind and the
 *  role and label of what it acts on (ids are renumbered every walk), plus
 *  the keys, text, direction or app that make it this action and not
 *  another. */
function fingerprint(a, target) {
  const who = target ? `${str(target.role)}:${squash(target.label).toLowerCase()}` : "";
  switch (a.kind) {
    case "key": return `key|${who}|${squash(a.keys || a.text).toLowerCase()}`;
    case "type": return `type|${who}|${squash(a.text)}`;
    case "scroll": return `scroll|${who}|${squash(a.dir).toLowerCase() || "down"}`;
    case "open": return `open|${appWords(a.app || a.text).join(" ")}`;
    default: return `${a.kind}|${who}`;
  }
}

/** The sentence a risky action is confirmed with: the server's, which knows
 *  what is being sent where, or one made here when only this side thought it
 *  needed asking. */
function confirmText(a, target) {
  const given = squash(a.confirm);
  if (given) return clip(given, 240);
  const name = quoted(target);
  const text = clip(squash(a.text), 80);
  switch (a.kind) {
    case "press": return name ? `Press ${name}?` : "Press it?";
    case "set": return `Put “${text}” in ${name || "the field"}?`;
    case "type": return `Type “${text}”?`;
    case "key": return `Press ${prettyKeys(a.keys || a.text)}${name ? ` in ${name}` : ""}?`;
    case "open": return `Open ${clip(squash(a.app || a.text), 60)}?`;
    case "scroll": return `Scroll ${squash(a.dir) || "down"}?`;
    case "focus": return name ? `Go to ${name}?` : "Go there?";
    default: return "Go ahead?";
  }
}

/** What the guide shows while the action runs. */
function acting(a, target) {
  const name = quoted(target);
  switch (a.kind) {
    case "press": return name ? `Pressing ${name}` : "Pressing";
    case "set": return name ? `Filling in ${name}` : "Filling it in";
    case "type": return "Typing";
    case "key": return `Pressing ${prettyKeys(a.keys || a.text)}`;
    case "scroll": return `Scrolling ${squash(a.dir) || "down"}`;
    case "focus": return name ? `Going to ${name}` : "Going there";
    case "open": return `Opening ${clip(squash(a.app || a.text), 60)}`;
    default: return "Working";
  }
}

module.exports = { actionLine, fingerprint, confirmText, acting };
