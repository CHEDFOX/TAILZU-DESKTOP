// Sign in with the phone (linkSignIn.js): the QR panel beside the sign-in form, without a browser. The page's three
// scripts run in one context, as app.html loads them, with a stand-in window, bridge, page and backend.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const TOKEN = "T".repeat(20) + "_-" + "t".repeat(21);
const SECRET = "S".repeat(43);
const QR = { size: 29, path: "M4 4h7v1h-7zM4 5h1v1h-1z" };

/** A page with the panel on screen and a backend that answers `answers` (each a function of the request). */
function page(o = {}) {
  const noop = () => {};
  const calls = [];
  const panel = { html: "", removed: false };
  const left = { textContent: "" };
  let styles = null;
  const g = {
    console: { warn: noop, log: noop, error: noop },
    setTimeout, clearTimeout, setInterval, clearInterval, Promise, JSON, Object, Array, String, Number, Math, Date, RegExp, Error,
    navigator: { language: "en-US" },
    innerWidth: 1280, innerHeight: 800, devicePixelRatio: 2,
    addEventListener: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop }),
    document: {
      hidden: !!o.hidden,
      addEventListener: noop,
      getElementById: (id) => (id === "gate" ? { hidden: false } : id === "d-qr-css" ? styles : null),
      querySelector: (sel) => (sel === "[data-link-panel]" ? (o.shown === false ? null : {
        set outerHTML(v) { panel.html = v; }, get outerHTML() { return panel.html; },
        previousElementSibling: null, remove() { panel.removed = true; },
      }) : sel === "[data-link-left]" ? left : null),
      querySelectorAll: () => [],
      createElement: () => ({}),
      head: { appendChild: (e) => { styles = e; } },
      activeElement: null,
    },
    fetch: async (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url, body, auth: init && init.headers && init.headers.Authorization });
      const answer = (o.answer || (() => ({ status: 404, json: {} })))(url, body, calls);
      const a = await answer;
      return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.json, text: async () => JSON.stringify(a.json), headers: { get: () => "application/json" } };
    },
    tailzuApp: {
      env: () => new Promise(() => {}),
      onKnobs: noop, onNavigate: noop, onDictated: noop, onNotes: noop,
      setSession: async (raw) => (raw ? { access_token: raw.access_token, expires_at: raw.expires_at } : null),
    },
  };
  g.window = g;
  const ctx = vm.createContext(g);
  for (const f of ["knobs.js", "sdui.js", "linkSignIn.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx, { filename: f });
  vm.runInContext("ENV = " + JSON.stringify({ baseUrl: "https://api.test", deviceName: "Aanya's MacBook Air", os: "mac" }), ctx);
  vm.runInContext("globalThis.__rendered = 0; render = async () => { globalThis.__rendered++; }", ctx);
  const run = (code) => vm.runInContext(code, ctx);
  return { g, ctx, run, calls, panel, left };
}
const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 3000) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error("timed out"); await settle(5); } };
const PROPS = { title: "Scan with your phone", sub: "Already use Tailzu there? No code to type.", steps: ["One", "Two", "Three"], typed: "Or type {code}", changesIn: "Code changes in {t}", renew: "Show a new code", denied: "Not approved on your phone." };
const draw = (p) => { p.ctx.__n = { type: "DeskLinkSignIn", props: PROPS }; return p.run("node(__n)"); };
const made = (o = {}) => ({ status: 200, json: { token: TOKEN, secret: SECRET, code: "K7Q4-2MXP", url: "https://app.x0bot.com/s/bots.link?l=" + TOKEN, qr: QR, expiresAt: 0, ttlMs: 300000, pollMs: 500, ...o } });
const isCreate = (url) => url === "https://api.test/v1/auth/link";
const isPoll = (url) => url === "https://api.test/v1/auth/link/poll";

test("drawn signed out, it asks for a request with this computer's name, and shows the QR and the code, never the secret", async () => {
  const p = page({ answer: (url) => (isCreate(url) ? made() : new Promise(() => {})) });
  const first = draw(p);
  assert.match(first, /class="d-qr-or"/);
  assert.match(first, /Making a code/);
  await until(() => p.run("LINK.state") === "waiting");
  assert.deepStrictEqual(p.calls[0], { url: "https://api.test/v1/auth/link", body: { deviceName: "Aanya's MacBook Air", platform: "mac" }, auth: undefined });
  const html = p.panel.html;
  assert.match(html, /<svg viewBox="0 0 29 29"/);
  assert.ok(html.includes('d="' + QR.path + '"'));
  assert.match(html, /Or type <b class="d-qr-code">K7Q4-2MXP<\/b>/);
  assert.match(html, /Code changes in [45]:\d\d/);
  assert.ok(!html.includes(SECRET), "the secret stays in memory");
  // The poll went out with the token and the secret, held on the server.
  await until(() => p.calls.some((c) => isPoll(c.url)));
  assert.deepStrictEqual(p.calls.find((c) => isPoll(c.url)).body, { token: TOKEN, secret: SECRET, wait: 25 });
  // Drawn again (a keystroke repaints the gate): the same request, no second one.
  draw(p);
  assert.strictEqual(p.calls.filter((c) => isCreate(c.url)).length, 1);
  p.run("linkReset()");
});

test("approved on the phone: the one-time sign-in becomes this window's session, then the app", async () => {
  let polls = 0;
  const p = page({
    answer: (url, body) => {
      if (isCreate(url)) return made();
      if (isPoll(url)) return ++polls === 1 ? { status: 200, json: { status: "pending", expiresAt: 0 } } : { status: 200, json: { status: "approved", tokenHash: "hashed-one-time", type: "magiclink" } };
      if (/\/auth\/v1\/verify$/.test(url)) return { status: 200, json: { access_token: "at", refresh_token: "rt", expires_at: 9999999999, body } };
      return { status: 404, json: {} };
    },
  });
  draw(p);
  await until(() => p.run("globalThis.__rendered") === 1);
  const verify = p.calls.find((c) => /\/auth\/v1\/verify$/.test(c.url));
  assert.deepStrictEqual(verify.body, { token_hash: "hashed-one-time", type: "magiclink" });
  assert.match(verify.url, /^https:\/\/[a-z0-9]+\.supabase\.co\/auth\/v1\/verify$/);
  assert.strictEqual(p.run("SESSION && SESSION.access_token"), "at");
  assert.strictEqual(p.run("LINK.state"), "idle");
  assert.strictEqual(polls, 2);
});

test("Not me on the phone: it says so, with a button for a new code", async () => {
  const p = page({ answer: (url) => (isCreate(url) ? made() : isPoll(url) ? { status: 200, json: { status: "denied" } } : { status: 404, json: {} }) });
  draw(p);
  await until(() => p.run("LINK.state") === "denied");
  assert.match(p.panel.html, /Not approved on your phone\./);
  assert.match(p.panel.html, /data-link-renew/);
  assert.strictEqual(p.run("SESSION"), null);
});

test("a server without it: the panel is left out", async () => {
  const p = page({ answer: () => ({ status: 404, json: { code: "link_off" } }) });
  draw(p);
  await until(() => p.run("LINK.state") === "off");
  assert.ok(p.panel.removed);
  assert.strictEqual(draw(p), "");
});

test("only a QR that is what it says is drawn; the code still works", async () => {
  const p = page({ answer: (url) => (isCreate(url) ? made({ qr: { size: 29, path: 'M1 1h1v1h-1z"/><script>x</script>' } }) : new Promise(() => {})) });
  draw(p);
  await until(() => p.run("LINK.state") === "waiting");
  assert.ok(!p.panel.html.includes("<script"));
  assert.ok(!p.panel.html.includes("<svg viewBox"));
  assert.match(p.panel.html, /K7Q4-2MXP/);
  p.run("linkReset()");
  // A request that is not one: no panel state built from it.
  const bad = page({ answer: (url) => (isCreate(url) ? made({ token: "../x" }) : new Promise(() => {})) });
  draw(bad);
  await until(() => bad.run("LINK.state") === "offline");
});

test("ran out: a new code while someone is looking; in a window in the back, the button instead", async () => {
  let creates = 0;
  const p = page({ answer: (url) => (isCreate(url) ? (++creates, made()) : isPoll(url) ? { status: 200, json: { status: "expired" } } : { status: 404, json: {} }) });
  draw(p);
  await until(() => creates >= 3);
  p.run("linkReset()");
  const away = page({ hidden: true, answer: (url) => (isCreate(url) ? made() : isPoll(url) ? { status: 200, json: { status: "expired" } } : { status: 404, json: {} }) });
  draw(away);
  await until(() => away.run("LINK.state") === "expired");
  assert.match(away.panel.html, /data-link-renew/);
  assert.strictEqual(away.calls.filter((c) => isCreate(c.url)).length, 1);
});

test("off the sign-in step (signed in some other way): the wait stops and nothing is taken", async () => {
  const p = page({ answer: (url) => (isCreate(url) ? made() : isPoll(url) ? { status: 200, json: { status: "pending", expiresAt: 0 } } : { status: 404, json: {} }) });
  draw(p);
  await until(() => p.run("LINK.state") === "waiting");
  p.run("SESSION = { access_token: 'x' }");
  await until(() => p.run("LINK.state") === "idle", 3000);
  const polls = p.calls.filter((c) => isPoll(c.url)).length;
  await settle(700);
  assert.strictEqual(p.calls.filter((c) => isPoll(c.url)).length, polls);
  assert.ok(!p.calls.some((c) => /\/auth\/v1\/verify$/.test(c.url)));
});
