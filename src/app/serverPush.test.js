// node --test
//
// What the server now sends that the window kept for itself (docs/server-push-audit.md in the backend): the faces the
// server supplies (remoteFonts.js).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const vm = require("node:vm");
const { pageFiles } = require("./testkit.js");

/** A page with the renderer's pieces that remoteFonts.js uses, and its file loaded into it. */
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
  for (const f of pageFiles(["remoteFonts.js"])) vm.runInContext(fs.readFileSync(f, "utf8"), ctx, { filename: f });
  return { ctx, handlers };
}

test("a face the server supplies: https, a plain name and a font file only", () => {
  const { ctx } = page({ api: {} });
  assert.ok(ctx.deskFontUsable("Tailzu Geist Bold", "https://api.example/fonts/geist-bold.woff2"));
  assert.ok(!ctx.deskFontUsable("Tailzu", "http://api.example/fonts/a.woff2"), "not https");
  assert.ok(!ctx.deskFontUsable("Tailzu", "https://api.example/fonts/a.js"), "not a font");
  assert.ok(!ctx.deskFontUsable("<x>", "https://api.example/fonts/a.ttf"), "not a plain name");
});
