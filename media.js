// SEND A FILE AND PLAY A SOUND, in the app window: the Bots app's media
// actions (backend shared/types/sdui.ts section 3d). Loaded after sdui.js,
// whose session, state and painting it uses (api's base, bearer, setStatePath,
// stateAt, repaint, run, toast); sdui.js's run() hands it the actions.
//
//   uploadFile   the system's chooser for the kind asked (a picture, a video,
//                any file); a screenshot is the Mac's own (drag over an area,
//                or Space and click a window: main.js app:captureScreen), a
//                picture where there is none. Sent to the server's path with
//                the session (multipart, one `file` part) with its progress in
//                state as it goes, and the answer in state at the end.
//   playAudio    one sound at a time: a server path fetched with the session,
//   stopAudio    or an https address; decoded and played here (Web Audio, so
//                the page's media policy is untouched); how far it is goes
//                into state. Kept decoded for the window's life.
//
// Each belongs to the screen it started on: painting another screen stops it
// (sdui.js paint calls mediaLeave). A tick of progress repaints the screen
// without taking a click in flight or the caret from the field being typed in.
"use strict";

/** The most a file may be: the upload route's own limit (backend media/types.ts CAP_MAX). */
const MEDIA_MAX = 50 * 1024 * 1024;
const MEDIA_ACCEPT = { photo: "image/*", screenshot: "image/*", camera: "image/*", video: "video/*", file: "" };

/** "820 B", "412 KB", "3.4 MB". */
function mediaSize(bytes) {
  const b = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (b < 1024) return Math.round(b) + " B";
  if (b < 1024 * 1024) return Math.round(b / 1024) + " KB";
  const mb = b / 1024 / 1024;
  return (mb < 10 ? mb.toFixed(1).replace(/\.0$/, "") : String(Math.round(mb))) + " MB";
}
/** "0:02", "1:05". */
function mediaClock(seconds) {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}
function mediaPct(done, total) {
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0 || done <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((done / total) * 100)));
}
/** What the screen reads while a file goes. */
function mediaProgress(name, kind, sent, total) {
  const pct = mediaPct(sent, total);
  return { name, kind, pct, percent: pct + "%", size: mediaSize(total) };
}
/** What the screen reads while a sound plays. */
function mediaPlayState(id, at, of) {
  const a = mediaClock(at), o = mediaClock(of);
  return { id, pct: mediaPct(at, of), at: a, of: o, time: of > 0 ? a + " / " + o : a };
}
/**
 * A refused upload in words a person can read: the file routes word what is
 * wrong with a file (too big, a kind not read, a reader not on yet) for a
 * person, so 413, 415, 422, 503 and 504 say what the server said; the rest get
 * this window's own words.
 */
function mediaRefusal(status, body) {
  let parsed = {};
  try { parsed = JSON.parse(body) || {}; } catch { /* a page, not an answer */ }
  const said = typeof parsed.message === "string" && parsed.message.trim() && parsed.message.length <= 240 ? parsed.message.trim() : "";
  if (status === 401 || status === 403) return K.txt("error.unauthorized", "Your session has expired. Sign in again to continue.");
  if (status === 429) return K.txt("error.rateLimited", "Too many requests. Wait a moment, then try again.");
  if (status === 404 && parsed.code === "media_off") return K.txt("media.filesOff", "Sending files isn't switched on yet.");
  if ([413, 415, 422, 503, 504].indexOf(status) !== -1 && said) return said;
  return K.txt("media.sendFailed", "Couldn't send that file. Try again.");
}
/** "$state.x" in a path or an address, each value made safe for a URL. */
function mediaFill(url) {
  return String(url || "").replace(/\$state\.[A-Za-z0-9_.]*[A-Za-z0-9_]/g, (m) => {
    const v = stateAt(m.slice(7));
    return v == null ? "" : encodeURIComponent(String(v));
  });
}
/** A server path of this app's (fetched with the session) or an https address; nothing else. */
function mediaSource(url) {
  if (typeof url !== "string" || !url) return null;
  if (url[0] === "/" && url[1] !== "/" && url.indexOf("..") === -1) return { path: url };
  if (/^https:\/\/[^\s/]+(\/|$)/i.test(url)) return { web: url };
  return null;
}
const mediaIsPath = (p) => typeof p === "string" && p[0] === "/" && p[1] !== "/" && p.indexOf("..") === -1;
/** A file's name without a folder or a trick in it. */
function mediaName(name, fallback) {
  const base = String(name == null ? "" : name).split(/[/\\]/).pop() || "";
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f:*?"<>|]/g, "").replace(/^[.\s]+/, "").trim().slice(0, 120);
  return clean || fallback;
}

// ---------------------------------------------------------------------------
// Painting while something moves
// ---------------------------------------------------------------------------

let MEDIA_POINTER = false;
let MEDIA_WANTS_PAINT = false;
window.addEventListener("pointerdown", () => { MEDIA_POINTER = true; }, true);
window.addEventListener("pointerup", () => { MEDIA_POINTER = false; if (MEDIA_WANTS_PAINT) mediaPaint(); }, true);

/**
 * Repaint for a tick of progress. Not under a pressed pointer (the element
 * being clicked would be replaced between press and release, and the click
 * lost: it waits for the release), and the field being typed in keeps its
 * caret.
 */
function mediaPaint() {
  if (MEDIA_POINTER) { MEDIA_WANTS_PAINT = true; return; }
  MEDIA_WANTS_PAINT = false;
  const a = document.activeElement;
  const path = a && a.getAttribute ? a.getAttribute("data-bind") : null;
  const sel = path && typeof a.selectionStart === "number" ? [a.selectionStart, a.selectionEnd] : null;
  repaint();
  if (!path) return;
  const el = Array.from(document.querySelectorAll("[data-bind]")).find((x) => x.getAttribute("data-bind") === path);
  if (!el) return;
  try { el.focus(); if (sel) el.setSelectionRange(sel[0], sel[1]); } catch { /* not a text field */ }
}

const mediaTop = () => STACK[STACK.length - 1] || null;
const mediaSet = (path, value) => { if (path) setStatePath(path, value); };

// ---------------------------------------------------------------------------
// Send a file
// ---------------------------------------------------------------------------

/** The system's chooser; null when nothing was chosen. */
function mediaChoose(kind) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = MEDIA_ACCEPT[kind] || "";
    input.style.display = "none";
    let done = false;
    const finish = (f) => { if (done) return; done = true; try { input.remove(); } catch {} resolve(f || null); };
    input.addEventListener("change", () => finish(input.files && input.files[0]));
    input.addEventListener("cancel", () => finish(null));
    document.body.appendChild(input);
    input.click();
  });
}

/** A screenshot: the Mac's own picker where there is one, else a picture from this computer. */
async function mediaScreenshot() {
  const cap = window.tailzuApp && typeof window.tailzuApp.captureScreen === "function" ? await window.tailzuApp.captureScreen() : null;
  if (cap && cap.bytes) return new File([cap.bytes], mediaName(cap.name, "Screenshot.png"), { type: "image/png" });
  if (cap && cap.cancelled) return null;
  if (cap && cap.why === "screen") toast(K.txt("desktop.media.shotOff", "Screen Recording is off for Tailzu, so pick a picture instead."));
  return mediaChoose("screenshot");
}

let MEDIA_SENDING = null;   // { entry, xhr, stopped }

async function mediaUpload(a) {
  const failed = K.txt("media.sendFailed", "Couldn't send that file. Try again.");
  const entry = mediaTop();
  let file;
  try {
    file = a.pick === "screenshot" ? await mediaScreenshot() : await mediaChoose(a.pick);
  } catch {
    return run(a.onError, K.txt("media.pickFailed", "Couldn't open your files. Try again."));
  }
  if (!file) return run(a.onCancel);
  const max = Math.min(Number(a.maxBytes) || MEDIA_MAX, MEDIA_MAX);
  if (file.size > max) return run(a.onError, "That file is over " + Math.round(max / 1024 / 1024) + " MB, the most Tailzu takes.");
  const path = a.path || "/v1/files";
  if (!mediaIsPath(path)) return run(a.onError, failed);
  if (MEDIA_SENDING) { MEDIA_SENDING.stopped = true; try { MEDIA_SENDING.xhr.abort(); } catch {} }
  const name = mediaName(file.name, "file");
  const kind = a.pick;
  const me = { entry, xhr: new XMLHttpRequest(), stopped: false };
  MEDIA_SENDING = me;
  const show = (sent, total) => { if (!me.stopped && a.progressTo) { mediaSet(a.progressTo, mediaProgress(name, kind, sent, total)); mediaPaint(); } };
  show(0, file.size);
  let last = 0;
  const tok = await bearer();
  if (me.stopped) return;
  const xhr = me.xhr;
  const settled = new Promise((resolve) => {
    xhr.onload = () => resolve({ status: xhr.status, body: String(xhr.responseText || "") });
    xhr.onerror = () => resolve({ status: 0, body: "" });
    xhr.onabort = () => resolve(null);
    xhr.ontimeout = () => resolve({ status: 0, body: "" });
  });
  xhr.upload.onprogress = (e) => {
    const now = Date.now();
    const done = e.lengthComputable && e.loaded >= e.total;
    if (!done && now - last < K.num("desktop.media.progressMs", 150)) return;
    last = now;
    show(e.loaded, e.lengthComputable ? e.total : file.size);
  };
  xhr.open("POST", ENV.baseUrl + path);
  if (tok) xhr.setRequestHeader("Authorization", "Bearer " + tok);
  const form = new FormData();
  form.append("file", file, name);
  xhr.send(form);
  const res = await settled;
  if (MEDIA_SENDING === me) MEDIA_SENDING = null;
  if (me.stopped || !res) return;
  mediaSet(a.progressTo, undefined);
  if (res.status === 0) {
    mediaPaint();
    return run(a.onError, K.txt("error.network", "Couldn't reach Tailzu. Check your connection and try again."));
  }
  if (res.status < 200 || res.status >= 300) {
    mediaPaint();
    return run(a.onError, mediaRefusal(res.status, res.body));
  }
  let answer;
  try { answer = JSON.parse(res.body); } catch { mediaPaint(); return run(a.onError, failed); }
  const bytes = Number(answer && answer.file && answer.file.bytes) || file.size;
  // The answer as the server gave it, with the name it was chosen with and its size in words, for the screen.
  mediaSet(a.assignTo, Object.assign({}, answer, { name, size: mediaSize(bytes) }));
  mediaPaint();
  return run(a.onSuccess);
}

// ---------------------------------------------------------------------------
// Play a sound
// ---------------------------------------------------------------------------

let MEDIA_AC = null;          // one AudioContext for the window
let MEDIA_PLAYING = null;     // { entry, id, statePath, node, t0, dur, timer }
let MEDIA_PENDING = null;     // { entry, statePath, dropped }: fetched, not playing yet
const MEDIA_SOUNDS = new Map(); // address → decoded sound, for the window's life

function mediaStop() {
  const w = MEDIA_PENDING;
  MEDIA_PENDING = null;
  let changed = false;
  if (w) { w.dropped = true; if (w.statePath) { mediaSet(w.statePath, undefined); changed = true; } }
  const p = MEDIA_PLAYING;
  if (p) {
    MEDIA_PLAYING = null;
    clearInterval(p.timer);
    try { p.node.onended = null; p.node.stop(); } catch { /* already over */ }
    try { p.node.disconnect(); } catch { /* gone */ }
    if (p.statePath) { mediaSet(p.statePath, undefined); changed = true; }
  }
  return changed;
}

async function mediaSound(url, src) {
  const had = MEDIA_SOUNDS.get(url);
  if (had) return had;
  const headers = {};
  if (src.path) { const tok = await bearer(); if (tok) headers.Authorization = "Bearer " + tok; }
  const res = await fetch(src.path ? ENV.baseUrl + src.path : src.web, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let said = "";
    try { said = String(JSON.parse(text).message || ""); } catch { /* not JSON */ }
    const e = new Error("sound refused: " + res.status);
    e.words = res.status === 503 && said ? said : "";
    throw e;
  }
  const bytes = await res.arrayBuffer();
  if (!MEDIA_AC) MEDIA_AC = new AudioContext();
  const buf = await MEDIA_AC.decodeAudioData(bytes);
  MEDIA_SOUNDS.set(url, buf);
  if (MEDIA_SOUNDS.size > 40) MEDIA_SOUNDS.delete(MEDIA_SOUNDS.keys().next().value);
  return buf;
}

async function mediaPlay(a) {
  mediaStop();
  const failed = K.txt("media.playFailed", "Couldn't play that. Try again.");
  const id = String(a.id || a.url || "");
  const url = mediaFill(a.url);
  const src = mediaSource(url);
  if (!src) return run(a.onError, failed);
  const claim = { entry: mediaTop(), statePath: a.statePath, dropped: false };
  MEDIA_PENDING = claim;
  // Shown at once, so the press is answered while the sound is fetched.
  if (a.statePath) { mediaSet(a.statePath, mediaPlayState(id, 0, 0)); mediaPaint(); }
  try {
    const buf = await mediaSound(url, src);
    if (claim.dropped) return;
    MEDIA_PENDING = null;
    if (MEDIA_AC.state === "suspended") await MEDIA_AC.resume();
    const node = MEDIA_AC.createBufferSource();
    node.buffer = buf;
    node.connect(MEDIA_AC.destination);
    const me = { entry: claim.entry, id, statePath: a.statePath, node, t0: MEDIA_AC.currentTime, dur: buf.duration, timer: 0 };
    MEDIA_PLAYING = me;
    node.onended = () => {
      if (MEDIA_PLAYING !== me) return;
      if (mediaStop()) mediaPaint();
      void run(a.onEnd);
    };
    me.timer = setInterval(() => {
      if (MEDIA_PLAYING !== me || !a.statePath) return;
      mediaSet(a.statePath, mediaPlayState(id, Math.min(me.dur, MEDIA_AC.currentTime - me.t0), me.dur));
      mediaPaint();
    }, K.num("desktop.media.playTickMs", 250));
    node.start();
  } catch (e) {
    if (claim.dropped) return;
    if (MEDIA_PENDING === claim) MEDIA_PENDING = null;
    if (a.statePath) { mediaSet(a.statePath, undefined); mediaPaint(); }
    return run(a.onError, (e && e.words) || failed);
  }
}

// ---------------------------------------------------------------------------
// The hand-off from sdui.js
// ---------------------------------------------------------------------------

/** run()'s media actions. */
function mediaRun(action) {
  switch (action.kind) {
    case "uploadFile": return mediaUpload(action);
    case "playAudio": return mediaPlay(action);
    case "stopAudio": if (mediaStop()) mediaPaint(); return undefined;
    default: return undefined;
  }
}

/** A screen is being painted: what belongs to another screen stops. */
function mediaLeave(entry) {
  if ((MEDIA_PLAYING && MEDIA_PLAYING.entry !== entry) || (MEDIA_PENDING && MEDIA_PENDING.entry !== entry)) mediaStop();
  if (MEDIA_SENDING && MEDIA_SENDING.entry !== entry) {
    MEDIA_SENDING.stopped = true;
    try { MEDIA_SENDING.xhr.abort(); } catch {}
    MEDIA_SENDING = null;
  }
}

// Declared to the server (sdui.js capabilities() reads these lists when it asks).
COMPONENTS.push("FileUpload", "AudioPlay");
ACTIONS.push("uploadFile", "playAudio", "stopAudio");

if (typeof module !== "undefined" && module.exports) {
  module.exports = { mediaSize, mediaClock, mediaPct, mediaProgress, mediaPlayState, mediaRefusal, mediaSource, mediaName };
}
