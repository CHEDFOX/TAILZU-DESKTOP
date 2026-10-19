// guide.html's script: the card, the ring, the thread and Blip.
//
// The main process says what to show (channel "guide", see agent.js and
// main.js); this page decides where. The card sits beside what it is talking
// about, never over it: below the ringed thing if there is room, else above,
// else to a side, and near the cursor when there is nothing to ring. Blip
// peeks over the card's edge on the side nearer the ring and points at it; a
// dotted thread runs from its finger to the ring.
(function () {
  "use strict";
  const K = window.TailzuKnobs;
  const params = new URLSearchParams(location.search);
  const DEMO = params.has("demo");
  const bridge = window.tailzuGuide || fakeBridge();
  const reduced = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const TAU = Math.PI * 2;
  const $ = (id) => document.getElementById(id);
  const card = $("card"), inner = $("inner"), fx = $("fx"), chip = $("chip"), wave = $("wave");
  const ctx = fx.getContext("2d");
  const wctx = wave.getContext("2d");
  const blip = window.TailzuBlip.createBlip({ height: K.num("desktop.guide.blipHeight", 112) });

  const S = {
    shown: false,
    state: "listening",
    risk: "confirm",
    ring: null,          // { frame:[x,y,w,h], caption, at }
    where: "default",    // where the card went: below / above / right / left (of the ring), anchor, default
    box: null,           // the card's rectangle as laid out (where it is going, not where it is)
    anchor: null,        // [x, y]: where to be when there is nothing to ring
    level: 0, levelTo: 0,
    hideAt: 0,
    speaking: false,
    lastFrame: 0,
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
    place(true);
  }
  window.addEventListener("resize", resize);

  // ---- where the card goes ---------------------------------------------------
  const M = 16;                       // keep this far from the window's edge
  // The height it is growing to, not the one it is passing through.
  function cardSize() { return [card.offsetWidth || K.num("desktop.guide.width", 348), inner.offsetHeight || 120]; }
  function clampX(x, w) { return Math.max(M, Math.min(W - M - w, x)); }
  function clampY(y, h) { return Math.max(M + 60, Math.min(H - M - h, y)); }   // room above it for Blip's head
  /** The card's top-left: beside the ring if there is one, else by the anchor. */
  function layout() {
    const [cw, ch] = cardSize();
    const blipRoom = K.num("desktop.guide.blipRoom", 66);   // Blip's head sticks up this far over the card
    if (S.ring) {
      const pad = K.num("desktop.guide.ringPad", 6);
      const [rx, ry, rw, rh] = S.ring.frame;
      const r = { x: rx - pad, y: ry - pad, w: rw + 2 * pad, h: rh + 2 * pad };
      const x = clampX(r.x + r.w / 2 - cw * .32, cw);
      const gap = 18;
      // Below, with Blip's head between the ring and the card.
      if (r.y + r.h + gap + blipRoom + ch <= H - M) return [x, r.y + r.h + gap + blipRoom, "below"];
      // Above, a little further off: the thread runs down from the card to it.
      if (r.y - gap * 2 - ch >= M + blipRoom) return [x, r.y - gap * 2 - ch, "above"];
      // Beside: whichever side has room, level with the ring.
      const y = clampY(r.y + r.h / 2 - ch / 2, ch);
      if (r.x + r.w + gap * 2 + cw <= W - M) return [r.x + r.w + gap * 2, y, "right"];
      if (r.x - gap * 2 - cw >= M) return [r.x - gap * 2 - cw, y, "left"];
      return [x, clampY(H - M - ch, ch), "default"];
    }
    if (S.anchor) {
      const [ax, ay] = S.anchor;
      const x = clampX(ax - cw * .3, cw);
      const below = ay + 28 + blipRoom;
      return [x, below + ch <= H - M ? below : clampY(ay - 28 - ch, ch), "anchor"];
    }
    // Nowhere in particular: low and centred, above where the pill lives.
    return [clampX((W - cw) / 2, cw), clampY(H - M - ch - K.num("desktop.guide.bottomOffset", 110), ch), "default"];
  }
  function place(instant) {
    if (!S.shown) return;
    const [x, y, where] = layout();
    const [cw, ch] = cardSize();
    S.where = where; S.box = { x, y, w: cw, h: ch };
    if (instant) card.classList.add("still");
    card.style.setProperty("--x", Math.round(x) + "px");
    card.style.setProperty("--y", Math.round(y) + "px");
    if (instant) { void card.offsetWidth; card.classList.remove("still"); }
    placeChip();
  }
  /** The card's height follows its content, smoothly. */
  const fit = () => { card.style.height = inner.offsetHeight + "px"; requestAnimationFrame(() => place(false)); };
  new ResizeObserver(fit).observe(inner);

  // ---- what it says ----------------------------------------------------------
  const LABELS = {
    listening: () => K.txt("desktop.guide.listening", "Listening"),
    thinking: () => K.txt("desktop.guide.thinking", "Looking"),
    showing: () => K.txt("desktop.guide.showing", "Here"),
    doing: () => K.txt("desktop.guide.doing", "Doing it"),
    confirm: () => (S.risk === "always" ? K.txt("desktop.guide.confirmAlways", "Can't be undone") : K.txt("desktop.guide.confirm", "Check first")),
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
    S.state = state;
    card.dataset.state = state;
    card.dataset.risk = S.risk;
    $("eyebrow").textContent = label || (LABELS[state] ? LABELS[state]() : state);
    $("foot").textContent = FOOT[state] ? FOOT[state]() : "";
    blip.live(state === "listening");
    blip.pose(poseFor());
  }
  function poseFor() {
    if (!S.shown) return "hidden";
    switch (S.state) {
      case "listening": return "listening";
      case "thinking": return "thinking";
      case "confirm": return "confirm";
      case "done": return "done";
      case "error": return "oops";
      default: return S.ring ? "point" : "peek";
    }
  }
  function words(el, text) {
    el.textContent = "";
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
    if (!S.ring || !S.ring.caption) { chip.classList.remove("on"); return; }
    const pad = K.num("desktop.guide.ringPad", 6);
    const [rx, ry, rw, rh] = S.ring.frame;
    const cw = chip.offsetWidth || 80, chh = chip.offsetHeight || 24;
    const x = Math.max(M, Math.min(W - M - cw, rx - pad));
    // Above the ring, else below it, else to its left: wherever the card is not.
    const b = S.box, hits = (cx, cy) => b && cx < b.x + b.w && cx + cw > b.x && cy < b.y + b.h + 8 && cy + chh > b.y - 60;
    const spots = [[x, ry - pad - 34], [x, ry + rh + pad + 10], [Math.max(M, rx - pad - cw - 12), ry + rh / 2 - chh / 2]];
    const [cx, cy] = spots.find(([sx, sy]) => sy >= M && sy + chh <= H - M && !hits(sx, sy)) || spots[0];
    chip.style.setProperty("--x", Math.round(cx) + "px");
    chip.style.setProperty("--y", Math.round(cy) + "px");
    chip.classList.add("on");
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
  function dot(g, x, y, r) {
    g.beginPath(); g.arc(x, y, r + .9, 0, TAU); g.fillStyle = "rgba(15,13,11,.62)"; g.fill();
    g.beginPath(); g.arc(x, y, r, 0, TAU); g.fillStyle = "#F3E2C6"; g.fill();
  }
  function drawRing(t) {
    const R = S.ring; if (!R) return;
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
  /** The thread: dots from Blip's fingertip to the nearest edge of the ring. */
  function drawThread(t, rc) {
    const R = S.ring;
    if (!R) return;
    // From Blip's finger; or, when the card sits above the ring and Blip
    // cannot reach past it, from the card's own bottom edge.
    let tip = blip.fingertip();
    if (S.where === "above" && rc) tip = [Math.max(rc.left + 28, Math.min(rc.right - 28, R.frame[0] + R.frame[2] / 2)), rc.bottom + 4];
    if (!tip) return;
    const pad = K.num("desktop.guide.ringPad", 6) + 9;
    const [rx, ry, rw, rh] = R.frame;
    const tx = Math.max(rx - pad, Math.min(rx + rw + pad, tip[0]));
    const ty = Math.max(ry - pad, Math.min(ry + rh + pad, tip[1]));
    const dx = tx - tip[0], dy = ty - tip[1], L = Math.hypot(dx, dy);
    if (L < 14) return;
    // A gentle arc, bowing away from the card.
    const nx = -dy / L, ny = dx / L, bow = Math.min(60, L * .18);
    const cxp = (tip[0] + tx) / 2 + nx * bow, cyp = (tip[1] + ty) / 2 + ny * bow;
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

  // ---- the voice: a row of dots it moves --------------------------------------
  function drawWave(t) {
    if (S.state !== "listening" && S.state !== "thinking") return;
    const ww = wave.width / dpr, wh = wave.height / dpr;
    wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    wctx.clearRect(0, 0, ww, wh);
    S.level += (S.levelTo - S.level) * .25;
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
  function frame(ms) {
    raf = 0;
    const t = ms / 1000;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    drawRing(t);
    const rc = card.getBoundingClientRect();
    if (rc.width) {
      const right = S.ring && (S.ring.frame[0] + S.ring.frame[2] / 2) > rc.left + rc.width * .62;
      const ax = right ? rc.right - 54 : rc.left + 54;
      if (S.ring) { const c = [S.ring.frame[0] + S.ring.frame[2] / 2, S.ring.frame[1] + S.ring.frame[3] / 2]; blip.lookAt(c); blip.pointAt(S.where === "above" ? null : c); }
      else if (S.state === "confirm") { const y = $("yes").getBoundingClientRect(); blip.lookAt([y.left + y.width / 2, y.top + y.height / 2]); blip.pointAt(null); }
      else if (S.state === "thinking") { blip.lookAt([ax - 40, rc.top - 160]); blip.pointAt(null); }
      else { blip.lookAt(null); blip.pointAt(null); }
      blip.draw(ctx, ax, rc.top, t, dpr);
    }
    drawThread(t, rc);
    drawWave(t);
    if (S.shown || blip.shown() || (S.hideAt && t - S.hideAt < .6)) raf = requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, W, H);
  }
  function wake() { if (!raf) raf = requestAnimationFrame(frame); }

  // ---- speaking -----------------------------------------------------------------
  let tts = null;   // { ctx, src } while the server's voice plays
  function stopSpeaking() {
    try { window.speechSynthesis && speechSynthesis.cancel(); } catch { /* none */ }
    if (tts) { try { tts.src && tts.src.stop(); } catch { /* ended */ } try { tts.ctx.close(); } catch { /* closed */ } tts = null; }
    blip.speaking(false);
  }
  function speak(m) {
    stopSpeaking();
    let over = false;
    const done = () => { if (over) return; over = true; blip.speaking(false); bridge.spoken(); };
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
      // the answer is only read, never said in the wrong voice.
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
      u.onstart = () => blip.speaking(true);
      u.onend = u.onerror = done;
      speechSynthesis.speak(u);
    }
  }

  // ---- messages from the main process -------------------------------------------
  function show(m) {
    const first = !S.shown;
    S.shown = true; S.hideAt = 0;
    S.ring = null; S.anchor = m.anchor ? [m.anchor.x, m.anchor.y] : null;
    $("app").textContent = m.app || "";
    $("heard").textContent = "";
    $("say").textContent = "";
    setSteps([]);
    S.risk = "confirm";
    setState(m.state || "listening", m.label);
    $("askHint").textContent = K.txt("desktop.guide.askHint", "or tap {key} twice", { key: m.key || "Alt" });
    card.classList.add("on");
    fit();
    place(first);
    wake();
  }
  function hide() {
    if (!S.shown) return;
    stopSpeaking();
    S.shown = false;
    blip.pose("hidden");
    S.hideAt = performance.now() / 1000;
    // Blip ducks first, then the card goes.
    setTimeout(() => { if (!S.shown) { card.classList.remove("on"); chip.classList.remove("on"); S.ring = null; } }, 160);
    bridge.mouse(false);
    wake();
  }
  const handlers = {
    show,
    hide,
    // The label, when there is one, is what it is doing ("Pressing Export"),
    // in the eyebrow.
    state: (m) => { if (m.risk) S.risk = m.risk; setState(m.state, m.label ? String(m.label).slice(0, 34) : ""); fit(); },
    level: (m) => { S.levelTo = Math.max(0, Math.min(1, Number(m.v) || 0)); },
    heard: (m) => { $("heard").textContent = m.text ? "“" + m.text + "”" : ""; fit(); },
    // The words at once; the voice when it is ready (`voice`): the server's
    // audio, or the built-in voice with a locale.
    say: (m) => {
      words($("say"), m.text);
      if (S.state === "listening" || S.state === "thinking") setState("showing");
      fit();
    },
    voice: (m) => { if (m.audio || m.speak) speak(m); },
    hush: () => stopSpeaking(),
    point: (m) => {
      if (!Array.isArray(m.frame) || m.frame.length !== 4) return;
      S.ring = { frame: m.frame.map(Number), caption: m.caption || "", at: performance.now() / 1000 };
      chip.textContent = S.ring.caption;
      if (S.state === "listening" || S.state === "thinking") setState("showing");
      else blip.pose(poseFor());
      place(false);
      wake();
    },
    unpoint: () => { S.ring = null; chip.classList.remove("on"); blip.pose(poseFor()); place(false); },
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
  };
  bridge.onGuide((m) => { if (m && handlers[m.type]) { try { handlers[m.type](m); } catch (e) { console.error(e); } } });

  $("yes").addEventListener("click", () => { bridge.confirm(true); setState("doing"); fit(); });
  $("no").addEventListener("click", () => { bridge.confirm(false); });
  $("close").addEventListener("click", () => bridge.dismiss());
  card.addEventListener("mouseenter", () => bridge.mouse(true));
  card.addEventListener("mouseleave", () => bridge.mouse(false));

  if (bridge.knobs) bridge.knobs().then((k) => K.setKnobs(k)).catch(() => {});
  if (bridge.onKnobs) bridge.onKnobs((k) => K.setKnobs(k));
  resize();

  // ---- the review page ------------------------------------------------------------
  function fakeBridge() {
    let cb = () => {};
    return {
      onGuide: (f) => { cb = f; }, send: (m) => cb(m),
      confirm: (y) => console.log("confirm", y), mouse: () => {}, spoken: () => {}, dismiss: () => console.log("dismiss"),
    };
  }
  if (DEMO) runDemo(params.get("demo"));
  function runDemo(scene) {
    document.body.classList.add("demo");
    const mock = document.createElement("div");
    mock.className = "mock";
    mock.innerHTML = `<div class="bar"><i></i><i></i><i></i><b>Q3 launch — Keynote</b></div>
      <div class="tools"><span>Share</span><span id="m-export">Export</span><span class="primary">Play</span></div>
      <div class="side"><p class="on"># design</p><p># launch</p><p># general</p><p>Priya</p><p>Anthony</p></div>
      <div class="page"><h2>Mockups, round two</h2><div class="ln" style="width:92%"></div><div class="ln" style="width:84%"></div><div class="ln" style="width:66%"></div></div>
      <div class="composer" id="m-composer">Message #design<em id="m-send">Send</em></div>`;
    document.body.insertBefore(mock, fx);
    const send = (m) => bridge.send(m);
    const box = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
    let lv = 0; setInterval(() => { lv = .25 + .55 * Math.abs(Math.sin(performance.now() / 260)) * Math.random(); send({ type: "level", v: lv }); }, 90);
    const scenes = {
      listening: () => { send({ type: "show", state: "listening", app: "Keynote", anchor: { x: 520, y: 200 } }); },
      thinking: () => { scenes.listening(); send({ type: "heard", text: "where's the export button?" }); send({ type: "state", state: "thinking" }); },
      point: () => { scenes.thinking(); send({ type: "say", text: "Up here, top right: Export. Pick PDF in the menu it opens." }); send({ type: "point", frame: box("m-export"), caption: "Export" }); },
      steps: () => {
        send({ type: "show", state: "doing", app: "Slack" });
        send({ type: "heard", text: "tell design the mockups are ready" });
        send({ type: "say", text: "Writing it in #design." });
        send({ type: "steps", items: [{ text: "Open #design", state: "done" }, { text: "Write the message", state: "doing" }, { text: "Send it", state: "todo" }] });
        send({ type: "point", frame: box("m-composer"), caption: "Message #design" });
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
    };
    if (scene && scenes[scene]) { scenes[scene](); return; }
    // The whole run, on a loop.
    const order = ["listening", "thinking", "point", "steps", "confirm", "done"];
    let i = 0;
    const next = () => { scenes[order[i % order.length]](); i++; setTimeout(next, i % order.length === 0 ? 3600 : 2600); };
    next();
  }
})();
