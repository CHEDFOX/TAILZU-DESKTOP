// For tests only (not shipped): the recorder's own scripts as recorder.html
// loads them, in its order. heldStop.js is left out: it is a module of its own,
// tested on its own, which the recorder finds on window when the page has it.
const fs = require("fs");
const path = require("path");

function recorderFiles() {
  const html = fs.readFileSync(path.join(__dirname, "recorder.html"), "utf8");
  return [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)]
    .map((m) => path.resolve(__dirname, m[1]))
    .filter((f) => path.dirname(f) === __dirname && path.basename(f) !== "heldStop.js");
}

module.exports = { recorderFiles };
