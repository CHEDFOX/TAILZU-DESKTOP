// The marks an answer draws while it explains (circles, arrows, underlines,
// numbers), turned from ids and picture places into places on the screen.

const { squash, clip, isFrame } = require("./helpers.js");

/** A place in the picture is 0 to this, across it and down it. */
const PICTURE_UNITS = 1000;
/** A box, circle, underline or highlight at a place in the picture rather
 *  than around something: it goes around this much of the picture's shorter
 *  side (in thousandths), centred on the place. Big enough to see, small
 *  enough to say which spot. */
const POINT_MARK = 40;
/** A mark's label, as the server cuts it. */
const LABEL_MAX = 48;
/** A path's points, as the server allows them. */
const PATH_MAX = 32;
const DRAW_KINDS = new Set(["box", "circle", "underline", "highlight", "arrow", "number", "label", "path"]);
/** The kinds drawn around (or under) a frame. */
const FRAMED = new Set(["box", "circle", "underline", "highlight"]);

const isPair = (p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === "number" && Number.isFinite(n));
const round2 = (v) => Math.round(v * 100) / 100;
const clampTo = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** A place in the picture (picture units) as a point on the screen (driver
 *  units), through the frame of the region the picture was cropped from:
 *  X = fx + x/1000·fw. Kept inside that region, whatever number came. */
function picturePoint(p, region) {
  const u = (v) => clampTo(v, 0, PICTURE_UNITS) / PICTURE_UNITS;
  return [round2(region[0] + u(p[0]) * region[2]), round2(region[1] + u(p[1]) * region[3])];
}

/** A box in the picture as a frame on the screen, cut to the region; null
 *  when nothing of it is left inside. */
function pictureBox(b, region) {
  const [x0, y0] = picturePoint([b[0], b[1]], region);
  const [x1, y1] = picturePoint([b[0] + Math.max(0, b[2]), b[1] + Math.max(0, b[3])], region);
  return x1 > x0 && y1 > y0 ? [x0, y0, round2(x1 - x0), round2(y1 - y0)] : null;
}

/** A small square frame centred on a point, for a mark that goes around a
 *  frame but was given a place. */
function aroundPoint(pt, region) {
  const size = Math.max(8, (POINT_MARK / PICTURE_UNITS) * Math.min(region[2], region[3]));
  return [round2(pt[0] - size / 2), round2(pt[1] - size / 2), round2(size), round2(size)];
}

/** One spot of a mark: `{ frame }` for an element of this screen or a box in
 *  the picture, `{ point }` for a place in it, or null when it cannot be
 *  placed: an id not on this screen, or a picture spot with no picture. */
function spotOf(spot, frames, region) {
  if (!spot || typeof spot !== "object") return null;
  if (typeof spot.id === "string") {
    const f = frames && typeof frames.get === "function" ? frames.get(spot.id) : null;
    return isFrame(f) ? { frame: f.slice() } : null;
  }
  if (!region) return null;
  if (isPair(spot.pt)) return { point: picturePoint(spot.pt, region) };
  if (isFrame(spot.box)) {
    const f = pictureBox(spot.box, region);
    return f ? { frame: f } : null;
  }
  return null;
}

/** A mark's label as the guide draws it: one line, no control characters.
 *  Only words: anything else in `text` would be drawn as "[object Object]". */
const markLabel = (v) => (typeof v === "string" ? clip(squash(v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")), LABEL_MAX) : "");
const sameGeometry = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * The server's draw event as the guide's mark, in driver units (the guide's
 * side turns them into its own): `{ kind, frame | from/to | at | points,
 * closed?, n?, text? }`. Frames are [x, y, w, h], points [x, y].
 *
 *   an id       the element's frame, from this screen's map (lines read off
 *               the window included); an id not on it drops the mark
 *   a picture   `pt` and `box` are 0–1000 of `region`, the frame of the
 *   spot        picture this run sent, and are kept inside it; with no
 *               picture sent, the mark is dropped
 *
 * A box, circle, underline or highlight given a place rather than a thing
 * goes around a small square there. A number or a label given a place is
 * drawn `at` it. Null for a mark that cannot be drawn as it was meant: a
 * circle somewhere near is worse than none.
 */
function resolveMark(ev, frames, region) {
  if (!ev || typeof ev !== "object" || !DRAW_KINDS.has(ev.kind)) return null;
  const pic = isFrame(region) && region[2] > 0 && region[3] > 0 ? region : null;
  const kind = ev.kind;
  const mark = { kind };
  if (kind === "path") {
    const pts = ev.points;
    if (!pic || !Array.isArray(pts) || pts.length < 2 || pts.length > PATH_MAX || !pts.every(isPair)) return null;
    mark.points = pts.map((p) => picturePoint(p, pic));
    if (ev.closed === true) mark.closed = true;
  } else if (kind === "arrow") {
    const from = spotOf(ev.from, frames, pic);
    const to = spotOf(ev.to, frames, pic);
    if (!from || !to) return null;
    mark.from = from.frame || from.point;
    mark.to = to.frame || to.point;
    // Two ids for the same place (a button and the line of text read off
    // it), or two picture places the clamp has made one: an arrow with no
    // length has no direction to draw its head in.
    if (sameGeometry(mark.from, mark.to)) return null;
  } else {
    const at = spotOf(ev.target, frames, pic);
    if (!at) return null;
    if (at.frame) mark.frame = at.frame;
    else if (FRAMED.has(kind)) mark.frame = aroundPoint(at.point, pic);
    else mark.at = at.point;
    if (kind === "number") {
      if (!Number.isInteger(ev.n) || ev.n < 1 || ev.n > 9) return null;
      mark.n = ev.n;
    }
  }
  const text = markLabel(ev.text);
  if (text) mark.text = text;
  else if (kind === "label") return null;
  return mark;
}

module.exports = { resolveMark };
