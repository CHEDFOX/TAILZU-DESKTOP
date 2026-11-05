// Spaces' living blocks (shared/types/sdui.ts 3i): BotStage, BotCrowd and Vanish, drawn with ../../botTiles.js (the phone's core).
//
// BotStage: a full tiny bot on a stage of his own. He roams (botTiles.js Roam: a walk, a stand, a catalog moment), walks out at a
// side and back in (outWhen), hops (cheerWhen), thinks, listens (his bubbles pulse with the voice the main process hears), and holds
// a thought: a box joined to his head by three bubbles (thoughtTrail). At rest the box is a small pill riding over him (followStep);
// tapped, it lets go of him and grows (square over him, or the stage's width), the window blurred behind it when it says veil; near
// the whole window when fullWhen holds; with place "low" he walks down to the foot of the window and the box fills the room above.
// BotCrowd: one canvas, one world, many tiny bots on patches of their own; it grows taller and cheers all together. Vanish: its
// children vaporise (blur, rise, fade, ink specks) and come back.
//
// A REPAINT REPLACES #view, AND NONE OF THIS MAY RESTART. Each lives in a Map outside the DOM by its life (or key): the bot, his
// roam, the box's last rect, the follow, what each condition was. The node draws the markup where things were; mountStages() runs
// right after it lands (bots.js mountBotTiles) and animates only what changed, from where it was (FLIP). The stage's own actions
// (onPress, onDoubleTap) are bound to his hit area alone, never to the stage's outer element, so a button in his thought never also
// presses him. Reduce Motion: still bots, the box still over him, every change at once.

const ST_LIVES = new Map();
const CR_LIVES = new Map();
/** Vanish: what each key was last drawn as (true gone, false there). */
const VN_GONE = new Map();
/** The stages the last paint mounted, for Escape. */
let ST_MOUNTED = [];

/** His crown stands about this many of his heights over the floor (the core's standing pose). */
const ST_CROWN = 1.05;
const ST_FLOOR = 6;

/** The stage's mode: full, open, listen, rest (in that order: §5.2). */
function stModeOf(p, th) {
  if (!th) return "rest";
  if (th.fullWhen && visible(th.fullWhen)) return "full";
  if (th.openPath && truthy(stateAt(th.openPath))) return "open";
  if (p.listenWhen && visible(p.listenWhen)) return "listen";
  return "rest";
}

/** The trail's room at rest (the core's TRAIL), about 82 px. */
function stTrailRoom() {
  const api = window.TailzuBotTiles;
  return api && typeof api.trailRoom === "function" ? api.trailRoom(1) : 82;
}

/** The stage is never drawn shorter than him and, with a pill, the trail's room and the pill (BotStageProps.size). */
function stMinHeight(p, th) {
  const size = Number(p.size) || 30;
  return size + 18 + (th && th.restText ? stTrailRoom() + 48 : 0);
}

/** His life: kept for the app's life, by `life`. The bot is made when the core is there. */
function stLife(p) {
  const life = String(p.life || "stage");
  let L = ST_LIVES.get(life);
  if (!L) {
    L = { life, bot: null, roam: null, mode: null, rect: null, follow: { x: NaN, v: 0, target: NaN }, cheer: null, out: null, outAt: "right", lowY: 0, h: 0, standUntil: 0, gliding: false, animUntil: 0, restW: 0 };
    ST_LIVES.set(life, L);
  }
  return L;
}

function botStageNode(n) {
  const p = n.props || {};
  const th = p.thought && typeof p.thought === "object" ? p.thought : null;
  const mode = stModeOf(p, th);
  const L = stLife(p);
  // The thought's content only while it is open, full, or he listens; at rest the pill says restText.
  const kids = mode !== "rest" ? (n.children || []).map(node).join("") : "";
  const id = BT_PENDING.push({ kind: "stage", n, p, th, mode }) - 1;
  const H = Math.max(Number(p.height) || 0, stMinHeight(p, th));
  const h = L.h && th && th.veil === false ? L.h : H;
  const style = th ? (th.style === "home" ? "home" : "space") : "";
  const r = L.rect;
  const boxAt = r ? "left:" + r.x + "px;top:" + r.y + "px;width:" + r.w + "px;height:" + r.h + "px;" : "";
  const rest = th && th.restText ? '<button type="button" class="tz-th-rest">' + esc(label(th.restText)) + "</button>" : "";
  // No pill at rest: no box, except the moment it closes (drawn where it was, and faded out by the mount).
  const closing = mode === "rest" && !rest && (L.mode === "open" || L.mode === "full");
  const box = th ? '<div class="tz-th-box tz-th-' + style + (th.place === "low" ? " tz-th-low" : "") + '" data-mode="' + mode + '" style="' + boxAt + (mode === "rest" && !rest && !closing ? "display:none;" : "") + '">' +
    (mode === "rest" ? rest : '<div class="tz-th-in">' + kids + "</div>") + "</div>" : "";
  // The veil is drawn as it was (on, while it was open) so a repaint never flashes it, and the mount fades it to what it is now.
  const veilWas = L.mode === "open" || L.mode === "full";
  return '<div class="tz-st" data-st="' + id + '" style="height:' + h + 'px">' +
    (th && th.veil ? '<div class="tz-th-veil' + (veilWas ? " on" : "") + '" aria-hidden="true"></div>' : "") +
    '<div class="tz-st-layer">' +
    '<canvas class="tz-bt-c tz-st-c" aria-hidden="true"></canvas>' +
    (th ? '<div class="tz-th-trail" aria-hidden="true"><i class="tz-th-b"></i><i class="tz-th-b"></i><i class="tz-th-b"></i></div>' : "") +
    '<button type="button" class="tz-st-hit' + (p.hit === "stage" ? " tz-st-all" : "") + '" aria-label="' + esc(label(p.label || "")) + '"></button>' +
    box + "</div></div>";
}

function botCrowdNode(n, p, kids) {
  const id = BT_PENDING.push({ kind: "crowd", p }) - 1;
  const L = CR_LIVES.get(String(p.life || "crowd"));
  const grown = !!p.grownWhen && visible(p.grownWhen);
  const want = grown && Number(p.grownHeight) > 0 ? Number(p.grownHeight) : Number(p.height) || 0;
  // Drawn at the height it had (a repaint never replays a grow); the mount moves it to its height now.
  const h = L && L.h ? L.h : want;
  return '<div class="tz-cr" data-cr="' + id + '" style="' + (h ? "height:" + h + "px" : "aspect-ratio:1") + '">' +
    '<canvas class="tz-bt-c tz-cr-c" role="img" aria-label="' + esc(label(p.label || "")) + '"></canvas>' +
    '<div class="tz-cr-in">' + kids + "</div></div>";
}

function vanishNode(p, kids) {
  const key = String(p.key || "vanish");
  const gone = !!p.goneWhen && visible(p.goneWhen);
  const was = VN_GONE.has(key) ? VN_GONE.get(key) : null;
  VN_GONE.set(key, gone);
  const id = BT_PENDING.push({ kind: "vanish", key, gone, was }) - 1;
  // As it was last drawn (gone at once when it is gone at the first draw); the mount plays a change.
  const drawnGone = was === null ? gone : was;
  return '<div class="tz-vn' + (drawnGone ? " gone" : "") + '" data-vn="' + id + '"' + (gone ? ' aria-hidden="true"' : "") + '><div class="tz-vn-in">' + kids + "</div></div>";
}

// ---- before and after a paint ------------------------------------------------------------------------------------------

/** Before #view's markup goes: each box's rect as it is seen now (FLIP from there), and the @ field's focus. */
function stagesBefore(view) {
  if (typeof mentionBefore === "function") mentionBefore();
  view.querySelectorAll(".tz-st").forEach((st) => {
    const L = st.__life;
    const box = st.querySelector(".tz-th-box"), layer = st.querySelector(".tz-st-layer");
    if (!L || !box || !layer || box.style.display === "none") return;
    const b = box.getBoundingClientRect(), r = layer.getBoundingClientRect();
    if (b.width > 0) L.rect = { x: b.left - r.left, y: b.top - r.top, w: b.width, h: b.height };
    L.h = st.clientHeight || L.h;
  });
  view.querySelectorAll(".tz-cr").forEach((cr) => { if (cr.__life && cr.clientHeight) cr.__life.h = cr.clientHeight; });
}

/** After a paint: the @ fields back in, the live words, then the vanishes, the crowds and the stages. */
function mountStages(root) {
  const reduced = prefers("(prefers-reduced-motion: reduce)");
  if (typeof mountMentions === "function") mountMentions(root);
  if (typeof mountLiveWords === "function") mountLiveWords(root);
  root.querySelectorAll("[data-vn]").forEach((el) => mountVanish(el, BT_PENDING[Number(el.getAttribute("data-vn"))], reduced));
  root.querySelectorAll("[data-cr]").forEach((el) => mountCrowd(el, BT_PENDING[Number(el.getAttribute("data-cr"))], reduced));
  // The veil of a stage from the last paint (lifted nowhere: it lived in the stage) went with it; the mounted list is new.
  ST_MOUNTED = [];
  root.querySelectorAll("[data-st]").forEach((el) => mountStage(el, BT_PENDING[Number(el.getAttribute("data-st"))], reduced));
}

/** Escape: the open thought on this screen closes (true), as a click on the veil does. */
function stageEscape() {
  for (let i = ST_MOUNTED.length - 1; i >= 0; i--) {
    const s = ST_MOUNTED[i];
    if (s.host.isConnected && (s.mode === "open" || s.mode === "full")) { stClose(s); return true; }
  }
  return false;
}

/** Closed by the person (the veil, Escape): openPath false, the screen drawn, then on.onDismiss. */
function stClose(s) {
  const th = s.th;
  if (th && th.openPath) setStatePath(th.openPath, false);
  const live = window.TailzuLive, held = live && live.holdView ? live.holdView(document) : null;
  repaint();
  if (held) live.restoreView(document, held);
  const on = s.n && s.n.on;
  if (on && on.onDismiss) void run(on.onDismiss);
}

// ---- BotStage ------------------------------------------------------------------------------------------------------------

function stSeed(life) { let seed = 23; for (const ch of String(life)) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0; return seed; }

function stBot(L, p, api) {
  const kind = p.kind || "custom", color = String(p.color || "#0a0a0a");
  const key = kind + "|" + color + "|" + (Number(p.size) || 30) + "|" + (p.toys === false ? 0 : 1);
  if (!L.bot || L.key !== key) {
    L.bot = new api.BotTile({ kind, color, mood: "idle", seed: stSeed(L.life), size: Number(p.size) || 30, toys: p.toys !== false });
    // No fabric under him: he stands among the page's own things.
    L.bot.cloth = 0;
    L.key = key;
    L.roam = null;
  }
  btDress(L.bot, kind, p.avatar);
  return L.bot;
}

/** Where the box goes for a mode, in the layer's px. g: { W, H (the stage now), crown (rest, layer px), view (the window) }. */
function stTarget(s, g, measure) {
  const th = s.th, L = s.L, mode = s.mode;
  const gut = K.num("desktop.stage.gutter", 16);
  const pillH = K.num("desktop.stage.pillHeight", 40), pillMax = K.num("desktop.stage.pillMaxWidth", 320);
  const room = stTrailRoom() + K.num("desktop.stage.pillLift", 8);
  const restBottom = g.crown - room;
  const clampX = (cx, w) => Math.max(gut, Math.min(g.W - gut - w, cx - w / 2));
  const headX = L.follow.x === L.follow.x ? L.follow.x : g.headX;
  if (mode === "rest") {
    const w = Math.min(pillMax, L.restW || pillMax, g.W - 2 * gut);
    return { x: clampX(headX, w), y: restBottom - pillH, w, h: pillH };
  }
  if (mode === "listen") {
    const w = Math.min(pillMax, g.W - 2 * gut);
    const h = Math.max(pillH, measure(w));
    return { x: clampX(headX, w), y: restBottom - h, w, h };
  }
  if (mode === "full") {
    // Near the whole window: from just under its top down to 72 px over his crown, across his column and a little past it
    // (the window's side column stays in sight, blurred), never nearer its edges than the gutter.
    const top = K.num("desktop.stage.fullTop", 12) - g.view.top, bottom = g.crown - K.num("desktop.stage.fullGap", 72);
    const past = K.num("desktop.stage.fullPast", 24);
    const left = Math.max(gut - g.view.left, -past), right = Math.min(g.view.width - gut - g.view.left, g.W + past);
    return { x: left, y: top, w: Math.max(120, right - left), h: Math.max(120, bottom - top) };
  }
  // open
  if (th.shape === "square") {
    const side = Math.min(g.W - 2 * gut > 0 ? Math.max(g.W - 2 * gut, 240) : 240, K.num("desktop.stage.squareMax", 360), g.view.height - 120);
    const x = clampX(g.headX, side);
    return { x, y: g.crown - K.num("desktop.stage.squareGap", 64) - side, w: side, h: side };
  }
  const w = Math.max(120, g.W - 2 * gut);
  if (th.place === "low") {
    // He has walked down to the window's foot; the box fills from near the window's top to above his trail, and scrolls.
    const top = K.num("desktop.stage.lowTop", 56) - g.view.top;
    return { x: gut, y: top, w, h: Math.max(120, restBottom - top) };
  }
  const h = Math.min(Math.max(K.num("desktop.stage.wideMin", 56), measure(w)), Math.round(g.view.height * K.num("desktop.stage.wideMaxFrac", 0.55)));
  return { x: gut, y: restBottom - h, w, h };
}

function mountStage(host, cfg, reduced) {
  const api = window.TailzuBotTiles;
  if (!cfg || !api || typeof api.thoughtTrail !== "function") return;
  const { n, p, th, mode } = cfg;
  const L = stLife(p);
  host.__life = L;
  const bot = stBot(L, p, api);
  const layer = host.querySelector(".tz-st-layer"), cv = host.querySelector(".tz-st-c"), hit = host.querySelector(".tz-st-hit");
  const box = host.querySelector(".tz-th-box"), veil = host.querySelector(".tz-th-veil");
  const bubbles = Array.from(host.querySelectorAll(".tz-th-b"));
  const s = { host, n, p, th, mode, L };
  ST_MOUNTED.push(s);
  const was = L.mode;
  L.mode = mode;
  const size = Number(p.size) || 30;
  const H0 = Math.max(Number(p.height) || 0, stMinHeight(p, th));
  const W = () => host.clientWidth || layer.clientWidth || 0;

  // ---- him
  const fit = (h) => { const w = W(); if (w > 0) bot.resize(w, h, h - ST_FLOOR); };
  fit(host.clientHeight || H0);
  if (p.roam && !L.roam && typeof api.Roam === "function" && btLooks()) L.roam = new api.Roam(bot, btLooks(), p.roam, W() || 300, stSeed(L.life) ^ 7);
  if (L.roam) L.roam.w = W() || L.roam.w;
  // What he is at: thinking, listening, standing by his open thought, or his own life (a breath first after it closes). Thinking
  // comes first: a voice chat listens for all of its turns (sending included, so the box keeps its words), and he thinks while a
  // turn's words go.
  const out = !!p.outWhen && visible(p.outWhen);
  const side = p.outSide === "left" || p.outSide === "right" ? p.outSide : null;
  const listening = !!th && !!p.listenWhen && visible(p.listenWhen);
  const thinking = !!p.thinkWhen && visible(p.thinkWhen);
  const opened = mode === "open" || mode === "full";
  if (was && (was === "open" || was === "full") && !opened) L.standUntil = performance.now() + K.num("desktop.stage.standMs", 1300);
  const act = thinking ? "think" : listening ? "listen" : opened || L.standUntil > performance.now() ? "stand" : "play";
  // The roam lets go first (pausing gives up a walk of its own), so the walks asked below are his.
  if (L.roam) L.roam.pause(reduced || act !== "play" || out);
  if (!reduced && bot.placed && bot.moment !== act) bot.setAct(act);
  // Out at a side while outWhen holds; back in when it stops (gone already at the first draw: put there at once).
  // No side named: the nearer edge, as the prototype walks him off (across a wide window the far one is a long stroll), and back
  // in from the edge he left by.
  if (out && L.out !== true) {
    L.outAt = side || (bot.placed && bot.x[2] < (W() || 300) * 0.5 ? "left" : "right");
    bot.exit(L.outAt, { now: L.out === null || reduced });
  } else if (!out && L.out === true) bot.enter(L.outAt, (W() || 300) * 0.5);
  L.out = out;
  // A hop each time cheerWhen turns true (news on the first draw counts).
  const cheer = !!p.cheerWhen && visible(p.cheerWhen);
  if (cheer && !L.cheer && !reduced && !out) { if (bot.mo) bot.stopMoment(); bot.cheer(); }
  L.cheer = cheer;
  // Low: while his thought is open he walks to the middle as his stage goes down to the window's foot. Not while outWhen holds him
  // off the stage: the walk would bring him back in, and he would stay.
  const low = !!th && th.place === "low" && opened;
  if (low && was !== mode && !reduced && bot.placed && !out) bot.walkTo((W() || 300) * 0.5, { free: true });

  // ---- the stage's height: with no veil, it grows by the open box (the page above gets shorter, nothing is covered)
  const grows = !!th && th.veil === false && (mode === "open" || mode === "listen");

  // ---- the layer: lifted out of the page (fixed, at the stage's own place) while a veiled thought is open, so a column that
  // scrolls never clips him or his box; with place "low", carried down to the window's foot.
  // Closing from low, it stays lifted while it rides back up, and goes back into the page once it is home.
  const fixed = !!th && th.veil === true && opened;
  const lowMs = K.num("desktop.stage.lowMs", 600);
  const glide = reduced ? "none" : "transform " + lowMs + "ms cubic-bezier(.3,1.15,.5,1)";
  let lifted = false;
  const place = (first) => {
    const r = host.getBoundingClientRect();
    const dy = fixed && low ? Math.max(0, window.innerHeight - K.num("desktop.stage.lowBottom", 24) - r.bottom) : 0;
    const keep = fixed || L.lowY > 0 || lifted;
    if (keep) Object.assign(layer.style, { position: "fixed", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
    if (first) {
      // Where it was in the last paint (lowered, when it was), so a repaint of an open thought never jumps.
      layer.style.transition = "none";
      layer.style.transform = L.lowY ? "translateY(" + L.lowY + "px)" : "";
      void layer.offsetWidth;
    }
    if (Math.abs(dy - L.lowY) > 0.5) {
      layer.style.transition = glide;
      layer.style.transform = dy ? "translateY(" + dy + "px)" : "";
      if (!dy && !fixed) {
        lifted = true;
        setTimeout(() => { lifted = false; if (host.isConnected && !L.lowY) Object.assign(layer.style, { position: "", left: "", top: "", width: "", height: "", transition: "" }); }, reduced ? 0 : lowMs);
      }
      L.lowY = dy;
    }
    if (!keep && !lifted) Object.assign(layer.style, { position: "", left: "", top: "", width: "", height: "" });
    return r;
  };
  const sr = place(true);

  // ---- the veil: the window blurred behind his open thought (fading in and out); a click on it closes it
  if (veil) {
    void veil.offsetWidth;
    veil.classList.toggle("on", opened);
    if (opened) veil.addEventListener("click", () => stClose(s));
  }

  // ---- the box: where it goes now, from where it was
  const geom = (h) => {
    const view = { left: sr.left, top: sr.top + L.lowY, width: window.innerWidth, height: window.innerHeight };
    const floor = h - ST_FLOOR;
    return { W: W(), H: h, crown: floor - size * ST_CROWN, headX: bot.placed ? bot.crown().x : W() / 2, view };
  };
  if (box) {
    const inner = box.querySelector(".tz-th-in");
    // The pill's width: its words' (measured once per life, while it is drawn at rest).
    if (mode === "rest" && !L.restW) {
      const rest = box.querySelector(".tz-th-rest");
      const w = rest ? rest.scrollWidth || rest.offsetWidth : 0;
      L.restW = w > 0 ? Math.ceil(w) + 2 : 0;
    }
    // What it holds, laid at the box's width now and then (fixed: nothing re-wraps while the box grows), and how tall it is.
    const measure = (w) => {
      if (!inner) return 0;
      inner.style.width = w + "px";
      box.removeAttribute("data-fill");
      return Math.ceil(inner.offsetHeight || inner.scrollHeight || 0) + 2;
    };
    const ease = "cubic-bezier(.3,1.06,.45,1)";
    const set = (r) => Object.assign(box.style, { left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px" });
    const layoutBox = (first) => {
      // Not laid out yet (no width): nothing to place; the resize that gives it one lays it out.
      if (W() <= 0) return;
      let h = host.clientHeight || H0;
      let target = stTarget(s, geom(h), measure);
      if (grows) {
        // The open box sits where the pill's bottom was, over his trail; the stage is as tall as that needs.
        const fromBottom = H0 - (target.y + target.h);
        const need = Math.max(H0, Math.ceil(fromBottom + target.h + K.num("desktop.stage.growTop", 8)));
        if (Math.abs(need - h) > 0.5) { host.style.transition = reduced ? "none" : "height " + K.num("desktop.stage.growMs", 360) + "ms " + ease; host.style.height = need + "px"; }
        h = need;
        target = stTarget(s, geom(h), measure);
      } else if (th && th.veil === false && host.style.height !== H0 + "px") {
        host.style.transition = reduced ? "none" : "height " + K.num("desktop.stage.growMs", 360) + "ms " + ease;
        host.style.height = H0 + "px";
        h = H0;
      }
      L.h = h;
      // Sized by the room it has (near full, low, square, a wide box at its most), what is in it scrolls.
      const fill = mode === "full" || (mode === "open" && (th.shape === "square" || th.place === "low")) || (inner && measure(target.w) > target.h + 2);
      if (fill) box.setAttribute("data-fill", "1"); else box.removeAttribute("data-fill");
      const ms = mode === "full" ? K.num("desktop.stage.fullMs", 420) : K.num("desktop.stage.growMs", 360);
      // Shrinking back from near full: the veil clears first, the box follows a moment later.
      const delay = first && was === "full" && mode !== "full" ? K.num("desktop.stage.closeDelayMs", 380) : 0;
      // Opening with no pill to grow from: from a small box over his head, fading in.
      const seedRect = () => {
        const g = geom(h), c = bot.placed ? bot.crown() : { x: g.W / 2, y: g.crown };
        return { x: c.x - 24, y: c.y - stTrailRoom() - 40, w: 48, h: 40 };
      };
      const seeded = first && !L.rect && mode !== "rest" && !reduced;
      const from = first ? L.rect || (seeded ? seedRect() : null) : null;
      if (seeded) { box.style.opacity = "0"; requestAnimationFrame(() => { box.style.transition += ", opacity " + K.num("desktop.stage.fadeMs", 220) + "ms ease-out"; box.style.opacity = "1"; }); }
      if (!reduced && (from || !first)) {
        if (from) { box.style.transition = "none"; set(from); void box.offsetWidth; }
        box.style.transition = ["left", "top", "width", "height"].map((k) => k + " " + ms + "ms " + ease + " " + delay + "ms").join(",");
        L.animUntil = performance.now() + ms + delay + 40;
      } else {
        box.style.transition = "none";
        L.animUntil = 0;
      }
      set(target);
      L.rect = target;
    };
    box.dataset.mode = mode;
    if (mode === "rest" && !box.querySelector(".tz-th-rest")) {
      // No pill: the closed thought fades where it is (if it was just open), then it is gone, its trail with it.
      box.setAttribute("data-gone", "1");
      if (box.style.display !== "none") {
        box.style.transition = reduced ? "none" : "opacity " + K.num("desktop.stage.fadeMs", 220) + "ms ease-out";
        requestAnimationFrame(() => { box.style.opacity = "0"; });
        setTimeout(() => { if (host.isConnected && L.mode === "rest") box.style.display = "none"; }, reduced ? 0 : K.num("desktop.stage.fadeMs", 220));
      }
      L.rect = null;
    } else layoutBox(true);
    // At rest again the pill glides back over him, softer, from where it lands.
    if (mode === "rest" && was && was !== "rest" && L.rect) { L.gliding = true; L.follow = { x: L.rect.x + L.rect.w / 2, v: 0, target: NaN }; }
    s.layoutBox = layoutBox;
    // What it holds changed size (the words he hears, line by line; a chip): it is laid out again from where it is.
    if (inner && typeof ResizeObserver === "function" && mode !== "rest" && mode !== "full") {
      let seen = inner.offsetHeight;
      const ro = new ResizeObserver(() => {
        if (!host.isConnected) { ro.disconnect(); return; }
        const now = inner.offsetHeight;
        if (Math.abs(now - seen) < 1 || box.hasAttribute("data-fill")) return;
        seen = now;
        layoutBox(false);
      });
      ro.observe(inner);
    }
    // The pill opens it; nothing else in the box is his.
    const restBtn = box.querySelector(".tz-th-rest");
    if (restBtn && th.openPath) restBtn.addEventListener("click", () => { setStatePath(th.openPath, true); repaint(); });
  }

  // ---- his hit area: his body (or the whole stage, hit "stage"); a click waits for a second one when there is a double
  const on = (n && n.on) || {};
  const waitMs = K.num("desktop.doubleClick.waitMs", 260);
  let pending = 0, lastDouble = 0;
  const bodyRect = () => {
    const c = bot.placed ? bot.crown() : { x: W() / 2, y: (host.clientHeight || H0) - size * ST_CROWN };
    const half = Math.max(22, size * 0.75), floor = (host.clientHeight || H0) - ST_FLOOR;
    return { x: c.x - half, y: c.y - 6, w: half * 2, h: Math.max(44, floor - c.y + 10) };
  };
  const onBody = (e) => {
    if (p.hit !== "stage") return true;
    const r = hit.getBoundingClientRect(), b = bodyRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    return x >= b.x - 8 && x <= b.x + b.w + 8 && y >= b.y - 8 && y <= b.y + b.h + 8;
  };
  const press = () => { if (on.onPress) void run(on.onPress); };
  const double = () => {
    clearTimeout(pending); pending = 0;
    lastDouble = performance.now();
    if (!reduced && bot.placed) { if (bot.mo) bot.stopMoment(); bot.cheer(); }
    void run(on.onDoubleTap);
  };
  hit.addEventListener("click", (e) => {
    const d = Number(e.detail) || 1;
    if (d >= 2) { if (on.onDoubleTap && onBody(e) && performance.now() - lastDouble > 300) double(); return; }
    if (!on.onDoubleTap) { press(); return; }
    clearTimeout(pending);
    pending = setTimeout(() => { pending = 0; press(); }, waitMs);
  });
  hit.addEventListener("dblclick", (e) => { if (on.onDoubleTap && onBody(e) && performance.now() - lastDouble > 300) double(); });
  hit.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); press(); } });
  const placeHit = () => {
    if (p.hit === "stage") return;
    const b = bodyRect();
    Object.assign(hit.style, { left: b.x + "px", top: b.y + "px", width: b.w + "px", height: b.h + "px" });
  };

  // ---- each frame: him, his roam, the pill following him, the trail, the hit area
  let t = 0, lastH = host.clientHeight || H0;
  const trail = () => {
    if (!box || !bubbles.length) return;
    const hidden = box.style.display === "none" || box.hasAttribute("data-gone") || bot.out() || !bot.placed;
    const lr = layer.getBoundingClientRect(), br = box.getBoundingClientRect();
    const rect = br.width > 0 ? { x: br.left - lr.left, y: br.top - lr.top, w: br.width, h: br.height } : L.rect;
    if (!rect || hidden) { bubbles.forEach((b) => { b.style.opacity = "0"; }); return; }
    const level = listening ? (typeof voiceLevel === "function" ? voiceLevel() : 0) : -1;
    const bs = api.thoughtTrail(bot.crown(), rect, t, level, 1);
    bs.forEach((b, i) => {
      const el = bubbles[i];
      if (!el) return;
      const d = b.r * 2;
      el.style.width = el.style.height = d.toFixed(2) + "px";
      el.style.borderWidth = b.stroke.toFixed(2) + "px";
      el.style.transform = "translate(" + (b.x - b.r).toFixed(2) + "px," + (b.y - b.r).toFixed(2) + "px)";
      el.style.opacity = String(b.alpha);
    });
  };
  const follow = (dt) => {
    if (!box || mode !== "rest" || !L.rect || performance.now() < L.animUntil) return;
    const w = L.rect.w, gut = K.num("desktop.stage.gutter", 16), Wn = W();
    const head = bot.crown().x;
    L.follow = api.followStep(L.follow, head, dt, { lo: gut + w / 2, hi: Wn - gut - w / 2 }, L.gliding);
    if (L.gliding && Math.abs(L.follow.x - head) < 8 && Math.abs(L.follow.v) < 20) L.gliding = false;
    const x = L.follow.x - w / 2;
    box.style.left = x.toFixed(2) + "px";
    L.rect = Object.assign({}, L.rect, { x });
  };
  const step = (dt) => {
    t += dt;
    const h = host.clientHeight || H0;
    if (Math.abs(h - lastH) > 0.5) { lastH = h; fit(h); }
    if (L.standUntil && performance.now() >= L.standUntil && !opened && !listening && !thinking) {
      L.standUntil = 0;
      bot.setAct("play");
      if (L.roam) L.roam.pause(out);
    }
    bot.step(dt);
    if (L.roam) L.roam.step(dt);
    if (listening && L.rect) {
      bot.lookAt(L.rect.x + L.rect.w / 2, L.rect.y + L.rect.h);
      bot.setLevel(typeof voiceLevel === "function" ? voiceLevel() : 0);
    } else bot.setLevel(0);
    follow(dt);
    placeHit();
    trail();
    if (fixed || lifted) place(false);
  };
  const paint = () => { const w = W(), h = host.clientHeight || H0; if (w > 0) btPaint(cv, bot, w, h); };
  bot.settle(reduced);
  placeHit();
  paint();
  trail();
  if (typeof ResizeObserver === "function") {
    const ro = new ResizeObserver(() => {
      if (!host.isConnected) { ro.disconnect(); return; }
      fit(host.clientHeight || H0);
      if (L.roam) L.roam.w = W();
      // A new width (the window resized): the box is placed again for it; a height of the stage's own growing is not new.
      const w = W();
      if (s.layoutBox && Math.abs(w - (s.w || 0)) > 0.5) { s.w = w; s.layoutBox(false); }
      if (reduced) { bot.settle(true); paint(); trail(); placeHit(); }
    });
    ro.observe(host);
  }
  if (!reduced) btLoop(host, step, paint);
}

// ---- BotCrowd ------------------------------------------------------------------------------------------------------------

/** Each bot's patch: two staggered rows in the lower part of the box, lots of room between them (the prototype's crew). */
function crPatches(n, W, H) {
  const inset = K.num("desktop.stage.crowdInset", 18);
  const bottom = Math.ceil(n / 2), top = n - bottom;
  const pitch = Math.max(1, (W - 2 * inset) / Math.max(1, bottom));
  const cw = pitch * 0.92;
  const out = [];
  for (let i = 0; i < n; i++) {
    const row = i < top ? 0 : 1, c = row === 0 ? i + 0.5 : i - top;
    out.push({ x: inset + c * pitch + (pitch - cw) / 2, w: cw, floor: H * (row === 0 ? K.num("desktop.stage.crowdRow1", 0.7) : K.num("desktop.stage.crowdRow2", 0.94)) });
  }
  return out;
}

function mountCrowd(host, cfg, reduced) {
  const api = window.TailzuBotTiles;
  if (!cfg || !api) return;
  const p = cfg.p;
  const life = String(p.life || "crowd");
  let L = CR_LIVES.get(life);
  const specs = (Array.isArray(p.bots) ? p.bots : []).slice(0, 12);
  const key = specs.map((b) => b.kind + b.color).join("|") + "|" + (Number(p.size) || 22);
  if (!L || L.key !== key) {
    const tiles = specs.map((b, i) => {
      const t = new api.BotTile({ kind: b.kind || "custom", color: String(b.color || "#0a0a0a"), mood: "idle", seed: 31 + i * 97, size: Number(p.size) || 22, toys: false });
      t.cloth = 0;
      btDress(t, b.kind || "custom", b.avatar);
      return t;
    });
    const world = api.gridWorld(tiles);
    const looks = btLooks();
    const sp = p.surprises && typeof p.surprises === "object" ? p.surprises : null;
    if (sp && looks && Array.isArray(sp.moments)) world.surprise(sp.moments.map((m) => looks.moment(String(m))).filter(Boolean), Number(sp.every) || 3, Number(sp.chance) || 0, 11);
    L = { life, key, world, tiles, h: 0, cheer: false, cheerTimers: [], patches: [] };
    CR_LIVES.set(life, L);
  }
  host.__life = L;
  const cv = host.querySelector(".tz-cr-c");
  const grown = !!p.grownWhen && visible(p.grownWhen);
  const W = () => host.clientWidth || 0;
  const want = grown && Number(p.grownHeight) > 0 ? Number(p.grownHeight) : Number(p.height) > 0 ? Number(p.height) : W();
  // The height it has, then the height it wants (600 ms), the bots riding the floor as it moves.
  const now = host.clientHeight || L.h || want;
  if (Math.abs(now - want) > 0.5) {
    host.style.transition = "none";
    host.style.height = now + "px";
    void host.offsetWidth;
    host.style.transition = reduced ? "none" : "height " + K.num("desktop.stage.crowdGrowMs", 600) + "ms cubic-bezier(.3,1.06,.45,1)";
  }
  host.style.height = want + "px";
  host.style.aspectRatio = "";
  L.h = want;
  let lastW = 0, lastH = 0;
  const layout = () => {
    const w = W(), h = host.clientHeight || want;
    if (w <= 0 || (Math.abs(w - lastW) < 0.5 && Math.abs(h - lastH) < 0.5)) return;
    lastW = w; lastH = h;
    L.patches = crPatches(L.tiles.length, w, h);
    L.patches.forEach((pt, i) => L.world.place(i, pt.x, 0, pt.w, h, pt.floor));
  };
  layout();
  // Every bot cheers, again and again, while cheerWhen holds (a few seconds at most).
  const cheer = !!p.cheerWhen && visible(p.cheerWhen);
  if (cheer && !L.cheer && !reduced) {
    const every = K.num("desktop.stage.crowdCheerEveryMs", 1600), most = K.num("desktop.stage.crowdCheerMs", 6000);
    for (let at = 0; at < most; at += every) {
      L.tiles.forEach((tile, i) => L.cheerTimers.push(setTimeout(() => { if (!L.cheer) return; if (tile.mo) tile.stopMoment(); tile.cheer(); }, at + i * 70)));
    }
  }
  if (!cheer) { L.cheerTimers.forEach(clearTimeout); L.cheerTimers = []; }
  L.cheer = cheer;
  const dpr = () => Math.min(3, window.devicePixelRatio || 1);
  const paint = () => {
    const w = W(), h = host.clientHeight || want;
    if (w <= 0 || !cv) return;
    const k = dpr(), Wp = Math.max(1, Math.round(w * k)), Hp = Math.max(1, Math.round(h * k));
    if (cv.width !== Wp || cv.height !== Hp) { cv.width = Wp; cv.height = Hp; cv.style.width = w + "px"; cv.style.height = h + "px"; }
    const g = cv.getContext && cv.getContext("2d");
    if (!g) return;
    g.setTransform(k, 0, 0, k, 0, 0);
    g.clearRect(0, 0, w, h);
    L.tiles.forEach((tile, i) => {
      const pt = L.patches[i];
      if (!pt) return;
      g.setTransform(k, 0, 0, k, pt.x * k, 0);
      tile.draw(g);
    });
  };
  L.world.settle(reduced);
  paint();
  if (typeof ResizeObserver === "function") {
    const ro = new ResizeObserver(() => { if (!host.isConnected) { ro.disconnect(); return; } layout(); if (reduced) { L.world.settle(true); paint(); } });
    ro.observe(host);
  }
  if (!reduced) btLoop(host, (dt) => { layout(); L.world.step(dt); }, paint);
}

// ---- Vanish --------------------------------------------------------------------------------------------------------------

function mountVanish(host, cfg, reduced) {
  if (!cfg) return;
  const inner = host.querySelector(".tz-vn-in");
  const { gone, was } = cfg;
  if (was === null || was === gone || !inner) { host.classList.toggle("gone", gone); return; }
  if (reduced) { host.classList.toggle("gone", gone); return; }
  const fadeMs = K.num("desktop.stage.vanishMs", 520), foldMs = K.num("desktop.stage.vanishFoldMs", 240);
  const h = inner.offsetHeight || inner.scrollHeight || 0;
  if (gone) {
    // Blur, rise and fade, ink specks drifting up; then the room it took folds away.
    host.classList.remove("gone");
    host.style.height = h + "px";
    inner.style.transition = "filter " + fadeMs + "ms ease-out, transform " + fadeMs + "ms ease-out, opacity " + fadeMs + "ms ease-out";
    vnSpecks(host, inner, fadeMs);
    requestAnimationFrame(() => {
      inner.style.filter = "blur(6px)"; inner.style.transform = "translateY(-8px)"; inner.style.opacity = "0";
      setTimeout(() => {
        if (!host.isConnected) return;
        host.style.transition = "height " + foldMs + "ms ease-in";
        host.style.height = "0px";
        setTimeout(() => { if (host.isConnected) { host.classList.add("gone"); host.style.height = ""; host.style.transition = ""; } }, foldMs);
      }, fadeMs);
    });
    return;
  }
  // Back: the room opens, then it reforms out of the blur.
  host.classList.remove("gone");
  host.style.height = "0px";
  inner.style.transition = "none";
  inner.style.filter = "blur(6px)"; inner.style.transform = "translateY(-8px)"; inner.style.opacity = "0";
  requestAnimationFrame(() => {
    host.style.transition = "height " + foldMs + "ms ease-out";
    host.style.height = h + "px";
    setTimeout(() => {
      if (!host.isConnected) return;
      host.style.height = ""; host.style.transition = "";
      inner.style.transition = "filter " + fadeMs + "ms ease-out, transform " + fadeMs + "ms ease-out, opacity " + fadeMs + "ms ease-out";
      inner.style.filter = ""; inner.style.transform = ""; inner.style.opacity = "";
    }, foldMs);
  });
}

/** Twelve ink specks (2-3 px) from where the words were, drifting up and fading. */
function vnSpecks(host, inner, ms) {
  const w = inner.offsetWidth || 200, h = inner.offsetHeight || 40;
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < K.num("desktop.stage.vanishSpecks", 12); i++) {
    const d = document.createElement("i");
    d.className = "tz-vn-speck";
    const size = 2 + rand();
    Object.assign(d.style, { left: (rand() * w).toFixed(1) + "px", top: (h * (0.2 + rand() * 0.6)).toFixed(1) + "px", width: size + "px", height: size + "px" });
    host.appendChild(d);
    requestAnimationFrame(() => {
      d.style.transition = "transform " + ms + "ms ease-out, opacity " + ms + "ms ease-out";
      d.style.transform = "translate(" + ((rand() - 0.5) * 24).toFixed(1) + "px," + (-12 - rand() * 22).toFixed(1) + "px)";
      d.style.opacity = "0";
    });
    setTimeout(() => d.remove(), ms + 60);
  }
}
