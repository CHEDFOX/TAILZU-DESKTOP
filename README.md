# Tailzu Desktop

Voice dictation for the desktop — press a hotkey (or hold a key), talk, and the
cleaned-up text is pasted wherever your cursor is. Same product as the mobile
app, but on desktop **none of the iOS keyboard walls exist**: we record the mic
directly and paste into any app. No extension sandbox, no App Store, no build
limits.

It reuses the existing Tailzu backend — `/v1/transcribe-clean` for one-shot
dictations, `/v1/transcribe-stream` + the per-tone `/v1/refine/*` routes for
live mode.

## How it works

```
hotkey / hold-key → record mic ─┬─ batch: POST /v1/transcribe-clean
                                └─ live:  WS /v1/transcribe-stream (+ overlay captions)
        → cleaned text → clipboard → paste keystroke into the focused app
```

- **main.js** — tray app, global hotkey, hold-to-talk hook, tone menu,
  caption overlay, clipboard + paste, config.
- **recorder.html** + **recorder.js** — hidden window: batch (MediaRecorder→webm)
  and live (WebAudio→16 kHz PCM→WebSocket) capture paths.
- **overlay.html** + **overlay.js** — the floating live-caption strip.
- **pill.html** + **pill.js** — the dictation pill at the foot of the screen.
- **speechMeter.js** — tells a voice from a breath, a keyboard or a hum, so a
  pause writes only speech and silence is never uploaded (node --test).
- **pasteJoin.js** — the space (or none) between two pasted stretches.
- **app.html** + **sdui.js** — the app window, drawn from the server's screens.
  - The onboarding is two node types the server sends (`OnboardStage`,
    `BlipSpot`) and one friend who is not a node: **blip.js** `createWalker`
    draws Blip on `#blipStage`, over both the sign-in gate and the app, and
    walks him to wherever the step on show says he stands. Only the steps'
    content glides; he, the bar and his bubble stay put (`html[data-onboard]`
    is that hold). Its two faces are bundled (`assets/fonts`): the window's
    policy loads fonts from its own files only.
- **Ask** — tap Alt twice and ask about the app in front:
  - **ask.js** wires it in the main process: the question's microphone, the
    guide's window, the agent's hands.
  - **agent.js** is the run loop. It reads the screen through the driver, asks
    `POST /v1/agent`, points, says, and acts. It asks first before anything
    that sends, deletes or pays (node --test). **resolver.js** matches a
    question to the screen on the device, for the instant answers.
  - **driver.js** picks **axDriver.js** + `native/tzax.swift` on a Mac (the
    accessibility tree) or **uiaDriver.js** on Windows (UI Automation). Each
    is a warm helper speaking JSON lines.
  - **guide.html** + **guide.js** + **blip.js** draw the card, the ring on
    the target, the thread from the pill, the marks Ask draws while it
    explains, and Blip, the one-eyed dotted presenter, peeking over the
    card and pointing. **pill.js** parts the pill for the thread.
  - `guide.html?demo` is a review page.

Every page carries a Content-Security-Policy that runs only this folder's own
script files, which is why no page has an inline script (neuralField.html's
one is allowed by hash, written by gen-field.js).
- **runner/** — Tailzu Code on this computer: the person's own computer as a
  runner for Xode's live sessions (see the section of that name).
- **preload.js** — the tiny IPC bridge.
- **knobs.js** — the server's values for everything above (see below).

## Run it (dev)

```
npm install
npm run icon          # generate the tray icons (one-time; the app icons are committed, see gen-app-icon.py)
cp config.example.json config.json   # optional — only baseUrl is needed
npm start
```

## config.json

Every key is optional. A key you leave out takes the **server's** default (the
knob named in brackets, sent in the bootstrap); a key you write wins over it.
So the example config carries only `baseUrl` — copying more of this table into
it would pin those values against anything the server later changes.

| key | meaning |
| --- | --- |
| `baseUrl` | your backend, e.g. `https://api.x0bot.com` (a config that still says `https://api.tailzu.space`, the old default, is read as this) — https, or http to `localhost` only: the account's token rides on every request |
| `language` | `auto` or a code like `en` / `hi` / `es` (`desktop.language.default`) |
| `hotkey` | toggle accelerator (`desktop.hotkey.default`, `CommandOrControl+Shift+Space`); if it is taken, `desktop.hotkey.fallbacks` are tried in order |
| `tone` | `none` / `formal` / `casual` / `very-casual` / `excited` (`desktop.tone.default`): only what the tray shows signed out. Dictation writes in the account's voice; the tray's Tone menu changes the account's tone |
| `live` | `true` → live captions while dictating (`desktop.live.default`) |
| `pauseFlush` | `false` → a pause no longer writes out what was said so far (`desktop.pauseFlush.default`) |
| `hold` | `true` → hold-to-talk on `holdKey` (`desktop.hold.default`; needs uiohook-napi) |
| `holdKey` | key name for hold-to-talk, e.g. `F9` (`desktop.hold.key`) |
| `tap` / `tapKeys` | double-tap to dictate, on `["Ctrl", "Alt"]` (`desktop.tap.default`, `desktop.tap.keys`); with the one key, `tap` is whether a quick tap keeps it listening |
| `oneKey` | the one key (Mac/Windows): `fn`, `rightOption`, `rightCommand` / `rightCtrl`, `rightAlt` (default Fn on a Mac, Right Ctrl on Windows: `desktop.oneKey.default.mac` / `.windows`); `"off"` → the keys above. Set from Keylessbord's settings in the window |
| `autoStart` | launch at login (`desktop.autoStart.default`; installed app; also in the tray menu) |
| `runnerImage` | the Docker image for "Run in a container" (default `node:22-bookworm`; it needs `bash`) |
| `runnerName` | the name this computer is listed under for Xode (default: the computer's name) |

There is no `token` any more. Signed out, nothing is sent with an
Authorization header; dictation needs a signed-in account.

For the **installed** app, config lives in the per-user data dir (Windows:
`%APPDATA%\tailzu-desktop\config.json`) — use the tray's "Edit config…" to open
it. The dev `config.json` (in this repo's root) is git-ignored and never packaged.

## Use it

Dictation needs an account, the same as on the phones — open the window from
the tray and sign in. The hotkey answers a signed-out machine by opening that
window rather than recording into a history no account owns.

- **The one key** (Mac and Windows): hold it to talk, let go to finish; a quick
  tap keeps it listening until it is tapped again. What was said goes where it
  is meant (routing.js, router.js): typed into the text box in focus; Ask for
  "Tailzu, …", a question about the screen, or a question with no text box in
  front; meeting notes for "take notes" / "stop notes" (and "notes lo", "नोट्स
  बंद करो"); a bot for a bot's task (the backend's `/v1/shell/route` picks which,
  `/v1/shell/ask` sends it). The pill says where it went, with one tap for the
  other choice ("Typed · Ask instead", "Sent to Plan Ease · Type it instead").
  Fn is watched by `native/tzkey.swift` (`npm run tzkey`); the others by the key
  hook. A key that cannot be bound falls back to the toggle hotkey, said once.
- **Toggle** (Linux, or `oneKey: "off"`): press the hotkey → speak → press again.
- **Hold-to-talk** (`hold: true`, without the one key): hold `holdKey` while speaking, release to finish.
- **Live captions** (`live: true`): a caption strip shows your words as you
  talk; the final polished text pastes when you stop. Captions are display-only —
  partial text is never typed into your target app.
- **Tone**: pick in the tray menu; applied to every dictation.
- **Select and say**: select text, start dictating, say what to do with it
  ("bullet points", "shorter", "in Hindi"). The selection is rewritten in place.
- **Ask** (tap **Alt twice**, or the tray): say something about the app in
  front.
  - **Show**: "where's export?", "how do I turn on captions?". The guide rings
    the thing and Blip points at it.
  - **Explain**: "what does this error mean?". The guide answers on its card
    and out loud.
  - **Small jobs**: "open #design and tell them the mockups are ready". It does
    them step by step and stops before anything risky with **Do it / Not
    now** (or tap Alt twice). Esc or the card's ✕ stops it.
  - **Instant**: the question streams as it is said, and a plain "where's
    X" is matched on the device (`resolver.js`) and ringed before the
    question ends, with no Ask request. Its words still come from the
    server's live transcription, as every question's do.
  - **Pictures**: "what's this graph saying?", "solve this". The window is
    also read from its pixels on the device (the system's own OCR), and a
    question about something drawn sends one cropped picture, to Tailzu and
    the AI providers it answers with, after a card asks **Allow once /
    Always for this app / Not now**. Always is offered for an app, never for
    a browser tab, whose name is the page's own title; the tray lists the
    apps said Always to and asks again for any of them, and signing out
    forgets them. `desktop.agent.pictures: never` turns pictures off; no
    server value skips the card.
  - **Out of the pill**: the card grows out of the pill on a thread, stays
    tied to it while it is up, and folds back into it at the end.
  - **Drawing**: while it explains, it circles, underlines, numbers and
    draws arrows on the screen or on the picture, labelled in handwriting.
  - **Peek**: while you dictate, a small Blip peeks over the text box at the
    cursor (`desktop.dictation.peek`).
  - **One-time setup**: a card in the app ("Let Ask see what you see.")
    allows reading the screen, seeing it and looking when needed, so the
    working screens never stop to ask.
  - **Connected apps** (when the server has them on): Settings lists the
    apps (state, Connect, how far it may go: Can look / Can draft / Can send,
    Disconnect) and a Tasks tab lists what was done (Waiting for you /
    Running / Done). Both are pages the server builds; the window adds only
    the `connector.connect` action, which asks `POST /v1/connectors/:id/connect`
    and opens the sign-in page it answers with. When a do-run reaches a
    change in one of those apps, the stream's `approve` event carries the
    server's own confirm card (its words, its Approve / Edit / Not now, the
    route each calls). The guide draws it as sent, and the button's route is
    called through `authorizedFetch` (agent.js `approve`, ask.js `call`: a
    task's own approve or deny, nothing else). Alt twice is Approve, on the
    same `desktop.agent.confirmTapMs` wait as any confirm card; Edit says no
    to that one and asks what to change; no answer leaves it waiting in
    Tasks. `desktop.agent.approveCallMs` bounds the call.
  - **Mostly text**: what leaves the machine is a text list of the screen's
    buttons, fields and OCR'd lines (roles, labels, short values, a rough
    position), the question's audio on the live stream, plus that one
    picture when allowed. No frames or window titles, and nothing from a
    private window or a sensitive app.
  - **Knobs**: `desktop.agent.*` and `desktop.guide.*`; off with
    `desktop.agent.enabled`. While Ask is on, Alt twice asks instead of
    dictating. Ctrl twice dictates.

## Tailzu Code on this computer

Xode works on a project's code and needs somewhere to run commands (tests,
builds, installs). Its first choice is the person's own computer, if they have said
it may: free, and fast, because nothing waits for a cloud computer to start. This
app speaks the backend's runner protocol for that (`docs/desktop-runner-session.md`
in the backend repository; the code is `runner/`).

**It is off until the person turns it on** (tray: *Use this computer for Tailzu Code*,
which says what it means the first time; or *Tailzu Code activity…*, the window).
While it is on and the app is running, one WebSocket stays open to the jobs Worker, so
the router knows this computer is here. That costs one small text frame every 30
seconds and nothing else; reconnects wait 1, 2, 4 … 60 seconds with a little jitter,
each with a new one-use ticket (`POST /v1/code/runner/ticket`).

**Which projects.** Per project, on this computer. The first time the bot offers a
project's work here, a dialog asks (*Allow for this project / Not on this computer /
Ask me later*). The answer is kept; a project never answered is not run, a refused one
is left out of the list the server is told. The window lists them and changes them.
Signing out forgets the answers.

**The code.** `<userData>/workspaces/<projectId>`, a git repository kept from job to
job: the first job fetches the commit (shallow), later ones only what changed (nothing
when the commit is already there), and `node_modules` and other untracked files stay.
The token for it is the server's read-only one for that one repository; it goes to
git in that process's environment as an HTTP header, and is in no file, config or
command line. A project connected by sign-in comes as a one-time download link
instead. Workspaces unused for 30 days are removed.

**What a command gets.** A shell in the workspace with a *scrubbed* environment: `PATH`
(the person's own login PATH, read once from their shell), `HOME`, `LANG`, the temp
folder and the npm, pip and cargo caches, and nothing else of the app's own
environment, so no token or cloud credential. `HOME` is a private folder inside the
app's data (`<userData>/runner/home`), where the caches live, not the person's. Each
command gets the time the step has left (a timeout kills its whole process group, exit
124); output is streamed a line at a time with secrets replaced, with a cap on how much
is sent (a head and a tail; the rest is said to be left out); the exit code is reported.
Unlike the GitHub runner it uses `bash -c`, not `bash -lc` (the login PATH is given
instead), and on Windows `bash` if Git for Windows has put one on the PATH, else `cmd.exe`.

**What it refuses**, with a clear reason, before running anything (every command of a
request is read first; a refusal is `done` with exit code 126):

- paths for file operations that leave the workspace (`..`, absolute, through a link)
- `sudo`, `doas`, `su`, `pkexec`, `runas`
- writes to a home directory's dotfiles or settings folders (`~/.bashrc`, `~/.ssh`,
  `Library`, `AppData`), anywhere else in the person's own home outside the workspace,
  and system folders (`/etc`, `/usr`, `C:\Windows`, ...)
- `rm -rf` (or `find -delete`, `chmod -R`) of `/`, a home folder, `..`, or a parent of the workspace
- naming places where keys live (`~/.aws`, `~/.npmrc`, the app's own sign-in file, ...)
- `curl` or `wget` piped to a shell (`| sh`, `bash <(curl ...)`, `eval "$(curl ...)"`)
- publishing and deploying: `npm publish`, `cargo publish`, `twine upload`, `docker push`,
  `terraform apply`, `vercel deploy`, ... and `git push`, which would fail anyway (the
  server never sends a write token)
- installing software for the whole computer (`apt`, `brew`, `npm -g`, `pip --user`)

This is a guard against mistakes, and against a repository that talks the agent into
one, not a sandbox: a shell can say the same thing many ways. The wall is the next part.

**Run in a container (Docker).** In the window, turn on *Run in a container* and each
command runs in a throwaway container instead: `docker run --rm --init`, the workspace
mounted at `/workspace` (the only part of this computer a command can change), the tool
caches in a folder mounted at `/cache`, all capabilities dropped, `no-new-privileges`, run
as the person's own user, the image `node:22-bookworm` unless `runnerImage` in
`config.json` says another (it needs `bash`), and an environment of exactly what the
command is given: nothing of the app's. The first command pulls the image, which takes a
while. A dev server's one port is published on `127.0.0.1` only. It **fails closed**:
if Docker is not installed or not running, the job is declined and a notification says
why; it never falls back to running on the computer itself. Git (fetching the code) is
still run by the app on the computer, since it holds the token.

**The preview.** For the design round the bot may ask for the project's dev server:
started on `127.0.0.1` with `PORT`, `HOST` and `BROWSER=none`, its port found from what
it prints, and the room's requests passed to it over the session's own socket (never a
WebSocket upgrade, never anywhere but `127.0.0.1` / `::1`, at most 1 MB in and 10 MB out).
It is killed, with everything it started, when the room says, when a command needs the
checkout, and when the session ends.

**Standing down.** Paused (the socket closed, nothing running) while on battery below 20%
(back at 25%) or in a low-power mode: macOS `pmset`, Linux sysfs and power-profiles-daemon,
Windows WMI for the battery (Battery Saver is not read). Where it cannot tell it never pauses.
A job already running is finished.

**Seeing and stopping it.** The tray says *Tailzu is working on <project>* with a **Stop**,
which kills what is running, tells the room, reports the step stopped and turns this off
until the person turns it on again. The window lists the last commands with time, project,
exit code and duration. Every command also goes into an audit log under
`<userData>/runner/audit`, one JSON line per event, a file a day, 7 days kept, owner-only.

**Nothing is left behind.** Every process started is in a process group of its own and
is killed when the session closes, on Stop, when the app quits, when the process exits
or an uncaught error ends it, and, through a small watchdog process, when the app is
killed outright (it holds a pipe to the app and kills the groups when it closes).

Tests: `node --test runner/*.test.js` (a fake Worker and room over real sockets, real bash
and git; a local bare repository stands in for GitHub; the battery source is stubbed).

## What comes from the backend

Everything the window draws, and now everything around it. Screens are the same
catalog JSON the phones render. The theme, the typography and the sign-in art
come from the same keys the phones read. The gate's copy, the rail, the tray
menu and every notification come from `flags["desktop.shell"]`, sent only to a
client that reports `device.formFactor: "desktop"`.

**And everything else the app would otherwise decide itself is a knob.**
`knobs.js` is the desktop's copy of the phones' `app/src/sdui/knobs.ts`:
`txt(key, fallback)` reads `bootstrap.labels`, and `num` / `bool` / `str` /
`color` / `list` / `obj` read `bootstrap.flags`. The literal next to each key is
the value that used to be hardcoded, kept only for a launch that has never
reached the server. `tools/knobs/extract.mjs` (in TAILZU-FRONTEND) scans this repo's `*.js`
and `*.html` for those calls, and the backend sends every key it finds, so each is
visible and changeable from the control console. Keys are named
`desktop.<area>.<name>` — hotkey fallbacks, tap timings, recorder thresholds,
window sizes, notification copy, the overlay's look, the window's toasts.

The main process fetches the bootstrap itself — at launch, including a hidden
login-item start, and every `desktop.bootstrap.refreshMs` — as
`{ platform: "web", appVersion, device: { formFactor: "desktop", os } }` with
the account's bearer when signed in. The answer is cached in `bootstrap.json`
in the user-data folder and read before anything else at startup, so the second
launch opens with the server's values, offline or not. The app window also hands
over every bootstrap it receives, and the main process relays the knobs to the
recorder and the caption overlay.

The neural field is the one drawing that ships as a file rather than as JSON:
it is ~400 lines of canvas the phones build at runtime and this window loads in
an iframe. `npm run field` regenerates it from the app's own source, so the two
cannot drift silently. What the phones bake in from the node's props travels in
the iframe's query string: `alpha` and `growth` on their own (they retune the
field in place), and every other prop the server sends as one `cfg` JSON
parameter laid over the baked geometry.

So a wording or tuning change is a backend deploy and a cache bump — no
installer. This matters more here than on the phones: there is no OTA channel on
desktop, and a release is a download the user has to notice, accept past
SmartScreen, and run.

### Quota and updates

- **Out of words.** When the bootstrap says `quota.exceeded`, the hotkey does
  not open the mic: the window opens on `quota.screenId` (the paywall) and a
  notification says why (`desktop.notify.wordsOut`).
- **Updates.** `flags["desktop.update"] = { latest, min, url, notes }`. Below
  `min`, every launch says the build is no longer supported
  (`desktop.notify.updateRequired`); below `latest`, it says once per version
  that an update is out (`desktop.notify.updateAvailable`). Clicking either
  opens `url`.

## Permissions (one-time)

- **Microphone** — granted on first record. The app holds it for its own page,
  so the only gate left is the OS one: Windows **Settings → Privacy & security
  → Microphone**, macOS its own prompt. A blocked mic names the panel to open.
- **macOS auto-paste** — enable Tailzu under **System Settings → Privacy &
  Security → Accessibility** (without it, text is still on the clipboard).
  **Ask** needs the same permission to read and press the app's buttons,
  and **Screen Recording** to read text drawn as pixels and to send a
  picture (it works without it, from the accessibility text alone; a
  question that needs the picture says so, with a button to that page).
- **macOS hold-to-talk** — the key hook also needs **Input Monitoring**.
- **Linux (X11)** — auto-paste needs `xdotool`.

## Build installers (PC build)

```
npm install
npm run icon
npm run dist:win      # Windows: dist/Tailzu Setup 0.1.0.exe (NSIS, one-click)
npm run dist:mac      # macOS:  dist/Tailzu-0.1.0.dmg (needs a Mac)
npm run dist          # current OS
```

Output lands in `dist/`. Windows builds are local + free — no cloud
service, no store review. Notes:

- The installer is **unsigned**, so Windows SmartScreen shows "Windows protected
  your PC" — click **More info → Run anyway**. Code-signing certificates remove
  that later.
- The installed app starts **signed out** — open the tray → "Open Tailzu" and
  sign in with the same account as the phone. Only `baseUrl` needs to be in
  config.json, and a packaged build already carries the right one.
- macOS `.dmg` must be built on a Mac (electron-builder can't cross-build mac
  from Windows). Notarization is a later step for public distribution.

## Roadmap (not in this MVP)

- Settings UI (replacing config.json)
- Auto-update (electron-updater) — until then the server announces updates
  through `desktop.update`
- Word-replay / history browser backed by /v1/history
