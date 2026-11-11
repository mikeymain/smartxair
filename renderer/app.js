// Settings window. Local state is the source of truth while the user edits; every change is sent to the main
// process (which validates, saves and redraws the overlay). The main process only pushes settings back when they
// change from outside this window, e.g. the on/off hotkey.
const { el, slider, ruleRow, keyCapture, drawScene, SCENES } = window.UI;
const api = window.reticle;
const $ = (id) => document.getElementById(id);

const SWATCHES = ['#00ff8c', '#ff3b5c', '#ffffff', '#ffd23f', '#00e5ff', '#ff7ad9', '#8977ff', '#ff8a00'];
const STYLE_LABELS = { cross: 'Cross', crossDot: 'Cross + dot', tShape: 'T', dot: 'Dot', circle: 'Ring', circleDot: 'Ring + dot', circleCross: 'Scope' };
const ZOOMS = [1, 3, 6];

let S = null;          // settings
let meta = null;       // presets, styles, version
// Zoom 1 = actual size: one crosshair pixel per screen pixel, exactly what the overlay draws in game.
let view = { scene: 'Street', zoom: 1 };
const syncers = [];    // functions that push S into the controls

const crosshair = () => (S.profiles.find(p => p.id === S.activeProfile) || S.profiles[0]).crosshair;

// ---- immutable updates -----------------------------------------------------

// Slider drags fire many input events per frame; send only the latest settings once per frame and
// repaint once per frame. S itself is always updated immediately.
let pendingSend = null;
let syncQueued = false;
function flushSend() {
  const next = pendingSend;
  pendingSend = null;
  if (next) api.setSettings(next);
}
function queueSync() {
  if (syncQueued) return;
  syncQueued = true;
  requestAnimationFrame(() => { syncQueued = false; flushSend(); syncAll(); });
}
// The window is destroyed on close; send the last queued change before it goes.
window.addEventListener('pagehide', flushSend);
function commit(next) {
  S = next;
  pendingSend = next;
  queueSync();
}
const setCross = (patch) => commit({
  ...S,
  profiles: S.profiles.map(p => (p.id === S.activeProfile ? { ...p, crosshair: { ...p.crosshair, ...patch } } : p))
});
const setDetection = (patch) => commit({ ...S, detection: { ...S.detection, ...patch } });
const setApp = (patch) => commit({ ...S, app: { ...S.app, ...patch } });

function syncAll() { for (const fn of syncers) fn(); }

// Rebuild a list of DOM nodes only when its key changes, not on every slider tick.
function whenChanged(keyOf, rebuild) {
  let last = null;
  return () => { const k = keyOf(); if (k !== last) { last = k; rebuild(); } };
}

// ---- tabs -------------------------------------------------------------------

// Keep the tabs and their panels in sync.
const tabListeners = [];
function selectTab(name) {
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('current', t.dataset.tab === name);
    t.setAttribute('aria-selected', String(t.dataset.tab === name));
  });
  document.querySelectorAll('.pane').forEach(p => { p.hidden = p.dataset.pane !== name; });
  if (name === 'crosshair') drawPreview();
  tabListeners.forEach(fn => fn(name));
}
window.SmartXairTabs = {
  select: selectTab,
  onChange: (fn) => tabListeners.push(fn),
  list: () => [...document.querySelectorAll('.tab')].map(t => ({ name: t.dataset.tab, label: t.textContent }))
};

function initTabs() {
  for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => selectTab(tab.dataset.tab));
}

// ---- crosshair tab ------------------------------------------------------------

function chipGroup(container, items, isCurrent, onPick) {
  const buttons = items.map(item => {
    const b = el('button', { type: 'button', class: 'chip', text: item.label, onclick: () => onPick(item.value) });
    container.append(b);
    return { b, item };
  });
  return () => buttons.forEach(({ b, item }) => b.classList.toggle('current', isCurrent(item.value)));
}

const stamp = document.createElement('canvas'); // reused every redraw instead of allocating a canvas per frame

function drawPreview() {
  const canvas = $('preview');
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
  if (!w || !h) return;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext('2d');
  drawScene(ctx, w, h, view.scene);

  // Draw at true pixel size off-screen, then scale up without smoothing so the zoom shows real pixels.
  const c = crosshair();
  const e = window.Crosshair.extent(c);
  const size = e * 2 + 1;
  const off = stamp;
  off.width = size; off.height = size; // resizing also clears it
  window.Crosshair.draw(off.getContext('2d'), c, e, e);
  const z = view.zoom; // 1 = true size: one crosshair pixel per screen pixel
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = c.opacity / 100;
  const cx = Math.floor(w / 2) + c.offsetX * z, cy = Math.floor(h / 2) + c.offsetY * z;
  ctx.drawImage(off, Math.round(cx - e * z), Math.round(cy - e * z), size * z, size * z);
  ctx.globalAlpha = 1;

  // Say so when the preview is magnified, so nobody tunes the size against a zoomed view.
  const label = z === 1 ? 'ACTUAL SIZE' : `ZOOM ${z}×`;
  drawGlassPill(ctx, label, Math.round(12 * dpr), Math.round(12 * dpr), dpr, z === 1 ? '#b6ff3b' : '#ffb547');
}

function drawGlassPill(ctx, text, x, y, dpr, color, scale = 1) {
  ctx.font = `600 ${Math.round(11.5 * dpr * scale)}px "Cascadia Mono", Consolas, monospace`;
  const h = Math.round(26 * dpr * scale), padX = Math.round(11 * dpr * scale), w = ctx.measureText(text).width + padX * 2;
  ctx.save();
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 2 * dpr);
  ctx.fillStyle = 'rgba(8,10,11,.78)'; ctx.fill();
  ctx.lineWidth = dpr; ctx.strokeStyle = 'rgba(182,255,59,.45)'; ctx.stroke();
  ctx.fillStyle = color; ctx.textBaseline = 'middle';
  ctx.fillText(text, x + padX, y + h / 2 + 0.5 * dpr);
  ctx.restore();
}

function miniIcon(style) {
  const canvas = el('canvas', { width: 21, height: 21 });
  return {
    canvas,
    paint() {
      const c = { ...crosshair(), style, length: 5, gap: 2, thickness: 2, dotSize: 3, circleRadius: 7, outlineThickness: 1, opacity: 100 };
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, 21, 21);
      window.Crosshair.draw(ctx, c, 10, 10);
    }
  };
}

function initCrosshairTab() {
  syncers.push(chipGroup($('scene-chips'), SCENES.map(s => ({ label: s, value: s })),
    v => view.scene === v, v => { view = { ...view, scene: v }; syncAll(); }));
  syncers.push(chipGroup($('zoom-chips'), ZOOMS.map(z => ({ label: z === 1 ? 'Actual size' : 'Zoom ' + z + '×', value: z })),
    v => view.zoom === v, v => { view = { ...view, zoom: v }; syncAll(); }));

  // Shapes, each shown as a real render.
  const grid = $('style-grid');
  const icons = meta.styles.map(style => {
    const icon = miniIcon(style);
    const b = el('button', { type: 'button', class: 'style-btn', title: STYLE_LABELS[style], 'aria-label': STYLE_LABELS[style], onclick: () => setCross({ style }) }, icon.canvas);
    grid.append(b);
    return { b, icon, style };
  });
  syncers.push(() => icons.forEach(({ b, icon, style }) => { b.classList.toggle('current', crosshair().style === style); icon.paint(); }));

  const sw = SWATCHES.map(color => {
    const b = el('button', { type: 'button', class: 'swatch', title: color, 'aria-label': 'Colour ' + color, onclick: () => setCross({ color }) });
    b.style.background = color;
    $('swatches').append(b);
    return { b, color };
  });
  $('color').addEventListener('input', (e) => setCross({ color: e.target.value }));
  $('outline-color').addEventListener('input', (e) => setCross({ outlineColor: e.target.value }));
  $('outline').addEventListener('change', (e) => setCross({ outline: e.target.checked }));
  syncers.push(() => {
    const c = crosshair();
    sw.forEach(({ b, color }) => b.classList.toggle('current', c.color === color));
    $('color').value = c.color;
    $('outline-color').value = c.outlineColor;
    $('outline').checked = c.outline;
    $('color-dot').style.background = c.color;
    $('outline-dot').style.background = c.outlineColor;
  });

  const addSliders = (container, defs) => defs.forEach(([key, label, min, max, unit = 'px']) => {
    const s = slider({ label, min, max, unit, set: v => setCross({ [key]: v }) });
    container.append(s.node);
    syncers.push(() => s.sync(crosshair()[key]));
  });
  addSliders($('sliders'), [
    ['length', 'Arm length', 0, 60], ['gap', 'Gap', 0, 40], ['thickness', 'Thickness', 1, 12],
    ['dotSize', 'Dot size', 1, 20], ['circleRadius', 'Ring radius', 2, 80], ['opacity', 'Opacity', 5, 100, '%']
  ]);
  addSliders($('outline-sliders'), [['outlineThickness', 'Outline width', 1, 6]]);
  addSliders($('offset-sliders'), [['offsetX', 'Nudge X', -200, 200], ['offsetY', 'Nudge Y', -200, 200]]);

  initProfiles();
  initPresets();
  syncers.push(drawPreview);
  new ResizeObserver(drawPreview).observe($('preview'));
}

function initProfiles() {
  const box = $('profile-chips');
  const name = $('profile-name');
  name.addEventListener('input', () => commit({
    ...S, profiles: S.profiles.map(p => (p.id === S.activeProfile ? { ...p, name: name.value || 'Untitled' } : p))
  }));
  syncers.push(whenChanged(() => S.activeProfile + '|' + S.profiles.map(p => p.id + ':' + p.name).join('|'), () => {
    box.replaceChildren();
    for (const p of S.profiles) {
      const pick = el('button', { type: 'button', class: 'chip' + (p.id === S.activeProfile ? ' current' : ''), text: p.name,
        onclick: () => commit({ ...S, activeProfile: p.id }) });
      if (S.profiles.length > 1) {
        const remove = el('button', { type: 'button', class: 'chip-x', 'aria-label': 'Delete ' + p.name, text: '×',
          onclick: () => {
            const profiles = S.profiles.filter(x => x.id !== p.id);
            commit({ ...S, profiles, activeProfile: S.activeProfile === p.id ? profiles[0].id : S.activeProfile });
          } });
        box.append(el('span', { class: 'chip-slot' }, [pick, remove]));
      } else box.append(pick);
    }
    box.append(el('button', { type: 'button', class: 'chip add', text: '+ New', onclick: () => {
      const id = 'p' + Date.now().toString(36);
      const profiles = [...S.profiles, { id, name: 'Crosshair ' + (S.profiles.length + 1), crosshair: { ...crosshair() } }];
      commit({ ...S, profiles, activeProfile: id });
    } }));
    const active = S.profiles.find(p => p.id === S.activeProfile);
    if (document.activeElement !== name) name.value = active ? active.name : '';
  }));
}

function initPresets() {
  for (const preset of meta.presets) {
    $('preset-chips').append(el('button', { type: 'button', class: 'chip', text: preset.name,
      onclick: () => setCross({ ...preset.crosshair, offsetX: crosshair().offsetX, offsetY: crosshair().offsetY }) }));
  }
  const msg = $('share-msg');
  $('share-copy').addEventListener('click', async () => {
    const code = await api.copyShareCode(crosshair());
    msg.textContent = 'Copied ' + code.slice(0, 18) + '…';
  });
  $('share-paste').addEventListener('click', async () => {
    const c = await api.pasteShareCode();
    if (!c) { msg.textContent = 'No share code on the clipboard.'; return; }
    setCross(c);
    msg.textContent = 'Loaded.';
  });
}

// ---- when it shows ---------------------------------------------------------------

function initDetectionTab() {
  const chips = $('game-chips');
  const addGame = (raw) => {
    const name = String(raw || '').trim().split(/[\\/]/).pop().replace(/\.exe$/i, '');
    if (!name || S.detection.games.some(g => g.toLowerCase() === name.toLowerCase())) return;
    setDetection({ games: [...S.detection.games, name] });
  };
  syncers.push(whenChanged(() => S.detection.games.join('|'), () => {
    chips.replaceChildren();
    if (!S.detection.games.length) chips.append(el('span', { class: 'hint-inline', text: 'Add a game.' }));
    for (const g of S.detection.games) {
      chips.append(el('span', { class: 'chip-slot' }, [
        el('span', { class: 'chip game', text: g + '.exe' }),
        el('button', { type: 'button', class: 'chip-x', 'aria-label': 'Remove ' + g, text: '×',
          onclick: () => setDetection({ games: S.detection.games.filter(x => x !== g) }) })
      ]));
    }
  }));
  const input = $('game-input');
  $('game-add').addEventListener('click', () => { addGame(input.value); input.value = ''; });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { addGame(input.value); input.value = ''; } });
  const running = $('game-running');
  running.addEventListener('focus', async () => {
    const names = await api.runningGames();
    running.replaceChildren(el('option', { value: '', text: 'Pick a running app…' }), ...names.map(n => el('option', { value: n, text: n })));
  });
  running.addEventListener('change', () => { addGame(running.value); running.value = ''; });

  const rules = [
    ['forceBorderless', 'Force borderless', 'Set the game to Windowed.', null, ''],
    ['hideWhenCursorVisible', 'Hide in menus', '', null, ''],
    ['requireMouseLock', 'Only show while the mouse is locked', '', null, ''],
    ['hideOnSoftwareCursor', 'Hide when the game draws its own cursor', '', 'Experimental', ''],
    ['autoFullscreen', 'Auto-detect fullscreen games', '', null, '']
  ];
  for (const [key, title, desc, tag, tagClass] of rules) {
    const row = ruleRow({ title, desc, tag, tagClass, set: v => setDetection({ [key]: v }) });
    $('rule-rows').append(row.node);
    syncers.push(() => row.sync(S.detection[key]));
  }

  const modes = [['always', 'Always'], ['hideWhileAiming', 'Hide while aiming'], ['onlyWhileAiming', 'Only while aiming']];
  const seg = modes.map(([value, label]) => {
    const b = el('button', { type: 'button', text: label, onclick: () => setDetection({ aimMode: value }) });
    $('aim-mode').append(b);
    return { b, value };
  });
  syncers.push(() => seg.forEach(({ b, value }) => b.classList.toggle('current', S.detection.aimMode === value)));

  const aim = keyCapture($('aim-key'), v => setDetection({ aimKey: v }));
  syncers.push(() => aim.sync(S.detection.aimKey));
  const delay = slider({ label: 'Show delay', min: 0, max: 1000, unit: 'ms', set: v => setDetection({ showDelayMs: v }) });
  $('delay-slider').append(delay.node);
  syncers.push(() => delay.sync(S.detection.showDelayMs));
}

// ---- status + troubleshooting --------------------------------------------------------

// ---- app tab -----------------------------------------------------------------------

function initAppTab() {
  const toggle = keyCapture($('toggle-key'), v => setDetection({ toggleHotkey: v }));
  syncers.push(() => { toggle.sync(S.detection.toggleHotkey); $('hotkey-name').textContent = window.UI.friendly(S.detection.toggleHotkey); });
  const rows = [
    ['launchAtLogin', 'Launch with Windows', ''],
    ['startMinimized', 'Start in the tray', '']
  ];
  for (const [key, title, desc] of rows) {
    const row = ruleRow({ title, desc, set: v => setApp({ [key]: v }) });
    $('app-rows').append(row.node);
    syncers.push(() => row.sync(S.app[key]));
  }
  $('version').textContent = `v${meta.version}`;
}

// ---- start -------------------------------------------------------------------------

async function start() {
  const state = await api.getState();
  S = state.settings;
  meta = state;
  initTabs();
  initCrosshairTab();
  initDetectionTab();
  initAppTab();
  $('enabled').addEventListener('change', (e) => commit({ ...S, enabled: e.target.checked }));
  syncers.push(() => { $('enabled').checked = S.enabled; });
  // Main echoes only the hotkey/tray on-off switch. Keep a queued edit, but with the echoed switch, so the
  // queued send cannot revert it.
  api.onSettings((next) => {
    S = pendingSend ? { ...pendingSend, enabled: next.enabled } : next;
    if (pendingSend) pendingSend = S;
    syncAll();
  });
  syncAll();
}

start();
