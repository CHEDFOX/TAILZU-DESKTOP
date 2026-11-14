// ONE OF OUR OWN CALLS, IN THE WINDOW (the `call` block, SPEC 2.13; the feature is TAILZU-BACKEND/docs/rooms.md).
//
// The window's copy of TAILZU-FRONTEND/app/src/sdui/call: the same four seat routes, the same state written into the screen, and the
// same `Caller` node. Electron has WebRTC of its own, so there is nothing to load and nothing to declare: `call` is always on here.
//
//   v2CallJoin(a)    take a seat: the microphone (and the camera) opened, an offer made, POSTed to a.join; the answer set, the loop started
//   v2CallSet(op)    mic, cam or screen on or off
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

/** Take a seat and hold the call for this screen. */
async function v2CallJoin(a) {
  if (V2_CALL) return;
  const statePath = typeof a.statePath === "string" && a.statePath ? a.statePath : "c";
  const video = a.video !== false;
  const c = {
    statePath, phase: "connecting", mic: true, cam: video, me: null, host: false,
    people: [], waiting: [], held: [], byMid: new Map(), heard: {}, seat: "", pc: null, mine: null,
    chain: Promise.resolve(), beat: null, tries: 0, lastOk: 0, stopped: false,
  };
  V2_CALL = c;
  v2CallPush();

  try {
    c.mine = await navigator.mediaDevices.getUserMedia({ audio: true, video });
  } catch {
    c.phase = "failed";
    v2CallPush();
    V2_CALL = null;
    return run(a.onBlocked);
  }
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
    const audio = c.mine.getAudioTracks()[0];
    const cam = c.mine.getVideoTracks()[0];
    if (!audio) throw new Error("no microphone");
    const aT = pc.addTransceiver(audio, { direction: "sendonly" });
    const vT = cam ? pc.addTransceiver(cam, { direction: "sendonly" }) : null;

    await pc.setLocalDescription(await pc.createOffer());
    await v2CallGathered(pc);

    const body = { sdp: pc.localDescription && pc.localDescription.sdp, audioMid: aT.mid || "0" };
    if (vT && vT.mid) body.videoMid = vT.mid;
    if (typeof a.knock === "string" && a.knock) body.knock = a.knock;
    const out = await v2CallPost(a.join, body);

    await pc.setRemoteDescription({ type: "answer", sdp: out.answer });
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

/** The person's own switches. The window has no earpiece and no second camera, so mic, cam and the screen are all of them. */
async function v2CallSet(op, value) {
  const c = V2_CALL;
  if (!c) return;
  const on = (was) => (value === undefined ? !was : value);
  if (op === "mic") {
    c.mic = on(c.mic);
    for (const t of c.mine ? c.mine.getAudioTracks() : []) t.enabled = c.mic;
  } else if (op === "cam") {
    c.cam = on(c.cam);
    for (const t of c.mine ? c.mine.getVideoTracks() : []) t.enabled = c.cam;
  } else {
    return;  // speaker and flip are the phone's
  }
  v2CallPush();
  await v2CallStep(c, () => v2CallBeat(c)).catch(() => undefined);
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
