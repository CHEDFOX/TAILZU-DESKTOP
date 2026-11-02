// What the guide says when the run stops on this side. Short, because they
// appear in a card beside a one-eyed character, and plain, because they are
// what someone reads when something did NOT happen.
//
// LABELS (desktop.agent.text.*), so the server words them and translates them;
// the words here are today's, and the fallback. TEXT reads them as they are
// now, so every line below that says TEXT.x says the server's word for it.

const knobs = require("../../../knobs.js");

function textsFrom(txt) {
  return {
    private: txt("desktop.agent.text.private", "Ask doesn't look at private windows."),
    sensitive: txt("desktop.agent.text.sensitive", "Ask doesn't look at this app."),
    declined: txt("desktop.agent.text.declined", "Okay, I left it."),
    steps: txt("desktop.agent.text.steps", "I stopped there: that was taking too many steps."),
    deadline: txt("desktop.agent.text.deadline", "I stopped there: that was taking too long."),
    yourTurn: txt("desktop.agent.text.yourTurn", "Your turn"),
    handover: txt("desktop.agent.text.handover", "Your turn: finish this part, then press Continue."),
    handoverNote: txt("desktop.agent.text.handoverNote", "I don't type passwords, codes or card details. I'll carry on when you press Continue."),
    handoverGo: txt("desktop.agent.text.handoverGo", "Continue"),
    handoverStop: txt("desktop.agent.text.handoverStop", "Stop"),
    handoverStopped: txt("desktop.agent.text.handoverStopped", "Okay, I stopped there."),
    stuck: txt("desktop.agent.text.stuck", "That didn't change anything, so I stopped."),
    loop: txt("desktop.agent.text.loop", "I was going round in circles, so I stopped."),
    blocked: txt("desktop.agent.text.blocked", "I'll stop here: I don't look at this app."),
    blockedPrivate: txt("desktop.agent.text.blockedPrivate", "I'll stop here: I don't look at private windows."),
    network: txt("desktop.agent.text.network", "Couldn't reach X0 Bot."),
    incomplete: txt("desktop.agent.text.incomplete", "The answer was cut off. Try again?"),
    failed: txt("desktop.agent.text.failed", "Something went wrong."),
    signIn: txt("desktop.agent.text.signIn", "Sign in to X0 Bot to use Ask."),
    needLook: txt("desktop.agent.text.needLook", "I'd have to see the picture to answer that, and I can't look at it here."),
    // A Mac that has not let Tailzu see the screen (Screen Recording), with a
    // button on the card to that page of System Settings (guide offer).
    needScreen: txt("desktop.agent.text.needScreen", "I'd have to see the picture to answer that, and this Mac hasn't let X0 Bot see the screen. Turn on X0 Bot in System Settings, Privacy & Security, Screen Recording."),
    looking: txt("desktop.agent.text.looking", "Looking"),
    pictureSent: txt("desktop.agent.text.pictureSent", "1 picture sent"),
    // The server's refusals, by status, when it gave no words of its own (makePost).
    status400: txt("desktop.agent.text.status400", "Ask couldn't read that request."),
    status413: txt("desktop.agent.text.status413", "There's too much on this screen to read."),
    status429: txt("desktop.agent.text.status429", "Too many asks. Try again in a moment."),
  };
}
/** Today's words: what TEXT falls back to, and what a line the server sends empty becomes. */
const TEXT_EN = textsFrom((_key, fallback) => fallback);
const TEXT = {};
for (const k of Object.keys(TEXT_EN)) {
  Object.defineProperty(TEXT, k, {
    enumerable: true,
    get() {
      let v;
      try { v = textsFrom(knobs.txt)[k]; } catch { v = undefined; }
      return typeof v === "string" && v.trim() ? v : TEXT_EN[k];
    },
  });
}

module.exports = { TEXT };
