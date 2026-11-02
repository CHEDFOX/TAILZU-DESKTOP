// The folders Ask may use (DeskFolders), kept by the main process.

/** The main process's last answer: { custom, folders: [{ label, path }], error }, or null until it gives one. */
let FOLDERS = null;
let FOLDERS_LISTENING = false;

function foldersWatch() {
  if (FOLDERS_LISTENING || !ENV || !ENV.askSetup) return;
  FOLDERS_LISTENING = true;
  try { window.tailzuApp.onFolders((st) => foldersTook(st)); } catch { /* an older main process */ }
  foldersRead();
}
function foldersRead() {
  try { Promise.resolve(window.tailzuApp.folders()).then(foldersTook, () => {}); } catch { /* an older main process */ }
}
function foldersTook(st) {
  if (!st || typeof st !== "object") return;
  FOLDERS = {
    custom: st.custom === true,
    error: typeof st.error === "string" ? st.error.slice(0, 160) : "",
    folders: (Array.isArray(st.folders) ? st.folders : []).slice(0, 12)
      .map((f) => ({ label: String((f && f.label) || "").slice(0, 80), path: String((f && f.path) || "").slice(0, 240) }))
      .filter((f) => f.label),
  };
  if (CURRENT_SCREEN && findNode(CURRENT_SCREEN.root, "DeskFolders")) repaint();
}
function foldersAction(kind, i) {
  try { window.tailzuApp.foldersAction(kind, Number.isInteger(i) ? i : -1); } catch { /* an older main process */ }
}

/** The row: each allowed folder with a button to take it out, then Add a folder and, once the list is the person's own, Back to the usual three. Rows reuse the setup card's look. */
function foldersNode(p, s) {
  if (!FOLDERS) return "";
  const t = (v) => esc(label(v) || "");
  const tick = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.4 6.6 11.4 12.6 4.8"/></svg>';
  const btn = (action, words, quiet, title) => '<button type="button" class="d-ask-btn' + (quiet ? " d-ask-quiet" : "") + '"' +
    bind(action) + ' aria-label="' + esc(String(words) + ": " + title) + '">' + esc(words) + "</button>";
  const rows = FOLDERS.folders.map((f, i) =>
    '<div class="d-ask-row" data-folder="' + i + '" data-done="1"><span class="d-ask-n" aria-hidden="true">' + tick + "</span>" +
    '<div class="d-ask-text"><div class="d-ask-t">' + esc(f.label) + '</div><div class="d-ask-s">' + esc(f.path) + "</div></div>" +
    '<div class="d-ask-act">' + btn({ kind: "ask.folderRemove", i: i }, label(p.remove) || "", true, f.label) + "</div></div>").join("") ||
    '<div class="d-ask-row"><span class="d-ask-n" aria-hidden="true">·</span><div class="d-ask-text"><div class="d-ask-s">' + t(p.none) + "</div></div></div>";
  const policy = typeof p.policyUrl === "string" && /^https:\/\//.test(p.policyUrl) && label(p.policyLabel)
    ? ' <button type="button" class="d-ask-link"' + bind({ kind: "openUrl", url: p.policyUrl }) + ">" + t(p.policyLabel) + "</button>"
    : "";
  const more = String(p.cls || "").split(/\s+/).filter((c) => /^d-[a-z0-9-]+$/.test(c));
  return '<section class="' + ["d-ask", "d-folders"].concat(more).join(" ") + '" data-place="settings" aria-label="' + esc(label(p.title) || "") + '" style="' + s + '"><div class="d-ask-in">' +
    (p.lede ? '<p class="d-ask-lede">' + t(p.lede) + "</p>" : "") +
    '<div class="d-ask-card">' + rows + "</div>" +
    '<p class="d-ask-foot d-folders-act">' + btn({ kind: "ask.folderAdd" }, label(p.add) || "", false, label(p.title) || "") +
    (FOLDERS.custom ? " " + btn({ kind: "ask.folderReset" }, label(p.reset) || "", true, label(p.title) || "") : "") + "</p>" +
    (FOLDERS.error ? '<p class="d-ask-foot" role="alert">' + t(p.refused) + " " + esc(FOLDERS.error) + "</p>" : "") +
    (p.foot || policy ? '<p class="d-ask-foot">' + t(p.foot) + policy + "</p>" : "") +
    "</div></section>";
}
