// For tests only (not shipped): main.js run whole with Electron faked.
//
// The peek and the setup card are wired into main.js, which cannot run outside
// Electron. Here it does: its own source, every Electron module it uses
// played by a fake, the helper and the app in front scripted. What plain
// dictation RECORDS, SENDS and PASTES is all in three places, and each is
// written down in order: every message to the recorder's window (what to
// record, the app, the field, the screen around it, stop, cancel), every
// clipboard write, and every paste keystroke.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

const MAIN_JS = path.join(__dirname, "main.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The display, the app in front and the helper's caret answer the fakes give.
const WORK = { x: 100, y: 40, width: 1400, height: 860 };
const CARET = [600, 300, 2, 18];
const FIELD = [400, 290, 500, 40];
const NOTES = { label: "Notes", title: "Shopping list", private: false, sensitive: false, pictureKey: "Notes" };
const answer = (o = {}) => Object.assign({ ok: true, caret: CARET.slice(), field: FIELD.slice(), app: { name: "Notes", pid: 42 }, scale: "points" }, o);

function mainProcess(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tailzu-main-"));
  // Signed in, and far from needing a new token.
  fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify({ access_token: "tok", refresh_token: "ref", expires_at: 4102444800 }));
  // Always a bootstrap of its own: knobs.js keeps the last one it was given.
  fs.writeFileSync(path.join(dir, "bootstrap.json"), JSON.stringify({ labels: {}, flags: Object.assign({ "desktop.paste.delayMs": 1 }, o.flags) }));
  // What an earlier launch kept on this computer, when a test starts from it.
  if (o.state) fs.writeFileSync(path.join(dir, "desktop-state.json"), JSON.stringify(o.state));
  const dictation = [];   // what plain dictation records, sends and pastes
  const guide = [];       // what the guide's window was sent
  const carets = [];      // what the helper was asked
  const timers = new Set();
  const ipc = new EventEmitter();
  const handles = new Map();
  const shortcuts = [];
  const windows = [];
  const trayMenus = [];   // the tray's menus, as built (Menu.buildFromTemplate's template)
  const copy = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  class BW extends EventEmitter {
    constructor(opts) {
      super();
      this.opts = opts || {}; this.visible = false; this.destroyed = false; this.file = null;
      this.bounds = { x: this.opts.x || 0, y: this.opts.y || 0, width: this.opts.width || 100, height: this.opts.height || 100 };
      const self = this;
      this.webContents = Object.assign(new EventEmitter(), {
        send: (ch, m) => {
          if (self.file === "src/dictation/recorder/recorder.html") dictation.push(["recorder", ch, copy(m)]);
          else if (self.file === "src/agent/guide/guide.html") guide.push(copy(m));
          else if (self.file === "src/app/app.html") (self.appSent = self.appSent || []).push([ch, copy(m)]);
        },
        isLoading: () => false, isDestroyed: () => self.destroyed, getURL: () => "file://" + self.file,
        setWindowOpenHandler() {},
      });
      windows.push(this);
    }
    static getFocusedWindow() { return null; }
    loadFile(f) { this.file = f; setImmediate(() => this.webContents.emit("did-finish-load")); }
    setVisibleOnAllWorkspaces() {} setIgnoreMouseEvents() {} setContentProtection() {} setAlwaysOnTop() {} moveTop() {}
    isVisible() { return this.visible; } isDestroyed() { return this.destroyed; }
    show() { this.visible = true; } showInactive() { this.visible = true; } hide() { this.visible = false; } focus() {}
    destroy() { this.destroyed = true; } close() {}
    getBounds() { return Object.assign({}, this.bounds); } setBounds(b) { this.bounds = Object.assign({}, b); }
  }
  const img = { resize: () => img, setTemplateImage() {}, isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }) };
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true, isReady: () => true, getPath: () => dir, setPath() {}, getVersion: () => "0.4.0",
    requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(),
    quit() {}, exit() {}, relaunch() {}, dock: { hide() {} }, setAppUserModelId() {},
    getLoginItemSettings: () => ({ wasOpenedAtLogin: false }), setLoginItemSettings() {},
  });
  const electron = {
    app, BrowserWindow: BW, ipcMain: { on: (ch, f) => ipc.on(ch, f), handle: (ch, f) => handles.set(ch, f) },
    Tray: class { setImage() {} setToolTip() {} setContextMenu(m) { trayMenus.push(m); } setTitle() {} },
    Menu: { buildFromTemplate: (t) => ({ t }), setApplicationMenu() {} },
    globalShortcut: { register: (k, f) => { shortcuts.push(f); return true; }, unregisterAll() {} },
    screen: {
      getCursorScreenPoint: () => ({ x: 500, y: 400 }), getDisplayNearestPoint: () => ({ workArea: WORK, bounds: WORK }),
      getDisplayMatching: () => ({ workArea: WORK, bounds: WORK }), on() {}, screenToDipRect: (_w, r) => r,
    },
    clipboard: { writeText: (t) => dictation.push(["clipboard", t]) },
    Notification: class { show() {} on() {} },
    nativeImage: { createFromPath: () => img, createEmpty: () => img, createFromBuffer: () => img },
    session: { defaultSession: { setPermissionRequestHandler() {} } },
    shell: { openExternal: async () => {}, openPath: async () => {} },
    nativeTheme: { shouldUseDarkColors: false }, powerMonitor: { on() {} },
    desktopCapturer: { getSources: async () => [] },
    systemPreferences: { isTrustedAccessibilityClient: () => true, getMediaAccessStatus: () => "granted" },
  };
  const childProcess = {
    execFile: (cmd, args, opts, cb) => { dictation.push(["keystroke", cmd, args]); setImmediate(() => cb && cb(null, "", "")); },
    spawn: () => { throw new Error("nothing is spawned here"); },
  };
  const realFront = require("../context/frontApp.js");
  const infos = (o.infos || [NOTES]).slice();
  const frontApp = {
    frontInfo: async () => (infos.length > 1 ? infos.shift() : infos[0]),
    focusedField: async () => ({ kind: "message", label: "Message", before: "Dear Sam," }),
    warmUp() {}, shutDown() {}, label: realFront.label, looksSensitive: realFront.looksSensitive,
    isPrivate: realFront.isPrivate, privateWindowsOk: realFront.privateWindowsOk, offLimits: realFront.offLimits,
  };
  const driver = {
    available: () => true, start() {}, stop() {},
    snapshot: async () => ({ ok: false, error: "unsupported" }),
    // Which dictation it was asked during (how many had started by then).
    caret: (opt) => {
      carets.push(Object.assign({ during: dictation.filter(([w, ch]) => w === "recorder" && ch === "start-recording").length }, opt));
      return o.caret ? o.caret() : Promise.resolve(answer());
    },
  };
  const fakes = {
    electron, child_process: childProcess, "../context/frontApp.js": frontApp, "../agent/driver/driver.js": driver,
    "../context/screenRead.js": { readScreen: async () => "Sam: are we still on for Friday?" },
    "./updater.js": { canSelfUpdate: () => false, update: async () => ({ ok: false }) },
  };
  const req = (id) => {
    if (Object.prototype.hasOwnProperty.call(fakes, id)) return fakes[id];
    if (id === "uiohook-napi") throw new Error("no key hook in tests");
    if (!id.startsWith(".")) return require(id);
    // main.js's own files beside it (src/main/) run as it does, fakes and all.
    const file = require.resolve(path.join(path.dirname(MAIN_JS), id));
    return path.dirname(file) === path.dirname(MAIN_JS) ? load(file) : require(file);
  };
  // Its timers never keep the tests alive, and all of them go with it.
  const T = (set) => (f, ms, ...a) => { const t = set(f, ms, ...a); if (t && t.unref) t.unref(); timers.add(t); return t; };
  // Each file once per main process, with the fakes above, these timers and a fetch that never answers.
  const loaded = new Map();
  function load(file, source) {
    if (loaded.has(file)) return loaded.get(file).exports;
    const mod = { exports: {} };
    loaded.set(file, mod);
    const src = source || fs.readFileSync(file, "utf8");
    const wrapped = vm.runInThisContext("(function (exports, require, module, __filename, __dirname, setTimeout, setInterval, fetch) {" + src + "\n})", { filename: file });
    wrapped(mod.exports, req, mod, file, path.dirname(file), T(setTimeout), T(setInterval), async () => new Response("{}", { status: 503 }));
    return mod.exports;
  }
  const quiet = { log: console.log, warn: console.warn };
  console.warn = () => {}; console.log = () => {};
  try {
    load(MAIN_JS, o.source);
  } finally { Object.assign(console, quiet); }
  const win = (file) => windows.find((w) => w.file === file && !w.destroyed);
  const from = (file) => ({ sender: win(file).webContents });
  return {
    dictation, guide, carets, ipc, handles, windows, win, dir, app,
    /** The tray's menu as it is now: its template's items. */
    tray: () => (trayMenus.length ? trayMenus[trayMenus.length - 1].t : []),
    ready: () => sleep(20),
    // The hotkey (the first accelerator main registers is dictation's).
    hotkey: () => shortcuts[0](),
    fromRecorder: (ch, p) => ipc.emit(ch, from("src/dictation/recorder/recorder.html"), p),
    fromPill: (ch, p) => ipc.emit(ch, from("src/dictation/pill/pill.html"), p),
    fromApp: (ch, ...a) => ipc.emit(ch, from("src/app/app.html"), ...a),
    invoke: (ch, sender, ...a) => handles.get(ch)({ sender }, ...a),
    sessions: () => dictation.filter(([w, ch]) => w === "recorder" && ch === "start-recording").map(([, , p]) => p.session),
    close: () => {
      for (const t of timers) clearTimeout(t);
      app.emit("will-quit");
      fs.rmSync(dir, { recursive: true, force: true });
      require("../../knobs.js").setKnobs({ labels: {}, flags: {} });
    },
  };
}

module.exports = { mainProcess, NOTES };
