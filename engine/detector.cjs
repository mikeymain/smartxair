// One evaluation per tick: is the crosshair wanted right now, and where is the game's centre?
// Uses only public window/cursor state (see win32.cjs).
const win = require('./win32.cjs');
const { SoftCursorTracker, decide, isTinyClip, isListedGame, NON_GAMES, DIVISION_2_EXE } = require('./logic.cjs');

const NAME_CACHE_MS = 30000;
const MISS_REFRESH_MS = 1000; // a pid that never resolves must not force a full snapshot every tick
const DESKTOP_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd']);

class Detector {
  constructor(ownPid) {
    this.ownPid = ownPid;
    this.names = new Map();
    this.namesAt = 0;
    this.missedAt = new Map();
    this.soft = new SoftCursorTracker();
  }

  processName(pid) {
    const now = Date.now();
    const stale = now - this.namesAt > NAME_CACHE_MS;
    // A first miss usually means a newly started game, so refresh at once; repeat misses for the same pid wait.
    const retry = !this.names.has(pid) && now - (this.missedAt.get(pid) || 0) > MISS_REFRESH_MS;
    if (stale || retry) {
      this.names = win.processNames();
      this.namesAt = now;
      if (this.missedAt.size > 64) this.missedAt.clear();
      this.missedAt.set(pid, now);
    }
    if (this.names.has(pid)) return this.names.get(pid);
    return '?';
  }

  isFullscreenGame(hwnd, name) {
    if (NON_GAMES.has(name.toLowerCase())) return false;
    if (hwnd === win.shellWindow() || DESKTOP_CLASSES.has(win.className(hwnd))) return false;
    const w = win.windowRect(hwnd), m = win.monitorRect(hwnd);
    return !!(w && m && w.left <= m.left && w.top <= m.top && w.right >= m.right && w.bottom >= m.bottom
      && (win.getStyle(hwnd) & win.WS.CAPTION) !== win.WS.CAPTION);
  }

  /** @returns {{show:boolean, reason:string, process:string, window:number, center:{x,y}|null, ...signals}} */
  evaluate(detection, aiming) {
    const r = {
      show: false, reason: '', process: '', window: 0, center: null,
      cursorShown: false, clipped: false, clipSize: '', distance: 0, softMenu: false, aiming: !!aiming
    };
    const hwnd = win.foregroundWindow();
    if (!hwnd) return { ...r, reason: 'no focused window' };
    const pid = win.windowPid(hwnd);
    if (pid === this.ownPid) return { ...r, reason: 'SmartXair focused', own: true };
    const name = this.processName(pid);
    if (win.isMinimized(hwnd)) return { ...r, process: name, reason: 'game minimised' };
    const listed = isListedGame(name, detection.games);
    if (name === '?' || (!listed && !(detection.autoFullscreen && this.isFullscreenGame(hwnd, name)))) {
      return { ...r, process: name, reason: 'tabbed out / not a game' };
    }
    const compatibility = listed && (detection.compatibilityForListedGames || name.toLowerCase() === DIVISION_2_EXE.toLowerCase());
    const forceBorderless = compatibility && detection.forceBorderless;

    const center = win.clientCenter(hwnd);
    if (!center) return { ...r, process: name, window: hwnd, forceBorderless, reason: 'game window has no client area' };

    const c = win.cursor() || { shown: false, pos: this.soft.last };
    const clip = win.clipRect();
    const clipped = !!clip && isTinyClip(clip);
    const softMenu = this.soft.update({ window: hwnd, pos: c.pos, center, cursorShown: c.shown, clipped });
    const verdict = decide({ detection, cursorShown: c.shown, softMenu, aiming, clipped,
      requireMouseLock: compatibility && detection.requireMouseLock });
    return {
      ...r, ...verdict, process: name, window: hwnd, center, forceBorderless,
      cursorShown: c.shown, clipped, softMenu,
      clipSize: clip ? `${clip.right - clip.left}x${clip.bottom - clip.top}` : '',
      distance: Math.round(Math.hypot(c.pos.x - center.x, c.pos.y - center.y))
    };
  }
}

function describe(r) {
  return `${r.show ? 'SHOW' : 'HIDE'} (${r.reason}) fg=${r.process} cursorShown=${r.cursorShown} clipped=${r.clipped} ` +
    `clip=${r.clipSize} distFromCentre=${r.distance} softMenu=${r.softMenu} aiming=${r.aiming}` +
    (r.center ? ` center=${r.center.x},${r.center.y}` : '');
}

module.exports = { Detector, describe };
