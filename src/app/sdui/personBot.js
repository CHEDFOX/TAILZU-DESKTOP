// PersonBot (shared/types/sdui.ts 3j, the server's docs/spaces.md "How people look"): a person as their own tiny bot, never their
// initials. Wherever Spaces shows a person (a space's people, an invitation, a request to join, the spaces list, Work in space, a
// share page, the "@" list), the server sends { type: "PersonBot", props: { seed, avatar, color, size?, live?, label? } }.
//
// HIS BOX is size x size (32 by default) and its bottom edge is his floor: he stands on it, drawn by ../../botTiles.js (the phone's
// core) in the avatar the server gave him from the looks catalog (bots.js btLooks) and the person's colour. No cloth, no toys. His
// world is half as wide again as the box, the box in its middle, so a shrug never meets a wall; he is 0.76 of the box tall, so
// every look in the catalog (a top hat, a crown, a star on an antenna) stays inside it. These are the phone's numbers
// (TAILZU-FRONTEND app/src/sdui/bots/personBotCore.ts) and his seed is worked out the same way, so a person idles alike on both.
//
// HOW HE IDLES (PbIdle). He is in his standing pose at once, then after a pause of his own plays PB_IDLE on a loop: he looks about,
// now and then at you, sways a little (a lean and a head tilt on two slow sines of his own) and blinks (the engine's blinks, on his
// seed). Rarely, a small gesture from the catalog (a shrug, a look), never two in the window within `gap` seconds (PB_GATE). A
// gesture that leaves him off his spot walks him back to it. All of it is seeded by the person's id and which of that person he is
// on the screen, so a list never moves in step, the same person in two rows included.
//
// ONE LOOP FOR ALL OF THEM (PB_LOOP): one animation frame loop for every PersonBot in the window, the screen's and the "@" list's.
// It steps only the ones in view (one IntersectionObserver), draws at most `fps` times a second, and stops with none in view or the
// window hidden. A repaint replaces #view's markup, never his life: each is kept by person and place (PB_LIVES), and the new canvas
// picks him up where he was. Reduce Motion, or live false: his standing pose, still, painted once. Without the core, or a drawing
// that fails: a plain circle in his colour (what the server sends a build without PersonBot).

const PB = {
  size: 32, minSize: 12, maxSize: 128,
  scale: 0.76, world: 1.5,
  ink: "#0a0a0a",
  every: [16, 36], first: [4, 24], start: [0, 4], retry: [1, 3],
  gap: 2.5,
  drift: 0.1, walkSpeed: 0.6, walkFor: 4,
  gestures: ["shrug", "react.look"],
  fps: 30,
};

/** His life, by scope, person and place: { key, bot, idle, size, color }. */
const PB_LIVES = new Map();

// ---- the rules (pure) --------------------------------------------------------------------------------------------------

/** What the node says, read safely: a size in range, a colour that is one (else ink), live unless it says false. */
function pbRead(p) {
  const o = p && typeof p === "object" ? p : {};
  const n = Number(o.size);
  const size = Math.round(Math.min(PB.maxSize, Math.max(PB.minSize, Number.isFinite(n) && n > 0 ? n : PB.size)));
  const c = typeof o.color === "string" ? o.color.trim() : "";
  return {
    seed: typeof o.seed === "string" || typeof o.seed === "number" ? String(o.seed) : "",
    avatar: typeof o.avatar === "string" ? o.avatar : "",
    color: /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c) ? c : PB.ink,
    size,
    live: o.live !== false,
    label: typeof o.label === "string" ? String(label(o.label) || "") : "",
  };
}

/** His engine seed: the person's id (FNV-1a, the phone's seedOf) and `salt`, which of that person on the screen he is (0 the first). */
function pbSeed(id, salt) {
  let h = 0x811c9dc5;
  const s = String(id || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  if (salt) h = Math.imul(h ^ Math.imul(salt + 1, 0x9e3779b1), 0x85ebca6b) >>> 0;
  return h >>> 0 || 1;
}

/** His world for a box of `size`: its width and height, his floor (the box's foot), his height, and the box's left in it. */
function pbStage(size) {
  const w = size * PB.world;
  // The engine keeps its floor at least 4 px over its world's foot: the world is that much taller than the box.
  return { w, h: size + 4, floor: size, S: size * PB.scale, boxX: (w - size) / 2 };
}

/** Move him as he is so his head is over x: every particle by the same distance, so nothing about how he moves changes. */
function pbStandIn(bot, x) {
  const dx = x - bot.crown().x;
  if (!Number.isFinite(dx) || Math.abs(dx) < 1e-6) return;
  for (let i = 0; i < bot.n; i++) { bot.x[i] += dx; bot.px[i] += dx; }
}

/** A [lo, hi] of seconds, both finite and lo <= hi; else the default. */
function pbRange(r, d) {
  if (!Array.isArray(r) || r.length < 2) return d;
  const a = Number(r[0]), b = Number(r[1]);
  return Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b >= a ? [a, b] : d;
}

/** The server's say on his idling (knobs), with the phone's numbers as the fallback. */
function pbOptions(size) {
  return {
    every: pbRange(K.list("desktop.personBot.everyS", [16, 36]), PB.every),
    first: pbRange(K.list("desktop.personBot.firstS", [4, 24]), PB.first),
    start: PB.start,
    retry: PB.retry,
    drift: size * PB.drift,
    walkSpeed: PB.walkSpeed,
    walkFor: PB.walkFor,
  };
}

/**
 * HIS IDLE, as a recipe in the catalog's own language (the phone's PERSON_IDLE), compiled once by the engine: a 9 s loop of looking
 * about (and on half the rounds at you), a lean and a head tilt on two slow sines. `T + 9*k` is the time since the loop began, so
 * the sines never jump; `rnd` and `rnd2` are his own draws for this play, so no two bots sway alike.
 */
const PB_IDLE = {
  v: 1,
  moments: {
    "person.idle": {
      label: "Idles",
      note: "A person's tiny bot standing in their row: looks about, sways a little, blinks (PersonBot).",
      dur: 9,
      mode: "loop",
      fallback: "settle",
      tracks: [
        { do: "look", target: "around", rate: 0.3 },
        { do: "look", target: "screen", at: 4.2, to: 6.6, chance: 0.5 },
        { do: "lean", v: "0.04*sin((T + 9*k)*(1.05 + 0.4*rnd) + 6.283*rnd2)" },
        { do: "tilt", v: "0.05*sin((T + 9*k)*(0.7 + 0.3*rnd2) + 6.283*rnd)" },
      ],
    },
  },
};
let PB_IDLE_M;
/** PB_IDLE compiled (once); null if this engine cannot play it, and he simply stands. */
function pbIdleMoment() {
  const api = window.TailzuBotTiles;
  if (PB_IDLE_M === undefined && api) PB_IDLE_M = api.compileLooks(PB_IDLE).moment("person.idle") || null;
  return PB_IDLE_M || null;
}

/** The window's say on gestures: at most one every `gap` seconds, whoever asks (the loop's clock, seconds). */
const PB_GATE = {
  gap: PB.gap,
  last: -Infinity,
  take(now) { if (now - this.last < this.gap) return false; this.last = now; return true; },
};

/** A person's tiny bot in his box: standing in the middle in his resting pose, still (PbIdle.start lets him live). */
function pbTile(seed, color, size, avatar) {
  const api = window.TailzuBotTiles;
  const st = pbStage(size);
  const bot = new api.BotTile({ kind: "custom", color, mood: "idle", seed, size: st.S, toys: false, avatar: avatar || undefined });
  bot.cloth = 0;
  // "stand": between his moments the engine keeps him standing where he is, looking about (never a play, never a wander).
  bot.setAct("stand");
  bot.resize(st.w, st.h, st.floor);
  bot.settle(true);
  pbStandIn(bot, st.w / 2);
  return bot;
}

/** One person's tiny bot living: his idle, his rare gestures, back to his spot after one (the phone's PersonIdle). */
class PbIdle {
  constructor(bot, home, seed, o, idle) {
    this.bot = bot;
    this.home = home;
    this.o = o;
    this.rand = window.TailzuBotTiles.rng((seed ^ 0x6a09e667) >>> 0);
    this.idle = idle === undefined ? pbIdleMoment() : idle;
    this.live = false;
    this.wait = 0;
    this.nextIn = 0;
    this.walkT = -1;
  }

  pick(r) { return r[0] + this.rand() * (r[1] - r[0]); }

  /** He comes alive from his resting pose: the idle after his own pause, his first gesture later. */
  start() {
    if (this.live) return;
    this.live = true;
    this.bot.settle(false);
    this.wait = this.pick(this.o.start);
    this.nextIn = this.pick(this.o.first);
    this.walkT = -1;
  }

  /** Still (Reduce Motion, live false): whatever he was at stops, and he is in his resting pose on his spot. */
  stop() {
    const b = this.bot;
    this.live = false;
    b.stopWalk();
    if (b.mo) b.stopMoment();
    b.settle(true);
    pbStandIn(b, this.home);
  }

  /** dt seconds on (now: the loop's clock, seconds), with the gestures this build can play. Steps him; the loop paints. */
  frame(dt, now, gestures, gate) {
    const b = this.bot;
    if (!this.live) return;
    b.step(dt);
    if (this.walkT >= 0) {
      this.walkT += dt;
      if (b.walking() && this.walkT < this.o.walkFor) return;
      if (b.walking()) b.stopWalk();
      this.walkT = -1;
    }
    if (this.wait > 0) {
      this.wait -= dt;
      if (this.wait <= 0 && this.idle) b.playMoment(this.idle, "loop");
      return;
    }
    if (!b.mo) {
      // A gesture is over: off his spot, he walks back to it first; then his idle again.
      if (Math.abs(b.crown().x - this.home) > this.o.drift) {
        b.walkTo(this.home, { speed: this.o.walkSpeed });
        // The engine counts a walk done within a quarter of his height; a person's spot is narrower than that.
        b.steerTol = b.S * 0.05;
        this.walkT = 0;
        return;
      }
      if (this.idle) b.playMoment(this.idle, "loop");
    }
    // A gesture is playing.
    if (b.mo && b.mo !== this.idle) return;
    this.nextIn -= dt;
    if (this.nextIn > 0) return;
    const g = gestures.length ? gestures[Math.floor(this.rand() * gestures.length)] : null;
    if (g && gate.take(now) && b.playMoment(g, "once")) this.nextIn = this.pick(this.o.every);
    else this.nextIn = g ? this.pick(this.o.retry) : this.pick(this.o.every);
  }
}

// ---- the one loop ------------------------------------------------------------------------------------------------------

/**
 * Every PersonBot in the window that lives: { host, life, paint, seen }. One requestAnimationFrame loop for all of them; it steps
 * only those in view, at most `fps` times a second, and none while the window is hidden. A member whose host has left the page
 * leaves; one whose frame throws three times running leaves too (he stays drawn as he was).
 */
const PB_LOOP = { members: new Set(), raf: 0, last: 0, io: null, listening: false };

function pbObserver() {
  if (PB_LOOP.io || typeof IntersectionObserver !== "function") return PB_LOOP.io;
  PB_LOOP.io = new IntersectionObserver((es) => {
    for (const e of es) {
      const m = e.target.__pb;
      if (m) m.seen = e.isIntersecting;
    }
    pbWake();
  });
  return PB_LOOP.io;
}

function pbJoin(m) {
  // Read when a bot joins, not when this file loads: the bootstrap's knobs come later.
  PB_GATE.gap = K.num("desktop.personBot.gapS", 2.5);
  // Seen until the observer says otherwise (a window without one sees them all).
  m.seen = true;
  m.faults = 0;
  m.host.__pb = m;
  PB_LOOP.members.add(m);
  const io = pbObserver();
  if (io) io.observe(m.host);
  if (!PB_LOOP.listening) { PB_LOOP.listening = true; document.addEventListener("visibilitychange", pbWake); }
  pbWake();
}

function pbLeave(m) {
  PB_LOOP.members.delete(m);
  if (PB_LOOP.io) { try { PB_LOOP.io.unobserve(m.host); } catch { /* gone already */ } }
  if (m.host.__pb === m) m.host.__pb = null;
}

/**
 * Any member in view. Not whether it is on the page yet: a row of the "@" list is made before its list goes on the body, and the
 * next frame finds it there. A frame drops whatever has left the page first.
 */
function pbAnySeen() {
  for (const m of PB_LOOP.members) if (m.seen) return true;
  return false;
}

function pbWake() {
  if (PB_LOOP.raf || document.hidden || !pbAnySeen()) return;
  PB_LOOP.last = 0;
  PB_LOOP.raf = requestAnimationFrame(pbTick);
}

function pbTick() {
  PB_LOOP.raf = 0;
  for (const m of [...PB_LOOP.members]) if (!m.host.isConnected) pbLeave(m);
  if (document.hidden || !pbAnySeen()) return;
  const now = performance.now();
  const fps = K.num("desktop.personBot.fps", 30);
  // Drawn at most fps times a second: a frame that comes sooner is skipped (a millisecond's grace for the display's jitter).
  if (PB_LOOP.last && fps > 0 && now - PB_LOOP.last < 1000 / fps - 1) { PB_LOOP.raf = requestAnimationFrame(pbTick); return; }
  const dt = PB_LOOP.last ? (now - PB_LOOP.last) / 1000 : 1 / 60;
  PB_LOOP.last = now;
  const gestures = pbGestures();
  for (const m of [...PB_LOOP.members]) {
    if (!m.seen) continue;
    try {
      m.life.idle.frame(dt, now / 1000, gestures, PB_GATE);
      m.paint();
      m.faults = 0;
    } catch (e) {
      if (++m.faults >= 3) { console.warn("[Tailzu][PersonBot] frame failed:", e); pbLeave(m); }
    }
  }
  if (!PB_LOOP.raf && !document.hidden && pbAnySeen()) PB_LOOP.raf = requestAnimationFrame(pbTick);
}

/** The catalog's gestures this build can play (the server's list, else the phone's). */
function pbGestures() {
  const L = btLooks();
  if (!L) return [];
  const ids = K.list("desktop.personBot.gestures", ["shrug", "react.look"]);
  return (Array.isArray(ids) ? ids : PB.gestures).map((id) => L.moment(String(id))).filter(Boolean);
}

// ---- drawing -----------------------------------------------------------------------------------------------------------

/** His life for this place: made once, kept across paints; made again when his colour or his box changes. */
function pbLife(scope, o, salt) {
  const key = scope + "|" + o.seed + "|" + salt;
  let L = PB_LIVES.get(key);
  if (L && (L.size !== o.size || L.color !== o.color)) L = null;
  const looks = btLooks();
  const avatar = looks ? looks.avatar("custom", o.avatar) : null;
  if (!L) {
    // A screen of people no longer up goes, a few at a time (each is a whole small bot).
    if (PB_LIVES.size >= K.num("desktop.personBot.lives", 96)) {
      for (const [k, v] of PB_LIVES) { if (!v.member || !v.member.host.isConnected) PB_LIVES.delete(k); if (PB_LIVES.size < 64) break; }
    }
    const seed = pbSeed(o.seed, salt);
    const bot = pbTile(seed, o.color, o.size, avatar);
    const st = pbStage(o.size);
    L = { key, bot, size: o.size, color: o.color, idle: new PbIdle(bot, st.w / 2, seed, pbOptions(o.size)), member: null };
    PB_LIVES.set(key, L);
  } else if (avatar) {
    // A new catalog re-skins him where he stands.
    L.bot.setAvatar(avatar);
  }
  return L;
}

/** The box: the middle of his world, drawn into a canvas sized for the display. */
function pbPaint(cv, bot, size) {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const W = Math.max(1, Math.round(size * dpr));
  if (cv.width !== W || cv.height !== W) { cv.width = W; cv.height = W; cv.style.width = size + "px"; cv.style.height = size + "px"; }
  const g = cv.getContext("2d");
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, size, size);
  g.save();
  g.translate(-pbStage(size).boxX, 0);
  bot.draw(g);
  g.restore();
}

/** He failed to draw: the plain circle in his colour, as a build without PersonBot is sent. */
function pbCircle(host, color) {
  const cv = host.querySelector(".tz-pb-c");
  if (cv) cv.remove();
  host.style.borderRadius = "50%";
  host.style.background = color;
}

/** A host (the node's, or a row's) given its bot: painted now, on the loop while he lives. `salt`: which of that person he is. */
function pbMount(host, o, scope, salt, reduced) {
  const cv = host.querySelector(".tz-pb-c");
  if (!cv || !window.TailzuBotTiles) { pbCircle(host, o.color); return; }
  try {
    const L = pbLife(scope, o, salt);
    if (L.member) pbLeave(L.member);
    L.member = null;
    const paint = () => pbPaint(cv, L.bot, o.size);
    const live = o.live && !reduced;
    if (live) L.idle.start(); else if (L.idle.live) L.idle.stop();
    paint();
    if (!live) return;
    const m = { host, life: L, paint, seen: true, faults: 0 };
    L.member = m;
    pbJoin(m);
  } catch (e) {
    console.warn("[Tailzu][PersonBot] stopped:", e);
    pbCircle(host, o.color);
  }
}

/** The node: the box, an empty canvas in it (mountPersonBots gives it his bot once the markup lands). */
function personBotNode(p, s) {
  const o = pbRead(p);
  const a11y = o.label ? ' role="img" aria-label="' + esc(o.label) + '"' : ' aria-hidden="true"';
  const box = "width:" + o.size + "px;height:" + o.size + "px;";
  if (!window.TailzuBotTiles) return '<span class="tz-pb"' + a11y + ' style="' + (s ? s + ";" : "") + box + "border-radius:50%;background:" + esc(o.color) + '"></span>';
  const id = BT_PENDING.push({ kind: "person", o }) - 1;
  return '<span class="tz-pb" data-pb="' + id + '"' + a11y + ' style="' + (s ? s + ";" : "") + box + '"><canvas class="tz-pb-c" aria-hidden="true"></canvas></span>';
}

/**
 * After a paint: each box gets its bot. Which of a person he is counts in the order they are drawn, so the same person twice on a
 * screen idles as two, and a repaint finds each where he was.
 */
function mountPersonBots(root) {
  const reduced = prefers("(prefers-reduced-motion: reduce)");
  const salts = new Map();
  root.querySelectorAll("[data-pb]").forEach((host) => {
    const cfg = BT_PENDING[Number(host.getAttribute("data-pb"))];
    if (!cfg || cfg.kind !== "person") return;
    const salt = salts.get(cfg.o.seed) || 0;
    salts.set(cfg.o.seed, salt + 1);
    pbMount(host, cfg.o, "view", salt, reduced);
  });
}

/**
 * A person's tiny bot for a list drawn from data (MentionField's "@" rows): an element, mounted at once. `scope` keeps these lives
 * apart from the screen's (the same person in the field's list and on the page idles as two); `salt` is which of them in the list.
 */
function personBotEl(look, size, scope, salt) {
  const o = pbRead(Object.assign({}, look, { size, label: "" }));
  const host = document.createElement("span");
  host.className = "tz-pb";
  host.setAttribute("aria-hidden", "true");
  host.style.width = o.size + "px";
  host.style.height = o.size + "px";
  const cv = document.createElement("canvas");
  cv.className = "tz-pb-c";
  cv.setAttribute("aria-hidden", "true");
  host.appendChild(cv);
  pbMount(host, o, String(scope || "list"), Number(salt) || 0, prefers("(prefers-reduced-motion: reduce)"));
  return host;
}
