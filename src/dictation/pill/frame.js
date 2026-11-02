// Each frame: where every part of the pill is going for the state it is in
// (targets), and drawing it there; a route's label after the words went.
"use strict";

// Where the words went, and the one other place they can go instead:
// "Typed · Ask instead", "Sent to Plan Ease · Type it instead". A press on the
// pill chooses the alternative; main undoes the first and does the other.
const SEP = " · ";
function routedLabel() { return (S.data.label || "") + (S.data.alt ? SEP + S.data.alt : ""); }
/** The label at (x, cy) in the current font: what was done in `main`, the
 *  alternative in `alt`, underlined, as the thing to press. No amber: that is
 *  only for what is live. */
function drawRouted(x, cy, main, alt) {
  const lead = (S.data.label || "") + (S.data.alt ? SEP : "");
  ctx.fillStyle = main; ctx.fillText(lead, x, cy + .5);
  if (!S.data.alt) return;
  const ax = x + ctx.measureText(lead).width, aw = ctx.measureText(S.data.alt).width;
  ctx.fillStyle = alt; ctx.fillText(S.data.alt, ax, cy + .5);
  ctx.fillRect(ax, cy + 7, aw, 1);
}

/** The capsule's shape for a state: shut (two equal halves), or open around
 *  some words with the cream half a cap at the end. */
function capsuleTargets(st) {
  const g = { buttons: 0, show: 1, solid: 1, text: 0 };
  const open = (label, h, extra = 0) => {
    g.h = h; g.cap = Math.round(h * 0.82); g.text = 1;
    g.w = Math.round(K.num("desktop.pill.capsulePad", 14) + extra + textW(label) + 12 + g.cap);
  };
  if (st === "rest" && hovered && restShown && hint) open(hint, K.num("desktop.pill.hoverHeight", 28));
  else if (st === "routed") open(routedLabel(), K.num("desktop.pill.labelHeight", 30));
  else if (st === "error" || st === "done") {
    open(st === "done" ? doneLabel() : (S.data.label || K.txt("desktop.pill.errorDefault", "Something went wrong")), K.num("desktop.pill.labelHeight", 30), st === "done" ? 18 : 0);
  } else {
    g.w = K.num("desktop.pill.capsuleWidth", 40); g.h = K.num("desktop.pill.capsuleHeight", 16); g.cap = g.w / 2;
    if (st === "rest") { g.solid = 0; g.show = restShown ? 1 : 0; }
  }
  return g;
}

/** Where everything wants to be this frame. */
function targets() {
  const st = S.name, sq = K.num("desktop.pill.atom", 3);
  const g = {};
  if (BOTS()) return botsTargets(st);
  if (CAPSULE()) return capsuleTargets(st);
  // SPLIT, THE PILL NEVER GROWS INTO A WIDE PILL OF DOTS. The small pill
  // comes apart where it is: the two halves leave it and it fades, and on
  // stop they come back into it, in its own place, and it writes there,
  // its three squares lighting in turn. The wide pill with its dots (joined
  // listening, and the rolling wave while writing) is what this design
  // retired.
  if ((st === "listening" || st === "writing") && SPLIT()) {
    g.w = K.num("desktop.pill.restWidth", 46); g.h = K.num("desktop.pill.restHeight", 14);
    g.solid = 1; g.buttons = 0; g.text = 0; g.show = 1;
    return g;
  }
  // Ask, without the capsule: the small pill, solid, with the bead on its
  // top edge where the thread leaves it. Shown even when the rest pill is
  // not: the thread has to come out of something.
  if (st === "ask") {
    g.w = K.num("desktop.pill.restWidth", 46); g.h = K.num("desktop.pill.restHeight", 14);
    g.solid = 1; g.buttons = 0; g.text = 0; g.show = 1;
    return g;
  }
  if (st === "rest") {
    const open = hovered && restShown && !!hint;
    g.w = open ? K.num("desktop.pill.hoverPad", 30) + 3 * sq + 10 + textW(hint) : K.num("desktop.pill.restWidth", 46);
    g.h = open ? K.num("desktop.pill.hoverHeight", 28) : K.num("desktop.pill.restHeight", 14);
    g.solid = open ? 1 : 0; g.buttons = 0; g.text = open ? 1 : 0; g.show = restShown ? 1 : 0;
  } else if (st === "listening") {
    g.w = K.num("desktop.pill.listenWidth", 188); g.h = K.num("desktop.pill.listenHeight", 38);
    g.solid = 1; g.buttons = 1; g.text = 0; g.show = 1;
  } else if (st === "writing") {
    g.w = K.num("desktop.pill.writeWidth", 124); g.h = K.num("desktop.pill.writeHeight", 30);
    g.solid = 1; g.buttons = 0; g.text = 0; g.show = 1;
  } else {
    const label = st === "done" ? doneLabel() : st === "routed" ? routedLabel() : (S.data.label || K.txt("desktop.pill.errorDefault", "Something went wrong"));
    g.w = textW(label) + (st === "done" ? 46 : 38); g.h = K.num("desktop.pill.labelHeight", 30);
    g.solid = 1; g.buttons = 0; g.text = 1; g.show = 1;
  }
  return g;
}

let last = 0, running = false;
function wake() { if (!running && !CAPTURE) { running = true; last = clock(); requestAnimationFrame(loop); } }
function loop() { const settled = frame(); if (settled && (S.name === "rest" || S.name === "ask")) { running = false; return; } requestAnimationFrame(loop); }

/** One frame. Returns true when nothing is moving. */
function frame() {
  const now = clock(), dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000)); last = now;
  const t = (now - S.at) / 1000;
  if (S.name === "done" && t * 1000 > K.num("desktop.pill.doneMs", 1300)) setState("rest");
  if (S.name === "error" && t * 1000 > K.num("desktop.pill.errorMs", 2400)) setState("rest");
  // Main puts a route's label away itself; this only guards against a lost message.
  if (S.name === "routed" && t * 1000 > K.num("desktop.pill.routedMs", 8000)) setState("rest");
  // Bands decay once the recorder goes quiet, so a dropped message never
  // freezes a bar mid-air.
  if (now - bandsAt > 250) for (let i = 0; i < bands.length; i++) bands[i] *= Math.exp(-dt * 10);

  // The halves: apart while it listens, straight out of the small pill,
  // together otherwise, at one pace both ways, so a stop in the middle of
  // coming apart simply turns them round.
  const wantSplit = SPLIT() && S.name === "listening" && t * 1000 >= K.num("desktop.pill.splitDelayMs", 0);
  const splitTarget = wantSplit ? 1 : 0;
  const seWas = clamp(splitT);
  SP.spring(splitState, splitTarget, splitOpts(), dt);
  splitT = splitState.x;                       // may ride a touch past 0/1; clamped where drawn
  const se = clamp(splitT), fade = SP.fades(se);
  // The halves met on the way home: the capsule clicks shut, and the spring's
  // overshoot is spent in that click.
  if (seWas > 0.02 && se <= 0.004) snapAt = now;
  if (se > 0.001 || thread.energy() > 0.05) {
    thread.step(dt, bands, S.name === "listening" && now - bandsAt < 250, threadOpts());
    // A pause wrote a chunk: the thread is plucked.
    if (flashAt > pluckedAt) { pluckedAt = flashAt; if (S.name === "listening") thread.pluck(0.7, threadOpts()); }
  }

  // Ask: open at the seam while a question is up. Closing, the gap is held
  // while the guide's thread comes home (askCloseDelayMs), then the bead goes
  // into the seam and, a beat behind it, the halves are pulled shut.
  // 590 ms is when the guide's fold (desktop.guide.foldMs, 620) has the
  // thread inside the bead: it is pulled down from 300 ms to 600 ms, slow and
  // then fast. At 420 the bead sank while the thread still stood two thirds
  // of its height over an empty gap, and the halves shut across its last few
  // dots. The two are set together: a longer fold wants a longer hold.
  const asking = S.name === "ask", phase = asking ? S.data.phase : "";
  const shutAt = K.num("desktop.pill.askCloseDelayMs", 590);
  const shutting = asking && phase === "closing" && t * 1000 >= shutAt;
  const askTarget = asking && !(shutting && t * 1000 >= shutAt + K.num("desktop.pill.askShutLagMs", 110)) ? 1 : 0;
  const agWas = clamp(askGap.x);
  if (REDUCED()) { askGap.x = ease(askGap.x, askTarget, 18, dt); askGap.v = 0; }
  else SP.spring(askGap, askTarget, splitOpts(), dt);
  // The click only for halves that are home. A dictation that takes the pill
  // mid-question shuts the gap as the halves leave for the edges, and the
  // click's squash, drawn about the middle, threw the halves out past the
  // ends of their thread.
  if (agWas > 0.02 && askGap.x <= 0.004 && !REDUCED() && se <= 0.004) snapAt = now;
  askGapPx = CAPSULE() ? K.num("desktop.pill.askGap", 9) * clamp(askGap.x) : 0;
  // The bead goes in slowly, then quickly (askBeadMs), and the halves close
  // on the last of it; anything else that ends it lets it go at its own pace.
  const beadTarget = asking && !shutting ? 1 : 0;
  if (shutting) bead = Math.min(bead, 1 - Math.pow(clamp((t * 1000 - shutAt) / Math.max(1, K.num("desktop.pill.askBeadMs", 160))), 2));
  else bead = ease(bead, beadTarget, 14, dt);
  const hotTarget = asking && phase === "listening" ? 1 : 0, slowTarget = asking && phase === "thinking" ? 1 : 0;
  beadHot = ease(beadHot, hotTarget, 9, dt);
  beadSlow = ease(beadSlow, slowTarget, 6, dt);
  // Shut, and the click spent: back to rest by itself, unless main has
  // already said so (it does, once the guide's window has gone).
  if (shutting && askTarget === 0 && !SP.springMoving(askGap, 0) && bead < 0.01 && now - snapAt > 320) setState("rest");

  const g = targets(), k = K.num("desktop.pill.spring", 16);
  const before = P.w + P.h + P.solid + P.buttons + P.text + P.cap;
  P.w = ease(P.w, g.w, k, dt); P.h = ease(P.h, g.h, k, dt);
  P.solid = ease(P.solid, g.solid, k * .8, dt); P.buttons = ease(P.buttons, g.buttons, k * .9, dt);
  P.text = ease(P.text, g.text, k * .9, dt);
  if (g.cap != null) P.cap = ease(P.cap, g.cap, k, dt);
  P.show = ease(P.show ?? 1, g.show, k, dt);
  let moving = Math.abs(P.w + P.h + P.solid + P.buttons + P.text + P.cap - before) > 0.01;
  if (now - snapAt < 400) moving = true;
  if (SP.springMoving(splitState, splitTarget) || thread.energy() > 0.05) moving = true;
  // Listening and thinking the bead breathes, and closing it is on its way
  // in. Showing it is still: once the gap and the bead have settled, the
  // frames stop for as long as the card is up (a confirm's is thirty seconds),
  // as they do at rest. Under reduced motion it never breathes (drawBead),
  // and they stop once it has come to its colour, listening and thinking too.
  const breathing = !REDUCED() && ((asking && (phase === "listening" || phase === "thinking")) || beadHot > 0.005 || beadSlow > 0.005);
  if (breathing || (asking && phase === "closing") || SP.springMoving(askGap, askTarget) || Math.abs(bead - beadTarget) > 0.005
    || Math.abs(beadHot - hotTarget) > 0.005 || Math.abs(beadSlow - slowTarget) > 0.005) moving = true;

  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (P.show < 0.01) return !moving;
  const cx = W / 2, bottom = H - K.num("desktop.pill.bottomPad", 14);
  const x0 = cx - P.w / 2, y0 = bottom - P.h, cy = bottom - P.h / 2;
  ctx.globalAlpha = P.show;
  if (BOTS()) {
    if (drawBots(t, now, dt, x0, y0, cy)) moving = true;
    if (S.name === "listening" || S.name === "writing" || S.name === "done" || S.name === "error") moving = true;
    if (pointer) hoverAt(pointer.x, pointer.y);
    return !moving;
  }

  // The capsule. At rest it is a shade over the page; open, it is ink.
  const err = S.name === "error" ? outCubic(t / 0.2) : 0;
  const shake = S.name === "error" && t < 0.42 ? Math.sin(t * 60) * 3 * (1 - t / 0.42) : 0;
  ctx.save();
  ctx.translate(shake, 0);
  // The body fades as the halves leave it, and is back before they meet.
  const bodyA = fade.body;
  if (!CAPSULE() && bodyA > 0.01) {
    ctx.shadowColor = `rgba(0,0,0,${(0.12 + 0.26 * P.solid) * bodyA})`; ctx.shadowBlur = 8 + 14 * P.solid; ctx.shadowOffsetY = 2 + 4 * P.solid;
    ctx.fillStyle = mixHex(K.color("desktop.pill.restFill", "#2A2522"), C.ink(), P.solid);
    ctx.globalAlpha = P.show * bodyA * (K.num("desktop.pill.restAlpha", 0.78) + (1 - K.num("desktop.pill.restAlpha", 0.78)) * P.solid);
    ctx.beginPath(); ctx.roundRect(x0, y0, P.w, P.h, P.h / 2); ctx.fill();
    ctx.shadowColor = "transparent"; ctx.globalAlpha = P.show * bodyA;
    ctx.strokeStyle = err ? rgba(C.rose(), .55 * err) : rgba(C.pale(), 0.12 + 0.06 * P.solid); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(x0 + .5, y0 + .5, P.w - 1, P.h - 1, (P.h - 1) / 2); ctx.stroke();
    ctx.globalAlpha = P.show;
  }

  // The thread, between the two halves: amber, because the microphone is
  // open, over a dark hair so it reads on a white page and a dark one alike.
  if (fade.thread > 0.01) {
    const pd = SP.pods(podSeed(), W, se, INSET());
    const hb = CAPSULE() ? halves(se) : null;
    const x1 = hb ? hb.lx + hb.lw * 0.45 : pd.lx + pd.r * 0.9, x2 = hb ? hb.rx - hb.rw * 0.45 : pd.rx - pd.r * 0.9;
    const n = Math.max(16, Math.min(240, Math.round((x2 - x1) / Math.max(4, K.num("desktop.pill.threadStep", 12)))));
    const boil = Math.floor(now / (1000 / Math.max(1, K.num("desktop.pill.handFps", 12))));
    const pts = thread.points(x1, x2, cy, now / 1000, n, SP.tremor(boil, K.num("desktop.pill.hand", 0.8)), threadOpts());
    // A pluck on a loud syllable can swing past the window's strip: kept in it.
    for (const pt of pts) pt[1] = clamp(pt[1], 3, H - 3);
    const tw = K.num("desktop.pill.threadWidth", 1.6);
    const trace = () => {
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length - 1; i++) {
        ctx.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2);
      }
      const l = pts[pts.length - 1]; ctx.lineTo(l[0], l[1]);
    };
    ctx.save(); ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.globalAlpha = P.show * fade.thread;
    trace(); ctx.strokeStyle = rgba(C.ink(), K.num("desktop.pill.threadShadow", 0.1)); ctx.lineWidth = tw + 1.4; ctx.stroke();
    trace(); ctx.strokeStyle = C.amber(); ctx.lineWidth = tw; ctx.stroke();
    ctx.restore();
  }

  // Live captions, above: the tail of what is being said.
  if (S.name === "listening" && caption) {
    ctx.save(); ctx.font = FONT();
    const maxW = Math.min(W - 24, K.num("desktop.pill.captionWidth", 360));
    let s = caption; while (s.length > 1 && ctx.measureText("…" + s).width > maxW - 28) s = s.slice(1);
    if (s !== caption) s = "…" + s.trimStart();
    const cw = ctx.measureText(s).width + 28, ch = 28, ccy = y0 - 10 - ch;
    ctx.fillStyle = rgba(C.ink(), .94); ctx.beginPath(); ctx.roundRect(cx - cw / 2, ccy, cw, ch, 10); ctx.fill();
    ctx.fillStyle = C.pale(); ctx.textBaseline = "middle"; ctx.fillText(s, cx - cw / 2 + 14, ccy + ch / 2 + .5);
    ctx.restore();
  }

  // The atoms.
  const n = CAPSULE() ? 0 : BARS(), mid = (n - 1) / 2, sq = K.num("desktop.pill.atom", 3), aa = atoms(n);
  const inner = P.h, bl = x0 + inner + 4, br = x0 + P.w - inner - 4;
  const maxH = Math.max(sq, P.h - K.num("desktop.pill.barInset", 16));
  const flashP = (now - flashAt) / 1000;
  const talking = now - bandsAt < 250;
  for (let i = 0; i < n; i++) {
    const a = aa[i], d = Math.abs(i - mid);
    let tx = cx, th = sq, ty = 0, ta = 0, hot = 0;
    if (S.name === "rest" || S.name === "ask" || (SPLIT() && (S.name === "listening" || S.name === "writing"))) {
      const open = P.text > .5 && hint;
      const gx = open ? x0 + 15 + sq : cx - 5 - sq / 2;
      if (d <= 1) { tx = gx + (i - mid + 1) * (sq + 2.6) + (open ? 0 : 5 - sq - 2.6 + sq / 2); ta = open ? .85 : .6; }
      else { tx = gx + 5; ta = 0; }
      // Writing, in the small pill: a light passes over its three squares,
      // left to right, again and again. Nothing moves, nothing grows.
      if (S.name === "writing" && d <= 1) {
        const pos = ((t * 1.5) % 1.5) * 3 - 0.75;
        ta = .3 + .65 * Math.exp(-Math.pow(i - mid + 1 - pos, 2) * 1.6);
      }
    } else if (S.name === "listening") {
      tx = n > 1 ? bl + (br - bl) * i / (n - 1) : cx;
      // Low voice in the middle, the rest mirrored outwards: a voice has one
      // shape, and a symmetric one reads as a voice rather than a meter.
      const band = bands[Math.min(bands.length - 1, Math.round(d * 1.35))] * (1 - 0.08 * ((i * 7) % 3));
      const env = 0.5 + 0.5 * Math.cos(Math.PI * d / (mid + 1.2));
      const breath = talking ? 0 : 0.5 + 0.5 * Math.sin(t * 3.2 - d * 0.7);
      const pulse = flashP < 0.6 ? Math.exp(-Math.pow(d - flashP / 0.6 * (mid + 1), 2) / 2) * (1 - flashP / 0.6) : 0;
      th = sq + (maxH - sq) * clamp(band * env * 1.25 + pulse * .55);
      ta = talking ? .95 : .45 + .4 * breath;
      hot = 1;
    } else if (S.name === "writing") {
      const gap = K.num("desktop.pill.writeGap", 6);
      tx = cx + (i - mid) * gap;
      ty = -Math.sin(t * 9 - i * 0.55) * 3 * clamp(t / 0.3);
      const sweep = ((t * 1.3) % 1.4) - 0.2, near = Math.exp(-Math.pow(i / (n - 1) - sweep, 2) * 40);
      ta = (d <= mid ? .5 : 0) + .45 * near; th = sq;
    } else {
      tx = x0 + 18; ta = 0; th = sq;
    }
    // Apart, the bars (or the small pill's squares) give way to the thread.
    ta *= 1 - SP.smooth(0, 0.3, se);
    const kk = K.num("desktop.pill.atomSpring", 22);
    a.x = ease(a.x, tx, kk, dt); a.h = ease(a.h, th, S.name === "listening" ? 30 : kk, dt);
    a.y = ease(a.y, ty, kk, dt); a.a = ease(a.a, ta, kk, dt); a.hot = ease(a.hot, hot, kk * .6, dt);
    if (Math.abs(a.x - tx) + Math.abs(a.h - th) + Math.abs(a.a - ta) > 0.05) moving = true;
    if (a.a < 0.01) continue;
    ctx.fillStyle = a.hot > .02 ? mixHex(C.pale(), C.amber(), a.hot) : C.pale();
    ctx.globalAlpha = P.show * a.a;
    const w = sq;
    ctx.beginPath(); ctx.roundRect(a.x - w / 2, cy - a.h / 2 + a.y, w, a.h, Math.min(w / 2, 1.2 + a.h / 6)); ctx.fill();
  }
  ctx.globalAlpha = P.show;

  // ✕ and ✓, while listening. The two halves, while they are out of the pill (leaving it, apart, or on
  // their way home); with the split off, the joined pill's ✕ and ✓.
  if (CAPSULE()) drawCapsule(se, cy, err, t, now);
  const apartNow = se > 0.001;
  if (!CAPSULE() && (apartNow || P.buttons > 0.01)) {
    let lx, rx, r, b;
    if (apartNow) {
      const pd = SP.pods(podSeed(), W, se, INSET());
      // Out of the small pill they grow to their size; home, they shrink back into it.
      const grow = 0.3 + 0.7 * SP.smooth(0, 0.35, se);
      lx = pd.lx; rx = pd.rx; b = fade.disc; r = Math.max(2, (pd.r - 5) * grow);
      ctx.save();
      for (const px of [lx, rx]) {
        ctx.globalAlpha = P.show * b;
        ctx.shadowColor = "rgba(0,0,0,.34)"; ctx.shadowBlur = 18; ctx.shadowOffsetY = 5;
        ctx.fillStyle = C.ink(); ctx.beginPath(); ctx.arc(px, cy, pd.r * grow, 0, Math.PI * 2); ctx.fill();
        ctx.shadowColor = "transparent";
        ctx.strokeStyle = rgba(C.pale(), 0.18); ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(px, cy, pd.r * grow - .5, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();
    } else {
      lx = x0 + P.h / 2; rx = x0 + P.w - P.h / 2; r = P.h / 2 - 5; b = P.buttons;
    }
    ctx.globalAlpha = P.show * b;
    ctx.fillStyle = rgba(C.pale(), overCancel ? .24 : .13); ctx.beginPath(); ctx.arc(lx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = rgba(C.pale(), .9); ctx.lineWidth = 1.6; ctx.lineCap = "round";
    const s = r * .36;
    ctx.beginPath(); ctx.moveTo(lx - s, cy - s); ctx.lineTo(lx + s, cy + s); ctx.moveTo(lx + s, cy - s); ctx.lineTo(lx - s, cy + s); ctx.stroke();
    ctx.fillStyle = C.pale(); ctx.beginPath(); ctx.arc(rx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = C.ink(); ctx.lineWidth = 1.8; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(rx - r * .38, cy + r * .02); ctx.lineTo(rx - r * .1, cy + r * .3); ctx.lineTo(rx + r * .4, cy - r * .3); ctx.stroke();
    ctx.globalAlpha = P.show;
  }
  // Ask, without the capsule: the bead on the small pill's top edge, while
  // the pill is there (not while its body has gone to the edges as discs).
  if (!CAPSULE() && bead > 0.01 && se <= 0.004) drawBead(cx, y0, Infinity, now);

  // Words: the hint on hover, the count when done, the reason on error.
  if (P.text > 0.01) {
    // With the body: a reason does not float over the thread before the halves are home.
    const cap = CAPSULE(), tx0 = x0 + K.num("desktop.pill.capsulePad", 14);
    ctx.save(); ctx.font = FONT(); ctx.textBaseline = "middle";
    // In the capsule, words wait until the halves are home.
    ctx.globalAlpha = P.show * outCubic(P.text) * (cap ? 1 - SP.smooth(0, 0.015, se) : bodyA);
    if (cap && S.name !== "done") {
      // In the ink, the cream cap after it (rose, for an error).
      ctx.fillStyle = rgba(C.pale(), S.name === "rest" ? .9 : 1);
      if (S.name === "rest") ctx.fillText(hint, tx0, cy + .5);
      else if (S.name === "error") ctx.fillText(S.data.label || K.txt("desktop.pill.errorDefault", "Something went wrong"), tx0, cy + .5);
      else if (S.name === "routed") drawRouted(tx0, cy, rgba(C.pale(), .72), C.pale());
    } else if (S.name === "rest") {
      ctx.fillStyle = rgba(C.pale(), .88); ctx.fillText(hint, x0 + 15 + 3 * sq + 12, cy + .5);
    } else if (S.name === "done") {
      // The check draws itself, born amber, and settles to pale.
      const p = outCubic(t / 0.35), ix = x0 + 18, s = 5;
      ctx.strokeStyle = mixHex(C.amber(), C.pale(), clamp((t - .35) / .5)); ctx.lineWidth = 2; ctx.lineCap = "round"; ctx.lineJoin = "round";
      const pts = [[ix - s, cy], [ix - s * .3, cy + s * .7], [ix + s * 1.1, cy - s * .8]];
      const L1 = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]), L2 = Math.hypot(pts[2][0] - pts[1][0], pts[2][1] - pts[1][1]);
      const len = (L1 + L2) * p;
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
      if (len <= L1) ctx.lineTo(pts[0][0] + (pts[1][0] - pts[0][0]) * len / L1, pts[0][1] + (pts[1][1] - pts[0][1]) * len / L1);
      else { ctx.lineTo(pts[1][0], pts[1][1]); const u = (len - L1) / L2; ctx.lineTo(pts[1][0] + (pts[2][0] - pts[1][0]) * u, pts[1][1] + (pts[2][1] - pts[1][1]) * u); }
      ctx.stroke();
      ctx.fillStyle = C.pale(); ctx.fillText(doneLabel(), x0 + 32, cy + .5);
    } else if (S.name === "routed") {
      drawRouted(x0 + 19, cy, rgba(C.pale(), .72), C.pale());
    } else if (S.name === "error") {
      ctx.fillStyle = C.rose(); ctx.beginPath(); ctx.arc(x0 + 17, cy, 3.2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = C.pale(); ctx.fillText(S.data.label || K.txt("desktop.pill.errorDefault", "Something went wrong"), x0 + 27, cy + .5);
    }
    ctx.restore();
  }
  ctx.restore();
  if (S.name === "listening" || S.name === "writing" || S.name === "done" || S.name === "error") moving = true;
  // The pill changes size under a pointer that is not moving (listening
  // shrinks to writing, done to rest), and no mousemove says so: the window
  // went on taking clicks where the pill had been. Asked again as it moves.
  if (pointer) hoverAt(pointer.x, pointer.y);
  return !moving;
}
