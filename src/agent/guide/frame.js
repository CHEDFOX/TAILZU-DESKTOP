// The canvas, the frame loop that draws everything on it, and the voice's row
// of dots.
"use strict";

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
    const bots = BOTS();
    let y = mid, r = 1.6, col = bots ? "rgba(10,10,10,.18)" : "rgba(243,226,198,.28)";
    if (S.state === "listening") {
      const a = (2 + S.level * 11) * env;
      y = mid + Math.sin(t * 7.5 + i * .55) * a * .9 + Math.sin(t * 3.1 + i * 1.3) * a * .35;
      r = 1.5 + S.level * 1.3 * env;
      col = bots ? `rgba(169,87,58,${.5 + .5 * env})` : `rgba(232,162,60,${.5 + .5 * env})`;
    } else {
      // Thinking: still dots and a light running along them.
      const head = ((t * .9) % 1.4) * n - n * .2;
      const glow = Math.exp(-Math.pow((i - head) / 2.2, 2));
      r = 1.5 + glow * 1.1;
      col = bots ? `rgba(10,10,10,${.18 + .7 * glow})` : `rgba(243,226,198,${.22 + .7 * glow})`;
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
  // Peeking over a text box: Blip and nothing else.
  const peeking = drawPeek(ms, t, dt);
  if (!peeking) drawMarks(ms);
  const rc = !peeking && card.classList.contains("on") ? visible(o) : null;
  if (!peeking) drawTether(t, o);
  if (rc) drawRim(o, rc);
  if (!peeking) { drawRing(t); drawPins(ms); }
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
  if (!peeking) drawThread(t, rc);
  // The card's voice dots: there is no card while it peeks, and a peek
  // can last minutes.
  if (!peeking) drawWave(t);
  const demoMoving = demoFrame ? demoFrame(t, dt) : false;
  hitTest();
  const busy = S.shown || !o.over || marks.length > 0 || blip.shown() || (S.hideAt && t - S.hideAt < .6) || PK.on || demoMoving;
  if (busy) { if (!CAPTURE) raf = requestAnimationFrame(frame); }
  else ctx.clearRect(0, 0, W, H);
}
function wake() { if (!raf && !CAPTURE) raf = requestAnimationFrame(frame); }
