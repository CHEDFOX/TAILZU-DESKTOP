// tzkey — the one key on a Mac when it is Fn (oneKey.js), macOS 13+.
//
// Fn is not a key to Electron's shortcuts, and the key hook (uiohook-napi)
// does not report it either: its macOS table maps kVK_Function to nothing.
// This helper watches it with a listen-only event tap and says what it does on
// stdout, one word a line:
//
//   ready   the tap is on
//   down    Fn (or the Globe key) went down
//   up      it came up
//   other   another key, a modifier, a click or the wheel while it was down:
//           a chord (Fn+←, Fn+Delete), not the one key
//
// It reads no key's character, keeps nothing and sends nothing anywhere: the
// only key it names is Fn, and it says "other" for everything else. It never
// changes or swallows an event (listen-only).
//
// It exits 3 when macOS will not let it listen (Accessibility or Input
// Monitoring, which the app asks for, not this helper), and 0 when stdin
// closes, i.e. with the app.
import ApplicationServices
import Foundation

signal(SIGPIPE, SIG_IGN)
setvbuf(stdout, nil, _IOLBF, 0)

func say(_ word: String) {
  FileHandle.standardOutput.write((word + "\n").data(using: .utf8)!)
}

// kVK_Function, and the Globe key's code on the keyboards that send its own.
let fnCodes: Set<Int64> = [63, 179]
var fnDown = false
var tapPort: CFMachPort? = nil

let callback: CGEventTapCallBack = { _, type, event, _ in
  switch type {
  case .tapDisabledByTimeout, .tapDisabledByUserInput:
    // macOS turns a slow tap off; on again, and a key held through it is let go.
    if let port = tapPort { CGEvent.tapEnable(tap: port, enable: true) }
    if fnDown { fnDown = false; say("up") }
  case .flagsChanged:
    let code = event.getIntegerValueField(.keyboardEventKeycode)
    if fnCodes.contains(code) {
      let on = event.flags.contains(.maskSecondaryFn)
      if on && !fnDown { fnDown = true; say("down") }
      else if !on && fnDown { fnDown = false; say("up") }
    } else if fnDown {
      say("other")
    }
  default:
    if fnDown { say("other") }
  }
  return Unmanaged.passUnretained(event)
}

let kinds: [CGEventType] = [.flagsChanged, .keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel]
let mask = kinds.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << CGEventMask($1.rawValue)) }

guard let port = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
                                   eventsOfInterest: mask, callback: callback, userInfo: nil) else {
  exit(3)
}
tapPort = port
let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
CGEvent.tapEnable(tap: port, enable: true)
say("ready")

// With the app: its end of stdin closes.
DispatchQueue.global(qos: .utility).async {
  while readLine(strippingNewline: true) != nil {}
  exit(0)
}
CFRunLoopRun()
