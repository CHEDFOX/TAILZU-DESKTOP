// Lists, without the window knowing what is in them (SPEC 2.6, B6): `List`, windowed and paged, and `Each`.
//
// The arithmetic is the phone's (components/listCore.ts) — which rows are in view, which path a page may come from,
// what a page does to the rows already held — so a feed behaves the same on both. The drawing is DOM: a box that
// scrolls, a spacer above the rows in view and one below, and the rows themselves redrawn as it scrolls.

const V2_LIST_LIMITS = { pageMax: 100, heldMax: 2000, eachMax: 200, flatMax: 100, pathMax: 1024, failMax: 3 };
const V2_ROW_SIZE = { min: 8, max: 2000, fallback: 64 };
/** Screenfuls of rows kept on each side of the ones in view. */
const V2_OVERSCAN = 1;

/** Every list drawn on this screen: its node, its rows and where its paging has got to. */
let V2_LISTS = new Map();

function v2RowSize(raw) {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return V2_ROW_SIZE.fallback;
  return Math.min(V2_ROW_SIZE.max, Math.max(V2_ROW_SIZE.min, Math.round(n)));
}

/** A path a list may fetch: ours, under /v1/, no scheme, no climbing, decoded as well as written. */
function v2ApiPath(raw) {
  if (typeof raw !== "string") return null;
  const p = raw.trim();
  if (!p || p.length > V2_LIST_LIMITS.pathMax || p.indexOf("/v1/") !== 0) return null;
  const k = v2Kernel();
  if (k && !k.networkPathOk(p)) return null;
  let decoded;
  try { decoded = decodeURIComponent(p); } catch { return null; }
  if (decoded.indexOf("/v1/") !== 0) return null;
  if (decoded.indexOf("..") !== -1 || decoded.indexOf("//") !== -1 || decoded.indexOf("\\") !== -1) return null;
  return p;
}

/** The rows and the next path inside a page's body. Three server routes answer `rows` or `data` rather than `items`. */
function v2PageBody(body) {
  const b = body && typeof body === "object" ? body : {};
  const raw = [b.items, b.rows, b.data].find((v) => Array.isArray(v));
  return { items: Array.isArray(raw) ? raw.slice(0, V2_LIST_LIMITS.pageMax) : [], next: v2ApiPath(b.next) };
}

/** A row's key: its own id field, else its place. Always a string, and never the same one twice. */
function v2KeyOf(item, keyProp, index) {
  if (keyProp && item && typeof item === "object") {
    const v = item[keyProp];
    if (typeof v === "string" && v) return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return "#" + index;
}

/** The rows held after a page arrives: no row twice, never past the ceiling, and a replace starts from none. */
function v2Merged(held, incoming, mode, keyProp) {
  const base = mode === "replace" ? [] : held.slice();
  const seen = new Set();
  if (keyProp) base.forEach((it, i) => seen.add(v2KeyOf(it, keyProp, i)));
  const fresh = [];
  incoming.forEach((it, i) => {
    if (!keyProp) { fresh.push(it); return; }
    const key = v2KeyOf(it, keyProp, base.length + i);
    if (seen.has(key)) return;
    seen.add(key);
    fresh.push(it);
  });
  const take = fresh.slice(0, Math.max(0, V2_LIST_LIMITS.heldMax - base.length));
  return mode === "prepend" ? take.concat(base) : base.concat(take);
}

/**
 * Which rows are in view, and how much empty space goes above and below them.
 *
 * `top` is where the list starts inside its scroller, so the same arithmetic serves a list that scrolls on its own
 * and one that rides the page's scroller.
 */
function v2WindowRows(count, size, viewH, scrollTop, top) {
  if (count <= 0 || size <= 0) return { first: 0, last: -1, before: 0, after: 0 };
  const height = viewH > 0 ? viewH : size * 10;
  const seen = Math.max(0, scrollTop - (top || 0));
  const perScreen = Math.max(1, Math.ceil(height / size));
  const first = Math.max(0, Math.floor(seen / size) - perScreen * V2_OVERSCAN);
  const last = Math.min(count - 1, first + perScreen * (1 + 2 * V2_OVERSCAN));
  return { first, last, before: first * size, after: Math.max(0, (count - 1 - last) * size) };
}

/** This list's own name, so its rows and its paging survive a repaint. */
function v2ListId(n, p) {
  if (typeof n.id === "string" && n.id) return n.id;
  const page = p && p.page && typeof p.page === "object" ? String(p.page.into || p.page.endpoint || "") : "";
  return "list:" + (page || V2_LISTS.size);
}

/** The screen is going: forget every list it had. */
function v2ListLeave() { V2_LISTS = new Map(); }

/**
 * The box. Its rows are filled in once the paint has landed (v2After), and again whenever it scrolls — which is
 * what makes it a windowed list rather than two thousand elements.
 */
function v2ListNode(n, p, s) {
  const id = v2ListId(n, p);
  const data = Array.isArray(p.data) ? p.data : [];
  const had = V2_LISTS.get(id);
  const page = p.page && typeof p.page === "object" ? p.page : null;
  V2_LISTS.set(id, {
    id,
    node: n,
    props: p,
    // What it was given, which after a page is the store's own rows (`page.into`); what it had, while the store
    // has not caught up (a list paging into a path its `data` does not read).
    rows: data.length || !had ? data : had.rows,
    size: v2RowSize(p.estimatedSize),
    horizontal: p.horizontal === true,
    scroller: p.scroll === true,
    next: had ? had.next : page ? v2ApiPath(page.endpoint) : null,
    loading: false,
    fails: had ? had.fails : 0,
    first: -1,
    last: -2,
  });
  const own = p.scroll === true ? "overflow:" + (p.horizontal === true ? "auto hidden" : "hidden auto") + ";" : "";
  return '<div data-v2-list="' + esc(id) + '" style="' + s + ";" + own +
    (p.horizontal === true ? "display:flex;flex-direction:row" : "") + '"></div>';
}

/** `Each`: a small array, every entry drawn, nothing windowed. */
function v2EachNode(n, p, s) {
  const data = Array.isArray(p.data) ? p.data : [];
  const max = Math.max(0, Math.min(V2_LIST_LIMITS.eachMax, Number(p.max) > 0 ? Math.floor(Number(p.max)) : V2_LIST_LIMITS.eachMax));
  const tpl = p.item && typeof p.item === "object" ? p.item : null;
  if (!tpl) return "";
  const rows = data.slice(0, max).map((item, i) => v2WithRow(item, i, () => node(tpl))).join("");
  return '<div style="' + s + '">' + rows + "</div>";
}

/** The scroller a list rides: its own box when it has one, else the window's view. */
function v2ScrollerOf(el) {
  if (el.getAttribute("data-v2-own") === "1") return el;
  let at = el.parentElement;
  while (at) {
    const o = at.style && (at.style.overflowY || at.style.overflow);
    if (o === "auto" || o === "scroll" || at.getAttribute("id") === "view") return at;
    at = at.parentElement;
  }
  return el;
}

/** Draw the rows that are in view into this list's box, with the empty space above and below them. */
function v2ListFill(el, st) {
  const p = st.props;
  const tpl = p.item && typeof p.item === "object" ? p.item : null;
  if (!tpl) { el.innerHTML = ""; return; }
  const rows = st.rows;
  if (!rows.length) {
    const empty = p.empty && typeof p.empty === "object" ? node(p.empty) : "";
    el.innerHTML = empty;
    return;
  }
  const scroller = st.scroller ? el : v2ScrollerOf(el);
  const own = scroller === el;
  let plan;
  if (st.scroller || own) {
    plan = v2WindowRows(rows.length, st.size, el.clientHeight || 0, el.scrollTop || 0, 0);
  } else {
    // Riding the page's scroller: the list starts where it sits inside it.
    const top = (el.getBoundingClientRect ? el.getBoundingClientRect().top : 0) - (scroller.getBoundingClientRect ? scroller.getBoundingClientRect().top : 0) + (scroller.scrollTop || 0);
    plan = v2WindowRows(Math.min(rows.length, V2_LIST_LIMITS.heldMax), st.size, scroller.clientHeight || 0, scroller.scrollTop || 0, top);
    // Without a scroller of its own a list is a capped block of rows, the same ceiling the phone keeps.
    if (!st.scroller && rows.length <= V2_LIST_LIMITS.flatMax) plan = { first: 0, last: rows.length - 1, before: 0, after: 0 };
  }
  if (plan.first === st.first && plan.last === st.last) return;
  st.first = plan.first;
  st.last = plan.last;
  const axis = st.horizontal ? "width" : "height";
  const out = [];
  if (plan.before > 0) out.push('<div style="flex:none;' + axis + ":" + plan.before + 'px"></div>');
  for (let i = plan.first; i <= plan.last; i++) out.push(v2WithRow(rows[i], i, () => node(tpl)));
  if (plan.after > 0) out.push('<div style="flex:none;' + axis + ":" + plan.after + 'px"></div>');
  el.innerHTML = out.join("");
  if (typeof bindHandlers === "function") bindHandlers(el);
  if (typeof v2WireIn === "function") v2WireIn(el);
}

/** Ask for the next page. One at a time, and never again once the server has said there is no more. */
async function v2ListPage(st, el) {
  const p = st.props;
  const page = p.page && typeof p.page === "object" ? p.page : null;
  if (!page || st.loading || !st.next || st.fails >= V2_LIST_LIMITS.failMax) return;
  if (st.rows.length >= V2_LIST_LIMITS.heldMax) return;
  const path = st.next;
  st.loading = true;
  try {
    const body = await api(path, undefined, "GET");
    const got = v2PageBody(body);
    const mode = p.pageMode === "prepend" || p.pageMode === "replace" ? p.pageMode : page.mode === "prepend" || page.mode === "replace" ? page.mode : "append";
    st.rows = v2Merged(st.rows, got.items, mode, typeof p.key === "string" ? p.key : "");
    st.next = got.next;
    st.fails = 0;
    if (typeof page.into === "string" && page.into) setStatePath(page.into, st.rows);
    if (typeof page.cursor === "string" && page.cursor) setStatePath(page.cursor, st.next);
    st.first = -1; st.last = -2;
    v2ListFill(el, st);
    if (st.node.on && st.node.on.onResult) await run(st.node.on.onResult, { count: got.items.length, more: !!st.next });
  } catch (e) {
    st.fails += 1;
    if (st.node.on && st.node.on.onError) await run(st.node.on.onError, "");
  } finally {
    st.loading = false;
  }
}

/** Wire every list the paint drew: fill it, follow its scroller, and ask for the first page when it has one. */
function v2ListsWire(root) {
  root.querySelectorAll("[data-v2-list]").forEach((el) => {
    const st = V2_LISTS.get(el.getAttribute("data-v2-list"));
    if (!st || el.getAttribute("data-v2-wired") === "1") return;
    el.setAttribute("data-v2-wired", "1");
    if (st.scroller) el.setAttribute("data-v2-own", "1");
    const scroller = v2ScrollerOf(el);
    const onScroll = () => {
      v2ListFill(el, st);
      const p = st.props;
      if (p.onEndReached === "none") return;
      const near = st.scroller
        ? el.scrollHeight - el.scrollTop - el.clientHeight < Math.max(1, (el.clientHeight || 0) * 0.4)
        : scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < Math.max(1, (scroller.clientHeight || 0) * 0.4);
      if (near) void v2ListPage(st, el);
    };
    if (scroller && typeof scroller.addEventListener === "function") scroller.addEventListener("scroll", onScroll, { passive: true });
    v2ListFill(el, st);
    // Nothing in hand and a page to ask for: ask now, so an empty list is a loading list and not a dead one.
    if (!st.rows.length) void v2ListPage(st, el);
  });
}
