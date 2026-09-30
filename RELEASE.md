# Publishing the desktop app

This repo's `build` workflow builds all three installers on every push and
publishes them only on a manual run (Actions → build → Run workflow), with
the `DOWNLOADS_SSH_KEY` secret set. The delivery side is already built. `tailzu.space/download` detects the
visitor's OS and links to `/downloads/Tailzu-Setup.exe`, `/downloads/Tailzu.dmg`
or `/downloads/Tailzu.AppImage`, HEAD-checks each one, and shows "coming soon"
for whatever is not published yet. The server serves that directory from a host
bind mount, so publishing a release is one copy:

```
scp "dist/Tailzu-Setup.exe" server:~/tulmi/downloads/
```

The filenames are fixed on purpose. The page's links never change, so a release
replaces a file and nothing else moves.

**What is not built is signing, and that is the part that decides whether a
stranger can install this.**

## Windows

```
npm run dist:win      # on Windows
```

Produces `dist/Tailzu-Setup.exe`. It installs and runs.

Unsigned, SmartScreen shows "Windows protected your PC" with the Run button
hidden behind "More info". Most people stop there. A signing certificate is
what removes it:

- **OV certificate** — the warning goes away once the binary accumulates
  reputation, which takes downloads and time. Each new release starts partway
  back.
- **EV certificate** — trusted by SmartScreen immediately, no reputation
  period.

Since June 2023 both must live on a hardware token or an HSM, so signing
happens on a machine with the token plugged in, or through a cloud signing
service. Plan for that before wiring any CI.

Nothing here blocks a beta. Unsigned is fine for people you send it to
directly; it is not fine for a public download page.

## macOS

**The app must be built on a Mac, signed, and notarized. There is no way
around this and no way to do it from Linux.** Since Catalina, an unsigned or
un-notarized app downloaded from the web is refused by Gatekeeper — not
warned about, refused, usually with "Tailzu is damaged and can't be opened",
which reads to a user like a broken download rather than a policy.

You already have an Apple Developer Program membership for the App Store
submissions. Notarization needs no second membership — it needs a different
certificate from the same account:

1. In the Developer portal, create a **Developer ID Application** certificate.
   This is NOT the "Apple Distribution" certificate used for the App Store.
   Download it and double-click to add it to the login keychain.
2. Create an **app-specific password** at appleid.apple.com (Sign-In and
   Security → App-Specific Passwords). Your real Apple password will not work.
3. Find your **Team ID** in the Developer portal's Membership page — ten
   characters, e.g. `A1B2C3D4E5`.
4. On the Mac:

```
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="A1B2C3D4E5"
npm run dist:mac:signed
```

Notarization uploads the app to Apple and waits for a verdict — usually a few
minutes, occasionally much longer. electron-builder staples the ticket to the
.dmg when it succeeds, which is what lets the app open on a machine that has
never been online.

Then:

```
scp "dist/Tailzu.dmg" server:~/tulmi/downloads/
```

### Check it before you publish it

A signed build that cannot record is worse than an unsigned one, because it
looks like it works. The hardened runtime is required for notarization and it
switches off what Electron needs unless `build/entitlements.mac.plist` asks
for it — which is why that file exists and why the microphone entitlement is
in it. `NSMicrophoneUsageDescription` is the prompt; the entitlement is the
permission, and an app with the prompt and not the entitlement asks politely
and then records silence.

On a Mac that has never seen the app, from a normal user account:

```
spctl -a -vvv -t install /Applications/Tailzu.app   # should say: accepted, Notarized Developer ID
```

Then open it, grant the microphone, and dictate once. Test from a copy that
was actually **downloaded** — a build sitting in your own `dist/` folder skips
the quarantine flag, so it will open on your machine whether or not
notarization worked.

## Updates

From 0.2.2 a build installs its own updates (updater.js). Publishing records
the installer's SHA-512 beside it (receive-download.sh, backend), and the
window's update card gets an "Update now" button: it downloads the new build
from tailzu.space (over https, and a redirect anywhere else is refused) into a
fresh private temp folder, checks it against that checksum, puts it in place of the
running one and restarts on it, still signed in. Windows runs the installer
silently over the install; macOS swaps the .app; Linux swaps the AppImage.

A copy that cannot replace itself (a Mac app run from the disk image, an
Applications folder the user cannot write to, a Linux build that is not an
AppImage) gets the download link instead. Builds before 0.2.2 have no updater,
so reaching 0.2.2 is one last manual download.

On a Mac, until the app is signed with a Developer ID, macOS treats each new
build as a new app: it may ask again for the microphone and Accessibility.

### 0.2.2 — the network shows

The neural network was drawn behind the desk's page colour, so the live
training screen was plain black. The page colour now sits under it. Builds
from this one declare `DeskField`, and the server puts the network on the
Train page only for them. Error toasts say the error, not `$event`.

Dictation: only the written text is ever pasted, never the raw transcript,
and in the account's own voice (no tone is sent; the server uses the
account's, as it does for the phone). A pause writes a paragraph, not a
phrase: short dictations are written whole when they stop. Nothing without
a voice in it is uploaded — the meter reads every sample and tells a voice
from a breath, a keyboard, a fan or a hum (speechMeter.js) — so silence no
longer comes back as "Thank you.". Stretches go one after another, each with
exactly what was written before it, and join with one space or none as the
script and punctuation want (the server's `joinWithSpace`, or pasteJoin.js).
Each request gets a fresh token, and a refused one is renewed and resent. A
live dictation sends the second engine's reading to the refine step; a
failed refine is said as a failure, not pasted raw.

The pill: its hint shows on hover from the first launch (it was dropped
while the page loaded), it follows the screens when a monitor, the scaling
or the taskbar changes and after sleep, it comes back from a crashed page,
and no state can leave it stuck on "writing" (a stop always settles). The
paste helper on Windows opens no console window that could take the
keyboard, and the caption overlay no longer activates the app on macOS.

Publishing now sends the version with each installer; every older install
on that OS sees an update card in its window.

Updates install from the window: "Update now" downloads the new build, checks
its SHA-512, swaps it in and restarts (see Updates above).

Live dictation writes from the whole recording: the stream only draws the
captions, and on stop the audio goes through /v1/transcribe-clean like every
other dictation (no doubled sentences, no rough stream text). The pill and the
caption overlay sit at the screen-saver level and reclaim the top while a
dictation runs, so no app can cover them.

Opening the window no longer flashes the old rail on black: the window stays
hidden until its first frame is drawn, on the desk's own sheet, and the page
keeps the shell hidden until the server has said which look to wear.

### 0.2.0 — the desk and the pill

The window is Tailzu's own desk: a masthead with Today, Insights, Words,
Voices and Train, and Settings and Plan behind the gear. The pill sits at the
foot of the screen while you talk. Both are drawn from the server, so after
this one install every change to them is a backend deploy. An older install
keeps the phone screens it had until it updates.

Until then the server tells installed builds about a release. Bump `version` in
`package.json` before `npm run dist` (every build reports it as
`appVersion` in its bootstrap), publish, then set the flag from the control
console:

```
desktop.update = { "latest": "0.1.2", "min": "", "url": "https://tailzu.space/download", "notes": "" }
```

- A build older than `latest` gets one notification per version, and a click
  on it opens `url`.
- A build older than `min` is told on every launch that it is no longer
  supported. Raise `min` only when an old build would actually break against
  the backend — it is the loud one.
