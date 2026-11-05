// xode --help

"use strict";

const TEXT = `xode: Xode, X0 Bot's coding bot, in your terminal.

  xode login               sign in: approve a code in the X0 Bot app
  xode                     chat with Xode about this folder's project (its GitHub repository)
  xode "fix the rounding"  send that, approve the plan, follow the job to its end
  xode status              who is signed in, and the job of this folder
  xode stop                stop the job running in this folder
  xode logout              sign out and forget the sign-in

Options
  --project <id>           the project (or XODE_PROJECT); without it, the folder's own
  --new                    start a new chat instead of carrying on the last one
  --no-runner              don't offer this computer to do the work (or XODE_RUNNER=0)
  --version                print the version

Run it inside your project's folder. While xode is open, this computer can do that project's
work (and only that project's); when a job ends, its branch comes into the folder.

XODE_SERVER sets the server (default https://api.x0bot.com).`;

async function help({ out }) {
  out.line(TEXT);
  return 0;
}

module.exports = { help };
