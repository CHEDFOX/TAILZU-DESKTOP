// The building blocks this window has, and the gate that decides whether a screen may use them.
//
// A screen says what it needs (`needs: ["expr", "list"]`). Every block is OFF for a screen that says nothing, so
// every screen that exists today draws exactly as it did before this file was added. A screen that needs a block
// this build has not got is not lowered into something smaller — it draws its own fallback, or the short
// "Update X0" card below (pure SPEC 2.0 principle 6, 2.12).

/** What this window really implements, in the kernel's own order. Nothing is named here that is not drawn. */
const V2_BLOCKS = [
  "expr", "defs", "rules", "device", "local", "paint", "motion", "gesture", "list", "input", "media", "data", "shell",
  // One of our own calls (TAILZU-BACKEND/docs/rooms.md). Electron has WebRTC of its own, so unlike the phone there is nothing to
  // load and nothing to check: the window can always hold a call.
  "call",
];

/** The one place the v2 half keeps what it is doing for the screen that is up. */
const V2 = {
  on: false,          // this screen stated `needs` and we have them all
  screenId: "",       // the screen the rest of this object belongs to
  needs: [],
  defs: null,
  missing: [],        // blocks this screen needs and this build has not got
  bad: [],            // expressions, rules or props that were refused, for the handshake report
  ui: {},             // what a gesture or a scroll last wrote, read as `ui.*`
  ops: 0,             // expression operations spent since the last paint (LIMITS.opsPerChange)
  pending: false,     // a paint is on its way: v2After() runs once it has landed
};

/** The clock the rules run on. A test moves it by setting `V2.clock`; the window never does. */
function v2Now() {
  return typeof V2.clock === "function" ? V2.clock() : Date.now();
}

/** The generated kernel (sdui/kernel.js), or null in a page that did not load it. */
function v2Kernel() {
  return (typeof window !== "undefined" && window.TailzuKernel) || null;
}

/** A block the server turned off for everyone (`sdui.off`), or the whole lot in safe mode (`sdui.safe`). */
function v2Off(name) {
  if (K.bool("sdui.safe", false)) return true;
  const off = K.list("sdui.off", []);
  return Array.isArray(off) && off.indexOf(name) !== -1;
}

/** The blocks this window declares in the handshake: what it has, less what a kill switch turned off. */
function v2Declared() {
  if (!v2Kernel()) return [];
  return V2_BLOCKS.filter((b) => !v2Off(b));
}

/** What a screen says it needs, as a list of names. Anything else (no `needs`, a bad shape) is "nothing". */
function v2Needs(screen) {
  const n = screen && screen.needs;
  return Array.isArray(n) ? n.filter((x) => typeof x === "string" && x) : [];
}

/** The blocks a screen needs that this build cannot give it. Empty means it can be drawn. */
function v2MissingFor(screen) {
  const k = v2Kernel();
  const needs = v2Needs(screen);
  if (!needs.length) return [];
  if (!k) return needs.slice();
  return k.missingBlocks(v2Declared(), needs);
}

/** True when this screen asked for `name` and it is on. Every block is off for a screen that did not ask. */
function v2Has(name) {
  return V2.on && V2.needs.indexOf(name) !== -1 && !v2Off(name);
}

/**
 * The screen a client without the blocks gets instead (SPEC 2.12). The server sends its own `fallback` tree
 * whenever it can; this is the floor for when it did not, so a screen is never simply blank.
 */
function v2GateHtml(missing) {
  const line = K.txt("desktop.blocks.update", "Update X0 to see this.");
  const why = K.txt("desktop.blocks.missing", "This page needs {blocks}, which this version doesn't have yet.",
    { blocks: missing.join(", ") });
  const link = K.str("desktop.blocks.downloadUrl", "");
  return '<div class="pad"><p style="color:var(--text)">' + esc(line) + "</p>" +
    '<p style="color:var(--label);font-size:13px">' + esc(why) + "</p>" +
    (link ? '<p><a href="#" data-v2-get="' + esc(link) + '" style="color:var(--accent)">' +
      esc(K.txt("desktop.blocks.download", "Download the new version")) + "</a></p>" : "") + "</div>";
}
