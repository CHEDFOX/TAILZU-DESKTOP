// The shell as trees (SPEC 2.10, B11): `Sheet`, `Modal` and `Toast` drawn from the server's own nodes, over the
// window's view.
//
// What this window does NOT do, and says so in the package's questions: `navigate` with a `presentation` still
// pushes, which is the spec's own default for a value a client cannot honour. A Sheet or a Modal written INTO a
// screen is drawn here properly, dragged by its detents and dismissed by its backdrop.

const V2_DETENTS = { small: 0.25, medium: 0.5, large: 0.9 };
const V2_MAX_DETENTS = 4;
let V2_SHELL = new Map();
let V2_SHELL_SEQ = 0;
/** Overlays closed on this screen whose `open` is bound to nothing: nothing in the store can say they are shut. */
let V2_SHELL_SHUT = new Set();
/** When each toast on this screen goes, so a repaint under it does not start its clock again. */
let V2_TOAST_DUE = new Map();
/** The overlays on this paint that Escape may close, the topmost last. */
let V2_SHELL_ESC = [];

/** The heights a sheet may rest at, as fractions of the window, biggest last. */
function v2Detents(raw) {
  const list = (Array.isArray(raw) ? raw : ["medium"]).slice(0, V2_MAX_DETENTS).map((d) => {
    if (typeof d === "string" && V2_DETENTS[d] != null) return V2_DETENTS[d];
    const n = Number(d);
    return Number.isFinite(n) && n >= 0.1 && n <= 1 ? n : null;
  }).filter((n) => n !== null);
  return list.length ? list.sort((a, b) => a - b) : [V2_DETENTS.medium];
}

const v2Radius = (v, d) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(40, Number(v))) : d);

/** A sheet, a modal or a toast. Nothing is drawn while its `open` is false. */
function v2ShellNode(n, p, s, kids) {
  const id = "v2s" + V2_SHELL_SEQ++;
  const key = typeof n.id === "string" && n.id ? n.id : "#" + id;
  const open = p.open === undefined ? !V2_SHELL_SHUT.has(key) : truthy(p.open);
  if (!open) { V2_TOAST_DUE.delete(key); return ""; }
  V2_SHELL.set(id, { id, key, node: n, props: p });
  // The two colours can come from an expression, so they pass the same check as any style value (resolve.js).
  const back = typeof p.backdrop === "string" && v2CssSafe(p.backdrop) ? p.backdrop : "rgba(0,0,0,.45)";
  const bg = typeof p.background === "string" && v2CssSafe(p.background) ? p.background : "var(--card)";
  if (n.type === "Toast") {
    const bottom = Math.max(0, Math.min(400, Number(p.bottom) || 32));
    return '<div data-v2-shell="' + id + '" role="status" style="position:fixed;left:50%;transform:translateX(-50%);bottom:' +
      bottom + "px;background:" + esc(bg) + ';color:var(--text);border:1px solid var(--border);border-radius:12px;padding:10px 16px;z-index:60;' + s + '">' +
      kids + "</div>";
  }
  if (n.type === "Modal") {
    return '<div data-v2-shell="' + id + '" style="position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;background:' + esc(back) + '">' +
      '<div data-v2-stop role="dialog" aria-modal="true" style="max-width:min(680px,88vw);max-height:84vh;overflow:auto;background:' + esc(bg) +
      ';border:1px solid var(--border);border-radius:' + v2Radius(p.radius, 16) + "px;padding:18px;" + s + '">' + kids + "</div></div>";
  }
  const detents = v2Detents(p.detents);
  const at = Math.max(0, Math.min(detents.length - 1, Math.floor(Number(p.initial) || 0)));
  return '<div data-v2-shell="' + id + '" style="position:fixed;inset:0;z-index:50;background:' + esc(back) + '">' +
    '<div data-v2-stop data-v2-sheet role="dialog" aria-modal="true" style="position:absolute;left:0;right:0;bottom:0;height:' + Math.round(detents[at] * 100) +
    "vh;overflow:auto;background:" + esc(bg) + ";border-top:1px solid var(--border);border-radius:" + v2Radius(p.radius, 18) +
    "px " + v2Radius(p.radius, 18) + "px 0 0;padding:16px;" + s + '">' +
    '<div data-v2-grab style="width:40px;height:4px;border-radius:999px;background:var(--border);margin:0 auto 12px;cursor:grab"></div>' +
    kids + "</div></div>";
}

/** Close one: its exit motion plays, then it goes and the screen hears `onDismiss`. */
function v2ShellClose(el, st) {
  const wait = typeof v2PlayExit === "function" ? v2PlayExit(el.querySelector("[data-v2-stop]") || el, st.node.motion) : 0;
  const go = () => {
    const on = st.node.on || {};
    const p = st.props;
    const held = typeof p.openPath === "string" && p.openPath;
    if (held) setStatePath(p.openPath, false);
    // Bound to nothing, it would simply be drawn again by the repaint below: this window remembers it is shut.
    else if (p.open === undefined) V2_SHELL_SHUT.add(st.key);
    V2_TOAST_DUE.delete(st.key);
    if (on.onDismiss) void run(on.onDismiss);
    else if (typeof repaint === "function") repaint();
  };
  if (wait > 0) setTimeout(go, wait); else go();
}

function v2ShellWire(root) {
  root.querySelectorAll("[data-v2-shell]").forEach((el) => {
    const st = V2_SHELL.get(el.getAttribute("data-v2-shell"));
    if (!st || el.getAttribute("data-v2-wired") === "1") return;
    el.setAttribute("data-v2-wired", "1");
    const p = st.props;
    const inner = el.querySelector("[data-v2-stop]");
    if (inner) inner.addEventListener("click", (e) => { if (e.stopPropagation) e.stopPropagation(); });
    if (p.dismissible !== false && st.node.type !== "Toast") {
      el.addEventListener("click", () => v2ShellClose(el, st));
      // Escape closes the topmost one, before the window's own Escape (listen.js) hears it.
      if (!V2_SHELL_ESC.length) {
        v2Listen(document, "keydown", (e) => {
          if (e.key !== "Escape" || e.defaultPrevented || !V2_SHELL_ESC.length) return;
          const top = V2_SHELL_ESC[V2_SHELL_ESC.length - 1];
          if (!top.el.isConnected) return;
          if (e.preventDefault) e.preventDefault();
          V2_SHELL_ESC = [];
          v2ShellClose(top.el, top.st);
        }, true);
      }
      V2_SHELL_ESC.push({ el, st });
    }
    // A sheet is dragged by its grab bar, and settles on the nearest detent it was let go near.
    const grab = el.querySelector("[data-v2-grab]");
    const sheet = el.querySelector("[data-v2-sheet]");
    if (grab && sheet) {
      const detents = v2Detents(p.detents);
      let from = null;
      grab.addEventListener("pointerdown", (e) => { from = { y: e.clientY || 0, h: sheet.clientHeight || 0 }; });
      v2Listen(window, "pointermove", (e) => {
        if (!from) return;
        const h = Math.max(60, from.h - ((e.clientY || 0) - from.y));
        sheet.style.height = h + "px";
      });
      v2Listen(window, "pointerup", () => {
        if (!from) return;
        from = null;
        const tall = (window.innerHeight || 800);
        const now = (sheet.clientHeight || 0) / tall;
        if (p.dismissible !== false && now < detents[0] * 0.6) { v2ShellClose(el, st); return; }
        let best = detents[0];
        for (const d of detents) if (Math.abs(d - now) < Math.abs(best - now)) best = d;
        sheet.style.height = Math.round(best * 100) + "vh";
      });
    }
    if (st.node.type === "Toast") {
      const ms = Math.max(800, Math.min(10000, Number(p.ms) || 2600));
      const now = v2Now();
      const due = V2_TOAST_DUE.has(st.key) ? V2_TOAST_DUE.get(st.key) : now + ms;
      V2_TOAST_DUE.set(st.key, due);
      setTimeout(() => { if (el.isConnected) v2ShellClose(el, st); }, Math.max(0, due - now));
    }
  });
}

/** A new paint starts from no overlays. */
function v2ShellPaintStart() { V2_SHELL = new Map(); V2_SHELL_SEQ = 0; V2_SHELL_ESC = []; }

/** The screen is going: what it shut and when its toasts go are forgotten. */
function v2ShellLeave() { V2_SHELL_SHUT = new Set(); V2_TOAST_DUE = new Map(); }
