// node --test
//
// The permission card over the app (sdui/permCard.js): one permission, asked for at the moment it was missed, with the page
// behind it blurred. What is held here: it goes up only for a thing this window can read and the computer has refused; the
// microphone and the camera are asked of the system first and its settings page only once the system will not ask again; the
// Mac's two open their page at once; it closes itself when the answer turns yes while the person is away in System Settings;
// one at a time, and Escape closes it.
const test = require("node:test");
const assert = require("node:assert");
const { fakePage } = require("./testkit.js");

/** A window whose computer answers as `st` says, and whose microphone and camera open (or refuse) as `media` says. */
function win(st = {}, media) {
  const acts = [];
  const p = fakePage({
    bridge: {
      micStatus: async () => st.mic || "denied",
      camStatus: async () => st.cam || "denied",
      axStatus: async () => st.ax || "denied",
      seeStatus: async () => st.see || "denied",
      // As the preload hands it over.
      askSetupAction: (kind, on) => acts.push({ kind: String(kind || ""), on: typeof on === "boolean" ? on : null }),
    },
  });
  p.g.navigator.mediaDevices = {
    getUserMedia: media || (async () => { throw Object.assign(new Error("no"), { name: "NotAllowedError" }); }),
  };
  p.acts = acts;
  p.card = () => p.document.querySelector(".tz-pc-veil");
  p.text = () => {
    const c = p.card();
    return c ? c.textContent.replace(/\s+/g, " ").trim() : "";
  };
  p.press = (cls) => p.card().querySelector(cls).dispatchEvent(new p.dom.Ev("click"));
  p.need = async (kind) => { p.ctx.__k = kind; const r = await p.run("permNeed(__k)"); await p.settle(); return r; };
  return p;
}

test("the card goes up for the one thing that was missed, and its button opens that page", async () => {
  const p = win();
  await p.need("ax");
  assert.ok(p.card(), "a card");
  assert.match(p.text(), /Let me type for you/);
  assert.match(p.text(), /Accessibility/);
  assert.match(p.text(), /Open Settings/);
  assert.match(p.text(), /Not now/);
  // The Mac grants this one in System Settings and nowhere else, so the button goes straight there.
  p.press(".tz-pc-go");
  assert.deepStrictEqual(p.acts, [{ kind: "openAccessibility", on: null }]);
  // Ask's look is the other one. On a page of its own: the card's buttons drop
  // a second press inside the moment of a double-click, and a test presses
  // two cards in the same millisecond.
  const q = win();
  await q.need("see");
  assert.match(q.text(), /Let me see your screen/);
  q.press(".tz-pc-go");
  assert.deepStrictEqual(q.acts, [{ kind: "openScreenRecording", on: null }]);
});

test("nothing goes up when it is already allowed, when this window cannot read it, or when nobody is looking", async () => {
  const yes = win({ ax: "granted" });
  assert.strictEqual(await yes.need("ax"), false);
  assert.strictEqual(yes.card(), null);
  // A system that keeps no such answer is nothing to ask for.
  const none = win({ ax: "unknown" });
  assert.strictEqual(await none.need("ax"), false);
  // A main process too old to answer at all.
  const old = fakePage();
  old.ctx.__k = "ax";
  assert.strictEqual(await old.run("permNeed(__k)"), false);
  // The window is not on screen: the main process keeps its notification for that.
  const away = win();
  away.document.hidden = true;
  assert.strictEqual(await away.need("ax"), false);
  assert.strictEqual(away.card(), null);
  // And a kind nobody knows.
  const p = win();
  assert.strictEqual(await p.need("fingerprint"), false);
});

test("the microphone is asked of the system first; its settings page only once the system will not ask again", async () => {
  const p = win();
  await p.need("mic");
  assert.match(p.text(), /Let me hear you/);
  assert.match(p.text(), /Allow/);
  // The first press is the system's own prompt. Refused, the button becomes the page, and says why.
  p.press(".tz-pc-go");
  await p.settle();
  assert.deepStrictEqual(p.acts, [], "no page opened on the first press");
  assert.match(p.text(), /Open Settings/);
  assert.match(p.text(), /Your computer is holding this one/);
  p.press(".tz-pc-go");
  await p.settle();
  assert.deepStrictEqual(p.acts, [{ kind: "openMicrophone", on: null }]);
});

test("allowed at the system's prompt, the card says so and goes", async () => {
  const opened = [];
  const stream = { getTracks: () => [{ stop() { opened.push("stopped"); } }] };
  const p = win({ cam: "denied" }, async () => { opened.push("asked"); return stream; });
  await p.need("cam");
  assert.match(p.text(), /Let me use the camera/);
  p.press(".tz-pc-go");
  await p.settle();
  assert.deepStrictEqual(opened, ["asked", "stopped"], "opened once and shut at once");
  assert.match(p.text(), /That’s it/);
  assert.deepStrictEqual(p.acts, [], "nothing was opened in Settings");
  p.tick(1200);
  assert.strictEqual(p.card(), null);
});

test("it closes itself when the answer turns yes while they are away in System Settings", async () => {
  const st = { see: "denied" };
  const p = win(st);
  await p.need("see");
  assert.ok(p.card());
  // A second passes with it still off: the card stays.
  p.tick(1000);
  await p.settle();
  assert.ok(p.card());
  st.see = "granted";
  p.tick(1000);
  await p.settle();
  assert.match(p.text(), /That’s it/);
  p.tick(1200);
  assert.strictEqual(p.card(), null);
});

test("one card at a time; Not now and Escape close it", async () => {
  const p = win();
  await p.need("ax");
  assert.strictEqual(await p.need("see"), false, "the second ask waits");
  assert.strictEqual(p.document.querySelectorAll(".tz-pc-veil").length, 1);
  p.press(".tz-pc-no");
  p.tick(400);
  assert.strictEqual(p.card(), null);
  await p.need("mic");
  assert.ok(p.card());
  p.document.body.dispatchEvent(new p.dom.Ev("keydown", { key: "Escape" }));
  p.tick(400);
  assert.strictEqual(p.card(), null);
  // Closed, the next one can be asked for.
  assert.strictEqual(await p.need("mic"), true);
});

test("a row refused for good puts the card up, and not the page's own line as well", async () => {
  const p = win();
  p.run("STATE = {}; CURRENT_SCREEN = { state: {}, root: { type: 'Stack' } }; CURRENT_ACTIONS = {}");
  p.ctx.__a = {
    kind: "requestPermission", permission: "microphone",
    onGranted: { kind: "setState", path: "flag", value: "granted" },
    onDenied: { kind: "setState", path: "flag", value: "denied" },
    onBlocked: { kind: "setState", path: "flag", value: "blocked" },
  };
  await p.run("run(__a)");
  await p.settle();
  assert.ok(p.card(), "the card says where the switch is");
  assert.strictEqual(p.run("STATE.flag"), undefined, "so the page does not say it again");
  // A window that cannot put the card up still gets the page's line.
  const bare = win();
  bare.document.hidden = true;
  bare.run("STATE = {}; CURRENT_SCREEN = { state: {}, root: { type: 'Stack' } }; CURRENT_ACTIONS = {}");
  bare.ctx.__a = p.ctx.__a;
  await bare.run("run(__a)");
  await bare.settle();
  assert.strictEqual(bare.card(), null);
  assert.strictEqual(bare.run("STATE.flag"), "blocked");
});
