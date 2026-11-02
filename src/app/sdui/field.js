// The neural field (NeuralField, DeskField): neuralField.html in a frame, fed
// the node's props and the window's state.

/**
 * THE FIELD IS TOLD WHAT THE SCREEN IS DOING, and it only runs when somebody
 * is looking at it.
 *
 * Both were missing here. The iframe was loaded and then left alone, so the
 * network never reacted to a live session — it pulsed the same idle pattern
 * while the user was mid-sentence, where the phone's leans toward the centre
 * on "listening" and outward on "speaking". And it kept drawing at sixty
 * frames a second behind a window that had been put away, which on a tray app
 * is most of its life.
 *
 * The page takes both over the same channel the phones use: postMessage into
 * `window.tz`. Same message names, same quantising of the level — twenty steps
 * is finer than the eye and turns sixty messages a second into a trickle.
 */
/** NeuralField props that are sent as messages or as their own parameter,
 *  never inside the `cfg` the page bakes. */
const FIELD_LIVE = ["alpha", "growth", "state", "level", "training"];
let FIELD_BINDS = null;   // { state, level, training } paths the server named
let FIELD_PROPS = null;
let FIELD_LAST = "";

let FIELD_EL = null;      // the one iframe, kept across paints

function fieldSend(msg) {
  if (!FIELD_EL || !FIELD_EL.contentWindow) return;
  try { FIELD_EL.contentWindow.postMessage(msg, "*"); } catch { /* not loaded yet */ }
}

/** Whatever the screen currently says, in the page's vocabulary. */
function fieldState() {
  const b = FIELD_BINDS || {};
  const p = FIELD_PROPS || {};
  const at = (key) => (b[key] ? stateAt(b[key]) : p[key]);
  const lvl = Math.min(1, Math.max(0, Number(at("level")) || 0));
  return {
    state: String(at("state") || "idle"),
    level: Math.round(lvl * 20) / 20,
    training: at("training") === true || at("training") === "true",
  };
}

/** The screen that owned the field is gone, or going. Drop the iframe with it
 *  rather than keep a canvas alive for a screen nobody is on — and rather than
 *  leave it standing under whatever the view shows next. */
function dropField() {
  groundView(null);
  if (FIELD_TRACK) FIELD_TRACK();
  if (FIELD_EL) { try { FIELD_EL.remove(); } catch {} FIELD_EL = null; }
  FIELD_BINDS = FIELD_PROPS = null; FIELD_LAST = "";
}

/**
 * NOTHING BETWEEN THE FIELD AND THE VIEW MAY BE OPAQUE.
 *
 * On the phones the field is a child of the screen, so it paints over the
 * screen's own background, as a child does. Here it is a layer UNDER the whole
 * view — which is what keeps it from reloading on every paint — and that turns
 * the painting order over: the screen's background now sits on top of it. The
 * Train screen's root is solid black, so the field ran at full size, every
 * frame, behind a black sheet, and the only time anyone saw it was the instant
 * a tab change swapped the sheet out.
 *
 * So the order is put back by hand: every background between the slot and the
 * view is lifted off, and the one nearest the field — the one it would have
 * been drawn over on a phone — becomes the iframe's own ground. Siblings that
 * come after the field (the scrim, the copy, the button) still sit above it,
 * exactly as the tree says. Re-done on every paint, since every paint writes
 * the backgrounds back.
 */
function uncoverField(slot, view) {
  let ground = "";
  for (let el = slot.parentElement; el && el !== view; el = el.parentElement) {
    const bg = getComputedStyle(el).backgroundColor;
    if (!bg || bg === "transparent" || /rgba\([^)]*,\s*0\)$/.test(bg)) continue;
    if (!ground) ground = bg;
    el.style.backgroundColor = "transparent";
  }
  return ground;
}

/**
 * THE VIEW'S OWN GROUND GOES UNDER THE FIELD, NOT OVER IT.
 *
 * The field is a layer beneath #view, so whatever #view paints sits on top of
 * it. The desk gave #view a ground of its own — the sheet on the desk's pages,
 * --bg on the phone-shaped ones — and from then on the field ran behind an
 * opaque sheet on every screen: the live training screen was plain black.
 *
 * While a field is up the ground moves one level down, to #main, where it
 * paints beneath the layer, and the view goes clear. Same colour, right order.
 * Called with null when the field goes, which hands the ground back.
 */
function groundView(view) {
  const v = view || $("view");
  if (!v) return;
  const host = v.parentElement;
  v.style.background = "";
  if (host) host.style.backgroundColor = "";
  if (!view || !host) return;
  host.style.backgroundColor = getComputedStyle(v).backgroundColor;
  v.style.background = "transparent";
}

function wireField(view) {
  const slot = view.querySelector("[data-field]");
  if (!slot) { dropField(); return; }
  const q = slot.getAttribute("data-field") || "";
  // THE SAME FIELD, RETUNED, never a new one. A screen that wants it brighter
  // (the session, after the entry) or that knows the network has grown says
  // so over the same channel as the state, and the page eases or rebuilds in
  // place. Reloading the iframe for a new alpha was the black frame in the
  // middle of slide-to-begin.
  if (FIELD_EL && FIELD_EL.dataset.q !== q) {
    const was = new URLSearchParams(FIELD_EL.dataset.q || "");
    FIELD_EL.dataset.q = q;
    const qs = new URLSearchParams(q);
    if ((was.get("cfg") || "") !== (qs.get("cfg") || "")) {
      // Different GEOMETRY is a different drawing, and the page bakes its
      // geometry once — so this one reloads. It does not happen between the
      // screens of one catalog, which all send the same field.
      FIELD_EL.src = "neuralField.html" + q;
    } else {
      const tune = {};
      if (qs.has("alpha")) tune.alpha = Number(qs.get("alpha"));
      if (qs.has("growth")) tune.growth = Number(qs.get("growth"));
      fieldSend(tune);
    }
  }
  groundView(view);
  const ground = uncoverField(slot, view);
  if (!FIELD_EL) {
    // MOUNTED ONCE, OUTSIDE THE VIEW, AND NEVER MOVED.
    //
    // Reparenting an iframe reloads the document inside it in every browser
    // that matters, so "keep it and move it into the new markup" is the same
    // reload by another name. It lives beside the view instead, as a layer,
    // and the paint only tells it where to be.
    FIELD_EL = document.createElement("iframe");
    FIELD_EL.dataset.q = q;
    FIELD_EL.setAttribute(
      "style",
      "position:absolute;border:0;background:#000;pointer-events:none;z-index:0",
    );
    FIELD_EL.addEventListener("load", () => {
      FIELD_LAST = "";
      push();
      fieldSend({ run: !document.hidden });
    });
    FIELD_EL.src = "neuralField.html" + q;
    FIELD_EL.style.visibility = "hidden";   // until place() has measured the slot
    // FIRST child of #main, so it paints under #view (which carries z-index:1).
    // The field is the art behind the copy; appended last it would cover the
    // title and the button it exists to sit behind.
    const host = view.parentElement || document.body;
    host.insertBefore(FIELD_EL, host.firstChild);
  }
  // The screen's own colour under the field, as on the phones; the window's
  // ground when the screen names none.
  FIELD_EL.style.background = ground || "var(--bg)";
  place();

  /** Sit exactly where this paint put the slot. Measured against the layer's
   *  offset parent, so scrolling the view carries the field with it. */
  function place() {
    const host = FIELD_EL.offsetParent || document.body;
    const a = slot.getBoundingClientRect(), b = host.getBoundingClientRect();
    FIELD_EL.style.left = (a.left - b.left) + "px";
    FIELD_EL.style.top = (a.top - b.top) + "px";
    FIELD_EL.style.width = a.width + "px";
    FIELD_EL.style.height = a.height + "px";
    // A slot with no size yet means the paint has not laid out. Stay hidden
    // rather than flash a black rectangle in the corner.
    FIELD_EL.style.visibility = a.width && a.height ? "visible" : "hidden";
  }

  function push() {
    const msg = fieldState();
    const key = JSON.stringify(msg);
    if (key === FIELD_LAST) return;      // nothing changed; do not wake the page
    FIELD_LAST = key;
    fieldSend(msg);
  }
  push();

  // The slot moves when the view scrolls or the window is resized, and the
  // layer is not in the flow, so it has to be told. Replaced on every paint so
  // a listener never outlives the slot it measures.
  if (FIELD_TRACK) FIELD_TRACK();
  const onMove = () => place();
  view.addEventListener("scroll", onMove, { passive: true });
  window.addEventListener("resize", onMove);
  FIELD_TRACK = () => {
    view.removeEventListener("scroll", onMove);
    window.removeEventListener("resize", onMove);
    FIELD_TRACK = null;
  };
  requestAnimationFrame(place);   // after layout has settled
}
let FIELD_TRACK = null;

// A tray app spends most of its life put away. The page stops its loop outright
// and resumes where it was — the field is a simulation of state, not a
// timeline, so a pause costs it nothing.
document.addEventListener("visibilitychange", () => fieldSend({ run: !document.hidden }));
