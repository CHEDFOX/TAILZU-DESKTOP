// node --test
//
// The overlay pages from the server's UI bundle: built by scripts/ui-bundle.js, fetched only from the API, checked
// whole and file by file, kept, loaded by the windows, and set aside for the built-in pages whenever anything is off.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { createUiBundle, verifyBundle, bridgeNames, references, PAGES, CSP } = require("./uiBundle.js");
const { build } = require("../../scripts/ui-bundle.js");
const knobs = require("../../knobs.js");

const V1 = "20261123101500-aaaaaaa", V2 = "20261124101500-bbbbbbb";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const built = new Map();
function bundle(v, minApp = "0.4.0") {
  const k = v + minApp;
  if (!built.has(k)) built.set(k, build({ v, minApp }));
  return built.get(k);
}
const flagOf = (b, o = {}) => Object.assign({ v: b.v, url: `/downloads/ui/${b.v}.json`, sha256: b.sha256, minApp: b.minApp }, o);
/** A bundle changed by `edit` (its parsed JSON), with the whole hash made right again. */
function edited(b, edit) {
  const j = JSON.parse(b.bytes.toString("utf8"));
  edit(j);
  const bytes = Buffer.from(JSON.stringify(j));
  return { v: j.v, minApp: j.minApp, bytes, sha256: sha(bytes) };
}

function rig(serve, o = {}) {
  const dir = o.dir || fs.mkdtempSync(path.join(os.tmpdir(), "ui-bundle-"));
  const asked = [], logs = [];
  const fetch = async (url, init) => {
    asked.push([url, init]);
    const body = serve(url);
    if (!body) return { ok: false, status: 404, url };
    return { ok: true, url, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length) };
  };
  const make = (more = {}) => {
    const u = createUiBundle(Object.assign({ userData: dir, appVersion: "0.4.7", baseUrl: () => "https://api.local", fetch, log: (l) => logs.push(l) }, more));
    u.serve({ handle() {} });
    return u;
  };
  return { dir, asked, logs, make, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const byUrl = (...bs) => (url) => { const b = bs.find((x) => url.endsWith(`/downloads/ui/${x.v}.json`)); return b ? b.bytes : null; };

function fakeWin() {
  const w = { loaded: [], destroyed: false, isDestroyed: () => w.destroyed };
  w.webContents = Object.assign(new EventEmitter(), { getURL: () => w.loaded[w.loaded.length - 1] || "" });
  w.loadFile = (f) => { w.loaded.push("file:" + f); };
  w.loadURL = (u) => { w.loaded.push(u); return Promise.resolve(); };
  return w;
}

test("the script's bundle round-trips: fetched from the API, checked, kept, and the windows load their page from it", async () => {
  const b = bundle(V1);
  const r = rig(byUrl(b));
  const u = r.make();
  assert.strictEqual(u.status().using, null);
  assert.strictEqual(await u.check(flagOf(b)), true);
  assert.deepStrictEqual(r.asked.map(([url, init]) => [url, init.redirect]), [[`https://api.local/downloads/ui/${V1}.json`, "error"]]);
  assert.strictEqual(u.status().using, V1);
  // Unpacked into userData/ui/<v>/, and pointed at.
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(r.dir, "ui", "current.json"))).v, V1);
  assert.ok(fs.existsSync(path.join(r.dir, "ui", V1, "files", "src", "dictation", "pill", "pill.html")));
  // The same version again: nothing fetched.
  assert.strictEqual(await u.check(flagOf(b)), false);
  assert.strictEqual(r.asked.length, 1);
  for (const page of Object.keys(PAGES)) {
    const w = fakeWin();
    assert.strictEqual(u.load(w, page), "bundle");
    assert.deepStrictEqual(w.loaded, [`x0ui://${V1}/${PAGES[page]}`]);
  }
  // Served from the bundle, with the policy; nothing else is.
  const res = u.respond(`x0ui://${V1}/src/dictation/pill/pill.html`, "GET");
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get("content-security-policy"), CSP);
  assert.match(res.headers.get("content-type"), /^text\/html/);
  const real = fs.readFileSync(path.join(__dirname, "..", "dictation", "pill", "pill.html"));
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(real));
  assert.strictEqual(u.respond(`x0ui://${V1}/src/main/preload.js`).status, 404);
  assert.strictEqual(u.respond(`x0ui://${V1}/src/dictation/pill/../../main/main.js`).status, 404);
  assert.strictEqual(u.respond(`x0ui://${V2}/src/dictation/pill/pill.html`).status, 404);
  assert.strictEqual(u.respond(`x0ui://${V1}/knobs.js`, "POST").status, 405);
  // The next launch has it before any network.
  const next = r.make();
  assert.strictEqual(next.status().using, V1);
  assert.strictEqual(next.load(fakeWin(), "rest"), "bundle");
  r.done();
});

test("a changed visible string in the bundle is what the window gets; a bad bundle leaves the built-in page", async () => {
  const b = bundle(V1);
  const changed = edited(b, (j) => {
    const f = j.files.find((x) => x.path === PAGES.rest);
    const html = Buffer.from(f.data, "base64").toString("utf8").replace("</head>", "<title>FROM THE SERVER</title></head>");
    const data = Buffer.from(html);
    Object.assign(f, { data: data.toString("base64"), size: data.length, sha256: sha(data) });
  });
  const r = rig(byUrl(changed));
  const u = r.make();
  assert.strictEqual(await u.check(flagOf(changed)), true);
  assert.strictEqual(u.load(fakeWin(), "rest"), "bundle");
  const text = await u.respond(`x0ui://${V1}/${PAGES.rest}`).text();
  assert.match(text, /FROM THE SERVER/);
  // The same change with the file's hash left as it was: refused, and a fresh install stays built-in.
  const bad = edited(b, (j) => { const f = j.files.find((x) => x.path === PAGES.rest); f.data = Buffer.from("<title>FROM THE SERVER</title>").toString("base64"); });
  const r2 = rig(byUrl(bad));
  const u2 = r2.make();
  assert.strictEqual(await u2.check(flagOf(bad)), false);
  const w = fakeWin();
  assert.strictEqual(u2.load(w, "rest"), "built-in");
  assert.deepStrictEqual(w.loaded, ["file:" + PAGES.rest]);
  r.done(); r2.done();
});

test("refused: another host, a redirect off the API, a wrong hash, a missing file, a too-new app, a bridge this app lacks", async () => {
  const b = bundle(V1);
  const r = rig(byUrl(b));
  const u = r.make();
  assert.strictEqual(await u.check(flagOf(b, { url: `https://elsewhere.example/downloads/ui/${V1}.json` })), false);
  assert.strictEqual(await u.check(flagOf(b, { url: `/downloads/ui/${V2}.json` })), false);
  assert.strictEqual(await u.check(flagOf(b, { url: `/downloads/ui/${V1}.json?x=1` })), false);
  assert.strictEqual(r.asked.length, 0);
  // Fetched, but answered from somewhere else.
  const away = rig(() => b.bytes);
  const ua = away.make({ fetch: async (url) => ({ ok: true, url: "https://elsewhere.example/x.json", arrayBuffer: async () => b.bytes }) });
  assert.strictEqual(await ua.check(flagOf(b)), false);
  // A hash that is not the bundle's: refused, and not fetched again this run.
  assert.strictEqual(await u.check(flagOf(b, { sha256: "0".repeat(64) })), false);
  assert.strictEqual(await u.check(flagOf(b, { sha256: "0".repeat(64) })), false);
  assert.strictEqual(r.asked.length, 1);
  // A script a page loads, left out (whole hash right): not used at all.
  const missing = edited(b, (j) => { j.files = j.files.filter((f) => f.path !== "src/dictation/pill/voice.js"); });
  const rm = rig(byUrl(missing));
  assert.strictEqual(await rm.make().check(flagOf(missing)), false);
  assert.ok(rm.logs.some((l) => /voice\.js, which the bundle does not carry/.test(l)));
  // A page that loads from another host.
  const remote = edited(b, (j) => {
    const f = j.files.find((x) => x.path === PAGES.rest);
    const data = Buffer.from(Buffer.from(f.data, "base64").toString("utf8").replace("</head>", '<script src="https://cdn.example/x.js"></script></head>'));
    Object.assign(f, { data: data.toString("base64"), size: data.length, sha256: sha(data) });
  });
  const rr = rig(byUrl(remote));
  assert.strictEqual(await rr.make().check(flagOf(remote)), false);
  // Too new for this app: not even fetched.
  const tooNew = bundle(V2, "9.0.0");
  const rn = rig(byUrl(tooNew));
  assert.strictEqual(await rn.make().check(flagOf(tooNew)), false);
  assert.strictEqual(rn.asked.length, 0);
  // The flag says one minApp, the bundle another.
  const rl = rig(byUrl(b));
  assert.strictEqual(await rl.make().check(flagOf(b, { minApp: "0.1.0" })), false);
  // Built against a bridge function this app's preload does not have.
  const rb = rig(byUrl(b));
  assert.strictEqual(await rb.make({ bridge: ["tailzu.onPill"] }).check(flagOf(b)), false);
  assert.ok(rb.logs.some((l) => /bridge has no/.test(l)));
  for (const x of [r, away, rm, rr, rn, rl, rb]) x.done();
});

test("the previous good bundle stays until a new one verifies, and is removed once one has", async () => {
  const b1 = bundle(V1), b2 = bundle(V2);
  const bad2 = edited(b2, (j) => { j.files[0].sha256 = "1".repeat(64); });
  let serving = bad2;
  const r = rig((url) => (url.endsWith(V1 + ".json") ? b1.bytes : serving.bytes));
  const u = r.make();
  assert.strictEqual(await u.check(flagOf(b1)), true);
  assert.strictEqual(await u.check(flagOf(bad2)), false);
  assert.strictEqual(u.status().using, V1);
  assert.strictEqual(r.make().status().using, V1);
  serving = b2;
  assert.strictEqual(await u.check(flagOf(b2)), true);
  assert.strictEqual(u.status().using, V2);
  assert.deepStrictEqual(fs.readdirSync(path.join(r.dir, "ui")).sort(), [V2, "current.json"].sort());
  r.done();
});

test("a kept file changed on disk, or an app downgraded below minApp: the built-in pages", async () => {
  const b = bundle(V1);
  const r = rig(byUrl(b));
  assert.strictEqual(await r.make().check(flagOf(b)), true);
  assert.strictEqual(r.make({ appVersion: "0.3.9" }).status().using, null);
  fs.appendFileSync(path.join(r.dir, "ui", V1, "files", "knobs.js"), "\n// changed");
  const u = r.make();
  assert.strictEqual(u.status().kept, null);
  assert.strictEqual(u.load(fakeWin(), "pill"), "built-in");
  // Fetched again when the server names it.
  assert.strictEqual(await u.check(flagOf(b)), true);
  r.done();
});

test("a page that fails to load, or renderers crashing twice in a row, fall back to built-in for the rest of the run", async () => {
  const b = bundle(V1);
  const r = rig(byUrl(b));
  const u = r.make();
  await u.check(flagOf(b));
  // One crash, then a page that ran a while: the count starts again.
  const timers = [];
  const u2 = r.make({ setTimeout: (f) => { timers.push(f); return 0; } });
  let w = fakeWin();
  u2.load(w, "pill");
  w.webContents.emit("render-process-gone", {}, { reason: "crashed" });
  w = fakeWin(); u2.load(w, "pill");
  w.webContents.emit("did-finish-load");
  timers.pop()();
  w.webContents.emit("render-process-gone", {}, { reason: "crashed" });
  assert.strictEqual(u2.status().using, V1);
  // Two in a row: set aside, and the window the crash handler builds is already built-in.
  let rebuilt = null;
  w = fakeWin(); u2.load(w, "guide");
  w.webContents.on("render-process-gone", () => { rebuilt = fakeWin(); u2.load(rebuilt, "guide"); });
  w.webContents.emit("render-process-gone", {}, { reason: "oom" });
  assert.deepStrictEqual(rebuilt.loaded, ["file:" + PAGES.guide]);
  assert.match(u2.status().setAside, /crashed 2 times in a row/);
  assert.ok(r.logs.some((l) => /built-in pages for the rest of this run/.test(l)));
  // A load that fails: the built-in page at once.
  const u3 = r.make();
  const f = fakeWin();
  u3.load(f, "rest");
  f.webContents.emit("did-fail-load", {}, -6, "ERR_FILE_NOT_FOUND", `x0ui://${V1}/${PAGES.rest}`, true);
  assert.deepStrictEqual(f.loaded, [`x0ui://${V1}/${PAGES.rest}`, "file:" + PAGES.rest]);
  assert.strictEqual(u3.load(fakeWin(), "pill"), "built-in");
  r.done();
});

test("desktop.ui.enabled false: nothing fetched, every page built-in", async () => {
  const b = bundle(V1);
  const r = rig(byUrl(b));
  assert.strictEqual(await r.make().check(flagOf(b)), true);
  knobs.setKnobs({ labels: {}, flags: { "desktop.ui.enabled": false } });
  try {
    const u = r.make();
    assert.strictEqual(u.load(fakeWin(), "pill"), "built-in");
    assert.strictEqual(await u.check(flagOf(bundle(V2))), false);
    assert.strictEqual(r.asked.length, 1);
  } finally { knobs.setKnobs({ labels: {}, flags: {} }); }
  r.done();
});

test("the bridge read from preload.js is the one it really exposes", () => {
  const exposed = [];
  const src = fs.readFileSync(path.join(__dirname, "preload.js"), "utf8");
  const fake = { contextBridge: { exposeInMainWorld: (ns, api) => { for (const k of Object.keys(api)) exposed.push(ns + "." + k); } }, ipcRenderer: {} };
  new Function("__fake", src.replace('require("electron")', "__fake"))(fake);
  assert.deepStrictEqual(bridgeNames(src), [...new Set(exposed)].sort());
});

test("main.js: with a bundle kept, the pill's window loads its page from it under the served scheme", async () => {
  const { mainProcess } = require("./testkit.js");
  const b = bundle(V1);
  const r = rig(byUrl(b));
  assert.strictEqual(await r.make().check(flagOf(b)), true);
  const files = {};
  const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else files[path.relative(r.dir, p)] = fs.readFileSync(p); } };
  walk(path.join(r.dir, "ui"));
  const m = mainProcess({ files });
  try {
    await m.ready();
    assert.deepStrictEqual(m.protocols.privileged, [{ scheme: "x0ui", privileges: { standard: true, secure: true } }]);
    const pill = m.win(PAGES.pill);
    assert.strictEqual(pill.url, `x0ui://${V1}/${PAGES.pill}`);
    // Same preload and powers as the built-in page.
    assert.match(pill.opts.webPreferences.preload, /preload\.js$/);
    assert.strictEqual(pill.opts.webPreferences.sandbox, true);
    const res = await m.protocols.x0ui({ url: pill.url, method: "GET" });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("content-security-policy"), CSP);
  } finally { m.close(); r.done(); }
  // Nothing kept: the built-in page, as before.
  const plain = mainProcess();
  try { await plain.ready(); assert.strictEqual(plain.win(PAGES.pill).url, null); } finally { plain.close(); }
});

test("references: scripts, links and fonts beside the page; another host or outside the repo is null", () => {
  const r = references('<script src="../../../knobs.js"></script><link rel="x" href="a.css"><style>@font-face{src:url(../f.woff2)}</style><img src="https://x.example/a.png">', "src/a/b/p.html");
  assert.deepStrictEqual(r.map((x) => x.path), ["knobs.js", null, "src/a/b/a.css", "src/a/f.woff2"]);
  assert.strictEqual(references('<script src="../../../../x.js"></script>', "src/a/b/p.html")[0].path, null);
  assert.throws(() => verifyBundle(Buffer.from("{}"), null), /not a bundle/);
});
