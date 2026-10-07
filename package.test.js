// The packaged app only carries what build.files in package.json names, one
// file at a time. A module required from main.js but missing from that list
// runs fine from the checkout (`electron .`) and crashes every installer at
// launch with "Cannot find module" — which is how 0.3.3 reached the Store and
// tailzu.space without frontApp.js. This walks every file the app loads,
// starting from main.js and the windows' HTML, and fails on the first one the
// list leaves out.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const pkg = require("./package.json");
const listed = new Set(pkg.build.files.filter((f) => !f.includes("*")));
const globbed = pkg.build.files.filter((f) => f.endsWith("/**")).map((f) => f.slice(0, -3) + "/");

function shipped(file) {
  return listed.has(file) || globbed.some((dir) => file.startsWith(dir));
}

/** Every local file `file` loads: require("./x"), <script src="x">, loadFile("x.html"). */
function loads(file) {
  const src = fs.readFileSync(path.join(__dirname, file), "utf8");
  const out = new Set();
  for (const m of src.matchAll(/require\(\s*["']\.\/([^"']+)["']\s*\)/g)) out.add(m[1]);
  for (const m of src.matchAll(/<script[^>]+src=["']\.?\/?([^"']+)["']/g)) out.add(m[1]);
  for (const m of src.matchAll(/loadFile\(\s*[^"']*["']([^"']+\.html)["']/g)) out.add(m[1]);
  for (const m of src.matchAll(/path\.join\(\s*__dirname\s*,\s*["']([^"']+\.(?:js|html))["']\s*\)/g)) out.add(m[1]);
  return [...out].map((f) => f.replace(/^\.\//, ""));
}

test("every file the app loads is in build.files", () => {
  const seen = new Set();
  const todo = ["main.js", ...pkg.build.files.filter((f) => f.endsWith(".html"))];
  const missing = [];
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f) || !fs.existsSync(path.join(__dirname, f))) continue;
    seen.add(f);
    for (const dep of loads(f)) {
      if (dep.startsWith("assets/")) continue;
      if (!fs.existsSync(path.join(__dirname, dep))) continue;   // written at run time (config.json, shell.json)
      if (!shipped(dep)) missing.push(`${dep} (loaded by ${f})`);
      todo.push(dep);
    }
  }
  assert.deepStrictEqual(missing, [], `add to build.files in package.json: ${missing.join(", ")}`);
  assert.ok(seen.size > 10, `walked only ${seen.size} files; the walker lost the tree`);
});

test("build.files names only files that exist", () => {
  const gone = [...listed].filter((f) => !fs.existsSync(path.join(__dirname, f)));
  assert.deepStrictEqual(gone, [], `in build.files but not in the repo: ${gone.join(", ")}`);
});
