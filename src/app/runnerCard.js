// "TAILZU CODE ON THIS COMPUTER", AS A CARD ON THE SERVER'S PAGE (bots.computer's DeskRunner node).
//
// The runner's own window (runner/runner.html, runner/ui.js) drew this with its words built in. Here the
// server's page places the card and sends every word it shows (the node's props, translated like any other
// page's); this file draws what the main process says the runner is doing and sends the card's buttons back
// to it, which checks each one (main.js, runner:*). Turning it on and allowing a project are asked by the main
// process itself, in its own words, before they happen: a page the server drew is never the consent.
//
// Loaded after sdui.js, whose escaping, actions, state and painting it uses. Everything the main process sends
// (project names, commands, a reason) goes in escaped, never as markup.
/* global esc, label, bind, repaint, CURRENT_SCREEN, findNode */
/* eslint-env browser */

/** The main process's last snapshot: { status, container, projects, activity, workspacesDir }, or null. */
let RUNNER = null;
let RUNNER_LISTENING = false;

/** This window can show the runner: an older main process has no such calls. */
function runnerOn() {
  return !!(window.tailzuApp && typeof window.tailzuApp.runner === "function");
}

function runnerWatch() {
  if (RUNNER_LISTENING || !runnerOn()) return;
  RUNNER_LISTENING = true;
  try { window.tailzuApp.onRunner((s) => runnerTook(s)); } catch { /* an older main process */ }
  runnerRead();
}
function runnerRead() {
  try { Promise.resolve(window.tailzuApp.runner()).then(runnerTook, () => {}); } catch { /* an older main process */ }
}
function runnerTook(s) {
  if (!s || typeof s !== "object" || !s.status || typeof s.status !== "object") return;
  RUNNER = s;
  if (CURRENT_SCREEN && findNode(CURRENT_SCREEN.root, "DeskRunner")) repaint();
}

/** The card's buttons. The main process answers with the snapshot again, or nothing (refused, or asked and declined). */
function runnerRun(action) {
  if (!runnerOn() || !action) return undefined;
  const api = window.tailzuApp;
  const then = (p) => Promise.resolve(p).then((s) => { if (s) runnerTook(s); else runnerRead(); }, () => runnerRead());
  try {
    switch (action.kind) {
      case "runner.set": return then(api.runnerSet(String(action.key || ""), action.value === true || action.value === "true"));
      case "runner.project": return then(api.runnerProject(String(action.id || ""), String(action.name || ""), String(action.action || "")));
      case "runner.checkDocker": return then(api.runnerCheckDocker());
      case "runner.stop": api.runnerStop(); return undefined;
      case "runner.openAudit": api.runnerOpenAudit(); return undefined;
      default: return undefined;
    }
  } catch { return undefined; }
}

/** "09:41:07", as the window said it. */
const runnerWhen = (t) => { try { return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); } catch { return ""; } };
/** "820 ms", "3.4 s", "2 min". */
const runnerTime = (ms) => (ms === null || ms === undefined ? "" : ms < 1000 ? ms + " ms" : ms < 60000 ? (ms / 1000).toFixed(1) + " s" : Math.round(ms / 60000) + " min");

/** The card: the switch and what it is doing, the safety words, Stop, the container, the projects and what it ran. */
function runnerNode(p, s) {
  runnerWatch();
  if (!RUNNER) return "";
  const w = (k, vars) => {
    const v = label(p[k]) || "";
    return vars ? String(v).replace(/\{(\w+)\}/g, (m, x) => (x in vars ? String(vars[x]) : m)) : String(v);
  };
  const st = RUNNER.status || {};
  const box = RUNNER.container && typeof RUNNER.container === "object" ? RUNNER.container : {};
  const docker = box.docker && typeof box.docker === "object" ? box.docker : {};
  const project = String(st.project || "").slice(0, 120);
  const stateWord = {
    off: w("stateOff"), signed_out: w("stateSignedOut"), connecting: w("stateConnecting"), backoff: w("stateConnecting"),
    idle: w("stateConnecting"), online: w("stateOnline"), paused: w("statePaused"), live_off: w("stateLiveOff"), replaced: w("stateReplaced"),
  };
  const line = st.state === "working" ? w("stateWorking", { project })
    : st.state === "paused" ? (st.pausedReason === "battery_low" ? w("pausedBattery") : st.pausedReason === "low_power_mode" ? w("pausedLowPower") : w("statePaused"))
    : (stateWord[st.state] || "");
  const sw = (on, action, name) => '<button type="button" role="switch" class="d-switch" aria-checked="' + (on ? "true" : "false") + '"' +
    bind(action) + ' aria-label="' + esc(name) + '"></button>';
  const btn = (action, words, quiet) => '<button type="button" class="d-ask-btn' + (quiet ? " d-ask-quiet" : "") + '"' + bind(action) + ">" + esc(words) + "</button>";
  const row = (left, title, sub, act) => '<div class="d-ask-row">' + (left || '<span aria-hidden="true"></span>') +
    '<div class="d-ask-text">' + (title ? '<div class="d-ask-t">' + esc(title) + "</div>" : "") + (sub ? '<div class="d-ask-s">' + sub + "</div>" : "") + "</div>" +
    '<div class="d-ask-act">' + (act || "") + "</div></div>";
  const dot = '<span class="d-ask-n" aria-hidden="true" style="background:' +
    (st.state === "online" ? "var(--d-ok)" : st.state === "working" ? "var(--d-amber)" : st.state === "paused" || st.state === "signed_out" || st.state === "replaced" ? "var(--danger, #E5736B)" : "var(--d-rule)") +
    ';box-shadow:none;width:12px;height:12px;justify-self:center"></span>';

  const enabled = !!st.enabled;
  const main = [
    row(dot, w("use"), esc(line), sw(enabled, { kind: "runner.set", key: "enabled", value: !enabled }, w("use"))),
    '<div class="d-ask-row" style="grid-template-columns:minmax(0, 1fr)"><div class="d-ask-s"><b>' + esc(w("safetyLead")) + "</b> " + esc(w("safety")) + "</div></div>",
  ];
  if (st.working) {
    main.push(row("", w("workingLine", { project }), esc(w("stopNote")), btn({ kind: "runner.stop" }, w("stop"), false)));
  }
  const on = !!box.on;
  const dockerLine = on
    ? (docker.running ? w("dockerRunning", { version: String(docker.version || "").slice(0, 40) })
      : docker.checked ? w("dockerDown", { reason: String(docker.reason || "").slice(0, 200) }) : w("dockerChecking"))
    : "";
  main.push(row("", w("container"), esc([dockerLine, w("containerNote", { image: String(box.image || "").slice(0, 120) })].filter(Boolean).join(" ")),
    (on ? btn({ kind: "runner.checkDocker" }, w("checkDocker"), true) : "") + sw(on, { kind: "runner.set", key: "container", value: !on }, w("container"))));

  const projects = (Array.isArray(RUNNER.projects) ? RUNNER.projects : []).slice(0, 50);
  const projectRows = projects.map((x) => {
    const id = String((x && x.id) || ""), name = String((x && x.name) || "").slice(0, 120), state = String((x && x.state) || "");
    const badge = state === "ask" ? w("badgeAsk") : state === "allowed" ? w("badgeAllowed") : state === "denied" ? w("badgeDenied") : state;
    const acts = (state !== "allowed" ? btn({ kind: "runner.project", id, name, action: "allow" }, w("allow"), false) : "") +
      (state !== "denied" ? btn({ kind: "runner.project", id, name, action: "deny" }, w("deny"), true) : "") +
      (state !== "ask" ? btn({ kind: "runner.project", id, name, action: "ask" }, w("askAgain"), true) : "");
    return row("", name, esc(badge), acts);
  }).join("") || row("", "", esc(w("noProjects")), "");

  const activity = (Array.isArray(RUNNER.activity) ? RUNNER.activity : []).slice(0, 100);
  const cell = (v, extra) => '<td style="padding:6px 8px;border-bottom:1px solid var(--d-rule);vertical-align:top' + (extra || "") + '">' + esc(v) + "</td>";
  const rows = activity.map((a) => {
    const cmd = (a.preview ? w("devServer") + " " : "") + String(a.command || "").slice(0, 400) +
      (a.refused ? "  " + w("notRun", { why: String(a.message || a.refused).slice(0, 200) }) : "");
    const exit = a.state === "running" ? w("running") : a.state === "refused" ? w("refused")
      : a.exitCode === 0 ? "0" : String(a.exitCode) + (a.timedOut ? " " + w("timedOut") : a.cancelled ? " " + w("stopped") : "");
    return "<tr>" + cell(runnerWhen(a.at)) + cell(String(a.project || "").slice(0, 120)) +
      cell(cmd, ";font-family:var(--f-mono, ui-monospace, Menlo, Consolas, monospace);font-size:12.5px;word-break:break-all") + cell(exit) + cell(runnerTime(a.ms)) + "</tr>";
  }).join("") || '<tr><td colspan="5" style="padding:14px 8px;color:var(--d-ink3)">' + esc(w("nothingYet")) + "</td></tr>";
  const th = (v, width) => '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--d-rule);font-weight:600;font-size:12px;color:var(--d-ink2)' +
    (width ? ";width:" + width : "") + '">' + esc(v) + "</th>";

  return '<section class="d-ask d-runner" data-place="settings" aria-label="' + esc(w("title")) + '" style="' + s + '"><div class="d-ask-in">' +
    (p.lede ? '<p class="d-ask-lede">' + esc(w("lede")) + "</p>" : "") +
    '<div class="d-ask-card">' + main.join("") + "</div>" +
    '<p class="d-ask-foot" style="margin-top:22px;font-weight:600;color:var(--d-ink2)">' + esc(w("projects")) + "</p>" +
    '<div class="d-ask-card">' + projectRows + "</div>" +
    '<p class="d-ask-foot" style="margin-top:22px;font-weight:600;color:var(--d-ink2)">' + esc(w("ran")) + "</p>" +
    '<div class="d-ask-card" style="padding:4px 8px"><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr>' +
    th(w("colTime"), "84px") + th(w("colProject"), "120px") + th(w("colCommand")) + th(w("colExit"), "70px") + th(w("colTook"), "70px") +
    "</tr></thead><tbody>" + rows + "</tbody></table></div>" +
    '<p class="d-ask-foot d-folders-act">' + btn({ kind: "runner.openAudit" }, w("audit"), true) +
    " <span>" + esc(w("workspaces", { dir: String(RUNNER.workspacesDir || "").slice(0, 240) })) + "</span></p>" +
    "</div></section>";
}

if (typeof module === "object" && module && module.exports) module.exports = { runnerNode, runnerRun, runnerTook };
