// The folder xode keeps a project's state under: the top of the git repository it was run in, or the folder itself outside one.

"use strict";

const { topOf } = require("../git/run");

async function folderOf(cwd) {
  try { return (await topOf(cwd)) || cwd; } catch { return cwd; }
}

module.exports = { folderOf };
