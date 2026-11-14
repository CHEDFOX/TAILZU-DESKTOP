// Where the blocks join the window: the node types they add, the marker a node carries so its motion and its
// gestures can find it after the paint, and the one wiring pass that runs once the markup is in the page.
//
// nodes.js calls v2Prepare() for every node and v2Mark() for the markup it made; everything else in this folder
// hangs off those two lines and off v2After(), which runs on the microtask after the paint has landed.

/** Nodes with a motion, gestures or a scroll input, by the marker put into their markup. */
let V2_MARKS = new Map();
/** Which nodes have already played their entrance on this screen: an entrance is an arrival, not a redraw. */
let V2_ENTERED = new Set();
/** The `motion.drive` appliers alive on this screen: a gesture or a scroll calls them as it moves. */
let V2_DRIVES = [];

/** The screen is going: what it entered, and what it drew, is forgotten. */
function v2MarksLeave() {
  V2_ENTERED = new Set();
  V2_MARKS = new Map();
  V2_DRIVES = [];
}

/** A new paint: the per-paint registries start again. What survives a repaint (lists, rules) is kept elsewhere. */
function v2PaintStart() {
  V2_MARKS = new Map();
  V2_DRIVES = [];
  if (typeof v2InputsPaintStart === "function") v2InputsPaintStart();
  if (typeof v2MediaPaintStart === "function") v2MediaPaintStart();
  if (typeof v2ShellPaintStart === "function") v2ShellPaintStart();
  if (typeof v2RulesPaintStart === "function") v2RulesPaintStart();
}

/** The node types the blocks add. Null means "not ours": nodes.js draws it as it always has. */
function v2Node(n, p, s, kids) {
  if (!V2.on) return null;
  switch (n.type) {
    case "List":
      // The vocab-1 List (items + itemTemplate) is untouched; this is the new one, which takes `data` and `item`.
      return v2Has("list") && (p.data !== undefined || p.item !== undefined) ? v2ListNode(n, p, s) : null;
    case "Each":
      return v2Has("list") ? v2EachNode(n, p, s) : null;
    case "Input":
      return v2Has("input") ? v2InputNode(n, p, s) : null;
    case "Video": case "Audio":
      return v2Has("media") && (typeof p.source === "string" || (p.source && typeof p.source === "object")) ? v2MediaNode(n, p, s, kids) : null;
    case "Sheet": case "Modal": case "Toast":
      return v2Has("shell") ? v2ShellNode(n, p, s, kids) : null;
    default:
      return null;
  }
}

/**
 * Put a marker in a node's markup when something has to find its element later.
 *
 * The markup is a string by the time it gets here, so the marker goes on its first tag. A node whose markup is not
 * one element (a Text that drew nothing, a list of rows) simply is not marked, and its motion does not play —
 * which is the right way round: nothing is claimed that cannot be done.
 */
function v2Mark(n, html) {
  if (!V2.on || typeof html !== "string" || html.charAt(0) !== "<") return html;
  const motion = n.motion && typeof n.motion === "object" && v2Has("motion") ? n.motion : null;
  const gestures = v2Has("gesture") ? v2Gestures(n.gestures) : [];
  const scrollInto = typeof n.scrollInto === "string" && n.scrollInto ? n.scrollInto
    : n.props && typeof n.props.scrollInto === "string" ? n.props.scrollInto : "";
  if (v2Has("rules") && Array.isArray(n.rules)) v2RulesOnNode(n.rules);
  if (!motion && !gestures.length && !scrollInto) return html;
  const id = "v2n" + V2_MARKS.size;
  V2_MARKS.set(id, { id, node: n, motion, gestures, scrollInto });
  return html.replace(/^<([a-zA-Z][\w-]*)/, '<$1 data-v2-n="' + id + '"');
}

/** The element a scroll input follows: its own box when it scrolls, else the window's view. */
function v2ScrollHost(el) {
  const o = el.style && (el.style.overflowY || el.style.overflow);
  if (o === "auto" || o === "scroll") return el;
  return (typeof $ === "function" && $("view")) || el;
}

/** Motion, gestures and scroll inputs, once their elements are in the page. */
function v2MarksWire(root) {
  const live = { count: 0, drives: V2_DRIVES };
  root.querySelectorAll("[data-v2-n]").forEach((el) => {
    const mark = V2_MARKS.get(el.getAttribute("data-v2-n"));
    if (!mark || el.getAttribute("data-v2-wired") === "1") return;
    el.setAttribute("data-v2-wired", "1");
    if (mark.motion) {
      // An entrance plays when the node arrives, not every time the screen is drawn again under it.
      const key = typeof mark.node.id === "string" && mark.node.id ? mark.node.id : "#" + mark.id;
      if (mark.motion.enter && !V2_ENTERED.has(key)) { V2_ENTERED.add(key); v2Play(el, mark.motion.enter, {}); }
      if (mark.motion.loop) v2Play(el, mark.motion.loop, { loop: true });
      if (mark.motion.drive) {
        const apply = v2Drive(el, mark.motion.drive, (by) => v2UiRead(by));
        if (apply) V2_DRIVES.push(apply);
      }
    }
    if (mark.gestures.length) v2GestureWire(el, mark.gestures, live);
    if (mark.scrollInto) {
      const host = v2ScrollHost(el);
      const name = mark.scrollInto;
      const follow = () => {
        V2.ui[name] = host.scrollTop || 0;
        for (const apply of V2_DRIVES) apply();
      };
      if (host && typeof host.addEventListener === "function") host.addEventListener("scroll", follow, { passive: true });
      follow();
    }
  });
}

/** Everything a block has to do to a paint that has landed. Called once per paint, and for rows drawn later. */
function v2WireIn(root) {
  if (!root) return;
  if (typeof v2ListsWire === "function") v2ListsWire(root);
  if (typeof v2InputsWire === "function") v2InputsWire(root);
  if (typeof v2MediaWire === "function") v2MediaWire(root);
  if (typeof v2ShellWire === "function") v2ShellWire(root);
  v2MarksWire(root);
}

/** The paint has landed. */
function v2After() {
  if (typeof v2RunHook === "function") v2RunHook();
  if (!V2.on) return;
  const view = typeof $ === "function" ? $("view") : null;
  if (view) v2WireIn(view);
  if (typeof v2RulesSync === "function") v2RulesSync();
  if (typeof v2LiveHook === "function" && v2Has("data")) v2LiveHook();
  // The gate's own download link, when this build is too old for the screen it was sent.
  if (view) {
    view.querySelectorAll("[data-v2-get]").forEach((a) => {
      if (a.getAttribute("data-v2-wired") === "1") return;
      a.setAttribute("data-v2-wired", "1");
      a.addEventListener("click", (e) => {
        if (e.preventDefault) e.preventDefault();
        try { window.tailzuApp.openExternal(a.getAttribute("data-v2-get")); } catch { /* no main process here */ }
      });
    });
  }
}

/**
 * What the window tells the server about the blocks (SPEC 2.11). `blocks` names only what is really drawn here, so
 * the server can send a screen that needs them — and send the frozen one to a build that cannot.
 */
function v2Handshake() {
  const blocks = v2Declared();
  if (!blocks.length) return {};
  const out = { vocab: 2, blocks };
  if (V2.bad.length) out.sdui = { ok: 1, bad: V2.bad.slice(0, 4) };
  return out;
}
