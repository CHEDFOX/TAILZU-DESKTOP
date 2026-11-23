// THE OVERLAY PAGES, AS ONE FILE THE SERVER CAN HAND OUT (src/main/uiBundle.js reads it).
//
// The pill, Ask's card and Blip at rest, and every file they load, gathered from THIS REPO — the pages are followed
// to their scripts, stylesheets and fonts, so nothing is listed by hand and the repo stays the one source of how
// they look. The bundle is a single JSON file (no zip to unpack, no dependency): its version, the oldest app it
// may run in, the bridge it was built against, and each file with its size, its SHA-256 and its bytes in base64.
//
//   node scripts/ui-bundle.js [--out dist/ui] [--v 20261123101500-3f9a2c1d0e4b] [--min-app 0.4.7]
//
// writes  <out>/<v>.json      the bundle, published as downloads/ui/<v>.json
//         <out>/latest.json   its manifest: v, the bundle's own sha256 and size, minApp, its address, and the list
//                             of files with each one's hash (the server's copy is written by its receiver,
//                             deploy/receive-download.sh, from the bytes it was sent)
//
// v is the commit's time in UTC and its hash, so a later commit is always a later version, and the same commit is
// always the same bytes (nothing else, not the time of the build, goes in): publishing it twice changes nothing.
// minApp is package.json's version unless --min-app says otherwise: raise it when the pages need something main
// does that the release before did not. The bundle is read back with the loader's own check before it is written,
// so this never writes one the app would refuse. The workflow (.github/workflows/ui.yml) runs it on every push to
// main that touches the pages.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { PAGES, FORMAT, V_RE, VERSION_RE, TYPES, references, bridgeNames, verifyBundle } = require("../src/main/uiBundle.js");

const ROOT = path.join(__dirname, "..");
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** The commit's version: "YYYYMMDDHHMMSS-<12 hex>", from git. */
function commitVersion(root) {
  const out = execFileSync("git", ["-C", root, "show", "-s", "--format=%ct %H", "HEAD"], { encoding: "utf8" }).trim();
  const [ct, hash] = out.split(" ");
  const d = new Date(Number(ct) * 1000);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${hash.slice(0, 12)}`;
}

/** Every file the three pages load, followed from the pages themselves. Throws on a reference that leaves the repo,
 *  names another host, or is a kind of file a bundle may not carry. */
function collect(root) {
  const files = new Map();
  const queue = Object.values(PAGES);
  while (queue.length) {
    const p = queue.shift();
    if (files.has(p)) continue;
    const ext = (/\.([a-z0-9]+)$/.exec(p) || [])[1];
    if (!TYPES[ext]) throw new Error(`${p}: a kind of file a bundle may not carry`);
    const data = fs.readFileSync(path.join(root, ...p.split("/")));
    files.set(p, data);
    if (/\.(html|css)$/.test(p)) {
      for (const r of references(data.toString("utf8"), p)) {
        if (!r.path) throw new Error(`${p} loads ${r.ref}, which is not a file in the repo`);
        queue.push(r.path);
      }
    }
  }
  return files;
}

/** The bundle (its exact bytes) and its manifest. */
function build(o = {}) {
  const root = o.root || ROOT;
  const v = o.v || commitVersion(root);
  if (!V_RE.test(v)) throw new Error(`"${v}" is not a bundle version (YYYYMMDDHHMMSS-<hex>)`);
  const minApp = o.minApp || JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  if (!VERSION_RE.test(minApp)) throw new Error(`"${minApp}" is not an app version`);
  const bridge = bridgeNames(fs.readFileSync(path.join(root, "src", "main", "preload.js"), "utf8"));
  if (!bridge.length) throw new Error("no bridge was found in src/main/preload.js");
  const files = [...collect(root)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([p, data]) => ({ path: p, sha256: sha256(data), size: data.length, data: data.toString("base64") }));
  const bytes = Buffer.from(JSON.stringify({ format: FORMAT, v, minApp, bridge, files }));
  const whole = sha256(bytes);
  // The loader's own check, before anything is written.
  verifyBundle(bytes, { v, sha256: whole, minApp });
  const manifest = {
    format: FORMAT, v, sha256: whole, size: bytes.length, minApp, url: `/downloads/ui/${v}.json`,
    files: files.map(({ path: p, sha256: s, size }) => ({ path: p, sha256: s, size })),
  };
  return { v, minApp, sha256: whole, bytes, manifest };
}

function main(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const out = path.resolve(arg("--out") || path.join(ROOT, "dist", "ui"));
  const b = build({ v: arg("--v"), minApp: arg("--min-app") });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${b.v}.json`), b.bytes);
  fs.writeFileSync(path.join(out, "latest.json"), JSON.stringify(b.manifest, null, 2) + "\n");
  console.log(`ui bundle ${b.v}: ${b.manifest.files.length} files, ${b.bytes.length} bytes, sha256 ${b.sha256}, minApp ${b.minApp}`);
  console.log(path.join(out, `${b.v}.json`));
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (e) { console.error("ui-bundle: " + ((e && e.message) || e)); process.exit(1); }
}

module.exports = { build, collect, commitVersion };
