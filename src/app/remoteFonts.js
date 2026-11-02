// FACES THE BACKEND SUPPLIES, loaded at run time (the phone's sdui/remoteFonts.ts, for the window).
//
// The window only had the faces its installer carried (assets/fonts, app.html's @font-face), so a new face meant
// a new installer. The bootstrap's `fonts` ({ "Tailzu-Display": "https://…/display.woff2", … }) now reach it too:
// each is registered under its own name, so a page can ask for it by fontFamily. The bundled faces stay, and are
// what draws until a face is ready, and whenever one cannot be had.
//
// The same three rules as the phone's: it never blocks (the page draws in the face it has meanwhile); a failure is
// per face and silent; only https, and only a font file. The bytes are fetched (connect-src) and handed to the page
// as data (a FontFace from an ArrayBuffer), so the window's own font-src stays its own files.
//
// Loaded after sdui.js (its knobs, K); sdui.js hands it every bootstrap it receives (received()).
/* global K */
/* eslint-env browser */

/** Every type the window can take as a font. The ceiling: the server may narrow it, never widen it. */
const DESK_FONT_TYPES = ["ttf", "otf", "woff", "woff2"];
const DESK_FONTS = new Set();

/** A plausible font: a short plain name, https, a font extension. */
function deskFontUsable(name, url) {
  if (!name || name.length > K.num("fonts.maxNameLength", 64) || !/^[A-Za-z0-9 _-]+$/.test(name)) return false;
  if (!/^https:\/\//i.test(url)) return false;
  const allowed = K.list("fonts.extensions", ["ttf", "otf", "woff", "woff2"])
    .map((e) => String(e).toLowerCase()).filter((e) => DESK_FONT_TYPES.indexOf(e) !== -1);
  const m = /\.([a-z0-9]+)(\?|$)/i.exec(url);
  return allowed.indexOf(m ? m[1].toLowerCase() : "") !== -1;
}

/** Register whatever the backend sent. Safe on every bootstrap: a face already loaded or loading is skipped. */
function deskLoadFonts(fonts) {
  if (!fonts || typeof fonts !== "object" || Array.isArray(fonts) || !K.bool("fonts.remote", true)) return;
  if (typeof FontFace !== "function" || !document.fonts) return;
  const most = K.num("fonts.maxBytes", 4194304);
  for (const name of Object.keys(fonts).slice(0, 40)) {
    const url = String(fonts[name] || "");
    if (DESK_FONTS.has(name) || !deskFontUsable(name, url)) continue;
    DESK_FONTS.add(name);
    fetch(url, { credentials: "omit" })
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((buf) => {
        if (!buf || !buf.byteLength || buf.byteLength > most) throw new Error("not a font we take");
        return new FontFace(name, buf).load();
      })
      .then((face) => { document.fonts.add(face); })
      // One bad face costs nothing but itself; a later bootstrap may try it again.
      .catch(() => { DESK_FONTS.delete(name); });
  }
}

if (typeof module === "object" && module && module.exports) module.exports = { deskFontUsable, deskLoadFonts };
