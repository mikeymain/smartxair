// Small DOM building blocks for app.js. Each control returns { node, sync } so app.js can push new values in
// without rebuilding (which would break a slider mid-drag).
(function () {
  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(children)) if (c) node.append(c);
    return node;
  }

  function slider({ label, min, max, unit = 'px', set }) {
    const range = el('input', { type: 'range', min, max, step: 1, 'aria-label': label });
    const num = el('input', { type: 'number', min, max, step: 1, 'aria-label': label + ' value' });
    const paint = (v) => range.style.setProperty('--fill', ((v - min) / (max - min)) * 100 + '%');
    const commit = (raw) => {
      const v = Math.min(max, Math.max(min, Math.round(Number(raw))));
      if (!Number.isFinite(v)) return;
      range.value = v; num.value = v; paint(v); set(v);
    };
    range.addEventListener('input', () => commit(range.value));
    num.addEventListener('change', () => commit(num.value));
    const node = el('label', { class: 'slider' }, [
      el('span', { text: label }), range,
      el('span', { class: 'num' }, [num, unit ? el('span', { class: 'unit', text: unit }) : null])
    ]);
    return {
      node,
      sync(v) {
        if (document.activeElement !== num) num.value = v;
        if (document.activeElement !== range) range.value = v;
        paint(v);
      }
    };
  }

  function switchInput(id, label) {
    return el('label', { class: 'switch' }, [
      el('input', { type: 'checkbox', id }), el('span', { class: 'track' }, el('span', { class: 'thumb' })),
      label ? el('span', { class: 'switch-label', text: label }) : null
    ]);
  }

  function ruleRow({ title, desc, tag, tagClass, set }) {
    const sw = switchInput(null, '');
    const input = sw.querySelector('input');
    input.setAttribute('aria-label', title);
    input.addEventListener('change', () => set(input.checked));
    const head = el('strong', { text: title }, tag ? el('em', { class: 'tag ' + (tagClass || ''), text: tag }) : null);
    const node = el('div', { class: 'rule' }, [el('div', {}, [head, desc ? el('span', { text: desc }) : null]), sw]);
    return { node, sync(v) { input.checked = !!v; }, input };
  }

  // KeyboardEvent.code -> the names engine/logic.cjs understands.
  function keyName(code) {
    let m;
    if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
    if ((m = /^Digit([0-9])$/.exec(code))) return m[1];
    if ((m = /^Numpad([0-9])$/.exec(code))) return 'Num' + m[1];
    if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
    if ((m = /^Arrow(Left|Right|Up|Down)$/.exec(code))) return m[1];
    const map = { Space: 'Space', Tab: 'Tab', Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp',
      PageDown: 'PageDown', Backquote: 'Backquote', Minus: 'Minus', Equal: 'Equal', CapsLock: 'CapsLock', Pause: 'Pause', Enter: 'Enter' };
    return map[code] || null;
  }
  const MOUSE = { 1: 'MButton', 2: 'RButton', 3: 'XButton1', 4: 'XButton2' };

  // Stored names stay engine-friendly ("RButton"); people see "Right mouse".
  const FRIENDLY = { LButton: 'Left mouse', RButton: 'Right mouse', MButton: 'Middle mouse', XButton1: 'Mouse 4', XButton2: 'Mouse 5',
    Backquote: '`', Minus: '-', Equal: '=', PageUp: 'Page Up', PageDown: 'Page Down', CapsLock: 'Caps Lock' };
  const friendly = (combo) => String(combo || '').split('+')
    .map(p => FRIENDLY[p] || p.replace(/^Num(\d)$/, 'Numpad $1')).join(' + ');

  // Click, then press a key or a mouse button (not left). Esc cancels.
  function keyCapture(button, set) {
    let listening = false;
    let current = '';
    const stop = (value) => {
      listening = false;
      button.classList.remove('listening');
      button.textContent = friendly(current);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onMouse, true);
      window.removeEventListener('contextmenu', block, true);
      if (value) set(value);
    };
    const block = (e) => { e.preventDefault(); e.stopPropagation(); };
    const onKey = (e) => {
      block(e);
      if (e.code === 'Escape') return stop(null);
      const k = keyName(e.code);
      if (!k) return; // a modifier alone: wait for the real key
      const combo = [e.ctrlKey && 'Ctrl', e.shiftKey && 'Shift', e.altKey && 'Alt', k].filter(Boolean).join('+');
      stop(combo);
    };
    const onMouse = (e) => {
      if (e.button === 0) return;
      block(e);
      stop(MOUSE[e.button]);
    };
    button.addEventListener('click', () => {
      if (listening) return;
      listening = true;
      button.classList.add('listening');
      button.textContent = 'Press a key…';
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('mousedown', onMouse, true);
      window.addEventListener('contextmenu', block, true);
    });
    return {
      sync(v) {
        current = v;
        if (!listening) button.textContent = friendly(v);
        button.title = 'Click, then press a key or mouse button (Esc cancels)';
      }
    };
  }

  // Backdrops for the preview, so a colour can be judged against the kinds of scenes the game has.
  const SCENES = {
    Night: ['#0b0e14', '#1c2331', '#2a3346'],
    Street: ['#262d37', '#4c535d', '#6b7076'],
    Sky: ['#6fa6dc', '#a9cbea', '#e6eef5'],
    Foliage: ['#16301b', '#365233', '#5e7a46'],
    White: ['#c9d3de', '#e4eaf1', '#f7f9fb']
  };

  function drawScene(ctx, w, h, name) {
    const [a, b, c] = SCENES[name] || SCENES.Night;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, a); g.addColorStop(.6, b); g.addColorStop(1, c);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // A skyline of blocks for texture; seeded so it never jitters between redraws.
    let seed = 7;
    const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
    ctx.fillStyle = 'rgba(0,0,0,.18)';
    for (let x = 0; x < w;) {
      const bw = 30 + rnd() * 90, bh = h * (.2 + rnd() * .45);
      ctx.fillRect(x, h - bh, bw, bh);
      x += bw + 6 + rnd() * 20;
    }
  }

  window.UI = { el, slider, switchInput, ruleRow, keyCapture, drawScene, friendly, SCENES: Object.keys(SCENES) };
})();
