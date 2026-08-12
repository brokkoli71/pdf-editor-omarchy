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

// ── control points and welding (row 127) ─────────────────────────────────────
//
// Every selected CORNER polyline — line, path, polygon, rectangle — grows round
// vertex handles in box mode, and dragging one moves both edges meeting there.
// Nothing is stored: the points are re-derived from the geometry every time,
// which is why they survive a reload and a sidecar round trip for free.

export const POLYGON_MAX_CORNERS = 8;
export const MAX_VISIBLE_VERTICES = POLYGON_MAX_CORNERS + 1;
export const VERTEX_HIT_PX = 7.0;        // grab radius for a control point
export const VERTEX_DRAW_R = 4.0;        // and the radius it is drawn at
export const VERTEX_SNAP_FRAC = 0.03;    // of the smaller viewport side
export const VERTEX_SNAP_MIN = 10.0;
export const VERTEX_SNAP_MAX = 44.0;
export const VERTEX_WELD_EPS = 0.5;      // this close already counts as ONE point

/** The draggable CONTROL POINTS of a stroke, or [] when it has none.
 *
 * A stroke qualifies when it is a CORNER polyline: a line, a path, a polygon, a
 * rectangle. A sampled curve (an ellipse is 24+ points) and freehand ink do not
 * — twenty-five handles on one wobble is not editing, it is a hedgehog.
 *
 * For a closed shape the repeated last point is dropped, and moving the first
 * vertex moves both ends, or the ring tears open. */
export function shapeVertices(pts) {
  if (!pts || pts.length < 2) return [];
  const closed = Math.abs(pts[0][0] - pts[pts.length - 1][0]) < 1e-9
              && Math.abs(pts[0][1] - pts[pts.length - 1][1]) < 1e-9;
  const core = closed ? pts.slice(0, -1) : pts;
  if (!(core.length >= 2 && core.length <= MAX_VISIBLE_VERTICES)) return [];
  return core.map((p) => [p[0], p[1]]);
}

/** A stroke's points with vertex `index` moved, keeping a closed ring closed. */
export function moveShapeVertex(pts, index, x, y) {
  const out = pts.map((p) => [p[0], p[1]]);
  const closed = Math.abs(out[0][0] - out[out.length - 1][0]) < 1e-9
              && Math.abs(out[0][1] - out[out.length - 1][1]) < 1e-9;
  out[index] = [x, y];
  if (closed && index === 0) out[out.length - 1] = [x, y];
  return out;
}

/** How close two control points must come before they snap together, in SCREEN
 * px. Relative to the VIEWPORT, not the document: it is a reach on screen, so
 * it must not shrink when you zoom in to work on a detail. */
export function vertexSnapRadius(viewW, viewH) {
  return Math.max(VERTEX_SNAP_MIN,
    Math.min(VERTEX_SNAP_MAX, VERTEX_SNAP_FRAC * Math.max(1, Math.min(viewW, viewH))));
}

/** Every control point sitting at (x, y), as [{stroke, index}].
 *
 * This is how two shapes stay joined AFTER being snapped together, and it is
 * deliberately not a stored link: points that share a coordinate ARE one point,
 * re-derived at every grab. Nothing to persist, so a weld survives a reload, a
 * round trip and an undo for free.
 *
 * ceiling: two points that coincide by ACCIDENT also move together, and the
 * only way to part them is to drag one away first. Storing real joins would
 * need stable per-stroke ids. */
export function weldedVertices(shapes, x, y, eps = VERTEX_WELD_EPS) {
  const out = [];
  for (const { stroke, verts } of shapes) {
    verts.forEach((v, i) => {
      if (Math.abs(v[0] - x) <= eps && Math.abs(v[1] - y) <= eps) {
        out.push({ stroke, index: i });
      }
    });
  }
  return out;
}

function isHeld(held, stroke, index) {
  return held.some((h) => h.stroke === stroke && h.index === index);
}

/** Nearest control point among `shapes` to (x, y), within `hit`. */
export function nearestVertexPoint(shapes, x, y, hit, held = []) {
  let best = hit, at = null;
  for (const { stroke, verts } of shapes) {
    verts.forEach((v, i) => {
      if (isHeld(held, stroke, i)) return;
      const d = Math.hypot(v[0] - x, v[1] - y);
      if (d <= best) { best = d; at = [v[0], v[1]]; }
    });
  }
  return at;
}

/** Nearest point ON an edge, within `hit` — the projection onto the closest
 * segment.
 *
 * Segments touching a HELD vertex are skipped: the point in your hand always
 * lies on its own two edges, so without this it would snap to itself and never
 * move. This is a POSITIONAL snap only — the point lands there and is then an
 * ordinary vertex. Nothing binds it to the edge, and if that edge later moves
 * the point stays put. */
export function nearestEdgePoint(shapes, x, y, hit, held = []) {
  let best = hit, at = null;
  for (const { stroke, verts } of shapes) {
    const n = verts.length;
    const closed = n > 2;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const j = (i + 1) % n;
      if (isHeld(held, stroke, i) || isHeld(held, stroke, j)) continue;
      const [ax, ay] = verts[i], [bx, by] = verts[j];
      const vx = bx - ax, vy = by - ay;
      const span = vx * vx + vy * vy;
      if (span < 1e-12) continue;
      const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / span));
      const px = ax + t * vx, py = ay + t * vy;
      const d = Math.hypot(px - x, py - y);
      if (d <= best) { best = d; at = [px, py]; }
    }
  }
  return at;
}

/** Freehand strokes within reach, the rest dropped by a bbox test first.
 *
 * Freehand ink is a polyline like any other, so snapping a corner onto a
 * sketched line needs no new geometry; what it needs is the prefilter, since a
 * page of handwriting is tens of thousands of segments and this runs on every
 * motion event. */
export function curveSnapShapes(pairs, x, y, hit) {
  const out = [];
  for (const { stroke, verts } of pairs) {
    if (!verts || verts.length < 2) continue;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of verts) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    if (minX - hit <= x && x <= maxX + hit && minY - hit <= y && y <= maxY + hit) {
      out.push({ stroke, verts });
    }
  }
  return out;
}

/** Where a dragged point should sit: a control point if one is in reach, else a
 * point on an edge.
 *
 * A VERTEX is the stronger target and has to win — landing NEXT TO a corner you
 * were aiming at is the whole failure this ordering prevents.
 *
 * `curves` are freehand strokes, offering their two ENDPOINTS as vertices (the
 * ends of a pen line are real, aimable points) and their whole polyline as
 * edges. Their interior points are NOT vertex targets: a freehand stroke has
 * hundreds, they are sampling artefacts rather than anything a person drew
 * deliberately, and treating them as corners would make the snap grab a
 * different pixel every time. */
export function snapPoint(shapes, x, y, hit, held = [], curves = []) {
  const ends = curves.map(({ stroke, verts }) =>
    ({ stroke, verts: [verts[0], verts[verts.length - 1]] }));
  return nearestVertexPoint(shapes.concat(ends), x, y, hit, held)
      || nearestEdgePoint(shapes.concat(curves), x, y, hit, held);
}

/** The round handles, and the halo on one that a drag is snapped onto. */
export function drawShapeVertices(ctx, verts, accent, snappedAt = null) {
  ctx.save();
  ctx.setLineDash([]);
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = accent;
  ctx.fillStyle = "#ffffff";
  for (const [x, y] of verts) {
    ctx.beginPath();
    ctx.arc(x, y, VERTEX_DRAW_R, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();
  }
  if (snappedAt) {
    // the visual half of "snapped, but not committed until you let go"
    ctx.lineWidth = 2.0;
    ctx.beginPath();
    ctx.arc(snappedAt[0], snappedAt[1], VERTEX_DRAW_R + 4, 0, 2 * Math.PI);
    ctx.stroke();
  }
  ctx.restore();
}
