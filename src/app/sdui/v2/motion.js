// Motion on any node (SPEC 2.5, B4), played by the browser's own animations.
//
// The value model is the animation spec's format 2, the same one the phone's Reanimated player reads: a number, a
// keyframe track `{ k: [[t, v, ease]], loop }`, or a spring `{ spring: to, k, damp, from }`. The tracks are sampled
// here into Web Animations keyframes, because a browser animates one transform and the server writes nine keys.
//
// Under Reduce Motion an entrance is a cross-fade, a loop rests on its first key and nothing moves by itself — but
// `drive` stays, because that is the person's own finger or scroll, not the app moving.

const V2_MOTION_KEYS = ["opacity", "translateX", "translateY", "scale", "scaleX", "scaleY", "rotate", "skewX", "skewY"];
const V2_MOTION_LIMITS = { keyframes: 64, nodes: 64, sharedMoves: 2, tracks: 16, seconds: 60, springs: 4, samples: 120 };
const V2_EASES = {
  lin: (x) => x,
  in: (x) => x * x,
  out: (x) => 1 - (1 - x) * (1 - x),
  inout: (x) => (x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x)),
  step: (x) => (x < 1 ? 0 : 1),
};
let V2_MOTION_LIVE = 0;
/** The loops playing on this paint. A loop never ends by itself and keeps its element alive after it is replaced. */
let V2_LOOPS = [];

/** A new paint: every loop of the last one stops (the elements it moved are about to be replaced). */
function v2MotionPaintStart() {
  for (const a of V2_LOOPS) { try { a.cancel(); } catch { /* already gone */ } }
  V2_LOOPS = [];
}

const v2Fin = (n, d) => (typeof n === "number" && Number.isFinite(n) ? n : d);

/** A spring, simulated once into a list of [t, value] keys. Mass 1, damping = 2 · damp · √k, as on the phone. */
function v2Spring(spec) {
  const to = v2Fin(spec.spring, 0);
  const k = Math.max(1, v2Fin(spec.k, 160));
  const damp = Math.max(0.05, Math.min(4, v2Fin(spec.damp, 0.8)));
  const c = 2 * damp * Math.sqrt(k);
  let x = v2Fin(spec.from, 0), v = 0, t = 0;
  const dt = 1 / 60;
  const keys = [[0, x]];
  while (t < 3 && (Math.abs(to - x) > 0.001 || Math.abs(v) > 0.01)) {
    v += (-k * (x - to) - c * v) * dt;
    x += v * dt;
    t += dt;
    keys.push([Math.round(t * 1000) / 1000, x]);
  }
  keys.push([Math.round((t + dt) * 1000) / 1000, to]);
  return keys;
}

/** One animated key as a function of time, with how long it runs. A value the kernel would refuse rests at 0. */
function v2Track(value, raw) {
  if (typeof value === "number") { const v = v2Fin(value, 0); return { at: () => v, end: 0, rest: v }; }
  if (!value || typeof value !== "object") return null;
  let keys = null, loop = false;
  if (Array.isArray(value.k)) {
    // A clock is capped at a minute; a `drive` track is not a clock — its keys are in the input's own units
    // (scroll points, a finger's travel), so `raw` leaves them alone.
    keys = value.k.slice(0, V2_MOTION_LIMITS.keyframes)
      .filter((p) => Array.isArray(p) && p.length >= 2)
      .map((p) => [raw ? v2Fin(p[0], 0) : Math.max(0, Math.min(V2_MOTION_LIMITS.seconds, v2Fin(p[0], 0))), v2Fin(p[1], 0), p[2]]);
    loop = value.loop === true;
  } else if ("spring" in value) {
    keys = v2Spring(value);
  }
  if (!keys || !keys.length) return null;
  keys.sort((a, b) => a[0] - b[0]);
  const end = keys[keys.length - 1][0];
  const at = (t) => {
    const time = loop && end > 0 ? t % end : t;
    if (time <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      if (time > keys[i][0]) continue;
      const [t0, v0] = keys[i - 1], [t1, v1, ease] = keys[i];
      const span = t1 - t0;
      const x = span > 0 ? (time - t0) / span : 1;
      const f = typeof ease === "string" && V2_EASES[ease] ? V2_EASES[ease] : V2_EASES.lin;
      return v0 + (v1 - v0) * f(Math.max(0, Math.min(1, x)));
    }
    return keys[keys.length - 1][1];
  };
  return { at, end, rest: keys[0][1], loop };
}

/** Every track in one section of a `motion` object, by the style key it moves. */
function v2Tracks(section) {
  const out = [];
  if (!section || typeof section !== "object") return out;
  for (const key of Object.keys(section)) {
    if (V2_MOTION_KEYS.indexOf(key) === -1) continue;
    if (out.length >= V2_MOTION_LIMITS.tracks) break;
    const track = v2Track(section[key]);
    if (track) out.push({ key, track });
  }
  return out;
}

/** The transform and opacity a set of tracks make at one moment. */
function v2MotionFrame(tracks, t) {
  const parts = [];
  const out = {};
  for (const { key, track } of tracks) {
    const v = track.at(t);
    if (key === "opacity") { out.opacity = String(Math.max(0, Math.min(1, v))); continue; }
    if (key === "rotate") parts.push("rotate(" + v + "deg)");
    else if (key === "skewX" || key === "skewY") parts.push(key.toLowerCase() + "(" + v + "deg)");
    else if (key === "scale" || key === "scaleX" || key === "scaleY") parts.push(key.replace("scale", "scale") + "(" + v + ")");
    else parts.push("translate" + key.slice(-1) + "(" + v + "px)");
  }
  if (parts.length) out.transform = parts.join(" ");
  return out;
}

/** Keyframes for the browser: the tracks sampled evenly, so nine keys with nine clocks become one animation. */
function v2Keyframes(tracks) {
  const end = tracks.reduce((m, t) => Math.max(m, t.track.end), 0);
  if (end <= 0) return { frames: [v2MotionFrame(tracks, 0)], ms: 0 };
  const steps = Math.max(2, Math.min(V2_MOTION_LIMITS.samples, Math.ceil(end * 60)));
  const frames = [];
  for (let i = 0; i <= steps; i++) {
    const f = v2MotionFrame(tracks, (end * i) / steps);
    f.offset = i / steps;
    frames.push(f);
  }
  return { frames, ms: Math.round(end * 1000) };
}

/** What the person asked for, and what the server's kill switch says. */
function v2MotionMode() {
  const switched = K.str("sdui.motion", "on");
  if (switched === "off" || K.bool("sdui.safe", false)) return "off";
  if (switched === "reduced") return "reduced";
  const d = typeof v2Facts === "function" ? v2Facts() : null;
  return d && d.reduceMotion ? "reduced" : "full";
}

/** Play one section on one element. Gives back the animation, or null when nothing moved. */
function v2Play(el, section, opts) {
  if (!el || typeof el.animate !== "function") return null;
  const mode = v2MotionMode();
  if (mode === "off") return null;
  const o = opts || {};
  const tracks = v2Tracks(section);
  if (!tracks.length) return null;
  if (mode === "reduced") {
    // A cross-fade stands in for an entrance or an exit; a loop simply rests where it starts.
    if (o.loop) return null;
    const from = o.exit ? 1 : 0, to = o.exit ? 0 : 1;
    try { return el.animate([{ opacity: String(from) }, { opacity: String(to) }], { duration: 180, fill: "both" }); } catch { return null; }
  }
  if (!o.loop && V2_MOTION_LIVE >= V2_MOTION_LIMITS.nodes) return null;
  const { frames, ms } = v2Keyframes(tracks);
  if (!ms) return null;
  // Only what ends is counted: a loop never finishes, so counting it would use the ceiling up for good.
  if (!o.loop) V2_MOTION_LIVE += 1;
  let anim = null;
  try {
    anim = el.animate(frames, { duration: ms, iterations: o.loop ? Infinity : 1, fill: o.loop ? "none" : "both" });
  } catch { if (!o.loop) V2_MOTION_LIVE -= 1; return null; }
  if (o.loop && anim) V2_LOOPS.push(anim);
  if (!o.loop && anim && anim.finished && typeof anim.finished.then === "function") {
    anim.finished.then(() => { V2_MOTION_LIVE = Math.max(0, V2_MOTION_LIVE - 1); }, () => { V2_MOTION_LIVE = Math.max(0, V2_MOTION_LIVE - 1); });
  }
  return anim;
}

/** An exit, played before whatever is holding the node takes it away. Gives back how long to wait. */
function v2PlayExit(el, motion) {
  if (!motion || !motion.exit) return 0;
  const anim = v2Play(el, motion.exit, { exit: true });
  if (!anim) return 0;
  const tracks = v2Tracks(motion.exit);
  return v2MotionMode() === "reduced" ? 180 : v2Keyframes(tracks).ms;
}

/**
 * `drive`: one input, mapped piecewise through keyframes. No clock and no expressions — the input is a scroll
 * offset or a gesture's own value, and the node follows it as it moves.
 */
function v2Drive(el, drive, read) {
  if (!el || !drive || typeof drive !== "object") return null;
  const tracks = [];
  for (const key of Object.keys(drive)) {
    if (V2_MOTION_KEYS.indexOf(key) === -1) continue;
    const spec = drive[key];
    if (!spec || typeof spec !== "object") continue;
    const track = v2Track({ k: spec.k }, true);
    if (track) tracks.push({ key, track, by: typeof spec.by === "string" ? spec.by : "" });
  }
  if (!tracks.length) return null;
  const apply = () => {
    const parts = [];
    let opacity = null;
    for (const t of tracks) {
      const v = t.track.at(v2Fin(read(t.by), 0));
      if (t.key === "opacity") { opacity = Math.max(0, Math.min(1, v)); continue; }
      if (t.key === "rotate") parts.push("rotate(" + v + "deg)");
      else if (t.key === "skewX" || t.key === "skewY") parts.push(t.key.toLowerCase() + "(" + v + "deg)");
      else if (t.key.indexOf("scale") === 0) parts.push(t.key + "(" + v + ")");
      else parts.push("translate" + t.key.slice(-1) + "(" + v + "px)");
    }
    if (parts.length) el.style.transform = parts.join(" ");
    if (opacity !== null) el.style.opacity = String(opacity);
  };
  apply();
  return apply;
}
