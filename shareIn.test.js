// shareIn.js: files, a link or text dropped on the app window go to the
// share-in screen. The deciding parts are pure; at the foot, the page's drop
// handled end to end on a stand-in window.
const test = require("node:test");
const assert = require("node:assert");
const { planDrop, shareParams, sendDrop, install, acceptable } = require("./shareIn.js");

const file = (name, size = 1000) => ({ name, size });
/** A DataTransfer as a drop hands it over. */
function dt({ files = [], uris = "", text = "", items } = {}) {
  const types = [...(files.length ? ["Files"] : []), ...(uris ? ["text/uri-list"] : []), ...(text ? ["text/plain"] : [])];
  return {
    files, types,
    items: items || files.map(() => ({ kind: "file" })),
    getData: (t) => (t === "text/uri-list" ? uris : t === "text/plain" ? text : ""),
  };
}

test("only files, links and text are worth a drop", () => {
  assert.ok(acceptable(["Files"]));
  assert.ok(acceptable(["text/plain"]));
  assert.ok(!acceptable(["text/html"]));
  assert.ok(!acceptable([]));
});

test("a link dragged from a browser is the link; its words are kept", () => {
  assert.deepStrictEqual(planDrop(dt({ uris: "https://irctc.co.in/pnr\r\n", text: "https://irctc.co.in/pnr" })),
    { files: [], text: "", url: "https://irctc.co.in/pnr", skipped: 0, tooBig: false });
  const p = planDrop(dt({ text: "Dinner with Mom, Thursday 7" }));
  assert.strictEqual(p.text, "Dinner with Mom, Thursday 7");
  assert.strictEqual(p.url, "");
});

test("a file from Finder or Explorer is a file, not its path", () => {
  for (const text of ["/Users/aanya/Downloads/Ticket.pdf", "file:///Users/aanya/Downloads/Ticket.pdf", "C:\\Users\\aanya\\Ticket.pdf"]) {
    const p = planDrop(dt({ files: [file("Ticket.pdf")], uris: "file:///Users/aanya/Downloads/Ticket.pdf", text }));
    assert.deepStrictEqual({ n: p.files.length, text: p.text, url: p.url }, { n: 1, text: "", url: "" });
  }
});

test("at most five files, none over 50 MB; the rest are counted", () => {
  const p = planDrop(dt({ files: [file("a"), file("b", 60 * 1024 * 1024), file("c"), file("d"), file("e"), file("f"), file("g")] }));
  assert.deepStrictEqual(p.files.map((f) => f.name), ["a", "c", "d", "e"]);
  assert.strictEqual(p.skipped, 3);
  assert.strictEqual(p.tooBig, true);
});

test("the screen's params", () => {
  assert.deepStrictEqual(shareParams({ text: "", url: "" }, ["f1"]), { file: "f1" });
  assert.deepStrictEqual(shareParams({ text: "Hi", url: "https://x.in" }, ["f1", "f2"]), { file: "f1", files: "f1,f2", text: "Hi", url: "https://x.in" });
});

/** The file door, answering from a table by file name. */
function door(answers) {
  const sent = [];
  class FD { constructor() { this.parts = []; } append(k, v, n) { this.parts.push([k, v, n]); } }
  const fetch = async (url, o) => {
    const name = o.body.parts[0][2];
    sent.push({ url, auth: o.headers.Authorization, name });
    const a = answers[name] || { status: 201, body: { file: { id: `id-${name}` } } };
    if (a.throws) throw new Error("offline");
    return { ok: a.status < 300, status: a.status, json: async () => a.body };
  };
  return { sent, fetch, FormData: FD };
}
const WORDS = { failed: "Couldn't add that.", partly: "Some of it couldn't be added.", tooBig: "Over 50 MB." };

test("files go up one by one with the session, and the screen opens with every id", async () => {
  const d = door({});
  const opened = [], toasts = [];
  const out = await sendDrop({ files: [file("Ticket.pdf"), file("IMG_2041.jpg")], text: "For Goa", url: "", skipped: 0 }, {
    ...d, token: async () => "tok", baseUrl: () => "https://api.tailzu.space", open: (p) => opened.push(p), toast: (m) => toasts.push(m), words: WORDS,
  });
  assert.strictEqual(out, "opened");
  assert.deepStrictEqual(d.sent, [
    { url: "https://api.tailzu.space/v1/files", auth: "Bearer tok", name: "Ticket.pdf" },
    { url: "https://api.tailzu.space/v1/files", auth: "Bearer tok", name: "IMG_2041.jpg" },
  ]);
  assert.deepStrictEqual(opened, [{ file: "id-Ticket.pdf", files: "id-Ticket.pdf,id-IMG_2041.jpg", text: "For Goa" }]);
  assert.deepStrictEqual(toasts, []);
});

test("a refused file: the server's words, and the rest still opens", async () => {
  const d = door({ "IMG_1.HEIC": { status: 422, body: { code: "unsupported", message: "HEIC pictures are not supported yet." } } });
  const opened = [], toasts = [];
  await sendDrop({ files: [file("IMG_1.HEIC"), file("Ticket.pdf")], text: "", url: "", skipped: 0 }, {
    ...d, token: async () => "tok", baseUrl: () => "https://x", open: (p) => opened.push(p), toast: (m) => toasts.push(m), words: WORDS,
  });
  assert.deepStrictEqual(toasts, ["HEIC pictures are not supported yet."]);
  assert.deepStrictEqual(opened, [{ file: "id-Ticket.pdf" }]);
});

test("nothing could be added: say so, open nothing", async () => {
  const d = door({ "a.pdf": { throws: true } });
  const opened = [], toasts = [];
  const out = await sendDrop({ files: [file("a.pdf")], text: "", url: "", skipped: 0 }, {
    ...d, token: async () => null, baseUrl: () => "https://x", open: (p) => opened.push(p), toast: (m) => toasts.push(m), words: WORDS,
  });
  assert.strictEqual(out, "failed");
  assert.deepStrictEqual(toasts, ["Couldn't add that."]);
  assert.deepStrictEqual(opened, []);
});

// ------------------------------------------------------------------ the page, on a stand-in window

function el(tag) {
  const e = {
    tag, children: [], attrs: {}, style: {}, textContent: "", className: "", id: "",
    classList: {
      set: new Set(),
      add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); },
    },
    appendChild(c) { this.children.push(c); return c; },
    setAttribute(k, v) { this.attrs[k] = v; },
    closest: () => null,
  };
  return e;
}
function page(o = {}) {
  const on = {}, docOn = {};
  const d = door(o.answers || {});
  const doc = {
    head: el("head"), body: el("body"),
    createElement: el, createElementNS: (_ns, tag) => el(tag),
    addEventListener: (k, f) => { docOn[k] = f; },
  };
  const win = { addEventListener: (k, f) => { on[k] = f; }, fetch: d.fetch, FormData: d.FormData };
  const opened = [], toasts = [];
  install({
    window: win, document: doc, ready: () => o.ready ?? true, enabled: () => o.enabled ?? true, token: async () => "tok",
    baseUrl: () => "https://x", open: (p) => opened.push(p), toast: (m) => toasts.push(m), txt: (_k, f) => f,
  });
  const box = doc.body.children[0];
  const fire = (k, data, target = el("div")) => {
    let prevented = false;
    on[k]({ dataTransfer: data, target, relatedTarget: null, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  return { on, docOn, box, fire, opened, toasts, sent: d.sent };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

test("dragging a file over the window says Drop to send; letting go sends it and opens the screen", async () => {
  const p = page();
  const data = dt({ files: [file("Ticket.pdf")] });
  assert.ok(p.fire("dragenter", data));
  assert.ok(p.box.classList.contains("on"));
  const texts = JSON.stringify(p.box, (k, v) => (k === "set" ? [...v] : v));
  assert.ok(texts.includes("Drop to send") && texts.includes("A file"));
  assert.ok(p.fire("dragover", data));
  assert.ok(p.fire("drop", data));
  await settle(); await settle();
  assert.deepStrictEqual(p.sent.map((s) => s.name), ["Ticket.pdf"]);
  assert.deepStrictEqual(p.opened, [{ file: "id-Ticket.pdf" }]);
  assert.ok(!p.box.classList.contains("on"));
});

test("signed out, or the Bots app off: the window takes no drop", () => {
  for (const o of [{ ready: false }, { enabled: false }]) {
    const p = page(o);
    assert.strictEqual(p.fire("dragover", dt({ files: [file("a.pdf")] })), false);
    assert.ok(!p.box.classList.contains("on"));
  }
});

test("text dropped on a text field is the field's; a drag from this window is never a share", () => {
  const p = page();
  const field = el("input");
  field.closest = () => field;
  assert.strictEqual(p.fire("dragover", dt({ text: "hello" }), field), false);
  // A file onto the same field is still a share.
  assert.ok(p.fire("dragover", dt({ files: [file("a.pdf")] }), field));
  p.docOn.dragstart();
  assert.strictEqual(p.fire("dragover", dt({ text: "picked from the page" })), false);
});

test("dragging back out (or Esc) puts it away", () => {
  const p = page();
  p.fire("dragenter", dt({ uris: "https://x.in", text: "https://x.in" }));
  assert.ok(p.box.classList.contains("on"));
  p.fire("dragleave", null);
  assert.ok(!p.box.classList.contains("on"));
});
