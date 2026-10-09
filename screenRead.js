// READING THE SCREEN AROUND THE FIELD — the accessibility tree first, the
// picture (OCR) only to fill what the tree did not have.
//
// frontApp.surroundings() asks the system for the focused window's text
// (macOS Accessibility, Windows UI Automation). Most apps answer, exactly
// and cheaply. Some — Google Docs, a PDF, Figma — draw their text as pixels
// and answer nothing. For those, and only when the tree came back empty or
// thin, this captures the focused window and reads the text OUT OF THE IMAGE
// on the device (macOS Vision via the bundled tzocr helper; Windows
// Windows.Media.Ocr through the shared PowerShell). The image never leaves
// the machine; only the text joins the accessibility text and goes on as
// `surroundings`, under the same reference-only, screen-off-limits rules.
//
// Everything is bounded and time-boxed: a slow or refused capture or OCR
// yields nothing and the mic carries on. A window's OCR is cached briefly,
// so dictating twice into the same unchanged window reads the picture once.
const { desktopCapturer, systemPreferences, app } = require("electron");
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const frontApp = require("./frontApp.js");

/** The bundled macOS OCR helper (built and signed with the app, like
 *  audiotap); the source tree's build/ copy in dev. */
function ocrBinary() {
  return app.isPackaged ? path.join(process.resourcesPath, "tzocr") : path.join(__dirname, "build", "tzocr");
}

// A window's OCR text, kept for a short while: a second dictation into the
// same window (same title, same size) does not read the picture again.
const cache = new Map(); // key → { at, text }
function cacheGet(key, ttlMs) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.text;
  return null;
}
function cacheSet(key, text) {
  cache.set(key, { at: Date.now(), text });
  if (cache.size > 24) cache.delete(cache.keys().next().value);
}

function raceTimeout(promise, ms, fallback) {
  return Promise.race([promise, new Promise((r) => setTimeout(() => r(fallback), ms))]).catch(() => fallback);
}

/** The focused window captured to a temp PNG, matched by its title, at most
 *  `maxSide` on its long edge. Returns the path, or null. */
async function captureWindowPng(title, maxSide) {
  const sources = await desktopCapturer.getSources({
    types: ["window"], fetchWindowIcons: false,
    thumbnailSize: { width: maxSide, height: maxSide },
  });
  const t = String(title || "");
  let src = t && sources.find((s) => s.name === t);
  if (!src && t) src = sources.find((s) => s.name && (s.name.includes(t) || t.includes(s.name)));
  if (!src && sources.length === 1) src = sources[0];
  if (!src || !src.thumbnail || src.thumbnail.isEmpty()) return null;
  const png = src.thumbnail.toPNG();
  if (!png || png.length < 256) return null;
  const file = path.join(os.tmpdir(), `tz-ocr-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  await fs.promises.writeFile(file, png);
  return file;
}

/** OCR a PNG by path on the device. "" when there is nothing or no engine. */
function runOcr(pngPath) {
  if (process.platform === "darwin") {
    return new Promise((resolve) => {
      execFile(ocrBinary(), [pngPath], { timeout: 6000, maxBuffer: 1 << 22 }, (err, out) => resolve(err ? "" : String(out || "")));
    });
  }
  if (process.platform === "win32") return frontApp.psOcr(pngPath);
  return Promise.resolve("");
}

/** True when the OS would refuse a screen capture (macOS Screen Recording
 *  not granted). The first attempt otherwise shows the system prompt. */
function captureBlocked() {
  if (process.platform !== "darwin") return false;
  try { return systemPreferences.getMediaAccessStatus("screen") === "denied"; } catch { return false; }
}

/**
 * The screen around the field as one bounded blob: the accessibility read,
 * plus OCR of the window when that read was empty or thin. `info` is the
 * front window (frontApp.frontInfo) — its title matches the window to
 * capture, and is never sent. opts carries the knob values.
 */
async function readScreen(info, opts = {}) {
  const {
    axChars = 2000, axTimeoutMs = 1400,
    ocr = true, minChars = 80, maxSide = 1600, ocrTimeoutMs = 3000, cacheMs = 15000,
  } = opts;
  const ax = await frontApp.surroundings({ chars: axChars, timeoutMs: axTimeoutMs });
  // The tree answered enough, or OCR is off, or the OS won't allow a capture:
  // the tree's text (which may be "") is the answer.
  if (!ocr || (ax && ax.length >= minChars) || captureBlocked()) return ax || "";

  const key = (info && (info.title || info.label)) || "";
  let ocrText = key ? cacheGet(key, cacheMs) : null;
  if (ocrText == null) {
    const png = await raceTimeout(captureWindowPng((info && info.title) || "", maxSide), ocrTimeoutMs, null);
    if (png) {
      ocrText = await raceTimeout(runOcr(png), ocrTimeoutMs, "");
      fs.promises.unlink(png).catch(() => {});
      if (key) cacheSet(key, ocrText || "");
    } else {
      ocrText = "";
    }
  }
  return frontApp.mergeScreen(ax, ocrText, axChars);
}

module.exports = { readScreen, captureWindowPng, runOcr, captureBlocked, ocrBinary, _cache: cache };
