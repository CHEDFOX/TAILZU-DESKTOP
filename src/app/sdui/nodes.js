// The node renderer: node() turns one server node into markup, with the
// handlers it binds once the markup is in the page.

let handlers = [];        // [{ id, action }] — bound after innerHTML lands
let SUBMITS = [];         // actions an Enter in a desk field runs, by 1-based index

/**
 * THE KEYS THIS COMPUTER HAS BOUND, drawn as keys.
 *
 * Only the main process knows them — the server cannot, and a page that said
 * "Ctrl twice" to someone who moved it to Alt would be wrong in the one place
 * it is trying to teach. So the node names which binding to draw and the keys
 * come from `state.desktop`, as keycaps.
 */
function keysNode(p, s) {
  const d = LOCAL || {};
  const small = /(^|\s)d-keys-small(\s|$)/.test(String(p.cls || "")) ? " d-keys-small" : "";
  // THE ONE KEY has no notes chord (main.js binds none with it): notes start and stop by saying so with that key held.
  if (p.source === "notes" && d.oneKey) {
    const key = String(d.oneKeyLabel || d.hotkey || "");
    const words = K.txt("desktop.notes.oneKeySay", "Say “take notes” / “stop notes” with {key}").split("{key}");
    return '<span class="d-keys' + small + '" style="' + s + '">' + esc(words[0] || "") +
      (key ? '<span class="d-keycap">' + esc(key) + "</span>" : "") + esc(words.slice(1).join("")) + "</span>";
  }
  const tap = d.tap !== false && Array.isArray(d.tapKeys) && d.tapKeys.length;
  const keys = p.source === "notes" ? String(d.notesHotkey || "Ctrl+Alt+N").split("+").map((k) => k.trim()).filter(Boolean)
    : p.source !== "hotkey" && tap ? [d.tapKeys[0], d.tapKeys[0]]
    : String(d.hotkey || "Ctrl+Shift+Space").split("+").map((k) => k.trim()).filter(Boolean);
  return '<span class="d-keys' + small + '" style="' + s + '">' +
    keys.map((k) => '<span class="d-keycap">' + esc(k) + "</span>").join("") + "</span>";
}

/**
 * SVG `shapes` (the Bots kit): circles and paths, each with its own paint, and the kit's motions as app.html's
 * classes: .tz-work (breathe, loops), .tz-pop (lands once), .tz-draw (a ring draws to its dash, once). A rotation
 * goes on a group around the shape, so it never fights the motion's own transform. Reduce Motion stops them all.
 */
function svgShapes(p, s) {
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0);
  const shapes = p.shapes.filter((sh) => sh && typeof sh === "object").slice(0, 64).map((sh) => {
    const cls = sh.motion === "breathe" ? "tz-work" : sh.motion === "pop" ? "tz-pop" : sh.motion === "draw" ? "tz-draw" : "";
    const dash = typeof sh.dash === "string" && /^[0-9.\s,]+$/.test(sh.dash) ? sh.dash : "";
    const full = dash ? Number(dash.split(/[\s,]+/)[1]) || 0 : 0;
    const style = (sh.delayMs ? "animation-delay:" + num(sh.delayMs) + "ms;" : "") + (cls === "tz-draw" && full ? "--tz-c:" + full + ";" : "");
    const attrs = (cls ? ' class="' + cls + '"' : "") + (style ? ' style="' + style + '"' : "") +
      ' fill="' + esc(tok(sh.fill) || "none") + '"' +
      (sh.stroke ? ' stroke="' + esc(tok(sh.stroke)) + '" stroke-width="' + num(sh.strokeWidth || 1.5) + '"' : "") +
      (dash ? ' stroke-dasharray="' + dash + '"' : "") +
      ' stroke-linecap="' + esc(sh.linecap || "round") + '" stroke-linejoin="' + esc(sh.linejoin || "round") + '"' +
      (sh.opacity != null ? ' opacity="' + num(sh.opacity) + '"' : "");
    const c = Array.isArray(sh.circle) ? sh.circle.map(num) : null;
    const el = c ? '<circle cx="' + c[0] + '" cy="' + c[1] + '" r="' + c[2] + '"' + attrs + "></circle>"
      : '<path d="' + esc(sh.d || "") + '"' + attrs + "></path>";
    if (!sh.rotate) return el;
    const o = Array.isArray(sh.origin) ? sh.origin.map(num) : c ? [c[0], c[1]] : [12, 12];
    return '<g transform="rotate(' + num(sh.rotate) + " " + o[0] + " " + o[1] + ')">' + el + "</g>";
  }).join("");
  const aria = p.accessibilityLabel ? ' role="img" aria-label="' + esc(label(p.accessibilityLabel)) + '"' : ' aria-hidden="true"';
  return '<svg viewBox="' + esc(p.viewBox || "0 0 24 24") + '"' + aria + ' style="' + s + ';display:block;flex:none;overflow:visible">' + shapes + "</svg>";
}

function bind(action) {
  if (!action) return "";
  const id = "h" + handlers.length;
  handlers.push({ id, action: STATE && STATE.item !== undefined ? withItem(action) : action });
  return ' data-h="' + id + '"';
}

/**
 * A ROW'S ACTION REMEMBERS ITS ROW.
 *
 * A List draws each item with `state.item` set, and unsets it when the row is
 * drawn. Clicks come later — so "copy this note" or "delete this word",
 * written as `$state.item.text`, would read an item that no longer exists and
 * act on nothing. The references to the item are filled in when the row is
 * drawn; everything else in the action is left for the click.
 */
function withItem(v) {
  const ITEM = /\$state\.item\.[A-Za-z0-9_.]+/g;
  if (typeof v === "string") {
    if (/^\$state\.item\.[A-Za-z0-9_.]+$/.test(v)) return stateAt(v.slice(7));
    return v.replace(ITEM, (m) => { const x = stateAt(m.slice(7)); return x == null ? "" : String(x); });
  }
  if (Array.isArray(v)) return v.map(withItem);
  if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v)) o[k] = withItem(v[k]); return o; }
  return v;
}

/** The desk's own classes, by name. Only `d-` names get through: a class is a
 *  stylesheet rule in app.html, and a server that could name any class could
 *  reach styles this window never meant to hand out. */
function cls(p) {
  const list = String((p && p.cls) || "").split(/\s+/).filter((c) => /^d-[a-z0-9-]+$/.test(c));
  return list.length ? ' class="' + list.join(" ") + '"' : "";
}

/**
 * A STACK'S HINT (HoverHint): `props.hint` is a node drawn as a small card under the stack while the pointer is on it or it has
 * the focus, and `props.hintLabel` is what a screen reader hears for it. Only the CSS in app.html (.tz-hint) shows and hides it:
 * nothing here listens for the pointer. The host takes the focus so a keyboard reaches it too.
 */
function hintHost(p) {
  if (!p.hint || typeof p.hint !== "object") return "";
  return ' data-hint tabindex="0"' + (p.hintLabel ? ' aria-description="' + esc(label(p.hintLabel)) + '"' : "");
}
function hintOf(p) {
  if (!p.hint || typeof p.hint !== "object") return "";
  return '<div class="tz-hint" role="tooltip">' + node(p.hint) + "</div>";
}

function node(n) {
  if (!n) return "";
  if (!visible(n.visibleIf)) return n.fallback ? node(n.fallback) : "";
  // The onboarding stage draws the one step it is on, not all of them.
  if (n.type === "OnboardStage") return stageNode(n);
  const p = n.props || {}, st = n.style || {}, s = css(st);
  const kids = (n.children || []).map(node).join("");
  const press = n.on && (n.on.onPress || n.on.onChange || n.on.onSubmit);
  const txt = esc(label(p.content != null ? p.content : p.label));

  switch (n.type) {
    case "Screen":
      // A desk page runs the width of the window and brings its own margins;
      // a phone screen keeps the centred column it was designed for.
      if (p.layout === "full") return '<div' + cls({ cls: "d-screen " + (p.cls || "") }) + ' style="' + s + '">' + kids + "</div>";
      return '<div class="pad" style="' + s + '">' + kids + "</div>";

    case "Row":
      // A SETTINGS ROW, as the phones draw it: the label on the left, a value
      // and a chevron on the right, a hairline under. This window read every
      // Row as a horizontal stack and drew the children it does not have —
      // so Settings was a heading over nothing, and the server's fallback
      // Button never applied because the window had said it could draw a
      // Row. A Row with no label is still the layout row, below.
      if (p.label != null || p.value != null) {
        const chevron = p.chevron !== false;
        return '<div' + bind(press) + ' style="display:flex;align-items:center;padding:' +
          K.num("desktop.row.paddingV", 17) + 'px 0;' +
          (p.divider === false ? "" : "border-bottom:1px solid var(--border);") +
          (press ? "cursor:pointer;" : "") + s + '">' +
          '<span style="flex:1;' + role("row", "font-size:" + K.num("desktop.row.fontSize", 16) + "px;color:" +
            (p.danger ? "var(--danger)" : "var(--text)")) + '">' + esc(p.label || "") + "</span>" +
          (p.value ? '<span style="' + role("rowValue", "font-size:" + K.num("desktop.row.valueSize", 15) + "px;color:var(--muted)") +
            (chevron ? ";margin-right:" + K.num("desktop.row.valueGap", 8) + "px" : "") + '">' + esc(p.value) + "</span>" : "") +
          (chevron ? '<span style="' + role("rowChevron", "font-size:" + K.num("desktop.row.chevronSize", 20) + "px;color:var(--muted)") +
            ';margin-top:-2px">›</span>' : "") +
          "</div>";
      }
      // falls through
    case "Stack": case "SafeArea": case "MorphOut": case "PullToRefresh": case "Grid":
      // A Grid with columns is a grid. It was a column of its children, which
      // is a long way from three apps across.
      if (n.type === "Grid" && Number(p.columns) > 0) {
        return '<div' + bind(press) + rolePress(press) + cls(p) + ' style="position:relative;display:grid;grid-template-columns:repeat(' +
          Math.floor(Number(p.columns)) + ",minmax(0,1fr));gap:" + (Number(p.gap) || 0) + "px" + (press ? ";cursor:pointer" : "") + ";" + s + '">' + kids + "</div>";
      }
      // POSITION:RELATIVE, AND IT IS LOAD-BEARING.
      //
      // React Native paints children in the order they are written. CSS does
      // not: a POSITIONED element paints above a static one however early it
      // comes. So the shape the catalog uses for every full-bleed screen —
      // absolute art, absolute scrim, then the content — put the art and the
      // scrim ON TOP of the content here. The paywall rendered its plans,
      // centred and correctly placed, entirely underneath its own backdrop.
      //
      // Making every in-flow stack relative restores the order the tree
      // means. It also fixes the containing block: an absolutely-positioned
      // child now measures against its own parent, which is what it does on
      // the phones and not what it was doing here.
      return '<div' + bind(press) + rolePress(press) + cls(p) + hintHost(p) +
        (p.accessibilityLabel ? ' aria-label="' + esc(label(p.accessibilityLabel)) + '"' : "") + ' style="' +
        (st.position ? "" : "position:relative;") + "display:flex;flex-direction:" +
        (st.direction === "row" || n.type === "Row" ? "row" : "column") +
        (press ? ";cursor:pointer" : "") + ";" + s + '">' + kids + hintOf(p) + "</div>";

    case "Card":
      return '<div' + bind(press) + ' style="background:var(--card);border:1px solid var(--border);' +
        "border-radius:" + K.num("desktop.card.radius", 18) + "px;padding:" + K.num("desktop.card.padding", 16) +
        "px;margin-bottom:" + K.num("desktop.card.marginBottom", 13) + "px" + (press ? ";cursor:pointer" : "") + ";" + s + '">' +
        kids + (txt ? "<div>" + txt + "</div>" : "") + "</div>";

    case "Spacer":
      // minHeight is what keeps a flexible spacer from closing up completely
      // (the onboarding's, which pushes its button to the foot of the window).
      return '<div style="height:' + esc(st.height || K.num("desktop.spacer.height", 8)) + "px;flex:" + esc(st.flex || 0) +
        (st.minHeight != null ? ";min-height:" + esc(Number(st.minHeight) || 0) + "px" : "") + '"></div>';

    case "Divider":
      return '<div style="height:1px;background:var(--border);margin:' + K.num("desktop.divider.margin", 12) + 'px 0"></div>';

    case "Heading":
      return '<h2 style="margin:0;' + role("heading", "color:var(--text)") + ";" + s + '">' + txt + "</h2>";

    case "Hero":
      return '<div style="margin-bottom:16px"><div style="' + role("h1", "color:var(--text)") + '">' +
        esc(label(p.title)) + '</div><div style="margin-top:4px;' + role("muted") + '">' +
        esc(label(p.subtitle)) + "</div></div>";

    case "Overline":
      return '<div style="' + role("overline", "color:var(--label)") + ";" + s + '">' + txt + "</div>";

    case "Paragraph": case "Quote":
      return '<p style="margin:0;' + role(n.type === "Quote" ? "quoteBlock" : "paragraph", "color:var(--body)") +
        ";" + s + '">' + txt + "</p>";

    case "Text":
      // `variant` names a role — the same switch the phone makes.
      //
      // WHITE-SPACE: PRE-WRAP, because React Native keeps the spaces a string
      // was written with and HTML does not. It collapses a run of them, and
      // trims them entirely at the edges of a flex item — so the consent line,
      // which is one sentence split into parts because two of its words are
      // links, rendered as "our Terms and" with the spaces eaten and the words
      // jammed together. pre-wrap keeps them and still wraps, which is what
      // the phones do with the same tree.
      // A desk line takes its face from its class, and its words from state
      // when it is bound to them — the keys this computer has bound, a note's
      // two lines — so one template can draw every row of a list.
      if (p.cls) {
        const bound = n.bind && n.bind.content ? stateAt(n.bind.content) : undefined;
        const words = bound != null ? esc(String(bound)) : txt;
        return '<span' + bind(press) + cls(p) + ' style="' + s + '">' + words + "</span>";
      }
      // In the onboarding a line can be drawn from state (a language's name, an
      // app's, the words the mic wrote), as the phones do; the server sends no
      // words for it, so it is never put through a translator.
      // Bound to state (the Bots app's, and the onboarding's): the state's value when it has one.
      const live = (IN_STAGE || IN_KIT) && n.bind && n.bind.content ? stateAt(n.bind.content) : undefined;
      // Clipped to a number of lines, as the phones' numberOfLines does.
      const lines = Number(p.numberOfLines) > 0 ? Math.floor(Number(p.numberOfLines)) : 0;
      const clip = lines === 1 ? "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
        : lines > 1 ? "display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:" + lines + ";overflow:hidden;" : "";
      return '<span' + bind(press) + rolePress(press) + ((IN_STAGE || IN_KIT) && n.bind && n.bind.content ? ' data-tb="' + esc(String(n.bind.content)) + '"' : "") + ' style="white-space:pre-wrap;' +
        role(p.variant || "body", "color:var(--text)") + ";" +
        (press ? "cursor:pointer;" : "") + s + (clip ? ";" + clip : "") + '">' + (live != null ? esc(String(live)) : txt) + "</span>";

    case "Badge": case "Chip":
      return '<span' + bind(press) + ' style="display:inline-block;border:1px solid var(--border);border-radius:999px;' +
        'padding:5px 11px;' + role(n.type === "Badge" ? "badge" : "chip", "color:var(--body)") + ";" + (press ? "cursor:pointer;" : "") + s + '">' + txt + "</span>";

    case "Button": {
      // A desk control is a link or an ink button, drawn by its class.
      if (p.cls) return '<button type="button"' + bind(press) + cls(p) + ' style="' + s + '">' + txt + "</button>";
      const primary = p.variant !== "secondary" && p.variant !== "ghost";
      return '<button' + bind(press) + ' style="display:block;width:100%;border:0;cursor:pointer;' +
        (primary ? "background:var(--accent);color:" + K.color("desktop.button.primaryText", "#000")
                 : "background:transparent;color:var(--text);border:1px solid var(--border)") +
        ";border-radius:" + K.num("desktop.button.radius", 14) + "px;padding:" + K.str("desktop.button.padding", "14px 18px") +
        ";margin:" + K.str("desktop.button.margin", "6px 0") + ";" + role(primary ? "button" : "buttonSecondary") + ";" + s + '">' +
        (txt || esc(K.txt("desktop.button.label", "Continue"))) + "</button>";
    }

    case "Row2": case "KeyValue":
      return '<div' + bind(press) + ' style="display:flex;justify-content:space-between;gap:14px;padding:12px 0;' +
        "border-bottom:1px solid var(--border)" + (press ? ";cursor:pointer" : "") + '">' +
        '<span style="' + role("row", "color:var(--label)") + '">' + esc(label(p.label)) + "</span>" +
        '<span style="' + role("rowValue", "color:var(--text)") + '">' + esc(label(p.value)) + "</span></div>";

    case "StatCard":
      return '<div style="background:var(--card);border-radius:14px;padding:15px;flex:1;min-width:0;' + s + '">' +
        '<div style="' + role("label", "color:var(--label);text-transform:uppercase") + '">' + esc(label(p.label)) + "</div>" +
        '<div style="margin-top:5px;' + role("h1", "color:var(--text)") + '">' + esc(p.value) + "</div></div>";

    case "TextField": {
      const path = (n.bind && n.bind.value) || "";
      const val = path ? (stateAt(path) || "") : "";
      const multi = p.multiline === true;
      if (p.cls && !multi) {
        const submit = n.on && n.on.onSubmit ? ' data-s="' + SUBMITS.push(n.on.onSubmit) + '"' : "";
        return '<input value="' + esc(val) + '" data-bind="' + esc(path) + '"' + submit + cls(p) +
          ' placeholder="' + esc(label(p.placeholder) || "") + '" aria-label="' + esc(label(p.placeholder) || "") + '" style="' + s + '">';
      }
      // Enter runs on.onSubmit (the Bots app's ask bar), as it does on a desk field.
      const submit = n.on && n.on.onSubmit && !multi ? ' data-s="' + SUBMITS.push(n.on.onSubmit) + '"' : "";
      const common = submit + ' data-bind="' + esc(path) + '" placeholder="' + esc(label(p.placeholder) || "") +
        '" style="width:100%;background:var(--input);border:1px solid var(--border);border-radius:13px;' +
        "padding:13px 14px;color:var(--text);font:inherit;outline:none;" + s + '"';
      return multi
        ? "<textarea rows=\"4\"" + common + ">" + esc(val) + "</textarea>"
        : '<input value="' + esc(val) + '"' + common + ">";
    }

    case "Switch": {
      const path = (n.bind && n.bind.value) || "";
      const on = truthy(path ? stateAt(path) : p.value);
      if (p.cls) {
        return '<button type="button" role="switch" aria-checked="' + on + '"' + cls(p) +
          (n.on && n.on.onChange ? bind(n.on.onChange) : ' data-toggle="' + esc(path) + '"') +
          ' aria-label="' + esc(label(p.accessibilityLabel || p.label || "")) + '" style="' + s + '"></button>';
      }
      const sw = K.obj("desktop.switch", {
        width: 50, height: 30, knob: 24, inset: 3, offBackground: "rgba(255,255,255,.16)", knobColor: "#fff",
      });
      return '<button' + bind(n.on && n.on.onChange ? n.on.onChange : press) +
        ' data-toggle="' + esc(path) + '" aria-pressed="' + on + '"' +
        ' style="width:' + sw.width + "px;height:" + sw.height + "px;flex:none;border:0;border-radius:" + (sw.height / 2) +
        "px;cursor:pointer;position:relative;background:" + (on ? "var(--accent)" : esc(sw.offBackground)) + '">' +
        '<span style="position:absolute;top:' + sw.inset + "px;left:" + (on ? sw.width - sw.knob - sw.inset : sw.inset) +
        "px;width:" + sw.knob + "px;height:" + sw.knob + "px;border-radius:50%;background:" + esc(sw.knobColor) + '"></span></button>';
    }

    case "List": {
      const items = Array.isArray(p.items) ? p.items : [];
      if (!items.length) {
        const empty = label(p.emptyLabel);
        return empty ? '<p style="color:var(--muted);text-align:center;padding:26px 0">' + esc(empty) + "</p>" : "";
      }
      const tpl = p.itemTemplate;
      return items.map((it) => {
        const saved = STATE;
        STATE = Object.assign({}, STATE, { item: it });
        const html = tpl ? node(tpl) : '<div style="padding:10px 0">' + esc(it.title || it.output || "") + "</div>";
        STATE = saved;
        return html;
      }).join("");
    }

    case "Image": case "Video": {
      const src = p.source && (p.source.url || p.source.uri);
      if (!src) return "";
      // The PARENT usually owns the box. A hero is a Stack carrying the aspect
      // ratio and the clipping, holding a media node whose only instruction is
      // "fill me" — so a percentage has to survive as a percentage. Appending
      // "px" to it produced `height:100%px`, which the browser drops, and the
      // fallback 160px then collapsed a full-bleed hero into a strip.
      const dim = (v, fb) => (v == null ? fb : typeof v === "number" ? v + "px" : String(v));
      const fills = String(st.height) === "100%";
      const box =
        "width:" + dim(st.width, "100%") + ";" +
        (st.aspectRatio ? "aspect-ratio:" + st.aspectRatio + ";"
                        : "height:" + dim(st.height, K.num("desktop.image.height", 160) + "px") + ";") +
        "min-height:0;" +
        // Filling a parent means the parent draws the corners and the spacing.
        "border-radius:" + (st.borderRadius != null ? st.borderRadius : fills ? 0 : K.num("desktop.image.radius", 16)) + "px;" +
        "object-fit:" + (p.contentFit === "contain" ? "contain" : "cover") + ";" +
        "display:block;" + (fills ? "margin:0;" : "margin:0 auto " + K.num("desktop.image.marginBottom", 14) + "px;");
      return n.type === "Video"
        ? '<video src="' + esc(src) + '" autoplay muted loop playsinline style="' + esc(box) + '"></video>'
        : '<img src="' + esc(src) + '" alt="" style="' + esc(box) + '">';
    }

    case "Keys": return keysNode(p, s);

    // Where Blip stands in this step: an empty box the size of his figure, that
    // says in which pose and with what words. The one Blip who walks the
    // onboarding (blip.js createWalker) finds it and goes there.
    case "BlipSpot": return blipSpotNode(p, s);

    case "DeskAskSetup": return askSetupNode(p, s);
    // A running page or artifact: a slot here, the page a layer over it (liveView.js, loaded after this file).
    case "LiveView": return typeof liveViewNode === "function" ? liveViewNode(n, p, s) : "";
    // Sign in with the phone: the QR panel beside the sign-in form (linkSignIn.js, loaded after this file).
    case "DeskLinkSignIn": return typeof linkSignInNode === "function" ? linkSignInNode(p, s) : "";
    case "BotTiles": return botTilesNode(p);
    case "BotCard": return botCardNode(n, p, kids);
    case "BotBuddy": return botBuddyNode(p);
    case "WriteOn": return writeOnNode(p);
    case "LiveMark": return liveMarkNode(n, p);
    case "HeadBar": return headBarNode(p, kids);

    case "WordMeter": return wordMeter(p);
    case "PieChart": case "DonutChart": return pie(p);
    case "BarChart": return bars(p);
    case "Sparkline": case "LineChart": return bars({ series: p.series || p.data, color: p.color });
    case "ProgressRing": case "Gauge":
      return '<div style="height:' + K.num("desktop.progress.height", 6) + "px;border-radius:" +
        (K.num("desktop.progress.height", 6) / 2) + 'px;background:var(--border);overflow:hidden;margin:8px 0">' +
        '<div style="width:' + Math.max(0, Math.min(100, Number(p.value) || 0)) + '%;height:100%;background:var(--accent)"></div></div>';

    // ---- what the phones draw that a window can draw too -----------------
    //
    // These were all falling through to `default`, which renders a node's
    // CHILDREN and drops the node itself. For a Gradient or an SVG that means
    // nothing appears at all; for the greeting it meant no word; for the way
    // into training it meant no control. The desktop was not a smaller version
    // of the app, it was the app with its scrims, its icons, its chevrons and
    // its one button missing.

    case "SVG": {
      // The Bots kit's glyphs: several shapes and their motions.
      if (Array.isArray(p.shapes)) return svgShapes(p, s);
      // One path, viewBox and all, straight through. Every chevron, arrow,
      // cross and tab glyph in the catalog is one of these.
      const vb = esc(p.viewBox || "0 0 24 24");
      const fill = p.fill && p.fill !== "none" ? esc(tok(p.fill)) : "none";
      const stroke = p.stroke ? esc(tok(p.stroke)) : "none";
      return '<svg viewBox="' + vb + '" style="' + s + ';display:block' + (IN_STAGE ? ";flex:none" : "") + '" ' +
        'fill="' + fill + '" stroke="' + stroke + '" ' +
        'stroke-width="' + (Number(p.strokeWidth) || K.num("desktop.svg.strokeWidth", 2)) + '" ' +
        'stroke-linecap="' + esc(p.strokeLinecap || "round") + '" ' +
        'stroke-linejoin="' + esc(p.strokeLinejoin || "round") + '">' +
        '<path d="' + esc(p.d || "") + '"></path></svg>';
    }

    case "Gradient": {
      const cols = (p.colors || []).map((c) => tok(c));
      const locs = p.locations || [];
      const stops = cols.map((c, i) =>
        esc(c) + (locs[i] != null ? " " + Math.round(locs[i] * 100) + "%" : "")).join(",");
      const dir = p.direction === "horizontal" ? "to right" : "to bottom";
      return '<div style="' + s + ';background:linear-gradient(' + dir + "," + stops + ')"></div>';
    }

    case "BlurBackground":
      // A real backdrop blur — the one thing a browser does better than the
      // phones, and for free.
    {
      // The phones' intensity is 0..100; a CSS blur radius a third of it
      // matches what they draw.
      const blur = Math.round((Number(p.intensity) || K.num("desktop.blur.intensity", 60)) /
        K.num("desktop.blur.divisor", 3));
      return '<div style="' + s + ';backdrop-filter:blur(' + blur + 'px);-webkit-backdrop-filter:blur(' +
        blur + 'px)">' + kids + "</div>";
    }

    case "ProgressBar":
      return '<div style="' + s + ";height:" + K.num("desktop.progressBar.height", 3) +
        'px;border-radius:2px;background:var(--border);overflow:hidden">' +
        '<div class="tz-indet" style="height:100%;background:var(--accent)"></div></div>';

    case "FlipText": {
      // The greeting. Same words, same interval, same idea — one turns into
      // the next and nothing else on the line moves.
      const words = (p.words || []).map((w) => esc(String(w)));
      if (!words.length) return "";
      const id = "flip" + (node._n = (node._n || 0) + 1);
      FLIPS.push({
        id: id, words: words,
        ms: Math.max(K.num("desktop.flip.minMs", 900), Number(p.intervalMs) || K.num("desktop.flip.intervalMs", 2600)),
      });
      return '<span id="' + id + '" style="' + s + ";transition:opacity " +
        (K.num("desktop.flip.fadeMs", 250) / 1000) + 's">' + words[0] + "</span>";
    }

    case "Modal":
      // Open state lives in the screen's own state, exactly as on the phone.
      if (!truthy(stateAt((n.bind && n.bind.open) || ""))) return "";
      return '<div class="tz-modal"><div class="tz-sheet" style="' + s + '">' + kids + "</div></div>";

    case "SwipeAction": {
      // THE WAY IN. On a phone it is dragged, because a live microphone
      // deserves a held intention. A mouse has no thumb to rest, so here it is
      // the same object as a button — same label, same colours, same pale far
      // end — and a click commits it. The gesture was never the point; the
      // deliberateness was, and a click on a pill this size is deliberate.
      const d = K.obj("desktop.swipeAction", {
        height: 58, radius: 999, background: "#0B0B0D", color: "#fff", fontSize: 12, weight: 700,
        tracking: 1.8, disc: 46, target: "#F3E2C6",
      });
      const h = Number(p.height) || d.height;
      const disc = Number(p.disc) || d.disc;
      return '<button class="tz-press" data-ev="onComplete" style="' + s +
        ";position:relative;height:" + h + "px;border-radius:" + (Number(p.radius) || d.radius) + "px" +
        ";background:" + esc(tok(p.background || d.background)) +
        ";border:" + (p.borderWidth ? p.borderWidth + "px solid " + esc(tok(p.borderColor)) : "none") +
        ";color:" + esc(tok(p.color || d.color)) +
        ";font-size:" + (Number(p.fontSize) || d.fontSize) + "px;font-weight:" + (p.weight || d.weight) +
        ";letter-spacing:" + (Number(p.tracking) || d.tracking) + 'px;width:100%;cursor:pointer">' +
        esc(label(p.label || "")) +
        '<span style="position:absolute;right:6px;top:50%;transform:translateY(-50%);width:' +
        disc + "px;height:" + disc +
        "px;border-radius:50%;background:" + esc(tok(p.targetBackground || d.target)) +
        ';opacity:.45"></span></button>';
    }

    case "NeuralField": {
      // The page it draws is HTML and canvas. This IS a browser — it needs no
      // bridge, no WebView and no stand-in; the same file the phone loads
      // renders here natively.
      //
      // WITH THE SAME NUMBERS. It used to load the file bare, and the file is
      // generated with `growth` absent — which the page reads as 1. So the
      // window drew a fully grown network for everybody, on day one and month
      // six alike, and the claim this screen makes (that the thing inside gets
      // bigger every time you talk to it) was false in the one place it is
      // visible. alpha went the same way: the field sat at full strength on a
      // screen that wanted it dimmed behind the copy.
      //
      // Those two are per screen and per person, and retune the field in
      // place. EVERYTHING ELSE THE SERVER SENDS goes too — regions, colours,
      // bloom, focal length — as one `cfg` parameter the page lays over the
      // geometry it has baked in, so a retune on the server reaches the window
      // the way it reaches the phones, and a node that sends none of it gets
      // the baked field exactly as before. The live values (state, level,
      // training) are messages, not config, and stay out of the address.
      const geo = {};
      Object.keys(p).forEach((k) => {
        if (FIELD_LIVE.indexOf(k) === -1 && p[k] != null) geo[k] = p[k];
      });
      const q = "?alpha=" + encodeURIComponent(Number(p.alpha != null ? p.alpha : 1)) +
        "&growth=" + encodeURIComponent(Number(p.growth != null ? p.growth : 1)) +
        (Object.keys(geo).length ? "&cfg=" + encodeURIComponent(JSON.stringify(geo)) : "");
      FIELD_BINDS = n.bind || null;
      FIELD_PROPS = p;
      // A PLACEHOLDER, not the iframe itself. Every repaint replaces this
      // view's innerHTML, and an iframe written into that string is a NEW
      // iframe: the page reloads, forty thousand curves are baked again, and
      // the animation restarts from nothing. The Train tab repaints on every
      // phase of a live session, so the one screen where the field is supposed
      // to react was the one screen where it kept starting over.
      //
      // The real iframe is created once and moved in here after each paint.
      return '<div data-field="' + esc(q) + '" class="tz-field" style="' + s + '"></div>';
    }

    // THE CONVERSATION. SDUI has no repeater, so the Train tab's thread is one
    // node that reads an array out of state and draws it — the same contract
    // the phones implement, and the reason the server can append a row and
    // have both surfaces show it.
    //
    // This window used to fall through to `default` and draw the node's
    // fallback: a line saying the conversation needed an update, on a build
    // that was perfectly capable of holding one.
    case "ChatThread":
      return chatThread(n, p, s);

    // The mic, in the page. Not the tray's: that one records globally and
    // pastes into whatever app has focus, which is the wrong verb entirely for
    // a control that is supposed to fill the field beside it. The window has
    // its own microphone permission, so it records here and writes the
    // transcript into the bound path, exactly as the phones do.
    //
    // VoiceToggle and VoiceButton differ on the phones by how they are held.
    // A mouse has no hold, so both are a click, and the catalog's fallback
    // from one to the other costs nothing.
    case "VoiceToggle":
    case "VoiceButton":
      return voiceButton(n, p, s);

    // The spoken session. Renders nothing — it owns the audio loop and writes
    // what it knows into the screen's state, so everything around it stays
    // ordinary backend JSON. Started on the first paint that contains it.
    case "VoiceSession":
      startSession(n);
      return "";

    // ── the sign-in screen ────────────────────────────────────────────────
    // The gate was the last hand-built screen in this window: its own markup,
    // its own buttons, its own arrangement, while the phones drew theirs from
    // `auth.screen` in the boot flags. So the first screen of the product was
    // the one screen that looked like a different product, and every change to
    // it was a change to an installer.
    case "AuthPhase":
      return (n.props?.phases || []).indexOf(AUTH.phase) === -1 ? "" : kids;

    case "Rise":
      return riseNode(n, p, s, kids);

    case "SwipePill":
      return swipePill(p, s);

    case "CodeEntry":
      return codeEntry(p, s);

    case "AppleSignIn":
      return socialButton("apple", p, s);

    case "GoogleSignIn":
      return socialButton("google", p, s);

    // Everything the phones draw natively and this window has no business
    // imitating — the keyboard preview (there is no keyboard to configure
    // here), the mic toggle and the spoken session (this app records through
    // its own tray hotkey, not an in-page control). Their children still
    // render, so a card built around one is not lost, and a node that shipped
    // a fallback gets it — the same rule the phone renderer follows, so the
    // server can keep emitting one tree for both.
    default:
      return kids || (n.fallback ? node(n.fallback) : "");
  }
}
