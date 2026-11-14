// node --test
//
// What a screen means: `$` values and `$t` text, templates, conditions, and the one rule everything else rests on —
// a bare string is the person's own words and is never looked at for holes.
const test = require("node:test");
const assert = require("node:assert");
const { fakePage } = require("../../testkit.js");

function drawn(page, screen) {
  page.run("CURRENT_SCREEN = " + JSON.stringify(screen) + "; STATE = " + JSON.stringify(screen.state || {}) + ";");
  return page.run("node(CURRENT_SCREEN.root)");
}

test("a `$t` text is filled from state and a `$` value lands on the style", () => {
  const page = fakePage();
  const html = drawn(page, {
    screenId: "done", needs: ["expr"], state: { done: [1, 2], items: [1, 2, 3], busy: true },
    root: {
      type: "Stack", style: { opacity: { $: "state.busy ? 0.4 : 1" } },
      children: [{ type: "Text", props: { content: { $t: "{{ count(state.done) }} of {{ count(state.items) }} done" } } }],
    },
  });
  assert.match(html, /2 of 3 done/);
  assert.match(html, /opacity:0\.4/);
});

test("user text is never a template, whatever it holds", () => {
  const page = fakePage();
  const html = drawn(page, {
    screenId: "note", needs: ["expr"], state: { title: "{{ state.secret }}", secret: "s3cret" },
    root: { type: "Text", props: { content: { $: "state.title" } } },
  });
  // The title is drawn as the characters it holds; the secret it names is nowhere near the page.
  assert.match(html, /\{\{ state.secret \}\}/);
  assert.doesNotMatch(html, /s3cret/);
});

test("a bare string prop holding holes is drawn as it was written", () => {
  const page = fakePage();
  const html = drawn(page, {
    screenId: "note", needs: ["expr"], state: { secret: "s3cret" },
    root: { type: "Text", props: { content: "{{ state.secret }}" } },
  });
  assert.match(html, /\{\{ state.secret \}\}/);
  assert.doesNotMatch(html, /s3cret/);
});

test("a condition written as an expression hides the node, and draws its fallback", () => {
  const page = fakePage();
  const screen = {
    screenId: "card", needs: ["expr"], state: { dismissed: true },
    root: {
      type: "Stack",
      children: [{
        type: "Text", visibleIf: { expr: "!state.dismissed" },
        props: { content: "the hint" }, fallback: { type: "Text", props: { content: "nothing to say" } },
      }],
    },
  };
  const html = drawn(page, screen);
  assert.doesNotMatch(html, /the hint/);
  assert.match(html, /nothing to say/);
  screen.state.dismissed = false;
  screen.screenId = "card2";
  assert.match(drawn(page, screen), /the hint/);
});

test("Use and Slot: one definition, drawn with its own arguments", () => {
  const page = fakePage();
  const html = drawn(page, {
    screenId: "rows", needs: ["expr", "defs"], state: { bot: { name: "Blip" } },
    defs: {
      "bot.row": {
        params: ["bot"],
        root: { type: "Stack", children: [{ type: "Text", props: { content: { $: "args.bot.name" } } }, { type: "Slot", name: "trail" }] },
      },
    },
    root: {
      type: "Use", def: "bot.row", args: { bot: { $: "state.bot" } },
      slots: { trail: { type: "Text", props: { content: "›" } } },
    },
  });
  assert.match(html, /Blip/);
  assert.match(html, /›/);
});

test("a definition that uses itself is refused, and the screen still draws", () => {
  const page = fakePage();
  const html = drawn(page, {
    screenId: "loop", needs: ["expr", "defs"],
    defs: { a: { root: { type: "Use", def: "a" } } },
    root: { type: "Text", props: { content: "still here" } },
  });
  assert.match(html, /still here/);
  assert.ok(JSON.parse(page.run("JSON.stringify(V2.bad)")).some((b) => b.indexOf("defs") === 0));
});

test("`bind` written as an expression is a value, and a bare string in it is still a path", () => {
  const page = fakePage();
  const expr = drawn(page, {
    screenId: "bound", needs: ["expr"], state: { n: 7 },
    root: { type: "Text", props: { cls: "d-line" }, bind: { content: { $: "state.n + 1" } } },
  });
  assert.match(expr, /8/);
  const path = drawn(page, {
    screenId: "bound2", needs: ["expr"], state: { words: "from the store" },
    root: { type: "Text", props: { cls: "d-line" }, bind: { content: "words" } },
  });
  assert.match(path, /from the store/);
});

test("an expression that is not in the language leaves the prop out and is reported", () => {
  const page = fakePage();
  const html = drawn(page, {
    screenId: "bad", needs: ["expr"],
    root: { type: "Text", props: { content: { $: "state.x = 1" } } },
  });
  assert.strictEqual(typeof html, "string");
  assert.ok(JSON.parse(page.run("JSON.stringify(V2.bad)")).length > 0);
});

test("device facts read the window, and `local` refuses a key that looks like a secret", () => {
  const page = fakePage();
  const facts = JSON.parse(page.run("JSON.stringify(v2Facts())"));
  assert.strictEqual(facts.platform, "desktop");
  assert.strictEqual(facts.sizeClass, "large");       // the test window is 1200 wide
  assert.strictEqual(facts.perm.camera, "unsupported");
  assert.deepStrictEqual(facts.canOpen, {});
  assert.match(page.run(`v2LocalSet("authToken", "x")`), /secret/);
});
