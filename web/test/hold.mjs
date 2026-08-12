// Holding still, when a hand cannot.
//
// Both dwells were reported as "too precisely not moving" to use. A hand
// holding a pen against glass for half a second drifts; it does not stop. The
// web port had NO tolerance on circle-to-lasso — one motion event cancelled it
// — and re-armed the shape dwell on every event, so a shaking hand reset that
// clock for ever and it never fired at all.
//
// The two tolerances measure from different origins, and the difference is the
// design: the lasso hold from where the press LANDED (so a slow drag across the
// page can never become a selection), the shape dwell from wherever the pen was
// last moving (you draw a shape and then stop).
//
//   node web/test/hold.mjs

import { HOLD_SLOP_PX } from "../src/surface.js";

let checks = 0, failures = 0;
function check(name, got, want) {
  checks++;
  if (got !== want) {
    failures++;
    console.error(`  ✗ ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

/** The two decisions the move handler makes, as the handler makes them. */
const lassoSurvives = (start, at) =>
  Math.hypot(at[0] - start[0], at[1] - start[1]) <= HOLD_SLOP_PX;
const dwellRestarts = (anchor, at) =>
  Math.hypot(at[0] - anchor[0], at[1] - anchor[1]) > HOLD_SLOP_PX;

// ── a hand that shakes still counts as holding ──────────────────────────────
// Real pen jitter while trying to hold still is a couple of px per report.
{
  const start = [400, 300];
  let anchor = [...start];
  let restarts = 0, cancelled = false;
  // half a second of a hand not being a clamp: jitter plus a slow drift
  for (let i = 0; i < 60; i++) {
    const at = [start[0] + Math.sin(i) * 2.5 + i * 0.08,
                start[1] + Math.cos(i * 1.7) * 2.5 + i * 0.05];
    if (!lassoSurvives(start, at)) cancelled = true;
    if (dwellRestarts(anchor, at)) { anchor = at; restarts++; }
  }
  check("the lasso hold survives a shaking hand", cancelled, false);
  check("and the dwell's clock is never restarted", restarts, 0);
}

// ── a press that goes somewhere is a stroke, not a hold ─────────────────────
{
  const start = [400, 300];
  let cancelled = false;
  for (let i = 1; i <= 30; i++) {
    if (!lassoSurvives(start, [start[0] + i * 3, start[1]])) cancelled = true;
  }
  check("a real stroke cancels the lasso hold", cancelled, true);
}

// ── a SLOW drag is still a stroke: the origin never moves ───────────────────
// The lasso's anchor is deliberately not re-based. Re-basing it would keep the
// hold alive across a slow drag over the whole page, and the selection would
// fire in the middle of drawing.
{
  const start = [400, 300];
  let cancelled = false;
  for (let i = 1; i <= 200; i++) {          // 0.4 px a report: very slow
    if (!lassoSurvives(start, [start[0] + i * 0.4, start[1]])) cancelled = true;
  }
  check("a slow drag is not a hold", cancelled, true);
}

// ── the dwell fires from where you STOPPED, not where you started ──────────
// Drawing a shape and then holding still at its far end must arm the clock
// there; measuring from the press origin would mean it never armed at all.
{
  let anchor = [100, 100];
  let restarts = 0;
  for (let i = 1; i <= 40; i++) {
    const at = [100 + i * 8, 100 + i * 6];
    if (dwellRestarts(anchor, at)) { anchor = at; restarts++; }
  }
  check("travelling keeps restarting the clock", restarts > 0, true);
  // then the hand stops, near where it ended
  let restartedWhileStill = 0;
  for (let i = 0; i < 40; i++) {
    const at = [anchor[0] + Math.sin(i) * 2, anchor[1] + Math.cos(i) * 2];
    if (dwellRestarts(anchor, at)) restartedWhileStill++;
  }
  check("and stops restarting once the hand does", restartedWhileStill, 0);
}

// ── the tolerance is a HAND, so it must be reachable but not vast ──────────
// Bounds, not a value: it has moved once already and will move again.
{
  check("bigger than pen jitter", HOLD_SLOP_PX >= 10, true);
  check("smaller than a letter", HOLD_SLOP_PX <= 30, true);
}

if (failures) {
  console.error(`\n✗ ${failures} of ${checks} hold checks failed.`);
  process.exit(1);
}
console.log(`✓ ${checks} hold checks passed (a hold tolerates a hand that shakes).`);
