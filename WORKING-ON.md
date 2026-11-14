# Being built right now (read before you start)

Updated 14 Nov 2026, 15:50 UTC. One session is building the items below. Do not edit the files they hold until the item is
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
- **Launch animation from the server**, frontend `7ddcf31`. It rides the bootstrap as `app.launch`.
- **Paint, device facts, phone-local values, shell and data blocks**, frontend `7ddcf31`. Not switched on until V1: no
  screen can reach them.

## Landed: build 8.9.1 (14 Nov 2026, every switch off)

- **Build 8.9.1** (backend `e296bff`, frontend `84b67b0`). Calendar busy times and adding through the system editor, one
  "X0 Bot" Reminders list, the Focus Filter (iPhone) and Do Not Disturb (Android), steps and the driving check, sleep (Health /
  Health Connect), arrival reminders, App Attest / DeviceCheck / Play Integrity, and the server's abuse and fraud prevention
  signals (`docs/trust.md`; `TRUST` off, then shadow, then on; counted, never joined). The Android calendar, motion and arrival
  halves are behind build switches `TULMI_ANDROID_CALENDAR` / `_MOTION` / `_ARRIVAL` (off in every shipping profile; `n0` is the
  proof build) and their own server switches `PERM_*_ANDROID`. Migrations **0093** and **0094**. Owner steps:
  `TAILZU-BACKEND/docs/owner-8.9.1.md`. Every file it held is free again.
  Open, a decision and not a bug: a server permission card is followed by the phone's own "One permission first" card, because
  `app/src/sdui/actions.ts` skips its `primedCard` only on `primed: true` and the server never sends it (not in the contract).
  One card too many, still one Continue path; adding `primed` is a contract field plus a lint rule.

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

## Landed 14 Nov 2026 (all switched off)

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
  0093 trust signals, 0094 phone things. Next free: **0095**. Take the next free number and
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