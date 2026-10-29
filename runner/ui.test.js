// node --test
//
// The window's page script (ui.js) against a tiny fake page: it draws what main.js sends, puts everything from the server in as text (never
// markup), and sends back only the requests main.js checks.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class El {
  constructor(tag) { this.tag = tag; this.children = []; this._text = ""; this.className = ""; this.hidden = false; this.checked = false; this.listeners = {}; this.colSpan = 1; }
  set textContent(v) { this._text = String(v); if (v === "") this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(ev, f) { this.listeners[ev] = f; }
  walk(f) { f(this); for (const c of this.children) c.walk(f); }
}

function page(snapshot) {
  const ids = {};
  const document = { getElementById: (id) => (ids["#" + id] = ids["#" + id] || new El("#" + id)), createElement: (t) => new El(t) };
  const sent = [];
  const api = {
    state: async () => snapshot, set: async (k, v) => { sent.push(["set", k, v]); return snapshot; }, project: async (id, name, action) => { sent.push(["project", id, name, action]); return snapshot; },
    checkDocker: async () => { sent.push(["checkDocker"]); return snapshot; }, stop: () => sent.push(["stop"]), openAudit: () => sent.push(["openAudit"]), onUpdate: (f) => { api.update = f; },
  };
  const ctx = { window: { tailzuRunner: api }, document, Date, String, Array, Object, Number };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "ui.js"), "utf8"), ctx);
  return { ids, sent, api, ctx };
}

const snap = (over = {}) => ({
  status: { enabled: true, container: false, state: "online", pausedReason: "", project: "", working: false },
  projects: [{ id: "p1", name: "acme/app", state: "allowed" }, { id: "p2", name: "<img src=x onerror=alert(1)>", state: "ask" }, { id: "p3", name: "acme/no", state: "denied" }],
  activity: [{ id: 2, at: Date.now(), project: "acme/app", command: "npm test", state: "done", exitCode: 1, ms: 2500, refused: "" }, { id: 1, at: Date.now(), project: "acme/app", command: "sudo ls", state: "refused", exitCode: 126, ms: 0, refused: "sudo", message: "no sudo" }],
  power: { paused: false }, container: { on: false, image: "node:22-bookworm", docker: { installed: true, running: true, version: "27", reason: "", checked: true } },
  auditDir: "/x/audit", workspacesDir: "/x/workspaces", ...over,
});

test("it draws the switch, the state, the projects with what to do about each, and the commands with their exit codes", async () => {
  const p = page(snap());
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(p.ids["#enabled"].checked, true);
  assert.strictEqual(p.ids["#state"].textContent, "Online for X0 Code");
  assert.strictEqual(p.ids["#workingRow"].hidden, true);
  const names = []; p.ids["#projects"].walk((e) => { if (e.className === "name") names.push(e.textContent); });
  assert.deepStrictEqual(names, ["acme/app", "<img src=x onerror=alert(1)>", "acme/no"], "a server's text is text");
  const buttons = []; p.ids["#projects"].walk((e) => { if (e.tag === "button") buttons.push(e.textContent); });
  assert.deepStrictEqual(buttons, ["Don't allow", "Ask me again", "Allow", "Don't allow", "Allow", "Ask me again"]);
  const rows = p.ids["#activity"].children.map((tr) => tr.children.map((td) => td.textContent));
  assert.deepStrictEqual(rows.map((r) => [r[2], r[3], r[4]]), [["npm test", "1", "2.5 s"], ["sudo ls  - not run: no sudo", "refused", "0 ms"]]);
  assert.match(p.ids["#where"].textContent, /\/x\/workspaces/);
});

test("working shows what it works on, with Stop; paused says why; the container's Docker state is said", async () => {
  const p = page(snap({ status: { enabled: true, container: false, state: "working", pausedReason: "", project: "acme/app", working: true } }));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(p.ids["#working"].textContent, "X0 Bot is working on acme/app");
  assert.strictEqual(p.ids["#workingRow"].hidden, false);
  p.ids["#stop"].listeners.click();
  assert.deepStrictEqual(p.sent, [["stop"]]);
  p.api.update(snap({ status: { enabled: true, state: "paused", pausedReason: "battery_low", working: false }, container: { on: true, image: "node:22-bookworm", docker: { installed: false, running: false, version: "", reason: "Docker is not installed on this computer.", checked: true } } }));
  assert.strictEqual(p.ids["#state"].textContent, "Paused: the battery is under 20%");
  assert.match(p.ids["#dockerNote"].textContent, /Docker is not installed on this computer\. Nothing will run until/);
  assert.strictEqual(p.ids["#recheck"].hidden, false);
});

test("what the person clicks goes back as a request: the switch, the container, a project, the audit folder", async () => {
  const p = page(snap());
  await new Promise((r) => setImmediate(r));
  p.ids["#enabled"].listeners.change({ target: { checked: false } });
  p.ids["#container"].listeners.change({ target: { checked: true } });
  p.ids["#audit"].listeners.click();
  p.ids["#projects"].children[1].children.find((b) => b.textContent === "Allow").listeners.click();
  assert.deepStrictEqual(p.sent, [["set", "enabled", false], ["set", "container", true], ["openAudit"], ["project", "p2", "<img src=x onerror=alert(1)>", "allow"]]);
});
