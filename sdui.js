/**
 * The desktop app window — the same server-drawn app the phones render.
 *
 * WHY THIS IS A RENDERER AND NOT A SECOND APP
 *
 * Every screen in Tailzu is JSON from /v1/app/screen: the tabs, the copy, the
 * charts, the paywall, which nodes exist and what they do. The phones ship a
 * renderer for that JSON and nothing else. So the desktop needs a renderer for
 * that JSON and nothing else — and a screen added to the catalog appears here
 * without a desktop release, exactly as it does on iOS and Android.
 *
 * WHY IT NEEDS A REAL SIGN-IN
 *
 * The tray's dictation runs on a static bearer token, which the backend
 * resolves to a stable synthetic user ("static-…"). That is fine for
 * transcription, which needs no history. It is useless for everything else:
 * a synthetic id is not a UUID, it matches no row in any table, so stats,
 * history, voices and entitlement all come back empty. The window signs in
 * properly — email OTP against Supabase, the same account as the phone — and
 * every screen then holds the same data the phone shows.
 *
 * Supabase's REST auth is two POSTs, so there is no SDK here. The anon key is
 * the public client credential; the tokens it returns are stored by the main
 * process, never by this renderer.
 */

/* eslint-env browser */

const SUPABASE_URL = "https://merzyohecmyfvlyahxaz.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1lcnp5b2hlY215ZnZseWFoeGF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyMjU1MzAsImV4cCI6MjA5NzgwMTUzMH0.scDhHeRU20wRIgKBFL8GouIEp8bJG8w8aIsySUkePHY";

const SCHEMA_VERSION = 1;

/** Node types this renderer draws. Sent in the capability handshake, so the
 *  server never emits a node the window cannot handle — the same contract the
 *  phones use, honoured honestly rather than claimed. */
const COMPONENTS = [
  "Screen", "Stack", "Spacer", "Text", "Image", "Icon", "Button", "TextField",
  "Chip", "Card", "List", "Divider", "Row", "Overline", "Heading", "Paragraph",
  "Quote", "Badge", "KeyValue", "Hero", "Switch", "SegmentedControl",
  "StatCard", "BarChart", "LineChart", "Sparkline", "PieChart", "DonutChart",
  "ProgressRing", "Gauge", "WordMeter", "Video", "Audio", "Grid",
];
const ACTIONS = [
  "navigate", "back", "switchTab", "callEndpoint", "setState", "toggleState",
  "toggleInArray", "refresh", "openUrl", "toast", "haptic", "sequence",
  "delay", "reloadScreen",
];

let ENV = null;          // baseUrl, fallbackToken, tone, language
let SESSION = null;      // { access_token, refresh_token, expires_at }
let BOOT = null;
let TABS = [];
let STACK = [];          // [{ screenId, params }]
let STATE = {};          // per-screen state, replaced on every navigation
let TAB_ID = "";

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function sbFetch(path, body) {
  const res = await fetch(SUPABASE_URL + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error_description || json.msg || json.error || `Auth failed (${res.status})`);
  return json;
}

/**
 * A valid access token, refreshing when the stored one has expired.
 *
 * Falls back to the static token so the window still renders SOMETHING before
 * sign-in rather than showing an error — the screens it can draw without an
 * account are the ones that need no account.
 */
async function bearer() {
  if (!SESSION) return ENV.fallbackToken || "dev";
  const now = Math.floor(Date.now() / 1000);
  if (SESSION.expires_at && SESSION.expires_at - 60 <= now && SESSION.refresh_token) {
    try {
      const r = await sbFetch("/auth/v1/token?grant_type=refresh_token", { refresh_token: SESSION.refresh_token });
      await setSession(r);
    } catch {
      // Refresh failed — the session is gone, not merely stale.
      await setSession(null);
      render();
      return ENV.fallbackToken || "dev";
    }
  }
  return SESSION.access_token;
}

async function setSession(raw) {
  SESSION = raw
    ? {
        access_token: raw.access_token,
        refresh_token: raw.refresh_token,
        expires_at: raw.expires_at || Math.floor(Date.now() / 1000) + (raw.expires_in || 3600),
      }
    : null;
  await window.tailzuApp.setSession(SESSION);
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

function capabilities() {
  return {
    schemaVersion: SCHEMA_VERSION,
    appVersion: "desktop",
    // The catalog branches on this. Desktop is closest to iOS in what it can
    // draw and shares none of the Android keyboard's constraints, so it takes
    // the iOS tree rather than inventing a third the server has never seen.
    platform: "ios",
    components: COMPONENTS,
    actions: ACTIONS,
    templates: [],
    device: {
      width: window.innerWidth, height: window.innerHeight, scale: window.devicePixelRatio || 1,
      colorScheme: "dark", locale: navigator.language || "en-US", reduceMotion: false, rtl: false,
    },
  };
}

async function api(path, body, method) {
  const tok = await bearer();
  const res = await fetch(ENV.baseUrl + path, {
    method: method || "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 429 && text.indexOf("quota_exceeded") !== -1) {
      const e = new Error("quota_exceeded"); e.quota = true; throw e;
    }
    throw new Error(path + " → " + res.status);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.indexOf("application/json") !== -1 ? res.json() : res.text();
}

const bootstrap = () => api("/v1/app/bootstrap", { capabilities: capabilities(), launchCount: 1 });
const fetchScreen = (screenId, params) =>
  api("/v1/app/screen", {
    screenId, params, capabilities: capabilities(),
    tzOffsetMinutes: -new Date().getTimezoneOffset(),
  });

// ---------------------------------------------------------------------------
// Theme, labels, conditions
// ---------------------------------------------------------------------------

function applyTheme(theme) {
  if (!theme || !theme.color) return;
  const c = theme.color, root = document.documentElement.style;
  const set = (k, v) => { if (v) root.setProperty(k, v); };
  set("--bg", c.bg); set("--card", c.card); set("--input", c.inputBg);
  set("--border", c.border); set("--text", c.text); set("--body", c.body);
  set("--muted", c.muted); set("--label", c.label); set("--danger", c.danger);
}

function label(v) {
  if (typeof v === "string" && v[0] === "@") {
    const k = v.slice(1);
    return (BOOT && BOOT.labels && BOOT.labels[k]) || k;
  }
  return v;
}

function tok(v) {
  if (typeof v !== "string" || v[0] !== "$") return v;
  let o = BOOT && BOOT.theme;
  for (const part of v.slice(1).split(".")) { if (o == null) return undefined; o = o[part]; }
  return o;
}

function stateAt(path) {
  let o = STATE;
  for (const part of String(path).replace(/^state\./, "").split(".")) {
    if (o == null) return undefined;
    o = o[part];
  }
  return o;
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v === true || v === "true" || (typeof v === "number" && v !== 0) || (typeof v === "string" && v.length > 0);
}

function lookup(ref) {
  if (typeof ref !== "string") return ref;
  if (ref.indexOf("state.") === 0) return stateAt(ref);
  if (ref.indexOf("flags.") === 0) return BOOT && BOOT.flags && BOOT.flags[ref.slice(6)];
  return stateAt(ref);
}

function visible(c) {
  if (!c) return true;
  if (c.platform) return c.platform === "ios";
  if (c.flag) return truthy(BOOT && BOOT.flags && BOOT.flags[c.flag]);
  if (c.truthy) return truthy(lookup(c.truthy));
  if (c.falsy) return !truthy(lookup(c.falsy));
  if (c.eq) return String(lookup(c.eq[0])) === String(c.eq[1]);
  if (c.neq) return String(lookup(c.neq[0])) !== String(c.neq[1]);
  if (c.not) return !visible(c.not);
  if (c.all) return c.all.every(visible);
  if (c.any) return c.any.some(visible);
  return true;
}

/** Style keys → CSS. The SDUI names come first, then the RN-flavoured aliases
 *  the newer screens author with; both are in the tree and both must resolve. */
const NUMERIC_OK = /opacity|flex|flex-grow|flex-shrink|z-index|font-weight|line-height|aspect-ratio/;
const MAP = {
  direction: "flex-direction", align: "align-items", justify: "justify-content",
  radius: "border-radius", background: "background-color", gap: "gap",
};
const ALIGN = { start: "flex-start", end: "flex-end", center: "center", between: "space-between", around: "space-around", stretch: "stretch", baseline: "baseline" };

function css(st) {
  if (!st) return "";
  const out = [];
  for (const k of Object.keys(st)) {
    let v = tok(st[k]);
    if (v == null) continue;
    let prop = MAP[k] || k.replace(/[A-Z]/g, (ch) => "-" + ch.toLowerCase());
    if (prop === "align-items" || prop === "justify-content" || prop === "align-self") v = ALIGN[v] || v;
    if (typeof v === "number" && !NUMERIC_OK.test(prop)) v = v + "px";
    out.push(prop + ":" + v);
  }
  return out.join(";");
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

let handlers = [];        // [{ id, action }] — bound after innerHTML lands

function bind(action) {
  if (!action) return "";
  const id = "h" + handlers.length;
  handlers.push({ id, action });
  return ' data-h="' + id + '"';
}

function node(n) {
  if (!n) return "";
  if (!visible(n.visibleIf)) return n.fallback ? node(n.fallback) : "";
  const p = n.props || {}, st = n.style || {}, s = css(st);
  const kids = (n.children || []).map(node).join("");
  const press = n.on && (n.on.onPress || n.on.onChange || n.on.onSubmit);
  const txt = esc(label(p.content != null ? p.content : p.label));

  switch (n.type) {
    case "Screen":
      return '<div class="pad" style="' + s + '">' + kids + "</div>";

    case "Stack": case "Row": case "SafeArea": case "MorphOut": case "PullToRefresh": case "Grid":
      return '<div' + bind(press) + ' style="display:flex;flex-direction:' +
        (st.direction === "row" || n.type === "Row" ? "row" : "column") +
        (press ? ";cursor:pointer" : "") + ";" + s + '">' + kids + "</div>";

    case "Card":
      return '<div' + bind(press) + ' style="background:var(--card);border:1px solid var(--border);' +
        "border-radius:18px;padding:16px;margin-bottom:13px" + (press ? ";cursor:pointer" : "") + ";" + s + '">' +
        kids + (txt ? "<div>" + txt + "</div>" : "") + "</div>";

    case "Spacer":
      return '<div style="height:' + (st.height || 8) + "px;flex:" + (st.flex || 0) + '"></div>';

    case "Divider":
      return '<div style="height:1px;background:var(--border);margin:12px 0"></div>';

    case "Heading":
      return '<h2 style="color:var(--text);font-size:26px;font-weight:600;line-height:1.18;margin:0 0 14px;' + s + '">' + txt + "</h2>";

    case "Hero":
      return '<div style="margin-bottom:16px"><div style="color:var(--text);font-size:30px;font-weight:700;letter-spacing:-.5px">' +
        esc(label(p.title)) + '</div><div style="color:var(--muted);font-size:15px;margin-top:4px">' +
        esc(label(p.subtitle)) + "</div></div>";

    case "Overline":
      return '<div style="color:var(--label);font-size:11px;letter-spacing:3px;text-transform:uppercase;font-weight:500;margin-bottom:9px;' + s + '">' + txt + "</div>";

    case "Paragraph": case "Quote":
      return '<p style="color:var(--body);margin:0 0 12px;' + s + '">' + txt + "</p>";

    case "Text":
      return '<span' + bind(press) + ' style="color:var(--text);' + (press ? "cursor:pointer;" : "") + s + '">' + txt + "</span>";

    case "Badge": case "Chip":
      return '<span' + bind(press) + ' style="display:inline-block;border:1px solid var(--border);border-radius:999px;' +
        'padding:5px 11px;font-size:12.5px;color:var(--body);' + (press ? "cursor:pointer;" : "") + s + '">' + txt + "</span>";

    case "Button": {
      const primary = p.variant !== "secondary" && p.variant !== "ghost";
      return '<button' + bind(press) + ' style="display:block;width:100%;border:0;cursor:pointer;' +
        (primary ? "background:var(--accent);color:#000" : "background:transparent;color:var(--text);border:1px solid var(--border)") +
        ';border-radius:14px;padding:14px 18px;font-size:16px;font-weight:600;margin:6px 0;' + s + '">' +
        (txt || "Continue") + "</button>";
    }

    case "Row2": case "KeyValue":
      return '<div' + bind(press) + ' style="display:flex;justify-content:space-between;gap:14px;padding:12px 0;' +
        "border-bottom:1px solid var(--border)" + (press ? ";cursor:pointer" : "") + '">' +
        '<span style="color:var(--label)">' + esc(label(p.label)) + "</span>" +
        '<span style="color:var(--text);font-weight:500">' + esc(label(p.value)) + "</span></div>";

    case "StatCard":
      return '<div style="background:var(--card);border-radius:14px;padding:15px;flex:1;min-width:0;' + s + '">' +
        '<div style="color:var(--label);font-size:11px;letter-spacing:1.6px;text-transform:uppercase">' + esc(label(p.label)) + "</div>" +
        '<div style="color:var(--text);font-size:30px;font-weight:700;margin-top:5px">' + esc(p.value) + "</div></div>";

    case "TextField": {
      const path = (n.bind && n.bind.value) || "";
      const val = path ? (stateAt(path) || "") : "";
      const multi = p.multiline === true;
      const common = ' data-bind="' + esc(path) + '" placeholder="' + esc(label(p.placeholder) || "") +
        '" style="width:100%;background:var(--input);border:1px solid var(--border);border-radius:13px;' +
        "padding:13px 14px;color:var(--text);font:inherit;outline:none;" + s + '"';
      return multi
        ? "<textarea rows=\"4\"" + common + ">" + esc(val) + "</textarea>"
        : '<input value="' + esc(val) + '"' + common + ">";
    }

    case "Switch": {
      const path = (n.bind && n.bind.value) || "";
      const on = truthy(path ? stateAt(path) : p.value);
      return '<button' + bind(n.on && n.on.onChange ? n.on.onChange : press) +
        ' data-toggle="' + esc(path) + '" aria-pressed="' + on + '"' +
        ' style="width:50px;height:30px;flex:none;border:0;border-radius:15px;cursor:pointer;position:relative;background:' +
        (on ? "var(--accent)" : "rgba(255,255,255,.16)") + '">' +
        '<span style="position:absolute;top:3px;left:' + (on ? 23 : 3) +
        'px;width:24px;height:24px;border-radius:50%;background:#fff"></span></button>';
    }

    case "List": {
      const items = Array.isArray(p.items) ? p.items : [];
      if (!items.length) {
        const empty = label(p.emptyLabel);
        return empty ? '<p style="color:var(--muted);text-align:center;padding:26px 0">' + esc(empty) + "</p>" : "";
      }
      const tpl = p.itemTemplate;
      return items.map((it) => {
        const saved = STATE;
        STATE = Object.assign({}, STATE, { item: it });
        const html = tpl ? node(tpl) : '<div style="padding:10px 0">' + esc(it.title || it.output || "") + "</div>";
        STATE = saved;
        return html;
      }).join("");
    }

    case "Image": case "Video": {
      const src = p.source && (p.source.url || p.source.uri);
      if (!src) return "";
      const box = "width:" + (st.width ? st.width + "px" : "100%") + ";" +
        (st.aspectRatio ? "aspect-ratio:" + st.aspectRatio + ";" : "height:" + (st.height || 160) + "px;") +
        "border-radius:" + (st.borderRadius != null ? st.borderRadius : 16) + "px;object-fit:" +
        (p.contentFit === "contain" ? "contain" : "cover") + ";display:block;margin:0 auto 14px";
      return n.type === "Video"
        ? '<video src="' + esc(src) + '" autoplay muted loop playsinline style="' + box + '"></video>'
        : '<img src="' + esc(src) + '" alt="" style="' + box + '">';
    }

    case "WordMeter": return wordMeter(p);
    case "PieChart": case "DonutChart": return pie(p);
    case "BarChart": return bars(p);
    case "Sparkline": case "LineChart": return bars({ series: p.series || p.data, color: p.color });
    case "ProgressRing": case "Gauge":
      return '<div style="height:6px;border-radius:3px;background:var(--border);overflow:hidden;margin:8px 0">' +
        '<div style="width:' + Math.max(0, Math.min(100, Number(p.value) || 0)) + '%;height:100%;background:var(--accent)"></div></div>';

    // Everything the phones draw natively and this window has no business
    // imitating — the keyboard preview, the mic toggle, the particle mark.
    // Their children still render, so a card built around one is not lost.
    default:
      return kids;
  }
}

function wordMeter(p) {
  const base = +p.base || 0, earned = +p.earned || 0;
  const total = Math.max(1, base + earned);
  const used = Math.max(0, Math.min(total, +p.used || 0));
  const left = total - used;
  const tick = earned > 0 ? (base / total) * 100 : -1;
  const fill = p.fillColor || "var(--accent)";
  return '<div><div style="display:flex;justify-content:space-between;align-items:baseline">' +
    '<span style="color:var(--text);font-size:28px;font-weight:700;letter-spacing:-.5px">' + left.toLocaleString() + "</span>" +
    '<span style="color:var(--label);font-size:13px">' + used.toLocaleString() + " of " + total.toLocaleString() + " used</span></div>" +
    '<div style="color:var(--label);font-size:13px;margin-top:2px">words left</div>' +
    '<div style="height:10px;border-radius:5px;background:var(--border);margin-top:12px;position:relative;overflow:hidden">' +
    '<div style="width:' + (used / total) * 100 + "%;height:100%;background:" + fill + '"></div>' +
    (tick >= 0 ? '<div style="position:absolute;top:0;bottom:0;left:' + tick + '%;width:2px;background:var(--bg)"></div>' : "") +
    '</div><div style="display:flex;gap:14px;margin-top:10px">' +
    '<span style="color:var(--label);font-size:12px">' + base.toLocaleString() + " free</span>" +
    (earned > 0 ? '<span style="color:' + (p.earnedColor || "var(--accent)") + ';font-size:12px;font-weight:600">+' +
      earned.toLocaleString() + " earned</span>" : "") + "</div>" +
    (p.caption ? '<div style="color:var(--label);font-size:13px;margin-top:12px">' + esc(p.caption) + "</div>" : "") + "</div>";
}

function pie(p) {
  const data = (p.data || []).filter((d) => (+d.value || 0) > 0);
  const total = data.reduce((n, d) => n + (+d.value || 0), 0);
  const size = p.size || 150, r = size / 2;
  const inner = p.donut === false ? 0 : r - r * 0.26;
  if (!total) return "";
  let a = -Math.PI / 2, paths = "";
  data.forEach((d) => {
    const frac = (+d.value) / total, a1 = a + frac * Math.PI * 2;
    const big = a1 - a > Math.PI ? 1 : 0;
    const x0 = r + r * Math.cos(a), y0 = r + r * Math.sin(a);
    const x1 = r + r * Math.cos(a1), y1 = r + r * Math.sin(a1);
    const ix1 = r + inner * Math.cos(a1), iy1 = r + inner * Math.sin(a1);
    const ix0 = r + inner * Math.cos(a), iy0 = r + inner * Math.sin(a);
    // One slice covering the whole circle cannot be drawn as a single arc:
    // start and end coincide and the path collapses. Draw a ring instead.
    paths += data.length === 1
      ? '<circle cx="' + r + '" cy="' + r + '" r="' + (r + inner) / 2 + '" fill="none" stroke="' +
        esc(d.color || "#E8A23C") + '" stroke-width="' + (r - inner) + '"/>'
      : '<path d="M ' + x0 + " " + y0 + " A " + r + " " + r + " 0 " + big + " 1 " + x1 + " " + y1 +
        " L " + ix1 + " " + iy1 + " A " + inner + " " + inner + " 0 " + big + " 0 " + ix0 + " " + iy0 +
        ' Z" fill="' + esc(d.color || "#E8A23C") + '"/>';
    a = a1;
  });
  const legend = p.legend === false ? "" :
    '<div style="display:flex;flex-direction:column;gap:6px;flex:1;min-width:0">' + data.map((d) =>
      '<div style="display:flex;align-items:center;gap:8px;min-width:0">' +
      '<span style="width:8px;height:8px;border-radius:50%;flex:none;background:' + esc(d.color || "#E8A23C") + '"></span>' +
      '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px">' + esc(d.label || "") + "</span>" +
      '<span style="color:var(--label);font-size:12.5px">' + Math.round(((+d.value) / total) * 100) + "%</span></div>").join("") + "</div>";
  const centre = p.centerValue != null
    ? '<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">' +
      '<div style="color:var(--text);font-size:19px;font-weight:700">' + esc(p.centerValue) + "</div>" +
      '<div style="color:var(--label);font-size:11px">' + esc(p.centerLabel || "") + "</div></div>"
    : "";
  return '<div style="display:flex;align-items:center;gap:18px"><div style="position:relative;flex:none;width:' +
    size + "px;height:" + size + 'px"><svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + " " + size + '">' +
    paths + "</svg>" + centre + "</div>" + legend + "</div>";
}

function bars(p) {
  const vals = (p.series || []).map((x) => (typeof x === "number" ? x : +x.value || 0));
  if (!vals.length) return "";
  const max = Math.max.apply(null, vals.concat([1]));
  return '<div style="display:flex;align-items:flex-end;gap:4px;height:110px">' + vals.map((v) =>
    '<div style="flex:1;border-radius:3px;background:' + esc(p.color || "#E8A23C") +
    ';height:' + Math.max(2, (v / max) * 100) + '%"></div>').join("") + "</div>";
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("on"), 2600);
}

function resolveValue(v) {
  if (typeof v === "string" && v.indexOf("$state.") === 0) return stateAt(v.slice(7));
  return v;
}

async function run(action) {
  if (!action) return;
  if (typeof action === "string") return run((CURRENT_ACTIONS || {})[action]);
  switch (action.kind) {
    case "navigate": go(action.screenId, action.params); return;
    case "back": back(); return;
    case "switchTab": switchTab(action.tabId); return;
    case "reloadScreen": case "refresh": await paint(true); return;
    case "setState": setStatePath(action.path, resolveValue(action.value)); repaint(); return;
    case "toggleState": setStatePath(action.path, !truthy(stateAt(action.path))); repaint(); return;
    case "toggleInArray": {
      const cur = stateAt(action.path);
      const list = Array.isArray(cur) ? cur.slice() : [];
      const v = resolveValue(action.value);
      const i = list.indexOf(v);
      if (i === -1) list.push(v); else list.splice(i, 1);
      setStatePath(action.path, list); repaint(); return;
    }
    case "toast": toast(label(action.message) || ""); return;
    case "haptic": return;                      // no equivalent, and none faked
    case "delay": await new Promise((r) => setTimeout(r, action.ms || 0)); return;
    case "openUrl": window.tailzuApp.openExternal(action.url); return;
    case "sequence":
      for (const a of action.actions || []) await run(a);
      return;
    case "callEndpoint": {
      try {
        const path = String(action.path || "").replace(/\$state\.[A-Za-z0-9_.]+/g, (m) => {
          const v = stateAt(m.slice(7));
          return v == null ? "" : encodeURIComponent(String(v));
        });
        const body = action.body != null ? deepResolve(action.body) : undefined;
        const res = await api(path, body, action.method || "POST");
        if (action.assignTo) { setStatePath(action.assignTo, res); repaint(); }
        await run(action.onSuccess);
        if (action.method && action.method.toUpperCase() !== "GET") await paint(true);
      } catch (err) {
        if (err && err.quota) { go("paywall"); return; }
        await run(action.onError);
      }
      return;
    }
    default: return;
  }
}

function deepResolve(v) {
  if (typeof v === "string") return resolveValue(v);
  if (Array.isArray(v)) return v.map(deepResolve);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) o[k] = deepResolve(v[k]);
    return o;
  }
  return v;
}

function setStatePath(path, value) {
  const parts = String(path).replace(/^state\./, "").split(".");
  let o = STATE;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof o[parts[i]] !== "object" || o[parts[i]] === null) o[parts[i]] = {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = value;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

let CURRENT_ACTIONS = {};

function go(screenId, params) {
  if (!screenId) return;
  STACK.push({ screenId, params });
  paint();
}
function back() {
  if (STACK.length > 1) { STACK.pop(); paint(); }
}
function switchTab(tabId) {
  const tab = TABS.find((t) => t.id === tabId);
  if (!tab) return;
  TAB_ID = tabId;
  STACK = [{ screenId: tab.screenId }];
  paint();
}

async function paint(force) {
  const cur = STACK[STACK.length - 1];
  if (!cur) return;
  const view = $("view");
  if (force || !paint._last || paint._last !== cur.screenId) {
    view.innerHTML = '<div class="pad" style="color:var(--label)">Loading…</div>';
  }
  paint._last = cur.screenId;
  let screen;
  try {
    screen = await fetchScreen(cur.screenId, cur.params);
  } catch (err) {
    view.innerHTML = '<div class="pad"><p style="color:var(--danger)">Couldn\'t load this screen.</p>' +
      '<p style="color:var(--label);font-size:13px">' + esc(String(err.message || err)) + "</p></div>";
    return;
  }
  STATE = Object.assign({}, screen.state || {});
  CURRENT_ACTIONS = screen.actions || {};
  $("title").textContent = label(screen.title) || "";
  $("back").hidden = STACK.length <= 1;
  repaint(screen);
}

let CURRENT_SCREEN = null;
function repaint(screen) {
  if (screen) CURRENT_SCREEN = screen;
  const sc = CURRENT_SCREEN;
  if (!sc) return;
  handlers = [];
  const html = sc.root ? node(sc.root) : '<div class="pad">' + (sc.blocks || []).map(node).join("") + "</div>";
  const view = $("view");
  view.innerHTML = html;

  handlers.forEach((h) => {
    const el = view.querySelector('[data-h="' + h.id + '"]');
    if (el) el.addEventListener("click", () => { void run(h.action); });
  });
  view.querySelectorAll("[data-bind]").forEach((el) => {
    const path = el.getAttribute("data-bind");
    if (!path) return;
    el.addEventListener("input", () => { setStatePath(path, el.value); });
  });
  view.querySelectorAll("[data-toggle]").forEach((el) => {
    const path = el.getAttribute("data-toggle");
    if (!path) return;
    el.addEventListener("click", () => { setStatePath(path, !truthy(stateAt(path))); repaint(); });
  });
  document.querySelectorAll("#tabs .tab").forEach((b) => {
    b.setAttribute("aria-current", String(b.dataset.tab === TAB_ID));
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function renderTabs() {
  $("tabs").innerHTML = TABS.map((t) =>
    '<button class="tab" data-tab="' + esc(t.id) + '">' + esc(t.title) + "</button>").join("");
  document.querySelectorAll("#tabs .tab").forEach((b) => {
    b.addEventListener("click", () => switchTab(b.dataset.tab));
  });
}

async function render() {
  const signedIn = !!(SESSION && SESSION.access_token);
  $("gate").hidden = signedIn;
  $("shell").hidden = !signedIn;
  if (!signedIn) return;
  BOOT = await bootstrap();
  applyTheme(BOOT.theme);
  TABS = BOOT.navigation && BOOT.navigation.kind === "tabs" ? BOOT.navigation.tabs : [];
  renderTabs();
  TAB_ID = TABS.length ? TABS[0].id : "";
  // Never the intro or onboarding: those answer questions this user already
  // answered on their phone, and the desktop cannot enable a keyboard anyway.
  const first = TABS.length ? TABS[0].screenId : "home";
  STACK = [{ screenId: first }];
  await paint();
}

async function signIn(email) {
  await sbFetch("/auth/v1/otp", { email, create_user: true });
}
async function verify(email, token) {
  const r = await sbFetch("/auth/v1/verify", { email, token, type: "email" });
  await setSession(r);
}

(async function start() {
  ENV = await window.tailzuApp.env();
  SESSION = ENV.session || null;

  $("dictate").addEventListener("click", () => { window.tailzuApp.dictate(); toast("Listening — press your hotkey to stop"); });
  $("settingsLink").addEventListener("click", () => go("settings"));
  $("back").addEventListener("click", back);
  $("signOut").addEventListener("click", async () => { await setSession(null); location.reload(); });

  const email = $("email"), code = $("code"), err = $("gateErr");
  const fail = (e) => { err.textContent = String((e && e.message) || e || ""); };

  $("sendCode").addEventListener("click", async () => {
    err.textContent = "";
    const v = email.value.trim();
    if (!v) return fail("Enter your email address.");
    $("sendCode").disabled = true;
    try {
      await signIn(v);
      $("stepEmail").hidden = true;
      $("stepCode").hidden = false;
      code.focus();
    } catch (e) { fail(e); } finally { $("sendCode").disabled = false; }
  });
  $("backToEmail").addEventListener("click", () => {
    $("stepEmail").hidden = false; $("stepCode").hidden = true; err.textContent = "";
  });
  $("verify").addEventListener("click", async () => {
    err.textContent = "";
    $("verify").disabled = true;
    try {
      await verify(email.value.trim(), code.value.trim());
      await render();
    } catch (e) { fail(e); } finally { $("verify").disabled = false; }
  });
  email.addEventListener("keydown", (e) => { if (e.key === "Enter") $("sendCode").click(); });
  code.addEventListener("keydown", (e) => { if (e.key === "Enter") $("verify").click(); });

  try {
    await render();
  } catch (e) {
    // A failed bootstrap must not leave a blank window with no way out.
    $("gate").hidden = false;
    $("shell").hidden = true;
    fail("Couldn't reach the backend: " + ((e && e.message) || e));
  }
})();
