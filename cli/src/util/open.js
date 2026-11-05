// Opening a web page in the person's browser, with the platform's own opener, run without a shell.
// Windows has no opener program of its own name (start is part of cmd), so the URL goes to the system's URL handler directly.

"use strict";

const { execFile } = require("child_process");

/** The program and arguments that open `url` on this platform. */
function openerFor(url, platform = process.platform) {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  return ["xdg-open", [url]];
}

/** Resolves true when the opener ran. Only https:// addresses are opened. */
function openUrl(url, { platform = process.platform, run = execFile } = {}) {
  if (!/^https:\/\/[^\s]+$/i.test(String(url || ""))) return Promise.resolve(false);
  const [file, args] = openerFor(url, platform);
  return new Promise((resolve) => {
    try {
      const child = run(file, args, { timeout: 15_000, windowsHide: true, stdio: "ignore" }, (err) => resolve(!err));
      if (child && child.unref) child.unref();
    } catch {
      resolve(false);
    }
  });
}

module.exports = { openUrl, openerFor };
