// The server's "open" event: the only links a run may open (a mail draft, a
// chat with a message written in), checked here before anything opens.

/** Longest link the server's `open` event may carry: a mail draft or a message, not a download. */
const OPEN_URL_MAX = 8000;
/** The only parts of a mailto: link that are an email. `attach` and the like are not. */
const MAILTO_FIELDS = new Set(["to", "cc", "bcc", "subject", "body"]);

/**
 * The https hand-offs an `open` may carry, each a site's own link to write a
 * message, share, search or set a route for the person to finish there: its
 * exact host and the path it is under. A path ending in / is a prefix; any
 * other is that path or one below it (/search and /search/x, never /searchx).
 * Maps links are only Google's documented form (api=1). Phone-only links
 * (upi:, tel:, sms:) are never here: the server keeps them for the phone.
 */
const OPEN_LINKS = [
  { host: "mail.google.com", path: "/mail/" },             // Gmail compose
  { host: "wa.me", path: "/" },                            // WhatsApp chat or share
  { host: "api.whatsapp.com", path: "/send" },
  { host: "t.me", path: "/share/url" },                    // Telegram share (a t.me/<username> chat is below)
  { host: "www.google.com", path: "/maps/dir", query: ["api", "1"] },
  { host: "www.google.com", path: "/maps/search", query: ["api", "1"] },
  { host: "m.uber.com", path: "/ul" },
  { host: "www.amazon.in", path: "/s" },
  { host: "www.flipkart.com", path: "/search" },
  { host: "www.youtube.com", path: "/results" },
  { host: "music.youtube.com", path: "/search" },
  { host: "open.spotify.com", path: "/search" },
  { host: "www.threads.net", path: "/intent/post" },
  { host: "www.threads.com", path: "/intent/post" },
  { host: "www.booking.com", path: "/searchresults.html" },
];
/** A Telegram username as a t.me path: a letter, then letters, digits or _, 4 to 32 in all. */
const TELEGRAM_USER = /^\/([A-Za-z][A-Za-z0-9_]{3,31})\/?$/;
/** t.me's own pages, which are no one's username: they join, log in, pay or set a proxy. */
const TELEGRAM_PAGES = new Set([
  "share", "proxy", "socks", "joinchat", "login", "confirmphone", "setlanguage", "addstickers", "addemoji",
  "addtheme", "addlist", "invoice", "giftcode", "boost", "contact", "premium", "stars", "nft",
]);

const under = (pathname, path) => path.endsWith("/") ? pathname.startsWith(path) : pathname === path || pathname.startsWith(path + "/");

/** A t.me/<username> link: that chat, with at most a message written in (`text`), and nothing it does by itself. */
function telegramChat(u) {
  const m = TELEGRAM_USER.exec(u.pathname);
  if (!m || TELEGRAM_PAGES.has(m[1].toLowerCase())) return false;
  for (const k of u.searchParams.keys()) if (k !== "text") return false;
  return true;
}

/**
 * The link the server's `open` event may open on this computer, or null.
 * An https hand-off in OPEN_LINKS (exact host and path, no credentials or
 * port), a t.me/<username> chat, or a mailto: link carrying only mail fields.
 * Anything else, whatever the server says, is dropped, so an `open` can write
 * a message, a search or a route for the person to finish, and can never
 * launch a program, a file, a payment, a call or any other site.
 */
function safeOpenUrl(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > OPEN_URL_MAX) return null;
  if (/[\u0000-\u0020\u007f]/.test(raw)) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol === "https:") {
    if (u.username || u.password || u.port) return null;
    const link = OPEN_LINKS.find((l) => l.host === u.hostname && under(u.pathname, l.path)
      && (!l.query || u.searchParams.get(l.query[0]) === l.query[1]));
    return link || (u.hostname === "t.me" && telegramChat(u)) ? u.href : null;
  }
  if (u.protocol === "mailto:") {
    for (const k of u.searchParams.keys()) if (!MAILTO_FIELDS.has(k.toLowerCase())) return null;
    return u.pathname ? u.href : null;
  }
  return null;
}

module.exports = { safeOpenUrl };
