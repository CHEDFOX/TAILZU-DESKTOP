/**
 * THE OVERLAY WINDOWS' PAGES, FROM THE SERVER.
 *
 * The pill, Ask's card and Blip at rest are pages of ours (dictation/pill/pill.html, agent/guide/guide.html,
 * dictation/rest/rest.html), and every word of how they look and move was in the installer: a change to the card
 * was a release, and a release on desktop is a download someone has to notice, accept past SmartScreen and run.
 * The window's screens have been the server's for a long time. These three were not.
 *
 * So the server names a UI BUNDLE — the three pages and every file they load, built from this repo by
 * scripts/ui-bundle.js and published beside the installers — in the bootstrap ("desktop.ui": { v, url, sha256,
 * minApp }), and this keeps it: when v is not the one kept, it is fetched from the API's own origin (no other
 * host, no redirect), checked whole and file by file, unpacked into userData/ui/<v>/, and the three windows load
 * their page from it from then on. The pattern is blipSync.js's: a version check, a fetch, a check, a copy kept for
 * the next launch, and what the app carries whenever there is nothing better.
 *
 * WHAT MAKES IT SAFE TO LET THE SERVER DRAW THESE WINDOWS:
 *
 *   1. NO NEW POWERS. A bundled page runs in the same window, with the same webPreferences and the same preload
 *      (windows.js webPrefs): no Node, an isolated world, Chromium's sandbox, and only the bridge's functions, each
 *      of whose messages main checks for the window that sent it. A page from the server can do exactly what the
 *      built-in page could, and nothing else.
 *   2. ONLY ITS OWN FILES. The pages are served under a scheme of our own (x0ui://<v>/...), from the bytes that were
 *      verified and are held in memory — never read again from disk after the check, so nothing that changes the
 *      folder afterwards is what runs. A path that is not in the bundle is a 404. Every answer carries a
 *      Content-Security-Policy set HERE, not by the bundle: scripts, styles, fonts and pictures only from the bundle
 *      itself, no inline script, nothing to connect to (as the built-in pages have it), no frames, no forms.
 *   3. NEVER HALF. A bundle with a file missing, a file that does not hash to what its manifest says, a page that
 *      references a file it does not carry, or a reference to anywhere else is not used AT ALL. The one kept before
 *      it stays until a new one has verified, and is only then removed.
 *   4. NEVER IN AN APP TOO OLD FOR IT. minApp is the oldest build whose main process the pages were made against
 *      (refused above app.getVersion()), and `bridge` lists the functions the preload offered when the bundle was
 *      built: an app whose preload lacks one of them (a bundle built from main after a bridge change, before the
 *      release that carries it) refuses the bundle, whatever minApp says.
 *   5. BACK TO BUILT-IN WHEN IT GOES WRONG. A page from the bundle that fails to load is replaced by the built-in
 *      one at once; renderers crashing twice in a row from the bundle set it aside for the rest of the run. Both are
 *      logged with the reason. desktop.ui.enabled (a knob, on by default) turns the whole thing off from the server.
 *
 * A bundle that verifies mid-run is used by the next window made (the pill at the next launch, Ask's card and the
 * resting Blip the next time theirs is built); a window already open keeps the bundle it was loaded from, which
 * stays served from memory for it.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const defaultKnobs = require("../../knobs.js");

/** The scheme the bundled pages are served under. Registered as privileged (standard, so relative paths and 'self'
 *  work; secure, as file:// pages are) by main.js before the app is ready. */
const SCHEME = "x0ui";
const SCHEME_PRIVILEGES = Object.freeze({ standard: true, secure: true });

/** The bundle's format. A bundle of another format is not read. */
const FORMAT = 1;

/** The three pages, by the name the windows ask with, at their place in the repo — the same relative path in the
 *  bundle, in the app (loadFile) and under userData/ui/<v>/files/, so every page's own relative references hold. */
const PAGES = Object.freeze({
  pill: "src/dictation/pill/pill.html",
  guide: "src/agent/guide/guide.html",
  rest: "src/dictation/rest/rest.html",
});

/** "20261123101500-3f9a2c1d0e4b": the commit's time (UTC) and its hash, so a later commit is a later version. It is
 *  also the scheme's host and the folder's name, so nothing else is allowed in it. */
const V_RE = /^[0-9]{14}-[0-9a-f]{7,40}$/;
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
/** A file's path in the bundle: forward slashes, no empty, hidden, "." or ".." segment, no leading slash. */
const PATH_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;
/** What a bundle may carry, and the type each is served as. Nothing executable but the pages' own scripts. */
const TYPES = Object.freeze({
  html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8",
  woff2: "font/woff2", woff: "font/woff", png: "image/png", webp: "image/webp",
});
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 300;

/** The policy every bundled answer is served with. The pages carry a policy of their own in a meta tag too, and the
 *  two are both enforced, so a bundle can narrow this one but never widen it. connect-src is none, as today: these
 *  pages speak to main through the bridge, never to the network. */
const CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "font-src 'self'", "img-src 'self'",
  "connect-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join("; ");

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const extOf = (p) => { const m = /\.([a-z0-9]+)$/.exec(p); return m ? m[1] : ""; };

/** -1, 0 or 1, by dotted number. "0.4.10" is newer than "0.4.9". */
function compareVersions(a, b) {
  const pa = String(a).split("."), pb = String(b).split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = parseInt(pa[i] || "0", 10) || 0, y = parseInt(pb[i] || "0", 10) || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * What a page or a stylesheet loads: every <script src>, <link href> (and src= of the few tags that load one) and
 * CSS url(), each as { ref, path }: path is where it lands in the bundle, relative to the repo, or null for an
 * address that is not a file beside it (another host, an absolute path). data: is left out: the policy above gives
 * it nothing to load into. The script collects a bundle's files with this, and the loader checks every page's with it.
 */
function references(text, from) {
  const out = [];
  const dir = path.posix.dirname(from);
  const add = (raw) => {
    const ref = String(raw).trim().replace(/^["']|["']$/g, "").trim();
    if (!ref || ref.startsWith("#") || /^data:/i.test(ref)) return;
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("/") || ref.startsWith("\\")) { out.push({ ref, path: null }); return; }
    const clean = ref.split(/[?#]/)[0];
    const p = path.posix.normalize(path.posix.join(dir, clean));
    out.push({ ref, path: p.startsWith("../") || p === ".." ? null : p });
  };
  if (/\.html$/.test(from)) {
    for (const m of text.matchAll(/<(?:script|img|source|audio|video|iframe|embed)\b[^>]*?\ssrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi)) add(m[1]);
    for (const m of text.matchAll(/<link\b[^>]*?\shref\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi)) add(m[1]);
  }
  if (/\.(html|css)$/.test(from)) {
    for (const m of text.matchAll(/url\(\s*("[^"]*"|'[^']*'|[^)\s]*)\s*\)/g)) add(m[1]);
    for (const m of text.matchAll(/@import\s+("[^"]*"|'[^']*')/g)) add(m[1]);
  }
  return out;
}

/**
 * The bridge's functions, as "namespace.name", read from preload.js's source: every key of every object it hands
 * exposeInMainWorld. The script records the list in the bundle; the app reads its own preload with the same function,
 * and a bundle that names one the app does not have is refused.
 */
function bridgeNames(src) {
  const names = new Set();
  const re = /exposeInMainWorld\(\s*["']([A-Za-z_$][\w$]*)["']\s*,\s*\{/g;
  let m;
  while ((m = re.exec(String(src)))) {
    const ns = m[1];
    let depth = 0;
    const rest = String(src).slice(re.lastIndex).split("\n");
    for (const line of rest) {
      const code = line.trim().startsWith("//") ? "" : line;
      const key = depth === 0 ? /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(code) : null;
      if (key) names.add(ns + "." + key[1]);
      for (const c of code) { if (c === "{") depth++; else if (c === "}") depth--; }
      if (depth < 0) break;
    }
  }
  return [...names].sort();
}

/** A file entry's own shape: a safe path of a type a bundle may carry, its size and its hash. Throws when it is not. */
function checkEntry(f) {
  if (!f || typeof f !== "object") throw new Error("a file entry that is not one");
  if (typeof f.path !== "string" || !PATH_RE.test(f.path) || f.path.length > 200) throw new Error("a file path that is not allowed: " + String(f.path).slice(0, 80));
  if (!TYPES[extOf(f.path)]) throw new Error("a kind of file a bundle may not carry: " + f.path);
  if (!Number.isInteger(f.size) || f.size < 0 || f.size > MAX_BYTES) throw new Error("a file with no size: " + f.path);
  if (typeof f.sha256 !== "string" || !SHA_RE.test(f.sha256)) throw new Error("a file with no hash: " + f.path);
}

/** The three pages are there, and every file each page (and each stylesheet) loads is in the bundle. Throws with the
 *  first that is not: a bundle with something missing is not used at all. */
function checkComplete(files) {
  for (const p of Object.values(PAGES)) if (!files.has(p)) throw new Error("the page " + p + " is missing");
  for (const [p, buf] of files) {
    if (!/\.(html|css)$/.test(p)) continue;
    for (const r of references(buf.toString("utf8"), p)) {
      if (!r.path) throw new Error(p + " loads something from outside the bundle: " + r.ref.slice(0, 80));
      if (!files.has(r.path)) throw new Error(p + " loads " + r.path + ", which the bundle does not carry");
    }
  }
}

/**
 * A downloaded bundle, checked whole: the bytes hash to the flag's sha256, it is the flag's version with the flag's
 * minApp, and every file decodes to its size and hash, with nothing missing. Returns { v, sha256, minApp, bridge,
 * files: Map(path → Buffer) }; throws with the reason otherwise.
 */
function verifyBundle(bytes, expect) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length > MAX_BYTES) throw new Error("it is too big (" + buf.length + " bytes)");
  const whole = sha256(buf);
  if (expect && expect.sha256 !== whole) throw new Error("its hash is not the one the server named");
  let b;
  try { b = JSON.parse(buf.toString("utf8")); } catch { throw new Error("it is not JSON"); }
  if (!b || typeof b !== "object" || b.format !== FORMAT) throw new Error("it is not a bundle this app can read");
  if (typeof b.v !== "string" || !V_RE.test(b.v)) throw new Error("it has no version");
  if (expect && b.v !== expect.v) throw new Error("it is version " + b.v + ", not " + expect.v);
  if (typeof b.minApp !== "string" || !VERSION_RE.test(b.minApp)) throw new Error("it does not say which app it needs");
  if (expect && expect.minApp && b.minApp !== expect.minApp) throw new Error("it needs app " + b.minApp + ", not the " + expect.minApp + " the server said");
  if (!Array.isArray(b.bridge) || !b.bridge.every((n) => typeof n === "string" && /^[\w$]+\.[\w$]+$/.test(n))) throw new Error("it does not list the bridge it was built against");
  if (!Array.isArray(b.files) || !b.files.length || b.files.length > MAX_FILES) throw new Error("it has no files");
  const files = new Map();
  for (const f of b.files) {
    checkEntry(f);
    if (files.has(f.path)) throw new Error("it carries " + f.path + " twice");
    if (typeof f.data !== "string") throw new Error(f.path + " has no content");
    const data = Buffer.from(f.data, "base64");
    if (data.length !== f.size || sha256(data) !== f.sha256) throw new Error(f.path + " does not match its hash");
    files.set(f.path, data);
  }
  checkComplete(files);
  return { v: b.v, sha256: whole, minApp: b.minApp, bridge: b.bridge.slice(), files };
}

/**
 * @param {object} o
 * @param {string} o.userData        the app's data folder; the bundle is kept in its ui/
 * @param {string} o.appVersion      app.getVersion()
 * @param {() => string} o.baseUrl   the API's address (cfg.baseUrl): the only origin a bundle is fetched from
 * @param {Function} o.fetch         fetch(url, init)
 * @param {string[]} [o.bridge]      this app's bridge (default: read from preload.js beside this file)
 * @param {Function} [o.log]         one line, for what was refused or set aside and why
 * @param {Function} [o.onChange]    a new bundle verified and kept (its v)
 * @param {object} [o.knobs]         knobs.js (injected by tests)
 */
function createUiBundle(o) {
  const knobs = o.knobs || defaultKnobs;
  const log = (line) => { try { if (o.log) o.log("ui: " + line); } catch { /* the line only */ } };
  const T = o.setTimeout || setTimeout;
  const root = path.join(o.userData, "ui");
  let appBridge = o.bridge || null;
  /** The bundle verified and kept (memory and disk), or null. */
  let kept = readKept();
  /** Every bundle a window was loaded from this run, by v: what the scheme serves. */
  const served = new Map();
  /** Why the bundle was set aside for this run (built-in pages from then on), or null. */
  let setAsideWhy = null;
  let crashes = 0;
  let serving = false;
  let fetching = null;
  /** v:sha256 of bundles that failed their check this run: not fetched again until the server names another. */
  const refused = new Set();
  const told = new Set();

  function bridge() {
    if (appBridge) return appBridge;
    try { appBridge = bridgeNames(fs.readFileSync(path.join(__dirname, "preload.js"), "utf8")); } catch { appBridge = []; }
    return appBridge;
  }

  /** Why this app cannot run the bundle ("" when it can). */
  function unusable(b) {
    if (compareVersions(b.minApp, o.appVersion) > 0) return "it needs app " + b.minApp + " and this is " + o.appVersion;
    const have = new Set(bridge());
    const lacking = b.bridge.filter((n) => !have.has(n));
    if (lacking.length) return "this app's bridge has no " + lacking.slice(0, 3).join(", ");
    return "";
  }

  /** The kept bundle's folder read back and checked file by file against its manifest. Null when there is none, or
   *  when anything in it is missing or changed (it is then fetched again when the server names it). */
  function readDir(dir) {
    const man = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    if (!man || man.format !== FORMAT || !V_RE.test(String(man.v)) || !VERSION_RE.test(String(man.minApp))) throw new Error("its manifest is not one");
    if (!Array.isArray(man.files) || !man.files.length || man.files.length > MAX_FILES || !Array.isArray(man.bridge)) throw new Error("its manifest has no files");
    const files = new Map();
    for (const f of man.files) {
      checkEntry(f);
      const data = fs.readFileSync(path.join(dir, "files", ...f.path.split("/")));
      if (data.length !== f.size || sha256(data) !== f.sha256) throw new Error("the kept " + f.path + " is not the file that was checked");
      files.set(f.path, data);
    }
    checkComplete(files);
    return { v: man.v, sha256: String(man.sha256 || ""), minApp: man.minApp, bridge: man.bridge.map(String), files };
  }
  function readKept() {
    let cur;
    try { cur = JSON.parse(fs.readFileSync(path.join(root, "current.json"), "utf8")); } catch { return null; }
    try {
      if (!cur || !V_RE.test(String(cur.v))) throw new Error("current.json names no version");
      const b = readDir(path.join(root, cur.v));
      if (b.v !== cur.v) throw new Error("its folder holds " + b.v);
      return b;
    } catch (e) {
      log("the kept bundle is not used: " + ((e && e.message) || e));
      return null;
    }
  }

  /** Into userData/ui/<v>/: written beside, read back and checked, renamed into place, and only then pointed at by
   *  current.json; the bundles before it are removed last. A failure anywhere leaves the one before as it was. */
  function keep(b) {
    fs.mkdirSync(root, { recursive: true });
    const tmp = path.join(root, "." + b.v + "-" + process.pid + "-" + Date.now() + ".tmp");
    try {
      const entries = [];
      for (const [p, data] of b.files) {
        const to = path.join(tmp, "files", ...p.split("/"));
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.writeFileSync(to, data);
        entries.push({ path: p, sha256: sha256(data), size: data.length });
      }
      fs.writeFileSync(path.join(tmp, "manifest.json"), JSON.stringify({ format: FORMAT, v: b.v, sha256: b.sha256, minApp: b.minApp, bridge: b.bridge, files: entries }));
      readDir(tmp);
      const final = path.join(root, b.v);
      fs.rmSync(final, { recursive: true, force: true });
      fs.renameSync(tmp, final);
    } catch (e) {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* left for the next clean-up */ }
      throw e;
    }
    fs.writeFileSync(path.join(root, "current.json.tmp"), JSON.stringify({ v: b.v }));
    fs.renameSync(path.join(root, "current.json.tmp"), path.join(root, "current.json"));
    for (const name of fs.readdirSync(root)) {
      if (name === b.v || name === "current.json") continue;
      try { fs.rmSync(path.join(root, name), { recursive: true, force: true }); } catch { /* removed next time */ }
    }
  }

  function enabled() { return knobs.bool("desktop.ui.enabled", true) !== false; }

  /** The bundle the next window loads from, or null for the built-in pages. */
  function active() {
    if (!kept || !serving || setAsideWhy || !enabled()) return null;
    return unusable(kept) ? null : kept;
  }

  function setAside(why) {
    if (setAsideWhy) return;
    setAsideWhy = why;
    log("back to the built-in pages for the rest of this run: " + why);
  }

  /**
   * Load one of the three pages into its window: from the bundle when there is one to use, the built-in file
   * exactly as before otherwise. Returns "bundle" or "built-in".
   */
  function load(win, page) {
    const file = PAGES[page];
    if (!file) throw new Error("no such page: " + page);
    const b = active();
    if (!b) { win.loadFile(file); return "built-in"; }
    served.set(b.v, b);
    const url = SCHEME + "://" + b.v + "/" + file;
    const wc = win.webContents;
    const fromBundle = () => { try { return String(wc.getURL() || "").startsWith(SCHEME + ":"); } catch { return false; } };
    let healthy = null;
    wc.on("did-fail-load", (_e, code, desc, validatedURL, isMainFrame) => {
      // -3 is a load replaced by another (ours, or a reload): not a failure of the page.
      if (isMainFrame === false || code === -3 || !String(validatedURL || "").startsWith(SCHEME + ":")) return;
      setAside("the " + page + "'s page from bundle " + b.v + " did not load (" + code + " " + (desc || "") + ")");
      try { if (!win.isDestroyed()) win.loadFile(file); } catch { /* the window is gone */ }
    });
    // A page that has run a while from the bundle ends the run of crashes.
    wc.on("did-finish-load", () => {
      clearTimeout(healthy);
      if (!fromBundle()) return;
      healthy = T(() => { crashes = 0; }, Math.max(0, knobs.num("desktop.ui.healthyMs", 60000)));
      if (healthy && healthy.unref) healthy.unref();
    });
    // FIRST, before the window's own handler: that one builds the window again at once (the pill, main.js), and the
    // new one must already know whether the bundle is still to be used.
    const gone = (_e, d) => {
      clearTimeout(healthy);
      const reason = (d && d.reason) || "gone";
      if (reason === "clean-exit" || !fromBundle()) return;
      crashes++;
      log("the " + page + "'s page from bundle " + b.v + " went away (" + reason + "), " + crashes + " in a row");
      if (crashes >= Math.max(1, knobs.num("desktop.ui.crashLimit", 2))) setAside("pages from bundle " + b.v + " crashed " + crashes + " times in a row, the last the " + page + "'s (" + reason + ")");
    };
    if (typeof wc.prependListener === "function") wc.prependListener("render-process-gone", gone); else wc.on("render-process-gone", gone);
    const p = win.loadURL(url);
    if (p && typeof p.catch === "function") p.catch(() => { /* did-fail-load says so, and falls back */ });
    return "bundle";
  }

  /** One answer of the scheme: a file of a bundle a window was loaded from, with the policy; 404 for anything else. */
  function respond(raw, method) {
    const headers = { "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Cross-Origin-Resource-Policy": "same-origin" };
    const no = (status) => new Response("", { status, headers: Object.assign({ "Content-Type": "text/plain" }, headers) });
    if (method && method !== "GET") return no(405);
    let u, p;
    try { u = new URL(String(raw)); p = decodeURIComponent(u.pathname).replace(/^\/+/, ""); } catch { return no(400); }
    if (u.protocol !== SCHEME + ":" || u.search || !PATH_RE.test(p)) return no(404);
    const b = served.get(u.hostname);
    const data = b && b.files.get(p);
    if (!data) return no(404);
    return new Response(data, { status: 200, headers: Object.assign({ "Content-Type": TYPES[extOf(p)], "Content-Security-Policy": CSP }, headers) });
  }

  /** Serve the scheme (once the app is ready, before any of the three windows is made). False when it cannot be,
   *  and every page is then the built-in one. */
  function serve(protocol) {
    if (serving) return true;
    try {
      protocol.handle(SCHEME, (req) => respond(req.url, req.method));
      serving = true;
    } catch (e) { log("the bundle cannot be served: " + ((e && e.message) || e)); }
    return serving;
  }

  /** The flag's address, if it is the API's own and the bundle's own path; null otherwise. */
  function addressOf(f) {
    let base, u;
    try { base = new URL(String(o.baseUrl())); u = new URL(f.url, base); } catch { return null; }
    if (u.origin !== base.origin || u.username || u.password || u.search || u.hash) return null;
    if (u.pathname !== "/downloads/ui/" + f.v + ".json") return null;
    return u;
  }

  /** The bootstrap's flag: fetch the bundle it names when its v is not the one kept. Resolves true when a new one
   *  verified and was kept. */
  async function check(flag) {
    if (!enabled() || !flag || typeof flag !== "object") return false;
    const f = { v: flag.v, url: flag.url, sha256: flag.sha256, minApp: flag.minApp };
    if (typeof f.v !== "string" || !V_RE.test(f.v) || typeof f.url !== "string" || typeof f.sha256 !== "string" || !SHA_RE.test(f.sha256)
      || typeof f.minApp !== "string" || !VERSION_RE.test(f.minApp)) return false;
    if (kept && kept.v === f.v) return false;
    const key = f.v + ":" + f.sha256;
    if (refused.has(key)) return false;
    const once = (why) => { if (!told.has(key)) { told.add(key); log("bundle " + f.v + " is not fetched: " + why); } return false; };
    if (compareVersions(f.minApp, o.appVersion) > 0) return once("it needs app " + f.minApp + " and this is " + o.appVersion);
    const u = addressOf(f);
    if (!u) return once("its address is not the API's own (" + f.url.slice(0, 120) + ")");
    if (fetching) return fetching;
    fetching = (async () => {
      let bytes;
      try {
        // No redirect is followed: a bundle comes from the API's origin or not at all.
        const res = await o.fetch(u.href, { redirect: "error", cache: "no-store" });
        if (!res || !res.ok) return false;
        if (res.url && new URL(res.url).origin !== u.origin) throw new Error("it was answered from another host");
        bytes = Buffer.from(await res.arrayBuffer());
      } catch (e) {
        log("bundle " + f.v + " could not be fetched: " + ((e && e.message) || e));
        return false;
      }
      try {
        const b = verifyBundle(bytes, f);
        const why = unusable(b);
        if (why) throw new Error(why);
        try { keep(b); } catch (e) { log("bundle " + f.v + " is used for this run only, it could not be kept: " + ((e && e.message) || e)); }
        kept = b;
        try { if (o.onChange) o.onChange(b.v); } catch { /* theirs */ }
        return true;
      } catch (e) {
        refused.add(key);
        log("bundle " + f.v + " is not used: " + ((e && e.message) || e));
        return false;
      }
    })().finally(() => { fetching = null; });
    return fetching;
  }

  /** Which bundle is kept, whether the next window loads from it, and why not. */
  function status() {
    const a = active();
    return { kept: kept ? kept.v : null, using: a ? a.v : null, setAside: setAsideWhy, crashes, serving, unusable: kept ? unusable(kept) : "" };
  }

  return { check, load, serve, respond, status, pageUrl: (page) => { const a = active(); return a && PAGES[page] ? SCHEME + "://" + a.v + "/" + PAGES[page] : null; } };
}

module.exports = {
  createUiBundle, verifyBundle, references, bridgeNames, compareVersions, checkComplete,
  PAGES, SCHEME, SCHEME_PRIVILEGES, CSP, FORMAT, V_RE, VERSION_RE, TYPES, MAX_BYTES,
};
