// The small box at the start of a session: Xode, the repository and the folder, then one dim tip. Plain words when it isn't
// a terminal.
//
//   ╭──────────────────────────────╮
//   │ Xode · ana/storefront        │
//   │ ~/code/storefront            │
//   ╰──────────────────────────────╯
//   Type what you want · / for commands · Ctrl+C twice to exit

"use strict";

const { shortPath } = require("../util/shortPath");
const { visible } = require("./paint");

const TIP = "Type what you want · / for commands · Ctrl+C twice to exit";

/** Cuts a path from the left so it fits `n` columns. */
function leftCut(s, n) {
  return s.length <= n ? s : "…" + s.slice(s.length - n + 1);
}

/** The lines. o: { repo, folder, term, paint, home } */
function welcomeLines({ repo, folder, term, paint, home }) {
  const where = shortPath(folder, home);
  if (!term.tty) return [`Xode · ${repo}`];
  const W = term.width();
  const inner = Math.min(W - 4, Math.max(28, repo.length + 7, where.length));
  const rows = [paint.bold("Xode") + paint.dim(" · ") + leftCut(repo, inner - 7), paint.dim(leftCut(where, inner))];
  const side = paint.dim("│");
  return [
    paint.dim("╭" + "─".repeat(inner + 2) + "╮"),
    ...rows.map((r) => `${side} ${r}${" ".repeat(Math.max(0, inner - visible(r)))} ${side}`),
    paint.dim("╰" + "─".repeat(inner + 2) + "╯"),
    paint.dim(TIP.length <= W ? TIP : "/ for commands · Ctrl+C twice to exit"),
  ];
}

module.exports = { welcomeLines, TIP };
