// The "Tailzu Code on this computer" window: the switch, the container setting, the projects, and what it ran.
// Draws what main.js sends (runner:state, runner:update); every change goes back as a request main.js checks. All text from the server
// (project names, commands) goes in with textContent, never as markup.
//
// Every word of the window is a label (desktop.runner.*, through knobs.js), so the server words and translates it. The words in
// runner.html are only the first paint; the state names are the tray's own (desktop.tray.runner*), so the window and the tray agree.
(function () {
  "use strict";
  const api = window.tailzuRunner;
  const K = window.TailzuKnobs;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const put = (id, text) => { const e = $(id); if (e) e.textContent = text; };

  // Each state: its dot, and its words (read when drawn, so a change from the server lands on the next draw).
  const STATES = {
    off: ["", () => K.txt("desktop.runner.stateOff", "Off")],
    signed_out: ["bad", () => K.txt("desktop.tray.runnerSignIn", "Sign in to use this computer")],
    connecting: ["", () => K.txt("desktop.tray.runnerConnecting", "Connecting…")],
    backoff: ["", () => K.txt("desktop.tray.runnerConnecting", "Connecting…")],
    idle: ["", () => K.txt("desktop.tray.runnerConnecting", "Connecting…")],
    online: ["online", () => K.txt("desktop.tray.runnerOnline", "Online for Xode")],
    working: ["working", () => K.txt("desktop.runner.stateWorking", "Working")],
    paused: ["paused", () => K.txt("desktop.runner.statePaused", "Paused")],
    live_off: ["", () => K.txt("desktop.tray.runnerLiveOff", "Xode is not on for your account yet")],
    replaced: ["bad", () => K.txt("desktop.tray.runnerReplaced", "Another copy of X0 Bot has this computer")],
  };
  const PAUSE = {
    battery_low: () => K.txt("desktop.tray.runnerPausedBattery", "Paused: battery is under 20%"),
    low_power_mode: () => K.txt("desktop.tray.runnerPausedLowPower", "Paused: Low Power Mode is on"),
  };

  const when = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const took = (ms) => (ms === null || ms === undefined ? ""
    : ms < 1000 ? K.txt("desktop.runner.tookMs", "{n} ms", { n: ms })
      : ms < 60000 ? K.txt("desktop.runner.tookS", "{n} s", { n: (ms / 1000).toFixed(1) })
        : K.txt("desktop.runner.tookMin", "{n} min", { n: Math.round(ms / 60000) }));

  /** The words that do not change with what is drawn: the title, the switches, the long paragraph, the headings. */
  function words() {
    const title = K.txt("desktop.runner.title", "Xode on this computer");
    document.title = title;
    put("heading", title);
    put("intro", K.txt("desktop.runner.intro", "Let Xode do its work here first: free, and fast, because nothing has to wait for a cloud computer to start."));
    put("enabledLabel", K.txt("desktop.tray.runnerUse", "Use this computer for Xode"));
    // The lead in bold, then the rest as plain text.
    const explain = $("explain");
    if (explain) {
      explain.textContent = "";
      explain.appendChild(el("b", "", K.txt("desktop.runner.explainLead", "On unless you turn it off.")));
      explain.appendChild(document.createTextNode(" " + K.txt("desktop.runner.explain", "While it is on, and only while X0 Bot is open, Xode can run its commands (tests, builds, installs) on this computer, for every project of yours but the ones you say \"Don't allow\" to below. It works in a folder of its own, from a read-only copy of your code, and cannot see your passwords, keys or other files: commands get a clean environment and a private home folder, and things like sudo, git push, publishing or deleting your home folder are refused. It pauses by itself when the battery is under 20% or Low Power Mode is on. Everything it runs is listed below and kept in a log on this computer for 7 days.")));
    }
    put("stop", K.txt("desktop.tray.runnerStop", "Stop"));
    put("stopNote", K.txt("desktop.runner.stopNote", "Stop ends what is running and turns this off until you turn it on again."));
    put("containerLabel", K.txt("desktop.runner.container", "Run in a container (Docker)"));
    put("recheck", K.txt("desktop.runner.checkDocker", "Check Docker"));
    put("projectsHead", K.txt("desktop.runner.projects", "Projects"));
    put("ranHead", K.txt("desktop.runner.ran", "What it ran"));
    put("colTime", K.txt("desktop.runner.colTime", "Time"));
    put("colProject", K.txt("desktop.runner.colProject", "Project"));
    put("colCommand", K.txt("desktop.runner.colCommand", "Command"));
    put("colExit", K.txt("desktop.runner.colExit", "Exit"));
    put("colTook", K.txt("desktop.runner.colTook", "Took"));
    put("audit", K.txt("desktop.runner.openAudit", "Open the audit log folder"));
  }

  let last = null;
  function draw(s) {
    if (!s) return;
    last = s;
    const st = s.status;
    $("enabled").checked = !!st.enabled;
    const [cls, label] = STATES[st.state] || ["", () => st.state];
    $("dot").className = "dot " + cls;
    $("state").textContent = st.state === "paused" ? (PAUSE[st.pausedReason] || label)()
      : st.state === "working" ? K.txt("desktop.runner.stateWorkingOn", "Working on {project}", { project: st.project })
        : label();
    $("workingRow").hidden = !st.working;
    $("stopNote").hidden = !st.working;
    $("working").textContent = st.working ? K.txt("desktop.tray.runnerWorking", "X0 Bot is working on {project}", { project: st.project }) : "";

    $("container").checked = !!s.container.on;
    const d = s.container.docker;
    $("recheck").hidden = !s.container.on;
    const now = !s.container.on ? ""
      : d.running ? K.txt("desktop.runner.dockerRunning", "Docker {version} is running.", { version: d.version || "" })
        : d.checked ? K.txt("desktop.runner.dockerWaiting", "{reason} Nothing will run until it is available or this is turned off.", { reason: d.reason })
          : K.txt("desktop.runner.dockerChecking", "Checking Docker…");
    $("dockerNote").textContent = (now ? now + " " : "") +
      K.txt("desktop.runner.dockerExplain", "Each command runs in a throwaway container (image {image}) with only this project's workspace mounted, so it cannot touch the rest of this computer. Needs Docker installed and running; if it is not, nothing runs here. Off by default.", { image: s.container.image });

    const box = $("projects");
    box.textContent = "";
    if (!s.projects.length) box.appendChild(el("div", "empty", K.txt("desktop.runner.noProjects", "No projects yet. Every project of yours may run here unless you say otherwise.")));
    // Every project is allowed until the person says "Don't allow"; Allow puts a refused one back.
    for (const p of s.projects) {
      const denied = p.state === "denied";
      const row = el("div", "proj");
      row.appendChild(el("span", "name", p.name));
      row.appendChild(el("span", "badge " + (denied ? "denied" : "allowed"), denied ? K.txt("desktop.runner.badgeDenied", "denied") : K.txt("desktop.runner.badgeAllowed", "allowed")));
      const act = (text, action, primary) => { const b = el("button", primary ? "primary" : "", text); b.addEventListener("click", () => api.project(p.id, p.name, action).then(refresh)); return b; };
      row.appendChild(denied ? act(K.txt("desktop.runner.allow", "Allow"), "allow", true) : act(K.txt("desktop.runner.deny", "Don't allow"), "deny"));
      box.appendChild(row);
    }

    const body = $("activity");
    body.textContent = "";
    if (!s.activity.length) { const tr = el("tr"); const td = el("td", "empty", K.txt("desktop.runner.nothingYet", "Nothing yet.")); td.colSpan = 5; tr.appendChild(td); body.appendChild(tr); }
    for (const a of s.activity) {
      const tr = el("tr");
      tr.appendChild(el("td", "", when(a.at)));
      tr.appendChild(el("td", "", a.project));
      tr.appendChild(el("td", "cmd", (a.preview ? K.txt("desktop.runner.devServer", "[dev server]") + " " : "") + a.command +
        (a.refused ? "  - " + K.txt("desktop.runner.notRun", "not run: {why}", { why: a.message || a.refused }) : "")));
      const ex = a.state === "running" ? ["run", K.txt("desktop.runner.exitRunning", "running")]
        : a.state === "refused" ? ["fail", K.txt("desktop.runner.exitRefused", "refused")]
          : a.exitCode === 0 ? ["ok", "0"]
            : ["fail", String(a.exitCode) + (a.timedOut ? " " + K.txt("desktop.runner.exitTime", "(time)") : a.cancelled ? " " + K.txt("desktop.runner.exitStopped", "(stopped)") : "")];
      tr.appendChild(el("td", "exit " + ex[0], ex[1]));
      tr.appendChild(el("td", "", took(a.ms)));
      body.appendChild(tr);
    }
    $("where").textContent = K.txt("desktop.runner.workspaces", "Workspaces: {dir}", { dir: s.workspacesDir });
  }

  function refresh() { return api.state().then(draw); }

  /** New knobs from main: the words again, and what is drawn with them. */
  function knobs(k) {
    if (!k) return;
    K.setKnobs(k);
    words();
    draw(last);
  }

  $("enabled").addEventListener("change", (e) => { api.set("enabled", e.target.checked).then(draw); });
  $("container").addEventListener("change", (e) => { api.set("container", e.target.checked).then(draw); });
  $("stop").addEventListener("click", () => { api.stop(); });
  $("audit").addEventListener("click", () => api.openAudit());
  $("recheck").addEventListener("click", () => { api.checkDocker().then(refresh); });
  api.onUpdate((s) => draw(s));
  if (api.onKnobs) api.onKnobs(knobs);
  words();
  if (api.knobs) api.knobs().then(knobs).catch(() => {});
  refresh();
})();
