// Home's header, alive: WriteOn, LiveMark, HeadBar (shared/types/sdui.ts, "Home's header")
//
// WriteOn: the bold line writes itself in word by word (botTiles.js writeOnTimes: dictation's uneven pace) with
// Keylessbord's clay caret blinking after the last word; it fades a few seconds on. Once per app open and line (`once`):
// a repaint or a return finds it written, or carries on from where it was. LiveMark: the dot mark, alive (botTiles.js
// LiveMark): ring dots on springs, eyes on the cursor and swinging with a scroll, a ring dot lit for each bot at work;
// a click squishes it and runs on.onPress. HeadBar: a compact bar over the top of the main column (the kit puts it
// just before the column that scrolls), shown once that column is scrolled past `at`. Reduce Motion: all still.

const WO_STARTED = new Map();
const LM_LIVES = new Map();
// How long the caret stays after the last word, before it fades.
const woCaretMs = () => K.num("desktop.writeOn.caretMs", 2600);
const seedOfText = (str) => { let h = 7; for (const ch of String(str)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; };

function writeOnNode(p) {
  const id = BT_PENDING.push({ kind: "writeOn", p }) - 1;
  const size = Number(p.size) || 40, lh = Number(p.lineHeight) || Math.round(size * 1.15);
  const words = String(p.content || "").split(/\s+/).filter(Boolean);
  return '<div data-wo="' + id + '" role="heading" aria-level="1" aria-label="' + esc(label(p.content || "")) + '" style="position:relative;' +
    "font-family:'" + esc(p.fontFamily || "Tailzu Geist Bold") + "';font-weight:normal;font-size:" + size + "px;line-height:" + lh + "px;letter-spacing:" + (Number(p.tracking) || 0) + "px;color:" + esc(p.color || "#0a0a0a") + ';text-wrap:balance">' +
    '<span aria-hidden="true">' + words.map((w) => '<span class="tz-wo-w" style="display:inline-block;transition:opacity .17s ease-out,transform .17s ease-out">' + esc(w) + "</span>").join(" ") + "</span>" +
    '<span class="tz-wo-c" aria-hidden="true" style="position:absolute;left:0;top:' + Math.round((lh - size * 0.9) / 2) + "px;width:" + Math.max(2, Math.round(size * 0.075)) + "px;height:" + Math.round(size * 0.9) +
    "px;border-radius:2px;background:" + esc(p.caretColor || "#A9573A") + ';opacity:0;transition:left .16s cubic-bezier(.3,1.3,.5,1),top .16s,opacity .09s"></span></div>';
}

function liveMarkNode(n, p) {
  const id = BT_PENDING.push({ kind: "liveMark", p, n }) - 1;
  const size = Number(p.size) || 56;
  return '<div data-lm="' + id + '" role="button" tabindex="0" aria-label="' + esc(label(p.label || "X0 Bot")) + '" style="position:relative;flex-shrink:0;cursor:pointer;width:' + size + "px;height:" + size + 'px">' +
    '<canvas class="tz-bt-c" aria-hidden="true" style="position:absolute;left:0;top:0;pointer-events:none"></canvas></div>';
}

function headBarNode(p, kids) {
  const id = BT_PENDING.push({ kind: "headBar", p }) - 1;
  return '<div data-hb="' + id + '" style="position:absolute;left:0;right:0;top:0;height:0;z-index:5">' +
    '<div class="tz-hb" style="background:#fff;border-bottom:1px solid #e6e6e6;opacity:0;transform:translateY(-12px);pointer-events:none;transition:opacity .22s ease-out,transform .26s cubic-bezier(.2,.9,.3,1)">' + kids + "</div></div>";
}

/** The nearest ancestor that scrolls (the main column), or null. */
function scrollParent(el) {
  for (let e = el.parentElement; e; e = e.parentElement) {
    const o = getComputedStyle(e).overflowY;
    if (o === "auto" || o === "scroll") return e;
  }
  return null;
}

function mountHomeHead(root, reduced) {
  const api = window.TailzuBotTiles;
  root.querySelectorAll("[data-wo]").forEach((el) => {
    const cfg = BT_PENDING[Number(el.getAttribute("data-wo"))];
    if (!cfg || !api) return;
    const p = cfg.p, once = String(p.once || p.content || "");
    const ws = Array.from(el.querySelectorAll(".tz-wo-w")), caret = el.querySelector(".tz-wo-c");
    const size = Number(p.size) || 40, lh = Number(p.lineHeight) || Math.round(size * 1.15), ch = Math.round(size * 0.9);
    const times = api.writeOnTimes(ws.map((w) => w.textContent), seedOfText(once));
    if (reduced || !ws.length) return;
    if (!WO_STARTED.has(once)) WO_STARTED.set(once, Date.now());
    const el0 = Date.now() - WO_STARTED.get(once), end = times[times.length - 1] + 200;
    const at = (i) => { const w = ws[i]; caret.style.left = (w.offsetLeft + w.offsetWidth + Math.round(size * 0.08)) + "px"; caret.style.top = (w.offsetTop + (lh - ch) / 2) + "px"; };
    let last = -1;
    ws.forEach((w, i) => {
      if (times[i] <= el0) { last = i; return; }
      w.style.opacity = "0"; w.style.transform = "translateY(4px)";
      setTimeout(() => { if (!el.isConnected) return; w.style.opacity = "1"; w.style.transform = "none"; at(i); }, times[i] - el0);
    });
    if (last >= 0) at(last);
    const caretMs = woCaretMs();
    if (el0 >= end + caretMs) return;
    // Keylessbord's caret: blinking while he writes and a moment after, then it fades.
    let on = true;
    caret.style.opacity = "1";
    const blink = setInterval(() => { if (!el.isConnected) { clearInterval(blink); return; } on = !on; caret.style.opacity = on ? "1" : "0"; }, 520);
    setTimeout(() => { clearInterval(blink); caret.style.transition = "opacity .42s"; caret.style.opacity = "0"; }, end + caretMs - el0);
  });
  root.querySelectorAll("[data-lm]").forEach((host) => {
    const cfg = BT_PENDING[Number(host.getAttribute("data-lm"))];
    if (!cfg || !api) return;
    const { p, n } = cfg, size = Number(p.size) || 56, life = String(p.life || "home");
    let mark = LM_LIVES.get(life);
    if (!mark) { mark = new api.LiveMark(seedOfText(life)); LM_LIVES.set(life, mark); }
    mark.size = size;
    mark.setLit(Array.isArray(p.lit) ? p.lit.map(String) : []);
    mark.settle(reduced);
    const cv = host.querySelector(".tz-bt-c");
    const paint = () => btPaint(cv, mark, size, size);
    paint();
    const go = () => {
      const ref = n.on && n.on.onPress;
      if (!ref) return;
      if (reduced) { void run(ref); return; }
      mark.press();
      setTimeout(() => { void run(ref); }, 170);
    };
    host.addEventListener("click", go);
    host.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    if (reduced) return;
    // The cursor, anywhere on the page; the scroll of the column it is in.
    const move = (e) => {
      if (!host.isConnected) { document.removeEventListener("mousemove", move); return; }
      const r = host.getBoundingClientRect(), u = 34 / size;
      mark.look((e.clientX - r.left) * u, (e.clientY - r.top) * u);
    };
    document.addEventListener("mousemove", move);
    const sp = scrollParent(host);
    if (sp) {
      let lastY = sp.scrollTop, lastT = performance.now();
      const sc = () => {
        if (!host.isConnected) { sp.removeEventListener("scroll", sc); return; }
        const t = performance.now();
        mark.nudge(((sp.scrollTop - lastY) / Math.max(8, t - lastT)) * 1000);
        lastY = sp.scrollTop; lastT = t;
      };
      sp.addEventListener("scroll", sc, { passive: true });
    }
    btLoop(host, (dt) => mark.step(dt), paint);
  });
  root.querySelectorAll("[data-hb]").forEach((hb) => {
    const cfg = BT_PENDING[Number(hb.getAttribute("data-hb"))];
    if (!cfg) return;
    const at = Number(cfg.p.at) || 150, bar = hb.querySelector(".tz-hb");
    const col = hb.nextElementSibling;
    if (!col || !bar) return;
    if (reduced) bar.style.transition = "none";
    let shown = null;
    const sc = () => {
      if (!hb.isConnected) { col.removeEventListener("scroll", sc); return; }
      const now = col.scrollTop > at;
      if (now === shown) return;
      shown = now;
      bar.style.opacity = now ? "1" : "0";
      bar.style.transform = now ? "none" : "translateY(-12px)";
      bar.style.pointerEvents = now ? "auto" : "none";
    };
    col.addEventListener("scroll", sc, { passive: true });
    sc();
  });
}
