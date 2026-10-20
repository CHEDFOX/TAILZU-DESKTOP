// tzax — Tailzu Ask's eyes and hands in the app in front (macOS 13+).
//
// Ask has to know what is on the screen of the app the user is in ("where's
// export?") and, when asked to, press, type into, scroll and focus things
// there. This helper is that reach: it reads the focused window's
// accessibility tree into a short list of elements with ids, and acts on those
// ids. The list goes only to axDriver.js; the agent sends on roles, labels and
// short values, never frames or window titles. The focused window's title does
// come back, beside the list and never in it, because it is how the agent
// tells, on every read, that the window is a private one or a bank's site;
// like the frames, it stays on this machine.
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
//   {"id":5,"cmd":"look","maxSide":1600}         {"id":5,"ok":true,"window":{…},"lines":[…],"image":{…},…}
//   {"id":6,"cmd":"caret","timeoutMs":250}       {"id":6,"ok":true,"caret":[x,y,w,h]|null,"field":[x,y,w,h]|null,"app":{…},"scale":"points",…}
//   anything that fails                          {"id":4,"ok":false,"error":"not_trusted"}
//
// It needs Accessibility, which macOS grants to the app that started it
// (Tailzu: the same permission the field reader already uses). It never reads
// a password: a secure field is listed as one, without its value.
//
// "look" is the one command that takes a picture: the focused window's own
// pixels, read into lines of text here with Vision, plus a JPEG of it. It
// needs Screen Recording, which it checks for and never asks for: a prompt
// from a helper nobody sees would land over the user's app, so asking, and
// saying why, is the app's to do. Without it a look answers
// no_screen_permission, for the app to tell the user so. The picture goes
// only to axDriver.js and stays on this machine unless the user lets Ask
// send it. A look takes longer than anything else here, so it runs on a
// queue of its own, beside the other commands: the snapshot asked for at the
// same moment is not kept waiting behind it.
//
// "caret" is where the text cursor and its text box are, for Blip to peek
// over the box while the user dictates: two rectangles and the app, never a
// word of the text. It is asked every few hundred milliseconds for as long as
// a dictation lasts, so it too has a queue of its own, and a small budget.
import AppKit
import ApplicationServices
import Carbon
import Foundation
import ImageIO
import ScreenCaptureKit
import Vision

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
/// A look's text is at most this many lines: the agent lists them beside the
/// accessibility elements, and a request carries a few hundred at most.
let lookMaxLines = 300
/// A look's JPEG bigger than this is encoded again, rougher, or left out: the
/// answer is one line on a pipe, and axDriver.js drops a line over 12 MB.
let jpegMaxBytes = 6_000_000

// MARK: - JSON out
//
// Written by hand rather than with JSONSerialization, which raises an
// Objective-C exception (a crash, not an error) on a NaN. Every number here is
// made an Int on the way in, except a look's confidences, which are written
// with two decimals and never as NaN; an answer is always exactly one line.

enum J {
  case null
  case bool(Bool)
  case int(Int)
  case num(Double)
  case str(String)
  /// A string with nothing in it to escape (base64): a look's picture is
  /// hundreds of kilobytes, not worth quoting a character at a time.
  case plain(String)
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
  case .num(let d): out += d.isFinite ? String(format: "%.2f", d) : "null"
  case .str(let s): quote(s, into: &out)
  case .plain(let s):
    out += "\""
    out += s
    out += "\""
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
  /// A web page's area was there but empty: Chromium has not built the page's
  /// tree yet.
  var emptyWeb = false
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
/// Looks run here, one at a time, beside the main thread's commands.
let lookQueue = DispatchQueue(label: "space.tailzu.tzax.look", qos: .userInitiated)
let lookBusy = Busy()
/// Caret reads run here, one at a time, beside both: one asked while a walk
/// or a look is under way is not kept waiting, and keeps neither waiting.
let caretQueue = DispatchQueue(label: "space.tailzu.tzax.caret", qos: .userInitiated)
let caretBusy = Busy()
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
  return fetch(el, attrList, count: attrNames.count, timeout: messageTimeout)
}

/// The `count` attributes `names` lists, in one message that gives up after
/// `timeout`. Missing attributes are nil.
func fetch(_ el: AXUIElement, _ names: CFArray, count: Int, timeout: Float) -> (AXError, [AnyObject?]) {
  var got = [AnyObject?](repeating: nil, count: count)
  var values: CFArray?
  let err = AXUIElementCopyMultipleAttributeValues(timed(el, timeout), names, AXCopyMultipleAttributeOptions(), &values)
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
  var webSeen = false
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
    // Only the first page area met counts: breadth first, that is the page's
    // own. A frame inside the page has an area of its own, and an empty one
    // (a blank helper frame, an ad not loaded) is on most pages and is no
    // reason to read the whole app twice on every step.
    if axRole == "AXWebArea" {
      if !webSeen && kids.isEmpty { w.emptyWeb = true }
      webSeen = true
    }
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
  var fullTitle = ""
  if let win = window {
    winFrame = liveFrame(win)
    // Read once: cut to a label's length for the walk, which drops the static
    // text that repeats it, and kept longer for the agent's own check.
    let raw = copyAttr(win, "AXTitle") as? String
    winTitle = clean(raw, 80)
    fullTitle = clean(raw, 200)
  }
  let focusedEl = element(copyAttr(app, "AXFocusedUIElement"))

  var w = walk(app: app, window: window, winFrame: winFrame, winTitle: winTitle, focusedEl: focusedEl,
               maxCount: maxCount, stopAt: stopAt)
  // Chromium builds its tree only once asked (wake), and the first read is
  // often a sliver of it: give it a moment and read again, keeping the larger.
  // The menu bar is not counted (Chrome alone has ten menus, and they are
  // there before the page is), and a page whose area is still empty is read
  // again however much browser is around it.
  let inWindow = w.found.filter { $0.role != "menu" }.count
  if engine != .other && !w.busy && (w.emptyWeb || inWindow < 15) && msLeft(stopAt) > 300 {
    usleep(150_000)
    let again = walk(app: app, window: window, winFrame: winFrame, winTitle: winTitle, focusedEl: focusedEl,
                     maxCount: maxCount, stopAt: stopAt)
    // A tie goes to the read whose page is no longer empty (both stopped at
    // the most elements). A smaller one never wins: a second read cut short
    // by the time left may simply not have got as far as the page.
    if again.found.count > w.found.count
        || (again.found.count == w.found.count && w.emptyWeb && !again.emptyWeb && !again.busy) { w = again }
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
  // The window: its frame, and its title for agent.js to refuse a private
  // window or a sensitive site on every read, not only the first. Neither
  // goes into a request; toRequestElements sends no window at all.
  var windowJ = J.null
  if window != nil {
    var wo: Reply = []
    if let f = winFrame { wo.append(("frame", frameJ(f))) }
    wo.append(("title", .str(fullTitle)))
    windowJ = .obj(wo)
  }
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

/// A press is AXPress and nothing else. Other actions an element lists are
/// not a press: AXConfirm is Return in a text field (it sends the draft,
/// submits the form), AXShowMenu opens a context menu (Chromium lists it on
/// every node, clickable or not). Answering ok for one of those would also
/// stop agent.js's real click, the thing that was meant. So without AXPress
/// a row is chosen, and anything else fails, for the caller to click.
func press(_ e: Entry) -> Reply {
  let names = actionNames(e.el)
  // An action list that could not be read (a busy app) still gets the press.
  if names.contains("AXPress") || names.isEmpty {
    let err = AXUIElementPerformAction(timed(e.el, actionTimeout), "AXPress" as CFString)
    switch err {
    case .success:
      return ok([("how", .str("AXPress"))])
    case .cannotComplete:
      // Done, but the app was slow to say so — typically a press that opened
      // a dialog or a menu. "Failed" here would make the caller click it again.
      return ok([("how", .str("AXPress")), ("slow", .bool(true))])
    case .invalidUIElement:
      return fail("gone")
    default:
      break
    }
  }
  // Rows and cells mostly cannot be pressed, only chosen. A choice the app
  // was slow to confirm may have been made, and a click on a chosen row can
  // start renaming it (Finder), so that one is slow, not failed, too.
  if settable(e.el, "AXSelected") {
    switch setAttr(e.el, "AXSelected", kCFBooleanTrue) {
    case .success: return ok([("how", .str("select"))])
    case .cannotComplete: return ok([("how", .str("select")), ("slow", .bool(true))])
    default: break
    }
  }
  return fail(names.contains("AXPress") ? "press_failed" : "no_action")
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

// MARK: - Looking: the window's picture and its text
//
// None of this runs on the main thread: a look runs on lookQueue, its text is
// read on a global queue. ScreenCaptureKit answers through completion
// handlers on threads of its own, and Vision on that global queue; each is
// waited for with a semaphore that gives up at the look's budget, so a
// capture or a read that never comes back costs a look, not the helper.

/// A result that arrives on another thread, waited for no later than a
/// deadline. One that comes after the wait gave up lands here unread.
final class Waiter<T> {
  private let sem = DispatchSemaphore(value: 0)
  private let lock = NSLock()
  private var value: T?

  func put(_ v: T?) {
    lock.lock()
    value = v
    lock.unlock()
    sem.signal()
  }

  /// The value (nil when there was none), or late when the deadline came first.
  func take(by deadline: DispatchTime) -> (value: T?, late: Bool) {
    if sem.wait(timeout: deadline) == .timedOut { return (nil, true) }
    lock.lock()
    defer { lock.unlock() }
    return (value, false)
  }
}

/// One window as the window server lists it.
struct Listed {
  let id: CGWindowID
  let frame: CGRect
  let layer: Int
  let name: String
}

/// The window a look takes: its number for the capture, its frame (global
/// top-left points, like a snapshot's), and its title, which stays here like
/// a snapshot's does.
struct LookWindow {
  let id: CGWindowID
  let frame: CGRect
  let title: String
  /// The title bar's row, where the title is drawn: sent as a frame only
  /// (titleFrames), for agent.js to cut the picture below it even when the
  /// OCR did not read the title there, or did not run.
  var titleBand: CGRect? = nil
}

/// A window's title bar row, from its traffic lights: they sit centred in it,
/// in a plain title bar and in a unified toolbar alike, so the row is as far
/// below their middle as its top is above it. The window's width; nil for a
/// window without them (a panel, an app that draws its own) or a row taller
/// than a quarter of the window.
func titleBand(_ win: AXUIElement, _ frame: CGRect) -> CGRect? {
  for attr in ["AXCloseButton", "AXMinimizeButton", "AXZoomButton"] {
    guard let b = element(copyAttr(win, attr)), let f = liveFrame(b), f.width > 0, f.height > 0 else { continue }
    let h = (2 * (f.midY - frame.minY)).rounded(.up)
    guard h > 0, h <= frame.height / 4 else { return nil }
    return CGRect(x: frame.minX, y: frame.minY, width: frame.width, height: h)
  }
  return nil
}

/// The app's windows on screen, frontmost first. The window list is the only
/// public place a window's number is, and its bounds are in the same global
/// top-left points as accessibility's frames.
func listedWindows(_ pid: pid_t) -> [Listed] {
  guard let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
    return []
  }
  var wins: [Listed] = []
  for w in info {
    guard (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
          let num = w[kCGWindowNumber as String] as? NSNumber,
          let layer = (w[kCGWindowLayer as String] as? NSNumber)?.intValue,
          let bounds = w[kCGWindowBounds as String] as? NSDictionary,
          let r = CGRect(dictionaryRepresentation: bounds as CFDictionary),
          r.width > 1, r.height > 1 else { continue }
    if let alpha = w[kCGWindowAlpha as String] as? NSNumber, alpha.doubleValue <= 0 { continue }
    wins.append(Listed(id: CGWindowID(num.uint32Value), frame: r, layer: layer, name: (w[kCGWindowName as String] as? String) ?? ""))
  }
  return wins
}

/// How far apart two frames are, edge by edge, in points.
func apart(_ a: CGRect, _ b: CGRect) -> CGFloat {
  abs(a.minX - b.minX) + abs(a.minY - b.minY) + abs(a.width - b.width) + abs(a.height - b.height)
}

/// The window the user is in: the app's focused window as accessibility sees
/// it (the one a snapshot reads), found in the window list by its owner and
/// bounds. When accessibility has no answer (not trusted, the app busy) it is
/// the app's frontmost ordinary window: a hung app still has pixels.
func lookWindow(_ pid: pid_t) -> LookWindow? {
  let app = timed(AXUIElementCreateApplication(pid))
  var winRef: CFTypeRef?
  let err = AXUIElementCopyAttributeValue(app, "AXFocusedWindow" as CFString, &winRef)
  var window = element(winRef)
  if window == nil && err != .cannotComplete && err != .apiDisabled { window = element(copyAttr(app, "AXMainWindow")) }
  var axFrame: CGRect? = nil
  var title = ""
  if let win = window {
    axFrame = liveFrame(win)
    title = clean(copyAttr(win, "AXTitle") as? String, 200)
  }
  // Ordinary and floating windows; not the menu bar's, the Dock's or a
  // screen saver's, which sit on the layers above.
  let listed = listedWindows(pid).filter { $0.layer >= 0 && $0.layer < 24 }
  var pick: Listed? = nil
  var focusedOne = false
  if let f = axFrame, f.width > 0, f.height > 0 {
    pick = listed.min(by: { apart($0.frame, f) < apart($1.frame, f) })
    if let p = pick, apart(p.frame, f) > 8 {
      // No window with the same bounds (an app whose idea of its own frame is
      // a little off): the frontmost one that covers most of it, else none.
      pick = listed.first(where: {
        let i = $0.frame.intersection(f)
        return !i.isNull && i.width * i.height >= 0.6 * f.width * f.height
      })
    } else {
      focusedOne = pick != nil
    }
  } else {
    pick = listed.first(where: { $0.layer == 0 })
  }
  guard let w = pick else { return nil }
  // The title is the pictured window's, because the agent refuses a private
  // window by it. A window that only covers the focused one may be another
  // (the browser's private one), so it goes by its own name in the list.
  let listedName = clean(w.name, 200)
  let named = focusedOne || listedName.isEmpty ? title : listedName
  // The title bar only of the window accessibility named: the buttons are
  // that window's.
  var band: CGRect? = nil
  if focusedOne, let ax = window { band = titleBand(ax, w.frame) }
  return LookWindow(id: w.id, frame: w.frame, title: named.isEmpty ? listedName : named, titleBand: band)
}

enum Shot {
  case image(CGImage)
  case failed(String)
}

/// The window's own pixels, whatever is over it, at the display's full
/// resolution and without its shadow: exactly its frame. ScreenCaptureKit
/// from macOS 14; on 13, where ScreenCaptureKit cannot take one picture, the
/// window-list call (deprecated from 14, so never reached there).
func capture(_ win: LookWindow, until: DispatchTime) -> Shot {
  if #available(macOS 14.0, *) {
    return captureWithScreenCaptureKit(win, until: until)
  }
  // The window-list call is looked up by name in CoreGraphics (already
  // loaded with AppKit), not named here: the SDK obsoletes it from macOS 15,
  // and the newer SDK CI builds with need not let Swift call it at all,
  // however it is guarded. It is the same public function, only found at run
  // time; the arguments are its C ones (CGWindowID and the two option sets
  // are 32-bit, the image comes back retained). The image options are its
  // fixed values, kCGWindowImageBoundsIgnoreFraming | ...BestResolution, so
  // nothing of this call depends on what the SDK says about it.
  typealias CreateImage = @convention(c) (CGRect, UInt32, CGWindowID, UInt32) -> UnsafeMutableRawPointer?
  guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGWindowListCreateImage") else { return .failed("capture_failed") }
  let createImage = unsafeBitCast(symbol, to: CreateImage.self)
  let options: UInt32 = (1 << 0) | (1 << 3)
  guard let made = createImage(.null, CGWindowListOption.optionIncludingWindow.rawValue, win.id, options) else {
    return .failed("capture_failed")
  }
  let image = Unmanaged<CGImage>.fromOpaque(made).takeRetainedValue()
  guard image.width > 0, image.height > 0 else { return .failed("capture_failed") }
  return .image(image)
}

@available(macOS 14.0, *)
func captureWithScreenCaptureKit(_ win: LookWindow, until: DispatchTime) -> Shot {
  let listed = Waiter<SCShareableContent>()
  SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { content, _ in
    listed.put(content)
  }
  let (content, lateList) = listed.take(by: until)
  if lateList { return .failed("timeout") }
  guard let shareable = content else { return .failed("capture_failed") }
  guard let scWindow = shareable.windows.first(where: { $0.windowID == win.id }) else { return .failed("no_window") }
  let filter = SCContentFilter(desktopIndependentWindow: scWindow)
  // The window's points times the display's pixels per point: the picture is
  // its full resolution, the shape of its frame, so Vision's boxes map back.
  let k = CGFloat(filter.pointPixelScale)
  let scale = k.isFinite && k >= 0.5 && k <= 8 ? k : 2
  let config = SCStreamConfiguration()
  config.width = max(1, min(16384, Int((win.frame.width * scale).rounded())))
  config.height = max(1, min(16384, Int((win.frame.height * scale).rounded())))
  config.showsCursor = false
  config.ignoreShadowsSingleWindow = true
  config.captureResolution = .best
  let shot = Waiter<CGImage>()
  SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) { image, _ in
    shot.put(image)
  }
  let (image, lateShot) = shot.take(by: until)
  if lateShot { return .failed("timeout") }
  guard let picture = image, picture.width > 0, picture.height > 0 else { return .failed("capture_failed") }
  return .image(picture)
}

/// One line of text Vision read in the window, and where it is on the screen.
struct Line {
  let text: String
  let frame: CGRect
  let conf: Float

  var json: J {
    let c = conf.isFinite ? Double(max(0, min(1, conf))) : 0
    return .obj([("text", .str(text)), ("frame", frameJ(frame)), ("conf", .num(c))])
  }
}

/// Vision's lines in reading order, in screen points. Its boxes are fractions
/// of the picture with the origin at the bottom left; the picture is exactly
/// the window, so the window's frame turns them into the global top-left
/// points a snapshot's frames are in.
func screenLines(_ results: [Any], in frame: CGRect) -> [Line] {
  var found: [Line] = []
  for case let obs as VNRecognizedTextObservation in results {
    guard let best = obs.topCandidates(1).first else { continue }
    let text = clean(best.string, 120)
    let b = obs.boundingBox.standardized
    guard !text.isEmpty, b.minX.isFinite, b.minY.isFinite, b.width.isFinite, b.height.isFinite else { continue }
    let x0 = max(0, min(1, b.minX)), x1 = max(0, min(1, b.maxX))
    let y0 = max(0, min(1, b.minY)), y1 = max(0, min(1, b.maxY))
    guard x1 > x0, y1 > y0 else { continue }
    let r = CGRect(x: frame.minX + x0 * frame.width, y: frame.minY + (1 - y1) * frame.height,
                   width: (x1 - x0) * frame.width, height: (y1 - y0) * frame.height)
    found.append(Line(text: text, frame: r, conf: best.confidence))
  }
  found.sort { a, b in
    let ya = a.frame.minY.rounded(), yb = b.frame.minY.rounded()
    return ya != yb ? ya < yb : a.frame.minX < b.frame.minX
  }
  return Array(found.prefix(lookMaxLines))
}

/// Vision's names for the user's preferred languages, out of those it reads
/// (`supported`, at the request's level), in the user's order. Matched on the
/// language: "zh-Hant-TW" is zh-Hant first, then zh-Hans; "fr-CA" is fr-FR.
func ocrLanguages(_ preferred: [String], _ supported: [String]) -> [String] {
  let lang = { (tag: String) -> String in tag.lowercased().split(whereSeparator: { $0 == "-" || $0 == "_" }).first.map(String.init) ?? "" }
  var found: [String] = []
  for p in preferred {
    let tag = p.replacingOccurrences(of: "_", with: "-").lowercased()
    let same = supported.filter { !lang($0).isEmpty && lang($0) == lang(tag) }
    for s in same.filter({ tag.hasPrefix($0.lowercased()) }) + same where !found.contains(s) { found.append(s) }
  }
  return found
}

/// The text in the picture, read on a thread of its own while the picture is
/// encoded on this one. A read still going when the look's time is up is
/// cancelled: the look goes without its text rather than late.
final class Reading {
  let request = VNRecognizeTextRequest()
  let done = Waiter<[Line]>()

  init(_ image: CGImage, in frame: CGRect) {
    request.recognitionLevel = .fast
    request.usesLanguageCorrection = false
    // In the user's own languages, as Windows' OCR is. .fast has recognizers
    // for Latin scripts only, and on a Japanese or Russian window it makes
    // Latin junk of every label, which would go out as the window's text; so
    // a user who reads a language only .accurate has gets .accurate. It is
    // slower, and a read that runs past the budget goes without its lines.
    let preferred = Locale.preferredLanguages
    let fast = ocrLanguages(preferred, (try? request.supportedRecognitionLanguages()) ?? [])
    request.recognitionLevel = .accurate
    let accurate = ocrLanguages(preferred, (try? request.supportedRecognitionLanguages()) ?? [])
    if accurate.contains(where: { !fast.contains($0) }) {
      request.recognitionLanguages = accurate
    } else {
      request.recognitionLevel = .fast
      if !fast.isEmpty { request.recognitionLanguages = fast }
    }
    // Vision's default smallest text is a thirty-second of the picture's
    // height, made for photos; on a whole window that is most of its labels.
    // Anything from about 8 points up is read.
    request.minimumTextHeight = Float(max(0.004, min(0.03125, 8 / max(1, frame.height))))
    let req = request
    let done = self.done
    DispatchQueue.global(qos: .userInitiated).async {
      let handler = VNImageRequestHandler(cgImage: image, options: [:])
      do {
        try handler.perform([req])
        done.put(screenLines((req.results as [Any]?) ?? [], in: frame))
      } catch {
        done.put(nil)
      }
    }
  }
}

/// The picture as a JPEG no longer than `maxSide` on its long side: drawn on
/// white (a window's rounded corners are transparent, and a JPEG has no
/// alpha), in sRGB, which is what a vision model expects.
func jpeg(_ image: CGImage, maxSide: Int, quality: Double) -> (data: Data, width: Int, height: Int)? {
  let w0 = image.width, h0 = image.height
  guard w0 > 0, h0 > 0 else { return nil }
  let k = min(1, Double(maxSide) / Double(max(w0, h0)))
  let w = max(1, Int((Double(w0) * k).rounded()))
  let h = max(1, Int((Double(h0) * k).rounded()))
  guard let space = CGColorSpace(name: CGColorSpace.sRGB),
        let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
  ctx.interpolationQuality = .high
  ctx.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
  ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
  ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
  guard let small = ctx.makeImage() else { return nil }
  for q in [quality, min(quality, 0.5)] {
    let data = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(data as CFMutableData, "public.jpeg" as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(dest, small, [kCGImageDestinationLossyCompressionQuality as String: q] as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { return nil }
    if data.length <= jpegMaxBytes { return (data: data as Data, width: w, height: h) }
  }
  return nil
}

func clampDouble(_ v: Any?, _ lo: Double, _ hi: Double, _ fallback: Double) -> Double {
  guard let n = v as? NSNumber else { return fallback }
  let d = n.doubleValue
  return d.isFinite ? max(lo, min(hi, d)) : fallback
}

/// The focused window: its frame and title, the lines of text in it with
/// where each one is, and a JPEG of it, as far as `budgetMs` allows.
func look(_ req: [String: Any], _ deadline: DispatchTime) -> Reply {
  let started = DispatchTime.now()
  let stopAt = min(deadline - .milliseconds(120), started + .milliseconds(clampInt(req["budgetMs"], 50, 8000, 1500)))
  let maxSide = clampInt(req["maxSide"], 64, 4096, 1600)
  let quality = clampDouble(req["quality"], 0.3, 0.95, 0.82)
  let wantText = (req["ocr"] as? Bool) ?? true
  let wantImage = (req["image"] as? Bool) ?? true
  // Checked, never asked for: CGRequestScreenCaptureAccess, or a capture
  // without the permission, would put macOS's prompt up from here.
  guard CGPreflightScreenCaptureAccess() else { return fail("no_screen_permission") }
  guard let front = frontApp() else { return fail("no_app") }
  let pid = front.processIdentifier
  guard let win = lookWindow(pid) else { return fail("no_window") }

  var lines: [J] = []
  var image = J.null
  if wantText || wantImage {
    let picture: CGImage
    switch capture(win, until: stopAt) {
    case .image(let i): picture = i
    case .failed(let error): return fail(error)
    }
    let reading = wantText ? Reading(picture, in: win.frame) : nil
    if wantImage, let j = jpeg(picture, maxSide: maxSide, quality: quality) {
      image = .obj([("mime", .str("image/jpeg")), ("data", .plain(j.data.base64EncodedString())),
                    ("width", .int(j.width)), ("height", .int(j.height))])
    }
    if let text = reading {
      // The text gets the rest of the budget, and a moment more when the
      // capture used it up, as long as the answer still beats the deadline.
      let until = max(stopAt, min(deadline - .milliseconds(100), DispatchTime.now() + .milliseconds(150)))
      let (found, late) = text.done.take(by: until)
      if late { text.request.cancel() }
      lines = (found ?? []).map { $0.json }
    }
  }

  var appInfo: Reply = [("name", .str(front.localizedName ?? "")), ("pid", .int(Int(pid)))]
  if let b = front.bundleIdentifier { appInfo.append(("bundleId", .str(b))) }
  let ms = Int((DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1_000_000)
  var r = ok()
  r.append(("app", .obj(appInfo)))
  r.append(("window", .obj([("frame", frameJ(win.frame)), ("title", .str(win.title))])))
  r.append(("scale", .str("points")))
  r.append(("lines", .arr(lines)))
  r.append(("titleFrames", .arr(win.titleBand.map { [frameJ($0)] } ?? [])))
  r.append(("image", image))
  r.append(("ms", .int(ms)))
  return r
}

// MARK: - Where the caret is
//
// For the peek (Blip over the text box while the user dictates): where the
// text cursor is and where its box is, in the same global top-left points as
// a snapshot's frames. Positions are all it reads. Not the field's value, not
// its selection's text, not a window's title: the answer has no text in it but
// the app's name. It runs on caretQueue, and every message it sends gives up
// in the time the caret has left, so an app that has stopped answering costs
// one peek, not the helper.

/// What a caret read asks of the focused element, in one message.
let caretAttrNames = ["AXRole", "AXSubrole", "AXPosition", "AXSize", "AXSelectedTextRange", "AXParent"]
let caretAttrList = caretAttrNames as CFArray
/// What it asks of that element's parent, to see whether a scroll view cuts it.
let boxAttrNames = ["AXRole", "AXPosition", "AXSize"]
let boxAttrList = boxAttrNames as CFArray

/// How long one message of a caret read may take: the usual quarter second,
/// or what is left before `stopAt` when that is less (never under 20 ms).
/// Never given to the system-wide element: a timeout set on that one is set
/// for every element this process messages.
func caretTimeout(_ stopAt: DispatchTime) -> Float {
  return max(0.02, min(messageTimeout, Float(msLeft(stopAt)) / 1000))
}

/// AXBoundsForRange for `length` characters at `location`: global top-left
/// points, like AXPosition. No rect when the app cannot say; `busy` when it
/// did not answer in time, which is not the same as having nothing to say.
func boundsFor(_ el: AXUIElement, location: Int, length: Int, timeout: Float) -> (rect: CGRect?, busy: Bool) {
  var range = CFRange(location: location, length: length)
  guard let param = AXValueCreate(.cfRange, &range) else { return (nil, false) }
  var out: CFTypeRef?
  let err = AXUIElementCopyParameterizedAttributeValue(timed(el, timeout), "AXBoundsForRange" as CFString, param, &out)
  if err == .cannotComplete { return (nil, true) }
  guard err == .success, let v = axValue(out), AXValueGetType(v) == .cgRect else { return (nil, false) }
  var r = CGRect.zero
  guard AXValueGetValue(v, .cgRect, &r), r.minX.isFinite, r.minY.isFinite, r.width.isFinite, r.height.isFinite else { return (nil, false) }
  return (r.standardized, false)
}

/// What a caret read found where the selection is: the bar and how it was
/// found; nothing, the app having no place for it; or no answer in time.
enum CaretFound {
  case bar(CGRect, String)
  case nothing
  /// The app was busy (it is, just after a paste lands in it) or the time
  /// ran out. Told apart from nothing: a field without its caret would move
  /// Blip from the caret to the field's corner and back on the next read.
  case cut
}

/// The caret at `location` as a bar 2 points wide. The range is asked as it
/// is, zero characters long, which most apps answer with the caret's own bar.
/// Where that has no height, or sits at the screen's corner (what some apps
/// answer for a range with nothing in it), the character after the caret is
/// asked for and its left edge taken; at the end of the text, where there is
/// none, the character before it and its right edge. A rectangle nowhere near
/// the element itself is a placeholder, not the caret.
func caretAt(_ el: AXUIElement, location: Int, near frame: CGRect?, until stopAt: DispatchTime) -> CaretFound {
  var cut = false
  func usable(_ got: (rect: CGRect?, busy: Bool)) -> CGRect? {
    if got.busy { cut = true }
    guard let r = got.rect, r.height > 0, r.height <= 2000, r.width <= 4000, !(r.minX == 0 && r.minY == 0) else { return nil }
    if let f = frame, f.width > 0, f.height > 0 {
      let bar = CGRect(x: r.minX, y: r.minY, width: max(1, r.width), height: r.height)
      if !f.insetBy(dx: -40, dy: -40).intersects(bar) { return nil }
    }
    return r
  }
  if let r = usable(boundsFor(el, location: location, length: 0, timeout: caretTimeout(stopAt))) {
    return .bar(CGRect(x: r.minX, y: r.minY, width: 2, height: r.height), "range")
  }
  guard msLeft(stopAt) > 0 else { return .cut }
  if let r = usable(boundsFor(el, location: location, length: 1, timeout: caretTimeout(stopAt))) {
    return .bar(CGRect(x: r.minX, y: r.minY, width: 2, height: r.height), "after")
  }
  guard location > 0 else { return cut ? .cut : .nothing }
  guard msLeft(stopAt) > 0 else { return .cut }
  if let r = usable(boundsFor(el, location: location - 1, length: 1, timeout: caretTimeout(stopAt))) {
    return .bar(CGRect(x: r.maxX, y: r.minY, width: 2, height: r.height), "before")
  }
  return cut ? .cut : .nothing
}

/// The roles that take text even where they keep no selection range to read.
/// Anything else with no range is no text box: a window, a list, a button,
/// or an Electron app whose tree is not built yet, which answers its window.
let caretTextRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox"]

/// The caret and its text box in the element with the keyboard, anywhere on
/// the screen (the system-wide focused element, not a snapshot's app). A
/// password field gives neither: Blip does not peek over one.
func caret(_ deadline: DispatchTime) -> Reply {
  let started = DispatchTime.now()
  let stopAt = deadline - .milliseconds(15)
  var ref: CFTypeRef?
  let err = AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), "AXFocusedUIElement" as CFString, &ref)
  if err == .apiDisabled { return fail("not_trusted") }
  if err == .cannotComplete { return fail("app_busy") }
  guard let el = element(ref) else { return fail("no_focus") }
  var pid: pid_t = 0
  if AXUIElementGetPid(el, &pid) != .success { pid = 0 }
  let running = pid > 0 ? NSRunningApplication(processIdentifier: pid) : nil
  let appInfo: Reply = [("name", .str(running?.localizedName ?? "")), ("pid", .int(Int(pid)))]
  func answer(_ bar: CGRect?, _ box: CGRect?, _ how: String) -> Reply {
    var r = ok()
    r.append(("caret", bar.map { frameJ($0) } ?? J.null))
    r.append(("field", box.map { frameJ($0) } ?? J.null))
    r.append(("app", .obj(appInfo)))
    r.append(("scale", .str("points")))
    // Which way the caret was found, for the logs: range, after, before,
    // none or secure.
    r.append(("how", .str(how)))
    r.append(("ms", .int(Int((DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1_000_000))))
    return r
  }

  let (got, v) = fetch(el, caretAttrList, count: caretAttrNames.count, timeout: caretTimeout(stopAt))
  if got == .cannotComplete { return fail("app_busy") }
  // The focus moved on between the two messages: no news, not "no field".
  if got == .invalidUIElement { return fail("no_focus") }
  if got != .success { return answer(nil, nil, "none") }
  let role = (v[0] as? String) ?? "", sub = (v[1] as? String) ?? ""
  if role == "AXSecureTextField" || sub == "AXSecureTextField" { return answer(nil, nil, "secure") }

  // Only a text box has a box: Blip at the corner of a window or a button
  // would be Blip where nobody is typing ("never shows where it cannot know
  // where the cursor is").
  var textRange: AXValue? = nil
  if let rv = axValue(v[4]), AXValueGetType(rv) == .cfRange { textRange = rv }
  if textRange == nil && !caretTextRoles.contains(role) { return answer(nil, nil, "none") }

  // The box: the element's own frame (a field in a web page is its own, not
  // the page's). A text view's frame is the whole of its text, however much
  // is scrolled out of sight, so where its parent is a scroll view the box is
  // the part that view shows: that is the box the user sees. A parent that
  // did not answer in time is no news, not an unclipped box: that would move
  // Blip to the top of the whole text and back.
  let own = frameOf(v[2], v[3]).flatMap { $0.width > 0 && $0.height > 0 ? $0 : nil }
  var box = own
  if let f = own, let parent = element(v[5]) {
    guard msLeft(stopAt) > 0 else { return fail("app_busy") }
    let (pe, pv) = fetch(parent, boxAttrList, count: boxAttrNames.count, timeout: caretTimeout(stopAt))
    if pe == .cannotComplete { return fail("app_busy") }
    if pe == .success, (pv[0] as? String) == "AXScrollArea", let pf = frameOf(pv[1], pv[2]) {
      let seen = f.intersection(pf)
      if !seen.isNull && seen.width > 0 && seen.height > 0 { box = seen }
    }
  }

  // The caret: where the selection starts, which is where the words land (a
  // selection is replaced by them). No selection range, no caret. An app too
  // busy to say where it is (it is, just after a paste) is no news either.
  var found: (bar: CGRect, how: String)? = nil
  if let rv = textRange {
    var range = CFRange(location: 0, length: 0)
    if AXValueGetValue(rv, .cfRange, &range), range.location >= 0, range.length >= 0 {
      guard msLeft(stopAt) > 0 else { return fail("app_busy") }
      switch caretAt(el, location: range.location, near: own, until: stopAt) {
      case .bar(let bar, let how): found = (bar, how)
      case .cut: return fail("app_busy")
      case .nothing: break
      }
    }
  }
  return answer(found?.bar, box, found?.how ?? "none")
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
  case "snapshot", "press", "click", "setValue", "focus", "scroll", "key", "caret":
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
  case "caret":
    return caret(deadline)
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
  let limit = clampInt(req["timeoutMs"], 100, 8000, cmd == "snapshot" ? 1500 : (cmd == "look" ? 2500 : (cmd == "caret" ? 250 : 1200)))
  // A moment before the caller gives up, so it hears "timeout" from here.
  let deadline = got + .milliseconds(limit - 40)
  out.watch(key, id, at: deadline)
  switch cmd {
  case "look":
    // Its own queue: the agent asks for a snapshot and a look at the same
    // moment, and the snapshot must not wait out a picture.
    lookQueue.async { performLook(key, id, req, deadline) }
  case "caret":
    // Its own queue too: it is asked every few hundred milliseconds while the
    // user dictates, and must neither wait behind a walk nor hold one up.
    caretQueue.async { performCaret(key, id, req, deadline) }
  default:
    DispatchQueue.main.async { perform(key, id, cmd, req, deadline) }
  }
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

/// A look, on lookQueue, in the order the looks came; the same rule as
/// perform's for one that waited out its time behind another.
func performLook(_ key: Int, _ id: J, _ req: [String: Any], _ deadline: DispatchTime) {
  if out.isAnswered(key) || DispatchTime.now() >= deadline - .milliseconds(30) { return }
  lookBusy.begin()
  let reply = look(req, deadline)
  lookBusy.end()
  out.answer(key, id, reply)
}

/// A caret read, on caretQueue, by run (it needs Accessibility like the
/// rest); the same rule as perform's for one that waited out its time.
func performCaret(_ key: Int, _ id: J, _ req: [String: Any], _ deadline: DispatchTime) {
  if out.isAnswered(key) || DispatchTime.now() >= deadline - .milliseconds(30) { return }
  caretBusy.begin()
  let reply = run("caret", req, deadline)
  caretBusy.end()
  out.answer(key, id, reply)
}

// MARK: - Main

// The default for every element this process messages; each is also given it
// (or actionTimeout) on its own before it is messaged.
_ = AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), messageTimeout)
// This process has no NSApplication, and ScreenCaptureKit expects the
// window-server connection one would have made: asking for the main display
// makes it, here on the main thread, before any look.
_ = CGMainDisplayID()

// stdin on its own thread; the commands run in order on the main thread,
// whose run loop also keeps NSWorkspace's idea of the front app current.
let reader = Thread {
  while let line = readLine(strippingNewline: true) {
    receive(line)
  }
  // stdin closed: the app is gone, or done with us. Finish what was asked
  // (a caret being read, a look being taken, then the main queue, which runs
  // in order), then go.
  caretQueue.sync {}
  lookQueue.sync {}
  DispatchQueue.main.async { exit(0) }
}
reader.start()

let stuckCheck = DispatchSource.makeTimerSource(queue: DispatchQueue.global())
stuckCheck.schedule(deadline: .now() + 1, repeating: 1.0)
stuckCheck.setEventHandler {
  // _exit, not exit: exit's cleanup waits on the very thread that is stuck.
  // Nothing is lost; every answer was written straight to the pipe.
  if busy.stuck() || lookBusy.stuck() || caretBusy.stuck() { _exit(3) }
}
stuckCheck.resume()

let keepAlive = Timer(timeInterval: 3600, repeats: true) { _ in }
RunLoop.main.add(keepAlive, forMode: .default)
RunLoop.main.run()
