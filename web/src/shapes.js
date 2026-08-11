// Shape recognition — the extended dwell, ported from sidemark.py.
//
// Holding still mid-stroke does not only make a line: a closed loop is cleaned
// into an axis-aligned RECTANGLE, an ELLIPSE (a near-circle snaps to a true
// circle), or an irregular POLYGON. Everything stays an ordinary STROKE (a
// polyline), so a recognised shape lassoes, erases and round-trips for free —
// there is no new object kind.
//
// The LINE is always the fallback, so turning recognition down to "lines" or
// "off" can never regress the classic straight snap.
//
// Pure geometry, so both surfaces share one classifier and cannot drift.

export const POLYGON_MAX_CORNERS = 8;
export const CIRCLE_TOLERANCE = 0.12;   // |rx-ry| within this reads as a circle
export const LASSO_CLICK_SLOP_PX = 4;   // under this a lasso drag is a CLICK

/** Is this freehand polyline a LOOP? Its ends meet, relative to its own size,
 * AND the pen travelled much further than the straight-line distance — the
 * second half is what tells a loop from a near-straight scribble that merely
 * wandered back near where it started.
 *
 * One definition, because two things ask it: the shape snap and
 * circle-to-lasso (only a loop can be pressed INSIDE). */
export function polylineIsClosed(pts) {
  if (pts.length < 2) return false;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const diag = Math.hypot(Math.max(...xs) - Math.min(...xs),
                          Math.max(...ys) - Math.min(...ys));
  const gap = Math.hypot(pts[pts.length - 1][0] - pts[0][0],
                         pts[pts.length - 1][1] - pts[0][1]);
  let plen = 0;
  for (let i = 1; i < pts.length; i++) {
    plen += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  return diag > 1e-6 && gap < 0.30 * diag && plen > 1.4 * diag;
}

/** Distance from a point to the SEGMENT ab (not the infinite line). */
export function pointSegmentDistance(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const span = vx * vx + vy * vy;
  if (span < 1e-12) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / span));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/** Ramer–Douglas–Peucker: drop points within `tol` of the chord they lie on,
 * keeping the ends. What survives is the polyline's CORNERS. */
export function simplifyPolyline(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const [ax, ay] = pts[0];
  const [bx, by] = pts[pts.length - 1];
  let worst = -1, at = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = pointSegmentDistance(pts[i][0], pts[i][1], ax, ay, bx, by);
    if (d > worst) { worst = d; at = i; }
  }
  if (worst <= tol) return [pts[0], pts[pts.length - 1]];
  return simplifyPolyline(pts.slice(0, at + 1), tol).slice(0, -1)
    .concat(simplifyPolyline(pts.slice(at), tol));
}

/** Total distance from every point to the nearest segment of `verts` — the one
 * residual every candidate is scored with, so their totals compare directly. */
export function polylineResidual(pts, verts) {
  let total = 0;
  for (const [x, y] of pts) {
    let best = Infinity;
    for (let i = 0; i < verts.length - 1; i++) {
      const d = pointSegmentDistance(x, y, verts[i][0], verts[i][1],
                                     verts[i + 1][0], verts[i + 1][1]);
      if (d < best) best = d;
    }
    total += best;
  }
  return total;
}

function diagonalOf(pts) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return Math.hypot(Math.max(...xs) - Math.min(...xs),
                    Math.max(...ys) - Math.min(...ys));
}

/** The corners of an OPEN stroke drawn as a run of straight segments. Empty
 * when the stroke reads as one line.
 *
 * The single straight line stays the fallback and has to be BEATEN by a clear
 * margin (`gain`), or every slightly bowed stroke turns into a two-segment path
 * and the classic straight snap is gone. */
export function openPathCorners(pts, tolFrac = 0.045, gain = 2.5) {
  if (pts.length < 3) return [];
  const diag = diagonalOf(pts);
  if (diag < 1e-6) return [];
  const simple = simplifyPolyline(pts, tolFrac * diag);
  if (!(simple.length >= 3 && simple.length <= POLYGON_MAX_CORNERS + 1)) return [];
  const lineErr = polylineResidual(pts, [pts[0], pts[pts.length - 1]]);
  if (polylineResidual(pts, simple) * gain > lineErr) return [];
  return simple;
}

/** The corner vertices of a closed freehand loop, as an OPEN list (no repeated
 * closing point). Empty when the loop does not read as a polygon.
 *
 * The tolerance is a fraction of the loop's diagonal, so a big sloppy shape and
 * a small neat one are judged alike. The count is bounded: below 3 there is no
 * polygon, and above POLYGON_MAX_CORNERS a wobbly circle starts to "simplify"
 * into a many-sided nothing, which would beat the ellipse fit on residual while
 * being obviously wrong to a human. */
export function polygonCorners(pts, tolFrac = 0.045) {
  if (pts.length < 4) return [];
  const diag = diagonalOf(pts);
  if (diag < 1e-6) return [];
  // close the loop first so the start/end join is simplified like any other
  // corner — a freehand loop usually starts and ends mid-edge, and RDP pins
  // both ends, which would otherwise leave a phantom vertex there
  const closed = pts.concat([pts[0]]);
  let simple = simplifyPolyline(closed, tolFrac * diag);
  if (simple.length > 1
      && Math.hypot(simple[0][0] - simple[simple.length - 1][0],
                    simple[0][1] - simple[simple.length - 1][1]) < tolFrac * diag) {
    simple = simple.slice(0, -1);
  }
  if (!(simple.length >= 3 && simple.length <= POLYGON_MAX_CORNERS)) return [];
  return simple;
}

/** Do all four edges run square to the page? That is what makes a hand-drawn
 * box a RECTANGLE rather than a general quadrilateral — the distinction has to
 * be made on ANGLE, not on which candidate fits best. */
export function quadIsAxisAligned(corners, tolDeg = 12.0) {
  for (let i = 0; i < corners.length; i++) {
    const [ax, ay] = corners[i];
    const [bx, by] = corners[(i + 1) % corners.length];
    if (Math.hypot(bx - ax, by - ay) < 1e-9) return false;
    let deg = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI;
    deg = ((deg % 90) + 90) % 90;      // Python's % is always non-negative
    if (Math.min(deg, 90 - deg) > tolDeg) return false;
  }
  return true;
}

/** Classify a freehand polyline into a clean primitive. Returns
 * `{kind, pts}` with kind "line" | "path" | "rect" | "ellipse" | "polygon". */
export function recognizeShape(pts) {
  if (pts.length < 2) return { kind: "line", pts: pts.slice() };
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const minx = Math.min(...xs), maxx = Math.max(...xs);
  const miny = Math.min(...ys), maxy = Math.max(...ys);
  const w = maxx - minx, h = maxy - miny;
  const start = pts[0], end = pts[pts.length - 1];

  if (!polylineIsClosed(pts)) {
    // an open stroke is either a run of straight segments or one line; the
    // loop test has already ruled out "the ends met", which is the only thing
    // that makes a shape closed
    const path = openPathCorners(pts);
    return path.length ? { kind: "path", pts: path }
                       : { kind: "line", pts: [start, end] };
  }

  const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
  let rx = Math.max(w / 2, 1e-6), ry = Math.max(h / 2, 1e-6);
  // Fit the candidates and keep the smallest residual, all as a total over the
  // SAME points so the sums compare directly. For a rectangle every point hugs
  // a bbox edge; an ellipse's corners bow inward, so its points sit far from
  // every edge there. For an ellipse the normalised radius is ~1 everywhere; a
  // rectangle's corners push it out to ~sqrt(2). The two errors disagree
  // exactly at the corners, which is what separates the shapes.
  let rectErr = 0, ellErr = 0;
  for (const [x, y] of pts) {
    rectErr += Math.min(Math.abs(x - minx), Math.abs(x - maxx),
                        Math.abs(y - miny), Math.abs(y - maxy));
    ellErr += Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1) * (rx + ry) / 2;
  }
  let corners = polygonCorners(pts);
  let polyErr = corners.length
    ? polylineResidual(pts, corners.concat([corners[0]])) : Infinity;

  // RECT stays its own kind and wins its own case outright: rectangles are
  // re-derived geometrically for the grid dividers, and a hand-drawn box is
  // ALSO a good 4-corner polygon — a slightly tilted quad through its real
  // corners even fits BETTER than the axis-aligned bbox, so on residual alone
  // the polygon would quietly take the grid snap away. Four corners that sit
  // square to the page mean "rectangle".
  if (corners.length === 4 && quadIsAxisAligned(corners)) {
    corners = [];
    polyErr = Infinity;
  }
  if (rectErr <= ellErr && rectErr <= polyErr) {
    return { kind: "rect", pts: [[minx, miny], [maxx, miny], [maxx, maxy],
                                 [minx, maxy], [minx, miny]] };
  }
  if (polyErr < ellErr) {
    return { kind: "polygon", pts: corners.concat([corners[0]]) };
  }
  // A hand-drawn circle lands as a faintly oval ellipse otherwise, which reads
  // as sloppy recognition even though it is perfectly faithful.
  if (Math.abs(rx - ry) <= CIRCLE_TOLERANCE * Math.max(rx, ry)) {
    rx = ry = (rx + ry) / 2;
  }
  const n = Math.max(24, pts.length);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = (2 * Math.PI * i) / n;
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return { kind: "ellipse", pts: out };
}

/** The bbox if `pts` traces an axis-aligned rectangle perimeter, else null.
 *
 * Detected GEOMETRICALLY, not from a stored tag, so it survives a save/reload
 * and works on any rectangle-like stroke — the recognised ones hit it exactly. */
export function rectBboxOf(pts, tolFrac = 0.10) {
  if (pts.length < 4) return null;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const minx = Math.min(...xs), maxx = Math.max(...xs);
  const miny = Math.min(...ys), maxy = Math.max(...ys);
  const w = maxx - minx, h = maxy - miny;
  if (w < 1e-6 || h < 1e-6) return null;
  const tol = tolFrac * Math.hypot(w, h);
  if (Math.hypot(pts[0][0] - pts[pts.length - 1][0],
                 pts[0][1] - pts[pts.length - 1][1]) > tol) return null;
  for (const [x, y] of pts) {
    if (Math.min(Math.abs(x - minx), Math.abs(x - maxx),
                 Math.abs(y - miny), Math.abs(y - maxy)) > tol) return null;
  }
  return [minx, miny, maxx, maxy];
}

/** `count` evenly-spaced interior positions across [lo, hi] — the lines that
 * cut the span into count+1 equal cells. */
export function evenDividerPositions(lo, hi, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(lo + ((hi - lo) * (i + 1)) / (count + 1));
  return out;
}

/** The label shown at the cursor when a dwell recognises something. Every kind
 * needs an entry — a missing one is an error mid-gesture. */
export const SNAP_LABELS = {
  line: "Line", path: "Path", rect: "Rectangle", ellipse: "Ellipse",
  polygon: "Polygon", vdiv: "Divider", hdiv: "Divider",
};

// ── grid dividers ────────────────────────────────────────────────────────────
//
// A straight line drawn inside a rectangle already on the page becomes a
// full-span divider at its even grid slot, and its siblings re-space to equal
// cells. Rectangles are found GEOMETRICALLY (rectBboxOf), so this survives a
// save and reload and needs no stored tag — which is also why `rect` has to win
// its own case in recognizeShape on angle rather than on fit.

/** The smallest rectangle-stroke whose interior contains (x, y), or null. */
export function rectContaining(strokes, x, y) {
  let best = null, bestArea = null;
  for (const st of strokes) {
    const bb = rectBboxOf(st.pts);
    if (!bb) continue;
    const [minx, miny, maxx, maxy] = bb;
    if (minx < x && x < maxx && miny < y && y < maxy) {
      const area = (maxx - minx) * (maxy - miny);
      if (bestArea === null || area < bestArea) { best = bb; bestArea = area; }
    }
  }
  return best;
}

/** Existing full-span dividers of the given orientation inside `rect` —
 * 2-point straight lines spanning it. */
export function dividersInRect(strokes, rect, vertical) {
  const [minx, miny, maxx, maxy] = rect;
  const tol = 0.08 * Math.hypot(maxx - minx, maxy - miny);
  const out = [];
  for (const st of strokes) {
    const pts = st.pts;
    if (!pts || pts.length !== 2) continue;
    const [[ax, ay], [bx, by]] = pts;
    if (vertical) {
      if (Math.abs(ax - bx) <= tol && minx - tol < ax && ax < maxx + tol
          && Math.abs(Math.min(ay, by) - miny) <= tol
          && Math.abs(Math.max(ay, by) - maxy) <= tol) out.push(st);
    } else if (Math.abs(ay - by) <= tol && miny - tol < ay && ay < maxy + tol
               && Math.abs(Math.min(ax, bx) - minx) <= tol
               && Math.abs(Math.max(ax, bx) - maxx) <= tol) {
      out.push(st);
    }
  }
  return out;
}

/** If the straight segment p0→p1 lies inside a rectangle on the page, snap it
 * to a full-span divider at its even grid slot: `{kind, pts}` with kind "vdiv"
 * or "hdiv". Siblings are re-spaced at COMMIT, not here. */
export function snapGridDivider(strokes, p0, p1) {
  const vertical = Math.abs(p1[1] - p0[1]) >= Math.abs(p1[0] - p0[0]);
  const mx = (p0[0] + p1[0]) / 2, my = (p0[1] + p1[1]) / 2;
  const rect = rectContaining(strokes, mx, my);
  if (!rect) return null;
  const [minx, miny, maxx, maxy] = rect;
  const sibs = dividersInRect(strokes, rect, vertical);
  if (vertical) {
    const positions = sibs.map((s) => s.pts[0][0]).concat([mx]).sort((a, b) => a - b);
    const rank = positions.indexOf(mx);
    const slot = evenDividerPositions(minx, maxx, sibs.length + 1)[
      Math.min(rank < 0 ? sibs.length : rank, sibs.length)];
    return { kind: "vdiv", pts: [[slot, miny], [slot, maxy]] };
  }
  const positions = sibs.map((s) => s.pts[0][1]).concat([my]).sort((a, b) => a - b);
  const rank = positions.indexOf(my);
  const slot = evenDividerPositions(miny, maxy, sibs.length + 1)[
    Math.min(rank < 0 ? sibs.length : rank, sibs.length)];
  return { kind: "hdiv", pts: [[minx, slot], [maxx, slot]] };
}

/** Re-space every divider of `newStroke`'s orientation inside its rectangle to
 * equal cells. Returns the sibling records for the undo entry — the whole
 * gesture is ONE entry: remove the new divider, restore the siblings. */
export function respaceDividers(strokes, newStroke, vertical) {
  const [a, b] = newStroke.pts;
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const rect = rectContaining(strokes, mx, my);
  if (!rect) return null;
  const [minx, miny, maxx, maxy] = rect;
  const sibs = dividersInRect(strokes, rect, vertical);   // includes the new one
  const old = new Map();
  for (const s of sibs) if (s !== newStroke) old.set(s, s.pts.map((p) => p.slice()));
  const positions = evenDividerPositions(vertical ? minx : miny,
                                         vertical ? maxx : maxy, sibs.length);
  sibs.forEach((s, i) => {
    const pos = positions[i];
    s.pts = vertical ? [[pos, miny], [pos, maxy]] : [[minx, pos], [maxx, pos]];
  });
  return sibs.filter((s) => s !== newStroke)
    .map((s) => ({ stroke: s, before: old.get(s), after: s.pts.map((p) => p.slice()) }));
}
