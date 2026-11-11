const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, clipboard } = require('electron');
const path = require('node:path');
const store = require('./engine/settings.cjs');
const { VisibilityGate, parseCombo, ComboWatcher, nextTickMs } = require('./engine/logic.cjs');
const { createLog } = require('./engine/log.cjs');

// The overlay must keep painting while the game, not us, has focus.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const OVERLAY_DIP = 400;        // overlay window edge; the crosshair is drawn inside it at the exact device pixel
const TOPMOST_EVERY_MS = 1000;  // borderless games can be topmost too

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Win32 is loaded only in the primary instance.
  const win = require('./engine/win32.cjs');
  const { Detector, describe } = require('./engine/detector.cjs');
  const { BorderlessForcer } = require('./engine/borderless.cjs');

  const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
  const logFile = () => path.join(app.getPath('userData'), 'debug.log');

  let settings;
  let log;
  let mainWindow = null;
  let overlay = null;
  let overlayHwnd = 0;
  let tray = null;
  let saveTimer = null;
  let toggleKey = null;
  let aimCodes = null;
  let lastLogged = '';
  let overlayState = { visible: false, key: '' };
  let lastTopmost = 0;

  const detector = new Detector(process.pid);
  const gate = new VisibilityGate();
  let borderless;

  const alive = (w) => Boolean(w && !w.isDestroyed());

  // ---- windows ----------------------------------------------------------

  // Built on demand and destroyed on close, so its renderer process only exists while the window is open.
  function createMainWindow() {
    const w = new BrowserWindow({
      width: 1120, height: 760, minWidth: 940, minHeight: 640, show: false,
      backgroundColor: '#0b0d0e', title: 'SmartXair', icon: appIcon(64), autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    w.setMenu(null);
    w.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    w.once('ready-to-show', () => w.show());
    // Closing keeps the overlay running from the tray; Quit is in the tray menu.
    w.on('closed', () => { if (mainWindow === w) mainWindow = null; });
    mainWindow = w;
  }

  function showMainWindow() {
    if (!alive(mainWindow)) createMainWindow();
    else { mainWindow.show(); if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  }

  function createOverlay() {
    overlay = new BrowserWindow({
      width: OVERLAY_DIP, height: OVERLAY_DIP, x: 0, y: 0,
      frame: false, transparent: true, resizable: false, movable: false, hasShadow: false,
      skipTaskbar: true, alwaysOnTop: true, focusable: false, show: false,
      webPreferences: {
        preload: path.join(__dirname, 'overlay-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true,
        backgroundThrottling: false
      }
    });
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.setIgnoreMouseEvents(true);
    overlay.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
    overlay.webContents.once('did-finish-load', () => { sendCrosshair(); overlay.showInactive(); hardenOverlay(); });
  }

  // If the overlay could take focus, the detector would read that as "tabbed out". Make sure it never can.
  function hardenOverlay() {
    const handle = overlay.getNativeWindowHandle();
    overlayHwnd = Number(handle.length >= 8 ? handle.readBigUInt64LE(0) : handle.readUInt32LE(0));
    const want = win.WS_EX.NOACTIVATE | win.WS_EX.TRANSPARENT | win.WS_EX.TOOLWINDOW | win.WS_EX.LAYERED;
    const ex = win.getExStyle(overlayHwnd);
    if ((ex & want) !== want) {
      win.setExStyle(overlayHwnd, (ex | want) >>> 0);
      log(`Overlay ex-style fixed: ${ex.toString(16)} -> ${win.getExStyle(overlayHwnd).toString(16)}`);
    }
  }

  function sendCrosshair() {
    if (!alive(overlay)) return;
    overlay.webContents.send('overlay:crosshair', store.activeCrosshair(settings));
    overlayState.key = ''; // force a re-place with the new drawing
  }

  // Win32 gives physical pixels; Electron places windows in DIP. Place the window near the aim point, then tell the
  // page exactly which device pixel inside it is the aim point, so rounding never shifts the crosshair.
  function placeOverlay(center, visible) {
    if (!alive(overlay)) return;
    const c = store.activeCrosshair(settings);
    const aim = center ? { x: center.x + c.offsetX, y: center.y + c.offsetY } : null;
    const key = visible && aim ? `${aim.x},${aim.y}` : 'hidden';
    if (key === overlayState.key && visible === overlayState.visible) return keepOnTop(visible);
    if (visible && aim) {
      const dip = screen.screenToDipPoint(aim);
      const bounds = { x: Math.round(dip.x - OVERLAY_DIP / 2), y: Math.round(dip.y - OVERLAY_DIP / 2), width: OVERLAY_DIP, height: OVERLAY_DIP };
      overlay.setBounds(bounds);
      const origin = screen.dipToScreenPoint({ x: bounds.x, y: bounds.y });
      overlay.webContents.send('overlay:place', { x: aim.x - origin.x, y: aim.y - origin.y });
    }
    if (visible !== overlayState.visible) overlay.webContents.send('overlay:visible', visible);
    overlayState = { visible, key };
    keepOnTop(visible);
  }

  function keepOnTop(visible) {
    if (!visible || !overlayHwnd || Date.now() - lastTopmost < TOPMOST_EVERY_MS) return;
    win.setPos(overlayHwnd, 0, 0, 0, 0, win.SWP.NOMOVE | win.SWP.NOSIZE | win.SWP.NOACTIVATE, -1);
    lastTopmost = Date.now();
  }

  // ---- tray -------------------------------------------------------------

  function appIcon(size) {
    return nativeImage.createFromPath(path.join(__dirname, 'assets', 'smartxair.png'))
      .resize({ width: size, height: size });
  }

  function refreshTray() {
    if (!tray) return;
    const d = settings.detection;
    tray.setToolTip(`SmartXair - ${settings.enabled ? 'on' : 'off'} (${d.toggleHotkey} toggles)`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open SmartXair', click: showMainWindow },
      { label: 'Overlay enabled', type: 'checkbox', checked: settings.enabled, click: () => setEnabled(!settings.enabled) },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ]));
  }

  // ---- settings ---------------------------------------------------------

  function applySettings() {
    const codes = parseCombo(settings.detection.toggleHotkey);
    if (!toggleKey || toggleKey.codes.join(',') !== codes.join(',')) toggleKey = new ComboWatcher(codes);
    aimCodes = parseCombo(settings.detection.aimKey);
    sendCrosshair();
    refreshTray();
    if (app.isPackaged) {
      // In development the login item would point at electron.exe, so only packaged builds register it.
      app.setLoginItemSettings({ openAtLogin: settings.app.launchAtLogin, args: ['--minimized'] });
    }
  }

  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { store.save(settingsFile(), settings); }
      catch (error) { log('Settings save failed: ' + error.message); }
    }, 250);
  }

  // `echo` tells the settings window about changes it did not make itself (hotkey, tray). Echoing its own edits
  // back would fight a slider mid-drag.
  function setSettings(next, echo) {
    settings = store.clean(next);
    applySettings();
    saveSoon();
    if (echo && alive(mainWindow)) mainWindow.webContents.send('settings:changed', settings);
    return settings;
  }

  function setEnabled(on) { setSettings({ ...settings, enabled: on }, true); }

  // ---- loop -------------------------------------------------------------

  /** @returns {boolean} true while a target game is focused */
  function tick() {
    if (toggleKey && toggleKey.pressed(win.keyHit)) setEnabled(!settings.enabled);
    const aiming = !!aimCodes && aimCodes.every(win.keyDown);

    const r = detector.evaluate(settings.detection, aiming);
    if (settings.detection.forceBorderless && r.window) borderless.tryApply(r.window);

    const visible = gate.update(settings.enabled && r.show, settings.detection.showDelayMs, Date.now());
    placeOverlay(r.center, visible);

    if (settings.detection.debugLog) {
      const key = [r.show, r.reason, r.process, r.cursorShown, r.softMenu, r.aiming, settings.enabled].join('|');
      if (key !== lastLogged) { log((settings.enabled ? '' : '[disabled] ') + describe(r)); lastLogged = key; }
    }
    return Boolean(r.window);
  }

  function loop() {
    let gameFocused = false;
    try { gameFocused = tick(); } catch (error) { log('Tick failed: ' + (error.stack || error.message)); }
    setTimeout(loop, nextTickMs({ gameFocused, visible: overlayState.visible }));
  }


  // ---- IPC --------------------------------------------------------------

  function registerIpc() {
    ipcMain.handle('state:get', () => ({
      settings, presets: store.PRESETS, styles: store.STYLES, version: require('./package.json').version, logFile: logFile(),
      packaged: app.isPackaged
    }));
    ipcMain.handle('settings:set', (_e, next) => setSettings(next, false));
    ipcMain.handle('share:copy', (_e, crosshair) => {
      const code = store.toShareCode(crosshair);
      clipboard.writeText(code);
      return code;
    });
    ipcMain.handle('share:paste', () => store.fromShareCode(clipboard.readText()));
    ipcMain.handle('games:running', () => {
      try { return win.windowedProcessNames(); } catch (error) { log('Window list failed: ' + error.message); return []; }
    });
  }

  // ---- start ------------------------------------------------------------

  // The app only ever shows its own two local pages: no popups, no navigation away.
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (e) => e.preventDefault());
  });  app.on('second-instance', showMainWindow);
  app.on('before-quit', () => {
    clearTimeout(saveTimer);
    try { store.save(settingsFile(), settings); } catch { /* best effort on the way out */ }
  });
  app.on('window-all-closed', (e) => e.preventDefault());

  app.whenReady().then(() => {
    log = createLog(logFile());
    borderless = new BorderlessForcer(log);
    try {
      const old = path.join(app.getPath('appData'), 'smartreticle', 'settings.json');
      if (store.adopt(old, settingsFile())) log('Settings copied from SmartReticle: ' + old);
    } catch (error) { log('Settings copy from SmartReticle failed: ' + error.message); }
    settings = store.load(settingsFile());
    registerIpc();
    tray = new Tray(appIcon(32));
    tray.on('click', showMainWindow);
    applySettings();
    createOverlay();
    const startHidden = process.argv.includes('--minimized') || settings.app.startMinimized;
    if (!startHidden) createMainWindow();
    loop();
  });
}
