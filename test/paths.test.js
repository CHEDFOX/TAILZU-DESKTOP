// Every path the app names, checked without starting Electron.
//
// The packaged app carries only what build.files in package.json matches. A
// module required from the main process but left out of that list runs fine
// from the checkout (`electron .`) and crashes every installer at launch with
// "Cannot find module", which is how 0.3.3 reached the Store and x0bot.com
// without frontApp.js. So this walks what the app loads at run time, from
// package.json's main through every require, loadFile, preload, page script,
// font and frame, and holds four things:
//
//   - every relative path in the source resolves to a file (requires, page
//     scripts and fonts, loadFile, __dirname joins, package.json's scripts,
//     the CI workflow's);
//   - everything the app loads is shipped (build.files, or extraResources);
//   - everything shipped from src/ is loaded by something, and no test,
//     fixture or test kit is shipped;
//   - the docs (README.md, RELEASE.md, archi.md) name only paths that exist.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const pkg = require("../package.json");
const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join("/");
const read = (abs) => fs.readFileSync(abs, "utf8");
const isFile = (abs) => fs.existsSync(abs) && fs.statSync(abs).isFile();

/** Every file in the checkout that is ours (no .git, node_modules or build output). */
function repoFiles() {
  const out = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      if (name === ".git" || name === "node_modules" || name === "dist") continue;
      const abs = path.join(dir, name);
      if (fs.statSync(abs).isDirectory()) walk(abs);
      else out.push(abs);
    }
  })(ROOT);
  return out;
}

/** electron-builder's file patterns, as far as this package uses them: the last pattern that matches decides. */
function globRe(pattern) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      const slash = pattern[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "/" && pattern.slice(i + 1) === "**") { re += "(?:/.*)?"; break; }
    else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}
const patterns = pkg.build.files.map((p) => ({ not: p.startsWith("!"), re: globRe(p.replace(/^!/, "")) }));
const extra = [...(pkg.build.mac.extraResources || []), ...(pkg.build.win.extraResources || [])].map((r) => r.from);
function shipped(file) {
  let on = false;
  for (const p of patterns) if (p.re.test(file)) on = !p.not;
  return on || extra.includes(file);
}

/** A require() target, the way Node finds it. */
function resolveModule(fromDir, spec) {
  const base = path.resolve(fromDir, spec);
  for (const c of [base, base + ".js", base + ".json", path.join(base, "index.js")]) if (isFile(c)) return c;
  return null;
}

// Things named in the source that are made later: the helpers CI builds into
// build/, the per-user state a dev run writes at the root, and the paths tests
// use on purpose to name a helper that is not there.
const MADE_LATER = /^(build\/(audiotap|tzocr|tzax|tzkey|no-such-helper)|config\.json|session\.json|shell\.json|src\/agent\/driver\/fixtures\/no-such-binary)$/;

const REQUIRE = /require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;
const LOAD_FILE = /\.loadFile\(\s*["']([^"']+)["']\s*\)/g;
const DIRNAME_JOIN = /path\.join\(\s*__dirname((?:\s*,\s*["'][^"'\n]*["'])+)\s*\)/g;
const SCRIPT_SRC = /<script[^>]*\ssrc=["']([^"']+)["']/g;
const CSS_URL = /url\(\s*["']?([^)"']+)["']?\s*\)/g;
const PAGE_NAME = /["']([\w-]+\.html)(?:[?#][^"']*)?["']/g;

function joinArgs(list) { return [...list.matchAll(/["']([^"']*)["']/g)].map((m) => m[1]); }

/** Every path a source file names: [{ kind, from, target (absolute), label }]. */
function pathsIn(abs) {
  const src = read(abs), dir = path.dirname(abs), out = [];
  if (abs.endsWith(".js")) {
    for (const m of src.matchAll(REQUIRE)) out.push({ kind: "require", target: resolveModule(dir, m[1]) || path.resolve(dir, m[1]), label: m[1] });
    for (const m of src.matchAll(LOAD_FILE)) out.push({ kind: "loadFile", target: path.resolve(ROOT, m[1]), label: m[1] });
    for (const m of src.matchAll(DIRNAME_JOIN)) out.push({ kind: "join", target: path.resolve(dir, ...joinArgs(m[1])), label: joinArgs(m[1]).join("/") });
  }
  if (abs.endsWith(".html")) {
    for (const m of src.matchAll(SCRIPT_SRC)) if (!/^(https?:|data:)/.test(m[1])) out.push({ kind: "script", target: path.resolve(dir, m[1]), label: m[1] });
    for (const m of src.matchAll(CSS_URL)) if (!/^(https?:|data:|#)/.test(m[1])) out.push({ kind: "url", target: path.resolve(dir, m[1]), label: m[1] });
  }
  return out.map((p) => Object.assign(p, { from: abs }));
}

const SKIP = new Set([__filename, path.join(ROOT, "botTiles.js"), path.join(ROOT, "botLooks.js")]);
const sources = repoFiles().filter((f) => /\.(js|html)$/.test(f) && !SKIP.has(f));

test("every relative path in the source resolves", () => {
  const missing = [];
  for (const f of sources) {
    for (const p of pathsIn(f)) {
      if (isFile(p.target) || MADE_LATER.test(rel(p.target))) continue;
      if (p.kind === "join" && fs.existsSync(p.target)) continue;   // a folder (TAILZU-FRONTEND beside this repo)
      if (p.kind === "join" && !rel(p.target).startsWith("src/") && rel(p.target).startsWith("..")) continue;   // outside the repo
      missing.push(`${rel(f)}: ${p.kind} ${p.label}`);
    }
  }
  assert.deepStrictEqual(missing, [], "paths that point at nothing:\n  " + missing.join("\n  "));
});

test("package.json's scripts and the CI workflow name files that exist", () => {
  const named = [];
  const scan = (where, text) => {
    for (const m of text.matchAll(/\bnode ([\w./-]+\.js)\b/g)) named.push([where, m[1]]);
    for (const m of text.matchAll(/\s([\w./-]+\.swift)\b/g)) named.push([where, m[1]]);
  };
  for (const [k, v] of Object.entries(pkg.scripts)) scan("package.json scripts." + k, v);
  for (const f of fs.readdirSync(path.join(ROOT, ".github", "workflows"))) scan(f, read(path.join(ROOT, ".github", "workflows", f)));
  const gone = named.filter(([, f]) => !isFile(path.join(ROOT, f))).map(([w, f]) => `${w}: ${f}`);
  assert.deepStrictEqual(gone, [], gone.join(", "));
  assert.ok(isFile(path.join(ROOT, pkg.main)), `main ${pkg.main} is not there`);
  for (const r of extra) assert.ok(r.startsWith("build/") || isFile(path.join(ROOT, r)), `extraResources ${r} is not there`);
});

/** What the app loads when it runs: from main, every require, page, preload, script, font and frame. */
function loaded() {
  const seen = new Map();   // abs -> how it was reached
  const todo = [[path.join(ROOT, pkg.main), "node", null]];
  while (todo.length) {
    const [abs, kind, page] = todo.pop();
    if (seen.has(abs) || !isFile(abs)) continue;
    seen.set(abs, kind);
    if (kind === "node") {
      for (const p of pathsIn(abs)) {
        if (!isFile(p.target)) continue;
        if (p.target.endsWith(".html")) todo.push([p.target, "page", null]);
        else if (p.target.endsWith(".js") || p.target.endsWith(".json")) todo.push([p.target, "node", null]);
        else todo.push([p.target, "asset", null]);
      }
    } else if (kind === "page") {
      for (const p of pathsIn(abs)) todo.push([p.target, p.kind === "script" ? "script" : "asset", abs]);
    } else if (kind === "script") {
      // A page's script names other pages (a frame) relative to the page, not to itself.
      for (const m of read(abs).matchAll(PAGE_NAME)) {
        const target = path.resolve(path.dirname(page), m[1]);
        if (isFile(target)) todo.push([target, "page", null]);
      }
    }
  }
  return seen;
}

test("everything the app loads is shipped", () => {
  const reached = loaded();
  assert.ok(reached.size > 40, `walked only ${reached.size} files; the walker lost the tree`);
  const missing = [...reached.keys()].map(rel).filter((f) => !shipped(f));
  assert.deepStrictEqual(missing, [], "loaded but not in build.files: " + missing.join(", "));
});

test("everything shipped from src/ is loaded, and no test, fixture or test kit is shipped", () => {
  const reached = new Set([...loaded().keys()].map(rel));
  const files = repoFiles().map(rel).filter(shipped);
  const dev = files.filter((f) => /\.test\.js$|\/fixtures\/|testkit\.js$|^scripts\/|^test\//.test(f));
  assert.deepStrictEqual(dev, [], "shipped but only for development: " + dev.join(", "));
  const unused = files.filter((f) => f.startsWith("src/") && !reached.has(f));
  assert.deepStrictEqual(unused, [], "shipped but loaded by nothing: " + unused.join(", "));
  for (const f of pkg.build.files.filter((p) => !p.includes("*") && !p.startsWith("!"))) {
    assert.ok(isFile(path.join(ROOT, f)), `build.files names ${f}, which is not there`);
  }
});

test("the docs name only paths that exist", () => {
  const gone = [];
  for (const doc of ["README.md", "RELEASE.md", "archi.md"]) {
    const text = read(path.join(ROOT, doc));
    for (const m of text.matchAll(/(?<![\w/.-])((?:src|native|scripts|test|assets|docs)\/[\w./-]*[\w/])/g)) {
      const p = m[1].replace(/\/$/, "");
      if (!fs.existsSync(path.join(ROOT, p))) gone.push(`${doc}: ${m[1]}`);
    }
  }
  assert.deepStrictEqual(gone, [], "paths in the docs that are not in the repo:\n  " + gone.join("\n  "));
});
