# THE WINDOWS HALF OF "ASK": one long-lived PowerShell that reads the app in
# front through UI Automation and acts on it through Win32, answering one JSON
# line per question. It is its OWN process, never the one frontApp.js keeps for
# dictation — Ask asks far more, and far bigger questions, and must never make
# a dictation press wait behind a whole-window walk.
#
# The protocol, one JSON object per line each way:
#   in   {"id":n,"cmd":"snapshot","max":250}
#   out  {"id":n,"ok":true,"app":{...},"elements":[...], ...}
# Every line is answered, in the order asked, even when UI Automation throws;
# a line that is not JSON is answered {"ok":false,"error":"malformed"}. The
# exceptions to the order are "look" (the window's pixels and the text in them)
# and "caret" (where the text cursor is, for the peek while the user
# dictates), each answered by its own threads when it is done, so the snapshot
# asked at the same moment is not kept waiting behind them; the driver matches
# answers by id, so the order was never what it relied on. The
# conventions (an Add-Type C# block for Win32, $ErrorActionPreference, UTF-8
# output, run as command text with -EncodedCommand and windowsHide by the Node
# side) mirror frontApp.js's PowerShell, so the two read the same to anyone who
# knows one. It is too big to encode whole, so uiaDriver.js encodes a one-line
# loader that reads this file and dot-sources it: command text is not subject
# to the execution policy, which Group Policy can set where -ExecutionPolicy
# Bypass cannot reach, and an unsigned -File would then never start.
#
# The Add-Type C# is compiled by the .NET Framework's own compiler under
# Windows PowerShell 5.1, so it stays C# 5: no $"" strings, no => members, no
# out var, no tuples.

$ErrorActionPreference = 'SilentlyContinue'

# WIN32 FOR THE THINGS UI AUTOMATION CANNOT DO: the foreground window and its
# process, a real mouse click and wheel (SendInput, so it is indistinguishable
# from the user's own), and whether a window is elevated (a non-elevated
# process cannot drive an elevated one — UIPI drops the input silently, so we
# refuse up front and say why rather than appear to succeed and do nothing).
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class TzAgent {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint to, bool fAttach);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint threadId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern short VkKeyScanEx(char ch, IntPtr hkl);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr proc, uint access, out IntPtr tok);
  [DllImport("advapi32.dll", SetLastError = true)] public static extern bool GetTokenInformation(IntPtr tok, int cls, out uint info, uint len, out uint ret);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, IntPtr title);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

  // Per-monitor DPI awareness, so the numbers UI Automation gives (physical
  // pixels) and the numbers SetCursorPos takes are the same numbers. Windows
  // PowerShell is not DPI aware, and an unaware process has its cursor
  // coordinates scaled: at 150% a click meant for one control lands half as
  // far again from the screen's corner, on another. Per-monitor v2 (-4,
  // Windows 10 1703 on) where there is one, the older system-wide awareness
  // where not. Returns which one took, for the ping.
  public static string MakeDpiAware() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return "per_monitor"; } catch (Exception) { }
    try { if (SetProcessDPIAware()) return "system"; } catch (Exception) { }
    return "unaware";
  }

  // The top-level window a window belongs to (GA_ROOT). A UWP app's content
  // is a CoreWindow child of its ApplicationFrameWindow, and an MDI document
  // a child of its frame; only the top-level one is ever "in front". Not
  // GA_ROOTOWNER: an owned dialog is its own top-level window.
  public static IntPtr TopLevel(IntPtr h) {
    if (h == IntPtr.Zero) return IntPtr.Zero;
    return GetAncestor(h, 2);
  }

  // The window's caption. GetWindowText on another process's window reads
  // the caption the window manager keeps, without sending the app a message,
  // so a hung app cannot stall the snapshot here.
  public static string WindowTitle(IntPtr h) {
    if (h == IntPtr.Zero) return "";
    StringBuilder sb = new StringBuilder(1024);
    GetWindowText(h, sb, sb.Capacity);
    return sb.ToString();
  }

  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion u; }

  const uint INPUT_MOUSE = 0;
  const uint INPUT_KEYBOARD = 1;
  const uint KEYEVENTF_KEYUP = 0x0002;
  const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
  const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  const uint MOUSEEVENTF_LEFTUP = 0x0004;
  const uint MOUSEEVENTF_WHEEL = 0x0800;
  const uint MOUSEEVENTF_HWHEEL = 0x1000;

  static int Size() { return Marshal.SizeOf(typeof(INPUT)); }

  // A real left click where the cursor is now. The move is the caller's: it
  // puts the cursor on the element's centre first, so this is a true click, and
  // restores nothing afterwards (the spec: this is a real click, not a feint).
  public static void Click() {
    INPUT[] ins = new INPUT[2];
    ins[0].type = INPUT_MOUSE; ins[0].u.mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
    ins[1].type = INPUT_MOUSE; ins[1].u.mi.dwFlags = MOUSEEVENTF_LEFTUP;
    SendInput(2, ins, Size());
  }
  public static void Wheel(int delta, bool horizontal) {
    INPUT[] ins = new INPUT[1];
    ins[0].type = INPUT_MOUSE;
    ins[0].u.mi.mouseData = (uint)delta;
    ins[0].u.mi.dwFlags = horizontal ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL;
    SendInput(1, ins, Size());
  }
  public static void Key(ushort vk, bool up, bool extended) {
    INPUT[] ins = new INPUT[1];
    ins[0].type = INPUT_KEYBOARD;
    ins[0].u.ki.wVk = vk;
    ins[0].u.ki.dwFlags = (up ? KEYEVENTF_KEYUP : 0) | (extended ? KEYEVENTF_EXTENDEDKEY : 0);
    SendInput(1, ins, Size());
  }

  // Bring a window to the front against the foreground lock: a synthetic Alt
  // tap, then borrow the current foreground thread's input queue with
  // AttachThreadInput so SetForegroundWindow is allowed. Returns whether the
  // target really ended up in front — the caller refuses to type if it did not.
  public static bool ForceForeground(IntPtr target) {
    if (target == IntPtr.Zero) return false;
    if (GetForegroundWindow() == target) return true;
    uint cur = GetCurrentThreadId();
    uint fgPid; uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out fgPid);
    uint tgtPid; uint tgtThread = GetWindowThreadProcessId(target, out tgtPid);
    keybd_event(0x12, 0, 0, IntPtr.Zero);
    keybd_event(0x12, 0, KEYEVENTF_KEYUP, IntPtr.Zero);
    bool a1 = AttachThreadInput(cur, fgThread, true);
    bool a2 = AttachThreadInput(cur, tgtThread, true);
    BringWindowToTop(target);
    SetForegroundWindow(target);
    ShowWindow(target, 5);
    if (a2) AttachThreadInput(cur, tgtThread, false);
    if (a1) AttachThreadInput(cur, fgThread, false);
    return GetForegroundWindow() == target;
  }

  // Elevation. SelfElevated / ProcElevated each return 1 (elevated), 0 (not),
  // or -1 (could not tell). A standard process cannot open the token of a
  // higher-integrity one, so -1 for the target, read together with a
  // definitely-unelevated self, is itself the tell.
  const uint TOKEN_QUERY = 0x0008;
  const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const int TokenElevation = 20;
  static int TokenElevated(IntPtr tok) {
    uint elev = 0, ret = 0;
    bool ok = GetTokenInformation(tok, TokenElevation, out elev, 4, out ret);
    return ok ? (elev != 0 ? 1 : 0) : -1;
  }
  public static int SelfElevated() {
    IntPtr tok;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, out tok)) return -1;
    int r = TokenElevated(tok); CloseHandle(tok); return r;
  }
  public static int ProcElevated(uint pid) {
    IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (h == IntPtr.Zero) return -1;
    IntPtr tok;
    if (!OpenProcessToken(h, TOKEN_QUERY, out tok)) { CloseHandle(h); return -1; }
    int r = TokenElevated(tok); CloseHandle(tok); CloseHandle(h); return r;
  }
}
'@

# DPI awareness first, before UI Automation loads and might make a window of
# its own: from here on rectangles, the cursor and SendInput all speak
# physical pixels, which is what the snapshot says it gives (scale 'pixels')
# and what ask.js converts to DIP for the guide's ring.
$script:dpi = 'unaware'
try { $script:dpi = [TzAgent]::MakeDpiAware() } catch {}

# UI Automation. If it will not load (a stripped Windows, say) snapshot and the
# element actions answer ok:false "no_uia", while ping, trusted, key, click,
# scroll and open — all Win32 — still work.
$uia = $false
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $AE = [System.Windows.Automation.AutomationElement]
  $AUTO = [System.Windows.Automation.Automation]
  $TS = [System.Windows.Automation.TreeScope]
  $VP = [System.Windows.Automation.ValuePattern]
  $IP = [System.Windows.Automation.InvokePattern]
  $TOG = [System.Windows.Automation.TogglePattern]
  $SIP = [System.Windows.Automation.SelectionItemPattern]
  $ECP = [System.Windows.Automation.ExpandCollapsePattern]
  $SCP = [System.Windows.Automation.ScrollPattern]
  $TXP = [System.Windows.Automation.TextPattern]
  $uia = $true
} catch {}

# PIXELS FOR "LOOK": the window in front, its own pixels (never the screen's),
# made into a JPEG for the picture path, and handed to Windows' own OCR for the
# text in it, each line where it is on screen. This is its own Add-Type, apart from
# TzAgent's, so that if System.Drawing will not load, the snapshot and every
# action still work and look alone answers "no_capture". The C# 5 rules above
# hold here too.
$script:lookReady = $false
try {
  Add-Type -ReferencedAssemblies System.Drawing -ErrorAction Stop -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
public static class TzShot {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);

  const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
  const uint PW_RENDERFULLCONTENT = 2;
  const int SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77, SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79;
  const int LINE_MAX = 120;

  // The window as it is drawn, in physical pixels (the helper is DPI aware),
  // clipped to the desktop: {x, y, w, h}, or null for a window that is
  // minimized or has nothing on screen. DWM's extended frame bounds rather
  // than GetWindowRect: on Windows 10 and 11 the window rect takes in an
  // invisible resize border several pixels wide on three sides, which would
  // come out as a fringe of whatever is behind, and a maximized window's rect
  // reaches past the screen's edge.
  public static int[] Frame(IntPtr h) {
    if (h == IntPtr.Zero || IsIconic(h)) return null;
    RECT r = new RECT();
    bool got = false;
    try { got = DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT))) == 0; } catch (Exception) { got = false; }
    if (!got || r.Right <= r.Left || r.Bottom <= r.Top) {
      if (!GetWindowRect(h, out r)) return null;
    }
    int left = r.Left, top = r.Top, right = r.Right, bottom = r.Bottom;
    int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN), vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    if (vw > 0 && vh > 0) {
      int vx = GetSystemMetrics(SM_XVIRTUALSCREEN), vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
      left = Math.Max(left, vx); top = Math.Max(top, vy);
      right = Math.Min(right, vx + vw); bottom = Math.Min(bottom, vy + vh);
    }
    if (right - left < 1 || bottom - top < 1) return null;
    return new int[] { left, top, right - left, bottom - top };
  }

  // The window's own pixels, exactly its frame f, or null when they cannot be
  // had within ms. PrintWindow, never a copy of the screen: whatever is over
  // the window (a toast with a code in it, another app's always-on-top
  // window, Tailzu's own card, pill and marks) is not in them, so it is never
  // read as the window's text or sent in its picture, which is what the Mac's
  // capture of the one window gives too. PW_RENDERFULLCONTENT has DWM draw
  // it, so a window drawn with DirectComposition (Chromium, Electron, the
  // XAML apps) comes out as it looks rather than black. It draws the whole
  // window rect, the invisible resize borders with it, so the frame is cut
  // out of that. A window that will not be drawn (an elevated one, one kept
  // out of captures) is not looked at: there is no falling back to the
  // screen, which would bring back everything over it.
  public static Bitmap Capture(IntPtr h, int[] f, int ms) {
    RECT wr;
    if (h == IntPtr.Zero || !GetWindowRect(h, out wr)) return null;
    int ww = wr.Right - wr.Left, wh = wr.Bottom - wr.Top;
    int cx = f[0] - wr.Left, cy = f[1] - wr.Top;
    // Moved or resized since its frame was read: the picture would not be
    // the frame the lines are measured against.
    if (ww < 1 || wh < 1 || cx < 0 || cy < 0 || cx + f[2] > ww || cy + f[3] > wh) return null;
    Bitmap whole = new Printing(h).Take(ms);
    if (whole == null) return null;
    try {
      // A window not made for this screen's DPI is drawn at its own, smaller
      // size, and Windows scales it only on the screen: scaled here the same
      // way, so the picture is what the user sees and the lines land on it.
      if (whole.Width != ww || whole.Height != wh) {
        Bitmap big = Resized(whole, ww, wh);
        whole.Dispose();
        whole = big;
      }
      Bitmap bmp = whole.Clone(new Rectangle(cx, cy, f[2], f[3]), PixelFormat.Format32bppArgb);
      if (Blank(bmp)) { bmp.Dispose(); return null; }
      return bmp;
    } finally {
      whole.Dispose();
    }
  }

  // PrintWindow on a thread of its own, waited for no longer than the look
  // can spare: an app that has stopped answering can hold it, and the look
  // then goes without a picture rather than late, its worker free for the
  // next one. A picture finished after that is thrown away by the thread.
  sealed class Printing {
    readonly IntPtr h;
    readonly object gate = new object();
    Bitmap done;
    bool late;

    public Printing(IntPtr h) { this.h = h; }

    void Run() {
      Bitmap bmp = null;
      bool ok = false;
      try {
        // The window measured in its own units, which are the ones it draws
        // in: this thread takes on the window's DPI awareness (it is this
        // thread's alone), so a window Windows scales for the screen is
        // measured at the size it is drawn at.
        try { SetThreadDpiAwarenessContext(GetWindowDpiAwarenessContext(h)); } catch (Exception) { }
        RECT r;
        if (!GetWindowRect(h, out r) || r.Right <= r.Left || r.Bottom <= r.Top) return;
        // No alpha: whatever PrintWindow leaves in a pixel's fourth byte is
        // never taken for transparency, which scaling would turn to black.
        bmp = new Bitmap(r.Right - r.Left, r.Bottom - r.Top, PixelFormat.Format32bppRgb);
        using (Graphics g = Graphics.FromImage(bmp)) {
          IntPtr hdc = g.GetHdc();
          try { ok = PrintWindow(h, hdc, PW_RENDERFULLCONTENT); } finally { g.ReleaseHdc(hdc); }
        }
      } catch (Exception) {
        ok = false;
      } finally {
        lock (gate) {
          if (ok && !late) { done = bmp; bmp = null; }
        }
        if (bmp != null) bmp.Dispose();
      }
    }

    public Bitmap Take(int ms) {
      Thread t = new Thread(Run);
      t.IsBackground = true;
      t.Start();
      t.Join(Math.Max(1, ms));
      lock (gate) {
        late = true;
        Bitmap b = done;
        done = null;
        return b;
      }
    }
  }

  // Whether every pixel is black, which is what PrintWindow draws for a
  // window it could not (one kept out of captures, some video and games). A
  // black picture is no picture: it is not read, nor sent to be described.
  static bool Blank(Bitmap bmp) {
    BitmapData d = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    try {
      int[] row = new int[bmp.Width];
      for (int y = 0; y < bmp.Height; y++) {
        Marshal.Copy(new IntPtr(d.Scan0.ToInt64() + (long)y * d.Stride), row, 0, row.Length);
        for (int x = 0; x < row.Length; x++) {
          if ((row[x] & 0xFFFFFF) != 0) return false;
        }
      }
      return true;
    } finally {
      bmp.UnlockBits(d);
    }
  }

  // A copy no longer than maxSide on its long side, or the same bitmap when it
  // already fits. Bicubic, because the picture path exists for what is small
  // and drawn (an equation, a chart's labels) and has to stay legible.
  public static Bitmap Fit(Bitmap src, int maxSide) {
    int w = src.Width, h = src.Height;
    int longest = Math.Max(w, h);
    if (maxSide <= 0 || longest <= maxSide) return src;
    double k = (double)maxSide / longest;
    return Resized(src, Math.Max(1, (int)Math.Round(w * k)), Math.Max(1, (int)Math.Round(h * k)));
  }

  // A copy of src drawn at nw x nh.
  static Bitmap Resized(Bitmap src, int nw, int nh) {
    int w = src.Width, h = src.Height;
    Bitmap dst = new Bitmap(nw, nh, PixelFormat.Format32bppArgb);
    try {
      using (Graphics g = Graphics.FromImage(dst))
      using (ImageAttributes edges = new ImageAttributes()) {
        g.CompositingMode = CompositingMode.SourceCopy;
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        // Without it the filter reads past the edge and draws a dark rim.
        edges.SetWrapMode(WrapMode.TileFlipXY);
        g.DrawImage(src, new Rectangle(0, 0, nw, nh), 0, 0, w, h, GraphicsUnit.Pixel, edges);
      }
    } catch (Exception) {
      dst.Dispose();
      throw;
    }
    return dst;
  }

  static ImageCodecInfo jpegCodec;
  static ImageCodecInfo JpegCodec() {
    if (jpegCodec == null) {
      foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders()) {
        if (c.FormatID == ImageFormat.Jpeg.Guid) { jpegCodec = c; break; }
      }
    }
    return jpegCodec;
  }

  // The bitmap as a JPEG at the given quality (1..100), base64, or null when
  // this Windows has no JPEG encoder.
  public static string Jpeg(Bitmap bmp, int quality) {
    ImageCodecInfo codec = JpegCodec();
    if (codec == null) return null;
    using (MemoryStream ms = new MemoryStream())
    using (EncoderParameters ps = new EncoderParameters(1)) {
      ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)Math.Max(1, Math.Min(100, quality)));
      bmp.Save(ms, codec, ps);
      return Convert.ToBase64String(ms.GetBuffer(), 0, (int)ms.Length);
    }
  }

  // The bitmap as a BMP in memory, for the OCR's decoder: a BMP is a straight
  // copy of the pixels, where a PNG would spend a hundred milliseconds on
  // compression that is thrown away a moment later.
  public static MemoryStream Bmp(Bitmap bmp) {
    MemoryStream ms = new MemoryStream();
    try { bmp.Save(ms, ImageFormat.Bmp); } catch (Exception) { ms.Dispose(); throw; }
    ms.Position = 0;
    return ms;
  }

  // A JSON string, quoted. The answer is put together here rather than with
  // ConvertTo-Json: a few hundred lines through the cmdlet one by one take
  // longer than the OCR did, and Windows PowerShell's encoder turns a wrapped
  // array into {"value":[...],"Count":n}.
  public static string Json(string s) {
    if (s == null) return "\"\"";
    StringBuilder sb = new StringBuilder(s.Length + 8);
    sb.Append('"');
    foreach (char c in s) {
      switch (c) {
        case '"': sb.Append("\\\""); break;
        case '\\': sb.Append("\\\\"); break;
        case '\n': sb.Append("\\n"); break;
        case '\r': sb.Append("\\r"); break;
        case '\t': sb.Append("\\t"); break;
        default:
          if (c < ' ' || c == '\u2028' || c == '\u2029') sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
          else sb.Append(c);
          break;
      }
    }
    sb.Append('"');
    return sb.ToString();
  }

  static readonly Regex Space = new Regex("\\s+");

  // Whitespace collapsed and trimmed, at most max characters, never cut
  // between the two halves of a surrogate pair.
  public static string Clean(string s, int max) {
    if (string.IsNullOrEmpty(s)) return "";
    string t = Space.Replace(s, " ").Trim();
    if (t.Length > max) {
      int n = max;
      if (n > 0 && char.IsHighSurrogate(t[n - 1])) n--;
      t = t.Substring(0, n);
    }
    return t;
  }

  // Text as it is compared with the window's title: case and spaces do not
  // count, nor the ellipsis an app puts where it cut a title short, nor which
  // dash or quote mark it was read with: OCR reads the em dash in a title
  // ("Report - Word" for "Report", em dash, "Word") as a hyphen, a curly
  // quote as a straight one, and a title read so was let through as a line
  // (agent.js textKey, the same rule).
  public static string Key(string s) {
    if (string.IsNullOrEmpty(s)) return "";
    StringBuilder sb = new StringBuilder(s.Length);
    foreach (char ch in s) {
      if (char.IsWhiteSpace(ch)) continue;
      char c = ch;
      if ((c >= '\u2010' && c <= '\u2015') || c == '\u2212') c = '-';
      else if (c == '\u2018' || c == '\u2019' || c == '\u201a' || c == '\u201b' || c == '\u2032') c = '\'';
      else if ((c >= '\u201c' && c <= '\u201f') || c == '\u2033') c = '"';
      sb.Append(char.ToLowerInvariant(c));
    }
    string k = sb.ToString();
    if (k.EndsWith("\u2026", StringComparison.Ordinal)) k = k.Substring(0, k.Length - 1);
    else if (k.EndsWith("...", StringComparison.Ordinal)) k = k.Substring(0, k.Length - 3);
    return k;
  }

  // Whether an OCR line is the window's title drawn in its title bar or tab:
  // the whole of it, a piece of it (cut short), or a line that has it inside
  // (the title read as one line with the buttons beside it). The title never
  // leaves the computer, and it is caught here, against the whole of it,
  // because the device sees it capped at 200 characters and would miss a long
  // one, or one read together with what is beside it.
  public static bool IsTitle(string text, string titleKey) {
    if (string.IsNullOrEmpty(titleKey)) return false;
    string k = Key(text);
    if (k.Length == 0) return false;
    if (k == titleKey) return true;
    if (k.Length >= 8 && titleKey.IndexOf(k, StringComparison.Ordinal) >= 0) return true;
    return titleKey.Length >= 8 && k.IndexOf(titleKey, StringComparison.Ordinal) >= 0;
  }

  static string N(long v) { return v.ToString(CultureInfo.InvariantCulture); }

  // The band at the top of the window that is its title bar (and a classic
  // menu bar under it): from the frame's top down to where the client area
  // starts, as JSON [x,y,w,h] in the frame's units, or null when the client
  // area starts at the top (an app that draws its own title bar: Chromium,
  // Office, the Store apps), or the band is not a title bar's size. The title
  // is drawn there, and the device cuts the picture below it (agent.js
  // chromeBottom) even when the OCR did not read it, or did not run.
  public static string TitleBand(IntPtr h, int[] f) {
    if (h == IntPtr.Zero || f == null || f.Length != 4) return null;
    POINT p = new POINT();
    try { if (!ClientToScreen(h, ref p)) return null; } catch (Exception) { return null; }
    int band = p.Y - f[1];
    if (band < 1 || band > f[3] / 4) return null;
    return "[" + N(f[0]) + "," + N(f[1]) + "," + N(f[2]) + "," + N(band) + "]";
  }

  // An OCR line's box alone, no text, as JSON [x,y,w,h] on the screen (the
  // same transform as Line), or null for one with no size: where a line that
  // is the window's title was, for the device to cut the picture below it.
  public static string Box(double x0, double y0, double x1, double y1, double k, int dx, int dy) {
    if (!(x1 > x0) || !(y1 > y0)) return null;
    long l = (long)Math.Round(x0 * k) + dx, tp = (long)Math.Round(y0 * k) + dy;
    long rt = (long)Math.Round(x1 * k) + dx, b = (long)Math.Round(y1 * k) + dy;
    return "[" + N(l) + "," + N(tp) + "," + N(Math.Max(1, rt - l)) + "," + N(Math.Max(1, b - tp)) + "]";
  }

  // One OCR line as the device gets it, or null for one with no text or no
  // size: its text, and the box around its words (x0,y0 to x1,y1 in the
  // picture the engine read), scaled by k back to the capture's pixels and
  // moved by dx,dy from the window's corner to the screen's.
  public static string Line(string text, double x0, double y0, double x1, double y1, double k, int dx, int dy) {
    string t = Clean(text, LINE_MAX);
    if (t.Length == 0 || !(x1 > x0) || !(y1 > y0)) return null;
    long l = (long)Math.Round(x0 * k) + dx, tp = (long)Math.Round(y0 * k) + dy;
    long rt = (long)Math.Round(x1 * k) + dx, b = (long)Math.Round(y1 * k) + dy;
    return "{\"text\":" + Json(t) + ",\"frame\":[" + N(l) + "," + N(tp) + "," + N(Math.Max(1, rt - l)) + "," + N(Math.Max(1, b - tp)) + "]}";
  }

  // The whole answer, one line. idJson is the request's id as JSON already.
  // titleFrames: where the title is drawn (TitleBand, Box), frames only.
  public static string Reply(string idJson, int[] frame, string title, string[] lines, string[] titleFrames, string jpeg, int width, int height, string ocr, long ms) {
    StringBuilder sb = new StringBuilder(512 + (jpeg == null ? 0 : jpeg.Length));
    sb.Append("{\"id\":").Append(string.IsNullOrEmpty(idJson) ? "null" : idJson);
    sb.Append(",\"ok\":true,\"window\":{\"frame\":[");
    for (int i = 0; i < 4; i++) { if (i > 0) sb.Append(','); sb.Append(N(frame[i])); }
    sb.Append("],\"title\":").Append(Json(title)).Append("},\"scale\":\"pixels\",\"lines\":[");
    bool first = true;
    if (lines != null) {
      foreach (string l in lines) {
        if (string.IsNullOrEmpty(l)) continue;
        if (!first) sb.Append(',');
        sb.Append(l);
        first = false;
      }
    }
    sb.Append("],\"titleFrames\":[");
    first = true;
    int boxes = 0;
    if (titleFrames != null) {
      foreach (string t in titleFrames) {
        if (string.IsNullOrEmpty(t) || boxes >= 8) continue;
        if (!first) sb.Append(',');
        sb.Append(t);
        first = false;
        boxes++;
      }
    }
    sb.Append("],\"image\":");
    if (string.IsNullOrEmpty(jpeg)) sb.Append("null");
    else sb.Append("{\"mime\":\"image/jpeg\",\"data\":\"").Append(jpeg).Append("\",\"width\":").Append(N(width)).Append(",\"height\":").Append(N(height)).Append('}');
    sb.Append(",\"ocr\":").Append(Json(ocr)).Append(",\"ms\":").Append(N(ms)).Append('}');
    return sb.ToString();
  }

  public static string Fail(string idJson, string error) {
    return "{\"id\":" + (string.IsNullOrEmpty(idJson) ? "null" : idJson) + ",\"ok\":false,\"error\":" + Json(error) + "}";
  }

  // One whole line under the console writer's own lock. The reader loop
  // answers other commands on its thread while a look is being made on
  // another, and two answers must never run into one line.
  public static void Send(string line) {
    TextWriter o = Console.Out;
    lock (o) { o.WriteLine(line); o.Flush(); }
  }
}
'@
  $script:lookReady = $true
} catch {}

# THE CARET FOR THE PEEK: where the text cursor and its box are, for Blip to
# peek over the box while the user dictates (peek-spec §A), in the snapshot's
# physical pixels. Two rectangles and nothing else: no text is read, not the
# field's, not its selection's. Its own Add-Type, apart from TzAgent's and
# TzShot's, so that if it will not compile every other command still works and
# caret alone answers "no_caret". The C# 5 rules above hold here too.
#
# The caret comes from UI Automation's COM interface, because the managed one
# this script uses elsewhere (System.Windows.Automation) predates TextPattern2
# and has no GetCaretRange. Only the slots it calls are typed; the ones before
# them are kept as placeholders so each method lands on its slot of the
# vtable (UIAutomationClient.idl's order), and none of them is ever called.
$script:caretReady = $false
try {
  Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class TzCaret {
  [ComImport, Guid("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IAutomation {
    // CompareElements, CompareRuntimeIds, GetRootElement, ElementFromHandle, ElementFromPoint
    void Gap1(); void Gap2(); void Gap3(); void Gap4(); void Gap5();
    IElement GetFocusedElement();
  }

  [ComImport, Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IElement {
    // SetFocus, GetRuntimeId, FindFirst, FindAll, FindFirstBuildCache, FindAllBuildCache, BuildUpdatedCache
    void Gap1(); void Gap2(); void Gap3(); void Gap4(); void Gap5(); void Gap6(); void Gap7();
    [return: MarshalAs(UnmanagedType.Struct)] object GetCurrentPropertyValue(int propertyId);
    // GetCurrentPropertyValueEx, GetCachedPropertyValue, GetCachedPropertyValueEx, GetCurrentPatternAs, GetCachedPatternAs
    void Gap9(); void Gap10(); void Gap11(); void Gap12(); void Gap13();
    [return: MarshalAs(UnmanagedType.IUnknown)] object GetCurrentPattern(int patternId);
  }

  [ComImport, Guid("32eba289-3583-42c9-9c59-3b6d9a1e9b6a"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface ITextPattern {
    // RangeFromPoint, RangeFromChild
    void Gap1(); void Gap2();
    IRangeArray GetSelection();
  }

  [ComImport, Guid("506a921a-fcc9-409f-b23b-37eb74106872"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface ITextPattern2 {
    // TextPattern's six (RangeFromPoint, RangeFromChild, GetSelection,
    // GetVisibleRanges, DocumentRange, SupportedTextSelection), then RangeFromAnnotation
    void Gap1(); void Gap2(); void Gap3(); void Gap4(); void Gap5(); void Gap6(); void Gap7();
    IRange GetCaretRange(out int isActive);
  }

  [ComImport, Guid("ce4ae76a-e717-4c98-81ea-47371d028eb6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IRangeArray {
    int Length { get; }
    IRange GetElement(int index);
  }

  [ComImport, Guid("a543cc6a-f4ae-494b-8239-c814481187a8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IRange {
    IRange Clone();
    // Compare
    void Gap2();
    int CompareEndpoints(int srcEndPoint, IRange range, int targetEndPoint);
    void ExpandToEnclosingUnit(int unit);
    // FindAttribute, FindText, GetAttributeValue
    void Gap5(); void Gap6(); void Gap7();
    [return: MarshalAs(UnmanagedType.SafeArray, SafeArraySubType = VarEnum.VT_R8)] double[] GetBoundingRectangles();
    // GetEnclosingElement, the range's words (never read here), Move, MoveEndpointByUnit
    void Gap9(); void Gap10(); void Gap11(); void Gap12();
    void MoveEndpointByRange(int srcEndPoint, IRange range, int targetEndPoint);
  }

  const int TextPatternId = 10014;
  const int TextPattern2Id = 10024;
  const int BoundingRectangleId = 30001;
  const int IsPasswordId = 30019;
  const int EndpointStart = 0;
  const int EndpointEnd = 1;
  const int UnitCharacter = 0;
  const int ES_PASSWORD = 0x20;
  const int GWL_STYLE = -16;

  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] struct GUITHREADINFO {
    public int cbSize; public uint flags;
    public IntPtr hwndActive; public IntPtr hwndFocus; public IntPtr hwndCapture; public IntPtr hwndMenuOwner; public IntPtr hwndMoveSize; public IntPtr hwndCaret;
    public RECT rcCaret;
  }
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO info);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] static extern bool LogicalToPhysicalPointForPerMonitorDPI(IntPtr h, ref POINT p);

  // One read at a time. A read whose app has stopped answering can sit in UI
  // Automation for seconds (its own timeouts are long); until it comes back,
  // a new one answers "busy" at once rather than pile up a thread a peek.
  static int busy;
  static IAutomation automation;
  static readonly object automationGate = new object();

  // The client, made once and kept: the read threads are all MTA, where it can
  // be called from any of them. One that has gone bad is made again.
  static IAutomation Automation() {
    lock (automationGate) {
      if (automation == null) automation = (IAutomation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("ff48dba4-60ef-4201-aa87-54103eef594e"), true));
      return automation;
    }
  }
  static void Forget() { lock (automationGate) { automation = null; } }

  // Start a read, whose threads answer the line: null. Otherwise the error
  // for the loop to answer it with, "busy" when a read is still out.
  public static string Begin(string idJson, string appJson, int ms) {
    if (Interlocked.CompareExchange(ref busy, 1, 0) != 0) return "busy";
    try {
      new Read(idJson, appJson).Start(Math.Max(1, ms));
      return null;
    } catch (Exception) {
      // No watchdog could be made, so nothing will answer it but the loop.
      Interlocked.Exchange(ref busy, 0);
      return "exception";
    }
  }

  // One read: the work on a thread of its own, and a watchdog that answers
  // "timeout" when the time is up first. Whichever comes first answers; the
  // other finds it answered and says nothing.
  sealed class Read {
    readonly string idJson;
    readonly string appJson;
    readonly object gate = new object();
    // When it began, for the answer's ms; TickCount, as nothing here needs
    // more than mscorlib (unchecked: the difference is right across its wrap).
    readonly int began = Environment.TickCount;
    bool answered;
    Timer watchdog;

    public Read(string idJson, string appJson) { this.idJson = idJson; this.appJson = appJson; }

    public void Start(int ms) {
      watchdog = new Timer(new TimerCallback(Late), null, ms, Timeout.Infinite);
      bool started = false;
      try {
        Thread t = new Thread(new ThreadStart(Work));
        t.IsBackground = true;
        // MTA, which a new thread is anyway, said so: the client is shared
        // between the reads' threads. Best effort, as where there are no
        // apartments the call itself throws.
        try { t.SetApartmentState(ApartmentState.MTA); } catch (Exception) { }
        t.Start();
        started = true;
      } catch (Exception) {
        started = false;
      }
      if (!started) {
        Interlocked.Exchange(ref busy, 0);
        Answer(Fail(idJson, "exception"));
      }
    }

    void Late(object state) { Answer(Fail(idJson, "timeout")); }

    void Answer(string line) {
      lock (gate) {
        if (answered) return;
        answered = true;
      }
      try { watchdog.Dispose(); } catch (Exception) { }
      Send(line);
    }

    void Work() {
      string line;
      Held held = new Held();
      try {
        int[] caret = null;
        int[] field = null;
        string how = "none";
        bool secure = false;
        bool uia = false;
        bool text = false;
        IElement el = null;
        try { el = held.Keep(Automation().GetFocusedElement()); } catch (InvalidComObjectException) { Forget(); el = null; } catch (Exception) { el = null; }
        if (el != null) {
          uia = true;
          object pw = Property(el, IsPasswordId);
          if (pw is bool && (bool)pw) {
            secure = true;
          } else {
            field = Box(Property(el, BoundingRectangleId), false);
            caret = FromText(el, field, held, ref how, ref text);
          }
        }
        if (!secure && caret == null) {
          // No text pattern, or none that knew: the system caret, which
          // classic Win32 controls still draw.
          try {
            GUITHREADINFO g = new GUITHREADINFO();
            g.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
            if (GetGUIThreadInfo(0, ref g) && g.hwndCaret != IntPtr.Zero && g.rcCaret.Bottom > g.rcCaret.Top) {
              if (!uia && IsPasswordEdit(g.hwndCaret)) {
                secure = true;
              } else {
                POINT a = new POINT(); a.X = g.rcCaret.Left; a.Y = g.rcCaret.Top;
                POINT b = new POINT(); b.X = g.rcCaret.Right; b.Y = g.rcCaret.Bottom;
                if (ToScreen(g.hwndCaret, ref a) && ToScreen(g.hwndCaret, ref b) && b.Y > a.Y) {
                  int[] bar = new int[] { a.X, a.Y, 2, b.Y - a.Y };
                  if (Near(bar, field)) {
                    caret = bar;
                    how = "system";
                    RECT wr;
                    if (field == null && GetWindowRect(g.hwndCaret, out wr) && wr.Right > wr.Left && wr.Bottom > wr.Top) {
                      field = new int[] { wr.Left, wr.Top, wr.Right - wr.Left, wr.Bottom - wr.Top };
                    }
                  }
                }
              }
            }
          } catch (Exception) { }
        }
        // Only a text box has a box: one with no text pattern and no caret
        // is a window, a list or a button, and Blip at its corner would be
        // Blip where nobody is typing.
        if (!secure && caret == null && !text) field = null;
        long ms = unchecked(Environment.TickCount - began);
        line = secure ? Reply(idJson, null, null, appJson, "secure", ms)
                      : Reply(idJson, caret, field, appJson, how, ms);
      } catch (Exception) {
        line = Fail(idJson, "exception");
      } finally {
        held.Release();
        Interlocked.Exchange(ref busy, 0);
      }
      Answer(line);
    }
  }

  // The COM objects a read made, each released once when it is done: a peek
  // every few hundred milliseconds would otherwise keep the app's own objects
  // behind them alive until the collector happened by.
  sealed class Held {
    readonly System.Collections.Generic.List<object> all = new System.Collections.Generic.List<object>();
    public T Keep<T>(T o) where T : class {
      if (o != null && !all.Contains(o)) all.Add(o);
      return o;
    }
    public void Release() {
      foreach (object o in all) {
        try { if (Marshal.IsComObject(o)) Marshal.ReleaseComObject(o); } catch (Exception) { }
      }
      all.Clear();
    }
  }

  static object Property(IElement el, int id) {
    try { return el.GetCurrentPropertyValue(id); } catch (Exception) { return null; }
  }

  // [left, top, width, height] as whole pixels, from four doubles at `at`:
  // finite, inside a million either way, a size not negative and a height not
  // zero (a box needs a width too). Null for anything else.
  static int[] Box(object v, bool bar) {
    double[] d = v as double[];
    if (d == null) return null;
    return BoxAt(d, 0, bar);
  }
  static int[] BoxAt(double[] d, int at, bool bar) {
    if (d.Length < at + 4) return null;
    for (int i = at; i < at + 4; i++) {
      if (double.IsNaN(d[i]) || double.IsInfinity(d[i]) || Math.Abs(d[i]) > 1000000) return null;
    }
    if (d[at + 3] <= 0 || d[at + 2] < 0 || (!bar && d[at + 2] <= 0)) return null;
    return new int[] { (int)Math.Round(d[at]), (int)Math.Round(d[at + 1]), (int)Math.Round(d[at + 2]), Math.Max(1, (int)Math.Round(d[at + 3])) };
  }

  // A range's first rectangle with a height (a range gives one per line).
  static int[] First(IRange r) {
    double[] d = null;
    try { d = r.GetBoundingRectangles(); } catch (Exception) { d = null; }
    if (d == null) return null;
    for (int at = 0; at + 4 <= d.Length; at += 4) {
      int[] b = BoxAt(d, at, true);
      if (b != null) return b;
    }
    return null;
  }

  // A bar nowhere near the box it should be in is a placeholder, not the caret.
  static bool Near(int[] bar, int[] field) {
    if (bar == null) return false;
    if (field == null) return true;
    const int slack = 40;
    return bar[0] + Math.Max(1, bar[2]) >= field[0] - slack && bar[0] <= field[0] + field[2] + slack
      && bar[1] + bar[3] >= field[1] - slack && bar[1] <= field[1] + field[3] + slack;
  }

  // The caret as a bar 2 pixels wide: TextPattern2's caret range or, where
  // there is no TextPattern2, where TextPattern's selection starts (the words
  // replace a selection from there). A caret is zero characters wide and many
  // apps give it no rectangle; then a copy is widened to the character there
  // and its left edge taken, or its right edge when the character turned out
  // to be the one before (the caret at the very end of the text).
  // `text` is set when the element has either pattern: it takes text, so its
  // box is a text box even where neither could say where the caret is.
  static int[] FromText(IElement el, int[] field, Held held, ref string how, ref bool text) {
    IRange range = null;
    object p = null;
    try { p = held.Keep(el.GetCurrentPattern(TextPattern2Id)); } catch (Exception) { p = null; }
    ITextPattern2 tp2 = p as ITextPattern2;
    if (tp2 != null) {
      text = true;
      try {
        int active;
        range = held.Keep(tp2.GetCaretRange(out active));
      } catch (Exception) { range = null; }
      if (range != null) how = "caret";
    }
    if (range == null) {
      p = null;
      try { p = held.Keep(el.GetCurrentPattern(TextPatternId)); } catch (Exception) { p = null; }
      ITextPattern tp = p as ITextPattern;
      if (tp != null) {
        text = true;
        try {
          IRangeArray sel = held.Keep(tp.GetSelection());
          if (sel != null && sel.Length > 0) {
            range = held.Keep(sel.GetElement(0));
            if (range != null) {
              IRange start = held.Keep(range.Clone());
              range.MoveEndpointByRange(EndpointEnd, start, EndpointStart);
            }
          }
        } catch (Exception) { range = null; }
        if (range != null) how = "selection";
      }
    }
    if (range == null) return null;
    int[] bar = First(range);
    if (bar != null && Near(bar, field)) return new int[] { bar[0], bar[1], 2, bar[3] };
    try {
      IRange ch = held.Keep(range.Clone());
      ch.ExpandToEnclosingUnit(UnitCharacter);
      int[] c = First(ch);
      if (c == null) return null;
      bool before = false;
      try { before = ch.CompareEndpoints(EndpointStart, range, EndpointStart) < 0; } catch (Exception) { before = false; }
      int[] edge = new int[] { before ? c[0] + c[2] : c[0], c[1], 2, c[3] };
      if (!Near(edge, field)) return null;
      how = how + (before ? "+before" : "+char");
      return edge;
    } catch (Exception) {
      return null;
    }
  }

  // A classic password box, for when UI Automation could not say: an Edit or
  // a RichEdit with ES_PASSWORD.
  static bool IsPasswordEdit(IntPtr h) {
    try {
      StringBuilder sb = new StringBuilder(64);
      GetClassName(h, sb, sb.Capacity);
      string cls = sb.ToString();
      bool edit = string.Equals(cls, "Edit", StringComparison.OrdinalIgnoreCase) || cls.StartsWith("RichEdit", StringComparison.OrdinalIgnoreCase);
      return edit && (GetWindowLong(h, GWL_STYLE) & ES_PASSWORD) != 0;
    } catch (Exception) {
      return false;
    }
  }

  // The system caret's rectangle is in its window's client coordinates, in
  // that window's own units. An app Windows scales for the screen (one not
  // made for this DPI, which is just the kind of app that still draws a
  // system caret) keeps it in its own smaller ones, and turned to the screen
  // in this helper's physical pixels it would land short of the caret. So it
  // is turned to the screen in the window's units, then to physical pixels.
  // Where Windows has neither call (before 10 1607), the plain conversion.
  static bool ToScreen(IntPtr h, ref POINT p) {
    IntPtr old = IntPtr.Zero;
    try { old = SetThreadDpiAwarenessContext(GetWindowDpiAwarenessContext(h)); } catch (Exception) { old = IntPtr.Zero; }
    try {
      if (!ClientToScreen(h, ref p)) return false;
      if (old != IntPtr.Zero) {
        try { LogicalToPhysicalPointForPerMonitorDPI(h, ref p); } catch (Exception) { }
      }
      return true;
    } finally {
      if (old != IntPtr.Zero) {
        try { SetThreadDpiAwarenessContext(old); } catch (Exception) { }
      }
    }
  }

  static string N(long v) { return v.ToString(CultureInfo.InvariantCulture); }

  static void Frame(StringBuilder sb, int[] f) {
    if (f == null) { sb.Append("null"); return; }
    sb.Append('[').Append(N(f[0])).Append(',').Append(N(f[1])).Append(',').Append(N(f[2])).Append(',').Append(N(f[3])).Append(']');
  }

  // The answer, one line. idJson and appJson are JSON already (the loop makes
  // them); how is one of this class's own words. Nothing else goes in.
  static string Reply(string idJson, int[] caret, int[] field, string appJson, string how, long ms) {
    StringBuilder sb = new StringBuilder(192);
    sb.Append("{\"id\":").Append(string.IsNullOrEmpty(idJson) ? "null" : idJson);
    sb.Append(",\"ok\":true,\"caret\":");
    Frame(sb, caret);
    sb.Append(",\"field\":");
    Frame(sb, field);
    sb.Append(",\"app\":").Append(string.IsNullOrEmpty(appJson) ? "null" : appJson);
    sb.Append(",\"scale\":\"pixels\",\"how\":\"").Append(how).Append("\",\"ms\":").Append(N(ms)).Append('}');
    return sb.ToString();
  }

  static string Fail(string idJson, string error) {
    return "{\"id\":" + (string.IsNullOrEmpty(idJson) ? "null" : idJson) + ",\"ok\":false,\"error\":\"" + error + "\"}";
  }

  // One whole line under the console writer's own lock, as TzShot.Send: the
  // loop answers other lines on its thread meanwhile.
  static void Send(string line) {
    System.IO.TextWriter o = Console.Out;
    lock (o) { o.WriteLine(line); o.Flush(); }
  }
}
'@
  $script:caretReady = $true
} catch {}

# Windows.Media.Ocr (Windows 10 and later), loaded the way frontApp.js's
# PowerShell loads it and awaited the same way, through
# WindowsRuntimeSystemExtensions.AsTask. The types are kept and handed to the
# look worker, which runs in a runspace of its own, rather than left for it to
# find by name. $null when any of it will not load: look then still captures
# the picture, and answers with no lines.
function TzLoadWinRT {
  try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $at = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
    $eng = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    $dec = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    $sbm = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    [void][Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
    $res = [Windows.Media.Ocr.OcrResult]
    if ($null -eq $at -or $null -eq $eng -or $null -eq $dec -or $null -eq $sbm -or $null -eq $res) { return $null }
    return @{ asTask = $at; engine = $eng; decoder = $dec; bitmap = $sbm; result = $res; streams = [System.IO.WindowsRuntimeStreamExtensions] }
  } catch { return $null }
}

# A look runs on a thread of its own, never the reader loop's. OCR of a big
# window takes a few hundred milliseconds, and the device asks for a snapshot
# and a look at the same moment (Alt twice): made here, the look would hold the
# snapshot past its own timeout. A small pool, opened now while nothing is
# waiting so the first look starts at once; MTA, so the OCR engine one worker
# makes can be used from the pool's other thread without a message pump.
function TzOpenLookPool {
  try {
    $iss = [System.Management.Automation.Runspaces.InitialSessionState]::CreateDefault2()
    $pool = [runspacefactory]::CreateRunspacePool(1, 2, $iss, $Host)
    try { $pool.ApartmentState = [System.Threading.ApartmentState]::MTA } catch {}
    try { $pool.ThreadOptions = [System.Management.Automation.Runspaces.PSThreadOptions]::ReuseThread } catch {}
    $pool.Open()
    return $pool
  } catch { return $null }
}

$script:winrt = $null
$script:lookPool = $null
$script:lookKit = $null
$script:looks = New-Object System.Collections.Generic.List[object]
if ($script:lookReady) {
  $script:winrt = TzLoadWinRT
  $script:lookPool = TzOpenLookPool
  # Everything a worker needs, by reference: the C# and WinRT types, and one
  # table the workers share (the OCR engine, made once).
  $script:lookKit = @{ shot = [TzShot]; winrt = $script:winrt; shared = [hashtable]::Synchronized(@{}) }
}

# UI Automation control types onto the contract's roles. Anything not here is
# dropped, except a Pane/Group/Custom that has a name AND can be invoked, which
# is a clickable thing worth pointing at, so it is kept as a button. A
# Document is decided in the walk: an area only when it can be typed into.
$ROLES = @{
  'ControlType.Button' = 'button'; 'ControlType.SplitButton' = 'button';
  'ControlType.Hyperlink' = 'link';
  'ControlType.Edit' = 'field';
  'ControlType.CheckBox' = 'check'; 'ControlType.RadioButton' = 'radio';
  'ControlType.TabItem' = 'tab';
  'ControlType.MenuItem' = 'menuitem';
  'ControlType.ListItem' = 'item'; 'ControlType.TreeItem' = 'item'; 'ControlType.DataItem' = 'item';
  'ControlType.ComboBox' = 'combo';
  'ControlType.Slider' = 'slider';
  'ControlType.Image' = 'image';
  'ControlType.Text' = 'text';
  'ControlType.Header' = 'heading'; 'ControlType.HeaderItem' = 'heading';
  'ControlType.Window' = 'window';
}
$KEEP_IF_ACTIONABLE = @('ControlType.Pane', 'ControlType.Group', 'ControlType.Custom')

# The virtual-key codes for a chord. "cmd" maps to ctrl here, because on
# Windows the command key is Control; "win" is the real Windows key.
$VK = @{
  'ctrl' = 0x11; 'control' = 0x11; 'shift' = 0x10; 'alt' = 0x12; 'option' = 0x12;
  'cmd' = 0x11; 'command' = 0x11; 'meta' = 0x11; 'win' = 0x5B; 'super' = 0x5B;
  'enter' = 0x0D; 'return' = 0x0D; 'escape' = 0x1B; 'esc' = 0x1B; 'tab' = 0x09;
  'space' = 0x20; 'spacebar' = 0x20; 'backspace' = 0x08; 'back' = 0x08;
  'delete' = 0x2E; 'del' = 0x2E; 'insert' = 0x2D; 'ins' = 0x2D;
  'left' = 0x25; 'up' = 0x26; 'right' = 0x27; 'down' = 0x28;
  'home' = 0x24; 'end' = 0x23; 'pageup' = 0x21; 'pgup' = 0x21; 'pagedown' = 0x22; 'pgdn' = 0x22;
}
foreach ($i in 1..12) { $VK["f$i"] = 0x6F + $i }       # F1..F12 = 0x70..0x7B
# Keys that need the extended-key flag or some apps read them as the numpad.
$EXT = @('left', 'up', 'right', 'down', 'home', 'end', 'pageup', 'pgup', 'pagedown', 'pgdn', 'insert', 'ins', 'delete', 'del')
$MODS = @('ctrl', 'control', 'shift', 'alt', 'option', 'cmd', 'command', 'meta', 'win', 'super')

$SEL_MAX = 8000
$VAL_MAX = 120
$LABEL_MAX = 80
$TITLE_MAX = 200
$TITLE_READ = 1024
$MAX_NODES = 4000
$BUDGET_MS = 900

# A value that is an address (a page's URL, a link's target) is where the user
# is, not text they are writing, and it is never sent.
$URL_VALUE = '(?i)^\s*(?:[a-z][a-z0-9+.-]*://|www\.)'

# The id -> AutomationElement maps: the latest snapshot's, and the one before
# it, so an action on an id from the last-but-one snapshot still finds its
# element (the device may act on what it last saw while a new walk is running).
# Each map's foreground window is kept with it, for the click's foreground
# check when an element's own window cannot be found (see TzClickEl).
$script:mapCur = @{}
$script:mapPrev = @{}
$script:rootCur = [IntPtr]::Zero
$script:rootPrev = [IntPtr]::Zero

function TzFind($id) {
  if ($id -ne $null -and $script:mapCur.ContainsKey($id)) { return $script:mapCur[$id] }
  if ($id -ne $null -and $script:mapPrev.ContainsKey($id)) { return $script:mapPrev[$id] }
  return $null
}

function TzRootOf($id) {
  if ($id -ne $null -and $script:mapCur.ContainsKey($id)) { return $script:rootCur }
  if ($id -ne $null -and $script:mapPrev.ContainsKey($id)) { return $script:rootPrev }
  return [IntPtr]::Zero
}

function TzGP($el, $prop) { try { return $el.GetCachedPropertyValue($prop) } catch { return $null } }

# The walk's rectangle: the cached one, read in the same cross-process call
# as the element itself. Never for acting — see TzLiveRect.
function TzRect($el) {
  try { $r = $el.Cached.BoundingRectangle; if ($r) { return $r } } catch {}
  try { return $el.Current.BoundingRectangle } catch {}
  return $null
}

# Where the element is NOW, for a click or a wheel. The cached rectangle still
# answers after the element is gone (a list re-rendered or scrolled while a
# confirm card was up), and a click there would land on whatever took its
# place, which nothing ever risk-checked. So it is read live, and an element
# that is gone, off-screen or without a size is a refusal, never a guess.
# Read through GetCurrentPropertyValue, a method: PowerShell turns an exception
# in a property getter ($el.Current.BoundingRectangle) into a quiet $null, so
# only a method call can say "gone".
function TzLiveRect($el) {
  $off = $null
  $r = $null
  try {
    $off = $el.GetCurrentPropertyValue($AE::IsOffscreenProperty)
    $r = $el.GetCurrentPropertyValue($AE::BoundingRectangleProperty)
  } catch { return @{ error = 'gone' } }
  if ($off -eq $true) { return @{ error = 'offscreen' } }
  if ($r -eq $null -or $r.IsEmpty -or -not ($r.Width -gt 0) -or -not ($r.Height -gt 0)) { return @{ error = 'no_rect' } }
  return @{ rect = $r }
}

# Whether what was thrown says the element no longer exists. Matched by name:
# a [type] in a catch would need UI Automation loaded before this script could
# run at all, and it may not load.
function TzIsGone($err) {
  $e = $null
  try { $e = $err.Exception } catch {}
  while ($e -ne $null) {
    if ($e.GetType().Name -eq 'ElementNotAvailableException') { return $true }
    $e = $e.InnerException
  }
  return $false
}

# The foreground window's process id, for the elevation gate on commands that
# have no element of their own (key, scroll under the pointer).
function TzForegroundPid {
  $h = [TzAgent]::GetForegroundWindow()
  [uint32]$procId = 0
  [void][TzAgent]::GetWindowThreadProcessId($h, [ref]$procId)
  return $procId
}

# True when we would be acting on a window we are not allowed to drive: we are
# certainly not elevated and the target either is, or is high enough that we
# cannot even read its token. Being elevated ourselves, we never block.
function TzElevated([uint32]$procId) {
  if ($procId -eq 0) { return $false }
  $self = [TzAgent]::SelfElevated()
  if ($self -ne 0) { return $false }
  $tgt = [TzAgent]::ProcElevated($procId)
  return ($tgt -eq 1 -or $tgt -eq -1)
}

function TzClean([string]$s, [int]$max) {
  if ([string]::IsNullOrEmpty($s)) { return '' }
  $s = ($s -replace '\s+', ' ').Trim()
  if ($s.Length -gt $max) { $s = $s.Substring(0, $max) }
  return $s
}

# The window's title as the device gets it: at most $TITLE_MAX characters and,
# when it is longer, its start and its end. A browser says a window is private
# at the END of its title ("... - Mozilla Firefox Private Browsing", "... -
# [InPrivate] - Microsoft Edge"), so a long page title cut from the end would
# hide exactly what agent.js looks for to refuse the window.
function TzTitleCap([string]$t) {
  if ($t.Length -le $TITLE_MAX) { return $t }
  $tail = 80
  return $t.Substring(0, $TITLE_MAX - $tail - 5) + ' ... ' + $t.Substring($t.Length - $tail)
}

# ---- Snapshot -------------------------------------------------------------------
# $budget is the walk's own time limit in ms. The driver sends about 60% of its
# timeout: a huge tree (Slack, Teams, a long page) comes back truncated with
# what was found rather than not at all, and this single-threaded helper is
# free again before the next question, instead of still walking when it comes.
function TzSnapshot([int]$max, [int]$budget) {
  $o = [ordered]@{ ok = $false }
  if (-not $uia) { $o.error = 'no_uia'; return $o }
  if ($budget -le 0) { $budget = $BUDGET_MS }
  $sw = [System.Diagnostics.Stopwatch]::StartNew()

  $h = [TzAgent]::GetForegroundWindow()
  if ($h -eq [IntPtr]::Zero) { $o.error = 'no_window'; return $o }
  [uint32]$procId = 0
  [void][TzAgent]::GetWindowThreadProcessId($h, [ref]$procId)

  # The window's title, for the device alone: agent.js reads it to refuse a
  # private window or a sensitive app before anything is read or sent, and
  # never puts it in a request. The walk also uses it to keep the title out of
  # the elements (a page's root, a caption drawn as text), so it is kept whole
  # here and only capped on its way out (TzTitleCap).
  $title = ''
  try { $title = TzClean ([TzAgent]::WindowTitle($h)) $TITLE_READ } catch {}

  $root = $null
  try { $root = $AE::FromHandle($h) } catch {}
  if ($root -eq $null) { $o.error = 'no_window'; return $o }

  # Everything the walk reads, cached in one go, so each node is one
  # cross-process call for its children carrying all their properties, not a
  # call per property per child.
  $cr = New-Object System.Windows.Automation.CacheRequest
  $cr.AutomationElementMode = [System.Windows.Automation.AutomationElementMode]::Full
  $cr.TreeScope = $TS::Element
  foreach ($p in @(
    $AE::NameProperty, $AE::ControlTypeProperty, $AE::BoundingRectangleProperty,
    $AE::IsEnabledProperty, $AE::HasKeyboardFocusProperty, $AE::IsPasswordProperty,
    $AE::IsOffscreenProperty, $AE::AutomationIdProperty, $AE::HelpTextProperty,
    $AE::ProcessIdProperty,
    $AE::IsInvokePatternAvailableProperty, $AE::IsTogglePatternAvailableProperty,
    $AE::IsSelectionItemPatternAvailableProperty, $AE::IsExpandCollapsePatternAvailableProperty,
    $AE::IsValuePatternAvailableProperty, $AE::IsScrollPatternAvailableProperty,
    $AE::IsTextPatternAvailableProperty,
    $VP::ValueProperty, $VP::IsReadOnlyProperty, $TOG::ToggleStateProperty, $SIP::IsSelectedProperty
  )) { $cr.Add($p) }

  # Ids survive one more snapshot, so keep the last map as the previous one.
  $script:mapPrev = $script:mapCur
  $script:mapCur = @{}
  $script:rootPrev = $script:rootCur
  $script:rootCur = $h

  $els = New-Object System.Collections.Generic.List[object]
  $count = 0
  $visited = 0
  $truncated = $false
  $focusedId = $null
  $winRect = $null
  $cond = $AUTO::ControlViewCondition

  $cr.Push()
  try {
    $rootC = $root.GetUpdatedCache($cr)
    if (-not $title) { try { $title = TzClean "$($rootC.Cached.Name)" $TITLE_READ } catch {} }
    $winRect = TzRect $rootC
    $wl = if ($winRect) { $winRect.Left } else { -1e9 }
    $wt = if ($winRect) { $winRect.Top } else { -1e9 }
    $wr = if ($winRect) { $winRect.Right } else { 1e9 }
    $wb = if ($winRect) { $winRect.Bottom } else { 1e9 }

    $level = New-Object System.Collections.Generic.List[object]
    $level.Add(@{ el = $rootC; pct = '' })
    while ($level.Count -gt 0) {
      $next = New-Object System.Collections.Generic.List[object]
      foreach ($w in $level) {
        if ($count -ge $max -or $visited -ge $MAX_NODES -or $sw.ElapsedMilliseconds -ge $budget) { $truncated = $true; break }
        $visited++
        $el = $w.el
        $ctName = ''
        try { $ct = $el.Cached.ControlType; if ($ct) { $ctName = $ct.ProgrammaticName } } catch {}

        # Where it is, and whether it is worth drawing: on screen, sized, and
        # within the window. Children are walked regardless of the parent's fate.
        $rect = TzRect $el
        $onScreen = $true
        try { if ($el.Cached.IsOffscreen) { $onScreen = $false } } catch {}
        $sized = $rect -ne $null -and $rect.Width -gt 0 -and $rect.Height -gt 0
        $inside = $false
        if ($sized) {
          $inside = -not ($rect.Right -lt $wl -or $rect.Left -gt $wr -or $rect.Bottom -lt $wt -or $rect.Top -gt $wb)
        }

        $role = $ROLES[$ctName]
        $isPw = $false
        try { $isPw = [bool]$el.Cached.IsPassword } catch {}

        # A menu item straight under a menu bar is a top-level menu.
        if ($role -eq 'menuitem' -and $w.pct -eq 'ControlType.MenuBar') { $role = 'menu' }

        # A pane/group/custom is layout noise unless it is named and can be
        # invoked — then it is effectively a button.
        $invokable = (TzGP $el $AE::IsInvokePatternAvailableProperty) -eq $true -or
                     (TzGP $el $AE::IsTogglePatternAvailableProperty) -eq $true -or
                     (TzGP $el $AE::IsSelectionItemPatternAvailableProperty) -eq $true -or
                     (TzGP $el $AE::IsExpandCollapsePatternAvailableProperty) -eq $true
        $name = ''
        try { $name = $el.Cached.Name } catch {}
        if ($role -eq $null -and ($KEEP_IF_ACTIONABLE -contains $ctName) -and $invokable -and -not [string]::IsNullOrWhiteSpace($name)) {
          $role = 'button'
        }

        # A Document is a text area only when it can be typed into. A web
        # page's root (Chrome, Edge, any Electron app) is a read-only Document
        # named with the page's title, which is the window's, and valued with
        # its URL. Listed, it would send both, and keys pressed at the page
        # (Gmail's "#" deletes) would read as typing in a box and go unasked.
        # Its children are walked all the same, as the Mac skips AXWebArea.
        if ($ctName -eq 'ControlType.Document') {
          $role = $null
          if ((TzGP $el $AE::IsValuePatternAvailableProperty) -eq $true -and (TzGP $el $VP::IsReadOnlyProperty) -eq $false) { $role = 'area' }
        }

        # The window's caption drawn as text (a custom title bar) is the title
        # by another road; it stays here, as it does on the Mac.
        if ($role -eq 'text' -and $title -and (TzClean $name $TITLE_READ) -ieq $title) { $role = $null }

        # A multi-line edit reads as an area, not a one-line field. UI
        # Automation exposes no multi-line flag on the core properties, so a
        # tall box is the signal (documented: unverifiable without Windows).
        if ($role -eq 'field' -and $rect -ne $null -and $rect.Height -gt 40) { $role = 'area' }

        if ($role -ne $null -and $onScreen -and $sized -and $inside) {
          $count++
          $id = "e$count"
          $script:mapCur[$id] = $el

          $help = ''
          try { $help = $el.Cached.HelpText } catch {}
          $autoId = ''
          try { $autoId = $el.Cached.AutomationId } catch {}
          $label = $name; if ([string]::IsNullOrWhiteSpace($label)) { $label = $help }
          # Never a window's title as a label: not a window's own name, and
          # not a typed-in Document's name where that is the title or part
          # of it.
          if ($role -eq 'window') { $label = '' }
          elseif ($ctName -eq 'ControlType.Document' -and $title -and -not [string]::IsNullOrWhiteSpace($label) -and
                  $title.IndexOf((TzClean $label $TITLE_READ), [StringComparison]::OrdinalIgnoreCase) -ge 0) { $label = '' }

          # An address/search bar's value is a URL the user is on — their
          # browsing, not a field we help write. Label only, never its value.
          $isUrlField = ($label -match '(?i)address\s*(and\s*search|bar)|search\s*or\s*(type|enter).*(address|url)|^\s*url\s*$') -or ($autoId -match '(?i)url|address')

          $item = [ordered]@{
            id = $id; role = $role; label = (TzClean $label $LABEL_MAX)
            frame = @([int][math]::Round($rect.X), [int][math]::Round($rect.Y), [int][math]::Round($rect.Width), [int][math]::Round($rect.Height))
          }

          try { if ($el.Cached.HasKeyboardFocus) { $item.focused = $true; $focusedId = $id } } catch {}
          try { if (-not $el.Cached.IsEnabled) { $item.disabled = $true } } catch {}

          if ((TzGP $el $AE::IsSelectionItemPatternAvailableProperty) -eq $true) {
            $sel = TzGP $el $SIP::IsSelectedProperty
            if ($role -eq 'item' -or $role -eq 'tab') { if ($sel -eq $true) { $item.selected = $true } }
            if ($role -eq 'radio') { $item.checked = [bool]$sel }
          }
          if ($role -eq 'check' -and (TzGP $el $AE::IsTogglePatternAvailableProperty) -eq $true) {
            $item.checked = ("$(TzGP $el $TOG::ToggleStateProperty)" -eq 'On')
          }

          # A password field is listed, so the model knows it is there, but its
          # value never leaves the machine.
          if ($isPw) {
            $item.secure = $true
          } elseif (-not $isUrlField -and ($role -eq 'field' -or $role -eq 'area' -or $role -eq 'combo') -and (TzGP $el $AE::IsValuePatternAvailableProperty) -eq $true) {
            $v = TzGP $el $VP::ValueProperty
            if ($v -is [string] -and $v.Length -gt 0 -and $v -notmatch $URL_VALUE) { $item.value = (TzClean $v $VAL_MAX) }
          }

          $els.Add($item)
        }

        # Its children, next level. One FindAll, all of them cached.
        try {
          $kids = $el.FindAll($TS::Children, $cond)
          if ($kids -ne $null) { foreach ($k in $kids) { $next.Add(@{ el = $k; pct = $ctName }) } }
        } catch {}
      }
      if ($count -ge $max -or $visited -ge $MAX_NODES -or $sw.ElapsedMilliseconds -ge $budget) { $truncated = $true; break }
      $level = $next
    }
  } catch {} finally { $cr.Pop() }

  # The selected text in the focused element, whole or not at all, and only
  # where it could be written over (not a read-only page's text).
  $selText = ''
  try {
    $fe = $AE::FocusedElement
    if ($fe -ne $null) {
      $tp = $null
      if ($fe.TryGetCurrentPattern($TXP::Pattern, [ref]$tp)) {
        $ro = $false
        # Not $vp: PowerShell's names ignore case, so a local $vp would be
        # $VP, the ValuePattern type, and $VP::Pattern would read as null.
        $valp = $null
        if ($fe.TryGetCurrentPattern($VP::Pattern, [ref]$valp)) { $ro = [bool]$valp.Current.IsReadOnly }
        if (-not $ro) {
          $sel = $tp.GetSelection()
          if ($sel -and $sel.Length -gt 0) {
            $st = $sel[0].GetText($SEL_MAX + 1)
            if ($st -and $st.Length -le $SEL_MAX) { $selText = $st }
          }
        }
      }
    }
  } catch {}

  $appName = TzAppName $h $procId

  # The title rides in the window object for the device's own checks only
  # (see above), capped with its end kept; "" when it could not be read.
  $window = $null
  if ($winRect -or $title) {
    $frame = $null
    if ($winRect) { $frame = @([int][math]::Round($winRect.X), [int][math]::Round($winRect.Y), [int][math]::Round($winRect.Width), [int][math]::Round($winRect.Height)) }
    $window = [ordered]@{ frame = $frame; title = (TzTitleCap "$title") }
  }

  $sw.Stop()
  $o.ok = $true
  $o.app = @{ name = $appName; pid = [int]$procId }
  $o.window = $window
  $o.focused = $focusedId
  $o.selection = $selText
  $o.scale = 'pixels'
  $o.elements = $els
  $o.truncated = $truncated
  $o.ms = [int]$sw.ElapsedMilliseconds
  return $o
}

# The app a window belongs to, by the name people know it by: its file
# description, else its process name. A Store app (Calculator, Settings, Mail)
# is drawn in a frame that ApplicationFrameHost owns, so every one of them was
# named "Application Frame Host": the sensitive-app check saw that, not the
# app. The app is the CoreWindow inside the frame, named by its own process,
# as frontApp.js names it. The caller's pid stays the frame's, which is the
# window here. "" when it cannot be told.
function TzAppName([IntPtr]$h, [uint32]$procId) {
  $appName = ''
  try {
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'ApplicationFrameHost') {
      $core = [TzAgent]::FindWindowEx($h, [IntPtr]::Zero, 'Windows.UI.Core.CoreWindow', [IntPtr]::Zero)
      [uint32]$coreId = 0
      if ($core -ne [IntPtr]::Zero) { [void][TzAgent]::GetWindowThreadProcessId($core, [ref]$coreId) }
      if ($coreId -ne 0 -and $coreId -ne $procId) { $hosted = Get-Process -Id $coreId -ErrorAction SilentlyContinue; if ($hosted) { $p = $hosted } }
    }
    if ($p) { $appName = $p.ProcessName; try { $d = $p.MainModule.FileVersionInfo.FileDescription; if ($d) { $appName = $d } } catch {} }
  } catch {}
  return $appName
}

# ---- Element actions ------------------------------------------------------------
function TzElPid($el) { try { return [uint32]$el.Cached.ProcessId } catch {} ; try { return [uint32]$el.Current.ProcessId } catch {} ; return 0 }

# Run a pattern call off the reader loop. InvokePattern.Invoke (and Toggle /
# ExpandCollapse) does not return until any modal dialog the control opens is
# closed, so on the loop's own thread one "press OK" would wedge the helper for
# as long as the dialog stayed up, and every later command with it. The call
# goes on its own runspace; if it has not come back after ~400 ms we assume it
# opened something modal, answer pending, and let the runspace finish on its
# own (it disposes itself when it returns). $null back here means "still going".
function TzInvokeBounded($block, $argList, [int]$ms) {
  $psh = [powershell]::Create()
  [void]$psh.AddScript($block)
  foreach ($a in $argList) { [void]$psh.AddArgument($a) }
  $async = $psh.BeginInvoke()
  if ($async.AsyncWaitHandle.WaitOne($ms)) {
    $res = $null
    try { $res = $psh.EndInvoke($async) } catch {}
    try { $psh.Dispose() } catch {}
    if ($res -and $res.Count -ge 1) { return $res[0] }
    return @{ ok = $true }
  }
  return $null
}

function TzPress($el) {
  # Pick the pattern on this thread (a quick, non-blocking query); only the
  # Invoke/Toggle/Select/Expand itself is run off-thread, so we always know how.
  # An element that is gone answers "gone", so the device knows nothing was
  # pressed (and a click fallback then finds it gone too, see TzLiveRect).
  $p = $null
  $how = $null
  try {
    if ($el.TryGetCurrentPattern($IP::Pattern, [ref]$p)) { $how = 'invoke' }
    elseif ($el.TryGetCurrentPattern($TOG::Pattern, [ref]$p)) { $how = 'toggle' }
    elseif ($el.TryGetCurrentPattern($SIP::Pattern, [ref]$p)) { $how = 'select' }
    elseif ($el.TryGetCurrentPattern($ECP::Pattern, [ref]$p)) { $how = 'expand' }
  } catch {
    if (TzIsGone $_) { return @{ ok = $false; error = 'gone' } }
    return @{ ok = $false; error = 'exception' }
  }
  if ($how -eq $null) { return @{ ok = $false; error = 'no_action' } }

  $block = {
    param($p, $how)
    try {
      switch ($how) {
        'invoke' { $p.Invoke() }
        'toggle' { $p.Toggle() }
        'select' { $p.Select() }
        'expand' { if ("$($p.Current.ExpandCollapseState)" -eq 'Expanded') { $p.Collapse() } else { $p.Expand() } }
      }
      return @{ ok = $true; how = $how }
    } catch { return @{ ok = $false; error = 'exception'; how = $how } }
  }
  $r = TzInvokeBounded $block @($p, $how) 400
  if ($r -eq $null) { return @{ ok = $true; how = $how; pending = $true } }
  return $r
}

# The top-level window handle an element lives in, for the foreground check:
# the nearest Window ancestor with a handle, taken up to its top-level root,
# since a UWP app's CoreWindow (Settings, Calculator) and an MDI child are
# Windows too, but child ones that GetForegroundWindow never returns. Zero
# when there is none to be found within reach (an element deeper than the climb,
# a popup menu whose ancestors include no Window).
function TzTopWindow($el) {
  try {
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $n = $el
    for ($i = 0; $i -lt 20 -and $n -ne $null; $i++) {
      # [int]: a getter that failed reads as $null, which is not a handle.
      $wh = 0; try { $wh = [int]$n.Current.NativeWindowHandle } catch {}
      $isWin = $false; try { $isWin = ("$($n.Current.ControlType.ProgrammaticName)" -eq 'ControlType.Window') } catch {}
      if ($isWin -and $wh -ne 0) { return [TzAgent]::TopLevel([IntPtr]$wh) }
      $parent = $null; try { $parent = $walker.GetParent($n) } catch {}
      if ($parent -eq $null) { break }
      $n = $parent
    }
    $wh = 0; try { $wh = [int]$el.Current.NativeWindowHandle } catch {}
    if ($wh -ne 0) { return [TzAgent]::TopLevel([IntPtr]$wh) }
  } catch {}
  return [IntPtr]::Zero
}

# Tailzu's own windows never take focus, so the helper cannot assume the app it
# means to act on is in front: a plain SetForegroundWindow is refused under the
# foreground lock and SendInput would then land in whatever is. Bring the
# target forward with the real workaround and confirm it took; if it did not,
# the caller returns "not_foreground" rather than click the wrong window.
function TzEnsureForeground([IntPtr]$hwnd) {
  if ($hwnd -eq [IntPtr]::Zero) { return $true }
  return [TzAgent]::ForceForeground($hwnd)
}

# A real click at the middle of where the element is now. $root is the window
# that was in front when the element was walked: when its own window cannot be
# found (a web element deeper than TzTopWindow climbs), that is the window that
# must be in front, never "whatever is". The rectangle is read live before the
# foreground dance (nothing is brought forward for an element that is gone) and
# again after it, since bringing a window forward can move or close what was
# there.
function TzClickEl($el, [IntPtr]$root) {
  $live = TzLiveRect $el
  if ($live.error) { return @{ ok = $false; error = $live.error } }
  $top = TzTopWindow $el
  if ($top -eq [IntPtr]::Zero) { $top = $root }
  if (-not (TzEnsureForeground $top)) { return @{ ok = $false; error = 'not_foreground' } }
  $live = TzLiveRect $el
  if ($live.error) { return @{ ok = $false; error = $live.error } }
  $r = $live.rect
  $cx = [int][math]::Round($r.X + $r.Width / 2)
  $cy = [int][math]::Round($r.Y + $r.Height / 2)
  [void][TzAgent]::SetCursorPos($cx, $cy)
  [TzAgent]::Click()
  return @{ ok = $true }
}

function TzSetValue($el, [string]$text) {
  try { $el.SetFocus() } catch {}
  # $valp, never $vp, which is $VP (see the selection in TzSnapshot).
  $valp = $null
  if ($el.TryGetCurrentPattern($VP::Pattern, [ref]$valp)) {
    if ($valp.Current.IsReadOnly) { return @{ ok = $false; error = 'read_only' } }
    $valp.SetValue($text)
    return @{ ok = $true }
  }
  return @{ ok = $false; error = 'no_value' }
}

function TzScrollEl($el, [string]$dir, [int]$lines) {
  $sp = $null
  $has = $false
  try { $has = $el.TryGetCurrentPattern($SCP::Pattern, [ref]$sp) } catch {
    if (TzIsGone $_) { return @{ ok = $false; error = 'gone' } }
  }
  if ($has) {
    $small = [System.Windows.Automation.ScrollAmount]::SmallIncrement
    $dec = [System.Windows.Automation.ScrollAmount]::SmallDecrement
    try {
      for ($i = 0; $i -lt $lines; $i++) {
        switch ($dir) {
          'down'  { $sp.ScrollVertical($small) }
          'up'    { $sp.ScrollVertical($dec) }
          'right' { $sp.ScrollHorizontal($small) }
          'left'  { $sp.ScrollHorizontal($dec) }
        }
      }
      return @{ ok = $true; how = 'scrollpattern' }
    } catch {}
  }
  # No scroll pattern: the wheel over the element's centre, where it is now
  # (see TzLiveRect); one that is gone is not scrolled blind under the cursor.
  $live = TzLiveRect $el
  if ($live.error) { return @{ ok = $false; error = $live.error } }
  $r = $live.rect
  [void][TzAgent]::SetCursorPos([int][math]::Round($r.X + $r.Width / 2), [int][math]::Round($r.Y + $r.Height / 2))
  TzWheel $dir $lines
  return @{ ok = $true; how = 'wheel' }
}

function TzWheel([string]$dir, [int]$lines) {
  $amount = 120 * [math]::Max(1, $lines)
  switch ($dir) {
    'up'    { [TzAgent]::Wheel($amount, $false) }
    'down'  { [TzAgent]::Wheel(-$amount, $false) }
    'right' { [TzAgent]::Wheel($amount, $true) }
    'left'  { [TzAgent]::Wheel(-$amount, $true) }
  }
}

# ---- Keys -----------------------------------------------------------------------
# A chord to virtual keys. Named keys (enter, tab, f5, arrows, ...) have fixed
# codes; a single character is mapped through the FOREGROUND window's keyboard
# layout with VkKeyScanEx, so "t" or a layout-specific symbol reaches the right
# key on a non-US keyboard, and any shift the character itself needs is added.
function TzKey([string]$chord) {
  $h = [TzAgent]::GetForegroundWindow()
  [uint32]$fpid = 0
  $tid = [TzAgent]::GetWindowThreadProcessId($h, [ref]$fpid)
  $hkl = [TzAgent]::GetKeyboardLayout($tid)

  $tokens = @($chord.ToLower().Split('+') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
  if ($tokens.Count -eq 0) { return @{ ok = $false; error = 'bad_key' } }
  $keyTok = $tokens[$tokens.Count - 1]
  $modVks = @()
  for ($i = 0; $i -lt $tokens.Count - 1; $i++) { if ($MODS -contains $tokens[$i]) { $v = $VK[$tokens[$i]]; if ($v) { $modVks += $v } } }

  $keyVk = -1
  $extended = $EXT -contains $keyTok
  if ($VK.ContainsKey($keyTok)) {
    $keyVk = $VK[$keyTok]
  } elseif ($keyTok.Length -eq 1) {
    $scan = [TzAgent]::VkKeyScanEx([char]$keyTok[0], $hkl)
    if ($scan -ne -1) {
      $keyVk = $scan -band 0xFF
      $shiftState = ($scan -shr 8) -band 0xFF
      if (($shiftState -band 1) -and ($modVks -notcontains 0x10)) { $modVks += 0x10 }  # needs Shift
      if (($shiftState -band 2) -and ($modVks -notcontains 0x11)) { $modVks += 0x11 }  # needs Ctrl
      if (($shiftState -band 4) -and ($modVks -notcontains 0x12)) { $modVks += 0x12 }  # needs Alt
    }
  }
  if ($keyVk -lt 0) { return @{ ok = $false; error = 'bad_key' } }

  foreach ($v in $modVks) { [TzAgent]::Key([uint16]$v, $false, $false) }
  [TzAgent]::Key([uint16]$keyVk, $false, $extended)
  [TzAgent]::Key([uint16]$keyVk, $true, $extended)
  for ($i = $modVks.Count - 1; $i -ge 0; $i--) { [TzAgent]::Key([uint16]$modVks[$i], $true, $false) }
  return @{ ok = $true }
}

# ---- Open an app ----------------------------------------------------------------
# OPEN launches an app by the name people know it by, and nothing else. The
# name is the model's, and the model reads the screen, so a page can put
# anything there: a path, a share (\\host\x.exe, which also hands that host the
# user's NTLM hash), a URL or a protocol handler (ms-msdt:...), all of which a
# bare Start-Process would run. So a name with a path, drive, scheme,
# environment-variable or wildcard character, or one that starts with a dot, is
# refused before anything is looked up; and what is launched is only ever
# something Windows itself lists as an app: a Start Menu shortcut, an installed
# (Store) app, an App Paths entry, or an .exe on the PATH (never the current
# directory). The Mac helper likewise resolves only installed apps.
$OPEN_REFUSE = '[\\/:%*?"<>|\[\]`~]'
# A loose match is never an uninstaller or a readme that happens to share the
# app's name ("Uninstall Slack" for "Slack").
$OPEN_NOT_APP = '(?i)\b(uninstall|deinstall|remove|repair|setup|install|readme|release notes|license|help|manual|website)\b'

function TzOpenRefused([string]$name) {
  return ($name -match $OPEN_REFUSE) -or $name.StartsWith('.') -or ($name -match '\p{Cc}')
}

function TzStartMenuLinks {
  foreach ($d in @("$env:ProgramData\Microsoft\Windows\Start Menu\Programs", "$env:APPDATA\Microsoft\Windows\Start Menu\Programs")) {
    if (-not (Test-Path -LiteralPath $d)) { continue }
    Get-ChildItem -LiteralPath $d -Recurse -Filter *.lnk -ErrorAction SilentlyContinue
  }
}

function TzOpen([string]$name) {
  if ([string]::IsNullOrWhiteSpace($name)) { return @{ ok = $false; error = 'no_app' } }
  $name = $name.Trim()
  if (TzOpenRefused $name) { return @{ ok = $false; error = 'not_found' } }

  $target = $null   # a shortcut or an .exe, by its full path
  $appId = $null    # an installed app, by its AppUserModelID
  $links = @(TzStartMenuLinks)
  $exe = if ($name -match '(?i)\.exe$') { $name } else { "$name.exe" }

  # A Start Menu shortcut with exactly this name, first: it is what the user
  # sees in Start, and it starts the app the way Start does.
  foreach ($lnk in $links) { if ($lnk.BaseName -ieq $name) { $target = $lnk.FullName; break } }
  # An installed app with exactly this name. Store apps (Settings, Calculator)
  # have no shortcut file; Start knows them by an AppUserModelID.
  if (-not $target) {
    try {
      $sa = Get-StartApps -ErrorAction Stop | Where-Object { $_.Name -ieq $name } | Select-Object -First 1
      if ($sa -and $sa.AppID) { $appId = "$($sa.AppID)" }
    } catch {}
  }
  # An App Paths entry, which is what Win+R resolves "excel" or "chrome" by.
  if (-not $target -and -not $appId) {
    foreach ($hive in @('HKCU:', 'HKLM:')) {
      try {
        $p = (Get-ItemProperty -LiteralPath "$hive\Software\Microsoft\Windows\CurrentVersion\App Paths\$exe" -ErrorAction Stop).'(default)'
        if ($p) { $p = "$p".Trim().Trim('"'); if (Test-Path -LiteralPath $p -PathType Leaf) { $target = $p; break } }
      } catch {}
    }
  }
  # An .exe on the PATH (notepad, calc). Get-Command searches the PATH only,
  # never the current directory, and only a real .exe is taken, not a script.
  if (-not $target -and -not $appId) {
    try {
      $c = Get-Command -Name $exe -CommandType Application -ErrorAction Stop |
        Where-Object { $_.Path -and [System.IO.Path]::GetExtension($_.Path) -ieq '.exe' } | Select-Object -First 1
      if ($c) { $target = $c.Path }
    } catch {}
  }
  # Last, a Start Menu shortcut whose name contains it ("Chrome" for "Google
  # Chrome"), the closest (shortest) first.
  if (-not $target -and -not $appId) {
    $loose = $links | Where-Object { $_.BaseName.IndexOf($name, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.BaseName -notmatch $OPEN_NOT_APP } |
      Sort-Object { $_.BaseName.Length } | Select-Object -First 1
    if ($loose) { $target = $loose.FullName }
  }

  $launched = $false
  if ($target) {
    try { Start-Process -FilePath $target -ErrorAction Stop; $launched = $true } catch {}
  } elseif ($appId) {
    try { Start-Process -FilePath 'explorer.exe' -ArgumentList ('shell:AppsFolder\' + $appId) -ErrorAction Stop; $launched = $true } catch {}
  }
  if (-not $launched) { return @{ ok = $false; error = 'not_found' } }
  # Best effort: once the new window exists, bring it forward past the
  # foreground lock the same way key/click do (SetForegroundWindow alone fails).
  try {
    Start-Sleep -Milliseconds 300
    $short = [System.IO.Path]::GetFileNameWithoutExtension($name)
    $win = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.ProcessName -ilike "*$short*" -or $_.MainWindowTitle -ilike "*$name*") } | Select-Object -First 1
    if ($win) { [void][TzAgent]::ForceForeground($win.MainWindowHandle) }
  } catch {}
  return @{ ok = $true }
}

# ---- Look -----------------------------------------------------------------------
# The window in front as a picture and as the text in it, for the device alone:
# the OCR lines become elements it can point at before any server is asked,
# and the picture is kept on the device unless the person lets one go to the
# vision model. Answered in the same units as the snapshot (physical pixels,
# global), the window's frame being exactly what the picture shows.
$LOOK_BUDGET_MS = 1500
$LOOK_MAX_SIDE = 1600
$LOOK_QUALITY = 82
# What uiaDriver.js allows a look outside its budget (its LOOK_MARGIN_MS): the
# JPEG, and an answer a few hundred KB long written and read.
$LOOK_MARGIN_MS = 800

# The worker, run in the look pool (TzOpenLookPool). It is handed everything
# it uses, since a runspace of its own shares no variables or functions with
# this one, and it writes its own answer line: the reader loop is meanwhile
# blocked reading the next command and could not. $budget bounds the parts that
# wait (the capture, the OCR and the reading of its lines); the JPEG is quick
# and runs to the end. Whatever happens, the line is answered.
$TZ_LOOK_WORKER = {
  param($kit, $warm, $idJson, $hwnd, $frame, $title, $budget, $maxSide, $quality, $wantOcr, $wantImage, $sw, $titleKey, $titleBand)
  $ErrorActionPreference = 'SilentlyContinue'
  $LINES_MAX = 300
  $shot = $kit.shot
  $rt = $kit.winrt

  # An IAsyncOperation awaited no longer than $ms. $null when it has not
  # finished by then; it goes on by itself and its result is dropped.
  function TzAwaitFor($op, $t, $ms) {
    $task = $rt.asTask.MakeGenericMethod($t).Invoke($null, @($op))
    if (-not $task.Wait([int][math]::Max(1, $ms))) { return $null }
    return $task.Result
  }

  # One OCR engine for the helper's life, shared by the pool's threads: for
  # the user's own languages, else for the first language Windows has a
  # recognizer for, so a language list with no OCR pack still reads something.
  function TzOcrEngine {
    if ($null -eq $rt) { return $null }
    $engine = $kit.shared['engine']
    if ($null -ne $engine) { return $engine }
    $engineType = $rt.engine
    try { $engine = $engineType::TryCreateFromUserProfileLanguages() } catch {}
    if ($null -eq $engine) {
      try {
        $langs = $engineType::AvailableRecognizerLanguages
        if ($null -ne $langs -and $langs.Count -gt 0) { $engine = $engineType::TryCreateFromLanguage($langs[0]) }
      } catch {}
    }
    if ($null -ne $engine) { $kit.shared['engine'] = $engine }
    return $engine
  }

  # Started with the helper, so the first look does not pay for the engine.
  if ($warm) { $null = TzOcrEngine; return }

  $sent = $false
  $bmp = $null
  try {
    try { $bmp = $shot::Capture($hwnd, $frame, [int][math]::Max(1, $budget - $sw.ElapsedMilliseconds)) } catch { $bmp = $null }
    if ($null -eq $bmp) { $shot::Send($shot::Fail($idJson, 'capture_failed')); $sent = $true; return }
    # What the line-reading needs at the end, kept back from the OCR's wait.
    $reserve = [math]::Min(200, [int]($budget / 5))

    # The text first: the engine reads on threads of its own, so it works
    # while this one makes the JPEG. Read from the capture at full size
    # (smaller text is lost when scaled), unless the window is bigger than the
    # engine takes, when it reads a copy and $up scales its boxes back up.
    $ocr = 'off'
    $task = $null
    $sbm = $null
    $up = 1.0
    if ($wantOcr) {
      $ocr = 'unavailable'
      $eng = TzOcrEngine
      if ($null -ne $eng) {
        $ocr = 'timeout'
        $src = $bmp
        $mem = $null
        try {
          $engineType = $rt.engine
          $most = 0
          try { $most = [int]$engineType::MaxImageDimension } catch {}
          if ($most -gt 0 -and [math]::Max($bmp.Width, $bmp.Height) -gt $most) { $src = $shot::Fit($bmp, $most); $up = $bmp.Width / $src.Width }
          # From an in-memory stream: nothing of the screen is written to disk.
          $mem = $shot::Bmp($src)
          $streamsType = $rt.streams
          $decoderType = $rt.decoder
          $ras = $streamsType::AsRandomAccessStream($mem)
          $dec = TzAwaitFor ($decoderType::CreateAsync($ras)) $rt.decoder ($budget - $reserve - $sw.ElapsedMilliseconds)
          if ($null -ne $dec) { $sbm = TzAwaitFor ($dec.GetSoftwareBitmapAsync()) $rt.bitmap ($budget - $reserve - $sw.ElapsedMilliseconds) }
          if ($null -ne $sbm) { $task = $rt.asTask.MakeGenericMethod($rt.result).Invoke($null, @($eng.RecognizeAsync($sbm))) }
        } catch { $ocr = 'failed' } finally {
          if ($null -ne $mem) { $mem.Dispose() }
          if (-not [object]::ReferenceEquals($src, $bmp)) { $src.Dispose() }
        }
      }
    }

    # The picture: exactly the window's frame, its long side brought down to
    # $maxSide.
    $jpeg = $null
    $iw = 0
    $ih = 0
    if ($wantImage) {
      $small = $null
      try {
        $small = $shot::Fit($bmp, $maxSide)
        $jpeg = $shot::Jpeg($small, $quality)
        $iw = $small.Width
        $ih = $small.Height
      } catch { $jpeg = $null } finally {
        if ($null -ne $small -and -not [object]::ReferenceEquals($small, $bmp)) { $small.Dispose() }
      }
    }
    $bmp.Dispose()
    $bmp = $null

    # The lines: an OcrLine has no box of its own, so it is the union of its
    # words' boxes, moved from the picture's corner to the screen's. Read
    # until the budget is spent; what was read by then is answered. The list
    # is made with ::new(), not New-Object: a cmdlet outside the core would be
    # module-loaded on this runspace's first look, a tenth of a second of it.
    $lines = [System.Collections.Generic.List[string]]::new()
    # Where the title is drawn, as frames with no text: the title bar's band,
    # and every line dropped below for being the title. The device cuts the
    # picture below them (agent.js chromeBottom); it never sees those lines.
    $titleFrames = [System.Collections.Generic.List[string]]::new()
    if ($titleBand) { $titleFrames.Add($titleBand) }
    if ($null -ne $task) {
      $done = $false
      try { $done = $task.Wait([int][math]::Max(1, $budget - $reserve - $sw.ElapsedMilliseconds)) } catch { $ocr = 'failed' }
      if ($done) {
        $ocr = 'ok'
        try {
          foreach ($ln in $task.Result.Lines) {
            if ($lines.Count -ge $LINES_MAX) { break }
            if ($sw.ElapsedMilliseconds -ge $budget) { $ocr = 'partial'; break }
            $x0 = [double]::MaxValue; $y0 = [double]::MaxValue; $x1 = [double]::MinValue; $y1 = [double]::MinValue
            foreach ($wd in $ln.Words) {
              $r = $wd.BoundingRect
              if ($r.X -lt $x0) { $x0 = $r.X }
              if ($r.Y -lt $y0) { $y0 = $r.Y }
              if ($r.X + $r.Width -gt $x1) { $x1 = $r.X + $r.Width }
              if ($r.Y + $r.Height -gt $y1) { $y1 = $r.Y + $r.Height }
            }
            # The window's title, read off its title bar or tab, is never a
            # line; only where it was goes back.
            if ($shot::IsTitle($ln.Text, $titleKey)) {
              if ($titleFrames.Count -lt 8) { $b = $shot::Box($x0, $y0, $x1, $y1, $up, $frame[0], $frame[1]); if ($b) { $titleFrames.Add($b) } }
              continue
            }
            $j = $shot::Line($ln.Text, $x0, $y0, $x1, $y1, $up, $frame[0], $frame[1])
            if ($j) { $lines.Add($j) }
          }
        } catch { if ($lines.Count -eq 0) { $ocr = 'failed' } else { $ocr = 'partial' } }
        try { $sbm.Dispose() } catch {}
      }
    }

    $shot::Send($shot::Reply($idJson, $frame, $title, $lines.ToArray(), $titleFrames.ToArray(), $jpeg, $iw, $ih, $ocr, $sw.ElapsedMilliseconds))
    $sent = $true
  } catch {
  } finally {
    if (-not $sent) { try { $shot::Send($shot::Fail($idJson, 'exception')) } catch {} }
    if ($null -ne $bmp) { try { $bmp.Dispose() } catch {} }
  }
}

# Finished workers, ended and disposed, so the pool's bookkeeping does not grow
# with every look.
function TzLookReap {
  for ($i = $script:looks.Count - 1; $i -ge 0; $i--) {
    $j = $script:looks[$i]
    if ($j.async.IsCompleted) {
      try { [void]$j.ps.EndInvoke($j.async) } catch {}
      try { $j.ps.Dispose() } catch {}
      $script:looks.RemoveAt($i)
    }
  }
}

function TzLookRun([object[]]$argv) {
  $psh = [powershell]::Create()
  $psh.RunspacePool = $script:lookPool
  # In a scope of its own ($true), not dot-sourced into the runspace's global
  # one: the pool's runspaces live as long as the helper, and what the worker
  # left there (the window's pixels as a BMP, its JPEG, the decoded bitmap)
  # would be kept, a window's worth per runspace, until the next look landed
  # on it. All a worker keeps for the next is in $kit.shared.
  [void]$psh.AddScript($TZ_LOOK_WORKER, $true)
  foreach ($a in $argv) { [void]$psh.AddArgument($a) }
  $script:looks.Add(@{ ps = $psh; async = $psh.BeginInvoke() })
}

# The engine made in the background as the helper starts.
function TzLookWarm {
  if ($null -eq $script:lookPool -or $null -eq $script:lookKit -or $null -eq $script:lookKit.winrt) { return }
  try { TzLookRun @($script:lookKit, $true) } catch {}
}

# Start a look; its worker answers the line. Answered here, at once, only when
# there is nothing to look at, or no time left to look. The window is the one
# in front NOW, its handle, frame and title read on this thread before the
# worker starts.
function TzLookBegin($id, $msg) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  if (-not $script:lookReady) { return @{ id = $id; ok = $false; error = 'no_capture' } }
  $hwnd = [TzAgent]::GetForegroundWindow()
  if ($hwnd -eq [IntPtr]::Zero) { return @{ id = $id; ok = $false; error = 'no_window' } }
  $frame = [TzShot]::Frame($hwnd)
  if ($null -eq $frame) { return @{ id = $id; ok = $false; error = 'no_window' } }
  # The title for the device's own checks, capped as the snapshot's is
  # (TzTitleCap); and whole, as a key, for the worker to keep it out of the
  # lines (TzShot.IsTitle).
  $whole = ''
  try { $whole = TzClean ([TzAgent]::WindowTitle($hwnd)) $TITLE_READ } catch {}
  $title = TzTitleCap $whole
  $titleKey = [TzShot]::Key($whole)
  # The title bar's band, read now with the frame it is measured against.
  $titleBand = $null
  try { $titleBand = [TzShot]::TitleBand($hwnd, $frame) } catch {}

  # The options, kept sane whatever is sent.
  $budget = $LOOK_BUDGET_MS
  $b = 0
  if ($msg.budgetMs -ne $null -and [int]::TryParse("$($msg.budgetMs)", [ref]$b) -and $b -gt 0) { $budget = $b }
  if ($budget -lt 100) { $budget = 100 } elseif ($budget -gt 10000) { $budget = 10000 }
  # When the driver stops waiting, by the clock both sides read. This loop
  # reads one line at a time, so a look can sit behind a snapshot's walk
  # while the driver's clock runs: the budget is cut to what is left, less
  # what the driver allows for outside it, and a look the driver has given
  # up on is not made at all.
  $dl = 0.0
  if ($msg.deadline -ne $null -and [double]::TryParse("$($msg.deadline)", [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$dl) -and $dl -gt 0) {
    $left = [long]$dl - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $LOOK_MARGIN_MS
    if ($left -lt 100) { return @{ id = $id; ok = $false; error = 'timeout' } }
    if ($budget -gt $left) { $budget = [int]$left }
  }
  $maxSide = $LOOK_MAX_SIDE
  $m = 0
  if ($msg.maxSide -ne $null -and [int]::TryParse("$($msg.maxSide)", [ref]$m) -and $m -gt 0) { $maxSide = $m }
  if ($maxSide -lt 64) { $maxSide = 64 } elseif ($maxSide -gt 4096) { $maxSide = 4096 }
  # 0..1 as the driver sends it, or a percentage.
  $quality = $LOOK_QUALITY
  $q = 0.0
  if ($msg.quality -ne $null -and [double]::TryParse("$($msg.quality)", [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$q) -and $q -gt 0) {
    if ($q -le 1) { $q = $q * 100 }
    $quality = [int][math]::Round($q)
  }
  if ($quality -lt 10) { $quality = 10 } elseif ($quality -gt 100) { $quality = 100 }
  $wantOcr = -not ($msg.ocr -eq $false)
  $wantImage = -not ($msg.image -eq $false)
  $idJson = 'null'
  try { $idJson = ConvertTo-Json -InputObject $id -Compress } catch {}

  TzLookReap
  $argv = @($script:lookKit, $false, $idJson, $hwnd, $frame, $title, $budget, $maxSide, $quality, $wantOcr, $wantImage, $sw, $titleKey, $titleBand)
  if ($null -ne $script:lookPool) {
    TzLookRun $argv
  } else {
    # No pool (it would not open): the look runs here and the loop waits for
    # it, which is slower but still answers within the budget.
    $null = & $TZ_LOOK_WORKER @argv
  }
  return $null
}

# ---- Caret ----------------------------------------------------------------------
# Where the caret and its text box are, for the peek (peek-spec §A): asked
# every few hundred milliseconds while the user dictates, answered with two
# rectangles and the app, never any text. Read and answered by TzCaret's own
# threads, so this loop goes on reading lines meanwhile and a snapshot asked
# beside it is not held up; a caret line that waited behind a walk past the
# driver's time is answered "timeout" here, not read late.
$CARET_MS = 250
# What an answer spends outside the read: the line written, and read.
$CARET_MARGIN_MS = 30
# The app's name and pid as JSON, by window and process: Get-Process and a
# file's version resource on every peek would be most of its time.
$script:caretApps = @{}

function TzCaretApp([IntPtr]$h, [uint32]$procId) {
  $key = "$h/$procId"
  if ($script:caretApps.ContainsKey($key)) { return $script:caretApps[$key] }
  if ($script:caretApps.Count -ge 64) { $script:caretApps.Clear() }
  $appJson = ConvertTo-Json -InputObject ([ordered]@{ name = (TzAppName $h $procId); pid = [int]$procId }) -Compress
  $script:caretApps[$key] = $appJson
  return $appJson
}

# Start a caret read; its threads answer the line. Answered here, at once,
# only when it cannot be read: no C#, nothing in front, no time left, or a
# read still out (an app that stopped answering).
function TzCaretBegin($id, $msg) {
  if (-not $script:caretReady) { return @{ id = $id; ok = $false; error = 'no_caret' } }
  $h = [TzAgent]::GetForegroundWindow()
  if ($h -eq [IntPtr]::Zero) { return @{ id = $id; ok = $false; error = 'no_window' } }
  [uint32]$procId = 0
  [void][TzAgent]::GetWindowThreadProcessId($h, [ref]$procId)
  $appJson = TzCaretApp $h $procId
  $budget = $CARET_MS
  $b = 0
  if ($msg.budgetMs -ne $null -and [int]::TryParse("$($msg.budgetMs)", [ref]$b) -and $b -gt 0) { $budget = $b }
  if ($budget -lt 50) { $budget = 50 } elseif ($budget -gt 5000) { $budget = 5000 }
  # Cut to what the driver has left by the clock both sides read, after the
  # name was had; given up on already, it is not read at all.
  $dl = 0.0
  if ($msg.deadline -ne $null -and [double]::TryParse("$($msg.deadline)", [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$dl) -and $dl -gt 0) {
    $left = [long]$dl - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $CARET_MARGIN_MS
    if ($left -lt 20) { return @{ id = $id; ok = $false; error = 'timeout' } }
    if ($budget -gt $left) { $budget = [int]$left }
  }
  $idJson = 'null'
  try { $idJson = ConvertTo-Json -InputObject $id -Compress } catch {}
  $err = [TzCaret]::Begin($idJson, $appJson, $budget)
  if ($null -ne $err) { return @{ id = $id; ok = $false; error = "$err" } }
  return $null
}

# ---- The loop -------------------------------------------------------------------
function TzReply($obj) {
  $json = ''
  try { $json = ConvertTo-Json -InputObject $obj -Compress -Depth 6 } catch { $json = '{"ok":false,"error":"encode"}' }
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

# Snapshot answers through a placeholder token, so its elements are always a
# JSON array even when there are zero or one of them (Windows PowerShell's
# ConvertTo-Json collapses a one-element array to a bare object otherwise).
function TzReplySnapshot($id, $snap) {
  if (-not $snap.ok) { $snap.id = $id; TzReply $snap; return }
  $els = $snap.elements
  $tok = '@@ELS_' + [guid]::NewGuid().ToString('N') + '@@'
  $resp = [ordered]@{
    id = $id; ok = $true; app = $snap.app; window = $snap.window; focused = $snap.focused
    selection = $snap.selection; scale = $snap.scale; elements = $tok; truncated = $snap.truncated; ms = $snap.ms
  }
  $body = ConvertTo-Json -InputObject $resp -Compress -Depth 6
  $parts = foreach ($e in $els) { ConvertTo-Json -InputObject $e -Compress -Depth 4 }
  $arr = '[' + ($parts -join ',') + ']'
  $body = $body.Replace('"' + $tok + '"', $arr)
  [Console]::Out.WriteLine($body)
  [Console]::Out.Flush()
}

try { [Console]::InputEncoding = [Text.Encoding]::UTF8 } catch {}
[Console]::OutputEncoding = [Text.Encoding]::UTF8
TzLookWarm

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  if ($line.Trim() -eq '') { continue }

  $msg = $null
  try { $msg = $line | ConvertFrom-Json } catch {}
  if ($msg -eq $null -or -not $msg.cmd) {
    $mid = $null; try { $mid = $msg.id } catch {}
    TzReply @{ id = $mid; ok = $false; error = 'malformed' }
    continue
  }

  $id = $msg.id
  $cmd = "$($msg.cmd)"
  try {
    switch ($cmd) {
      'ping' { TzReply @{ id = $id; ok = $true; pong = $true; dpi = $script:dpi; look = [bool]$script:lookReady; ocr = ($null -ne $script:winrt); pool = ($null -ne $script:lookPool); caret = [bool]$script:caretReady }; break }
      'trusted' { TzReply @{ id = $id; ok = $true; trusted = $true }; break }

      'snapshot' {
        $max = 250
        if ($msg.max -ne $null) { [void][int]::TryParse("$($msg.max)", [ref]$max) }
        if ($max -le 0) { $max = 250 }
        # The walk's time budget (see TzSnapshot), kept sane whatever is sent.
        $budget = $BUDGET_MS
        $b = 0
        if ($msg.budgetMs -ne $null -and [int]::TryParse("$($msg.budgetMs)", [ref]$b) -and $b -gt 0) { $budget = $b }
        if ($budget -lt 50) { $budget = 50 } elseif ($budget -gt 30000) { $budget = 30000 }
        TzReplySnapshot $id (TzSnapshot $max $budget)
        break
      }

      'press' {
        $el = TzFind "$($msg.target)"
        if ($el -eq $null) { TzReply @{ id = $id; ok = $false; error = 'bad_target' }; break }
        if (TzElevated (TzElPid $el)) { TzReply @{ id = $id; ok = $false; error = 'elevated' }; break }
        $r = TzPress $el; $r.id = $id; TzReply $r; break
      }

      'click' {
        $el = TzFind "$($msg.target)"
        if ($el -eq $null) { TzReply @{ id = $id; ok = $false; error = 'bad_target' }; break }
        if (TzElevated (TzElPid $el)) { TzReply @{ id = $id; ok = $false; error = 'elevated' }; break }
        $r = TzClickEl $el (TzRootOf "$($msg.target)"); $r.id = $id; TzReply $r; break
      }

      'setValue' {
        $el = TzFind "$($msg.target)"
        if ($el -eq $null) { TzReply @{ id = $id; ok = $false; error = 'bad_target' }; break }
        if (TzElevated (TzElPid $el)) { TzReply @{ id = $id; ok = $false; error = 'elevated' }; break }
        $r = TzSetValue $el "$($msg.text)"; $r.id = $id; TzReply $r; break
      }

      'focus' {
        $el = TzFind "$($msg.target)"
        if ($el -eq $null) { TzReply @{ id = $id; ok = $false; error = 'bad_target' }; break }
        if (TzElevated (TzElPid $el)) { TzReply @{ id = $id; ok = $false; error = 'elevated' }; break }
        try { $el.SetFocus(); TzReply @{ id = $id; ok = $true } } catch { TzReply @{ id = $id; ok = $false; error = 'focus_failed' } }
        break
      }

      'scroll' {
        $dir = "$($msg.dir)"
        if ($dir -notmatch '^(up|down|left|right)$') { TzReply @{ id = $id; ok = $false; error = 'bad_dir' }; break }
        $lines = 3
        if ($msg.lines -ne $null) { [void][int]::TryParse("$($msg.lines)", [ref]$lines) }
        if ($lines -le 0) { $lines = 3 }
        if ($msg.target) {
          $el = TzFind "$($msg.target)"
          if ($el -eq $null) { TzReply @{ id = $id; ok = $false; error = 'bad_target' }; break }
          if (TzElevated (TzElPid $el)) { TzReply @{ id = $id; ok = $false; error = 'elevated' }; break }
          $r = TzScrollEl $el $dir $lines; $r.id = $id; TzReply $r; break
        } else {
          if (TzElevated (TzForegroundPid)) { TzReply @{ id = $id; ok = $false; error = 'elevated' }; break }
          TzWheel $dir $lines
          TzReply @{ id = $id; ok = $true; how = 'wheel' }; break
        }
      }

      'key' {
        $chord = "$($msg.chord)"
        if ([string]::IsNullOrWhiteSpace($chord)) { TzReply @{ id = $id; ok = $false; error = 'bad_key' }; break }
        # A chord goes to whatever is in front; the device keeps the app there.
        # UIPI drops it silently into an elevated window, and a lost foreground
        # would send it nowhere useful — refuse both rather than type blind.
        if (TzElevated (TzForegroundPid)) { TzReply @{ id = $id; ok = $false; error = 'elevated' }; break }
        if ([TzAgent]::GetForegroundWindow() -eq [IntPtr]::Zero) { TzReply @{ id = $id; ok = $false; error = 'not_foreground' }; break }
        $r = TzKey $chord; $r.id = $id; TzReply $r; break
      }

      'open' {
        $r = TzOpen "$($msg.app)"; $r.id = $id; TzReply $r; break
      }

      'look' {
        # Answered by its worker when it is done (see TzLookBegin); here only
        # when there is nothing to look at.
        $r = TzLookBegin $id $msg
        if ($null -ne $r) { TzReply $r }
        break
      }

      'caret' {
        # Answered by its own threads (see TzCaretBegin); here only when it
        # cannot be read.
        $r = TzCaretBegin $id $msg
        if ($null -ne $r) { TzReply $r }
        break
      }

      default { TzReply @{ id = $id; ok = $false; error = 'unknown_cmd' }; break }
    }
  } catch {
    # Whatever UI Automation or Win32 threw, the line is still answered.
    TzReply @{ id = $id; ok = $false; error = 'exception' }
  }
}

# stdin closed: the app is done with us. Run as command text, the exit code
# would otherwise be whatever the last statement left in $?, and a clean end
# should read as one.
exit 0
