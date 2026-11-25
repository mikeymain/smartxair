const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const store = require('../engine/settings.cjs');

function loadModule(file, overrides, globals = {}) {
  const filename = path.join(__dirname, '..', file);
  const localRequire = createRequire(filename);
  const context = {
    module: { exports: {} }, __dirname: path.dirname(filename), console,
    require: id => Object.hasOwn(overrides, id) ? overrides[id] : localRequire(id),
    ...globals
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return context.module.exports;
}

test('null nested settings preserve valid sibling settings', () => {
  for (const patch of [{ detection: null }, { profiles: [null] }, { profiles: [{ crosshair: null }] }]) {
    const settings = store.clean({ ...patch, enabled: false, app: { startMinimized: true } });
    assert.equal(settings.enabled, false);
    assert.equal(settings.app.startMinimized, true);
    assert.deepEqual(settings.detection, store.defaults().detection);
    assert.deepEqual(settings.profiles[0].crosshair, store.DEFAULT_CROSSHAIR);
  }
});

test('a missing process name retries after one second despite frequent polls', () => {
  let now = 2000;
  let snapshots = 0;
  const { Detector } = loadModule('engine/detector.cjs', {
    './win32.cjs': { processNames: () => ++snapshots === 1 ? new Map() : new Map([[55, 'TheDivision2']]) }
  }, { Date: { now: () => now } });
  const detector = new Detector(1);
  for (; now <= 3000; now += 50) assert.equal(detector.processName(55), '?');
  assert.equal(snapshots, 1);
  assert.equal(detector.processName(55), 'TheDivision2');
  assert.equal(snapshots, 2);
});

test('holding the hotkey toggles once across settings updates and again after release', () => {
  let ready;
  let down = false;
  const handlers = new Map();
  const timers = new Map();
  let timerId = 0;
  const app = {
    requestSingleInstanceLock: () => true, on() {}, getPath: () => 'unused',
    whenReady: () => ({ then(callback) { ready = callback; } }),
    commandLine: { appendSwitch() {} }
  };
  class Window {
    setAlwaysOnTop() {} setIgnoreMouseEvents() {} loadFile() {} isDestroyed() { return false; }
    webContents = { once() {}, send() {} };
  }
  class Tray { setToolTip() {} setContextMenu() {} on() {} }
  loadModule('main.cjs', {
    electron: {
      app, BrowserWindow: Window, Tray, Menu: { buildFromTemplate: items => items },
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
      nativeImage: { createFromPath: () => ({ resize() {} }) }
    },
    './engine/settings.cjs': { ...store, load: store.defaults, adopt: () => false, save() {} },
    './engine/log.cjs': { createLog: () => () => {} },
    './engine/win32.cjs': { keyHit: () => down, keyDown: () => false },
    './engine/detector.cjs': { Detector: class { evaluate() { return { show: false, window: 0 }; } } },
    './engine/borderless.cjs': { BorderlessForcer: class {} }
  }, {
    process: { pid: 1, argv: ['node', 'main.cjs', '--minimized'] },
    setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout: id => timers.delete(id)
  });
  ready();
  const state = () => handlers.get('state:get')().settings;
  const poll = () => {
    const [id, timer] = [...timers].find(([, value]) => value.delay === 50);
    timers.delete(id);
    timer.fn();
  };
  down = true;
  poll();
  assert.equal(state().enabled, false);
  poll();
  assert.equal(state().enabled, false, 'a held key must not toggle again');
  handlers.get('settings:set')(null, { ...state(), detection: { ...state().detection, toggleHotkey: ' f8 ' } });
  poll();
  assert.equal(state().enabled, false, 'the same parsed combo must keep its held state');
  down = false;
  poll();
  down = true;
  poll();
  assert.equal(state().enabled, true);
});

test('the overlay shows on startup when a game is already focused', () => {
  let ready;
  let overlayLoaded;
  let poll;
  const messages = [];
  const app = {
    requestSingleInstanceLock: () => true, on() {}, getPath: () => 'unused',
    whenReady: () => ({ then(callback) { ready = callback; } }),
    commandLine: { appendSwitch() {} }
  };
  class Window {
    setAlwaysOnTop() {} setIgnoreMouseEvents() {} loadFile() {} isDestroyed() { return false; }
    setBounds() {} showInactive() {} getNativeWindowHandle() { return Buffer.from([1, 0, 0, 0]); }
    webContents = {
      once(event, callback) { if (event === 'did-finish-load') overlayLoaded = callback; },
      send(channel, value) { messages.push([channel, value]); }
    };
  }
  class Tray { setToolTip() {} setContextMenu() {} on() {} }
  const settings = store.defaults();
  settings.detection.showDelayMs = 0;
  settings.detection.forceBorderless = false;
  loadModule('main.cjs', {
    electron: {
      app, BrowserWindow: Window, Tray, Menu: { buildFromTemplate: items => items }, ipcMain: { handle() {} },
      nativeImage: { createFromPath: () => ({ resize() {} }) },
      screen: { screenToDipPoint: point => point, dipToScreenPoint: point => point }
    },
    './engine/settings.cjs': { ...store, load: () => settings, adopt: () => false },
    './engine/log.cjs': { createLog: () => () => {} },
    './engine/win32.cjs': { keyHit: () => false, keyDown: () => false, WS_EX: {}, SWP: {}, getExStyle: () => 0, setPos() {} },
    './engine/detector.cjs': { Detector: class { evaluate() { return { show: true, window: 1, center: { x: 320, y: 240 } }; } } },
    './engine/borderless.cjs': { BorderlessForcer: class {} }
  }, {
    process: { pid: 1, argv: ['node', 'main.cjs', '--minimized'] },
    setTimeout: callback => { poll = callback; }
  });
  ready();
  assert.deepEqual(messages, [], 'the renderer cannot receive overlay updates before loading');
  overlayLoaded();
  poll();
  assert.deepEqual(messages.map(([channel]) => channel), ['overlay:crosshair', 'overlay:place', 'overlay:visible']);
  assert.equal(messages[2][1], true);
});
