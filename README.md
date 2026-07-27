# Tailzu Desktop

Voice dictation for the desktop — press a hotkey, talk, and the cleaned-up text
is pasted wherever your cursor is. Same idea as the mobile app, but on desktop
**none of the iOS keyboard walls exist**: we record the mic directly and paste
into any app. No extension sandbox, no App Store, no build limits.

It reuses the existing Tailzu backend — the desktop app just calls
`/v1/transcribe-clean` exactly like the phone does.

## How it works

```
global hotkey (toggle) → record mic → POST /v1/transcribe-clean → cleaned text
   → copied to clipboard → paste keystroke into the focused app
```

- **main.js** — tray icon, global hotkey, clipboard + paste, IPC.
- **recorder.html** — hidden window: `getUserMedia` + `MediaRecorder` → backend.
- **preload.js** — the tiny IPC bridge.

## Run it (dev)

```
cd desktop
npm install
npm run icon          # generate the tray icon (one-time)
cp config.example.json config.json   # then edit config.json
npm start
```

Edit **config.json**:
- `baseUrl` — your backend, e.g. `https://api.tailzu.space`
- `token` — a Supabase access token (or `dev` if the backend allows it)
- `hotkey` — Electron accelerator, default `CommandOrControl+Shift+Space`
- `language` — `auto` or a code like `en` / `hi` / `es`

## Use it

1. Focus any text field (Slack, browser, notes…).
2. Press the hotkey → the tray shows "listening…".
3. Speak, then press the hotkey again to stop.
4. The cleaned text is pasted at your cursor.

## Permissions (one-time)

- **Microphone** — granted on first record (macOS/Windows prompt).
- **macOS auto-paste** — enable Tailzu under **System Settings → Privacy &
  Security → Accessibility**. Without it, the text is still copied to the
  clipboard; you just paste with ⌘V yourself.
- **Linux (X11)** — auto-paste needs `xdotool` installed.

## Package installers

```
npm run dist          # current OS
npm run dist:win      # Windows .exe (NSIS)
npm run dist:mac      # macOS .dmg
```

Windows builds are local + free (no EAS, no store review). macOS `.dmg` builds
need a Mac; notarization is a later step for distribution outside your own machine.

## Roadmap (not in this MVP)

- Hold-to-talk (needs a low-level key hook, e.g. `uiohook-napi`) instead of toggle.
- Live streaming transcription via `/v1/transcribe-stream`.
- Supabase sign-in + settings UI (currently config.json).
- Auto-update.
