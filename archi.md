# X0 Bot desktop: architecture

X0 Bot for Windows, macOS (and a Linux AppImage) is an Electron app in plain
JavaScript, with no bundler. It does five things:

- **Dictation on one key.** Hold the key (Right ⌘ on a Mac, Fn on one that
  already had it; Right Ctrl on Windows and Linux), talk, let go: the words are
  cleaned by the server and pasted into the text box in front, or sent to Ask,
  to meeting notes, to a routine or to a bot, whichever was meant.
- **Ask, the on-screen agent.** A question about the app in front: the guide
  rings the thing, explains it, or does a small job, asking first before
  anything that sends, deletes or pays.
- **Meeting notes.** A hidden recorder hears the microphone and, on a Mac, the
  computer's sound, and uploads it in stretches for the server to organise.
- **The app window.** Every screen is JSON from the server, drawn by a renderer
  of the server's node kinds (the same catalog the phone apps draw).
- **The runner.** With the person's say-so, this computer runs the commands of
  Xode's live sessions (tests, builds, a dev server) in a guarded workspace.

The server (TAILZU-BACKEND) decides almost everything the app shows: words,
numbers and switches arrive as *knobs* in the bootstrap, and screens arrive as
JSON, so most changes ship without an installer.

## Layout

```
package.json            entry point (main), npm scripts, electron-builder config (build.files)
README.md               what the app does, configuration, permissions, use
RELEASE.md              building, signing, publishing; release notes
archi.md                this file
config.example.json     a dev config.json (only baseUrl)
knobs.js                the server's values (txt/num/bool/...), shared by the main process and every page
botTiles.js             GENERATED: the living bot tiles' physics and drawing (from TAILZU-FRONTEND)
botLooks.js             GENERATED: the bots' looks and moments, the starter catalog (from TAILZU-FRONTEND)

src/
  main/                 the Electron main process
    main.js             entry: lifecycle, config, session, bootstrap, windows, tray, keys, paste, IPC
    preload.js          the bridges every window of ours gets (window.tailzu, tailzuApp, ...)
    windows.js          web preferences, hardening, and the floating windows' bounds
    shell.js            the tray's and notifications' built-in words, and their merge with the server's
    oauth.js            Apple/Google sign-in without a window: authorize URL, loopback page, code exchange
    links.js            which screen a tulmi:// link may open
    updater.js          in-place updates: download, verify SHA-512, swap, restart
    testkit.js          for tests: main.js run whole with Electron faked (not shipped)

  dictation/            one-key dictation
    oneKey.js           the one key: choice and first default per OS, the Fn helper's protocol, the hold/tap gesture
    tapDetector.js      double-tap on a modifier without false positives
    router.js           where the words go (type, Ask, notes, a bot), from cheap local signals
    routing.js          doing it, session by session; the server's brain when on; undoing pastes ("Ask instead")
    pasteJoin.js        the space, or none, between two pasted stretches
    recorder/           the hidden recorder window (microphone, batch and live capture)
      recorder.html     the page; loads the parts below in order
      core.js           the session's state and the main process's messages
      bands.js          the voice, band by band, for the pill
      pauseFlush.js     the level watch: a pause writes what was said so far
      stretches.js      stretches in order; what is sent to main; the token; teardown
      mic.js            opening the microphone; failure wording
      refine.js         the live path's fallback (POST /v1/refine)
      batch.js          MediaRecorder, webm, POST /v1/transcribe-clean
      live.js           WebAudio, 16 kHz PCM, WS /v1/transcribe-stream (captions)
      heldStop.js       a full stop held at a pause until the next stretch decides
      testkit.js        for tests: recorder.html's scripts in order (not shipped)
    restSpot.js         where Blip rests between dictations (the screen's right edge) and when
    rest/               the rest window: Blip behind the edge, his antennae out, peeking now and then, ducking from the pointer
    pill/               the dictation pill at the foot of the screen
      pill.html         the page; shared/blip.js, then core, frame, capsule, bots (with Blip), pointer,
                        start, demo in order
      pillSplit.js      the split pill's geometry and spring (no drawing)
    overlay/            the live-caption strip (when the pill is off)

  context/              what the person is looking at
    frontApp.js         the app in front, the focused field, the text around it (AppleScript / PowerShell)
    screenRead.js       the screen's text: accessibility first, on-device OCR to fill the gaps
    pageRead.js         the whole page, off-screen parts included, for understanding (never acted on):
                        the helper's page read, a screen at a time when that is thin; cut for the server

  agent/                Ask
    ask.js              createAsk: the guide's window, the question's microphone, the agent's hands
    run/                the run on this computer
      agent.js          createAgent: the loop (read the screen, ask /v1/agent, point, say, act); long jobs, handover
      screen.js         the elements sent (coarse regions, no URL queries)
      picture.js        OCR lines as elements; the crop a picture question sends
      marks.js          what an answer draws, mapped to screen positions
      changes.js        what an action changed; where focus went
      risk.js           the device's own risk rating (it only ever raises the server's)
      actions.js        an action in words: history line, confirm sentence, progress
      stream.js         the step request and its NDJSON event stream
      text.js           the guide's words when a run stops here
      approval.js       the server's confirm card for a connected app
      openLink.js       the "open" event: the only links a run may open
      helpers.js        shared small helpers
    resolver.js         instant answers: "where's Export?" matched on the device
    localfiles.js       "This computer": Ask's file operations, guarded
    folderSettings.js   the allowed folders (Settings row)
    peek.js             Blip over the text box while dictating: the caret watch
    askSetup.js         the one-time setup card's main-process side
    pillAsk.js          what a question may do with the pill; the capsule's rectangle
    driver/             the screen's buttons and fields, per OS
      driver.js         picks the driver for this platform
      axDriver.js       macOS: talks to native/tzax.swift (accessibility, look, caret)
      uiaDriver.js      Windows: talks to native/uia-agent.ps1 (UI Automation, OCR, caret)
      page.js           a "page" answer (the window's whole text) as callers see it, from either helper
      fixtures/         fake helpers the driver tests run against
    guide/              the guide window: card, ring, thread, Blip, marks
      guide.html        the page; core, placement, card, ring, tether, peek, pen, frame, speech,
                        messages, demo in order (guide.html?demo is the review page)

  notes/                meeting notes
    notes.html          the hidden notes window
    notesRecorder.js    two tracks (mic, computer sound), recorded in stretches and whole
    notesCore.js        what to upload, in what order, and what to do on failure

  app/                  the app window, drawn by the server
    app.html            the window; its fonts, CSS and scripts in load order
    sdui/               the renderer, one file per part (core.js first, boot.js last)
      core.js           constants, the node kinds this build draws, the window's state
      auth.js           Supabase email/phone codes, the session, error wording
      backend.js        capability handshake, authorised requests, bootstrap, fetching a screen
      theme.js          theme, labels, conditions, style to CSS
      nodes.js          node(): one server node to markup
      askSetupCard.js   DeskAskSetup     folders.js   DeskFolders
      bots.js           BotTiles, BotCard, BotBuddy (with ../../botTiles.js)
      homeHead.js       WriteOn, LiveMark, HeadBar
      chat.js           ChatThread       voice.js     the in-page mic and the spoken session
      charts.js         word meter, pie, bars
      onboarding.js     OnboardStage, BlipSpot      signIn.js    the sign-in screen's pieces
      paying.js         checkout, entitlement, one-click update
      refresh.js        the data tabs refreshed on return   permissions.js  mic/Accessibility answers
      actions.js        run(): what an action does, and the toast
      askStream.js      an answer written as it streams      connectors.js  connecting an app
      navigation.js     go, back, tabs, paint(), repaint()
      field.js          the neural field (neuralField.html in a frame)
      chrome.js         flip lines, tabs, masthead, the look, the first frame
      gate.js           the sign-in gate      boot.js   where the window lands; the start
    media.js            send a file, play a sound
    linkSignIn.js       sign in with the phone (QR)
    shareIn.js          files, links or text dropped on the window
    live.js             live updates over /v1/live
    liveView.js         a running page in a webview (liveViewMain.js: its main-process half;
                        liveViewGuest.js: the webview's preload)
    outbox.js           offline: the outbox and the Offline page
    runnerCard.js       the runner's card on the server's page
    remoteFonts.js      faces the server supplies
    neuralField.html    the neural field page (generated by scripts/gen-field.js)
    fixtures/           server trees the renderer tests draw
    testkit.js          for tests: app.html's scripts in order (not shipped)

  runner/               Xode's live runner on this computer
    index.js            createRunner: the switch, presence socket, jobs, Stop
    protocol.js presence.js ws.js session.js   the backend's runner protocol
    workspace.js gitrun.js overlay.js changes.js search.js   the per-project checkout
    exec.js env.js guard.js docker.js procs.js watchdog.js redact.js   running commands safely
    preview.js          the dev server for the design round
    power.js allow.js audit.js activity.js   battery, per-project consent, audit log, activity
    runner.html ui.js   the runner's own window (when the server's page is not used)
    testkit.js          for tests (not shipped)

  shared/               used by more than one window
    blip.js             Blip, drawn in dots (guide, app window, pill); one file, see "Contracts"
    speechMeter.js      voice versus breath, keys or hum (recorder, notes)

native/                 helpers built per OS (not JavaScript)
  tzax.swift            macOS accessibility, look and caret helper (npm run tzax)
  tzocr.swift           macOS Vision OCR (npm run tzocr)
  tzkey.swift           macOS Fn key watcher (npm run tzkey)
  audiotap.swift        macOS system-audio capture for notes (npm run audiotap)
  uia-agent.ps1         Windows UI Automation, OCR and caret helper
  ocr-test.png          the image CI reads with both OCR engines

scripts/                run by hand or by CI, never shipped
  gen-icon.js           the tray icons (npm run icon)
  gen-app-icon.py       every app icon from the master picture
  gen-field.js          neuralField.html from TAILZU-FRONTEND's page (npm run field)
  nativeCheck.js        CI: the Mac and Windows helpers, run where they can be

test/
  paths.test.js         every relative path resolves; everything loaded is shipped, nothing else

assets/                 fonts (OFL), tray and app icons
build/                  electron-builder resources: icon.ico, entitlements, NSIS include, Store tiles
docs/microsoft-store.md the Store listing
.github/workflows/build.yml   installers for macOS, Windows and Linux; publishing on a manual run
```

Unit tests sit beside the code they test (`x.test.js` next to `x.js`); `test/`
holds checks of the repository as a whole.

## Where to find

| What | Where |
| --- | --- |
| Main process entry | `src/main/main.js` (sections, in order: Store folder, Config, Session, Bootstrap, Server-drawn chrome, Updates, Tone, Apple/Google, recorder window, app window, pill, tray, Notes, runner, app-window IPC, Dictation toggle, Hold-to-talk, the one key, Paste, Ask, routing, recorder IPC, lifecycle, links) |
| Preload bridges | `src/main/preload.js` |
| Window creation and hardening | `src/main/windows.js`; each `loadFile` in `main.js` and `ask.js` |
| Dictation hotkey | `main.js` "Dictation toggle", "Hold-to-talk", "The one key"; `src/dictation/oneKey.js`, `tapDetector.js`; `native/tzkey.swift` |
| Recording | `src/dictation/recorder/` |
| Where the words go | `src/dictation/router.js` (decide), `routing.js` (do; the brain); `main.js` "routing" (`decide`, `needGrant`) |
| Paste | `main.js` "Paste into the focused app"; `src/dictation/pasteJoin.js` |
| The pill / captions | `src/dictation/pill/`, `src/dictation/overlay/` |
| App and field in front | `src/context/frontApp.js`, `screenRead.js` |
| Ask (agent) | `src/agent/ask.js`, `src/agent/run/agent.js`, `src/agent/guide/` |
| Reading and acting on the screen | `src/agent/driver/`, `native/tzax.swift`, `native/uia-agent.ps1` |
| The whole page (understanding, not acting) | `src/context/pageRead.js`; the helpers' "page" command and `src/agent/driver/page.js`; step 0's `page` in `src/agent/run/agent.js` |
| Ask's file operations | `src/agent/localfiles.js`, `folderSettings.js` |
| Notes | `src/notes/`; `main.js` "Notes"; `native/audiotap.swift` |
| Server-drawn app window | `src/app/app.html`, `src/app/sdui/` (node kinds: `sdui/core.js` COMPONENTS) |
| Sign-in | window: `sdui/auth.js`, `gate.js`, `signIn.js`; main: `main.js` "Session", "Apple / Google", `oauth.js` |
| Knobs | `knobs.js`; the bootstrap is fetched in `main.js` "Bootstrap" and by `sdui/backend.js` |
| Runner (Xode jobs) | `src/runner/` (entry `index.js`); `main.js` "Tailzu Code on this computer"; `src/app/runnerCard.js` |
| Updater | `src/main/updater.js`; `main.js` "Updates"; `sdui/paying.js` installUpdate |
| Native helpers | `native/` (build: `npm run tzax|tzocr|tzkey|audiotap`, output in `build/`) |
| Packaging and release | `package.json` `build`; `build/`; `.github/workflows/build.yml`; `RELEASE.md`; `docs/microsoft-store.md` |

## How the parts connect

**Processes.** The main process (Node) owns everything that must be trusted or
must persist: the config, the session's tokens, the cached bootstrap, the
windows, the tray, global keys, the paste keystroke, the drivers' native
helpers and the runner. Every window is a sandboxed renderer with context
isolation and no Node; each page loads only its own files (CSP `script-src
'self'`), as classic scripts in a fixed order. Code shared between the main
process, pages and tests is written as small UMD modules (`knobs.js`,
`botTiles.js`, `botLooks.js`, `shared/*.js`, `notesCore.js`, `pillSplit.js`,
`heldStop.js`): `require()`d in Node, `window.Tailzu*` in a page.

**Windows.** Hidden recorder (`dictation/recorder`), pill (`dictation/pill`),
caption overlay (`dictation/overlay`), guide (`agent/guide`), app window
(`app`), hidden notes window (`notes`), runner window (`runner/runner.html`).
Live pages inside the app window are `<webview>`s in a session of their own
(`app/liveViewMain.js`), with one preload (`app/liveViewGuest.js`).

**IPC.** `preload.js` exposes one bridge per kind of window, and the main
process checks which window sent each message (`isFrom` in `main.js`):

- `window.tailzu` (recorder, pill, overlay): `start-recording`,
  `recording-target`, `recording-field`, `recording-around`, `stop-recording`,
  `cancel-recording`, `dictation-segment`, `dictation-result`,
  `dictation-idle`, `dictation-error`, `dictation-level`, `live-partial`,
  `ask-audio`, `ask-pause`, `ask-text`, `recorder:token`; `pill`,
  `pill-level`, `pill:hover`, `pill:action`; `overlay-text`; `app:knobs`, `knobs`.
- `window.tailzuApp` (app window): `app:env`, `app:config`, `app:setConfig`,
  `app:session`, `app:setSession`, `app:oauth`, `app:boot`, `app:navigate`,
  `app:dictate`, `app:dictated`, `app:notes`, `app:changed`,
  `app:openExternal`, `app:readClipboard`, `app:micStatus`, `app:axStatus`,
  `app:captureScreen`, `app:allowSystemAudio`, `app:askSetup` / `ask-setup` /
  `app:askSetupAction`, `app:folders` / `ask-folders` / `app:foldersAction`,
  `app:installUpdate` / `app:updateProgress`, `live:open`, `runner:*`, `knobs`.
- `window.tailzuGuide` (guide): `guide` (main to page), `guide:mouse`,
  `guide:confirm`, `guide:permit`, `guide:spoken`, `guide:dismiss`, `guide:offer`.
- `window.tailzuNotes` (notes): `notes:start`, `notes:stop`, `notes:pcm`,
  `notes:system`, `notes:token`, `notes:status`, `notes:done`.
- `window.tailzuRunner` (runner window): `runner:state`, `runner:set`,
  `runner:project`, `runner:checkDocker`, `runner:stop`, `runner:openAudit`,
  `runner:update`.
- `window.tailzuLive` (a live page's webview): `tz-live`, to its host page.

**The server.** `config.json`'s `baseUrl` (default `https://api.x0bot.com`).
The main process fetches `POST /v1/app/bootstrap` (knobs, the tray's words
under `flags["desktop.shell"]`, updates under `flags["desktop.update"]`) and
caches it; dictation uses `/v1/transcribe-clean`, `/v1/transcribe-stream` and
`/v1/refine`; routing `/v1/shell/route`, `/v1/shell/ask`, `/v1/ask/decide` (the
brain) and `/v1/routines/draft` then `/v1/routines`; Ask `/v1/agent`
(NDJSON; step 0 may carry the whole page as `page`) and `/v1/tasks/:id/approve|deny`; notes `/v1/notes`; the app window
`/v1/app/screen`, `/v1/live`, `/v1/files`, `/v1/connectors/:id/connect`,
`/v1/auth/link`; the runner `/v1/code/runner/*` and a WebSocket to the jobs
Worker (protocol: `TAILZU-BACKEND/docs/desktop-runner-session.md`). Accounts
are Supabase's (email or phone codes in the window; Apple and Google through
the browser and a loopback port, `oauth.js`).

## Contracts with the other repositories

These are kept as they were; change them only together with the other side.

- **API paths and SDUI node kinds** the server sends: unchanged. The kinds this
  build draws are `COMPONENTS` and the capability names in `src/app/sdui/core.js`.
- **`botTiles.js` and `botLooks.js` stay at the root**: TAILZU-FRONTEND's
  `app/src/botTiles/genDesktop.mjs` and `genStarter.mjs` write them there, and
  tests on both sides compare their sha256 headers. Never edit them by hand.
- **`knobs.js` stays at the root**: TAILZU-FRONTEND's `tools/knobs/extract.mjs`
  finds this checkout by it, then scans every `*.js` and `*.html` here for knob
  calls. Its manifest records the file of each "dynamic" knob, so it needs a
  regeneration after files move.
- **Installer names** (`Tailzu-Setup.exe`, `Tailzu.dmg`, `Tailzu.AppImage`,
  `Tailzu.appx`) are what the server's `/download` and
  `deploy/receive-download.sh` serve; `artifactName` in `package.json` keeps them.
- **`src/shared/blip.js` is one file**: the backend's
  `tulmi/scripts/make-blip-loops.ts` retunes its motions by text and counts
  matches.
- Dev tools in the other repositories read files here by path (they take a
  path argument; their defaults still name the old root layout): TAILZU-BACKEND
  `tulmi/scripts/bots-render/render.ts` and `preview.ts` (`src/app/app.html`
  and its scripts), `make-blip-loops.ts` (`src/shared/blip.js`);
  TAILZU-FRONTEND `tools/media/capture-desk.mjs` (`src/app/app.html`) and
  `capture-pill.mjs` (`src/dictation/pill/pill.html`).

## Run, test, build, release

```
npm install
npm run icon                          # tray icons (once)
cp config.example.json config.json    # optional
npm start                             # electron .  ->  src/main/main.js
npm test                              # node --test: every *.test.js, and test/
```

A dev run keeps `config.json`, `session.json` and `shell.json` at the
repository root (git-ignored); an installed app keeps them in its user-data
folder.

Installers: `npm run dist:win`, `npm run dist:mac` (on a Mac), `npm run dist`.
electron-builder ships only what `build.files` matches (`src/**` without tests,
fixtures and test kits, plus `knobs.js`, `botTiles.js`, `botLooks.js` and
`assets/**`); the native helpers go in as `extraResources`.
`test/paths.test.js` fails when something loaded is not shipped, or something
shipped is loaded by nothing. CI (`.github/workflows/build.yml`) builds all
three installers on every push and publishes them only on a manual run.
Signing, notarization and publishing: `RELEASE.md`. The Store listing:
`docs/microsoft-store.md`.
