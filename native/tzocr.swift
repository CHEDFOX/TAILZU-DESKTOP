// tzocr — on-device OCR for the desktop app's screen read (screenRead.js).
//
// Reads a PNG whose path is argv[1] and prints the text the macOS Vision
// framework recognizes in it, one line per recognized line, top to bottom.
// The image is read into text HERE, on the machine; nothing leaves. Built
// and signed with the app (build.yml, electron-builder extraResources), the
// way the audiotap helper is.
//
// No arguments, an unreadable file, or no text: it prints nothing and exits
// 0, so the caller simply gets no screen text and the mic carries on.
import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count > 1 else { exit(0) }
let path = CommandLine.arguments[1]
guard let image = NSImage(contentsOfFile: path),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { exit(0) }

var lines: [(y: CGFloat, x: CGFloat, text: String)] = []
let request = VNRecognizeTextRequest { (req, _) in
  guard let results = req.results as? [VNRecognizedTextObservation] else { return }
  for obs in results {
    guard let best = obs.topCandidates(1).first else { continue }
    let box = obs.boundingBox   // normalized, origin bottom-left
    lines.append((y: box.origin.y, x: box.origin.x, text: best.string))
  }
}
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: cg, options: [:])
try? handler.perform([request])

// Top of the window first (higher y), then left to right: reading order.
lines.sort { $0.y != $1.y ? $0.y > $1.y : $0.x < $1.x }
var out = ""
for line in lines { out += line.text + "\n" }
FileHandle.standardOutput.write(out.data(using: .utf8) ?? Data())
