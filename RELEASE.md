# Publishing the desktop app

The delivery side is already built. `tailzu.space/download` detects the
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
npm --prefix desktop run dist:win      # on Windows
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
npm --prefix desktop run dist:mac:signed
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

## What this does not do yet

There is no auto-update. Every release is a fresh download from the page, and
users who installed an older build have no way to know. electron-updater plus
a published feed is the answer when the installed base is large enough to care;
until then, the version in Settings is how anyone tells what they have.
