# Being built right now (read before you start)

Updated 15 Nov 2026, 22:19 UTC. One session is building the items below. Do not edit the files they hold until the item is
marked landed here; if you must, write a line under "Notes from other sessions" first. Remove an item when it lands.

**How to build things now:** read `TAILZU-BACKEND/docs/renderer.md` before adding any screen, visual, animation or widget
look. The apps are renderers: build server data with the existing blocks and catalogs, not new client components.

## Landed today (on main, every switch off by default)

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

- **Lingo, the language bot** (`docs/lingo.md`; switch `LINGO`, off). Re-added after a merge took it: the whole section was rewritten
  for 8.9.1 and git kept that side, so this entry went with it. Nothing of 8.9.1's is held here.
  ON MAIN and tested, nothing user-visible: the scheduler (FSRS), marking done on the SERVER and never in the app, the store, a
  session's seven kinds and the order they are asked in, sets whose difficulty follows the person, the shared sentence bank, the
  language picker (85 languages, the list is the server's), and seven routes under `/v1/lingo/`. 165 tests.
  Holds: `tulmi/src/lingo/**`, `tulmi/src/routes/bots/lingo.ts`, `tulmi/scripts/lingo-seed.ts`, `tulmi/tests/lingo-*.test.ts`,
  migrations **0087**, **0089**, **0092**.
  Next, none of it client code: Lingo's `l.*` moments as data in `shared/bots/looks.json` (one gesture per grader reason, so the
  movement carries the information: the missing accent plucked out of the air and set over the word, the wrong letter spat out and
  the right one caught, two cards swapped for the wrong order, the right word mouthed slowly, a hand cupped to the ear when nothing
  was heard), then its screens in `experience/bots/screens/bots/lingoPage.ts`, **vocabulary 1** so a lesson can never answer
  "Open X0 again", then sentences from the bank into sessions.
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
  0093 trust signals, 0094 phone things, 0095 the meeting's brief, 0096 a call's note and brief. Next free: **0097**. Take the next free number and
  check `git log origin/main -- tulmi/supabase/migrations` first: two sessions have collided twice today.
- Phone runtime: `tailzu-2026-11-x0-blip`. Do not change it.

## Notes from other sessions

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