// TAILZU CODE ON THIS COMPUTER: the person's own computer as a runner for Xode.
//
// docs/desktop-runner-session.md (in the backend repository) is the protocol; this is the app's side of it, from the switch in
// the tray to the last process killed. In the order things happen:
//
//   the switch     "Use this computer for Tailzu Code", OFF until the person turns it on (state.enabled)
//   presence       presence.js keeps one WebSocket open to the jobs Worker, so the router knows this computer is here. Paused (the
//                  socket closed, nothing polled) while the battery is under 20% or a low-power mode is on (power.js)
//   an offer       the router chose this computer for a step. Which project is it? (the server's job record). Has the person allowed
//                  it here? (allow.js; asked the first time.) Then the code: a workspace under <userData>/workspaces, fetched with the
//                  read-only token the offer carries (workspace.js)
//   a session      the step is a live session: connect to the job's room and do what it sends, one thing at a time (session.js)
//   a plain step   no session: run its commands, hand back what they changed (changes.js) and report
//   the report     POST /v1/code/runner/result, with the real minutes; progress every 30 s until then, to keep the lease
//   Stop / quit    every process Tailzu Code started is killed (procs.js), on Stop, on a closed session, on quit, on a crash (and, with
//                  the watchdog, when the app is killed outright)
//
// Every command goes into the audit log (audit.js) and the activity list (activity.js). Nothing here touches Electron: the tray, the
// window and the dialog are handed in, so the tests run all of it with a fake Worker.

"use strict";

const nodeFs = require("fs");
const nodeOs = require("os");
const crypto = require("crypto");
const childProcess = require("child_process");

const { helloFrame, isDeviceId, isSessionCommands } = require("./protocol.js");
const { createPresence } = require("./presence.js");
const { connectWs } = require("./ws.js");
const { createPowerGate, createSystemSource } = require("./power.js");
const { createAllowList } = require("./allow.js");
const { createAudit } = require("./audit.js");
const { createActivity } = require("./activity.js");
const { createWorkspaces, tarExtract } = require("./workspace.js");
const { createGit } = require("./gitrun.js");
const { commandEnv, createLoginPath, runnerPaths, ensurePaths, ensureContainerCache } = require("./env.js");
const { createSpawner, runCommands, firstRefusal } = require("./exec.js");
const { makeContext } = require("./guard.js");
const { createSession } = require("./session.js");
const { createProcs } = require("./procs.js");
const { createWatchdog } = require("./watchdog.js");
const { redact, secretValues, tailOf, TAIL_BYTES } = require("./redact.js");
const { changesAgainst, skippedNote } = require("./changes.js");
const { layOverlay } = require("./overlay.js");
const { dockerStatus, dockerClientEnv, DEFAULT_IMAGE } = require("./docker.js");

const LEASE_EVERY_MS = 30000;
const REPORT_WAITS = [0, 2000, 5000, 15000];
const DOCKER_TTL_MS = 30000;
const PROJECTS_TTL_MS = 10 * 60000;

/** "acme/app" from https://github.com/acme/app.git: the last two parts of the address. */
function repoName(cloneUrl) {
  const m = /([^/:]+\/[^/]+?)(?:\.git)?\/?$/i.exec(String(cloneUrl || ""));
  return m ? m[1] : "";
}

/**
 * o: {
 *   userData, version, platform, hostname,
 *   state            the runner's saved settings: { enabled, container, deviceId, projects } - mutated in place, then saveState()
 *   saveState()
 *   api              { fetch(path, init) -> Response (as the signed-in person), signedIn() -> boolean }
 *   secrets()        the app's own tokens, so no output can carry them
 *   ask({ projectId, name }) -> Promise<true | false | null>    the question to the person
 *   notify(text)     a native notification
 *   config           { image, name } from config.json
 *   powerMonitor     Electron's, for the battery
 *   -- for the tests: real (the environment), fs, child { execFile, spawn }, connect, power { read }, urlPolicy, dockerStatus, sleep,
 *      timers, askWaitMs, previewLimits, caps, graceMs, noWatchdog, leaseEveryMs
 * }
 */
function createRunner(o) {
  const real = o.real || process.env;
  const platform = o.platform || process.platform;
  const fs = o.fs || nodeFs;
  const child = o.child || childProcess;
  const timers = o.timers || { setTimeout, clearTimeout };
  const now = o.now || Date.now;
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = o.log || (() => {});
  const config = o.config || {};
  const settings = o.state;
  const paths = runnerPaths(o.userData);
  ensurePaths(paths, fs);

  if (typeof settings.enabled !== "boolean") settings.enabled = false;
  if (typeof settings.container !== "boolean") settings.container = false;
  if (!settings.projects || typeof settings.projects !== "object") settings.projects = {};
  if (!isDeviceId(settings.deviceId)) { settings.deviceId = "desk-" + crypto.randomBytes(8).toString("hex"); o.saveState(); }

  // ---- the pieces ----
  const loginPath = createLoginPath({ execFile: child.execFile, real, platform });
  const git = createGit({ execFile: child.execFile, real, home: paths.home, getPath: () => loginPath.get(), platform });
  const workspaces = createWorkspaces({ root: paths.workspaces, git, fs, urlPolicy: o.urlPolicy, fetchFn: o.fetch, now, tar: o.tar || tarExtract, log });
  const watchdog = o.noWatchdog ? null : createWatchdog({ spawn: child.spawn, env: real });
  const procs = createProcs({ platform, spawn: child.spawn, spawnSync: child.spawnSync, watchdog });
  const audit = createAudit({ dir: paths.audit, fs, now, redact: (t) => redact(t, secretValues(real).concat(o.secrets ? o.secrets() : [])), onError: (e) => log("audit: " + e.message) });
  const activity = createActivity({ now });
  const allow = createAllowList({
    read: () => settings.projects,
    write: (map) => { settings.projects = map; o.saveState(); },
    ask: (p) => o.ask(p), waitMs: o.askWaitMs, now, timers,
  });
  const readPower = (o.power && o.power.read) || createSystemSource({ platform, execFile: child.execFile, fs, powerMonitor: o.powerMonitor });
  const power = createPowerGate({
    read: readPower, timers,
    onChange: () => { sync(); },
  });

  const listeners = new Set();
  let job = null;
  let docker = { installed: false, running: false, version: "", reason: "", at: 0 };
  let dockerAsking = null;
  let projects = { ids: [], names: {}, at: 0 };
  let projectsAsking = null;
  let stopped = false;

  const computerName = () => String(config.name || o.hostname || nodeOs.hostname() || "This computer").replace(/\.local$/i, "").trim().slice(0, 80) || "This computer";
  function changed() {
    for (const f of listeners) { try { f(); } catch { /* the window's own */ } }
    try { if (o.onChange) o.onChange(); } catch { /* the tray's own */ }
  }
  activity.onChange(changed);

  // ---- the server ----
  async function postJson(path, body) {
    return o.api.fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }

  async function getTicket() {
    if (!o.api.signedIn()) return { ok: false, reason: "signed_out" };
    let res;
    try { res = await postJson("/v1/code/runner/ticket", { deviceId: settings.deviceId }); } catch (err) { return { ok: false, reason: "error", message: "the network: " + String((err && err.message) || err).slice(0, 100) }; }
    if (res.status === 404) {
      let j = null;
      try { j = await res.json(); } catch { /* not JSON */ }
      return j && j.code === "live_off" ? { ok: false, reason: "live_off" } : { ok: false, reason: "error", message: "404" };
    }
    if (res.status === 401) return { ok: false, reason: "error", message: "the server did not accept the sign-in" };
    if (res.status === 429) return { ok: false, reason: "too_many", message: "429" };
    if (!res.ok) return { ok: false, reason: "error", message: String(res.status) };
    let j;
    try { j = await res.json(); } catch { return { ok: false, reason: "error", message: "an answer that was not understood" }; }
    if (!j || typeof j.url !== "string" || typeof j.ticket !== "string" || !j.ticket) return { ok: false, reason: "error", message: "an answer without a ticket" };
    // Only worth knowing when some project has been refused: the hello leaves those out.
    if (Object.values(settings.projects).some((e) => e && e.allowed === false)) await refreshProjects().catch(() => {});
    return { ok: true, url: j.url, ticket: j.ticket };
  }

  async function refreshProjects(force) {
    if (!force && projects.at && now() - projects.at < PROJECTS_TTL_MS) return projects;
    if (projectsAsking) return projectsAsking;
    projectsAsking = (async () => {
      try {
        const res = await o.api.fetch("/v1/code/projects", { method: "GET" });
        if (res.ok) {
          const j = await res.json();
          const list = Array.isArray(j && j.projects) ? j.projects : [];
          projects = { ids: list.map((p) => String(p.id)).filter(Boolean), names: Object.fromEntries(list.map((p) => [String(p.id), String(p.fullName || p.id)])), at: now() };
        }
      } catch { /* the cache stands */ }
      projectsAsking = null;
      return projects;
    })();
    return projectsAsking;
  }

  /** Tells the server which projects this computer takes: all of the person's, but the ones refused here. */
  async function pushProjects() {
    await refreshProjects().catch(() => {});
    presence.sendState({ projects: allow.helloProjects(projects.ids) });
  }

  /** The project a job belongs to: the server's own record of the job. */
  async function projectIdOf(jobId) {
    try {
      const res = await o.api.fetch("/v1/code/jobs/" + encodeURIComponent(jobId), { method: "GET" });
      if (!res.ok) return "";
      const j = await res.json();
      const id = j && j.job && j.job.projectId;
      return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id) ? id : "";
    } catch { return ""; }
  }

  // ---- presence ----
  const wantOnline = () => settings.enabled && o.api.signedIn() && !power.paused;

  const presence = createPresence({
    getTicket,
    connect: o.connect || connectWs,
    hello: () => helloFrame({ deviceId: settings.deviceId, name: computerName(), allowRun: wantOnline(), projects: allow.helloProjects(projects.ids), busy: !!job, app: "tailzu-desktop " + (o.version || "") }),
    onOffer: (offer) => { handleOffer(offer).catch((err) => log("offer: " + String((err && err.stack) || err))); },
    onCancel: (jobId, epoch) => { if (job && job.id === jobId && epoch >= job.epoch) abortJob(job, "the server took the step back", false); },
    onStatus: () => changed(),
    timers, log,
    pingEveryMs: o.pingEveryMs, deadAfterMs: o.deadAfterMs, baseMs: o.baseMs, maxMs: o.maxMs,
  });

  /** Brings presence in line with the switch, the sign-in and the power: online, or not. */
  let powerReady = false;
  /** `fresh`: the person just turned it on, so a computer another copy had taken (`replaced`) is taken back; otherwise it is left alone. */
  function sync(fresh) {
    if (stopped) return;
    if (settings.enabled) {
      // The battery is read once before going online, so a laptop at 10% does not connect for a moment and leave again.
      if (!powerReady) {
        const first = power.start();
        first.then(() => { powerReady = true; if (!stopped) apply(fresh); }).catch((err) => log("power: " + String((err && err.message) || err)));
        changed();
        return;
      }
    } else { power.stop(); powerReady = false; }
    apply(fresh);
  }
  function apply(fresh) {
    if (wantOnline()) { if (presence.state !== "replaced" || fresh) presence.start(); }
    else if (job) presence.sendState({ allowRun: false });
    else presence.stop();
    changed();
  }

  // ---- a job ----
  function decline(j, reason) {
    j.declined = reason;
    presence.decline(j.id, j.epoch, reason);
    audit.log({ event: "declined", jobId: j.id, project: j.project, projectId: j.projectId, reason });
  }

  /** Keeps the lease: a progress call now, and every 30 seconds until the step ends. A step given to another computer ends this one. */
  function keepLease(j) {
    const tick = async () => {
      if (j.leaseStopped) return;
      try {
        const res = await postJson("/v1/code/runner/progress", { jobId: j.id, epoch: j.epoch });
        if (res.status === 409) { abortJob(j, "the step moved to another computer", false); return; }
      } catch { /* the next one will do */ }
      if (!j.leaseStopped) j.leaseTimer = timers.setTimeout(tick, o.leaseEveryMs || LEASE_EVERY_MS);
    };
    void tick();
  }
  const stopLease = (j) => { j.leaseStopped = true; timers.clearTimeout(j.leaseTimer); };

  /** Ends a job in progress. `doReport`: tell the server (the person stopped it); not when the server itself took the step back. */
  function abortJob(j, reason, doReport) {
    if (!j || j.aborted) return;
    j.aborted = { reason, report: !!doReport };
    if (j.session) j.session.stop(reason);
    j.abort.abort();
    procs.killAll();
  }

  async function post(path, body) {
    let status = 0;
    for (const wait of REPORT_WAITS) {
      if (wait) await sleep(wait);
      try {
        const res = await postJson(path, body);
        status = res.status;
        if (res.ok) return { ok: true, status };
        if (res.status < 500 && res.status !== 429) return { ok: false, status };
      } catch { status = 0; }
    }
    return { ok: false, status };
  }

  /** The result of the step, as any runner sends it. A 409 (the step went to another computer meanwhile) is not this app's failure. */
  async function report(j, exitCode, outputTail, changes) {
    if (j.reported) return;
    j.reported = true;
    const minutes = Math.round(((now() - j.startedAt) / 60000) * 1000) / 1000;
    const known = j.known || [];
    const body = { jobId: j.id, stepIdx: j.stepIdx, epoch: j.epoch, exitCode, outputTail: tailOf(redact(outputTail, known), TAIL_BYTES), minutes, changes: changes || [] };
    const r = await post("/v1/code/runner/result", body);
    audit.log({ event: "reported", jobId: j.id, project: j.project, exitCode, minutes, ok: r.ok, status: r.status });
    return r;
  }

  async function dockerNow(force) {
    if (!force && docker.at && now() - docker.at < DOCKER_TTL_MS) return docker;
    if (dockerAsking) return dockerAsking;
    dockerAsking = (async () => {
      const probe = o.dockerStatus || ((env) => dockerStatus({ execFile: child.execFile, env }));
      const st = await probe(dockerClientEnv(real, await loginPath.get()));
      docker = Object.assign({}, st, { at: now() });
      dockerAsking = null;
      changed();
      return docker;
    })();
    return dockerAsking;
  }

  async function handleOffer(offer) {
    if (job) { presence.decline(offer.jobId, offer.epoch, "busy"); return; }
    if (!settings.enabled || !o.api.signedIn() || power.paused) { presence.decline(offer.jobId, offer.epoch, "not_available"); return; }
    const j = {
      id: offer.jobId, epoch: offer.epoch, stepIdx: offer.stepIdx, offer, startedAt: now(), project: repoName(offer.repo.cloneUrl) || "a project", projectId: "",
      phase: "starting", session: null, aborted: null, declined: "", reported: false, leaseStopped: false, leaseTimer: null, abort: new AbortController(), current: [],
      known: secretValues(real).concat(o.secrets ? o.secrets() : [], offer.repo.readToken || [], offer.session ? offer.session.ticket : []).filter((v) => typeof v === "string" && v.length >= 8),
    };
    job = j;
    presence.sendState({ busy: true });
    changed();
    keepLease(j);
    try {
      await runJob(j);
      // Stopped by the person before anything began: the step is handed back with a word, not left to run out its lease.
      if (!j.reported && !j.declined && j.aborted && j.aborted.report) await report(j, 1, "[X0 Bot: " + j.aborted.reason + " before the step began]");
    } catch (err) {
      log("job " + j.id + " failed: " + String((err && err.stack) || err));
      audit.log({ event: "error", jobId: j.id, project: j.project, message: String((err && err.message) || err).slice(0, 300) });
      if (!j.declined && !(j.aborted && !j.aborted.report)) await report(j, 1, "[X0 Bot: this computer could not run the step: " + String((err && err.message) || err).slice(0, 200) + "]").catch(() => {});
    } finally {
      stopLease(j);
      activity.settleRunning();
      procs.killAll();
      procs.release();
      job = null;
      presence.sendState({ busy: false });
      if (!wantOnline()) presence.stop();
      changed();
    }
  }

  function hooksFor(j) {
    return {
      onStart: ({ command, preview }) => {
        const id = activity.start({ project: j.project, command, jobId: j.id, preview });
        j.current.push({ id, key: (preview ? "p:" : "c:") + command });
        audit.log({ event: "start", jobId: j.id, project: j.project, projectId: j.projectId, command, preview: !!preview, container: !!settings.container });
      },
      onEnd: ({ command, exitCode, ms, timedOut, cancelled, preview }) => {
        const at = j.current.findIndex((x) => x.key === (preview ? "p:" : "c:") + command);
        if (at >= 0) activity.end(j.current.splice(at, 1)[0].id, { exitCode, ms, timedOut, cancelled });
        audit.log({ event: "end", jobId: j.id, project: j.project, projectId: j.projectId, command, exitCode, ms, timedOut: !!timedOut, cancelled: !!cancelled, preview: !!preview });
      },
      onRefused: ({ command, rule, message }) => {
        activity.refused({ project: j.project, command, jobId: j.id, rule, message });
        audit.log({ event: "refused", jobId: j.id, project: j.project, projectId: j.projectId, command, rule, message });
      },
    };
  }

  async function runJob(j) {
    const offer = j.offer;
    // Which project is this? The offer carries the repository, not the project; the server's record of the job says.
    j.projectId = await projectIdOf(j.id);
    if (j.aborted) return;
    if (!j.projectId) { decline(j, "unknown_project"); return; }
    const verdict = await allow.check({ projectId: j.projectId, name: j.project });
    if (j.aborted) return;
    if (verdict !== "allowed") {
      decline(j, verdict === "denied" ? "project_not_allowed" : "not_asked_in_time");
      // The server stops offering a refused project once it is told which projects are left.
      if (verdict === "denied") void pushProjects();
      return;
    }
    if (power.paused) { decline(j, "paused"); return; }
    if (offer.session && offer.session.expiresAt && offer.session.expiresAt < now()) { decline(j, "ticket_expired"); return; }

    const inBox = !!settings.container;
    if (inBox) {
      const d = await dockerNow(true);
      if (!d.running) {
        decline(j, "docker_unavailable");
        if (o.notify) o.notify(d.reason || "Docker is not available, so Xode did not run. Turn off \"Run in a container\" or start Docker.");
        return;
      }
    }

    j.phase = "preparing";
    changed();
    audit.log({ event: "accepted", jobId: j.id, project: j.project, projectId: j.projectId, session: !!offer.session, container: inBox });
    const prep = await workspaces.prepare({ projectId: j.projectId, repo: offer.repo, known: j.known });
    if (j.aborted) return;
    if (!prep.ok) {
      audit.log({ event: "workspace_failed", jobId: j.id, project: j.project, message: prep.error });
      await report(j, 1, "[X0 Bot: this computer could not get the code: " + prep.error + "]");
      return;
    }

    const path = await loginPath.get();
    const env = commandEnv({ real, paths, loginPath: path, platform });
    const container = inBox ? { image: config.image || DEFAULT_IMAGE, workspace: prep.dir, cache: paths.containerCache, clientEnv: dockerClientEnv(real, path), uid: typeof process.getuid === "function" ? process.getuid() : undefined, gid: typeof process.getgid === "function" ? process.getgid() : undefined, lang: env.LANG } : null;
    if (inBox) ensureContainerCache(paths, fs);
    const spawnCommand = createSpawner({ platform, fs, spawn: child.spawn, container, pathEnv: path });
    const guard = makeContext({
      cwd: prep.dir, home: nodeOs.homedir(), runnerHome: paths.home, runnerDir: paths.home, tmpDirs: [nodeOs.tmpdir(), paths.tmp].concat(platform === "darwin" ? ["/private/tmp", "/tmp"] : ["/tmp"]),
      protectedDirs: [o.userData], protectedOk: [paths.workspaces, paths.home, paths.tmp],
    });
    j.phase = "running";
    changed();

    if (offer.session && isSessionCommands(offer.commands)) {
      const sess = createSession({
        session: offer.session, dir: prep.dir, connect: (url) => (o.connect || connectWs)(url), git, procs, spawnCommand, env, guard, known: j.known,
        name: computerName(), hooks: hooksFor(j), container: !!container, fs, platform, nodeVersion: process.version, timers, now,
        graceMs: o.graceMs, caps: o.caps, previewLimits: o.previewLimits,
      });
      j.session = sess;
      if (j.aborted) sess.stop(j.aborted.reason);
      const ended = await sess.run();
      activity.settleRunning();
      audit.log({ event: "session_ended", jobId: j.id, project: j.project, reason: ended.reason, commands: ended.commands, exitCode: ended.exitCode });
      if (j.aborted && !j.aborted.report) return;
      await report(j, j.aborted ? 1 : ended.exitCode, "[X0 Bot: live session ended (" + (j.aborted ? j.aborted.reason : ended.reason) + "); " + ended.commands + " command(s) run]");
      return;
    }

    // An ordinary step: the commands as given, with the staged edits laid over the checkout.
    if (isSessionCommands(offer.commands)) { await report(j, 1, "[X0 Bot: a live session was offered without a way into the room]"); return; }
    const hooks = hooksFor(j);
    const refused = firstRefusal(offer.commands, guard);
    if (refused) {
      hooks.onRefused(refused);
      await report(j, 126, "$ " + refused.command + "\n[X0 Bot: not run on this computer: " + refused.message + "]");
      return;
    }
    const lay = await layOverlay(prep.dir, offer.overlay, new Set(), git, fs);
    const note = lay.skipped.length ? "[X0 Bot: could not lay " + lay.skipped.slice(0, 5).join(", ") + "]\n" : "";
    const ran = await runCommands(offer.commands, offer.timeoutSec, {
      cwd: prep.dir, env, signal: j.abort.signal, procs, spawnCommand, onStart: hooks.onStart, onEnd: hooks.onEnd,
    });
    if (j.aborted && !j.aborted.report) return;
    let changes = [];
    let extra = "";
    if (ran.exitCode === 0 && !offer.discard && !j.aborted) {
      try {
        const found = await changesAgainst(offer.repo.headSha, prep.dir, git, fs);
        changes = found.changes;
        extra = skippedNote(found.skipped);
      } catch (err) {
        extra = "\n[X0 Bot: could not work out what the commands changed: " + String((err && err.message) || err).slice(0, 200) + "]";
      }
    }
    await report(j, j.aborted ? 1 : ran.exitCode, note + ran.output + extra, changes);
  }

  // ---- what the tray and the window use ----
  function status() {
    let state;
    if (!settings.enabled) state = "off";
    else if (!o.api.signedIn()) state = "signed_out";
    else if (job && job.phase !== "starting") state = "working";
    else if (power.paused) state = "paused";
    else state = presence.state === "idle" ? "connecting" : presence.state;
    return {
      enabled: settings.enabled, container: settings.container, state, pausedReason: power.paused ? power.reason : "",
      project: job && job.phase !== "starting" ? job.project : "", jobId: job ? job.id : "", deviceName: computerName(), deviceId: settings.deviceId,
      working: !!job && job.phase !== "starting",
    };
  }

  return {
    /** Start: reads the state and, if the switch is on, goes online. */
    start() {
      stopped = false;
      audit.prune();
      // Workspaces nobody has used for a month are tidied away, a minute after launch and off the main thread's busy moment.
      const tidy = timers.setTimeout(() => { workspaces.prune(30).catch(() => {}); }, o.tidyAfterMs === undefined ? 60000 : o.tidyAfterMs);
      if (tidy && tidy.unref) tidy.unref();
      sync();
    },
    status,
    on(f) { listeners.add(f); return () => listeners.delete(f); },
    /** The switch. */
    setEnabled(on) {
      settings.enabled = !!on;
      o.saveState();
      if (!on && job) abortJob(job, "turned off on this computer", true);
      sync(!!on);
    },
    /** "Run in a container". */
    setContainer(on) {
      settings.container = !!on;
      o.saveState();
      if (on) dockerNow(true).catch(() => {});
      changed();
    },
    /** The tray's Stop: end what is running and stand down until the person turns it on again. */
    stopWork() {
      if (job) abortJob(job, "stopped on this computer", true);
      settings.enabled = false;
      o.saveState();
      sync();
      if (o.notify) o.notify("Xode stopped. This computer is off for Xode until you turn it on again.");
    },
    /** A project's answer, from the window: "allow", "deny" or "ask" (forget). */
    async setProject(id, name, action) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(String(id))) return;
      if (action === "allow") allow.decide(id, name, true);
      else if (action === "deny") allow.decide(id, name, false);
      else allow.forget(id);
      await pushProjects();
      changed();
    },
    /** What the window shows. */
    async snapshot({ fetchProjects = true } = {}) {
      const known = fetchProjects ? await refreshProjects() : projects;
      const answered = new Map(allow.list().map((p) => [p.id, p]));
      const rows = [];
      for (const id of known.ids) rows.push({ id, name: known.names[id] || (answered.get(id) && answered.get(id).name) || id, state: answered.has(id) ? answered.get(id).state : "ask" });
      for (const [id, p] of answered) if (!known.ids.includes(id)) rows.push({ id, name: p.name, state: p.state });
      rows.sort((a, b) => a.name.localeCompare(b.name));
      if (settings.container && (!docker.at || now() - docker.at > DOCKER_TTL_MS)) dockerNow().catch(() => {});
      return {
        status: status(), projects: rows, activity: activity.list().slice(0, 100), power: power.state(),
        container: { on: settings.container, image: config.image || DEFAULT_IMAGE, docker: { installed: docker.installed, running: docker.running, version: docker.version, reason: docker.reason, checked: !!docker.at } },
        auditDir: paths.audit, workspacesDir: paths.workspaces,
      };
    },
    checkDocker: () => dockerNow(true),
    /** The platform said the power changed (on-ac, on-battery, resume, unlock). */
    powerEvent(name) {
      power.poke().catch(() => {});
      if (name === "resume" || name === "unlock-screen") presence.nudge();
    },
    /** The sign-in changed (a person signed in, or the session ended). */
    sessionChanged() {
      if (!o.api.signedIn()) {
        // Their answers were theirs: whoever signs in next is asked for themselves.
        if (job) abortJob(job, "signed out on this computer", false);
        allow.clear();
        settings.enabled = false;
        o.saveState();
      }
      sync();
    },
    /** Kills everything Tailzu Code started, at once, before returning: for a process that is exiting. */
    killAllSync() { try { procs.killAllSync(); } catch { /* exiting anyway */ } },
    /** The app is quitting. */
    shutdown() {
      stopped = true;
      if (job) { job.aborted = { reason: "the app closed", report: false }; if (job.session) job.session.stop("the app closed"); stopLease(job); }
      presence.stop();
      power.stop();
      try { procs.killAllSync(); } catch { /* exiting anyway */ }
    },
    /** Kill what is running if the process dies: normal exit, and an error nobody caught. */
    installProcessHooks(proc = process) {
      const kill = () => { try { procs.killAllSync(); } catch { /* exiting anyway */ } };
      proc.on("exit", kill);
      proc.on("uncaughtExceptionMonitor", kill);
    },
    // for the tests
    _internals: { presence, power, allow, audit, activity, workspaces, procs, paths, git, handleOffer, getTicket, get job() { return job; } },
    deviceId: settings.deviceId,
    auditDir: paths.audit,
  };
}

module.exports = { createRunner, repoName };
