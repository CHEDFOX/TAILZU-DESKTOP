// Small helpers the run's parts share: text, frames, elements, timing, and the
// lists of browsers and web-built apps.

const knobs = require("../../../knobs.js");

const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const squash = (v) => str(v).replace(/\s+/g, " ").trim();
/** Cut to n characters, with an ellipsis that says it was cut. */
function clip(v, n) {
  const s = str(v);
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s;
}
const errText = (e) => clip(squash((e && e.message) || e || "error"), 120);

function isFrame(f) {
  return Array.isArray(f) && f.length === 4 && f.every((n) => typeof n === "number" && Number.isFinite(n));
}

function elementsOf(snapshot) {
  return snapshot && snapshot.ok !== false && Array.isArray(snapshot.elements)
    ? snapshot.elements.filter((e) => e && typeof e === "object")
    : [];
}
/** The accessibility tree's elements, without the lines read off a picture. */
const treeOf = (snapshot) => elementsOf(snapshot).filter((e) => e.ocr !== true);

/** The element with keyboard focus: the one the snapshot names, or the first
 *  one that says so itself. */
function focusedOf(snapshot) {
  const els = elementsOf(snapshot);
  if (snapshot && snapshot.focused) {
    const named = els.find((e) => e.id === snapshot.focused);
    if (named) return named;
  }
  return els.find((e) => e.focused === true) || null;
}

/** A promise that settles with `fallback` if `p` takes longer than `ms`. */
function within(p, ms, fallback) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), Math.max(0, ms)); });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** Any of these, as whole words, in any script: "send" but not "sender",
 *  "post" but not "postpone", "order" but not "ordered list". A letter or
 *  digit on either side means it is part of another word. */
const words = (list) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${list.join("|")})(?![\\p{L}\\p{N}])`, "iu");

/** Apps whose controls are web pages: a page's author writes its
 *  accessibility labels, and they can say anything. */
const BROWSERS_BUILT_IN = words(["chrome", "chromium", "safari", "edge", "msedge", "firefox", "arc", "brave", "opera", "vivaldi"]);
/** …and the apps built on one (Electron, webviews). Their text boxes are
 *  React or Quill components that only hear typing, not a value set from
 *  outside: a SET there leaves the message empty, or it snaps back. */
const WEB_APPS_BUILT_IN = words([
  "chrome", "chromium", "safari", "edge", "msedge", "firefox", "arc", "brave", "opera", "vivaldi",
  "slack", "discord", "notion", "whatsapp", "teams", "code", "visual\\s+studio\\s+code", "figma", "linear",
  "obsidian", "electron",
]);
/**
 * The server may add to both (desktop.agent.browsers, desktop.agent.webApps),
 * never take from them: a press in a browser asks first, so a browser it does
 * not know of would be a press that does not. A bad list, or none, leaves them
 * as they are.
 */
function plusServer(builtIn, key) {
  let from = null;
  let more = null;
  return {
    test(name) {
      if (builtIn.test(name)) return true;
      const v = key === "browsers" ? knobs.list("desktop.agent.browsers", []) : knobs.list("desktop.agent.webApps", []);
      if (v !== from) {
        from = v;
        const w = (Array.isArray(v) ? v : []).filter((x) => typeof x === "string" && x.trim())
          .map((x) => x.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"));
        more = w.length ? words(w) : null;
      }
      return !!more && more.test(name);
    },
  };
}
const BROWSERS = plusServer(BROWSERS_BUILT_IN, "browsers");
const WEB_APPS = plusServer(WEB_APPS_BUILT_IN, "webApps");

module.exports = { str, squash, clip, errText, isFrame, elementsOf, treeOf, focusedOf, within, sleep, words, BROWSERS, WEB_APPS };
