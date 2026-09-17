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
  // Drawn here as well as on the phones. Every one of these was falling
  // through to `default`, which renders a node's CHILDREN and drops the node —
  // so a Gradient, an SVG or a scrim simply did not appear, and the window was
  // not a smaller version of the app but the app with its icons, its scrims
  // and its one button missing.
  "SVG", "Gradient", "BlurBackground", "FlipText", "Modal", "ProgressBar",
  "SwipeAction", "NeuralField",
  // The Train tab, in full. The conversation is a real repeater here now, and
  // the mic records in the page rather than through the tray's global hotkey —
  // so the refine screen is the same screen it is on a phone, not a notice
  // saying it needs an update.
  "ChatThread", "VoiceToggle", "VoiceButton",
  // The spoken session: a socket to the same transcribe stream the tray uses,
  // the same converse endpoint, and the browser's own synthesiser for the
  // reply. The phone version spends half its length on audio-session
  // categories so the reply leaves the speaker rather than the earpiece; a
  // window has neither, so none of that exists here.
  "VoiceSession",
];
// NOT declared: ScreenHoldTouches. The window does not implement it, and
// claiming a component to unlock a layout is how a capability list stops
// meaning anything. The backend reaches the same conclusion from
// `formFactor: "desktop"` and for the true reason — the flag exists because a
// scroll view steals the touches of a child being DRAGGED, and nothing here is
// dragged: the pill is a click, because a mouse has no thumb to rest.
const ACTIONS = [
  "navigate", "back", "switchTab", "callEndpoint", "setState", "toggleState",
  "toggleInArray", "refresh", "openUrl", "toast", "haptic", "sequence",
  "delay", "reloadScreen",
  // navigateBack is the important one: the catalog names it fifteen times and
  // this renderer knew only "back", so every back control in the window was
  // drawn, clickable, and did nothing.
  "navigateBack", "dismiss", "clearState", "appendState", "condition",
];

let ENV = null;          // baseUrl, fallbackToken, tone, language
let SESSION = null;      // { access_token, refresh_token, expires_at }
let BOOT = null;
let TABS = [];
let STACK = [];          // [{ screenId, params }]
/**
 * Flip lines waiting for their ticker.
 *
 * Collected while a screen renders and started once it is in the DOM —
 * rendering returns a string here, so there is no element to attach to until
 * the paint lands. Cleared on every paint so a screen that is gone cannot keep
 * turning words over in a document that no longer holds it.
 */
let FLIPS = [];
let FLIP_TIMERS = [];
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
  // The tray reads the account's tone with this, so it always has the current
  // one rather than a copy that goes stale the moment the token rotates.
  try { window.tailzuApp.token(SESSION.access_token); } catch { /* tray only */ }
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
    //
    // WIDTH IS A SEPARATE QUESTION, and it is answered by device.width below.
    // Saying "ios" was true about what this can draw and silent about how much
    // room it has, so the server laid a phone column down the middle of a
    // window. It reads the viewport now.
    platform: "ios",
    components: COMPONENTS,
    actions: ACTIONS,
    templates: [],
    device: {
      // WHAT THIS IS, as opposed to what it can draw.
      //
      // `platform` above is a drawing question and answers "iOS". This is the
      // other one: there is no keyboard extension to add here, and the
      // microphone is granted by the OS outside the app, so the two setup
      // steps have nothing to ask a window. The server used to answer
      // `onboarding_keyboard` and this file quietly threw the answer away —
      // the renderer overruling the creator. It tells the truth instead and
      // gets the right screen back.
      formFactor: "desktop",
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

/**
 * The same bootstrap, asked WITHOUT a credential.
 *
 * The gate is the one screen drawn before there is an account, so it was the
 * one screen whose words could not come from the server — leaving the sign-in
 * copy, and the theme it renders in, frozen in whatever installer you happen to
 * be running. The route takes auth as optional, so the window can simply ask as
 * a stranger and get back the theme and the chrome, with none of the user's
 * anything attached (there is no user to attach).
 *
 * Deliberately NOT sending the static fallback token. It resolves to a
 * synthetic account, and a launch that never signs in should not be billed a
 * bootstrap against somebody — even a somebody nobody is.
 */
async function bootstrapAnon() {
  const res = await fetch(ENV.baseUrl + "/v1/app/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ capabilities: capabilities(), launchCount: 1 }),
  });
  if (!res.ok) throw new Error("bootstrap → " + res.status);
  return res.json();
}
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
  // The accent was the one colour this window kept to itself — a literal in the
  // stylesheet — so the brand could be retuned on the phones and this stayed
  // the old amber, with nothing to show that it had.
  set("--accent", c.primary || c.accent);
}

/**
 * THE SERVER'S TYPOGRAPHY, HERE TOO.
 *
 * Every size, weight, tracking and colour in this window was written into this
 * file by hand, while the backend was already sending the whole system —
 * `theme.font.roles`, the same 50-odd roles the phones resolve. So the two
 * surfaces drifted by construction: retuning a heading on the phone did
 * nothing here, and nobody could see that from either side.
 *
 * A role resolves to CSS. `family: "display"` is a slot, not a face — the
 * phone maps it to a downloaded serif, and a window under a font-src 'self'
 * policy cannot fetch that, so it maps to the platform serif instead. Same
 * intent, whatever is installed.
 *
 * SCALE, because a phone column is 393pt and this one is 640. Sizes are
 * carried at a ratio rather than re-chosen, so the rhythm between them — the
 * thing that makes it read as one product — survives the change of surface.
 */
const TYPE_SCALE = 1.08;
const SERIF = 'Georgia,"Times New Roman",serif';
const SANS = '-apple-system,"Segoe UI",system-ui,sans-serif';

function role(name, extra) {
  const theme = (BOOT && BOOT.theme) || {};
  const f = theme.font || {};
  const r = (f.roles && f.roles[name]) || null;
  if (!r) return extra || "";
  const c = theme.color || {};
  const out = [];
  const px = (v) => Math.round(v * TYPE_SCALE * 10) / 10 + "px";
  if (r.size != null) out.push("font-size:" + px(r.size));
  if (r.weight) out.push("font-weight:" + r.weight);
  if (r.lineHeight != null) out.push("line-height:" + px(r.lineHeight));
  if (r.letterSpacing != null) out.push("letter-spacing:" + r.letterSpacing + "px");
  if (r.italic) out.push("font-style:italic");
  if (r.transform) out.push("text-transform:" + r.transform);
  if (r.align) out.push("text-align:" + r.align);
  if (r.color) out.push("color:" + (c[r.color] || r.color));
  out.push("font-family:" + (r.family === "display" ? SERIF : SANS));
  if (r.marginTop != null) out.push("margin-top:" + r.marginTop + "px");
  if (r.marginBottom != null) out.push("margin-bottom:" + r.marginBottom + "px");
  if (r.marginVertical != null) {
    out.push("margin-top:" + r.marginVertical + "px", "margin-bottom:" + r.marginVertical + "px");
  }
  return out.join(";") + (extra ? ";" + extra : "");
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
      return '<h2 style="margin:0;' + role("heading", "color:var(--text)") + ";" + s + '">' + txt + "</h2>";

    case "Hero":
      return '<div style="margin-bottom:16px"><div style="' + role("h1", "color:var(--text)") + '">' +
        esc(label(p.title)) + '</div><div style="margin-top:4px;' + role("muted") + '">' +
        esc(label(p.subtitle)) + "</div></div>";

    case "Overline":
      return '<div style="' + role("overline", "color:var(--label)") + ";" + s + '">' + txt + "</div>";

    case "Paragraph": case "Quote":
      return '<p style="margin:0;' + role(n.type === "Quote" ? "quoteBlock" : "paragraph", "color:var(--body)") +
        ";" + s + '">' + txt + "</p>";

    case "Text":
      // `variant` names a role — the same switch the phone makes.
      return '<span' + bind(press) + ' style="' + role(p.variant || "body", "color:var(--text)") + ";" +
        (press ? "cursor:pointer;" : "") + s + '">' + txt + "</span>";

    case "Badge": case "Chip":
      return '<span' + bind(press) + ' style="display:inline-block;border:1px solid var(--border);border-radius:999px;' +
        'padding:5px 11px;' + role(n.type === "Badge" ? "badge" : "chip", "color:var(--body)") + ";" + (press ? "cursor:pointer;" : "") + s + '">' + txt + "</span>";

    case "Button": {
      const primary = p.variant !== "secondary" && p.variant !== "ghost";
      return '<button' + bind(press) + ' style="display:block;width:100%;border:0;cursor:pointer;' +
        (primary ? "background:var(--accent);color:#000" : "background:transparent;color:var(--text);border:1px solid var(--border)") +
        ';border-radius:14px;padding:14px 18px;margin:6px 0;' + role(primary ? "button" : "buttonSecondary") + ";" + s + '">' +
        (txt || "Continue") + "</button>";
    }

    case "Row2": case "KeyValue":
      return '<div' + bind(press) + ' style="display:flex;justify-content:space-between;gap:14px;padding:12px 0;' +
        "border-bottom:1px solid var(--border)" + (press ? ";cursor:pointer" : "") + '">' +
        '<span style="' + role("row", "color:var(--label)") + '">' + esc(label(p.label)) + "</span>" +
        '<span style="' + role("rowValue", "color:var(--text)") + '">' + esc(label(p.value)) + "</span></div>";

    case "StatCard":
      return '<div style="background:var(--card);border-radius:14px;padding:15px;flex:1;min-width:0;' + s + '">' +
        '<div style="' + role("label", "color:var(--label);text-transform:uppercase") + '">' + esc(label(p.label)) + "</div>" +
        '<div style="margin-top:5px;' + role("h1", "color:var(--text)") + '">' + esc(p.value) + "</div></div>";

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
      // The PARENT usually owns the box. A hero is a Stack carrying the aspect
      // ratio and the clipping, holding a media node whose only instruction is
      // "fill me" — so a percentage has to survive as a percentage. Appending
      // "px" to it produced `height:100%px`, which the browser drops, and the
      // fallback 160px then collapsed a full-bleed hero into a strip.
      const dim = (v, fb) => (v == null ? fb : typeof v === "number" ? v + "px" : String(v));
      const fills = String(st.height) === "100%";
      const box =
        "width:" + dim(st.width, "100%") + ";" +
        (st.aspectRatio ? "aspect-ratio:" + st.aspectRatio + ";"
                        : "height:" + dim(st.height, "160px") + ";") +
        "min-height:0;" +
        // Filling a parent means the parent draws the corners and the spacing.
        "border-radius:" + (st.borderRadius != null ? st.borderRadius : fills ? 0 : 16) + "px;" +
        "object-fit:" + (p.contentFit === "contain" ? "contain" : "cover") + ";" +
        "display:block;" + (fills ? "margin:0;" : "margin:0 auto 14px;");
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

    // ---- what the phones draw that a window can draw too -----------------
    //
    // These were all falling through to `default`, which renders a node's
    // CHILDREN and drops the node itself. For a Gradient or an SVG that means
    // nothing appears at all; for the greeting it meant no word; for the way
    // into training it meant no control. The desktop was not a smaller version
    // of the app, it was the app with its scrims, its icons, its chevrons and
    // its one button missing.

    case "SVG": {
      // One path, viewBox and all, straight through. Every chevron, arrow,
      // cross and tab glyph in the catalog is one of these.
      const vb = esc(p.viewBox || "0 0 24 24");
      const fill = p.fill && p.fill !== "none" ? esc(tok(p.fill)) : "none";
      const stroke = p.stroke ? esc(tok(p.stroke)) : "none";
      return '<svg viewBox="' + vb + '" style="' + s + ';display:block" ' +
        'fill="' + fill + '" stroke="' + stroke + '" ' +
        'stroke-width="' + (Number(p.strokeWidth) || 2) + '" ' +
        'stroke-linecap="' + esc(p.strokeLinecap || "round") + '" ' +
        'stroke-linejoin="' + esc(p.strokeLinejoin || "round") + '">' +
        '<path d="' + esc(p.d || "") + '"></path></svg>';
    }

    case "Gradient": {
      const cols = (p.colors || []).map((c) => tok(c));
      const locs = p.locations || [];
      const stops = cols.map((c, i) =>
        esc(c) + (locs[i] != null ? " " + Math.round(locs[i] * 100) + "%" : "")).join(",");
      const dir = p.direction === "horizontal" ? "to right" : "to bottom";
      return '<div style="' + s + ';background:linear-gradient(' + dir + "," + stops + ')"></div>';
    }

    case "BlurBackground":
      // A real backdrop blur — the one thing a browser does better than the
      // phones, and for free.
      return '<div style="' + s + ';backdrop-filter:blur(' +
        Math.round((Number(p.intensity) || 60) / 3) + 'px);-webkit-backdrop-filter:blur(' +
        Math.round((Number(p.intensity) || 60) / 3) + 'px)">' + kids + "</div>";

    case "ProgressBar":
      return '<div style="' + s + ';height:3px;border-radius:2px;background:var(--border);overflow:hidden">' +
        '<div class="tz-indet" style="height:100%;background:var(--accent)"></div></div>';

    case "FlipText": {
      // The greeting. Same words, same interval, same idea — one turns into
      // the next and nothing else on the line moves.
      const words = (p.words || []).map((w) => esc(String(w)));
      if (!words.length) return "";
      const id = "flip" + (node._n = (node._n || 0) + 1);
      FLIPS.push({ id: id, words: words, ms: Math.max(900, Number(p.intervalMs) || 2600) });
      return '<span id="' + id + '" style="' + s + ';transition:opacity .25s">' + words[0] + "</span>";
    }

    case "Modal":
      // Open state lives in the screen's own state, exactly as on the phone.
      if (!truthy(stateAt((n.bind && n.bind.open) || ""))) return "";
      return '<div class="tz-modal"><div class="tz-sheet" style="' + s + '">' + kids + "</div></div>";

    case "SwipeAction": {
      // THE WAY IN. On a phone it is dragged, because a live microphone
      // deserves a held intention. A mouse has no thumb to rest, so here it is
      // the same object as a button — same label, same colours, same amber far
      // end — and a click commits it. The gesture was never the point; the
      // deliberateness was, and a click on a pill this size is deliberate.
      const h = Number(p.height) || 58;
      return '<button class="tz-press" data-ev="onComplete" style="' + s +
        ";position:relative;height:" + h + "px;border-radius:" + (Number(p.radius) || 999) + "px" +
        ";background:" + esc(tok(p.background || "#0B0B0D")) +
        ";border:" + (p.borderWidth ? p.borderWidth + "px solid " + esc(tok(p.borderColor)) : "none") +
        ";color:" + esc(tok(p.color || "#fff")) +
        ";font-size:" + (Number(p.fontSize) || 12) + "px;font-weight:" + (p.weight || 700) +
        ";letter-spacing:" + (Number(p.tracking) || 1.8) + 'px;width:100%;cursor:pointer">' +
        esc(label(p.label || "")) +
        '<span style="position:absolute;right:6px;top:50%;transform:translateY(-50%);width:' +
        (Number(p.disc) || 46) + "px;height:" + (Number(p.disc) || 46) +
        "px;border-radius:50%;background:" + esc(tok(p.targetBackground || "#C9862B")) +
        ';opacity:.45"></span></button>';
    }

    case "NeuralField": {
      // The page it draws is HTML and canvas. This IS a browser — it needs no
      // bridge, no WebView and no stand-in; the same file the phone loads
      // renders here natively.
      //
      // WITH THE SAME NUMBERS. It used to load the file bare, and the file is
      // generated with `growth` absent — which the page reads as 1. So the
      // window drew a fully grown network for everybody, on day one and month
      // six alike, and the claim this screen makes (that the thing inside gets
      // bigger every time you talk to it) was false in the one place it is
      // visible. alpha went the same way: the field sat at full strength on a
      // screen that wanted it dimmed behind the copy.
      //
      // Those two are per screen and per person; everything else in the page's
      // config is geometry and identical everywhere. So they travel in the
      // query string and the rest stays baked.
      const q = "?alpha=" + encodeURIComponent(Number(p.alpha != null ? p.alpha : 1)) +
        "&growth=" + encodeURIComponent(Number(p.growth != null ? p.growth : 1));
      FIELD_BINDS = n.bind || null;
      FIELD_PROPS = p;
      // A PLACEHOLDER, not the iframe itself. Every repaint replaces this
      // view's innerHTML, and an iframe written into that string is a NEW
      // iframe: the page reloads, forty thousand curves are baked again, and
      // the animation restarts from nothing. The Train tab repaints on every
      // phase of a live session, so the one screen where the field is supposed
      // to react was the one screen where it kept starting over.
      //
      // The real iframe is created once and moved in here after each paint.
      return '<div data-field="' + esc(q) + '" class="tz-field" style="' + s + '"></div>';
    }

    // THE CONVERSATION. SDUI has no repeater, so the Train tab's thread is one
    // node that reads an array out of state and draws it — the same contract
    // the phones implement, and the reason the server can append a row and
    // have both surfaces show it.
    //
    // This window used to fall through to `default` and draw the node's
    // fallback: a line saying the conversation needed an update, on a build
    // that was perfectly capable of holding one.
    case "ChatThread":
      return chatThread(n, p, s);

    // The mic, in the page. Not the tray's: that one records globally and
    // pastes into whatever app has focus, which is the wrong verb entirely for
    // a control that is supposed to fill the field beside it. The window has
    // its own microphone permission, so it records here and writes the
    // transcript into the bound path, exactly as the phones do.
    //
    // VoiceToggle and VoiceButton differ on the phones by how they are held.
    // A mouse has no hold, so both are a click, and the catalog's fallback
    // from one to the other costs nothing.
    case "VoiceToggle":
    case "VoiceButton":
      return voiceButton(n, p, s);

    // The spoken session. Renders nothing — it owns the audio loop and writes
    // what it knows into the screen's state, so everything around it stays
    // ordinary backend JSON. Started on the first paint that contains it.
    case "VoiceSession":
      startSession(n);
      return "";

    // Everything the phones draw natively and this window has no business
    // imitating — the keyboard preview (there is no keyboard to configure
    // here), the mic toggle and the spoken session (this app records through
    // its own tray hotkey, not an in-page control). Their children still
    // render, so a card built around one is not lost, and a node that shipped
    // a fallback gets it — the same rule the phone renderer follows, so the
    // server can keep emitting one tree for both.
    default:
      return kids || (n.fallback ? node(n.fallback) : "");
  }
}

/**
 * The Train tab's conversation.
 *
 * Every visual value is a prop with a default, so the server moves all of it
 * without a build — the same rule the phone component follows, and the reason
 * `colors` can arrive half-filled and still land.
 *
 * Rows, whatever the server appended:
 *   { role: "ask",      text }            what the app asked
 *   { role: "mine",     text }            what the user answered
 *   { role: "note",     text }            a centred aside ("Learned: dry")
 *   { role: "variants", options: [...] }  three readings to choose between
 */
const CHAT_D = {
  askBg: "rgba(255,255,255,0.06)", askBorder: "rgba(255,255,255,0.09)",
  askText: "rgba(255,255,255,0.9)", mineBg: "#FFFFFF", mineText: "#000000",
  noteText: "#E8A23C", noteBg: "rgba(232,162,60,0.1)", noteBorder: "rgba(232,162,60,0.26)",
  variantBg: "rgba(255,255,255,0.05)", variantBorder: "rgba(255,255,255,0.1)",
  variantText: "rgba(255,255,255,0.92)", angleText: "rgba(255,255,255,0.4)",
  pickedBg: "rgba(232,162,60,0.13)", pickedBorder: "#E8A23C",
  labelText: "rgba(255,255,255,0.38)", radius: 16, gap: 11,
};

/** Which option was taken in which row, for the screen currently painted.
 *  Keyed by row index: a thread only ever grows, so an index is stable. */
let CHAT_PICKED = {};

function chatThread(n, p, s) {
  const c = { ...CHAT_D, ...(p.colors || {}) };
  const rows = (() => { const r = stateAt((n.bind && n.bind.thread) || ""); return Array.isArray(r) ? r : []; })();
  const pickLabel = label(p.pickLabel) || "Tap the one that sounds like you";

  const bubble = (r, i) => {
    if (r.role === "mine") {
      return '<div style="align-self:flex-end;max-width:82%;background:' + esc(tok(c.mineBg)) +
        ";padding:10px 14px;border-radius:" + c.radius + "px;border-bottom-right-radius:5px" +
        ';font-size:14.5px;line-height:21px;color:' + esc(tok(c.mineText)) + '">' + esc(r.text || "") + "</div>";
    }
    if (r.role === "note") {
      return '<div style="align-self:center;background:' + esc(tok(c.noteBg)) + ";border:1px solid " +
        esc(tok(c.noteBorder)) + ";border-radius:999px;padding:5px 11px;font-size:11px;letter-spacing:.5px;color:" +
        esc(tok(c.noteText)) + '">' + esc(r.text || "") + "</div>";
    }
    if (r.role === "variants") {
      const options = Array.isArray(r.options) ? r.options.filter((o) => o && o.text) : [];
      if (!options.length) return "";
      const chose = CHAT_PICKED[i];
      const opts = options.map((o, j) => {
        const isPicked = chose === j;
        const dimmed = chose != null && !isPicked;
        return '<button class="tz-press" data-pick="' + i + ":" + j + '"' +
          (chose != null ? " disabled" : "") +
          ' style="display:block;width:100%;text-align:left;cursor:' + (chose != null ? "default" : "pointer") +
          ";background:" + esc(tok(isPicked ? c.pickedBg : c.variantBg)) +
          ";border:1px solid " + esc(tok(isPicked ? c.pickedBorder : c.variantBorder)) +
          ";border-radius:14px;padding:11px 13px;opacity:" + (dimmed ? ".3" : "1") + '">' +
          (o.angle
            ? '<div style="font-size:10px;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;color:' +
              esc(tok(isPicked ? c.pickedBorder : c.angleText)) + '">' + esc(o.angle) + "</div>"
            : "") +
          '<div style="font-size:14px;line-height:21px;color:' + esc(tok(c.variantText)) + '">' +
          esc(o.text) + "</div></button>";
      }).join("");
      return '<div style="display:flex;flex-direction:column;gap:7px">' +
        '<div style="font-size:10.5px;letter-spacing:1.4px;text-transform:uppercase;color:' +
        esc(tok(c.labelText)) + '">' + esc(r.label || pickLabel) + "</div>" + opts + "</div>";
    }
    // Anything else is something the app said.
    return '<div style="align-self:flex-start;max-width:88%;background:' + esc(tok(c.askBg)) +
      ";border:1px solid " + esc(tok(c.askBorder)) + ";padding:12px 14px;border-radius:" + c.radius +
      "px;border-bottom-left-radius:5px;font-size:14.5px;line-height:22px;color:" +
      esc(tok(c.askText)) + '">' + esc(r.text || "") + "</div>";
  };

  return '<div data-chat="1" style="' + s + ";flex:1;min-height:0;overflow-y:auto;display:flex" +
    ";flex-direction:column;gap:" + c.gap + 'px;padding-bottom:10px">' +
    rows.map(bubble).join("") + "</div>";
}

/**
 * The in-page microphone.
 *
 * Click to start, click again to stop. The clip goes to the same
 * /v1/transcribe-clean the tray uses, the text is written into the bound path,
 * and `onChange` fires — which is the moment the server's action refines it.
 * A failure fires `onError` with the real reason, because a permission denial
 * and a dead connection are not the same problem and must not read alike.
 */
let MIC = null;   // { rec, stream, path, node } while a capture is open

function voiceButton(n, p, s) {
  const size = Number(p.size) || 44;
  const on = !!(MIC && MIC.path === ((n.bind && n.bind.value) || ""));
  return '<button class="tz-press" data-mic="' + esc((n.bind && n.bind.value) || "") + '"' +
    ' aria-pressed="' + on + '" title="' + (on ? "Stop and transcribe" : "Record") + '"' +
    ' style="' + s + ";flex:none;width:" + size + "px;height:" + size + "px;border-radius:50%;cursor:pointer" +
    ";border:0;display:flex;align-items:center;justify-content:center;background:" +
    esc(tok(on ? "#e0556b" : (p.background || "#E8A23C"))) + '">' +
    // A filled circle while live, the mic glyph at rest. Drawn rather than
    // loaded: the phones use an uploaded icon, and a window that waited on
    // that upload would show an empty button until somebody made one.
    (on
      ? '<span style="width:' + Math.round(size * 0.34) + "px;height:" + Math.round(size * 0.34) +
        'px;border-radius:3px;background:#fff"></span>'
      : '<svg width="' + Math.round(size * 0.46) + '" height="' + Math.round(size * 0.46) +
        '" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round">' +
        '<rect x="9" y="2" width="6" height="12" rx="3" fill="#000" stroke="none"/>' +
        '<path d="M5 11a7 7 0 0 0 14 0M12 18v4"/></svg>') +
    "</button>";
}

async function micStart(path, n) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]
    .find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    MIC = null;
    try {
      if (!chunks.length) throw new Error("no audio captured");
      const type = rec.mimeType || "audio/webm";
      const fd = new FormData();
      fd.append("audio", new Blob(chunks, { type }), "audio." + (type.indexOf("ogg") !== -1 ? "ogg" : "webm"));
      fd.append("targetApp", "Desktop");
      fd.append("language", String(n.props?.language || "auto"));
      const res = await fetch(ENV.baseUrl + "/v1/transcribe-clean", {
        method: "POST",
        headers: { Authorization: "Bearer " + (await bearer()) },
        body: fd,
      });
      if (!res.ok) throw new Error("transcribe → " + res.status);
      const j = await res.json();
      const text = String(j.cleanedText || j.transcript || j.text || "").trim();
      if (!text) throw new Error("no speech detected");
      if (path) setStatePath(path, text);
      repaint();
      const ch = n.on && n.on.onChange;
      if (ch) await run(ch, text);
    } catch (err) {
      repaint();
      const eh = n.on && n.on.onError;
      const msg = (err && err.message) ? err.message : String(err);
      if (eh) await run(eh, msg); else toast(msg);
    }
  };
  rec.start();
  MIC = { rec, stream, path, node: n };
  repaint();
}

/**
 * A SPOKEN CONVERSATION, the same loop the phones run.
 *
 * Renders nothing. It owns the audio and writes what it knows into the screen's
 * state, so the screen around it stays ordinary backend JSON — a bubble bound
 * to `level`, a line bound to `line`, a button that posts `$state.turns`.
 *
 * One turn at a time:
 *
 *   listening   a socket to /v1/transcribe-stream fills in text as you talk.
 *               A pause of silenceMs with something said ends the turn, and
 *               the mic closes — it must be shut while the app talks, or it
 *               transcribes its own voice.
 *   thinking    the conversation so far goes to `path`; a reply comes back.
 *   speaking    the browser says it. When it finishes, listening resumes.
 *
 * Turn-based, not full duplex — you cannot talk over it — which is the same
 * limit the phones have, for the same reason.
 *
 * The phone version spends half its length on AVAudioSession categories, so
 * the reply comes out of the speaker rather than the earpiece. A window has no
 * earpiece and no categories, and all of that simply does not exist here.
 */
const LEVEL_TICK_MS = 90, LEVEL_ON_SPEECH = 0.8, LEVEL_FLOOR = 0.15, LEVEL_DECAY = 0.86;

let SESSION_RUN = null;   // the live loop, or null

function startSession(n) {
  if (SESSION_RUN) return;                 // already running for this screen
  const p = deepResolve(n.props || {});
  const r = {
    alive: true,
    endpoint: String(p.path || "/v1/train/converse"),
    silenceMs: Math.max(600, Number(p.silenceMs) || 1500),
    maxTurns: Math.max(2, Number(p.maxTurns) || 40),
    language: p.language ? String(p.language) : "auto",
    statePath: String(p.statePath || "sessionState"),
    levelPath: String(p.levelPath || "level"),
    linePath: String(p.linePath || "line"),
    turnsPath: String(p.turnsPath || "turns"),
    node: n, turns: [], committed: "", partial: "",
    ws: null, stream: null, ctx: null, proc: null, src: null,
    decay: null, silence: null, level: 0,
  };
  SESSION_RUN = r;

  const put = (path, v) => { if (path) setStatePath(path, v); };
  const setState_ = (v) => { put(r.statePath, v); repaint(); };
  const setLevel = (v) => { r.level = v; put(r.levelPath, v); };
  const say = (role, text) => {
    r.turns = r.turns.concat([{ role, text }]);
    put(r.turnsPath, r.turns);
    put(r.linePath, text);
    repaint();
  };
  const fail = (m) => {
    if (!r.alive) return;
    teardown(r);
    setState_("error");
    const eh = n.on && n.on.onError;
    if (eh) void run(eh, m); else toast(m);
  };

  const armSilence = () => {
    clearTimeout(r.silence);
    r.silence = setTimeout(() => {
      const said = (r.committed + " " + r.partial).trim();
      // A pause with nothing in it is a pause, not a turn. Keep listening.
      if (!said) { armSilence(); return; }
      closeMic(r);
      say("user", said);
      void respond();
    }, r.silenceMs);
  };
  const heard = () => { setLevel(LEVEL_ON_SPEECH); armSilence(); };

  async function listen() {
    if (!r.alive) return;
    if (r.turns.length >= r.maxTurns * 2) { setState_("idle"); setLevel(0); return; }
    r.committed = ""; r.partial = "";
    setState_("listening");
    setLevel(LEVEL_FLOOR);
    // The level has no amplitude behind it — the socket hands over text, not
    // PCM. So it rises on the arrival of words and decays between them, which
    // is a true signal about speech even though it is not loudness.
    r.decay = setInterval(() => {
      if (r.level > LEVEL_FLOOR) setLevel(Math.max(LEVEL_FLOOR, r.level * LEVEL_DECAY));
    }, LEVEL_TICK_MS);
    try {
      r.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (!r.alive) { closeMic(r); return; }
      const token = await bearer();
      r.ws = new WebSocket(ENV.baseUrl.replace(/^http/, "ws") + "/v1/transcribe-stream");
      r.ws.binaryType = "arraybuffer";
      // A browser socket cannot set an Authorization header; the protocol
      // carries the token in the start frame, which the server accepts.
      r.ws.onopen = () => r.ws && r.ws.send(JSON.stringify({
        type: "start", token, targetApp: "Desktop", language: r.language,
        sampleRate: 16000, encoding: "pcm_s16le", channels: 1,
      }));
      r.ws.onmessage = (ev) => {
        if (!r.alive) return;
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === "partial") { r.partial = m.text || ""; heard(); }
        else if (m.type === "final") {
          if (m.text && m.text.trim()) r.committed = (r.committed + " " + m.text.trim()).trim();
          r.partial = ""; heard();
        } else if (m.type === "error") fail(m.message || "The microphone stopped.");
      };
      r.ws.onerror = () => { /* onclose follows */ };
      r.ctx = new AudioContext();
      r.src = r.ctx.createMediaStreamSource(r.stream);
      r.proc = r.ctx.createScriptProcessor(4096, 1, 1);
      r.src.connect(r.proc);
      r.proc.connect(r.ctx.destination);
      const inRate = r.ctx.sampleRate;
      r.proc.onaudioprocess = (e) => {
        if (!r.alive || !r.ws || r.ws.readyState !== 1) return;
        r.ws.send(pcm16k(e.inputBuffer.getChannelData(0), inRate));
      };
      armSilence();
    } catch (err) {
      fail(err && err.name === "NotAllowedError"
        ? "microphone blocked — allow it in your system settings"
        : ((err && err.message) ? err.message : "Couldn't start listening."));
    }
  }

  async function respond() {
    if (!r.alive) return;
    setState_("thinking");
    setLevel(0.12);
    try {
      const res = await api(r.endpoint, { turns: r.turns, language: r.language });
      if (!r.alive) return;
      const reply = String((res && res.reply) || "").trim();
      if (!reply) { void listen(); return; }
      say("assistant", reply);
      setState_("speaking");
      setLevel(0.5);
      speak(reply, () => { if (r.alive) void listen(); });
    } catch (err) {
      fail((err && err.message) ? err.message : "Couldn't reach the conversation.");
    }
  }

  /** Out loud, then back to listening. A browser with no voices installed
   *  resolves immediately rather than hanging the loop on an utterance that
   *  will never fire `onend`. */
  function speak(text, done) {
    try {
      const synth = window.speechSynthesis;
      if (!synth) { done(); return; }
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      if (r.language && r.language !== "auto") u.lang = r.language;
      u.onend = done;
      u.onerror = done;
      synth.speak(u);
      // Some engines drop an utterance silently. A ceiling proportional to the
      // reply keeps a dead synthesiser from ending the conversation.
      setTimeout(() => { if (r.alive && stateAt(r.statePath) === "speaking") done(); },
        Math.min(30000, 2000 + text.length * 90));
    } catch { done(); }
  }

  void listen();
}

/** Close the microphone and its socket, leaving the loop able to open another. */
function closeMic(r) {
  clearInterval(r.decay); r.decay = null;
  clearTimeout(r.silence); r.silence = null;
  try { r.proc && (r.proc.onaudioprocess = null, r.proc.disconnect()); } catch {}
  try { r.src && r.src.disconnect(); } catch {}
  try { r.ctx && r.ctx.close(); } catch {}
  r.proc = r.src = r.ctx = null;
  if (r.ws) { r.ws.onmessage = r.ws.onclose = r.ws.onerror = null; try { r.ws.close(); } catch {} r.ws = null; }
  if (r.stream) { r.stream.getTracks().forEach((t) => t.stop()); r.stream = null; }
}

/** End the conversation for good. Called when the screen goes away — a loop
 *  that outlives its screen keeps a live microphone open behind a window the
 *  user believes they have left. */
function stopSession() {
  if (!SESSION_RUN) return;
  SESSION_RUN.alive = false;
  closeMic(SESSION_RUN);
  try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch {}
  SESSION_RUN = null;
}

/** Float samples at the device rate → 16 kHz signed 16-bit, which is what the
 *  transcribe socket expects. Linear interpolation; the same routine the tray
 *  recorder uses, so both paths sound identical to the server. */
function pcm16k(f32, inRate) {
  const ratio = inRate / 16000;
  const outLen = Math.floor(f32.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const idx = i * ratio, i0 = Math.floor(idx), i1 = Math.min(i0 + 1, f32.length - 1);
    const frac = idx - i0;
    let v = f32[i0] * (1 - frac) + f32[i1] * frac;
    v = Math.max(-1, Math.min(1, v));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out.buffer;
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

/** What the control that fired the current action handed over.
 *
 *  The catalog writes "$event" where a handler needs it — the transcript a mic
 *  produced, the error a session raised — and this window resolved it to the
 *  literal string "$event". So a failed dictation toasted the word "$event" at
 *  the user instead of saying what went wrong. */
let EVENT = undefined;

function resolveValue(v) {
  if (typeof v === "string" && v.indexOf("$state.") === 0) return stateAt(v.slice(7));
  if (v === "$event") return EVENT;
  return v;
}

async function run(action, eventValue) {
  if (!action) return;
  if (arguments.length > 1) EVENT = eventValue;
  if (typeof action === "string") return run((CURRENT_ACTIONS || {})[action], ...(arguments.length > 1 ? [eventValue] : []));
  switch (action.kind) {
    case "navigate": go(action.screenId, action.params); return;
    // TWO NAMES FOR ONE THING, and only one was answered. The catalog says
    // "navigateBack" — fifteen times, on every back control in the four inside
    // screens — and this understood only "back". So every one of those arrows
    // was drawn, was clickable, and did nothing; an action this switch does not
    // know falls through in silence, which is how it stayed invisible.
    case "back": case "navigateBack": case "dismiss": back(); return;
    case "switchTab": switchTab(action.tabId); return;
    case "reloadScreen": case "refresh": await paint(true); return;
    case "setState": setStatePath(action.path, resolveValue(action.value)); repaint(); return;
    case "clearState": setStatePath(action.path, undefined); repaint(); return;
    case "appendState": {
      const cur = stateAt(action.path);
      const arr = Array.isArray(cur) ? cur.slice() : [];
      arr.push(resolveValue(action.value));
      setStatePath(action.path, arr);
      repaint();
      return;
    }
    // The same evaluator the tree's visibleIf uses, so a condition means the
    // same thing whether it gates a node or an action.
    case "condition": {
      const branch = visible(action.if) ? action.then : action.else;
      if (branch) await run(branch);
      return;
    }
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
        if (action.method && action.method.toUpperCase() !== "GET") {
          // Any write could have been the tone. Telling the tray to re-read is
          // cheaper, and more honest, than guessing which writes matter.
          try { window.tailzuApp.changed(); } catch { /* tray only */ }
          await paint(true);
        }
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
  // A LOOP THAT OUTLIVES ITS SCREEN HOLDS A LIVE MICROPHONE BEHIND A WINDOW
  // THE USER BELIEVES THEY HAVE LEFT. Ended here, before the next screen can
  // start one of its own.
  stopSession();
  if (MIC) { try { MIC.rec.stop(); } catch {} MIC = null; }
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
  // Picks belong to the thread that was on screen. A new screen has none.
  CHAT_PICKED = {};
  CURRENT_ACTIONS = screen.actions || {};
  $("title").textContent = label(screen.title) || "";
  $("back").hidden = STACK.length <= 1;
  repaint(screen);
}

/** First node in the tree carrying this event, and the action it names. */
/** Find a node by type anywhere in a tree. The chat and the mic need their own
 *  node back — for the paths the server named on it, and for its handlers —
 *  and the renderer returns strings, so there is nothing to close over. */
function findNode(n, type) {
  if (!n || typeof n !== "object") return null;
  if (n.type === type) return n;
  for (const c of n.children || []) { const r = findNode(c, type); if (r) return r; }
  return null;
}

/**
 * Picking a variant.
 *
 * Handled here rather than by the server, for the same reason the phones
 * handle it locally: the click has to answer instantly and a round trip
 * cannot. The choice is written to paths the SERVER names, then `onSelect`
 * fires — so the server still decides what a pick MEANS, it just does not have
 * to be present for the row to respond.
 */
function wireChat(view, sc) {
  const host = view.querySelector("[data-chat]");
  if (!host) return;
  const n = findNode(sc.root, "ChatThread");
  if (!n) return;
  const p = deepResolve(n.props || {});
  const rows = (() => { const r = stateAt((n.bind && n.bind.thread) || ""); return Array.isArray(r) ? r : []; })();

  view.querySelectorAll("[data-pick]").forEach((el) => {
    el.addEventListener("click", async () => {
      const [i, j] = el.getAttribute("data-pick").split(":").map(Number);
      const options = (rows[i] && rows[i].options || []).filter((o) => o && o.text);
      const taken = options[j];
      if (!taken) return;
      // Snapshot in the order the server's pick endpoint expects: what was
      // taken, then the two that were not.
      const others = options.filter((_, k) => k !== j);
      setStatePath(String(p.chosenPath || "_chosen"), taken.text || "");
      setStatePath(String(p.anglePath || "_angle"), taken.angle || "");
      setStatePath(String(p.rejectedAPath || "_rejA"), (others[0] && others[0].text) || "");
      setStatePath(String(p.rejectedBPath || "_rejB"), (others[1] && others[1].text) || "");
      CHAT_PICKED[i] = j;
      repaint();
      if (n.on && n.on.onSelect) await run(n.on.onSelect, taken.text || "");
    });
  });

  // A new row below the fold is a row nobody sees. After the paint, so the
  // rows have measured — scrolling before that lands short.
  requestAnimationFrame(() => { host.scrollTop = host.scrollHeight; });
}

/**
 * THE FIELD IS TOLD WHAT THE SCREEN IS DOING, and it only runs when somebody
 * is looking at it.
 *
 * Both were missing here. The iframe was loaded and then left alone, so the
 * network never reacted to a live session — it pulsed the same idle pattern
 * while the user was mid-sentence, where the phone's leans toward the centre
 * on "listening" and outward on "speaking". And it kept drawing at sixty
 * frames a second behind a window that had been put away, which on a tray app
 * is most of its life.
 *
 * The page takes both over the same channel the phones use: postMessage into
 * `window.tz`. Same message names, same quantising of the level — twenty steps
 * is finer than the eye and turns sixty messages a second into a trickle.
 */
let FIELD_BINDS = null;   // { state, level, training } paths the server named
let FIELD_PROPS = null;
let FIELD_LAST = "";

let FIELD_EL = null;      // the one iframe, kept across paints

function fieldSend(msg) {
  if (!FIELD_EL || !FIELD_EL.contentWindow) return;
  try { FIELD_EL.contentWindow.postMessage(msg, "*"); } catch { /* not loaded yet */ }
}

/** Whatever the screen currently says, in the page's vocabulary. */
function fieldState() {
  const b = FIELD_BINDS || {};
  const p = FIELD_PROPS || {};
  const at = (key) => (b[key] ? stateAt(b[key]) : p[key]);
  const lvl = Math.min(1, Math.max(0, Number(at("level")) || 0));
  return {
    state: String(at("state") || "idle"),
    level: Math.round(lvl * 20) / 20,
    training: at("training") === true || at("training") === "true",
  };
}

function wireField(view) {
  const slot = view.querySelector("[data-field]");
  if (!slot) {
    // The screen that owned it is gone. Drop the iframe with it rather than
    // keep a canvas alive for a screen nobody is on.
    if (FIELD_EL) { try { FIELD_EL.remove(); } catch {} FIELD_EL = null; }
    FIELD_BINDS = FIELD_PROPS = null; FIELD_LAST = "";
    return;
  }
  const q = slot.getAttribute("data-field") || "";
  // Reuse only when it is the same field. A different alpha or growth is a
  // different drawing — both are baked when the page loads — so that one does
  // reload, which is right: it is a change, not a repaint.
  if (FIELD_EL && FIELD_EL.dataset.q !== q) { try { FIELD_EL.remove(); } catch {} FIELD_EL = null; }
  if (!FIELD_EL) {
    // MOUNTED ONCE, OUTSIDE THE VIEW, AND NEVER MOVED.
    //
    // Reparenting an iframe reloads the document inside it in every browser
    // that matters, so "keep it and move it into the new markup" is the same
    // reload by another name. It lives beside the view instead, as a layer,
    // and the paint only tells it where to be.
    FIELD_EL = document.createElement("iframe");
    FIELD_EL.dataset.q = q;
    FIELD_EL.setAttribute(
      "style",
      "position:absolute;border:0;background:#000;pointer-events:none;z-index:0",
    );
    FIELD_EL.addEventListener("load", () => {
      FIELD_LAST = "";
      push();
      fieldSend({ run: !document.hidden });
    });
    FIELD_EL.src = "neuralField.html" + q;
    // FIRST child of #main, so it paints under #view (which carries z-index:1).
    // The field is the art behind the copy; appended last it would cover the
    // title and the button it exists to sit behind.
    const host = view.parentElement || document.body;
    host.insertBefore(FIELD_EL, host.firstChild);
  }
  place();

  /** Sit exactly where this paint put the slot. Measured against the layer's
   *  offset parent, so scrolling the view carries the field with it. */
  function place() {
    const host = FIELD_EL.offsetParent || document.body;
    const a = slot.getBoundingClientRect(), b = host.getBoundingClientRect();
    FIELD_EL.style.left = (a.left - b.left) + "px";
    FIELD_EL.style.top = (a.top - b.top) + "px";
    FIELD_EL.style.width = a.width + "px";
    FIELD_EL.style.height = a.height + "px";
    // A slot with no size yet means the paint has not laid out. Stay hidden
    // rather than flash a black rectangle in the corner.
    FIELD_EL.style.visibility = a.width && a.height ? "visible" : "hidden";
  }

  function push() {
    const msg = fieldState();
    const key = JSON.stringify(msg);
    if (key === FIELD_LAST) return;      // nothing changed; do not wake the page
    FIELD_LAST = key;
    fieldSend(msg);
  }
  push();

  // The slot moves when the view scrolls or the window is resized, and the
  // layer is not in the flow, so it has to be told. Replaced on every paint so
  // a listener never outlives the slot it measures.
  if (FIELD_TRACK) FIELD_TRACK();
  const onMove = () => place();
  view.addEventListener("scroll", onMove, { passive: true });
  window.addEventListener("resize", onMove);
  FIELD_TRACK = () => {
    view.removeEventListener("scroll", onMove);
    window.removeEventListener("resize", onMove);
    FIELD_TRACK = null;
  };
  requestAnimationFrame(place);   // after layout has settled
}
let FIELD_TRACK = null;

// A tray app spends most of its life put away. The page stops its loop outright
// and resumes where it was — the field is a simulation of state, not a
// timeline, so a pause costs it nothing.
document.addEventListener("visibilitychange", () => fieldSend({ run: !document.hidden }));

function wireMic(view, sc) {
  view.querySelectorAll("[data-mic]").forEach((el) => {
    el.addEventListener("click", async () => {
      // Stop first: a second click on a live button is "stop", not "start
      // another one on top of the one already running".
      if (MIC) { try { MIC.rec.stop(); } catch { MIC = null; repaint(); } return; }
      const path = el.getAttribute("data-mic") || "";
      const n = findNode(sc.root, "VoiceToggle") || findNode(sc.root, "VoiceButton");
      try {
        await micStart(path, n || {});
      } catch (err) {
        MIC = null;
        repaint();
        const eh = n && n.on && n.on.onError;
        const msg = (err && err.name === "NotAllowedError")
          ? "microphone blocked — allow it in your system settings"
          : ((err && err.message) ? err.message : String(err));
        if (eh) await run(eh, msg); else toast(msg);
      }
    });
  });
}

function findEvent(n, name) {
  if (!n || typeof n !== "object") return null;
  if (n.on && n.on[name]) return n.on[name];
  for (const c of n.children || []) { const r = findEvent(c, name); if (r) return r; }
  return null;
}

let CURRENT_SCREEN = null;
function repaint(screen) {
  if (screen) CURRENT_SCREEN = screen;
  const sc = CURRENT_SCREEN;
  if (!sc) return;
  handlers = [];
  // Whatever was turning words over belongs to the DOM about to be replaced.
  stopFlips();
  const html = sc.root ? node(sc.root) : '<div class="pad">' + (sc.blocks || []).map(node).join("") + "</div>";
  const view = $("view");
  view.innerHTML = html;
  startFlips();

  handlers.forEach((h) => {
    const el = view.querySelector('[data-h="' + h.id + '"]');
    if (el) el.addEventListener("click", () => { void run(h.action); });
  });
  view.querySelectorAll("[data-bind]").forEach((el) => {
    const path = el.getAttribute("data-bind");
    if (!path) return;
    el.addEventListener("input", () => { setStatePath(path, el.value); });
  });
  // A committed pill. `onComplete` is the phones' name for it and the catalog
  // sends the same tree to both, so the name is honoured rather than renamed.
  view.querySelectorAll("[data-ev='onComplete']").forEach((el) => {
    const ref = (sc.root && findEvent(sc.root, "onComplete")) || null;
    if (ref) el.addEventListener("click", () => { void run(ref); });
  });
  view.querySelectorAll("[data-toggle]").forEach((el) => {
    const path = el.getAttribute("data-toggle");
    if (!path) return;
    el.addEventListener("click", () => { setStatePath(path, !truthy(stateAt(path))); repaint(); });
  });
  wireChat(view, sc);
  wireMic(view, sc);
  wireField(view);
  document.querySelectorAll("#tabs .tab").forEach((b) => {
    b.setAttribute("aria-current", String(b.dataset.tab === TAB_ID));
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/** Stop every flip line. Called before a paint replaces the DOM under them. */
function stopFlips() {
  FLIP_TIMERS.forEach(clearInterval);
  FLIP_TIMERS = [];
  FLIPS = [];
}

/**
 * Start the flip lines this paint produced.
 *
 * A crossfade rather than the phones' 3D turn: the turn there is a native
 * transform on a native text node, and a browser doing the same thing over a
 * blurred backdrop repaints the whole stacking context. The word still changes
 * language, which is the part anyone notices.
 */
function startFlips() {
  FLIPS.forEach((f) => {
    const el = document.getElementById(f.id);
    if (!el || f.words.length < 2) return;
    let i = 0;
    FLIP_TIMERS.push(setInterval(() => {
      el.style.opacity = "0";
      setTimeout(() => {
        i = (i + 1) % f.words.length;
        el.textContent = f.words[i];
        el.style.opacity = "1";
      }, 250);
    }, f.ms));
  });
  FLIPS = [];
}

function renderTabs() {
  $("tabs").innerHTML = TABS.map((t) =>
    '<button class="tab" data-tab="' + esc(t.id) + '">' + esc(t.title) + "</button>").join("");
  document.querySelectorAll("#tabs .tab").forEach((b) => {
    b.addEventListener("click", () => switchTab(b.dataset.tab));
  });
}

/**
 * THE CHROME, FROM THE SERVER.
 *
 * The screens in this window were already server-drawn; the frame around them
 * was not. The gate's heading, its buttons, the rail down the left — all
 * literals in app.html, so correcting one word of them meant cutting an
 * installer and getting every user to run it.
 *
 * Every key is optional. A missing one leaves the markup's own word in place,
 * which is what a build older than a key, or newer than a deploy, will hit.
 */
function paintChrome(shell) {
  if (!shell) return;
  const text = (id, v) => { const el = $(id); if (el && typeof v === "string" && v.trim()) el.textContent = v; };
  const hint = (id, v) => { const el = $(id); if (el && typeof v === "string" && v.trim()) el.placeholder = v; };
  const g = shell.gate || {};
  text("gateTitle", g.title);       text("gateSub", g.subtitle);
  text("tabEmail", g.emailTab);     text("tabPhone", g.phoneTab);
  hint("email", g.emailPlaceholder); hint("phone", g.phonePlaceholder);
  text("sendCode", g.sendCode);     text("gateOr", g.or);
  text("appleLabel", g.apple);      text("googleLabel", g.google);
  hint("code", g.codePlaceholder);  text("verify", g.verify);
  text("backToEmail", g.startOver); text("gateNote", g.note);
  const r = shell.rail || {};
  text("railBrand", r.brand);       text("dictate", r.dictate);
  text("settingsLink", r.settings); text("signOut", r.signOut);
  text("back", r.back);
  applyGateLayout(shell.gateLayout);
}

/**
 * STAND BESIDE THE ART, NOT ON IT.
 *
 * The sign-in art places a mark and a headline, and the form was centred in
 * the window — which is exactly where both of those are. On a wide window the
 * form takes a column of its own instead, at a position the server names,
 * because the art is an upload and the next one may be composed the other way
 * round.
 *
 * Below `wideAt` there is no second column to take, so it re-centres. Nothing
 * here runs at all for a server that sends no block: the window keeps the
 * centred layout it had.
 */
let GATE_LAYOUT = null;

function applyGateLayout(l) {
  if (l && typeof l === "object") GATE_LAYOUT = l;
  const g = $("gate");
  if (!g || !GATE_LAYOUT) return;
  const L = GATE_LAYOUT;
  const wide = window.innerWidth >= (Number(L.wideAt) || 860);
  const twoCol = wide && (L.align === "right" || L.align === "left");
  g.dataset.cols = twoCol ? "1" : "0";
  if (twoCol) {
    const col = Math.min(0.95, Math.max(0.05, Number(L.column) || 0.5));
    // Mirrored for "left", so one number describes either side.
    g.style.setProperty("--gate-col", ((L.align === "left" ? 1 - col : col) * 100) + "%");
    g.style.setProperty("--gate-w", (Number(L.columnWidth) || 300) + "px");
  } else {
    g.style.removeProperty("--gate-col");
    g.style.removeProperty("--gate-w");
  }
  // The scrim belongs to the layout: it darkens where the FORM is, and the
  // form only sits there when there is room for two columns.
  const bg = $("gatebg");
  if (bg) {
    bg.dataset.scrim = twoCol && typeof L.scrim === "string" && L.scrim.trim() ? "1" : "0";
    if (bg.dataset.scrim === "1") bg.style.setProperty("--gate-scrim", L.scrim);
    else bg.style.removeProperty("--gate-scrim");
  }
  // The art in these uploads already says "Code sent." and "Say it right.", so
  // the window's own heading and subtitle would be the same words twice. An
  // explicit switch, not an empty string: blank means "keep what you have"
  // everywhere else in this block, and it has to keep meaning that.
  const hide = (id, show) => { const el = $(id); if (el) el.hidden = show === false; };
  hide("gateTitle", L.showTitle);
  hide("gateSub", L.showSubtitle);
}

// A window that is resized across `wideAt` changes which layout applies.
window.addEventListener("resize", () => applyGateLayout());

/** The tray's copy lives in the main process, which never talks to the backend.
 *  The window is the only thing here holding a connection, so it passes the
 *  block along and main caches it for the launches that start offline. */
function shareChrome(shell) {
  if (!shell) return;
  paintChrome(shell);
  try { window.tailzuApp.shell(shell); } catch { /* tray only */ }
}

async function render() {
  const signedIn = !!(SESSION && SESSION.access_token);
  $("gate").hidden = signedIn;
  $("shell").hidden = !signedIn;
  if (!signedIn) {
    // Ask as a stranger, so the gate is drawn by the same server that draws
    // everything behind it. A failure here is not fatal: the markup already
    // carries every word, and someone signing in on a dead connection has a
    // bigger problem than the heading being one release old.
    // gateBoot() memoises it, and the art and the phone-method switch already
    // read the same answer — so this is the one request, not a second.
    const anon = await gateBoot();
    if (anon) {
      BOOT = anon;                 // role() resolves typography against it too
      applyTheme(anon.theme);
      shareChrome(anon.flags && anon.flags["desktop.shell"]);
    }
    return;
  }
  BOOT = await bootstrap();
  applyTheme(BOOT.theme);
  shareChrome(BOOT.flags && BOOT.flags["desktop.shell"]);
  TABS = BOOT.navigation && BOOT.navigation.kind === "tabs" ? BOOT.navigation.tabs : [];
  renderTabs();
  // WHERE THE SERVER SAYS, when the server says somewhere this window has.
  //
  // We report `formFactor: "desktop"` now, so the intro and the two setup
  // steps are not offered to us at all and `initialScreenId` is a tab. This
  // still checks, because a backend older than that field answers
  // `onboarding_keyboard` — and a window has no keyboard to enable, so
  // landing there would be a dead end with no way out. Anything that is not
  // one of our tabs falls back to the first one.
  //
  // The tab id is taken from the SAME tab, not from TABS[0]: a bar lighting
  // one tab while another's screen is drawn is worse than a bar that is
  // simply wrong, because the first tap on it does nothing.
  const landing = TABS.find((t) => (t.screenId || t.id) === BOOT.initialScreenId) || TABS[0];
  TAB_ID = landing ? landing.id : "";
  STACK = [{ screenId: landing ? (landing.screenId || landing.id) : "home" }];
  await paint();
}

async function signIn(email) {
  await sbFetch("/auth/v1/otp", { email, create_user: true });
}
async function verify(email, token) {
  const r = await sbFetch("/auth/v1/verify", { email, token, type: "email" });
  await setSession(r);
}
// Phone is the same two calls with a different key and a different OTP type.
// It only appears when the backend says an SMS provider is actually wired up —
// a button that sends a code nobody can receive is worse than no button.
async function signInPhone(phone) {
  await sbFetch("/auth/v1/otp", { phone, create_user: true });
}
async function verifyPhone(phone, token) {
  const r = await sbFetch("/auth/v1/verify", { phone, token, type: "sms" });
  await setSession(r);
}

/**
 * The bootstrap the GATE needs, fetched once.
 *
 * Two things on the sign-in screen come from the server — whether phone
 * sign-in is on, and the art behind the form — and both are needed before
 * there is a session. That is exactly why they ride in the boot flags rather
 * than in a screen: bootstrap is the only channel that reaches an app with
 * nobody signed into it. It runs on the fallback token here, which is all
 * either of them needs.
 *
 * Cached because it used to be called per question, and two callers meant two
 * round trips to answer one screen.
 */
let preBoot = null;
function gateBoot() {
  // ASKED AS A STRANGER. This runs before there is an account, and it used to
  // go out under the static fallback token — which resolves to a synthetic
  // user, so every launch that never signed in was charged a bootstrap against
  // somebody. Auth is optional on the route, so it simply asks without one.
  if (!preBoot) preBoot = bootstrapAnon().catch(() => null);
  return preBoot;
}

async function phoneEnabled() {
  const b = await gateBoot();
  const v = b && (b.flags || {})["auth.enablePhone"];
  return v === true || v === "true";
}

/**
 * Dress the sign-in screen with the uploaded art.
 *
 * `auth.background` is what the phones draw, and this window showed nothing at
 * all — so the first screen of the product looked like a different product on
 * the desktop. Same key, same upload, no second asset to keep in step.
 *
 * The code step gets its own art when one has been uploaded and falls back to
 * the entry's when it has not, which is the rule the phones follow.
 */
async function dressGate(step) {
  const b = await gateBoot();
  const flags = (b && b.flags) || {};
  const spec = (step === "code" && flags["auth.background.code"]) || flags["auth.background"];
  const host = $("gatebg");
  if (!host) return;
  if (!spec || !spec.url) { host.innerHTML = ""; return; }
  const gate = $("gate");
  if (gate && spec.background) gate.style.background = spec.background;
  const fit = spec.fit === "contain" ? "contain" : "cover";
  const isVideo = /^video\//.test(String(spec.contentType || "")) ||
                  /\.(mp4|mov|m4v|webm)(\?|$)/i.test(spec.url);
  // Rebuilding the element on every step would restart the clip mid sign-in,
  // so a source that has not changed is left alone.
  if (host.dataset.src === spec.url) return;
  host.dataset.src = spec.url;
  host.innerHTML = isVideo
    ? '<video src="' + esc(spec.url) + '" autoplay muted loop playsinline style="object-fit:' + fit + '"></video>'
    : '<img src="' + esc(spec.url) + '" alt="" style="object-fit:' + fit + '">';
}

(async function start() {
  ENV = await window.tailzuApp.env();
  SESSION = ENV.session || null;

  $("dictate").addEventListener("click", () => { window.tailzuApp.dictate(); toast("Listening — press your hotkey to stop"); });
  $("settingsLink").addEventListener("click", () => go("settings"));
  $("back").addEventListener("click", back);
  $("signOut").addEventListener("click", async () => {
    await setSession(null);
    // Drop the tray's token too, or it keeps reading the account of someone
    // who just signed out of it.
    try { window.tailzuApp.token(null); } catch { /* tray only */ }
    location.reload();
  });

  const email = $("email"), code = $("code"), err = $("gateErr");
  const fail = (e) => { err.textContent = String((e && e.message) || e || ""); };

  // Which of email / phone the code was sent to, so the verify step knows
  // which endpoint to answer with.
  let method = "email";
  let sentTo = "";
  const dialled = () => ($("dial").value.trim() + $("phone").value.trim()).replace(/[^\d+]/g, "");

  $("methods").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    method = b.dataset.m;
    Array.prototype.forEach.call($("methods").children, (x) => {
      x.setAttribute("aria-pressed", String(x.dataset.m === method));
    });
    $("email").hidden = method !== "email";
    $("phoneRow").hidden = method !== "phone";
    err.textContent = "";
    (method === "email" ? email : $("phone")).focus();
  });

  $("sendCode").addEventListener("click", async () => {
    err.textContent = "";
    $("sendCode").disabled = true;
    try {
      if (method === "phone") {
        const v = dialled();
        if (!/^\+\d{7,15}$/.test(v)) throw new Error("Enter a number with its country code, like +1 555 000 1234.");
        await signInPhone(v);
        sentTo = v;
      } else {
        const v = email.value.trim();
        if (!v) throw new Error("Enter your email address.");
        await signIn(v);
        sentTo = v;
      }
      $("stepEmail").hidden = true;
      $("stepCode").hidden = false;
      void dressGate("code");
      code.focus();
    } catch (e) { fail(e); } finally { $("sendCode").disabled = false; }
  });
  $("backToEmail").addEventListener("click", () => {
    $("stepEmail").hidden = false; $("stepCode").hidden = true; err.textContent = "";
    void dressGate("entry");
  });

  // Apple / Google. The main process owns the window and the code exchange;
  // this only asks and reacts.
  const oauth = async (provider, btn) => {
    err.textContent = "";
    $("appleBtn").disabled = $("googleBtn").disabled = true;
    try {
      const r = await window.tailzuApp.oauth(provider);
      if (!r || !r.ok) {
        // Closing the window is a decision, not a failure worth shouting about.
        if (r && r.error === "cancelled") return;
        throw new Error((r && r.error) || "Sign-in failed.");
      }
      SESSION = r.session;
      location.reload();
    } catch (e) { fail(e); } finally {
      $("appleBtn").disabled = $("googleBtn").disabled = false;
    }
  };
  $("appleBtn").addEventListener("click", () => oauth("apple"));
  $("googleBtn").addEventListener("click", () => oauth("google"));

  // Ask the backend, once, whether phone is live. Everything else on the gate
  // works while this is in flight.
  if (!SESSION) {
    phoneEnabled().then((on) => { if (on) $("methods").hidden = false; });
    void dressGate("entry");
  }
  $("verify").addEventListener("click", async () => {
    err.textContent = "";
    $("verify").disabled = true;
    try {
      // Answer with whichever address the code actually went to.
      if (method === "phone") await verifyPhone(sentTo, code.value.trim());
      else await verify(sentTo || email.value.trim(), code.value.trim());
      await render();
    } catch (e) { fail(e); } finally { $("verify").disabled = false; }
  });
  email.addEventListener("keydown", (e) => { if (e.key === "Enter") $("sendCode").click(); });
  $("phone").addEventListener("keydown", (e) => { if (e.key === "Enter") $("sendCode").click(); });
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
