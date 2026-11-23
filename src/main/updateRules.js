// WHICH BUILD MAY BE TAKEN, AND FROM WHERE: the rules both updaters keep.
//
// The one-click card (updater.js, "Update now") and the silent updater
// (silentUpdate.js, which does the same job on its own at a quiet moment)
// must refuse exactly the same things, so the rules live here, once, with no
// Electron in them: the silent updater is tested without it.
//
//   - a build comes from our own server only (x0bot.com, or tailzu.space, the
//     address before it), over https, never anywhere a redirect points;
//   - under the one fixed name for this OS (the download page's names, which
//     never change: a release replaces the file and nothing else moves);
//   - with a SHA-512 the server recorded when the build was published
//     (deploy/receive-download.sh in the backend), which the file must match
//     before anything runs it;
//   - and a version that reads as one.

// x0bot.com, and tailzu.space: the server names the old address to builds up
// to 0.4.4, which trust nothing else (the backend's desktopRelease.ts).
const HOSTS = new Set(["x0bot.com", "www.x0bot.com", "tailzu.space", "www.tailzu.space"]);
const FILES = { win32: "Tailzu-Setup.exe", darwin: "Tailzu.dmg", linux: "Tailzu.AppImage" };
// receive-download.sh refuses anything smaller; so does this.
const MIN_BYTES = 5_000_000;

/** Our own server, over https: the only place a build is taken from. */
const trusted = (u) => !!u && u.protocol === "https:" && HOSTS.has(u.hostname);

/**
 * `{ url, version, sha512 }` as the window or the bootstrap gives it, checked:
 * `{ url, version, sha512, name }` (the address parsed and trusted, the
 * checksum in lower case, the file's name for this OS), or null for anything
 * that is not a build this copy may take.
 */
function checkRelease(u, platform) {
  const name = FILES[platform];
  if (!name || !u || typeof u !== "object") return null;
  const sha512 = String(u.sha512 || "").toLowerCase();
  const version = String(u.version || "");
  let url;
  try { url = new URL(String(u.url || "")); } catch { return null; }
  if (!trusted(url) || url.username || url.password || url.pathname.split("/").pop() !== name) return null;
  if (!/^[a-f0-9]{128}$/.test(sha512) || !/^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(version)) return null;
  return { url: url.toString(), version, sha512, name };
}

/** Dotted numbers, compared as numbers: 0.1.10 is newer than 0.1.9. A part
 *  that is not a number counts as 0, so "1.2" equals "1.2.0". */
function compareVersions(a, b) {
  const pa = String(a || "").split("."), pb = String(b || "").split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = parseInt(pa[i], 10) || 0, y = parseInt(pb[i], 10) || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

module.exports = { HOSTS, FILES, MIN_BYTES, trusted, checkRelease, compareVersions };
