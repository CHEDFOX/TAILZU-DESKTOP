// guide.html's script: the card, the ring, the thread, Blip, the tether to
// the pill, and the marks it draws on the screen.
//
// The main process says what to show (channel "guide", see agent.js and
// ask.js); this page decides where. A question grows out of the pill: a
// thread rises from the gap between its halves, the card blooms at the
// thread's end and stays tied to it while it is up, and folds back into it
// when it goes (docked: desktop.guide.dock). Docked, the card sits above the
// pill and moves only to keep clear of what it rings, sideways along the
// bottom, the tether bending after it. Not docked (the knob off, or the pill
// on another display), the card sits beside what it is talking about, as it
// did before it had a pill: below the ringed thing if there is room, else
// above, else to a side, and near the cursor when there is nothing to ring.
// Blip peeks over the card's edge on the side nearer the ring and points at
// it; a dotted thread runs from its finger to the ring. The marks are a
// teacher's pen: circles, arrows, underlines and numbers drawn on the screen
// as a hand would draw them, under everything else.
(function () {
  "use strict";
  const K = window.TailzuKnobs;
  const params = new URLSearchParams(location.search);
  const DEMO = params.has("demo");
  // Frame-exact review (?demo=<scene>&capture): the page's clock stands still
  // and moves only when window.__step(ms) says, as pill.html's does, so a
  // screenshot is of exactly that moment of a bloom or a fold rather than of
  // whenever the browser got round to it.
  const CAPTURE = DEMO && params.has("capture");
  const bridge = window.tailzuGuide || fakeBridge();
  const reduced = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const TAU = Math.PI * 2;
  const $ = (id) => document.getElementById(id);
  const card = $("card"), inner = $("inner"), fx = $("fx"), chip = $("chip"), wave = $("wave");
  const ctx = fx.getContext("2d");
  const wctx = wave.getContext("2d");
  const blip = window.TailzuBlip.createBlip({ height: K.num("desktop.guide.blipHeight", 112) });

  // ---- time -----------------------------------------------------------------------
  let virtual = 0;
  /** Milliseconds on the page's clock: a virtual one under ?capture. */
  const now = () => (CAPTURE ? virtual : performance.now());
  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, k) => a + (b - a) * k;
  const outCubic = (k) => 1 - Math.pow(1 - clamp(k), 3);
  const inCubic = (k) => Math.pow(clamp(k), 3);
  const inQuad = (k) => clamp(k) * clamp(k);
  const outBack = (k) => { const c = 1.9, x = clamp(k) - 1; return 1 + (c + 1) * x * x * x + c * x * x; };
  /** CSS's cubic-bezier(), as a function of time 0..1. */
  function cubicBezier(x1, y1, x2, y2) {
    const at = (t, a, b) => 3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t;
    return (x) => {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      let lo = 0, hi = 1, t = x;
      for (let i = 0; i < 22; i++) { t = (lo + hi) / 2; if (at(t, x1, x2) < x) lo = t; else hi = t; }
      return at(t, y1, y2);
    };
  }
  // The bloom: out quickly, a touch past its size, and back. The fold is the
  // same reversed, without the overshoot: an ease-in, so it is pulled home.
  const BLOOM = cubicBezier(.2, 1.25, .35, 1);
  function rgba(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
  }

  const S = {
    shown: false,
    state: "listening",
    stateAt: 0,          // seconds: when the state last changed (the thinking light runs from it)
    errAt: -1e9,         // seconds: when it last went wrong (the tether's end dot goes rose)
    risk: "confirm",
    ring: null,          // { frame:[x,y,w,h], caption, at, tentative }
    where: "default",    // where the card went: dock, below / above / right / left (of the ring), anchor, default
    box: null,           // the card's rectangle as laid out (where it is going, not where it is)
    cur: null,           // { x, y, w, h, bottom }: where it is this frame, on its way to box
    anchor: null,        // [x, y]: where to be when there is nothing to ring
    dock: null,          // { pill: {x,y,w,h} | null, seed }: as ask.js last said (dock)
    slid: false,         // tied to the pill, it has gone aside for a ring (and stays there)
    P: null,             // the pill (or the seed) the card is tied to as laid out; null: not tied
    docked: false,
    // The card's birth or fold: open, since when (ms), tied to the pill or
    // not, and where it all was when it began (so a fold that is turned round
    // goes back from where it got to).
    life: { open: false, at: -1e12, docked: false, from: { tether: 0, k: 0, ky: 0, alpha: 0, inner: 0 } },
    lineMix: 1,          // the tether as listening's line (1) or as dots (0)
    level: 0, levelTo: 0,
    hideAt: 0,
    speaking: false,
    lastFrame: 0,
    chipBox: null,       // where the ring's label is, while it is on
    // What of the window is not the work area: on a Mac the window covers
    // the whole display so the menu bar's items can be ringed, and the card
    // keeps clear of the menu bar and the Dock.
    inset: { top: 0, right: 0, bottom: 0, left: 0 },
  };
  let dpr = 1, W = 0, H = 0;

  // ---- the canvas ------------------------------------------------------------
  function resize() {
    dpr = window.devicePixelRatio || 1;
    W = window.innerWidth; H = window.innerHeight;
    fx.width = Math.round(W * dpr); fx.height = Math.round(H * dpr);
    fx.style.width = W + "px"; fx.style.height = H + "px";
    const ww = wave.clientWidth || 312, wh = wave.clientHeight || 30;
    wave.width = Math.round(ww * dpr); wave.height = Math.round(wh * dpr);
    capCard();
    place(true);
    wake();
  }
  window.addEventListener("resize", resize);

  // ---- where the card goes ---------------------------------------------------
  const M = 16;                       // keep this far from the window's edge
  const HEAD = 60;                    // room above the card for Blip's head
  const SEED_R = 3.5;                 // the seed's radius: the pill's bead, as the guide draws its own
  const ROUND = 18;                   // the card's corner (guide.html --r)
  /** Where the card may be: the work area, less a margin. */
  function room() {
    const i = S.inset;
    return { l: i.left + M, t: i.top + M, r: W - i.right - M, b: H - i.bottom - M };
  }
  // The height it is growing to, not the one it is passing through.
  function cardSize() { return [card.offsetWidth || K.num("desktop.guide.width", 348), inner.offsetHeight || 120]; }
  function clampX(x, w) { const a = room(); return Math.max(a.l, Math.min(a.r - w, x)); }
  function clampY(y, h) { const a = room(); return Math.max(a.t + HEAD, Math.min(a.b - h, y)); }
  /**
   * What the card is tied to, in this window's coordinates: the pill, where
   * ask.js says it is (dock); else a seed of the guide's own at the bottom of
   * the room, for the thread to rise from. Null when the card is tied to
   * nothing: the knob is off, or the pill is on another display than this
   * window (`seed: false`), where the card is placed as it was before it had
   * a pill.
   */
  function pillRect() {
    if (!K.bool("desktop.guide.dock", true)) return null;
    const d = S.dock;
    if (d && d.pill) return d.pill;
    if (d && d.seed === false) return null;
    const a = room();
    const cx = (a.l + a.r) / 2, cy = a.b - K.num("desktop.guide.seedOffset", 40);
    return { x: cx - SEED_R, y: cy - SEED_R, w: 2 * SEED_R, h: 2 * SEED_R, seed: true };
  }
  /** Never taller than the room there is, Blip's head included: a long
   *  answer, a plan and a quote together once pushed Do it and Not now off
   *  the bottom of a small screen. What overflows is the answer and the
   *  plan, which scroll; the quote and the buttons are always there. Tied
   *  to the pill, the room is what is above the tether. */
  function capCard() {
    const a = room(), P = pillRect();
    const bottom = P ? Math.min(a.b, P.y - K.num("desktop.guide.tether", 56)) : a.b;
    inner.style.maxHeight = Math.max(160, Math.floor(bottom - a.t - HEAD)) + "px";
  }
  /** The ring the card keeps beside. A tentative one while they are still
   *  talking is not: the guess changes with their words, and the card they
   *  are watching would chase it across the screen. */
  function placedRing() {
    return S.ring && !(S.ring.tentative && S.state === "listening") ? S.ring : null;
  }
  /** The card's top-left, and what it is beside. */
  function layout(P) {
    const [cw, ch] = cardSize();
    if (P) return docked(P, cw, ch);
    const ring = placedRing();
    if (ring) return beside(ring, cw, ch);
    const a = room();
    const blipRoom = K.num("desktop.guide.blipRoom", 66);   // Blip's head sticks up this far over the card
    if (S.anchor) {
      const [ax, ay] = S.anchor;
      const x = clampX(ax - cw * .3, cw);
      const below = Math.max(ay + 28 + blipRoom, a.t + HEAD);
      return [x, below + ch <= a.b ? below : clampY(ay - 28 - ch, ch), "anchor"];
    }
    // Nowhere in particular: low and centred, above where the pill lives.
    return [clampX((a.l + a.r - cw) / 2, cw), clampY(a.b - ch - K.num("desktop.guide.bottomOffset", 110), ch), "default"];
  }
  /** Beside the ring: below it if there is room, else above, else level with it. */
  function beside(ring, cw, ch) {
    const a = room();
    const blipRoom = K.num("desktop.guide.blipRoom", 66);
    const pad = K.num("desktop.guide.ringPad", 6);
    const [rx, ry, rw, rh] = ring.frame;
    const r = { x: rx - pad, y: ry - pad, w: rw + 2 * pad, h: rh + 2 * pad };
    const x = clampX(r.x + r.w / 2 - cw * .32, cw);
    const gap = 18;
    // Below, with Blip's head between the ring and the card.
    const below = Math.max(r.y + r.h + gap + blipRoom, a.t + HEAD);
    if (below + ch <= a.b) return [x, below, "below"];
    // Above, a little further off: the thread runs down from the card to it.
    if (r.y - gap * 2 - ch >= a.t + blipRoom) return [x, r.y - gap * 2 - ch, "above"];
    // Beside: whichever side has room, level with the ring.
    const y = clampY(r.y + r.h / 2 - ch / 2, ch);
    if (r.x + r.w + gap * 2 + cw <= a.r) return [r.x + r.w + gap * 2, y, "right"];
    if (r.x - gap * 2 - cw >= a.l) return [r.x - gap * 2 - cw, y, "left"];
    return [x, clampY(a.b - ch, ch), "default"];
  }
  /**
   * TIED TO THE PILL: the card's bottom edge a tether's length above it,
   * centred on it. What the card (Blip's head included) would cover of the
   * answer's ring or of the marks drawn on the screen sends it sideways along
   * the bottom, to just right or just left of what it covered, wherever it
   * then covers none of them and moves least; the tether bends after it. A
   * ring too big for that (a whole pane) gets the card beside it as before
   * it had a pill, still tied. Marks it cannot get clear of it covers.
   */
  function docked(P, cw, ch) {
    const a = room();
    const x = clampX(P.x + P.w / 2 - cw / 2, cw);
    const y = clampY(P.y - K.num("desktop.guide.tether", 56) - ch, ch);
    // Only an answer's ring moves it. A tentative one is a guess, or the
    // picture being looked at, which can be the whole window: kept clear of,
    // it sent the card gliding across the screen in the middle of an
    // answer, for a ring it can never be clear of.
    const ring = S.ring && !S.ring.tentative ? S.ring : null;
    // The marks too: the first one takes the place of the picture's
    // tentative ring, and the card, back over the pill, sat on the very
    // triangle it was drawing on, Blip's head over two of its marks.
    const keep = [];
    if (ring) {
      const pad = K.num("desktop.guide.ringPad", 6) + 12;    // the ring's marching dots, and a breath
      const [rx, ry, rw, rh] = ring.frame;
      keep.push([rx - pad, ry - pad, rx + rw + pad, ry + rh + pad]);
    }
    for (const m of marks) if (!m.fadeAt && m.area) keep.push([m.area[0] - 10, m.area[1] - 10, m.area[0] + m.area[2] + 10, m.area[1] + m.area[3] + 10]);
    // Gone aside, it stays aside when what it made room for goes: it moves
    // to make room, and coming back as an answer ends was movement for
    // nothing. The next card starts over the pill.
    if (!keep.length) return [S.slid && S.box ? clampX(S.box.x, cw) : x, y, "dock"];
    const blipRoom = K.num("desktop.guide.blipRoom", 66);
    const over = (cx) => keep.some(([l, t, r, b]) => cx < r && cx + cw > l && y - blipRoom < b && y + ch > t);
    if (!over(x)) return [x, y, "dock"];
    // Far enough off that the thread to the ring still shows between them;
    // nearer, down to a small gap, where the screen's edge leaves less room
    // (a wide ring, a message box across the window), rather than give up
    // the bottom and go over the ring with the tether through it.
    const gap = K.num("desktop.guide.slideGap", 44), least = 12;
    let best = null;
    for (const [l, , r] of keep) {
      for (const cx of [Math.min(r + gap, a.r - cw), Math.max(l - gap - cw, a.l)]) {
        if (cx < a.l || cx + cw > a.r || over(cx) || (cx > x ? cx < r + least : cx + cw > l - least)) continue;
        if (best === null || Math.abs(cx - x) < Math.abs(best - x)) best = cx;
      }
    }
    if (best !== null) return [best, y, "dock"];
    if (!ring) return [x, y, "dock"];
    // Still tied: never lower than the tether lets it be, or the thread
    // between it and the pill would be all but gone.
    const v1 = beside(ring, cw, ch);
    return [v1[0], Math.min(v1[1], y), v1[2]];
  }
  function place(instant) {
    if (!S.shown) return;
    const P = pillRect();
    S.P = P; S.docked = !!P;
    const [lx, ly, where] = layout(P);
    const [cw, ch] = cardSize();
    if (P) S.slid = Math.abs(lx - clampX(P.x + P.w / 2 - cw / 2, cw)) > 1;
    // Up, and tied to the pill now when it came up tied to nothing (the
    // pill is back on this display): the thread grows up to it from the
    // pill, the card as it is. Its life was not a docked one, and the
    // tether is only drawn for one that is.
    if (P && S.life.open && !S.life.docked) {
      const o = lifeAt(now());
      S.life = { open: true, at: now(), docked: true, from: { tether: 0, k: 1, ky: 1, alpha: o.alpha, inner: o.inner } };
    }
    // Whatever the ring's place, the card itself is always all on screen.
    const x = clampX(lx, cw), y = clampY(ly, ch);
    S.where = where; S.box = { x, y, w: cw, h: ch };
    if (instant || !S.cur) S.cur = { x, y, w: cw, h: ch, bottom: y + ch };
    placeChip();
    relabel();
    wake();
  }
  /** The card's height follows its content, smoothly (moveCard). */
  const fit = () => place(false);
  new ResizeObserver(fit).observe(inner);
  const near = (v, to) => (Math.abs(v - to) < .05 ? to : v);
  /** The card on its way to where it was laid out: it glides there. Tied to
   *  the pill its bottom edge is what is placed, so a growing answer grows
   *  the card upward and the tether's end stays put. */
  function moveCard(dt) {
    const b = S.box, c = S.cur;
    if (!b || !c) return;
    // Under reduced motion it does not glide or grow: it is where it goes,
    // at the height it is, as it was when CSS moved it (only its opacity
    // was ever eased then).
    const kp = reduced ? 1 : 1 - Math.exp(-dt * K.num("desktop.guide.glideRate", 11));
    const kh = reduced ? 1 : 1 - Math.exp(-dt * K.num("desktop.guide.fitRate", 15));
    c.w = b.w;
    c.x = near(c.x + (b.x - c.x) * kp, b.x);
    c.h = near(c.h + (b.h - c.h) * kh, b.h);
    if (S.docked) { c.bottom = near(c.bottom + (b.y + b.h - c.bottom) * kp, b.y + b.h); c.y = c.bottom - c.h; }
    else { c.y = near(c.y + (b.y - c.y) * kp, b.y); c.bottom = c.y + c.h; }
  }
  /** Where the thread meets the card: under the pill, as far along the
   *  card's bottom edge as it reaches, 40 px short of its corners. */
  function attachX(c) {
    const P = S.P;
    const px = P ? P.x + P.w / 2 : c.x + c.w / 2;
    return clamp(px, c.x + 40, c.x + c.w - 40);
  }
  const snap = (v) => Math.round(v * dpr) / dpr;

  // ---- the birth and the fold ----------------------------------------------------
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
    ctx.strokeStyle = "#F3E2C6"; ctx.lineWidth = 1.2; ctx.stroke();
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

  // ---- the ring and its label --------------------------------------------------
  function placeChip() {
    if (!S.ring || !S.ring.caption || S.ring.tentative) { chip.classList.remove("on"); S.chipBox = null; return; }
    const pad = K.num("desktop.guide.ringPad", 6);
    const [rx, ry, rw, rh] = S.ring.frame;
    const cw = chip.offsetWidth || 80, chh = chip.offsetHeight || 24;
    const x = Math.max(M, Math.min(W - M - cw, rx - pad));
    // Above the ring, else below it, else to one side: wherever the card is
    // not, and always on screen. A target at the very top (a tab, a toolbar,
    // a menu-bar item) has no room above it, and the card below takes the
    // spot under it, so the side spots sit level with it, kept in the window.
    const b = S.box, hits = (cx, cy) => b && cx < b.x + b.w && cx + cw > b.x && cy < b.y + b.h + 8 && cy + chh > b.y - 60;
    const ring = (cx, cy) => cx < rx + rw + pad && cx + cw > rx - pad && cy < ry + rh + pad && cy + chh > ry - pad;
    const inWin = (cx, cy) => cx >= M && cx + cw <= W - M && cy >= M && cy + chh <= H - M;
    const level = Math.max(M, Math.min(H - M - chh, ry + rh / 2 - chh / 2));
    // A number on the ring's corner (the step being done, ringed and
    // numbered both) keeps the corner: the label starts just past it, and
    // reads "2 · MESSAGE #DESIGN" rather than sitting on the number.
    const past = (sx, sy) => {
      for (const m of marks) {
        const d = m.disc;
        if (d && !m.fadeAt && sx < d.x + 13 && sx + cw > d.x - 13 && sy < d.y + 13 && sy + chh > d.y - 13) sx = d.x + 13 + 5;
      }
      return sx;
    };
    const above = ry - pad - 34, under = ry + rh + pad + 10;
    const spots = [[past(x, above), above], [past(x, under), under], [rx - pad - cw - 12, level], [rx + rw + pad + 12, level]];
    const fits = (s) => inWin(s[0], s[1]) && !ring(s[0], s[1]);
    const [cx, cy] = spots.find((s) => fits(s) && !hits(s[0], s[1])) || spots.find(fits)
      || [x, Math.max(M, Math.min(H - M - chh, spots[1][1]))];
    chip.style.setProperty("--x", Math.round(cx) + "px");
    chip.style.setProperty("--y", Math.round(cy) + "px");
    chip.classList.add("on");
    S.chipBox = { x: cx, y: cy, w: cw, h: chh };
  }

  function roundRect(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }
  /** A point `d` along a rounded rectangle's edge, clockwise from its top-left. */
  function alongRect(x, y, w, h, d) {
    const P = 2 * (w + h); d = ((d % P) + P) % P;
    if (d < w) return [x + d, y];
    if (d < w + h) return [x + w, y + d - w];
    if (d < 2 * w + h) return [x + w - (d - w - h), y + h];
    return [x, y + h - (d - 2 * w - h)];
  }
  function dot(g, x, y, r, fill) {
    g.beginPath(); g.arc(x, y, r + .9, 0, TAU); g.fillStyle = "rgba(15,13,11,.62)"; g.fill();
    g.beginPath(); g.arc(x, y, r, 0, TAU); g.fillStyle = fill || "#F3E2C6"; g.fill();
  }
  function drawRing(t) {
    const R = S.ring; if (!R) return;
    if (R.tentative) { drawHint(t, R); return; }
    const pad = K.num("desktop.guide.ringPad", 6);
    const k = Math.min(1, (t - R.at) / .32), e = 1 - Math.pow(1 - k, 3);
    const back = 1 + (1 - e) * .28 + Math.sin(Math.PI * k) * .04;
    const [fx0, fy0, fw, fh] = R.frame;
    const cx = fx0 + fw / 2, cy = fy0 + fh / 2;
    const w = (fw + 2 * pad) * back, h = (fh + 2 * pad) * back;
    const x = cx - w / 2, y = cy - h / 2, rad = Math.min(12, h / 2);
    ctx.save();
    ctx.globalAlpha = e * (S.hideAt ? Math.max(0, 1 - (t - S.hideAt) / .25) : 1);
    // The ripple, once, as it lands.
    const rk = (t - R.at - .2) / .7;
    if (rk > 0 && rk < 1 && !reduced) {
      const g = 10 * rk;
      roundRect(ctx, x - g, y - g, w + 2 * g, h + 2 * g, rad + g);
      ctx.strokeStyle = `rgba(232,162,60,${.5 * (1 - rk)})`; ctx.lineWidth = 2; ctx.stroke();
    }
    // The ring: amber, with its own glow, over an ink hairline that keeps it
    // visible on amber-ish backgrounds.
    roundRect(ctx, x, y, w, h, rad);
    ctx.strokeStyle = "rgba(15,13,11,.35)"; ctx.lineWidth = 4; ctx.stroke();
    ctx.shadowColor = "rgba(232,162,60,.65)"; ctx.shadowBlur = 14;
    ctx.strokeStyle = K.color("desktop.guide.ring", "#E8A23C"); ctx.lineWidth = 2; ctx.stroke();
    ctx.shadowBlur = 0;
    // Dots marching round it, a step outside: the films' dots.
    const gapPx = 11, o = 6, P = 2 * (w + 2 * o + h + 2 * o);
    const n = Math.floor(P / gapPx), shift = reduced ? 0 : (t * 14) % gapPx;
    for (let i = 0; i < n; i++) {
      const [px, py] = alongRect(x - o, y - o, w + 2 * o, h + 2 * o, i * gapPx + shift);
      dot(ctx, px, py, 1.25);
    }
    ctx.restore();
  }
  /** The tentative ring: what their words so far seem to name, or the part
   *  of the window a picture is being taken of. Drawn lightly — a thin
   *  dotted line that breathes, no glow, no ripple, no thread and no label —
   *  so a guess that changes with the next word never reads as an answer.
   *  The answer's own ring lands in its place. */
  function drawHint(t, R) {
    const pad = K.num("desktop.guide.ringPad", 6);
    const k = Math.min(1, (t - R.at) / .24), e = 1 - Math.pow(1 - k, 3);
    const breath = reduced ? 1 : .62 + .38 * (.5 + .5 * Math.sin((t - R.at) * K.num("desktop.guide.hintPulse", 4.2) - Math.PI / 2));
    const [fx0, fy0, fw, fh] = R.frame;
    const cx = fx0 + fw / 2, cy = fy0 + fh / 2;
    const grow = 1 + (1 - e) * .1 + (reduced ? 0 : (breath - .62) * .035);
    const w = (fw + 2 * pad) * grow, h = (fh + 2 * pad) * grow;
    const x = cx - w / 2, y = cy - h / 2, rad = Math.min(12, h / 2);
    ctx.save();
    ctx.globalAlpha = e * breath * (S.hideAt ? Math.max(0, 1 - (t - S.hideAt) / .25) : 1);
    ctx.lineCap = "round";
    // Round dots, each with an ink rim so they hold on a white page, the
    // way the ring's own marching dots do; walking slowly round.
    ctx.setLineDash([0, K.num("desktop.guide.hintGap", 6)]);
    ctx.lineDashOffset = reduced ? 0 : -t * 9;
    roundRect(ctx, x, y, w, h, rad);
    ctx.strokeStyle = "rgba(15,13,11,.4)"; ctx.lineWidth = 3.8; ctx.stroke();
    ctx.strokeStyle = K.color("desktop.guide.hint", "#E8A23C"); ctx.lineWidth = 2.6; ctx.stroke();
    ctx.restore();
  }
  /** Tied to the pill, a ring lower than the card's top (a Dock icon,
   *  something beside the pill) is one Blip cannot point at without
   *  reaching down through the card: the thread leaves the card's own edge
   *  for it, and Blip only looks. */
  function lowRing(rc) {
    const R = S.ring;
    return !!(S.docked && R && !R.tentative && rc && R.frame[1] + R.frame[3] / 2 > rc.top);
  }
  /** The thread: dots from Blip's fingertip to the nearest edge of the ring. */
  function drawThread(t, rc) {
    const R = S.ring;
    if (!R || R.tentative) return;
    const [rx, ry, rw, rh] = R.frame;
    const rcx = rx + rw / 2, rcy = ry + rh / 2;
    // From Blip's finger; or, when the card sits above the ring and Blip
    // cannot reach past it, from the card's own bottom edge; or, for a ring
    // lower than the card's top, from the card's nearer side, at the ring's
    // height.
    let tip = blip.fingertip();
    if (rc && (S.where === "above" || (lowRing(rc) && ry > rc.bottom && rcx > rc.left && rcx < rc.right))) {
      tip = [Math.max(rc.left + 28, Math.min(rc.right - 28, rcx)), rc.bottom + 4];
    } else if (rc && lowRing(rc)) {
      const right = rcx > (rc.left + rc.right) / 2;
      tip = [right ? rc.right + 4 : rc.left - 4, Math.max(rc.top + 18, Math.min(rc.bottom - 18, rcy))];
    }
    if (!tip) return;
    const pad = K.num("desktop.guide.ringPad", 6) + 9;
    const tx = Math.max(rx - pad, Math.min(rx + rw + pad, tip[0]));
    const ty = Math.max(ry - pad, Math.min(ry + rh + pad, tip[1]));
    const dx = tx - tip[0], dy = ty - tip[1], L = Math.hypot(dx, dy);
    if (L < 14) return;
    // A gentle arc, bowing away from the card.
    let nx = -dy / L, ny = dx / L;
    const bow = Math.min(60, L * .18), mx = (tip[0] + tx) / 2, my = (tip[1] + ty) / 2;
    if (rc) {
      const ccx = (rc.left + rc.right) / 2, ccy = (rc.top + rc.bottom) / 2;
      if (Math.hypot(mx - nx * bow - ccx, my - ny * bow - ccy) > Math.hypot(mx + nx * bow - ccx, my + ny * bow - ccy)) { nx = -nx; ny = -ny; }
    }
    const cxp = mx + nx * bow, cyp = my + ny * bow;
    const k = reduced ? 1 : Math.min(1, Math.max(0, (t - R.at - .12) / .38));
    const n = Math.max(2, Math.floor(L / 8));
    ctx.save();
    ctx.globalAlpha = S.hideAt ? Math.max(0, 1 - (t - S.hideAt) / .2) : 1;
    for (let i = 1; i <= n * k; i++) {
      const u = i / n, a = 1 - u;
      const px = a * a * tip[0] + 2 * a * u * cxp + u * u * tx, py = a * a * tip[1] + 2 * a * u * cyp + u * u * ty;
      dot(ctx, px, py, i === n ? 2 : 1.35);
    }
    ctx.restore();
  }

  // ---- the tether: from the pill to the card ---------------------------------------
  // A cubic from the bead (the pill's centre; main.js keeps the pill's window
  // over this one, so the pill hides the first few pixels and the thread
  // reads as coming out of the gap between its halves) to the card's bottom
  // edge. It leaves the pill straight up and arrives straight up: straight
  // when the card is centred, an S when it has gone aside. Sampled into
  // buffers made once, so drawing it every frame makes nothing new.
  const TN = 48;
  const tq = new Float64Array((TN + 1) * 2);
  const tl = new Float64Array(TN + 1);
  const tline = new Float64Array(2 * 400);
  const PT = [0, 0, 0, 0];
  function tetherCurve(x0, y0, x3, y3) {
    const span = Math.max(24, Math.abs(y0 - y3));
    // Handles three quarters of the rise: with half, a card gone far aside
    // hung from a thread that read as a slack wire sagging to the pill,
    // not one that leaves the pill straight up and goes into the card.
    const y1 = y0 - span * .75, y2 = y3 + span * .75;
    let len = 0;
    for (let i = 0; i <= TN; i++) {
      const u = i / TN, a = 1 - u;
      const x = a * a * a * x0 + 3 * a * a * u * x0 + 3 * a * u * u * x3 + u * u * u * x3;
      const y = a * a * a * y0 + 3 * a * a * u * y1 + 3 * a * u * u * y2 + u * u * u * y3;
      if (i) len += Math.hypot(x - tq[2 * i - 2], y - tq[2 * i - 1]);
      tq[2 * i] = x; tq[2 * i + 1] = y; tl[i] = len;
    }
    return len;
  }
  /** The point `s` along the tether and the way it runs there, into PT. */
  function pointOn(s) {
    let i = 1;
    while (i < TN && tl[i] < s) i++;
    const s0 = tl[i - 1], s1 = tl[i], k = s1 > s0 ? clamp((s - s0) / (s1 - s0)) : 0;
    const ax = tq[2 * i - 2], ay = tq[2 * i - 1], bx = tq[2 * i], by = tq[2 * i + 1];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1;
    PT[0] = ax + dx * k; PT[1] = ay + dy * k; PT[2] = dx / L; PT[3] = dy / L;
    return PT;
  }
  /** A hand's tremor: one offset per point, new a dozen times a second (the
   *  pill's thread boils the same way). */
  const tremor = (i, boil) => { const v = Math.sin(i * 12.9898 + boil * 78.233) * 43758.5453; return 2 * (v - Math.floor(v)) - 1; };
  function drawTether(t, o) {
    const P = S.P, c = S.cur;
    if (!P || !c || !S.life.docked) return;
    if (o.tether <= .001 && !(P.seed && o.seed > .01)) return;
    const x0 = P.x + P.w / 2, y0 = P.y + P.h / 2;
    const total = tetherCurve(x0, y0, attachX(c), c.bottom);
    const reach = total * clamp(o.tether);
    const mix = S.lineMix;
    ctx.save();
    if (reach > .5) {
      if (mix > .01) { ctx.globalAlpha = o.fade * mix; tetherLine(t, total, reach); }
      if (mix < .99) tetherDots(t, total, reach, o.fade * (1 - mix));
    }
    // Its tip, while it grows or is pulled home: a bigger dot, the bead
    // carrying the card up, and taking it back down.
    if (o.tether > .01 && o.tether < .995 && !reduced) {
      pointOn(reach);
      ctx.globalAlpha = o.fade;
      dot(ctx, PT[0], PT[1], 2.4, mix > .5 ? K.color("desktop.guide.tetherLive", "#E8A23C") : "#F3E2C6");
    }
    // No pill on this display: the seed it rises from, drawn here.
    if (P.seed && o.seed > .01) {
      const r = SEED_R * o.seed;
      ctx.globalAlpha = o.fade;
      ctx.beginPath(); ctx.arc(x0, y0, r + 1, 0, TAU); ctx.fillStyle = "rgba(15,13,11,.7)"; ctx.fill();
      ctx.beginPath(); ctx.arc(x0, y0, r, 0, TAU); ctx.fillStyle = "#F3E2C6"; ctx.fill();
    }
    ctx.restore();
  }
  /** Listening: an amber line over an ink hair (the pill's split thread),
   *  plucked by the voice: a standing wave along it that the level drives,
   *  and a little tremor. Its ends stay where they are tied. */
  function tetherLine(t, total, reach) {
    const amp = reduced ? 0 : K.num("desktop.guide.tetherAmp", 7) * clamp(S.level);
    const boil = Math.floor(t * 12), hand = reduced ? 0 : K.num("desktop.guide.tetherHand", 0.45);
    // A point every 5 px, or further apart on a thread longer than the
    // buffer holds (a card gone aside across an ultra-wide display): a fixed
    // 5 px stopped the line 2000 px out, short of the card.
    const gap = Math.max(5, reach / 396);
    let n = 0;
    for (let s = 0; n < 399; s += gap) {
      const ss = Math.min(s, reach);
      pointOn(ss);
      const u = ss / total, env = Math.sin(Math.PI * u);
      const w = amp * (env * Math.sin(t * TAU * 5.2) + .35 * Math.sin(TAU * u) * Math.sin(t * TAU * 7.9 + 1.3)) + env * hand * tremor(n, boil);
      tline[2 * n] = PT[0] - PT[3] * w; tline[2 * n + 1] = PT[1] + PT[2] * w;
      n++;
      if (ss >= reach) break;
    }
    const trace = () => {
      ctx.beginPath(); ctx.moveTo(tline[0], tline[1]);
      for (let i = 1; i < n - 1; i++) ctx.quadraticCurveTo(tline[2 * i], tline[2 * i + 1], (tline[2 * i] + tline[2 * i + 2]) / 2, (tline[2 * i + 1] + tline[2 * i + 3]) / 2);
      ctx.lineTo(tline[2 * n - 2], tline[2 * n - 1]);
    };
    const tw = K.num("desktop.guide.tetherWidth", 1.6);
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    trace(); ctx.strokeStyle = "rgba(15,13,11,.3)"; ctx.lineWidth = tw + 1.6; ctx.stroke();
    trace(); ctx.strokeStyle = K.color("desktop.guide.tetherLive", "#E8A23C"); ctx.lineWidth = tw; ctx.stroke();
  }
  /** Not listening: cream dots, every 8 px, still. Thinking, a light runs up
   *  them from the pill to the card (the card's own row of dots does the
   *  same). Gone wrong, the dot by the card is rose for a moment. */
  function tetherDots(t, total, reach, alpha) {
    const thinking = S.state === "thinking" && !reduced;
    const head = thinking ? ((t - S.stateAt) * .85) % 1.35 - .15 : -9;
    const rose = S.state === "error" ? clamp(1 - (t - S.errAt) / 1.6) : 0;
    // About 8 px apart, spread evenly from the gap in the pill to just under
    // the card's edge, so the last dot touches the card wherever it is. A dot
    // every 8 px from the pill ended anywhere up to 8 px short of the card,
    // and the thread looked as if it did not reach it. (The spacing depends
    // on the whole thread, never on how far it has grown: the dots do not
    // slide while it grows or is pulled home.)
    const s0 = 4, end = Math.max(s0, total - 3), n = Math.max(1, Math.round((end - s0) / 8)), gap = (end - s0) / n;
    for (let i = 0; i <= n; i++) {
      const s = s0 + i * gap;
      if (s > reach) break;
      pointOn(s);
      const glow = thinking ? Math.exp(-Math.pow((s / total - head) / .09, 2)) : 0;
      // The light is the dots coming up to full where it is, from faint:
      // over a white page a brighter cream would not show, a stronger dot does.
      ctx.globalAlpha = alpha * (thinking ? .3 + .7 * glow : 1);
      const last = i === n || s + gap > reach;
      dot(ctx, PT[0], PT[1], 1.35 + glow * 1.1, last && rose > 0 ? mixRose(rose) : undefined);
    }
  }
  function mixRose(k) {
    const a = [243, 226, 198], b = [228, 88, 123];
    return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * k)).join(",")})`;
  }

  // ---- the pen: marks on the screen ----------------------------------------------
  // The model marks up the screen while it explains, as a teacher uses a pen:
  // a circle round part of a diagram, an arrow from a label to what it names,
  // the places to click numbered. Each mark is drawn as a hand draws it, in
  // order, in amber over an ink edge, and it looks the same on every frame:
  // its wobble is seeded by its id and worked out once, when it arrives.
  const KINDS = new Set(["box", "circle", "underline", "highlight", "arrow", "number", "label", "path"]);
  const marks = [];
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  // A mark is drawn in this window or not at all: its geometry is held to
  // the window, a little over its edges at most. A frame sent a million px
  // wide is a line walked every 2 px when the mark is made, and the page
  // hung on it; one wholly off the window has nothing here to mark.
  const OVER = 16;
  const inX = (v) => clamp(v, -OVER, W + OVER), inY = (v) => clamp(v, -OVER, H + OVER);
  function asFrame(f) {
    if (!Array.isArray(f) || f.length !== 4) return null;
    const [x, y, w, h] = f.map(Number);
    if (![x, y, w, h].every(isNum) || w < 0 || h < 0) return null;
    if (x > W + OVER || y > H + OVER || x + w < -OVER || y + h < -OVER) return null;
    const x0 = inX(x), y0 = inY(y);
    return [x0, y0, inX(x + w) - x0, inY(y + h) - y0];
  }
  function asPoint(p) {
    if (!Array.isArray(p) || p.length !== 2) return null;
    const [x, y] = p.map(Number);
    return isNum(x) && isNum(y) ? [inX(x), inY(y)] : null;
  }
  /** A point or a frame, by its length. */
  const asSpot = (s) => asFrame(s) || asPoint(s);
  function seedOf(id) {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function rand(seed) {
    let a = seed | 0;
    return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  /**
   * A line as a hand draws it. `raw` is the line meant ([x0, y0, x1, y1, …],
   * finely sampled); it is resampled every 6 px, each point nudged across the
   * line by smooth noise (three slow waves, seeded), and its ends carried 2 px
   * past where they were meant to stop (`over`: [start, end]). `drift(s, len)`
   * nudges further, for a shape whose end runs on over its start, so the end
   * does not trace the start exactly. Returns { pts, cum, len }.
   */
  function hand(raw, rnd, amp, over, drift) {
    const n = raw.length / 2;
    let total = 0;
    const segs = new Float64Array(Math.max(1, n));
    for (let i = 1; i < n; i++) { total += Math.hypot(raw[2 * i] - raw[2 * i - 2], raw[2 * i + 1] - raw[2 * i - 1]); segs[i] = total; }
    const step = 6, count = Math.max(2, Math.ceil(total / step) + 1);
    const xs = new Float64Array(count), ys = new Float64Array(count);
    let j = 1;
    for (let k = 0; k < count; k++) {
      const s = Math.min(total, k * step);
      while (j < n - 1 && segs[j] < s) j++;
      const s0 = segs[j - 1] || 0, s1 = segs[j] || 0, f = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
      xs[k] = raw[2 * j - 2] + (raw[2 * j] - raw[2 * j - 2]) * f;
      ys[k] = raw[2 * j - 1] + (raw[2 * j + 1] - raw[2 * j - 1]) * f;
      if (n === 1) { xs[k] = raw[0]; ys[k] = raw[1]; }
    }
    // Mostly slow bends, the way a hand drifts off a line and comes back,
    // and only a faint quick tremor: quicker waves made a line look like a
    // caterpillar, not a pen.
    const f1 = TAU / (70 + rnd() * 50), f2 = TAU / (22 + rnd() * 10), f3 = TAU / (180 + rnd() * 120);
    const p1 = rnd() * TAU, p2 = rnd() * TAU, p3 = rnd() * TAU;
    const noise = (s) => (.6 * Math.sin(s * f1 + p1) + .14 * Math.sin(s * f2 + p2) + .5 * Math.sin(s * f3 + p3)) / 1.2;
    const out = [];
    for (let k = 0; k < count; k++) {
      const a = Math.max(0, k - 1), b = Math.min(count - 1, k + 1);
      const dx = xs[b] - xs[a], dy = ys[b] - ys[a], L = Math.hypot(dx, dy) || 1;
      const s = Math.min(total, k * step);
      const off = amp * noise(s) + (drift ? drift(s, total) : 0);
      out.push(xs[k] - dy / L * off, ys[k] + dx / L * off);
    }
    // The ends, carried on a little: a hand does not stop on the dot.
    const m = out.length / 2;
    if (m >= 2) {
      const ext = (i, k, d) => { const dx = out[2 * i] - out[2 * k], dy = out[2 * i + 1] - out[2 * k + 1], L = Math.hypot(dx, dy) || 1; return [out[2 * i] + dx / L * d, out[2 * i + 1] + dy / L * d]; };
      if (over[1]) { const e = ext(m - 1, m - 2, over[1]); out.push(e[0], e[1]); }
      if (over[0]) { const e = ext(0, 1, over[0]); out.unshift(e[0], e[1]); }
    }
    const pts = Float32Array.from(out), cum = new Float32Array(pts.length / 2);
    let len = 0;
    for (let i = 1; i < cum.length; i++) { len += Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]); cum[i] = len; }
    return { pts, cum, len };
  }
  /** A point `d` along a rounded rectangle, clockwise from the start of its top edge. */
  function alongRound(x, y, w, h, r, d) {
    const a = w - 2 * r, b = h - 2 * r, q = Math.PI / 2 * r;
    const arc = (cx, cy, from, dd) => { const th = from + dd / r; return [cx + r * Math.cos(th), cy + r * Math.sin(th)]; };
    if (d < a) return [x + r + d, y]; d -= a;
    if (d < q) return arc(x + w - r, y + r, -Math.PI / 2, d); d -= q;
    if (d < b) return [x + w, y + r + d]; d -= b;
    if (d < q) return arc(x + w - r, y + h - r, 0, d); d -= q;
    if (d < a) return [x + w - r - d, y + h]; d -= a;
    if (d < q) return arc(x + r, y + h - r, Math.PI / 2, d); d -= q;
    if (d < b) return [x, y + h - r - d]; d -= b;
    return arc(x + r, y + r, Math.PI, Math.min(d, q));
  }
  /** Where a line toward `q` leaves frame `f`, `gap` px off its edge. */
  function edgeToward(f, q, gap) {
    const cx = f[0] + f[2] / 2, cy = f[1] + f[3] / 2, hw = f[2] / 2 + gap, hh = f[3] / 2 + gap;
    const dx = q[0] - cx, dy = q[1] - cy;
    if (Math.abs(dx) <= hw && Math.abs(dy) <= hh) return [cx, cy];
    const k = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
    return [cx + dx * k, cy + dy * k];
  }
  const centreOf = (s) => (s.length === 4 ? [s[0] + s[2] / 2, s[1] + s[3] / 2] : s);
  /** Label spots: four candidate top-left corners for a label of w × h,
   *  around a rectangle, best first (above its left, below it, to its right,
   *  to its left). */
  const around = (x, y, w, h, first) => (lw, lh) => {
    const g = 6, mid = y + h / 2 - lh / 2;
    const above = [x, y - lh - g], below = [x, y + h + g], right = [x + w + g, mid], left = [x - lw - g, mid];
    return first === "below" ? [below, above, right, left] : first === "right" ? [right, left, above, below] : [above, below, right, left];
  };

  /** A mark, as the guide draws it: its strokes made by the hand, and where
   *  its label wants to be. Null for one that cannot be drawn. */
  function makeMark(m) {
    const kind = String(m.kind || "");
    if (!KINDS.has(kind)) return null;
    const id = String(m.id || "") || "m" + marks.length + ":" + Math.round(now());
    const rnd = rand(seedOf(id));
    const amp = K.num("desktop.guide.inkWobble", 1.2);
    // Around a thing: its frame (`at` as a frame is taken as one too).
    const frame = asFrame(m.frame) || asFrame(m.at);
    const out = { id, kind, strokes: [], len: 0, fill: null, sweep: null, disc: null, label: null, spots: null, bounds: null, area: null, path: null, start: 0, dur: 0, fadeAt: 0 };
    const raw = [];
    switch (kind) {
      case "box": {
        if (!frame) return null;
        // A rounded rectangle 6 px round it, clockwise from the top-left, in
        // one stroke that runs on 10 px past where it began.
        const x = frame[0] - 6, y = frame[1] - 6, w = frame[2] + 12, h = frame[3] + 12, r = Math.min(8, w / 2, h / 2);
        const P = 2 * (w + h - 4 * r) + TAU * r;
        for (let d = 0; d <= P + 10; d += 2) { const q = alongRound(x, y, w, h, r, d % P); raw.push(q[0], q[1]); }
        out.strokes.push(hand(raw, rnd, amp, [2, 2], (s) => (s > P - 14 ? -1.6 * clamp((s - P + 14) / 24) : 0)));
        out.spots = around(x, y, w, h);
        break;
      }
      case "circle": {
        if (!frame) return null;
        // An ellipse round it, tilted a little, from just left of the top,
        // once round and on past the start, a little wider by the end: the
        // way a circle is drawn in one go.
        const cx = frame[0] + frame[2] / 2, cy = frame[1] + frame[3] / 2, rx = frame[2] / 2 + 10, ry = frame[3] / 2 + 8;
        const tilt = -4 * Math.PI / 180, a0 = (-100 + (rnd() - .5) * 8) * Math.PI / 180, sweep = (380 + (rnd() - .5) * 10) * Math.PI / 180;
        const steps = Math.max(24, Math.ceil(sweep * Math.max(rx, ry) / 2));
        const ct = Math.cos(tilt), st = Math.sin(tilt);
        for (let i = 0; i <= steps; i++) {
          const th = a0 + sweep * i / steps, g = 1 + .045 * (th - a0) / TAU;
          const px = rx * g * Math.cos(th), py = ry * g * Math.sin(th);
          raw.push(cx + px * ct - py * st, cy + px * st + py * ct);
        }
        out.strokes.push(hand(raw, rnd, amp, [2, 2]));
        out.spots = around(cx - rx, cy - ry, 2 * rx, 2 * ry);
        break;
      }
      case "underline": {
        if (!frame) return null;
        // Under it, with a slight sag and a small flick up at the end, both
        // in proportion: under one character, a sag and a flick made for a
        // line of words turned it into a tilde.
        const x0 = frame[0] - 2, x1 = frame[0] + frame[2] + 2, by = frame[1] + frame[3] + 3, L = x1 - x0;
        const sag = Math.min(2.5, L * .015), flick = Math.min(3, L * .06), fl = Math.max(2, Math.min(10, L * .35));
        for (let x = x0; x <= x1 + .01; x += 2) {
          const u = (x - x0) / Math.max(1, L), up = clamp((x - (x1 - fl)) / fl);
          raw.push(x, by + sag * Math.sin(Math.PI * u) - flick * up * up);
        }
        out.strokes.push(hand(raw, rnd, amp * .8 * clamp(L / 80, .3, 1), [2, 2]));
        out.spots = (lw, lh) => [[x0, by + 8], [x0, frame[1] - lh - 6], [x1 + 6, by - lh / 2], [x0 - lw - 6, by - lh / 2]];
        break;
      }
      case "highlight": {
        if (!frame) return null;
        // A marker's swipe over it: a band with slanted ends, its edges not
        // quite straight, swept left to right.
        const x0 = frame[0] - 3, x1 = frame[0] + frame[2] + 3, y0 = frame[1] - 2, y1 = frame[1] + frame[3] + 2;
        const sl = Math.min(6, (y1 - y0) * .3), p = new Path2D();
        const wob = (x) => .7 * Math.sin(x * .09 + rnd() * TAU);
        p.moveTo(x0 + sl, y0);
        for (let x = x0 + sl; x <= x1 + sl; x += 8) p.lineTo(x, y0 + wob(x));
        p.lineTo(x1 + sl, y0);
        p.lineTo(x1, y1);
        for (let x = x1; x >= x0; x -= 8) p.lineTo(x, y1 + wob(x));
        p.lineTo(x0, y1);
        p.closePath();
        out.fill = p; out.sweep = [x0, x1 + sl, y0 - 2, y1 + 2];
        out.len = x1 + sl - x0;
        out.spots = around(x0, y0, x1 - x0, y1 - y0);
        break;
      }
      case "arrow": {
        const from = asSpot(m.from), to = asSpot(m.to);
        if (!from || !to) return null;
        // A curve from one to the other, bowed away from the card; a frame's
        // end leaves (or reaches) the edge facing the other end, 6 px off it.
        const a = from.length === 4 ? edgeToward(from, centreOf(to), 6) : from;
        const b = to.length === 4 ? edgeToward(to, centreOf(from), 6) : to;
        const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
        if (L < 8) return null;
        let nx = -dy / L, ny = dx / L;
        const bx = S.box ? S.box.x + S.box.w / 2 : W / 2, byc = S.box ? S.box.y + S.box.h / 2 : H;
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, bow = .12 * L;
        if (Math.hypot(mx + nx * bow - bx, my + ny * bow - byc) < Math.hypot(mx - nx * bow - bx, my - ny * bow - byc)) { nx = -nx; ny = -ny; }
        const cx = mx + nx * bow, cy = my + ny * bow;
        const steps = Math.max(8, Math.ceil(L / 2));
        for (let i = 0; i <= steps; i++) { const u = i / steps, v = 1 - u; raw.push(v * v * a[0] + 2 * v * u * cx + u * u * b[0], v * v * a[1] + 2 * v * u * cy + u * u * b[1]); }
        out.strokes.push(hand(raw, rnd, amp, [2, 0]));
        // The head: two short strokes back from the tip at ±28°, after the
        // shaft, as one flick of the pen.
        const tx = b[0] - cx, ty = b[1] - cy, tL = Math.hypot(tx, ty) || 1, ux = tx / tL, uy = ty / tL, hl = 11, an = 28 * Math.PI / 180;
        const barb = (s) => [b[0] - hl * (ux * Math.cos(an) - s * uy * Math.sin(an)), b[1] - hl * (uy * Math.cos(an) + s * ux * Math.sin(an))];
        const l = barb(1), r = barb(-1);
        out.strokes.push(hand([l[0], l[1], b[0], b[1], r[0], r[1]], rnd, amp * .3, [0, 1]));
        if (from.length === 4) out.spots = around(from[0], from[1], from[2], from[3]);
        else {
          // At the tail: the arrow comes out of its label.
          const vx = cx - a[0], vy = cy - a[1], vL = Math.hypot(vx, vy) || 1, ex = vx / vL, ey = vy / vL;
          out.spots = (lw, lh) => {
            const k = Math.min(Math.abs(ex) > 1e-3 ? lw / 2 / Math.abs(ex) : Infinity, Math.abs(ey) > 1e-3 ? lh / 2 / Math.abs(ey) : Infinity) + 5;
            const c = [a[0] - ex * k, a[1] - ey * k];
            return [[c[0] - lw / 2, c[1] - lh / 2], [a[0] - lw / 2, a[1] - lh - 8], [a[0] - lw / 2, a[1] + 8], [a[0] + (ex > 0 ? -lw - 8 : 8), a[1] - lh / 2]];
          };
        }
        break;
      }
      case "number": {
        const n = Math.round(Number(m.n));
        if (!(n >= 1 && n <= 9)) return null;
        // On a frame's top-left corner, or on the point; kept on screen.
        const at = frame ? [frame[0] - 8, frame[1] - 8] : asPoint(m.at);
        if (!at) return null;
        const cx = clamp(at[0], 13, W - 13), cy = clamp(at[1], 13, H - 13);
        out.disc = { x: cx, y: cy, n };
        out.spots = around(cx - 11, cy - 11, 22, 22, "right");
        break;
      }
      case "label": {
        const at = asPoint(m.at), f = frame || asFrame(m.at);
        if (!at && !f) return null;
        if (f) out.spots = around(f[0], f[1], f[2], f[3], "right");
        else out.spots = (lw, lh) => [[at[0] - lw / 2, at[1] - lh / 2], [at[0] - lw / 2, at[1] - lh - 8], [at[0] - lw / 2, at[1] + 8], [at[0] + 8, at[1] - lh / 2]];
        break;
      }
      case "path": {
        // At most 64 points (the server sends 32 at most): each costs a
        // line drawn through it when the mark is made.
        const pts = Array.isArray(m.points) ? m.points.slice(0, 64).map(asPoint) : [];
        if (pts.length < 2 || pts.some((p) => !p)) return null;
        const seq = m.closed === true ? pts.concat([pts[0]]) : pts;
        for (let i = 0; i < seq.length; i++) {
          if (!i) { raw.push(seq[0][0], seq[0][1]); continue; }
          const [ax, ay] = seq[i - 1], [bx2, by2] = seq[i], L = Math.hypot(bx2 - ax, by2 - ay), steps = Math.max(1, Math.ceil(L / 2));
          for (let k = 1; k <= steps; k++) raw.push(ax + (bx2 - ax) * k / steps, ay + (by2 - ay) * k / steps);
        }
        out.strokes.push(hand(raw, rnd, amp, [2, 2]));
        const p = pts[0];
        out.spots = (lw, lh) => [[p[0] - lw - 10, p[1] - lh / 2], [p[0] + 10, p[1] - lh / 2], [p[0] - lw / 2, p[1] - lh - 10], [p[0] - lw / 2, p[1] + 10]];
        break;
      }
    }
    for (const st of out.strokes) out.len += st.len;
    // What it covers, for the labels that come after it to keep off: a
    // number's disc; a line's extent, unless it is a long one across the
    // screen (an arrow's box is mostly empty).
    if (out.disc) out.bounds = [out.disc.x - 12, out.disc.y - 12, 24, 24];
    else if (out.strokes.length && kind !== "arrow" && kind !== "path") {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const st of out.strokes) for (let i = 0; i < st.pts.length; i += 2) { x0 = Math.min(x0, st.pts[i]); x1 = Math.max(x1, st.pts[i]); y0 = Math.min(y0, st.pts[i + 1]); y1 = Math.max(y1, st.pts[i + 1]); }
      out.bounds = [x0 - 3, y0 - 3, x1 - x0 + 6, y1 - y0 + 6];
    } else if (out.sweep) out.bounds = [out.sweep[0], out.sweep[2], out.sweep[1] - out.sweep[0], out.sweep[3] - out.sweep[2]];
    // All of it, arrows and paths too: what a card tied to the pill keeps
    // off (docked). Drawn under the card, a mark it covers is not seen.
    {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const add = (x, y) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); };
      for (const st of out.strokes) for (let i = 0; i < st.pts.length; i += 2) add(st.pts[i], st.pts[i + 1]);
      if (out.disc) { add(out.disc.x - 12, out.disc.y - 12); add(out.disc.x + 12, out.disc.y + 12); }
      if (out.sweep) { add(out.sweep[0], out.sweep[2]); add(out.sweep[1], out.sweep[3]); }
      out.area = x1 >= x0 ? [x0, y0, x1 - x0, y1 - y0] : null;
    }
    const text = typeof m.text === "string" ? m.text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim().slice(0, 48) : "";
    if (text) {
      const size = K.num("desktop.guide.labelSize", 19);
      ctx.save(); ctx.font = labelFont(size); const tw = ctx.measureText(text).width; ctx.restore();
      out.label = { text, size, w: Math.ceil(tw) + 16, h: Math.round(size * 1.12) + 4, x: 0, y: 0, rot: (rnd() - .6) * 3.2 * Math.PI / 180, writeMs: Math.min(620, 140 + text.length * 30), at: 0 };
    } else if (kind === "label") return null;
    if (kind === "label") out.len = out.label.w;
    // The pen's pace: longer marks take longer, up to a limit.
    out.dur = Math.min(K.num("desktop.guide.inkMaxMs", 900), K.num("desktop.guide.inkMs", 260) + out.len / K.num("desktop.guide.inkSpeed", 1.6));
    return out;
  }
  const labelFont = (size) => `600 ${size}px Caveat, "Segoe Print", cursive`;
  /** The label where it is clear: off the card (and Blip's head over it),
   *  the ring and its label, the pill, and the other labels; the first of
   *  its spots that is, else the first on screen. */
  function placeLabel(m) {
    const L = m.label;
    if (!L) return;
    const free = (x, y) => {
      if (x < 8 || y < 8 || x + L.w > W - 8 || y + L.h > H - 8) return false;
      const hit = (r, g) => r && x < r.x + r.w + g && x + L.w > r.x - g && y < r.y + r.h + g && y + L.h > r.y - g;
      const b = S.box;
      if (b && x < b.x + b.w + 6 && x + L.w > b.x - 6 && y < b.y + b.h + 6 && y + L.h > b.y - 62) return false;
      if (hit(S.chipBox, 6)) return false;
      if (S.ring) {
        const [rx, ry, rw, rh] = S.ring.frame;
        // Off what is ringed; and off the line of a ring round a whole
        // picture (the tentative "Looking"), whose dots would run through
        // the words: wholly inside it or wholly out.
        if (!S.ring.tentative) { if (hit({ x: rx, y: ry, w: rw, h: rh }, 10)) return false; }
        else {
          const g = K.num("desktop.guide.ringPad", 6) + 4;
          const inside = x >= rx - g + 6 && y >= ry - g + 6 && x + L.w <= rx + rw + g - 6 && y + L.h <= ry + rh + g - 6;
          if (!inside && hit({ x: rx, y: ry, w: rw, h: rh }, g + 4)) return false;
        }
      }
      if (S.P && hit(S.P, 10)) return false;
      // Nor on the tether between the pill and the card.
      if (S.P && b) {
        const px = S.P.x + S.P.w / 2, ax = clamp(px, b.x + 40, b.x + b.w - 40), top = b.y + b.h;
        if (hit({ x: Math.min(px, ax), y: top, w: Math.abs(px - ax), h: Math.max(0, S.P.y - top) }, 8)) return false;
      }
      for (const o of marks) if (o !== m && o.label && !o.fadeAt && o.label.placed && hit(o.label, 4)) return false;
      return true;
    };
    // And, if it can, off the other marks: their numbers, and what their
    // lines cover.
    const clear = (x, y) => {
      for (const o of marks) {
        if (o === m || o.fadeAt || !o.bounds) continue;
        const [bx, by, bw, bh] = o.bounds;
        if (x < bx + bw + 3 && x + L.w > bx - 3 && y < by + bh + 3 && y + L.h > by - 3) return false;
      }
      return true;
    };
    const spots = m.spots ? m.spots(L.w, L.h) : [];
    // Marks inside a picture being looked at keep their labels inside it:
    // each spot that would straddle its edge is tried again moved in.
    if (S.ring && S.ring.tentative) {
      const [rx, ry, rw, rh] = S.ring.frame, g = K.num("desktop.guide.ringPad", 6) - 2;
      const l = rx - g, t = ry - g, r = rx + rw + g - L.w, b = ry + rh + g - L.h;
      if (r > l && b > t) for (const p of spots.slice()) if (p[0] < r + L.w && p[0] + L.w > l && p[1] < b + L.h && p[1] + L.h > t) spots.push([clamp(p[0], l, r), clamp(p[1], t, b)]);
    }
    const inWin = (s) => s[0] >= 8 && s[1] >= 8 && s[0] + L.w <= W - 8 && s[1] + L.h <= H - 8;
    const s = spots.find((p) => free(p[0], p[1]) && clear(p[0], p[1])) || spots.find((p) => free(p[0], p[1])) || spots.find(inWin) || spots[0] || [8, 8];
    L.x = clamp(s[0], 8, Math.max(8, W - 8 - L.w)); L.y = clamp(s[1], 8, Math.max(8, H - 8 - L.h));
    L.placed = true;
  }
  /** The card moved (a ring sent it aside), or a new ring's label came: a
   *  label either now covers finds another spot. */
  function relabel() {
    const b = S.box, c = S.chipBox;
    for (const m of marks) {
      const L = m.label;
      if (!L || m.fadeAt || !L.placed) continue;
      const onCard = b && L.x < b.x + b.w + 6 && L.x + L.w > b.x - 6 && L.y < b.y + b.h + 6 && L.y + L.h > b.y - 62;
      const onChip = c && L.x < c.x + c.w + 6 && L.x + L.w > c.x - 6 && L.y < c.y + c.h + 6 && L.y + L.h > c.y - 6;
      if (onCard || onChip) placeLabel(m);
    }
  }
  function addMark(m) {
    if (!S.shown) return;
    if (m && m.id && marks.some((x) => x.id === String(m.id) && !x.fadeAt)) return;
    const mk = makeMark(m || {});
    if (!mk) return;
    const ms = now();
    // In the order they came: each starts when the one before is most of
    // the way drawn, so they read as one hand moving on.
    let prev = null;
    for (let i = marks.length - 1; i >= 0; i--) if (!marks[i].fadeAt) { prev = marks[i]; break; }
    mk.start = prev && !reduced ? Math.max(ms, prev.start + .7 * prev.dur) : ms;
    if (mk.label) { mk.label.at = mk.start + (mk.kind === "label" ? 0 : mk.kind === "number" ? mk.dur * .6 : mk.dur * .55); placeLabel(mk); }
    marks.push(mk);
    // Tied to the pill, the card may be over it: it makes room (docked).
    if (S.docked) place(false);
    // A number that lands on the ring's corner moves the ring's label past
    // it (placeChip), and a label of a mark's that the ring's label now
    // covers moves off it.
    if (mk.disc && S.chipBox) { placeChip(); relabel(); }
    // So many and no more: the oldest go first.
    const max = Math.max(1, K.num("desktop.guide.inkMax", 24));
    let live = marks.filter((x) => !x.fadeAt);
    while (live.length > max) { live[0].fadeAt = ms; live = live.slice(1); }
    wake();
  }
  function fadeMarks() { const ms = now(); for (const m of marks) if (!m.fadeAt) m.fadeAt = ms; wake(); }
  /** One stroke, drawn as far as `upto` px along it. */
  function traceStroke(g, st, upto) {
    const p = st.pts, c = st.cum, n = c.length;
    if (upto <= 0 || n < 2) return;
    g.moveTo(p[0], p[1]);
    let i = 1;
    for (; i < n && c[i] <= upto; i++) g.lineTo(p[2 * i], p[2 * i + 1]);
    if (i < n) {
      const f = (upto - c[i - 1]) / Math.max(1e-6, c[i] - c[i - 1]);
      g.lineTo(p[2 * i - 2] + (p[2 * i] - p[2 * i - 2]) * f, p[2 * i - 1] + (p[2 * i + 1] - p[2 * i - 1]) * f);
    }
  }
  const penEase = (p) => .4 * p + .6 * p * p * (3 - 2 * p);
  /** A mark's opacity: fading in (reduced motion only: it appears whole)
   *  and fading out. */
  const alphaOf = (m, ms) => (m.fadeAt ? clamp(1 - (ms - m.fadeAt) / 200) : 1) * (reduced ? clamp((ms - m.start) / 120) : 1);
  /** The marks' lines, under everything else: an ink edge, then the amber
   *  with a faint glow. Their numbers and labels come later (drawPins). */
  function drawMarks(ms) {
    if (!marks.length) return;
    const ink = K.color("desktop.guide.inkColor", "#E8A23C"), width = K.num("desktop.guide.inkWidth", 3);
    const glow = rgba(ink, .55);
    for (let i = marks.length - 1; i >= 0; i--) if (marks[i].fadeAt && ms - marks[i].fadeAt >= 200) marks.splice(i, 1);
    ctx.save();
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    for (const m of marks) {
      const a = alphaOf(m, ms);
      if (a <= 0 || ms < m.start) continue;
      const p = reduced ? 1 : clamp((ms - m.start) / m.dur);
      ctx.globalAlpha = a;
      if (m.fill) {
        // The marker sweeps across.
        const [x0, x1, y0, y1] = m.sweep;
        ctx.save();
        ctx.beginPath(); ctx.rect(x0 - 2, y0, (x1 - x0 + 4) * penEase(p), y1 - y0); ctx.clip();
        ctx.fillStyle = rgba(ink, K.num("desktop.guide.highlightAlpha", 0.26)); ctx.fill(m.fill);
        ctx.restore();
        continue;
      }
      if (!m.strokes.length) continue;
      let path = m.path;
      if (!path && p >= 1) {
        // Finished: kept as a path, so it is not walked again every frame.
        path = m.path = new Path2D();
        for (const st of m.strokes) traceStroke(path, st, st.len + 1);
      }
      if (!path) {
        ctx.beginPath();
        let left = m.len * penEase(p);
        for (const st of m.strokes) { if (left <= 0) break; traceStroke(ctx, st, left); left -= st.len; }
      }
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "rgba(15,13,11,.38)"; ctx.lineWidth = width + 3;
      if (path) ctx.stroke(path); else ctx.stroke();
      ctx.shadowColor = glow; ctx.shadowBlur = 6;
      ctx.strokeStyle = ink; ctx.lineWidth = width;
      if (path) ctx.stroke(path); else ctx.stroke();
      ctx.shadowBlur = 0;
    }
    ctx.restore();
  }
  /**
   * The numbers, then the labels on top of them, so a label is never
   * crossed by a line. These are pinned over the ring (still under the
   * thread, Blip and the card): a step being done is ringed and numbered
   * both, and its number sits on the ring's corner. Under the ring, the
   * ring's line and its marching dots ran across the numeral; over it, it
   * reads as a badge on the ring.
   */
  function drawPins(ms) {
    if (!marks.length) return;
    const ink = K.color("desktop.guide.inkColor", "#E8A23C");
    const glow = rgba(ink, .55);
    ctx.save();
    for (const m of marks) {
      if (!m.disc) continue;
      const a = alphaOf(m, ms);
      if (a <= 0 || ms < m.start) continue;
      const k = reduced ? 1 : clamp((ms - m.start) / m.dur), s = reduced ? 1 : outBack(k);
      ctx.save();
      ctx.globalAlpha = a * clamp(k * 4);
      ctx.translate(m.disc.x, m.disc.y); ctx.scale(s, s);
      ctx.beginPath(); ctx.arc(0, 0, 12.4, 0, TAU); ctx.fillStyle = "rgba(15,13,11,.38)"; ctx.fill();
      ctx.beginPath(); ctx.arc(0, 0, 11, 0, TAU); ctx.fillStyle = "#0F0D0B"; ctx.fill();
      ctx.shadowColor = glow; ctx.shadowBlur = 6;
      ctx.beginPath(); ctx.arc(0, 0, 10, 0, TAU); ctx.strokeStyle = ink; ctx.lineWidth = 2; ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#F3E2C6"; ctx.font = '600 12px "Instrument Sans", -apple-system, "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(m.disc.n), 0, .5);
      ctx.restore();
    }
    for (const m of marks) {
      const L = m.label;
      if (!L || ms < L.at) continue;
      const a = alphaOf(m, ms) * (reduced ? 1 : clamp((ms - L.at) / 160));
      if (a <= 0) continue;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.translate(L.x + L.w / 2, L.y + L.h / 2); ctx.rotate(L.rot);
      ctx.beginPath(); ctx.roundRect(-L.w / 2, -L.h / 2, L.w, L.h, 8);
      ctx.fillStyle = "rgba(15,13,11,.86)"; ctx.fill();
      ctx.strokeStyle = "rgba(243,226,198,.14)"; ctx.lineWidth = 1; ctx.stroke();
      // The words, written out left to right.
      const wk = reduced ? 1 : outCubic((ms - L.at - 60) / L.writeMs);
      if (wk > 0) {
        ctx.beginPath(); ctx.rect(-L.w / 2, -L.h / 2 - 6, 6 + (L.w - 8) * wk, L.h + 12); ctx.clip();
        ctx.fillStyle = "#F3E2C6"; ctx.font = labelFont(L.size); ctx.textAlign = "left"; ctx.textBaseline = "middle";
        ctx.fillText(L.text, -L.w / 2 + 8, 1);
      }
      ctx.restore();
    }
    ctx.restore();
  }

  // ---- the voice: a row of dots it moves --------------------------------------
  function drawWave(t) {
    if (S.state !== "listening" && S.state !== "thinking") return;
    const ww = wave.width / dpr, wh = wave.height / dpr;
    wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    wctx.clearRect(0, 0, ww, wh);
    const n = 30, step = ww / n, mid = wh / 2;
    for (let i = 0; i < n; i++) {
      const x = step * (i + .5);
      const env = Math.sin(Math.PI * (i + .5) / n);
      let y = mid, r = 1.6, col = "rgba(243,226,198,.28)";
      if (S.state === "listening") {
        const a = (2 + S.level * 11) * env;
        y = mid + Math.sin(t * 7.5 + i * .55) * a * .9 + Math.sin(t * 3.1 + i * 1.3) * a * .35;
        r = 1.5 + S.level * 1.3 * env;
        col = `rgba(232,162,60,${.5 + .5 * env})`;
      } else {
        // Thinking: still dots and a light running along them.
        const head = ((t * .9) % 1.4) * n - n * .2;
        const glow = Math.exp(-Math.pow((i - head) / 2.2, 2));
        r = 1.5 + glow * 1.1;
        col = `rgba(243,226,198,${.22 + .7 * glow})`;
      }
      wctx.beginPath(); wctx.arc(x, y, r, 0, TAU); wctx.fillStyle = col; wctx.fill();
    }
  }

  // ---- the frame --------------------------------------------------------------
  let raf = 0;
  let demoFrame = null;   // the review page's mock pill, drawn on the same clock
  function frame() {
    raf = 0;
    const ms = now(), t = ms / 1000;
    const dt = clamp(t - S.lastFrame, 0, .1);
    S.lastFrame = t;
    S.level += (S.levelTo - S.level) * (1 - Math.exp(-dt * 14));
    S.lineMix += ((S.state === "listening" ? 1 : 0) - S.lineMix) * (reduced ? 1 : 1 - Math.exp(-dt * 10));
    // Under ?capture nothing waits for the page to lay itself out: the
    // card's height is read on the frame it changes.
    if (CAPTURE && S.shown && S.box && inner.offsetHeight !== S.box.h) place(false);
    moveCard(dt);
    const o = lifeAt(ms);
    if (!S.shown && o.over && card.classList.contains("on")) gone();
    paintCard(o);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    drawMarks(ms);
    const rc = card.classList.contains("on") ? visible(o) : null;
    drawTether(t, o);
    if (rc) drawRim(o, rc);
    drawRing(t);
    drawPins(ms);
    blip.pose(poseFor());
    if (rc) {
      const right = S.ring && !S.ring.tentative && (S.ring.frame[0] + S.ring.frame[2] / 2) > rc.left + rc.width * .62;
      const ax = right ? rc.right - 54 : rc.left + 54;
      if (S.state === "permission") { const y = $("once").getBoundingClientRect(); blip.lookAt([y.left + y.width / 2, y.top + y.height / 2]); blip.pointAt(null); }
      // A tentative ring is looked at, not pointed at; so is one below the card's top.
      else if (S.ring) { const c = [S.ring.frame[0] + S.ring.frame[2] / 2, S.ring.frame[1] + S.ring.frame[3] / 2]; blip.lookAt(c); blip.pointAt(S.where === "above" || S.ring.tentative || lowRing(rc) ? null : c); }
      else if (S.state === "confirm") { const y = $("yes").getBoundingClientRect(); blip.lookAt([y.left + y.width / 2, y.top + y.height / 2]); blip.pointAt(null); }
      else if (S.state === "thinking") { blip.lookAt([ax - 40, rc.top - 160]); blip.pointAt(null); }
      else { blip.lookAt(null); blip.pointAt(null); }
      // It goes as the card starts to fold, not with the last of it: what
      // was still ducking would ride the shrinking card down like crumbs.
      ctx.save(); ctx.globalAlpha = clamp((Math.min(o.k, o.ky) - .85) / .15) * o.alpha;
      blip.draw(ctx, ax, rc.top, t, dpr);
      ctx.restore();
    } else blip.step(t);
    drawThread(t, rc);
    drawWave(t);
    const demoMoving = demoFrame ? demoFrame(t, dt) : false;
    const busy = S.shown || !o.over || marks.length > 0 || blip.shown() || (S.hideAt && t - S.hideAt < .6) || demoMoving;
    if (busy) { if (!CAPTURE) raf = requestAnimationFrame(frame); }
    else ctx.clearRect(0, 0, W, H);
  }
  function wake() { if (!raf && !CAPTURE) raf = requestAnimationFrame(frame); }

  // ---- speaking -----------------------------------------------------------------
  let tts = null;   // { ctx, src } while the server's voice plays
  // Which sentence is being said. The main process sends the next one when
  // this page says the last has been heard, so only the one still being said
  // may say so: one stopped by a hush or by a newer sentence is told it was
  // interrupted a moment later, and that would let the sentence after the
  // newer one in at once and cut it off.
  let saying = 0;
  function stopSpeaking() {
    saying++;
    try { window.speechSynthesis && speechSynthesis.cancel(); } catch { /* none */ }
    if (tts) { try { tts.src && tts.src.stop(); } catch { /* ended */ } try { tts.ctx.close(); } catch { /* closed */ } tts = null; }
    blip.speaking(false);
  }
  function speak(m) {
    stopSpeaking();
    const n = saying;
    let over = false;
    const done = () => { if (over || n !== saying) return; over = true; blip.speaking(false); bridge.spoken(); };
    // The server's voice, when the main process fetched it (/v1/speak, the
    // read-aloud voice chosen in Settings, in whatever language the answer is
    // in), played through Web Audio as the desk plays it: no blob: URL.
    if (m.audio) {
      const ctxA = new AudioContext();
      const mine = tts = { ctx: ctxA, src: null };
      const bytes = m.audio instanceof ArrayBuffer ? m.audio : new Uint8Array(m.audio).buffer;
      ctxA.decodeAudioData(bytes.slice(0)).then((buf) => {
        if (tts !== mine) return;
        const src = ctxA.createBufferSource();
        src.buffer = buf; src.connect(ctxA.destination);
        src.onended = () => { if (tts === mine) { try { ctxA.close(); } catch { /* closed */ } tts = null; } done(); };
        mine.src = src; src.start();
        blip.speaking(true);
      }).catch(() => { if (tts === mine) { try { ctxA.close(); } catch { /* closed */ } tts = null; } builtIn(); });
      return;
    }
    builtIn();
    function builtIn() {
      // The built-in voice, with a real locale; none for that locale, and
      // the answer is only read, never said in the wrong voice. (Audio that
      // would not decode falls back to it, and by then a newer sentence may
      // be the one being said: this one is then not said at all.)
      if (n !== saying) return;
      if (!m.speak || !window.speechSynthesis) return done();
      const u = new SpeechSynthesisUtterance(m.text);
      if (m.locale) {
        const loc = String(m.locale).toLowerCase();
        const v = speechSynthesis.getVoices().find((x) => x.lang && x.lang.toLowerCase().replace("_", "-").startsWith(loc));
        if (!v && !loc.startsWith("en")) return done();
        u.lang = m.locale;
        if (v) u.voice = v;
      }
      u.rate = typeof m.rate === "number" ? m.rate : 1;
      u.onstart = () => { if (n === saying) blip.speaking(true); };
      u.onend = u.onerror = done;
      speechSynthesis.speak(u);
    }
  }

  // ---- messages from the main process -------------------------------------------
  function show(m) {
    const first = !S.shown;
    // Put away completely (not just folding): it starts from nothing, where
    // it is to be. A fold still under way is turned round where it is.
    const fresh = first && lifeAt(now()).over;
    S.shown = true; S.hideAt = 0;
    S.ring = null; S.anchor = m.anchor ? [m.anchor.x, m.anchor.y] : null;
    if (fresh) S.slid = false;
    $("app").textContent = m.app || "";
    $("heard").textContent = "";
    $("say").textContent = "";
    $("badge").textContent = "";
    setSteps([]);
    chip.classList.remove("on"); S.chipBox = null;
    S.risk = "confirm";
    // A new card's marks are its own: the last one's fade.
    fadeMarks();
    setState(m.state || "listening", m.label);
    $("askHint").textContent = K.txt("desktop.guide.askHint", "or tap {key} twice", { key: m.key || "Alt" });
    card.classList.add("on");
    capCard();
    place(fresh);
    if (first) {
      S.lineMix = S.state === "listening" ? 1 : 0;
      startLife(true);
    }
    wake();
  }
  function hide() {
    if (!S.shown) return;
    stopSpeaking();
    S.shown = false;
    blip.pose("hidden");
    S.hideAt = now() / 1000;
    // Blip ducks and the marks fade first; then the card folds back into the
    // thread's end and the thread is pulled down into the pill (lifeAt).
    chip.classList.remove("on");
    fadeMarks();
    startLife(false);
    bridge.mouse(false);
    wake();
  }
  const handlers = {
    show,
    hide,
    // Where the pill is, in this window's coordinates, for the card to grow
    // out of and stay tied to; null when no question has it here (a seed of
    // the guide's own instead, or with `seed: false` nothing: the card is
    // placed as it was before it had a pill). ask.js sends it before every
    // show, and again whenever the window moves to another display.
    dock: (m) => {
      const p = m && m.pill;
      // Numbers, and only numbers: Number(null) is 0, and a pill with a
      // missing y read as one at the top of the screen.
      const ok = p && [p.x, p.y, p.w, p.h].every(isNum) && p.w > 0 && p.h > 0;
      const next = { pill: ok ? { x: Number(p.x), y: Number(p.y), w: Number(p.w), h: Number(p.h) } : null, seed: !(m && m.seed === false) };
      const was = S.dock;
      const same = was && was.seed === next.seed && (was.pill === next.pill || (was.pill && next.pill && ["x", "y", "w", "h"].every((k) => was.pill[k] === next.pill[k])));
      S.dock = next;
      if (same) return;
      capCard();
      place(true);
    },
    // The label, when there is one, is what it is doing ("Pressing Export"),
    // in the eyebrow.
    state: (m) => { if (m.risk) S.risk = m.risk; setState(m.state, m.label ? String(m.label).slice(0, 34) : ""); fit(); },
    level: (m) => { S.levelTo = Math.max(0, Math.min(1, Number(m.v) || 0)); },
    heard: (m) => { $("heard").textContent = m.text ? "“" + m.text + "”" : ""; fit(); },
    // The words at once; the voice when it is ready (`voice`): the server's
    // audio, or the built-in voice with a locale.
    // `append`: the next sentence of an answer that is still coming.
    // An answer while the picture card is still up means it was settled
    // without a click (no answer in time): the card answers, its buttons go.
    say: (m) => {
      words($("say"), m.text, m.append === true);
      if (S.state === "listening" || S.state === "thinking" || S.state === "permission") setState("showing");
      fit();
    },
    // Only for the card that is up. The main process drops a voice whose
    // card has gone; this is the second lock. Either way the main process
    // hears it is over, so the next sentence is not held up.
    voice: (m) => { if (S.shown && (m.audio || m.speak)) speak(m); else bridge.spoken(); },
    hush: () => stopSpeaking(),
    area: (m) => {
      const i = (m && m.inset) || {};
      const n = (v) => Math.max(0, Number(v) || 0);
      S.inset = { top: n(i.top), right: n(i.right), bottom: n(i.bottom), left: n(i.left) };
      capCard();
      place(true);
    },
    // `tentative`: a guess while they are still talking (it leaves the card
    // listening), or the part of the window a picture is of. The same guess
    // again leaves the ring as it is; an answer's own ring replaces it.
    point: (m) => {
      if (!Array.isArray(m.frame) || m.frame.length !== 4) return;
      const frame = m.frame.map(Number);
      if (!frame.every(Number.isFinite)) return;
      const tentative = m.tentative === true;
      if (tentative && S.ring && S.ring.tentative && S.ring.frame.every((v, i) => Math.abs(v - frame[i]) < 1)) return;
      S.ring = { frame, caption: tentative ? "" : m.caption || "", at: now() / 1000, tentative };
      chip.textContent = S.ring.caption;
      if (!tentative && (S.state === "listening" || S.state === "thinking")) setState("showing");
      else blip.pose(poseFor());
      place(false);
      wake();
    },
    badge: (m) => { $("badge").textContent = m.text ? String(m.text).slice(0, 32) : ""; },
    // May a picture go: once, always for this app, or not now.
    permission: (m) => {
      const app = String(m.app || "").trim();
      $("permitText").textContent = String(m.text || "");
      $("once").textContent = K.txt("desktop.guide.permitOnce", "Allow once");
      $("always").textContent = app ? K.txt("desktop.guide.permitAlways", "Always for {app}", { app }) : K.txt("desktop.guide.permitAlwaysHere", "Always here");
      $("always").title = $("always").textContent;
      $("notnow").textContent = K.txt("desktop.guide.permitNo", "Not now");
      setState("permission");
      fit();
    },
    unpoint: () => { S.ring = null; chip.classList.remove("on"); S.chipBox = null; blip.pose(poseFor()); place(false); },
    steps: (m) => { setSteps(m.items); fit(); },
    confirm: (m) => {
      S.risk = m.risk === "always" ? "always" : "confirm";
      const [what, quote] = splitConfirm(m.text);
      $("what").textContent = what;
      $("quote").textContent = quote;
      $("yes").textContent = K.txt("desktop.guide.yes", "Do it");
      $("no").textContent = K.txt("desktop.guide.no", "Not now");
      setState("confirm");
      fit();
    },
    // A mark on the screen (ask.js draw: geometry already in this window's
    // coordinates, a fresh id each), and all of them away.
    draw: (m) => addMark(m),
    clear: () => fadeMarks(),
  };
  bridge.onGuide((m) => { if (m && handlers[m.type]) { try { handlers[m.type](m); } catch (e) { console.error(e); } } });

  $("yes").addEventListener("click", () => { bridge.confirm(true); setState("doing"); fit(); });
  $("no").addEventListener("click", () => { bridge.confirm(false); });
  // Whichever it is, the answer is on its way next: with the picture, or
  // from the words alone.
  for (const [id, choice] of [["once", "once"], ["always", "always"], ["notnow", "no"]]) {
    $(id).addEventListener("click", () => { if (S.state !== "permission") return; bridge.permit(choice); setState("thinking"); fit(); });
  }
  $("close").addEventListener("click", () => bridge.dismiss());
  card.addEventListener("mouseenter", () => bridge.mouse(true));
  card.addEventListener("mouseleave", () => bridge.mouse(false));

  if (bridge.knobs) bridge.knobs().then((k) => K.setKnobs(k)).catch(() => {});
  if (bridge.onKnobs) bridge.onKnobs((k) => K.setKnobs(k));
  // The faces the canvas writes in, asked for now: a label drawn before its
  // face has loaded would be measured in another.
  const faces = document.fonts ? Promise.all([labelFont(19), '600 12px "Instrument Sans"'].map((f) => document.fonts.load(f).catch(() => null))) : Promise.resolve();
  resize();

  // ---- the review page ------------------------------------------------------------
  function fakeBridge() {
    let cb = () => {};
    return {
      onGuide: (f) => { cb = f; }, send: (m) => cb(m),
      confirm: (y) => console.log("confirm", y), permit: (c) => console.log("permit", c), mouse: () => {}, spoken: () => {}, dismiss: () => console.log("dismiss"),
    };
  }
  if (DEMO) faces.then(() => runDemo(params.get("demo")));
  function runDemo(scene) {
    document.body.classList.add("demo");
    if (params.has("dark")) document.body.classList.add("dark");
    // The review page's timers run on the page's clock: under ?capture they
    // wait for __step like everything else.
    const timers = [];
    const later = (fn, ms) => { if (!CAPTURE) return setTimeout(fn, ms); timers.push({ at: virtual + ms, fn }); };
    const every = (fn, ms) => { const tick = () => { fn(); later(tick, ms); }; later(tick, ms); };
    function runTimers() {
      for (;;) {
        let i = -1;
        for (let j = 0; j < timers.length; j++) if (timers[j].at <= virtual && (i < 0 || timers[j].at < timers[i].at)) i = j;
        if (i < 0) return;
        const [tm] = timers.splice(i, 1);
        tm.fn();
      }
    }
    const mock = document.createElement("div");
    mock.className = "mock";
    mock.innerHTML = `<div class="bar"><i></i><i></i><i></i><b>Q3 launch — Keynote</b></div>
      <div class="tools"><span>Share</span><span id="m-export">Export</span><span class="primary">Play</span></div>
      <div class="side"><p class="on" id="m-design"># design</p><p># launch</p><p># general</p><p>Priya</p><p>Anthony</p></div>
      <div class="page"><h2>Mockups, round two</h2><div class="ln" style="width:92%"></div><div class="ln" style="width:84%"></div><div class="ln" style="width:66%"></div>
        <div class="fig" id="m-fig"><span>&int;<sub>0</sub><sup>1</sup> x<sup>2</sup> dx = &#8531;</span></div></div>
      <div class="composer" id="m-composer">Message #design<em id="m-send">Send</em></div>`;
    document.body.insertBefore(mock, fx);
    // THE PILL, as main has it while a question is up (pill.js "ask"): its
    // halves parted at the seam, a bead in the gap, amber while it listens.
    // Over this window, as main keeps it, so it hides the tether's first
    // pixels. Drawn on this page's clock, from what the guide is doing.
    const pc = document.createElement("canvas");
    pc.id = "mockpill";
    fx.after(pc);
    const pg = pc.getContext("2d");
    const mp = { x: 0, v: 0, bead: 0, hot: 1, slow: 0 };
    const pillMode = params.get("pill");    // "seed": no pill (the guide's seed); "off": not docked at all
    const pillAt = () => ({ x: Math.round(W / 2 - 20), y: H - S.inset.bottom - 34, w: 40, h: 16 });
    demoFrame = (t, dt) => {
      if (pc.width !== Math.round(W * dpr) || pc.height !== Math.round(H * dpr)) {
        pc.width = Math.round(W * dpr); pc.height = Math.round(H * dpr); pc.style.width = W + "px"; pc.style.height = H + "px";
      }
      pg.setTransform(dpr, 0, 0, dpr, 0, 0);
      pg.clearRect(0, 0, W, H);
      if (pillMode) return false;
      const P = pillAt(), L = S.life, e = now() - L.at;
      // Open while a question is up; closing, held open while the thread
      // comes home (askCloseDelayMs), then shut on the split's springs.
      const open = S.shown || (!L.open && e < K.num("desktop.pill.askCloseDelayMs", 590));
      const target = open ? 1 : 0, out = target > mp.x;
      if (reduced) { mp.x += (target - mp.x) * (1 - Math.exp(-dt * 18)); mp.v = 0; }
      else { const k = out ? 120 : 240, c = out ? 24 : 16; mp.v += (k * (target - mp.x) - c * mp.v) * dt; mp.x += mp.v * dt; }
      mp.bead += ((open ? 1 : 0) - mp.bead) * (1 - Math.exp(-dt * (open ? 14 : 22)));
      mp.hot += ((S.shown && S.state === "listening" ? 1 : 0) - mp.hot) * (1 - Math.exp(-dt * 9));
      mp.slow += ((S.shown && S.state === "thinking" ? 1 : 0) - mp.slow) * (1 - Math.exp(-dt * 6));
      const gap = 9 * clamp(mp.x, 0, 1.3), cx = P.x + P.w / 2, cy = P.y + P.h / 2, sr = Math.min(2.5, gap / 3);
      pg.save();
      pg.globalAlpha = .8 + .2 * clamp(mp.x * 3);
      pg.shadowColor = "rgba(0,0,0,.3)"; pg.shadowBlur = 14; pg.shadowOffsetY = 4;
      pg.fillStyle = "#0F0D0B"; pg.beginPath(); pg.roundRect(cx - 20 - gap / 2, P.y, 20, 16, [8, sr, sr, 8]); pg.fill();
      pg.fillStyle = "#F3E2C6"; pg.beginPath(); pg.roundRect(cx + gap / 2, P.y, 20, 16, [sr, 8, 8, sr]); pg.fill();
      pg.shadowColor = "transparent";
      pg.strokeStyle = "rgba(243,226,198,.16)"; pg.lineWidth = 1; pg.beginPath(); pg.roundRect(cx - 19.5 - gap / 2, P.y + .5, 19, 15, [7.5, sr, sr, 7.5]); pg.stroke();
      pg.strokeStyle = "rgba(15,13,11,.3)"; pg.beginPath(); pg.roundRect(cx + gap / 2 + .5, P.y + .5, 19, 15, [sr, 7.5, 7.5, sr]); pg.stroke();
      const breath = .5 + .5 * Math.sin(t * TAU / 1.25), pulse = .5 - .5 * Math.cos(t * TAU / 1.8);
      const r = Math.min((gap - 2) / 2, 3.5 * mp.bead * (reduced ? 1 : 1 - .22 * mp.hot * (1 - breath) - .1 * mp.slow * (1 - pulse)));
      if (r > .3) {
        pg.shadowColor = `rgba(232,162,60,${(.3 + .45 * breath) * mp.hot})`; pg.shadowBlur = (4 + 5 * breath) * mp.hot;
        const c0 = [243, 226, 198], c1 = [232, 162, 60];
        pg.fillStyle = `rgb(${c0.map((v, i) => Math.round(v + (c1[i] - v) * mp.hot)).join(",")})`;
        pg.beginPath(); pg.arc(cx, cy, r, 0, TAU); pg.fill();
        pg.shadowColor = "transparent";
        pg.strokeStyle = "rgba(15,13,11,.4)"; pg.lineWidth = .8; pg.beginPath(); pg.arc(cx, cy, Math.max(0, r - .4), 0, TAU); pg.stroke();
      }
      pg.restore();
      return Math.abs(mp.v) > .002 || Math.abs(target - mp.x) > .002 || Math.abs((open ? 1 : 0) - mp.bead) > .01;
    };
    // Every card tied to the pill, as ask.js sends it: where the pill is,
    // before every show.
    const send = (m) => {
      if (m.type === "show") bridge.send(pillMode === "off" ? { type: "dock", pill: null, seed: false } : { type: "dock", pill: pillMode === "seed" ? null : pillAt() });
      bridge.send(m);
    };
    const box = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
    // A voice: syllables, bursts with gaps (deterministic, so a captured
    // frame is the same every time).
    const voice = (ms) => {
      const v = Math.sin(Math.floor(ms / 90) * 12.9898) * 43758.5453, rnd = v - Math.floor(v);
      return .25 + .55 * Math.abs(Math.sin(ms / 260)) * rnd;
    };
    every(() => send({ type: "level", v: S.state === "listening" ? voice(now()) : 0 }), 90);
    const scenes = {
      listening: () => { send({ type: "show", state: "listening", app: "Keynote", anchor: { x: 520, y: 200 } }); },
      thinking: () => { scenes.listening(); send({ type: "heard", text: "where's the export button?" }); send({ type: "state", state: "thinking" }); },
      point: () => { scenes.thinking(); send({ type: "say", text: "Up here, top right: Export. Pick PDF in the menu it opens." }); send({ type: "point", frame: box("m-export"), caption: "Export" }); },
      // A plan, with the places it goes numbered on the screen, as the card numbers its steps.
      steps: () => {
        send({ type: "show", state: "doing", app: "Slack" });
        send({ type: "heard", text: "tell design the mockups are ready" });
        send({ type: "say", text: "Writing it in #design." });
        send({ type: "steps", items: [{ text: "Open #design", state: "done" }, { text: "Write the message", state: "doing" }, { text: "Send it", state: "todo" }] });
        send({ type: "point", frame: box("m-composer"), caption: "Message #design" });
        send({ type: "draw", id: "d1", kind: "number", frame: box("m-design"), n: 1 });
        send({ type: "draw", id: "d2", kind: "number", frame: box("m-composer"), n: 2 });
        send({ type: "draw", id: "d3", kind: "number", frame: box("m-send"), n: 3 });
      },
      confirm: () => {
        scenes.steps();
        send({ type: "steps", items: [{ text: "Open #design", state: "done" }, { text: "Write the message", state: "done" }, { text: "Send it", state: "doing" }] });
        send({ type: "point", frame: box("m-send"), caption: "Send" });
        send({ type: "confirm", text: "Send to #design: “The mockups are ready! Round two is in the deck.”", risk: "confirm" });
      },
      always: () => {
        send({ type: "show", state: "doing", app: "Keynote" });
        send({ type: "heard", text: "delete the old roadmap slide" });
        send({ type: "point", frame: box("m-export"), caption: "Delete slide" });
        send({ type: "confirm", text: "Delete slide 4: “Roadmap (old)”", risk: "always" });
      },
      done: () => { scenes.steps(); send({ type: "steps", items: [{ text: "Open #design", state: "done" }, { text: "Write the message", state: "done" }, { text: "Send it", state: "done" }] }); send({ type: "unpoint" }); send({ type: "say", text: "Sent. Priya's already typing." }); send({ type: "state", state: "done" }); },
      error: () => { send({ type: "show", state: "thinking", app: "Keynote" }); send({ type: "heard", text: "where's the export button?" }); send({ type: "state", state: "error" }); send({ type: "say", text: "I can't read this window yet. Turn on Tailzu under Accessibility in System Settings." }); },
      // Everything at the longest agent.js lets it be: the card must still
      // fit, its buttons on screen.
      tall: () => {
        send({ type: "show", state: "doing", app: "Slack" });
        send({ type: "heard", text: "tell design the mockups are ready and that round two is in the deck, and ask Priya to look at the launch timeline before Friday's review" });
        send({ type: "say", text: "Writing it in #design now. I've put the whole update in one message so it reads as one thought: the mockups, the deck with round two, and a nudge to Priya about the launch timeline before Friday's review. Check it before it goes." });
        send({ type: "steps", items: [
          { text: "Open #design from the sidebar", state: "done" }, { text: "Click into the message box", state: "done" },
          { text: "Write the update about the mockups", state: "done" }, { text: "Mention Priya about the launch timeline", state: "done" },
          { text: "Read it over once more", state: "done" }, { text: "Send it to the channel", state: "doing" },
        ] });
        send({ type: "point", frame: box("m-send"), caption: "Send" });
        send({ type: "confirm", text: "Send to #design: “The mockups are ready! Round two is in the deck, page 4 onwards. @Priya could you look at the launch timeline before Friday's review? There's a question on the date for the press embargo and another on who signs off the final copy for the store listing.”", risk: "confirm" });
      },
      top: () => {
        send({ type: "show", state: "thinking", app: "Chrome" });
        send({ type: "heard", text: "which tab has the roadmap?" });
        send({ type: "say", text: "That one, the second tab." });
        send({ type: "point", frame: [300, 10, 70, 30], caption: "Q3 roadmap" });
      },
      menubar: () => {
        const bar = document.createElement("div");
        bar.className = "menubar";
        bar.innerHTML = "<b>&#63743;</b><b>Keynote</b><span id=\"m-file\">File</span><span>Edit</span><span>Insert</span><span>Slide</span><span>Format</span><span>View</span>";
        document.body.insertBefore(bar, fx);
        send({ type: "area", inset: { top: 25, right: 0, bottom: 70, left: 0 } });
        send({ type: "show", state: "thinking", app: "Keynote" });
        send({ type: "heard", text: "where's save as?" });
        send({ type: "say", text: "Under File: hold Option and it turns into Save As." });
        send({ type: "point", frame: box("m-file"), caption: "File" });
      },
      // The instant layer: "where's ex…", and a guess ringed while they are
      // still saying it. The card listens on where it was.
      tentative: () => {
        scenes.listening();
        send({ type: "point", frame: box("m-export"), caption: "Export", tentative: true });
      },
      // The picture layer: may a picture of this go, for an app not yet allowed.
      permission: () => {
        const f = box("m-fig");
        send({ type: "show", state: "thinking", app: "Keynote", anchor: { x: f[0] + f[2] - 60, y: f[1] + f[3] - 24 } });
        send({ type: "heard", text: "explain this equation" });
        send({ type: "permission", app: "Keynote", text: "To answer that I need to see it: one picture of this part of the screen, sent to Tailzu." });
      },
      // …and the answer to it, a sentence at a time as the model writes,
      // beside the picture it is about.
      growing: () => {
        send({ type: "show", state: "thinking", app: "Keynote" });
        send({ type: "heard", text: "explain this equation" });
        send({ type: "point", frame: box("m-fig"), caption: "Looking", tentative: true });
        send({ type: "badge", text: "1 picture sent" });
        const said = [
          "It's the area under the curve y = x² from x = 0 to x = 1.",
          "The integral of x² is x³/3.",
          "At 1 that's 1/3, and at 0 it's 0, so the area is 1/3.",
          "So the curve leaves a third of the unit square under it.",
        ];
        said.forEach((text, i) => later(() => send(i ? { type: "say", text, append: true } : { type: "say", text }), 400 + i * 900));
      },
      long: () => {
        send({ type: "show", state: "doing", app: "Finder" });
        send({ type: "heard", text: "open https://docs.google.com/document/d/1x9Qe2ZlongDocumentIdThatNeverBreaks_abcdefghijklmnop/edit" });
        send({ type: "say", text: "Your file is at /Users/priya/Library/Application_Support/Keynote/Autosave/Q3_launch_roadmap_final_v2_really_final.key" });
        send({ type: "point", frame: box("m-composer"), caption: "Address" });
        send({ type: "confirm", text: "Type “https://docs.google.com/document/d/1x9Qe2ZlongDocumentIdThatNeverBreaks/edit”?", risk: "confirm" });
      },
      // THE BIRTH, and a whole question: the thread out of the pill, the card
      // at its end, listening (the voice plucks the thread), thinking (a
      // light runs up it), then the answer.
      dock: () => {
        send({ type: "show", state: "listening", app: "Keynote" });
        later(() => send({ type: "heard", text: "where's the export button?" }), 1500);
        later(() => send({ type: "state", state: "thinking" }), 2300);
        later(() => { send({ type: "say", text: "Up here, top right: Export. Pick PDF in the menu it opens." }); send({ type: "point", frame: box("m-export"), caption: "Export" }); }, 3500);
      },
      // A ring by the pill: the card moves aside along the bottom, the
      // tether bends after it, and the thread leaves the card's side.
      slide: () => {
        const bar = document.createElement("div");
        bar.className = "dockbar";
        bar.innerHTML = "<span>&lsaquo;</span><span class=\"n\">4 / 12</span><span id=\"m-present\" class=\"primary\">&#9654;&ensp;Present</span><span>&rsaquo;</span>";
        document.body.insertBefore(bar, fx);
        send({ type: "show", state: "thinking", app: "Keynote" });
        send({ type: "heard", text: "how do I start the slideshow?" });
        later(() => { send({ type: "say", text: "Press Present, just here by the pill. Esc ends it." }); send({ type: "point", frame: box("m-present"), caption: "Present" }); }, 700);
      },
      // An answer, then away: the fold, over and over.
      fold: () => {
        const cycle = () => {
          send({ type: "show", state: "thinking", app: "Keynote" });
          send({ type: "heard", text: "where's the export button?" });
          later(() => send({ type: "say", text: "Up here, top right: Export." }), 500);
          later(() => send({ type: "hide" }), 2200);
          later(cycle, 3400);
        };
        cycle();
      },
      // THE PEN: a picture of a right triangle, a question about it, and the
      // answer marked up on it as it is said.
      draw: () => {
        const fig = document.getElementById("m-fig");
        fig.className = "tri"; fig.id = "m-tri";
        fig.innerHTML = `<svg viewBox="0 0 480 250" width="480" height="250" aria-hidden="true">
          <polygon points="60,206 60,46 273,206" fill="currentColor" fill-opacity=".05" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/>
          <path d="M60 190 H76 V206" fill="none" stroke="currentColor" stroke-width="1.6"/>
          <text id="t-3" x="28" y="136">3</text><text id="t-4" x="158" y="238">4</text><text id="t-q" x="172" y="114">?</text></svg>`;
        mock.querySelectorAll(".page .ln").forEach((el) => { el.style.display = "none"; });
        mock.querySelector(".page h2").textContent = "Homework: triangles";
        const svg = fig.querySelector("svg").getBoundingClientRect();
        const pt = (x, y) => [svg.left + x * svg.width / 480, svg.top + y * svg.height / 250];
        const at = (x, y, w, h) => { const [a, b] = pt(x, y); return [a, b, w * svg.width / 480, h * svg.height / 250]; };
        send({ type: "show", state: "thinking", app: "Preview" });
        send({ type: "heard", text: "how long is the long side?" });
        send({ type: "point", frame: box("m-tri"), caption: "Looking", tentative: true });
        send({ type: "badge", text: "1 picture sent" });
        const says = [
          ["The long side is the hypotenuse, c: the side across from the right angle.", [
            { kind: "circle", frame: at(58, 186, 22, 22), text: "90°" },
            { kind: "arrow", from: pt(336, 66), to: pt(190, 139), text: "c, what we want" }]],
          ["For any right triangle, a² + b² = c².", [
            { kind: "number", at: pt(60, 120), n: 1 },
            { kind: "number", at: pt(166, 206), n: 2 }]],
          ["Here that's 3² + 4² = 9 + 16 = 25.", [
            { kind: "underline", frame: box("t-3") },
            { kind: "underline", frame: box("t-4") }]],
          ["So c = √25 = 5.", []],
        ];
        let id = 0;
        says.forEach(([text, draws], i) => later(() => {
          send(i ? { type: "say", text, append: true } : { type: "say", text });
          for (const d of draws) send(Object.assign({ type: "draw", id: "d" + (++id) }, d));
        }, 600 + i * 1300));
        later(() => send({ type: "unpoint" }), 600 + 4 * 1300);
      },
    };
    const start = () => {
      if (scene && scenes[scene]) { scenes[scene](); return; }
      // The whole run, on a loop.
      const order = ["listening", "thinking", "point", "steps", "confirm", "done"];
      let i = 0;
      const next = () => { scenes[order[i % order.length]](); i++; later(next, i % order.length === 0 ? 3600 : 2600); };
      next();
    };
    // For the review's checks: what the page is doing, and a way to tell it more.
    window.__guide = { S, marks, LIFE, now, send: (m) => bridge.send(m) };
    if (CAPTURE) {
      // Every animation the page runs in CSS (the words rising, the ring's
      // label) is held and set to the page's clock too.
      const began = new WeakMap();
      const seek = () => {
        for (const a of document.getAnimations()) {
          if (!began.has(a)) { began.set(a, virtual); a.pause(); }
          a.currentTime = virtual - began.get(a);
        }
      };
      window.__step = (ms) => {
        let left = Math.max(0, Number(ms) || 0);
        do { const d = Math.min(1000 / 60, left); virtual += d; left -= d; runTimers(); frame(); seek(); } while (left > 0);
      };
      start();
      frame(); seek();
      window.__ready = true;
    } else start();
  }
})();
