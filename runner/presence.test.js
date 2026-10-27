// node --test
//
// Presence (presence.js) against a FAKE WORKER over real sockets: the ticket asked for every time and used once, the device ticket carried as a
// bearer header, the hello, the ack that makes the computer "online", the 30-second ping and the 90-second silence that means dead, reconnecting
// after 1, 2, 4 ... 60 seconds with a little jitter, and what is NOT retried: a computer another copy has taken, a Worker that has no live session,
// a person who is signed out.

const nodeTest = require("node:test");
// A test that waits for ever fails after a minute and a half instead of hanging the run.
const test = (name, fn) => nodeTest(name, { timeout: 90000 }, fn);
const assert = require("node:assert");
const { createPresence } = require("./presence.js");
const { connectWs } = require("./ws.js");
const { helloFrame } = require("./protocol.js");
const { startFakeCloud, fakeTimers, tick, until } = require("./testkit.js");

/** A presence wired to the fake cloud, over its real HTTP and sockets. */
function rig(cloud, o = {}) {
  const log = [];
  const statuses = [];
  const offers = [];
  const cancels = [];
  const getTicket = o.getTicket || (async () => {
    const res = await fetch(cloud.url + "/v1/code/runner/ticket", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: "laptop-0001" }) });
    if (res.status === 404) return { ok: false, reason: "live_off" };
    if (!res.ok) return { ok: false, reason: res.status === 429 ? "too_many" : "error", message: String(res.status) };
    const j = await res.json();
    return { ok: true, url: j.url, ticket: j.ticket };
  });
  const presence = createPresence({
    getTicket, connect: connectWs, hello: () => helloFrame({ deviceId: "laptop-0001", name: "Work laptop", allowRun: true, projects: "all", busy: false, app: "tailzu-desktop 1.4.0" }),
    onOffer: (x) => offers.push(x), onCancel: (j, e) => cancels.push([j, e]), onStatus: (s) => statuses.push(s.state), log: (l) => log.push(l),
    ...o.timing,
  });
  return { presence, log, statuses, offers, cancels };
}

test("it asks for a ticket, connects with it as a bearer header, says hello, and is online at the ack", async () => {
  const cloud = await startFakeCloud();
  const r = rig(cloud);
  r.presence.start();
  await cloud.deviceWaiter.until(1);
  const dev = cloud.devices[0];
  assert.strictEqual(dev.headers.authorization, "Bearer " + dev.ticket);
  assert.deepStrictEqual(cloud.api.tickets, [{ deviceId: "laptop-0001" }]);
  const hello = await dev.waitFor("hello");
  assert.deepStrictEqual(hello, { t: "hello", v: 1, deviceId: "laptop-0001", name: "Work laptop", allowRun: true, projects: "all", busy: false, app: "tailzu-desktop 1.4.0" });
  await until(() => r.presence.online, 3000, "online");
  assert.deepStrictEqual(r.statuses.filter((s, i, a) => a.indexOf(s) === i), ["connecting", "online"]);
  r.presence.stop();
  await cloud.close();
});

test("an offer and a cancel reach the app; an offer that cannot be read is declined, not run", async () => {
  const cloud = await startFakeCloud();
  const r = rig(cloud);
  r.presence.start();
  await cloud.deviceWaiter.until(1);
  const dev = cloud.devices[0];
  await until(() => r.presence.online, 3000);
  const good = cloud.sessionOffer("job-1", { offer: {} });
  dev.send({ t: "offer", offer: good });
  dev.send({ t: "cancel", jobId: "job-1", epoch: 3 });
  dev.send({ t: "offer", offer: { jobId: "job-2", stepIdx: 1, epoch: 9, commands: "not a list", repo: {} } });
  dev.send({ t: "something-from-the-future", x: 1 });
  await until(() => r.offers.length === 1 && r.cancels.length === 1, 3000);
  assert.strictEqual(r.offers[0].jobId, "job-1");
  assert.strictEqual(r.offers[0].session.ticket, good.session.ticket);
  assert.deepStrictEqual(r.cancels[0], ["job-1", 3]);
  const decline = await dev.waitFor("decline");
  assert.deepStrictEqual([decline.jobId, decline.epoch, decline.reason], ["job-2", 9, "bad_offer"]);
  assert.strictEqual(r.offers.length, 1);
  r.presence.stop();
  await cloud.close();
});

test("the keepalive is the plain text ping, every interval, and a pong keeps the socket", async () => {
  const cloud = await startFakeCloud();
  const r = rig(cloud, { timing: { pingEveryMs: 40, deadAfterMs: 400 } });
  r.presence.start();
  await cloud.deviceWaiter.until(1);
  const dev = cloud.devices[0];
  await until(() => dev.texts.filter((t) => t === "ping").length >= 3, 3000, "three pings");
  assert.strictEqual(cloud.devices.length, 1, "still the one socket");
  assert.strictEqual(r.presence.online, true);
  r.presence.stop();
  await cloud.close();
});

test("a socket that stops answering ping is taken for dead and replaced, with a new ticket", async () => {
  const cloud = await startFakeCloud();
  const r = rig(cloud, { timing: { pingEveryMs: 30, deadAfterMs: 120, baseMs: 10, maxMs: 40 } });
  r.presence.start();
  await cloud.deviceWaiter.until(1);
  const first = cloud.devices[0];
  first.autoPong = false;
  await cloud.deviceWaiter.until(2, 5000);
  assert.notStrictEqual(cloud.devices[1].ticket, first.ticket);
  assert.ok(cloud.api.tickets.length >= 2, "a ticket for every connection");
  assert.ok(r.log.some((l) => /no pong/.test(l)), r.log.join("|"));
  await until(() => r.presence.online, 3000, "online again");
  r.presence.stop();
  await cloud.close();
});

test("when the Worker closes the socket it reconnects with a NEW ticket (a ticket works once)", async () => {
  const cloud = await startFakeCloud();
  const r = rig(cloud, { timing: { baseMs: 10, maxMs: 40 } });
  r.presence.start();
  await cloud.deviceWaiter.until(1);
  cloud.devices[0].close(1012, "restarting");
  await cloud.deviceWaiter.until(2, 5000);
  await until(() => r.presence.online, 3000, "online again");
  assert.deepStrictEqual(cloud.devices.map((d) => d.ticket), ["t1.device.1", "t1.device.2"]);
  assert.strictEqual(cloud.api.tickets.length, 2);
  r.presence.stop();
  await cloud.close();
});

test("a ticket that was already used is refused with 401 replayed, and the next try gets a fresh one", async () => {
  const cloud = await startFakeCloud();
  let n = 0;
  let stale = null;
  const getTicket = async () => {
    n += 1;
    if (n === 2 && stale) return { ok: true, url: cloud.wsUrl + "/v1/devices/connect", ticket: stale };   // the first one again
    const res = await fetch(cloud.url + "/v1/code/runner/ticket", { method: "POST", body: "{}" });
    const j = await res.json();
    if (!stale) stale = j.ticket;
    return { ok: true, url: j.url, ticket: j.ticket };
  };
  const r = rig(cloud, { getTicket, timing: { baseMs: 10, maxMs: 40 } });
  r.presence.start();
  await cloud.deviceWaiter.until(1);
  cloud.devices[0].close(1012, "x");
  await until(() => r.log.some((l) => /401 replayed/.test(l)), 4000, "the replay to be refused");
  await cloud.deviceWaiter.until(2, 5000);
  r.presence.stop();
  await cloud.close();
});

test("the delays between tries are 1, 2, 4 ... 60 seconds, with a little jitter, and start over once the Worker has answered", async () => {
  const timers = fakeTimers();
  let ok = false;
  const cloud = await startFakeCloud();
  const getTicket = async () => (ok ? { ok: true, url: cloud.wsUrl + "/v1/devices/connect", ticket: "unknown" } : { ok: false, reason: "error", message: "down" });
  const r = rig(cloud, { getTicket, timing: { timers, random: () => 0.5 } });
  r.presence.start();
  for (let i = 0; i < 9; i += 1) { await tick(2); timers.fire(); }
  await tick(2);
  assert.deepStrictEqual(timers.history.slice(0, 9), [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  r.presence.stop();
  // Jitter: a fifth either way.
  for (const [random, want] of [[0, 800], [1, 1200]]) {
    const t2 = fakeTimers();
    const r2 = rig(cloud, { getTicket, timing: { timers: t2, random: () => random } });
    r2.presence.start();
    await tick(2);
    assert.strictEqual(t2.history[0], want);
    r2.presence.stop();
  }
  await cloud.close();
});

test("a Worker that refuses with 429 too_many is not tried again for at least a minute", async () => {
  const timers = fakeTimers();
  const cloud = await startFakeCloud();
  cloud.refuseNext = { status: 429, code: "too_many" };
  const r = rig(cloud, { timing: { timers, random: () => 0.5 } });
  r.presence.start();
  await tick(8);
  await until(() => timers.history.length > 0, 3000, "a retry to be scheduled");
  assert.ok(timers.history[0] >= 60000, "waited " + timers.history[0]);
  r.presence.stop();
  await cloud.close();
});

test("replaced: another copy of the app has this computer now, so it does NOT reconnect on its own", async () => {
  const cloud = await startFakeCloud();
  const r = rig(cloud, { timing: { baseMs: 10 } });
  r.presence.start();
  await cloud.deviceWaiter.until(1);
  cloud.devices[0].send({ t: "replaced" });
  cloud.devices[0].close(4000, "replaced");
  await until(() => r.presence.state === "replaced", 3000, "the replaced state");
  await new Promise((res) => setTimeout(res, 250));
  assert.strictEqual(cloud.devices.length, 1);
  assert.strictEqual(cloud.api.tickets.length, 1);
  // Starting again by hand is allowed: the person turned it off and on.
  r.presence.start();
  await cloud.deviceWaiter.until(2, 3000);
  r.presence.stop();
  await cloud.close();
});

test("live_off (the jobs are not on Cloudflare): no socket, and a look again much later; signed out: nothing until started again", async () => {
  const timers = fakeTimers();
  const cloud = await startFakeCloud({ liveOff: true });
  const r = rig(cloud, { timing: { timers, liveOffRetryMs: 900000 } });
  r.presence.start();
  await until(() => r.presence.state === "live_off", 3000, "live_off");
  assert.deepStrictEqual(timers.pending(), [900000]);
  assert.strictEqual(cloud.devices.length, 0);
  r.presence.stop();

  const signedOut = rig(cloud, { getTicket: async () => ({ ok: false, reason: "signed_out" }), timing: { timers: fakeTimers() } });
  signedOut.presence.start();
  await until(() => signedOut.presence.state === "signed_out", 3000);
  assert.strictEqual(cloud.devices.length, 0);
  signedOut.presence.stop();
  await cloud.close();
});

test("stop says bye, closes with 1000 and stays off; state frames are sent only while online", async () => {
  const cloud = await startFakeCloud();
  const r = rig(cloud);
  r.presence.sendState({ busy: true });
  r.presence.start();
  await cloud.deviceWaiter.until(1);
  const dev = cloud.devices[0];
  await until(() => r.presence.online, 3000);
  assert.strictEqual(dev.of("state").length, 0, "nothing was sent while offline");
  r.presence.sendState({ allowRun: false, busy: true });
  const st = await dev.waitFor("state");
  assert.deepStrictEqual(st, { t: "state", allowRun: false, busy: true });
  r.presence.stop();
  await dev.waitFor("bye");
  assert.strictEqual((await dev.waitClosed()).code, 1000);
  await new Promise((res) => setTimeout(res, 150));
  assert.strictEqual(cloud.devices.length, 1);
  assert.strictEqual(r.presence.state, "idle");
  await cloud.close();
});

test("waking from sleep: a socket that still answers is kept, one that does not is replaced, and a wait is cut short", async () => {
  const timers = fakeTimers();
  const cloud = await startFakeCloud();
  const r = rig(cloud, { timing: { timers, baseMs: 5, random: () => 0.5 } });
  r.presence.start();
  await cloud.deviceWaiter.until(1);
  const dev = cloud.devices[0];
  await until(() => r.presence.online, 3000);
  dev.texts.length = 0;
  r.presence.nudge();
  await until(() => dev.texts.includes("ping"), 3000, "the ping");
  await tick(3);
  assert.ok(timers.fireMs(10000), "the ten-second wait was set");
  await tick(3);
  assert.strictEqual(cloud.devices.length, 1, "it answered: kept");

  dev.autoPong = false;
  // Make "alive" go stale: the answer never comes.
  r.presence.nudge();
  await tick(3);
  assert.ok(timers.fireMs(10000));
  await tick(3);
  assert.deepStrictEqual(timers.pending(), [5], "the dead socket was dropped and a retry waits");
  timers.fire();
  await cloud.deviceWaiter.until(2, 3000);
  r.presence.stop();
  await cloud.close();
});
