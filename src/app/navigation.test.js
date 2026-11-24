// node --test
//
// Going places in the window (sdui/navigation.js, actions.js): the stack never grows into a walk Back has to retrace, a screen the
// sidebar opens is a place of its own, Back from a lone screen goes to its tab, Back shows the kept copy at once, and a call's
// answer that lands after the person moved on does nothing to the screen they moved to.
const test = require("node:test");
const assert = require("node:assert");
const { fakePage } = require("./testkit.js");

const screenOf = (id, params, extra) => ({ screenId: id, look: "bots", state: { params: params || {} }, root: { type: "Text", props: { content: id } }, ...(extra || {}) });

/** A page whose server answers screens (each fetch counted, optionally slow) and calls (held until released). */
function page(o = {}) {
  const fetched = [];
  const held = [];
  const p = fakePage({
    fetch: async (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : {};
      const json = (v) => ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => v, text: async () => JSON.stringify(v) });
      if (url.endsWith("/v1/app/screen")) {
        fetched.push(body.screenId);
        const wait = (o.slow || {})[body.screenId];
        if (wait) await new Promise((r) => setTimeout(r, wait));
        return json(screenOf(body.screenId, body.params, (o.extra || {})[body.screenId]));
      }
      // A call: answered when the test lets it go.
      return new Promise((resolve) => held.push(() => resolve(json({ id: "x1" }))));
    },
  });
  p.run("ENV = { baseUrl: 'https://api.test' }; SESSION = { access_token: 't' }; TABS = [{ id: 'talk', screenId: 'bots.talk' }, { id: 'activity', screenId: 'bots.activity' }]; TAB_ID = 'talk'; STACK = [{ screenId: 'bots.talk' }]");
  const stack = () => JSON.parse(p.run("JSON.stringify(STACK.map((e) => e.screenId + (e.params && e.params.slug ? ':' + e.params.slug : '')))"));
  const top = () => p.run("CURRENT_SCREEN && CURRENT_SCREEN.screenId");
  const act = async (a) => { p.ctx.__a = a; await p.run("run(__a)"); await p.settle(); };
  const tick = (ms) => new Promise((r) => setTimeout(r, ms));
  return { p, fetched, held, stack, top, act, tick };
}
const nav = (screenId, params, more) => ({ kind: "navigate", screenId, ...(params ? { params } : {}), ...(more || {}) });

test("a screen already in the stack is gone back to, not pushed again; the one up is not pushed twice", async () => {
  const w = page();
  await w.act(nav("bots.spaces"));
  await w.act(nav("bots.bot", { slug: "plan" }));
  await w.act(nav("bots.bot", { slug: "plan" }));
  assert.deepStrictEqual(w.stack(), ["bots.talk", "bots.spaces", "bots.bot:plan"], "a double click is one visit");
  await w.act(nav("bots.bot", { slug: "travel" }));
  await w.act(nav("bots.spaces"));
  assert.deepStrictEqual(w.stack(), ["bots.talk", "bots.spaces"], "back to Spaces, not Spaces again on top of the walk");
  assert.strictEqual(w.top(), "bots.spaces");
});

test("the sidebar's places (root) start afresh, like a tab; Back from a lone screen goes to its tab", async () => {
  const w = page();
  await w.act(nav("bots.spaces"));
  await w.act(nav("bots.bot", { slug: "plan" }, { root: true }));
  await w.act(nav("bots.settings", undefined, { root: true }));
  assert.deepStrictEqual(w.stack(), ["bots.settings"], "no walk through every bot clicked in the sidebar");
  await w.act({ kind: "navigateBack" });
  assert.deepStrictEqual(w.stack(), ["bots.talk"], "Settings' × goes home, not nowhere");
  assert.strictEqual(w.top(), "bots.talk");
});

test("a tab already up at its own page is not fetched again", async () => {
  const w = page();
  await w.act({ kind: "switchTab", tabId: "activity" });
  const n = w.fetched.length;
  await w.act({ kind: "switchTab", tabId: "activity" });
  assert.strictEqual(w.fetched.length, n);
});

test("Back shows the kept copy at once, and fetches it again behind it", async () => {
  const w = page({ slow: { "bots.spaces": 80 } });
  await w.act(nav("bots.spaces"));
  await w.tick(120);
  await w.act(nav("bots.bot", { slug: "plan" }));
  w.p.ctx.__a = { kind: "navigateBack" };
  w.p.run("run(__a)");
  assert.strictEqual(w.top(), "bots.spaces", "drawn before the slow fetch came back");
  await w.tick(120);
  assert.strictEqual(w.fetched.filter((s) => s === "bots.spaces").length, 2, "and fetched again behind it");
});

test("a screen the server says is never kept is fetched, not shown from a copy", async () => {
  const w = page({ slow: { "bots.approve": 60 }, extra: { "bots.approve": { cacheTtlSeconds: 0 } } });
  await w.act(nav("bots.approve"));
  await w.tick(100);
  await w.act(nav("bots.bot", { slug: "plan" }));
  w.p.ctx.__a = { kind: "navigateBack" };
  w.p.run("run(__a)");
  assert.strictEqual(w.top(), "bots.bot", "the old screen stays up until the fresh one lands");
  await w.tick(100);
  assert.strictEqual(w.top(), "bots.approve");
});

test("a call's answer that lands after the person moved on does not navigate them, nor write into the screen they moved to", async () => {
  const w = page();
  await w.act(nav("bots.spaces"));
  w.p.ctx.__a = { kind: "callEndpoint", method: "POST", path: "/v1/x", body: {}, assignTo: "made", onSuccess: nav("bots.bot", { slug: "made" }) };
  const pending = w.p.run("run(__a)");
  await w.act(nav("bots.settings"));
  w.held.forEach((f) => f());
  await pending;
  await w.p.settle();
  assert.deepStrictEqual(w.stack(), ["bots.talk", "bots.spaces", "bots.settings"], "still where they went");
  assert.strictEqual(w.p.run("STATE.made"), undefined, "nothing written into Settings' state");
});

test("a save whose onSuccess refreshes fetches the screen once, not twice", async () => {
  const w = page();
  await w.act(nav("bots.spaces"));
  const before = w.fetched.length;
  w.p.ctx.__a = { kind: "callEndpoint", method: "POST", path: "/v1/x", body: {}, onSuccess: { kind: "refresh" } };
  const pending = w.p.run("run(__a)");
  await w.tick(0);
  w.held.forEach((f) => f());
  await pending;
  await w.p.settle();
  assert.strictEqual(w.fetched.length - before, 1);
});

test("while the next screen is on its way, the one up takes no clicks", async () => {
  const w = page({ slow: { "bots.spaces": 60 } });
  await w.act(nav("bots.activity"));
  w.p.ctx.__a = nav("bots.spaces");
  w.p.run("run(__a)");
  assert.strictEqual(w.p.run("$('view').inert"), true);
  await w.tick(100);
  await w.p.settle();
  assert.strictEqual(w.p.run("$('view').inert"), false);
});
