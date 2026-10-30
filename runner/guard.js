// THE GUARD RAILS: what Tailzu Code will not do on this computer, whatever it is asked.
//
// Two kinds of check, both pure (a path is resolved through the real disk only when a `realpath` is given):
//
//   checkPathInside(root, path)   a path for a FILE operation (a search's folder) must resolve inside the workspace:
//                                 not absolute, no `..`, not through a link that leaves it.
//   checkCommand(command, ctx)    a COMMAND is read the way a shell reads it (quotes, `;` `&&` `|`, `$( )`, `bash -c`,
//                                 `eval`, here-documents) and refused, with a plain sentence saying why, if it:
//                                   sudo         runs `sudo`, `doas`, `su`, `pkexec` or `runas`;
//                                   system_write writes to a system folder (`/etc`, `/usr`, `C:\Windows`, ...);
//                                   home_write   writes to a dotfile or settings folder in a home directory;
//                                   outside_write writes anywhere else in the person's own home, outside the workspace;
//                                   rm_root      deletes (`rm -r`, `find -delete`), or changes the owner or mode of,
//                                                `/`, a home folder or a parent of the workspace, recursively;
//                                   secret_read  names a place where the person keeps keys and tokens (`~/.ssh`,
//                                                `~/.aws`, `~/.npmrc`, this app's own sign-in file, ...);
//                                   pipe_to_shell downloads a script and runs it at once (`curl ... | sh`);
//                                   publish      publishes a package or deploys (`npm publish`, `docker push`, ...);
//                                   push         runs `git push`;
//                                   global_install installs software for the whole computer (`apt`, `brew`, `npm -g`);
//                                   system       shuts down, formats or partitions.
//
// THIS IS A GUARD AGAINST MISTAKES AND AGAINST A REPOSITORY THAT TALKS THE AGENT INTO ONE, NOT A SANDBOX. A shell can say
// the same thing a hundred ways and this reads the common ones. What actually keeps a command away from the person's
// files is the rest of the design: the private home folder, the scrubbed environment, the read-only token, and, for
// anyone who wants a wall, the container (README, "Tailzu Code on this computer").

"use strict";

const nodePath = require("path");
const nodeFs = require("fs");
const nodeOs = require("os");

// ---------------------------------------------------------------------------------------------- the lexer

/**
 * Reads a command line into pipelines of simple commands. Not a shell: no expansion, no functions, no aliases. It keeps
 * what the checks need: the words (quotes taken off), the redirections, the text inside `$( )`, backticks and `<( )`
 * (read again as command lines of their own), and whether a word still holds an expansion the guard cannot know.
 *
 * Returns { stages: [pipeline, ...] } where a pipeline is a list of stages joined by `|`, and a stage is
 * { words: [{ text, dynamic, quoted }], redirs: [{ op, target }], subs: [string] }.
 */
function parseCommand(src) {
  const s = String(src);
  const n = s.length;
  let i = 0;
  const pipelines = [];
  let pipeline = [];
  let stage = newStage();
  let word = null;
  let pendingHeredocs = [];
  let heredocNext = null;

  function newStage() { return { words: [], redirs: [], subs: [], redirOpen: null }; }
  const endWord = () => {
    if (!word) return;
    const w = { text: word.text, dynamic: word.dynamic, quoted: word.quoted };
    word = null;
    if (heredocNext) { pendingHeredocs.push({ delim: w.text, strip: heredocNext.strip }); heredocNext = null; }
    if (stage.redirOpen) { stage.redirs.push({ op: stage.redirOpen, target: w }); stage.redirOpen = null; }
    else stage.words.push(w);
  };
  const endStage = () => { endWord(); if (stage.words.length || stage.redirs.length || stage.subs.length) pipeline.push(stage); stage = newStage(); };
  const endPipeline = () => { endStage(); if (pipeline.length) pipelines.push(pipeline); pipeline = []; };
  const add = (c, dynamic, quoted) => {
    if (!word) word = { text: "", dynamic: false, quoted: false };
    word.text += c;
    if (dynamic) word.dynamic = true;
    if (quoted) word.quoted = true;
  };
  const touch = () => { if (!word) word = { text: "", dynamic: false, quoted: false }; };

  /** The text between a `(` already read and its matching `)`, quotes respected. Moves `i` past the `)`. */
  function balanced() {
    let depth = 1;
    const start = i;
    while (i < n) {
      const c = s[i];
      if (c === "\\") { i += 2; continue; }
      if (c === "'") { const e = s.indexOf("'", i + 1); i = e < 0 ? n : e + 1; continue; }
      if (c === '"') { i += 1; while (i < n && s[i] !== '"') i += s[i] === "\\" ? 2 : 1; i += 1; continue; }
      if (c === "(") depth += 1;
      else if (c === ")") { depth -= 1; if (depth === 0) { const inner = s.slice(start, i); i += 1; return inner; } }
      i += 1;
    }
    return s.slice(start);
  }
  /** A `$name`, `${...}`, `$(...)`, `` `...` `` at `i` (which is at the `$` or the backtick). */
  function expansion(quoted) {
    const c = s[i];
    if (c === "`") { const e = s.indexOf("`", i + 1); stage.subs.push(s.slice(i + 1, e < 0 ? n : e)); add("`...`", true, quoted); i = e < 0 ? n : e + 1; return true; }
    if (c !== "$") return false;
    if (s[i + 1] === "(" && s[i + 2] === "(") { i += 3; balanced(); add("$((...))", true, quoted); return true; }
    if (s[i + 1] === "(") { i += 2; stage.subs.push(balanced()); add("$(...)", true, quoted); return true; }
    if (s[i + 1] === "{") { const e = s.indexOf("}", i); add(s.slice(i, e < 0 ? n : e + 1), true, quoted); i = e < 0 ? n : e + 1; return true; }
    if (/[A-Za-z_]/.test(s[i + 1] || "")) { let e = i + 1; while (e < n && /[A-Za-z0-9_]/.test(s[e])) e += 1; add(s.slice(i, e), true, quoted); i = e; return true; }
    return false;
  }

  while (i < n) {
    const c = s[i];
    if (c === " " || c === "\t") { endWord(); i += 1; continue; }
    if (c === "\r") { i += 1; continue; }
    if (c === "\n") {
      endPipeline();
      i += 1;
      // A here-document's body is data: skip it up to its delimiter.
      for (const h of pendingHeredocs) {
        while (i < n) {
          let e = s.indexOf("\n", i);
          if (e < 0) e = n;
          const line = s.slice(i, e).replace(/\r$/, "");
          i = Math.min(n, e + 1);
          if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
        }
      }
      pendingHeredocs = [];
      continue;
    }
    if (c === "#" && !word) { while (i < n && s[i] !== "\n") i += 1; continue; }
    if (c === "\\") {
      if (s[i + 1] === "\n") { i += 2; continue; }
      if (i + 1 < n) add(s[i + 1], false, true);
      i += 2;
      continue;
    }
    if (c === "'") {
      touch();
      if (word) word.quoted = true;
      const e = s.indexOf("'", i + 1);
      for (const ch of s.slice(i + 1, e < 0 ? n : e)) add(ch, false, true);
      i = e < 0 ? n : e + 1;
      continue;
    }
    if (c === '"') {
      touch();
      if (word) word.quoted = true;
      i += 1;
      while (i < n && s[i] !== '"') {
        const d = s[i];
        if (d === "\\" && i + 1 < n) {
          const nx = s[i + 1];
          if (nx === "$" || nx === "`" || nx === '"' || nx === "\\") add(nx, false, true);
          else if (nx !== "\n") { add("\\", false, true); add(nx, false, true); }
          i += 2;
          continue;
        }
        if (expansion(true)) continue;
        add(d, false, true);
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === "$" || c === "`") {
      if (expansion(false)) continue;
      add(c, false, false);
      i += 1;
      continue;
    }
    if ((c === "<" || c === ">") && s[i + 1] === "(") {
      // Process substitution: <(cmd) is a word (a path to what cmd printed); its inside is a command of its own.
      i += 2;
      stage.subs.push(balanced());
      add(c + "(...)", true, false);
      continue;
    }
    if (c === "&" && s[i + 1] === ">") {
      endWord();
      const op = s[i + 2] === ">" ? "&>>" : "&>";
      i += op.length;
      stage.redirOpen = op;
      continue;
    }
    if (c === ";" || c === "&" || c === "|" || c === "(" || c === ")") {
      const two = s.slice(i, i + 2);
      if (two === "||" || two === "&&" || two === ";;") { endPipeline(); i += 2; continue; }
      if (c === "|") { endStage(); i += s[i + 1] === "&" ? 2 : 1; continue; }
      endPipeline();
      i += 1;
      continue;
    }
    if (c === "<" || c === ">") {
      // A file descriptor number written right before the operator belongs to it ("2>").
      if (word && /^\d+$/.test(word.text) && !word.quoted) word = null;
      else endWord();
      let op = c;
      if (s[i + 1] === c) op += c;
      if (op === "<<" && s[i + 2] === "<") op = "<<<";
      else if (op === "<<" && s[i + 2] === "-") op = "<<-";
      else if (op === ">" && s[i + 1] === "|") op = ">|";
      else if (op === ">" && s[i + 1] === "&") op = ">&";
      else if (op === "<" && s[i + 1] === "&") op = "<&";
      i += op.length;
      stage.redirOpen = op;
      if (op === "<<" || op === "<<-") heredocNext = { strip: op === "<<-" };
      continue;
    }
    add(c, false, false);
    i += 1;
  }
  endPipeline();
  return { stages: pipelines };
}

// ---------------------------------------------------------------------------------------------- the names

const RESERVED_PREFIX = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "}", "time", "coproc", "fi", "done", "esac", "select"]);
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SUDO = new Set(["sudo", "sudoedit", "doas", "su", "pkexec", "runas", "gsudo"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish", "csh", "tcsh", "pwsh", "powershell", "cmd", "busybox"]);
const INTERPRETERS = new Set(["python", "python2", "python3", "perl", "ruby", "node", "deno", "bun", "php", "lua", "osascript"]);
const DOWNLOADERS = new Set(["curl", "wget", "fetch", "aria2c", "iwr", "irm", "invoke-webrequest", "invoke-restmethod"]);
const POWER = new Set(["shutdown", "reboot", "halt", "poweroff", "mkfs", "fdisk", "parted", "wipefs"]);
const SYSTEM_PACKAGERS = new Set(["apt", "apt-get", "aptitude", "dpkg", "yum", "dnf", "rpm", "pacman", "apk", "zypper", "brew", "port", "choco", "winget", "scoop", "snap", "flatpak", "softwareupdate", "emerge", "nix-env"]);
const PACKAGER_VERBS = new Set(["install", "remove", "uninstall", "upgrade", "update", "purge", "autoremove", "add", "del", "tap", "untap", "link", "unlink", "reinstall", "dist-upgrade", "full-upgrade", "localinstall", "erase", "-i"]);

/** Words that run another command with the rest of their words: look through them to the command. */
const WRAPPERS = {
  env: { value: new Set(["-u", "-C", "-S", "--unset", "--chdir", "--split-string"]), assigns: true },
  command: { value: new Set() },
  builtin: { value: new Set() },
  exec: { value: new Set(["-a"]) },
  nohup: { value: new Set() },
  nice: { value: new Set(["-n", "--adjustment"]) },
  ionice: { value: new Set(["-c", "-n", "-p"]) },
  setsid: { value: new Set() },
  stdbuf: { value: new Set(["-i", "-o", "-e"]) },
  timeout: { value: new Set(["-s", "-k", "--signal", "--kill-after"]), positional: 1 },
  xargs: { value: new Set(["-I", "-n", "-P", "-d", "-L", "-s", "-E", "-a", "-l", "-i"]) },
  watch: { value: new Set(["-n", "-d"]) },
  unbuffer: { value: new Set() },
  caffeinate: { value: new Set(["-t", "-w"]) },
  arch: { value: new Set() },
  taskset: { value: new Set(), positional: 1 },
  chronic: { value: new Set() },
};

const baseName = (w) => String(w).replace(/\\/g, "/").split("/").pop().toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, "");
const isOption = (t) => t.startsWith("-") && t.length > 1;

/** The command of a stage, through assignments, reserved words and wrappers: { name, args: [word] }. */
function commandOf(words) {
  let i = 0;
  for (let guard = 0; guard < 50 && i < words.length; guard += 1) {
    const w = words[i];
    if (!w.quoted && ASSIGN.test(w.text)) { i += 1; continue; }
    if (!w.quoted && RESERVED_PREFIX.has(w.text)) { i += 1; continue; }
    const name = baseName(w.text);
    const wrap = Object.prototype.hasOwnProperty.call(WRAPPERS, name) ? WRAPPERS[name] : null;
    if (!wrap) return { name, args: words.slice(i + 1) };
    if (name === "command" && words.slice(i + 1).some((a) => /^-[a-zA-Z]*[vV]/.test(a.text))) return { name: "", args: [] };   // a lookup, not a run
    let j = i + 1;
    let positional = wrap.positional || 0;
    for (; j < words.length; j += 1) {
      const a = words[j].text;
      if (a === "--") { j += 1; break; }
      if (wrap.assigns && ASSIGN.test(a)) continue;
      if (isOption(a)) { if (wrap.value.has(a)) j += 1; continue; }
      if (positional > 0) { positional -= 1; continue; }
      break;
    }
    i = j;
  }
  return { name: "", args: [] };
}

/** The first `max` words of an argument list that are not options (`values` are options that take a word). */
function positionals(args, max, values) {
  const out = [];
  for (let i = 0; i < args.length && out.length < max; i += 1) {
    const a = args[i].text;
    if (a === "--") { for (let k = i + 1; k < args.length && out.length < max; k += 1) out.push(args[k].text); break; }
    if (isOption(a)) { if (values && values.has(a)) i += 1; continue; }
    out.push(a);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- the paths

const SYSTEM_DIRS = ["/etc", "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/boot", "/dev", "/proc", "/sys", "/var", "/opt", "/root", "/srv", "/run", "/snap", "/system", "/library", "/applications", "/private/etc", "/private/var", "/cores"];
const SYSTEM_OK = ["/var/tmp", "/var/folders", "/private/var/folders", "/private/var/tmp", "/dev/null", "/dev/stdout", "/dev/stderr", "/dev/stdin", "/dev/tty", "/dev/fd", "/dev/zero"];
const WIN_SYSTEM = ["c:/windows", "c:/program files", "c:/program files (x86)", "c:/programdata"];
/** Where a person keeps keys and tokens, under a home folder. */
const SECRET_UNDER_HOME = [".ssh", ".aws", ".gnupg", ".azure", ".kube", ".docker", ".config/gcloud", ".config/gh", ".config/hub", ".config/doctl", ".config/rclone", ".npmrc", ".yarnrc", ".yarnrc.yml", ".netrc", "_netrc", ".pypirc", ".git-credentials", ".cargo/credentials", ".cargo/credentials.toml", ".gem/credentials", ".m2/settings.xml", ".terraform.d/credentials.tfrc.json", ".vault-token", ".bash_history", ".zsh_history", "library/keychains", "appdata/roaming/npm/etc", "appdata/roaming/gnupg", "appdata/local/google/chrome/user data", "library/application support/google/chrome", "library/application support/firefox", "library/cookies"];
const SECRET_ABSOLUTE = ["/etc/shadow", "/etc/gshadow", "/etc/sudoers", "/etc/sudoers.d", "/etc/ssh", "/root"];

const underDir = (p, dir) => p === dir || p.startsWith(dir.endsWith("/") ? dir : dir + "/");
const isWinPath = (p) => /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p);

/** A path as one comparable string: forward slashes, normalised, no trailing slash (but "/" stays), lower case. */
function canon(p) {
  let out = (isWinPath(p) ? nodePath.win32.normalize(p) : nodePath.posix.normalize(String(p))).replace(/\\/g, "/");
  if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out.toLowerCase();
}

/** The path with its longest existing part resolved through the disk (links followed, a dangling link too), the rest kept as written. */
function realish(p, realpath, depth = 0) {
  if (!realpath || depth > 8) return p;
  let head = p;
  const rest = [];
  for (let guard = 0; guard < 64; guard += 1) {
    try { const r = realpath(head); return rest.length ? nodePath.join(r, ...rest.reverse()) : r; } catch { /* not there: maybe a dangling link, else its folder */ }
    try {
      if (nodeFs.lstatSync(head).isSymbolicLink()) {
        const target = nodePath.resolve(nodePath.dirname(head), nodeFs.readlinkSync(head));
        return realish(rest.length ? nodePath.join(target, ...rest.reverse()) : target, realpath, depth + 1);
      }
    } catch { /* not a link either */ }
    const up = nodePath.dirname(head);
    if (up === head) return p;
    rest.push(nodePath.basename(head));
    head = up;
  }
  return p;
}

/** What a word names as an absolute path, or null when it holds an expansion the guard cannot know. */
function pathOf(word, ctx) {
  let t = word.text;
  if (isOption(t)) { const eq = t.indexOf("="); if (eq < 0) return null; t = t.slice(eq + 1); }
  const home = ctx.commandHome;
  if (t === "~" || t.startsWith("~/") || t.startsWith("~\\")) t = home + t.slice(1);
  else if (t.startsWith("~")) return null;
  t = t.replace(/^\$\{?(HOME|USERPROFILE)\}?(?=$|[\\/])/, home).replace(/^%USERPROFILE%/i, home);
  if (!t || /\$|`|\(\.\.\.\)/.test(t)) return null;
  if (nodePath.posix.isAbsolute(t) || isWinPath(t)) return t;
  if (!ctx.cwd) return null;
  return (isWinPath(ctx.cwd) ? nodePath.win32 : nodePath.posix).join(ctx.cwd, t);
}

/** The most specific home folder this path is under, if any. */
function homeOf(p, ctx) {
  let best = null;
  for (const h of ctx.homesCanon) if (underDir(p, h.dir) && (!best || h.dir.length > best.dir.length)) best = h;
  return best;
}

/** What is wrong with writing to this absolute path, if anything: { rule, message } or null. */
function writeProblem(abs, ctx) {
  const plain = canon(abs);
  const real = canon(realish(abs, ctx.realpath));
  for (const p of plain === real ? [plain] : [plain, real]) {
    if (underDir(p, ctx.workspaceCanon)) continue;
    if (SYSTEM_OK.some((ok) => underDir(p, ok))) continue;
    if (ctx.tmpCanon.some((d) => underDir(p, d))) continue;
    // The runner's private folders (its home, its temp, its caches) are the commands' own, dotfiles of that home excepted.
    if (underDir(p, ctx.runnerDirCanon) && !ctx.runnerHomeDotfile(p)) continue;
    if (SYSTEM_DIRS.some((d) => underDir(p, d)) || WIN_SYSTEM.some((d) => underDir(p, d)) || /^[a-z]:\/(windows|program files)/.test(p)) {
      return { rule: "system_write", message: "That writes to a system folder (" + abs + "). Xode only writes inside the project's workspace." };
    }
    const h = homeOf(p, ctx);
    if (h) {
      const first = p.slice(h.dir.length).replace(/^\//, "").split("/")[0];
      if (!first) return { rule: "home_write", message: "That writes to a home folder itself (" + abs + "). Xode only writes inside the project's workspace." };
      if (first.startsWith(".") || first === "library" || first === "appdata") {
        return { rule: "home_write", message: "That writes to a dotfile or settings folder in a home directory (" + abs + "). Xode never changes those." };
      }
      if (h.person) return { rule: "outside_write", message: "That writes outside the project's workspace, into the person's own folders (" + abs + "). Xode only writes inside the workspace." };
    }
  }
  return null;
}

/** Is this path a place where keys and tokens live? */
function secretProblem(abs, ctx) {
  const plain = canon(abs);
  const real = canon(realish(abs, ctx.realpath));
  for (const p of plain === real ? [plain] : [plain, real]) {
    if (SECRET_ABSOLUTE.some((d) => underDir(p, d)) && !underDir(p, ctx.workspaceCanon)) return true;
    for (const h of ctx.homesCanon) {
      if (!underDir(p, h.dir)) continue;
      const rel = p.slice(h.dir.length).replace(/^\//, "");
      if (SECRET_UNDER_HOME.some((s) => rel === s || rel.startsWith(s + "/"))) return true;
    }
    for (const d of ctx.protectedCanon) if (underDir(p, d) && !ctx.protectedOk.some((ok) => underDir(p, ok))) return true;
  }
  return false;
}

const refuse = (rule, message) => ({ ok: false, rule, message });

/** A folder whose recursive deletion (or owner change) would be a disaster: `/`, a home, a drive root, a parent of the workspace. */
function catastrophic(abs, ctx) {
  for (const q of [canon(abs), canon(realish(abs, ctx.realpath))]) {
    const t = q.replace(/\/(\*|\.\*|\.)$/, "") || "/";
    if (t === "/" || /^[a-z]:\/?$/.test(t)) return true;
    if (ctx.homesCanon.some((h) => h.dir === t)) return true;
    if (ctx.workspaceCanon !== t && underDir(ctx.workspaceCanon, t)) return true;   // a parent of the workspace
    if (SYSTEM_DIRS.includes(t) || WIN_SYSTEM.includes(t)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------- publish and deploy

const tool = (verbs, depth, values) => ({ verbs: new Set(verbs), depth: depth || 1, values: new Set(values || []) });
const NPM_VALUES = ["-w", "--workspace", "--prefix", "-C", "--cwd", "--filter", "-F", "--dir", "--cache", "--registry", "--userconfig", "--loglevel"];
const KUBE_VALUES = ["-n", "--namespace", "--context", "--kubeconfig", "-s", "--server", "--cluster", "--user"];

/** Tools whose subcommands publish or deploy: the words (not options) within `depth` of the tool that may name one. */
const PUBLISH = {
  npm: tool(["publish", "unpublish", "deprecate", "dist-tag", "owner", "access", "token", "login", "adduser", "logout", "star", "unstar", "team", "org"], 1, NPM_VALUES),
  pnpm: tool(["publish", "unpublish", "login", "logout", "adduser"], 1, NPM_VALUES),
  yarn: tool(["publish", "npm", "login", "logout"], 1, NPM_VALUES),
  bun: tool(["publish"], 1, NPM_VALUES),
  lerna: tool(["publish"], 2),
  changeset: tool(["publish"], 1),
  cargo: tool(["publish", "login", "logout", "yank", "owner"], 1),
  twine: tool(["upload", "register"], 1),
  poetry: tool(["publish"], 1),
  flit: tool(["publish"], 1),
  hatch: tool(["publish"], 1),
  uv: tool(["publish"], 1),
  gem: tool(["push", "yank", "signin", "owner"], 1),
  nuget: tool(["push", "delete"], 1),
  mvn: tool(["deploy", "release:perform"], 12),
  mvnw: tool(["deploy", "release:perform"], 12),
  gradle: tool(["publish", "uploadarchives"], 12),
  gradlew: tool(["publish", "uploadarchives"], 12),
  docker: tool(["push", "login", "logout", "trust"], 2),
  podman: tool(["push", "login", "logout"], 2),
  nerdctl: tool(["push", "login"], 2),
  buildah: tool(["push", "login"], 2),
  skopeo: tool(["copy", "login", "sync"], 1),
  helm: tool(["install", "upgrade", "push", "uninstall", "rollback"], 1, KUBE_VALUES),
  kubectl: tool(["apply", "create", "delete", "patch", "replace", "rollout", "scale", "set", "edit", "label", "annotate", "drain", "cordon", "taint"], 1, KUBE_VALUES),
  terraform: tool(["apply", "destroy", "import", "taint", "untaint", "force-unlock", "login"], 1, ["-chdir"]),
  tofu: tool(["apply", "destroy", "import", "taint", "untaint", "force-unlock", "login"], 1),
  pulumi: tool(["up", "destroy", "login"], 1),
  cdk: tool(["deploy", "destroy"], 1),
  sam: tool(["deploy"], 1),
  serverless: tool(["deploy", "remove", "login"], 1),
  sls: tool(["deploy", "remove", "login"], 1),
  vercel: tool(["deploy", "login", "promote", "rollback", "--prod"], 2),
  netlify: tool(["deploy", "login"], 1),
  firebase: tool(["deploy", "login"], 1),
  "firebase-tools": tool(["deploy", "login"], 1),
  "netlify-cli": tool(["deploy", "login"], 1),
  wrangler: tool(["deploy", "publish", "login", "secret"], 2),
  flyctl: tool(["deploy", "launch", "auth"], 1),
  fly: tool(["deploy", "launch", "auth"], 1),
  railway: tool(["up", "deploy", "login"], 1),
  amplify: tool(["publish", "push"], 1),
  heroku: tool(["login", "container:push", "container:release", "releases:rollback", "deploy"], 1),
  dokku: tool(["deploy"], 1),
  eas: tool(["submit"], 1),
  expo: tool(["publish"], 1),
  cap: tool(["deploy"], 2),
  capistrano: tool(["deploy"], 2),
  aws: tool(["deploy"], 3),
  gcloud: tool(["deploy"], 4),
  az: tool(["deploy"], 4),
};
/** Tools that only ever publish or deploy: refused whatever the words after them. */
const ONLY_PUBLISH = new Set(["surge", "gh-pages", "release-it", "semantic-release", "np", "now"]);
const PUBLISH_SCRIPTS = new Set(["publish", "deploy", "release:publish", "publish:all", "deploy:prod", "deploy:production", "ship"]);
const SCRIPT_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);

function publishProblem(cmd) {
  const { name } = cmd;
  const args = cmd.args;
  if (name === "git") {
    // git [global options] <subcommand>: -C <dir> and -c <k=v> take a value.
    const sub = positionals(args, 1, new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env", "--super-prefix"]))[0] || "";
    if (sub === "push" || sub === "send-pack" || sub === "receive-pack") {
      return refuse("push", "git push isn't allowed here: Xode has read-only access to the code, and it never pushes. Its changes come back through X0 Bot.");
    }
    if (sub === "config" && args.some((a) => /^--(global|system)$/.test(a.text))) return refuse("home_write", "git config --global or --system would change settings outside the workspace. Use --local, or leave it.");
    if (sub === "credential" || sub === "credential-store" || sub === "credential-cache") return refuse("secret_read", "git credential would touch stored passwords. It isn't allowed here.");
    return null;
  }
  if (name === "gh") {
    const sub = positionals(args, 1)[0] || "";
    if (["release", "repo", "workflow", "secret", "variable", "auth", "gist", "ruleset", "label", "pr", "issue", "api"].includes(sub) && sub !== "") {
      return refuse("publish", "gh " + sub + " acts on GitHub as the person, which Xode doesn't do from this computer.");
    }
    return null;
  }
  if (ONLY_PUBLISH.has(name) && !args.some((a) => /^(--version|-v|--help|-h)$/.test(a.text))) return refuse("publish", name + " publishes or deploys, which isn't allowed here.");
  // Package runners: look at the tool they run.
  const viaRunner = name === "npx" || name === "pnpx" || name === "bunx" || ((name === "pnpm" || name === "yarn") && positionals(args, 1)[0] === "dlx");
  if (viaRunner) {
    const rest = name === "npx" || name === "pnpx" || name === "bunx" ? args : args.slice(args.findIndex((a) => a.text === "dlx") + 1);
    const pkg = positionals(rest, 1, new Set(["-p", "--package", "-c", "--call"]))[0] || "";
    const inner = baseName(pkg.replace(/@[^/@]*$/, ""));
    const at = rest.findIndex((a) => a.text === pkg);
    if (inner && inner !== name && (PUBLISH[inner] || ONLY_PUBLISH.has(inner))) return publishProblem({ name: inner, args: at >= 0 ? rest.slice(at + 1) : [] });
    return null;
  }
  if (name === "python" || name === "python3" || name === "py") {
    const k = args.findIndex((a) => a.text === "-m");
    const mod = k >= 0 && args[k + 1] ? baseName(args[k + 1].text) : "";
    if (mod === "twine") return publishProblem({ name: "twine", args: args.slice(k + 2) });
    if (mod === "pip") return globalProblem({ name: "pip", args: args.slice(k + 2) });
    return null;
  }
  if (SCRIPT_RUNNERS.has(name)) {
    const words = positionals(args, 4, new Set(NPM_VALUES)).map((w) => w.toLowerCase());
    const t = PUBLISH[name];
    const hit = t ? words.slice(0, t.depth).find((w) => t.verbs.has(w)) : "";
    if (hit) return refuse("publish", name + " " + hit + " isn't allowed here: Xode doesn't publish packages or log in to registries.");
    const runAt = words.findIndex((w) => w === "run" || w === "run-script");
    const script = runAt >= 0 ? words[runAt + 1] : name === "npm" ? "" : words[0];
    if (script && PUBLISH_SCRIPTS.has(script)) return refuse("publish", name + " run " + script + " looks like a publish or deploy script, which isn't allowed here.");
    return globalProblem(cmd);
  }
  if (name === "dotnet") {
    const words = positionals(args, 3).map((w) => w.toLowerCase());
    if (words[0] === "nuget" && (words[1] === "push" || words[1] === "delete")) return refuse("publish", "dotnet nuget " + words[1] + " isn't allowed here: Xode doesn't publish packages.");
    return null;
  }
  const t = Object.prototype.hasOwnProperty.call(PUBLISH, name) ? PUBLISH[name] : null;
  if (t) {
    const words = positionals(name === "cargo" ? args.filter((a) => !a.text.startsWith("+")) : args, t.depth, t.values).map((w) => w.toLowerCase());
    const hit = words.find((w) => t.verbs.has(w) || ((name === "gradle" || name === "gradlew") && /^publish(?!tomavenlocal$)/.test(w)));
    const flag = args.find((a) => t.verbs.has(a.text.toLowerCase()) && isOption(a.text));
    if (hit || flag) return refuse("publish", name + " " + (hit || flag.text) + " isn't allowed here: Xode doesn't publish or deploy from this computer.");
    if ((name === "docker" || name === "podman") && args.some((a) => a.text === "--push" || /^--output=.*push=true/.test(a.text))) return refuse("publish", name + " build --push isn't allowed here: Xode doesn't push images.");
  }
  return globalProblem(cmd);
}

/** Software for the whole computer: system package managers, `npm -g`, `pip install --user`. */
function globalProblem(cmd) {
  const { name } = cmd;
  const a = cmd.args.map((w) => w.text);
  if (SYSTEM_PACKAGERS.has(name)) {
    const first = positionals(cmd.args, 1)[0] || "";
    const flagged = a.some((x) => PACKAGER_VERBS.has(x) || /^-[SRU][a-zA-Z]*$/.test(x));
    if (PACKAGER_VERBS.has(first) || flagged) return refuse("global_install", name + " installs or removes software for the whole computer, which isn't allowed here. Install it inside the project, or turn on \"Run in a container\".");
  }
  if (SCRIPT_RUNNERS.has(name)) {
    const words = positionals(cmd.args, 2, new Set(NPM_VALUES)).map((w) => w.toLowerCase());
    const mutates = new Set(["install", "i", "add", "link", "ln", "uninstall", "remove", "rm", "update", "upgrade", "up", "unlink", "global"]);
    if (name === "yarn" && words[0] === "global") return refuse("global_install", "yarn global installs software for the whole computer, which isn't allowed here.");
    if (words.some((w) => mutates.has(w)) && a.some((x) => x === "--global" || x === "--location=global" || /^-[a-zA-Z]*g[a-zA-Z]*$/.test(x))) {
      return refuse("global_install", name + " -g installs software for the whole computer, which isn't allowed here. Install it inside the project.");
    }
  }
  if (name === "pip" || name === "pip3") {
    if (positionals(cmd.args, 1)[0] === "install" && a.some((x) => x === "--user" || x === "--break-system-packages" || x === "--prefix=/usr" || x === "--target=/")) {
      return refuse("global_install", "pip install --user or --break-system-packages installs software for the whole computer. Use a virtual environment inside the project.");
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------- the walk

/** Every simple command in a command line, with `$( )` and `bash -c "..."` read again: [{ stage, pipeline, idx, cmd, depth }]. */
function walk(src, depth, out) {
  if (depth > 6) return out;
  for (const pipeline of parseCommand(src).stages) {
    pipeline.forEach((stage, idx) => {
      const cmd = commandOf(stage.words);
      out.push({ stage, pipeline, idx, cmd, depth });
      for (const sub of stage.subs) walk(sub, depth + 1, out);
      // A shell given a program to run: read the program as a command line.
      if (SHELLS.has(cmd.name) || cmd.name === "eval") {
        const texts = [];
        if (cmd.name === "eval") texts.push(cmd.args.map((a) => a.text).join(" "));
        else {
          const k = cmd.args.findIndex((a) => /^-[a-zA-Z]*c$/.test(a.text) || /^-command$/i.test(a.text));
          if (k >= 0 && cmd.args[k + 1]) texts.push(cmd.args[k + 1].text);
        }
        for (const t of texts) if (t.trim()) walk(t, depth + 1, out);
      }
    });
  }
  return out;
}

const downloads = (src) => walk(src, 1, []).some((e) => DOWNLOADERS.has(e.cmd.name));

/** Does this stage read the program it runs from its standard input (`| sh`, `| python -`, `| bash -s`)? */
function readsProgramFromStdin(cmd) {
  const a = cmd.args.map((w) => w.text);
  if (SHELLS.has(cmd.name)) {
    if (a.some((x) => /^-[a-zA-Z]*c$/.test(x))) return false;
    const files = a.filter((x) => !isOption(x));
    return files.length === 0 || a.includes("-s") || a.includes("-");
  }
  if (a.some((x) => /^-[a-zA-Z]*[ecmp]$/.test(x) || x === "--eval" || x === "--command" || x === "--print")) return false;
  const files = a.filter((x) => !isOption(x));
  return files.length === 0 || a.includes("-");
}

/** A word that is the program itself, given as a substitution of something downloaded (`bash <(curl ...)`, `eval "$(curl ...)"`). */
function runsDownloadedText(cmd, stage) {
  if (!stage.subs.some(downloads)) return false;
  const dynamicWord = cmd.args.some((w) => w.dynamic && /\$\(|`|<\(\.\.\.\)/.test(w.text));
  if (!dynamicWord) return false;
  const name = cmd.name;
  if (name === "eval" || name === "source" || name === ".") return true;
  if (SHELLS.has(name) || INTERPRETERS.has(name)) {
    const a = cmd.args;
    const k = a.findIndex((x) => /^-[a-zA-Z]*[cep]$/.test(x.text) || x.text === "--eval" || x.text === "--command");
    if (k >= 0) return !!(a[k + 1] && a[k + 1].dynamic);
    const firstFile = a.find((x) => !isOption(x.text));
    return !!(firstFile && /^<\(\.\.\.\)$/.test(firstFile.text));
  }
  return false;
}

/** A context for the checks: the workspace, the homes, the temp folders, and how a word's path is read. */
function makeContext(o) {
  const workspace = o.cwd || o.workspace || process.cwd();
  const personHome = o.home || nodeOs.homedir();
  const commandHome = o.commandHome || o.runnerHome || personHome;
  let realpath = o.realpath;
  if (realpath === undefined) realpath = (p) => nodeFs.realpathSync(p);
  const homes = [{ dir: canon(commandHome), person: canon(commandHome) === canon(personHome) }, { dir: canon(personHome), person: true }];
  const runnerDir = o.runnerDir || o.runnerHome || null;
  // Where scratch files may go. Given, it is the whole list; left out, the system's.
  const tmp = o.tmpDirs || [nodeOs.tmpdir(), "/tmp", "/private/tmp", "/var/tmp"];
  const runnerHomeCanon = o.runnerHome ? canon(o.runnerHome) : "";
  return {
    workspace, workspaceCanon: canon(realish(workspace, realpath)), commandHome, personHome,
    homesCanon: homes, tmpCanon: tmp.filter(Boolean).map((d) => canon(d)), realpath, cwd: workspace,
    runnerDirCanon: runnerDir ? canon(runnerDir) : "\u0000", runnerHomeCanon: runnerHomeCanon || "\u0000",
    // Inside the runner's own home a dotfile is still a dotfile: writing ~/.bashrc is refused even there.
    runnerHomeDotfile: (p) => !!runnerHomeCanon && underDir(p, runnerHomeCanon) && /^\./.test(p.slice(runnerHomeCanon.length).replace(/^\//, "")),
    protectedCanon: (o.protectedDirs || []).map((d) => canon(d)),
    protectedOk: (o.protectedOk || []).map((d) => canon(d)),
  };
}

const OUT_REDIRECT = new Set([">", ">>", ">|", "&>", "&>>", ">&"]);
const WRITERS_ALL = new Set(["rm", "rmdir", "unlink", "shred", "truncate", "touch", "mkdir", "chmod", "chown", "chgrp", "chattr", "setfacl", "mv", "tee", "mkfifo", "mknod", "del", "erase", "rd", "ri", "remove-item", "new-item", "set-content", "add-content", "out-file", "move-item", "copy-item"]);
const WRITERS_DEST = new Set(["cp", "install", "ln", "rsync", "scp", "copy", "xcopy", "robocopy"]);

/** The words naming files a command writes to. */
function writeTargets(cmd, stage) {
  const out = [];
  for (const r of stage.redirs) if (OUT_REDIRECT.has(r.op) && !(r.op === ">&" && /^(\d+|-)$/.test(r.target.text))) out.push(r.target);
  const { name, args } = cmd;
  const nonOpt = (list) => list.filter((a) => !isOption(a.text));
  const optValue = (names) => {
    const found = [];
    args.forEach((a, k) => {
      for (const nm of names) {
        if (a.text === nm && args[k + 1]) found.push(args[k + 1]);
        else if (nm.startsWith("--") && a.text.startsWith(nm + "=")) found.push({ text: a.text.slice(nm.length + 1), dynamic: a.dynamic, quoted: a.quoted });
      }
    });
    return found;
  };
  if (WRITERS_ALL.has(name)) {
    out.push(...(name === "chmod" || name === "chown" || name === "chgrp" ? nonOpt(args).slice(1) : nonOpt(args)));
  } else if (WRITERS_DEST.has(name)) {
    const into = optValue(["-t", "--target-directory"]);
    if (into.length) out.push(...into);
    else { const files = nonOpt(args); if (files.length) out.push(files[files.length - 1]); }
  } else if (name === "dd") {
    for (const a of args) if (a.text.startsWith("of=")) out.push({ text: a.text.slice(3), dynamic: a.dynamic, quoted: a.quoted });
  } else if (name === "sed" || name === "perl" || name === "ruby" || name === "gawk") {
    if (args.some((a) => /^-[a-zA-Z]*i/.test(a.text) || a.text === "--in-place" || a.text.startsWith("--in-place=") || a.text === "inplace")) out.push(...nonOpt(args).slice(1));
  } else if (name === "curl") {
    out.push(...optValue(["-o", "--output", "--output-dir"]));
  } else if (name === "wget") {
    out.push(...optValue(["-O", "--output-document", "-P", "--directory-prefix"]));
  } else if (name === "tar") {
    if (args.some((a) => (/^-?[a-zA-Z]*x[a-zA-Z]*$/.test(a.text) && !a.text.startsWith("--")) || a.text === "--extract")) out.push(...optValue(["-C", "--directory"]));
  } else if (name === "unzip") {
    out.push(...optValue(["-d"]));
  } else if (name === "git") {
    const sub = positionals(args, 1, new Set(["-C", "-c", "--git-dir", "--work-tree"]))[0];
    if (sub === "clone") { const ps = positionals(args.slice(args.findIndex((a) => a.text === "clone") + 1), 2); if (ps[1]) out.push({ text: ps[1], dynamic: false, quoted: false }); }
  }
  return out;
}

const NULLS = /^(\/dev\/null|\/dev\/std(out|err|in)|\/dev\/tty|nul|\$null)$/i;

/**
 * Is this command allowed?
 *   command    the text a shell would be given
 *   o          { cwd (the workspace), home (the person's), runnerHome (the private $HOME the command gets), runnerDir,
 *                realpath (a function, or null to read paths as written), protectedDirs, protectedOk }
 * Returns { ok: true } or { ok: false, rule, message }.
 */
function checkCommand(command, o) {
  const ctx = o && o.homesCanon ? o : makeContext(o || {});
  const all = walk(String(command), 0, []);
  let cwd = ctx.cwd;   // followed through `cd`; null once it is not known
  const here = { ...ctx };

  for (const { stage, pipeline, idx, cmd, depth } of all) {
    // Every word that names a place where keys live, whatever the command is.
    here.cwd = depth === 0 ? cwd : null;
    for (const w of stage.words.concat(stage.redirs.map((r) => r.target))) {
      const abs = pathOf(w, here);
      if (abs && secretProblem(abs, here)) return refuse("secret_read", "That names a place where keys and tokens are kept (" + w.text + "). Xode doesn't look there.");
    }
    if (!cmd.name) continue;
    const { name } = cmd;

    if (SUDO.has(name)) return refuse("sudo", name + " isn't allowed: it would run with more power than Xode has on this computer. Run the command without it.");
    if (POWER.has(name) || /^mkfs\./.test(name) || (name === "diskutil" && cmd.args.some((a) => /^(erase|partition|reformat|zero|secure)/i.test(a.text)))) {
      return refuse("system", name + " changes the whole computer, which isn't allowed here.");
    }

    // A download that is run: `curl ... | sh`, `wget -qO- ... | bash`, `bash <(curl ...)`, `sh -c "$(curl ...)"`, `eval "$(curl ...)"`.
    const downloadFirst = idx > 0 && pipeline.slice(0, idx).some((st) => DOWNLOADERS.has(commandOf(st.words).name) || st.subs.some(downloads));
    if (((SHELLS.has(name) || INTERPRETERS.has(name)) && downloadFirst && readsProgramFromStdin(cmd)) || runsDownloadedText(cmd, stage)
      || ((name === "iex" || name === "invoke-expression") && (downloadFirst || stage.subs.some(downloads) || cmd.args.some((a) => DOWNLOADERS.has(baseName(a.text)))))) {
      return refuse("pipe_to_shell", "Downloading a script and running it straight away isn't allowed. Download it, read it, then run it as a separate step.");
    }

    const pub = publishProblem(cmd);
    if (pub) return pub;
    if (SYSTEM_PACKAGERS.has(name)) { const g = globalProblem(cmd); if (g) return g; }

    // Deleting or changing a whole tree.
    const winRecurse = (/^(rd|rmdir|del|erase)$/.test(name) && cmd.args.some((a) => /^\/s$/i.test(a.text))) || (name === "remove-item" && cmd.args.some((a) => /^-recurse$/i.test(a.text)));
    const recursive = winRecurse || cmd.args.some((a) => /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(a.text) || a.text === "--recursive");
    if (["rm", "rmdir", "shred", "del", "erase", "rd", "ri", "remove-item"].includes(name) && recursive) {
      for (const w of cmd.args.filter((a) => !isOption(a.text) && !/^\/[a-z]$/i.test(a.text))) {
        const abs = pathOf(w, here);
        if (abs ? catastrophic(abs, here) : /^(\/|~|\$HOME|\$\{HOME\}|\.\.)(\/\*|\/)?$/.test(w.text)) {
          return refuse("rm_root", "That would delete a whole folder tree (" + w.text + "): the root of the disk, a home folder or a parent of the workspace. Xode only deletes inside the workspace.");
        }
      }
    }
    if ((name === "chmod" || name === "chown" || name === "chgrp") && recursive) {
      for (const w of cmd.args.filter((a) => !isOption(a.text)).slice(1)) {
        const abs = pathOf(w, here);
        if (abs && catastrophic(abs, here)) return refuse("rm_root", name + " -R on " + w.text + " would change a whole folder tree outside the workspace. It isn't allowed here.");
      }
    }
    if (name === "find") {
      const a = cmd.args;
      const deletes = a.some((x) => x.text === "-delete") || a.some((x, j) => (x.text === "-exec" || x.text === "-execdir") && ["rm", "shred", "unlink"].includes(baseName((a[j + 1] || { text: "" }).text)));
      if (deletes) {
        const stop = a.findIndex((x) => isOption(x.text) || x.text === "(" || x.text === "!");
        for (const w of a.slice(0, stop < 0 ? a.length : stop)) {
          const abs = pathOf(w, here);
          if (abs && catastrophic(abs, here)) return refuse("rm_root", "find ... -delete on " + w.text + " would delete a whole folder tree outside the workspace. It isn't allowed here.");
        }
      }
    }

    // Writes.
    for (const w of writeTargets(cmd, stage)) {
      if (NULLS.test(w.text)) continue;
      const abs = pathOf(w, here);
      if (!abs) continue;
      const bad = writeProblem(abs, here);
      if (bad) return refuse(bad.rule, bad.message);
    }

    // Follow a `cd` so that later relative paths in the same line are read where they point.
    if (depth === 0) {
      if (name === "cd" || name === "pushd") {
        const target = positionals(cmd.args, 1)[0];
        const w = cmd.args.find((a) => a.text === target);
        if (target === undefined) cwd = ctx.commandHome;
        else { const abs = w ? pathOf(w, { ...here, cwd }) : null; cwd = abs || null; }
      } else if (name === "popd") cwd = null;
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------- file operations

/**
 * A path for a file operation, given relative to the workspace: where it lands, or why not.
 * { ok: true, abs } | { ok: false, message }. Not absolute, no `..`, nothing odd in it, and (when links can be read)
 * resolving, through any links, to inside the workspace.
 */
function checkPathInside(root, rel, o) {
  const p = String(rel === undefined || rel === null ? "" : rel);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) return { ok: false, message: "That path has odd characters in it." };
  if (p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:/.test(p) || p.startsWith("~")) return { ok: false, message: "That path is not inside the workspace (" + p.slice(0, 120) + ")." };
  if (p.split(/[\\/]+/).some((x) => x === "..")) return { ok: false, message: "That path goes outside the workspace (" + p.slice(0, 120) + ")." };
  const realpath = o && o.realpath !== undefined ? o.realpath : (q) => nodeFs.realpathSync(q);
  const base = realpath ? realish(root, realpath) : root;
  const abs = nodePath.resolve(base, p || ".");
  const real = realpath ? realish(abs, realpath) : abs;
  if (!underDir(canon(real), canon(base))) return { ok: false, message: "That path leads outside the workspace through a link (" + p.slice(0, 120) + ")." };
  return { ok: true, abs };
}

module.exports = { checkCommand, checkPathInside, makeContext, parseCommand, commandOf, canon, underDir, catastrophic, writeProblem, walk };
