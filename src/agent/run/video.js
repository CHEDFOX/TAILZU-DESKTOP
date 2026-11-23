// A question about something MOVING: a video playing in the window, answered
// from a few seconds of it rather than one still picture.
//
// "What's happening in this video?", "explain this clip", or "what's this?"
// said over VLC while it plays: one picture is a single frame of something
// that is about what changes, and its sound is half of it. So the run records
// the window for desktop.agent.videoSeconds (6) instead, with the computer's
// own sound where this platform lets it be heard (never the microphone), and
// sends that as the step's one clip. Everything else about it is the
// picture's: the same per-app say-so, the same card, never a sensitive app;
// and stricter in one way, never a private window at all (agent.js
// allowedClip).
//
// Deciding is kept to words and a list, so it can be read and argued with:
//
//   a video noun   "video", "clip", "movie", "trailer"… in a question (show
//                  mode): a clip, whatever the app. A browser playing a
//                  video is a browser; its question says what is in it.
//   a player       the app in front, or its window's title, names one of
//                  desktop.agent.videoApps (VLC, QuickTime Player, YouTube,
//                  Netflix…): then a question about what is seen ("what's
//                  this?", "explain this", isVisualQuestion), or about what
//                  is going on ("what's happening?", "what just happened?",
//                  "who's speaking?", "what song is this?") is one too.
//                  The title is read here only and never leaves, as ever.
//
// Never for an order ("pause the video", "turn on captions"), nor for finding
// or doing something ("where's the video settings?", "how do I export this
// video?"): those are about controls, and the tree answers them.

const resolver = require("../resolver.js");
const { str, squash } = require("./helpers.js");

/** What a moving thing is called: said in a question, the question is about one. */
const VIDEO_NOUN = /\b(?:videos?|clips?|movies?|films?|footage|trailers?|reels?|livestreams?|live ?streams?|gifs?|animations?|cartoons?|episodes?|vlogs?)\b/;

/** A question about what goes on over time. Only in a player: in a chat,
 *  "what's happening in this thread?" is a question about words. */
const MOTION = /\b(?:what(?:'s| is| was|s) (?:happening|going on|playing)|what (?:just )?happened|what(?:'s| is) (?:he|she|it|they) doing|what are (?:they|these|those|people) doing|watch (?:this|that|it)|who(?:'s| is| are) (?:speaking|talking|singing|playing)|what (?:are|is|did) (?:they|he|she) (?:saying|say|singing)|what (?:song|music|language) is (?:this|that|playing))\b/;

/** The players a question is about by default. The server's list
 *  (desktop.agent.videoApps) replaces it. Whole words, any case. */
const PLAYERS = [
  "VLC", "QuickTime Player", "IINA", "mpv", "Infuse", "Elmedia", "Movist", "Media Player", "Movies & TV", "Films & TV",
  "Windows Media Player", "PotPlayer", "MPC-HC", "MPC-BE", "KMPlayer", "GOM Player", "SMPlayer", "Kodi", "Plex",
  "YouTube", "Netflix", "Prime Video", "Disney+", "Hulu", "Max", "Twitch", "Vimeo", "TikTok", "Dailymotion",
];

/** Asked of what plays, without a question mark: "summarise this trailer". */
const ABOUT = /^(?:describe|explain|summari[sz]e|analy[sz]e|interpret|break down|walk me through|go through|transcribe|translate|identify|tell me about)\b/;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `app` or `title` names one of `players`: a whole word or phrase of
 *  it, so "Max" is the player and "Maxwell's notes" is not. */
function isPlayer(app, title, players) {
  const list = (Array.isArray(players) ? players : PLAYERS).map((p) => squash(p)).filter(Boolean);
  if (!list.length) return false;
  const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${list.map(escapeRe).join("|")})(?=$|[^\\p{L}\\p{N}])`, "iu");
  return [app, title].some((s) => re.test(squash(s)));
}

/**
 * True when what they said, in this app, asks about something moving.
 * @param {string} text  their words (the stream's final caption)
 * @param {{ app?: string, title?: string, players?: string[], names?: string[] }} [o]
 *        `title`, the window's own, is only ever read here
 */
function wantsClip(text, o = {}) {
  const said = str(text);
  if (!said.trim()) return false;
  const names = Array.isArray(o.names) ? o.names : resolver.NAMES;
  const clean = resolver.commandText(said, names);
  if (!clean) return false;
  // A clip only ever answers: an order goes the usual way, and so does a
  // question about finding a control or how to do something.
  if (resolver.modeOf(said, names) !== "show" && !ABOUT.test(clean)) return false;
  if (resolver.FIND_OR_ACT.test(clean) || resolver.HOW_TO_DO.test(clean)) return false;
  if (VIDEO_NOUN.test(clean)) return true;
  if (!isPlayer(o.app, o.title, o.players)) return false;
  return MOTION.test(clean) || resolver.isVisualQuestion(said, names);
}

module.exports = { wantsClip, isPlayer, PLAYERS };
