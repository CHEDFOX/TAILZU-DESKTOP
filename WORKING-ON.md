# Being built right now (read before you start)

Updated 16 Nov 2026, 14:40 UTC. One session is building the items below. Do not edit the files they hold until the item is

marked landed here; if you must, write a line under "Notes from other sessions" first. Remove an item when it lands.

**How to build things now:** read `TAILZU-BACKEND/docs/renderer.md` before adding any screen, visual, animation or widget
look. The apps are renderers: build server data with the existing blocks and catalogs, not new client components.

## Landed today (on main, every switch off by default)

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

* **Lingo — a course cannot get any words.** (Still true after another session's 16 Nov work, which added what a
  learner wants the language FOR and fixed the language picker — migration 0105 — but did not touch this.) Everything downstream is built and tested: the scheduler, marking on the
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
  Next: sentences from the bank into sessions, and the call that rings the phone to practise speaking.
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