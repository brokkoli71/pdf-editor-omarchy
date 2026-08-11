// THE ink painter, ported from sidemark.py's draw_ink_stroke.
//
// Every surface routes through it, so a pen stroke cannot look different in the
// page, the live stroke or a copied PNG. With no `profile` this is the plain
// constant-width polyline ink has always been, so shapes, imported annotations
// and the highlighter are untouched. With one, the stroke is built as a closed
// OUTLINE (offset to each side by half the local width, capped with a
// half-circle at each end) and filled in one go: filling separate per-segment
// strokes instead would double-darken wherever they overlap, which a
// translucent pen would show.
//
// cairo → Canvas2D is close to 1:1 here. `ctx.arc(..., true)` is
// `arc_negative`, and both substrates put +y downward, so the sweep directions
// agree without any sign flipping.

/** Paint one ink stroke onto `ctx`, in whatever units `pts` are in.
 *
 * `grow` widens the result by a constant, which is what the lasso's glow is: it
 * must be the same SHAPE as the stroke it haloes, so a tapered stroke cannot be
 * given a flat halo without the two visibly disagreeing at the tip. */
export function drawInkStroke(ctx, pts, width, profile = null, grow = 0.0) {
  if (pts.length < 2) {
    if (pts.length) {
      const r = (width * (profile ? profile[0] : 1.0) + grow) / 2;
      ctx.beginPath();
      ctx.arc(pts[0][0], pts[0][1], Math.max(r, 1e-3), 0, 2 * Math.PI);
      ctx.fill();
    }
    return;
  }
  if (!profile) {
    ctx.beginPath();
    ctx.lineWidth = width + grow;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
    return;
  }

  // unit normal at each point: the perpendicular of the averaged incoming and
  // outgoing tangents, so an offset corner stays put instead of flaring
  const n = pts.length;
  const normals = [];
  for (let i = 0; i < n; i++) {
    let tx = 0.0, ty = 0.0;
    const legs = [];
    if (i) legs.push([pts[i - 1], pts[i]]);
    if (i < n - 1) legs.push([pts[i], pts[i + 1]]);
    for (const [a, b] of legs) {
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const d = Math.hypot(dx, dy);
      if (d > 1e-12) { tx += dx / d; ty += dy / d; }
    }
    let d = Math.hypot(tx, ty);
    if (d < 1e-12) { tx = 1.0; ty = 0.0; d = 1.0; }
    normals.push([-ty / d, tx / d]);
  }

  const half = [];
  for (let i = 0; i < n; i++) {
    half.push((width * Math.max(i < profile.length ? profile[i] : 1.0, 0.02) + grow) / 2);
  }

  ctx.beginPath();
  ctx.moveTo(pts[0][0] + normals[0][0] * half[0],
             pts[0][1] + normals[0][1] * half[0]);
  for (let i = 1; i < n; i++) {
    ctx.lineTo(pts[i][0] + normals[i][0] * half[i],
               pts[i][1] + normals[i][1] * half[i]);
  }
  // round cap at the end: from the left offset round to the right one, the
  // short way — through the direction the pen was travelling
  let a0 = Math.atan2(normals[n - 1][1], normals[n - 1][0]);
  ctx.arc(pts[n - 1][0], pts[n - 1][1], half[n - 1], a0, a0 - Math.PI, true);
  for (let i = n - 2; i >= 0; i--) {
    ctx.lineTo(pts[i][0] - normals[i][0] * half[i],
               pts[i][1] - normals[i][1] * half[i]);
  }
  a0 = Math.atan2(-normals[0][1], -normals[0][0]);
  ctx.arc(pts[0][0], pts[0][1], half[0], a0, a0 - Math.PI, true);
  ctx.closePath();
  ctx.fill();
}

/** Distance from a point to a segment — the eraser's question, and the same
 * geometry the Python original uses for hit-testing ink. */
export function pointSegmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const d2 = dx * dx + dy * dy;
  if (d2 <= 1e-12) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / d2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Does a press at (x, y) touch this stroke's centreline, within `radius`? */
export function strokeHit(pts, x, y, radius) {
  if (!pts.length) return false;
  if (pts.length === 1) return Math.hypot(x - pts[0][0], y - pts[0][1]) <= radius;
  for (let i = 1; i < pts.length; i++) {
    if (pointSegmentDistance(x, y, pts[i - 1][0], pts[i - 1][1],
                             pts[i][0], pts[i][1]) <= radius) return true;
  }
  return false;
}

export function rgbCss(rgb, alpha = 1.0) {
  const [r, g, b] = rgb;
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`;
}
