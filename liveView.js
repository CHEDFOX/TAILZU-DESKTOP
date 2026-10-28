/**
 * LiveView IN THE WINDOW: a running web page or artifact (the server's shared/types/sdui.ts 3e). Loaded after sdui.js, whose
 * state, actions and painting it uses; liveViewMain.js is the main process's half, liveViewGuest.js the page's preload.
 *
 * NEVER THE APP'S ORIGIN. Each live page is a <webview>: a separate page in a separate process, in a session of its own ("tz-live",
 * in memory) that holds none of the app's storage, cookies or tokens (the main process keeps the session; this window holds a short-
 * lived access token in memory and nothing here reaches it). liveViewMain.js forces every webview's preferences (no Node, context
 * isolation, the sandbox, this one preload), refuses every permission and download, lets a page move only within its own site,
 * and denies new windows. Only http(s), data: and about: pages are loaded. A link that leaves the page is OFFERED to open in the
 * browser, only when the node allows popups, and only after the person says yes.
 *
 * NOT IN THE PAGE'S MARKUP. Every paint replaces #view's HTML, and a webview that is moved or rebuilt reloads. So the node draws an
 * empty slot (liveViewNode), and the webview is a layer in #main laid exactly over it (wireLive), clipped to the view, kept by its
 * source across paints, and dropped when a paint has no slot for it.
 *
 * TALKING. The page says things with window.tailzuLive.post(obj) (the preload): `ready` (drawn), `failed`, `open` (a link to offer);
 * anything else goes to the node's `messagePath` and on.onResult. Every message is untrusted. `send` (bound to state) is handed to
 * the page's window.tzLive whenever it changes and after each load.
 *
 * States: loading (until it loads, or says `ready` when `waitForReady`; 15 s at most), the page, or "Couldn't show this page" with
 * "Try again" (a new webview).
 */
/* eslint-env browser */

const LIVE_READY_MS = 15000;
const LIVE_MESSAGE_MAX = 8 * 1024;
const LIVE_HTML_MAX = 2 * 1024 * 1024;

// ------------------------------------------------------------------------- the rules (pure; liveView.test.js)

function liveOriginOf(url) {
  if (typeof url !== "string") return null;
  const m = /^(https?):\/\/([^/?#]*)/i.exec(url.trim());
  if (!m || !m[2] || m[2].indexOf("@") !== -1) return null;
  return m[1].toLowerCase() + "://" + m[2].toLowerCase();
}

/** An http(s) address that may be opened in the browser: its host, or null. */
function liveOpenableHost(url) {
  const o = liveOriginOf(url);
  return o ? o.replace(/^https?:\/\//, "").replace(/:\d+$/, "") : null;
}

/** Where the page comes from: { kind: "url", url } | { kind: "html", html, baseUrl }, or null when nothing may be shown. */
function liveSourceOf(p) {
  p = p || {};
  if (typeof p.html === "string" && p.html) {
    if (p.html.length > LIVE_HTML_MAX) return null;
    const o = liveOriginOf(p.origin);
    return { kind: "html", html: p.html, baseUrl: o && o.indexOf("https://") === 0 ? o + "/" : "" };
  }
  if (typeof p.url !== "string") return null;
  const url = p.url.trim();
  const scheme = ((/^([a-z][a-z0-9+.-]*):/i.exec(url) || [])[1] || "").toLowerCase();
  if (scheme === "http" || scheme === "https") return liveOriginOf(url) ? { kind: "url", url } : null;
  if (scheme === "data" || scheme === "about") return { kind: "url", url };
  return null;
}

/** A message the page sent: a small object with a `t`, or null. */
function liveParse(raw) {
  if (typeof raw !== "string" || raw.length > LIVE_MESSAGE_MAX) return null;
  let v;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  if (typeof v.t !== "string" || !v.t || v.t.length > 32) return null;
  return v;
}

/** What the app tells the page (its window.tzLive), as a line of script; null when there is nothing to tell. */
function liveSendScript(send) {
  if (!send || typeof send !== "object" || Array.isArray(send)) return null;
  let json;
  try { json = JSON.stringify(send); } catch { return null; }
  if (!json || json.length > LIVE_MESSAGE_MAX) return null;
  json = json.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return "try { if (typeof window.tzLive === \"function\") window.tzLive(" + json + "); } catch (e) {} true;";
}

/** A short key for a source, so the same page keeps its webview across paints. */
function liveKey(src) {
  const s = src.kind === "html" ? "h" + src.baseUrl + src.html : "u" + src.url;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36) + "-" + s.length.toString(36);
}

/** The page the server wrote, as an address the webview can load. */
function liveDataUrl(html) {
  const bytes = new TextEncoder().encode(html);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return "data:text/html;charset=utf-8;base64," + btoa(bin);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { liveSourceOf, liveParse, liveSendScript, liveOpenableHost, liveKey, liveOriginOf, LIVE_READY_MS };
}

// ------------------------------------------------------------------------- the window

/** Can this window make a webview at all (the main process turned the tag on for it)? Asked once. */
let LIVE_ON = null;
function liveViewOn() {
  if (LIVE_ON === null) {
    try { LIVE_ON = typeof document.createElement === "function" && typeof document.createElement("webview").loadURL === "function"; } catch { LIVE_ON = false; }
  }
  return LIVE_ON;
}

const LIVE = new Map();      // key -> the live page: { key, layer, wv, src, node, props, phase, loads, sent, timer, seen }
let LIVE_SLOTS = [];         // what this paint drew: [{ key, node, props }]

/** The slot a paint draws (sdui.js node()): an empty box of the node's size. The page itself is a layer over it (wireLive). */
function liveViewNode(n, p, s) {
  const src = liveSourceOf(p);
  const h = typeof p.height === "number" ? "height:" + p.height + "px;" : "";
  if (!src || !liveViewOn()) {
    const words = esc(typeof p.errorText === "string" && p.errorText ? p.errorText : K.txt("liveView.error", "Couldn't show this page."));
    return '<div style="' + (s ? s + ";" : "") + h + 'display:flex;align-items:center;justify-content:center;"><span style="font-size:14px;color:#3d3d3d">' + words + "</span></div>";
  }
  const key = liveKey(src);
  const send = n.bind && n.bind.send ? stateAt(n.bind.send) : p.send;
  LIVE_SLOTS.push({ key, node: n, props: Object.assign({}, p, { send }), src });
  return '<div data-live="' + key + '" style="' + (s ? s + ";" : "") + h + 'position:relative;"' + (p.title ? ' aria-label="' + esc(p.title) + '"' : "") + "></div>";
}

/** After a paint: a layer over each slot, the same webview for the same page, and none for a page no longer drawn. */
function wireLive(view) {
  const slots = LIVE_SLOTS;
  LIVE_SLOTS = [];
  const here = new Set();
  for (const slot of slots) {
    const el = view.querySelector('[data-live="' + slot.key + '"]');
    if (!el) continue;
    here.add(slot.key);
    let live = LIVE.get(slot.key);
    if (!live) { live = liveMake(slot); LIVE.set(slot.key, live); }
    live.node = slot.node;
    live.props = slot.props;
    live.slot = el;
    // The slot's corners, so the page has the page's corners.
    try { live.layer.style.borderRadius = getComputedStyle(el).borderRadius; } catch { /* none */ }
    liveTell(live);
  }
  for (const [key, live] of LIVE) if (!here.has(key)) liveDrop(live);
  livePlace();
  liveFollow();
}

/**
 * The layers follow their slots every frame while there are any: the view scrolls, the window resizes, the page above a slot grows,
 * and a paint that drew no slot (a failed load's message) hides them. A few rectangles a frame; nothing while there is no live page.
 */
let LIVE_RAF = 0;
function liveFollow() {
  if (LIVE_RAF || !LIVE.size || typeof requestAnimationFrame !== "function") return;
  const tick = () => {
    if (!LIVE.size) { LIVE_RAF = 0; return; }
    livePlace();
    LIVE_RAF = requestAnimationFrame(tick);
  };
  LIVE_RAF = requestAnimationFrame(tick);
}

/** Drop every live page (the window signed out, or is going). */
function dropLive() {
  for (const live of LIVE.values()) liveDrop(live);
}

function liveDrop(live) {
  clearTimeout(live.timer);
  try { live.layer.remove(); } catch { /* gone */ }
  LIVE.delete(live.key);
}

const LIVE_INK = "#0a0a0a", LIVE_META = "#5c5c5c";

function liveMake(slot) {
  const layer = document.createElement("div");
  layer.className = "tz-live";
  layer.setAttribute("style", "position:absolute;z-index:2;overflow:hidden;visibility:hidden;background:transparent");
  const cover = document.createElement("div");
  cover.setAttribute("style", "position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:18px;text-align:center;background:#ffffff");
  layer.appendChild(cover);
  const host = $("main") || document.body;
  host.appendChild(layer);
  const live = { key: slot.key, layer, cover, wv: null, src: slot.src, node: slot.node, props: slot.props, phase: "loading", loads: 0, sent: "", timer: 0 };
  liveStart(live);
  return live;
}

/** A new webview for the page: on first paint, and on "Try again". */
function liveStart(live) {
  if (live.wv) { try { live.wv.remove(); } catch { /* gone */ } }
  live.loads = 0; live.sent = ""; live.base = false;
  const wv = document.createElement("webview");
  wv.setAttribute("partition", "tz-live");
  wv.setAttribute("style", "position:absolute;inset:0;width:100%;height:100%;opacity:0");
  const src = live.src;
  // A page the server wrote, run as its origin, is loaded once the webview is up; without an origin it runs as an opaque one.
  wv.setAttribute("src", src.kind === "url" ? src.url : src.baseUrl ? "about:blank" : liveDataUrl(src.html));
  wv.addEventListener("dom-ready", () => {
    if (src.kind === "html" && src.baseUrl && !live.base) {
      live.base = true;
      wv.loadURL(liveDataUrl(src.html), { baseURLForDataURL: src.baseUrl }).catch(() => liveFail(live, ""));
    }
  });
  wv.addEventListener("did-stop-loading", () => {
    if (src.kind === "html" && src.baseUrl && !live.base) return;   // still the blank page before the real one
    live.loads++;
    live.sent = "";
    liveTell(live);
    if (!(live.props && live.props.waitForReady === true) && live.phase === "loading") liveShow(live, "ready");
  });
  wv.addEventListener("did-fail-load", (e) => { if (e.isMainFrame && e.errorCode !== -3) liveFail(live, ""); });
  wv.addEventListener("render-process-gone", () => liveFail(live, ""));
  wv.addEventListener("ipc-message", (e) => { if (e.channel === "tz-live") liveHeard(live, e.args && e.args[0]); });
  live.wv = wv;
  live.layer.insertBefore(wv, live.cover);
  liveShow(live, "loading");
}

function liveShow(live, phase) {
  live.phase = phase;
  clearTimeout(live.timer);
  const p = live.props || {};
  const face = typeof p.fontFamily === "string" && /^[A-Za-z0-9 _-]{1,40}$/.test(p.fontFamily) ? "font-family:'" + p.fontFamily + "',var(--f-ui);" : "";
  if (live.wv) live.wv.style.opacity = phase === "ready" ? "1" : "0";
  live.cover.style.display = phase === "ready" ? "none" : "flex";
  if (phase === "loading") {
    live.cover.innerHTML = '<span class="tz-work" style="width:8px;height:8px;border-radius:4px;background:' + LIVE_META + '"></span>' +
      (p.loadingText ? '<span style="' + face + 'font-size:13px;line-height:18px;color:' + LIVE_META + '">' + esc(p.loadingText) + "</span>" : "");
    live.timer = setTimeout(() => { if (live.phase === "loading") liveFail(live, ""); }, LIVE_READY_MS);
  } else if (phase === "failed") {
    live.cover.innerHTML = '<span style="' + face + 'font-size:14px;line-height:19px;color:' + LIVE_INK + '">' +
      esc(p.errorText || K.txt("liveView.error", "Couldn't show this page.")) + "</span>" +
      '<button type="button" style="' + face + 'font-size:13px;line-height:17px;color:' + LIVE_INK + ';background:#ffffff;border:1px solid #d4d4d4;border-radius:16px;padding:7px 14px;cursor:pointer">' +
      esc(p.retryText || K.txt("liveView.retry", "Try again")) + "</button>";
    const b = live.cover.querySelector("button");
    if (b) b.addEventListener("click", () => liveStart(live));
  }
}

function liveFail(live, message) {
  if (live.phase === "failed") return;
  liveShow(live, "failed");
  const on = live.node && live.node.on && live.node.on.onError;
  if (on) void run(on, message || "");
}

/** What the page said. Untrusted: only `ready`, `failed` and `open` mean anything here; the rest is the server's to act on. */
function liveHeard(live, raw) {
  const m = liveParse(raw);
  if (!m) return;
  if (m.t === "ready") { if (live.phase !== "ready") liveShow(live, "ready"); return; }
  if (m.t === "failed") { liveFail(live, typeof m.message === "string" ? m.message.slice(0, 200) : ""); return; }
  if (m.t === "open") { if (typeof m.url === "string") liveOffer(live, m.url); return; }
  const p = live.props || {};
  if (typeof p.messagePath === "string" && p.messagePath) setStatePath(p.messagePath, m);
  const on = live.node && live.node.on && live.node.on.onResult;
  if (on) void run(on, m); else if (p.messagePath) repaint();
}

/** A link that leaves the page: opened in the browser only when the node allows it, and only after the person says yes. */
function liveOffer(live, url) {
  const host = liveOpenableHost(url);
  if (!host || !live.props || live.props.allowPopups !== true) return;
  if (Date.now() - (live.offered || 0) < 2000) return;
  live.offered = Date.now();
  if (window.confirm(K.txt("liveView.openTitle", "Open {host} in your browser?", { host }))) window.tailzuApp.openExternal(url);
}

/** Hand the page the node's `send`, when it changed or the page loaded again. */
function liveTell(live) {
  if (!live.wv || !live.loads) return;
  const js = liveSendScript(live.props && live.props.send);
  if (!js || js === live.sent) return;
  live.sent = js;
  try { live.wv.executeJavaScript(js).catch(() => { live.sent = ""; }); } catch { live.sent = ""; }
}

/** Lay every layer over its slot, clipped to what the view shows. */
function livePlace() {
  const view = $("view");
  if (!view || !LIVE.size) return;
  const v = view.getBoundingClientRect();
  for (const live of LIVE.values()) {
    const host = live.layer.offsetParent || document.body;
    const a = live.slot && live.slot.isConnected ? live.slot.getBoundingClientRect() : null;
    if (!a || !a.width || !a.height) { live.layer.style.visibility = "hidden"; continue; }
    const b = host.getBoundingClientRect();
    const st = live.layer.style;
    st.left = (a.left - b.left) + "px"; st.top = (a.top - b.top) + "px"; st.width = a.width + "px"; st.height = a.height + "px";
    const top = Math.max(0, v.top - a.top), left = Math.max(0, v.left - a.left);
    const bottom = Math.max(0, a.bottom - v.bottom), right = Math.max(0, a.right - v.right);
    const gone = top >= a.height || bottom >= a.height || left >= a.width || right >= a.width;
    st.clipPath = "inset(" + top + "px " + right + "px " + bottom + "px " + left + "px)";
    st.visibility = gone ? "hidden" : "visible";
  }
}

if (typeof window !== "undefined" && typeof module === "undefined") {
  // The main process names the page that wanted to leave (a link, a new window); the node decides whether it is offered.
  if (window.tailzuApp && typeof window.tailzuApp.onLiveOpen === "function") {
    window.tailzuApp.onLiveOpen((m) => {
      for (const live of LIVE.values()) {
        let id = -1;
        try { id = live.wv && live.wv.getWebContentsId(); } catch { /* not attached */ }
        if (m && id === m.guestId && typeof m.url === "string") liveOffer(live, m.url);
      }
    });
  }
}
