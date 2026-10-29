/**
 * LOCAL FILES — Ask's "This computer", the part that touches files.
 *
 * The server's planner asks for something to be done to the person's own files
 * (a `device` event, agent.js); this module does it, here, and is the only
 * thing that does. The server never sees a file or a full path: it is told
 * names, sizes, kinds and dates, and a path is always an allowed folder's name
 * and the way down ("Downloads/Invoices/a.pdf"). What is inside a file is
 * never read: there is no tool that opens one for its contents.
 *
 * THE RULES, all of them enforced here and not left to the planner:
 *   - only inside the allowed folders: Downloads, Desktop and Documents until
 *     the person changes them in Settings (roots());
 *   - never a system, app or hidden folder, whatever was allowed: no dot
 *     folders or files, no .app bundles, nothing under Windows, Program Files,
 *     /System, /usr and the like, this app's own data, the home folder itself;
 *   - a path is checked after the system has resolved it (realpath), so ".."
 *     and links that lead out are refused; ".." is refused outright, a link
 *     is never followed, copied, moved or trashed, and the check is made again
 *     at the moment of the change, not only when it was planned;
 *   - nothing is overwritten: a name already taken becomes "name (2)";
 *   - Trash is Electron's shell.trashItem only, and is asked about every time;
 *   - at most MAX_FILES files in one change (the rest are said, not done);
 *   - every change is written to an undo log in userData as it happens, so
 *     "undo" puts back what a change got through even when it failed halfway.
 *
 * plan(tool, args) never changes anything: it answers { ok, risk, count, say,
 * lines, run } where `say` is the plan card's headline as a word key and its
 * slots, and `run()` does it. A look (find, list, open, reveal) has risk "read"
 * and its run() is the whole of it.
 *
 *   createLocalFiles({ fs, path, os, shell, platform, home, userData, roots, protect, now, caseInsensitive })
 *     roots()   the folders the person chose (absolute paths; an empty list is "none"), or null for the usual three
 *     protect   paths of the app itself (its program, its folder): never touched even when they sit inside an allowed folder
 */
"use strict";

const nodeFs = require("node:fs");
const nodePath = require("node:path");
const nodeOs = require("node:os");

const MAX_FILES = 500;
const FIND_DEFAULT = 25;
const FIND_MAX = 50;
const WALK_DEPTH = 6;
const WALK_VISITED = 20000;
const RESULT_CHARS = 4500;
const CARD_LINES = 12;
const UNDO_BATCHES = 10;
const SUFFIX_TRIES = 1000;

/** The plan card's words when the server sent none (the same keys as the server's DeviceWords). */
const EN_WORDS = {
  title: "Okay to change these files?", titleTrash: "Move these to the Trash?", label: "What I’ll do",
  note: "Approve once, and I’ll do this kind of change on this computer without asking again. I only touch the folders you allowed, and I can undo it.",
  noteTrash: "Moving to the Trash always asks. You can put things back from the Trash.",
  ok: "Approve", later: "Not now", done: "Done ✓", left: "Okay, I left your files alone.", failed: "That didn’t all go through.",
  working: "Working on your files…",
  organise: "I’ll move {n} files into {m} folders inside {to}.", move: "I’ll move {n} files to {to}.", copy: "I’ll copy {n} files to {to}.",
  rename: "I’ll rename {from} to {to}.", makeFolder: "I’ll make a folder called {to}.", trash: "I’ll move {n} files to the Trash.",
  undo: "I’ll undo the last change ({n} files).", more: "…and {n} more",
};

const RISK = {
  find_files: "read", list_folder: "read", open_file: "read", reveal_file: "read",
  organise_folder: "write", move_files: "write", copy_files: "write", rename_file: "write", make_folder: "write", undo_last: "write",
  trash_files: "destructive",
};

// ---- kinds ---------------------------------------------------------------------

const KIND_EXT = {
  image: "jpg jpeg png gif webp heic heif bmp tif tiff svg raw cr2 nef arw dng ico avif",
  video: "mp4 mov m4v avi mkv webm wmv flv mpg mpeg 3gp",
  audio: "mp3 wav m4a aac flac ogg oga opus aiff aif wma amr",
  pdf: "pdf",
  document: "doc docx txt md rtf pages odt tex epub mobi",
  spreadsheet: "xls xlsx csv tsv numbers ods xlsm",
  presentation: "ppt pptx key odp pps ppsx",
  archive: "zip rar 7z tar gz tgz bz2 xz zst iso",
  installer: "dmg pkg exe msi appimage deb rpm apk",
  code: "js ts jsx tsx py rb go rs java c cc cpp h hpp cs php swift kt sh bash zsh ps1 html css json xml yaml yml sql ipynb",
};
const EXT_KIND = new Map();
for (const [kind, list] of Object.entries(KIND_EXT)) for (const e of list.split(" ")) EXT_KIND.set(e, kind);
const KINDS = new Set([...Object.keys(KIND_EXT), "other"]);
/** The subfolder each kind is sorted into. */
const KIND_FOLDER = {
  image: "Images", video: "Videos", audio: "Audio", pdf: "PDFs", document: "Documents", spreadsheet: "Spreadsheets",
  presentation: "Presentations", archive: "Archives", installer: "Installers", code: "Code", other: "Other",
};
/** What opening would run rather than show. Never opened from here. */
const RUNS_CODE = new Set(("exe msi bat cmd com scr ps1 psm1 vbs vbe wsf wsh jar js jse lnk url reg app command sh bash zsh " +
  "workflow action pkg dmg appimage run cpl hta inf desktop scpt scptd terminal " +
  "py pyw pl rb msc application gadget scf chm ws wsc sct vb jnlp webloc inetloc appref-ms diagcab settingcontent-ms ps1xml psd1 mht mhtml").split(" "));
const BUNDLE_EXT = [".app", ".framework", ".bundle", ".plugin", ".kext", ".xpc", ".photoslibrary"];

function extOf(name) {
  const n = String(name).replace(/[. ]+$/, "");
  const i = n.lastIndexOf(".");
  return i > 0 ? n.slice(i + 1).toLowerCase() : "";
}
const kindOf = (name) => EXT_KIND.get(extOf(name)) || "other";

const POSIX_SYSTEM = ["system", "library", "applications", "usr", "bin", "sbin", "etc", "var", "private", "opt", "proc", "sys", "dev", "boot",
  "lib", "lib32", "lib64", "root", "snap", "srv", "cores"];
const WIN_SYSTEM = ["windows", "program files", "program files (x86)", "programdata", "$recycle.bin", "system volume information", "recovery", "perflogs"];

// ---- small helpers ---------------------------------------------------------------

const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/;
/** What a name may not show: control characters, and the marks that reorder or hide text (a name that reads "fdp.exe" backwards). */
const NAME_G = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
const tidy = (s) => str(s).replace(NAME_G, " ");
const tidyText = (s) => str(s).split("\n").map(tidy).join("\n");
const fill = (s, vars) => str(s).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m));
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** A failure in plain words; never the path the system put in its message. */
function whyFailed(e) {
  const code = e && e.code;
  if (code === "EACCES" || code === "EPERM") return "no permission";
  if (code === "EBUSY" || code === "ETXTBSY") return "in use";
  if (code === "ENOENT") return "not found";
  if (code === "ENOSPC") return "disk full";
  if (code === "EEXIST") return "name taken";
  if (code === "EXDEV") return "another disk";
  if (e && e.refused) return str(e.message);
  return "failed";
}
const refuse = (message) => Object.assign(new Error(message), { refused: true });

function sizeText(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 102.4) / 10} KB`;
  if (n < 1024 * 1024 * 1024) return `${Math.round(n / 104857.6) / 10} MB`;
  return `${Math.round(n / 107374182.4) / 10} GB`;
}
function dayText(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const monthText = (ms) => dayText(ms).slice(0, 7);

/** Words for matching a file name: lower case, no accents, split on anything that is not a letter or digit. */
const wordsIn = (s) => str(s).normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

// ---- the module -------------------------------------------------------------------

function createLocalFiles(opts) {
  const o = opts || {};
  const fs = o.fs || nodeFs;
  const path = o.path || nodePath;
  const platform = o.platform || process.platform;
  const home = o.home || (o.os || nodeOs).homedir();
  const userData = o.userData || "";
  const shell = o.shell || {};
  const now = typeof o.now === "function" ? o.now : Date.now;
  const insensitive = typeof o.caseInsensitive === "boolean" ? o.caseInsensitive : platform === "darwin" || platform === "win32";
  const chosen = typeof o.roots === "function" ? o.roots : () => null;
  const sep = path.sep;
  // THE REFUSALS' WORDS are labels (desktop.files.*, through `o.txt`, the knobs' reader), so the server words
  // and translates them; the words below are today's, and the fallback. The rules themselves stay here.
  const say = typeof o.txt === "function" ? o.txt : null;
  function txt(key, fallback, vars) {
    let v;
    try { v = say ? say(key, fallback, vars) : undefined; } catch { v = undefined; }
    return typeof v === "string" && v.trim() ? v : fill(fallback, vars);
  }

  const fold = (p) => (insensitive ? p.toLowerCase() : p);
  const real = (p) => (fs.realpathSync.native || fs.realpathSync)(p);
  function isInside(child, parent) {
    const c = fold(child), p = fold(parent);
    if (c === p) return true;
    const rel = path.relative(p, c);
    return !!rel && rel !== ".." && !rel.startsWith(".." + sep) && !path.isAbsolute(rel);
  }
  /** `p` below `parent` (already known to be inside it), as the part after it; "" for the folder itself. */
  const relTo = (parent, p) => (fold(p) === fold(parent) ? "" : p.slice(parent.length).replace(/^[\\/]+/, ""));
  const hiddenName = (n) => n.startsWith(".");
  const bundleName = (n) => BUNDLE_EXT.some((b) => n.toLowerCase().endsWith(b));
  const badName = (n) => hiddenName(n) || bundleName(n);

  let realHome = home;
  try { realHome = real(home); } catch { /* a home that cannot be read protects itself below */ }
  const realData = (() => { try { return userData ? real(userData) : ""; } catch { return userData; } })();
  const protect = (Array.isArray(o.protect) ? o.protect : []).filter((p) => p && typeof p === "string").map((p) => { try { return real(p); } catch { return ""; } }).filter(Boolean);
  /**
   * This app's own files: `p` is inside one, or is a folder that holds one. An allowed folder that itself
   * holds the app (a program run from Downloads) is not shut: only the app's own path is.
   */
  function isApp(p, rs) {
    return protect.some((x) => {
      if (rs.some((r) => isInside(r.path, x))) return fold(p) === fold(x);
      return isInside(p, x) || (isInside(x, p) && !rs.some((r) => fold(r.path) === fold(p)));
    });
  }

  // ---- the allowed folders ----

  /** Why a folder may not be one of the allowed ones, or "" when it may. `p` is already resolved. */
  function rootProblem(p, usual) {
    if (!p || !path.isAbsolute(p)) return txt("desktop.files.notOnComputer", "That isn't a folder on this computer.");
    if (path.parse(p).root === p) return txt("desktop.files.wholeDisk", "That's a whole disk.");
    if (fold(p) === fold(realHome) || isInside(realHome, p)) return txt("desktop.files.wholeHome", "That's your whole home folder, which holds system and hidden folders.");
    const segs = p.split(sep).filter(Boolean);
    if (segs.some(badName)) return txt("desktop.files.hiddenFolder", "That's a hidden or app folder.");
    if (realData && (isInside(p, realData) || isInside(realData, p))) return txt("desktop.files.ownFolder", "That's Tailzu's own folder.");
    const inHome = isInside(p, realHome);
    if (inHome) {
      const parts = path.relative(realHome, p).split(sep).map((x) => x.toLowerCase());
      if (parts[0] === "applications" || parts[0] === "appdata") return txt("desktop.files.appFolder", "That's a system or app folder.");
      // The usual three are the system's own Downloads, Desktop and Documents, wherever it keeps them: with
      // iCloud Drive or a cloud folder on, a Mac keeps them under Library/Mobile Documents or Library/CloudStorage.
      // Nothing else under Library is ever one, the usual three included.
      if (parts[0] === "library" && !(usual && (parts[1] === "mobile documents" || parts[1] === "cloudstorage"))) return txt("desktop.files.appFolder", "That's a system or app folder.");
      return "";
    }
    const first = (platform === "win32" ? segs.slice(1) : segs)[0];
    const list = platform === "win32" ? WIN_SYSTEM : POSIX_SYSTEM;
    if (first && list.includes(first.toLowerCase())) return txt("desktop.files.systemFolder", "That's a system folder.");
    return "";
  }

  /** The allowed folders now: [{ label, path }], resolved, deduplicated and checked again each time they are asked for. */
  function roots() {
    let list = null;
    try { list = chosen(); } catch { list = null; }
    // Nothing chosen (null) is the usual three; a list the person made, even an empty one, is theirs.
    const asked = Array.isArray(list) ? list.filter((p) => typeof p === "string") : ["Downloads", "Desktop", "Documents"].map((n) => path.join(home, n));
    const out = [];
    const labels = new Set();
    for (const p of asked) {
      let r;
      try { r = real(p); if (!fs.statSync(r).isDirectory()) continue; } catch { continue; }
      if (rootProblem(r, !Array.isArray(list))) continue;
      if (out.some((x) => fold(x.path) === fold(r))) continue;
      let label = path.basename(r), n = 2;
      while (labels.has(fold(label))) label = `${path.basename(r)} ${n++}`;
      labels.add(fold(label));
      out.push({ label, path: r });
    }
    return out;
  }

  /** A folder offered for the allowed list: { ok, path } resolved, or { ok: false, why }. */
  function checkRoot(p) {
    let r;
    try { r = real(str(p)); if (!fs.statSync(r).isDirectory()) return { ok: false, why: txt("desktop.files.notFolder", "That isn't a folder.") }; } catch { return { ok: false, why: txt("desktop.files.cantOpen", "I can't open that folder.") }; }
    const why = rootProblem(r);
    return why ? { ok: false, why } : { ok: true, path: r };
  }

  // ---- the path guard ----

  /**
   * A path the planner or the undo log named, as { ok, real, root, rel, exists } or { ok: false, why }.
   * Written "Downloads/Invoices/a.pdf" (an allowed folder's name first) or, from the undo log, absolute.
   * Resolved through the system's realpath, so what is checked is where it really is.
   */
  function guard(input, roots_, internal) {
    const rs = roots_ || roots();
    const text = str(input).trim();
    if (!text || text.length > 600 || CONTROL.test(text)) return { ok: false, why: txt("desktop.files.badPath", "That isn't a usable path.") };
    if (!rs.length) return { ok: false, why: txt("desktop.files.noFolders", "No folder is allowed for Ask. Add one in Settings.") };
    // What the planner names starts with an allowed folder's name. A full path (a drive, a \\server share, a
    // leading slash) is only ever this module's own: the undo log's, or a step it made itself (`internal`).
    // Refused before anything is looked up, so a share the planner names is never even contacted.
    const full = path.isAbsolute(text) || /^(?:[\\/]{2}|[A-Za-z]:|[\\/])/.test(text);
    if (full && !internal) return { ok: false, why: txt("desktop.files.startWithFolder", "A path starts with the name of a folder Ask may use.") };
    const segs = text.replace(/\\/g, "/").split("/").filter((s) => s !== "" && s !== ".");
    if (segs.includes("..")) return { ok: false, why: txt("desktop.files.goesUp", "That path goes up out of its folder.") };
    // "... " and "..." are ".." to a system that drops trailing dots and spaces; on Windows so is any name that ends so, and
    // ":" starts a hidden stream.
    if (!internal && segs.some((x) => /^[. ]+$/.test(x) || (platform === "win32" && (/[<>:"|?*]/.test(x) || /[. ]$/.test(x))))) return { ok: false, why: txt("desktop.files.badPath", "That isn't a usable path.") };
    let candidate;
    if (path.isAbsolute(text)) {
      candidate = path.normalize(text);
    } else {
      const root = rs.find((r) => fold(r.label) === fold(segs[0] || ""));
      if (!root) return { ok: false, why: txt("desktop.files.notAllowed", "{name} isn't one of the folders Ask may use.", { name: clip(segs[0] || text, 40) }) };
      candidate = path.join(root.path, ...segs.slice(1));
    }
    // The folder it is in is resolved through the system (links in the way lead where they lead, and are
    // then checked); the last step is not followed: a link there stays a link, and is refused by whoever
    // would act on it. What does not exist yet (a new folder, a new name) is checked by where it would go.
    let at = path.dirname(candidate);
    const rest = [];
    for (;;) {
      try { at = real(at); break; } catch (e) {
        if (!e || e.code !== "ENOENT" || path.dirname(at) === at) return { ok: false, why: txt("desktop.files.cantReach", "I can't reach that.") };
        rest.unshift(path.basename(at));
        at = path.dirname(at);
      }
    }
    const base = path.basename(candidate);
    const resolved = path.join(at, ...rest, base);
    const root = rs.find((r) => isInside(resolved, r.path));
    if (!root) return { ok: false, why: txt("desktop.files.outside", "That's outside the folders Ask may use.") };
    const rel = relTo(root.path, resolved);
    if (rel && rel.split(sep).some(badName)) return { ok: false, why: txt("desktop.files.intoHidden", "Ask doesn't go into hidden or app folders.") };
    if (isApp(resolved, rs)) return { ok: false, why: txt("desktop.files.tailzuItself", "That's part of Tailzu itself.") };
    if (rest.some((x) => CONTROL.test(x)) || CONTROL.test(base)) return { ok: false, why: txt("desktop.files.badPath", "That isn't a usable path.") };
    const st = lstat(resolved);
    return { ok: true, real: resolved, root, rel: rel.split(sep).join("/"), exists: !!st, link: !!st && st.isSymbolicLink() };
  }

  const shown = (g) => (g.rel ? `${g.root.label}/${g.rel}` : g.root.label);
  const shownReal = (p, rs) => {
    const root = (rs || roots()).find((r) => isInside(p, r.path));
    if (!root) return path.basename(p);
    const rel = relTo(root.path, p).split(sep).join("/");
    return rel ? `${root.label}/${rel}` : root.label;
  };

  function lstat(p) { try { return fs.lstatSync(p); } catch { return null; } }

  /** A name beside the others in `dir` that is not taken: "a.pdf", "a (2).pdf", "a (3).pdf". `taken` holds the names a plan already gave out. */
  function freeName(dir, name, taken) {
    const i = name.lastIndexOf(".");
    const stem = i > 0 ? name.slice(0, i) : name, ext = i > 0 ? name.slice(i) : "";
    for (let n = 1; n <= SUFFIX_TRIES; n++) {
      const cand = n === 1 ? name : `${stem} (${n})${ext}`;
      const key = fold(path.join(dir, cand));
      if (taken && taken.has(key)) continue;
      if (lstat(path.join(dir, cand))) continue;
      if (taken) taken.add(key);
      return cand;
    }
    throw refuse("no free name");
  }

  // ---- looking: walk, filter, describe ----

  function describe(g, st, rs) {
    const dir = st.isDirectory();
    const name = path.basename(g);
    // A file's name is the person's, but it goes to the planner as text: no line breaks to start a line of its own.
    return {
      real: g, name, dir, size: dir ? 0 : st.size, mtime: st.mtimeMs,
      kind: dir ? "folder" : kindOf(name), show: tidy(shownReal(g, rs)).replace(/\s+/g, " "),
    };
  }
  const line = (e) => `${e.show}${e.dir ? "/" : ""} | ${e.kind} | ${e.dir ? "-" : sizeText(e.size)} | ${dayText(e.mtime)}`;

  /** The test a find's arguments make. Dates are the person's own days. */
  function filterOf(args) {
    const words = args.name ? wordsIn(args.name) : [];
    const since = args.since ? new Date(`${args.since}T00:00:00`).getTime() : null;
    const until = args.until ? new Date(`${args.until}T23:59:59.999`).getTime() : null;
    const min = typeof args.min_mb === "number" ? args.min_mb * 1048576 : null;
    const max = typeof args.max_mb === "number" ? args.max_mb * 1048576 : null;
    const kind = args.kind && KINDS.has(str(args.kind)) ? str(args.kind) : "";
    return (e) => {
      if (kind && e.kind !== kind) return false;
      if (since !== null && e.mtime < since) return false;
      if (until !== null && e.mtime > until) return false;
      if (min !== null && e.size < min) return false;
      if (max !== null && e.size > max) return false;
      if (words.length) {
        const have = wordsIn(e.name).join(" ");
        if (!words.every((w) => have.includes(w))) return false;
      }
      return true;
    };
  }
  const hasFilter = (a) => !!(a.name || a.kind || a.since || a.until || typeof a.min_mb === "number" || typeof a.max_mb === "number");

  /** Files under the given folders, newest first: no hidden or app folders, no links, bounded in depth and in how much is looked at. */
  function files(from, rs, keep, cap) {
    const hits = [];
    let visited = 0, truncated = false;
    const stack = from.map((g) => ({ dir: g.real, depth: 0 }));
    while (stack.length) {
      const { dir, depth } = stack.pop();
      let names;
      try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const d of names) {
        if (badName(d.name)) continue;
        if (d.isSymbolicLink && d.isSymbolicLink()) continue;
        if (++visited > WALK_VISITED) { truncated = true; break; }
        const p = path.join(dir, d.name);
        if (protect.length && isApp(p, rs)) continue;
        if (d.isDirectory()) { if (depth + 1 < WALK_DEPTH) stack.push({ dir: p, depth: depth + 1 }); continue; }
        if (!d.isFile()) continue;
        let st;
        try { st = fs.lstatSync(p); } catch { continue; }
        const e = describe(p, st, rs);
        if (keep(e)) hits.push(e);
      }
      if (truncated) break;
    }
    hits.sort((a, b) => b.mtime - a.mtime || a.show.localeCompare(b.show));
    if (hits.length > cap) { truncated = true; hits.length = cap; }
    return { hits, truncated };
  }

  /** The folders a `folder` argument names, else every allowed one. */
  function scope(args, rs) {
    if (!args.folder) return { from: rs.map((r) => ({ real: r.path })) };
    const g = guard(args.folder, rs);
    if (!g.ok) return { why: g.why };
    const st = g.exists ? lstat(g.real) : null;
    if (!st || !st.isDirectory()) return { why: txt("desktop.files.cantSeeFolder", "{name} isn't a folder I can see.", { name: clip(str(args.folder), 40) }) };
    return { from: [g] };
  }

  /** Several files, for a change: named in `paths`, or picked by the find filters. { items, more } or { why }. */
  function selection(args, rs, { dirs }) {
    if (Array.isArray(args.paths) && args.paths.length) {
      const items = [];
      const seen = new Set();
      for (const p of args.paths) {
        const g = guard(p, rs);
        if (!g.ok) return { why: g.why };
        if (!g.exists) return { why: txt("desktop.files.notThere", "{name} isn't there.", { name: clip(str(p), 60) }) };
        if (!g.rel) return { why: txt("desktop.files.wholeAllowed", "Ask doesn't move or remove a whole allowed folder.") };
        const st = lstat(g.real);
        if (!st || st.isSymbolicLink()) return { why: txt("desktop.files.isLink", "{name} is a link, so I leave it.", { name: clip(path.basename(g.real), 60) }) };
        if (st.isDirectory() && !dirs) return { why: txt("desktop.files.isFolder", "{name} is a folder; I only do this to files.", { name: clip(path.basename(g.real), 60) }) };
        if (!st.isDirectory() && !st.isFile()) return { why: txt("desktop.files.notRegular", "{name} isn't a regular file.", { name: clip(path.basename(g.real), 60) }) };
        if (seen.has(fold(g.real))) continue;
        seen.add(fold(g.real));
        items.push(describe(g.real, st, rs));
      }
      return { items: items.slice(0, MAX_FILES), more: Math.max(0, items.length - MAX_FILES) };
    }
    if (!hasFilter(args)) return { why: txt("desktop.files.whichFiles", "Tell me which files: a word in the name, a kind, a date or a size.") };
    const sc = scope(args, rs);
    if (sc.why) return { why: sc.why };
    const found = files(sc.from, rs, filterOf(args), MAX_FILES + 1);
    return { items: found.hits.slice(0, MAX_FILES), more: found.hits.length > MAX_FILES || found.truncated ? 1 : 0, moreUnknown: true };
  }

  // ---- the undo log ----

  const logPath = userData ? path.join(userData, "local-files-undo.json") : "";
  let memory = { batches: [] };
  function loadLog() {
    if (!logPath) return memory;
    try {
      const j = JSON.parse(fs.readFileSync(logPath, "utf8"));
      return j && Array.isArray(j.batches) ? { batches: j.batches.filter((b) => b && Array.isArray(b.ops)) } : { batches: [] };
    } catch { return { batches: [] }; }
  }
  function saveLog(l) {
    memory = l;
    if (!logPath) return;
    try {
      l.batches = l.batches.slice(-UNDO_BATCHES);
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      const tmp = `${logPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(l));
      fs.renameSync(tmp, logPath);
    } catch { /* an undo log that cannot be kept must not stop the change that is already done */ }
  }

  // ---- doing: the one place a file changes ----

  /** Move one thing without overwriting. A rename; across disks, a copy and then the removal. */
  function relocate(from, to) {
    if (lstat(to)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
    try { fs.renameSync(from, to); } catch (e) {
      if (!e || e.code !== "EXDEV") throw e;
      const st = lstat(from);
      if (!st || !st.isFile()) throw e;
      fs.copyFileSync(from, to, nodeFs.constants.COPYFILE_EXCL);
      // The original goes only once the whole copy is there: a short one (disk full, unplugged) is cleared away instead.
      let whole = false;
      try { whole = fs.statSync(to).size === st.size; } catch { whole = false; }
      if (!whole) {
        try { fs.unlinkSync(to); } catch { /* it was ours, and it is not complete */ }
        throw Object.assign(new Error("short copy"), { code: "ENOSPC" });
      }
      try { fs.utimesSync(to, st.atime, st.mtime); } catch { /* the date is a nicety */ }
      fs.unlinkSync(from);
    }
  }

  /** Runs `steps` ([{ op, from, to, label }]) as one change, logging each as it is done. Returns { ok, text, note, done, failed }. */
  async function perform(tool, steps, verb) {
    const log = loadLog();
    const batch = { id: `${now()}-${Math.random().toString(36).slice(2, 8)}`, at: now(), tool, ops: [] };
    log.batches.push(batch);
    const failed = [];
    let moved = 0, logged = 0;
    try {
      for (const s of steps) {
        try {
          // Checked again now: the folder may have been taken out of the list, or a link put in the way, since it was planned.
          const rs = roots();
          if (s.op === "mkdir") {
            const g = guard(s.to, rs, true);
            if (!g.ok) throw refuse(g.why);
            if (!lstat(g.real)) { fs.mkdirSync(g.real); batch.ops.push({ op: "mkdir", to: g.real }); }
            continue;
          }
          const src = guard(s.from, rs, true);
          if (!src.ok) throw refuse(src.why);
          const st = lstat(src.real);
          if (!st) throw Object.assign(new Error("gone"), { code: "ENOENT" });
          if (st.isSymbolicLink()) throw refuse("a link");
          if (s.op === "trash") {
            await shell.trashItem(src.real);
            batch.ops.push({ op: "trash", from: src.real });
            moved++;
            continue;
          }
          const dst = guard(s.to, rs, true);
          if (!dst.ok) throw refuse(dst.why);
          if (!lstat(path.dirname(dst.real))) throw Object.assign(new Error("gone"), { code: "ENOENT" });
          if (s.op === "copy") {
            if (!st.isFile()) throw refuse("only files are copied");
            fs.copyFileSync(src.real, dst.real, nodeFs.constants.COPYFILE_EXCL);
            batch.ops.push({ op: "copy", from: src.real, to: dst.real });
          } else {
            if (st.isDirectory() && isInside(dst.real, src.real)) throw refuse("a folder can't go inside itself");
            relocate(src.real, dst.real);
            batch.ops.push({ op: s.op, from: src.real, to: dst.real });
          }
          moved++;
        } catch (e) {
          failed.push(`${clip(tidy(s.label || "a file"), 50)} (${whyFailed(e)})`);
        }
        // On disk after every step, not in batches: if the app is closed halfway, what got done can still be undone.
        if (batch.ops.length !== logged) { logged = batch.ops.length; saveLog(log); }
      }
    } finally {
      if (!batch.ops.length) log.batches = log.batches.filter((b) => b !== batch);
      saveLog(log);
    }
    const note = `${verb(moved)}${failed.length ? `; ${failed.length} didn’t go through` : ""}`;
    const text = [note + ".", ...(failed.length ? ["Could not: " + failed.slice(0, 8).join(", ") + (failed.length > 8 ? `, and ${failed.length - 8} more` : "")] : [])]
      .join(" ");
    return { ok: moved > 0 || (!steps.length && !failed.length), text: clip(text, RESULT_CHARS), note: clip(note, 200), done: moved, failed: failed.length };
  }

  // ---- the tools ----

  const bad = (error) => ({ ok: false, error });

  function planFind(args) {
    const rs = roots();
    if (!rs.length) return bad("No folder is allowed for Ask. Add one in Settings.");
    const sc = scope(args, rs);
    if (sc.why) return bad(sc.why);
    const limit = Math.min(FIND_MAX, Math.max(1, Math.round(Number(args.limit)) || FIND_DEFAULT));
    return {
      ok: true, risk: "read", count: 0, lines: [],
      run: async () => {
        const found = files(sc.from, rs, filterOf(args), limit + 1);
        const more = found.hits.length > limit || found.truncated;
        const hits = found.hits.slice(0, limit);
        const head = hits.length ? `${plural(hits.length, "file", "files")} found${more ? " (more match; narrow it down)" : ""}:` : "No files found.";
        const text = clip([head, ...hits.map(line)].join("\n"), RESULT_CHARS);
        return { ok: true, text, note: hits.length ? plural(hits.length, "file", "files") + " found" : "no files found", done: hits.length, failed: 0 };
      },
    };
  }

  function planList(args) {
    const rs = roots();
    if (!rs.length) return bad("No folder is allowed for Ask. Add one in Settings.");
    if (!args.folder) {
      return {
        ok: true, risk: "read", count: 0, lines: [],
        run: async () => ({ ok: true, text: "Folders Ask may use:\n" + rs.map((r) => r.label).join("\n"), note: plural(rs.length, "folder", "folders"), done: rs.length, failed: 0 }),
      };
    }
    const g = guard(args.folder, rs);
    if (!g.ok) return bad(g.why);
    const st = g.exists ? lstat(g.real) : null;
    if (!st || !st.isDirectory()) return bad(`${clip(str(args.folder), 40)} isn't a folder I can see.`);
    const limit = Math.min(FIND_MAX, Math.max(1, Math.round(Number(args.limit)) || FIND_DEFAULT));
    return {
      ok: true, risk: "read", count: 0, lines: [],
      run: async () => {
        let names = [];
        try { names = fs.readdirSync(g.real, { withFileTypes: true }); } catch (e) { return { ok: false, text: `I couldn't read it (${whyFailed(e)}).`, note: "couldn’t read the folder", done: 0, failed: 1 }; }
        const items = [];
        for (const d of names) {
          if (badName(d.name) || (d.isSymbolicLink && d.isSymbolicLink())) continue;
          const st2 = lstat(path.join(g.real, d.name));
          if (st2 && (st2.isFile() || st2.isDirectory())) items.push(describe(path.join(g.real, d.name), st2, rs));
        }
        items.sort((a, b) => Number(b.dir) - Number(a.dir) || b.mtime - a.mtime);
        const shownItems = items.slice(0, limit);
        const text = clip([`${shown(g)}: ${plural(items.length, "item", "items")}${items.length > limit ? `, newest ${limit}` : ""}`, ...shownItems.map(line)].join("\n"), RESULT_CHARS);
        return { ok: true, text, note: plural(items.length, "item", "items"), done: items.length, failed: 0 };
      },
    };
  }

  function planOpen(args, reveal) {
    const g = guard(args.path);
    if (!g.ok) return bad(g.why);
    const st = g.exists ? lstat(g.real) : null;
    if (!st) return bad(`${clip(str(args.path), 60)} isn't there.`);
    if (st.isSymbolicLink()) return bad("That's a link, so I leave it.");
    // Programs and scripts are never opened from here: by name, by bundle, or, off Windows, a file with the execute bit and no type we know.
    const program = RUNS_CODE.has(extOf(g.real)) || bundleName(g.real) || (platform !== "win32" && st.isFile() && (st.mode & 0o111) !== 0 && kindOf(path.basename(g.real)) === "other");
    if (!reveal && program) return bad("I don't open programs or scripts. Open it yourself if you meant to.");
    return {
      ok: true, risk: "read", count: 0, lines: [],
      run: async () => {
        // Looked at again at the moment it is opened.
        const again = guard(args.path);
        if (!again.ok || again.real !== g.real) return { ok: false, text: "It moved, so I didn’t open it.", note: "it moved", done: 0, failed: 1 };
        if (reveal) { shell.showItemInFolder(g.real); return { ok: true, text: `Showing ${shown(g)}.`, note: "shown", done: 1, failed: 0 }; }
        const err = await shell.openPath(g.real);
        return err ? { ok: false, text: "It wouldn’t open.", note: "wouldn’t open", done: 0, failed: 1 } : { ok: true, text: `Opened ${shown(g)}.`, note: "opened", done: 1, failed: 0 };
      },
    };
  }

  const cardLines = (rows) => {
    const out = rows.slice(0, CARD_LINES);
    return { lines: out, more: Math.max(0, rows.length - out.length) };
  };

  function planOrganise(args) {
    const rs = roots();
    const g = guard(args.folder, rs);
    if (!g.ok) return bad(g.why);
    const st = g.exists ? lstat(g.real) : null;
    if (!st || !st.isDirectory()) return bad(`${clip(str(args.folder), 40)} isn't a folder I can see.`);
    const by = args.by === "month" ? "month" : args.by === "type" ? "type" : "";
    if (!by) return bad("Sort by type or by month.");
    let entries = [];
    try { entries = fs.readdirSync(g.real, { withFileTypes: true }); } catch { return bad("I can't read that folder."); }
    const loose = [];
    for (const d of entries) {
      if (badName(d.name) || !d.isFile() || (d.isSymbolicLink && d.isSymbolicLink())) continue;
      const st2 = lstat(path.join(g.real, d.name));
      if (st2 && st2.isFile()) loose.push(describe(path.join(g.real, d.name), st2, rs));
    }
    if (!loose.length) return bad("There are no loose files to sort in there.");
    loose.sort((a, b) => a.name.localeCompare(b.name));
    const take = loose.slice(0, MAX_FILES);
    const taken = new Set();
    const made = new Map();
    const steps = [];
    const rows = [];
    for (const f of take) {
      const folder = by === "type" ? KIND_FOLDER[f.kind] || "Other" : monthText(f.mtime);
      const destDir = path.join(g.real, folder);
      if (!made.has(folder)) {
        made.set(folder, true);
        const at = lstat(destDir);
        if (at && !at.isDirectory()) return bad(`There's a file called ${folder} in the way.`);
        if (!at) steps.push({ op: "mkdir", to: destDir, label: folder });
      }
      const name = freeName(destDir, f.name, taken);
      steps.push({ op: "move", from: f.real, to: path.join(destDir, name), label: f.name });
      rows.push(`${f.name} → ${folder}/${name === f.name ? "" : name}`);
    }
    const { lines, more } = cardLines(rows);
    return {
      ok: true, risk: "write", count: take.length, say: { key: "organise", vars: { n: take.length, m: made.size, to: shown(g) } },
      lines, more, extra: loose.length > take.length ? `${loose.length - take.length} more files are left for next time.` : "",
      run: () => perform("organise_folder", steps, (n) => `Moved ${plural(n, "file", "files")} into ${plural(made.size, "folder", "folders")} in ${shown(g)}`),
    };
  }

  function planTransfer(args, copy) {
    const rs = roots();
    if (!args.to) return bad("Which folder should they go to?");
    const sel = selection(args, rs, { dirs: !copy });
    if (sel.why) return bad(sel.why);
    if (!sel.items.length) return bad("I didn't find any files like that.");
    const to = guard(args.to, rs);
    if (!to.ok) return bad(to.why);
    if (to.exists) { const t = lstat(to.real); if (!t || !t.isDirectory()) return bad(`${clip(str(args.to), 40)} is a file, not a folder.`); }
    const taken = new Set();
    const steps = [];
    const rows = [];
    if (!to.exists) steps.push(...newFolders(to));
    for (const f of sel.items) {
      if (fold(path.dirname(f.real)) === fold(to.real)) continue;
      if (f.dir && isInside(to.real, f.real)) return bad("A folder can't go inside itself.");
      const name = freeName(to.real, f.name, taken);
      steps.push({ op: copy ? "copy" : "move", from: f.real, to: path.join(to.real, name), label: f.name });
      rows.push(`${f.show} → ${shown(to)}/${name === f.name ? "" : name}`);
    }
    if (!rows.length) return bad("They're already there.");
    const { lines, more } = cardLines(rows);
    return {
      ok: true, risk: "write", count: rows.length, say: { key: copy ? "copy" : "move", vars: { n: rows.length, to: shown(to) } }, lines, more,
      extra: sel.more ? "More files match than one change takes; the rest are left for next time." : "",
      run: () => perform(copy ? "copy_files" : "move_files", steps, (n) => `${copy ? "Copied" : "Moved"} ${plural(n, "file", "files")} to ${shown(to)}`),
    };
  }

  /** mkdir steps for each level of a folder that does not exist yet. */
  function newFolders(g) {
    const out = [];
    let at = g.real;
    while (!lstat(at) && path.dirname(at) !== at && isInside(path.dirname(at), g.root.path)) { out.unshift({ op: "mkdir", to: at, label: path.basename(at) }); at = path.dirname(at); }
    return out;
  }

  function planRename(args) {
    const rs = roots();
    const g = guard(args.path, rs);
    if (!g.ok) return bad(g.why);
    const st = g.exists ? lstat(g.real) : null;
    if (!st) return bad(`${clip(str(args.path), 60)} isn't there.`);
    if (st.isSymbolicLink()) return bad("That's a link, so I leave it.");
    if (!g.rel) return bad("Ask doesn't rename a whole allowed folder.");
    const name = str(args.new_name).trim();
    if (!name || name.length > 200 || CONTROL.test(name) || /[\\/:*?"<>|]/.test(name) || name === "." || name === "..") return bad("That isn't a usable name.");
    if (badName(name)) return bad("Ask doesn't make hidden or app names.");
    const dir = path.dirname(g.real);
    if (name === path.basename(g.real)) return bad("It's already called that.");
    let final = name;
    const there = lstat(path.join(dir, name));
    // On a disk that ignores case, "a.pdf" to "A.pdf" is the same file, not a clash.
    const same = there && insensitive && fold(name) === fold(path.basename(g.real));
    if (there && !same) final = freeName(dir, name);
    return {
      ok: true, risk: "write", count: 1, say: { key: "rename", vars: { from: path.basename(g.real), to: final } }, lines: [], more: 0,
      run: () => perform("rename_file", [{ op: "rename", from: g.real, to: path.join(dir, final), label: path.basename(g.real) }], () => `Renamed ${path.basename(g.real)} to ${final}`),
    };
  }

  function planMakeFolder(args) {
    const g = guard(args.path);
    if (!g.ok) return bad(g.why);
    if (!g.rel) return bad("That folder is already one of Ask's.");
    if (g.exists) return bad("There's already something called that.");
    const steps = newFolders(g);
    if (!steps.length) return bad("I can't make that folder.");
    return {
      ok: true, risk: "write", count: steps.length, say: { key: "makeFolder", vars: { to: shown(g) } }, lines: [], more: 0,
      run: () => perform("make_folder", steps, () => `Made the folder ${shown(g)}`),
    };
  }

  function planTrash(args) {
    const rs = roots();
    const sel = selection(args, rs, { dirs: true });
    if (sel.why) return bad(sel.why);
    if (!sel.items.length) return bad("I didn't find any files like that.");
    const rows = sel.items.map((f) => `${f.show}${f.dir ? "/" : ""} (${f.dir ? "folder" : sizeText(f.size)})`);
    const { lines, more } = cardLines(rows);
    return {
      ok: true, risk: "destructive", count: sel.items.length, say: { key: "trash", vars: { n: sel.items.length } }, lines, more,
      extra: sel.more ? "More files match than one change takes; the rest are left for next time." : "",
      run: () => perform("trash_files", sel.items.map((f) => ({ op: "trash", from: f.real, label: f.name })), (n) => `Moved ${plural(n, "item", "items")} to the Trash`),
    };
  }

  function planUndo() {
    const log = loadLog();
    const batch = log.batches[log.batches.length - 1];
    if (!batch) return bad("There's nothing to undo.");
    const doable = batch.ops.filter((op) => op.op !== "trash");
    if (!doable.length) {
      // Said once, then the batch is let go, or "undo" would only ever say this.
      log.batches.pop();
      saveLog(log);
      return bad("Those went to the Trash, so I can't put them back myself. Open the Trash and drag them out.");
    }
    const rs = roots();
    const rows = [...doable].reverse().filter((op) => op.op !== "mkdir").map((op) => {
      const from = shownReal(op.to, rs), back = op.from ? shownReal(path.dirname(op.from), rs) : "";
      return op.op === "copy" ? `${from} → Trash` : `${from} → ${back}/`;
    });
    const count = doable.filter((op) => op.op !== "mkdir").length;
    const { lines, more } = cardLines(rows);
    // Undoing a copy sends the copy to the Trash, and the Trash always asks: so does this, whatever was said yes to before.
    return {
      ok: true, risk: doable.some((op) => op.op === "copy") ? "destructive" : "write", count, say: { key: "undo", vars: { n: count } }, lines, more,
      run: async () => undoBatch(),
    };
  }

  /** Puts the last change back, newest step first; what cannot be put back stays in the log. */
  async function undoBatch() {
    const log = loadLog();
    const batch = log.batches[log.batches.length - 1];
    if (!batch) return { ok: false, text: "There's nothing to undo.", note: "nothing to undo", done: 0, failed: 0 };
    const left = [];
    const problems = [];
    let back = 0;
    for (const op of [...batch.ops].reverse()) {
      try {
        const rs = roots();
        if (op.op === "trash") { left.unshift(op); continue; }
        if (op.op === "mkdir") {
          const g = guard(op.to, rs, true);
          if (g.ok && g.exists && !fs.readdirSync(g.real).length) fs.rmdirSync(g.real);
          else if (g.ok && g.exists) { problems.push(`${clip(tidy(path.basename(op.to)), 40)} (not empty)`); }
          continue;
        }
        const here = guard(op.to, rs, true);
        if (!here.ok) throw refuse(here.why);
        const st = lstat(here.real);
        if (!st) throw Object.assign(new Error("gone"), { code: "ENOENT" });
        if (st.isSymbolicLink()) throw refuse("a link");
        if (op.op === "copy") {
          await shell.trashItem(here.real);
          back++;
          continue;
        }
        const origin = guard(op.from, rs, true);
        if (!origin.ok) throw refuse(origin.why);
        const dir = path.dirname(origin.real);
        fs.mkdirSync(dir, { recursive: true });
        const name = freeName(dir, path.basename(origin.real));
        relocate(here.real, path.join(dir, name));
        back++;
      } catch (e) {
        left.unshift(op);
        problems.push(`${clip(tidy(path.basename(op.to || op.from || "a file")), 40)} (${whyFailed(e)})`);
      }
    }
    if (left.length) batch.ops = left; else log.batches.pop();
    saveLog(log);
    const note = `Put back ${plural(back, "file", "files")}${problems.length ? `; ${problems.length} couldn’t be` : ""}`;
    return { ok: back > 0 || !problems.length, text: clip(`${note}.${problems.length ? " Could not: " + problems.slice(0, 8).join(", ") : ""}`, RESULT_CHARS), note: clip(note, 200), done: back, failed: problems.length };
  }

  const TOOLS = {
    find_files: planFind, list_folder: planList, open_file: (a) => planOpen(a, false), reveal_file: (a) => planOpen(a, true),
    organise_folder: planOrganise, move_files: (a) => planTransfer(a, false), copy_files: (a) => planTransfer(a, true),
    rename_file: planRename, make_folder: planMakeFolder, undo_last: planUndo, trash_files: planTrash,
  };

  /**
   * A file's name is the person's, or whoever sent it to them: it can hold a line break, a mark that reorders the
   * text around it, or words written to be read as an instruction. Whatever goes to the card or back to the
   * planner is cleaned of the first two here, in one place, whichever tool made it; the planner is told the third
   * in its prompt, and a change that follows a look at names always asks (agent.js).
   */
  function tidied(p) {
    p.lines = (Array.isArray(p.lines) ? p.lines : []).map(tidy);
    if (p.extra) p.extra = tidy(p.extra);
    if (p.say && p.say.vars) p.say = { key: p.say.key, vars: Object.fromEntries(Object.entries(p.say.vars).map(([k, v]) => [k, typeof v === "string" ? tidy(v) : v])) };
    const run = p.run;
    p.run = async () => {
      const r = await run();
      return Object.assign({}, r, { text: tidyText(r && r.text), note: tidy(r && r.note) });
    };
    return p;
  }

  /** What a tool would do, without doing it: see the top of this file. Never throws. */
  async function plan(tool, args) {
    const name = str(tool);
    if (!Object.hasOwn(TOOLS, name)) return { ok: false, error: "I can't do that on this computer." };
    try {
      const p = TOOLS[name](args && typeof args === "object" && !Array.isArray(args) ? args : {});
      return p.ok ? tidied(Object.assign({ tool: name, more: 0, extra: "" }, p)) : p;
    } catch (e) {
      return { ok: false, error: e && e.refused ? e.message : "That didn’t work." };
    }
  }

  return { plan, roots, checkRoot, guard, rootProblem, undoBatch, riskOf: (tool) => (Object.hasOwn(RISK, str(tool)) ? RISK[str(tool)] : ""), kindOf };
}

// ---- the Settings row: "Folders Ask can use" (sdui.js DeskFolders) ---------------------

/**
 * The allowed folders, in the app window. The server draws the row (its words);
 * this is the main process's side: the list as it stands, and three buttons
 * (add a folder through the system's own chooser, take one out, back to the
 * usual three). A folder is added only if the guard accepts it (not a system,
 * app or hidden folder, not the home folder); the list is this computer's own
 * and never sent anywhere.
 *
 *   o.ipcMain, o.fromApp(e), o.dialog, o.window()   the app window, for the chooser
 *   o.files        createLocalFiles()
 *   o.localState, o.saveLocalState
 *   o.home         for showing "~/Downloads"
 *   o.send(state)  to the app window, as "ask-folders"
 */
function createFolderSettings(o) {
  const files = o.files;
  const home = o.home || "";
  let error = "";
  const call = (f, fallback) => { try { return f(); } catch { return fallback; } };
  const tilde = (p) => (home && (p === home || p.startsWith(home + nodePath.sep)) ? "~" + p.slice(home.length) : p);

  function state() {
    const custom = Array.isArray(o.localState.askFolders);
    return {
      custom,
      folders: files.roots().map((r) => ({ label: r.label, path: tilde(r.path) })),
      error,
    };
  }
  const push = () => call(() => o.send(state()));
  /** The folders as saved paths: the list in force now, to be changed. */
  const current = () => (Array.isArray(o.localState.askFolders) ? o.localState.askFolders.slice() : files.roots().map((r) => r.path));
  const save = (list) => { o.localState.askFolders = list; call(() => o.saveLocalState()); };

  async function act(p) {
    if (!p || typeof p !== "object") return false;
    error = "";
    if (p.kind === "reset") {
      delete o.localState.askFolders;
      call(() => o.saveLocalState());
      return true;
    }
    if (p.kind === "remove") {
      const roots = files.roots();
      const r = Number.isInteger(p.i) ? roots[p.i] : null;
      if (!r) return false;
      save(current().filter((x) => call(() => nodeFs.realpathSync(x), x) !== r.path));
      return true;
    }
    if (p.kind === "add") {
      let picked;
      try {
        picked = await o.dialog.showOpenDialog(call(() => o.window(), undefined), { properties: ["openDirectory"], buttonLabel: "Allow" });
      } catch { return false; }
      if (!picked || picked.canceled || !Array.isArray(picked.filePaths) || !picked.filePaths[0]) return false;
      const c = files.checkRoot(picked.filePaths[0]);
      if (!c.ok) { error = c.why; return true; }
      if (!files.roots().some((r) => r.path === c.path)) save(current().concat(c.path).slice(0, 12));
      return true;
    }
    return false;
  }

  o.ipcMain.handle("app:folders", (e) => (o.fromApp(e) ? state() : null));
  o.ipcMain.on("app:foldersAction", async (e, p) => {
    if (!o.fromApp(e)) return;
    if (await act(p)) push();
  });
  return { state, push, act };
}

/** The most dangerous of two tiers. */
const RANK = { "": 0, read: 1, write: 2, destructive: 3 };
const higher = (a, b) => ((RANK[a] || 0) >= (RANK[b] || 0) ? a : b);

module.exports = { createLocalFiles, createFolderSettings, higher, fill, EN_WORDS, RISK, MAX_FILES, KIND_FOLDER, kindOf, RUNS_CODE };
