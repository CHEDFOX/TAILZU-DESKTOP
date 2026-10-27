// The "Tailzu Code on this computer" window: the switch, the container setting, the projects, and what it ran.
// Draws what main.js sends (runner:state, runner:update); every change goes back as a request main.js checks. All text from the server
// (project names, commands) goes in with textContent, never as markup.
(function () {
  "use strict";
  const api = window.tailzuRunner;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

  const STATES = {
    off: ["", "Off"], signed_out: ["bad", "Sign in to Tailzu to use this"], connecting: ["", "Connecting…"], backoff: ["", "Connecting…"], online: ["online", "Online for Tailzu Code"],
    working: ["working", "Working"], paused: ["paused", "Paused"], live_off: ["", "Tailzu Code is not on for your account yet"], replaced: ["bad", "Another copy of Tailzu has this computer"], idle: ["", "Connecting…"],
  };
  const PAUSE = { battery_low: "Paused: the battery is under 20%", low_power_mode: "Paused: Low Power Mode is on" };

  const when = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const took = (ms) => (ms === null || ms === undefined ? "" : ms < 1000 ? ms + " ms" : ms < 60000 ? (ms / 1000).toFixed(1) + " s" : Math.round(ms / 60000) + " min");

  function draw(s) {
    if (!s) return;
    const st = s.status;
    $("enabled").checked = !!st.enabled;
    const [cls, label] = STATES[st.state] || ["", st.state];
    $("dot").className = "dot " + cls;
    $("state").textContent = st.state === "paused" ? (PAUSE[st.pausedReason] || label) : st.state === "working" ? "Working on " + st.project : label;
    $("workingRow").hidden = !st.working;
    $("stopNote").hidden = !st.working;
    $("working").textContent = st.working ? "Tailzu is working on " + st.project : "";

    $("container").checked = !!s.container.on;
    const d = s.container.docker;
    $("recheck").hidden = !s.container.on;
    $("dockerNote").textContent = (s.container.on
      ? (d.running ? "Docker " + (d.version || "") + " is running. " : d.checked ? d.reason + " Nothing will run until it is available or this is turned off. " : "Checking Docker… ")
      : "") +
      "Each command runs in a throwaway container (image " + s.container.image + ") with only this project's workspace mounted, so it cannot touch the rest of this computer. " +
      "Needs Docker installed and running; if it is not, nothing runs here. Off by default.";

    const box = $("projects");
    box.textContent = "";
    if (!s.projects.length) box.appendChild(el("div", "empty", "No projects yet. Tailzu Code asks the first time it wants to run one here."));
    for (const p of s.projects) {
      const row = el("div", "proj");
      row.appendChild(el("span", "name", p.name));
      row.appendChild(el("span", "badge " + p.state, p.state === "ask" ? "will ask" : p.state));
      const act = (label, action, primary) => { const b = el("button", primary ? "primary" : "", label); b.addEventListener("click", () => api.project(p.id, p.name, action).then(refresh)); return b; };
      if (p.state !== "allowed") row.appendChild(act("Allow", "allow", true));
      if (p.state !== "denied") row.appendChild(act("Don't allow", "deny"));
      if (p.state !== "ask") row.appendChild(act("Ask me again", "ask"));
      box.appendChild(row);
    }

    const body = $("activity");
    body.textContent = "";
    if (!s.activity.length) { const tr = el("tr"); const td = el("td", "empty", "Nothing yet."); td.colSpan = 5; tr.appendChild(td); body.appendChild(tr); }
    for (const a of s.activity) {
      const tr = el("tr");
      tr.appendChild(el("td", "", when(a.at)));
      tr.appendChild(el("td", "", a.project));
      tr.appendChild(el("td", "cmd", (a.preview ? "[dev server] " : "") + a.command + (a.refused ? "  - not run: " + (a.message || a.refused) : "")));
      const ex = a.state === "running" ? ["run", "running"] : a.state === "refused" ? ["fail", "refused"] : a.exitCode === 0 ? ["ok", "0"] : ["fail", String(a.exitCode) + (a.timedOut ? " (time)" : a.cancelled ? " (stopped)" : "")];
      tr.appendChild(el("td", "exit " + ex[0], ex[1]));
      tr.appendChild(el("td", "", took(a.ms)));
      body.appendChild(tr);
    }
    $("where").textContent = "Workspaces: " + s.workspacesDir;
  }

  function refresh() { return api.state().then(draw); }

  $("enabled").addEventListener("change", (e) => { api.set("enabled", e.target.checked).then(draw); });
  $("container").addEventListener("change", (e) => { api.set("container", e.target.checked).then(draw); });
  $("stop").addEventListener("click", () => { api.stop(); });
  $("audit").addEventListener("click", () => api.openAudit());
  $("recheck").addEventListener("click", () => { api.checkDocker().then(refresh); });
  api.onUpdate((s) => draw(s));
  refresh();
})();
