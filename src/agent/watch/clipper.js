// ASK'S EYES FOR SOMETHING MOVING, IN THE MAIN PROCESS: a few seconds of the
// window in front, recorded in a hidden window (watch.html) while a video
// plays in it, for a question about what happens in it (run/video.js decides,
// run/agent.js asks, with the same say-so a picture needs).
//
// How it is recorded. Chromium's own desktop capture, as the note-taker's
// computer sound is (notes/notesRecorder.js): the window is found among
// desktopCapturer's sources by its title (the look's, which never leaves),
// and the hidden window asks getUserMedia for that source, at most
// `maxSide` pixels a side and `fps` frames a second, and records it with
// MediaRecorder into a WebM (VP8 where it can, as every Electron build
// writes reliably). No title, or no source of that title: no clip, and the
// run sends the still picture instead. Never "the only window there is":
// the wrong window recorded is worse than none.
//
// The computer's own sound for the same seconds, where this platform lets it
// be heard, and NEVER THE MICROPHONE:
//
//   Windows  Chromium's loopback, asked for with the screen as its source
//            (the screen's video is asked for to get it, and dropped at once,
//            as the note-taker does).
//   macOS    the audiotap helper's 16 kHz PCM (native/audiotap.swift), a
//            process of its own for the clip, played into the recording.
//            Not while a note is being taken: the note's helper has the
//            computer's sound then, and the clip is frames only.
//   Linux    the sound server's monitor of the output device, found by name
//            (desktop.notes.monitorPattern); no device of that name, no sound.
//
// Without it the clip is frames only, and says so (`sound: false`), so the
// model is told it has no sound rather than left to think the video is silent.
//
// The hidden window may ask for the screen only while a clip is being
// recorded (owns() and recording() for main.js's permission handler), and
// only its own answer, for the clip it was asked for, is taken.
//
// Every dependency is injected (Electron's pieces, spawn, the clock), so a
// whole recording is played in clipper.test.js without a screen.

const str = (v) => (v == null ? "" : String(v));
const squash = (v) => str(v).replace(/\s+/g, " ").trim();

/** WebM first, in the order MediaRecorder is asked; the first it supports wins. */
const TYPES_SOUND = ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm"];
const TYPES_QUIET = ["video/webm;codecs=vp8", "video/webm;codecs=vp9", "video/webm"];

/**
 * @param {object} deps
 * @param {Function} deps.BrowserWindow
 * @param {{ on: Function }} deps.ipcMain
 * @param {{ getSources: Function }} deps.desktopCapturer
 * @param {(extra?: object) => object} deps.webPrefs
 * @param {(win: object) => void} [deps.hardenWindow]
 * @param {string} [deps.page]                 the hidden window's file (loadFile)
 * @param {string} [deps.platform]             process.platform's
 * @param {(cmd: string, args: string[], o: object) => object} [deps.spawn]   child_process.spawn
 * @param {() => string|null} [deps.tapPath]   macOS: the audiotap helper, or null when it is not there
 * @param {() => boolean} [deps.notesBusy]     a note is being taken (its helper has the computer's sound)
 * @param {(name: string, fallback: any) => any} [deps.knob]
 * @param {(line: string) => void} [deps.log]
 */
function createClipper(deps) {
  const d = deps || {};
  const platform = d.platform || process.platform;
  const knob = typeof d.knob === "function" ? d.knob : (_n, f) => f;
  const num = (n, f) => { const v = knob(n, f); return typeof v === "number" && Number.isFinite(v) ? v : f; };
  const text = (n, f) => { const v = knob(n, f); return typeof v === "string" && v ? v : f; };
  const log = (line) => { try { if (typeof d.log === "function") d.log(line); } catch { /* never stops a clip */ } };

  let win = null;
  let job = null;   // the clip being recorded: { id, finish, timer, tap }
  let seq = 0;

  function ensureWindow() {
    if (win && !win.isDestroyed()) return win;
    win = new d.BrowserWindow({
      show: false, focusable: false, skipTaskbar: true,
      // Its recording is stopped on a timer, and a hidden window's timers
      // run once a second at best unless this is off.
      webPreferences: d.webPrefs({ backgroundThrottling: false }),
    });
    if (typeof d.hardenWindow === "function") d.hardenWindow(win);
    const w = win;
    w.webContents.on("render-process-gone", () => {
      if (win !== w) return;
      win = null;
      try { w.destroy(); } catch { /* already gone */ }
      if (job) job.finish(null);
    });
    // Named whole, as the app's other pages are (relative to the app's root).
    if (d.page) w.loadFile(d.page);
    else w.loadFile("src/agent/watch/watch.html");
    return w;
  }

  function send(channel, payload) {
    const w = ensureWindow();
    const wc = w.webContents;
    if (typeof wc.isLoading === "function" && wc.isLoading()) wc.once("did-finish-load", () => wc.send(channel, payload));
    else wc.send(channel, payload);
  }

  /** The window whose title is `title`: exactly, else one whose name holds
   *  it or is held by it (a title cut short on one side), never a guess. */
  async function findSource(title) {
    const t = squash(title);
    if (!t) return null;
    const sources = await d.desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
    const named = (Array.isArray(sources) ? sources : []).filter((s) => s && typeof s.id === "string" && squash(s.name));
    return named.find((s) => squash(s.name) === t)
      || (t.length >= 4 ? named.find((s) => squash(s.name).includes(t) || t.includes(squash(s.name))) : null)
      || null;
  }

  /** How the computer's sound is heard here, for this clip, or none. */
  async function soundPlan(want) {
    if (!want) return { system: "none" };
    if (platform === "win32") {
      const screens = await d.desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
      return screens && screens[0] ? { system: "desktop", sourceId: screens[0].id } : { system: "none" };
    }
    if (platform === "darwin") {
      const busy = typeof d.notesBusy === "function" && d.notesBusy() === true;
      return !busy && typeof d.spawn === "function" && typeof d.tapPath === "function" && d.tapPath() ? { system: "pcm" } : { system: "none" };
    }
    return { system: "monitor", pattern: text("desktop.notes.monitorPattern", "monitor") };
  }

  /** macOS: the helper that hears the computer, its PCM handed to the hidden
   *  window as it comes. Null when it cannot be started. */
  function startTap() {
    const bin = d.tapPath();
    let child;
    try { child = d.spawn(bin, [], { stdio: ["pipe", "pipe", "ignore"] }); } catch { return null; }
    if (!child || !child.stdout) return null;
    let odd = null;
    child.stdout.on("data", (chunk) => {
      // Samples are two bytes; a packet can split one.
      let buf = odd ? Buffer.concat([odd, chunk]) : chunk;
      odd = null;
      if (buf.length % 2) { odd = buf.subarray(buf.length - 1); buf = buf.subarray(0, buf.length - 1); }
      if (buf.length && job && job.tap === child) send("watch:pcm", buf);
    });
    if (typeof child.on === "function") child.on("error", () => { /* frames only */ });
    return child;
  }
  function stopTap(child) {
    if (!child) return;
    try { if (child.stdin) child.stdin.end(); } catch { /* closed */ }
    const t = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 1500);
    if (t && typeof t.unref === "function") t.unref();
  }

  /**
   * A clip of the window titled `o.title`, recorded now: resolves
   * { mime, data: Buffer, sound, seconds }, { tooBig: true } when it ran
   * past `maxBytes` (stopped there, nothing kept), or null when nothing
   * could be recorded. One at a time.
   * @param {{ title: string, seconds: number, maxSide: number, fps: number, maxBytes: number, sound: boolean }} o
   */
  async function record(o) {
    const opts = o || {};
    if (job) return null;
    let src = null;
    try { src = await findSource(opts.title); } catch (e) { log(`clip: no sources (${(e && e.message) || e})`); }
    if (!src) { log("clip: the window was not found among the sources"); return null; }
    let sound;
    try { sound = await soundPlan(opts.sound === true); } catch { sound = { system: "none" }; }
    if (job) return null;
    const id = ++seq;
    const seconds = Math.max(1, Number(opts.seconds) || 6);
    return new Promise((resolve) => {
      const me = {
        id, tap: null, timer: null,
        finish(r) {
          if (job !== me) return;
          job = null;
          clearTimeout(me.timer);
          stopTap(me.tap);
          resolve(r);
        },
      };
      job = me;
      // The hidden window stops itself at `seconds`; this is for a window
      // that never answers (crashed, stuck in getUserMedia).
      me.timer = setTimeout(() => {
        try { send("watch:stop", { id }); } catch { /* gone */ }
        log("clip: the recorder never answered");
        me.finish(null);
      }, seconds * 1000 + Math.max(1000, num("desktop.agent.videoWaitMs", 5000)));
      if (sound.system === "pcm") {
        me.tap = startTap();
        if (!me.tap) sound = { system: "none" };
      }
      try {
        send("watch:record", {
          id, sourceId: src.id, sound, seconds,
          maxSide: Math.max(160, Math.round(Number(opts.maxSide) || 960)),
          fps: Math.max(1, Number(opts.fps) || 4),
          maxBytes: Math.max(1, Number(opts.maxBytes) || 8000000),
          videoBitrate: num("desktop.agent.videoBitrate", 1000000),
          audioBitrate: num("desktop.agent.videoAudioBitrate", 32000),
          types: { sound: TYPES_SOUND, quiet: TYPES_QUIET },
        });
      } catch (e) {
        log(`clip: the recorder could not be asked (${(e && e.message) || e})`);
        me.finish(null);
      }
    });
  }

  function owns(wc) { return !!win && !win.isDestroyed() && win.webContents === wc; }
  function recording() { return !!job; }

  if (d.ipcMain && typeof d.ipcMain.on === "function") {
    d.ipcMain.on("watch:done", (e, p) => {
      // Only the hidden window's answer, and only for the clip it was asked for.
      if (!e || !owns(e.sender) || !job || !p || p.id !== job.id) return;
      if (p.ok === true && p.tooBig === true) { job.finish({ tooBig: true }); return; }
      if (p.ok !== true || !p.data || !(p.data.byteLength > 0 || p.data.length > 0)) {
        if (p.error) log(`clip: ${squash(p.error).slice(0, 120)}`);
        job.finish(null);
        return;
      }
      job.finish({
        mime: /mp4/i.test(str(p.mime)) ? "video/mp4" : "video/webm",
        data: Buffer.from(p.data),
        sound: p.sound === true,
        seconds: typeof p.seconds === "number" && p.seconds > 0 ? Math.round(p.seconds * 10) / 10 : undefined,
      });
    });
  }

  function destroy() {
    if (job) job.finish(null);
    if (win && !win.isDestroyed()) { try { win.destroy(); } catch { /* gone */ } }
    win = null;
  }

  return { record, owns, recording, destroy };
}

module.exports = { createClipper, TYPES_SOUND, TYPES_QUIET };
