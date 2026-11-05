// Is a program on the PATH?

"use strict";

const fs = require("fs");
const path = require("path");

/** The full path of `name` on the PATH, or null. */
function which(name, env = process.env) {
  const exts = process.platform === "win32" ? (env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of String(env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch { /* not here */ }
    }
  }
  return null;
}

module.exports = { which };
