// node --test
//
// Spaces' living blocks (sdui/stage.js): BotStage (his life across paints, out and back in, click and double-click, the modes,
// the veil, the trail's bubbles, his hit area), BotCrowd (grows, cheers), Vanish (stays gone), BotTiles' double-click, and the
// kit's extras the new screens lean on (autoFocus, lastError, stay, startAtEnd, a navigate that replaces). sdui/ runs on the test
// kit's small DOM (fakePage) with botTiles.js, the phone's core, as the window loads it.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { fakePage } = require("./testkit.js");

const ENGINE = fs.readFileSync(path.join(__dirname, "..", "..", "botTiles.js"), "utf8");
const HAS_ENGINE = /\bwalkTo\(/.test(ENGINE) && /function thoughtTrail/.test(ENGINE);
const needsEngine = HAS_ENGINE ? {} : { skip: "botTiles.js has not been generated from the phone's new core yet (walkTo, thoughtTrail)" };

const ROAM = { moments: ["dance", "shrug"], every: [2.4, 3.8], pause: [0.3, 0.9], span: [0.1, 0.9] };
const press = (path, v = true) => ({ kind: "setState", path, value: v });

/** Home's stage, as homeThought.ts sends it (the window's sizes), with a field in his thought. */
function homeStage(extra = {}) {
  return {
    type: "BotStage",
    props: Object.assign({
      life: "home.ask", kind: "custom", color: "#0a0a0a", size: 30, height: 184, toys: false, roam: ROAM,
      listenWhen: { eq: ["voice", "listening"] }, thinkWhen: { truthy: "asking" },
      thought: { style: "home", restText: "Ask any bot...", openPath: "askOpen", fullWhen: { truthy: "sent" }, shape: "square", veil: true, place: "follow" },
      label: "Ask any bot. Double-click him to talk.",
    }, extra),
    children: [
      { type: "Text", props: { content: "In his thought" } },
      { type: "Button", props: { label: "Inside", cls: "d-btn" }, on: { onPress: press("inside") } },
    ],
    on: { onPress: press("askOpen"), onDoubleTap: press("doubled"), onDismiss: press("dismissed") },
  };
}

/** A page with one screen on it: its root, its state; the stage laid at the window's foot. */
function screen(p, root, state, id = "bots.home") {
  p.view.rect = { left: 0, top: 600, width: 720, height: 200 };
  p.ctx.__sc = { screenId: id, look: "bots", root: { type: "Stack", children: Array.isArray(root) ? root : [root] }, state: state || {} };
  p.run("STACK = [{ screenId: __sc.screenId }]; STATE = Object.assign({}, __sc.state); repaint(__sc)");
}
const repaint = (p) => p.run("repaint()");
const stageEl = (p) => p.view.querySelector(".tz-st");
const life = (p, name = "home.ask") => p.run("ST_LIVES.get(" + JSON.stringify(name) + ")");

test("the window says it draws the new blocks, and declares the voice only with a main process that records for him", () => {
  const p = fakePage();
  const comps = p.run("capabilities().components"), acts = p.run("capabilities().actions");
  for (const c of ["BotStage", "BotCrowd", "Vanish", "MentionField", "LiveWords", "DoubleTap", "KitExtras", "VoiceLive", "DeskTalkTo"]) assert.ok(comps.includes(c), c);
  assert.ok(!comps.includes("ActionParams"), "the window fills $state params without declaring it");
  for (const a of ["voiceLive", "voiceStop"]) assert.ok(acts.includes(a), a);
  const old = fakePage({ bridge: { voice: undefined } });
  const without = old.run("capabilities().components");
  assert.ok(without.includes("BotStage") && !without.includes("VoiceLive") && !without.includes("DeskTalkTo"));
});

test("BotStage: the markup holds him, his hit area, the trail's three bubbles and the pill; never shorter than its minimum", () => {
  const p = fakePage();
  p.run("STATE = { askOpen: false }");
  p.ctx.__n = homeStage({ height: 40 });
  const html = p.run("node(__n)");
  assert.match(html, /<canvas class="tz-bt-c tz-st-c"/);
  assert.match(html, /<button type="button" class="tz-st-hit" aria-label="Ask any bot\. Double-click him to talk\.">/);
  assert.strictEqual((html.match(/class="tz-th-b"/g) || []).length, 3);
  assert.match(html, /class="tz-th-rest">Ask any bot\.\.\.</);
  assert.match(html, /data-mode="rest"/);
  assert.doesNotMatch(html, /In his thought/, "at rest the box shows only its words");
  // 30 + 18 + the trail's room (82) + 48: whatever the height says.
  assert.match(html, /class="tz-st" data-st="\d+" style="height:178px"/);
  p.ctx.__n = homeStage({ height: 40, thought: undefined });
  assert.match(p.run("node(__n)"), /style="height:48px"/, "no pill: only him");
});

test("BotStage: his life is kept across two paints (the same bot, where he was), and the modes open, full and listen", needsEngine, () => {
  const p = fakePage();
  screen(p, homeStage(), { askOpen: false, voice: "" });
  const L = life(p);
  const bot = L.bot;
  assert.ok(bot && bot.placed, "made and placed");
  p.tick(2000);
  const x = bot.crown().x;
  repaint(p);
  assert.strictEqual(life(p).bot, bot, "the same bot");
  assert.ok(Math.abs(bot.crown().x - x) < 0.01, "not put back anywhere: a repaint does not restart him");
  const box = () => stageEl(p).querySelector(".tz-th-box");
  const veil = () => stageEl(p).querySelector(".tz-th-veil");
  assert.strictEqual(box().getAttribute("data-mode"), "rest");
  assert.ok(!veil().classList.contains("on"), "no veil at rest");
  p.run("STATE.askOpen = true"); repaint(p);
  assert.strictEqual(box().getAttribute("data-mode"), "open");
  assert.ok(veil().classList.contains("on"), "the veil while open");
  assert.match(box().textContent, /In his thought/);
  assert.strictEqual(box().style.width, "360px", "a square, 360 at most");
  assert.strictEqual(box().style.width, box().style.height);
  assert.match(box().style.transition, /360ms/, "it grows from where it was");
  p.run("STATE.sent = 'Plan my Saturday'"); repaint(p);
  assert.strictEqual(box().getAttribute("data-mode"), "full", "full wins over open");
  assert.match(box().style.transition, /420ms/);
  assert.ok(veil().classList.contains("on"));
  p.run("STATE.sent = ''; STATE.askOpen = false; STATE.voice = 'listening'"); repaint(p);
  assert.strictEqual(box().getAttribute("data-mode"), "listen");
  assert.ok(!veil().classList.contains("on"), "listening has no veil");
  assert.match(box().style.transition, /380ms/, "back from near full: it follows the veil a moment later");
  p.tick(100);
  assert.strictEqual(bot.moment, "listen");
  p.run("STATE.voice = ''"); repaint(p);
  assert.strictEqual(box().getAttribute("data-mode"), "rest");
});

test("BotStage: the trail is three bubbles of 10, 17 and 26 px with 1.5, 1.75 and 2 px ink borders", needsEngine, () => {
  const p = fakePage();
  screen(p, homeStage(), { askOpen: false });
  p.tick(48);
  const b = stageEl(p).querySelectorAll(".tz-th-b");
  assert.strictEqual(b.length, 3);
  assert.deepStrictEqual(b.map((x) => x.style.width), ["10.00px", "17.00px", "26.00px"]);
  assert.deepStrictEqual(b.map((x) => x.style.borderWidth), ["1.50px", "1.75px", "2.00px"]);
  assert.ok(b.every((x) => Number(x.style.opacity) > 0.99));
});

test("BotStage: outWhen walks him out at its side, and back in when it stops", needsEngine, () => {
  const p = fakePage();
  const top = homeStage({ life: "spaces.me", outWhen: { truthy: "creating" }, outSide: "right", thought: { style: "space", openPath: "thOpen", shape: "wide", veil: true, place: "low" }, hit: "stage" });
  screen(p, top, { creating: false }, "bots.spaces");
  const bot = life(p, "spaces.me").bot;
  assert.strictEqual(bot.out(), false);
  p.run("STATE.creating = true"); repaint(p);
  assert.strictEqual(bot.exitSide, 1, "on his way out at the right");
  for (let i = 0; i < 120 && !bot.out(); i++) p.tick(250);
  assert.strictEqual(bot.out(), true, "out past the edge");
  p.run("STATE.creating = false"); repaint(p);
  for (let i = 0; i < 120 && bot.walking(); i++) p.tick(250);
  assert.strictEqual(bot.out(), false, "back in");
  assert.ok(bot.crown().x > 0 && bot.crown().x < 720, "on the stage");
  // A screen drawn with him already out (Create was open when Spaces was fetched): out at once, no walk.
  const q = fakePage();
  screen(q, top, { creating: true }, "bots.spaces");
  assert.strictEqual(q.run("ST_LIVES.get('spaces.me').bot.out()"), true);
});

test("BotStage: his low thought opening while he is out does not walk him back in", needsEngine, () => {
  const p = fakePage();
  const top = homeStage({ life: "spaces.me", outWhen: { truthy: "creating" }, outSide: "right", thought: { style: "space", openPath: "thOpen", shape: "wide", veil: true, place: "low" }, hit: "stage" });
  screen(p, top, { creating: true, thOpen: false }, "bots.spaces");
  const bot = life(p, "spaces.me").bot;
  assert.strictEqual(bot.out(), true, "out while Call Your People is open");
  p.run("STATE.thOpen = true"); repaint(p);
  for (let i = 0; i < 40; i++) p.tick(250);
  assert.strictEqual(bot.out(), true, "still out: the low walk waits for outWhen to end");
  p.run("STATE.thOpen = false"); repaint(p);
  for (let i = 0; i < 20; i++) p.tick(250);
  assert.strictEqual(bot.out(), true, "and stays out after it closes");
});

test("BotStage: a voice chat listens for all its turns (the box stays), and he thinks while a turn's words go", needsEngine, () => {
  const p = fakePage();
  screen(p, homeStage({ listenWhen: { truthy: "voice" }, thinkWhen: { eq: ["voice", "sending"] } }), { askOpen: false, voice: "listening" });
  const box = () => stageEl(p).querySelector(".tz-th-box");
  const bot = life(p).bot;
  p.tick(100);
  assert.strictEqual(box().getAttribute("data-mode"), "listen");
  assert.strictEqual(bot.moment, "listen");
  p.run("STATE.voice = 'sending'"); repaint(p);
  p.tick(100);
  assert.strictEqual(box().getAttribute("data-mode"), "listen", "no rest pill between turns");
  assert.strictEqual(bot.moment, "think", "thinking wins over listening for his pose");
  p.run("STATE.voice = 'listening'"); repaint(p);
  p.tick(100);
  assert.strictEqual(bot.moment, "listen");
});

test("BotStage: a click on him waits for a second; a double-click runs onDoubleTap alone; Enter presses", needsEngine, () => {
  const p = fakePage();
  screen(p, homeStage(), { askOpen: false });
  const hit = () => stageEl(p).querySelector(".tz-st-hit");
  hit().click({ detail: 1 });
  p.tick(200);
  assert.strictEqual(p.run("STATE.askOpen"), false, "still waiting for a second click");
  p.tick(100);
  assert.strictEqual(p.run("STATE.askOpen"), true, "a single click, after the wait");
  p.run("STATE.askOpen = false"); repaint(p);
  hit().click({ detail: 1 });
  hit().click({ detail: 2 });
  hit().dispatchEvent(new p.dom.Ev("dblclick"));
  p.tick(600);
  assert.strictEqual(p.run("STATE.doubled"), true);
  assert.strictEqual(p.run("STATE.askOpen"), false, "the single click was taken back");
  p.run("STATE.doubled = false"); repaint(p);
  hit().key("Enter");
  assert.strictEqual(p.run("STATE.askOpen"), true);
  assert.strictEqual(p.run("STATE.doubled"), false);
  // Without a double, a click is a press at once.
  const q = fakePage();
  const s = homeStage(); delete s.on.onDoubleTap;
  screen(q, s, { askOpen: false });
  q.view.querySelector(".tz-st-hit").click({ detail: 1 });
  assert.strictEqual(q.run("STATE.askOpen"), true);
});

test("BotStage: a button in his open thought never presses him; only his hit area is his, and the veil closes it", needsEngine, () => {
  const p = fakePage();
  screen(p, homeStage(), { askOpen: true });
  const st = stageEl(p);
  const inner = st.querySelector("button.d-btn");
  assert.ok(inner, "the thought's own button");
  inner.click({ detail: 1 });
  p.tick(400);
  assert.strictEqual(p.run("STATE.inside"), true, "the button ran its own action");
  assert.strictEqual(p.run("STATE.doubled"), undefined);
  // Nothing on the stage's outer elements takes a click.
  for (const el of [st, st.querySelector(".tz-st-layer"), st.querySelector(".tz-th-box")]) assert.deepStrictEqual(el.listeners.click || [], [], el.className);
  // The veil: openPath false, then onDismiss.
  stageEl(p).querySelector(".tz-th-veil").click();
  assert.strictEqual(p.run("STATE.askOpen"), false);
  assert.strictEqual(p.run("STATE.dismissed"), true);
  // Escape does the same.
  p.run("STATE.askOpen = true; STATE.dismissed = false"); repaint(p);
  assert.strictEqual(p.run("stageEscape()"), true);
  assert.strictEqual(p.run("STATE.askOpen"), false);
  assert.strictEqual(p.run("STATE.dismissed"), true);
  assert.strictEqual(p.run("stageEscape()"), false, "nothing open");
});

test("BotStage: hit \"stage\" presses from anywhere on the stage; the pill at rest opens his thought", needsEngine, () => {
  const p = fakePage();
  const top = homeStage({ life: "spaces.me", hit: "stage", thought: { style: "space", openPath: "thOpen", shape: "wide", veil: true, place: "low" } });
  top.on = { onPress: press("thOpen") };
  screen(p, top, { thOpen: false }, "bots.spaces");
  const hit = stageEl(p).querySelector(".tz-st-hit");
  assert.ok(hit.classList.contains("tz-st-all"), "the whole stage");
  hit.click({ detail: 1, clientX: 700, clientY: 610 });
  assert.strictEqual(p.run("STATE.thOpen"), true);
  const q = fakePage();
  screen(q, homeStage(), { askOpen: false });
  q.view.querySelector(".tz-th-rest").click();
  assert.strictEqual(q.run("STATE.askOpen"), true, "the pill opens it");
  assert.strictEqual(q.view.querySelector(".tz-th-box").getAttribute("data-mode"), "open");
});

test("BotStage: a space's box (no veil) opens in the stage, which grows by it; the feed above gets shorter", needsEngine, () => {
  const p = fakePage();
  const s = homeStage({ life: "space.me", thought: { style: "space", restText: "Write to everyone, or @ someone", openPath: "thOpen", shape: "wide", veil: false, place: "follow" } });
  s.on = { onPress: press("thOpen") };
  screen(p, s, { thOpen: false }, "bots.spaces");
  assert.strictEqual(stageEl(p).style.height, "184px");
  // What the box holds is 120 tall (as laid out by the window).
  p.run("STATE.thOpen = true"); repaint(p);
  const st = stageEl(p), inner = st.querySelector(".tz-th-in");
  inner.offsetHeight = 120;
  p.run("ST_MOUNTED[0].layoutBox(false)");
  const box = st.querySelector(".tz-th-box");
  assert.strictEqual(box.style.width, (720 - 32) + "px", "the stage's width less 16 a side");
  assert.strictEqual(box.style.height, "122px");
  const grown = parseFloat(st.style.height);
  assert.ok(grown > 184 && grown < 184 + 122 + 20, "the stage grew by about the box: " + grown);
  assert.ok(parseFloat(box.style.top) >= 0, "inside the stage");
  assert.strictEqual(st.querySelector(".tz-th-veil"), null);
  p.run("STATE.thOpen = false"); repaint(p);
  assert.strictEqual(stageEl(p).style.height, "184px", "back to its own height");
});

test("BotCrowd: one canvas of tiny bots on their patches; it grows to grownHeight and every bot cheers when made", needsEngine, () => {
  const p = fakePage();
  const crowd = {
    type: "BotCrowd",
    props: {
      life: "spaces.crowd", size: 22, height: 360, grownWhen: { truthy: "creating" }, grownHeight: 600, cheerWhen: { truthy: "made" },
      bots: ["plan", "travel", "notes", "code", "keybot", "custom", "make"].map((kind) => ({ kind, color: "#3E6E8E" })), label: "Tiny bots playing",
    },
    children: [{ type: "Text", props: { content: "Call Your People" } }],
  };
  screen(p, crowd, { creating: false, made: false }, "bots.spaces");
  const host = () => p.view.querySelector(".tz-cr");
  assert.strictEqual(host().style.height, "360px");
  assert.strictEqual(host().querySelectorAll("canvas").length, 1, "one canvas");
  assert.match(host().textContent, /Call Your People/, "its children over the bots");
  const L = p.run("CR_LIVES.get('spaces.crowd')");
  assert.strictEqual(L.tiles.length, 7);
  assert.ok(L.tiles.every((t) => t.placed && t.cloth === 0 && t.toys === false), "placed, no fabric, no toys");
  const floors = L.tiles.map((t) => t.floor);
  assert.ok(floors.every((f) => f > 360 * 0.45), "the bots keep the lower part of the box");
  p.run("STATE.creating = true"); repaint(p);
  assert.strictEqual(host().style.height, "600px");
  assert.match(host().style.transition, /600ms/, "it grows");
  repaint(p);
  assert.doesNotMatch(host().style.transition || "", /600ms/, "a repaint does not grow it again");
  let cheers = 0;
  L.tiles.forEach((t) => { const c = t.cheer.bind(t); t.cheer = () => { cheers++; c(); }; });
  p.run("STATE.made = true"); repaint(p);
  p.tick(1000);
  assert.strictEqual(cheers, 7, "every bot, staggered");
  p.tick(2000);
  assert.strictEqual(cheers, 14, "again");
  p.run("STATE.made = false"); repaint(p);
  p.tick(5000);
  assert.strictEqual(cheers, 14, "not while it no longer holds");
});

test("Vanish: its children vaporise when goneWhen turns true, and a repaint draws them gone without playing it again", () => {
  const p = fakePage();
  const v = { type: "Vanish", props: { key: "spaces.create", goneWhen: { truthy: "creating" } }, children: [{ type: "Text", props: { content: "Your Own Space" } }] };
  screen(p, v, { creating: false }, "bots.spaces");
  const el = () => p.view.querySelector(".tz-vn");
  assert.ok(!el().classList.contains("gone"));
  p.run("STATE.creating = true"); repaint(p);
  assert.ok(!el().classList.contains("gone"), "drawn as it was, then it goes");
  p.tick(20);
  const inner = el().querySelector(".tz-vn-in");
  assert.strictEqual(inner.style.filter, "blur(6px)");
  assert.strictEqual(inner.style.opacity, "0");
  assert.strictEqual(el().querySelectorAll(".tz-vn-speck").length, 12, "ink specks");
  p.tick(1000);
  assert.ok(el().classList.contains("gone"));
  repaint(p);
  assert.ok(el().classList.contains("gone"), "a repaint: gone at once");
  assert.strictEqual(el().querySelectorAll(".tz-vn-speck").length, 0, "nothing played again");
  p.run("STATE.creating = false"); repaint(p);
  p.tick(1000);
  assert.ok(!el().classList.contains("gone"), "back");
  // Gone at the first draw: drawn gone.
  const q = fakePage();
  screen(q, Object.assign({}, v, { props: { key: "other", goneWhen: { truthy: "creating" } } }), { creating: true }, "bots.spaces");
  assert.ok(q.view.querySelector(".tz-vn").classList.contains("gone"));
});

test("BotTiles: a double-click takes back the tile's tap (its action and its fades) and runs doubleTap", needsEngine, () => {
  const p = fakePage();
  const tiles = {
    type: "BotTiles",
    props: {
      columns: 2, height: 132, tiles: [
        { slug: "plan", name: "Plan Ease", sub: "Plans your day", color: "#8F6A1F", kind: "plan", state: "idle", action: press("opened", "plan"), doubleTap: press("chat", "plan") },
        { slug: "travel", name: "Travel bot", sub: "Plans your trips", color: "#3E6E8E", kind: "travel", state: "idle", action: press("opened", "travel") },
      ],
    },
  };
  screen(p, tiles, {});
  const [plan, travel] = p.view.querySelectorAll(".tz-bt-tile");
  plan.click({ detail: 1 });
  p.tick(100);
  assert.strictEqual(travel.querySelector(".tz-bt-w").style.opacity, "0.35", "the others fade, as for any tap");
  plan.click({ detail: 2 });
  plan.dispatchEvent(new p.dom.Ev("dblclick"));
  p.tick(3000);
  assert.strictEqual(p.run("STATE.chat"), "plan");
  assert.strictEqual(p.run("STATE.opened"), undefined, "its single action never ran");
  assert.strictEqual(travel.querySelector(".tz-bt-w").style.opacity, "1", "the fades taken back");
  // A tile with no double: its tap as ever.
  travel.click({ detail: 1 });
  p.tick(1100);
  assert.strictEqual(p.run("STATE.opened"), "travel");
});

// ---- the kit's extras (KitExtras) ------------------------------------------------------------------------------------------

test("autoFocus: a field takes the focus when a setState shows it (a repaint, not a paint), and not again on the next repaint", () => {
  const p = fakePage();
  const email = { type: "TextField", id: "email", bind: { value: "email" }, props: { placeholder: "Their email", keyboard: "email", autoFocus: true, maxLength: 200 }, visibleIf: { truthy: "creating" } };
  screen(p, [{ type: "Text", props: { content: "Spaces" } }, email], { creating: false }, "bots.spaces");
  assert.strictEqual(p.view.querySelector("input"), null);
  p.run("STATE.creating = true"); repaint(p);
  const field = p.view.querySelector("input");
  assert.strictEqual(p.document.activeElement, field, "focused when it appeared");
  assert.strictEqual(field.getAttribute("type"), "email");
  assert.strictEqual(field.getAttribute("autocapitalize"), "off");
  assert.strictEqual(field.getAttribute("maxlength"), "200");
  field.blur();
  repaint(p);
  assert.notStrictEqual(p.document.activeElement, p.view.querySelector("input"), "not again on a repaint");
  // A code field: capitals, nothing corrected; what is typed goes to state in capitals.
  p.ctx.__n = { type: "TextField", id: "code", bind: { value: "code" }, props: { placeholder: "Type a space's code", keyboard: "code" } };
  assert.match(p.run("node(__n)"), /autocapitalize="characters"[^>]*data-kb="code"/);
});

test("a failed call keeps the server's { code, message } at lastError (said.ts toasts it); stay keeps the screen; a navigate can replace", async () => {
  let answer = { ok: false, status: 409, text: async () => JSON.stringify({ code: "already_invited", message: "They're already invited." }), headers: { get: () => "application/json" } };
  const fetched = [];
  const p = fakePage({ fetch: async (url, o) => { fetched.push([url, o && o.method]); return answer; } });
  p.run("ENV = { baseUrl: 'https://api.test' }; SESSION = null");
  screen(p, { type: "Text", props: { content: "Spaces" } }, {}, "bots.spaces");
  p.ctx.__a = {
    kind: "callEndpoint", method: "POST", path: "/v1/botsapp/bots/spaces/draft/invite", body: { email: "m@x.in" },
    onError: { kind: "condition", if: { truthy: "lastError.message" }, then: { kind: "toast", message: "$state.lastError.message" }, else: { kind: "toast", message: "Couldn't invite them." } },
  };
  await p.run("run(__a)");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(p.run("STATE.lastError"))), { code: "already_invited", message: "They're already invited." });
  assert.strictEqual(p.document.getElementById("toast").textContent, "They're already invited.");
  answer = { ok: false, status: 500, text: async () => JSON.stringify({ code: "x", message: "internal detail" }), headers: { get: () => "application/json" } };
  await p.run("run(__a)");
  assert.strictEqual(p.run("STATE.lastError"), null, "never a 5xx's words");
  // stay: no fetch of the screen after the write.
  answer = { ok: true, status: 200, json: async () => ({ confirm: { line: "Send this to Mom only?" } }), headers: { get: () => "application/json" } };
  fetched.length = 0;
  p.ctx.__b = { kind: "callEndpoint", method: "POST", path: "/v1/botsapp/bots/spaces/s1/feed", body: {}, assignTo: "said", stay: true };
  await p.run("run(__b)");
  await p.settle();
  assert.deepStrictEqual(fetched.map((f) => f[0]), ["https://api.test/v1/botsapp/bots/spaces/s1/feed"], "no /v1/app/screen after it");
  assert.strictEqual(p.run("STATE.said.confirm.line"), "Send this to Mom only?");
  // navigate with replace: the top of the stack, swapped.
  p.run("STACK = [{ screenId: 'bots.home' }, { screenId: 'bots.spaces' }]; STATE.madeSpace = { id: 's9' }");
  p.ctx.__c = { kind: "navigate", screenId: "bots.spaces", params: { made: "$state.madeSpace.id" }, replace: true };
  p.run("run(__c)");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(p.run("STACK"))), [{ screenId: "bots.home" }, { screenId: "bots.spaces", params: { made: "s9" } }]);
});

test("startAtEnd: a feed opens at its end, stays there as things come in near it, and keeps the person's place further up", () => {
  const p = fakePage();
  const feed = { type: "Scroll", props: { startAtEnd: true }, children: [{ type: "Text", props: { content: "Dinner at 8?" } }] };
  screen(p, feed, {}, "bots.spaces");
  const box = () => p.view.querySelector("[data-end]");
  box().scrollHeight = 2000; box().rect = { left: 0, top: 0, width: 700, height: 500 };
  p.tick(20);
  assert.strictEqual(box().scrollTop, 2000, "at its end");
  // Near the end, a new message: still at the end.
  const near = box(); near.scrollTop = 1450;
  repaint(p);
  box().scrollHeight = 2100; box().rect = { left: 0, top: 0, width: 700, height: 500 };
  p.tick(20);
  assert.strictEqual(box().scrollTop, 2100);
  // Scrolled up: the place is kept.
  box().scrollTop = 300;
  box().dispatchEvent(new p.dom.Ev("scroll"));
  repaint(p);
  const kept = box(); kept.scrollHeight = 2200;
  p.tick(20);
  assert.notStrictEqual(kept.scrollTop, 2200, "not pulled down");
});

test("Reduce Motion: he stands still, no roam and no walk; the box is where it goes at once", needsEngine, () => {
  const p = fakePage({ reduced: true });
  const top = homeStage({ outWhen: { truthy: "creating" } });
  screen(p, top, { askOpen: false, creating: false });
  const L = life(p);
  assert.strictEqual(L.bot.still, true, "a still pose");
  const x = L.bot.crown().x;
  p.tick(3000);
  assert.strictEqual(L.bot.crown().x, x, "no roam");
  p.run("STATE.askOpen = true"); repaint(p);
  const box = stageEl(p).querySelector(".tz-th-box");
  assert.strictEqual(box.style.transition, "none", "no grow: there at once");
  assert.strictEqual(box.getAttribute("data-mode"), "open");
  p.run("STATE.askOpen = false; STATE.creating = true"); repaint(p);
  assert.strictEqual(L.bot.out(), true, "out at once, no walk");
});
