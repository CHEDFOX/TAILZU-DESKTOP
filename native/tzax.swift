// tzax — Tailzu Ask's eyes and hands in the app in front (macOS 13+).
//
// Ask has to know what is on the screen of the app the user is in ("where's
// export?") and, when asked to, press, type into, scroll and focus things
// there. This helper is that reach: it reads the focused window's
// accessibility tree into a short list of elements with ids, and acts on those
// ids. The list goes only to axDriver.js; the agent sends on roles, labels and
// short values, never frames or window titles.
//
// It is long-lived, kept warm by axDriver.js: one JSON command per line on
// stdin, one JSON answer per line on stdout, each answer carrying its
// command's "id". A command answers within its own time limit even when the
// app in front is slow or hung: every accessibility message gives up after a
// quarter of a second, a watchdog answers "timeout" for a command that runs
// out of time, and a command that waited too long behind another is never
// acted on late. A bad line is answered, never fatal. It exits when stdin
// closes, i.e. with the app.
//
//   {"id":1,"cmd":"ping"}                        {"id":1,"ok":true,"pong":true,"pid":…,"v":1}
//   {"id":2,"cmd":"snapshot","max":250}          {"id":2,"ok":true,"app":{…},"elements":[…],…}
//   {"id":3,"cmd":"press","el":"e7"}             {"id":3,"ok":true,"how":"AXPress"}
//   {"id":4,"cmd":"key","chord":"cmd+k"}         {"id":4,"ok":true}
//   anything that fails                          {"id":4,"ok":false,"error":"not_trusted"}
//
// It needs Accessibility, which macOS grants to the app that started it
// (Tailzu: the same permission the field reader already uses). It takes no
// picture, and never reads a password: a secure field is listed as one,
// without its value.
import AppKit
import ApplicationServices
import Carbon
import Foundation

signal(SIGPIPE, SIG_IGN)

// MARK: - Limits

/// How long one accessibility message may take before the app counts as busy.
/// Without it a hung app holds a call for about six seconds.
let messageTimeout: Float = 0.25
/// Actions wait a little longer: a press that opens a dialog answers late even
/// when it worked.
let actionTimeout: Float = 0.5
/// The walk stops after this many nodes, listed or not.
let maxVisited = 4000
/// The selection goes whole or not at all (frontApp.js's SELECTION_MAX).
let selectionMax = 8000
/// Busy on one command this long means stuck: the helper exits (code 3) and
/// the driver starts a fresh one on its next call.
let stuckNanos: UInt64 = 10_000_000_000

// MARK: - JSON out
//
// Written by hand rather than with JSONSerialization, which raises an
// Objective-C exception (a crash, not an error) on a NaN. Every number here is
// made an Int on the way in, and an answer is always exactly one line.

enum J {
  case null
  case bool(Bool)
  case int(Int)
  case str(String)
  case arr([J])
  case obj([(String, J)])
}

typealias Reply = [(String, J)]

func ok(_ more: Reply = []) -> Reply {
  let head: Reply = [("ok", J.bool(true))]
  return head + more
}
func fail(_ error: String) -> Reply { [("ok", J.bool(false)), ("error", J.str(error))] }

func quote(_ s: String, into out: inout String) {
  out += "\""
  for u in s.unicodeScalars {
    switch u {
    case "\"": out += "\\\""
    case "\\": out += "\\\\"
    case "\n": out += "\\n"
    case "\r": out += "\\r"
    case "\t": out += "\\t"
    default:
      if u.value < 0x20 || u.value == 0x2028 || u.value == 0x2029 {
        out += String(format: "\\u%04x", u.value)
      } else {
        out.unicodeScalars.append(u)
      }
    }
  }
  out += "\""
}

func encode(_ v: J, into out: inout String) {
  switch v {
  case .null: out += "null"
  case .bool(let b): out += b ? "true" : "false"
  case .int(let i): out += String(i)
  case .str(let s): quote(s, into: &out)
  case .arr(let a):
    out += "["
    for (i, x) in a.enumerated() {
      if i > 0 { out += "," }
      encode(x, into: &out)
    }
    out += "]"
  case .obj(let kv):
    out += "{"
    for (i, pair) in kv.enumerated() {
      if i > 0 { out += "," }
      quote(pair.0, into: &out)
      out += ":"
      encode(pair.1, into: &out)
    }
    out += "}"
  }
}

func frameJ(_ r: CGRect) -> J {
  func n(_ x: CGFloat) -> J { .int(Int(min(1_000_000, max(-1_000_000, x)).rounded())) }
  return .arr([n(r.minX), n(r.minY), n(r.width), n(r.height)])
}

/// stdout. Each command is answered exactly once — by itself, or by its
/// watchdog if that came first — from whichever thread gets there.
final class Out {
  private let lock = NSLock()
  private var answered = Set<Int>()
  private var watchdogs: [Int: DispatchSourceTimer] = [:]

  /// Answer "timeout" at `deadline` unless the command has answered by then.
  /// A timer source with a 1 ms leeway rather than asyncAfter, whose leeway is
  /// the system's to choose: this answer has to beat the caller's own timer.
  func watch(_ key: Int, _ id: J, at deadline: DispatchTime) {
    let t = DispatchSource.makeTimerSource(queue: DispatchQueue.global())
    t.schedule(deadline: deadline, repeating: .never, leeway: .milliseconds(1))
    t.setEventHandler { [weak self] in
      _ = self?.answer(key, id, fail("timeout"))
    }
    lock.lock()
    watchdogs[key] = t
    lock.unlock()
    t.resume()
  }

  @discardableResult
  func answer(_ key: Int, _ id: J, _ reply: Reply) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if let t = watchdogs.removeValue(forKey: key) { t.cancel() }
    if answered.contains(key) { return false }
    answered.insert(key)
    if answered.count > 4096 { answered = answered.filter { $0 > key - 1024 } }
    let head: Reply = [("id", id)]
    emit(.obj(head + reply))
    return true
  }

  func isAnswered(_ key: Int) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return answered.contains(key)
  }

  /// The answer to a line that had no id to answer by.
  func stray(_ reply: Reply) {
    lock.lock()
    defer { lock.unlock() }
    let head: Reply = [("id", J.null)]
    emit(.obj(head + reply))
  }

  private func emit(_ v: J) {
    var s = ""
    encode(v, into: &s)
    s += "\n"
    let bytes = Array(s.utf8)
    bytes.withUnsafeBufferPointer { buf in
      guard let base = buf.baseAddress else { return }
      var off = 0
      while off < buf.count {
        let n = write(1, base + off, buf.count - off)
        if n > 0 { off += n; continue }
        if n < 0 && errno == EINTR { continue }
        _exit(0) // nobody is reading: the app that started us is gone
      }
    }
  }
}

/// When the command running now began (0: none), for the stuck check.
final class Busy {
  private let lock = NSLock()
  private var since: UInt64 = 0
  func begin() { lock.lock(); since = DispatchTime.now().uptimeNanoseconds; lock.unlock() }
  func end() { lock.lock(); since = 0; lock.unlock() }
  func stuck() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return since != 0 && DispatchTime.now().uptimeNanoseconds - since > stuckNanos
  }
}

// MARK: - What a snapshot is made of

/// One element found on the walk, before it is given its id.
final class Found {
  let el: AXUIElement
  let axRole: String
  let role: String
  var label: String
  /// The label was the element's own. Without one it may be gathered from the
  /// text inside it (a web link, a table row).
  let own: Bool
  var gathered: [String] = []
  var value: String?
  let frame: CGRect
  /// What could be seen where it sits (the window, cut by scroll areas), so a
  /// click lands on the visible part.
  let clip: CGRect
  var focused = false
  var disabled = false
  var selected = false
  var checked: Bool?
  var secure = false

  init(el: AXUIElement, axRole: String, role: String, label: String, frame: CGRect, clip: CGRect) {
    self.el = el
    self.axRole = axRole
    self.role = role
    self.label = label
    self.own = !label.isEmpty
    self.frame = frame
    self.clip = clip
  }

  func json(_ id: String) -> J {
    var o: Reply = [("id", .str(id)), ("role", .str(role)), ("label", .str(label))]
    if let v = value, !secure { o.append(("value", .str(v))) }
    o.append(("frame", frameJ(frame)))
    if focused { o.append(("focused", .bool(true))) }
    if disabled { o.append(("disabled", .bool(true))) }
    if selected { o.append(("selected", .bool(true))) }
    if let c = checked { o.append(("checked", .bool(c))) }
    if secure { o.append(("secure", .bool(true))) }
    return .obj(o)
  }
}

/// A node waiting on the breadth-first walk.
struct Item {
  let el: AXUIElement
  let parentRole: String
  let clip: CGRect
  /// The nearest listed control above it that takes its name from its content.
  let owner: Found?
  /// The window itself: walked, not listed.
  let root: Bool
}

struct Walk {
  var found: [Found] = []
  var truncated = false
  /// The app stopped answering partway.
  var busy = false
}

/// What an id names, for as long as it is good.
struct Entry {
  let el: AXUIElement
  let axRole: String
  let secure: Bool
  let pid: pid_t
  let clip: CGRect
}

/// One snapshot's ids. Two are kept, the latest and the one before, and a new
/// snapshot never reuses an id of the latest, so an id from either one still
/// names the element it was given to.
final class Snap {
  var byId: [String: Entry] = [:]
  let first: Int
  let last: Int
  init(first: Int, last: Int) {
    self.first = first
    self.last = last
  }
}

enum Engine { case chromium, electron, other }

/// A launch, waited on from the main thread, finished on another.
final class Launch {
  let sem = DispatchSemaphore(value: 0)
  var failed = false
}

// MARK: - State

let out = Out()
let busy = Busy()
var received = 0
var current = Snap(first: 0, last: -1)
var previous = Snap(first: 0, last: -1)
/// The app the latest snapshot read: keys and clicks go to it, and only to it.
var lastPid: pid_t = 0
/// Processes already asked to build their accessibility tree.
var woken = Set<pid_t>()
var engines: [String: Engine] = [:]
/// The current keyboard layout's character → key, built once per layout.
var layoutCache: (id: String, keys: [String: (CGKeyCode, Bool)])? = nil

/// The attributes read for every node, in one message: role, names, value,
/// frame, state and children. One round trip per node is what makes a walk of
/// a few hundred elements fast enough.
let attrNames = ["AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXValue", "AXHelp",
                 "AXPlaceholderValue", "AXPosition", "AXSize", "AXEnabled", "AXFocused",
                 "AXSelected", "AXChildren", "AXTitleUIElement"]
let attrList = attrNames as CFArray
enum A {
  static let role = 0, subrole = 1, title = 2, desc = 3, value = 4, help = 5, placeholder = 6
  static let pos = 7, size = 8, enabled = 9, focused = 10, selected = 11, children = 12, titleUI = 13
}

/// Roles that take their name from the text inside them when they have none
/// of their own (a web link, a table row), and so swallow that text.
let namedByContent: Set<String> = ["button", "link", "row", "cell", "heading", "tab", "menuitem", "item", "radio", "check", "switch"]
/// Roles that mean nothing without a label.
let needsLabel: Set<String> = ["row", "cell", "heading", "text", "image", "item", "menuitem", "tab", "window"]
/// Roles whose insides are not walked: their content is their value, or not
/// worth an element of its own.
let leafRoles: Set<String> = ["field", "area", "combo", "text", "slider", "image", "check", "radio", "switch", "menu"]
/// Roles that may be named by a separate label element (AXTitleUIElement).
let controlRoles: Set<String> = ["button", "field", "area", "combo", "check", "radio", "switch", "slider", "tab"]
let listRoles: Set<String> = ["AXTable", "AXOutline", "AXList", "AXGrid", "AXBrowser"]
let clipRoles: Set<String> = ["AXScrollArea", "AXWebArea"]
let notItems: Set<String> = ["AXWebArea", "AXApplication", "AXMenu", "AXMenuBar", "AXWindow"]

let chromiumIds = ["com.google.Chrome", "org.chromium.Chromium", "com.microsoft.edgemac", "com.brave.Browser",
                   "com.vivaldi.Vivaldi", "com.operasoftware.Opera", "company.thebrowser.Browser"]

/// A browser's address bar, by its name in each browser — the same pattern as
/// agent.js's ADDRESS_BAR. Its value is where the user has been.
let addressBar = try? NSRegularExpression(
  pattern: "\\b(?:address(?:\\s+and\\s+search)?\\s+bar|address\\s+and\\s+search|search\\s+or\\s+(?:type|enter)|(?:type|enter)\\s+(?:an?\\s+|web\\s+)?(?:address|url)|smart\\s+search|url|location\\s+bar)\\b|^address$",
  options: [.caseInsensitive])

/// Keys that are not characters keep their fixed key codes (kVK_*).
let namedKeys: [String: CGKeyCode] = [
  "enter": 36, "return": 36, "tab": 48, "space": 49, "spacebar": 49,
  "delete": 51, "backspace": 51, "forwarddelete": 117, "escape": 53, "esc": 53,
  "left": 123, "right": 124, "down": 125, "up": 126,
  "arrowleft": 123, "arrowright": 124, "arrowdown": 125, "arrowup": 126,
  "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "pgup": 116, "pgdn": 121, "help": 114,
  "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
  "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]
/// Characters by their place on a US (ANSI) keyboard: the fallback when the
/// layout in use has no key for one.
let ansiKeys: [String: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
  "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
  "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
  "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35,
  "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44,
  "n": 45, "m": 46, ".": 47, "`": 50,
]
/// The numeric keypad, left out of the layout table: "cmd+1" means the 1 above
/// the letters, not the keypad's.
let keypadCodes: Set<Int> = [65, 67, 69, 71, 75, 76, 78, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91, 92]

// MARK: - Accessibility, carefully
//
// Every value from another app is checked for its type before it is used: an
// app can answer anything. Every element is given the messaging timeout before
// it is messaged, so a hung app costs a quarter of a second, not six.

func timed(_ el: AXUIElement, _ t: Float = messageTimeout) -> AXUIElement {
  _ = AXUIElementSetMessagingTimeout(el, t)
  return el
}

func copyAttr(_ el: AXUIElement, _ attr: String) -> AnyObject? {
  var v: CFTypeRef?
  guard AXUIElementCopyAttributeValue(timed(el), attr as CFString, &v) == .success else { return nil }
  return v
}

func setAttr(_ el: AXUIElement, _ attr: String, _ value: AnyObject, _ t: Float = actionTimeout) -> AXError {
  return AXUIElementSetAttributeValue(timed(el, t), attr as CFString, value)
}

func axValue(_ o: AnyObject?) -> AXValue? {
  guard let o = o, CFGetTypeID(o) == AXValueGetTypeID() else { return nil }
  return (o as! AXValue)
}

func element(_ o: AnyObject?) -> AXUIElement? {
  guard let o = o, CFGetTypeID(o) == AXUIElementGetTypeID() else { return nil }
  return (o as! AXUIElement)
}

func elements(_ o: AnyObject?) -> [AXUIElement] {
  guard let o = o, CFGetTypeID(o) == CFArrayGetTypeID(), let list = o as? NSArray else { return [] }
  var els: [AXUIElement] = []
  els.reserveCapacity(list.count)
  for x in list {
    if let e = element(x as AnyObject) { els.append(e) }
  }
  return els
}

func frameOf(_ pos: AnyObject?, _ size: AnyObject?) -> CGRect? {
  guard let pv = axValue(pos), let sv = axValue(size),
        AXValueGetType(pv) == .cgPoint, AXValueGetType(sv) == .cgSize else { return nil }
  var p = CGPoint.zero
  var s = CGSize.zero
  guard AXValueGetValue(pv, .cgPoint, &p), AXValueGetValue(sv, .cgSize, &s),
        p.x.isFinite, p.y.isFinite, s.width.isFinite, s.height.isFinite else { return nil }
  return CGRect(origin: p, size: s)
}

func liveFrame(_ el: AXUIElement) -> CGRect? { frameOf(copyAttr(el, "AXPosition"), copyAttr(el, "AXSize")) }

func asBool(_ o: AnyObject?) -> Bool? { (o as? NSNumber)?.boolValue }

func actionNames(_ el: AXUIElement) -> [String] {
  var names: CFArray?
  guard AXUIElementCopyActionNames(timed(el), &names) == .success, let cf = names else { return [] }
  let list = cf as NSArray
  return list.compactMap { $0 as? String }
}

func settable(_ el: AXUIElement, _ attr: String) -> Bool {
  var can: DarwinBoolean = false
  return AXUIElementIsAttributeSettable(timed(el), attr as CFString, &can) == .success && can.boolValue
}

/// Everything `attrNames` names, in one message. Missing attributes are nil.
func fetch(_ el: AXUIElement) -> (AXError, [AnyObject?]) {
  var got = [AnyObject?](repeating: nil, count: attrNames.count)
  var values: CFArray?
  let err = AXUIElementCopyMultipleAttributeValues(timed(el), attrList, AXCopyMultipleAttributeOptions(), &values)
  guard err == .success, let cf = values else { return (err == .success ? .failure : err, got) }
  let list = cf as NSArray
  for i in 0..<min(list.count, got.count) {
    let o = list[i] as AnyObject
    if o is NSNull { continue }
    if let v = axValue(o), AXValueGetType(v) == .axError { continue } // that attribute is not there
    got[i] = o
  }
  return (.success, got)
}

func axName(_ e: AXError) -> String {
  switch e {
  case .success: return "ok"
  case .attributeUnsupported, .actionUnsupported: return "unsupported"
  case .cannotComplete: return "app_busy"
  case .invalidUIElement: return "gone"
  case .apiDisabled: return "not_trusted"
  case .illegalArgument: return "illegal_argument"
  case .noValue: return "no_value"
  case .notImplemented: return "not_implemented"
  default: return "ax_error_\(e.rawValue)"
  }
}

func msLeft(_ t: DispatchTime) -> Int {
  let now = DispatchTime.now().uptimeNanoseconds
  let end = t.uptimeNanoseconds
  return end > now ? Int((end - now) / 1_000_000) : 0
}

// MARK: - Text

/// One line, at most `limit` characters as JavaScript counts them (UTF-16
/// units: the agent and the server measure in those): runs of whitespace and
/// control characters become one space, invisible marks go, a cut end gets "…"
/// and is never cut inside a character.
func clean(_ s: String?, _ limit: Int) -> String {
  guard let s = s, !s.isEmpty else { return "" }
  var flat = String.UnicodeScalarView()
  var space = true
  var cut = false
  var n = 0
  for u in s.unicodeScalars {
    let v = u.value
    if v == 0xFFFC || v == 0x200B || v == 0x200E || v == 0x200F || v == 0xFEFF || v == 0x00AD { continue }
    if u.properties.isWhitespace || v < 0x20 || (v >= 0x7F && v <= 0x9F) {
      if !space { flat.append(" "); space = true; n += 1 }
      continue
    }
    flat.append(u)
    space = false
    n += 1
    if n > limit * 3 { cut = true; break }
  }
  var line = String(flat)
  while line.hasSuffix(" ") { line.removeLast() }
  if !cut && line.utf16.count <= limit { return line }
  var short = ""
  var units = 0
  for ch in line {
    let u = ch.utf16.count
    if units + u > limit - 1 { break }
    short.append(ch)
    units += u
  }
  while short.hasSuffix(" ") { short.removeLast() }
  return short + "…"
}

func alike(_ a: String, _ b: String) -> Bool {
  let x = a.lowercased(), y = b.lowercased()
  if x.isEmpty || y.isEmpty { return x == y }
  return x == y || x.contains(y) || y.contains(x)
}

func numberText(_ n: NSNumber) -> String {
  let d = n.doubleValue
  return d.isFinite ? String(format: "%g", d) : ""
}

func isAddressBar(_ names: [String]) -> Bool {
  guard let re = addressBar else { return false }
  for n in names where !n.isEmpty {
    if re.firstMatch(in: n, options: [], range: NSRange(n.startIndex..., in: n)) != nil { return true }
  }
  return false
}

// MARK: - The app in front

func frontApp() -> NSRunningApplication? {
  if let a = NSWorkspace.shared.frontmostApplication { return a }
  let pid = focusedPid()
  return pid > 0 ? NSRunningApplication(processIdentifier: pid) : nil
}

/// The app with the keyboard, asked of the accessibility server: live, where
/// NSWorkspace's answer is only as fresh as our last trip round the run loop.
func focusedPid() -> pid_t {
  guard let el = element(copyAttr(AXUIElementCreateSystemWide(), "AXFocusedApplication")) else { return 0 }
  var pid: pid_t = 0
  return AXUIElementGetPid(el, &pid) == .success ? pid : 0
}

func frontPid() -> pid_t {
  let pid = focusedPid()
  return pid > 0 ? pid : (NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0)
}

/// Make `pid` the app in front before keys or a click go out: they land in
/// whatever is in front, so it had better be the app Ask read. AXFrontmost is
/// what System Events sets and works from a background process; activation
/// is the second try. False when it would not come forward.
func bringForward(_ pid: pid_t, _ deadline: DispatchTime) -> Bool {
  if frontPid() == pid { return true }
  guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else { return false }
  _ = setAttr(AXUIElementCreateApplication(pid), "AXFrontmost", kCFBooleanTrue)
  _ = app.activate(options: [.activateIgnoringOtherApps])
  let until = min(deadline - .milliseconds(200), DispatchTime.now() + .milliseconds(500))
  while DispatchTime.now() < until {
    usleep(25_000)
    if frontPid() == pid {
      usleep(40_000) // its key window takes a moment to take the keyboard
      return true
    }
  }
  return frontPid() == pid
}

func engineOf(_ app: NSRunningApplication) -> Engine {
  let id = app.bundleIdentifier ?? ""
  if chromiumIds.contains(where: { id.hasPrefix($0) }) { return .chromium }
  guard let url = app.bundleURL else { return .other }
  if let known = engines[url.path] { return known }
  let dir = url.appendingPathComponent("Contents").appendingPathComponent("Frameworks").path
  let names = (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []
  var e = Engine.other
  if names.contains("Electron Framework.framework") {
    e = .electron
  } else if names.contains(where: { $0.hasSuffix("Framework.framework") && ($0.contains("Chrom") || $0.contains("Edge") || $0.contains("Browser")) }) {
    e = .chromium
  }
  engines[url.path] = e
  return e
}

/// Chromium and Electron apps build their accessibility tree only when asked
/// (frontApp.js asks the same through System Events); Chrome itself also
/// wants AXEnhancedUserInterface. Asked once per process; a native app just
/// says it has no such attribute.
func wake(_ app: AXUIElement, pid: pid_t, engine: Engine) {
  if woken.contains(pid) { return }
  let manual = setAttr(app, "AXManualAccessibility", kCFBooleanTrue, messageTimeout)
  if engine == .chromium { _ = setAttr(app, "AXEnhancedUserInterface", kCFBooleanTrue, messageTimeout) }
  if manual == .cannotComplete { return } // busy right now: ask again next time
  if woken.count > 64 { woken.removeAll() }
  woken.insert(pid)
}

// MARK: - Snapshot

/// Ask's role for an accessibility role, or nil for layout.
func roleOf(_ ax: String, _ sub: String, _ parent: String) -> String? {
  switch ax {
  case "AXButton", "AXPopUpButton", "AXMenuButton", "AXDisclosureTriangle", "AXColorWell": return "button"
  case "AXLink": return "link"
  case "AXTextField", "AXSearchField", "AXDateField", "AXTimeField": return "field"
  case "AXComboBox": return "combo"
  case "AXTextArea": return "area"
  case "AXCheckBox": return sub == "AXSwitch" ? "switch" : "check"
  case "AXRadioButton": return (sub == "AXTabButton" || parent == "AXTabGroup") ? "tab" : "radio"
  case "AXTab": return "tab"
  case "AXMenuBarItem": return "menu"
  case "AXMenuItem": return "menuitem"
  case "AXRow": return "row"
  case "AXCell": return "cell"
  case "AXStaticText": return "text"
  case "AXHeading": return "heading"
  case "AXImage": return "image"
  case "AXSlider": return "slider"
  case "AXSheet", "AXWindow": return "window"
  default: return nil
  }
}

/// The element as Ask lists it, or nil when it is layout or has no size.
func make(_ el: AXUIElement, _ v: [AnyObject?], axRole: String, parentRole: String, inRow: Bool,
          clip: CGRect, focusedEl: AXUIElement?) -> Found? {
  guard let f0 = frameOf(v[A.pos], v[A.size]), f0.width > 0, f0.height > 0 else { return nil }
  let sub = (v[A.subrole] as? String) ?? ""
  var role = roleOf(axRole, sub, parentRole)
  if role == "cell" && inRow { role = nil } // a row's cells are the row
  let title = clean(v[A.title] as? String, 80)
  let desc = clean(v[A.desc] as? String, 80)
  if role == nil {
    // Layout — unless it is named and can be pressed: a clickable card, a
    // web "button" made of a div.
    let name = title.isEmpty ? desc : title
    guard !name.isEmpty, !axRole.isEmpty, !notItems.contains(axRole), !(inRow && axRole == "AXCell"),
          actionNames(el).contains("AXPress") else { return nil }
    role = "item"
  }
  guard let r = role else { return nil }

  let shown = f0.intersection(clip)
  let frame = (shown.isNull || shown.width <= 0 || shown.height <= 0) ? f0 : shown
  let secure = sub == "AXSecureTextField"
  let valueText = v[A.value] as? String
  let placeholder = clean(v[A.placeholder] as? String, 80)
  var label: String
  switch r {
  case "text":
    label = clean(valueText, 80)
    if label.isEmpty { label = title.isEmpty ? desc : title }
  case "window":
    label = desc // never a window's title
  default:
    label = title.isEmpty ? desc : title
    if label.isEmpty { label = placeholder }
    if label.isEmpty { label = clean(v[A.help] as? String, 80) }
  }
  if label.isEmpty && controlRoles.contains(r), let t = element(v[A.titleUI]) {
    let named = (copyAttr(t, "AXValue") as? String) ?? (copyAttr(t, "AXTitle") as? String)
    label = clean(named, 80)
  }
  if label.isEmpty && (axRole == "AXPopUpButton" || axRole == "AXMenuButton") {
    label = clean(valueText, 80) // a pop-up shows its choice
  }

  let found = Found(el: el, axRole: axRole, role: r, label: label, frame: frame, clip: clip)
  found.secure = secure
  found.disabled = asBool(v[A.enabled]) == false
  found.selected = asBool(v[A.selected]) == true
  found.focused = asBool(v[A.focused]) == true || (focusedEl.map { CFEqual($0, el) } ?? false)
  switch r {
  case "field", "area", "combo":
    // A password is never read out, and an address bar's value is where the
    // user has been: both are listed by their name only.
    if !secure, let s = valueText, !isAddressBar([label, title, desc, placeholder]) {
      if r == "area" || copyAttr(el, "AXURL") == nil { found.value = clean(s, 120) }
    }
  case "slider":
    if let n = v[A.value] as? NSNumber {
      found.value = numberText(n)
    } else if let s = valueText {
      found.value = clean(s, 120)
    }
  case "check", "switch":
    if let n = v[A.value] as? NSNumber {
      if n.intValue == 2 { found.value = "mixed" } else { found.checked = n.intValue != 0 }
    }
  case "radio", "tab":
    if let n = v[A.value] as? NSNumber, n.intValue == 1 { found.selected = true }
  default:
    break
  }
  return found
}

/// One breadth-first read of the app: its menu bar's top-level items, a menu
/// open over it, then the focused window, nearest things first. Stops at
/// `maxCount` listed, `maxVisited` read, or `stopAt`, whichever comes first.
func walk(app: AXUIElement, window: AXUIElement?, winFrame: CGRect?, winTitle: String,
          focusedEl: AXUIElement?, maxCount: Int, stopAt: DispatchTime) -> Walk {
  var w = Walk()
  var queue: [Item] = []

  // The menu bar's top-level items, as "menu". An open one adds its items.
  if let bar = element(copyAttr(app, "AXMenuBar")) {
    for (i, item) in elements(copyAttr(bar, "AXChildren")).enumerated() {
      if w.found.count >= maxCount || DispatchTime.now() >= stopAt { w.truncated = true; break }
      let (err, v) = fetch(item)
      if err == .cannotComplete { w.busy = true; break }
      if err != .success { continue }
      let title = clean(v[A.title] as? String, 80)
      if i == 0 && title == "Apple" { continue } // the system's menu, not the app's
      guard !title.isEmpty, let f = frameOf(v[A.pos], v[A.size]), f.width > 0, f.height > 0 else { continue }
      let m = Found(el: item, axRole: "AXMenuBarItem", role: "menu", label: title, frame: f, clip: .infinite)
      m.disabled = asBool(v[A.enabled]) == false
      m.selected = asBool(v[A.selected]) == true
      w.found.append(m)
      if m.selected {
        for menu in elements(v[A.children]) {
          queue.append(Item(el: menu, parentRole: "AXMenuBarItem", clip: .infinite, owner: nil, root: false))
        }
      }
    }
  }
  if w.busy { return w }
  // A context menu open over the app hangs off the app itself.
  if queue.isEmpty {
    for k in elements(copyAttr(app, "AXChildren")) where (copyAttr(k, "AXRole") as? String) == "AXMenu" {
      queue.append(Item(el: k, parentRole: "AXApplication", clip: .infinite, owner: nil, root: false))
    }
  }
  if let win = window {
    queue.append(Item(el: win, parentRole: "", clip: winFrame ?? .infinite, owner: nil, root: true))
  }

  var head = 0
  var visited = 0
  var stalls = 0
  // One place is kept for the element with the keyboard until the walk meets
  // it: where typing goes matters more than the 250th button.
  var focusSeen = focusedEl == nil
  while head < queue.count {
    if w.found.count >= (focusSeen ? maxCount : maxCount - 1) || visited >= maxVisited || DispatchTime.now() >= stopAt {
      w.truncated = true
      break
    }
    let it = queue[head]
    head += 1
    visited += 1
    let (err, v) = fetch(it.el)
    if err != .success {
      if err == .cannotComplete {
        stalls += 1
        if stalls >= 3 { w.truncated = true; w.busy = true; break }
      }
      continue
    }
    stalls = 0
    let axRole = (v[A.role] as? String) ?? ""
    var clip = it.clip
    if let f = frameOf(v[A.pos], v[A.size]), f.width > 0, f.height > 0 {
      if axRole == "AXMenu" {
        clip = f // an open menu is drawn over everything, inside the window or not
      } else {
        if !f.intersects(it.clip) { continue } // out of sight, and everything inside it too
        if clipRoles.contains(axRole) { clip = it.clip.intersection(f) }
      }
    }

    var listed: Found? = nil
    var madeRole: String? = nil
    if !it.root, let f = make(it.el, v, axRole: axRole, parentRole: it.parentRole, inRow: it.owner?.role == "row",
                               clip: it.clip, focusedEl: focusedEl) {
      madeRole = f.role
      var keep = f.own || namedByContent.contains(f.role) || !needsLabel.contains(f.role)
      if f.role == "text" || f.role == "image", let o = it.owner {
        // Text and pictures inside a listed control are its name, not things
        // of their own.
        if !o.own {
          if !f.label.isEmpty && o.gathered.count < 8 { o.gathered.append(f.label) }
          keep = false
        } else if f.role == "image" || alike(o.label, f.label) {
          keep = false
        }
      }
      if f.role == "text" && !winTitle.isEmpty && f.label == winTitle { keep = false } // the window's title stays here
      if keep {
        w.found.append(f)
        listed = f
        if f.focused { focusSeen = true }
      }
    }

    // Fields, texts, checkboxes: what is inside them is their value.
    if let r = madeRole, leafRoles.contains(r) { continue }
    if madeRole == "menuitem" && asBool(v[A.selected]) != true { continue } // a closed submenu is not on screen
    if (v[A.subrole] as? String) == "AXSecureTextField" { continue }
    var kids = elements(v[A.children])
    if kids.count > 60 && listRoles.contains(axRole) {
      // A long list or table: the rows on screen, not all ten thousand.
      let rows = elements(copyAttr(it.el, axRole == "AXTable" || axRole == "AXOutline" ? "AXVisibleRows" : "AXVisibleChildren"))
      if !rows.isEmpty { kids = rows }
    }
    var owner = it.owner
    if let f = listed { owner = namedByContent.contains(f.role) ? f : nil }
    for k in kids.prefix(400) {
      if queue.count - head >= 8000 { break }
      queue.append(Item(el: k, parentRole: axRole, clip: clip, owner: owner, root: false))
    }
  }

  // The element with the keyboard, if the walk did not reach it.
  if let fe = focusedEl, !w.busy, w.found.count < maxCount, !w.found.contains(where: { $0.focused }) {
    let (err, v) = fetch(fe)
    if err == .success,
       let f = make(fe, v, axRole: (v[A.role] as? String) ?? "", parentRole: "", inRow: false,
                    clip: winFrame ?? .infinite, focusedEl: fe),
       winFrame.map({ $0.intersects(f.frame) }) ?? true,
       f.own || !needsLabel.contains(f.role) {
      f.focused = true
      w.found.append(f)
    }
  }

  var kept: [Found] = []
  for f in w.found {
    if !f.own && !f.gathered.isEmpty { f.label = clean(f.gathered.joined(separator: " "), 80) }
    if f.label.isEmpty && needsLabel.contains(f.role) { continue }
    kept.append(f)
  }
  w.found = kept
  return w
}

/// The selected text of the focused element, whole, or "" — never a
/// password's, and nothing over selectionMax (its length is asked first, so a
/// select-all in a long document is not copied across just to be dropped).
func selectionOf(_ el: AXUIElement) -> String {
  if (copyAttr(el, "AXSubrole") as? String) == "AXSecureTextField" { return "" }
  if let rv = axValue(copyAttr(el, "AXSelectedTextRange")), AXValueGetType(rv) == .cfRange {
    var r = CFRange(location: 0, length: 0)
    if AXValueGetValue(rv, .cfRange, &r) && (r.length <= 0 || r.length > selectionMax) { return "" }
  }
  guard let s = copyAttr(el, "AXSelectedText") as? String, s.utf16.count <= selectionMax else { return "" }
  return s
}

/// Where the next snapshot's ids start: 1, unless that would reuse an id of
/// the latest snapshot, which stays good until the one after.
func nextBase(_ n: Int) -> Int {
  if current.byId.isEmpty || current.first > n { return 1 }
  return current.last + 1
}

func snapshot(maxCount: Int, budgetMs: Int, deadline: DispatchTime) -> Reply {
  let started = DispatchTime.now()
  let stopAt = min(deadline - .milliseconds(80), started + .milliseconds(budgetMs))
  guard let front = frontApp() else { return fail("no_app") }
  let pid = front.processIdentifier
  let app = timed(AXUIElementCreateApplication(pid))
  let engine = engineOf(front)
  wake(app, pid: pid, engine: engine)

  var winRef: CFTypeRef?
  let winErr = AXUIElementCopyAttributeValue(app, "AXFocusedWindow" as CFString, &winRef)
  if winErr == .apiDisabled { return fail("not_trusted") }
  var window = element(winRef)
  if window == nil && winErr != .cannotComplete { window = element(copyAttr(app, "AXMainWindow")) }
  if window == nil && winErr == .cannotComplete { return fail("app_busy") }
  var winFrame: CGRect? = nil
  var winTitle = ""
  if let win = window {
    winFrame = liveFrame(win)
    winTitle = clean(copyAttr(win, "AXTitle") as? String, 80)
  }
  let focusedEl = element(copyAttr(app, "AXFocusedUIElement"))

  var w = walk(app: app, window: window, winFrame: winFrame, winTitle: winTitle, focusedEl: focusedEl,
               maxCount: maxCount, stopAt: stopAt)
  // Chromium builds its tree only once asked (wake), and the first read is
  // often a sliver of it: give it a moment and read again, keeping the larger.
  if engine != .other && !w.busy && w.found.count < 15 && msLeft(stopAt) > 300 {
    usleep(150_000)
    let again = walk(app: app, window: window, winFrame: winFrame, winTitle: winTitle, focusedEl: focusedEl,
                     maxCount: maxCount, stopAt: stopAt)
    if again.found.count > w.found.count { w = again }
  }
  if w.busy && w.found.isEmpty { return fail("app_busy") }
  let selection = (focusedEl != nil && !w.busy) ? selectionOf(focusedEl!) : ""

  let base = nextBase(w.found.count)
  let snap = Snap(first: base, last: base + w.found.count - 1)
  var elems: [J] = []
  elems.reserveCapacity(w.found.count)
  var focusedId: String? = nil
  for (i, f) in w.found.enumerated() {
    let id = "e\(base + i)"
    snap.byId[id] = Entry(el: f.el, axRole: f.axRole, secure: f.secure, pid: pid, clip: f.clip)
    if f.focused && focusedId == nil { focusedId = id }
    elems.append(f.json(id))
  }
  previous = current
  current = snap
  lastPid = pid

  var appInfo: Reply = [("name", .str(front.localizedName ?? "")), ("pid", .int(Int(pid)))]
  if let b = front.bundleIdentifier { appInfo.append(("bundleId", .str(b))) }
  var windowJ = J.null
  if let f = winFrame { windowJ = .obj([("frame", frameJ(f))]) }
  let ms = Int((DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1_000_000)
  var r = ok()
  r.append(("app", .obj(appInfo)))
  r.append(("window", windowJ))
  r.append(("focused", focusedId.map { J.str($0) } ?? J.null))
  r.append(("selection", .str(selection)))
  r.append(("scale", .str("points")))
  r.append(("elements", .arr(elems)))
  r.append(("truncated", .bool(w.truncated)))
  r.append(("ms", .int(ms)))
  return r
}

// MARK: - Acting on an id

func lookup(_ id: String) -> Entry? { current.byId[id] ?? previous.byId[id] }

/// The middle of what can be seen of the element now (it may have moved since
/// the snapshot), or nil when it is gone.
func centre(_ e: Entry) -> CGPoint? {
  guard let f = liveFrame(e.el), f.width > 0, f.height > 0 else { return nil }
  let seen = f.intersection(e.clip)
  let r = (seen.isNull || seen.width <= 0 || seen.height <= 0) ? f : seen
  return CGPoint(x: r.midX, y: r.midY)
}

func press(_ e: Entry) -> Reply {
  let names = actionNames(e.el)
  for a in ["AXPress", "AXConfirm", "AXPick", "AXShowMenu"] where names.contains(a) || (names.isEmpty && a == "AXPress") {
    let err = AXUIElementPerformAction(timed(e.el, actionTimeout), a as CFString)
    switch err {
    case .success:
      return ok([("how", .str(a))])
    case .cannotComplete:
      // Done, but the app was slow to say so — typically a press that opened
      // a dialog or a menu. "Failed" here would make the caller click it again.
      return ok([("how", .str(a)), ("slow", .bool(true))])
    case .invalidUIElement:
      return fail("gone")
    default:
      continue
    }
  }
  // Rows and cells mostly cannot be pressed, only chosen.
  if settable(e.el, "AXSelected"), setAttr(e.el, "AXSelected", kCFBooleanTrue) == .success {
    return ok([("how", .str("select"))])
  }
  return fail(names.isEmpty ? "no_action" : "press_failed")
}

/// A real left click at the middle of the element, in the app it belongs to.
/// Events come from a private source, so a key the user happens to hold does
/// not turn it into a cmd-click.
func click(_ e: Entry, _ deadline: DispatchTime) -> Reply {
  guard bringForward(e.pid, deadline) else { return fail("not_front") }
  guard let p = centre(e) else { return fail("gone") }
  guard let src = CGEventSource(stateID: .privateState),
        let move = CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left),
        let down = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left),
        let up = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left) else {
    return fail("no_event")
  }
  down.setIntegerValueField(.mouseEventClickState, value: 1)
  up.setIntegerValueField(.mouseEventClickState, value: 1)
  move.post(tap: .cghidEventTap)
  usleep(20_000)
  down.post(tap: .cghidEventTap)
  usleep(30_000)
  up.post(tap: .cghidEventTap)
  return ok([("how", .str("click"))])
}

/// The field's whole value replaced (focused first, as typing would be). A
/// password field is not written to.
func setValue(_ e: Entry, _ text: String) -> Reply {
  if e.secure { return fail("secure") }
  _ = setAttr(e.el, "AXFocused", kCFBooleanTrue)
  let err = setAttr(e.el, "AXValue", text as CFString)
  switch err {
  case .success, .cannotComplete: return ok()
  default: return fail(axName(err))
  }
}

func focus(_ e: Entry, _ deadline: DispatchTime) -> Reply {
  if e.axRole == "AXWindow" || e.axRole == "AXSheet" {
    _ = bringForward(e.pid, deadline)
    let raised = AXUIElementPerformAction(timed(e.el, actionTimeout), "AXRaise" as CFString)
    _ = setAttr(e.el, "AXMain", kCFBooleanTrue)
    if raised == .success { return ok() }
  }
  let err = setAttr(e.el, "AXFocused", kCFBooleanTrue)
  switch err {
  case .success, .cannotComplete: return ok()
  default: return fail(axName(err))
  }
}

/// Wheel lines at the element's middle (the pointer is moved there: wheel
/// events go to what is under it), or wherever the pointer is.
func scroll(_ e: Entry?, dir: String, lines: Int, deadline: DispatchTime) -> Reply {
  let delta: (Int32, Int32)
  switch dir {
  case "up": delta = (1, 0)
  case "down": delta = (-1, 0)
  case "left": delta = (0, 1)
  case "right": delta = (0, -1)
  default: return fail("bad_dir")
  }
  guard let src = CGEventSource(stateID: .privateState) else { return fail("no_event") }
  var at: CGPoint? = nil
  if let e = e {
    guard let p = centre(e) else { return fail("gone") }
    at = p
    if let move = CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left) {
      move.post(tap: .cghidEventTap)
      usleep(30_000)
    }
  }
  let stop = deadline - .milliseconds(100)
  for _ in 0..<max(1, min(lines, 40)) {
    if DispatchTime.now() >= stop { break }
    guard let ev = CGEvent(scrollWheelEvent2Source: src, units: .line, wheelCount: 2,
                           wheel1: delta.0, wheel2: delta.1, wheel3: 0) else { return fail("no_event") }
    if let p = at { ev.location = p }
    ev.post(tap: .cghidEventTap)
    usleep(8_000)
  }
  return ok()
}

// MARK: - Keys

/// Character → (key code, needs shift) on the keyboard layout in use, so
/// "cmd+z" is Undo on a German, French or Dvorak keyboard too. Built once per
/// layout (TIS wants the main thread, which is where commands run).
func layoutKeys() -> [String: (CGKeyCode, Bool)] {
  guard let src = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue() else { return [:] }
  var layoutId = ""
  if let p = TISGetInputSourceProperty(src, kTISPropertyInputSourceID) {
    layoutId = Unmanaged<CFString>.fromOpaque(p).takeUnretainedValue() as String
  }
  if let cache = layoutCache, !layoutId.isEmpty, cache.id == layoutId { return cache.keys }
  var keys: [String: (CGKeyCode, Bool)] = [:]
  if let raw = TISGetInputSourceProperty(src, kTISPropertyUnicodeKeyLayoutData) {
    let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue()
    if let bytes = CFDataGetBytePtr(data) {
      let layout = UnsafeRawPointer(bytes).assumingMemoryBound(to: UCKeyboardLayout.self)
      let kbd = UInt32(LMGetKbdType())
      // Unshifted first, so a key's plain character wins; shift (Carbon's
      // shiftKey >> 8 == 2) only fills in what needs it ("?", "+" on US).
      for (shifted, mods) in [(false, UInt32(0)), (true, UInt32(2))] {
        for code in 0..<128 where !keypadCodes.contains(code) {
          var dead: UInt32 = 0
          // UniCharCount is not imported into Swift: UCKeyTranslate takes Int.
          var len = 0
          var chars = [UniChar](repeating: 0, count: 4)
          let st = UCKeyTranslate(layout, UInt16(code), UInt16(kUCKeyActionDown), mods, kbd,
                                  OptionBits(kUCKeyTranslateNoDeadKeysMask), &dead,
                                  chars.count, &len, &chars)
          if st != 0 || len == 0 { continue }
          let s = String(utf16CodeUnits: chars, count: Int(len)).lowercased()
          if keys[s] == nil { keys[s] = (CGKeyCode(code), shifted) }
        }
      }
    }
  }
  layoutCache = (id: layoutId, keys: keys)
  return keys
}

/// "cmd+shift+t", "ctrl+k", "enter", "cmd++" → key code and modifier flags.
func chordOf(_ raw: String) -> (code: CGKeyCode, flags: CGEventFlags)? {
  let text = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  guard !text.isEmpty, text.count <= 64 else { return nil }
  var parts: [String]
  if text == "+" {
    parts = ["+"]
  } else if text.hasSuffix("++") {
    parts = text.dropLast(2).split(separator: "+").map { String($0) } + ["+"]
  } else {
    parts = text.split(separator: "+").map { String($0) }
  }
  parts = parts.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
  guard let name = parts.last else { return nil }
  var flags: CGEventFlags = []
  for m in parts.dropLast() {
    switch m {
    case "cmd", "command", "meta", "super", "⌘": flags.insert(.maskCommand)
    case "ctrl", "control", "ctl", "⌃": flags.insert(.maskControl)
    case "alt", "option", "opt", "⌥": flags.insert(.maskAlternate)
    case "shift", "⇧": flags.insert(.maskShift)
    case "fn": flags.insert(.maskSecondaryFn)
    default: return nil
    }
  }
  if let code = namedKeys[name] { return (code: code, flags: flags) }
  let ch = name == "plus" ? "+" : (name == "minus" ? "-" : name)
  guard ch.count == 1 else { return nil }
  var found = layoutKeys()[ch]
  if found == nil, let c = ansiKeys[ch] { found = (c, false) }
  if found == nil && ch == "+" { found = (CGKeyCode(24), true) }
  guard let k = found else { return nil }
  if k.1 { flags.insert(.maskShift) }
  return (code: k.0, flags: flags)
}

/// The chord pressed and released in the app the latest snapshot read, which
/// is brought to the front first: keys go to whatever is in front.
func key(_ chord: String, _ deadline: DispatchTime) -> Reply {
  guard let k = chordOf(chord) else { return fail("bad_chord") }
  if lastPid > 0 && !bringForward(lastPid, deadline) { return fail("not_front") }
  guard let src = CGEventSource(stateID: .privateState),
        let down = CGEvent(keyboardEventSource: src, virtualKey: k.code, keyDown: true),
        let up = CGEvent(keyboardEventSource: src, virtualKey: k.code, keyDown: false) else {
    return fail("no_event")
  }
  down.flags = k.flags
  up.flags = k.flags
  down.post(tap: .cghidEventTap)
  usleep(12_000)
  up.post(tap: .cghidEventTap)
  return ok()
}

// MARK: - Opening an app

/// The app a person means by `raw`: one running under that name, else
/// "<name>.app" in the usual folders (case aside), else its name in the
/// user's language, else a whole-word match ("chrome", "settings").
func appURL(_ raw: String) -> URL? {
  var want = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  if want.hasSuffix(".app") { want = String(want.dropLast(4)) }
  guard !want.isEmpty, !want.contains("/") else { return nil }
  let running = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
  if let r = running.first(where: { ($0.localizedName ?? "").lowercased() == want }), let u = r.bundleURL { return u }

  let fm = FileManager.default
  let dirs = ["/Applications", "/Applications/Utilities", "/System/Applications",
              "/System/Applications/Utilities", NSHomeDirectory() + "/Applications"]
  var apps: [URL] = []
  for d in dirs {
    guard let names = try? fm.contentsOfDirectory(atPath: d) else { continue }
    for n in names where n.lowercased().hasSuffix(".app") {
      apps.append(URL(fileURLWithPath: d).appendingPathComponent(n))
    }
  }
  let base = { (u: URL) -> String in u.deletingPathExtension().lastPathComponent.lowercased() }
  if let u = apps.first(where: { base($0) == want }) { return u }
  let shown = { (u: URL) -> String in
    let s = fm.displayName(atPath: u.path).lowercased()
    return s.hasSuffix(".app") ? String(s.dropLast(4)) : s
  }
  if let u = apps.first(where: { shown($0) == want }) { return u }
  let spaced = { (s: String) -> String in
    " " + s.split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map { String($0) }.joined(separator: " ") + " "
  }
  let key = spaced(want)
  if key.trimmingCharacters(in: .whitespaces).count >= 3 {
    if let u = apps.filter({ spaced(base($0)).contains(key) }).min(by: { base($0).count < base($1).count }) { return u }
    if let r = running.first(where: { spaced(($0.localizedName ?? "").lowercased()).contains(key) }), let u = r.bundleURL { return u }
  }
  return nil
}

/// Launch the app, or bring it forward if it is running.
func openApp(_ name: String, _ deadline: DispatchTime) -> Reply {
  guard let url = appURL(name) else { return fail("not_found") }
  let shown = FileManager.default.displayName(atPath: url.path)
  let label = shown.lowercased().hasSuffix(".app") ? String(shown.dropLast(4)) : shown
  let launch = Launch()
  let cfg = NSWorkspace.OpenConfiguration()
  cfg.activates = true
  NSWorkspace.shared.openApplication(at: url, configuration: cfg) { _, error in
    launch.failed = error != nil
    launch.sem.signal()
  }
  let wait = min(deadline - .milliseconds(100), DispatchTime.now() + .milliseconds(900))
  if launch.sem.wait(timeout: wait) == .timedOut {
    return ok([("app", .str(label)), ("pending", .bool(true))]) // still starting; it comes forward when ready
  }
  return launch.failed ? fail("launch_failed") : ok([("app", .str(label))])
}

// MARK: - Commands

func idOf(_ v: Any?) -> J {
  if let s = v as? String { return .str(s) }
  if let n = v as? NSNumber { return .int(n.intValue) }
  return .null
}

func clampInt(_ v: Any?, _ lo: Int, _ hi: Int, _ fallback: Int) -> Int {
  guard let n = v as? NSNumber else { return fallback }
  let d = n.doubleValue
  if !d.isFinite { return fallback }
  return Int(max(Double(lo), min(Double(hi), d.rounded())))
}

func run(_ cmd: String, _ req: [String: Any], _ deadline: DispatchTime) -> Reply {
  switch cmd {
  case "ping":
    return ok([("pong", .bool(true)), ("pid", .int(Int(getpid()))), ("v", .int(1))])
  case "trusted":
    let prompt = (req["prompt"] as? Bool) ?? false
    let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
    return ok([("trusted", .bool(AXIsProcessTrustedWithOptions(opts)))])
  case "open":
    return openApp((req["app"] as? String) ?? "", deadline)
  case "snapshot", "press", "click", "setValue", "focus", "scroll", "key":
    break
  default:
    return fail("unknown_command")
  }
  // The rest reads or moves another app, which macOS allows only with
  // Accessibility (an untrusted process's events are dropped without a word).
  guard AXIsProcessTrusted() else { return fail("not_trusted") }
  switch cmd {
  case "snapshot":
    return snapshot(maxCount: clampInt(req["max"], 1, 500, 250), budgetMs: clampInt(req["budgetMs"], 50, 6000, 900),
                    deadline: deadline)
  case "key":
    return key((req["chord"] as? String) ?? "", deadline)
  case "scroll":
    var target: Entry? = nil
    if let el = req["el"] as? String {
      guard let e = lookup(el) else { return fail("unknown_id") }
      target = e
    }
    return scroll(target, dir: (req["dir"] as? String) ?? "", lines: clampInt(req["lines"], 1, 40, 5), deadline: deadline)
  default:
    break
  }
  guard let el = req["el"] as? String, !el.isEmpty else { return fail("bad_id") }
  guard let e = lookup(el) else { return fail("unknown_id") }
  switch cmd {
  case "press": return press(e)
  case "click": return click(e, deadline)
  case "setValue": return setValue(e, (req["text"] as? String) ?? "")
  case "focus": return focus(e, deadline)
  default: return fail("unknown_command")
  }
}

/// One line from stdin, on the reader thread, the moment it arrives: its
/// watchdog is armed now, so a command stuck behind a slow one is still
/// answered in its own time; then it joins the main thread's queue. Bad lines
/// are answered through that queue too, so answers keep the lines' order.
func receive(_ line: String) {
  let got = DispatchTime.now()
  let text = line.trimmingCharacters(in: .whitespacesAndNewlines)
  if text.isEmpty { return }
  guard let data = text.data(using: .utf8),
        let parsed = try? JSONSerialization.jsonObject(with: data, options: []),
        let req = parsed as? [String: Any] else {
    DispatchQueue.main.async { out.stray(fail("bad_json")) }
    return
  }
  received += 1
  let key = received
  let id = idOf(req["id"])
  guard let cmd = req["cmd"] as? String else {
    DispatchQueue.main.async { _ = out.answer(key, id, fail("bad_request")) }
    return
  }
  let limit = clampInt(req["timeoutMs"], 100, 8000, cmd == "snapshot" ? 1500 : 1200)
  // A moment before the caller gives up, so it hears "timeout" from here.
  let deadline = got + .milliseconds(limit - 40)
  out.watch(key, id, at: deadline)
  DispatchQueue.main.async { perform(key, id, cmd, req, deadline) }
}

/// A command, on the main thread, in the order the lines came.
func perform(_ key: Int, _ id: J, _ cmd: String, _ req: [String: Any], _ deadline: DispatchTime) {
  // Waited out its time behind another command: it is (about to be) answered
  // "timeout", and is never acted on late.
  if out.isAnswered(key) || DispatchTime.now() >= deadline - .milliseconds(30) { return }
  busy.begin()
  let reply = run(cmd, req, deadline)
  busy.end()
  out.answer(key, id, reply)
}

// MARK: - Main

// The default for every element this process messages; each is also given it
// (or actionTimeout) on its own before it is messaged.
_ = AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), messageTimeout)

// stdin on its own thread; the commands run in order on the main thread,
// whose run loop also keeps NSWorkspace's idea of the front app current.
let reader = Thread {
  while let line = readLine(strippingNewline: true) {
    receive(line)
  }
  // stdin closed: the app is gone, or done with us. Finish what was asked
  // (the main queue runs in order), then go.
  DispatchQueue.main.async { exit(0) }
}
reader.start()

let stuckCheck = DispatchSource.makeTimerSource(queue: DispatchQueue.global())
stuckCheck.schedule(deadline: .now() + 1, repeating: 1.0)
stuckCheck.setEventHandler {
  // _exit, not exit: exit's cleanup waits on the very thread that is stuck.
  // Nothing is lost; every answer was written straight to the pipe.
  if busy.stuck() { _exit(3) }
}
stuckCheck.resume()

let keepAlive = Timer(timeInterval: 3600, repeats: true) { _ in }
RunLoop.main.add(keepAlive, forMode: .default)
RunLoop.main.run()
