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
# conventions (an Add-Type C# block for Win32, $ErrorActionPreference, UTF-8
# output, launched with -File and windowsHide by the Node side) mirror
# frontApp.js's PowerShell, so the two read the same to anyone who knows one.

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

# UI Automation control types onto the contract's roles. Anything not here is
# dropped, except a Pane/Group/Custom that has a name AND can be invoked, which
# is a clickable thing worth pointing at, so it is kept as a button.
$ROLES = @{
  'ControlType.Button' = 'button'; 'ControlType.SplitButton' = 'button';
  'ControlType.Hyperlink' = 'link';
  'ControlType.Edit' = 'field'; 'ControlType.Document' = 'area';
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
$MAX_NODES = 4000

# The id -> AutomationElement maps: the latest snapshot's, and the one before
# it, so an action on an id from the last-but-one snapshot still finds its
# element (the device may act on what it last saw while a new walk is running).
$script:mapCur = @{}
$script:mapPrev = @{}

function TzFind($id) {
  if ($id -ne $null -and $script:mapCur.ContainsKey($id)) { return $script:mapCur[$id] }
  if ($id -ne $null -and $script:mapPrev.ContainsKey($id)) { return $script:mapPrev[$id] }
  return $null
}

function TzGP($el, $prop) { try { return $el.GetCachedPropertyValue($prop) } catch { return $null } }

function TzRect($el) {
  try { $r = $el.Cached.BoundingRectangle; if ($r) { return $r } } catch {}
  try { return $el.Current.BoundingRectangle } catch {}
  return $null
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

# ---- Snapshot -------------------------------------------------------------------
function TzSnapshot([int]$max) {
  $o = [ordered]@{ ok = $false }
  if (-not $uia) { $o.error = 'no_uia'; return $o }
  $sw = [System.Diagnostics.Stopwatch]::StartNew()

  $h = [TzAgent]::GetForegroundWindow()
  if ($h -eq [IntPtr]::Zero) { $o.error = 'no_window'; return $o }
  [uint32]$procId = 0
  [void][TzAgent]::GetWindowThreadProcessId($h, [ref]$procId)

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
        if ($count -ge $max -or $visited -ge $MAX_NODES) { $truncated = $true; break }
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
            if ($v -is [string] -and $v.Length -gt 0) { $item.value = (TzClean $v $VAL_MAX) }
          }

          $els.Add($item)
        }

        # Its children, next level. One FindAll, all of them cached.
        try {
          $kids = $el.FindAll($TS::Children, $cond)
          if ($kids -ne $null) { foreach ($k in $kids) { $next.Add(@{ el = $k; pct = $ctName }) } }
        } catch {}
      }
      if ($count -ge $max -or $visited -ge $MAX_NODES) { $truncated = $true; break }
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
        $vp = $null
        if ($fe.TryGetCurrentPattern($VP::Pattern, [ref]$vp)) { $ro = [bool]$vp.Current.IsReadOnly }
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

  $window = $null
  if ($winRect) { $window = @{ frame = @([int][math]::Round($winRect.X), [int][math]::Round($winRect.Y), [int][math]::Round($winRect.Width), [int][math]::Round($winRect.Height)) } }

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
  $p = $null
  $how = $null
  if ($el.TryGetCurrentPattern($IP::Pattern, [ref]$p)) { $how = 'invoke' }
  elseif ($el.TryGetCurrentPattern($TOG::Pattern, [ref]$p)) { $how = 'toggle' }
  elseif ($el.TryGetCurrentPattern($SIP::Pattern, [ref]$p)) { $how = 'select' }
  elseif ($el.TryGetCurrentPattern($ECP::Pattern, [ref]$p)) { $how = 'expand' }
  else { return @{ ok = $false; error = 'no_action' } }

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

# The top-level window handle an element lives in, for the foreground check.
function TzTopWindow($el) {
  try {
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $n = $el
    for ($i = 0; $i -lt 20 -and $n -ne $null; $i++) {
      $wh = 0; try { $wh = $n.Current.NativeWindowHandle } catch {}
      $isWin = $false; try { $isWin = ("$($n.Current.ControlType.ProgrammaticName)" -eq 'ControlType.Window') } catch {}
      if ($isWin -and $wh -ne 0) { return [IntPtr]$wh }
      $parent = $null; try { $parent = $walker.GetParent($n) } catch {}
      if ($parent -eq $null) { break }
      $n = $parent
    }
    $wh = 0; try { $wh = $el.Current.NativeWindowHandle } catch {}
    if ($wh -ne 0) { return [IntPtr]$wh }
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

function TzClickEl($el) {
  $r = TzRect $el
  if ($r -eq $null) { return @{ ok = $false; error = 'no_rect' } }
  if (-not (TzEnsureForeground (TzTopWindow $el))) { return @{ ok = $false; error = 'not_foreground' } }
  $cx = [int][math]::Round($r.X + $r.Width / 2)
  $cy = [int][math]::Round($r.Y + $r.Height / 2)
  [void][TzAgent]::SetCursorPos($cx, $cy)
  [TzAgent]::Click()
  return @{ ok = $true }
}

function TzSetValue($el, [string]$text) {
  try { $el.SetFocus() } catch {}
  $vp = $null
  if ($el.TryGetCurrentPattern($VP::Pattern, [ref]$vp)) {
    if ($vp.Current.IsReadOnly) { return @{ ok = $false; error = 'read_only' } }
    $vp.SetValue($text)
    return @{ ok = $true }
  }
  return @{ ok = $false; error = 'no_value' }
}

function TzScrollEl($el, [string]$dir, [int]$lines) {
  $sp = $null
  if ($el.TryGetCurrentPattern($SCP::Pattern, [ref]$sp)) {
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
  # No scroll pattern: the wheel over the element's centre.
  $r = TzRect $el
  if ($r -ne $null) { [void][TzAgent]::SetCursorPos([int][math]::Round($r.X + $r.Width / 2), [int][math]::Round($r.Y + $r.Height / 2)) }
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
  $ext = $EXT -contains $keyTok
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
  [TzAgent]::Key([uint16]$keyVk, $false, $ext)
  [TzAgent]::Key([uint16]$keyVk, $true, $ext)
  for ($i = $modVks.Count - 1; $i -ge 0; $i--) { [TzAgent]::Key([uint16]$modVks[$i], $true, $false) }
  return @{ ok = $true }
}

# ---- Open an app ----------------------------------------------------------------
function TzOpen([string]$name) {
  if ([string]::IsNullOrWhiteSpace($name)) { return @{ ok = $false; error = 'no_app' } }
  $launched = $false
  # Start-Process resolves an executable, an App Path, or a PATH entry directly.
  try { Start-Process $name -ErrorAction Stop; $launched = $true } catch {}
  if (-not $launched) {
    # Otherwise it is a display name: find its Start Menu shortcut by name,
    # exact first, then a loose contains, case-insensitive.
    $dirs = @("$env:ProgramData\Microsoft\Windows\Start Menu\Programs", "$env:APPDATA\Microsoft\Windows\Start Menu\Programs")
    $exact = $null; $loose = $null
    foreach ($d in $dirs) {
      if (-not (Test-Path $d)) { continue }
      foreach ($lnk in Get-ChildItem -Path $d -Recurse -Filter *.lnk -ErrorAction SilentlyContinue) {
        if ($lnk.BaseName -ieq $name) { $exact = $lnk; break }
        if ($loose -eq $null -and $lnk.BaseName -like "*$name*") { $loose = $lnk }
      }
      if ($exact) { break }
    }
    $pick = if ($exact) { $exact } else { $loose }
    if ($pick) { try { Start-Process $pick.FullName -ErrorAction Stop; $launched = $true } catch {} }
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
      'ping' { TzReply @{ id = $id; ok = $true; pong = $true }; break }
      'trusted' { TzReply @{ id = $id; ok = $true; trusted = $true }; break }

      'snapshot' {
        $max = 250
        if ($msg.max -ne $null) { [void][int]::TryParse("$($msg.max)", [ref]$max) }
        if ($max -le 0) { $max = 250 }
        TzReplySnapshot $id (TzSnapshot $max)
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
        $r = TzClickEl $el; $r.id = $id; TzReply $r; break
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

      default { TzReply @{ id = $id; ok = $false; error = 'unknown_cmd' }; break }
    }
  } catch {
    # Whatever UI Automation or Win32 threw, the line is still answered.
    TzReply @{ id = $id; ok = $false; error = 'exception' }
  }
}
