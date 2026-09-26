/**
 * KNOBS — every value the desktop app would otherwise decide for itself, asked
 * of the server instead.
 *
 * The same contract as the phones' app/src/sdui/knobs.ts, in plain JavaScript,
 * because this folder has no bundler: the main process `require`s it and every
 * page loads it as a plain <script> (it then lives on `window.TailzuKnobs`).
 * Nothing in here knows where the values come from — the main process fetches
 * the bootstrap itself and relays it to its windows, and the app window also
 * hands over every bootstrap it receives.
 *
 *   txt("desktop.notify.wordsOut", "You're out of words this month.")  → bootstrap.labels
 *   num("desktop.tap.gapMs", 400)                                       → bootstrap.flags
 *   bool / str / color / list / obj                                     → bootstrap.flags
 *
 * The literal next to each key is the value that used to be hardcoded, kept
 * only for the moment before the first bootstrap has ever arrived. The key and
 * that default must both be written as literals at the call site:
 * tools/knobs/extract.mjs reads them from the source, and the backend sends
 * every key it finds, so the control console can change each one live.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.TailzuKnobs = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  let labels = {};
  let flags = {};
  let source = null;

  /** Point the knobs at a bootstrap (or anything shaped { labels, flags }).
   *  Cheap and idempotent; call it with every bootstrap that arrives. */
  function setKnobs(boot) {
    if (!boot || boot === source) return;
    source = boot;
    labels = (boot.labels && typeof boot.labels === "object") ? boot.labels : {};
    flags = (boot.flags && typeof boot.flags === "object") ? boot.flags : {};
  }

  /** Text. `{name}` placeholders are filled from `vars`. */
  function txt(key, fallback, vars) {
    const v = labels[key];
    const s = typeof v === "string" ? v : fallback;
    return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
  }

  function num(key, fallback) {
    const v = flags[key];
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    return Number.isFinite(n) ? n : fallback;
  }

  function bool(key, fallback) {
    const v = flags[key];
    return typeof v === "boolean" ? v : fallback;
  }

  function str(key, fallback) {
    const v = flags[key];
    return typeof v === "string" ? v : fallback;
  }

  /** A colour: any CSS colour string the server sends, else the fallback. */
  function color(key, fallback) {
    const v = flags[key];
    return typeof v === "string" && v.length > 0 ? v : fallback;
  }

  function list(key, fallback) {
    const v = flags[key];
    return Array.isArray(v) ? v : fallback;
  }

  function obj(key, fallback) {
    const v = flags[key];
    return v && typeof v === "object" && !Array.isArray(v) ? Object.assign({}, fallback, v) : fallback;
  }

  return { setKnobs, txt, num, bool, str, color, list, obj };
});
