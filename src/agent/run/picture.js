// The window's picture: the lines its OCR read, joined to the tree as elements
// of their own, and the part of it a question about something drawn sends.

const resolver = require("../resolver.js");
const { str, squash, clip, isFrame, treeOf } = require("./helpers.js");
const { ADDRESS_BAR, URL_LINE } = require("./screen.js");
const { titleOf } = require("./changes.js");

/** "The largest image" on screen has to be at least this big to be the
 *  picture: smaller is an icon or an avatar, and the window says more. */
const MIN_PICTURE = [120, 80];
/** The least a picture of one element is, in the look's own pixels, on each
 *  side: an icon on a big window, in a look brought down to fit, is a few
 *  pixels there, too small to crop (ask.js crop wants 8) or to make anything
 *  of. Its frame is grown about its middle to this. */
const MIN_CROP_PX = 32;

const areaOf = (f) => Math.max(0, f[2]) * Math.max(0, f[3]);

/** The part two frames share, or null when they do not. */
function intersect(a, b) {
  if (!isFrame(a) || !isFrame(b)) return null;
  const x = Math.max(a[0], b[0]);
  const y = Math.max(a[1], b[1]);
  const r = Math.min(a[0] + a[2], b[0] + b[2]);
  const btm = Math.min(a[1] + a[3], b[1] + b[3]);
  return r > x && btm > y ? [x, y, r - x, btm - y] : null;
}
const overlaps = (a, b) => !!intersect(a, b);
const contains = (f, p) => !!p && p.x >= f[0] && p.x <= f[0] + f[2] && p.y >= f[1] && p.y <= f[1] + f[3];

/** The look and the tree describe the same window: their frames are the same
 *  rectangle, give or take a border (a Windows frame's invisible edge, a
 *  shadow). Not the same, and the focus moved between the two reads: the
 *  lines would be placed in, and the picture taken of, another window.
 *  Every maximized window on a display has the same frame, so the titles
 *  are compared too when both reads have one (one may be the other cut
 *  short). */
function sameWindow(snap, look) {
  const ta = squash(titleOf(snap)).toLowerCase();
  const tb = squash(str(look && look.window && look.window.title).slice(0, 200)).toLowerCase();
  if (ta && tb && !ta.startsWith(tb) && !tb.startsWith(ta)) return false;
  const a = snap && snap.window && snap.window.frame;
  const b = look && look.window && look.window.frame;
  if (!isFrame(a) || !isFrame(b)) return !isFrame(a);
  const both = intersect(a, b);
  const union = areaOf(a) + areaOf(b) - (both ? areaOf(both) : 0);
  return !!both && union > 0 && areaOf(both) / union >= 0.8;
}

/** Text as two readings of the same words compare: case and spaces do not
 *  count, nor which dash or quote mark it was read with (OCR reads an em
 *  dash in a title as a hyphen, a curly quote as a straight one). */
const textKey = (s) => squash(s).replace(/\s+/g, "").toLowerCase()
  .replace(/[\u2010-\u2015\u2212]/g, "-").replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'").replace(/[\u201c-\u201f\u2033]/g, "\"");
const sameText = (a, b) => textKey(a) === textKey(b);
/** A line of OCR over a tree element that scores this much against its label
 *  (resolver.labelScore) is that label read again, a letter misread or a mark
 *  beside it ("Exp0rt", "Export..." for "Export…", "Name:"). Left in, the two
 *  tie for any question that names it, and nothing is pointed at. The
 *  resolver's own bar for a word spelled within a letter. */
const READ_AGAIN = 0.8;

const isAddressBar = (e) => (e.role === "field" || e.role === "combo") && ADDRESS_BAR.test(squash(e.label));

/** The window's title as both reads have it, compared the way OCR text is. */
const titleKeys = (snap, look) => [titleOf(snap), str(look && look.window && look.window.title)]
  .map((t) => textKey(squash(t).slice(0, 200)))
  .filter(Boolean);

/** A line of OCR that is the window's title. A title the window shows cut
 *  short ("Q3 budget — Confid…", or "..." as OCR reads an ellipsis) is part
 *  of it; a line that runs the title together with the toolbar beside it
 *  ("AutoSave Q3 budget.xlsx - Excel Search") still carries it. */
function isTitleLine(text, titles) {
  const key = textKey(text);
  if (!key) return false;
  const cut = key.replace(/(?:…|\.{2,})$/, "");
  return titles.some((t) => t === key || (cut.length >= 8 && t.includes(cut)) || (t.length >= 8 && key.includes(t)));
}

/**
 * The look's OCR lines as elements o1…oN (role "text", the line as label, its
 * frame, ocr: true), to go after the tree's. Left out:
 *
 *   a line that says what a tree element over it already says — the button's
 *   own label, read twice, as near as OCR reads it (READ_AGAIN);
 *   anything over a password field, which may be showing the password, and
 *   over an address bar, the URL whose value the tree keeps to itself;
 *   the window's title, which never leaves this computer, however it is read.
 */
function ocrElements(snap, look) {
  if (!look || look.ok !== true || !Array.isArray(look.lines)) return [];
  const tree = treeOf(snap).filter((e) => isFrame(e.frame));
  const guarded = tree.filter((e) => e.secure === true || isAddressBar(e)).map((e) => e.frame);
  const titles = titleKeys(snap, look);
  const out = [];
  for (const line of look.lines) {
    if (!line || !isFrame(line.frame) || line.frame[2] <= 0 || line.frame[3] <= 0) continue;
    const text = clip(squash(line.text), 120);
    if (!text) continue;
    if (isTitleLine(text, titles)) continue;
    if (guarded.some((f) => overlaps(f, line.frame))) continue;
    if (tree.some((e) => e.label && overlaps(e.frame, line.frame)
      && (sameText(e.label, text) || resolver.labelScore(text, e.label) >= READ_AGAIN))) continue;
    out.push({ id: "o" + (out.length + 1), role: "text", label: text, frame: line.frame.slice(), ocr: true });
  }
  return out;
}

// Containers that can hold a picture the tree has no word for: a canvas, a
// chart drawn in a cell, a diagram in a web page's region.
const PICTURE_HOLDERS = new Set(["group", "area", "cell"]);

/**
 * The part of the window the question is about, as { frame, region }:
 *
 *   the image (or a big, wordless group, area or cell) under the pointer —
 *   "what's this?" said while pointing at it; the smallest, if they nest;
 *   else the largest image on screen, if it is at least MIN_PICTURE;
 *   else the whole window.
 *
 * Frames are kept to the window's, which is all the picture has, below its
 * own chrome (chromeBottom): the title and the page's address never leave as
 * text, and do not leave drawn in a picture either. An element too small to
 * see in the look's picture is grown about its middle to MIN_CROP_PX of it
 * (within the same bounds): cropped as it was, an icon on a 4K window was
 * nothing, and the whole window used to go in its place.
 */
function pictureRegion(screen, look, pointer) {
  const whole = look.window.frame;
  const top = chromeBottom(screen, look);
  const below = [whole[0], top, whole[2], whole[1] + whole[3] - top];
  // A window that is all chrome (a toolbar, a title bar) has nothing below
  // it worth a picture; what there is goes as it is.
  const win = below[3] >= MIN_PICTURE[1] ? below : whole;
  const im = look.image;
  const per = (n, of) => (typeof n === "number" && n > 0 ? Math.ceil(MIN_CROP_PX * of / n) : 0);
  const least = im ? [per(im.width, whole[2]), per(im.height, whole[3])] : [0, 0];
  const element = (f) => ({ frame: grownTo(f, least, win), region: "element" });
  const tree = treeOf(screen).filter((e) => isFrame(e.frame));
  const big = (f) => f[2] >= MIN_PICTURE[0] && f[3] >= MIN_PICTURE[1];
  const wordless = (e) => !squash(e.label) && !squash(e.value);
  if (pointer) {
    const under = [];
    for (const e of tree) {
      const f = intersect(e.frame, win);
      if (!f || !contains(f, pointer)) continue;
      // A sliver is not a picture of anything; an icon is, just.
      if (e.role === "image" ? f[2] >= 16 && f[3] >= 16 : PICTURE_HOLDERS.has(e.role) && wordless(e) && big(f)) under.push(f);
    }
    under.sort((x, y) => areaOf(x) - areaOf(y));
    if (under.length) return element(under[0]);
  }
  const images = tree.filter((e) => e.role === "image").map((e) => intersect(e.frame, win)).filter((f) => f && big(f));
  images.sort((x, y) => areaOf(y) - areaOf(x));
  if (images.length) return element(images[0]);
  return { frame: win.slice(), region: "window" };
}

/** `f` grown about its middle to at least `least` [w, h], kept inside `box`
 *  (never bigger than it); `f` itself when it is that big already. */
function grownTo(f, least, box) {
  const w = Math.min(Math.max(f[2], least[0]), box[2]);
  const h = Math.min(Math.max(f[3], least[1]), box[3]);
  if (w <= f[2] && h <= f[3]) return f;
  const fit = (mid, size, lo, span) => Math.min(Math.max(Math.round(mid - size / 2), lo), lo + span - size);
  return [
    w > f[2] ? fit(f[0] + f[2] / 2, w, box[0], box[2]) : f[0],
    h > f[3] ? fit(f[1] + f[3] / 2, h, box[1], box[3]) : f[1],
    Math.max(w, f[2]), Math.max(h, f[3]),
  ];
}

/**
 * How far down the window its own chrome goes: the title bar, a browser's
 * tabs and its address bar, where the window's title and the page's whole
 * address are drawn. The bottom of the lowest of these in the window's top
 * quarter: an address bar in the tree; an OCR line that reads as the title;
 * where the helper says the title is (`titleFrames`: the Windows helper drops
 * the title's lines before they get here, so this side cannot read them);
 * and, with no address bar in the tree to go by (a screen read off the
 * picture alone, a browser whose bar the walk missed), an OCR line that
 * reads as an address. The window's top when there is none of them.
 */
function chromeBottom(screen, look) {
  const win = look.window.frame;
  const limit = win[1] + win[3] / 4;
  let bottom = win[1];
  const chrome = (f) => {
    if (!isFrame(f) || f[1] >= limit) return false;
    bottom = Math.max(bottom, f[1] + f[3]);
    return true;
  };
  let bar = false;
  for (const e of treeOf(screen)) if (isFrame(e.frame) && isAddressBar(e) && chrome(e.frame)) bar = true;
  for (const f of Array.isArray(look.titleFrames) ? look.titleFrames : []) chrome(f);
  const titles = titleKeys(screen, look);
  for (const line of Array.isArray(look.lines) ? look.lines : []) {
    if (!line || !isFrame(line.frame)) continue;
    if (isTitleLine(line.text, titles) || (!bar && URL_LINE.test(squash(line.text)))) chrome(line.frame);
  }
  return Math.min(bottom, win[1] + win[3]);
}

const hasBytes = (d) => !!(d && (d.length > 0 || d.size > 0 || d.byteLength > 0));
const byteSize = (d) => (d ? (typeof d.size === "number" ? d.size : typeof d.byteLength === "number" ? d.byteLength : d.length || 0) : 0);

module.exports = { sameWindow, ocrElements, pictureRegion, hasBytes, byteSize };
