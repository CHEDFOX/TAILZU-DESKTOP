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
- **recorder.html** — hidden window: batch (MediaRecorder→webm) and live
  (WebAudio→16 kHz PCM→WebSocket) capture paths.
- **overlay.html** — the floating live-caption strip.
- **preload.js** — the tiny IPC bridge.
- **knobs.js** — the server's values for everything above (see below).

## Run it (dev)

```
cd desktop
npm install
npm run icon          # generate tray + app icons (one-time)
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
| `baseUrl` | your backend, e.g. `https://api.tailzu.space` |
| `language` | `auto` or a code like `en` / `hi` / `es` (`desktop.language.default`) |
| `hotkey` | toggle accelerator (`desktop.hotkey.default`, `CommandOrControl+Shift+Space`); if it is taken, `desktop.hotkey.fallbacks` are tried in order |
| `tone` | `none` / `formal` / `casual` / `very-casual` / `excited` (`desktop.tone.default`; also in the tray menu) |
| `live` | `true` → live captions while dictating (`desktop.live.default`) |
| `pauseFlush` | `false` → a pause no longer writes out what was said so far (`desktop.pauseFlush.default`) |
| `hold` | `true` → hold-to-talk on `holdKey` (`desktop.hold.default`; needs uiohook-napi) |
| `holdKey` | key name for hold-to-talk, e.g. `F9` (`desktop.hold.key`) |
| `tap` / `tapKeys` | double-tap to dictate, on `["Ctrl", "Alt"]` (`desktop.tap.default`, `desktop.tap.keys`) |
| `autoStart` | launch at login (`desktop.autoStart.default`; installed app; also in the tray menu) |

There is no `token` any more. Signed out, nothing is sent with an
Authorization header; dictation needs a signed-in account.

For the **installed** app, config lives in the per-user data dir (Windows:
`%APPDATA%\tailzu-desktop\config.json`) — use the tray's "Edit config…" to open
it. The dev `desktop/config.json` is git-ignored and never packaged.

## Use it

Dictation needs an account, the same as on the phones — open the window from
the tray and sign in. The hotkey answers a signed-out machine by opening that
window rather than recording into a history no account owns.

- **Toggle**: press the hotkey → speak → press again.
- **Hold-to-talk** (`hold: true`): hold `holdKey` while speaking, release to finish.
- **Live captions** (`live: true`): a caption strip shows your words as you
  talk; the final polished text pastes when you stop. Captions are display-only —
  partial text is never typed into your target app.
- **Tone**: pick in the tray menu; applied to every dictation.

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
reached the server. `tools/knobs/extract.mjs` scans `desktop/*.js` and
`*.html` for those calls, and the backend sends every key it finds, so each is
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
- **macOS hold-to-talk** — the key hook also needs **Input Monitoring**.
- **Linux (X11)** — auto-paste needs `xdotool`.

## Build installers (PC build)

```
cd desktop
npm install
npm run icon
npm run dist:win      # Windows: dist/Tailzu Setup 0.1.0.exe (NSIS, one-click)
npm run dist:mac      # macOS:  dist/Tailzu-0.1.0.dmg (needs a Mac)
npm run dist          # current OS
```

Output lands in `desktop/dist/`. Windows builds are local + free — no cloud
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
