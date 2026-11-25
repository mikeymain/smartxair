// Win32 through koffi. Read-only queries about windows, the cursor and keys, plus window-style changes for
// force-borderless. Nothing here opens, injects into or reads another process's memory.
const path = require('node:path');
const koffi = require('koffi');

const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const user32 = koffi.load(path.join(sys32, 'user32.dll'));
const kernel32 = koffi.load(path.join(sys32, 'kernel32.dll'));

const POINT = koffi.struct('SR_POINT', { x: 'int32', y: 'int32' });
const RECT = koffi.struct('SR_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const CURSORINFO = koffi.struct('SR_CURSORINFO', { cbSize: 'uint32', flags: 'uint32', hCursor: 'intptr_t', pt: POINT });
const MONITORINFO = koffi.struct('SR_MONITORINFO', { cbSize: 'uint32', rcMonitor: RECT, rcWork: RECT, dwFlags: 'uint32' });
const PROCESSENTRY32W = koffi.struct('SR_PROCESSENTRY32W', {
  dwSize: 'uint32', cntUsage: 'uint32', th32ProcessID: 'uint32', th32DefaultHeapID: 'uintptr_t',
  th32ModuleID: 'uint32', cntThreads: 'uint32', th32ParentProcessID: 'uint32', pcPriClassBase: 'int32',
  dwFlags: 'uint32', szExeFile: koffi.array('char16_t', 260, 'String')
});

const GetForegroundWindow = user32.func('intptr_t __stdcall GetForegroundWindow()');
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr_t hWnd, _Out_ uint32 *pid)');
const IsIconic = user32.func('bool __stdcall IsIconic(intptr_t hWnd)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(intptr_t hWnd)');
const GetShellWindow = user32.func('intptr_t __stdcall GetShellWindow()');
const GetClassNameW = user32.func('int __stdcall GetClassNameW(intptr_t hWnd, void *name, int max)');
const GetWindowTextLengthW = user32.func('int __stdcall GetWindowTextLengthW(intptr_t hWnd)');
const GetClientRect = user32.func('bool __stdcall GetClientRect(intptr_t hWnd, _Out_ SR_RECT *rect)');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(intptr_t hWnd, _Out_ SR_RECT *rect)');
const ClientToScreen = user32.func('bool __stdcall ClientToScreen(intptr_t hWnd, _Inout_ SR_POINT *pt)');
const GetCursorInfo = user32.func('bool __stdcall GetCursorInfo(_Inout_ SR_CURSORINFO *info)');
const GetClipCursor = user32.func('bool __stdcall GetClipCursor(_Out_ SR_RECT *rect)');
const GetAsyncKeyState = user32.func('int16 __stdcall GetAsyncKeyState(int vKey)');
const MonitorFromWindow = user32.func('intptr_t __stdcall MonitorFromWindow(intptr_t hWnd, uint32 flags)');
const GetMonitorInfoW = user32.func('bool __stdcall GetMonitorInfoW(intptr_t hMonitor, _Inout_ SR_MONITORINFO *info)');
const GetWindowLongW = user32.func('int32 __stdcall GetWindowLongW(intptr_t hWnd, int index)');
const SetWindowLongW = user32.func('int32 __stdcall SetWindowLongW(intptr_t hWnd, int index, int32 value)');
const SetWindowPos = user32.func('bool __stdcall SetWindowPos(intptr_t hWnd, intptr_t after, int x, int y, int cx, int cy, uint32 flags)');
const EnumWindowsProc = koffi.proto('bool __stdcall SR_EnumWindowsProc(intptr_t hWnd, intptr_t lParam)');
const EnumWindows = user32.func('bool __stdcall EnumWindows(SR_EnumWindowsProc *cb, intptr_t lParam)');

const CreateToolhelp32Snapshot = kernel32.func('intptr_t __stdcall CreateToolhelp32Snapshot(uint32 flags, uint32 pid)');
const Process32FirstW = kernel32.func('bool __stdcall Process32FirstW(intptr_t snap, _Inout_ SR_PROCESSENTRY32W *entry)');
const Process32NextW = kernel32.func('bool __stdcall Process32NextW(intptr_t snap, _Inout_ SR_PROCESSENTRY32W *entry)');
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(intptr_t h)');

const CURSOR_SHOWING = 1;
const MONITOR_DEFAULTTONEAREST = 2;
const TH32CS_SNAPPROCESS = 0x2;
const INVALID_HANDLE = -1;
const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;

const WS = {
  CAPTION: 0x00c00000, THICKFRAME: 0x00040000, SYSMENU: 0x00080000, MINIMIZEBOX: 0x00020000, MAXIMIZEBOX: 0x00010000
};
const WS_EX = {
  DLGMODALFRAME: 0x1, TRANSPARENT: 0x20, TOOLWINDOW: 0x80, WINDOWEDGE: 0x100, CLIENTEDGE: 0x200,
  STATICEDGE: 0x20000, LAYERED: 0x80000, NOACTIVATE: 0x08000000
};
const SWP = { NOSIZE: 0x1, NOMOVE: 0x2, NOACTIVATE: 0x10, FRAMECHANGED: 0x20, NOOWNERZORDER: 0x200 };

function foregroundWindow() { return GetForegroundWindow(); }

function windowPid(hwnd) {
  const pid = [0];
  GetWindowThreadProcessId(hwnd, pid);
  return pid[0];
}

function className(hwnd) {
  const buf = Buffer.alloc(128);
  const n = GetClassNameW(hwnd, buf, 64);
  return n > 0 ? buf.toString('utf16le', 0, n * 2) : '';
}

function clientCenter(hwnd) {
  const r = {};
  if (!GetClientRect(hwnd, r) || r.right <= 0 || r.bottom <= 0) return null;
  const pt = { x: Math.floor(r.right / 2), y: Math.floor(r.bottom / 2) };
  ClientToScreen(hwnd, pt);
  return pt;
}

function windowRect(hwnd) {
  const r = {};
  return GetWindowRect(hwnd, r) ? r : null;
}

function monitorRect(hwnd) {
  const mi = { cbSize: koffi.sizeof(MONITORINFO) };
  return GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), mi) ? mi.rcMonitor : null;
}

function cursor() {
  const ci = { cbSize: koffi.sizeof(CURSORINFO) };
  if (!GetCursorInfo(ci)) return null;
  return { shown: (ci.flags & CURSOR_SHOWING) !== 0 && ci.hCursor !== 0, pos: ci.pt };
}

function clipRect() {
  const r = {};
  return GetClipCursor(r) ? r : null;
}

const keyDown = (vk) => (GetAsyncKeyState(vk) & 0x8000) !== 0;
// Down now, or pressed since the previous poll: a tap shorter than the poll interval still counts once.
const keyHit = (vk) => (GetAsyncKeyState(vk) & 0x8001) !== 0;

// pid -> exe name (no ".exe"), from a process snapshot. Never opens the target process, so it still works
// when a game's anti-cheat or admin rights would refuse OpenProcess.
function processNames() {
  const names = new Map();
  const snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap === INVALID_HANDLE || snap === 0) return names;
  try {
    const entry = { dwSize: koffi.sizeof(PROCESSENTRY32W) };
    let ok = Process32FirstW(snap, entry);
    while (ok) {
      names.set(entry.th32ProcessID, String(entry.szExeFile).replace(/\.exe$/i, ''));
      entry.dwSize = koffi.sizeof(PROCESSENTRY32W);
      ok = Process32NextW(snap, entry);
    }
  } finally {
    CloseHandle(snap);
  }
  return names;
}

// Exe names of processes that own a visible, titled top-level window: the "add a running game" list.
function windowedProcessNames() {
  const pids = new Set();
  const cb = koffi.register((hwnd) => {
    if (IsWindowVisible(hwnd) && GetWindowTextLengthW(hwnd) > 0) pids.add(windowPid(hwnd));
    return true;
  }, koffi.pointer(EnumWindowsProc));
  try { EnumWindows(cb, 0); } finally { koffi.unregister(cb); }
  const names = processNames();
  return [...new Set([...pids].map(p => names.get(p)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

const getStyle = (hwnd) => GetWindowLongW(hwnd, GWL_STYLE) >>> 0;
const getExStyle = (hwnd) => GetWindowLongW(hwnd, GWL_EXSTYLE) >>> 0;
// LONG is signed 32-bit: `| 0` turns an unsigned style back into the int32 Windows expects.
const setStyle = (hwnd, v) => SetWindowLongW(hwnd, GWL_STYLE, v | 0);
const setExStyle = (hwnd, v) => SetWindowLongW(hwnd, GWL_EXSTYLE, v | 0);
const setPos = (hwnd, x, y, w, h, flags, after = 0) => SetWindowPos(hwnd, after, x, y, w, h, flags);

module.exports = {
  foregroundWindow, windowPid, className, clientCenter, windowRect, monitorRect, cursor, clipRect, keyDown, keyHit,
  isMinimized: (h) => IsIconic(h), shellWindow: () => GetShellWindow(), processNames, windowedProcessNames,
  getStyle, getExStyle, setStyle, setExStyle, setPos, WS, WS_EX, SWP
};
