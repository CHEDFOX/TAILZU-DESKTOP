// The onboarding stage (OnboardStage, BlipSpot).

/**
 * ONE FRIEND BESIDE YOU THROUGH THE WHOLE ONBOARDING.
 *
 * Blip is not a node in any screen. Drawn inside one, he would be torn down
 * and drawn again at the two moments that matter most: when the gate gives way
 * to the app after the code, and between any two screens. So he is one canvas
 * (#blipStage), drawn by blip.js, for the life of the window, and a step only
 * says where he should stand: a BlipSpot, an empty box with a pose and a few
 * words. The stage (OnboardStage) holds the steps, shows the one it is on and
 * glides the next in; the bar, the bubble and the walker stay where they are.
 *
 * TWO STAGES, because signing in comes before there is an account: Welcome,
 * Sign in and Code are the server's auth tree, drawn by paintGate() into the
 * gate; everything after is the screen `onboard`, drawn by repaint() into the
 * view. In between, the gate goes and the screen is fetched, and Blip HOLDS:
 * the paper, the bar and he himself stay, standing where he last stood, until
 * the next stage mounts and he walks to its spot. html[data-onboard] is that
 * hold. He is let go (faded out) only when a screen that is not a stage is
 * painted.
 */
const OB_STEP = {};       // the furthest step each stage has reached, by id
let IN_STAGE = 0;         // above zero while a stage's step is being drawn
/** True while a Bots app page (look "bots") is drawn: borders are solid, pressables are buttons to the keyboard. */
let IN_KIT = false;
const OBS = {
  walker: null,
  look: null,             // the stage's look (ground, bar, bubble, Blip's colours, glide)
  key: "",                // where Blip was last sent: stage, step and spot
  lastId: "",             // the last stage drawn, so the next one glides in
  watch: null,            // the ResizeObserver on the step on show
  landT: 0, burstT: 0, hideT: 0, scrollRaf: 0,
};
const GLIDE_EASE = "cubic-bezier(.32,.72,0,1)";

/**
 * A STAGE: only the step it is on is drawn, inside a box that scrolls on its
 * own (a short window must not cut a step off), with the stage's look riding
 * along as data for the bar and Blip to read.
 *
 * THE STEP IS NEVER LOST ON A REFETCH. A screen fetched again (an app was
 * connected, or someone went to pick more languages and came back) starts its
 * state over, and the step with it. The furthest step a stage has reached is
 * kept by id, and a rebuilt state is raised to it. Going back is not a thing a
 * stage does; the flow is a line, and each step knows its way to the next.
 *
 * The sign-in flow can pick the step as well: while it is in a phase named in
 * `phaseStep` (the code was sent), that step shows, whatever the stage was on.
 * That phase is not remembered: "Change it" returns the flow to the entry and
 * the step with it.
 */
function stageNode(n) {
  const p = n.props || {}, kids = n.children || [];
  if (!kids.length) return "";
  const id = String(p.id || "stage");
  const at = (i) => Math.max(0, Math.min(kids.length - 1, Math.floor(Number(i)) || 0));
  OB_STEP[id] = Math.max(at(OB_STEP[id]), at(stateAt((n.bind && n.bind.step) || "step")));
  const phased = p.phaseStep && typeof p.phaseStep === "object" ? p.phaseStep[AUTH.phase] : undefined;
  const step = Number.isInteger(phased) ? at(phased) : OB_STEP[id];
  const kid = kids[step];
  let inner;
  IN_STAGE++;
  try { inner = node(kid); } finally { IN_STAGE--; }
  const look = { ground: p.ground, progress: p.progress, bubble: p.bubble, blip: p.blip, glide: p.glide };
  return '<div class="ob-stage" data-stage="' + esc(id) + '" data-step="' + step +
    '" data-first="' + (Math.floor(Number(p.first)) || 0) + '" data-of="' + (Math.floor(Number(p.of)) || kids.length) +
    '" data-step-id="' + esc((kid && kid.props && kid.props.stepId) || "") + '" data-look="' + esc(JSON.stringify(look)) + '">' +
    '<div class="ob-step"><div class="ob-content">' + inner + "</div></div></div>";
}

/** A pressable box in the onboarding is a button to the keyboard as well. */
function rolePress(press) {
  return press && (IN_STAGE || IN_KIT) ? ' role="button" tabindex="0"' : "";
}

/**
 * WHERE BLIP STANDS. The box is as big as his figure (a little wider than it
 * is tall, with room for the bubble to start beside it), so the step lays
 * itself out around where he will be; the walker finds the box and goes to its
 * foot. What he says and how he looks while he says it ride along as data.
 */
function blipSpotNode(p, s) {
  const h = Math.max(24, Math.min(400, Number(p.h) || 100));
  const said = label(p.say);
  const spot = {
    pose: /^[a-z]{2,10}$/.test(String(p.pose)) ? String(p.pose) : "present",
    h, say: said == null ? "" : String(said),
    bubble: p.bubble === "corner" ? "corner" : "side",
    burst: p.burst === true,
  };
  return '<span class="bs" aria-hidden="true" data-blip="' + esc(JSON.stringify(spot)) + '" style="width:' +
    Math.ceil(h * 1.4) + "px;height:" + Math.ceil(h * 1.16 + 4) + "px;" + s + '"></span>';
}

/** The last of several spots on show. A step shows one at a time (the server sees to it); if two ever do, the last in the document is the one he goes to. */
function lastSpot(spots) {
  return spots && spots.length ? spots[spots.length - 1] : null;
}

// What the server sends for the look is data into style attributes and a
// canvas, so each value is checked on the way in and falls back to the
// design's own.
const OB_COLOR = /^(#[0-9a-f]{3,8}|rgba?\([0-9., %]+\)|transparent)$/i;
const okColor = (v, fb) => (typeof v === "string" && OB_COLOR.test(v.trim()) ? v.trim() : fb);
const okFont = (v, fb) => (typeof v === "string" && /^[A-Za-z0-9 _-]{1,40}$/.test(v) ? v : fb);
const okNum = (v, fb, lo, hi) => { const x = Number(v); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : fb; };

function stageLook(el) {
  let raw = {};
  try { raw = JSON.parse(el.getAttribute("data-look") || "{}") || {}; } catch { raw = {}; }
  const pg = raw.progress || {}, bb = raw.bubble || {}, bl = raw.blip || {}, gl = raw.glide || {};
  return {
    ground: okColor(raw.ground, "#EFEDE8"),
    progress: { on: okColor(pg.on, "#1C1A17"), off: okColor(pg.off, "rgba(28,26,23,0.13)"), height: okNum(pg.height, 4, 1, 12), gap: okNum(pg.gap, 4, 0, 16) },
    bubble: {
      background: okColor(bb.background, "#FCFBF8"), border: okColor(bb.border, "#1C1A17"), ink: okColor(bb.ink, "#1C1A17"),
      font: okFont(bb.font, "Tailzu Hand"), size: okNum(bb.size, 19, 10, 40), bigSize: okNum(bb.bigSize, 22, 10, 48),
    },
    blip: { dot: okColor(bl.dot, "#F3E2C6"), sticker: okColor(bl.sticker, "#151311"), glow: okColor(bl.glow, "#39FF14") },
    glide: { slide: okNum(gl.slide, 26, 0, 80), outMs: okNum(gl.outMs, 230, 0, 1000), inMs: okNum(gl.inMs, 320, 0, 1500), inDelayMs: okNum(gl.inDelayMs, 60, 0, 500) },
  };
}

function glideOut(el, dir, slide, ms, done) {
  if (typeof el.animate !== "function") { done(el); return; }
  const cs = getComputedStyle(el), from = { opacity: cs.opacity, transform: cs.transform };
  el.getAnimations().forEach((a) => a.cancel());
  el.inert = true;
  const a = el.animate([from, { opacity: 0, transform: "translate3d(" + (-dir * slide) + "px,0,0)" }], { duration: ms, easing: GLIDE_EASE, fill: "forwards" });
  a.onfinish = () => { done(el); a.cancel(); };
}

function glideIn(el, dir, slide, ms, delay) {
  if (typeof el.animate !== "function") return;
  el.animate([{ opacity: 0, transform: "translate3d(" + (dir * slide) + "px,0,0)" }, { opacity: 1, transform: "translate3d(0,0,0)" }],
    { duration: ms, delay, easing: GLIDE_EASE, fill: "backwards" });
}

/** The stage that is up, in the gate before there is an account and in the view after. */
function activeStage() {
  const gate = $("gate");
  const host = gate && !gate.hidden ? $("gateForm") : $("view");
  return host ? host.querySelector(".ob-stage") : null;
}

/** Is the gate showing the sign-in stage? Its state changes (the step) are for it. */
function gateUp() {
  const gate = $("gate");
  return !!(gate && !gate.hidden && AUTH_TREE && AUTH_TREE.type === "OnboardStage");
}

/** Is a stage the screen on show? */
function stageUp() {
  return !!(CURRENT_SCREEN && CURRENT_SCREEN.root && CURRENT_SCREEN.root.type === "OnboardStage");
}

/**
 * WHAT IS UP NOW, taken before a paint replaces it: which stage, which step,
 * and the step itself, to be put back and glided away if the step changes.
 * The scroll is kept too: a repaint is a new document, and one that starts at
 * the top would throw a long step back up the moment a chip was tapped.
 */
function stageBefore(host) {
  const el = host && host.querySelector ? host.querySelector(".ob-stage") : null;
  const live = el ? el.querySelector(".ob-step:not([data-out])") : null;
  if (!el || !live) return null;
  return { id: el.getAttribute("data-stage"), step: Number(el.getAttribute("data-step")) || 0, el: live, scroll: live.scrollTop };
}

/**
 * AFTER A PAINT: gives back whether a stage is up. If it is, the page takes on
 * its ground, the bar fills to the step, the step glides in (and the one
 * before glides out) when it changed, and Blip goes to the spot.
 */
function stageAfter(host, before) {
  const el = host.querySelector ? host.querySelector(".ob-stage") : null;
  if (!el) return false;
  const look = stageLook(el);
  OBS.look = look;
  const id = el.getAttribute("data-stage"), step = Number(el.getAttribute("data-step")) || 0;
  const root = document.documentElement;
  root.dataset.onboard = "1";
  root.style.setProperty("--ob-ground", look.ground);
  stageSwap(el, before, look);
  OBS.lastId = id;
  stageBar(look, (Math.floor(Number(el.getAttribute("data-first"))) || 0) + step, Math.floor(Number(el.getAttribute("data-of"))) || 1);
  try {
    if (document.fonts && document.fonts.load) {
      document.fonts.load('800 26px "Tailzu Grotesk"').catch(() => {});
      document.fonts.load('400 19px "Tailzu Hand"').catch(() => {});
    }
  } catch { /* the faces arrive when the text asks for them */ }
  stageWatch(el);
  stageFollow();
  return true;
}

/**
 * THE GLIDE. Only a change of step glides: the one that was up is put back,
 * inert, over the new one and slides out as the new one slides in, both on
 * one curve, about 380 ms from the first move to the last. A repaint inside a
 * step (a chip lit, the mic held) is instant, as the rest of this window's
 * repaints are: the document is rebuilt on every state change, and an
 * animation on each would be a flicker on each. A stage that has just taken
 * over from another (the app after the code) brings its first step in from the
 * right, and a repaint of the same step keeps the scroll it had.
 */
function stageSwap(el, before, look) {
  const id = el.getAttribute("data-stage"), step = Number(el.getAttribute("data-step")) || 0;
  const live = el.querySelector(".ob-step");
  // Held still, nothing slides and the two just fade, a little slower.
  const gl = prefers("(prefers-reduced-motion: reduce)") ? { slide: 0, outMs: 260, inMs: 260, inDelayMs: 0 } : look.glide;
  if (before && before.id === id && before.step !== step) {
    const dir = step > before.step ? 1 : -1;
    const out = before.el;
    out.setAttribute("data-out", "1");
    out.setAttribute("aria-hidden", "true");
    out.inert = true;
    el.appendChild(out);
    out.scrollTop = before.scroll;
    glideOut(out, dir, gl.slide, gl.outMs, (e) => e.remove());
    glideIn(live, dir, gl.slide, gl.inMs, gl.inDelayMs);
  } else if (!before && OBS.lastId && OBS.lastId !== id) {
    glideIn(live, 1, gl.slide, gl.inMs, gl.inDelayMs);
  } else if (before && before.id === id && live) {
    live.scrollTop = before.scroll;
  }
}

/** The bar: one segment a step, filled up to the one you are on. */
function stageBar(look, upto, of) {
  const bar = $("blipProg");
  if (!bar) return;
  const count = Math.max(1, Math.min(40, of));
  if (bar.children.length !== count) bar.innerHTML = "<i></i>".repeat(count);
  const pg = look.progress;
  bar.style.setProperty("--pg-on", pg.on);
  bar.style.setProperty("--pg-off", pg.off);
  bar.style.setProperty("--pg-h", pg.height + "px");
  bar.style.setProperty("--pg-gap", pg.gap + "px");
  for (let i = 0; i < bar.children.length; i++) bar.children[i].classList.toggle("on", i <= upto);
  bar.classList.add("on");
}

/** The step's box scrolling, or its content changing size (a font arriving, a line wrapping), moves where he should stand. */
function stageWatch(el) {
  const live = el.querySelector(".ob-step:not([data-out])");
  if (!live) return;
  live.addEventListener("scroll", () => {
    if (OBS.scrollRaf) return;
    OBS.scrollRaf = requestAnimationFrame(() => { OBS.scrollRaf = 0; stageFollow(); });
  });
  try {
    if (typeof ResizeObserver === "function") {
      if (!OBS.watch) OBS.watch = new ResizeObserver(() => stageFollow());
      OBS.watch.disconnect();
      const c = live.querySelector(".ob-content");
      if (c) OBS.watch.observe(c);
    }
  } catch { /* a window that cannot watch still follows on resize */ }
}

const dprNow = () => Math.min(2, window.devicePixelRatio || 1);

function ensureWalker() {
  if (OBS.walker) return OBS.walker;
  const cv = $("blipStage"), T = window.TailzuBlip;
  if (!cv || !T || typeof T.createWalker !== "function" || !OBS.look) return null;
  const b = OBS.look.blip;
  OBS.walker = T.createWalker(cv, {
    dpr: dprNow(), reduced: prefers("(prefers-reduced-motion: reduce)"),
    raf: (f) => requestAnimationFrame(f), caf: (id) => cancelAnimationFrame(id),
    dot: b.dot, sticker: b.sticker, glow: b.glow, paper: OBS.look.bubble.background,
  });
  OBS.walker.size(window.innerWidth, window.innerHeight, dprNow());
  try {
    window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", (e) => { if (OBS.walker) OBS.walker.reduced(e.matches); });
  } catch { /* an old engine keeps what it started with */ }
  return OBS.walker;
}

/**
 * WHERE THE SPOT IS, in the window: its feet and its bubble's corner, worked
 * out from the offsets up to the step's content (which the glide's transform
 * does not move), plus the stage's own place, less the step's scroll. So he
 * stands where the step will rest, not where a glide has it for the moment,
 * and he rides along when a short window scrolls the step.
 */
function spotAt(stageEl, stepEl, b) {
  const content = stepEl.querySelector(".ob-content");
  const rel = (e0) => {
    let x = 0, y = 0;
    for (let e = e0; e && e !== content; e = e.offsetParent) { x += e.offsetLeft; y += e.offsetTop; }
    return { x, y };
  };
  let d = {};
  try { d = JSON.parse(b.getAttribute("data-blip") || "{}") || {}; } catch { d = {}; }
  const h = okNum(d.h, 100, 24, 400), o = rel(b), r = stageEl.getBoundingClientRect();
  const ox = r.left + content.offsetLeft, oy = r.top + content.offsetTop - stepEl.scrollTop;
  let bx, by;
  if (d.bubble === "corner" && b.parentElement) {
    // Welcome's and Done's: the bubble hangs from the top right of Blip's row.
    const c = b.parentElement, q = rel(c);
    bx = q.x + c.offsetWidth - 10; by = q.y + 6;
  } else {
    bx = o.x + b.offsetWidth - Math.round(h * .16); by = o.y + Math.round(h * .1);
  }
  return {
    x: ox + o.x + b.offsetWidth / 2, y: oy + o.y + b.offsetHeight - 2, h,
    pose: /^[a-z]{2,10}$/.test(String(d.pose)) ? d.pose : "present", say: typeof d.say === "string" ? d.say : "",
    mode: d.bubble === "corner" ? "corner" : "side", burst: d.burst === true, bx: ox + bx, by: oy + by,
  };
}

/** His words: placed beside him in the stage's own look. False when he has none to say. */
function sayPlace(sp) {
  const b = $("blipSay");
  if (!b || !OBS.look) return false;
  if (!sp.say) { b.classList.remove("on"); return false; }
  const bb = OBS.look.bubble, st = b.style;
  b.firstElementChild.textContent = sp.say;
  st.setProperty("--bs-bg", bb.background); st.setProperty("--bs-bd", bb.border);
  st.background = bb.background; st.borderColor = bb.border; st.color = bb.ink;
  st.fontFamily = '"' + bb.font + '",var(--f-deva),"Comic Sans MS",cursive';
  st.fontSize = (sp.mode === "corner" ? bb.bigSize : bb.size) + "px";
  st.top = Math.round(sp.by) + "px";
  if (sp.mode === "side") { st.left = Math.round(sp.bx) + "px"; st.right = "auto"; }
  else { st.right = Math.round(document.documentElement.clientWidth - sp.bx) + "px"; st.left = "auto"; }
  return true;
}

function sayHide() {
  const b = $("blipSay");
  if (b) b.classList.remove("on");
}

/** He has got there (or was there already): his words come up, and at the end the confetti goes. */
function stageLand(sp, key, kind) {
  if (OBS.key !== key) return;                    // he has been sent elsewhere since
  const b = $("blipSay");
  if (b && sayPlace(sp)) {
    const was = b.classList.contains("on");
    b.classList.add("on");
    // Same place, new words: the bubble says them again with a small start.
    if (kind === "pose" && was && !prefers("(prefers-reduced-motion: reduce)") && typeof b.animate === "function") {
      b.animate([{ transform: "rotate(-1.5deg) scale(.93)" }, { transform: "rotate(-1.5deg) scale(1)" }], { duration: 220, easing: GLIDE_EASE });
    }
  }
  clearTimeout(OBS.burstT);
  if (sp.burst) {
    OBS.burstT = setTimeout(() => {
      if (OBS.key !== key || !window.TailzuBlip) return;
      window.TailzuBlip.burst(document.body, sp.x, sp.y - sp.h * .75, { reduced: prefers("(prefers-reduced-motion: reduce)") });
    }, 250);
  }
}

/**
 * SEND BLIP TO THE SPOT THE STEP ON SHOW HAS, or keep him on it: called after
 * every paint, and again when the window is resized, the step is scrolled or
 * its content changes size. The same spot as last time is only a measure
 * (he is moved, with no walk); a new one is a journey, a re-pose or, when he
 * is not anywhere yet (the first, or the first after he was let go), a
 * simple arrival with a fade.
 */
function stageFollow() {
  const el = activeStage();
  if (!el || !OBS.look) return;
  const live = el.querySelector(".ob-step:not([data-out])");
  if (!live) return;
  const b = lastSpot(Array.prototype.slice.call(live.querySelectorAll(".bs")));
  if (!b) { sayHide(); return; }
  const w = ensureWalker();
  if (!w) return;
  const sp = spotAt(el, live, b);
  const key = el.getAttribute("data-stage") + ":" + el.getAttribute("data-step") + ":" + b.getAttribute("data-blip");
  if (OBS.key === key) {
    w.retarget(sp.x, sp.y, sp.h);
    const bubble = $("blipSay");
    if (bubble && bubble.classList.contains("on")) sayPlace(sp);
    return;
  }
  OBS.key = key;
  clearTimeout(OBS.hideT); clearTimeout(OBS.burstT);
  const cv = $("blipStage");
  if (cv) cv.classList.add("on");
  const how = w.go(sp.x, sp.y, sp.h, sp.pose, (kind) => stageLand(sp, key, kind));
  // On his way his words are down; they come up when he lands.
  if (how === "travel") sayHide();
}

window.addEventListener("resize", () => {
  if (OBS.walker) OBS.walker.size(window.innerWidth, window.innerHeight, dprNow());
  stageFollow();
});
try { document.fonts.addEventListener("loadingdone", () => stageFollow()); } catch { /* no font events here */ }

/**
 * LET HIM GO: a screen that is not a stage is up. The paper gives way, the bar
 * and the words fade, and he fades with them (the walker is told to stop
 * drawing once that has finished).
 */
function leaveOnboard() {
  const root = document.documentElement;
  if (root.dataset.onboard !== "1") return;
  delete root.dataset.onboard;
  root.style.removeProperty("--ob-ground");
  OBS.key = ""; OBS.lastId = ""; OBS.look = null;
  clearTimeout(OBS.burstT);
  const cv = $("blipStage"), bar = $("blipProg");
  if (cv) cv.classList.remove("on");
  if (bar) bar.classList.remove("on");
  sayHide();
  if (OBS.walker) {
    clearTimeout(OBS.hideT);
    OBS.hideT = setTimeout(() => { if (OBS.walker) OBS.walker.hide(); }, 240);
  }
}
