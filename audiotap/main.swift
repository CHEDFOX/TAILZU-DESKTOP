// audiotap — the computer's own sound, for Tailzu's note-taker (macOS 13+).
//
// Electron hears the microphone itself, but on a Mac it cannot hear what the
// computer is playing (a call's other voices). ScreenCaptureKit can. This
// helper asks it for the system audio only, and writes it to stdout as 16 kHz
// mono signed 16-bit little-endian PCM until stdin closes or it is killed.
// The main process forwards the bytes to the notes window (main.js).
//
// The first run makes macOS ask for "Screen & System Audio Recording". The
// helper captures no picture: the stream's video is two pixels a second and
// is never read.
//
// Exit codes: 0 asked to stop, 2 macOS older than 13, 3 not allowed or could
// not start, 4 the stream stopped, 5 stdout closed.
import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

let rate = 16_000.0

/// Write all of `data` to stdout, or exit: a closed pipe means nobody is listening.
func emit(_ samples: [Int16]) {
  samples.withUnsafeBytes { raw in
    var off = 0
    while off < raw.count {
      let n = write(1, raw.baseAddress!.advanced(by: off), raw.count - off)
      if n <= 0 { exit(5) }
      off += n
    }
  }
}

@available(macOS 13.0, *)
final class Tap: NSObject, SCStreamOutput, SCStreamDelegate {
  private var stream: SCStream?
  private let queue = DispatchQueue(label: "space.tailzu.audiotap")
  /// Leftover position for resampling when the stream's rate is not 16 kHz.
  private var phase = 0.0

  func start() async throws {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    guard let display = content.displays.first else {
      throw NSError(domain: "audiotap", code: 1, userInfo: [NSLocalizedDescriptionKey: "no display"])
    }
    // Everything the computer plays except Tailzu itself.
    let parent = getppid()
    let mine = content.applications.filter { $0.processID == parent }
    let filter = SCContentFilter(display: display, excludingApplications: mine, exceptingWindows: [])
    let cfg = SCStreamConfiguration()
    cfg.capturesAudio = true
    cfg.excludesCurrentProcessAudio = true
    cfg.sampleRate = Int(rate)
    cfg.channelCount = 1
    cfg.width = 2
    cfg.height = 2
    cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)
    cfg.queueDepth = 3
    let s = SCStream(filter: filter, configuration: cfg, delegate: self)
    try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
    try await s.startCapture()
    stream = s
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .audio, CMSampleBufferIsValid(sb), CMSampleBufferDataIsReady(sb),
          let desc = CMSampleBufferGetFormatDescription(sb),
          let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(desc) else { return }
    var asbd = asbdPtr.pointee
    let frames = CMSampleBufferGetNumSamples(sb)
    guard frames > 0, let format = AVAudioFormat(streamDescription: &asbd),
          let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)) else { return }
    pcm.frameLength = AVAudioFrameCount(frames)
    let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(
      sb, at: 0, frameCount: Int32(frames), into: pcm.mutableAudioBufferList)
    guard status == noErr, let ch = pcm.floatChannelData else { return }
    let channels = Int(format.channelCount)
    let n = Int(pcm.frameLength)
    // Down to one channel.
    var mono = [Float](repeating: 0, count: n)
    for c in 0..<channels {
      let p = ch[c]
      for i in 0..<n { mono[i] += p[i] }
    }
    if channels > 1 { for i in 0..<n { mono[i] /= Float(channels) } }
    // To 16 kHz if the stream came at another rate (it is asked for 16 kHz).
    let src = format.sampleRate
    var out: [Int16] = []
    if abs(src - rate) < 1 {
      out.reserveCapacity(n)
      for v in mono { out.append(Int16(max(-1, min(1, v)) * 32767)) }
    } else {
      let step = src / rate
      while phase < Double(n) {
        let i = Int(phase)
        let f = Float(phase - Double(i))
        let a = mono[i], b = i + 1 < n ? mono[i + 1] : a
        out.append(Int16(max(-1, min(1, a + (b - a) * f)) * 32767))
        phase += step
      }
      phase -= Double(n)
    }
    if !out.isEmpty { emit(out) }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    FileHandle.standardError.write("audiotap: stopped: \(error.localizedDescription)\n".data(using: .utf8)!)
    exit(4)
  }
}

signal(SIGPIPE, SIG_IGN)

guard #available(macOS 13.0, *) else {
  FileHandle.standardError.write("audiotap: needs macOS 13 or later\n".data(using: .utf8)!)
  exit(2)
}

let tap = Tap()
Task {
  do {
    try await tap.start()
  } catch {
    FileHandle.standardError.write("audiotap: \(error.localizedDescription)\n".data(using: .utf8)!)
    exit(3)
  }
}

// Stop when the app closes our stdin (or dies).
DispatchQueue.global().async {
  _ = FileHandle.standardInput.readDataToEndOfFile()
  exit(0)
}

dispatchMain()
