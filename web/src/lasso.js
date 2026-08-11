// The lasso selection's shared policy, ported from sidemark.py.
//
// One geometry and one painter behind both the hit-test and the paint: a handle
// must be grabbed exactly where it is drawn, or the frame drifts from what a
// grab catches. Everything here is pure — no canvas, no events.

export const LASSO_CHIP_SIZE = 16.0;   // the chip's side, in screen px
export const LASSO_CHIP_GAP = 6.0;     // clearance from the box's TL handle
export const LASSO_PAD = 5.0;          // slack between the ink and the frame
export const HANDLE_HIT = 8.0;         // how close counts as grabbing a handle
export const ROTATE_HANDLE_GAP = 18.0; // px from the box's top edge to the knob
export const ROTATE_SNAP_DEG = 15.0;   // Shift snaps to this
export const DUPLICATE_OFFSET = 14.0;  // screen px, so a copy is visible at any
                                       // zoom

/** Even-odd ray-cast test: is (px, py) inside the polygon? */
export function pointInPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py)
        && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** The eight handle centres for a box drawn with `pad` slack, in the same space
 * as the box — shared by the hit-test and the painter. Order matters: 0–3 are
 * the corners clockwise from top-left, 4–7 the side midpoints. */
export function lassoHandlePoints(x0, y0, x1, y1, pad) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return [[x0 - pad, y0 - pad], [x1 + pad, y0 - pad],
          [x1 + pad, y1 + pad], [x0 - pad, y1 + pad],
          [cx, y0 - pad], [x1 + pad, cy], [cx, y1 + pad], [x0 - pad, cy]];
}

/** (mode, anchor) for a handle: a corner is "uniform", anchored at the opposite
 * corner; a side is "x"/"y", anchored on the opposite edge. */
export function lassoHandleAnchor(handle, bbox) {
  const [x0, y0, x1, y1] = bbox;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  if (handle < 4) return { mode: "uniform", anchor: corners[(handle + 2) % 4] };
  return {
    4: { mode: "y", anchor: [cx, y1] },
    5: { mode: "x", anchor: [x0, cy] },
    6: { mode: "y", anchor: [cx, y0] },
    7: { mode: "x", anchor: [x1, cy] },
  }[handle];
}

/** Per-axis (fx, fy) for a resize drag from `start` to `cur` about `anchor`. A
 * corner scales both axes by the diagonal ratio so the aspect never changes; a
 * side scales one axis. Clamped so a drag through the anchor cannot invert or
 * vanish the selection. */
export function lassoScaleFactors(mode, anchor, start, cur, lo = 0.05, hi = 20.0) {
  const [ax, ay] = anchor, [sx, sy] = start, [px, py] = cur;
  const axis = (c, s, a) =>
    Math.abs(s - a) > 1e-6 ? Math.max(lo, Math.min(hi, (c - a) / (s - a))) : 1.0;
  if (mode === "x") return [axis(px, sx, ax), 1.0];
  if (mode === "y") return [1.0, axis(py, sy, ay)];
  const d0 = Math.hypot(sx - ax, sy - ay);
  const d1 = Math.hypot(px - ax, py - ay);
  const f = d0 > 1e-6 ? Math.max(lo, Math.min(hi, d1 / d0)) : 1.0;
  return [f, f];
}

export function lassoHandleCursor(handle) {
  return ["nwse-resize", "nesw-resize", "nwse-resize", "nesw-resize",
          "ns-resize", "ew-resize", "ns-resize", "ew-resize"][handle];
}

/** Centre of the loop⇄box mode chip, diagonally OUTSIDE the box's top-left
 * corner: the top edge's centre belongs to the rotate knob and the corner
 * itself to a resize handle, and the gap keeps the chip clear of that handle's
 * hit box. */
export function lassoChipCentre(x0, y0, pad) {
  const off = pad + LASSO_CHIP_GAP + LASSO_CHIP_SIZE / 2;
  return [x0 - off, y0 - off];
}

export function lassoChipHit(cx, cy, px, py, slop = 3.0) {
  const r = LASSO_CHIP_SIZE / 2 + slop;
  return Math.abs(px - cx) <= r && Math.abs(py - cy) <= r;
}

/** Centre of the DELETE button, directly below the chip on the same vertical.
 *
 * Below rather than beside: the chip already sits diagonally out from the
 * corner, so going further left would walk it off a selection near the page
 * edge, while the space below is the box's own left margin and is always there.
 * Sharing the chip's x also makes the two read as one small stack of verbs. */
export function lassoDeleteCentre(x0, y0, pad) {
  const [cx, cy] = lassoChipCentre(x0, y0, pad);
  return [cx, cy + LASSO_CHIP_SIZE + LASSO_CHIP_GAP];
}

/** Same target size as the chip — it has to be hit with a pen on the first try,
 * and must be no HARDER to hit than the chip it sits under. */
export const lassoDeleteHit = lassoChipHit;

/** Paint the mode chip. It shows WHAT YOU WILL GET, not what you have: in loop
 * mode a resize box with corner ticks, in box mode a dashed loop. A toggle that
 * pictures its own current state reads as a status light and leaves you
 * guessing what tapping it does. */
export function drawLassoChip(ctx, cx, cy, boxed, accent) {
  const s = LASSO_CHIP_SIZE;
  ctx.save();
  ctx.lineWidth = 1.0;
  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.strokeStyle = accent;
  ctx.beginPath();
  ctx.roundRect(cx - s / 2, cy - s / 2, s, s, 3);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = accent;
  if (boxed) {
    // currently boxed → tapping gives you the LOOP
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.ellipse(cx, cy, s * 0.30, s * 0.24, 0, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.setLineDash([]);
  } else {
    // currently a loop → tapping gives you the BOX
    const h = s * 0.28;
    ctx.strokeRect(cx - h, cy - h, h * 2, h * 2);
    ctx.fillStyle = accent;
    for (const [dx, dy] of [[-h, -h], [h, -h], [h, h], [-h, h]]) {
      ctx.fillRect(cx + dx - 1.5, cy + dy - 1.5, 3, 3);
    }
  }
  ctx.restore();
}

/** Paint the delete button: a BARE RED CROSS, no ground.
 *
 * Colour and shape are the only guard on a destructive target sitting beside a
 * harmless one, so they stay distinct from the chip's filled square. The paint
 * is light; the hit region is the chip's full size — never shrink the target to
 * match the ink. */
export function drawLassoDelete(ctx, cx, cy) {
  const r = LASSO_CHIP_SIZE * 0.28;
  ctx.save();
  ctx.strokeStyle = "rgb(224, 27, 36)";
  ctx.lineWidth = 2.0;
  ctx.lineCap = "round";
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(cx - r, cy - r);
  ctx.lineTo(cx + r, cy + r);
  ctx.moveTo(cx + r, cy - r);
  ctx.lineTo(cx - r, cy + r);
  ctx.stroke();
  ctx.restore();
}

/** Add a lasso's catch to the selection it started from — Shift+lasso.
 *
 * By IDENTITY, never by value: strokes are plain objects, so a duplicated
 * stroke that happens to match would silently collapse into one. */
export function mergeSelection(base, caught) {
  const seen = new Set(base);
  return base.concat(caught.filter((s) => !seen.has(s)));
}

/** The bounding box of a set of strokes, in document units. ONE box, used by
 * the frame AND the hit-tests, or they drift apart. */
export function selectionBbox(strokes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) {
    const half = (s.width || 0) / 2;
    for (const [x, y] of s.pts) {
      if (x - half < x0) x0 = x - half;
      if (x + half > x1) x1 = x + half;
      if (y - half < y0) y0 = y - half;
      if (y + half > y1) y1 = y + half;
    }
  }
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : null;
}

/** Scale a point about an anchor, per axis. */
export function scalePoint(p, fx, fy, ax, ay) {
  return [ax + (p[0] - ax) * fx, ay + (p[1] - ay) * fy];
}

/** Centre of the rotate knob, on a stalk above the box's top edge. */
export function rotateKnobCentre(x0, y0, x1, pad = LASSO_PAD) {
  return [(x0 + x1) / 2, y0 - pad - ROTATE_HANDLE_GAP];
}

export function rotateKnobHit(kx, ky, px, py, hit = HANDLE_HIT) {
  return Math.hypot(px - kx, py - ky) <= hit;
}

/** Paint the rotate knob and its stalk. */
export function drawRotateKnob(ctx, x0, y0, x1, accent, pad = LASSO_PAD) {
  const [kx, ky] = rotateKnobCentre(x0, y0, x1, pad);
  ctx.save();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.2;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(kx, y0 - pad);
  ctx.lineTo(kx, ky);
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(kx, ky, 4.5, 0, 2 * Math.PI);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** Rotate a point about a centre. */
export function rotatePoint(p, angle, cx, cy) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const dx = p[0] - cx, dy = p[1] - cy;
  return [cx + dx * c - dy * s, cy + dx * s + dy * c];
}
