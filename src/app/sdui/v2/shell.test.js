// node --test
//
// The shell as trees, and the media nodes: what is drawn, what is dismissed, and what this window says it cannot do.
const test = require("node:test");
const assert = require("node:assert");
const { fakePage } = require("../../testkit.js");

function paint(screen) {
  const page = fakePage();
  page.run("var __ran = []; run = function (a) { __ran.push(a && a.kind ? a.kind : a); }; repaint = function () { __ran.push('repaint'); };");
  page.run("CURRENT_SCREEN = " + JSON.stringify(screen) + "; STATE = " + JSON.stringify(screen.state || {}) + ";");
  page.run('$("view").innerHTML = node(CURRENT_SCREEN.root); v2WireIn($("view"));');
  return { page, ran: () => JSON.parse(page.run("JSON.stringify(__ran)")), html: () => page.run('$("view").innerHTML') };
}

test("a sheet is drawn at the detent it asked for, and nothing is drawn while it is shut", () => {
  const open = paint({
    screenId: "sheet", needs: ["shell"],
    root: { type: "Sheet", props: { open: true, detents: ["small", "large"], initial: 1 }, children: [{ type: "Text", props: { content: "inside" } }] },
  });
  assert.match(open.html(), /height:90vh/);
  assert.match(open.html(), /inside/);
  const shut = paint({
    screenId: "sheet2", needs: ["shell"],
    root: { type: "Sheet", props: { open: false }, children: [{ type: "Text", props: { content: "inside" } }] },
  });
  assert.doesNotMatch(shut.html(), /inside/);
});

test("the backdrop dismisses a sheet, and a modal that says it may not is left alone", () => {
  const sheet = paint({
    screenId: "sheet", needs: ["shell"],
    root: { type: "Sheet", props: { open: true }, on: { onDismiss: { kind: "setState", path: "open", value: false } }, children: [] },
  });
  sheet.page.run('$("view").querySelector("[data-v2-shell]").click()');
  assert.deepStrictEqual(sheet.ran(), ["setState"]);
  const modal = paint({
    screenId: "modal", needs: ["shell"],
    root: { type: "Modal", props: { open: true, dismissible: false }, on: { onDismiss: { kind: "setState" } }, children: [] },
  });
  modal.page.run('$("view").querySelector("[data-v2-shell]").click()');
  assert.deepStrictEqual(modal.ran(), []);
});

test("a toast goes by itself, after the time it was given", () => {
  const t = paint({
    screenId: "toast", needs: ["shell"],
    root: { type: "Toast", props: { open: true, ms: 1200 }, on: { onDismiss: { kind: "setState" } }, children: [{ type: "Text", props: { content: "saved" } }] },
  });
  assert.match(t.html(), /saved/);
  t.page.tick(1000);
  assert.deepStrictEqual(t.ran(), []);
  t.page.tick(400);
  assert.deepStrictEqual(t.ran(), ["setState"]);
});

test("a clip plays from https and nowhere else", () => {
  const ok = paint({
    screenId: "clip", needs: ["media"],
    root: { type: "Video", props: { source: "https://x0bot.com/a.mp4", loop: true } },
  });
  assert.match(ok.html(), /<video[^>]+src="https:\/\/x0bot.com\/a.mp4"/);
  assert.match(ok.html(), /loop/);
  const no = paint({
    screenId: "clip2", needs: ["media"],
    root: { type: "Video", props: { source: "file:///etc/passwd" }, fallback: { type: "Text", props: { content: "no clip" } } },
  });
  assert.match(no.html(), /no clip/);
});

test("a player writes what it is doing where the screen asked", () => {
  const v = paint({
    screenId: "clip", needs: ["media"], state: {},
    root: { type: "Video", props: { source: "https://x0bot.com/a.mp4", into: { playing: "clip.playing", ended: "clip.ended" } } },
  });
  const el = v.page.run('$("view").querySelector("[data-v2-media]")');
  el.dispatchEvent(new v.page.dom.Ev("play"));
  assert.strictEqual(v.page.run("STATE.clip.playing"), true);
  el.dispatchEvent(new v.page.dom.Ev("ended"));
  assert.strictEqual(v.page.run("STATE.clip.ended"), true);
  assert.strictEqual(v.page.run("STATE.clip.playing"), false);
});

test("a Camera is not drawn here: the window says so instead of pretending", () => {
  const cam = paint({
    screenId: "scan", needs: ["media"],
    root: { type: "Camera", props: { mode: "scan" }, fallback: { type: "Text", props: { content: "scan on your phone" } } },
  });
  assert.match(cam.html(), /scan on your phone/);
});
