// xode --help

"use strict";

const TEXT = `xode: Xode, X0 Bot's coding bot, in your terminal.

  xode login               sign in with X0 Bot on your phone
  xode                     chat with Xode about a project
  xode "fix the rounding"  send that, approve the plan, follow the job to its end
  xode status              who is signed in, and the job running in this folder
  xode stop                stop the job running in this folder
  xode logout              sign out and forget the sign-in

Options
  --project <id>           the project (or XODE_PROJECT); without it, pick from a list
  --new                    start a new chat instead of carrying on the last one
  --version                print the version

XODE_SERVER sets the server (default https://api.x0bot.com).`;

async function help({ out }) {
  out.line(TEXT);
  return 0;
}

module.exports = { help };
