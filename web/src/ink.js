// The Sidemark ink pipeline, ported from sidemark.py.
//
// This is a FAITHFUL port, not a reinterpretation. Every constant and every
// ordering decision here was settled by measurement on real captured strokes
// (ideas.csv rows 139/143/144/147), and the traps below are the ones that cost
// the most to find — they are re-stated because a port is exactly where they
// come back.
//
// `web/test/conformance.mjs` checks this file against vectors generated from
// the Python original. If you change anything here, that is what tells you
// whether you changed the SHAPE of the ink or just the code.
//
// What the pen writes goes through three steps on commit, and the whole point
// is that they are three DIFFERENT jobs. Conflating two of them is what made
// fast handwriting shrink:
//
//   1. resampleInk()  — INTERPOLATE. A digitiser samples at a fixed rate, so
//      the faster you write the fewer points you get: a quick "o" arrives as a
//      12-gon. The gaps are filled along a CENTRIPETAL Catmull-Rom spline,
//      chosen because it INTERPOLATES — the curve passes through every point
//      the pen reported, so filling a gap can never move the line off where
//      you drew it. The walk is at fixed ARC LENGTH, so it also thins a slow
//      stroke's clusters and hands step 2 a polyline whose spacing no longer
//      depends on pen speed.
//   2. taubinSmooth() — DENOISE. Removes tremor without shrinking the shape.
//   3. widthProfile() — SHAPE. Folds pressure and the end taper into one
//      per-point width factor.
//
// Points are `[x, y, w]` triples through the pipeline; the third component is
// carried by every step so a width profile survives resampling with no
// separate pass.

export const INK_RESAMPLE_SPACING = 1.0;  // document units between points after
                                          // resampling, for a stroke of
                                          // ordinary size. A default pen is 2.0
                                          // units wide, so this is half a nib.
export const INK_SPACING_FRAC = 1 / 40.0; // spacing as a fraction of the
                                          // stroke's feature size
export const INK_SPACING_MIN = 0.12;
export const INK_SPACING_MAX = 2.0;
export const INK_MAX_POINTS = 3000;       // hard ceiling per stroke — a
                                          // page-long scribble widens its own
                                          // spacing rather than growing without
                                          // bound.
export const INK_SMOOTH_PAIRS = 20;       // λ/μ pairs. λ is capped at 0.5 by
                                          // stability, so the pass COUNT is the
                                          // only knob that deepens the stopband.
export const TAUBIN_MU_RATIO = 1.06;      // μ = -ratio·λ. Being slightly GREATER
                                          // than 1 is what makes the second
                                          // pass inflate a shade more than the
                                          // first shrank — the whole trick.

export const ERASE_SLACK_PX = 3.0;   // how far OUTSIDE the visible ink still
                                     // erases it

/** How close to a stroke's CENTRELINE counts as touching it.
 *
 * The eraser deletes a whole stroke on contact, so this is not a brush size:
 * it is "did I touch the ink". That is why it tracks the stroke's own width —
 * half of it reaches the visible edge, so clicking anywhere on a fat
 * highlighter erases it — plus a small fixed slack for an imperfect aim. */
export function eraseRadius(width) {
  return width / 2.0 + ERASE_SLACK_PX;
}

/** How big are the marks in this stroke, in document units.
 *
 * Every length in the pipeline is scaled by this, because all of them are
 * really "a fraction of a letter" and only looked like constants because the
 * writing they were tuned on was one size.
 *
 * The measure is the SMALLER side of the bounding box, not its diagonal: for a
 * run of cursive the small side is the x-height, which is the size of the
 * features that must survive, while the diagonal is just how long the word is.
 * The diagonal fallback rescues a degenerate box (a straight line has no
 * height) and is deliberately SMALL — at 0.15 it would win above about 6.6:1,
 * which ordinary cursive exceeds, and the measure would then grow with how long
 * the WORD is, the exact opposite of what it is for. */
export function inkFeatureSize(pts) {
  if (pts.length < 2) return 0.0;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  const w = maxX - minX, h = maxY - minY;
  return Math.max(Math.min(w, h), Math.hypot(w, h) * 0.05);
}

/** Resample spacing for this stroke — and, because a fixed pass count over a
 * fixed spacing is a fixed smoothing radius, this is what makes the DENOISE
 * scale with the writing too. One number, both effects. */
export function adaptiveSpacing(pts, base = INK_RESAMPLE_SPACING) {
  const size = inkFeatureSize(pts);
  if (size <= 0) return base;
  return Math.max(INK_SPACING_MIN, Math.min(INK_SPACING_MAX, size * INK_SPACING_FRAC));
}

/** Drop consecutive samples that land on the same spot. A digitiser repeats its
 * last position while the pen rests, and a zero-length segment has no tangent —
 * which would make the spline and the stroke outline both blow up. */
function dedupePoints(pts, eps = 1e-6) {
  const out = [];
  for (const p of pts) {
    if (!out.length || Math.hypot(p[0] - out[out.length - 1][0],
                                  p[1] - out[out.length - 1][1]) > eps) {
      out.push(p);
    }
  }
  return out;
}

function mix(a, b, u) {
  return [a[0] + (b[0] - a[0]) * u,
          a[1] + (b[1] - a[1]) * u,
          a[2] + (b[2] - a[2]) * u];
}

/** `n` points along the centripetal Catmull-Rom segment p1→p2, starting at p1
 * and stopping before p2.
 *
 * Barry–Goldman pyramid form, with knots spaced by sqrt(chord) — that exponent
 * (alpha = 0.5) IS "centripetal", and it is what stops the curve looping out
 * past a sharp corner the way uniform Catmull-Rom does. */
function crSegment(p0, p1, p2, p3, n) {
  const t0 = 0.0;
  const t1 = t0 + Math.sqrt(Math.max(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), 1e-9));
  const t2 = t1 + Math.sqrt(Math.max(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]), 1e-9));
  const t3 = t2 + Math.sqrt(Math.max(Math.hypot(p3[0] - p2[0], p3[1] - p2[1]), 1e-9));
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = t1 + (t2 - t1) * (i / n);
    const a1 = mix(p0, p1, (t - t0) / (t1 - t0));
    const a2 = mix(p1, p2, (t - t1) / (t2 - t1));
    const a3 = mix(p2, p3, (t - t2) / (t3 - t2));
    const b1 = mix(a1, a2, (t - t0) / (t2 - t0));
    const b2 = mix(a2, a3, (t - t1) / (t3 - t1));
    out.push(mix(b1, b2, (t - t1) / (t2 - t1)));
  }
  return out;
}

/** Re-space a dense polyline at a fixed arc length. The pen's real first and
 * last points always survive — a stroke must start and end where you put it,
 * however the middle is re-spaced. */
function walkArcLength(dense, spacing) {
  const out = [dense[0]];
  let acc = 0.0;
  let a = dense[0];
  for (let i = 1; i < dense.length; i++) {
    const b = dense[i];
    let seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    while (acc + seg >= spacing && seg > 1e-12) {
      const u = (spacing - acc) / seg;
      a = mix(a, b, u);
      out.push(a);
      seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
      acc = 0.0;
    }
    acc += seg;
    a = b;
  }
  const last = dense[dense.length - 1];
  if (Math.hypot(out[out.length - 1][0] - last[0],
                 out[out.length - 1][1] - last[1]) > 1e-9) {
    out.push(last);
  }
  return out;
}

/** Fill the gaps a fast stroke leaves and even out the spacing. */
export function resampleInk(pts, spacing = INK_RESAMPLE_SPACING,
                            maxPoints = INK_MAX_POINTS) {
  pts = dedupePoints(pts);
  if (pts.length < 3) return pts.slice();
  // phantom end points, mirrored through the real ones, so the first and last
  // segments get the same treatment as the interior ones
  const n = pts.length;
  const pad = [[2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1], pts[0][2]],
               ...pts,
               [2 * pts[n - 1][0] - pts[n - 2][0],
                2 * pts[n - 1][1] - pts[n - 2][1], pts[n - 1][2]]];
  let total = 0.0;
  for (let i = 1; i < n; i++) {
    total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  if (total <= 0) return pts.slice();
  // honour the ceiling by coarsening, never by truncating the stroke
  spacing = Math.max(spacing, total / maxPoints);
  const dense = [];
  for (let i = 0; i < pad.length - 3; i++) {
    const p0 = pad[i], p1 = pad[i + 1], p2 = pad[i + 2], p3 = pad[i + 3];
    const chord = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    // subdivide finer than the target spacing: the walk below re-spaces
    // exactly, and it can only be as accurate as the curve it walks
    const steps = Math.max(1, Math.min(64, Math.ceil(chord / (spacing * 0.5))));
    for (const q of crSegment(p0, p1, p2, p3, steps)) dense.push(q);
  }
  dense.push(pad[pad.length - 2]);
  return walkArcLength(dense, spacing);
}

/** One weighted pass toward each interior point's neighbour MIDPOINT. A
 * negative factor pushes away, which is how Taubin's second pass undoes the
 * first one's shrinkage. Endpoints are fixed; the width component is carried
 * through untouched.
 *
 * IT MUST BE THE MIDPOINT — `(a + b)/2 - c` — and never `a + b - 2c`. The two
 * differ by a factor of two, which puts the operator's eigenvalues in [0, 2]
 * instead of [0, 4], and Taubin's λ/μ are only a low-pass filter on the
 * former: with the doubled form the μ pass AMPLIFIES the highest frequency
 * instead of restoring it. It passes a circle test while broken, so the
 * conformance vectors are what actually guard this. */
function laplacianPass(pts, factor) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], c = pts[i], b = pts[i + 1];
    out.push([c[0] + factor * ((a[0] + b[0]) / 2 - c[0]),
              c[1] + factor * ((a[1] + b[1]) / 2 - c[1]),
              c[2]]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Remove tremor WITHOUT shrinking the shape. `strength` 0..1 scales λ.
 *
 * Each pair is a λ pass (shrink, smoothing) followed by a μ = -ratio·λ pass
 * (inflate). High-frequency wobble is attenuated by both; low-frequency shape —
 * the size of a letter, the radius of an "o" — is restored by the second. This
 * is the whole reason a fast "o" keeps its size. */
export function taubinSmooth(pts, strength, pairs = INK_SMOOTH_PAIRS,
                             muRatio = TAUBIN_MU_RATIO) {
  if (strength <= 0 || pts.length < 3) return pts.slice();
  const lam = 0.5 * Math.min(strength, 1.0);  // 0.5 is Taubin's own upper bound
  const mu = -muRatio * lam;
  let cur = pts.slice();
  for (let i = 0; i < pairs; i++) {
    cur = laplacianPass(cur, lam);
    cur = laplacianPass(cur, mu);
  }
  return cur;
}

/** Drop the feather-light TAIL of a stroke — and only the tail.
 *
 * A minimum-pressure gate has to be asymmetric, because the two things it could
 * act on are opposite problems at opposite ends:
 *
 *   - The END is a real skid. The pen unloads before it leaves the glass, so
 *     the last millimetres are a light smear running on toward the next letter.
 *     Cutting it is the whole point of the setting.
 *   - The START is already CLIPPED, not smeared. The digitiser reports no
 *     contact until its own threshold is crossed, so the first sample already
 *     carries real pressure and the ink before it was never captured. Gating
 *     the start makes "the stroke begins too late" strictly worse.
 *
 * The trim also stops at the first point at or above the threshold rather than
 * filtering the whole stroke, because a dip in the MIDDLE is the pen still
 * writing. */
export function trimLightTail(pts, press, minPressure) {
  if (!press || !press.length || minPressure <= 0 || pts.length !== press.length) {
    return [pts, press];
  }
  let end = pts.length;
  while (end > 2 && press[end - 1] < minPressure) end -= 1;
  return [pts.slice(0, end), press.slice(0, end)];
}

export const INK_PRESS_FLOOR = 0.35;  // width factor at the lightest touch, as a
                                      // fraction of the pen's nominal width.
                                      // Zero would give an invisible hairline.
export const INK_PRESS_GAMMA = 0.5;   // pressure→width curve. People write far
                                      // lighter than they think: measured
                                      // strokes sat around 0.3, which linearly
                                      // would be a permanently thin pen.
export const INK_TAPER_LEN = 2.5;     // longest the entry/exit ramp may be, in
                                      // document units of arc length.
export const INK_TAPER_FRAC = 0.18;   // ...but never more than this share of the
                                      // stroke, per end. A FIXED ramp is the
                                      // whole of a short stroke, which is why
                                      // the dot on an "i" came out at half
                                      // thickness. The ramp has to be a fraction
                                      // of the mark, not of the page.
export const INK_TAPER_MIN = 0.4;     // width factor at the very tip
export const INK_DOT_LEN = 5.0;       // arc length under which a mark is a DOT
export const INK_DOT_BOOST = 2.0;     // ...and a dot has to be WIDER than the
                                      // line the same pen draws, or it
                                      // disappears. Lands a dot at ~1.6x the
                                      // stem beside it — that ratio is the
                                      // number to hold onto, not this constant.

/** Width multiplier for a short mark, fading to 1.0 at INK_DOT_LEN. */
export function dotBoost(totalLen) {
  if (totalLen >= INK_DOT_LEN) return 1.0;
  const u = Math.max(0.0, totalLen) / INK_DOT_LEN;
  return INK_DOT_BOOST + (1.0 - INK_DOT_BOOST) * u;
}

/** The per-point width factor for a freehand stroke: pen pressure (if the
 * device reported any) shaped by INK_PRESS_GAMMA, multiplied by an entry and
 * exit ramp. Returns an array as long as `pts`. */
export function widthProfile(pts, press = null, {
  taper = true, dot = true,
  taperLen = INK_TAPER_LEN, taperMin = INK_TAPER_MIN,
} = {}) {
  const n = pts.length;
  if (n === 0) return [];
  let prof;
  if (press && press.length) {
    prof = press.map((p) => INK_PRESS_FLOOR + (1.0 - INK_PRESS_FLOOR)
      * Math.pow(Math.max(0.0, Math.min(1.0, p)), INK_PRESS_GAMMA));
  } else {
    prof = new Array(n).fill(1.0);
  }
  // arc length from each end, so the ramp is a distance ON THE PAGE and not a
  // point count — a fast stroke has fewer points over the same millimetres
  const fwd = [];
  let acc = 0.0;
  for (let i = 0; i < n; i++) {
    if (i) acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    fwd.push(acc);
  }
  const total = acc;

  // A DOT IS NOT A STROKE WITH ENDS. Capping the ramp's LENGTH is not enough:
  // the ramp multiplies each ENDPOINT by taperMin whatever its length, and a
  // dot is nothing but endpoints — so a tap came out at 0.4x before the boost
  // even multiplied it back. That bit only marks where the digitiser reported
  // three samples instead of two, because the too-short-to-resample path passes
  // taper=false and skips it: the same tap of the same pen painted 2.4x
  // differently depending on which branch it fell down. The two paths have to
  // agree, so the test is the same one that decides a dot is a dot.
  const dotMark = dot && total < INK_DOT_LEN;
  if (dotMark) taper = false;

  if (taper && n >= 2 && taperLen > 0 && total > 0) {
    taperLen = Math.min(taperLen, total * INK_TAPER_FRAC);
    for (let i = 0; i < n; i++) {
      const d = Math.min(fwd[i], total - fwd[i]);
      if (d < taperLen) {
        const u = d / taperLen;
        prof[i] *= taperMin + (1.0 - taperMin) * u;
      }
    }
  }

  // A DOT HAS NO DIRECTION, so it must have no width variation ALONG it. Its
  // pressure trace is not shape, it is the touchdown/liftoff envelope: the last
  // sample of a tap reads ~0 because that is the pen leaving the glass. Left
  // per-point, one end is drawn at the pressure floor and the other at full
  // boost, and a round tap comes out as a TEARDROP pointing whichever way the
  // pen happened to lift. The peak is the pressure the dot was actually made
  // with. (trimLightTail cannot help here: a tap under three samples returns
  // before it runs, and trimming a two-sample mark leaves nothing to draw.)
  if (dotMark && prof.length) {
    const peak = Math.max(...prof);
    prof = new Array(n).fill(peak);
  }

  // applied LAST and independently of the taper, so it survives a stroke too
  // short to have a meaningful ramp — which is every dot
  const boost = dot ? dotBoost(total) : 1.0;
  if (boost !== 1.0) prof = prof.map((p) => p * boost);
  return prof;
}

function isFlatProfile(prof) {
  return prof.every((v) => Math.abs(v - 1.0) < 1e-6);
}

/** The whole commit pipeline, and THE decision about what gets it.
 *
 * Every finished stroke routes through here, so nothing can drift on what
 * counts as handwriting. `pts` are `[x, y]` pairs and `press` the matching raw
 * pressure list (empty from a mouse).
 *
 * A SNAPPED stroke (`wasStraight`) is geometry a dwell already settled —
 * resampling or tapering it would undo that decision — and a FLAT one (the
 * highlighter) is a marker, not a nib, so it keeps one width end to end.
 * Everything else is handwriting and gets interpolated, denoised and shaped.
 *
 * Returns `{pts, profile}`; profile is null when the stroke should paint flat. */
export function finishInkStroke(pts, press, strength, {
  wasStraight = false, flat = false, minPressure = 0.0, spacing = null,
} = {}) {
  if (wasStraight) return { pts: pts.slice(), profile: null };
  if (pts.length < 3) {
    // a tap, or a flick of two samples: too short to resample, but this is
    // exactly the case that must still read as a DOT
    if (flat) return { pts: pts.slice(), profile: null };
    const prof = widthProfile(pts, press, { taper: false, dot: true });
    return { pts: pts.slice(), profile: isFlatProfile(prof) ? null : prof };
  }
  // NB `flat` drops pressure and the taper — it does NOT skip the pipeline. A
  // highlighter still has to be interpolated and denoised; it is a marker,
  // which means one WIDTH end to end, not a stroke left as raw samples.
  press = flat ? [] : (press || []);
  [pts, press] = trimLightTail(pts, press, minPressure);
  const taper = !flat;
  if (spacing === null) spacing = adaptiveSpacing(pts);
  let trip = pts.map((p, i) => [p[0], p[1], i < press.length ? press[i] : 1.0]);
  trip = resampleInk(trip, spacing);
  trip = taubinSmooth(trip, strength);
  const out = trip.map((t) => [t[0], t[1]]);
  let prof = widthProfile(out, press.length ? trip.map((t) => t[2]) : null,
                          { taper, dot: !flat });
  if (prof.length && isFlatProfile(prof)) prof = null;  // nothing to say
  return { pts: out, profile: prof };
}

export const LIVE_SMOOTH_MAX_PTS = 600;  // raw samples re-shaped per motion
                                         // event. The pipeline is O(n) and runs
                                         // on every event; past the window only
                                         // the TAIL is re-shaped and the head
                                         // stays as it was until commit — a
                                         // graceful floor, since that is what
                                         // the whole live line used to be.

/** The stroke still in FLIGHT, shaped the way its commit will shape it.
 *
 * Interpolates and denoises exactly as `finishInkStroke` does, so the line
 * under the nib is the line you are going to be left with. Two steps of the
 * commit pipeline are deliberately skipped, both because the stroke is not
 * finished: the raw samples are not CAPTURED (that record is per STROKE, not
 * per motion event), and the light tail is not TRIMMED (mid-stroke the falling
 * edge is just where the pen IS — trimming it would eat the tip and give it
 * back the moment you pressed harder). The tail is the one place the live line
 * and the committed line differ.
 *
 * `lead` is the predicted tip. It is appended AFTER the smoothing, never
 * before: the guess is meant to extend the line, not to bend the real samples
 * behind it toward itself (denoising pins its endpoints, so a predicted tip
 * passed through it would drag the last real points onto a guess).
 *
 * Note that a new sample re-indexes almost every resampled point while the PATH
 * stays put. That looks alarming in a diff and is invisible on screen — so any
 * test of this must compare SHAPE, never index-aligned positions. */
export function liveInkStroke(pts, press, strength, {
  flat = false, spacing = null, window = LIVE_SMOOTH_MAX_PTS, lead = null,
} = {}) {
  press = flat ? [] : (press || []).slice();
  if (pts.length >= 3) {
    // from the WHOLE stroke, so a sliding window cannot change the spacing (and
    // with it the smoothing radius) as you draw
    if (spacing === null) spacing = adaptiveSpacing(pts);
    let head = [], headPress = [];
    if (window && pts.length > window) {
      const cut = pts.length - window;
      head = pts.slice(0, cut);
      pts = pts.slice(cut);
      headPress = press.slice(0, cut);
      press = press.slice(cut);
    }
    let trip = pts.map((p, i) => [p[0], p[1], i < press.length ? press[i] : 1.0]);
    trip = resampleInk(trip, spacing);
    trip = taubinSmooth(trip, strength);
    // the join is seamless without blending: resampling starts at the first
    // point and denoising holds both endpoints, so head and tail still meet at
    // exactly the sample they were split on
    pts = head.concat(trip.map((t) => [t[0], t[1]]));
    press = press.length ? headPress.concat(trip.map((t) => t[2])) : [];
  } else {
    pts = pts.slice();
  }
  if (lead !== null) {
    pts = pts.concat([lead]);
    if (press.length) press = press.concat([press[press.length - 1]]);
  }
  if (flat) return { pts, profile: null };
  const prof = widthProfile(pts, press.length ? press : null);
  return { pts, profile: isFlatProfile(prof) ? null : prof };
}

// ── the hover lead-in ────────────────────────────────────────────────────────
//
// Free REAL data, and the only half of the latency story that invents nothing.
// A stylus is tracked while it hovers (the browser reports pointermove with
// `buttons === 0` for a pen in proximity), so we already know where the pen was
// in the milliseconds before the digitiser admitted contact — which is exactly
// the ink that "gets captured too late" was missing.
//
// The PREDICTION half of the Python original is deliberately NOT ported.
// It was settled by grading against 133 Hz captured ink: it recovers ~10% of
// the lag error at a 10–20 ms lead, ~0 at 40 ms, and is NEGATIVE beyond. The
// pen's real lag was measured to be upstream of the compositor. Don't rebuild
// it here — including via `getPredictedEvents()`, which is the same guess with
// a vendor's name on it.

export const HOVER_TRAIL_MS = 250.0;      // how much hover history to keep
export const HOVER_LEAD_MS = 70.0;        // how much may become a lead-in
export const HOVER_LEAD_MAX_STEP = 30.0;  // px between consecutive hover samples
                                          // that still counts as "the same
                                          // approach". A bigger jump is the pen
                                          // arriving from somewhere else, and
                                          // walking back through it would draw a
                                          // line across the page.

/** The tail of the hover trail that plausibly belongs to a stroke starting at
 * (x, y) — in forward order, excluding the press point itself.
 *
 * Walks BACKWARDS from the press and stops at the first sample that is too old
 * or too far from the one after it. Stopping on the gap is what keeps a pen
 * that swooped in from the other side of the page from drawing its approach. */
export function hoverLeadIn(trail, x, y, now, lead_ms = HOVER_LEAD_MS,
                            maxStep = HOVER_LEAD_MAX_STEP) {
  const out = [];
  let px = x, py = y;
  for (let i = trail.length - 1; i >= 0; i--) {
    const [sx, sy, t] = trail[i];
    if (now - t > lead_ms) break;
    if (Math.hypot(sx - px, sy - py) > maxStep) break;
    out.push([sx, sy]);
    px = sx; py = sy;
  }
  out.reverse();
  return out;
}
