#!/usr/bin/env node
// Packs the desktop app's runner into this package, as runner/, for `npm pack` and `npm publish` (the prepack script). The
// package's root is cli/, so once published it can't reach ../src/runner; xode loads ./runner when it is there (computer/load.js).
//
// What is copied: src/runner/index.js and everything it requires, followed file by file. Not the tests, not the test kit, and not
// the runner's window (runner.html, ui.js), which nothing here requires. A require that leaves src/runner stops the bundle with a
// sentence: copying it would need its folder too, so this is the place to add it.
//
//   node scripts/bundle-runner.js [into]     (default: runner/ beside package.json)

"use strict";

const fs = require("fs");
const path = require("path");

const FROM = path.resolve(__dirname, "..", "..", "src", "runner");
const INTO = path.resolve(__dirname, "..", "runner");
const MARK = ".bundled-runner";
const REQUIRE = /require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;
const NEVER = /\.test\.js$|(^|\/)testkit\.js$|(^|\/)ui\.js$|\.html$/;

function resolveFile(fromDir, spec) {
  const base = path.resolve(fromDir, spec);
  for (const c of [base, base + ".js", base + ".json", path.join(base, "index.js")]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

/** The runtime files of the runner: index.js and what it requires, as paths relative to `from`. */
function runtimeFiles(from = FROM) {
  const seen = new Set();
  const todo = [path.join(from, "index.js")];
  while (todo.length) {
    const file = todo.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(REQUIRE)) {
      const target = resolveFile(path.dirname(file), m[1]);
      if (!target) throw new Error(`bundle-runner: ${path.relative(from, file)} requires ${m[1]}, which isn't there.`);
      const rel = path.relative(from, target);
      if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`bundle-runner: ${path.relative(from, file)} requires ${m[1]}, outside src/runner; add its folder to the bundle.`);
      todo.push(target);
    }
  }
  const out = [...seen].map((f) => path.relative(from, f).split(path.sep).join("/")).sort();
  const wrong = out.filter((f) => NEVER.test(f));
  if (wrong.length) throw new Error(`bundle-runner: the runner requires ${wrong.join(", ")}, which must not ship.`);
  return out;
}

/** Copies the runner into `into` (emptied first, if it is an earlier bundle). Returns the files copied. */
function bundle({ from = FROM, into = INTO } = {}) {
  if (!fs.existsSync(path.join(from, "index.js"))) throw new Error(`bundle-runner: there is no runner at ${from}.`);
  const files = runtimeFiles(from);
  if (fs.existsSync(into)) {
    const there = fs.readdirSync(into);
    if (there.length && !there.includes(MARK)) throw new Error(`bundle-runner: ${into} has other files in it; not touching it.`);
    fs.rmSync(into, { recursive: true, force: true });
  }
  fs.mkdirSync(into, { recursive: true });
  for (const f of files) {
    const to = path.join(into, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(from, f), to);
  }
  fs.writeFileSync(path.join(into, MARK), "Copied from src/runner by scripts/bundle-runner.js when the package was packed. Not edited here.\n");
  return files;
}

if (require.main === module) {
  try {
    const into = process.argv[2] ? path.resolve(process.argv[2]) : INTO;
    const files = bundle({ into });
    process.stdout.write(`bundle-runner: ${files.length} files into ${path.relative(process.cwd(), into) || "."}\n`);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { bundle, runtimeFiles };
