// Crosshair geometry and drawing, shared by the overlay, the settings preview and the Node tests.
// All sizes are device pixels. (cx, cy) is the top-left corner of the centre pixel, i.e. the aim point.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Crosshair = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const HAS_ARMS = { cross: 1, crossDot: 1, tShape: 1, circleCross: 1 };
  const HAS_DOT = { dot: 1, crossDot: 1, circleDot: 1 };
  const HAS_CIRCLE = { circle: 1, circleDot: 1, circleCross: 1 };

  // Shapes relative to the centre pixel. `grow` expands every shape (used for the outline pass).
  // Hard-edged pixel circle, one rect per row, so a small dot reads as round instead of a blurred square.
  // A pixel is in when its centre lies inside the radius, minus a little so tiny discs lose their corners.
  const DISC_TRIM = 0.15;
  function pixelDisc(c, r) {
    const rows = [];
    const lim = r - DISC_TRIM;
    for (let py = Math.floor(c - r); py < Math.ceil(c + r); py++) {
      const dy = py + 0.5 - c;
      if (Math.abs(dy) > lim) continue;
      const half = Math.sqrt(lim * lim - dy * dy);
      const left = Math.ceil(c - half - 0.5), right = Math.floor(c + half - 0.5); // pixels whose centre fits
      if (right >= left) rows.push({ kind: 'rect', x: left, y: py, w: right - left + 1, h: 1 });
    }
    return rows;
  }

  function shapes(s, grow) {
    const out = [];
    const rect = (x, y, w, h) => out.push({ kind: 'rect', x: x - grow, y: y - grow, w: w + 2 * grow, h: h + 2 * grow });
    if (HAS_ARMS[s.style] && s.length > 0) {
      const t = s.thickness;
      const start = -Math.floor(t / 2);   // first pixel of the centre block
      const near = start - s.gap;         // inner end of left/top arms
      const far = start + t + s.gap;      // inner start of right/bottom arms
      const L = s.length;
      rect(far, start, L, t);             // right
      rect(near - L, start, L, t);        // left
      rect(start, far, t, L);             // bottom
      if (s.style !== 'tShape') rect(start, near - L, t, L); // top
      if (s.gap === 0) rect(start, start, t, t);
    }
    if (HAS_DOT[s.style]) {
      const d = s.dotSize, c = -Math.floor(d / 2) + d / 2;
      out.push(...pixelDisc(c, d / 2 + grow));
    }
    if (HAS_CIRCLE[s.style]) out.push({ kind: 'ring', cx: 0.5, cy: 0.5, r: s.circleRadius, width: s.thickness + 2 * grow });
    return out;
  }

  // Farthest pixel any part reaches from the centre; callers size canvases from it.
  function extent(s) {
    const arms = s.gap + s.length + s.thickness;
    const ring = s.circleRadius + s.thickness;
    return Math.max(arms, ring, s.dotSize) + s.outlineThickness + 2;
  }

  function paint(ctx, list, color, cx, cy) {
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    for (const sh of list) {
      if (sh.kind === 'rect') ctx.fillRect(cx + sh.x, cy + sh.y, sh.w, sh.h);
      else if (sh.kind === 'ring') { ctx.lineWidth = sh.width; ctx.beginPath(); ctx.arc(cx + sh.cx, cy + sh.cy, sh.r, 0, Math.PI * 2); ctx.stroke(); }
    }
  }

  // Opacity is applied by the caller (CSS or globalAlpha on a composite), so the outline under the fill never shows through.
  function draw(ctx, s, cx, cy) {
    if (s.outline) paint(ctx, shapes(s, s.outlineThickness), s.outlineColor, cx, cy);
    paint(ctx, shapes(s, 0), s.color, cx, cy);
  }

  return { shapes, extent, draw };
});
