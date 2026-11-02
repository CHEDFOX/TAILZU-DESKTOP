// For tests only (not shipped): the app window's scripts as app.html loads
// them, so a test can run them in a vm context in the page's own order.
const fs = require("fs");
const path = require("path");

/** Every script app.html loads, in order, as absolute paths. */
function appScripts() {
  const html = fs.readFileSync(path.join(__dirname, "app.html"), "utf8");
  return [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => path.resolve(__dirname, m[1]));
}

/** The files behind `names`, the scripts' own file names ("knobs.js", "sdui.js"), in the order given. */
function pageFiles(names) {
  const all = appScripts();
  return names.map((name) => {
    const f = all.find((p) => path.basename(p) === name);
    if (!f) throw new Error(`app.html loads no ${name}`);
    return f;
  });
}

module.exports = { appScripts, pageFiles };
