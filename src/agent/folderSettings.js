// The folders Ask may use, as the app window's Settings row shows them
// (DeskFolders): the main process's side of that row.

const nodeFs = require("node:fs");
const nodePath = require("node:path");

/**
 * The allowed folders, in the app window. The server draws the row (its words);
 * this is the main process's side: the list as it stands, and three buttons
 * (add a folder through the system's own chooser, take one out, back to the
 * usual three). A folder is added only if the guard accepts it (not a system,
 * app or hidden folder, not the home folder); the list is this computer's own
 * and never sent anywhere.
 *
 *   o.ipcMain, o.fromApp(e), o.dialog, o.window()   the app window, for the chooser
 *   o.files        createLocalFiles()
 *   o.localState, o.saveLocalState
 *   o.home         for showing "~/Downloads"
 *   o.send(state)  to the app window, as "ask-folders"
 */
function createFolderSettings(o) {
  const files = o.files;
  const home = o.home || "";
  let error = "";
  const call = (f, fallback) => { try { return f(); } catch { return fallback; } };
  const tilde = (p) => (home && (p === home || p.startsWith(home + nodePath.sep)) ? "~" + p.slice(home.length) : p);

  function state() {
    const custom = Array.isArray(o.localState.askFolders);
    return {
      custom,
      folders: files.roots().map((r) => ({ label: r.label, path: tilde(r.path) })),
      error,
    };
  }
  const push = () => call(() => o.send(state()));
  /** The folders as saved paths: the list in force now, to be changed. */
  const current = () => (Array.isArray(o.localState.askFolders) ? o.localState.askFolders.slice() : files.roots().map((r) => r.path));
  const save = (list) => { o.localState.askFolders = list; call(() => o.saveLocalState()); };

  async function act(p) {
    if (!p || typeof p !== "object") return false;
    error = "";
    if (p.kind === "reset") {
      delete o.localState.askFolders;
      call(() => o.saveLocalState());
      return true;
    }
    if (p.kind === "remove") {
      const roots = files.roots();
      const r = Number.isInteger(p.i) ? roots[p.i] : null;
      if (!r) return false;
      save(current().filter((x) => call(() => nodeFs.realpathSync(x), x) !== r.path));
      return true;
    }
    if (p.kind === "add") {
      let picked;
      try {
        picked = await o.dialog.showOpenDialog(call(() => o.window(), undefined), { properties: ["openDirectory"], buttonLabel: "Allow" });
      } catch { return false; }
      if (!picked || picked.canceled || !Array.isArray(picked.filePaths) || !picked.filePaths[0]) return false;
      const c = files.checkRoot(picked.filePaths[0]);
      if (!c.ok) { error = c.why; return true; }
      if (!files.roots().some((r) => r.path === c.path)) save(current().concat(c.path).slice(0, 12));
      return true;
    }
    return false;
  }

  o.ipcMain.handle("app:folders", (e) => (o.fromApp(e) ? state() : null));
  o.ipcMain.on("app:foldersAction", async (e, p) => {
    if (!o.fromApp(e)) return;
    if (await act(p)) push();
  });
  return { state, push, act };
}

module.exports = { createFolderSettings };
