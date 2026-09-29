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
  // Buying. There is no store on a desktop, so these open RevenueCat's Web
  // Billing checkout in the user's browser and then ask the server again.
  // Declared, because a capability list that omits them is the server being
  // told this window cannot take a payment — and it now can.
  "iap.subscribe", "iap.showPaywall", "iap.restore",
];

/**
 * The server's knobs (knobs.js, loaded before this file). Every literal this
 * renderer used to decide for itself — a toast's words, how long a slow load
 * waits before saying so, a switch's size — is read through these, with the
 * old literal as the fallback. Fed every bootstrap this window receives, and
 * the main process's cached copy before the first one lands.
 */
const K = window.TailzuKnobs;

let ENV = null;          // baseUrl, tone, language, appVersion, launchCount, knobs
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
  if (!res.ok) {
    throw new Error(json.error_description || json.msg || json.error ||
      K.txt("desktop.gate.authFailed", "Auth failed ({status})", { status: res.status }));
  }
  return json;
}

/**
 * A valid access token, refreshing when the stored one has expired.
 *
 * Null when nobody is signed in, and the request then goes out with no
 * Authorization header at all. There used to be a static fallback token here,
 * which the backend resolves to a synthetic user — so a signed-out window
 * asked for things as somebody nobody is.
 */
async function bearer() {
  if (!SESSION) return null;
  const now = Math.floor(Date.now() / 1000);
  if (SESSION.expires_at && SESSION.expires_at - K.num("desktop.auth.refreshSkewSec", 60) <= now && SESSION.refresh_token) {
    try {
      const r = await sbFetch("/auth/v1/token?grant_type=refresh_token", { refresh_token: SESSION.refresh_token });
      await setSession(r);
    } catch {
      // Refresh failed — the session is gone, not merely stale.
      await setSession(null);
      render();
      return null;
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
        expires_at: raw.expires_at ||
          Math.floor(Date.now() / 1000) + (raw.expires_in || K.num("desktop.auth.tokenLifetimeSec", 3600)),
      }
    : null;
  await window.tailzuApp.setSession(SESSION);
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

/** A media query's answer, false where the window cannot say. */
function prefers(q) {
  try { return window.matchMedia(q).matches; } catch { return false; }
}

function capabilities() {
  return {
    schemaVersion: SCHEMA_VERSION,
    // The build, from package.json by way of the main process — the page
    // cannot read the file. It used to say "desktop", which told the server
    // which surface this was and nothing about which release.
    appVersion: String((ENV && ENV.appVersion) || ""),
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
      // Which desktop, from the main process — a window cannot tell on its
      // own, and the gate's buttons depend on it.
      os: (ENV && ENV.os) || "",
      width: window.innerWidth, height: window.innerHeight, scale: window.devicePixelRatio || 1,
      // What the OS is actually set to, not what this window would like.
      colorScheme: prefers("(prefers-color-scheme: light)") ? "light" : "dark",
      locale: navigator.language || "en-US",
      reduceMotion: prefers("(prefers-reduced-motion: reduce)"),
      rtl: false,
    },
  };
}

async function api(path, body, method) {
  const tok = await bearer();
  const headers = { "Content-Type": "application/json" };
  if (tok) headers.Authorization = "Bearer " + tok;
  const res = await fetch(ENV.baseUrl + path, {
    method: method || "POST",
    headers,
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

/** How many times this install has launched — counted by the main process,
 *  once per launch, so the window and the tray report the same number. */
const launchCount = () => Number(ENV && ENV.launchCount) || 1;

/**
 * EVERY BOOTSTRAP THIS WINDOW RECEIVES points the knobs at itself and goes on
 * to the main process — all of it, labels and flags, not only the tray's
 * `desktop.shell` block. The main process fetches its own as well; this only
 * ever makes its copy fresher.
 */
function received(boot) {
  if (boot && typeof boot === "object") {
    K.setKnobs(boot);
    try { window.tailzuApp.boot({ labels: boot.labels || {}, flags: boot.flags || {} }); } catch { /* tray only */ }
    paintFirst();
  }
  return boot;
}

const bootstrap = () =>
  api("/v1/app/bootstrap", { capabilities: capabilities(), launchCount: launchCount() }).then(received);

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
    body: JSON.stringify({ capabilities: capabilities(), launchCount: launchCount() }),
  });
  if (!res.ok) throw new Error("bootstrap → " + res.status);
  return received(await res.json());
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
// The scale and the two stacks are knobs; read per call so a new bootstrap
// retunes the next paint.
//
// Single quotes inside the stacks, because these land in double-quoted style
// attributes: a "Segoe UI" in there closed the attribute early and cut off
// everything role() wrote after it — including the node's own style, so
// every Text lost its margins and colours from the tree ("0words"). A stack
// from the server gets the same treatment, for the same reason.
const fontStack = (v) => String(v).replace(/"/g, "'");

function role(name, extra) {
  const theme = (BOOT && BOOT.theme) || {};
  const f = theme.font || {};
  const r = (f.roles && f.roles[name]) || null;
  if (!r) return extra || "";
  const c = theme.color || {};
  const out = [];
  const scale = K.num("desktop.type.scale", 1.08);
  const px = (v) => Math.round(v * scale * 10) / 10 + "px";
  if (r.size != null) out.push("font-size:" + px(r.size));
  if (r.weight) out.push("font-weight:" + r.weight);
  if (r.lineHeight != null) out.push("line-height:" + px(r.lineHeight));
  if (r.letterSpacing != null) out.push("letter-spacing:" + r.letterSpacing + "px");
  if (r.italic) out.push("font-style:italic");
  if (r.transform) out.push("text-transform:" + r.transform);
  if (r.align) out.push("text-align:" + r.align);
  if (r.color) out.push("color:" + (c[r.color] || r.color));
  out.push("font-family:" + fontStack(r.family === "display"
    ? K.str("desktop.font.serif", "Georgia,'Times New Roman',serif")
    : K.str("desktop.font.sans", "-apple-system,'Segoe UI',system-ui,sans-serif")));
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

/**
 * The catalog's conditions — the same set the phones evaluate.
 *
 * A condition this window does not know is FALSE, not true: a node gated on
 * something unrecognised stays hidden rather than appearing for everybody. And
 * a malformed one (an operand missing) is false too, rather than a throw that
 * blanks the whole screen — the rule the phone renderer follows.
 */
function visible(c) {
  if (!c) return true;
  const flags = (BOOT && BOOT.flags) || {};
  const same = (a, b) => String(a) === String(b);
  try {
    // The tree the server sends this window is the iOS one (see capabilities),
    // and a condition can also name the desktop outright.
    if (c.platform) return c.platform === "ios" || c.platform === "desktop";
    if (c.flag) return truthy(flags[c.flag]);
    if (c.truthy) return truthy(lookup(c.truthy));
    if (c.falsy) return !truthy(lookup(c.falsy));
    if (c.eq) return same(lookup(c.eq[0]), c.eq[1]);
    if (c.neq) return !same(lookup(c.neq[0]), c.neq[1]);
    if (c.gt) return Number(lookup(c.gt[0])) > Number(c.gt[1]);
    if (c.gte) return Number(lookup(c.gte[0])) >= Number(c.gte[1]);
    if (c.lt) return Number(lookup(c.lt[0])) < Number(c.lt[1]);
    if (c.lte) return Number(lookup(c.lte[0])) <= Number(c.lte[1]);
    if (c.in) return Array.isArray(c.in[1]) && c.in[1].some((x) => same(x, lookup(c.in[0])));
    if (c.contains) {
      // An ARRAY is tested for membership, not for a substring of its joined
      // form — ["hinglish"] does not contain "hi". A string keeps substring
      // semantics.
      const v = lookup(c.contains[0]);
      return Array.isArray(v)
        ? v.some((x) => same(x, c.contains[1]))
        : String(v == null ? "" : v).indexOf(String(c.contains[1])) !== -1;
    }
    if (c.startsWith) return String(lookup(c.startsWith[0]) ?? "").indexOf(String(c.startsWith[1])) === 0;
    if (c.endsWith) {
      const v = String(lookup(c.endsWith[0]) ?? ""), end = String(c.endsWith[1]);
      return v.length >= end.length && v.slice(v.length - end.length) === end;
    }
    // Entitlement lives on the account, and the server already folds it into
    // the boot flags; there is no store on this machine to ask.
    if (c.entitled) return truthy(flags["quota.entitled"]) || truthy(flags["billing.entitled"]);
    if (c.not) return !visible(c.not);
    if (c.all) return c.all.every(visible);
    if (c.any) return c.any.some(visible);
  } catch {
    return false;
  }
  return false;
}

/** Style keys → CSS. The SDUI names come first, then the RN-flavoured aliases
 *  the newer screens author with; both are in the tree and both must resolve. */
// Properties that take a bare number in CSS. LINE-HEIGHT IS NOT ONE OF THEM
// here: CSS reads a bare line-height as a MULTIPLE of the font size, and the
// catalog writes it the way React Native does — in points. So `lineHeight: 15`
// on a 10.5px line became a 157px line box, and the consent notice under the
// sign-in pills had its two lines a third of a screen apart. Every screen that
// sets one was affected; it was only obvious where the text wrapped.
const NUMERIC_OK = /opacity|flex|flex-grow|flex-shrink|z-index|font-weight|aspect-ratio/;
const MAP = {
  direction: "flex-direction", align: "align-items", justify: "justify-content",
  radius: "border-radius", background: "background-color", gap: "gap",
};
const ALIGN = { start: "flex-start", end: "flex-end", center: "center", between: "space-between", around: "space-around", stretch: "stretch", baseline: "baseline" };

/**
 * REACT NATIVE SHORTHANDS THAT CSS HAS NEVER HEARD OF.
 *
 * `paddingHorizontal` became `padding-horizontal`, which every browser drops
 * without a word. The catalog writes these constantly — the paywall's rows,
 * the You tab's cards, the auth screen's margins — so the window had been
 * quietly rendering a large part of the app with no padding at all, and it
 * looked like a slightly cramped design rather than a bug.
 *
 * Each expands to the pair it means, written BEFORE the rest of the style so
 * an explicit `paddingLeft` alongside one still wins, exactly as it does on
 * the phones.
 */
const RN_PAIRS = {
  paddingHorizontal: ["padding-left", "padding-right"],
  paddingVertical: ["padding-top", "padding-bottom"],
  marginHorizontal: ["margin-left", "margin-right"],
  marginVertical: ["margin-top", "margin-bottom"],
};

function css(st) {
  if (!st) return "";
  const out = [];
  // The pairs first, so a specific side named alongside one overrides it.
  for (const k of Object.keys(RN_PAIRS)) {
    const v = tok(st[k]);
    if (v == null) continue;
    const val = typeof v === "number" ? v + "px" : String(v);
    for (const prop of RN_PAIRS[k]) out.push(prop + ":" + val);
  }
  for (const k of Object.keys(st)) {
    if (RN_PAIRS[k]) continue;
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

    case "Row":
      // A SETTINGS ROW, as the phones draw it: the label on the left, a value
      // and a chevron on the right, a hairline under. This window read every
      // Row as a horizontal stack and drew the children it does not have —
      // so Settings was a heading over nothing, and the server's fallback
      // Button never applied because the window had said it could draw a
      // Row. A Row with no label is still the layout row, below.
      if (p.label != null || p.value != null) {
        const chevron = p.chevron !== false;
        return '<div' + bind(press) + ' style="display:flex;align-items:center;padding:' +
          K.num("desktop.row.paddingV", 17) + 'px 0;' +
          (p.divider === false ? "" : "border-bottom:1px solid var(--border);") +
          (press ? "cursor:pointer;" : "") + s + '">' +
          '<span style="flex:1;' + role("row", "font-size:" + K.num("desktop.row.fontSize", 16) + "px;color:" +
            (p.danger ? "var(--danger)" : "var(--text)")) + '">' + esc(p.label || "") + "</span>" +
          (p.value ? '<span style="' + role("rowValue", "font-size:" + K.num("desktop.row.valueSize", 15) + "px;color:var(--muted)") +
            (chevron ? ";margin-right:" + K.num("desktop.row.valueGap", 8) + "px" : "") + '">' + esc(p.value) + "</span>" : "") +
          (chevron ? '<span style="' + role("rowChevron", "font-size:" + K.num("desktop.row.chevronSize", 20) + "px;color:var(--muted)") +
            ';margin-top:-2px">›</span>' : "") +
          "</div>";
      }
      // falls through
    case "Stack": case "SafeArea": case "MorphOut": case "PullToRefresh": case "Grid":
      // POSITION:RELATIVE, AND IT IS LOAD-BEARING.
      //
      // React Native paints children in the order they are written. CSS does
      // not: a POSITIONED element paints above a static one however early it
      // comes. So the shape the catalog uses for every full-bleed screen —
      // absolute art, absolute scrim, then the content — put the art and the
      // scrim ON TOP of the content here. The paywall rendered its plans,
      // centred and correctly placed, entirely underneath its own backdrop.
      //
      // Making every in-flow stack relative restores the order the tree
      // means. It also fixes the containing block: an absolutely-positioned
      // child now measures against its own parent, which is what it does on
      // the phones and not what it was doing here.
      return '<div' + bind(press) + ' style="' +
        (st.position ? "" : "position:relative;") + "display:flex;flex-direction:" +
        (st.direction === "row" || n.type === "Row" ? "row" : "column") +
        (press ? ";cursor:pointer" : "") + ";" + s + '">' + kids + "</div>";

    case "Card":
      return '<div' + bind(press) + ' style="background:var(--card);border:1px solid var(--border);' +
        "border-radius:" + K.num("desktop.card.radius", 18) + "px;padding:" + K.num("desktop.card.padding", 16) +
        "px;margin-bottom:" + K.num("desktop.card.marginBottom", 13) + "px" + (press ? ";cursor:pointer" : "") + ";" + s + '">' +
        kids + (txt ? "<div>" + txt + "</div>" : "") + "</div>";

    case "Spacer":
      return '<div style="height:' + (st.height || K.num("desktop.spacer.height", 8)) + "px;flex:" + (st.flex || 0) + '"></div>';

    case "Divider":
      return '<div style="height:1px;background:var(--border);margin:' + K.num("desktop.divider.margin", 12) + 'px 0"></div>';

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
      //
      // WHITE-SPACE: PRE-WRAP, because React Native keeps the spaces a string
      // was written with and HTML does not. It collapses a run of them, and
      // trims them entirely at the edges of a flex item — so the consent line,
      // which is one sentence split into parts because two of its words are
      // links, rendered as "our Terms and" with the spaces eaten and the words
      // jammed together. pre-wrap keeps them and still wraps, which is what
      // the phones do with the same tree.
      return '<span' + bind(press) + ' style="white-space:pre-wrap;' +
        role(p.variant || "body", "color:var(--text)") + ";" +
        (press ? "cursor:pointer;" : "") + s + '">' + txt + "</span>";

    case "Badge": case "Chip":
      return '<span' + bind(press) + ' style="display:inline-block;border:1px solid var(--border);border-radius:999px;' +
        'padding:5px 11px;' + role(n.type === "Badge" ? "badge" : "chip", "color:var(--body)") + ";" + (press ? "cursor:pointer;" : "") + s + '">' + txt + "</span>";

    case "Button": {
      const primary = p.variant !== "secondary" && p.variant !== "ghost";
      return '<button' + bind(press) + ' style="display:block;width:100%;border:0;cursor:pointer;' +
        (primary ? "background:var(--accent);color:" + K.color("desktop.button.primaryText", "#000")
                 : "background:transparent;color:var(--text);border:1px solid var(--border)") +
        ";border-radius:" + K.num("desktop.button.radius", 14) + "px;padding:" + K.str("desktop.button.padding", "14px 18px") +
        ";margin:" + K.str("desktop.button.margin", "6px 0") + ";" + role(primary ? "button" : "buttonSecondary") + ";" + s + '">' +
        (txt || esc(K.txt("desktop.button.label", "Continue"))) + "</button>";
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
      const sw = K.obj("desktop.switch", {
        width: 50, height: 30, knob: 24, inset: 3, offBackground: "rgba(255,255,255,.16)", knobColor: "#fff",
      });
      return '<button' + bind(n.on && n.on.onChange ? n.on.onChange : press) +
        ' data-toggle="' + esc(path) + '" aria-pressed="' + on + '"' +
        ' style="width:' + sw.width + "px;height:" + sw.height + "px;flex:none;border:0;border-radius:" + (sw.height / 2) +
        "px;cursor:pointer;position:relative;background:" + (on ? "var(--accent)" : esc(sw.offBackground)) + '">' +
        '<span style="position:absolute;top:' + sw.inset + "px;left:" + (on ? sw.width - sw.knob - sw.inset : sw.inset) +
        "px;width:" + sw.knob + "px;height:" + sw.knob + "px;border-radius:50%;background:" + esc(sw.knobColor) + '"></span></button>';
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
                        : "height:" + dim(st.height, K.num("desktop.image.height", 160) + "px") + ";") +
        "min-height:0;" +
        // Filling a parent means the parent draws the corners and the spacing.
        "border-radius:" + (st.borderRadius != null ? st.borderRadius : fills ? 0 : K.num("desktop.image.radius", 16)) + "px;" +
        "object-fit:" + (p.contentFit === "contain" ? "contain" : "cover") + ";" +
        "display:block;" + (fills ? "margin:0;" : "margin:0 auto " + K.num("desktop.image.marginBottom", 14) + "px;");
      return n.type === "Video"
        ? '<video src="' + esc(src) + '" autoplay muted loop playsinline style="' + box + '"></video>'
        : '<img src="' + esc(src) + '" alt="" style="' + box + '">';
    }

    case "WordMeter": return wordMeter(p);
    case "PieChart": case "DonutChart": return pie(p);
    case "BarChart": return bars(p);
    case "Sparkline": case "LineChart": return bars({ series: p.series || p.data, color: p.color });
    case "ProgressRing": case "Gauge":
      return '<div style="height:' + K.num("desktop.progress.height", 6) + "px;border-radius:" +
        (K.num("desktop.progress.height", 6) / 2) + 'px;background:var(--border);overflow:hidden;margin:8px 0">' +
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
        'stroke-width="' + (Number(p.strokeWidth) || K.num("desktop.svg.strokeWidth", 2)) + '" ' +
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
    {
      // The phones' intensity is 0..100; a CSS blur radius a third of it
      // matches what they draw.
      const blur = Math.round((Number(p.intensity) || K.num("desktop.blur.intensity", 60)) /
        K.num("desktop.blur.divisor", 3));
      return '<div style="' + s + ';backdrop-filter:blur(' + blur + 'px);-webkit-backdrop-filter:blur(' +
        blur + 'px)">' + kids + "</div>";
    }

    case "ProgressBar":
      return '<div style="' + s + ";height:" + K.num("desktop.progressBar.height", 3) +
        'px;border-radius:2px;background:var(--border);overflow:hidden">' +
        '<div class="tz-indet" style="height:100%;background:var(--accent)"></div></div>';

    case "FlipText": {
      // The greeting. Same words, same interval, same idea — one turns into
      // the next and nothing else on the line moves.
      const words = (p.words || []).map((w) => esc(String(w)));
      if (!words.length) return "";
      const id = "flip" + (node._n = (node._n || 0) + 1);
      FLIPS.push({
        id: id, words: words,
        ms: Math.max(K.num("desktop.flip.minMs", 900), Number(p.intervalMs) || K.num("desktop.flip.intervalMs", 2600)),
      });
      return '<span id="' + id + '" style="' + s + ";transition:opacity " +
        (K.num("desktop.flip.fadeMs", 250) / 1000) + 's">' + words[0] + "</span>";
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
      const d = K.obj("desktop.swipeAction", {
        height: 58, radius: 999, background: "#0B0B0D", color: "#fff", fontSize: 12, weight: 700,
        tracking: 1.8, disc: 46, target: "#C9862B",
      });
      const h = Number(p.height) || d.height;
      const disc = Number(p.disc) || d.disc;
      return '<button class="tz-press" data-ev="onComplete" style="' + s +
        ";position:relative;height:" + h + "px;border-radius:" + (Number(p.radius) || d.radius) + "px" +
        ";background:" + esc(tok(p.background || d.background)) +
        ";border:" + (p.borderWidth ? p.borderWidth + "px solid " + esc(tok(p.borderColor)) : "none") +
        ";color:" + esc(tok(p.color || d.color)) +
        ";font-size:" + (Number(p.fontSize) || d.fontSize) + "px;font-weight:" + (p.weight || d.weight) +
        ";letter-spacing:" + (Number(p.tracking) || d.tracking) + 'px;width:100%;cursor:pointer">' +
        esc(label(p.label || "")) +
        '<span style="position:absolute;right:6px;top:50%;transform:translateY(-50%);width:' +
        disc + "px;height:" + disc +
        "px;border-radius:50%;background:" + esc(tok(p.targetBackground || d.target)) +
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
      // Those two are per screen and per person, and retune the field in
      // place. EVERYTHING ELSE THE SERVER SENDS goes too — regions, colours,
      // bloom, focal length — as one `cfg` parameter the page lays over the
      // geometry it has baked in, so a retune on the server reaches the window
      // the way it reaches the phones, and a node that sends none of it gets
      // the baked field exactly as before. The live values (state, level,
      // training) are messages, not config, and stay out of the address.
      const geo = {};
      Object.keys(p).forEach((k) => {
        if (FIELD_LIVE.indexOf(k) === -1 && p[k] != null) geo[k] = p[k];
      });
      const q = "?alpha=" + encodeURIComponent(Number(p.alpha != null ? p.alpha : 1)) +
        "&growth=" + encodeURIComponent(Number(p.growth != null ? p.growth : 1)) +
        (Object.keys(geo).length ? "&cfg=" + encodeURIComponent(JSON.stringify(geo)) : "");
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

    // ── the sign-in screen ────────────────────────────────────────────────
    // The gate was the last hand-built screen in this window: its own markup,
    // its own buttons, its own arrangement, while the phones drew theirs from
    // `auth.screen` in the boot flags. So the first screen of the product was
    // the one screen that looked like a different product, and every change to
    // it was a change to an installer.
    case "AuthPhase":
      return (n.props?.phases || []).indexOf(AUTH.phase) === -1 ? "" : kids;

    case "Rise":
      return riseNode(n, p, s, kids);

    case "SwipePill":
      return swipePill(p, s);

    case "CodeEntry":
      return codeEntry(p, s);

    case "AppleSignIn":
      return socialButton("apple", p, s);

    case "GoogleSignIn":
      return socialButton("google", p, s);

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
/** The thread's defaults — under the node's own `colors`, over nothing. A
 *  knob as a whole, so the server can move any of them for every screen at
 *  once; the sizes ride along with the colours. */
function chatDefaults() {
  return K.obj("desktop.chat.style", {
    askBg: "rgba(255,255,255,0.06)", askBorder: "rgba(255,255,255,0.09)",
    askText: "rgba(255,255,255,0.9)", mineBg: "#FFFFFF", mineText: "#000000",
    noteText: "#E8A23C", noteBg: "rgba(232,162,60,0.1)", noteBorder: "rgba(232,162,60,0.26)",
    variantBg: "rgba(255,255,255,0.05)", variantBorder: "rgba(255,255,255,0.1)",
    variantText: "rgba(255,255,255,0.92)", angleText: "rgba(255,255,255,0.4)",
    pickedBg: "rgba(232,162,60,0.13)", pickedBorder: "#E8A23C",
    labelText: "rgba(255,255,255,0.38)", radius: 16, gap: 11,
    tail: 5, fontSize: 14.5, mineLineHeight: 21, askLineHeight: 22, noteSize: 11,
    optionRadius: 14, optionSize: 14, optionLineHeight: 21, labelSize: 10.5,
  });
}

/** Which option was taken in which row, for the screen currently painted.
 *  Keyed by row index: a thread only ever grows, so an index is stable. */
let CHAT_PICKED = {};

function chatThread(n, p, s) {
  const c = { ...chatDefaults(), ...(p.colors || {}) };
  const rows = (() => { const r = stateAt((n.bind && n.bind.thread) || ""); return Array.isArray(r) ? r : []; })();
  const pickLabel = label(p.pickLabel) || K.txt("desktop.chat.pickLabel", "Tap the one that sounds like you");

  const bubble = (r, i) => {
    if (r.role === "mine") {
      return '<div style="align-self:flex-end;max-width:82%;background:' + esc(tok(c.mineBg)) +
        ";padding:10px 14px;border-radius:" + c.radius + "px;border-bottom-right-radius:" + c.tail + "px" +
        ";font-size:" + c.fontSize + "px;line-height:" + c.mineLineHeight + "px;color:" + esc(tok(c.mineText)) + '">' +
        esc(r.text || "") + "</div>";
    }
    if (r.role === "note") {
      return '<div style="align-self:center;background:' + esc(tok(c.noteBg)) + ";border:1px solid " +
        esc(tok(c.noteBorder)) + ";border-radius:999px;padding:5px 11px;font-size:" + c.noteSize + "px;letter-spacing:.5px;color:" +
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
          ";border-radius:" + c.optionRadius + "px;padding:11px 13px;opacity:" + (dimmed ? ".3" : "1") + '">' +
          (o.angle
            ? '<div style="font-size:10px;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;color:' +
              esc(tok(isPicked ? c.pickedBorder : c.angleText)) + '">' + esc(o.angle) + "</div>"
            : "") +
          '<div style="font-size:' + c.optionSize + "px;line-height:" + c.optionLineHeight + "px;color:" + esc(tok(c.variantText)) + '">' +
          esc(o.text) + "</div></button>";
      }).join("");
      return '<div style="display:flex;flex-direction:column;gap:7px">' +
        '<div style="font-size:' + c.labelSize + "px;letter-spacing:1.4px;text-transform:uppercase;color:" +
        esc(tok(c.labelText)) + '">' + esc(r.label || pickLabel) + "</div>" + opts + "</div>";
    }
    // Anything else is something the app said.
    return '<div style="align-self:flex-start;max-width:88%;background:' + esc(tok(c.askBg)) +
      ";border:1px solid " + esc(tok(c.askBorder)) + ";padding:12px 14px;border-radius:" + c.radius +
      "px;border-bottom-left-radius:" + c.tail + "px;font-size:" + c.fontSize + "px;line-height:" + c.askLineHeight + "px;color:" +
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
  const size = Number(p.size) || K.num("desktop.voice.buttonSize", 44);
  const on = !!(MIC && MIC.path === ((n.bind && n.bind.value) || ""));
  return '<button class="tz-press" data-mic="' + esc((n.bind && n.bind.value) || "") + '"' +
    ' aria-pressed="' + on + '" title="' +
    esc(on ? K.txt("desktop.voice.stop", "Stop and transcribe") : K.txt("desktop.voice.record", "Record")) + '"' +
    ' style="' + s + ";flex:none;width:" + size + "px;height:" + size + "px;border-radius:50%;cursor:pointer" +
    ";border:0;display:flex;align-items:center;justify-content:center;background:" +
    esc(tok(on ? K.color("desktop.voice.liveBackground", "#e0556b")
               : (p.background || K.color("desktop.voice.background", "#E8A23C")))) + '">' +
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

/** What the microphone is asked for — the same knob the tray's recorder reads. */
const micConstraints = () =>
  K.obj("desktop.mic.constraints", { echoCancellation: true, noiseSuppression: true, autoGainControl: true });

async function micStart(path, n) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() });
  const mime = K.list("desktop.mic.mimeTypes", ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"])
    .find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    MIC = null;
    try {
      if (!chunks.length) throw new Error(K.txt("desktop.mic.noAudio", "no audio captured"));
      const type = rec.mimeType || "audio/webm";
      const fd = new FormData();
      fd.append("audio", new Blob(chunks, { type }), "audio." + (type.indexOf("ogg") !== -1 ? "ogg" : "webm"));
      fd.append("targetApp", "Desktop");
      fd.append("language", String(n.props?.language || "auto"));
      const tok = await bearer();
      const res = await fetch(ENV.baseUrl + "/v1/transcribe-clean", {
        method: "POST",
        headers: tok ? { Authorization: "Bearer " + tok } : {},
        body: fd,
      });
      if (!res.ok) throw new Error("transcribe → " + res.status);
      const j = await res.json();
      const text = String(j.cleanedText || j.transcript || j.text || "").trim();
      if (!text) throw new Error(K.txt("desktop.mic.noSpeech", "no speech detected"));
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
let SESSION_RUN = null;   // the live loop, or null

function startSession(n) {
  if (SESSION_RUN) return;                 // already running for this screen
  const p = deepResolve(n.props || {});
  // How the level bubble moves: how often it decays, how far a word lifts it,
  // where it rests, and where it sits while the app thinks and speaks.
  const LV = K.obj("desktop.voice.level", {
    tickMs: 90, onSpeech: 0.8, floor: 0.15, decay: 0.86, thinking: 0.12, speaking: 0.5,
  });
  const r = {
    alive: true,
    endpoint: String(p.path || K.str("desktop.voice.endpoint", "/v1/train/converse")),
    silenceMs: Math.max(K.num("desktop.voice.minSilenceMs", 600), Number(p.silenceMs) || K.num("desktop.voice.silenceMs", 1500)),
    maxTurns: Math.max(K.num("desktop.voice.minTurns", 2), Number(p.maxTurns) || K.num("desktop.voice.maxTurns", 40)),
    language: p.language ? String(p.language) : "auto",
    statePath: String(p.statePath || "sessionState"),
    levelPath: String(p.levelPath || "level"),
    linePath: String(p.linePath || "line"),
    turnsPath: String(p.turnsPath || "turns"),
    greeting: String(p.greeting || "").trim(),
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
  const heard = () => { setLevel(LV.onSpeech); armSilence(); };

  async function listen(warmed) {
    if (!r.alive) return;
    if (r.turns.length >= r.maxTurns * 2) { setState_("idle"); setLevel(0); return; }
    r.committed = ""; r.partial = "";
    setState_("listening");
    setLevel(LV.floor);
    // The level has no amplitude behind it — the socket hands over text, not
    // PCM. So it rises on the arrival of words and decays between them, which
    // is a true signal about speech even though it is not loudness.
    r.decay = setInterval(() => {
      if (r.level > LV.floor) setLevel(Math.max(LV.floor, r.level * LV.decay));
    }, LV.tickMs);
    try {
      // The microphone opened behind the greeting, when there was one. A
      // warm-up that failed falls through to asking again, so a denial is
      // still reported by the same path rather than silently.
      r.stream = (warmed ? await warmed : null) ||
        await navigator.mediaDevices.getUserMedia({ audio: micConstraints() });
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
        } else if (m.type === "error") fail(m.message || K.txt("desktop.voice.micStopped", "The microphone stopped."));
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
        ? K.txt("desktop.voice.micBlocked", "microphone blocked — allow it in your system settings")
        : ((err && err.message) ? err.message : K.txt("desktop.voice.startFailed", "Couldn't start listening.")));
    }
  }

  async function respond() {
    if (!r.alive) return;
    setState_("thinking");
    setLevel(LV.thinking);
    try {
      const res = await api(r.endpoint, { turns: r.turns, language: r.language });
      if (!r.alive) return;
      const reply = String((res && res.reply) || "").trim();
      if (!reply) { void listen(); return; }
      say("assistant", reply);
      setState_("speaking");
      setLevel(LV.speaking);
      speak(reply, () => { if (r.alive) void listen(); });
    } catch (err) {
      fail((err && err.message) ? err.message : K.txt("desktop.voice.replyFailed", "Couldn't reach the conversation."));
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
        Math.min(K.num("desktop.voice.ttsMaxMs", 30000),
          K.num("desktop.voice.ttsBaseMs", 2000) + text.length * K.num("desktop.voice.ttsPerCharMs", 90)));
    } catch { done(); }
  }

  /**
   * THE WARM-UP HAPPENS BEHIND THE GREETING, NOT BEFORE IT.
   *
   * This used to open by listening, so asking for the microphone and opening
   * the socket happened in silence with the screen already up — and the first
   * thing the app said arrived only after the user had spoken into that
   * silence and waited out a round trip. That reads as broken, not as
   * thinking.
   *
   * The greeting arrives written, composed by the server from the name and
   * what has actually been learned, so it is said at once and the warm-up goes
   * underneath it. A window has no audio-session category to fight, so here
   * the microphone itself can be opened early: by the time the sentence ends
   * the stream is live and the handover is a state change rather than a wait.
   */
  if (r.greeting) {
    r.turns = [{ role: "assistant", text: r.greeting }];
    put(r.turnsPath, r.turns);
    put(r.linePath, r.greeting);
    setState_("speaking");
    setLevel(LV.speaking);
    // Not awaited. The point is that it opens WHILE the sentence is spoken.
    const warm = navigator.mediaDevices
      .getUserMedia({ audio: micConstraints() })
      .catch(() => null);
    speak(r.greeting, () => {
      if (!r.alive) { void warm.then((st) => st && st.getTracks().forEach((t) => t.stop())); return; }
      void listen(warm);
    });
  } else {
    void listen();
  }
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

// ---------------------------------------------------------------------------
// Paying
// ---------------------------------------------------------------------------

/**
 * Who this is, for the checkout link.
 *
 * The Supabase access token is a JWT and `sub` is the user id. Read without
 * verifying, deliberately: this is used to address a checkout page, never to
 * authorise anything. Every request that matters still carries the token
 * itself and is verified by a server that has the key.
 */
function userId() {
  const t = SESSION && SESSION.access_token;
  if (!t) return "";
  try {
    const body = t.split(".")[1];
    const json = atob(body.replace(/-/g, "+").replace(/_/g, "/"));
    return String(JSON.parse(json).sub || "");
  } catch { return ""; }
}

/**
 * Open RevenueCat's Web Billing checkout, in the user's own browser.
 *
 * Not in this window. A checkout is a place people expect to recognise — a
 * real address bar, a padlock, a saved card — and an app-shaped frame around
 * somebody's card details is the shape of every phishing page ever built. It
 * is also the only way the browser's own autofill and 3-D Secure work.
 *
 * The id goes in the path because that is how RevenueCat attributes a Web
 * Billing purchase to an app user, which is what makes the entitlement follow
 * the account instead of the machine.
 */
/**
 * WHERE THE USER ID GOES IN THE LINK, and why this is not guessed here.
 *
 * RevenueCat has more than one shape of purchase link, and they do not carry
 * the app user id the same way: a hosted paywall link takes it as a trailing
 * path segment, a Web Purchase Link takes it as an `app_user_id` query
 * parameter, and which one you have depends on the billing engine behind it.
 *
 * Getting it wrong is the worst possible failure, because it LOOKS like
 * success. The checkout opens, the card is charged, the webhook arrives, and
 * the server logs `no Supabase user id on the event` — money taken, nothing
 * granted. The entitlements code names that case explicitly for a reason.
 *
 * So the shape is part of the configured link rather than an assumption in
 * this file. Put `{app_user_id}` wherever it belongs and it is substituted
 * there. Without a placeholder it is appended as the query parameter, which is
 * what RevenueCat documents for a Web Purchase Link — and which survives a URL
 * that already carries a query, where blind path-appending would not.
 */
function withUser(url, uid) {
  const id = encodeURIComponent(uid);
  if (url.indexOf("{app_user_id}") !== -1) return url.replace(/\{app_user_id\}/g, id);
  return url + (url.indexOf("?") === -1 ? "?" : "&") + "app_user_id=" + id;
}

/** What to call the place a subscription lives, by the flag that says it
 *  lives there. */
function manageAt() {
  return {
    "billing.manage.apple": K.txt("desktop.billing.storeApple", "the App Store"),
    "billing.manage.google": K.txt("desktop.billing.storeGoogle", "Google Play"),
    "billing.manage.web": K.txt("desktop.billing.storeWeb", "the web"),
  };
}

function buyOnWeb() {
  const flags = (BOOT && BOOT.flags) || {};
  // A SECOND SUBSCRIPTION IS THE ONE MISTAKE THIS WINDOW CAN MAKE WITH
  // SOMEBODY'S MONEY.
  //
  // One account reaches a phone and a window, and the two stores cannot see
  // each other: buying here while an App Store subscription is live bills them
  // twice for one entitlement, and neither store notices or refunds it. The
  // Settings row that offers this is already hidden from a subscriber — but a
  // hidden row is not a guard. The paywall is also reached by running out of
  // words, by a screen the server sends, and by a BOOT that went stale while
  // the window sat open, and every one of those ends here.
  //
  // NOT A BLOCK ON EVERY SUBSCRIBER, though. Moving from the monthly plan to
  // the annual one is the same purchase on the same store, and the store
  // handles the swap and the proration itself — refusing that would leave
  // somebody stuck on the plan they are trying to spend more on. The line is
  // the STORE, not the subscription.
  //
  // AND IT SENDS THEM THERE RATHER THAN DESCRIBING IT. They clicked a button
  // that means "change my plan"; answering with the route to somebody else's
  // settings screen leaves them to do the finding, which is the part that
  // becomes a support email. The server sends the address, so the click still
  // ends where changing a plan is possible.
  if (flags["billing.entitled"] && !flags["billing.manage.web"]) {
    const stores = manageAt();
    const key = Object.keys(stores).find((k) => flags[k]);
    const url = String(flags["billing.manage.url"] || "");
    if (key && url) {
      window.tailzuApp.openExternal(url);
      toast(K.txt("desktop.billing.opening", "Your subscription is with {store} — opening it. It covers every device.",
        { store: stores[key] }));
    } else {
      toast(key
        ? K.txt("desktop.billing.elsewhere",
          "Your subscription is with {store}. Change or cancel it there — it covers every device.", { store: stores[key] })
        : K.txt("desktop.billing.alreadyActive", "This account already has an active subscription."));
    }
    return;
  }
  const base = String(flags["paywall.web.url"] || "").trim();
  const uid = userId();
  if (!base || !uid) {
    // Said plainly rather than swallowed. A dead button is the bug this whole
    // case exists to fix, and a silent failure here would just move it.
    toast(base ? K.txt("desktop.billing.signInFirst", "Sign in first to subscribe.")
               : K.txt("desktop.billing.unavailable", "Subscriptions aren't set up for the desktop app yet."));
    return;
  }
  window.tailzuApp.openExternal(withUser(base, uid));
  toast(flags["billing.entitled"]
    ? K.txt("desktop.billing.changeInBrowser", "Change your plan in the browser — this window updates when you're back.")
    : K.txt("desktop.billing.finishInBrowser", "Finish in your browser — this window updates when you're back."));
  // They are about to leave. The answer arrives by webhook while they are
  // gone, so the moment they come back is the moment to ask again.
  WATCH_ENTITLEMENT = true;
}

/**
 * Ask the server whether this account is paid, and repaint if it changed.
 *
 * The server is the only thing that knows — the entitlement is a row against
 * the account, written by RevenueCat's webhook. A client that decided this for
 * itself would be a client anyone could edit into a subscriber.
 */
let WATCH_ENTITLEMENT = false;
async function refreshEntitlement(loud) {
  const was = !!(BOOT && BOOT.flags && BOOT.flags["quota.entitled"]);
  try {
    BOOT = await bootstrap();
  } catch {
    if (loud) toast(K.txt("desktop.billing.offline", "Couldn't reach the backend."));
    return;
  }
  const now = !!(BOOT.flags && BOOT.flags["quota.entitled"]);
  if (now && !was) {
    WATCH_ENTITLEMENT = false;
    toast(K.txt("desktop.billing.subscribed", "You're subscribed. Thank you."));
    await paint(true);
  } else if (loud) {
    toast(now ? K.txt("desktop.billing.active", "Your subscription is active.")
              : K.txt("desktop.billing.none", "No subscription found on this account."));
  }
}

// BACK FROM THE BROWSER. The purchase completes somewhere else entirely and
// tells the server, not this window — so returning to it is the only signal
// there is that the answer may have changed. Only after a checkout was opened:
// re-bootstrapping on every focus would be a request every time somebody
// alt-tabs.
window.addEventListener("focus", () => {
  if (!WATCH_ENTITLEMENT || !SESSION) return;
  void refreshEntitlement(false);
});

// ---------------------------------------------------------------------------
// The sign-in screen
// ---------------------------------------------------------------------------

/**
 * THE GATE IS A SCREEN LIKE THE OTHERS NOW.
 *
 * It was the last one in this window that was not: its own markup in app.html,
 * its own tabs and its own big amber button, while the phones drew theirs from
 * `auth.screen` — the pills you swipe, the two round social buttons, the code
 * pill, the staggered rise. The first screen of the product was the one screen
 * that looked like a different product, and the only one whose wording and
 * arrangement still needed an installer.
 *
 * The same tree renders here. What differs is what a mouse can do: there is no
 * thumb to rest on a badge, so the pill commits on a click of its disc or on
 * Enter — the same rule SwipeAction already follows on the training tab. The
 * gesture was never the point; the deliberateness was.
 *
 * The auth LOGIC stays where it was, in the handlers below. These components
 * read this object and call into it; they do not know how to sign anybody in.
 */
const AUTH = {
  phase: "entry",         // entry | sending | verify | verifying
  method: "email",        // which pill was committed
  email: "",
  dial: "+1",
  phone: "",
  sentTo: "",
  code: "",
  codeLength: 6,
  codeError: false,
  error: "",
  /** Which pill is open for typing. Only one at a time: opening the second
   *  should close the first, or the screen has two carets in it. */
  open: "",
};

/** A row that flies in. The phones spring it; a window has no spring, so this
 *  is the same delay, the same travel and the same overshoot, in CSS. */
function riseNode(n, p, s, kids) {
  const delay = Number(p.delayMs) || 0;
  const from = Number(p.fromY) || 0;
  const scale = Number(p.scaleFrom) || 1;
  return '<div class="tz-rise" style="' + s +
    ";--rise-y:" + from + "px;--rise-s:" + scale +
    ";animation-delay:" + delay + 'ms">' + kids + "</div>";
}

/** The sign-in pills' defaults, under whatever the auth tree's props say —
 *  shared by the method pills, the code pill and the code pill's live border. */
function pillDefaults() {
  return K.obj("desktop.pill", {
    height: 56, fontSize: 15, background: "rgba(255,255,255,0.06)", border: "rgba(255,255,255,0.10)",
    text: "rgba(255,255,255,0.96)", badge: "rgba(255,255,255,0.10)", badgeBorder: "rgba(255,255,255,0.18)",
    target: "#C9862B", targetIcon: "#000000", codeFontSize: 17, codeSpacing: 8,
  });
}

/** One sign-in method. The pill IS the field: click it and the caret lands
 *  inside, type, then the disc at the right end commits. */
function swipePill(p, s) {
  const method = p.method === "phone" ? "phone" : "email";
  if (method === "phone" && !AUTH.phoneOn) return "";
  const D = pillDefaults();
  const h = Number(p.height) || D.height;
  const open = AUTH.open === method;
  const value = method === "phone" ? AUTH.phone : AUTH.email;
  const ready = method === "phone" ? /^\+?\d{7,15}$/.test((AUTH.dial + value).replace(/[^\d+]/g, ""))
                                   : /.+@.+\..+/.test(value.trim());
  const badge = h - 10;
  const label = String((method === "phone" ? p.phoneLabel : p.emailLabel) ||
    (method === "phone" ? K.txt("desktop.gate.phoneLabel", "Phone number") : K.txt("desktop.gate.emailLabel", "Email address")));
  // The disc: at the left as a badge while the pill is closed; at the right
  // end the moment the pill opens — dim until there is something to send,
  // then the brand's amber with an arrow. It used to stay on the left until
  // the address was complete, which put it over the first letters of what
  // was being typed, and on the phone pill over the dial.
  // In flight: the row still draws, because the tree shows the same children
  // for "entry" and "sending" — but a second click would send a second code.
  const busy = AUTH.phase !== "entry";
  const disc = '<span class="tz-disc' + (busy ? " tz-busy" : "") + '" data-commit="' + method + '"' +
    ' role="button" tabindex="0" aria-label="' + esc(K.txt("desktop.gate.continue", "Continue")) + '"' +
    (busy ? ' aria-disabled="true"' : "") +
    ' style="width:' + badge + "px;height:" + badge + "px;" +
    (ready
      ? "right:5px;background:" + esc(tok(p.targetBackground || D.target)) +
        ";border-color:transparent;cursor:pointer"
      : (open ? "right:5px;" : "left:5px;") + "background:" + esc(tok(p.badgeBackground || D.badge)) +
        ";border-color:" + esc(tok(p.badgeBorderColor || D.badgeBorder))) + '">' +
    (ready
      ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="' +
        esc(tok(p.targetIconColor || D.targetIcon)) +
        '" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M5 12h13M12 5l7 7-7 7"/></svg>'
      : methodGlyph(method)) + "</span>";
  const dial = method === "phone" && open
    ? '<input class="tz-dial" data-dial="1" value="' + esc(AUTH.dial) + '" maxlength="5"' +
      ' inputmode="tel" aria-label="' + esc(K.txt("desktop.gate.countryCode", "Country code")) + '">'
    : "";
  return '<div class="tz-pill" style="' + s + ";height:" + h + "px;border-radius:" +
    (Number(p.radius) || h / 2) + "px;background:" + esc(tok(p.background || D.background)) +
    ";border:1px solid " + esc(tok(p.borderColor || D.border)) + '">' +
    disc + dial +
    '<input class="tz-pillin" data-pill="' + method + '"' +
    // TEXT, not email. Chromium refuses setSelectionRange on an email input,
    // and the caret has to be restored by hand after every repaint — so the
    // stricter type costs the field its cursor. inputmode still summons the
    // right keyboard and autocomplete still offers the right address.
    ' type="' + (method === "phone" ? "tel" : "text") + '"' +
    ' inputmode="' + (method === "phone" ? "tel" : "email") + '"' +
    ' placeholder="' + esc(label) + '" aria-label="' + esc(label) + '"' +
    ' autocomplete="' + (method === "phone" ? "tel" : "email") + '"' +
    ' spellcheck="false" value="' + esc(value) + '"' +
    ' style="padding-left:' + (open ? (method === "phone" ? 96 : 20) : h + 6) + "px" +
    ";padding-right:" + (open ? h + 6 : 18) + "px" +
    ";font-size:" + (Number(p.fontSize) || D.fontSize) + "px" +
    ";color:" + esc(tok(p.textColor || D.text)) + '"></div>';
}

function methodGlyph(method) {
  return method === "phone"
    ? '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.7)" stroke-width="1.8" stroke-linecap="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>'
    : '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.7)" stroke-width="1.8" stroke-linecap="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 6 10-6"/></svg>';
}

/** The code step: one pill, the digits spaced out, dots for what is missing. */
function codeEntry(p, s) {
  const D = pillDefaults();
  const h = Number(p.height) || D.height;
  const len = AUTH.codeLength;
  const shown = AUTH.code.padEnd(len, "·").split("").join(" ");
  const done = AUTH.code.length === len;
  return '<div class="tz-pill' + (AUTH.codeError ? " tz-shake" : "") + '" data-codebox="1" style="' + s +
    ";height:" + h + "px;border-radius:" + (h / 2) + "px;cursor:text" +
    ";background:" + esc(D.background) + ";border:1px solid " +
    (AUTH.codeError ? "var(--danger)" : done ? esc(tok(D.target)) : esc(D.border)) + '">' +
    // A real input, held invisible over the pill: the browser's own autofill
    // for a one-time code only offers itself to a field it can see.
    '<input data-code="1" inputmode="numeric" autocomplete="one-time-code"' +
    ' maxlength="' + len + '" value="' + esc(AUTH.code) + '" aria-label="' +
    esc(K.txt("desktop.gate.codeLabel", "Enter the code we sent you")) + '"' +
    ' style="position:absolute;inset:0;width:100%;height:100%;opacity:0;border:0;background:none">' +
    '<span style="width:100%;text-align:center;pointer-events:none;font-variant-numeric:tabular-nums' +
    ";letter-spacing:" + (Number(p.letterSpacing) || D.codeSpacing) + "px" +
    ";font-size:" + (Number(p.fontSize) || D.codeFontSize) + "px" +
    ";color:" + esc(D.text) + '">' + esc(shown) + "</span></div>";
}

/** Apple and Google, as the round icon buttons the phones draw — not the wide
 *  labelled rows this window used to have. */
function socialButton(provider, p, s) {
  const size = Number(p.size) || K.num("desktop.gate.socialSize", 52);
  const mark = provider === "apple"
    ? '<svg width="' + Math.round(size * 0.42) + '" height="' + Math.round(size * 0.42) +
      '" viewBox="0 0 24 24"><path fill="#fff" d="M16.365 1.43c0 1.14-.493 2.27-1.177 3.08-.744.9-1.99 1.57-2.987 1.57-.12 0-.23-.02-.3-.03-.01-.06-.04-.22-.04-.39 0-1.15.572-2.27 1.206-2.98.804-.94 2.142-1.64 3.248-1.68.03.13.05.28.05.43zm4.565 15.71c-.03.07-.46 1.58-1.51 3.14-.9 1.36-1.84 2.71-3.32 2.71-1.48 0-1.86-.88-3.56-.88-1.66 0-2.25.91-3.6.91-1.36 0-2.3-1.27-3.22-2.61-1.87-2.61-3.34-7.53-1.42-10.86.95-1.66 2.65-2.7 4.5-2.73 1.4-.03 2.72.95 3.58.95.85 0 2.45-1.18 4.12-1.01.7.03 2.67.28 3.93 2.13-.1.06-2.35 1.37-2.33 4.07.03 3.22 2.83 4.29 2.86 4.31z"/></svg>'
    : '<svg width="' + Math.round(size * 0.40) + '" height="' + Math.round(size * 0.40) +
      '" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';
  return '<button class="tz-social tz-press" data-oauth="' + provider + '"' +
    ' aria-label="' + esc(K.txt("desktop.gate.continueWith", "Continue with {provider}",
      { provider: provider === "apple" ? "Apple" : "Google" })) + '"' +
    ' style="' + s + ";width:" + size + "px;height:" + size + 'px">' + mark + "</button>";
}

function wordMeter(p) {
  const base = +p.base || 0, earned = +p.earned || 0;
  const total = Math.max(1, base + earned);
  const used = Math.max(0, Math.min(total, +p.used || 0));
  const left = total - used;
  const tick = earned > 0 ? (base / total) * 100 : -1;
  const fill = p.fillColor || "var(--accent)";
  const big = K.num("desktop.meter.bigSize", 28), small = K.num("desktop.meter.smallSize", 13);
  const tiny = K.num("desktop.meter.tinySize", 12), bar = K.num("desktop.meter.barHeight", 10);
  return '<div><div style="display:flex;justify-content:space-between;align-items:baseline">' +
    '<span style="color:var(--text);font-size:' + big + 'px;font-weight:700;letter-spacing:-.5px">' + left.toLocaleString() + "</span>" +
    '<span style="color:var(--label);font-size:' + small + 'px">' +
    esc(K.txt("desktop.meter.used", "{used} of {total} used", { used: used.toLocaleString(), total: total.toLocaleString() })) +
    "</span></div>" +
    '<div style="color:var(--label);font-size:' + small + 'px;margin-top:2px">' + esc(K.txt("desktop.meter.left", "words left")) + "</div>" +
    '<div style="height:' + bar + "px;border-radius:" + (bar / 2) +
    'px;background:var(--border);margin-top:12px;position:relative;overflow:hidden">' +
    '<div style="width:' + (used / total) * 100 + "%;height:100%;background:" + fill + '"></div>' +
    (tick >= 0 ? '<div style="position:absolute;top:0;bottom:0;left:' + tick + '%;width:2px;background:var(--bg)"></div>' : "") +
    '</div><div style="display:flex;gap:14px;margin-top:10px">' +
    '<span style="color:var(--label);font-size:' + tiny + 'px">' +
    esc(K.txt("desktop.meter.free", "{n} free", { n: base.toLocaleString() })) + "</span>" +
    (earned > 0 ? '<span style="color:' + (p.earnedColor || "var(--accent)") + ";font-size:" + tiny + 'px;font-weight:600">' +
      esc(K.txt("desktop.meter.earned", "+{n} earned", { n: earned.toLocaleString() })) + "</span>" : "") + "</div>" +
    (p.caption ? '<div style="color:var(--label);font-size:' + small + 'px;margin-top:12px">' + esc(p.caption) + "</div>" : "") + "</div>";
}

function pie(p) {
  const data = (p.data || []).filter((d) => (+d.value || 0) > 0);
  const total = data.reduce((n, d) => n + (+d.value || 0), 0);
  const size = p.size || K.num("desktop.pie.size", 150), r = size / 2;
  const inner = p.donut === false ? 0 : r - r * K.num("desktop.pie.ring", 0.26);
  const fallback = K.color("desktop.chart.color", "#E8A23C");
  const legendSize = K.num("desktop.pie.legendSize", 12.5);
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
        esc(d.color || fallback) + '" stroke-width="' + (r - inner) + '"/>'
      : '<path d="M ' + x0 + " " + y0 + " A " + r + " " + r + " 0 " + big + " 1 " + x1 + " " + y1 +
        " L " + ix1 + " " + iy1 + " A " + inner + " " + inner + " 0 " + big + " 0 " + ix0 + " " + iy0 +
        ' Z" fill="' + esc(d.color || fallback) + '"/>';
    a = a1;
  });
  const legend = p.legend === false ? "" :
    '<div style="display:flex;flex-direction:column;gap:6px;flex:1;min-width:0">' + data.map((d) =>
      '<div style="display:flex;align-items:center;gap:8px;min-width:0">' +
      '<span style="width:8px;height:8px;border-radius:50%;flex:none;background:' + esc(d.color || fallback) + '"></span>' +
      '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:' + legendSize + 'px">' +
      esc(d.label || "") + "</span>" +
      '<span style="color:var(--label);font-size:' + legendSize + 'px">' + Math.round(((+d.value) / total) * 100) +
      "%</span></div>").join("") + "</div>";
  const centre = p.centerValue != null
    ? '<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">' +
      '<div style="color:var(--text);font-size:' + K.num("desktop.pie.centerSize", 19) + 'px;font-weight:700">' +
      esc(p.centerValue) + "</div>" +
      '<div style="color:var(--label);font-size:' + K.num("desktop.pie.centerLabelSize", 11) + 'px">' +
      esc(p.centerLabel || "") + "</div></div>"
    : "";
  return '<div style="display:flex;align-items:center;gap:18px"><div style="position:relative;flex:none;width:' +
    size + "px;height:" + size + 'px"><svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + " " + size + '">' +
    paths + "</svg>" + centre + "</div>" + legend + "</div>";
}

function bars(p) {
  const vals = (p.series || []).map((x) => (typeof x === "number" ? x : +x.value || 0));
  if (!vals.length) return "";
  const max = Math.max.apply(null, vals.concat([1]));
  const minPct = K.num("desktop.bars.minPct", 2);
  return '<div style="display:flex;align-items:flex-end;gap:' + K.num("desktop.bars.gap", 4) +
    "px;height:" + K.num("desktop.bars.height", 110) + 'px">' + vals.map((v) =>
    '<div style="flex:1;border-radius:' + K.num("desktop.bars.radius", 3) + "px;background:" +
    esc(p.color || K.color("desktop.chart.color", "#E8A23C")) +
    ';height:' + Math.max(minPct, (v / max) * 100) + '%"></div>').join("") + "</div>";
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("on"), K.num("desktop.toast.ms", 2600));
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

    // ── buying ────────────────────────────────────────────────────────────
    // Every row on the paywall fires one of these, and this window answered
    // none of them: the screen drew, the rows clicked, and nothing happened —
    // the same silence `navigateBack` used to fall into.
    //
    // RevenueCat has no desktop SDK, so there is no store to call. Web Billing
    // is its own checkout, opened in the user's browser, and the identity
    // already lines up — the app user id is the Supabase user id on both
    // sides, so paying here writes the same entitlements row a phone purchase
    // writes, and someone who paid on their phone is already entitled here.
    case "iap.subscribe":
    case "iap.showPaywall":
      return buyOnWeb();

    // NOTHING TO RESTORE FROM, and nothing that needs restoring. On a phone
    // this asks the store to re-attach a purchase made on another device. Here
    // the server already knows: entitlement is a row against this account, not
    // a receipt on this machine. So the honest action is to go and ask it.
    case "iap.restore":
      await refreshEntitlement(true);
      return;
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
        if (err && err.quota) { go(K.str("quota.screenId", "paywall")); return; }
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

/**
 * A screen the MAIN PROCESS asked for — the paywall, when the hotkey was
 * refused for being out of words. The window may still be booting, so the
 * request waits for render() to lay the landing tab down and goes on top of
 * it; and a second request for the screen already showing is not a second
 * copy of it.
 */
let PENDING_SCREEN = null;
function navigateTo(screenId) {
  if (typeof screenId !== "string" || !screenId) return;
  if (!SESSION || !STACK.length) { PENDING_SCREEN = screenId; return; }
  const top = STACK[STACK.length - 1];
  if (top && top.screenId === screenId) return;
  go(screenId);
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
  // THE SCREEN THAT IS UP STAYS UP UNTIL THE NEXT ONE IS READY.
  //
  // This used to blank the view to "Loading…" the instant a navigation began,
  // so every screen change was three frames the eye could count: the old
  // screen gone, grey text on black, the new screen. On slide-to-begin that
  // was the blink between the pill and the session. Now the old screen holds
  // while the next is fetched and is replaced in ONE frame when it lands. The
  // word "Loading…" appears only if the fetch is genuinely slow — and it is
  // opaque, so nothing under the view can show through it.
  const seq = paint._seq = (paint._seq || 0) + 1;
  const fresh = force || !paint._last || paint._last !== cur.screenId;
  let slow = 0;
  const loading = esc(K.txt("desktop.screen.loading", "Loading…"));
  if (!paint._last) {
    view.innerHTML = '<div class="pad" style="color:var(--label)">' + loading + "</div>";
  } else if (fresh) {
    slow = setTimeout(() => {
      if (seq !== paint._seq) return;
      dropField();
      view.innerHTML = '<div class="pad" style="color:var(--label);background:var(--bg);min-height:100%">' + loading + "</div>";
    }, K.num("desktop.screen.slowMs", 700));
  }
  paint._last = cur.screenId;
  let screen;
  try {
    screen = await fetchScreen(cur.screenId, cur.params);
  } catch (err) {
    clearTimeout(slow);
    if (seq !== paint._seq) return;
    // Out of words is not a broken screen: it is the one the server names
    // for it, in place of the one that was refused.
    const quotaScreen = K.str("quota.screenId", "paywall");
    if (err && err.quota && cur.screenId !== quotaScreen) {
      STACK[STACK.length - 1] = { screenId: quotaScreen };
      return paint(true);
    }
    dropField();
    view.innerHTML = '<div class="pad"><p style="color:var(--danger)">' +
      esc(K.txt("desktop.screen.loadFailed", "Couldn't load this screen.")) + "</p>" +
      '<p style="color:var(--label);font-size:13px">' + esc(String(err.message || err)) + "</p></div>";
    return;
  }
  clearTimeout(slow);
  // A newer navigation started while this one was in flight. Its screen is
  // the one that should land; this one would paint over it a moment later.
  if (seq !== paint._seq) return;
  STATE = Object.assign({}, screen.state || {});
  // Picks belong to the thread that was on screen. A new screen has none.
  CHAT_PICKED = {};
  CURRENT_ACTIONS = screen.actions || {};
  $("title").textContent = label(screen.title) || "";
  $("back").hidden = STACK.length <= 1;
  applyChrome(screen);
  repaint(screen);
}

/**
 * A SCREEN THAT OWNS THE WINDOW.
 *
 * `hideChrome` and `hideHeader` are how the catalog says "this screen is the
 * whole surface" — the paywall says it, and so does the history view with its
 * own back chevron. Neither word appeared anywhere in this renderer, so the
 * paywall drew inside the rail and under the crumb: full-bleed art in a strip,
 * beside a nav bar it had asked not to have.
 *
 * Two more things a full-bleed screen needs that a padded column does not. Its
 * root asks for `flex: 1`, which means nothing inside a plain block — so the
 * view becomes a flex column for it and the root can actually fill. And it
 * scrolls no more: a screen the size of the window has nothing to scroll, and
 * an overflow container would let one stray absolute child add a scrollbar to
 * a screen with no content below the fold.
 */
function applyChrome(screen) {
  const bare = screen.hideChrome === true;
  const shell = $("shell"), view = $("view");
  shell.dataset.chrome = bare ? "0" : "1";
  $("crumb").hidden = bare || screen.hideHeader === true;
  view.dataset.full = bare ? "1" : "0";
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
/** NeuralField props that are sent as messages or as their own parameter,
 *  never inside the `cfg` the page bakes. */
const FIELD_LIVE = ["alpha", "growth", "state", "level", "training"];
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

/** The screen that owned the field is gone, or going. Drop the iframe with it
 *  rather than keep a canvas alive for a screen nobody is on — and rather than
 *  leave it standing under whatever the view shows next. */
function dropField() {
  if (FIELD_TRACK) FIELD_TRACK();
  if (FIELD_EL) { try { FIELD_EL.remove(); } catch {} FIELD_EL = null; }
  FIELD_BINDS = FIELD_PROPS = null; FIELD_LAST = "";
}

/**
 * NOTHING BETWEEN THE FIELD AND THE VIEW MAY BE OPAQUE.
 *
 * On the phones the field is a child of the screen, so it paints over the
 * screen's own background, as a child does. Here it is a layer UNDER the whole
 * view — which is what keeps it from reloading on every paint — and that turns
 * the painting order over: the screen's background now sits on top of it. The
 * Train screen's root is solid black, so the field ran at full size, every
 * frame, behind a black sheet, and the only time anyone saw it was the instant
 * a tab change swapped the sheet out.
 *
 * So the order is put back by hand: every background between the slot and the
 * view is lifted off, and the one nearest the field — the one it would have
 * been drawn over on a phone — becomes the iframe's own ground. Siblings that
 * come after the field (the scrim, the copy, the button) still sit above it,
 * exactly as the tree says. Re-done on every paint, since every paint writes
 * the backgrounds back.
 */
function uncoverField(slot, view) {
  let ground = "";
  for (let el = slot.parentElement; el && el !== view; el = el.parentElement) {
    const bg = getComputedStyle(el).backgroundColor;
    if (!bg || bg === "transparent" || /rgba\([^)]*,\s*0\)$/.test(bg)) continue;
    if (!ground) ground = bg;
    el.style.backgroundColor = "transparent";
  }
  return ground;
}

function wireField(view) {
  const slot = view.querySelector("[data-field]");
  if (!slot) { dropField(); return; }
  const q = slot.getAttribute("data-field") || "";
  // THE SAME FIELD, RETUNED, never a new one. A screen that wants it brighter
  // (the session, after the entry) or that knows the network has grown says
  // so over the same channel as the state, and the page eases or rebuilds in
  // place. Reloading the iframe for a new alpha was the black frame in the
  // middle of slide-to-begin.
  if (FIELD_EL && FIELD_EL.dataset.q !== q) {
    const was = new URLSearchParams(FIELD_EL.dataset.q || "");
    FIELD_EL.dataset.q = q;
    const qs = new URLSearchParams(q);
    if ((was.get("cfg") || "") !== (qs.get("cfg") || "")) {
      // Different GEOMETRY is a different drawing, and the page bakes its
      // geometry once — so this one reloads. It does not happen between the
      // screens of one catalog, which all send the same field.
      FIELD_EL.src = "neuralField.html" + q;
    } else {
      const tune = {};
      if (qs.has("alpha")) tune.alpha = Number(qs.get("alpha"));
      if (qs.has("growth")) tune.growth = Number(qs.get("growth"));
      fieldSend(tune);
    }
  }
  const ground = uncoverField(slot, view);
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
    FIELD_EL.style.visibility = "hidden";   // until place() has measured the slot
    // FIRST child of #main, so it paints under #view (which carries z-index:1).
    // The field is the art behind the copy; appended last it would cover the
    // title and the button it exists to sit behind.
    const host = view.parentElement || document.body;
    host.insertBefore(FIELD_EL, host.firstChild);
  }
  // The screen's own colour under the field, as on the phones; the window's
  // ground when the screen names none.
  FIELD_EL.style.background = ground || "var(--bg)";
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
          ? K.txt("desktop.voice.micBlocked", "microphone blocked — allow it in your system settings")
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
  // A NEW SCREEN ARRIVES, IT DOES NOT SNAP. The first paint of a screen fades
  // its content in over the field, which stays where it was; a repaint of the
  // same screen — a state change mid-session — is instant, as it must be.
  if (repaint._id !== sc.screenId && view.firstElementChild) {
    view.firstElementChild.classList.add("tz-swap");
  }
  repaint._id = sc.screenId;
  // A ROOT THAT ASKS TO FILL GETS SOMETHING TO FILL. The phones lay every
  // screen in a flex column, so a root with `flex: 1` is the height of the
  // screen there. In a plain block that number means nothing, and a root
  // whose children are all placed absolutely — the live session: the field,
  // the caption, the end button — has no height of its own and collapsed to
  // zero: black, and a field with nowhere to be. The view becomes a column
  // for such a root, and only for such a root; a padded page is left alone.
  const root = view.firstElementChild;
  view.dataset.flex = root && parseFloat(getComputedStyle(root).flexGrow) > 0 ? "1" : "0";
  startFlips();

  bindHandlers(view);
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
    const fade = K.num("desktop.flip.fadeMs", 250);
    FLIP_TIMERS.push(setInterval(() => {
      el.style.opacity = "0";
      setTimeout(() => {
        i = (i + 1) % f.words.length;
        el.textContent = f.words[i];
        el.style.opacity = "1";
      }, fade);
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
  const text = (id, v) => {
    const el = $(id);
    if (el && typeof v === "string" && v.trim()) { el.textContent = v; CHROME_PAINTED.add(id); }
  };
  const hint = (id, v) => { const el = $(id); if (el && typeof v === "string" && v.trim()) el.placeholder = v; };
  // The form itself is the server's auth.screen now — its labels are props on
  // that tree, not ids in this document. What is left here is the copy AROUND
  // it: the heading, and the line under everything.
  const g = shell.gate || {};
  text("gateTitle", g.title);       text("gateSub", g.subtitle);
  // The note is the one line that may be absent: shown only when the server
  // has something to say under the form, hidden rather than left as an empty
  // paragraph with a margin.
  text("gateNote", g.note);
  $("gateNote").hidden = !$("gateNote").textContent.trim();
  const r = shell.rail || {};
  text("railBrand", r.brand);       text("dictate", r.dictate);
  text("settingsLink", r.settings); text("signOut", r.signOut);
  text("back", r.back);
  applyGateLayout(shell.gateLayout);
}

/**
 * THE FIRST PAINT'S WORDS, FROM THE KNOBS.
 *
 * app.html carries its own copy of the chrome's words so the very first frame
 * has something in it. Those are only the fallbacks now: as soon as knobs are
 * known — the main process's cached bootstrap, before this window has asked
 * anything — each is replaced by the server's label. An element that
 * `desktop.shell` has already painted is left alone: that block is the more
 * specific answer, and it is the one the server has always sent.
 */
const CHROME_PAINTED = new Set();
function paintFirst() {
  const put = (id, v) => {
    const el = $(id);
    if (el && !CHROME_PAINTED.has(id) && typeof v === "string" && v.trim()) el.textContent = v;
  };
  document.title = K.txt("desktop.window.title", "Tailzu");
  put("gateTitle", K.txt("desktop.gate.title", "Tailzu"));
  put("gateSub", K.txt("desktop.gate.subtitle",
    "Sign in the same way you do on your phone — your voices, history and words come with you."));
  put("railBrand", K.txt("desktop.rail.brand", "Tailzu"));
  put("dictate", K.txt("desktop.rail.dictate", "Dictate now"));
  put("settingsLink", K.txt("desktop.rail.settings", "Settings"));
  put("signOut", K.txt("desktop.rail.signOut", "Sign out"));
  put("back", K.txt("desktop.rail.back", "← Back"));
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
  const wide = window.innerWidth >= (Number(L.wideAt) || K.num("desktop.gate.wideAt", 860));
  const twoCol = wide && (L.align === "right" || L.align === "left");
  g.dataset.cols = twoCol ? "1" : "0";
  if (twoCol) {
    const col = Math.min(0.95, Math.max(0.05, Number(L.column) || K.num("desktop.gate.column", 0.5)));
    // Mirrored for "left", so one number describes either side.
    g.style.setProperty("--gate-col", ((L.align === "left" ? 1 - col : col) * 100) + "%");
    g.style.setProperty("--gate-w", (Number(L.columnWidth) || K.num("desktop.gate.columnWidth", 300)) + "px");
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
    // (The bootstrap itself already went to the knobs and on to the main
    // process as it arrived — see received().)
    const anon = await gateBoot();
    if (anon) {
      BOOT = anon;                 // role() resolves typography against it too
      applyTheme(anon.theme);
      paintChrome(anon.flags && anon.flags["desktop.shell"]);
    }
    return;
  }
  BOOT = await bootstrap();
  applyTheme(BOOT.theme);
  paintChrome(BOOT.flags && BOOT.flags["desktop.shell"]);
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
  // A screen the main process asked for while this was booting goes on top
  // of the landing tab, so Back still leads somewhere.
  if (PENDING_SCREEN && PENDING_SCREEN !== STACK[0].screenId) STACK.push({ screenId: PENDING_SCREEN });
  PENDING_SCREEN = null;
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

/**
 * Paint the sign-in screen from the server's tree, and wire what it drew.
 *
 * Called on every change to AUTH, which is the whole state machine: a phase, a
 * typed value, a code. Repainting the lot each time is cheap — it is six rows —
 * and it means there is exactly one description of what the screen looks like
 * at any moment, rather than a set of imperative edits that have to agree.
 *
 * The rise animation is the one thing a full repaint would ruin: rows would fly
 * in again on every keystroke. So it runs once per PHASE, and repaints within a
 * phase are marked so the CSS sits them still.
 */
let AUTH_TREE = null;
let AUTH_RISEN = "";

/** The gate's error line, written from outside the sign-in state machine.
 *  A launch that never reached the backend has no tree to paint, so this
 *  writes the line directly: paintGate() draws nothing without one, and
 *  "couldn't reach the backend" is the one sentence that screen has to be
 *  able to say. */
function fail(msg) {
  AUTH.error = String(msg || "");
  const el = $("gateErr");
  if (el) el.textContent = AUTH.error;
}

function paintGate() {
  const host = $("gateForm");
  if (!host || !AUTH_TREE) return;
  const fresh = AUTH_RISEN !== AUTH.phase;
  AUTH_RISEN = AUTH.phase;
  host.dataset.still = fresh ? "0" : "1";
  // `handlers` is a module-level list that node() appends to as it renders an
  // `on.onPress`. repaint() clears it before drawing a screen; this draws
  // outside repaint(), so it has to clear it too — or the gate accumulates a
  // screen's worth of stale entries and binds by an id that has moved.
  handlers = [];
  host.innerHTML = node(AUTH_TREE);
  $("gateErr").textContent = AUTH.error;
  bindHandlers(host);
  wireGate();
}

/**
 * Attach what node() registered while rendering.
 *
 * This only ever ran inside repaint(), so a press written into the SERVER'S
 * auth tree drew its attribute and got no listener — the consent line's Terms
 * and Privacy Policy would have been underlined, looked tappable, and done
 * nothing. Exactly the failure `navigateBack` used to be.
 */
function bindHandlers(root) {
  handlers.forEach((h) => {
    const el = root.querySelector('[data-h="' + h.id + '"]');
    if (el) el.addEventListener("click", () => { void run(h.action); });
  });
}

function wireGate() {
  const host = $("gateForm");

  // Typing. The pill is the field, so its input writes straight into AUTH —
  // WITHOUT a repaint, which would take the caret with it. The disc's position
  // is the only thing that depends on the value, so it is moved by hand.
  host.querySelectorAll("[data-pill]").forEach((el) => {
    const m = el.getAttribute("data-pill");
    el.addEventListener("focus", () => {
      if (AUTH.open === m) return;
      AUTH.open = m; AUTH.error = "";
      paintGate();
      const again = host.querySelector('[data-pill="' + m + '"]');
      if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
    });
    el.addEventListener("input", () => {
      if (m === "phone") AUTH.phone = el.value; else AUTH.email = el.value;
      refreshDisc(m);
    });
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") void commit(m); });
  });
  const dial = host.querySelector("[data-dial]");
  if (dial) {
    dial.addEventListener("input", () => { AUTH.dial = dial.value; refreshDisc("phone"); });
    dial.addEventListener("keydown", (e) => { if (e.key === "Enter") void commit("phone"); });
  }

  host.querySelectorAll("[data-commit]").forEach((el) => {
    const m = el.getAttribute("data-commit");
    el.addEventListener("click", () => { void commit(m); });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void commit(m); }
    });
  });

  const box = host.querySelector("[data-codebox]");
  const codeIn = host.querySelector("[data-code]");
  if (box && codeIn) {
    box.addEventListener("click", () => codeIn.focus());
    codeIn.addEventListener("input", () => {
      AUTH.code = codeIn.value.replace(/\D/g, "").slice(0, AUTH.codeLength);
      codeIn.value = AUTH.code;
      AUTH.codeError = false;
      AUTH.error = "";
      // DRAWN BY HAND, NOT REPAINTED. A repaint replaced the input under the
      // caret with a fresh one, focused with its caret at the front — so the
      // next digit landed before the last, and the code read backwards; and
      // the focus did not always survive the swap, so every digit could cost
      // a click on the pill. The digits, the border and the error line are
      // the only things that change, and each is written in place.
      const shown = box.querySelector("span");
      if (shown) shown.textContent = AUTH.code.padEnd(AUTH.codeLength, "\u00b7").split("").join(" ");
      box.classList.remove("tz-shake");
      const D = pillDefaults();
      box.style.borderColor = AUTH.code.length === AUTH.codeLength ? tok(D.target) : D.border;
      $("gateErr").textContent = "";
      codeIn.setSelectionRange(AUTH.code.length, AUTH.code.length);
      // Six digits is the whole answer — there is nothing else to press.
      if (AUTH.code.length === AUTH.codeLength) void submitCode();
    });
    codeIn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && AUTH.code.length === AUTH.codeLength) void submitCode();
    });
    // The caret belongs here the moment the step opens — this IS the step.
    setTimeout(() => { const c = $("gateForm").querySelector("[data-code]"); if (c) c.focus(); },
      K.num("desktop.gate.codeFocusMs", 320));
  }

  host.querySelectorAll("[data-oauth]").forEach((el) => {
    el.addEventListener("click", () => { void oauth(el.getAttribute("data-oauth")); });
  });
}

/**
 * THE WAY BACK FROM THE CODE STEP.
 *
 * The phones have a corner arrow and a swipe from the left edge. This tree
 * carries neither, and a window has the gesture everybody already uses to back
 * out of anything: Escape. Without it a typo in the address was a dead end —
 * the code never arrives and there is nothing on the screen to press.
 *
 * The typed address is kept. Coming back to correct one character should not
 * clear the field.
 */
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if ($("gate").hidden || AUTH.phase !== "verify") return;
  AUTH.phase = "entry";
  AUTH.code = "";
  AUTH.codeError = false;
  AUTH.error = "";
  paintGate();
  void dressGate("entry");
});

/**
 * Send the code. The phones swipe a badge to get here; a mouse has no thumb to
 * rest, so the disc is clicked and Enter does the same — the rule SwipeAction
 * already follows on the training tab.
 */
async function commit(method) {
  if (AUTH.phase !== "entry") return;   // already sending
  AUTH.error = "";
  try {
    let to;
    if (method === "phone") {
      to = (AUTH.dial + AUTH.phone).replace(/[^\d+]/g, "");
      if (!/^\+\d{7,15}$/.test(to)) {
        throw new Error(K.txt("desktop.gate.badPhone", "Enter a number with its country code, like +1 555 000 1234."));
      }
    } else {
      to = AUTH.email.trim();
      if (!/.+@.+\..+/.test(to)) throw new Error(K.txt("desktop.gate.badEmail", "Enter your email address."));
    }
    AUTH.phase = "sending";
    paintGate();
    if (method === "phone") await signInPhone(to); else await signIn(to);
    AUTH.method = method;
    AUTH.sentTo = to;
    AUTH.code = "";
    AUTH.codeError = false;
    AUTH.phase = "verify";
    paintGate();
    void dressGate("code");
  } catch (e) {
    AUTH.phase = "entry";
    AUTH.error = String((e && e.message) || e || "");
    paintGate();
  }
}

/** Answer with whichever address the code actually went to. */
async function submitCode() {
  if (AUTH.phase !== "verify") return;
  AUTH.phase = "verifying";
  AUTH.error = "";
  paintGate();
  try {
    if (AUTH.method === "phone") await verifyPhone(AUTH.sentTo, AUTH.code);
    else await verify(AUTH.sentTo, AUTH.code);
    await render();
  } catch (e) {
    // The code was wrong, not the screen. Stay on the step, say so, shake it,
    // and clear it — retyping six digits over six wrong ones is worse than
    // starting them again.
    AUTH.phase = "verify";
    AUTH.codeError = true;
    AUTH.code = "";
    AUTH.error = String((e && e.message) || e || "");
    paintGate();
  }
}

/** Apple / Google. The main process owns the window, the PKCE secret and the
 *  code exchange; this only asks and reacts. */
async function oauth(provider) {
  AUTH.error = "";
  const host = $("gateForm");
  host.querySelectorAll("[data-oauth]").forEach((b) => { b.disabled = true; });
  try {
    const r = await window.tailzuApp.oauth(provider);
    if (!r || !r.ok) {
      // Closing the window is a decision, not a failure worth shouting about.
      if (r && r.error === "cancelled") return;
      throw new Error((r && r.error) || K.txt("desktop.gate.signInFailed", "Sign-in failed."));
    }
    SESSION = r.session;
    location.reload();
  } catch (e) {
    AUTH.error = String((e && e.message) || e || "");
    paintGate();
  } finally {
    const again = $("gateForm");
    if (again) again.querySelectorAll("[data-oauth]").forEach((b) => { b.disabled = false; });
  }
}

/** The disc alone, so typing does not repaint the caret out of the field. */
function refreshDisc(method) {
  const host = $("gateForm");
  const el = host && host.querySelector('[data-commit="' + method + '"]');
  if (!el) return;
  const ready = method === "phone"
    ? /^\+?\d{7,15}$/.test((AUTH.dial + AUTH.phone).replace(/[^\d+]/g, ""))
    : /.+@.+\..+/.test(AUTH.email.trim());
  if (el.dataset.ready === String(ready)) return;
  el.dataset.ready = String(ready);
  // Re-rendered rather than restyled: at the right end it is an arrow, at the
  // left it is the method's own glyph, and those are different drawings.
  paintGate();
  const again = $("gateForm").querySelector('[data-pill="' + method + '"]');
  if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
}

(async function start() {
  // Listen before asking, so nothing sent in between is missed: the main
  // process pushes new knobs whenever it adopts a bootstrap, and asks for a
  // screen when it refuses the hotkey for being out of words.
  try { window.tailzuApp.onKnobs((k) => { K.setKnobs(k); paintFirst(); }); } catch { /* tray only */ }
  try { window.tailzuApp.onNavigate((id) => navigateTo(id)); } catch { /* tray only */ }

  ENV = await window.tailzuApp.env();
  SESSION = ENV.session || null;
  // The main process's cached bootstrap: the server's words and numbers for
  // this first paint, before this window has asked the server anything.
  if (ENV.knobs) K.setKnobs(ENV.knobs);
  paintFirst();
  if (ENV.navigate) PENDING_SCREEN = ENV.navigate;

  $("dictate").addEventListener("click", () => {
    window.tailzuApp.dictate();
    toast(K.txt("desktop.toast.listening", "Listening — {key} stops",
      { key: ENV.hotkey || K.txt("desktop.toast.yourHotkey", "your hotkey") }));
  });
  $("settingsLink").addEventListener("click", () => go("settings"));
  $("back").addEventListener("click", back);
  $("signOut").addEventListener("click", async () => {
    await setSession(null);
    // Drop the tray's token too, or it keeps reading the account of someone
    // who just signed out of it.
    try { window.tailzuApp.token(null); } catch { /* tray only */ }
    location.reload();
  });

  if (!SESSION) {
    const b = await gateBoot();
    const flags = (b && b.flags) || {};
    AUTH.phoneOn = flags["auth.enablePhone"] === true || flags["auth.enablePhone"] === "true";
    AUTH_TREE = flags["auth.screen"] || null;
    paintGate();
    void dressGate("entry");
  }

  try {
    await render();
  } catch (e) {
    // A failed bootstrap must not leave a blank window with no way out.
    $("gate").hidden = false;
    $("shell").hidden = true;
    fail(K.txt("desktop.gate.offline", "Couldn't reach the backend: {error}", { error: String((e && e.message) || e) }));
  }
})();
