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

## Run it (dev)

```
cd desktop
npm install
npm run icon          # generate tray + app icons (one-time)
cp config.example.json config.json   # then edit config.json
npm start
```

## config.json

| key | meaning |
| --- | --- |
| `baseUrl` | your backend, e.g. `https://api.tailzu.space` |
| `token` | a static token from the backend's `STATIC_BEARER_TOKENS` |
| `language` | `auto` or a code like `en` / `hi` / `es` |
| `hotkey` | toggle accelerator, default `CommandOrControl+Shift+Space` |
| `tone` | `none` / `formal` / `casual` / `very-casual` / `excited` (also in the tray menu) |
| `live` | `true` → live captions while dictating (streaming) |
| `hold` | `true` → hold-to-talk on `holdKey` (needs uiohook-napi to load) |
| `holdKey` | key name for hold-to-talk, e.g. `F9`, `F10` |
| `autoStart` | launch at login (installed app; also in the tray menu) |

For the **installed** app, config lives in the per-user data dir (Windows:
`%APPDATA%\tailzu-desktop\config.json`) — use the tray's "Edit config…" to open
it. The dev `desktop/config.json` is git-ignored and never packaged, so tokens
can't leak into an installer.

## Use it

- **Toggle**: press the hotkey → speak → press again.
- **Hold-to-talk** (`hold: true`): hold `holdKey` while speaking, release to finish.
- **Live captions** (`live: true`): a caption strip shows your words as you
  talk; the final polished text pastes when you stop. Captions are display-only —
  partial text is never typed into your target app.
- **Tone**: pick in the tray menu; applied to every dictation.

## Permissions (one-time)

- **Microphone** — granted on first record.
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
- The installed app starts with **no token** — open the tray → "Edit config…",
  paste `baseUrl` + `token`, save, then Quit + relaunch.
- macOS `.dmg` must be built on a Mac (electron-builder can't cross-build mac
  from Windows). Notarization is a later step for public distribution.

## Roadmap (not in this MVP)

- Settings UI + Supabase sign-in (replacing config.json)
- Auto-update (electron-updater)
- Word-replay / history browser backed by /v1/history
