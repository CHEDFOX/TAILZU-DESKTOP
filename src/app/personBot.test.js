// node --test
//
// PersonBot (sdui/personBot.js; shared/types/sdui.ts 3j): a person as their own tiny bot, never their initials. The box and his
// stance in it, the phone's seeds, his idling (a look about, a sway, a rare gesture, never two in the window at once), the one loop
// for every bot in the window (paused out of view and while the window is hidden), a repaint that keeps each life, Reduce Motion,
// the plain circle without the core, the "@" list's rows drawn from each person's `bot`, and the Bricolage faces the window bundles.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { fakePage } = require("./testkit.js");

const MOM = { seed: "u-mom", avatar: "pip", color: "#5B7DB1" };
const ROHAN = { seed: "u-rohan", avatar: "nova", color: "#B5654A" };
const person = (look, extra = {}) => ({ type: "PersonBot", props: Object.assign({}, look, extra), style: { width: extra.size || 32, height: extra.size || 32, flexShrink: 0 } });

/** A screen of people, painted; requestAnimationFrame counted from here (every loop's frames, the PersonBots' and any other). */
function page(kids, o = {}) {
  const p = fakePage(o);
  p.run("ENV = { baseUrl: 'https://api.test' }; SESSION = null");
  p.view.rect = { left: 0, top: 0, width: 720, height: 800 };
  if (o.observer) {
    // An IntersectionObserver the test drives: what it observes, and a way to say what is in view.
    p.run("var __io = null; IntersectionObserver = function (cb) { this.cb = cb; this.els = new Set(); __io = this; }; " +
      "IntersectionObserver.prototype.observe = function (el) { this.els.add(el); }; IntersectionObserver.prototype.unobserve = function (el) { this.els.delete(el); };");
  }
  p.ctx.__sc = { screenId: "bots.spaces", look: "bots", root: { type: "Stack", children: kids }, state: {} };
  p.run("STACK = [{ screenId: 'bots.spaces', params: { id: 's1' } }]; STATE = {}; repaint(__sc)");
  p.run("var __raf = 0; var __rafWas = requestAnimationFrame; requestAnimationFrame = function (f) { __raf++; return __rafWas(f); }");
  const hosts = () => p.view.querySelectorAll(".tz-pb");
  const life = (key) => p.run("PB_LIVES.get(" + JSON.stringify(key) + ")");
  return { p, hosts, life, rafs: () => p.run("__raf") };
}

test("the window says it draws PersonBot and has Bricolage; the three faces are bundled with their licence", () => {
  const { p } = page([]);
  const caps = p.run("capabilities().components");
  assert.ok(caps.includes("PersonBot"));
  assert.ok(caps.includes("FontBricolage"));
  const html = fs.readFileSync(path.join(__dirname, "app.html"), "utf8");
  const fonts = path.join(__dirname, "../../assets/fonts");
  for (const [family, w] of [["Tailzu Bricolage", 400], ["Tailzu Bricolage Medium", 500], ["Tailzu Bricolage SemiBold", 600]]) {
    const file = "bricolage-grotesque-latin-" + w + "-normal.woff2";
    // One family per weight, as Geist's: any weight asked of it is its one file.
    assert.match(html, new RegExp('@font-face \\{ font-family:"' + family + '"; font-weight:100 900; font-display:swap; src:url\\(\\.\\./\\.\\./assets/fonts/' + file + '\\) format\\("woff2"\\); \\}'), family);
    const b = fs.readFileSync(path.join(fonts, file));
    assert.strictEqual(b.subarray(0, 4).toString("latin1"), "wOF2", file + " is a woff2");
  }
  const ofl = fs.readFileSync(path.join(fonts, "OFL.txt"), "utf8");
  assert.match(ofl, /SIL Open Font License, Version 1\.1/);
  assert.match(ofl, /Bricolage Grotesque Project Authors.*400, 500 and 600/, "the licence names the new files");
  assert.match(ofl, /PREAMBLE[\s\S]*TERMINATION/, "and its full text");
});

test("the node: a size x size box with an empty canvas, a label for a screen reader or none; the props read safely", () => {
  const { p, hosts } = page([person(MOM, { label: "Mom" }), person(ROHAN, { size: 24 })]);
  const [a, b] = hosts();
  assert.strictEqual(a.getAttribute("role"), "img");
  assert.strictEqual(a.getAttribute("aria-label"), "Mom");
  assert.strictEqual(b.getAttribute("aria-hidden"), "true", "no label: decoration beside the name");
  assert.deepStrictEqual([a.style.width, a.style.height, b.style.width, b.style.height], ["32px", "32px", "24px", "24px"]);
  assert.strictEqual(a.textContent, "", "never a letter");
  assert.ok(a.querySelector(".tz-pb-c"), "his canvas");
  const read = (v) => JSON.parse(JSON.stringify(p.run("pbRead(" + JSON.stringify(v) + ")")));
  assert.deepStrictEqual(read({ seed: "u1", avatar: "dot", color: "#6B8E4E" }), { seed: "u1", avatar: "dot", color: "#6B8E4E", size: 32, live: true, label: "" });
  assert.deepStrictEqual(read({ seed: 7, color: "red", size: 900, live: false }), { seed: "7", avatar: "", color: "#0a0a0a", size: 128, live: false, label: "" }, "a colour that is not one: ink; the size in range");
  assert.strictEqual(read({ size: 2 }).size, 12);
  assert.strictEqual(read(null).size, 32);
});

test("his seed is the phone's (FNV-1a of the person's id, then which of that person he is), and his box the phone's", () => {
  const { p } = page([]);
  // TAILZU-FRONTEND app/src/sdui/bots/personBotCore.ts seedOf, for the same ids.
  assert.deepStrictEqual(JSON.parse(p.run("JSON.stringify([pbSeed('u-mom', 0), pbSeed('u-mom', 1), pbSeed('u-rohan', 0), pbSeed('', 0), pbSeed('u-mom', 3)])")),
    [770119754, 3454720440, 3733651567, 2166136261, 2665378138]);
  assert.deepStrictEqual(JSON.parse(p.run("JSON.stringify(pbStage(32))")), { w: 48, h: 36, floor: 32, S: 24.32, boxX: 8 });
});

test("he stands in his box: feet on its floor, all of him inside it, no cloth, no toys; painted at once", () => {
  const { p, hosts, life } = page([person(MOM)]);
  const L = life("view|u-mom|0");
  const b = L.bot;
  assert.strictEqual(b.cloth, 0);
  assert.strictEqual(b.toys, false);
  assert.strictEqual(b.av.id, "pip", "the server's look from the catalog");
  assert.strictEqual(b.color, "#5B7DB1");
  const box = (bot) => {
    const xs = Array.from(bot.x.slice(0, bot.n)).map((x) => x - 8), ys = Array.from(bot.y.slice(0, bot.n));
    return { left: Math.min(...xs), right: Math.max(...xs), top: bot.crown().y, foot: Math.max(...ys) };
  };
  const at = box(b);
  assert.ok(at.foot > 30 && at.foot <= 32, "his feet on the floor: " + at.foot);
  assert.ok(at.top > 0, "his crown inside the box: " + at.top);
  assert.ok(at.left > 0 && at.right < 32, "inside it side to side: " + at.left + ".." + at.right);
  assert.ok(Math.abs(b.crown().x - 24) < 0.5, "in the middle of his world");
  const cv = hosts()[0].querySelector(".tz-pb-c");
  assert.deepStrictEqual([cv.width, cv.height, cv.style.width], [32, 32, "32px"]);
  // A minute of idling: he never leaves his box.
  for (let i = 0; i < 60; i++) {
    p.tick(1000);
    const now = box(b);
    assert.ok(now.foot <= 32.5 && now.top > -1 && now.left > -2 && now.right < 34, "still in his box at " + i + "s: " + JSON.stringify(now));
  }
});

test("he idles: his idle loop, a sway, rare gestures; two people never in step, and never two gestures within the gap", () => {
  const { p, life } = page([person(MOM), person(ROHAN), person(MOM), person({ seed: "u-anya", avatar: "bolt", color: "#6B8E4E" })]);
  p.run("var __g = []; var __pm = TailzuBotTiles.BotTile.prototype.playMoment; " +
    "TailzuBotTiles.BotTile.prototype.playMoment = function (m) { if (m && m.id !== 'person.idle') __g.push([performance.now() / 1000, m.id, this.seed]); return __pm.apply(this, arguments); }");
  const heads = () => ["view|u-mom|0", "view|u-rohan|0", "view|u-mom|1"].map((k) => life(k).bot.x[0]);
  const seen = [];
  for (let i = 0; i < 180; i++) { p.tick(1000); seen.push(heads()); }
  for (const k of ["view|u-mom|0", "view|u-rohan|0", "view|u-mom|1"]) assert.ok(life(k).idle.live, k + " lives");
  assert.ok(life("view|u-mom|0").bot.mo, "a moment on (his idle or a gesture)");
  // The same person twice is two bots: his own seed, his own sway.
  assert.notStrictEqual(life("view|u-mom|0").bot.seed, life("view|u-mom|1").bot.seed);
  const moved = (j) => Math.max(...seen.map((h) => h[j])) - Math.min(...seen.map((h) => h[j]));
  for (let j = 0; j < 3; j++) assert.ok(moved(j) > 0.2, "bot " + j + " sways: " + moved(j));
  assert.ok(seen.some((h) => Math.abs(h[0] - h[2]) > 0.05), "two of Mom never move as one");
  const g = JSON.parse(p.run("JSON.stringify(__g)"));
  assert.ok(g.length >= 4, "rare small gestures, over three minutes: " + g.length);
  assert.ok(g.every((x) => x[1] === "shrug" || x[1] === "react.look"), "the small ones: " + g.map((x) => x[1]));
  for (let i = 1; i < g.length; i++) assert.ok(g[i][0] - g[i - 1][0] >= 2.5 - 1e-6, "never two within the gap: " + (g[i][0] - g[i - 1][0]));
  // Each gesture of his own, a third of a minute or so apart (16 to 36 s between, the first after 4 to 24).
  for (const seed of new Set(g.map((x) => x[2]))) {
    const mine = g.filter((x) => x[2] === seed).map((x) => x[0]);
    for (let i = 1; i < mine.length; i++) assert.ok(mine[i] - mine[i - 1] >= 15.9, "his own gestures far apart: " + (mine[i] - mine[i - 1]));
  }
});

test("one loop for every bot in the window, at most 30 frames a second; a repaint keeps each life where it was", () => {
  const { p, hosts, life, rafs } = page([person(MOM), person(ROHAN), person({ seed: "u-anya", avatar: "bolt", color: "#6B8E4E" })]);
  p.tick(1000);
  assert.strictEqual(p.run("PB_LOOP.members.size"), 3);
  // One chain of frames, not one per bot: a second's frames are about 60 (every 16 ms), whatever the number of bots.
  assert.ok(rafs() >= 55 && rafs() <= 66, "frames asked in a second: " + rafs());
  // And at most 30 of them step and paint (the test's clock is 16 ms a frame, so every third one here; every second at 60 Hz).
  p.run("var __steps = 0; var __st = PB_LIVES.get('view|u-mom|0').idle; var __fr = __st.frame; __st.frame = function () { __steps++; return __fr.apply(this, arguments); }");
  p.tick(1000);
  assert.ok(p.run("__steps") >= 15 && p.run("__steps") <= 31, "steps in a second: " + p.run("__steps"));
  const bot = life("view|u-mom|0").bot, x = bot.x[0];
  const before = hosts()[0];
  p.run("__repaint = repaint; repaint(__sc)");
  assert.notStrictEqual(hosts()[0], before, "the markup is new");
  assert.strictEqual(life("view|u-mom|0").bot, bot, "the same bot");
  assert.strictEqual(bot.x[0], x, "where he was");
  assert.strictEqual(p.run("PB_LOOP.members.size"), 3, "the old boxes left the loop, the new ones are on it");
  assert.ok(p.run("[...PB_LOOP.members].every((m) => m.host.isConnected)"));
  // A screen without them: the loop stops by itself.
  p.ctx.__sc2 = { screenId: "bots.home", look: "bots", root: { type: "Stack", children: [] }, state: {} };
  p.run("repaint(__sc2)");
  p.tick(100);
  assert.strictEqual(p.run("PB_LOOP.members.size"), 0);
  assert.strictEqual(p.run("PB_LOOP.raf"), 0, "no frame asked");
});

test("out of view a bot waits, and with none in view, or the window hidden, the loop stops; back in view it goes on", () => {
  const { p, hosts, life } = page([person(MOM), person(ROHAN)], { observer: true });
  p.tick(500);
  assert.strictEqual(p.run("__io.els.size"), 2, "one observer watches them all");
  const say = (i, inView) => { p.ctx.__el = hosts()[i]; p.run("__io.cb([{ target: __el, isIntersecting: " + inView + " }])"); };
  say(0, false);
  const mom = life("view|u-mom|0").idle, rohan = life("view|u-rohan|0").idle;
  p.run("var __n = [0, 0]; [PB_LIVES.get('view|u-mom|0').idle, PB_LIVES.get('view|u-rohan|0').idle].forEach((d, i) => { const f = d.frame; d.frame = function () { __n[i]++; return f.apply(this, arguments); }; })");
  p.tick(1000);
  const n1 = JSON.parse(p.run("JSON.stringify(__n)"));
  assert.strictEqual(n1[0], 0, "Mom, out of view, waits");
  assert.ok(n1[1] > 10, "Rohan, in view, goes on");
  say(1, false);
  p.tick(100);
  assert.strictEqual(p.run("PB_LOOP.raf"), 0, "none in view: no frames");
  say(0, true);
  p.tick(1000);
  assert.ok(JSON.parse(p.run("JSON.stringify(__n)"))[0] > 10, "back in view, he goes on");
  // The window hidden: nothing; shown again (visibilitychange): on again.
  p.document.hidden = true;
  p.tick(100);
  assert.strictEqual(p.run("PB_LOOP.raf"), 0);
  p.document.hidden = false;
  (p.document.listeners.visibilitychange || []).forEach((f) => f());
  assert.notStrictEqual(p.run("PB_LOOP.raf"), 0);
  assert.ok(mom.live && rohan.live);
});

test("Reduce Motion, or live false: his standing pose, still, painted once and never on the loop", () => {
  for (const [kids, o] of [[[person(MOM)], { reduced: true }], [[person(MOM, { live: false })], {}]]) {
    const { p, life } = page(kids, o);
    const L = life("view|u-mom|0");
    assert.strictEqual(L.idle.live, false);
    assert.strictEqual(p.run("PB_LOOP.members.size"), 0);
    const x = Array.from(L.bot.x.slice(0, L.bot.n));
    p.tick(5000);
    assert.deepStrictEqual(Array.from(L.bot.x.slice(0, L.bot.n)), x, "not a particle moved");
    assert.ok(Math.abs(L.bot.crown().x - 24) < 0.5, "on his spot");
  }
});

test("without the bots' engine: a plain circle in his colour, no letter", () => {
  const p = fakePage({ files: ["knobs.js", "sdui.js"] });
  p.ctx.__n = person(MOM, { label: "Mom" });
  const html = p.run("node(__n)");
  assert.match(html, /^<span class="tz-pb" role="img" aria-label="Mom" style="[^"]*width:32px;height:32px;border-radius:50%;background:#5B7DB1"><\/span>$/);
});

test("the \"@\" list: each person their own tiny bot from the row's `bot`, a plain circle without one; never a letter", () => {
  const p = fakePage();
  p.run("ENV = { baseUrl: 'https://api.test' }; SESSION = null");
  p.view.rect = { left: 0, top: 0, width: 720, height: 800 };
  const people = [{ id: "u-mom", name: "Mom", bot: MOM }, { id: "u-rohan", name: "Rohan Sharma", bot: ROHAN }, { id: "u-old", name: "Old Friend" }];
  p.ctx.__sc = {
    screenId: "bots.spaces", look: "bots", state: { draft: {} },
    root: { type: "Stack", children: [{ type: "MentionField", props: { life: "space.compose.s1", placeholder: "Write", draftPath: "draft", people, bots: [], thingsPath: "/x/:bot", words: { people: "People in this space", bots: "Share", empty: "Nobody" } } }] },
  };
  p.run("STACK = [{ screenId: 'bots.spaces', params: {} }]; STATE = { draft: {} }; repaint(__sc)");
  const input = p.view.querySelector(".tz-mf-in");
  input.focus();
  input.type("@");
  const list = p.document.body.querySelector(".tz-mf-pop");
  const rows = list.querySelectorAll(".tz-mf-person");
  assert.deepStrictEqual(rows.map((r) => r.textContent), ["Mom", "Rohan Sharma", "Old Friend"], "their names, and nothing else");
  const bot = rows[0].querySelector(".tz-pb");
  assert.ok(bot && bot.querySelector(".tz-pb-c"), "Mom's own tiny bot");
  assert.deepStrictEqual([bot.style.width, bot.style.height], ["28px", "28px"], "28 in a row");
  assert.ok(p.run("PB_LIVES.has('mention|u-mom|0')"), "a life of the list's own, apart from the screen's");
  assert.strictEqual(p.run("PB_LIVES.get('mention|u-mom|0').bot.av.id"), "pip");
  const dot = rows[2].querySelector(".tz-mf-av");
  assert.ok(dot && !rows[2].querySelector(".tz-pb"), "no look: a plain circle");
  assert.strictEqual(dot.textContent, "");
  assert.match(dot.style.background, /^#[0-9A-F]{6}$/i);
  // He lives on the window's one loop while the list is up; filtered, the same life is drawn again; closed, he leaves it.
  p.tick(1000);
  assert.strictEqual(p.run("PB_LOOP.members.size"), 2);
  const life = p.run("PB_LIVES.get('mention|u-mom|0')");
  input.type("m");
  assert.strictEqual(list.querySelectorAll(".tz-pb").length, 1, "only Mom");
  assert.strictEqual(p.run("PB_LIVES.get('mention|u-mom|0')"), life, "the same bot, where he was");
  input.key("Escape");
  p.tick(100);
  assert.strictEqual(p.run("PB_LOOP.members.size"), 0, "the list gone, so is he from the loop");
});
