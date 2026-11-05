// A path with the home folder as ~, so it fits a narrow terminal.

"use strict";

const os = require("os");
const path = require("path");

function shortPath(p, home = os.homedir()) {
  const s = String(p);
  if (!home) return s;
  if (s === home) return "~";
  return s.startsWith(home + path.sep) ? "~" + s.slice(home.length) : s;
}

module.exports = { shortPath };
