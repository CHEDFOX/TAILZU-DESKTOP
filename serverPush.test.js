// node --test
//
// What the server now draws or sends that the window kept for itself (docs/server-push-audit.md in the backend):
// the runner's card on bots.computer (runnerCard.js) and the faces the server supplies (remoteFonts.js).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/** A page with sdui.js's pieces that runnerCard.js and remoteFonts.js use, and their files loaded into it. */
function page(o = {}) {
  const handlers = [];
  const ctx = {
    window: { tailzuApp: o.api },
    K: { num: (_k, f) => f, bool: (_k, f) => f, list: (_k, f) => f },
    esc: (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    label: (v) => (typeof v === "string" ? v : ""),
    bind: (a) => { handlers.push(a); return ' data-h="h' + (handlers.length - 1) + '"'; },
    repaint: () => { ctx.painted = (ctx.painted || 0) + 1; },
    CURRENT_SCREEN: null,
    findNode: () => null,
    console,
    Promise,
  };
  vm.createContext(ctx);
  for (const f of ["runnerCard.js", "remoteFonts.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx, { filename: f });
  return { ctx, handlers };
}

const WORDS = {
  title: "Tailzu Code on this computer", use: "Use this computer", safetyLead: "Off until you turn it on.", safety: "Safe.",
  stateOnline: "Online", stateWorking: "Working on {project}", allow: "Allow", deny: "Don't allow", askAgain: "Ask me again",
  badgeAsk: "Will ask", projects: "Projects", ran: "What it ran", nothingYet: "Nothing yet.", audit: "Open the log", workspaces: "Workspaces: {dir}",
  container: "Run in a container", containerNote: "Image {image}.", noProjects: "None yet.",
};

test("the runner's card: nothing until the main process answers, then its state in the server's words, names escaped", () => {
  let snap = null;
  const api = { runner: () => Promise.resolve(snap), onRunner: () => {} };
  const { ctx, handlers } = page({ api });
  assert.strictEqual(ctx.runnerNode(WORDS, ""), "", "no snapshot yet: nothing drawn");
  snap = {
    status: { enabled: true, state: "online" }, container: { on: false, image: "node:20", docker: {} },
    projects: [{ id: "p1", name: "<b>shop</b>", state: "ask" }],
    activity: [], workspacesDir: "/tmp/ws",
  };
  ctx.runnerTook(snap);
  const html = ctx.runnerNode(WORDS, "");
  assert.ok(html.includes("Online") && html.includes("Will ask") && html.includes("Image node:20.") && html.includes("Workspaces: /tmp/ws"));
  assert.ok(!html.includes("<b>shop</b>") && html.includes("&lt;b&gt;shop&lt;/b&gt;"), "a project's name is text, never markup");
  // Its buttons are the runner.* actions the main process checks.
  const kinds = handlers.map((a) => a.kind);
  assert.ok(kinds.includes("runner.set") && kinds.includes("runner.project") && kinds.includes("runner.openAudit"));
  const allow = handlers.find((a) => a.kind === "runner.project" && a.action === "allow");
  assert.deepStrictEqual({ id: allow.id, name: allow.name }, { id: "p1", name: "<b>shop</b>" });
});

test("the runner's buttons go to the main process, and its answer is drawn", async () => {
  const calls = [];
  const after = { status: { enabled: false, state: "off" }, container: {}, projects: [], activity: [], workspacesDir: "" };
  const api = {
    runner: () => Promise.resolve(null), onRunner: () => {},
    runnerSet: (k, v) => { calls.push(["set", k, v]); return Promise.resolve(after); },
    runnerProject: (id, name, action) => { calls.push(["project", id, name, action]); return Promise.resolve(null); },
    runnerStop: () => calls.push(["stop"]),
  };
  const { ctx } = page({ api });
  await ctx.runnerRun({ kind: "runner.set", key: "enabled", value: false });
  await ctx.runnerRun({ kind: "runner.project", id: "p1", name: "shop", action: "allow" });
  ctx.runnerRun({ kind: "runner.stop" });
  assert.deepStrictEqual(calls, [["set", "enabled", false], ["project", "p1", "shop", "allow"], ["stop"]]);
});

test("a face the server supplies: https, a plain name and a font file only", () => {
  const { ctx } = page({ api: {} });
  assert.ok(ctx.deskFontUsable("Tailzu Geist Bold", "https://api.example/fonts/geist-bold.woff2"));
  assert.ok(!ctx.deskFontUsable("Tailzu", "http://api.example/fonts/a.woff2"), "not https");
  assert.ok(!ctx.deskFontUsable("Tailzu", "https://api.example/fonts/a.js"), "not a font");
  assert.ok(!ctx.deskFontUsable("<x>", "https://api.example/fonts/a.ttf"), "not a plain name");
});
