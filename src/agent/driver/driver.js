// The screen's buttons and fields, by platform, behind one API (axDriver.js on
// a Mac, uiaDriver.js on Windows). Linux has no driver yet: every call answers
// that it is unsupported, and Ask stays off there.
const UNSUPPORTED = { ok: false, error: "unsupported" };
const none = {
  available: () => false, start() {}, stop() {},
  trusted: async () => ({ ok: true, trusted: false }),
  snapshot: async () => UNSUPPORTED, press: async () => UNSUPPORTED, click: async () => UNSUPPORTED,
  setValue: async () => UNSUPPORTED, focus: async () => UNSUPPORTED, scroll: async () => UNSUPPORTED,
  key: async () => UNSUPPORTED, open: async () => UNSUPPORTED, look: async () => UNSUPPORTED,
  // The peek asks for the caret only of a running helper, and both drivers
  // answer "unavailable" when theirs is not; no helper ever runs here.
  caret: async () => ({ ok: false, error: "unavailable" }),
};

function pick(platform) {
  try {
    if (platform === "darwin") return require("./axDriver.js");
    if (platform === "win32") return require("./uiaDriver.js");
  } catch (err) {
    console.warn("[driver] " + ((err && err.message) || err));
  }
  return none;
}

module.exports = pick(process.platform);
module.exports.pick = pick;
