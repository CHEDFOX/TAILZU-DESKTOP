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

### 0.3.11 — the pill is pulled apart and pulled home on a thread

The split pill's separation is no longer paced on a clock — it is a **damped
spring** (pillSplit.js), so the thread between the two halves reads as a
physical thing. Coming apart, the halves ease out and the thread stretches
taut. On stop, the thread's tension **pulls both halves home**: a stiffer,
lighter-damped yank that accelerates them inward and overshoots the join a
touch, which the capsule's click-shut swallows — so it looks like the thread
snapped the pill back into one. Both ends are driven symmetrically, so it
reassembles exactly where it started. The four spring constants
(`desktop.pill.splitIn/OutStiff`, `…Damp`) are server-tunable; the old
constant-pace `desktop.pill.splitMs` is retired.

### 0.3.10 — the desk scrolls, the masthead is just the mark, Today & Insights stay fresh

Three fixes to the desk window:

- **Scrolling works again on every page.** In the desk's column layout the
  content column had no `min-height:0`, so a flex item grew to its content's
  full height and the scroll view never got a bounded box — every page was
  clipped at the window's foot with no way down. One line fixes it.
- **The masthead is the mark alone** — the "Tailzu" wordmark beside it is
  gone, on the owner's ask. (The legacy rail, old builds only, keeps its name.)
- **Today and Insights refresh like the phone.** A dictation happens in
  another app, so the window's numbers were stale until you switched tabs.
  Now the data tabs re-fetch when you return to the window or switch to them,
  and again a moment after a dictation lands — not only Today (Insights too),
  never over a live capture, throttled by `desktop.desk.refreshMs`.

### 0.3.9 — it can read the screen even when the app hides its text

0.3.8 read the window through the accessibility layer, which most apps
answer. Some — Google Docs, a PDF, Figma — draw their text as pixels and
answer nothing. 0.3.9 fills that gap: when the accessibility read comes
back empty or thin, the focused window is captured and read with on-device
OCR (macOS Vision, via the bundled tzocr helper; Windows via
Windows.Media.Ocr on the shared PowerShell). The accessibility text still
leads where it exists — it is exact; OCR only adds the lines it did not
have, and never repeats one.

The image never leaves the machine: it is read into text on the device,
and only the text joins the rest as `surroundings`, under the same
reference-only, screen-off-limits rules (no private windows, no money or
health apps, no password fields). It runs only as a fallback, is bounded
(the window at ≤1600px), time-boxed (a slow capture or OCR yields nothing
and the mic carries on), and cached per window so dictating twice into the
same window reads the picture once.

On macOS the first capture shows the system's Screen Recording prompt
once; Windows shows none. Knobs: `desktop.ocr.read` (on),
`desktop.ocr.minChars` (the thin threshold, 80), `desktop.ocr.maxSide`,
`desktop.ocr.timeoutMs`, `desktop.ocr.cacheMs`. CI builds the Vision helper
and runs both OCR engines against a known test image (nativeCheck.js). Not
yet tried in real apps on a real machine; `desktop.ocr.read` turns it off.

### 0.3.8 — it reads the screen around the field

0.3.7 knew the field; this reads what is around it. When dictation starts,
the focused window's text — the conversation being replied to, the
recipient, the subject — is gathered through the same accessibility layer
(macOS Accessibility; Windows UI Automation, a bounded walk of the window)
and sent as `surroundings`. The server treats it the way the Reply helper
treats a pasted message: read to understand this one (who "he" is, how a
name is spelled, what is being answered), never written into the field.
"yeah friday works" against a thread becomes "Friday works for me".

Where it does NOT read:
- a private or incognito window (known from its title: Incognito, InPrivate,
  Private Browsing);
- a money or health app (Chase, a bank, 1Password, a patient portal…),
  matched by name;
- a password field (already, since 0.3.7).
In those the request is marked private and the server keeps nothing off the
screen — not the surroundings, and not even the field's own prior text,
which in those apps is a balance or a card number.

The gather is bounded and time-boxed (≤1.4 s, a few hundred nodes): a slow
or empty read costs nothing but the help — the mic starts regardless. It
is one shared blob, cleaned and cut to 2000 characters from the newest
lines. Knobs: `desktop.surroundings.read` (on), `desktop.surroundings.chars`,
`desktop.surroundings.timeoutMs`. CI runs the Windows walk for real and
compiles the Mac gather (nativeCheck.js). Not yet tried in real apps on a
real machine; the knob disables it instantly if it ever misbehaves.

### 0.3.7 — it knows the field it is writing into

The owner: "first the screen and app awareness". The app was known
("Chrome: Gmail"); the field never was, so the search box, the To line,
the subject and the message were all just Gmail. When dictation starts,
the field with the keyboard's focus is now read through the system's
accessibility layer (macOS Accessibility, the permission the paste already
needs; Windows UI Automation, through the PowerShell already kept open for
the app's name):

- its kind: a search box, an address bar, an email address field, a text
  field, a message box or a text area;
- its label or placeholder: "Search mail", "Subject", "Message #design";
- what is already written before the cursor, as the phone keyboards send
  it, and only when the cursor itself was read.

All three go with the dictation (`fieldKind`, `fieldLabel`, `context`), so
the server writes a search as words and a subject as a subject, and the
first stretch continues what is there. The first paste now joins that
text the way later pastes join each other: "Hello" and "how are you" is
"Hello how are you", not "Hellohow are you". A password field is never
read or described. On a Mac, Electron and Chromium apps are asked to build
their accessibility tree (AXManualAccessibility), which changes nothing
else about them. Linux reads no field yet. `desktop.field.read` turns it
off; `desktop.field.chars` and `desktop.field.timeoutMs` bound it. CI now
runs the Windows reader for real and compiles the Mac one (nativeCheck.js).

### 0.3.6 — the pill comes apart while it listens

At rest the pill is a capsule: two halves, ink and cream, and they are the
✕ and the ✓. Hover opens it around "Tap Ctrl twice to talk" with the cream
half a cap at the end. Listening, it comes apart: the halves round into the
✕ and ✓ discs on their way to the edges of the screen. Stopped, they come
home and click shut; writing, a glint runs over the shut capsule; an error
opens it around the reason with the cap gone rose. `desktop.pill.capsule`
turns it off (the slim pill with three squares), and its size is
`desktop.pill.capsuleWidth`/`capsuleHeight`.

Listening, the pill comes apart where it sits: ✕ glides out to the
left edge of the screen, ✓ to the right, and a thread the voice plucks runs
between them (slack and barely moving when you are quiet, ringing when you
talk, plucked when a pause writes a chunk). Stopped, the halves glide home
and go back into the pill, small again in its own place. The thread
replaces the bars, which the owner asked to rethink. Only the two halves
take clicks; the thread and the screen between them stay the app's.

The pill never grows into a wide pill of dots: not to listen, and not to
write (it writes shut, small, in its own place). Once it has written it goes straight back to rest: no "✓ 12
words", since the words are already in the field. `desktop.pill.showDone` brings the
count back.

For it the pill's window now spans the screen's work area, still
transparent and click-through. `desktop.pill.split` (server) turns it off and
brings back the joined pill with its bars; `desktop.pill.splitMaxWidth` caps
the reach on an ultrawide. The thread's look and feel are knobs too
(`desktop.pill.thread*`, `desktop.pill.hand*`, `desktop.pill.splitMs`).

### 0.3.5 — a fresh install starts signed out, an update never signs out

Downloading the same version from the site and running it over the
installed one opened signed in to whoever used the PC last: electron-builder
removes the old copy as an update, which keeps app data. The installer now
reads which version is installed before it starts: nothing, or this same
version, and it forgets the account (session.json); any other version is an
update and keeps it, as "Update now" (`--updated`) always does. Settings stay
either way.

The Microsoft Store copy keeps its data in its own folder (`Tailzu Store`).
It used the site build's folder name, and Windows lets a Store app write a
folder that already exists in place, so it read the site build's sign-in and
left its own behind on uninstall. Its first launch in the new folder brings
over what it kept in the old one, so updating from 0.3.4 stays signed in.

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
