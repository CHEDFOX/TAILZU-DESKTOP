// ONE OF OUR OWN CALLS, IN THE WINDOW (the `call` block, SPEC 2.13; the feature is TAILZU-BACKEND/docs/rooms.md).
//
// The window's copy of TAILZU-FRONTEND/app/src/sdui/call: the same four seat routes, the same state written into the screen, and the
// same `Caller` node. Electron has WebRTC of its own, so there is nothing to load and nothing to declare: `call` is always on here.
//
//   v2CallJoin(a)    take a seat and start the loop. NOTHING IS CAPTURED: the microphone and the camera start off
//   v2CallSet(op)    mic or cam on (which is what opens it, and publishes it), or off
//   v2CallLeave()    hung up
//   v2CallerNode()   one person's picture, or the first letter of their name while their camera is off
//
// THE LOOP, every two seconds: say we are still here, take back who is in the call, pull in whoever is new, answer the SFU when it asks,
// and let go of whoever left. That one call is also the heartbeat, so a window that is closed leaves the call by itself.
//
// THE SEAT NEVER REACHES THE SCREEN. It is a bearer: whoever holds it is in the call. What the screen is given is who is in it.

const V2_CALL_LIMITS = { beatMs: 2000, quietMs: 7000, retries: 6, people: 50, speakingHoldMs: 1200 };
const V2_CALL_SEAT = "/v1/rooms/seat";

/** The one call this window is in. */
let V2_CALL = null;
/** Caller nodes drawn by this paint, so each can be given its stream once the markup is in the page. */
let V2_CALLERS = new Map();

/** Which of the others' tracks we have not got yet, and which we hold for someone who has gone. */
function v2CallWanted(people, have) {
  const held = new Set(have.map((t) => t.identity + ":" + t.kind));
  const want = new Set();
  const pull = [];
  for (const p of people.slice(0, V2_CALL_LIMITS.people)) {
    for (const kind of ["audio", "video"]) {
      if (!p[kind]) continue;
      want.add(p.identity + ":" + kind);
      if (!held.has(p.identity + ":" + kind)) pull.push({ identity: p.identity, kind });
    }
  }
  return { pull, drop: have.filter((t) => !want.has(t.identity + ":" + t.kind)) };
}

/** Exactly what the screen reads: no seat, no session, no track names. */
function v2CallState(c) {
  const now = Date.now();
  const speaking = new Set(Object.keys(c.heard).filter((id) => now - c.heard[id] <= V2_CALL_LIMITS.speakingHoldMs));
  return {
    phase: c.phase, mic: c.mic, cam: c.cam, speaker: true, front: true,
    me: c.me ? { identity: c.me.identity, name: c.me.name } : null,
    people: c.people.slice(0, V2_CALL_LIMITS.people).map((p) => ({
      identity: p.identity, name: p.name, role: p.role,
      speaking: speaking.has(p.identity), mic: !!p.audio, cam: !!p.video,
    })),
    waiting: c.waiting.map((k) => ({ id: k.id, name: k.name })),
  };
}

/** Who a tile means by "me", "speaker" or a name. */
function v2CallWho(who, c) {
  if (who === "me") return c.me ? c.me.identity : "";
  if (who !== "speaker") return who;
  const now = Date.now();
  const talking = c.people.find((p) => now - (c.heard[p.identity] || 0) <= V2_CALL_LIMITS.speakingHoldMs);
  return (talking || c.people[0] || c.me || {}).identity || "";
}

function v2CallPush() {
  const c = V2_CALL;
  if (!c) return;
  setStatePath(c.statePath, v2CallState(c));
  if (typeof repaint === "function") repaint();
}

/** POST one of our paths with the window's own signed-in client. */
async function v2CallPost(path, body) {
  const r = await backend(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  return r;
}

/** One change at a time: the SFU refuses a second offer while the first is unanswered. */
function v2CallStep(c, run) {
  const mine = c.chain.then(run, run);
  c.chain = mine.then(() => undefined, () => undefined);
  return mine;
}

/** The SFU takes the whole offer at once, so the candidates are waited for rather than trickled. */
function v2CallGathered(pc) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((done) => {
    const t = setTimeout(done, 3000);
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") { clearTimeout(t); done(); }
    });
  });
}

/**
 * Take a seat and hold the call for this screen. NOTHING IS CAPTURED BY JOINING: the microphone and the camera start off and stay shut
 * until the person turns one on, so walking into a call never opens a device. The permissions were asked for once, after onboarding.
 */
async function v2CallJoin(a) {
  if (V2_CALL) return;
  const statePath = typeof a.statePath === "string" && a.statePath ? a.statePath : "c";
  const c = {
    statePath, phase: "connecting", mic: false, cam: false, me: null, host: false,
    people: [], waiting: [], held: [], byMid: new Map(), sent: new Map(), heard: {}, seat: "", pc: null, mine: null,
    chain: Promise.resolve(), beat: null, tries: 0, lastOk: 0, stopped: false,
  };
  V2_CALL = c;
  v2CallPush();

  try {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }], bundlePolicy: "max-bundle" });
    c.pc = pc;
    pc.addEventListener("track", () => { if (typeof repaint === "function") repaint(); });
    pc.addEventListener("connectionstatechange", () => {
      if (!c.stopped && (pc.connectionState === "failed" || pc.connectionState === "disconnected") && c.phase === "live") {
        c.phase = "reconnecting";
        v2CallPush();
      }
    });
    // A seat with no tracks of its own: the first SDP exchange happens when we pull someone in.
    const body = {};
    if (typeof a.knock === "string" && a.knock) body.knock = a.knock;
    const out = await v2CallPost(a.join, body);
    c.seat = out.seat;
    c.me = { identity: out.identity, name: out.name };
    c.host = !!out.host;
    c.people = Array.isArray(out.people) ? out.people : [];
    c.phase = "live";
    c.lastOk = Date.now();
    c.onEnd = a.onEnd;
    v2CallPush();
    v2CallLoop(c);
  } catch {
    c.phase = "failed";
    v2CallPush();
    v2CallStop(c);
    V2_CALL = null;
    return run(a.onError);
  }
  return undefined;
}

function v2CallLoop(c) {
  if (c.stopped || c.beat) return;
  const tick = async () => {
    c.beat = null;
    if (c.stopped) return;
    await v2CallStep(c, () => v2CallBeat(c)).catch(() => undefined);
    if (!c.stopped) c.beat = setTimeout(tick, V2_CALL_LIMITS.beatMs);
  };
  c.beat = setTimeout(tick, V2_CALL_LIMITS.beatMs);
}

async function v2CallBeat(c) {
  let out;
  try {
    out = await v2CallPost(V2_CALL_SEAT + "/live", { seat: c.seat, audio: c.mic, video: c.cam });
  } catch {
    c.tries += 1;
    if (c.tries >= V2_CALL_LIMITS.retries) { v2CallFinish(c, "failed"); return; }
    if (Date.now() - c.lastOk > V2_CALL_LIMITS.quietMs && c.phase === "live") { c.phase = "reconnecting"; v2CallPush(); }
    return;
  }
  c.tries = 0;
  c.lastOk = Date.now();
  if (out.gone || out.status === "ended") {
    const end = c.onEnd;
    v2CallFinish(c, "ended");
    return run(end);
  }
  if (c.phase === "reconnecting") c.phase = "live";
  c.people = (Array.isArray(out.people) ? out.people : []).slice(0, V2_CALL_LIMITS.people);
  c.waiting = c.host && Array.isArray(out.waiting) ? out.waiting : [];

  const { pull, drop } = v2CallWanted(c.people, c.held);
  if (drop.length) {
    for (const t of drop) c.byMid.delete(t.mid);
    c.held = c.held.filter((t) => drop.indexOf(t) < 0);
  }
  if (pull.length) await v2CallPull(c, pull);
  v2CallPush();
  return undefined;
}

/** Someone else's tracks into our session, and the SFU's offer answered. */
async function v2CallPull(c, want) {
  const pc = c.pc;
  if (!pc) return;
  const out = await v2CallPost(V2_CALL_SEAT + "/pull", { seat: c.seat, want });
  if (out.offer) {
    await pc.setRemoteDescription({ type: "offer", sdp: out.offer });
    await pc.setLocalDescription(await pc.createAnswer());
    await v2CallGathered(pc);
    if (out.mustAnswer) await v2CallPost(V2_CALL_SEAT + "/answer", { seat: c.seat, sdp: pc.localDescription && pc.localDescription.sdp });
  }
  const byMid = new Map();
  for (const t of pc.getTransceivers()) if (t.mid) byMid.set(t.mid, t);
  for (const t of Array.isArray(out.tracks) ? out.tracks : []) {
    if (!t.mid) continue;
    const got = want.find((w) => t.trackName === w.identity + "-" + w.kind);
    const tr = byMid.get(t.mid);
    const track = tr && tr.receiver ? tr.receiver.track : null;
    if (!got || !track) continue;
    c.held = c.held.filter((h) => !(h.identity === got.identity && h.kind === got.kind)).concat([{ identity: got.identity, kind: got.kind, mid: t.mid }]);
    c.byMid.set(t.mid, track);
  }
}

/** The person's own switches. Turning one on is what opens that device, and publishes it; the window has no earpiece and no second camera. */
async function v2CallSet(op, value) {
  const c = V2_CALL;
  if (!c || (op !== "mic" && op !== "cam")) return;
  const was = op === "mic" ? c.mic : c.cam;
  const want = value === undefined ? !was : value;
  if (want) {
    if (!(await v2CallOpen(c, op))) return;
  } else {
    v2CallShut(c, op);
  }
  if (op === "mic") c.mic = want; else c.cam = want;
  v2CallPush();
  await v2CallStep(c, () => v2CallBeat(c)).catch(() => undefined);
}

/** A microphone or a camera opened for the first time, and published. Opening is what asks, so it happens here and never at joining. */
async function v2CallOpen(c, op) {
  const pc = c.pc;
  if (!pc) return false;
  const have = (op === "mic" ? (c.mine ? c.mine.getAudioTracks() : []) : (c.mine ? c.mine.getVideoTracks() : []))
    .find((t) => t.readyState !== "ended");
  if (have) { have.enabled = true; return true; }

  let got;
  try {
    got = await navigator.mediaDevices.getUserMedia(op === "mic" ? { audio: true } : { video: true });
  } catch (err) {
    // Refused by the computer, not missing: the card asks for that one thing,
    // over the call, with the furthest this system goes towards granting it
    // (sdui/permCard.js). Any other failure is the call's own to report.
    if (err && err.name === "NotAllowedError" && typeof permNeed === "function") permNeed(op === "mic" ? "mic" : "cam");
    return false;
  }
  const track = (op === "mic" ? got.getAudioTracks() : got.getVideoTracks())[0];
  if (!track) return false;
  const kept = (c.mine ? c.mine.getTracks() : []).filter((t) => t.readyState !== "ended");
  c.mine = new MediaStream(kept.concat([track]));

  try {
    // Coming back to the m-line it was published on: the track is simply put back, with no new offer.
    const spare = c.sent.get(op);
    if (spare) { await spare.sender.replaceTrack(track); return true; }
    const t = pc.addTransceiver(track, { direction: "sendonly" });
    c.sent.set(op, t);
    await pc.setLocalDescription(await pc.createOffer());
    await v2CallGathered(pc);
    const body = { seat: c.seat, sdp: pc.localDescription && pc.localDescription.sdp };
    body[op === "mic" ? "audioMid" : "videoMid"] = t.mid || "0";
    const out = await v2CallPost(V2_CALL_SEAT + "/publish", body);
    await pc.setRemoteDescription({ type: "answer", sdp: out.answer });
    return true;
  } catch {
    try { track.stop(); } catch { /* already stopped */ }
    return false;
  }
}

/** Turned off: the microphone is disabled (instant to turn back on), the camera really let go so its light goes out. */
function v2CallShut(c, op) {
  if (op === "mic") {
    for (const t of c.mine ? c.mine.getAudioTracks() : []) t.enabled = false;
    return;
  }
  const sender = c.sent.get("cam");
  if (sender) { const go = sender.sender.replaceTrack(null); if (go && go.catch) go.catch(() => undefined); }
  for (const t of c.mine ? c.mine.getVideoTracks() : []) { try { t.stop(); } catch { /* already stopped */ } }
  const left = (c.mine ? c.mine.getTracks() : []).filter((t) => t.readyState !== "ended");
  c.mine = left.length ? new MediaStream(left) : null;
}

async function v2CallLeave() {
  const c = V2_CALL;
  if (!c) return;
  const seat = c.seat;
  const end = c.onEnd;
  v2CallFinish(c, "ended");
  if (seat) await v2CallPost(V2_CALL_SEAT + "/leave", { seat }).catch(() => undefined);
  return run(end);
}

function v2CallStop(c) {
  for (const t of c.mine ? c.mine.getTracks() : []) { try { t.stop(); } catch { /* already stopped */ } }
  c.mine = null;
  try { if (c.pc) c.pc.close(); } catch { /* already closed */ }
  c.pc = null;
}

/** Everything let go of, once. */
function v2CallFinish(c, phase) {
  if (c.stopped) return;
  c.stopped = true;
  c.phase = phase;
  if (c.beat) { clearTimeout(c.beat); c.beat = null; }
  v2CallStop(c);
  c.byMid = new Map();
  c.sent = new Map();
  c.held = [];
  c.people = [];
  c.waiting = [];
  c.seat = "";
  v2CallPush();
  if (V2_CALL === c) V2_CALL = null;
}

/** Leaving the screen hangs up: a microphone is never left open behind a page nobody is looking at. */
function v2CallLeaveScreen() {
  if (V2_CALL) v2CallFinish(V2_CALL, "ended");
}

/** The stream for one identity, for a tile. */
function v2CallStreamFor(identity) {
  const c = V2_CALL;
  if (!c) return null;
  if (c.me && identity === c.me.identity) return c.cam ? c.mine : null;
  const held = c.held.find((t) => t.identity === identity && t.kind === "video");
  const track = held ? c.byMid.get(held.mid) : null;
  return track ? new MediaStream([track]) : null;
}

/** `Caller`: one person in the call, their picture or the first letter of their name. */
function v2CallerNode(n, p, s) {
  const c = V2_CALL;
  const bg = typeof p.background === "string" ? p.background : "#262626";
  const radius = typeof p.radius === "number" ? p.radius : 0;
  const box = "background:" + esc(bg) + ";border-radius:" + radius + "px;overflow:hidden;display:flex;" +
    "align-items:center;justify-content:center;" + s;
  if (!c) return '<div style="' + box + '"></div>';

  const identity = v2CallWho(String(p.who === undefined ? "me" : p.who), c);
  const person = c.me && c.me.identity === identity ? c.me : c.people.find((x) => x.identity === identity);
  const stream = identity ? v2CallStreamFor(identity) : null;
  if (stream) {
    const id = "v2c" + V2_CALLERS.size;
    V2_CALLERS.set(id, { stream, mirror: p.mirror === true });
    const fit = p.fit === "contain" ? "contain" : "cover";
    const mirror = p.mirror === true ? "transform:scaleX(-1);" : "";
    return '<div style="' + box + '"><video data-v2-caller="' + id + '" autoplay playsinline muted ' +
      'style="width:100%;height:100%;object-fit:' + fit + ";" + mirror + '"></video></div>';
  }
  const letter = ((person && person.name ? person.name : "").trim()[0] || "").toUpperCase();
  const color = typeof p.nameColor === "string" ? p.nameColor : "#ffffff";
  const font = typeof p.fontFamily === "string" ? ';font-family:"' + esc(p.fontFamily) + '"' : "";
  return '<div style="' + box + '"><span style="color:' + esc(color) + ";font-size:28px" + font + '">' + esc(letter) + "</span></div>";
}

/** Once the markup is in the page, each tile is given its stream. */
function v2CallWire(root) {
  root.querySelectorAll("[data-v2-caller]").forEach((el) => {
    const got = V2_CALLERS.get(el.getAttribute("data-v2-caller"));
    if (!got || el.srcObject === got.stream) return;
    el.srcObject = got.stream;
    const go = el.play();
    if (go && typeof go.catch === "function") go.catch(() => undefined);
  });
}

/** A new paint: the tiles drawn by the last one are forgotten. */
function v2CallPaintStart() {
  V2_CALLERS = new Map();
}
