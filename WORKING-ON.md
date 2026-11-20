# Being built right now (read before you start)

## 20 Nov: LINGO — PICKING A LANGUAGE NOW GIVES YOU A LESSON

**The fault.** Pick a language and you got nothing to learn, for ever. Not a thin course — nothing. The path (24
units, `course.ts`) and the thing that writes a unit for a pair of languages (`lessons.ts`, 17 Nov) were both built,
tested and on main. They were simply never reached: `walk()` is the only thing that walks the path, `walk()` only
runs inside `POST /v1/lingo/session`, and the territory card would not open the set screen while a course had no
words in it — it offered **"Start by talking"** instead. So the one screen that builds the first unit was the one
screen the card refused to open. No words, so no lesson; no lesson, so no words.

That card rule was right when it was written, before the path existed and an empty course really did have nothing to
ask. `c252e11` added the path and touched 16 files; `lingoPage.ts` was not one of them. `tests/lingo-screens.test.ts`
pinned the old behaviour, and `lingo-walkthrough` missed it by calling `POST /session` directly instead of going
through a screen — so nothing was red.

**What it does now.** `PUT /v1/lingo/course` starts the first unit for a NEW course and does not wait for it, and the
answer to "what's it for?" navigates straight into the first exercise rather than back to a card with another button
on it. Three things that had to be true together:

- **One build in the air per pair and unit** (`makingUnit`, `unitFor`). The course that starts it and the lesson
  screen a second behind it are the same person, and each starting their own would pay twice for one unit. The claim
  is made in the **same tick** as the call — an `await` before it is a gap in which the next caller sees nothing
  running and starts a second build. `unitFor` is deliberately not `async` for that reason, and it hands back the
  tracked promise so the claim is let go of before anybody has their answer.
- **A session never blocks on a model call.** `walk()` asks whether the unit is being made and says so instead of
  waiting: `{ exercises: [], building: true }`.
- **A third empty on the set screen**, and the only one that ends by itself: **"Getting your first lesson ready"**.
  "Nothing due" would say they were finished and "Nothing to learn yet" would send them off to chat for no reason —
  both wrong for the ten seconds that matter most, which are somebody's first ten.
- **That screen has no button and nothing to read.** There is nothing to decide, a button meaning "ask again" makes
  somebody who is already waiting do the waiting's work, and the explanation of our model call is ours to carry.
  Lingo mutters over it (`l.mutter`) and it **ends by itself**: the page listens on `lingo:<tag>` (a new topic in
  `src/live/topics.ts`), the server publishes when the unit settles, and the open screen reloads into the first
  exercise where he stands. Published **whichever way it went** — a screen with nothing to press must never wait on
  a message that is not coming, so a unit that could not be written reloads into a fresh attempt and then the honest
  empty. Named while it waits and at no other moment: a live event mid-set would pull the question out from under
  somebody. No new client primitive was needed; `liveTopics` has been in both renderers all along.

A failed or thin unit is still kept nowhere (`ENOUGH`), and a pair whose first attempt failed stops looking busy, so
the next person gets a fresh attempt rather than a screen that waits for ever. Changing a level or the minutes a day
on a course somebody is already on spends no call.

`lingo-routes.test.ts` now passes `lessons: null` in its shared server, so the suite stops reaching for a real model
(those 401s were pre-existing noise from the session route). Four new cases: the first lesson over the real routes
mid-build and after, no second call per setting change, one build for two simultaneous arrivals, and a failed attempt
tried again. **12,677 pass.** The one failure is `launch-motion`'s side-by-side case, pre-existing and checked by
stashing. `docs/lingo.md` has a section on the path at last (9c) — it had none, since `c252e11` did not write one.

**Still true and not this:** the sentence bank is unseeded, which now matters less than it did — the first day is the
path's, not the spine's. Lingo is still behind `LINGO`, off.

## 17 Nov: THE SIGN-IN CARD HAS A SWITCH NOW, SO IT CAN BE UNDONE FROM HERE

`SIGN_IN_CARD`, **off**, staged by `SIGN_IN_CARD_USERS`. It was shipped without one, and that was the thing wrong with
publishing it: **everything the card draws lives in the window's own page** (`guide.html`), which only a new build can
change. A card that came out wrong would have needed a release to undo.

Off, three things happen: the planner is not told the card's rules (so they are not paid for either), any `FIELD` or
`ALSO` it writes anyway is dropped and counted in `cardDropped`, and the handover carries no card — the plain one, the
page itself, which always works. **Both gates, not one**: the two verbs are in the contract whatever the prompt says, so
a model that writes them anyway is stopped at the reader and not only by the note.

It took a `userId` down to the prompt (`StepContext.userId` → `agentUserMessage`) so the stage can be per account, which
is how every other new thing here is turned on. Two cases in `tests/agent-signin.test.ts` hold the default: off, a
handover carries no card and the rules are not in the prompt.

**So the card is now safe to publish**: ship the build with it off, turn it on for one account, look at it, then widen.
The words were already knobs (`desktop.agent.text.*`); this makes the whole feature one too.

12,466 pass. The two failures are both pre-existing and were checked by stashing: `launch-motion`'s side-by-side case,
and `code-routes`' hook timing out as it boots the real server, which fails the same way with this work removed.

## 17 Nov: THE SIGN-IN CARD IS WHOLE — boxes, ways in, and a way out to our own browser

**The boxes.** The card draws the page's real fields, named in the person's own language. A secret and a code are hidden
as typed (rule S5), `autocomplete="off"` so the browser is never asked to treat our card as the site's page, and nothing
is remembered: the values live in the inputs, cross once on Continue, and go with the card.

**The one moment the window takes the keyboard.** It is never focusable otherwise, and that flag is load-bearing — the
app being worked on keeps the keyboard, and a dictation's paste must land in it. So `ask.js` turns it on while a card
with boxes is up and off again in a **`finally`**, where a thrown or cancelled card cannot leave the window able to
steal the next keystroke.

**Then the app first, the boxes after.** On Continue the agent gives the keyboard back to the app they were in before
setting anything, because a field cannot be set in an app that is behind. Each box is set by the id the CARD named, so a
value for an id it did not name is ignored. **What they typed is not logged and never enters the run's history** — the
log says which box was filled, never what went in it, and a test holds that a password and an address appear nowhere in
what is sent.

**And a way out of all of it:** a sign-in handover offers **"Sign in in X0 Bot's browser"**, which opens the Sites list —
the same flow the phone uses. They sign in on a real page in our own browser, which keeps the session; the card stays up
and they press Continue when they are in. It opens the LIST, not a panel at a guessed address, because the window knows
the site in front only by its display name ("Swiggy") and never its domain — `https://Swiggy/` is not a page.

Three more cases in `agent.test.js` (the fill order and that nothing typed is sent; the browser button offered on a
sign-in and keeping the card up; a card's boxes carried with their kinds). **1,565 of 1,566.**

**Still no test for the card's own drawing**, and that is the standing risk here: `src/agent/guide/` has none and
`node --test` has no DOM. **`guide.html?demo=signIn`** now draws the whole thing still — two boxes, three ways in, the
browser button, Continue and Stop — and that is the only way to see it.

## 17 Nov: THE WAYS IN WERE BROKEN THREE WAYS, AND THE GUIDE'S RENDERER HAS NO TESTS

Reported here as done. It was not. Three separate faults, each in a layer the tests do not reach, found by reading the
path end to end:

1. **The buttons were never drawn.** `guide/messages.js` looked up a card's buttons by the ids `approve`, `edit` and
   `deny` only, mapping them onto the three `<button>`s in `guide.html`. Nothing created more, so a `way:e9` button did
   not exist on the screen.
2. **Its id could not get back.** `preload.js` and `guide:confirm` each did `yes === "edit" || yes === "deny" ? yes :
   !!yes`, so an id arrived as `true` — which `approve`'s own `pick` reads as the MAIN button. Pressing "Continue with
   Google" would have ENDED the handover.
3. **The cap was three.** `approve()` sliced the buttons to three, so even drawn and answerable, the fourth way in was
   dropped.

Fixed: `messages.js` builds a row of the page's own ways per card (`setWays`, up to four, wrapping); the id is let
through both halves and **matched against the buttons the card was actually sent** (`ask.js cardButtons`), so a renderer
cannot invent an answer and an unknown id is no answer rather than the main button; the cap is six.

**THE REAL FINDING: `src/agent/guide/` has no tests at all.** Not one file. Everything above it stubs the guide
(`agent.test.js` replaces `guide.approve` wholesale), so three faults in a row survived a 1,564-test suite. There is no
DOM in `node --test` either, so a test would mean a new dependency in a shipping Electron app — not something to add in
passing.

What there is instead is the project's own answer, now pointed at this: **`guide.html?demo=signIn`** draws the sign-in
card still, ways in and all. Anything changed in that renderer should be looked at through a demo scene, because
nothing else will catch it.

## 17 Nov: A BUG IN THE WAYS IN, FOUND BY READING THE PATH RATHER THAN THE TEST

Worth writing down, because the test passed and the app could not have worked.

The ways-in buttons send a button id (`way:e9`). Both halves of the card's answer path **coerced every string to a
boolean**: `preload.js`'s `confirm` and `guide:confirm` in `ask.js` each did `yes === "edit" || yes === "deny" ? yes :
!!yes`. So `"way:e9"` arrived as `true`, which `approve`'s own `pick` reads as the MAIN button — pressing "Continue with
Google" would have ended the handover instead of starting the way in. The tests in `agent.test.js` passed because they
stub `guide.approve` and never cross that hop.

Fixed in both, and with a guard rather than just a wider filter: `approve()` now remembers the ids of the buttons it sent
(`cardButtons`), and `guide:confirm` accepts an id **only if it is one of them**. So a renderer cannot invent an answer,
and an id that is not on the card is no answer at all rather than being read as the main button. The card's button cap
went 3 → 6, because a sign-in card draws up to four ways in beside Continue and Stop.

`src/agent/ask.test.js` holds the dangerous direction with the real path (`h.ipc.emit("guide:confirm", …)`): an invented
id does not act and above all does not read as Approve, and the real answer still works. 1,563 of 1,564.

**The lesson, since this is the second time this session:** a stub that stands in for the thing being changed will pass
whatever you do to the thing. The ways-in work needed a test that crossed the IPC, and the open `part` work needed one
that went through the real checker — which it has.

## 17 Nov: THE SIGN-IN CARD'S WAYS IN ARE DRAWN IN THE WINDOW (`docs/sign-in.md`)

The server has been able to describe a sign-in page's real boxes and ways in since 15 Nov (`FIELD` / `ALSO` before a
`HANDOVER`, nothing written per site, every id checked against the screen list). Nothing drew them, so every one of those
lines ended in a plain handover. **Half of it draws now: the ways in.**

Each `ALSO` is a button on the handover card, and pressing it presses that control on the page
(`TAILZU-DESKTOP/src/agent/run/agent.js` `handover`, `waysOf`). Pressing one does **not** finish the handover — starting
a way in is the beginning of their part, not the end — so the card comes back and waits, and only Continue or Stop ends
it. A press that fails is logged and the card still comes back, because the page is theirs to finish either way. At most
four, no repeat, nothing without both an id and a label: the window keeps its own cap rather than trusting the server's.

Why this half first: rule S3 exists because people rarely remember WHICH way they signed up with, and a page's own
buttons are often below the fold or behind "more options". And it needed no decision about anything.
Three cases in `src/agent/run/agent.test.js`; the desktop suite is 1,562 of 1,563.

**The BOXES are still not drawn, and that is a decision, not an omission.** The guide's window is deliberately never
focused — the app being worked on keeps the keyboard, and a dictation's paste must still land in it — so it cannot take a
keystroke, let alone a password. Three ways out, none of them picked: make the window focusable for that one moment and
hand focus back; a separate window that may take the keyboard; or the cloud browser's panel in a `LiveView`, which both
clients already have and which never holds the secret itself (each character goes to the real page, and the box is
emptied before the call goes out). Until one is chosen, every `FIELD` line still ends in a correct plain handover.

## 17 Nov: ONE KEY, ALREADY IN A MEETING — the bot goes in (`docs/meet.md` 4a)

`POST /v1/meet/now { url? }`. Auto-join is the plan made in advance (meetings 11 to 45 minutes away); this is the case a
person actually asks for — they are IN a meeting, they say "take notes", and the bot has to go now. `/join` wants a link
pasted into a box, which is no use to somebody who pressed a key mid-meeting.

Three ways, cheapest first: a `url` the caller already has (the window can SEE the screen, so a link read off the meeting
in front of them beats anything a calendar knows); else the calendar's meeting running NOW (`nowMeeting`, started within
90 minutes and not more than 10 from starting, nearest start winning when two overlap — at 10:31 they mean the one they
just joined, not the one they are late leaving); else **it asks**: `409 { code: "meet_which", ask: "link" }` is the key's
cue to put up a card and call again with the link.

**The asking matters more than the calendar**, which is the correction that shaped this: most people have the link on
the clipboard already, because they clicked Copy link to get in. So the card can offer that with one button and need no
typing — which it must, because the guide's window is deliberately never focused and cannot take a keystroke.

**It never guesses which meeting.** A bot sent into the wrong call does not fail quietly: it sits there and takes notes
of it. No calendar, nothing running, a meeting with no link, a calendar needing a fresh sign-in — all the same ask, none
of them the person's error. The service's own refusals come straight back: "no minutes left" is not "which meeting".

Our own calls need none of it: the bot takes its seat with the first person in (`rooms/sitIn.ts`), hears each person
separately through the SFU so who said what is never guessed, and writes the note and the brief. `/now` is for meetings
somebody else hosts.

Holds: `meet/calendar.ts` (`nowMeeting`, `NOW_LATE_MS`, `NOW_EARLY_MS`), the `/now` route and the `events` dep in
`routes/bots/meet.ts`, the calendar wired in `server.ts`, 6 cases in `tests/meet-routes.test.ts`. No migration, no switch
of its own: it rides `MEET`.

**Not built: the card.** The server answers `ask: "link"`; the window has to draw it and offer the clipboard. Desktop
work, and a desktop build.

## 17 Nov: THE SCREEN BOT'S MARKS ARE OPEN NOW, AND IT BOUGHT BACK PROMPT BUDGET

The guide could mark the screen with nine things and nothing else: a name nobody listed was DROPPED, so the explanation
pointed at nothing while the words carried on as if it were there, and nobody was told. A model explaining something
reaches for "outline", "emphasise", "callout", "frame", "trace" all the time.

Now an unlisted name is read for its SHAPE and drawn as a mark this app already has (`agent/lines.ts markOf`):
`OUTLINE` and `FRAME` are a box, `EMPHASISE` a highlight, `ENCIRCLE` a circle, `CAPTION` a label, `ORDER` a number,
`STRIKE` an underline, and a name it cannot read at all becomes the plainest mark there is — never nothing.
**Open at the name, closed at the mark**, the same rule as a drawing's roles (`src/show/style.ts`). The window and the
phone already draw all nine, so an invented name needs nothing shipped.

**This is not the leniency the file's own header refuses.** "A mark that fails is dropped, never guessed at" is about
its TARGET: an id must be one really on this screen, a picture spot only on a step that has one. That stays exactly as
strict, and the tests still hold it. What degrades is how the mark LOOKS, which is ours to choose and never theirs.
`clear` and `arrow` are never guessed at: one wipes what is on the screen, the other needs two ends, and a wrong guess
at either is worse than a box round the thing.

**AND IT PAID FOR ITSELF.** Eight lines of contract, one per kind, became one open line plus a short second. The
planner's stable block went from **4,889 to 4,846 against its 4,904 budget — 15 characters of headroom became 58.** So
the thing this file has been warning about ("the next line anyone adds will fail that test") is less tight than it was,
and it got less tight by becoming more capable, which is the opposite of what more verbs would have done.

The picture path gets it for nothing: `parseDraw` is shared, so a mark invented while reading a chart resolves the same
way. Held by `tests/agent-draw.test.ts` (32 cases), including that a prototype name (`constructor`, `toString`) is still
not a kind and lands on the fallback, and that `__proto__` is not even a name.

**What this does NOT do, and it is the honest half of "show things on the screen":** the guide's CARD is still closed.
It draws a state, words, the steps and a confirm. It cannot show a table, a copiable command, a comparison or a chart —
the things `src/show` draws in a chat, including the open `part`. The card is its own renderer in `guide/card.js` (DOM
and canvas), not the SDUI kit, so `showNodes` cannot be pointed at it. The way in is a short verb on the planner (which
there is now budget for) that asks for a showing, with the existing `bot_show` role turning the answer into blocks and
`guide/card.js` learning to draw them. That is the next piece, and it is a desktop build, not a server deploy.

## 17 Nov: "HEY X0" ON THE COMPUTER — the decision is built and wired; nothing listens yet

The wake word was written down here as "native work in both apps, nobody is building it". On the **computer** that is
only half true: the window has no store review and updates itself from our own site, so nothing there waits on Apple or
Google. What it needs is a local listener, and what it needs FIRST is the decision, which is where the mistakes and the
privacy live. That part is built, tested and wired.

`TAILZU-DESKTOP/src/dictation/wake/wake.js` — the policy alone: no microphone, no model, no Electron, so it can be read
and argued with. It is handed what a listener thought it heard and what else is going on, and answers whether to start.

- **A word is not enough.** Below `minHeard` nothing happened; at or above `sureHeard` it fires; in between it waits
  `confirmMs` for SPEECH to follow, because a person who says the name goes on to ask for something and a passing
  mention on a television usually does not land in that gap.
- **A brake, because the television wins otherwise.** More than `restAfter` hits inside `watchMs` and it stops listening
  for `restMs` and says why. Without it a programme that says the name every minute holds the microphone open all
  evening and drains the battery doing it. Hits too quiet to count never feed the brake, or noise alone would rest it.
- **Refusals, not settings:** never while a dictation, Ask or a call has the microphone (one microphone, and a wake word
  that interrupted a dictation would write its own name into what was being said); never in an app that is off limits
  (money, health, a password field, our own window); never on a locked or sleeping machine; and never at all unless the
  person turned it on — being allowed the microphone once is not permission to listen all day, so it is its own switch,
  **off**.
- **A word waiting for speech is dropped** the moment the microphone goes to something else, and cannot be confirmed
  late.
- **Nothing is kept**: counters and a clock, never audio and never a transcript.

**What it starts is a dictation** — the same thing the key starts — because the one key's brain is what decides whether
what follows is a question about the screen or words for the box in front (`docs/ask-decide.md`). A wake word is the key
without the key, not a third way in.

Wired in `main.js` ("hey X0"): `wakeHeard(score)`, `wakeSpeech()` and `wake:*` IPC for a listener to call, with the
machine's state read at the moment of a hit rather than tracked, so nothing can go stale. The app in front is checked
only once a word is otherwise good enough to act on, because reading it costs a call.
15 cases in `src/dictation/wake/wake.test.js`; the desktop suite is 1,559 of 1,560.

**What is left, and it is the part that cannot be written here:** the listener. On-device keyword spotting with the
microphone open and nothing written down — macOS can do it (`SFSpeechRecognizer` with `requiresOnDeviceRecognition`, a
helper beside `audiotap.swift` and `tzkey.swift`), Windows has `Windows.Media.SpeechRecognition`. `wake.js`'s `LISTENER`
says what it must do and must not. It could not be built or tested in a Linux container with no microphone, which is why
it is an interface and not a guess.

**Also found, not fixed:** the desktop's one failing test is real drift, not the side-by-side kind —
`botLooks.js` is behind the backend's `shared/bots/looks.json` (the cinema and Lingo moments). The fix is
`node src/botTiles/genStarter.mjs` in `TAILZU-FRONTEND/app`, which writes both copies. Left alone deliberately: it
touches `app/**`, and a push of that to main publishes an over-the-air update, so it is the owner's to time.

**On "the screen bot should do everything":** the driver is not the limit. `axDriver`/`uiaDriver` already expose every
ability the planner's verbs use (snapshot, press, click, setValue, focus, scroll, key, open, caret, page, look) — and
`click` is there and not even offered as a verb. The limit is the **planner's prompt budget: 15 characters**
(4,889 of 4,904). So "everything" cannot be more verbs at ~60 characters each; it has to be an OPEN vocabulary, the
`part` move applied to the guide's marks, which costs a handful. Not built yet.

## 17 Nov: SDUI_V2 IS NOT WAITING ON A STORE BUILD — THE PHONES ALREADY HAVE THE BLOCKS

`docs/renderer.md` section 3 said phones would get the vocabulary-2 blocks "with the next over-the-air update of the new
store build", which reads as a store build being the gate. **It is not, and it never was.** Checked today:

- `bfe4404` ("The phone renderer draws screen vocabulary 2") touched **31 files, every one under `app/src`** — no native
  file, no `app.config.ts`, no `native-inputs.lock`. So the runtime label never moved from `tailzu-2026-11-x0-blip`.
- `eas-release.yml`'s `update` job runs `if: … (github.event_name == 'push' || inputs.update)` and only skips the send
  when the push touched a native file. Runs **131 to 139** were all pushes to main and all succeeded, including
  `cba544d` on 14 Nov 21:59, which was JavaScript only. Run 140's own message says it plainly for the other case:
  "Native, so it reaches phones in the next store build, not over the air."

So **every phone on that runtime has the blocks**, and the phone side of `SDUI_V2` is already done.

**The window is the one that still needs something, and it is not a store either.** It updates itself in place from our
own site (`TAILZU-DESKTOP/src/main/updater.js`: download, SHA-512 against what the publish recorded, replace, restart).
Its version has not moved since `af74cd7` ("The window draws screen vocabulary 2") landed — still 0.4.7 — so a build
carrying the blocks has to be **published** for installs to pick them up.

**What is actually left before `SDUI_V2` can go on:** publish a desktop build, then stage with `SDUI_V2_USERS`, then the
switch. Nothing is waiting on Apple or Google. Worth knowing because the stale line had this looking weeks away when the
phone half was finished on 14 November.

Updated 16 Nov 2026, 14:40 UTC. One session is building the items below. Do not edit the files they hold until the item is

marked landed here; if you must, write a line under "Notes from other sessions" first. Remove an item when it lands.

**How to build things now:** read `TAILZU-BACKEND/docs/renderer.md` before adding any screen, visual, animation or widget
look. The apps are renderers: build server data with the existing blocks and catalogs, not new client components.

## Landed today (on main, every switch off by default)

### 17 Nov: THE ONE OPEN BLOCK — a conversation can show a thing nobody wrote a block for (`docs/show.md` 1a)

The answer to "a catalogue is never finished". Somebody makes a bot nobody planned for, it needs a component nobody wrote,
and the answer cannot be "wait for a release". So `show` has a **`part`**: the model names what a thing IS (`role`, any
words) and **never how it looks**, and `src/show/style.ts` resolves every role — invented ones included — onto a look this
app already draws and has already tested. **Open at the name, closed at the look**, so nothing can come out off-style,
because there is no style for it to come out in except ours.

Three kinds cover it: `text` (seven looks), `box` (a plain stack, a row, a card, or a card with a tone) and `control` (a
button: copy to the clipboard, or send words as if typed). A **copiable snippet**, which no named block can express, is
three parts composed — and it needed nothing added to either app, because `copyToClipboard` is an action every build
already honours and five of the app's own screens use it. The window gets `copyText` through the same per-client pattern
`keysDesk.ts` already uses.

A role resolves in three steps: the table of everything we thought of and its synonyms; the HINTS, which read the shape of
an invented name (`api_snippet` has `snip` in it, so it is code); then the family's plain look. Deliberately not clever —
no string distance, no model call, no learning — because a guess that fails is a thing drawn wrong with nobody told, and a
rule a person can read off the page beats one that is right more often. What a control was GIVEN beats what it was called:
one named `copy` holding only words to send can only send; one holding neither is not a control and is dropped.

Held by `tests/show-parts.test.ts` (15 cases). The one that matters: a tree of entirely invented roles
(`deployment_severity`, `incident_headline`, `root_cause_detail`, `failing_command`, `duplicate`) draws with `lintTree`
clean and the app's own design rules passing.

**A size table was re-anchored, deliberately, and it should be seen rather than slipped past.** `bot_show`'s contract had
~24 characters of headroom (2,638 measured against a 10%-over-2,420 ceiling), so the open block did not fit. Its
`prompt-sizes.ts` "before" is now its real pre-`part` size, 2,638, not the 2,420 of its first version — the same treatment
the cinema's roles were given when they grew by the block they now carry, and it keeps the 10% rule meaning something
going forward instead of resting on a stale anchor. Measured now: 2,898, ceiling 2,902. It is still tight on purpose.

**XODE'S CHAT DRAWS NOW TOO.** The drawing step ran in one place, `bots/run.ts`, which Xode does not use — its chat is
its own loop — so the bot most likely to need a copiable command could only write words. It is asked for in
`code/chat/index.ts` after `converse` and before the thread is kept, and rides on the turn as `s`
(`code/chat/threads.ts ChatTurn`). Two things differ there, both on purpose:

- **Its `Seen` is empty.** What a Xode turn reads are file paths, not addresses, so the checker's existing "an address
  this turn read" rule drops every link and picture — a drawing here cannot build an address out of nothing.
- **The chat draws it `live: false`** (`screens/codeWork/job.ts`), so a control that SENDS words is left out while a copy
  is drawn on every turn. This chat's Send is not the bots chat's: a `say` would post into the wrong conversation.

Held by `tests/bots-codework.test.ts`: a turn carrying a copiable snippet comes out with the right client's copy action
and only that one (`copyText` in the window, `copyToClipboard` on the phone), the copy carries the command and not the
label, and `lintTree` is clean. Its fixture is a `CODEWORK_CHAT_API` of its own rather than the shared one, because
several tests read the shared one for the EMPTY chat's words — the first attempt changed the shared fixture and broke
two of them.

**What is left of the reach:** the bot builder draws nothing, so creating a bot still gets no components.

### 16 Nov: A SCREEN NOBODY BUILT, DRAWN BY A MODEL (`docs/screen-draw.md`, switch `SCREEN_DRAW`, off)

The first place in the app where a MODEL composes a screen rather than a person writing it. An id with no
builder in `BOTS_SCREENS` is answered "This part is on its way" today; with the switch on it is drawn instead —
one cheap call picks from the **20 blocks a bot already draws under its words** (`src/show`) and the kit draws
them, so **the model never writes a style and cannot break the app's design rules**. That is the arrangement
`sdui2/design.ts` was written for, now used: the model proposes, code decides.

Why blocks and not nodes: a model that writes nodes has to get contrast, borders and touch sizes right on every
screen, and `checkDesign` is then a gate it can fail. Picking blocks it cannot fail, because `showNodes` writes
the nodes. `checkDesign(drawn: true)` still runs over the finished tree, but as an **assertion over our own
renderer** — an error there is a bug in the kit, not a bad drawing — so there is no redraw and no second call.

What it may not draw: nothing to tap, type or send (`choice`, `suggest`, `form` are dropped at any depth — their
Send needs a chat turn and a screen has none), and no address or picture (the checker's existing "an address this
turn read" rule meets a turn that read nothing, so its `Seen` is empty and every link and image goes).

**A built screen never goes near it.** Every id in `BOTS_SCREENS` is answered by its own builder exactly as
before, and the test holds that: Home with a model door present asks no model. It needs `deps.drawn`, so every
caller not given one — the tests, the render check, `emptyDeps()` — behaves as it did.

Holds: `tulmi/src/drawn/draw.ts` (new), the `screen_draw` role in `principles/roles.ts` with
`evals/screen_draw.jsonl`, the `SCREEN_DRAW*` lines of `config.ts`, `deps.drawn` on `BotsDeps`
(`experience/bots/live.ts`), the `!def` branch of `buildBotsScreen` (`experience/bots/index.ts`),
`tests/screen-draw.test.ts` (18 cases), `docs/screen-draw.md`. No migration.

**It is drawn once** (`SCREEN_DRAW_CACHE_MIN`, 60 minutes). What is kept is the BLOCKS, not the built screen, so one
entry serves a phone and the window both; the key is a hash of the exact message the model was given, which is the
proof rather than a shortcut — two requests share an answer only where the model would have been asked the very same
thing, and if that message ever grows to carry the person's own facts the key grows with it. A "nothing to draw" is
kept for two minutes; a call that FAILED is kept nowhere, so a model down for a moment cannot blank a screen for an
hour; everyone asking at once gets one call (`guard/coalesce.ts`); and a kept drawing is not held to the money check
because no call is made for it.

**Not done, and worth knowing before this is pointed anywhere people visit:** it is told nothing but the id and its params — there is no `load` for a screen nobody
built, so it draws from the id alone and is told to invent no numbers and no names. Vocabulary 1 by
construction; once `SDUI_V2` is on it could draw to the blocks a client declares (`hasBlock`). The fixtures are
written but no eval has been run against a real model.

### 16 Nov: ASK'S LADDER SHARES THE BRAIN'S CIRCUIT BREAKERS (no switch; `docs/code-brain.md`)

There are three doors to a model here — `code/brain/gateway.ts` (Xode and the bots), `pipeline/writing/model.ts` (the
writer) and `agent/llm.ts` (Ask, the screen bot). Only the first had circuit breakers, so Ask tried a dead model and paid
the whole of `AGENT_TIMEOUT_MS` on **every step**. It now asks the same breakers first, under the **same keys**
(`guard/breaker.ts modelBreakerKeys`), so a model whose breaker is open is skipped with no call, and the two doors learn
from each other: a model the bots have just found dead costs an Ask step nothing, and the other way round.

The key convention moved into `guard/breaker.ts`, the leaf, and the gateway delegates to it, so there is ONE definition.
It could not be imported from `tiers.ts` (`familyOf`), because tiers.ts imports the planner and the planner imports the
breakers. An answer is a success; an empty answer, a timeout and a failure are the model's; a caller that stopped says
nothing and gives its probe back — the gateway's own rules. No `CallRecord` is written for a skip, because no call was
made (the ledger's outcome column is unchanged), so a skip is one line of the log, as it is in the gateway.
Two cases in `tests/agent-route.test.ts`: eight failing steps shut the model AND its whole provider, and a ladder nobody
has failed is untouched.

**A doc that was wrong is fixed too.** `docs/code-brain.md`'s known limits said "calls are not streamed", and the gateway
has streamed all along (`onText`, `drain()`, `firstTextMs`, `onReset`, and a stopped stream charged for what it used).
The real gap is narrower and now written down: the gateway voids what was shown and climbs, which is right for a job
nobody watches and wrong for a caller whose lines are ACTED on as they arrive — `onReset` can un-say words, it cannot
un-press a button. That one per-call policy is what a full move of `agent/llm.ts` onto the gateway needs first, and it is
the next step of this work, not a thing that was skipped.

### 16 Nov: RAISING THE CONTEXT ACTUALLY RAISES IT NOW (`docs/context.md` 2a; no switch, default unchanged)

**A correction worth reading.** It was said here that four times the person's context block was one env var away.
It was not. `CONTEXT_MAX_CHARS` is a CAP, and the section limits (eight facts about them, eight people, four pieces
of open work, three recent results) are applied BEFORE the cap is measured, while the cap only ever CUTS. So raising
it bought nothing: the sections never produced more than about 2,000 characters, and a bigger budget was a bigger
empty room.

The section limits lift with the configured budget now (`context/build.ts forBudget`), to four times at the config's
own ceiling of 8,000. **At 2,000 every number is exactly what it was**, so nothing changes until somebody raises it;
`CONTEXT_MAX_CHARS=8000` then gathers four times as much and costs accordingly. Held by `tests/context.test.ts`:
eight people at the default, twelve with it raised, and the trim order untouched.

The lift reads the CONFIGURED budget and never a caller's own `max` — the configured budget says how much is
GATHERED, a caller's `max` only CUTS. The first version tied it to the caller's number, which made a smaller `max`
produce a SHORTER text and so nothing to trim: "just over the cap" stopped being over it, and the trim order's own
test caught it. Worth keeping in mind for anything else that scales with a budget.

How many asks are KEPT does not scale (`keep.ts TURNS_KEPT`, 6): that is storage, one row per person, so more of
those is a decision about what is written down rather than what a model is shown. Above 8,000 is still a zod
`.max()` change; the env var higher than that fails validation rather than clamping.

**One more correction, from reading `agent/llm.ts`:** the gateway's `growing` prompt cache would NOT help Ask. It
needs messages that only grow at their end, and the planner sends a system block plus ONE user message that is
rebuilt every step (the run's history is inside it). Its cacheable part is the stable block, which it already marks
for Anthropic. So Ask's caching is already as good as that mechanism can make it, and the win there is the
breakers above, not caching.

### 16 Nov, late: four sessions' branches merged into main

One session walked every branch in the four repos and merged what was ready. **Every migration below was renumbered
on the way in**, because three branches were cut before their numbers were taken and `migrate-pending.sh` runs only
what is numbered above `LIVE_MIGRATION` — a colliding number does not fail, it is silently never run.

- **Discover, places worth keeping** (`claude/discover-travel-bot`, pull request 3), migration **0099**. The engine,
  the catalogue, the store and 2 test files are on main. **It is dark by construction**: `ports.discover` is declared
  but nothing supplies it, so the tools never attach to a bot. Wiring it up is what is left.
- **Xode's standing job, the reality trend, the design floor** (`claude/zen-bohr-7xgu6f`), migration **0095 -> 0100**.
  `CODE_SCHEDULES` is off. That migration is the one worth knowing about: as a second 0095 it would never have run,
  and `code_schedules` would simply have been missing from the database with nothing to say so.
- **The cinema bot's 3D and the bot at the foot of Home** (`claude/keen-allen-podunv`), across backend, phone and
  window. `CINEMA` and `HOME_UPDATES` are off. A scene is DATA: the model picks from shapes, lights and materials,
  the checker clamps it, and we write the Blender script, so nothing a model writes is executed.
- **The site's phone screen** (`claude/loving-goldberg-wvp95p`, TAILZU-WEB) and **the Blip structure sheet**
  (`claude/jolly-brown-p8nhu2`, brand assets only).

**A SWITCH PER BOT: `BOTS_OFF`** (17 Nov). The slugs not to list, comma separated. Until now the control was uneven —
Xode, Keylessbord, Plan Ease, Travel and Talk were listed the moment `BOTS` was on with no switch at all, Lingo and
the cinema had their own, and the Oracle, the mail bot and the meeting bot were gated by whether their service was
set up. This reaches all of them.

* **A deny list, not an allow list**, unlike `CONNECTORS_ENABLED_IDS`, and for a reason: every connector ships
  disabled, but five bots ship listed. An allow list would mean that naming one bot to switch it on silently
  switched off the ones already there — turning the cinema on and losing Xode.
* **The last word, not the only one.** A bot must be available before this can hide it; naming one that is not does
  nothing. Those switches say "this is set up", this says "and I want it listed".
* **Hiding a bot does NOT free its name.** `isBuiltinSlug` is deliberately not filtered, so nobody can take "travel"
  while the Travel bot is off and collide with it the day it comes back. There is a test for exactly that.
* Read in `defs()`, the one place every listing goes through, so a built-in added later is covered without anybody
  remembering to.

**HOME IS ONE BOT A ROW ON THE PHONE** (17 Nov). `tiles(ctx, 1, 104, 16, …)` — two columns of 132 gave the phone FOUR
slots, three bots and "Make a bot", so with five built-ins alone most bots were chips under a "More bots" label. One
column is full-width rows and everything fits.

**Only the width changed.** It is the same living tile at a different shape: the same Blip playing on it in the bot's
colour, the same tap (the tile presses in, the cloth is drawn under the finger, that bot perks up and every other bot
turns its head to it), the same moments and the same engine. `columns` was always a parameter of `BotTiles`, and the
app already honoured it — `const cols = Math.max(1, Number(props?.columns) || 2)` — so this is server side alone, no
app change. (The first answer given here was that it needed one: that was from looking only at `strip`, which is one
full-width row and singular. `columns: 1` was the whole of it.)

* **104, not 132**: a wide row needs less height to give its bot somewhere to play, and seven rows of 132 is three
  screens of scrolling.
* **`HOME_TILES = 8`** is the cap, and it is not a layout number — each row is a LIVING bot the app keeps for its
  lifetime, so it is how many animate at once. Past it they are chips, which `moreBots` already did and which now
  draws nothing, because nothing is left over.
* **`emptyHome` changed with it.** Its own comment says it shows the bots "as Home shows them once they've started",
  so leaving it at two columns would have changed the grid's shape under someone as they gained a bot.
* **The window keeps its four across** (`homeDesk`, `tiles(ctx, 4, 150, 18, …)`), untouched.
* Talk had no card line and was showing its purpose cut mid-word ("Just talk to it: questions, ideas, writ…"). It
  reads **"Answers your questions"** now, in the style of the others (`shell/parts.ts` idleLine).

**THE CHAT IS A TAB NOW, AND YOU IS NOT.** Tabs are **bots, talk, activity** (17 Nov). None of it needed an app
release: the tab bar is server data and the app maps whatever tabs it is given — `TabBar.tsx` hardcodes no ids — and a
tab's icon travels as `{viewBox, layers}` for the app to draw, so a new tab with a new glyph is entirely this side.

* **Talk is second, not first.** Bots is what this app IS and what it opens on, and a tab is one tap wherever it sits.
* **Its page is the usual chat as a TAB ROOT** (`bots.talk`, `screens/bots.ts` `chatPage(…, { root: true })`): no back
  button, the bot's head instead of the phone's back row, and the slug is FIXED in the screen because a tab root is
  fetched with no params. Warmed at launch like the other roots.
* **The balloons fill on the tab you are on**; the thread does not. Nothing in that glyph reads `live`, unlike the
  other three — a conversation has no count to show and no ring to fill, and a dot invented to match would be lying.
* **You left the tab bar for Home's header**, where it already was: `homeHead` has carried a person button labelled
  "Profile and settings" all along, it just did `toTab("you")`. It pushes the page now. It was also **phone-only**,
  because the window reached You through its sidebar tab — with the tab gone that was the only way in on desktop, so
  the button is on both. Spaces' own "You" link pushes too. The page is unchanged and still warmed; it gained a back
  bar, as every pushed page has. The You tab's living ring went with the tab.

**A FIFTH BUILT-IN: THE BOT YOU JUST TALK TO** (slug `talk`, name **provisional**). Every other built-in is for a job —
code, a trip, a calendar, a film — so a person who just wanted to ask something had nowhere to go. This is the plainest
bot here: no service, no store, no tick, no migration. It is the chat loop (`botsBots/chat.ts`) and the role `bot_run`,
with `web` and `files` on, so it can look things up and read what they attach.

THE NAMES ARE NOT SETTLED. All the bots get named together later; `talk` is a working slug and "Talk" a working name.
Until `BOTS` is on there is no chat history keyed to the slug, so renaming costs nothing. After that it does.

Three things found while adding it, each a trap somebody else would have hit:

* **`tailzu` is NOT free, and is not a bot.** It is X0 itself: `palette.ts` gives that slug the app's own ink and mark,
  and `live.ts` reads it back as **"X0"** on an approval that came from no bot. It was the obvious name to take and
  taking it would have put a bot's face on the app's own voice. `chat` is no better — a live route segment under the
  bots area. Both are in `RESERVED_SLUGS` now, with `lingo` (a built-in that was never listed there) and the other
  route segments a slug would be matched before: `listing`, `rules`, `session`, `sessions`, `share`, `store`, `trip`.
* **A built-in wearing a shipped-only colour could not pass its own schema.** `parseBotInput` refuses `ash` and
  `slate` on purpose — that refusal is what stops somebody's own bot coming out the colour of one of ours — but
  `bots-validate` puts every built-in through that same schema. Lingo has worn ash since it landed and only escapes
  because `builtinBots()` leaves it out while `LINGO` is off: **switching Lingo on would have failed that test.**
  The colour is held to its own rule now (PALETTE or SHIPPED_ONLY), and the schema check keeps the rest.
* **Order is not cosmetic.** Home's grid draws three bots and "Make a bot", and the Bots tab glyph draws four. A fifth
  built-in placed first silently pushed Plan off the grid and Travel off the glyph, so `talk` goes LAST.

It wears `slate` (#4A535C), a cool graphite added to `SHIPPED_ONLY` so it is never offered in the picker, and three
balloons on one thread (`glyphs.ts` `balloons`) rather than the sparkle every AI product uses — which is also X0's own
mark and had to stay that way. 12,435 tests pass. `BOTS` is off, so none of it is reachable yet.

## A RELEASE THAT SENT NOTHING IS RED NOW, NOT GREEN (20 Nov)

Three things in one day decided not to do their work, said so in small print, and finished green:

1. the migrate stage, `CACHED`, so pending migrations never ran;
2. the payment-key gate, dropping Android from every update for two months;
3. **"Native files untouched"**, which set `send=false` and `exit 0` — every later step skipped, tick green, nothing
   on anybody's phone.

The third one caught the commit that removed the billing keys, because `app/app.config.ts` is on its list. The list
is right to hold that file (it can carry permissions, plugins, the icon) and the check is the ONLY thing standing
between JavaScript written for new native code and a binary without it — `runtimeVersion` is a fixed string, so
nothing else stops it. What was wrong was finishing green: a commit that is on main and on no phone is a thing
somebody has to act on.

It fails the run now, and the summary says which files tripped it and what to do — a store build for a real native
change, or the workflow run by hand (where the check does not apply) when an update really can carry it. Checked by
extracting the step and running it against a throwaway git repository: a JavaScript-only commit still gives
`send=true` and exit 0; a commit touching `app.config.ts` exits 1 with the error and the file named in the summary.

**Not done, and worth knowing:** it still judges by WHICH file changed, not by what changed inside it. Removing two
strings from `extra` is blocked exactly as a new permission would be. Narrowing it means diffing
`expo config --type public` before and after and blocking only when something native really moved. That is a better
check and a riskier one — it is the only guard there is — so it was left alone rather than made clever.

## REVENUECAT NO LONGER TOUCHES A RELEASE (20 Nov)

The coupling is cut at the root rather than loosened. **The billing keys are out of the manifest.** `app.config.ts`
baked them from the environment, `eas update` re-evaluates that config on every publish, and the whole mess followed
from those two facts:

* an update published without the variables replaced working keys with empty strings — purchases stopped, nobody had
  touched billing, and the message blamed a build that was fine;
* the guard added for that refused to publish for a platform whose key the release could not read, which let a
  **payment integration decide who received JavaScript**. Stored as "secret" on expo.dev a variable reads empty to
  `eas env:exec`, so Android was dropped from every update for two months while the run stayed green on a warning.

The server already sent the keys (`bootstrap` → `billing.revenueCatKey.ios` / `.android`) and the app already took
them at boot over the manifest. So the manifest half was deleted, not patched: nothing for a publish to lose, nothing
to guard, and the key in exactly one place — the server's own `.env`, which is where keys belong here anyway.

What went with it: both store-build key gates (the binary carries no key either now), the update job's gate, the
check job's, and `tools/ci/eas-keys.mjs` itself. The release mentions RevenueCat nowhere.

**Verified rather than assumed.** `npx expo config --type public` gives the real manifest: no `revenueCat*` in
`extra`, `sentryDsn` / `posthogApiKey` / `metaAppId` still there, and **`runtimeVersion` still
`tailzu-2026-11-x0-blip`** — had that moved, every installed app would have stopped taking updates. The live server
still serves both keys, 32 characters each. `app/src/billing/keyFromServer.test.ts` fails if either half comes back.

**One consequence to know.** A store build CAN read a "secret" variable, so the binaries shipped with a key in their
manifest; an update replaces that manifest. Phones that took the 19 Nov update already have an empty key there, and
after this one no manifest anywhere carries one. Billing therefore depends on bootstrap reaching the phone — which
it does on every launch and from the disk cache after the first. The only uncovered case is a first-ever launch with
no network, which sits on the offline card and cannot reach RevenueCat regardless.

**The EAS variables are now unused.** `REVENUECAT_IOS_KEY` (two entries, one Sensitive and one Secret) and
`REVENUECAT_ANDROID_KEY` can be deleted. `SENTRY_DSN` and `POSTHOG_API_KEY` are a different matter: they are still
read by `app.config.ts`, still read empty on the runner, and so these releases still report no crashes and no
analytics. Those two want "sensitive" visibility.

## EVERY OTA HAS BEEN iOS ONLY. ANDROID HAS HAD NONE OF IT (18 Nov)

**Why "I don't see the changes in the app" was true, and not a caching story.** From the release log, verbatim:

```
##[warning] REVENUECAT_ANDROID_KEY is empty in the EAS production environment as read from here,
            so android is left out. On expo.dev → Environment variables, give it "sensitive"
            visibility, not "secret".
PLATFORMS: ios
Environment variables ... loaded from the "production" environment on EAS:
  META_APP_ID, META_CLIENT_TOKEN, REVENUECAT_IOS_KEY
Platform    ios
```

`eas-keys.mjs --any ios android` keeps only the platforms whose payment key it can READ. A variable stored as
**"secret"** on expo.dev is readable by Expo's own builders and by nothing else — `eas env:exec` gets an empty string
— so Android was dropped from `--platform`, and the export built an iOS bundle alone. **Every update went to iOS
only.** The gate itself is right: an Android bundle published without that key is an Android app that cannot take a
payment. What was wrong is that it said so with a `::warning::` in a run that stayed green.

**AND IT HID ITSELF TWICE OVER.** A phone with no update does not declare the new components, and the capability
handshake then withholds exactly the new work from it — correctly. So the peeker was not sent AND the bot at the foot
of Home stayed, which reads as "the server did not change" rather than "this phone is three OTAs behind". Server work
and app work looked equally dead from the outside.

**AND THE GATE WAS ALREADY OBSOLETE.** It exists because `eas update` re-bakes `app.config.ts`, so publishing
without the variable would have replaced a working key in the manifest with an empty string — "purchases worked,
nobody changed anything about billing, and then they stopped". That is handled now, and not in the workflow: the
server sends the key (`bootstrap.ts` → `billing.revenueCatKey.ios` / `.android`) and the app takes it at boot over
whatever the manifest holds (`billing/purchases.ts` `setBillingKey`). **The live server serves both**, 32 characters
each, checked against `POST /v1/app/bootstrap`. So the manifest is the fallback, and a key missing on the runner
costs that fallback — not the key, and certainly not everyone on that platform every other bit of work.

So the release publishes `--platform all` now and the key check is a warning that cannot gate. Android gets updates
again with nothing to change on expo.dev. **Setting `REVENUECAT_ANDROID_KEY` to "sensitive" there is still worth
doing** — it restores the fallback — but it is no longer what stands between Android and a release. These are the
public SDK keys: they ship inside the binary and sit in the manifest in plain text, so there is nothing in them to
keep secret, and "secret" visibility buys nothing while costing this.

`SENTRY_DSN` and `POSTHOG_API_KEY` read empty from the runner too, so these releases report no crashes and no
analytics. Same cause, same one-line fix, worth doing while you are in there.

## A PENDING MIGRATION CAN BE SKIPPED A SECOND WAY: THE BUILD CACHES IT (18 Nov)

**`LIVE_MIGRATION` says 0100 and seven files sit above it (0101–0107).** Both deploys today show the migrate stage as
`CACHED` and the script never ran:

```
#17 [migrate 2/5] COPY tulmi/supabase/migrations/ /migrations/   CACHED
#18 [migrate 3/5] COPY tulmi/supabase/LIVE_MIGRATION             CACHED
#19 [migrate 5/5] RUN ... sh /migrate-pending.sh                 CACHED
```

That is the script's own intent — "a deploy without a new migration does not run them again" — but it means pending
migrations run **only** on a build where one of those three files actually changed. A commit that touches no file under
`supabase/` cannot run them, however far behind `LIVE_MIGRATION` is. So this file already warned that a duplicate
number is never run and does not fail; **this is the second silent skip, and it needs no duplicate at all.**

The likely story is that each of 0101–0107 ran on the deploy right after it landed (adding a file does invalidate that
COPY layer) and only the bookkeeping was never bumped. **That is a guess, not a reading**: the logs cannot say, and
nothing here can reach the database.

**Nothing is broken by it today** — everything those tables serve is off (`CINEMA`, `LINGO`), and the peeker and the
insert card need no new table. It is latent: whoever turns one of those on finds out then.

**To settle it, in this order.** Leave `LIVE_MIGRATION` at 0100, change a comment in `migrate-pending.sh` to break the
cache, deploy: the script runs 0101→0107 in order, each whole or not at all, and they are written to be safe to run
again, so it is safe whether or not they already have. A failure stops the build and the server keeps serving. THEN
bump to 0107. **Do not bump it on its own** — if they have not run, that skips them for good, which is the worst of
the three outcomes.

## THE ASK BAR HAS AN INSERT KEY, AND A CARD THAT GROWS (18 Nov)

A round `+` in its own circle to the left of the type box, with a gap — not another thing crowded inside the box,
because inserting a file is not part of typing. It blurs the page and pops a card (a `BotCard` overlay, a real modal)
with the ways in: a photo, the camera, a file, a screenshot, the clipboard.

* **It grows with what you choose.** Every pick ADDS (`uploadAdd`), up to the eight the ask door takes, and the chosen
  files appear above the ways in as a wrapping strip of pictures. The card sets no height, so it is taller every time
  one is added: nothing animates a number.
* **A way in no longer shuts it.** The picker is a native sheet and goes above the modal, so the card is still there
  when it closes, holding the new file. Only Paste shuts it — there is nothing to come back to.
* **The pictures are the copies still on the phone.** Nothing serves an uploaded file's bytes back (`/v1/files`
  answers with the file's facts and no address), so the uploader leaves each one in state as an `{ url }` spec and the
  card binds an Image's `source` to it. A file with no picture leaves it empty, the Image draws nothing, and the clip
  behind it shows. Lint knew only literal urls and takes a bound source now — the same promise either way.
* **Nothing new was needed on the way out.** The ask already carried `attachments` and the door already routed on them
  (a bot with the `files` skill is worth 3 more when a file is there). This was only the key that was missing.

The bar moved out of the kit into `ask.ts`: it needs the media parts, and `media.ts` imports the kit, so the kit cannot
import it back. The camera glyph is path data like every other, so no build had to learn it.

**A cross per picture is missing on purpose.** No action in the vocabulary takes ONE item out of a list
(`appendState` adds, `clearState` empties, nothing removes an index), so Clear takes them all off. A cross per picture
needs a new action kind, which is a change to the contract both clients read.

**Two keys in one object literal.** The ask bar's state was added as a second `state:` in the spread at the end of the
window's Home opts, and being later in the same literal it REPLACED the first — taking with it every reading the
arrival card and the About-you card stand on, so both drew nothing. Four tests caught it. A key already in the opts is
merged into it, never added again.

## COMING BACK LANDS WHERE THEY WERE, NOT PART OF THE WAY THERE (18 Nov)

The scroll restore was a one-shot latch on the FIRST content-size event — and a page does not reach its full height in
one pass: tiles measure, pictures land, `Rise` nodes settle. The first height is shorter than the last, so the offset
was clamped to a fraction of where they were and, the latch being set, never corrected. The page landed PART of the
way down, which reads as nearly remembering: the worst of both answers.

It keeps asking as the page grows now and stops owing the offset only once the page is tall enough to hold it
(`scrollMemory.ts` `landing`), or after a moment, so a page whose content has changed since is not chased for the life
of the screen. **The viewport is measured on every page too** — it used to be read only on a page that opens at its
end, so everywhere else the clamp was computed against a height of 0, which makes every page look scrollable to its
last pixel and lets through an offset that snaps back. And **their finger wins**: taking hold of the page cancels what
it owes.

**Still not restored at all: a screen whose body holds a `List`.** That branch hands its scroll to the List and
returns before any of this runs. Nothing in the bots app uses it today (it needs the vocabulary-2 `list` block), so it
was left rather than built untested — worth knowing before anything starts using `List`.

## THE PEEKER IS HOME'S ASK NOW. THE BOTTOM BOT IS GONE (18 Nov)

**The decision:** there is no reason to keep a bot walking the foot of Home once the peeker can be called and talked
to. It was a second way to do the one thing he does. So where a build declares `BotPeek`, Home has no `BotStage` at
all — and typing is the ask bar, which is what Home had before that bot and still works.

How the one moment is put together, all of it from pieces that already existed:

* **The ear** — `homePeekEar()`, the same always-listening turn the updates bot uses (`voiceLive` on `onAppear`,
  guarded by `{ falsy: typing }` and `{ falsy: voice }`). It opens when Home comes forward and stays open with
  nothing to press; the keyboard shuts it, `HOME_LISTEN=false` shuts it everywhere. It hangs off **his** node, not
  the page, so a build that cannot draw him is never sent an open microphone it has nothing to show for.
* **The veil** — `BotPeekProps.veil`. The app's own `<Blur/>` (`sdui/components/blur.tsx`), the very component a
  thought's veil draws: expo-blur on the phone, `backdrop-filter` on the web. Nothing native, so this is an OTA.
* **The panel** — the node's CHILDREN, built by the server. `askExchange()` in `homeThought.ts` is now the one place
  the exchange is described (the words as he hears them, what was said, Thinking, the answer with who answered, Open),
  and **the thought and the panel draw the same nodes**. Two copies of an answer's layout drift apart the first time
  one of them is touched.
* **Who answers is not his to decide.** The words go to `POST /v1/shell/ask` with `bot: "any"` — the door the ask bar
  and the thought always used, which reads the ask and routes it. One road, with him as the way onto it.

**What a build gets, and why it differs.** A phone declaring `BotPeek` gets the peeker, the veil, the panel, the open
ear, no bottom bot, and the ask bar for typing. A phone that does not, and **the window**, keep the walking bot
exactly as it is — because that one can answer and until today he could not. The window has its own Blip in its own
frame, and no notch.

**The one case where something stays at the foot:** `HOME_UPDATES`. That bot is not an ask, it is what is happening,
and it already has an open ear on the same `voice` path. So the peeker is sent `asks: false` — he keeps the gesture
and the leaning-in, and that bot keeps the words and the answer. **Two things listening is a bug.**

The bottom edge is one of his spots now that nothing walks there; it stops where the tab bar ends, not where the
glass does. 32 server tests on the peek alone, every build case among them.

**Still to come:** he is called by voice and by the ask bar's mic key, and `FRONT_DOOR` (`front/decide.ts`) is still
off — the cheap-road router that would pick the shape of an answer before a model is asked. Turning it on is a
separate decision.

## HOME'S PEEKER IS BUILT, SERVER AND APP (18 Nov)

A small Blip rises from behind an edge of Home, looks out, and ducks back — the window's own gesture
(`TAILZU-DESKTOP src/shared/blip.js` `rise`, `guide/peek.js`: 280 ms up, 300 ms down, a 560 ms hop), with one move the
window cannot make: **he hangs upside down from the notch**, head first, so the hardware cuts off his crown.

TWO RULES HOLD IT UP, both in `app/src/sdui/bots/peekCore.ts` where they are tested (19 tests):

* **He is clipped.** He is drawn in a POCKET at the edge, `overflow: hidden`, and only three fifths of him is ever
  past it. The first version clipped him against the screen's own edge instead, which works beside a wide notch and
  draws him **over the clock** beside a narrow punch-hole. A pocket on the safe side of the edge cannot do that on
  any phone, whatever its cutout.
* **He never crosses the screen.** The next spot is taken at rise 0, with the animation off, below the edge where
  nobody can see it. The only movement anybody watches is straight over an edge and straight back.

**A bug worth remembering:** `placeOf` works in the WINDOW's coordinates, because that is the only frame the safe area
is written in — but the node is mounted inside a `SafeArea` that has already taken the notch's height as padding, and
an absolutely placed child is placed against its parent. A pocket at `top: 59` was drawn at 118: a bot standing
halfway down the page. The component measures its host (`measureInWindow`) and `pocketIn` takes that off. A host at the
window's own origin changes nothing, which is why it was easy to miss.

**THE ANTENNA IS THE MICROPHONE, and nothing had to be built for it.** The motion core already lights it from the
voice's own level in the `listen` act (`botTiles/core.ts`: `glowTo = level * 1.2`) — the same light the window's Blip
shows. The one thing missing was that `BotBuddy` only fed the level while a scene was playing; it feeds it while he
listens now. No new catalog moment: `blip` already wears two ball-tipped antennae in `shared/bots/looks.json`.

Server side: `canPeek` / `botPeek` in the kit, `homePeek` in `homeThought.ts`, in Home's `pinned` layer (over the page,
outside its scroll), `BotPeek` in `lint.ts`. He takes the right edge, the notch, the left edge and the right again —
**never the bottom**, because the bot with the thought walks there. Called by voice (`voice`, which `homeVoice`
already writes) he comes to the notch and holds, listening; when the answer lands (`asked.shell.text`) he hops once
and ducks away. 21 server tests.

**What he is not, yet.** Home's ask is still the bot walking the bottom with his thought: that one takes words,
streams an answer back and blurs Home behind it, and the peeker cannot answer anything at all. Swapping the bottom bot
out waits on the peeker being able to hold the whole conversation — the blur, the routing, the card or the text it
draws by itself. Until then both are there, out of each other's way.

## AN OTA CARRIES RENDERER WORK. A STORE BUILD IS FOR NATIVE CODE ONLY (17 Nov)

**Correcting something this file got wrong twice**, because it was costing real decisions. "The apps would have to learn
to draw it, so it needs a store build" was the reason given on 16 Nov for taking the bot's peek and the dotted mark out,
and the reason nearly given today for not letting the Home bot peek around the screen. **It is wrong.**

`eas-release.yml` publishes an OTA on any push to main touching `app/**`, and an OTA carries **all of the JavaScript**,
new SDUI components and renderer behaviour included. `BotStage.tsx` imports React, react-native primitives and
safe-area-context — nothing native; Skia is already in the binary. So a new way of drawing a bot ships the same day.

THE REAL LINE:

* **Store build** — native code only: a new native module, a permission, the app icon, anything in the Android or iOS
  project. Those cannot go over the air at any price.
* **OTA** — everything else, including a new component and a new capability, as long as the runtime version still
  matches (`tailzu-2026-11-x0-blip`, fixed). The capability handshake then does its job: the updated build declares the
  new component, and a phone still on an older runtime simply never gets sent it.

What this changes: a thing that "needs an app change" is not thereby weeks away. It is one OTA away unless it is native.

## WHAT IS OFF, AND WHICH KIND OF OFF IT IS (16 Nov)

Fifty-three switches are off and twenty-six are on, which sounds alarming and mostly is not: most of the off ones are
finished work waiting to be launched. But "off" hides three different things, and only two of them are fixed by a switch.

**AT THE ROOT: `BOTS` IS OFF.** Every bot-shaped thing is behind it — the server reads `bots && cinemaOn()`, and the same
for the rest — so the cinema, Lingo, the mail bot, the meeting bot and the Oracle are invisible no matter what their own
switch says. Nothing below matters until this one is on.

### 1. Waiting on a setting, not on code. Nothing to build.

A few features have no switch at all: THE KEY IS THE SWITCH, so they are simply absent until it is set, with nothing
anywhere saying why. The meeting bot is the live example — `meetOn()` is `Boolean(RECALL_API_KEY)` and the key has not
been added, so the bot is not listed and never has been.

| Feature | What it needs | How it is gated |
| --- | --- | --- |
| The meeting bot | `RECALL_API_KEY`, `RECALL_WEBHOOK_SECRET` | the key IS the switch — **not added yet** |
| Calls (video and audio) | `SFU_APP_ID` **and** `SFU_APP_SECRET` | without both there are no calls anywhere |
| The mail bot | `MAIL_WORKER_URL` **and** `MAIL_WORKER_SECRET` | the pair is the switch |
| Phone calls out | `PLIVO_AUTH_ID`, `PLIVO_AUTH_TOKEN`, `PLIVO_FROM_NUMBER` | plus `CHANNEL_PHONE_CALLS` |
| Media ingest | `MEDIA_WORKER_URL`, `MEDIA_WORKER_SECRET` | plus `MEDIA_INGEST` |
| Artifacts | `ARTIFACT_VIEWER_URL`, `ARTIFACT_APP_ORIGIN` | plus `ARTIFACTS` |
| Xode on GitHub | `GITHUB_APP_ID`, `_SLUG`, `_CLIENT_ID`, `_CLIENT_SECRET`, `_PRIVATE_KEY`, `_WEBHOOK_SECRET` | plus `CODE_GITHUB` |
| Connectors | `CONNECTOR_TOKEN_KEY`, `CONNECTOR_OAUTH_CLIENTS` | plus `CONNECTORS` |
| Places, in Discover and the Oracle | `GOOGLE_PLACES_API_KEY` | falls back to no suggestions |
| Films, pictures and 3D creations | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | without them the bytes are in memory and a restart forgets them |

Known set, because the deploy's own live checks prove it: the Oracle's worker and its model keys, the payments webhook,
and `OPENROUTER_API_KEY`, which the config requires outright — the server does not start without it.

### 2. Off AND INCOMPLETE. A switch alone will not do it.

These are the ones worth knowing about, because turning them on gives you a feature that draws and does nothing.

* ~~**Lingo — a course cannot get any words.**~~ **CLOSED, 17 Nov**, by another session: `src/lingo/tool.ts` gives the
  bot `lingo_note_words`, which files the words a person reached for into the course they are on — the fix this entry
  called for. The sentence bank is still optional and still not seeded, which is a different thing: an empty bank is
  handled on purpose (the `blank` exercise is skipped and the ladder closes over it). Everything downstream is built and tested: the scheduler, marking on the
  server, the seven exercise kinds, the sets, the grader's gestures, the 85-language picker, 165 tests. But words arrive
  only through `POST /v1/lingo/words`, and **nothing calls it** — not the app, not a screen, and not the bot, which
  `builtin.ts` says outright has no tools. Switch it on today and you can start a Spanish course with nothing in it. The
  bot's own description is the answer ("teaches you a language by talking with you"): one tool on the bot, server side.
  *(The sentence bank is NOT this problem. An empty bank is handled on purpose — the `blank` exercise is skipped and the
  ladder closes over the gap. Seeding it adds the best exercise kind, a word used in a real sentence, but is optional.)*
* **Discover — dark by construction.** The engine, the catalogue, the store and its tests are on main, but `ports.discover`
  is declared and nothing supplies it, so the tools never attach to a bot. Wiring it up is what is left.
* **The cloud browser — never run against a real site.** Every test uses a fake browser. `CLOUD_BROWSER_SITES` is also
  inverted from every other list in the config: **empty means NONE**.
* **The sign-in card is not drawn anywhere.** The server sends it; the desktop app has to draw it. Until then every
  `FIELD` line ends in a correct plain handover, so nothing is broken — it is just never shown.
* **The cinema's 3D** is connected as of today, but the deploy that carries Blender has to land before it can render.

### 3. Off on purpose. Nothing is wrong.

Eighteen `PERM_*` switches are phone permissions, held until the stores approve each declaration — background location is
the one that blocks a `production` Android upload. `DEV_SKIP_AUTH` must stay off. The rest (`PLAN_SHARE`, `SPACES_ENABLED`,
`HOME_UPDATES`, `WIDGET_DIGEST`, `NATIVE_LOOKS`, `KEYBOARD_SKINS`, `USAGE_*`, `FRONT_DOOR`, `CODE_SCHEDULES`, `BOT_SHOW`,
`BOTS_SCENES`, `NOTIFY_REPLY`, `DEMO_ENABLED`, `AUTH_GOOGLE_WEB` and the others) are finished features waiting to launch.

**THE CINEMA IS IN, BOTH HALVES, AND THE 3D IS CONNECTED.** The film half merged (migrations 0101 and 0103, and bot
sessions as 0102); its seven prompts are roles in `roles.ts` with fixtures and known-good answers, so the sweep holds the
whole bot. The 3D half, which was wired to nothing, now has three doors under the cinema bot's own path
(`GET`/`POST /v1/cinema/scenes`, `GET /v1/cinema/scenes/:id`), a creation row a person comes back to (migration 0104,
`src/cinema/scene/service.ts` and `store.ts`), and Blender in the image behind `WITH_BLENDER=1`, which
`docker-compose.yml` sets for a deploy and CI leaves off. **`CINEMA` is still off**: nothing is reachable until it is
switched on, and this box has no graphics card, so a still is seconds to minutes and a moving scene wants their own
computer or a rented card (`docs/cinema-3d.md`). What follows is how it got here.

**THE CINEMA, TUNED AS FAR AS A MERGE CAN TAKE IT.** `src/cinema/` held the Blender half; the film bot wanted the same
paths. The 3D is a PART of the cinema bot — its own doc says so — so it took the sub-name: **`src/cinema/scene/` and
`docs/cinema-3d.md`**, and `src/cinema/` is free for the bot itself. One `CINEMA` switch for both halves; the 3D's keys
only say HOW it renders. Green, pushed, and it unblocks the film bot's rebase.

The film bot (`claude/kind-ptolemy-9f3jlg`, 25 commits) was then merged in full and backed out again. Everything
mechanical worked: 13 conflicts resolved, migrations renumbered 0089/0090/0091 -> 0101/0102/0103, the quota port
adapted to the `Quota` shape it grew since, **12,413 tests passing**. It stops on ONE thing, and it is the author's:

> **Its seven prompts do not go through `roles.ts`.** Every cinema model call funnels through one door (`index.ts`
> thinkAs) that writes `messages: [{ role: "system", content: o.system }, ...]` from inline constants — READ_SYSTEM,
> DIRECTOR_SYSTEM, REVISE_SYSTEM, PROPOSE_SYSTEM and four more. `principles-sweep` fails three ways on it: a system
> prompt written out, a model call that names no role, messages not built with `compose()`.
>
> The fix is to give each of the seven (`cinema.direct`, `cinema.revise`, `cinema.propose`, `cinema.picture.read`,
> `cinema.picture.check`, `cinema.check.still`, `cinema.check.take`) a role in `roles.ts` with a budget, an eval tier,
> a `prompt-sizes` entry and `evals/<role>.jsonl` with at least two fixtures, and have `thinkAs` compose from the role
> instead of taking a `system` string. **The 3D half already does exactly this** (`cinema_scene`, `cinema_eye`), so the
> pattern is in the same folder.
>
> A merge did not do it because moving those words into `compose()` changes what the models are told, and what they are
> told is what the films look like. That is a tuning decision, not a conflict resolution.

**Branches deliberately left alone**: `serene-lovelace-y9fcnj`, `keen-cori-wg8dpw`, `code-agent-core`,
`repo-analysis-verdict-6lpyaw`, `repos-deploy-analysis-w3uaxp`, `dreamy-franklin-rFLIX`. Each is 79 to 241 commits
behind a base from July to early November; merging one would undo months, not add to it.

**MIGRATIONS 0097, 0098, 0099, 0100 ARE ON THE LIVE DATABASE.** They went in by themselves, which is the whole point
of the arrangement: a deploy builds the new image before it touches the running server, and the image cannot be built
unless the migrations end well (`tulmi/supabase/migrate-pending.sh`, the `migrate` stage of the Dockerfile). The push of
`101ca707` built it at 14:00 on 16 November and the build said so — `migrations: running 0097 0098 0099 0100`, four
PASSes, `migrations: done` — and then the new container came up and the deploy's twelve live checks passed. So nobody
ran anything by hand, and nobody could have: the database address lives in `tulmi/.env` on the server and is given to
the build as a secret, so a laptop or a CI box skips this step entirely.

`LIVE_MIGRATION` is now `0100`, the last one known to be on the database. It had stayed at `0096`, which was not
dangerous — all four are guarded (`if not exists` throughout, and 0100's one policy is dropped if it exists first), so
re-running them changes nothing — but it meant every deploy did four pointless round trips and the build layer never
settled. **To put a migration live: write it, push it to main.** There is no hand step; the only hand step is moving
LIVE_MIGRATION afterwards, and the deploy log is where you read what happened.

- Native looks: the server draws the widgets, the Live Activity, the Android "Bots at work" notice and the keyboard's key
  faces (`docs/native-looks.md`). Every card shows its own bot.
- The bots' animation engine, format 2 (scenes), behind `BOTS_SCENES`.
- Location ("Use my location"), contacts (the phone's picker, no permission) and workouts (Apple Health / Health Connect),
  behind `PERM_LOCATION`, `PERM_CONTACT_PICK`, `PERM_HEALTH_IOS`, `PERM_HEALTH_ANDROID` (`docs/perms.md`).
- The runtime check: `tools/ci/check-runtime.mjs` and `app/native-inputs.lock` (phone). Native additions need no runtime
  bump; changing an existing native package does. Run `node tools/ci/check-runtime.mjs --write` after native changes.
- **Safety net** (one bad node cannot crash a screen; `sdui.safe` / `sdui.off` / `sdui.motion` switches; crash-loop safe
  mode), frontend `7ddcf31`. Not switched on until V1: the server sends no `sdui.*` knob yet.
- **Launch animation from the server**, frontend `7ddcf31`. It rides the bootstrap as `app.launch`. Launch **v5** (backend
  `41e9c38`) is the owner's original motion again (v1's, only `v` is new). Builds up to 8.9.1 give React Native their pivots
  as `transformOrigin` strings, whose parser drops decimals, so on those phones the gloves and feelers vanish while it plays
  (the owner chose this over an over-the-air update). Frontend `cba544d` on main gives numbers (`LaunchCurtain.tsx` `pivot`,
  guarded by `launchCore.test.ts`), so the NEXT store build draws all of it. **Before that build, bring the phone's own copy
  to v5** (held off main, because any push of `app/**` to main sends an over-the-air update): in TAILZU-FRONTEND run
  `node ../TAILZU-BACKEND/tulmi/scripts/gen-launch-starter.mjs`, restore `app/src/launch/launchCore.ts` and
  `launchCore.test.ts` from `2193692` (`git show 2193692:<path>`), keep the pivot test from `cba544d`, and push it WITH a
  native change. Until then `launchCore.test.ts` "the copy this build carries is the launch the backend generated it from"
  fails when the two repos sit side by side: expected, not a bug.
- **Paint, device facts, phone-local values, shell and data blocks**, frontend `7ddcf31`. Not switched on until V1: no
  screen can reach them.

## Landed: build 8.9.1 (14 Nov 2026; the three Android halves on, Health Connect and sleep off)

- **Build 8.9.1** (backend `e296bff`, frontend `84b67b0`). Calendar busy times and adding through the system editor, one
  "X0 Bot" Reminders list, the Focus Filter (iPhone) and Do Not Disturb (Android), steps and the driving check, sleep (Health /
  Health Connect), arrival reminders, App Attest / DeviceCheck / Play Integrity, and the server's abuse and fraud prevention
  signals (`docs/trust.md`; `TRUST` off, then shadow, then on; counted, never joined). The Android calendar, motion and arrival
  halves are behind build switches `TULMI_ANDROID_CALENDAR` / `_MOTION` / `_ARRIVAL` (**on in `preview` and `production`
  from 8.9.1**; `n0` is still the proof build, and Health Connect and sleep are the two that stay off) and their own server
  switches `PERM_*_ANDROID`. The Android release may not be uploaded until Play has approved the background-location
  declaration arrival needs, with its demo video. Migrations **0093** and **0094**. Owner steps:
  `TAILZU-BACKEND/docs/owner-8.9.1.md`. Every file it held is free again.
  Fixed on the server: `primed: true` (`shared/types/sdui.ts`) is set on the seven asks fired by our own explaining card's
  Continue (planCall `askMic`, `arrivalCard` and `keybotCard` mic, `notifyDesk` motion, `planItem` Android
  `backgroundLocation`, `keyboard_primer`, and the old onboarding voice step, whose ✕ is gone and whose pill now says
  Continue); every other ask keeps the phone's own box, which now names the permission (`experience/appKnobs.ts`
  `PERM_CARD_LABELS`). The asks that only existed to make iOS give the app a Settings page, and `flow_arm`'s ask on appear,
  read the permission first (`checkPermission`), so a phone that already allowed the microphone sees no box at all. Held by
  `tests/primed.test.ts`, which refuses both an unmarked ask behind our own card and a marked one anywhere else;
  `docs/perms.md` rule 2. The field is the phone's half only: the window and any build older than it draw no box.
- **8.9.1 store fixes** (backend `2af924d`). People no longer here: messages from a deleted account, or from someone the
  viewer no longer shares a space with, stay; the name is faded, says "No longer here" and opens nothing (`threads.ts` `gone`,
  `tests/spaces-gone.test.ts`). The About you card has Not now and saves with nothing filled in. The privacy policy names the
  AI services inline. The iPhone Meta knob is gone from the server. The AI permission card is unchanged ("Terms and privacy",
  the owner's decision). Owner checklist for both stores: `docs/owner-8.9.1.md` sections 7 and 7A.

## In progress

- Reviews of the pieces below may push small follow-up fixes to the same files.
- **The bot at the foot of Home, as what is happening** (server; `docs/home-updates.md`, behind `HOME_UPDATES`, off, staged by
  `HOME_UPDATES_USERS`; his ear is open the whole time Home is up, `HOME_LISTEN=false` shuts it). Instead of a box to type in, his thought holds what needs
  you, what your bots are working on and what just finished, each opening where it belongs. No microphone to press: his ear is open
  while the page is in front, and the key that opens the field is the one thing that shuts it (the ✕ beside the field gives it back;
  coming back by *speaking* is the wake word, which needs the apps). At rest he wears a mark, never a sentence, and nothing at all
  when there is nothing. He no longer stands in a white strip either: he lives behind the tab bar, only his head over the line, and
  jumps the ledge into full view now and then (`stand: "peek"` / `BotPeek`, the apps' `Peek` in botTiles' core; a tap anywhere in
  the room that is left opens what is happening). Three repos: the backend, TAILZU-FRONTEND and TAILZU-DESKTOP.
  Vocabulary 1, today's kit only. Built on `claude/keen-allen-podunv`, not on main yet. Holds
  `tulmi/src/experience/bots/screens/shell/homeUpdates.ts` (new), and the foot of Home in `screens/shell/home.ts` and
  `screens/shell.ts` (its load reads the activity feed only when the switch is on). It changes `homeThought.ts` not at all: with
  the switch off Home builds exactly as before.
- **Lingo, the language bot** (`docs/lingo.md`; switch `LINGO`, off). Re-added after a merge took it: the whole section was rewritten
  for 8.9.1 and git kept that side, so this entry went with it. Nothing of 8.9.1's is held here.
  ON MAIN and tested, nothing user-visible: the scheduler (FSRS), marking done on the SERVER and never in the app, the store, a
  session's seven kinds and the order they are asked in, sets whose difficulty follows the person, the shared sentence bank, the
  language picker (85 languages, the list is the server's), and seven routes under `/v1/lingo/`. 165 tests.
  Holds: `tulmi/src/lingo/**`, `tulmi/src/routes/bots/lingo.ts`, `tulmi/scripts/lingo-seed.ts`, `tulmi/tests/lingo-*.test.ts`,
  migrations **0087**, **0089**, **0092**.
  Its `l.*` moments are in `shared/bots/looks.json` (v5) and its four screens in `experience/bots/screens/bots/lingoPage.ts`,
  **vocabulary 1** so a lesson can never answer "Open X0 again". One gesture per grader reason, so the movement carries the
  information: the missing accent plucked out of the air and set over the word, the wrong letter spat out and the right one caught,
  two cards swapped for the wrong order, the right word mouthed slowly, a hand cupped to the ear when nothing was heard. Two more are
  idlings on a loop, asked for by its own screens and in nobody's `idle.moments`: `l.mutter` and `l.hum`. The territory wears one of
  them instead of a heading — Lingo alive across the top of the page, muttering while a word is due anywhere, humming once nothing
  is. Holds `shared/bots/looks.json` and, generated from it, `TAILZU-FRONTEND/app/src/botTiles/starter.ts` and
  `TAILZU-DESKTOP/botLooks.js` (`node src/botTiles/genStarter.mjs` in TAILZU-FRONTEND/app writes both).
  **The words gap is closed.** There was nowhere to ask Lingo anything — its tile opens the territory, not the shared
  bot page, and no screen of its own carried a chat bar — so the bot whose whole point is conversation could not be
  spoken to. The territory has one now, and `lingo_note_words` (`src/lingo/tool.ts`, Lingo's and no other bot's) is the
  one thing that chat can do besides talk: a word they reached for goes into the course, with how they met it, and a
  word already there keeps its whole history.
  The exercises are a grid now rather than a line — a word, an utterance, a turn of conversation, each asked both ways
  — so `reply` and `speak` are new and `talk` is real: marked on whether the word came out inside something of their
  own, not on saying it back. And a dry course draws short sentences from the shared bank first (`seed`), which
  `unseen` already ranks behind anything they reached for themselves.
  Next: the call that rings the phone to practise speaking; answer speed into the scheduler (it needs the time
  measured, which is an app change or another column); and a word earning its place by being reached for twice rather
  than once.
  **A colour question that was open here is now answered and done** (`6222f21`): `bots/builtin.ts` and `experience/bots/palette.ts`
  each carried their own copy of the four shipped bots' colours and had disagreed for as long as both existed — builtin.ts said Xode
  was pine while palette.ts drew it moss. palette.ts keeps the icons and reads the colour from builtin.ts now, and builtin.ts was set
  to the colours people actually SEE, so nothing shipped changed appearance; the API stopped contradicting the screen. Meetings moved
  off moss to pine, and Lingo wears `ash`, a neutral kept in `SHIPPED_ONLY` and out of `PALETTE` so it is never offered to anybody —
  in the palette it would change which colour `colourFor` hands every future bot a person makes. **The Oracle and the meeting bot
  still have no icon of their own** and get the generic `spark`: one line each in `palette.ts` `BUILTIN_ICON` when somebody wants to
  choose them. Not mine to pick.

## In progress (started 15 Nov 2026)

- **The brief: the document the bot makes while a meeting runs** (`docs/brief.md`; switch `MEETING_BRIEF`, off; migration **0095**).
  A meeting left a note behind — what was said. The brief is what it was about, written as it happens: the overview, the flow they
  described DRAWN, the numbers charted, the options as a table, what was decided, who does what, what is still open. Its blocks are
  the ones a bot already draws under its words (`src/show`), so nothing is new in the apps. It grows in edits, never rewrites, one
  model call a pass on the meeting's own tick, with a last pass when the meeting ends; the one line it may have for the people goes
  to the call's chat.
  **On main and tested, both halves.** Recall's meetings (`meet/service.ts`) and **our own calls**: the bot takes its seat with the
  first person in, hears the call through the SFU's WebSocket adapter (one a person, 48 kHz PCM, so who said what is never
  guessed), writes the note, makes the document, answers when asked, and on the last person out writes the last pass and
  organises the note. The call screen says it is there and draws the document beside the call (a window) or under it (a phone),
  and the link everyone joined by carries the document once the call is over — all server data, nothing new in either app.
  Migrations **0095** (meetings.brief) and **0096** (rooms.note_id, rooms.brief). Switch `MEETING_BRIEF`, off.
  **It speaks, too**: a session and a track of its own at the SFU (the same adapter the other way, `location: "local"`), a seat in
  the room that never beats and counts as nobody, the words read as 24 kHz PCM and let out in 20 ms frames — so every app hears
  it as it hears a person. And it answers to its name: a line that starts with "X0" is a question, out loud and in writing.

  Holds: `tulmi/src/brief/**`, `tulmi/src/rooms/**`, `tulmi/src/meet/**`, `tulmi/src/experience/bots/screens/bots/{meetScreens,callRoom}.ts`,
  the `MEETING_BRIEF*` lines of `config.ts`, migrations **0095** and **0096**, `docs/brief.md`.

- **One month to spend as you like** (`docs/bots-app.md` 12 and 12a). The month was cut into five "stretches" (4, 5, 6, 7 days
  then the rest), so a person could be refused on a Tuesday with two thirds of the month unspent. Now one allowance for the
  month, the same total as the five summed: Lite $35, Elite $450, Free $3. `USAGE_STRETCHES` (off) puts the windows back, and
  every screen already had the "this month" wording, so none of it needed an app update. What the stretch was quietly doing, a
  **burn brake** does on its own: a ceiling per hour of about ten heavy hours' spend (`USAGE_BURN_TIMES`, 48 — Lite $2.33/hour,
  Elite $30), so a looping job stops in an hour instead of eating the month. It is never advertised and meeting it says the
  server is busy, never that you have run out. A free account is no longer held to one request at a time; an account the
  signals slow down still gets exactly one, through `perUserSlowed`. 12a lists every per-day cap left and what must happen
  before each can go — several are the only brake on surfaces whose spend is not on the meter yet.

- **Sharing a plan with friends and family** (`docs/plan-share.md`; switch `PLAN_SHARE`, off, with `PLAN_SHARE_USERS`;
  migration **0096**). A plan is a month's allowance on ONE account, so sharing it means other accounts draw on that SAME
  allowance: one shared pot, no seat price and no seat count. `payerFor(userId)` (`src/billing/planShare.ts`) is the one rule —
  their own live plan always wins, only someone with none draws on another's — and the whole meter is keyed on its answer at
  two points and no others, `Spending.read` and `Spending.record`, so a member's spend lands on the owner's month. Spaces only
  (no email, no link, no code), nobody across a block, nothing about anybody else's money on any screen, and a held account may
  neither share, be shared with, nor ask. A `promised` ask becomes a real share the moment a plan is bought.
  **All of it is on main and tested** (`tests/plan-share.test.ts`, `tests/bots-plan-share.test.ts`, `tests/widgets.test.ts`):
  the store and routes, the screens (You > Plan and billing's sharing card, `bots.plan.share`, the row on a person's page, the
  second way out of the refused screen), the ask in Activity, and the notification's Share / Not now, which answers through
  `/v1/widgets/act` as `psa:<askId>`. Migration 0096 was run against a real Postgres 16, twice, to check it is safe to re-run.
  Also here: the usage gate `metering.enforceQuota` asks now answers a whole 429 body, not a sentence, so the **burn brake**
  guards Keylessbord's dictation and rewrites, the old Ask, notes and the front door too — with the `overloaded` code and the
  busy words, never the quota ones. It only ever guarded the bots platform and Xode's jobs before.
  Holds: `tulmi/src/billing/planShare.ts`, `tulmi/src/routes/bots/botsPlanShare.ts`, `tulmi/src/you/{limits,store}.ts`,
  `tulmi/src/usage/metering.ts` and its callers, the `PLAN_SHARE*` lines of `config.ts`, migration **0096**,
  `docs/plan-share.md`.

## Landed 14 Nov 2026 (all switched off)

- **The window asks on the card, where the phone asks** (`docs/window-setup.md`). The flow is the same on both — BOTS_APP is on,
  both builds declare `BotsKit`, so sign-in goes straight to Home and the asks are cards over a blurred Home. The two steps this
  session had added to the `onboard` screen (the window's terms and permissions) are **out again**: that screen is the older flow,
  for builds without `BotsKit`, and it is exactly what it was. What the window needs went onto the **arrival card** instead: its one
  Mac step now carries both switches as rows — typing for you, and answering about your screen, which was missing altogether — each
  named for what it does, with the Mac's own names in the line under them. The camera is asked for by the moment-of-need card when a
  call turns one on, never up front. One test of the primed walk went with the step it covered.

- **The permission card, over the app, where it was missed** (`docs/window-setup.md`, "When it is missed later"). The card the phone
  has, in the window: one permission, the page behind it blurred (the overlay `BotCard`'s veil), put up when a paste is refused for
  want of Accessibility, when Ask's look is refused for want of Screen Recording, when a call cannot open the microphone or the
  camera, and in place of the toast when a permissions row is refused for good. Only while the window is on screen; the main
  process keeps its notification for when it is not. It asks the system itself wherever the system will ask, and opens that
  computer's own page where it will not — `ms-settings:privacy-microphone` and `privacy-webcam` are new, so Windows is no longer a
  dead end. Words: `appKnobsData.ts` `desktop.perm.*`.

- **The window's terms and permissions, after onboarding** (`docs/window-setup.md`). A window finished its onboarding having agreed
  to nothing and granted nothing: `postAuthSteps` left Make me yours out ("the OS asks") and the AI permission is asked for by a Home
  card a window that lands on the desk never sees, so the first thing the person tried was refused by the gate. Two steps of the same
  stage Blip already walks through, between Languages and Try it — **Terms and privacy** (`onboard/terms.ts`: the phone's two answers
  and the same `PUT /v1/you/ai-consent`; Not now skips Try it, which the gate would refuse) and **Let me in, once**
  (`onboard/perms.ts`: a row each for the microphone, the camera, Accessibility and Screen recording, drawn only where the window
  declared the capability that reads it, and the Mac's two only on a Mac) — plus **Send to AI services** in the desk's
  Settings › Privacy and data, so the terms' promise is true there. Nothing is drawn or asked for on a phone; Make me yours, the Home
  card and the phone's permissions are exactly as they were.
  In the window: `NSCameraUsageDescription` and the camera entitlement (without which a hardened build is refused the camera, so the
  video half of a call could not work there at all), `app:camStatus` and `app:seeStatus` in the main process, `camReading`/`camFollow`,
  `seeReading`/`seeFollow` and `askCam` in the renderer, and the capabilities `DeskCamAsk` and `DeskSeeState`.

- **Calls, end to end** (`docs/rooms.md`): our own video and audio calls from the mail bot, on Cloudflare's Realtime SFU, and the
  **`call` block** (the 14th) that lets the apps be in one. Migration **0091**; settings `SFU_APP_ID` / `SFU_APP_SECRET` / `ROOM_*`,
  all off, so nothing is drawn until the owner turns them on. The kernel's block list grew by one, so
  `TAILZU-DESKTOP/src/app/sdui/kernel.js` and `TAILZU-BACKEND/shared/sdui/kernel.cjs` were regenerated
  (`node src/sdui/kernel/genKernel.mjs`). `BotsCtx` now carries `blocks`, the vocabulary-2 blocks the asking client really has, so a
  builder can tell before it writes a screen that states `needs`.

- Screen vocabulary 2 connected: phone renderer wiring (`app/src/sdui/blocks/**`, Renderer, actions, state), the server's
  checker (`tulmi/src/experience/sdui2/**`, switch `SDUI_V2` / `SDUI_V2_USERS`) and the window (`src/app/sdui/v2/**`).
  How to use it: `docs/renderer.md` section 3.
- Reply to a bot from its notification (`tulmi/src/bots/notifyReply.ts`, route `POST /v1/bots/:slug/notify-reply`,
  category `x0_bot_reply`, switch `NOTIFY_REPLY` / `NOTIFY_REPLY_USERS` / `NOTIFY_REPLY_PER_HOUR`). Server only.
- **What a bot draws under its words** (`docs/show.md`, switch `BOT_SHOW` / `BOT_SHOW_USERS`). Server only, vocabulary 1, so
  every build draws it with no release. After a bot answers in its chat, the `bot_show` role picks building blocks or none (a
  choice to tap, a callout, steps, a table, a chart, next questions, a form, a drawing), drawn as monochrome dot art whose
  pieces spring in on `Rise` on the newest answer, with Blip beside a drawing now and then. Why it is not vocabulary 2: the
  note below.
- The render check draws the phone again: `local.ts` requires `react-native-mmkv` and trusts what `createMMKV` returns, and
  `scripts/bots-render`'s catch-all stub answers null, so the first `local.*` read threw and the screen came out blank. The
  tool now stands in for a phone without MMKV (`phone/no-mmkv.js`), so the app takes its own AsyncStorage fallback. The phone
  itself would do the same on any binary where that require resolves but the native side is missing: `mmkvKV()` catches a
  failed require, not a `createMMKV` that answers nothing (`docs/renderer.md` section 7.2 asks for the `typeof` check). One
  line in the phone's court; not touched here.

## Numbers in use

- Migrations: 0087 lingo, 0088 native looks, 0089 lingo sentences, 0090 bot health days, 0091 rooms, 0092 lingo left,
  0093 trust signals, 0094 phone things, 0095 the meeting's brief, 0096 plan share, 0097 a call's note and brief,
  0098 a browser that belongs to the person, 0099 discover, 0100 Xode's standing job. **These are live.**
  Then, merged but NOT yet on the live database: 0101 the cinema's films, 0102 bot sessions, 0103 the cinema's places,
  0104 the cinema's 3D creations, 0105 what a learner wants a language FOR (another session's). They go in by
  themselves on the next deploy, and LIVE_MIGRATION moves to 0105 after.
  Next free: **0106**. Take the next free number and check both
  `git log origin/main -- tulmi/supabase/migrations` and the open branches first:
  sessions have collided three times now, and the third one nearly shipped.

  **The third collision, and what it teaches.** A call's note and brief was written as a second `0096` while
  `LIVE_MIGRATION` was already `0096`. `migrate-pending.sh` keeps a file only when its number is GREATER than that,
  so it was not pending, would never have run, and the deploy would have said there was nothing to do — the tables
  missing and the code that wants them failing at runtime, with nothing anywhere saying why. Renamed to
  `0097_room_brief.sql`, which the runner now picks up; it is two `add column if not exists`, so running it is safe
  whatever already reached the database. **A duplicate number does not fail loudly, it fails silently** — which is
  why the list above is worth keeping straight.
- Phone runtime: `tailzu-2026-11-x0-blip`. Do not change it.

## Notes from other sessions

- **16 Nov, the cloud browser, read-only half (`docs/sites.md`, `CLOUD_BROWSER` — off), on main.** A browser per
  person, signed in once, read when there is a reason: "where is my order" for a site with no API. Built:
  `src/sites/` (gate, store, service), `engine.visit()` in `src/web/browser/engine.ts`, the `site_read` role,
  migration **0098**, `tests/sites.test.ts`. The routes, the screens, the clock and signing in are all built now
  (see 16 Nov above); the whole feature is still behind `CLOUD_BROWSER`, off, which is why it is safe on main.
  **Not built: a run against a real site.** Every test uses a fake browser.
  Two things worth knowing before touching it. `CLOUD_BROWSER_SITES` is **empty means NONE**, inverted from every
  other list in the config on purpose. And the browser keeps nothing between visits: a fresh context filled from
  the saved session each time, so there is no live login anywhere and a crash costs a visit, not a sign-in.

- **16 Nov, the cloud browser can now be SIGNED IN, and the whole panel is server side (`docs/sites.md`).** On main,
  behind `CLOUD_BROWSER`, still off. The panel is a **page this server writes** (`src/sites/panelHost.ts`) shown in the
  `LiveView` node the apps already have — NOT a component of their own, which it nearly was. The reason is worth keeping:
  a component ships in a store build, and a store build is weeks. As a page, the frame clock, the tap arithmetic and the
  keyboard all ship when this server deploys, **and a phone that has never heard of sites can draw one today, with no app
  update at all.** Screen `bots.site.signin`; its own load is what opens the browser, so a build with no LiveView is sent
  no panel and opens none either.
  The page is given a **ticket**: one panel, nothing else, dead when the panel is, written into the HTML and nowhere else.
  A LiveView cannot see the app's token (SecureStore, behind the Keystore) and must not be handed one. The four ticket
  routes live under `/sites/panel/t/:ticket`, answer `Access-Control-Allow-Origin: *` and take no cookie — safe precisely
  because the ticket is the whole of the authority, and needed because Android gives an HTML-with-base-URL page an origin
  that is sometimes opaque. The screen is `keep: false`, so the ticket never reaches AsyncStorage.
  Nothing typed is kept: the box is emptied *before* each call goes out, so a password is in the page for one keystroke.
  Driven in real Chromium against a fake API: a tap at the frame's centre arrives within one pixel of the page's centre,
  a drag scrolls, Backspace on an empty box sends the key, the quiet clock holds at 700 ms and the asks stop when it ends.

- **15 Nov, the sign-in card (`docs/sign-in.md`), backend only, on main.** The planner can now describe a sign-in page's
  real boxes instead of only saying "sign in, then press Continue": `FIELD <id> <kind> | <label>` and `ALSO <id> | <label>`
  lines before a `HANDOVER`, which arrive on the `handover` event as `card`. Nothing is written per site — the boxes are
  read off `<screen>`, so a shop nobody has coded for works like one that was. The seven rules ride only on a screen that
  looks like a sign-in (`looksLikeSignIn`), the way `JOB_NOTE` does, so the stable block pays two verb lines and nothing else.
  Never a card for a payment or a CAPTCHA, and no boxes means no card, which shows them the page — so a client that ignores
  `card` behaves exactly as it does today. **The drawing of it is not built**: that is the desktop app, and the cloud browser
  when it exists. Until then every `FIELD` line still ends in a correct plain handover.

- **The planner's stable block is nearly full: 4889 of its 4904 budget** (`tests/principles.test.ts`, "stays inside its
  budget"). Fifteen characters. The budget is "measured + 10%" and the measured figure in that table, 4458, is long out of
  date — the block has drifted ~430 characters since someone last wrote it down. The next line anyone adds to
  `ROLES.ask_planner` will fail that test. Before raising the number, check the new text could not ride in a note at the
  head of the step instead (`JOB_NOTE`, `CONTEXT_NOTE`, `SIGN_IN_NOTE`), which is what the sign-in rules do and what the
  budget is there to make you ask. If it truly belongs in the block, re-measure and set the entry to measured + 10%,
  with the real measured figure in the comment.


- A wake word ("hey X0" with the microphone otherwise shut) and a press-and-hold on the walking bot are the two things the foot of
  Home cannot do from the server. The hold wants only the `gesture` block (SPEC 2.5) once `SDUI_V2` is on and the builds that carry
  it are out — no new app code. The wake word is native work in both apps (local listening, a permission, battery, review); nobody
  is building it.
- **14 Nov, from the window-permissions session:** the `perm-words.test.ts` failure over `NSHealthUpdateUsageDescription` is
  fixed by 8.9.1: the test now expects the string and checks it says only that nothing is written.
- **The bot drawings stay vocabulary 1, and that is now a decision, not a wait.** Yesterday's note said they would move to the
  `motion` block as soon as it could reach a screen. Reading `sdui2/gate.ts`: `needs` is worked out per SCREEN and a client
  missing a block is sent "Open X0 again" instead of the screen, never a lowered one. A chat must never do that for decoration,
  so the drawings keep `Rise`, which every build already draws, and the chat stays vocabulary 1 for everyone.
  Moving them to `motion` is still worth doing, but only emitted FOR CLIENTS THAT HAVE THE BLOCK (the screen is then
  vocabulary 2 for them alone and the gate passes), and only once `SDUI_V2` is on and the store build with the blocks is out.
  It would want `blocks` on `BotsCtx` (`experience/bots/kit.ts`, `registry.ts`, `screens.ts`), which the drawings do not touch
  today. What it buys: the window gets real springs (its v2 `motion` simulates one; a Rise there is a CSS ease), and fewer
  nodes. Say here when `SDUI_V2` goes on and I will do it.
- Calls, server side, are **on main** (`docs/rooms.md`, migration **0091**, settings `SFU_APP_ID` / `SFU_APP_SECRET` / `ROOM_*`, all
  off). Cloudflare's Realtime SFU carries the media: $0.05/GB out with the first 1,000 GB free, no per-minute charge, no webhook, and the
  App Secret never leaves the server. Joining from the apps is L1 above.