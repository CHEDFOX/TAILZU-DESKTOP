// Reading a git remote's address: which GitHub repository it is.
//
//   https://github.com/o/r(.git)(/)   http://…   https://user:token@github.com/o/r
//   git@github.com:o/r(.git)          ssh://git@github.com(:22)/o/r(.git)   git://github.com/o/r
//   github.com:o/r (an ssh alias of the same shape)

"use strict";

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

/** { owner, repo, fullName } for a GitHub address (fullName in lower case, for matching); { notGithub: true } for another host; null when it can't be read. */
function parseRemote(url) {
  const raw = String(url || "").trim();
  if (!raw) return null;
  let host = "";
  let path = "";
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.*)$/i.exec(raw);
  if (scheme) {
    if (!/^(https?|ssh|git|git\+ssh|ssh\+git)$/i.test(scheme[1])) return /^file$/i.test(scheme[1]) ? { notGithub: true } : null;
    host = scheme[2];
    path = scheme[3];
  } else {
    // scp-like: [user@]host:path (not a Windows drive letter, not a local path).
    const scp = /^(?:[^@/]+@)?([^/:]{2,}):(?!\/\/)(.*)$/.exec(raw);
    if (!scp) return { notGithub: true };
    host = scp[1];
    path = scp[2];
  }
  if (!/^(www\.)?github\.com$/i.test(host)) return { notGithub: true };
  const parts = path.replace(/\/+$/, "").replace(/\.git$/i, "").split("/").filter(Boolean);
  if (parts.length !== 2 || !NAME.test(parts[0]) || !NAME.test(parts[1]) || parts[1] === "." || parts[1] === "..") return null;
  const [owner, repo] = parts;
  return { owner, repo, fullName: `${owner}/${repo}`.toLowerCase() };
}

module.exports = { parseRemote };
