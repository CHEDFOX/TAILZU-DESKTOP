/**
 * The desktop app window — the same server-drawn app the phones render.
 *
 * WHY THIS IS A RENDERER AND NOT A SECOND APP
 *
 * Every screen in Tailzu is JSON from /v1/app/screen: the tabs, the copy, the
 * charts, the paywall, which nodes exist and what they do. The phones ship a
 * renderer for that JSON and nothing else. So the desktop needs a renderer for
 * that JSON and nothing else — and a screen added to the catalog appears here
 * without a desktop release, exactly as it does on iOS and Android.
 *
 * WHY IT NEEDS A REAL SIGN-IN
 *
 * The tray's dictation runs on a static bearer token, which the backend
 * resolves to a stable synthetic user ("static-…"). That is fine for
 * transcription, which needs no history. It is useless for everything else:
 * a synthetic id is not a UUID, it matches no row in any table, so stats,
 * history, voices and entitlement all come back empty. The window signs in
 * properly — email OTP against Supabase, the same account as the phone — and
 * every screen then holds the same data the phone shows.
 *
 * Supabase's REST auth is two POSTs, so there is no SDK here. The anon key is
 * the public client credential; the tokens it returns are stored by the main
 * process, never by this renderer.
 *
 * ONE RENDERER, ONE FILE PER PART. The files in this folder are classic
 * scripts that share the page's global scope, loaded by app.html in order:
 * this one (the constants and the window's state) first, boot.js (the start)
 * last. Nothing a file runs while it loads reaches into a file loaded after
 * it.
 */

/* eslint-env browser */

const SUPABASE_URL = "https://merzyohecmyfvlyahxaz.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1lcnp5b2hlY215ZnZseWFoeGF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyMjU1MzAsImV4cCI6MjA5NzgwMTUzMH0.scDhHeRU20wRIgKBFL8GouIEp8bJG8w8aIsySUkePHY";

const SCHEMA_VERSION = 1;

/** Node types this renderer draws. Sent in the capability handshake, so the
 *  server never emits a node the window cannot handle — the same contract the
 *  phones use, honoured honestly rather than claimed. */
const COMPONENTS = [
  "Screen", "Stack", "Spacer", "Text", "Image", "Icon", "Button", "TextField",
  "Chip", "Card", "List", "Divider", "Row", "Overline", "Heading", "Paragraph",
  "Quote", "Badge", "KeyValue", "Hero", "Switch", "SegmentedControl",
  "StatCard", "BarChart", "LineChart", "Sparkline", "PieChart", "DonutChart",
  "ProgressRing", "Gauge", "WordMeter", "Video", "Audio", "Grid",
  // A box that scrolls on its own inside a card (nodes.js; the terms and privacy card).
  "Scroll",
  // Drawn here as well as on the phones. Every one of these was falling
  // through to `default`, which renders a node's CHILDREN and drops the node —
  // so a Gradient, an SVG or a scrim simply did not appear, and the window was
  // not a smaller version of the app but the app with its icons, its scrims
  // and its one button missing.
  "SVG", "Gradient", "BlurBackground", "FlipText", "Modal", "ProgressBar",
  "SwipeAction", "NeuralField",
  // The Notes page's Stop sends "notes.stop" with the note's id (the server checks for this before it does).
  "NotesStop",
  // A stack's `hint`: a small card shown while the pointer is on it, or it has the focus (nodes.js hintOf). Settings' app icons.
  "HoverHint",
  // The Train tab, in full. The conversation is a real repeater here now, and
  // the mic records in the page rather than through the tray's global hotkey —
  // so the refine screen is the same screen it is on a phone, not a notice
  // saying it needs an update.
  "ChatThread", "VoiceToggle", "VoiceButton",
  // The spoken session: a socket to the same transcribe stream the tray uses,
  // the same converse endpoint, and the browser's own synthesiser for the
  // reply. The phone version spends half its length on audio-session
  // categories so the reply leaves the speaker rather than the earpiece; a
  // window has neither, so none of that exists here.
  "VoiceSession",
  // THE DESK. A window-shaped Tailzu rather than a phone's screens in a
  // frame: a masthead instead of a rail, pages that run the width of the
  // window, the said line above the written one. Declared so the server sends
  // those pages only to a build that can draw them; an older installer keeps
  // the rail and the phone screens it has always had.
  "DeskShell", "Keys",
  // A NeuralField the window can actually show on a page with a ground of its
  // own (groundView). A build without it drew the field behind the sheet, so
  // the server keeps the field off the desk's pages for those.
  "DeskField",
  // THE ONBOARDING: a stage that glides one step out and the next in, and the
  // empty spot where Blip stands in each step. Declaring them also promises the
  // optional props that ship in the same release (the field sign-in, the code
  // boxes, the labelled Google and Apple buttons, a held mic, a style value
  // that follows state). The server sends the new onboarding only to a build
  // that says both; an older installer is served the one it has always had.
  "OnboardStage", "BlipSpot",
  // THE BOTS APP'S KIT (the server's shared/types/sdui.ts, "The Bots app's kit"): SVG `shapes` with the
  // breathe / pop / draw motions (app.html's .tz-work / .tz-pop / .tz-draw, still under Reduce Motion), a Text
  // bound to state, a TextField whose Enter runs on.onSubmit, navigate params read from state, and a Bots page
  // (look "bots") where a border with a width is a solid one. The server boots the Bots app only for a build
  // that says this.
  "BotsKit",
  // THE LIVING BOT TILES (shared/types/sdui.ts, "The living bot tiles"): BotTiles, Home's grid with a tiny Blip
  // playing in each tile on a faint fabric, and BotCard, a card with one on top (the first-arrival permission
  // card, Keylessbord's). The physics is botTiles.js, generated from the phone's core so the two cannot differ.
  "BotsMotion", "BotTiles", "BotCard",
  // A full-width strip under BotTiles' grid (Notes), its bot at the left, in the same world as the tiles.
  "BotTilesStrip",
  // A bot's own tiny bot on its pages (a header, Xode's setup steps): BotBuddy, on the same core.
  "BotBuddy",
  // BotBuddy's act "carry" and `doneWhen`: a lane under a message on its way, where he hauls it as a bag, heavier
  // each trip, and sets it down when the answer is here (botBuddyNode). Without it the server sends "Asking…".
  "BotBuddyCarry",
  // THE BOTS' LOOKS AND MOMENTS (shared/types/sdui.ts, "Looks and moments"): avatars and moments from the server's
  // catalog (botLooks.js is the starter, btLooks() keeps the newest), played by botTiles.js on BotTiles, BotBuddy and
  // BotCard (`avatar`, `moment`, `momentMode`, `momentEndWhen`, BotTiles `surprises`). Without it: a moment's plain act.
  "BotMoments",
  // callEndpoint's `stream`: an answer's words and what the bot is doing, written into state as they come over the live
  // socket (live.js, topic ask:<id>), the line bound to them changed in place (askStreamTake).
  "AskStream",
  // Home's header, alive: the line that writes itself (WriteOn), the living mark (LiveMark), the compact bar (HeadBar).
  "WriteOn", "LiveMark", "HeadBar",
  // SPACES, THE FAMILY REDESIGN (shared/types/sdui.ts 3i). BotStage: a full tiny bot on a stage of his own who roams, walks out and
  // back in, listens and holds a thought (a box joined to his head by three bubbles) that follows him and opens; BotCrowd: a box of
  // tiny bots playing; Vanish: a row that vaporises; MentionField: "@" for a person, "/" for a bot's thing; LiveWords: what he hears,
  // as he hears it (sdui/stage.js, mention.js, listen.js). Not components: DoubleTap (a double-click on him or a bot tile) and
  // KitExtras (a TextField's keyboard, autoFocus and maxLength; startAtEnd; callEndpoint's stay; a dotted border with a radius;
  // a failed call's { code, message } at state lastError). The server sends the new Spaces and Home's ask as his thought only to a
  // build that says all of these; an older installer keeps the screens it has. Not ActionParams: the window has always filled
  // "$state.x" params without declaring it, and the server asks the name of the phone only.
  "BotStage", "BotCrowd", "Vanish", "MentionField", "LiveWords", "DoubleTap", "KitExtras",
  // PEOPLE AS THEIR OWN TINY BOTS (shared/types/sdui.ts 3j): PersonBot, a person's full tiny bot standing in a size x size box,
  // idling on one loop for the window (sdui/personBot.js), also in each row of MentionField's "@" list from the row's `bot`. Without
  // it the server sends a plain circle in the person's colour. Not a component: FontBricolage, the three Bricolage Grotesque faces
  // a space's messages are set in, bundled (app.html "Tailzu Bricolage", "... Medium", "... SemiBold"); without it, Geist.
  "PersonBot", "FontBricolage",
];
// Declared only by a copy that can put an update in place of itself (the main
// process knows: updater.js). The server then sends the one-click update card;
// a copy that cannot gets the download link.
const SELF_UPDATE = "DeskSelfUpdate";
/** The note-taker is here: the server sends the Notes tab and its pages. */
const NOTES = "DeskNotes";
/** This computer shows the server's notices from the main process's own live
 *  socket (src/main/notices.js): Plan Ease's reminders and day notes reach it,
 *  with their buttons on a Mac, and the phone's copy then comes without a
 *  sound. Said by the main process (env.notices: it can show one at all). A
 *  build that says it also runs a node's onAppear (nodes.js appearAt), so the
 *  hand-off screen a notice opens (bots.plan.go: Maps) does its job here. */
const NOTICES = "DeskNotices";
/** "Add this" said with something on the screen carries what is there to Plan
 *  Ease's one box (src/dictation/addThis.js). Said by the main process
 *  (env.addThis); the server answers with desktop.plan.addThis once its box
 *  reads it. */
const ADD_THIS = "DeskAddThis";
/** A Mac that can open the computer's-sound permission from a note. */
const SYSTEM_AUDIO = "DeskSystemAudio";
/** Ask is on in this copy (the main process says so: env.askSetup), so the
 *  server may send its one-time setup card, which this window draws with the
 *  permission states only the main process can read. */
const ASK_SETUP_CARD = "DeskAskSetup";
/** This window shows the assistant's side: Connected apps in Settings, the
 *  Tasks page, and the connector.connect action that signs an app in. The
 *  server sends them only while connected apps are switched on there. */
const CONNECTORS_CAN = "DeskConnectors";
/** This window can say whether the computer lets Tailzu use the microphone
 *  (tailzuApp.micStatus, the main process's reading) and ask for it (the
 *  system's own prompt, through requestPermission): the Bots app then sends its
 *  microphone card, drawn while the answer is no. */
const MIC_ASK = "DeskMicAsk";
const micAskOn = () => !!(window.tailzuApp && typeof window.tailzuApp.micStatus === "function" &&
  navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function");
/** This window can say whether the computer lets Tailzu type into other apps
 *  (tailzuApp.axStatus: the Mac's Accessibility; any other system has none):
 *  a page that asks after it gets the answer in $state.axGranted (axFollow),
 *  so the Bots app's arrival card moves on, and closes, once it is on. */
const AX_STATE = "DeskAxState";
const axAskOn = () => !!(window.tailzuApp && typeof window.tailzuApp.axStatus === "function");
/** The bot on the screen can listen (VoiceLive: the main process records for him, src/dictation/windowVoice.js) and the one key,
 *  with X0 in front, talks to him (DeskTalkTo): both need a main process that has the window's voice. The renderer and the main
 *  process ship together, so this mainly keeps a page loaded without one (the backend's render tool, the tests) honest. */
const VOICE_ON = () => !!(window.tailzuApp && typeof window.tailzuApp.voice === "function");
// NOT declared: ScreenHoldTouches. The window does not implement it, and
// claiming a component to unlock a layout is how a capability list stops
// meaning anything. The backend reaches the same conclusion from
// `formFactor: "desktop"` and for the true reason — the flag exists because a
// scroll view steals the touches of a child being DRAGGED, and nothing here is
// dragged: the pill is a click, because a mouse has no thumb to rest.
const ACTIONS = [
  "navigate", "back", "switchTab", "callEndpoint", "setState", "toggleState",
  "toggleInArray", "refresh", "openUrl", "toast", "haptic", "sequence",
  "delay", "reloadScreen",
  // navigateBack is the important one: the catalog names it fifteen times and
  // this renderer knew only "back", so every back control in the window was
  // drawn, clickable, and did nothing.
  "navigateBack", "dismiss", "clearState", "appendState", "condition",
  // Buying. There is no store on a desktop, so these open RevenueCat's Web
  // Billing checkout in the user's browser and then ask the server again.
  // Declared, because a capability list that omits them is the server being
  // told this window cannot take a payment — and it now can.
  "iap.subscribe", "iap.showPaywall", "iap.restore",
  // What only a desktop has: a clipboard to put a note back on, settings that
  // live on this computer (the pill, the shortcut), a microphone started from
  // a page, and a way out of the account from the settings page itself.
  "copyText", "desktop.config", "dictate", "signOut",
  // Start or stop the note-taker from the Notes page; Stop names the note (main.js stopNoteById), so it stops even one left
  // recording on the server after the app quit, instead of starting another.
  "notes.toggle", "notes.stop",
  // A note's Allow button (macOS): the computer's-sound permission.
  "notes.allowSystemAudio",
  // The update card's button: download, check and install the new build here.
  "installUpdate",
  // The Ask setup card's buttons. The two settings pages are Mac only and
  // fixed addresses the main process holds: the window names which, never
  // where. picturesAll takes `on` (true or false); relaunch restarts Tailzu,
  // which macOS can need before a new Screen Recording grant takes.
  "ask.openAccessibility", "ask.openScreenRecording", "ask.picturesAll", "ask.relaunch",
  // Connect an app from Settings: POST /v1/connectors/:id/connect, then the
  // sign-in page it answers with opens in the browser (connectApp).
  "connector.connect",
  // The microphone card's button: the system's own prompt (microphone only).
  "requestPermission",
  // The bot on the screen listens with live words, turn by turn, and stops (sdui/listen.js; capability VoiceLive, when VOICE_ON).
  "voiceLive", "voiceStop",
];

/**
 * The server's knobs (knobs.js, loaded before this file). Every literal this
 * renderer used to decide for itself — a toast's words, how long a slow load
 * waits before saying so, a switch's size — is read through these, with the
 * old literal as the fallback. Fed every bootstrap this window receives, and
 * the main process's cached copy before the first one lands.
 */
const K = window.TailzuKnobs;

let ENV = null;          // baseUrl, session, appVersion, launchCount, knobs, ...
let SESSION = null;      // { access_token, refresh_token, expires_at }
let BOOT = null;
let TABS = [];
let STACK = [];          // [{ screenId, params }]
/**
 * Flip lines waiting for their ticker.
 *
 * Collected while a screen renders and started once it is in the DOM —
 * rendering returns a string here, so there is no element to attach to until
 * the paint lands. Cleared on every paint so a screen that is gone cannot keep
 * turning words over in a document that no longer holds it.
 */
let FLIPS = [];
let FLIP_TIMERS = [];
let STATE = {};          // per-screen state, replaced on every navigation
let TAB_ID = "";
// The desk: set when the server says this window gets its own pages (the
// masthead, the width of the window) rather than the phone's.
let DESK = false;
// Settings that live on this computer — the pill, pausing, the keys that are
// bound — read from the main process and put under `state.desktop` on every
// screen, so a page can show them and a switch can change them.
let LOCAL = {};

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
