// tulmi:// links: the screen a link may open in the window, and nothing else
// taken from it.

// The page a browser lands on after someone connects an app (the server's
// /v1/connectors/callback) has an "Open Tailzu" button that is a tulmi:// link,
// the scheme the phone app already answers. A computer answers it too: the
// window comes up, on Connected apps. Only a screen id is ever taken from a
// link, and only the ones below: anything else just brings the window up.
// A space's invite (its page's "Open in Tailzu": tulmi://screen/bots.spaces?join=CODE)
// opens Spaces at joining, with the code and nothing else from the link.
const LINK_SCREENS = { assistant_apps: "desk_settings", assistant_tasks: "desk_tasks" };
const JOIN_SCREEN = "bots.spaces";
const JOIN_CODE = /^[A-Z0-9]{6,16}$/;
function screenFromLink(raw) {
  try {
    const u = new URL(String(raw || ""));
    if (u.protocol !== "tulmi:" || u.hostname !== "screen") return null;
    const id = u.pathname.replace(/^\//, "");
    if (id === JOIN_SCREEN) {
      const join = String(u.searchParams.get("join") || "").toUpperCase();
      return JOIN_CODE.test(join) ? { screenId: JOIN_SCREEN, params: { join } } : null;
    }
    return Object.prototype.hasOwnProperty.call(LINK_SCREENS, id) ? LINK_SCREENS[id] : null;
  } catch { return null; }
}

module.exports = { screenFromLink };
