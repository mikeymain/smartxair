// Settings model: defaults, validation (every value clamped, so a hand-edited or corrupt file never breaks the app),
// profiles, presets and share codes.
const fs = require('node:fs');
const path = require('node:path');
const { normalizeExe, parseCombo } = require('./logic.cjs');

const STYLES = ['cross', 'crossDot', 'tShape', 'dot', 'circle', 'circleDot', 'circleCross'];
const AIM_MODES = ['always', 'hideWhileAiming', 'onlyWhileAiming'];

const DEFAULT_CROSSHAIR = Object.freeze({
  style: 'crossDot', color: '#00ff8c', length: 6, gap: 4, thickness: 2, dotSize: 2, circleRadius: 10,
  outline: true, outlineThickness: 1, outlineColor: '#000000', opacity: 100, offsetX: 0, offsetY: 0
});

const PRESETS = Object.freeze([
  { name: 'Classic', crosshair: { ...DEFAULT_CROSSHAIR } },
  { name: 'Micro dot', crosshair: { ...DEFAULT_CROSSHAIR, style: 'dot', dotSize: 3, color: '#ff3b5c' } },
  { name: 'Ring', crosshair: { ...DEFAULT_CROSSHAIR, style: 'circleDot', circleRadius: 9, thickness: 1, dotSize: 2, color: '#ffffff' } },
  { name: 'Tee', crosshair: { ...DEFAULT_CROSSHAIR, style: 'tShape', length: 8, gap: 3, color: '#ffd23f' } },
  { name: 'Scope', crosshair: { ...DEFAULT_CROSSHAIR, style: 'circleCross', circleRadius: 16, length: 9, gap: 2, thickness: 1, color: '#00e5ff' } }
]);

function defaults() {
  return {
    version: 2,
    enabled: true,
    activeProfile: 'p1',
    profiles: [{ id: 'p1', name: 'Main', crosshair: { ...DEFAULT_CROSSHAIR } }],
    detection: {
      games: ['TheDivision2'],
      forceBorderless: true,       // Division 2 has no borderless mode; run it Windowed and this does the rest.
      autoFullscreen: false,
      hideWhenCursorVisible: true,
      requireMouseLock: true,      // measured in Division 2: mouse locked to centre in play, free in map/menus
      hideOnSoftwareCursor: false, // see SoftCursorTracker: misfires on raw-input games
      aimMode: 'always',
      aimKey: 'RButton',
      toggleHotkey: 'F8',
      showDelayMs: 120,
      debugLog: false
    },
    app: { launchAtLogin: false, startMinimized: false }
  };
}

const int = (v, def, min, max) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const bool = (v, def) => (typeof v === 'boolean' ? v : def);
const color = (v, def) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : def);
const oneOf = (v, list, def) => (list.includes(v) ? v : def);
const text = (v, def, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : def);

function cleanCrosshair(c = {}) {
  c ??= {};
  const d = DEFAULT_CROSSHAIR;
  return {
    style: oneOf(c.style, STYLES, d.style),
    color: color(c.color, d.color),
    length: int(c.length, d.length, 0, 100),
    gap: int(c.gap, d.gap, 0, 100),
    thickness: int(c.thickness, d.thickness, 1, 20),
    dotSize: int(c.dotSize, d.dotSize, 1, 30),
    circleRadius: int(c.circleRadius, d.circleRadius, 2, 150),
    outline: bool(c.outline, d.outline),
    outlineThickness: int(c.outlineThickness, d.outlineThickness, 1, 6),
    outlineColor: color(c.outlineColor, d.outlineColor),
    opacity: int(c.opacity, d.opacity, 5, 100),
    offsetX: int(c.offsetX, d.offsetX, -500, 500),
    offsetY: int(c.offsetY, d.offsetY, -500, 500)
  };
}

function cleanDetection(x = {}) {
  x ??= {};
  const d = defaults().detection;
  const games = Array.isArray(x.games)
    ? [...new Map(x.games.map(normalizeExe).filter(Boolean).map(g => [g.toLowerCase(), g])).values()].slice(0, 50)
    : d.games;
  const combo = (v, def) => (typeof v === 'string' && parseCombo(v) ? v : def);
  return {
    games,
    forceBorderless: bool(x.forceBorderless, d.forceBorderless),
    autoFullscreen: bool(x.autoFullscreen, d.autoFullscreen),
    hideWhenCursorVisible: bool(x.hideWhenCursorVisible, d.hideWhenCursorVisible),
    requireMouseLock: bool(x.requireMouseLock, d.requireMouseLock),
    hideOnSoftwareCursor: bool(x.hideOnSoftwareCursor, d.hideOnSoftwareCursor),
    aimMode: oneOf(x.aimMode, AIM_MODES, d.aimMode),
    aimKey: combo(x.aimKey, d.aimKey),
    toggleHotkey: combo(x.toggleHotkey, d.toggleHotkey),
    showDelayMs: int(x.showDelayMs, d.showDelayMs, 0, 2000),
    debugLog: bool(x.debugLog, d.debugLog)
  };
}

function clean(raw) {
  const d = defaults();
  const s = raw && typeof raw === 'object' ? raw : {};
  let profiles = Array.isArray(s.profiles) ? s.profiles.slice(0, 30).map((p, i) => ({
    id: text(p && p.id, 'p' + (i + 1), 40).replace(/[^\w-]/g, '') || 'p' + (i + 1),
    name: text(p && p.name, 'Crosshair ' + (i + 1), 32),
    crosshair: cleanCrosshair(p && p.crosshair)
  })) : d.profiles;
  // Ids must be unique or selecting one would pick the wrong profile.
  const seen = new Set();
  profiles = profiles.filter(p => !seen.has(p.id) && seen.add(p.id));
  if (!profiles.length) profiles = d.profiles;
  const active = profiles.some(p => p.id === s.activeProfile) ? s.activeProfile : profiles[0].id;
  return {
    version: 2,
    enabled: bool(s.enabled, d.enabled),
    activeProfile: active,
    profiles,
    detection: cleanDetection(s.detection),
    app: {
      launchAtLogin: bool(s.app && s.app.launchAtLogin, d.app.launchAtLogin),
      startMinimized: bool(s.app && s.app.startMinimized, d.app.startMinimized)
    }
  };
}

const activeCrosshair = (s) => (s.profiles.find(p => p.id === s.activeProfile) || s.profiles[0]).crosshair;

function load(file) {
  // Strip a BOM: Notepad and PowerShell 5 add one when the file is edited by hand.
  try { return clean(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))); }
  catch (error) {
    if (error.code !== 'ENOENT') console.error('Settings unreadable, using defaults:', error.message);
    return defaults();
  }
}

// The app was called SmartReticle. Copy its settings on first run under the new name; never overwrite.
/** @returns {boolean} true if the old file was copied */
function adopt(oldFile, newFile) {
  if (fs.existsSync(newFile) || !fs.existsSync(oldFile)) return false;
  fs.mkdirSync(path.dirname(newFile), { recursive: true });
  fs.copyFileSync(oldFile, newFile);
  return true;
}

// Write-then-rename so a crash mid-save cannot leave half a file.
function save(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, file);
}

// ---- share codes --------------------------------------------------------

function toShareCode(crosshair) {
  return 'SR2-' + Buffer.from(JSON.stringify(cleanCrosshair(crosshair))).toString('base64url');
}

// Also reads SR1 codes from the first (C#) version: base64 of "key=value;key=value" with PascalCase styles.
function fromShareCode(code) {
  const s = String(code || '').trim();
  try {
    if (s.startsWith('SR2-')) {
      const crosshair = JSON.parse(Buffer.from(s.slice(4), 'base64url').toString('utf8'));
      return crosshair === null ? null : cleanCrosshair(crosshair);
    }
    if (s.startsWith('SR1-')) {
      const pairs = Buffer.from(s.slice(4), 'base64').toString('utf8').split(';');
      const o = {};
      for (const pair of pairs) {
        const i = pair.indexOf('=');
        if (i > 0) o[pair.slice(0, i)] = pair.slice(i + 1);
      }
      if (o.style) o.style = o.style[0].toLowerCase() + o.style.slice(1);
      o.outline = o.outline === '1';
      return cleanCrosshair(o);
    }
  } catch { /* fall through: not a valid code */ }
  return null;
}

module.exports = {
  STYLES, AIM_MODES, DEFAULT_CROSSHAIR, PRESETS, defaults, clean, cleanCrosshair, cleanDetection,
  activeCrosshair, load, save, adopt, toShareCode, fromShareCode
};
