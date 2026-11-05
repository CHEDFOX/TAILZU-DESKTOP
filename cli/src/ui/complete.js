// Tab at the prompt: a command after "/" at the start, or a file or folder of the project after "@" (what git knows of:
// `git ls-files`, tracked and new files that aren't ignored, and the folders they are in). The text is sent as typed.

"use strict";

const { git } = require("../git/run");

const KEEP_MS = 10_000;
const SHOW = 12;

/** The paths of the project: files, then their folders (ending in "/"). Kept for a few seconds between presses of Tab. */
function projectPaths(cwd, run = git) {
  let at = 0;
  let paths = [];
  return async () => {
    if (Date.now() - at < KEEP_MS) return paths;
    try {
      const { stdout } = await run(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd, what: "list the files" });
      const files = [...new Set(stdout.split("\0").filter(Boolean))];
      const dirs = new Set();
      for (const f of files) {
        const parts = f.split("/");
        for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join("/") + "/");
      }
      paths = [...files, ...dirs].sort();
    } catch {
      paths = [];
    }
    at = Date.now();
    return paths;
  };
}

/** The longest start that every string in `list` shares. */
function commonStart(list) {
  if (!list.length) return "";
  let s = list[0];
  for (const x of list) while (!x.startsWith(s)) s = s.slice(0, -1);
  return s;
}

/** The paths after "@" that `typed` could become: the next level under it; else any file whose name starts with it. */
function pathMatches(paths, typed) {
  const next = paths.filter((p) => {
    if (!p.startsWith(typed) || p === typed) return false;
    const rest = p.slice(typed.length);
    const slash = rest.indexOf("/");
    return slash < 0 || slash === rest.length - 1;
  });
  if (next.length || !typed) return next;
  const low = typed.toLowerCase();
  return paths.filter((p) => !p.endsWith("/") && p.split("/").pop().toLowerCase().startsWith(low));
}

/**
 * completer(text, pos) resolves { text, pos, options } for a Tab at `pos` in `text`: the text completed as far as it can go,
 * and when several are possible and nothing more could be added, the ones to show (at most a dozen). Null: nothing to do.
 * commands: ["/help", ...].
 */
function createCompleter({ cwd, commands = [], paths = projectPaths(cwd) }) {
  return async (text, pos) => {
    const before = text.slice(0, pos);
    if (/^\/\S*$/.test(before) && !text.slice(pos).trim()) {
      const hits = commands.filter((c) => c.startsWith(before));
      return apply(text, pos, 0, before, hits, " ");
    }
    const m = /(^|\s)@([^\s]*)$/.exec(before);
    if (!m) return null;
    const typed = m[2];
    const start = pos - typed.length;
    const hits = pathMatches(await paths(), typed);
    return apply(text, pos, start, typed, hits, "", true);
  };
}

function apply(text, pos, start, typed, hits, after, isPath = false) {
  if (!hits.length) return null;
  if (hits.length === 1) {
    const one = hits[0];
    const tail = isPath ? (one.endsWith("/") ? "" : " ") : after;
    const done = text.slice(0, start) + one + tail;
    return { text: done + text.slice(pos), pos: done.length, options: [] };
  }
  const common = commonStart(hits);
  // Several, with nothing they all share beyond what is typed (or, for a name matched anywhere, nothing at all to add).
  if (common.length > typed.length && common.startsWith(typed)) {
    const done = text.slice(0, start) + common;
    return { text: done + text.slice(pos), pos: done.length, options: [] };
  }
  const options = hits.slice(0, SHOW);
  if (hits.length > SHOW) options.push(`… and ${hits.length - SHOW} more`);
  return { text, pos, options };
}

module.exports = { createCompleter, projectPaths, pathMatches, commonStart };
