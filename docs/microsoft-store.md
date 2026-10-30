# X0 Bot on the Microsoft Store: the listing

Everything Partner Center asks for, field by field, ready to paste. The images are made by one command in the phone
repo (`npx tsx tools/media/store/windows.mts`, from `TAILZU-BACKEND/tulmi`) and land in
`TAILZU-FRONTEND/tools/media/store/out/windows/`.

Limits in brackets are Partner Center's.

---

## Product setup

| Field | Value |
| --- | --- |
| Product name (reserved) | X0 Bot |
| Category | Productivity |
| Pricing | Free (plans are bought in the app) |
| Privacy policy URL | https://x0bot.com/privacy |
| Website | https://x0bot.com |
| Support contact | https://x0bot.com/support (or support@x0bot.com) |
| Copyright and trademark info [200] | © 2026 XOOTEQ LAB PRIVATE LIMITED. X0 Bot is a trademark of XOOTEQ LAB PRIVATE LIMITED. |
| Developed by [255] | XOOTEQ LAB PRIVATE LIMITED |
| Additional license terms | https://x0bot.com/terms |

## Store listing (English, United States)

### Description [10,000]

```
X0 Bot puts your bots on your computer. Hold one key and speak in any app, ask anything and the right bot takes it, and let your bots do the work while you get on with yours. Every bot shows you the plan before it acts, and asks before anything that matters.

KEYLESSBORD: SPEAK INSTEAD OF TYPE, IN EVERY APP
Hold your key, say it, let go. Your words land where your cursor is, in Gmail, WhatsApp, Word, Slack, your browser, anywhere you type. Speak in English, Hindi, Hinglish or any mix, and Keylessbord writes it the way you write: your punctuation, your names, your tone. Select text and say how to change it ("make this shorter", "in Hindi") and it rewrites it in place.

ASK ONCE, THE RIGHT BOT TAKES IT
Type or say what you need. X0 Bot picks the bot for it, shows who will answer and what it will do first, and you send it when it looks right.

XODE: YOUR CODE, FIXED AND ASKED FIRST
Connect GitHub and tell Xode what to do in a project. It reads the code, plans, makes the change on its own branch, runs the tests and opens a pull request. It asks you when there is a choice to make, and nothing ships without your yes. When this computer is on, Xode can run its tests and builds here, in its own folder, from a read-only copy of your code.

PLAN EASE AND TRAVEL BOT
Plan Ease turns a goal into short steps with times and puts them on your calendar and task list. Travel bot finds trains, flights and stays and lays them out for you to choose. When money is involved, you press pay, always.

NOTES THAT WRITE THEMSELVES
Take notes in any meeting or call. X0 Bot writes down who said what, pulls out what was decided and what is still to do, and keeps it all searchable.

MAKE YOUR OWN BOTS
Say what a bot should do and X0 Bot builds it, with the apps it may use and the rules it follows. Share bots and lists with family and friends in Spaces.

YOU ARE IN CHARGE
Activity shows everything your bots did, with a receipt for each. What pings you is yours to set: needs you always reaches you, the rest can wait quietly, and quiet hours keep the night quiet. Your data is never sold and never used to train AI models. Download or delete it any time.

Free to start. Plans give your bots more room every month.
```

### What's new in this version [1,500]

```
- The bots have new names: Xode (code), Keylessbord (voice typing in every app) and Plan Ease (plans and your calendar).
- A new look: Bots, Activity and You, the same as on the phone.
- Clear any row from Activity with its ✕.
- Set the daily summary and quiet hours to any time you like.
- Pages open instantly: everything is loaded ahead and kept fresh.
```

### Product features [20 × 200]

```
Hold one key and speak in any app: your words appear where your cursor is
Speak English, Hindi, Hinglish or any mix, written the way you write
Select text and say how to change it: shorter, friendlier, in Hindi
Ask once and the right bot takes it, showing its plan before it acts
Xode fixes and builds code in your GitHub projects and asks before anything ships
Xode can run tests and builds on this computer, from a read-only copy
Plan Ease puts goals on your calendar and task list as short timed steps
Travel bot finds trains, flights and stays for you to choose
Meeting notes that write themselves: who said what, decisions, to-dos
Make your own bots with the apps they may use and the rules they follow
Spaces: share bots, lists and plans with family and friends
Activity shows everything your bots did, with a receipt for each
Needs you always reaches you; quiet hours keep the night quiet
Money is always yours to approve: you press pay
Your data is never sold and never used to train AI models
```

### Screenshots (Desktop) [up to 10; 1366 x 768 or larger]

Upload in this order, from `out/windows/screenshots/` (3840 x 2160 PNG). Captions [200]:

| File | Caption |
| --- | --- |
| 01-home.png | Your bots, all in one place: what they are doing, and what needs you |
| 02-keylessbord.png | Hold a key and speak in any app. Keylessbord writes it the way you write |
| 03-ask.png | Ask once. The right bot takes it, and shows its plan first |
| 04-xode.png | Xode fixes your code in GitHub, runs the tests and asks before anything ships |
| 05-notes.png | Notes that write themselves: who said what, decisions and to-dos |
| 06-activity.png | See everything your bots did, with a receipt for each |

### Store logos and promotional images

| Partner Center slot | File | Size |
| --- | --- | --- |
| 1:1 box art | box-art-1x1.png | 2160 x 2160 |
| 2:3 poster art | poster-2x3.png | 1440 x 2160 |
| 16:9 super hero art | hero-16x9.png | 3840 x 2160 |
| 1:1 app tile icon | tile-300.png | 300 x 300 |

### Search terms [7 × 30, 21 words in all]

```
voice typing
speech to text
hindi typing
dictation
ai assistant
meeting notes
ai coding agent
```

### Short description [1,000]

```
Your bots on your computer. Hold a key and speak in any app, ask once and the right bot takes it, and let Xode, Plan Ease and Travel bot do the work. Every bot shows its plan first.
```

## System requirements

| | Minimum | Recommended |
| --- | --- | --- |
| OS | Windows 10 version 1809 (x64) | Windows 11 |
| Memory | 4 GB | 8 GB |
| Hardware | Microphone, internet connection | A headset for meetings |

## Age rating (IARC questionnaire)

- Category: Productivity, utility, not a game.
- Users can talk to each other: **Yes** (Spaces chats with people they invite). Reporting and blocking are in the app.
- Shares the user's location: **No**.
- Digital purchases: **Yes** (subscription plans).
- Unrestricted internet access (a browser): **No**.
- Violence, sex, drugs, gambling, crude humour: **None**.

Expected rating: PEGI 3 / ESRB Everyone, with "Users Interact" and "In-Game Purchases" notices.

## Before the first submission

1. **Product identity.** Partner Center → the product → Product identity gives three values. Put them in this repo on
   GitHub, Settings → Secrets and variables → Actions → **Variables** (not secrets):
   `MSSTORE_IDENTITY_NAME` (Package/Identity/Name), `MSSTORE_PUBLISHER` (Package/Identity/Publisher, `CN=…`) and
   `MSSTORE_PUBLISHER_NAME` (Package/Properties/PublisherDisplayName). The build only makes the Store package once the
   first two are set, so the package always matches the reservation.
2. **The package.** Run the build (Actions → build → Run workflow); the run page then has an artifact `Tailzu-store`
   holding `Tailzu.appx`. Upload that file under Packages (the Store signs it, so no certificate is needed for it).
3. **Payments.** Plans are bought through the app's own checkout (Razorpay, opened in the browser). Microsoft Store
   Policy 10.8.2 allows this for apps that are not games; say so in the certification notes.
4. **Certification notes** (for the testers): "Sign in with Google or email. To try voice typing, hold the key shown in
   Keylessbord (Right Ctrl by default on Windows) in Notepad and speak. Microphone permission is asked the first time."
