// node --test
//
// The environment a command is given (env.js): PATH, HOME, LANG and the tool caches, and nothing else from this app's own environment -
// not a token, not a cloud credential, not a setting for Node or Electron. HOME is a private folder. PATH is the person's login PATH,
// asked once, cleaned of relative entries.

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { commandEnv, createLoginPath, runnerPaths, ALLOWED_NAMES, cleanPath } = require("./env.js");
const { tempDir } = require("./testkit.js");

const SECRETS = {
  GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz0123456789", AWS_ACCESS_KEY_ID: "AKIAABCDEFGHIJKLMNOP", AWS_SECRET_ACCESS_KEY: "s3cr3t/s3cr3t/s3cr3t", AWS_SESSION_TOKEN: "tok",
  OPENAI_API_KEY: "sk-abcdefghijklmnop", GOOGLE_APPLICATION_CREDENTIALS: "/home/x/key.json", NPM_TOKEN: "npm_abcdef", ANTHROPIC_API_KEY: "sk-ant-x", SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
  HTTPS_PROXY: "http://user:pass@proxy:8080", NODE_OPTIONS: "--require /evil.js", ELECTRON_RUN_AS_NODE: "1", GH_TOKEN: "gho_xxx", KUBECONFIG: "/home/x/.kube/config", DOCKER_HOST: "tcp://x", EDITOR: "vim", USER: "alex", SHELL: "/bin/zsh",
};

test("a command gets PATH, HOME, LANG and the tool caches, and not one other variable of this app's", () => {
  const t = tempDir("tzenv-");
  const paths = runnerPaths(path.join(t.dir, "ud"));
  const env = commandEnv({ real: { ...SECRETS, PATH: "/usr/local/bin:/usr/bin", HOME: "/home/alex", LANG: "en_GB.UTF-8" }, paths, loginPath: "/opt/node/bin:/usr/bin:relative/bin::", platform: "linux", home: "/home/alex" });
  assert.deepStrictEqual(Object.keys(env).filter((k) => !ALLOWED_NAMES.has(k)), [], "every name is on the list");
  assert.strictEqual(env.PATH, "/opt/node/bin:/usr/bin", "the person's login PATH, relative entries dropped");
  assert.strictEqual(env.HOME, paths.home, "a private home, not /home/alex");
  assert.ok(env.HOME.startsWith(path.join(t.dir, "ud")));
  assert.strictEqual(env.LANG, "en_GB.UTF-8");
  assert.strictEqual(env.npm_config_cache, paths.npmCache);
  assert.strictEqual(env.PIP_CACHE_DIR, paths.pipCache);
  assert.strictEqual(env.CARGO_HOME, paths.cargoHome);
  assert.ok(env.CARGO_HOME.startsWith(paths.home), "the registry credentials of the person's own cargo home are not used");
  for (const [k, v] of Object.entries(SECRETS)) {
    assert.ok(!(k in env), k + " must not reach a command");
    assert.ok(!Object.values(env).includes(v), "the value of " + k + " must not appear");
  }
  t.remove();
});

test("LANG falls back to something safe when the app's own is odd or missing", () => {
  const paths = runnerPaths("/x/ud");
  assert.strictEqual(commandEnv({ real: { PATH: "/usr/bin", LANG: "bad value; rm -rf" }, paths, platform: "linux" }).LANG, "C.UTF-8");
  assert.strictEqual(commandEnv({ real: { PATH: "/usr/bin" }, paths, platform: "darwin" }).LANG, "en_US.UTF-8");
});

test("on Windows a command also gets what the platform cannot start a program without, and a private profile", () => {
  const paths = runnerPaths("C:\\Users\\a\\AppData\\Roaming\\Tailzu");
  const env = commandEnv({ real: { ...SECRETS, Path: "x", PATH: "C:\\Windows\\System32;C:\\Tools", SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\System32\\cmd.exe", PATHEXT: ".EXE;.CMD", USERPROFILE: "C:\\Users\\a" }, paths, loginPath: "C:\\Windows\\System32;relative;C:\\Tools", platform: "win32" });
  assert.strictEqual(env.SystemRoot, "C:\\Windows");
  assert.strictEqual(env.ComSpec, "C:\\Windows\\System32\\cmd.exe");
  assert.strictEqual(env.USERPROFILE, paths.home);
  assert.strictEqual(env.PATH, "C:\\Windows\\System32;C:\\Tools");
  for (const k of Object.keys(SECRETS)) assert.ok(!(k in env), k);
});

test("the login PATH is asked of the person's shell once, and a shell that says nothing falls back to this app's PATH and the usual places", async () => {
  const calls = [];
  const execFile = (file, args, opts, cb) => { calls.push([file, args]); cb(null, "motd noise\n__TZ_PATH_START__/home/a/.nvm/bin:/opt/homebrew/bin:/usr/bin__TZ_PATH_END__\n"); return { stdin: { end() {} } }; };
  const lp = createLoginPath({ execFile, real: { SHELL: "/bin/zsh", PATH: "/usr/bin" }, platform: "darwin" });
  assert.strictEqual(await lp.get(), "/home/a/.nvm/bin:/opt/homebrew/bin:/usr/bin");
  assert.strictEqual(await lp.get(), "/home/a/.nvm/bin:/opt/homebrew/bin:/usr/bin");
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0][0], "/bin/zsh");
  assert.ok(calls[0][1].includes("-ilc"));
  const silent = createLoginPath({ execFile: (f, a, o, cb) => { cb(new Error("timeout"), ""); return { stdin: { end() {} } }; }, real: { PATH: "/usr/bin" }, platform: "linux" });
  const p = await silent.get();
  assert.ok(p.startsWith("/usr/bin"));
  assert.ok(p.includes("/opt/homebrew/bin") && p.includes("/usr/local/bin"));
  const win = createLoginPath({ execFile() { throw new Error("must not be called"); }, real: { PATH: "C:\\a;C:\\b" }, platform: "win32" });
  assert.strictEqual(await win.get(), "C:\\a;C:\\b");
});

test("a PATH is reduced to absolute folders, each once", () => {
  assert.strictEqual(cleanPath("/a:/a:/b::.:rel:/c", "linux"), "/a:/b:/c");
  assert.strictEqual(cleanPath('"C:\\a";C:\\a;.;x', "win32"), "C:\\a");
});
