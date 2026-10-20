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
# a line that is not JSON is answered {"ok":false,"error":"malformed"}. The one
# exception to the order is "look" (the window's pixels and the text in them),
# which is answered by its own thread when it is done, so the snapshot asked at
# the same moment is not kept waiting behind it; the driver matches answers by
# id, so the order was never what it relied on. The
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

# PIXELS FOR "LOOK": the window in front captured from the screen, made into a
# JPEG for the picture path, and handed to Windows' own OCR for the text in it,
# each line where it is on screen. This is its own Add-Type, apart from
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
public static class TzShot {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);

  const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
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

  // The screen's pixels where the window is, as the user sees them: whatever
  // is over the window is in them too, Tailzu's own guide included unless
  // its content protection is on (desktop.guide.contentProtection, off by
  // default). A locked or secure desktop throws, and the caller answers
  // capture_failed.
  public static Bitmap Capture(int[] f) {
    Bitmap bmp = new Bitmap(f[2], f[3], PixelFormat.Format32bppArgb);
    try {
      using (Graphics g = Graphics.FromImage(bmp)) {
        g.CopyFromScreen(f[0], f[1], 0, 0, new Size(f[2], f[3]), CopyPixelOperation.SourceCopy);
      }
    } catch (Exception) {
      bmp.Dispose();
      throw;
    }
    return bmp;
  }

  // A copy no longer than maxSide on its long side, or the same bitmap when it
  // already fits. Bicubic, because the picture path exists for what is small
  // and drawn (an equation, a chart's labels) and has to stay legible.
  public static Bitmap Fit(Bitmap src, int maxSide) {
    int w = src.Width, h = src.Height;
    int longest = Math.Max(w, h);
    if (maxSide <= 0 || longest <= maxSide) return src;
    double k = (double)maxSide / longest;
    int nw = Math.Max(1, (int)Math.Round(w * k)), nh = Math.Max(1, (int)Math.Round(h * k));
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
  // count, nor the ellipsis an app puts where it cut a title short.
  public static string Key(string s) {
    if (string.IsNullOrEmpty(s)) return "";
    StringBuilder sb = new StringBuilder(s.Length);
    foreach (char c in s) { if (!char.IsWhiteSpace(c)) sb.Append(char.ToLowerInvariant(c)); }
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
  public static string Reply(string idJson, int[] frame, string title, string[] lines, string jpeg, int width, int height, string ocr, long ms) {
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

  $appName = ''
  try {
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($p) { $appName = $p.ProcessName; try { $d = $p.MainModule.FileVersionInfo.FileDescription; if ($d) { $appName = $d } } catch {} }
  } catch {}

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

# The worker, run in the look pool (TzOpenLookPool). It is handed everything
# it uses, since a runspace of its own shares no variables or functions with
# this one, and it writes its own answer line: the reader loop is meanwhile
# blocked reading the next command and could not. $budget bounds the part that
# waits (the OCR and the reading of its lines); the capture and the JPEG are
# quick and run to the end. Whatever happens, the line is answered.
$TZ_LOOK_WORKER = {
  param($kit, $warm, $idJson, $frame, $title, $budget, $maxSide, $quality, $wantOcr, $wantImage, $sw, $titleKey)
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
    try { $bmp = $shot::Capture($frame) } catch { $bmp = $null }
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
    if ($null -ne $task) {
      $done = $false
      try { $done = $task.Wait([int][math]::Max(1, $budget - $reserve - $sw.ElapsedMilliseconds)) } catch { $ocr = 'failed' }
      if ($done) {
        $ocr = 'ok'
        try {
          foreach ($ln in $task.Result.Lines) {
            if ($lines.Count -ge $LINES_MAX) { break }
            if ($sw.ElapsedMilliseconds -ge $budget) { $ocr = 'partial'; break }
            # The window's title, read off its title bar or tab, is never a line.
            if ($shot::IsTitle($ln.Text, $titleKey)) { continue }
            $x0 = [double]::MaxValue; $y0 = [double]::MaxValue; $x1 = [double]::MinValue; $y1 = [double]::MinValue
            foreach ($wd in $ln.Words) {
              $r = $wd.BoundingRect
              if ($r.X -lt $x0) { $x0 = $r.X }
              if ($r.Y -lt $y0) { $y0 = $r.Y }
              if ($r.X + $r.Width -gt $x1) { $x1 = $r.X + $r.Width }
              if ($r.Y + $r.Height -gt $y1) { $y1 = $r.Y + $r.Height }
            }
            $j = $shot::Line($ln.Text, $x0, $y0, $x1, $y1, $up, $frame[0], $frame[1])
            if ($j) { $lines.Add($j) }
          }
        } catch { if ($lines.Count -eq 0) { $ocr = 'failed' } else { $ocr = 'partial' } }
        try { $sbm.Dispose() } catch {}
      }
    }

    $shot::Send($shot::Reply($idJson, $frame, $title, $lines.ToArray(), $jpeg, $iw, $ih, $ocr, $sw.ElapsedMilliseconds))
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
  [void]$psh.AddScript($TZ_LOOK_WORKER)
  foreach ($a in $argv) { [void]$psh.AddArgument($a) }
  $script:looks.Add(@{ ps = $psh; async = $psh.BeginInvoke() })
}

# The engine made in the background as the helper starts.
function TzLookWarm {
  if ($null -eq $script:lookPool -or $null -eq $script:lookKit -or $null -eq $script:lookKit.winrt) { return }
  try { TzLookRun @($script:lookKit, $true) } catch {}
}

# Start a look; its worker answers the line. Answered here, at once, only when
# there is nothing to look at. The window is the one in front NOW, its frame
# and title read on this thread before the worker starts.
function TzLookBegin($id, $msg) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  if (-not $script:lookReady) { return @{ id = $id; ok = $false; error = 'no_capture' } }
  $h = [TzAgent]::GetForegroundWindow()
  if ($h -eq [IntPtr]::Zero) { return @{ id = $id; ok = $false; error = 'no_window' } }
  $frame = [TzShot]::Frame($h)
  if ($null -eq $frame) { return @{ id = $id; ok = $false; error = 'no_window' } }
  # The title for the device's own checks, capped as the snapshot's is
  # (TzTitleCap); and whole, as a key, for the worker to keep it out of the
  # lines (TzShot.IsTitle).
  $whole = ''
  try { $whole = TzClean ([TzAgent]::WindowTitle($h)) $TITLE_READ } catch {}
  $title = TzTitleCap $whole
  $titleKey = [TzShot]::Key($whole)

  # The options, kept sane whatever is sent.
  $budget = $LOOK_BUDGET_MS
  $b = 0
  if ($msg.budgetMs -ne $null -and [int]::TryParse("$($msg.budgetMs)", [ref]$b) -and $b -gt 0) { $budget = $b }
  if ($budget -lt 100) { $budget = 100 } elseif ($budget -gt 10000) { $budget = 10000 }
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
  $argv = @($script:lookKit, $false, $idJson, $frame, $title, $budget, $maxSide, $quality, $wantOcr, $wantImage, $sw, $titleKey)
  if ($null -ne $script:lookPool) {
    TzLookRun $argv
  } else {
    # No pool (it would not open): the look runs here and the loop waits for
    # it, which is slower but still answers within the budget.
    $null = & $TZ_LOOK_WORKER @argv
  }
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
      'ping' { TzReply @{ id = $id; ok = $true; pong = $true; dpi = $script:dpi; look = [bool]$script:lookReady; ocr = ($null -ne $script:winrt); pool = ($null -ne $script:lookPool) }; break }
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
