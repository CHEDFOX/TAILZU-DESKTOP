// DotArt (shared/types/sdui.ts 3k, the server's docs/show.md): what a bot draws under its words (a chart, a meter, a drawing) as a
// picture of dots, monochrome, that obey physics. The server sends { type: "DotArt", props: { w, h, d, enter?, heat?, ink?, seed?,
// key?, label? } }; the rules are ../../dotArt.js, generated from the phone's dotArtCore.ts, so a picture moves the same on both.
//
// Every dot is a point mass held at its home by a damped spring. It comes in as the server says (falling under gravity and caught
// by its spring, drawn out from the left, or gathered from scattered places), a click is an impulse that scatters the dots near it,
// and the pointer resting over the picture pushes them gently aside; the springs always bring them home, and a settled picture
// sleeps.
//
// ONE LOOP FOR ALL OF THEM (DA_LOOP): one animation frame loop for every picture in the window. A picture is on it only while
// something in it moves and it is in view (one IntersectionObserver), and none run while the window is hidden. A repaint replaces
// #view's markup, never a picture: each is kept by its key (DA_KEPT), so a refreshed chat does not bring its pictures in again.
// Reduce Motion: every dot at home, still, and the pointer does nothing. Without the rules (an old copy of dotArt.js missing), or a
// drawing that fails: the box, empty.

const DA = { fps: 60, hover: 0.33 };

/** Pictures by key, as long as the window is open (dotArt.js Kept). */
const DA_KEPT = window.TailzuDotArt ? new window.TailzuDotArt.Kept() : null;

// ---- the one loop ------------------------------------------------------------------------------------------------------

const DA_LOOP = { members: new Set(), raf: 0, last: 0, io: null, listening: false };

function daObserver() {
  if (DA_LOOP.io || typeof IntersectionObserver !== "function") return DA_LOOP.io;
  DA_LOOP.io = new IntersectionObserver((es) => {
    for (const e of es) {
      const m = e.target.__da;
      if (m) m.seen = e.isIntersecting;
    }
    daWake();
  });
  return DA_LOOP.io;
}

function daJoin(m) {
  if (DA_LOOP.members.has(m)) { daWake(); return; }
  m.seen = true;
  m.faults = 0;
  m.host.__da = m;
  DA_LOOP.members.add(m);
  const io = daObserver();
  if (io) io.observe(m.host);
  if (!DA_LOOP.listening) { DA_LOOP.listening = true; document.addEventListener("visibilitychange", daWake); }
  daWake();
}

function daLeave(m) {
  DA_LOOP.members.delete(m);
  if (DA_LOOP.io) { try { DA_LOOP.io.unobserve(m.host); } catch { /* gone already */ } }
  if (m.host.__da === m) m.host.__da = null;
}

function daAnySeen() {
  for (const m of DA_LOOP.members) if (m.seen) return true;
  return false;
}

function daWake() {
  if (DA_LOOP.raf || document.hidden || !daAnySeen()) return;
  DA_LOOP.last = 0;
  DA_LOOP.raf = requestAnimationFrame(daTick);
}

function daTick() {
  DA_LOOP.raf = 0;
  for (const m of [...DA_LOOP.members]) if (!m.host.isConnected) daLeave(m);
  if (document.hidden || !daAnySeen()) return;
  const now = performance.now();
  const fps = K.num("desktop.dotArt.fps", DA.fps);
  if (DA_LOOP.last && fps > 0 && now - DA_LOOP.last < 1000 / fps - 1) { DA_LOOP.raf = requestAnimationFrame(daTick); return; }
  const dt = DA_LOOP.last ? (now - DA_LOOP.last) / 1000 : 1 / 60;
  DA_LOOP.last = now;
  for (const m of [...DA_LOOP.members]) {
    if (!m.seen) continue;
    try {
      const moving = m.field.frame(dt);
      m.paint();
      m.faults = 0;
      if (!moving) daLeave(m);
    } catch (e) {
      if (++m.faults >= 3) { console.warn("[Tailzu][DotArt] frame failed:", e); daLeave(m); }
    }
  }
  if (!DA_LOOP.raf && !document.hidden && daAnySeen()) DA_LOOP.raf = requestAnimationFrame(daTick);
}

// ---- drawing -----------------------------------------------------------------------------------------------------------

/** The picture as it is now, into a canvas sized for the display. */
function daPaint(cv, field) {
  const s = field.spec;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const W = Math.max(1, Math.round(s.w * dpr)), H = Math.max(1, Math.round(s.h * dpr));
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; cv.style.width = s.w + "px"; cv.style.height = s.h + "px"; }
  const g = cv.getContext("2d");
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, s.w, s.h);
  field.draw(g);
}

/** A host given its picture: painted now, on the loop while it moves, answering the pointer while motion is on. */
function daMount(host, spec, reduced) {
  const cv = host.querySelector(".tz-da-c");
  if (!cv || !DA_KEPT) return;
  try {
    const field = window.TailzuDotArt.fieldFor(DA_KEPT, spec, { motion: !reduced, entering: true });
    const m = { host, field, paint: () => daPaint(cv, field), seen: true, faults: 0 };
    m.paint();
    if (field.awake) daJoin(m);
    if (reduced) return;
    const at = (e) => { const r = host.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    let down = false;
    host.addEventListener("pointerdown", (e) => {
      const p = at(e);
      down = true;
      field.poke(p.x, p.y);
      field.press(p);
      daJoin(m);
    });
    host.addEventListener("pointermove", (e) => {
      const p = at(e);
      field.press({ x: p.x, y: p.y, power: down ? 1 : K.num("desktop.dotArt.hover", DA.hover) });
      daJoin(m);
    });
    const up = () => { down = false; };
    host.addEventListener("pointerup", up);
    host.addEventListener("pointercancel", up);
    host.addEventListener("pointerleave", () => { down = false; field.press(null); });
  } catch (e) {
    console.warn("[Tailzu][DotArt] stopped:", e);
  }
}

/** The node: the box, an empty canvas in it (mountDotArts gives it its picture once the markup lands). */
function dotArtNode(p, s) {
  const spec = window.TailzuDotArt ? window.TailzuDotArt.readDotArt(p) : null;
  if (!spec) return "";
  const a11y = spec.label ? ' role="img" aria-label="' + esc(spec.label) + '"' : ' aria-hidden="true"';
  const box = "width:" + spec.w + "px;height:" + spec.h + "px;";
  const id = BT_PENDING.push({ kind: "dots", spec }) - 1;
  return '<span class="tz-da" data-da="' + id + '"' + a11y + ' style="' + (s ? s + ";" : "") + box + '"><canvas class="tz-da-c" aria-hidden="true"></canvas></span>';
}

/** After a paint: each box gets its picture. */
function mountDotArts(root) {
  const reduced = prefers("(prefers-reduced-motion: reduce)");
  root.querySelectorAll("[data-da]").forEach((host) => {
    const cfg = BT_PENDING[Number(host.getAttribute("data-da"))];
    if (!cfg || cfg.kind !== "dots") return;
    daMount(host, cfg.spec, reduced);
  });
}
