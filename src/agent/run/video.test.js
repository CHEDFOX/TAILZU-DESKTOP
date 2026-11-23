// node --test
//
// Whether a question is about something moving (video.js): words in the
// question, and a list of players for the app in front or its window's title.

const test = require("node:test");
const assert = require("node:assert");
const { wantsClip, isPlayer, PLAYERS } = require("./video.js");

test("a video noun in a question is a clip in any app; an order or a find is not", () => {
  for (const [said, app] of [
    ["what's happening in this video?", "Google Chrome"],
    ["What’s going on in this clip?", "Slack"],
    ["explain this clip", "Microsoft Edge"],
    ["what is this movie about?", "Safari"],
    ["Blip, summarise this trailer", "Firefox"],
  ]) assert.strictEqual(wantsClip(said, { app }), true, said);
  for (const [said, app] of [
    ["pause the video", "VLC"],
    ["turn on captions for this video", "Google Chrome"],
    ["where are the video settings?", "Zoom"],
    ["how do I export this video?", "iMovie"],
    ["open the clip", "Finder"],
    ["", "VLC"],
  ]) assert.strictEqual(wantsClip(said, { app }), false, said);
});

test("in a player, a question about what is seen or going on is a clip; elsewhere it is not", () => {
  for (const said of ["what is this?", "what's happening?", "what just happened?", "who is speaking?", "what song is this?", "what are they saying?"]) {
    assert.strictEqual(wantsClip(said, { app: "VLC media player" }), true, said);
    assert.strictEqual(wantsClip(said, { app: "Slack" }), false, said);
  }
  // A browser tab is a player by its title (read here only).
  assert.strictEqual(wantsClip("what's happening?", { app: "Google Chrome", title: "Lofi beats - YouTube - Google Chrome" }), true);
  assert.strictEqual(wantsClip("what's happening?", { app: "Google Chrome", title: "Inbox - Gmail" }), false);
});

test("the player list is whole words, and the server's list replaces it", () => {
  assert.strictEqual(isPlayer("Max", "", PLAYERS), true);
  assert.strictEqual(isPlayer("Maxwell's notes", "", PLAYERS), false);
  assert.strictEqual(isPlayer("Netflix", "", PLAYERS), true);
  assert.strictEqual(isPlayer("Disney+", "", PLAYERS), true);
  assert.strictEqual(isPlayer("Stremio", "", PLAYERS), false);
  assert.strictEqual(isPlayer("Stremio", "", ["Stremio"]), true);
  assert.strictEqual(wantsClip("what's happening?", { app: "Stremio", players: ["Stremio"] }), true);
  assert.strictEqual(wantsClip("what's happening?", { app: "VLC", players: [] }), false, "an empty list: words alone");
});

test("the names it answers to come off the front first", () => {
  assert.strictEqual(wantsClip("Jarvis, what just happened?", { app: "Netflix", names: ["Jarvis"] }), true);
});
