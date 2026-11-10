const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const L = require('../engine/logic.cjs');
const store = require('../engine/settings.cjs');
const Crosshair = require('../renderer/crosshair-draw.js');

const det = (over = {}) => ({ ...store.defaults().detection, ...over });

test('normalizeExe strips path and .exe', () => {
  assert.equal(L.normalizeExe('C:\\Games\\TheDivision2.exe'), 'TheDivision2');
  assert.equal(L.normalizeExe('   '), '');
});

test('Division 2 is the default game, force-borderless on, game-cursor rule off', () => {
  const d = store.defaults().detection;
  assert.deepEqual(d.games, ['TheDivision2']);
  assert.equal(d.forceBorderless, true);
  assert.equal(d.hideOnSoftwareCursor, false);
});

test('share code SR2 round-trips', () => {
  const c = { ...store.DEFAULT_CROSSHAIR, style: 'circleCross', gap: 7, color: '#ff0a14', opacity: 55 };
  const back = store.fromShareCode(store.toShareCode(c));
  assert.equal(back.style, 'circleCross');
  assert.equal(back.gap, 7);
  assert.equal(back.opacity, 55);
  assert.equal(back.color, '#ff0a14');
});

test('share code from the C# version (SR1) still loads', () => {
  const sr1 = 'SR1-' + Buffer.from('style=CircleDot;gap=5;color=#FF0000;outline=0').toString('base64');
  const c = store.fromShareCode(sr1);
  assert.equal(c.style, 'circleDot');
  assert.equal(c.gap, 5);
  assert.equal(c.color, '#ff0000');
  assert.equal(c.outline, false);
});

test('bad and corrupt share codes are rejected', () => {
  assert.equal(store.fromShareCode('garbage'), null);
  assert.equal(store.fromShareCode('SR2-!!!notbase64'), null);
});

test('settings values are clamped and junk is ignored', () => {
  const s = store.clean({ profiles: [{ id: 'a', name: 'x', crosshair: { gap: 9999, thickness: -5, style: 'nope', outline: false, color: 'red' } }] });
  const c = s.profiles[0].crosshair;
  assert.equal(c.gap, 100);
  assert.equal(c.thickness, 1);
  assert.equal(c.style, 'crossDot');
  assert.equal(c.outline, false);
  assert.equal(c.color, store.DEFAULT_CROSSHAIR.color);
});

test('clean() survives garbage input and duplicate profile ids', () => {
  assert.deepEqual(store.clean(null), store.defaults());
  const s = store.clean({ activeProfile: 'zzz', profiles: [{ id: 'a' }, { id: 'a' }, { id: 'b' }] });
  assert.deepEqual(s.profiles.map(p => p.id), ['a', 'b']);
  assert.equal(s.activeProfile, 'a');
});

test('invalid hotkeys fall back to defaults; games are de-duplicated', () => {
  const d = store.cleanDetection({ toggleHotkey: 'NotAKey', aimKey: 'XButton2', games: ['a.exe', 'A', 'b'] });
  assert.equal(d.toggleHotkey, 'F8');
  assert.equal(d.aimKey, 'XButton2');
  assert.deepEqual(d.games, ['A', 'b']);
});

test('settings save and load round-trip on disk', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-')), 'settings.json');
  const s = store.clean({ ...store.defaults(), detection: det({ aimMode: 'onlyWhileAiming' }) });
  store.save(file, s);
  assert.deepEqual(store.load(file), s);
});

test('old SmartReticle settings are copied once and never overwrite new ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-'));
  const oldFile = path.join(dir, 'smartreticle', 'settings.json');
  const newFile = path.join(dir, 'smartxair', 'settings.json');
  assert.equal(store.adopt(oldFile, newFile), false);
  store.save(oldFile, store.defaults());
  assert.equal(store.adopt(oldFile, newFile), true);
  assert.deepEqual(store.load(newFile), store.defaults());
  fs.writeFileSync(newFile, '{"enabled":false}');
  assert.equal(store.adopt(oldFile, newFile), false);
  assert.equal(store.load(newFile).enabled, false);
});

test('key combos parse', () => {
  assert.deepEqual(L.parseCombo('F8'), [0x77]);
  assert.deepEqual(L.parseCombo('Ctrl+Shift+X'), [0x11, 0x10, 0x58]);
  assert.deepEqual(L.parseCombo('RButton'), [0x02]);
  assert.deepEqual(L.parseCombo('Num5'), [0x65]);
  assert.equal(L.parseCombo('NotAKey'), null);
  assert.equal(L.parseCombo(''), null);
});

test('hotkey toggles once per press', () => {
  const w = new L.ComboWatcher([0x77]);
  let down = false;
  const read = () => down;
  assert.equal(w.pressed(read), false);
  down = true;
  assert.equal(w.pressed(read), true);
  assert.equal(w.pressed(read), false); // still held
  down = false;
  assert.equal(w.pressed(read), false);
});

test('visibility gate: delayed show, instant hide, delay restarts', () => {
  const g = new L.VisibilityGate();
  assert.equal(g.update(true, 120, 0), false);
  assert.equal(g.update(true, 120, 100), false);
  assert.equal(g.update(true, 120, 130), true);
  assert.equal(g.update(false, 120, 140), false);
  assert.equal(g.update(true, 120, 150), false);
});

test('decide: menu, game cursor, aim modes (mouse locked, as in gameplay)', () => {
  const play = (detection, over) => L.decide({ detection, cursorShown: false, softMenu: false, aiming: false, clipped: true, ...over });
  assert.equal(play(det(), { cursorShown: true }).show, false);
  assert.equal(play(det(), { softMenu: true }).show, true); // rule off by default
  assert.equal(play(det({ hideOnSoftwareCursor: true }), { softMenu: true }).show, false);
  assert.equal(play(det({ aimMode: 'hideWhileAiming' }), { aiming: true }).show, false);
  assert.equal(play(det({ aimMode: 'onlyWhileAiming' }), {}).show, false);
  assert.equal(play(det(), {}).reason, 'in game');
});

test('soft-cursor tracker: roaming = menu, recentred or locked = gameplay, resets on new window', () => {
  const t = new L.SoftCursorTracker();
  const center = { x: 500, y: 500 };
  const step = (x, extra = {}) => t.update({ window: 1, pos: { x, y: 500 }, center, cursorShown: false, clipped: false, ...extra });
  assert.equal(step(500), false);
  assert.equal(step(700), true);   // moved far from centre
  assert.equal(step(700), true);   // sticky while it rests in the menu
  assert.equal(step(505), false);  // game recentred it
  step(800);
  assert.equal(t.update({ window: 2, pos: { x: 800, y: 500 }, center, cursorShown: false, clipped: false }), false);
  assert.equal(step(900, { clipped: true }), false);
});

test('mouse-lock rule: Division 2 map drag (cursor hidden, mouse free) hides; gameplay (locked) shows', () => {
  const d = det();
  assert.equal(d.requireMouseLock, true);
  // Recorded in game: dragging the map hides the Windows cursor but leaves the clip at the whole desktop.
  assert.deepEqual(L.decide({ detection: d, cursorShown: false, softMenu: false, aiming: false, clipped: false }),
    { show: false, reason: 'menu: mouse not locked' });
  assert.equal(L.decide({ detection: d, cursorShown: false, softMenu: false, aiming: false, clipped: true }).show, true);
  assert.equal(L.decide({ detection: det({ requireMouseLock: false }), cursorShown: false, softMenu: false, aiming: false, clipped: false }).show, true);
});

test('loop runs at full rate only with the game focused or the crosshair up', () => {
  assert.equal(L.nextTickMs({ gameFocused: true, visible: false }), L.FAST_TICK_MS);
  assert.equal(L.nextTickMs({ gameFocused: false, visible: true }), L.FAST_TICK_MS);
  assert.equal(L.nextTickMs({ gameFocused: false, visible: false }), L.IDLE_TICK_MS);
  assert.ok(L.IDLE_TICK_MS > L.FAST_TICK_MS);
});

test('tiny clip detection', () => {
  assert.equal(L.isTinyClip({ left: 960, top: 540, right: 960, bottom: 540 }), true); // Division 2 gameplay
  assert.equal(L.isTinyClip({ left: -1920, top: 0, right: 1920, bottom: 1080 }), false); // Division 2 map
  assert.equal(L.isTinyClip({ left: 10, top: 10, right: 11, bottom: 11 }), true);
  assert.equal(L.isTinyClip({ left: 0, top: 0, right: 1920, bottom: 1080 }), false);
});

// ---- drawing ----

const bounds = (list) => list.filter(s => s.kind === 'rect');

test('every style produces shapes and a sane extent', () => {
  for (const style of store.STYLES) {
    const c = { ...store.DEFAULT_CROSSHAIR, style };
    assert.ok(Crosshair.shapes(c, 0).length > 0, style);
    assert.ok(Crosshair.extent(c) > 0, style);
  }
});

test('cross with a gap leaves the centre empty and arms are symmetric', () => {
  for (const thickness of [1, 2, 3]) {
    const c = { ...store.DEFAULT_CROSSHAIR, style: 'cross', gap: 4, thickness, outline: false };
    const rects = bounds(Crosshair.shapes(c, 0));
    const covers = (x, y) => rects.some(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
    assert.equal(covers(0, 0), false, 'centre empty at thickness ' + thickness);
    const [right, left] = rects;
    // Symmetric about the centre block's middle (pixel 0 for odd thickness, the 0|-1 seam for even).
    const mid = -Math.floor(thickness / 2) + thickness / 2;
    assert.equal(right.x - mid, mid - (left.x + left.w), 'symmetric at thickness ' + thickness);
    assert.equal(right.w, left.w);
  }
});

test('T shape has no top arm; outline pass grows every shape', () => {
  const c = { ...store.DEFAULT_CROSSHAIR, style: 'tShape', gap: 3 };
  assert.equal(bounds(Crosshair.shapes(c, 0)).length, 3);
  const [a] = Crosshair.shapes(c, 0), [b] = Crosshair.shapes(c, 2);
  assert.equal(b.w, a.w + 4);
  assert.equal(b.x, a.x - 2);
});

const covers = (rects, x, y) => rects.some(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);

test('dot covers the centre pixel', () => {
  for (const dotSize of [1, 2, 3, 4, 7]) {
    const c = { ...store.DEFAULT_CROSSHAIR, style: 'dot', dotSize };
    assert.ok(covers(bounds(Crosshair.shapes(c, 0)), 0, 0), 'size ' + dotSize);
  }
});

test('dot is round: full width through the middle, corners cut, symmetric', () => {
  for (const dotSize of [3, 4, 5, 8, 12]) {
    const c = { ...store.DEFAULT_CROSSHAIR, style: 'dot', dotSize, outline: false };
    const rects = bounds(Crosshair.shapes(c, 0));
    const x0 = -Math.floor(dotSize / 2), x1 = x0 + dotSize - 1; // square the old dot filled
    assert.ok(covers(rects, x0, 0) && covers(rects, x1, 0), 'full middle row at ' + dotSize);
    assert.equal(covers(rects, x0, x0), false, 'top-left corner cut at ' + dotSize);
    assert.equal(covers(rects, x1, x1), false, 'bottom-right corner cut at ' + dotSize);
    const rows = rects.map(r => r.w);
    assert.deepEqual(rows, [...rows].reverse(), 'symmetric rows at ' + dotSize);
    assert.equal(rects.length, dotSize, 'one row per pixel at ' + dotSize);
  }
});
