// `Video` and `Audio` (SPEC 2.10, B10), played by the window's own media elements.
//
// `Camera` is NOT drawn here and is not declared: a window has no viewfinder to offer and no scanner, and claiming
// one would be the capability list meaning nothing. A Camera node draws its `fallback`, which is the same answer a
// phone whose binary lacks the camera gives.

const V2_MEDIA_LIMITS = { urlMax: 2048, rate: { min: 0.25, max: 4 }, tickMinMs: 200 };
let V2_MEDIA = new Map();

/** A source we will play: https only, and short enough to be a URL rather than a payload. */
function v2MediaSrc(v) {
  const s = typeof v === "string" ? v.trim() : v && typeof v === "object" ? String(v.url || v.uri || "") : "";
  if (!s || s.length > V2_MEDIA_LIMITS.urlMax) return "";
  return /^https:\/\//i.test(s) ? s : "";
}

function v2MediaNode(n, p, s, kids) {
  const kind = n.type === "Audio" ? "audio" : "video";
  const src = v2MediaSrc(p.source);
  if (!src) return n.fallback ? node(n.fallback) : kids || "";
  const id = "v2m" + V2_MEDIA.size;
  V2_MEDIA.set(id, { id, node: n, props: p });
  const fit = p.contentFit === "cover" || p.contentFit === "fill" ? p.contentFit : "contain";
  const flags = (p.loop === true ? " loop" : "") + (p.muted === true ? " muted" : "") +
    (p.autoplay === true || p.playing === true ? " autoplay" : "") + (p.controls === false ? "" : " controls");
  if (kind === "audio") return '<audio data-v2-media="' + id + '" src="' + esc(src) + '"' + flags + ' style="' + s + '"></audio>' + kids;
  return '<video data-v2-media="' + id + '" src="' + esc(src) + '"' + flags +
    ' playsinline style="' + s + ";object-fit:" + fit + '"></video>';
}

/** Put what the player is doing where the screen asked for it. */
function v2MediaInto(st, el, patch) {
  const into = st.props.into && typeof st.props.into === "object" ? st.props.into : null;
  if (!into) return;
  for (const key of Object.keys(patch)) {
    const path = into[key];
    if (typeof path === "string" && path) setStatePath(path, patch[key]);
  }
}

function v2MediaWire(root) {
  root.querySelectorAll("[data-v2-media]").forEach((el) => {
    const st = V2_MEDIA.get(el.getAttribute("data-v2-media"));
    if (!st || el.getAttribute("data-v2-wired") === "1") return;
    el.setAttribute("data-v2-wired", "1");
    const p = st.props, on = st.node.on || {};
    const rate = Number(p.rate);
    if (Number.isFinite(rate)) el.playbackRate = Math.max(V2_MEDIA_LIMITS.rate.min, Math.min(V2_MEDIA_LIMITS.rate.max, rate));
    const vol = Number(p.volume);
    if (Number.isFinite(vol)) el.volume = Math.max(0, Math.min(1, vol));
    const tick = Math.max(V2_MEDIA_LIMITS.tickMinMs, Number(p.tickMs) || 500);
    let last = 0;
    el.addEventListener("loadeddata", () => {
      v2MediaInto(st, el, { loading: false, duration: el.duration || 0 });
      if (on.onResult) void run(on.onResult, { ready: true });
    });
    el.addEventListener("timeupdate", () => {
      const now = Date.now();
      if (now - last < tick) return;
      last = now;
      v2MediaInto(st, el, { time: el.currentTime || 0, progress: el.duration ? (el.currentTime || 0) / el.duration : 0 });
    });
    const said = (playing) => {
      v2MediaInto(st, el, { playing });
      if (on.onChange) void run(on.onChange, { playing, time: el.currentTime || 0 });
    };
    el.addEventListener("play", () => said(true));
    el.addEventListener("pause", () => said(false));
    el.addEventListener("ended", () => {
      v2MediaInto(st, el, { ended: true, playing: false });
      if (on.onComplete) void run(on.onComplete, { time: el.currentTime || 0 });
    });
    el.addEventListener("error", () => { if (on.onError) void run(on.onError, ""); });
    // `playing` is usually bound: true plays, false pauses.
    if (p.playing === false && typeof el.pause === "function") { try { el.pause(); } catch { /* nothing playing */ } }
  });
}

/** A new paint starts from no players. */
function v2MediaPaintStart() { V2_MEDIA = new Map(); }

/** A sound or a clip stops when its screen goes. */
function v2MediaLeave() { V2_MEDIA = new Map(); }
