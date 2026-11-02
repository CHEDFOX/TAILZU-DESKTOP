// The card: its birth out of the pill and its fold back into it, and what it
// says (the state, the words, the steps, the confirm).
"use strict";

// Both are worked out in the frame loop from the time since they began, so
// a fold turned round by a new question goes back from wherever it got to,
// and ?capture can stop on any frame of either.
const LIFE = { tether: 0, k: 0, ky: 0, alpha: 0, inner: 0, seed: 0, fade: 1, landed: false, over: true };
/** How far the birth or the fold is at `ms`, into LIFE: the tether's
 *  reach (0..1), the card's bloom across (`k`) and up (`ky`), each 0 a
 *  seed of itself .. 1 its size and a little over on the way, its
 *  opacity, its contents', the seed's size, the tether's opacity (`fade`:
 *  it only fades under reduced motion), whether the bloom has landed, and
 *  whether a fold is over. */
function lifeAt(ms) {
  const L = S.life, f = L.from, e = ms - L.at, o = LIFE;
  o.fade = 1; o.landed = false; o.over = false;
  if (L.open) {
    if (!L.docked || reduced) {
      // A plain fade: no pill to grow from, or no movement wanted.
      const q = clamp(e / (reduced ? 200 : 260));
      o.alpha = f.alpha + (1 - f.alpha) * (reduced ? q : 1 - (1 - q) * (1 - q));
      o.k = 1; o.ky = 1; o.inner = 1; o.tether = 1; o.seed = 1; o.landed = true;
      if (reduced) o.fade = o.alpha;
    } else {
      const grow = Math.max(1, K.num("desktop.guide.growMs", 220)), bloom = Math.max(1, K.num("desktop.guide.bloomMs", 360));
      // The thread first, from the bead up to where the card will be; the
      // card from about two thirds of the way (150 ms of 220), sooner when
      // the thread is already partly up.
      o.tether = f.tether + (1 - f.tether) * outCubic(e / grow);
      // Across first and then up, a beat behind: the dot at the thread's
      // end stretches out along where the card's bottom edge will be, and
      // the card opens upward from it. Visible from its first frames (an
      // opacity that comes up fast), or the small start of it would be
      // spent unseen and the card would seem to fade in at half its size.
      const d = grow * .68 * (1 - f.tether);
      const p = clamp((e - d) / bloom), py = clamp((e - d - .12 * bloom) / (.88 * bloom));
      o.k = f.k + (1 - f.k) * BLOOM(p);
      o.ky = f.ky + (1 - f.ky) * BLOOM(py);
      // On the bloom's own curve, over 120 ms: most of the way in the first
      // 30. Eased out more gently, the stretching line and the card's first
      // height were a grey ghost, and the bloom read as a fade.
      o.alpha = f.alpha + (1 - f.alpha) * Math.min(1, BLOOM(clamp((e - d) / 120)));
      o.inner = f.inner + (1 - f.inner) * outCubic((e - d - 150) / 240);
      o.seed = f.tether > .5 ? 1 : outBack(e / 160);
      // A card already whole (a fold turned round before it began, or a
      // thread growing up to a card that is up) has nothing to land.
      o.landed = p >= .9 || (f.k >= 1 && f.ky >= 1);
    }
  } else if (!L.docked || reduced) {
    // Blip ducks first, then the card fades.
    const q = clamp((e - (reduced ? 100 : 160)) / (reduced ? 220 : 260));
    o.alpha = f.alpha * (1 - q);
    o.k = 1; o.ky = 1; o.inner = f.inner; o.tether = f.tether; o.seed = 1;
    if (reduced) o.fade = o.alpha;
    o.over = q >= 1;
  } else {
    // THE FOLD, at its knob's length (the times below are for 620 ms):
    // the contents go, the card folds back into the thread's end at
    // 120-340 ms, and the thread is pulled down into the bead at 300-600,
    // faster as it goes.
    // Down first, then in: the bloom backwards.
    const s = Math.max(1, K.num("desktop.guide.foldMs", 620)) / 620, pc = (e - 120 * s) / (220 * s);
    o.inner = f.inner * (1 - clamp((e - 40 * s) / (140 * s)));
    o.ky = f.ky * (1 - inQuad(pc / .8));
    o.k = f.k * (1 - inQuad((pc - .2) / .8));
    o.alpha = f.alpha * clamp((340 * s - e) / (120 * s));
    o.tether = f.tether * (1 - inCubic((e - 300 * s) / (300 * s)));
    o.seed = 1 - clamp((e - 540 * s) / (80 * s));
    o.over = e >= 620 * s;
  }
  if (o.over) { o.tether = 0; o.k = 0; o.ky = 0; o.alpha = 0; o.inner = 0; o.seed = 0; }
  return o;
}
/** The card starts to open or to close, from wherever it is now. */
function startLife(open) {
  const ms = now(), o = lifeAt(ms);
  S.life = { open, at: ms, docked: S.docked, from: { tether: o.tether, k: o.k, ky: o.ky, alpha: o.alpha, inner: o.inner } };
}

// The card as drawn this frame, with the bloom's scale about the thread's
// end; and the same rectangle on the canvas, for Blip and the thread.
const VIS = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
const painted = { tf: "", org: "", br: "", h: "", op: "", io: "", it: "" };
const paintedAt = [NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN];
function setStyle(el, key, prop, v) { if (painted[key] !== v) { painted[key] = v; el.style[prop] = v; } }
function scaleOf(o) { return [lerp(.06, 1, o.k), lerp(.03, 1, o.ky)]; }
function visible(o) {
  const c = S.cur;
  if (!c) return null;
  const [sx, sy] = scaleOf(o);
  const x = snap(c.x), y = snap(c.y);
  const ox = S.life.docked ? attachX(c) : x + c.w / 2, oy = y + c.h;
  VIS.left = ox + (x - ox) * sx; VIS.right = ox + (x + c.w - ox) * sx;
  VIS.top = oy + (y - oy) * sy; VIS.bottom = oy;
  VIS.width = VIS.right - VIS.left; VIS.height = VIS.bottom - VIS.top;
  return VIS;
}
/**
 * THE BLOOM, on the card itself: a scale from the point where the thread
 * meets it, from a seed of itself (6% by 3%) to its size; and its corners
 * those of a pill while it is thin and its own once it is not, set as
 * elliptical radii so that, scaled unevenly, they still read as round.
 * (Radii rather than a clip-path: the card's shadow follows them, where a
 * clip would cut it off and the shadow would pop in when the clip came
 * away.) Its contents rise into it last.
 */
function paintCard(o) {
  const c = S.cur;
  if (!c) return;
  const x = snap(c.x), y = snap(c.y);
  // Nothing moved: nothing is written (or made), so a card at rest costs
  // the frame nothing.
  const key = [x, y, c.h, o.k, o.ky, o.alpha, o.inner, S.life.open ? 1 : 0, S.life.docked ? attachX(c) : 0];
  if (key.every((v, i) => v === paintedAt[i])) return;
  for (let i = 0; i < key.length; i++) paintedAt[i] = key[i];
  let tf = `translate3d(${x}px,${y}px,0)`, org = "", br = "";
  if (Math.abs(o.k - 1) > .0005 || Math.abs(o.ky - 1) > .0005) {
    const [sx, sy] = scaleOf(o);
    const ox = (S.life.docked ? attachX(c) : x + c.w / 2) - x;
    tf += ` scale(${sx.toFixed(4)},${sy.toFixed(4)})`;
    org = `${ox.toFixed(2)}px ${c.h.toFixed(2)}px`;
    const rs = Math.min(ROUND, c.w * sx / 2, c.h * sy / 2);
    br = `${Math.min(c.w / 2, rs / sx).toFixed(2)}px / ${Math.min(c.h / 2, rs / sy).toFixed(2)}px`;
  }
  setStyle(card, "tf", "transform", tf);
  setStyle(card, "org", "transformOrigin", org);
  setStyle(card, "br", "borderRadius", br);
  setStyle(card, "h", "height", c.h.toFixed(2) + "px");
  setStyle(card, "op", "opacity", o.alpha >= .999 ? "" : o.alpha.toFixed(3));
  setStyle(inner, "io", "opacity", o.inner >= .999 ? "" : o.inner.toFixed(3));
  setStyle(inner, "it", "transform", o.inner >= .999 || !S.life.open ? "" : `translateY(${(6 * (1 - o.inner)).toFixed(2)}px)`);
}
/** While it blooms or folds, a faint cream rim just outside the card's
 *  shape: the card's own hairline edge is scaled away with it, and an ink
 *  card on a dark app was a shadow growing out of the dark. Gone once it
 *  has landed. */
function drawRim(o, rc) {
  const m = Math.min(o.k, o.ky);
  const a = .32 * (1 - clamp((m - .55) / .45)) * clamp(o.alpha * 3);
  if (a <= .01 || reduced) return;
  const r = Math.min(ROUND, rc.width / 2, rc.height / 2);
  ctx.save();
  ctx.globalAlpha = a;
  roundRect(ctx, rc.left - .75, rc.top - .75, rc.width + 1.5, rc.height + 1.5, r + .75);
  ctx.strokeStyle = BOTS() ? "#d4d4d4" : "#F3E2C6"; ctx.lineWidth = 1.2; ctx.stroke();
  ctx.restore();
}
/** Folded away: what was on the card goes with it. */
function gone() {
  card.classList.remove("on");
  chip.classList.remove("on");
  S.ring = null; S.chipBox = null;
  $("badge").textContent = "";
}

// ---- what it says ----------------------------------------------------------
const LABELS = {
  listening: () => K.txt("desktop.guide.listening", "Listening"),
  thinking: () => K.txt("desktop.guide.thinking", "Looking"),
  showing: () => K.txt("desktop.guide.showing", "Here"),
  doing: () => K.txt("desktop.guide.doing", "Doing it"),
  confirm: () => (S.risk === "always" ? K.txt("desktop.guide.confirmAlways", "Can't be undone") : K.txt("desktop.guide.confirm", "Check first")),
  permission: () => K.txt("desktop.guide.permission", "Needs a look"),
  done: () => K.txt("desktop.guide.done", "Done"),
  error: () => K.txt("desktop.guide.error", "Couldn't"),
};
const FOOT = {
  listening: () => K.txt("desktop.guide.footListening", "Ask about anything on screen"),
  thinking: () => "",
  showing: () => K.txt("desktop.guide.footShowing", "Esc to close"),
  doing: () => K.txt("desktop.guide.footDoing", "Esc to stop"),
  done: () => "",
  error: () => "",
};
function setState(state, label) {
  if (state !== S.state) S.stateAt = now() / 1000;
  if (state === "error" && S.state !== "error") S.errAt = now() / 1000;
  S.state = state;
  card.dataset.state = state;
  card.dataset.risk = S.risk;
  $("eyebrow").textContent = label || (LABELS[state] ? LABELS[state]() : state);
  $("foot").textContent = FOOT[state] ? FOOT[state]() : "";
  blip.live(state === "listening");
  blip.pose(poseFor());
}
function poseFor() {
  // Blip peeks up once the card has bloomed, not before: the card is what
  // it stands on.
  if (!S.shown || !LIFE.landed) return "hidden";
  switch (S.state) {
    case "listening": return "listening";
    case "thinking": return "thinking";
    case "confirm": case "permission": return "confirm";
    case "done": return "done";
    case "error": return "oops";
    default: return S.ring && !S.ring.tentative ? "point" : "peek";
  }
}
/** The words, each rising into place a moment after the one before.
 *  `append`: added after what is there, and only the new words rise; an
 *  answer that grows a sentence at a time keeps the ones already read
 *  still, and follows the new ones down unless they have scrolled up to
 *  read back. */
function words(el, text, append) {
  const follow = append && el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  if (!append) { el.textContent = ""; el.scrollTop = 0; }
  else if (el.childNodes.length) el.appendChild(document.createTextNode(" "));
  const parts = String(text || "").split(/(\s+)/);
  let i = 0;
  for (const p of parts) {
    if (!p) continue;
    if (/^\s+$/.test(p)) { el.appendChild(document.createTextNode(" ")); continue; }
    const w = document.createElement("span");
    w.className = "w"; w.textContent = p;
    w.style.animationDelay = Math.min(1600, i++ * K.num("desktop.guide.wordMs", 34)) + "ms";
    el.appendChild(w);
  }
  if (follow) requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight, behavior: reduced ? "auto" : "smooth" }));
}
function setSteps(items) {
  const ol = $("steps");
  ol.textContent = "";
  (items || []).slice(0, 6).forEach((it, i) => {
    const li = document.createElement("li");
    // agent.js says "active" for the step under way.
    const raw = typeof it === "string" ? "todo" : it.state || "todo", st = raw === "active" ? "doing" : raw;
    li.dataset.s = st;
    const n = document.createElement("i"); const b = document.createElement("b"); b.textContent = String(i + 1); n.appendChild(b);
    const t = document.createElement("span"); t.textContent = typeof it === "string" ? it : it.text;
    li.append(n, t); ol.appendChild(li);
  });
}
/** "Send to #design: “The mockups are ready!”" → what it is, and the words. */
function splitConfirm(text) {
  const m = /^(.{2,80}?):\s*[“"«](.+)[”"»]\s*\??\s*$/s.exec(String(text || ""));
  if (m) return [m[1], m[2]];
  return [S.risk === "always" ? K.txt("desktop.guide.confirmAlwaysWhat", "This can't be undone") : K.txt("desktop.guide.confirmWhat", "About to"), String(text || "")];
}
