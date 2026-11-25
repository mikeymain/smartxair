// Pure decision logic, kept apart from Win32 so it can be tested with plain `node --test`.

// px: a hidden cursor this close to the game centre means the game is recentring it (gameplay).
const RECENTER_RADIUS = 24;
// px per tick that counts as the cursor moving.
const MOVE_THRESHOLD = 3;
// px: a clip rect this small means the game has locked the mouse (gameplay).
const TINY_CLIP = 64;
const DIVISION_2_EXE = 'TheDivision2';

// Hides at once, so a menu never flashes the crosshair; shows only once "in game" has held for `delayMs`.
class VisibilityGate {
  constructor() { this.since = null; this.visible = false; }
  update(wantShow, delayMs, now) {
    if (!wantShow) { this.since = null; this.visible = false; return false; }
    if (this.since === null) this.since = now;
    if (now - this.since >= delayMs) this.visible = true;
    return this.visible;
  }
}

// Catches menus where the game hides the Windows cursor and draws its own: the hidden cursor roams.
// Off by default in settings, because raw-input games that clip to the window without recentring look the same.
class SoftCursorTracker {
  constructor() { this.last = { x: 0, y: 0 }; this.menu = false; this.window = 0; }
  update({ window, pos, center, cursorShown, clipped }) {
    if (window !== this.window) { this.menu = false; this.window = window; }
    const dx = pos.x - center.x, dy = pos.y - center.y;
    const nearCenter = dx * dx + dy * dy <= RECENTER_RADIUS * RECENTER_RADIUS;
    const mx = pos.x - this.last.x, my = pos.y - this.last.y;
    const moved = mx * mx + my * my >= MOVE_THRESHOLD * MOVE_THRESHOLD;
    this.last = { x: pos.x, y: pos.y };
    if (cursorShown || clipped || nearCenter) this.menu = false;
    else if (moved) this.menu = true;
    return this.menu;
  }
}

// The rules applied in order once the game is known to be focused.
function decide({ detection, cursorShown, softMenu, aiming, clipped, requireMouseLock = detection.requireMouseLock }) {
  if (detection.hideWhenCursorVisible && cursorShown) return { show: false, reason: 'menu: cursor visible' };
  // Division 2 locks the mouse to a zero-size rect at the screen centre during play and frees it in the map and
  // menus, even while it hides the cursor for map dragging. Measured in-game; the most reliable menu signal.
  if (requireMouseLock && !clipped) return { show: false, reason: 'menu: mouse not locked' };
  if (detection.hideOnSoftwareCursor && softMenu) return { show: false, reason: 'menu: game-drawn cursor moving' };
  if (detection.aimMode === 'hideWhileAiming' && aiming) return { show: false, reason: 'aiming (hide while aiming)' };
  if (detection.aimMode === 'onlyWhileAiming' && !aiming) return { show: false, reason: 'not aiming (only while aiming)' };
  return { show: true, reason: 'in game' };
}

// Detection loop rates. Full rate only while a target game is focused or the crosshair is up, so menus still hide
// it within a frame. Elsewhere the loop only has to catch the toggle hotkey, which a 50 ms poll still sees.
const FAST_TICK_MS = 16;
const IDLE_TICK_MS = 50;

function nextTickMs({ gameFocused, visible }) {
  return gameFocused || visible ? FAST_TICK_MS : IDLE_TICK_MS;
}

// Zero-size counts: Division 2 clips to the single point at the screen centre ([960,540,960,540]).
function isTinyClip(clip) {
  const w = clip.right - clip.left, h = clip.bottom - clip.top;
  return w >= 0 && h >= 0 && w <= TINY_CLIP && h <= TINY_CLIP;
}

// "C:\Games\TheDivision2.exe" -> "TheDivision2"
function normalizeExe(value) {
  let s = String(value || '').trim();
  if (!s) return '';
  s = s.split(/[\\/]/).pop();
  return s.replace(/\.exe$/i, '');
}

// Apps that cover the screen but are not games; only consulted by auto-fullscreen mode.
const NON_GAMES = new Set([
  'explorer', 'chrome', 'msedge', 'firefox', 'brave', 'opera', 'vlc', 'mpc-hc64', 'potplayermini64',
  'applicationframehost', 'searchhost', 'shellexperiencehost', 'startmenuexperiencehost', 'lockapp',
  'discord', 'steamwebhelper', 'obs64', 'electron', 'smartxair', 'smartreticle', 'cursorlab'
]);

function isListedGame(processName, games) {
  const p = String(processName).toLowerCase();
  return games.some(g => g.toLowerCase() === p);
}

// ---- keys ---------------------------------------------------------------

const NAMED_KEYS = {
  lbutton: 0x01, rbutton: 0x02, mbutton: 0x04, xbutton1: 0x05, xbutton2: 0x06,
  backspace: 0x08, tab: 0x09, enter: 0x0d, shift: 0x10, ctrl: 0x11, control: 0x11, alt: 0x12,
  pause: 0x13, capslock: 0x14, escape: 0x1b, space: 0x20, pageup: 0x21, pagedown: 0x22, end: 0x23,
  home: 0x24, left: 0x25, up: 0x26, right: 0x27, down: 0x28, insert: 0x2d, delete: 0x2e,
  backquote: 0xc0, minus: 0xbd, equal: 0xbb
};

function keyCode(name) {
  const k = String(name).trim().toLowerCase();
  if (!k) return 0;
  if (Object.hasOwn(NAMED_KEYS, k)) return NAMED_KEYS[k];
  let m = /^f([1-9]|1\d|2[0-4])$/.exec(k);
  if (m) return 0x6f + Number(m[1]);
  m = /^num([0-9])$/.exec(k);
  if (m) return 0x60 + Number(m[1]);
  if (/^[a-z]$/.test(k)) return k.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(k)) return k.charCodeAt(0);
  return 0;
}

// "Ctrl+Shift+X" -> [0x11, 0x10, 0x58]; null when any part is unknown.
function parseCombo(text) {
  const parts = String(text || '').split('+').map(p => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const codes = parts.map(keyCode);
  return codes.every(Boolean) ? codes : null;
}

// Edge detector so a held hotkey toggles once.
class ComboWatcher {
  constructor(codes) { this.codes = codes; this.wasDown = false; }
  isDown(readKey) { return !!this.codes && this.codes.every(c => readKey(c)); }
  pressed(readKey) {
    const down = this.isDown(readKey);
    const edge = down && !this.wasDown;
    this.wasDown = down;
    return edge;
  }
}

module.exports = {
  VisibilityGate, SoftCursorTracker, decide, isTinyClip, normalizeExe, isListedGame, NON_GAMES,
  keyCode, parseCombo, ComboWatcher, RECENTER_RADIUS, TINY_CLIP, nextTickMs, FAST_TICK_MS, IDLE_TICK_MS, DIVISION_2_EXE
};
