// node --test
//
// The guards around the blocks: a person's words stay data all the way into actions.js, a screen that states no
// needs inherits nothing, nothing a paint wires outlives it, and every control can be named and reached.
const test = require("node:test");
const assert = require("node:assert");
const { fakePage } = require("../../testkit.js");

function paint(page, screen) {
  page.run("CURRENT_SCREEN = " + JSON.stringify(screen) + "; STATE = " + JSON.stringify(screen.state || {}) + ";");
  page.run('$("view").innerHTML = CURRENT_SCREEN.root ? node(CURRENT_SCREEN.root) : (CURRENT_SCREEN.blocks || []).map(node).join(""); v2After();');
}

test("words an expression hands to an action are never read as a $state token", async () => {
  const page = fakePage();
  page.run("var __bodies = []; api = async function (p, b) { __bodies.push(b); return {}; }; repaint = function () {}; paint = async function () {};");
  paint(page, { screenId: "n", needs: ["expr"], state: { draft: "$state.secret", secret: "s3cret" }, root: { type: "Text", props: { content: "x" } } });
  page.run('run({ kind: "setState", path: "echo", value: { $: "state.draft" } })');
  assert.strictEqual(page.run("STATE.echo"), "$state.secret");
  page.run('run({ kind: "callEndpoint", path: "/v1/notes", body: { text: { $: "state.draft" } } })');
  await page.settle();
  assert.deepStrictEqual(JSON.parse(page.run("JSON.stringify(__bodies)")), [{ text: "$state.secret" }]);
  // What the server wrote as a token still is one.
  page.run('run({ kind: "setState", path: "copy", value: "$state.secret" })');
  assert.strictEqual(page.run("STATE.copy"), "s3cret");
});

test("an action's onSuccess and a sequence's later steps are worked out when they run", async () => {
  const page = fakePage();
  page.run('api = async function () { return { id: "42" }; }; repaint = function () {}; paint = async function () {};');
  paint(page, { screenId: "a", needs: ["expr"], state: {}, root: { type: "Text", props: { content: "a" } } });
  page.run('run({ kind: "callEndpoint", path: "/v1/x", method: "GET", assignTo: "res", onSuccess: { kind: "setState", path: "id", value: { $: "state.res.id" } } })');
  await page.settle();
  assert.strictEqual(page.run("STATE.id"), "42");
  page.run('run({ kind: "sequence", actions: [{ kind: "setState", path: "a", value: 1 }, { kind: "setState", path: "b", value: { $: "state.a + 1" } }] })');
  await page.settle();
  assert.strictEqual(page.run("STATE.b"), 2);
});

test("a path an expression made is held to /v1/ like every other", async () => {
  const page = fakePage();
  page.run("var __asked = []; api = async function (p) { __asked.push(p); return {}; }; repaint = function () {};");
  paint(page, { screenId: "p", needs: ["expr"], state: { where: "/admin/users" }, root: { type: "Text", props: { content: "p" } } });
  page.run('run({ kind: "callEndpoint", path: { $: "state.where" }, method: "GET" })');
  await page.settle();
  assert.deepStrictEqual(JSON.parse(page.run("JSON.stringify(__asked)")), []);
});

test("a call kept for later goes into the outbox, not nowhere", async () => {
  const page = fakePage({ files: ["knobs.js", "botTiles.js", "botLooks.js", "sdui.js", "outbox.js"] });
  page.run("var __kept = []; outboxBox = function () { return { add(e) { __kept.push(e.path); return e; } }; }; outboxGo = async function () {};");
  paint(page, { screenId: "q", needs: ["data"], state: {}, root: { type: "Text", props: { content: "q" } } });
  page.run('run({ kind: "callEndpoint", path: "/v1/notes", body: { a: 1 }, queue: "outbox" })');
  await page.settle();
  assert.deepStrictEqual(JSON.parse(page.run("JSON.stringify(__kept)")), ["/v1/notes"]);
});

test("a screen drawn from blocks inherits nothing from a screen that had needs", async () => {
  const page = fakePage();
  paint(page, { screenId: "a", needs: ["expr"], state: {}, root: { type: "Text", props: { content: "a" } } });
  paint(page, { screenId: "b", state: { secret: "s3cret" }, blocks: [{ type: "Text", props: { content: { $: "state.secret" } } }] });
  assert.doesNotMatch(page.run('$("view").innerHTML'), /s3cret/);
});

test("a style value an expression made is a value, never more CSS", () => {
  const page = fakePage();
  paint(page, {
    screenId: "c", needs: ["expr"], state: { tag: "red;position:fixed;background-image:url(https://evil.test/p.png)", ok: "#ff0000" },
    root: { type: "Stack", style: { backgroundColor: { $: "state.tag" }, color: { $: "state.ok" } }, children: [] },
  });
  const style = page.run('$("view").firstElementChild.getAttribute("style")');
  assert.doesNotMatch(style, /url\(|position:fixed/);
  assert.match(style, /color:#ff0000/);
});

test("a gradient's direction is a direction, and nothing after it", () => {
  const page = fakePage();
  assert.strictEqual(page.run('v2Paint({ backgroundImage: "linear-gradient(to x);background-image:url(https://evil.test/p.png);--y:a, red, blue)" }).backgroundImage'), undefined);
  assert.strictEqual(page.run('v2Paint({ backgroundImage: "linear-gradient(to right, red, blue)" }).backgroundImage'), "linear-gradient(to right, red, blue)");
  assert.strictEqual(page.run('v2Paint({ backgroundImage: "radial-gradient(circle at center, red, blue)" }).backgroundImage'), "radial-gradient(circle at center, red, blue)");
});

test("listeners a paint puts on the view and the window are taken off by the next one", async () => {
  const page = fakePage();
  page.run("var __win = {}; window.addEventListener = function (t, f) { (__win[t] = __win[t] || []).push(f); }; window.removeEventListener = function (t, f) { __win[t] = (__win[t] || []).filter((x) => x !== f); };");
  const screen = {
    screenId: "feed", needs: ["expr", "list", "input", "shell"], state: { feed: [{ id: "a", n: "A" }] },
    root: { type: "Stack", children: [
      { type: "List", props: { data: { $: "state.feed" }, key: "id", item: { type: "Text", props: { content: { $: "item.n" } } } } },
      { type: "Stack", scrollInto: "sy", children: [] },
      { type: "Input", props: { kind: "slideToConfirm", into: "ok" } },
      { type: "Sheet", props: {}, children: [{ type: "Text", props: { content: "in" } }] },
    ] },
  };
  for (let i = 0; i < 4; i++) { paint(page, screen); await page.settle(); }
  assert.strictEqual(page.run('($("view").listeners.scroll || []).length'), 2);
  assert.strictEqual(page.run("(__win.pointermove || []).length"), 2);
  paint(page, { screenId: "plain", state: {}, root: { type: "Text", props: { content: "plain" } } });
  await page.settle();
  assert.strictEqual(page.run('($("view").listeners.scroll || []).length'), 0);
  assert.strictEqual(page.run("(__win.pointermove || []).length"), 0);
});

test("a loop is stopped by the next paint and never uses up the entrances' ceiling", async () => {
  const page = fakePage();
  page.run('(function () { const El = $("view").constructor; El.prototype.animate = function (f, o) { const a = { cancel() { a.cancelled = true; } }; a.finished = o.iterations === Infinity ? new Promise(() => {}) : Promise.resolve(); (window.__anims = window.__anims || []).push(a); return a; }; })();');
  const screen = { screenId: "m", needs: ["motion"], state: {}, root: { type: "Text", motion: { loop: { opacity: { k: [[0, 0.5], [1, 1]], loop: true } } }, props: { content: "pulse" } } };
  for (let i = 0; i < 70; i++) { paint(page, screen); await page.settle(); }
  assert.strictEqual(page.run("V2_MOTION_LIVE"), 0);
  assert.strictEqual(page.run("__anims.filter((a) => !a.cancelled).length"), 1);
});

test("an overlay bound to nothing closes and stays closed, and a toast's clock is not restarted by a repaint", async () => {
  const page = fakePage();
  const screen = { screenId: "t", needs: ["shell"], state: {}, root: { type: "Stack", children: [{ type: "Toast", props: { ms: 1000 }, children: [{ type: "Text", props: { content: "Saved" } }] }] } };
  page.run("V2.clock = () => performance.now();");
  page.run("CURRENT_SCREEN = " + JSON.stringify(screen) + "; STATE = {}; repaint._target = null;");
  page.run("repaint()");
  await page.settle();
  page.tick(600); page.run("repaint()"); await page.settle();
  page.tick(600); await page.settle();
  assert.doesNotMatch(page.run('$("view").innerHTML'), /Saved/);
  page.tick(3000); await page.settle();
  assert.doesNotMatch(page.run('$("view").innerHTML'), /Saved/);
});

test("a control made of several buttons is a named group, and each button has its own name", () => {
  const page = fakePage();
  paint(page, { screenId: "i", needs: ["input"], state: { n: 5 }, root: { type: "Input", props: { kind: "stepper", label: "Guests", into: "n" } } });
  const html = page.run('$("view").innerHTML');
  assert.match(html, /^<div[^>]*role="group"[^>]*aria-label="Guests"/);
  assert.doesNotMatch(html, /<label/);
  assert.match(html, /aria-label="Less"/);
  assert.match(html, /aria-label="More"/);
});

test("slide to confirm can be done from the keyboard", () => {
  const page = fakePage();
  page.run('CURRENT_ACTIONS = {};');
  paint(page, { screenId: "s", needs: ["input"], state: {}, root: { type: "Input", props: { kind: "slideToConfirm", into: "ok" } } });
  const thumb = page.run('$("view").querySelector("[data-v2-f]")');
  assert.strictEqual(thumb.getAttribute("tabindex"), "0");
  thumb.key("Enter");
  assert.strictEqual(page.run("STATE.ok"), true);
});

test("local values written before a sign-in by code are not served to the account that signs in", () => {
  const page = fakePage();
  page.run("var __ls = {}; localStorage = window.localStorage = { get length() { return Object.keys(__ls).length; }, key(i) { return Object.keys(__ls)[i]; }, getItem(k) { return k in __ls ? __ls[k] : null; }, setItem(k, v) { __ls[k] = String(v); }, removeItem(k) { delete __ls[k]; } };");
  page.g.atob = (s) => Buffer.from(s, "base64").toString();
  page.run("SESSION = null;");
  assert.strictEqual(page.run("v2LocalSet('hint.seen', true)"), "");
  const token = "h." + Buffer.from(JSON.stringify({ sub: "user-B" })).toString("base64") + ".s";
  page.run("SESSION = { access_token: " + JSON.stringify(token) + " };");
  assert.strictEqual(page.run("JSON.stringify(v2LocalAll())"), "{}");
  page.run("v2LocalSet('hint.seen', true)");
  assert.deepStrictEqual(Object.keys(page.run("__ls")).sort(), ["tailzu.local.user-B.hint.seen", "tailzu.local.who"]);
});

test("a sound's address an expression made is not read as a $state token either", async () => {
  const page = fakePage();
  // The window's own media actions, as app.html loads them after sdui/ ("media.js" names two scripts, so this one
  // is read by its path).
  page.run(require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "..", "media.js"), "utf8"));
  page.run("var __urls = []; mediaSource = function (u) { __urls.push(u); return null; };");
  paint(page, {
    screenId: "snd", needs: ["expr"], state: { tune: "/v1/sound?q=$state.secret", secret: "s3cret" },
    root: { type: "Text", props: { content: "s" } },
  });
  page.run('run({ kind: "playAudio", url: { $: "state.tune" } })');
  await page.settle();
  assert.deepStrictEqual(JSON.parse(page.run("JSON.stringify(__urls)")), ["/v1/sound?q=$state.secret"]);
});

test("a screen drawn from blocks also stops what the v2 screen before it left running", async () => {
  const page = fakePage();
  page.run("var __win = {}; window.addEventListener = function (t, f) { (__win[t] = __win[t] || []).push(f); }; window.removeEventListener = function (t, f) { __win[t] = (__win[t] || []).filter((x) => x !== f); };");
  page.run('(function () { const El = $("view").constructor; El.prototype.animate = function (f, o) { const a = { cancel() { a.cancelled = true; } }; a.finished = o.iterations === Infinity ? new Promise(() => {}) : Promise.resolve(); (window.__anims = window.__anims || []).push(a); return a; }; })();');
  paint(page, {
    screenId: "live", needs: ["expr", "motion", "input"], state: {},
    root: { type: "Stack", children: [
      { type: "Text", motion: { loop: { opacity: { k: [[0, 0.5], [1, 1]], loop: true } } }, props: { content: "pulse" } },
      { type: "Input", props: { kind: "slideToConfirm", into: "ok" } },
    ] },
  });
  await page.settle();
  assert.strictEqual(page.run("(__win.pointermove || []).length"), 1);
  assert.strictEqual(page.run("__anims.filter((a) => !a.cancelled).length"), 1);
  paint(page, { screenId: "old", state: {}, blocks: [{ type: "Text", props: { content: "plain" } }] });
  await page.settle();
  assert.strictEqual(page.run("(__win.pointermove || []).length"), 0);
  assert.strictEqual(page.run("__anims.filter((a) => !a.cancelled).length"), 0);
});

test("a style value an expression made inside a then/else pick is checked as well", () => {
  const page = fakePage();
  paint(page, {
    screenId: "pick", needs: ["expr"],
    state: { on: true, tag: "red;position:fixed;inset:0;z-index:999;background-image:url(https://evil.test/p.png)" },
    root: { type: "Stack", style: { backgroundColor: { truthy: "state.on", then: { $: "state.tag" }, else: "#000" } }, children: [] },
  });
  const style = page.run('$("view").firstElementChild.getAttribute("style")');
  assert.doesNotMatch(style, /url\(|position:fixed/);
});

test("Escape closes the topmost overlay, whatever its open is bound to", async () => {
  const page = fakePage();
  const screen = {
    screenId: "esc", needs: ["shell"], state: {},
    root: { type: "Stack", children: [{ type: "Sheet", props: {}, children: [{ type: "Text", props: { content: "inside" } }] }] },
  };
  page.run("CURRENT_SCREEN = " + JSON.stringify(screen) + "; STATE = {}; repaint._target = null;");
  page.run("repaint()");
  await page.settle();
  assert.match(page.run('$("view").innerHTML'), /inside/);
  page.run('$("view").querySelector("[data-v2-sheet]")').key("Escape");
  await page.settle();
  assert.doesNotMatch(page.run('$("view").innerHTML'), /inside/);
});

test("a colour prop an expression made cannot add a declaration of its own", () => {
  const page = fakePage();
  paint(page, {
    screenId: "pill", needs: ["expr"], state: { tag: "red;position:fixed;inset:0;background-image:url(https://evil.test/p.png)" },
    root: { type: "SwipeAction", props: { label: "Talk", background: { $: "state.tag" }, weight: '700" onmouseover="x' } },
  });
  const style = page.run('$("view").firstElementChild.getAttribute("style")');
  assert.doesNotMatch(style, /url\(|position:fixed/);
  assert.doesNotMatch(page.run('$("view").innerHTML'), /onmouseover/);
});
