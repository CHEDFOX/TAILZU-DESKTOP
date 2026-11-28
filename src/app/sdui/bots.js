// The living bot tiles (BotTiles, BotCard, BotBuddy): botTiles.js draws them,
// this places them, keeps their lives and dresses them in the server's looks.
//
// A node is drawn as HTML here (the words, the frame, an empty <canvas>) and registered in BT_PENDING; after the
// HTML lands, mountBotTiles() gives each canvas its bot and runs one animation frame loop per grid or card. A repaint
// replaces the DOM, so the bots themselves are kept (BT_LIVES, by slug) and the new canvases pick them up where they
// were. A loop stops by itself once its canvas has left the page, and waits while the window is hidden or the grid is
// scrolled away. Reduce Motion: the bots rest in a pose, painted once; a tap runs its action at once.
// A tap's look never outlives its moment: a grid painted again (Home's return) starts released (gridWorld), the window
// shown again lets it go, and so does the grid leaving the page.

let BT_PENDING = [];
const BT_LIVES = new Map();
const BT_CARDS = new Map();   // a BotCard's life across repaints: phase, step, completed, entered
const BT_FONT = { regular: "Tailzu Geist", medium: "Tailzu Geist Medium", semibold: "Tailzu Geist SemiBold", bold: "Tailzu Geist Bold" };
/**
 * THE VEIL UNDER A TILE'S WORDS: the fabric behind the name and line blurred and washed pale, fading in from just above
 * the words (where the bot stands) so there is no edge, and the words never lose to the pattern. The first child of the
 * words' box, stretched to the tile's sides and down past its foot (the tile clips it). The phone draws the same
 * (app BotTiles.tsx Veil).
 */
function btVeil(pad) {
  const mask = "linear-gradient(to bottom,transparent 0,#000 14px)";
  return '<div aria-hidden="true" style="position:absolute;left:-' + pad + "px;right:-" + pad + "px;top:-10px;bottom:-400px;" +
    "background:rgba(255,255,255,.74);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);" +
    "mask-image:" + mask + ";-webkit-mask-image:" + mask + '"></div>';
}
/** The name: capitals, bold. */
const btName = (face, f) => face(f.bold) + ";position:relative;font-size:15px;line-height:20px;letter-spacing:.6px;text-transform:uppercase;color:#0a0a0a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";

// The bots' looks and moments (botTiles.js compileLooks; the server's catalog, shared/bots/looks.json): the window's
// starter (botLooks.js, generated from the server's file at release), the last one the server sent (localStorage), and
// the server's own when the bootstrap's flag "bots.looks" ({ v, url }) names another version, up or down. A catalog is
// taken only when it compiles clean; the bots wear it from the next paint.
// The key carries the format: this release plays format 2 (scenes), and must not go on reading the format-1 copy
// an older window left behind at the same version. The copy itself is { f, spec }.
const BT_LOOKS_KEY = "tz.botLooks.f2";
let BT_LOOKS = null;
let BT_LOOKS_F = 1;
let BT_LOOKS_FETCHING = 0;
/** What went wrong with a scene, for the bootstrap's report (anim/SPEC.md 3.9). */
const BT_SCENE_BAD = [];
const BT_SCENE_SLOW = [];

/** A catalog's own format, as the projection wrote it, never above what this window plays. */
function btFormatOf(spec, api) {
  const f = Number(spec && spec.format);
  return f >= 1 ? Math.min(api.LOOKS_FORMAT, Math.floor(f)) : 1;
}

function btLooks() {
  const api = window.TailzuBotTiles;
  if (BT_LOOKS || !api) return BT_LOOKS;
  BT_LOOKS = api.compileLooks(window.TailzuBotLooks || { v: 1 });
  // The starter's own format, not 1: this release ships a format-2 starter (botLooks.js), and calling it format 1
  // would let an OLDER format-2 copy left by a previous run win on `f` alone.
  BT_LOOKS_F = btFormatOf(window.TailzuBotLooks, api);
  try {
    const kept = localStorage.getItem(BT_LOOKS_KEY);
    if (kept) {
      const held = JSON.parse(kept);
      const spec = held && typeof held === "object" && "spec" in held ? held.spec : held;
      const f = held && typeof held === "object" && "f" in held ? Math.max(1, Number(held.f) || 1) : 1;
      const L = api.compileLooks(spec);
      // Newer content, or the same content cut less far down; never an older catalog for its format alone.
      if (!L.errors.length && (L.v > BT_LOOKS.v || (L.v === BT_LOOKS.v && f > BT_LOOKS_F))) { BT_LOOKS = L; BT_LOOKS_F = f; }
    }
  } catch { /* nothing kept: the starter */ }
  return BT_LOOKS;
}

function btLooksSync(flag) {
  const api = window.TailzuBotTiles, L = btLooks();
  if (!api || !L || !flag || typeof flag !== "object" || !ENV) return;
  const v = Number(flag.v), url = String(flag.url || "");
  const f = Number(flag.f) >= 1 ? Math.min(api.LOOKS_FORMAT, Math.floor(Number(flag.f))) : 1;
  const key = v * 16 + f;
  if (!(v >= 1) || !url.startsWith("/v1/") || (v === L.v && f === BT_LOOKS_F) || key === BT_LOOKS_FETCHING) return;
  BT_LOOKS_FETCHING = key;
  fetch(String(ENV.baseUrl).replace(/\/$/, "") + url, { headers: { accept: "application/json" } })
    .then((r) => (r.ok ? r.json() : null))
    .then((spec) => {
      if (!spec || Number(spec.v) !== v) return;
      const next = api.compileLooks(spec);
      if (next.errors.length) return;
      BT_LOOKS = next;
      BT_LOOKS_F = f;
      try { localStorage.setItem(BT_LOOKS_KEY, JSON.stringify({ f, spec })); } catch { /* kept for this run only */ }
    })
    .catch(() => {})
    .finally(() => { BT_LOOKS_FETCHING = 0; });
}

/** A tile noticed a scene misbehaving: kept for the bootstrap's report, at most four of each. */
function btNoteScenes(bot) {
  if (!bot || !bot.sceneBad) return;
  for (const b of bot.sceneBad) if (BT_SCENE_BAD.length < 4 && !BT_SCENE_BAD.includes(b)) BT_SCENE_BAD.push(b);
  for (const s of bot.sceneSlow) if (BT_SCENE_SLOW.length < 4 && !BT_SCENE_SLOW.includes(s)) BT_SCENE_SLOW.push(s);
}

/** The window's own looks report (backend.js's capabilities() puts it on every bootstrap). */
function btLooksReport() {
  const L = btLooks();
  const out = { v: L ? L.v : 0, f: BT_LOOKS_F, ok: !!L && !L.errors.length };
  if (L && L.errors.length) out.why = String(L.errors[0]).slice(0, 120);
  if (BT_SCENE_BAD.length) out.bad = BT_SCENE_BAD.slice(0, 4);
  if (BT_SCENE_SLOW.length) out.slow = BT_SCENE_SLOW.slice(0, 4);
  return out;
}

/** A bot's look: the node's (an id or a spec), else his kind's. */
function btDress(bot, kind, avatar) {
  const L = btLooks();
  if (L) bot.setAvatar(L.avatar(kind, avatar));
}

/** A bot's moment from the catalog: started once per (id, mode), so a repaint does not start it again; none stops it. */
function btMoment(bot, id, mode) {
  const L = btLooks();
  const m = id && L ? L.moment(String(id)) : null;
  const key = m ? m.id + "|" + (mode || "") : "";
  if (bot.__mkey === key) return;
  bot.__mkey = key;
  if (m) bot.playMoment(m, mode === "loop" || mode === "once" ? mode : undefined);
  else if (bot.mo) bot.stopMoment();
}

function btLife(spec, i) {
  const api = window.TailzuBotTiles;
  const kind = spec.kind || api.kindOf(String(spec.slug || ""));
  const key = String(spec.slug) + "|" + kind + "|" + spec.color;
  let b = BT_LIVES.get(key);
  if (!b) {
    let seed = 7 + i * 131;
    for (const ch of String(spec.slug || "")) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    b = new api.BotTile({ kind, color: String(spec.color || "#0a0a0a"), mood: spec.state || "idle", seed });
    if (BT_LIVES.size > 24) BT_LIVES.clear();
    BT_LIVES.set(key, b);
  }
  b.setMood(spec.state || "idle");
  btDress(b, kind, spec.avatar);
  return b;
}

function botTilesNode(p) {
  const tiles = Array.isArray(p.tiles) ? p.tiles : [];
  const cols = Math.max(1, Number(p.columns) || 4), H = Number(p.height) || 150, pad = Number(p.padding) || 18, gap = Number(p.gap) || 14;
  // BotTilesStage: the bot's room at the top of each tile; its words start under it (the floor is read from them).
  const stage = Number(p.stage) > 0 ? Number(p.stage) : 0, subLines = Math.max(1, Math.min(6, Number(p.subLines) || 2));
  const nameGap = Math.max(0, Math.min(24, Number(p.nameGap) || 7));
  const f = Object.assign({}, BT_FONT, p.faces || {});
  const id = BT_PENDING.push({ kind: "tiles", p }) - 1;
  const face = (name) => "font-family:'" + esc(name) + "';font-weight:normal";
  const body = tiles.map((t, i) => {
    const make = t.kind === "make";
    const mark = make ? "" : t.state === "working" ? t.color : t.state === "needs" ? "#0a0a0a" : "";
    // The line is semibold in every state; its colour says which.
    const sub = t.state === "working" ? face(f.semibold) + ";color:" + esc(t.color) + ";white-space:nowrap;overflow:hidden;text-overflow:ellipsis"
      : t.state === "needs" ? face(f.semibold) + ";color:#0a0a0a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"
        : face(f.semibold) + ";color:#5c5c5c;display:-webkit-box;-webkit-line-clamp:" + subLines + ";-webkit-box-orient:vertical;overflow:hidden";
    return '<div class="tz-bt-tile" data-i="' + i + '" role="button" tabindex="0" aria-label="' + esc(t.label || (t.name + ". " + t.sub)) + '" style="' +
      "position:relative;height:" + H + "px;box-sizing:border-box;border-radius:20px;overflow:hidden;background:#fff;cursor:pointer;" +
      "transition:transform .18s cubic-bezier(.3,1.5,.5,1);" +
      (make ? "border:1.5px dashed #c9c9c9" : "border:1px solid #e6e6e6") + '">' +
      '<canvas class="tz-bt-c" aria-hidden="true" style="position:absolute;left:0;top:0;pointer-events:none"></canvas>' +
      (mark ? '<span style="position:absolute;top:' + pad + "px;right:" + pad + "px;width:10px;height:10px;border-radius:5px;background:" + esc(mark) + '"></span>' : "") +
      '<div class="tz-bt-w" style="position:absolute;left:' + pad + "px;right:" + pad + "px;" + (stage ? "top:" + stage : "bottom:" + pad) + 'px;display:flex;flex-direction:column;gap:' + nameGap + 'px;transition:opacity .2s;pointer-events:none">' + btVeil(pad) +
      '<div style="' + btName(face, f) + '">' + esc(t.name) + "</div>" +
      '<div style="' + sub + ';position:relative;font-size:12px;line-height:16px">' + esc(t.sub) + "</div></div></div>";
  }).join("");
  return '<div data-bt="' + id + '" style="position:relative;display:grid;grid-template-columns:repeat(' + cols + ",minmax(0,1fr));gap:" + gap + 'px">' + body + btStrip(p, tiles.length, pad, f) + "</div>";
}

/**
 * The strip under the grid (BotTilesProps.strip: Notes): the whole row, its bot on a stage of its own at the left, its
 * name and line on the right. The same world as the tiles: the last of them, so a tap on it, or on a tile, is the same
 * moment (the others look, their words fade).
 */
function btStrip(p, i, pad, f) {
  const t = p.strip && typeof p.strip === "object" ? p.strip : null;
  if (!t) return "";
  const H = Number(p.stripHeight) || 112;
  const face = (name) => "font-family:'" + esc(name) + "';font-weight:normal";
  const mark = t.state === "working" ? t.color : t.state === "needs" ? "#0a0a0a" : "";
  const sub = t.state === "working" ? face(f.semibold) + ";color:" + esc(t.color) : face(f.semibold) + ";color:" + (t.state === "needs" ? "#0a0a0a" : "#5c5c5c");
  const nameGap = Math.max(0, Math.min(24, Number(p.nameGap) || 7));
  return '<div class="tz-bt-tile" data-i="' + i + '" data-strip="1" role="button" tabindex="0" aria-label="' + esc(t.label || (t.name + ". " + t.sub)) + '" style="' +
    "position:relative;grid-column:1/-1;height:" + H + "px;box-sizing:border-box;border-radius:20px;overflow:hidden;background:#fff;cursor:pointer;" +
    'transition:transform .18s cubic-bezier(.3,1.5,.5,1);border:1px solid #e6e6e6">' +
    '<canvas class="tz-bt-c" aria-hidden="true" style="position:absolute;left:0;top:0;pointer-events:none"></canvas>' +
    (mark ? '<span style="position:absolute;top:' + pad + "px;right:" + pad + "px;width:10px;height:10px;border-radius:5px;background:" + esc(mark) + '"></span>' : "") +
    '<div class="tz-bt-w" style="position:absolute;left:clamp(140px,34%,220px);right:' + (pad + (mark ? 16 : 0)) + 'px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;gap:' + nameGap + 'px;transition:opacity .2s;pointer-events:none">' +
    '<div style="' + btName(face, f) + '">' + esc(t.name) + "</div>" +
    '<div style="' + sub + ';font-size:13px;line-height:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(t.sub) + "</div></div></div>";
}

/** A BotBuddy's bot, by its life (the same life on the next screen is the same bot, where he was). */
function btBuddy(p) {
  const api = window.TailzuBotTiles;
  const life = String(p.life || p.kind || "buddy");
  const kind = p.kind || api.kindOf(life);
  const color = String(p.color || "#0a0a0a");
  const key = "buddy|" + life + "|" + kind + "|" + color;
  let b = BT_LIVES.get(key);
  if (!b) {
    let seed = 17;
    for (const ch of life) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const H = Number(p.height) || 48;
    b = new api.BotTile({ kind, color, mood: "idle", seed, size: Number(p.size) || Math.round(H * 0.6) });
    b.cloth = 0; // no fabric under him on a page: he stands among the words
    if (BT_LIVES.size > 24) BT_LIVES.clear();
    BT_LIVES.set(key, b);
  }
  btDress(b, kind, p.avatar);
  return b;
}

/**
 * BotBuddy: a bot's own tiny bot on a stage of his own (a page's header, a setup step's top), never over words or
 * controls. His moment: thinking while `thinkWhen` holds, else the page's `act`. Static (an empty stage) without the core.
 *
 * Carrying (act "carry"): the stage is a lane under a message on its way, and he hauls it as a bag, heavier each trip.
 * While `doneWhen` holds the answer is here: he sets the bag down and walks off, and the lane folds away once he has gone
 * (drawn folded when he already has). Reduce Motion: still with the bag, and `label` written beside him.
 */
function botBuddyNode(p) {
  // A moment this build cannot play (an unknown id, a newer recipe) is the recipe's plain act.
  const L = p.moment ? btLooks() : null;
  const plain = L && !L.moment(String(p.moment)) && L.moments.has(String(p.moment)) ? L.fallback(String(p.moment)) : "";
  const act = p.thinkWhen && visible(p.thinkWhen) ? "think" : plain || p.act || "play";
  const done = act === "carry" && !!p.doneWhen && visible(p.doneWhen);
  const momentEnd = !!p.moment && !!p.momentEndWhen && visible(p.momentEndWhen);
  const id = BT_PENDING.push({ kind: "buddy", p, act, done, momentEnd }) - 1;
  const H = Number(p.height) || 48, W = Number(p.width) || 0;
  // Gone already (a repaint after he left, or an answer that came before he was in): folded.
  const api = window.TailzuBotTiles;
  const kept = act === "carry" && api ? BT_LIVES.get("buddy|" + String(p.life || p.kind || "buddy") + "|" + (p.kind || api.kindOf(String(p.life || ""))) + "|" + String(p.color || "#0a0a0a")) : null;
  const folded = done && (!kept || kept.moment !== "carry" || kept.carryDone() || prefers("(prefers-reduced-motion: reduce)"));
  const still = act === "carry" && p.label && prefers("(prefers-reduced-motion: reduce)")
    ? '<span style="position:absolute;left:calc(30% + ' + Math.round((Number(p.size) || H * 0.6) * 0.75) + 'px);right:0;top:0;bottom:0;display:flex;align-items:center;font-size:13px;color:#5c5c5c;white-space:nowrap;overflow:hidden">' + esc(label(p.label)) + "</span>"
    : "";
  return '<div data-bb="' + id + '"' + (p.label ? ' role="img" aria-label="' + esc(label(p.label)) + '"' : ' aria-hidden="true"') + ' style="position:relative;pointer-events:none;' +
    (W ? "width:" + W + "px;flex-shrink:0;" : "align-self:stretch;") + "height:" + (folded ? 0 : H) + "px" + (act === "carry" ? ";overflow:hidden;transition:height .28s ease" : "") + '">' +
    '<canvas class="tz-bt-c" aria-hidden="true" style="position:absolute;left:0;top:0;pointer-events:none"></canvas>' + still + "</div>";
}

/** BotCard: the frame, its stage and the step on show (the children that are visible). The life is in BT_CARDS. */
function botCardNode(n, p, kids) {
  const api = window.TailzuBotTiles;
  const once = typeof p.once === "string" ? p.once : "";
  const key = once || "card:" + (p.label || "") + ":" + p.color;
  let life = BT_CARDS.get(key);
  if (!life) { life = { phase: "wait", step: -1, completed: false, entered: false, doneSeen: false }; BT_CARDS.set(key, life); }
  let remembered = false;
  try { remembered = !!once && localStorage.getItem("tz.botcard.once." + once) === "1"; } catch { /* a closed card may come back once */ }
  const close = (p.closeWhen ? visible(p.closeWhen) : false) || remembered;
  const ready = p.readyWhen ? visible(p.readyWhen) : true;
  const done = p.doneWhen ? visible(p.doneWhen) : false;
  const complete = () => {
    if (life.completed) return;
    life.completed = true;
    const ref = n.on && n.on.onComplete;
    if (ref) setTimeout(() => { void run(ref); }, 0);
  };
  if (life.phase === "gone") return "";
  if (life.phase === "wait") {
    if (close) { life.phase = "gone"; return ""; }
    if (!ready) return "";
    if (done) { complete(); life.phase = "gone"; return ""; }
    life.phase = "open";
  }
  if (life.phase === "open" && close) {
    life.phase = "closing";
    if (once) { try { localStorage.setItem("tz.botcard.once." + once, "1"); } catch { /* best effort */ } }
  }
  const step = (n.children || []).findIndex((c) => !c.visibleIf || visible(c.visibleIf));
  const fresh = life.step !== -1 && step !== life.step;
  life.step = step;
  const id = BT_PENDING.push({ kind: "card", p, n, key, life, done, fresh, complete }) - 1;
  const overlay = !!p.overlay;
  const stageH = Number(p.stageHeight) || 128;
  const width = overlay ? Math.min(Number(p.width) || 340, 560) : 0;
  const entered = life.entered;
  const card = '<div class="tz-bc" data-bc="' + id + '"' + (p.label ? ' aria-label="' + esc(label(p.label)) + '"' : "") + ' style="' +
    (overlay ? "width:" + width + "px;max-width:calc(100vw - 40px);box-shadow:0 18px 50px rgba(0,0,0,.12);" : "align-self:stretch;") +
    "position:relative;box-sizing:border-box;border:1px solid #e6e6e6;border-radius:28px;background:#fff;overflow:hidden;" +
    "transition:transform .42s cubic-bezier(.3,1.35,.5,1),opacity .26s ease-out;" +
    (entered ? "" : "opacity:0;transform:scale(.94) translateY(10px)") + '">' +
    '<div style="position:relative;height:' + stageH + 'px"><canvas class="tz-bt-c" aria-hidden="true" style="position:absolute;left:0;top:0;pointer-events:none"></canvas>' +
"</div>" +
    '<div class="tz-bc-w" style="transition:opacity .26s ease-out,transform .26s ease-out;' + (fresh ? "opacity:0;transform:translateY(6px)" : "") + '">' + kids + "</div></div>";
  if (!api) return overlay ? "" : card;
  if (!overlay) return card;
  return '<div class="tz-bc-veil" data-bcv="' + id + '" style="position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:20px;' +
    "background:rgba(255,255,255,.42);-webkit-backdrop-filter:blur(10px) saturate(1.05);backdrop-filter:blur(10px) saturate(1.05);transition:opacity .28s ease-out;" +
    (entered ? "" : "opacity:0") + '">' + card + "</div>";
}

/** A canvas sized for the display, and the bot drawn into it. */
function btPaint(cv, tile, w, h) {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const W = Math.max(1, Math.round(w * dpr)), Hh = Math.max(1, Math.round(h * dpr));
  if (cv.width !== W || cv.height !== Hh) { cv.width = W; cv.height = Hh; cv.style.width = w + "px"; cv.style.height = h + "px"; }
  const g = cv.getContext("2d");
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  tile.draw(g);
}

/** One loop for a set of tiles: steps and paints while `host` is on the page, in view, and the window is shown. */
function btLoop(host, step, paint, gone) {
  let raf = 0, last = 0, seen = true;
  const io = typeof IntersectionObserver === "function" ? new IntersectionObserver((es) => {
    seen = es.some((e) => e.isIntersecting);
    if (seen) wake();
  }) : null;
  if (io) io.observe(host);
  let faults = 0;
  const tick = () => {
    raf = 0;
    if (!host.isConnected) { if (io) io.disconnect(); document.removeEventListener("visibilitychange", wake); if (gone) gone(); return; }
    if (document.hidden || !seen) return;
    const now = performance.now(), dt = last ? (now - last) / 1000 : 1 / 60;
    last = now;
    // One bad frame is not the end of the loop: a scene's own fault is caught inside the core, and three failing
    // frames in a row stop it, as the phone's loop does.
    try { step(dt); paint(); faults = 0; } catch (e) {
      console.warn("[Tailzu][BotTiles] frame failed:", e);
      if (++faults >= 3) return;
    }
    raf = requestAnimationFrame(tick);
  };
  function wake() { if (!raf && host.isConnected && !document.hidden && seen) { last = 0; raf = requestAnimationFrame(tick); } }
  document.addEventListener("visibilitychange", wake);
  wake();
}

function mountBotTiles(root) {
  const api = window.TailzuBotTiles;
  const reduced = prefers("(prefers-reduced-motion: reduce)");
  // An overlay from the last paint goes; a new one is lifted out to the body (nothing it sits in may clip or fade it).
  document.querySelectorAll("body > .tz-bc-veil").forEach((v) => v.remove());
  root.querySelectorAll("[data-bt]").forEach((grid) => {
    const cfg = BT_PENDING[Number(grid.getAttribute("data-bt"))];
    if (!cfg || !api) return;
    const strip = cfg.p.strip && typeof cfg.p.strip === "object" ? cfg.p.strip : null;
    const specs = (cfg.p.tiles || []).concat(strip ? [strip] : []);
    const els = Array.from(grid.querySelectorAll(".tz-bt-tile"));
    // Released as it is made: a look left from a tap before Home was left goes now.
    const world = api.gridWorld(specs.map(btLife));
    const sizes = [];
    const pad = Number(cfg.p.padding) || 18;
    const layout = () => {
      const g = grid.getBoundingClientRect();
      els.forEach((el, i) => {
        const r = el.getBoundingClientRect(), wr = el.querySelector(".tz-bt-w").getBoundingClientRect();
        const h = el.clientHeight;
        // The strip's bot plays on the stage left of its words, standing near its foot; a tile's above its words.
        const isStrip = strip && i === els.length - 1;
        const w = isStrip ? Math.max(80, Math.round(wr.left - r.left)) : el.clientWidth;
        sizes[i] = [w, h];
        world.place(i, r.left - g.left, r.top - g.top, w, h, isStrip ? h - pad * 0.7 : wr.top - r.top - 10); // the bot stands 10px above its name
      });
    };
    layout();
    // Each tile's moment (once placed; a repaint keeps it going), and Home's rare idle surprises.
    specs.forEach((s, i) => { if (world.tiles[i]) btMoment(world.tiles[i], s.moment, s.momentMode); });
    const sp = cfg.p.surprises && typeof cfg.p.surprises === "object" ? cfg.p.surprises : null;
    const L = btLooks();
    if (sp && L && Array.isArray(sp.moments)) world.surprise(sp.moments.map((m) => L.moment(String(m))).filter(Boolean), Number(sp.every) || 30, Number(sp.chance) || 0, 7);
    const paint = () => els.forEach((el, i) => { if (sizes[i]) btPaint(el.querySelector(".tz-bt-c"), world.tiles[i], sizes[i][0], sizes[i][1]); });
    world.settle(reduced);
    paint();
    if (typeof ResizeObserver === "function") { const ro = new ResizeObserver(() => { if (!grid.isConnected) { ro.disconnect(); return; } layout(); if (reduced) { world.settle(true); paint(); } }); ro.observe(grid); }
    let busy = false;
    const words = (o) => o.querySelector(".tz-bt-w");
    const letGo = () => { world.release(); busy = false; els.forEach((o) => { words(o).style.opacity = "1"; }); };
    // The window shown again (back from another app): whatever look was left goes, the words at full strength.
    const shown = () => {
      if (!grid.isConnected) { document.removeEventListener("visibilitychange", shown); world.release(); return; }
      if (!document.hidden && busy) letGo();
    };
    document.addEventListener("visibilitychange", shown);
    // A tile with a double (BotTileSpec.doubleTap: a voice chat with that bot) keeps its tap's timers, so a second click can take
    // the tap back (its action, its press, the others' fades) and run the double instead. Its single tap waits for that.
    const waitMs = K.num("desktop.doubleClick.waitMs", 260);
    els.forEach((el, i) => {
      const timers = [];
      let lastDouble = 0;
      const later = (f, ms) => { timers.push(setTimeout(f, ms)); };
      const go = (x, y) => {
        const action = specs[i] && specs[i].action;
        const dbl = specs[i] && specs[i].doubleTap;
        if (!action || busy) return;
        if (reduced) { if (dbl) later(() => { void run(action); }, waitMs); else void run(action); return; }
        busy = true;
        world.focus(i, sizes[i] ? Math.min(x, sizes[i][0]) : x, y);
        els.forEach((o, j) => { if (j !== i) o.querySelector(".tz-bt-w").style.opacity = String(api.TAP.fadeTo); });
        el.style.transform = "scale(" + api.TAP.pressScale + ")";
        later(() => { el.style.transform = ""; }, 140);
        later(() => { void run(action); }, Math.max(api.TAP.holdMs, dbl ? waitMs : 0));
        later(letGo, api.TAP.holdMs + api.TAP.restoreMs);
      };
      const double = () => {
        const dbl = specs[i] && specs[i].doubleTap;
        if (!dbl || Date.now() - lastDouble < 300) return;
        lastDouble = Date.now();
        timers.splice(0).forEach(clearTimeout);
        el.style.transform = "";
        letGo();
        void run(dbl);
      };
      el.addEventListener("click", (e) => {
        if ((Number(e.detail) || 1) >= 2 && specs[i] && specs[i].doubleTap) { double(); return; }
        const r = el.getBoundingClientRect(); go(e.clientX - r.left, e.clientY - r.top);
      });
      el.addEventListener("dblclick", () => double());
      el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(el.clientWidth / 2, el.clientHeight / 2); } });
    });
    if (!reduced) btLoop(grid, (dt) => {
      world.step(dt);
      for (const t of world.tiles) if (t.sceneBad && (t.sceneBad.length || t.sceneSlow.length)) btNoteScenes(t);
    }, paint, () => world.release());
  });
  mountHomeHead(root, reduced);
  // Spaces' stages, crowds, vanishes and @ fields (stage.js).
  if (typeof mountStages === "function") mountStages(root);
  // People as their own tiny bots (personBot.js), before an overlay card is lifted out to the body with any it holds.
  if (typeof mountPersonBots === "function") mountPersonBots(root);
  // BotBuddy: a bot's own tiny bot, kept by its life across screens and repaints.
  root.querySelectorAll("[data-bb]").forEach((stage) => {
    const cfg = BT_PENDING[Number(stage.getAttribute("data-bb"))];
    if (!cfg || !api) return;
    const { p, act, done, momentEnd } = cfg;
    const H = Number(p.height) || 48;
    const bot = btBuddy(p);
    bot.setLookTo(String(p.lookTo || ""));
    if (bot.mood !== (p.state || "idle")) bot.setMood(p.state || "idle");
    const carry = act === "carry";
    if (carry) {
      // A new ask after a delivery is a new haul; the answer here, he sets it down.
      if (bot.moment !== "carry" || (!done && bot.delivered)) bot.setAct("carry");
      if (done) bot.deliver();
    } else if (bot.moment !== act) {
      const was = bot.moment;
      bot.setAct(act);
      // A new step: a little hop (not for thinking, which comes and goes with each answer).
      if (!reduced && was !== "think" && act !== "think") bot.cheer();
    }
    const cv = stage.querySelector(".tz-bt-c");
    const width = () => stage.clientWidth || Number(p.width) || 0;
    const fit = () => { const w = width(); if (w > 0) bot.resize(w, H, H - 2); };
    fit();
    // His moment (not while he thinks or carries), and its end when momentEndWhen holds.
    if (bot.placed) btMoment(bot, act === "think" || carry ? "" : p.moment, p.momentMode);
    if (momentEnd) bot.deliverMoment();
    bot.settle(reduced);
    const paint = () => { const w = width(); if (w > 0) btPaint(cv, bot, w, H); };
    paint();
    // Carrying: once he has delivered and gone, the lane folds away.
    const fold = () => { if (carry && bot.carryDone() && stage.style.height !== "0px") stage.style.height = "0px"; };
    fold();
    if (typeof ResizeObserver === "function") { const ro = new ResizeObserver(() => { if (!stage.isConnected) { ro.disconnect(); return; } fit(); if (reduced) { bot.settle(true); paint(); } }); ro.observe(stage); }
    if (!reduced) btLoop(stage, (dt) => { bot.step(dt); fold(); }, paint);
  });
  root.querySelectorAll("[data-bc]").forEach((card) => {
    const cfg = BT_PENDING[Number(card.getAttribute("data-bc"))];
    if (!cfg || !api) return;
    const { p, key, life } = cfg;
    let bot = BT_LIVES.get("card|" + key);
    if (!bot) {
      // Sized to the stage: the card has room for a bigger bot than a tile.
      bot = new api.BotTile({ kind: p.kind || "custom", color: String(p.color || "#3d3d3d"), mood: "idle", seed: 29, size: Math.round((Number(p.stageHeight) || 128) * 0.4) });
      BT_LIVES.set("card|" + key, bot);
    }
    btDress(bot, p.kind || "custom", p.avatar);
    const veil = root.querySelector('[data-bcv="' + card.getAttribute("data-bc") + '"]');
    if (veil) document.body.appendChild(veil);
    const cv = card.querySelector(".tz-bt-c"), stageH = Number(p.stageHeight) || 128;
    const size = () => [card.clientWidth, stageH];
    const [w0] = size();
    bot.resize(w0, stageH, stageH - 12);
    if (life.phase === "open" && bot.placed) btMoment(bot, p.moment, p.momentMode);
    bot.settle(reduced);
    const paint = () => { const [w] = size(); if (w > 0) btPaint(cv, bot, w, stageH); };
    paint();
    // Coming in: a soft scale and fade, once (a repaint keeps it where it is).
    if (!life.entered) {
      life.entered = true;
      if (reduced) card.style.transition = "opacity .26s ease-out";
      requestAnimationFrame(() => { card.style.opacity = "1"; card.style.transform = "none"; if (veil) veil.style.opacity = "1"; });
    }
    // The way out, when the card carries one: Escape and a drag to the right over the card or the blur. The visible Back is a
    // step of the card, drawn by the server, so a card has one the day the server sends it.
    const leaveRef = cfg.n && cfg.n.on && cfg.n.on.onDismiss;
    if (leaveRef && !life.leaveWired) {
      life.leaveWired = true;
      let left = false;
      const leave = () => { if (left) return; left = true; void run(leaveRef); };
      const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); leave(); } };
      document.addEventListener("keydown", onKey);
      const host = veil || card;
      let from = null;
      host.addEventListener("pointerdown", (e) => { from = { x: e.clientX, y: e.clientY }; });
      host.addEventListener("pointerup", (e) => {
        if (from && e.clientX - from.x > 70 && Math.abs(e.clientY - from.y) < 60) leave();
        from = null;
      });
      const stop = new MutationObserver(() => { if (!card.isConnected) { document.removeEventListener("keydown", onKey); stop.disconnect(); } });
      stop.observe(document.body, { childList: true, subtree: true });
    }
    const words = card.querySelector(".tz-bc-w");
    if (cfg.fresh && words) { if (!reduced) bot.cheer(); requestAnimationFrame(() => { words.style.opacity = "1"; words.style.transform = "none"; }); }
    // Done: the happy moment, then on.onComplete.
    if (cfg.done && !life.doneSeen && life.phase === "open") {
      life.doneSeen = true;
      bot.cheer();
      setTimeout(cfg.complete, Number(p.doneDelayMs) || 1300);
    }
    // Going: the card and the blur fade out together, then they are gone.
    if (life.phase === "closing") {
      requestAnimationFrame(() => {
        card.style.opacity = "0";
        if (!reduced) card.style.transform = "scale(.96)";
        if (veil) veil.style.opacity = "0";
      });
      setTimeout(() => { life.phase = "gone"; if (veil) veil.remove(); else card.remove(); }, 320);
    }
    if (!reduced) btLoop(card, (dt) => bot.step(dt), paint);
  });
}
