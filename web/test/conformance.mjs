// Check web/src/ink.js against vectors generated from sidemark.py.
//
// The point of this file is that the ink pipeline was tuned by MEASUREMENT, so
// a port is only as good as its agreement with the original — reading the code
// does not settle it. Several of the traps in there pass a plausibility check
// while broken (the doubled Laplacian smooths a circle correctly and amplifies
// the Nyquist frequency; a dot with a per-point profile looks fine until you
// notice it is a teardrop), which is exactly what a numeric oracle catches.
//
//   extras/export_ink_vectors.py > web/test/vectors.json
//   node web/test/conformance.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as ink from "../src/ink.js";

const here = dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(readFileSync(join(here, "vectors.json"), "utf8"));

const EPS = 1e-6;
let checks = 0, failures = 0;
const failed = new Set();

function fail(name, msg) {
  failures++;
  failed.add(name);
  if (failures <= 12) console.error(`  ✗ ${name}: ${msg}`);
  else if (failures === 13) console.error("  … (further failures suppressed)");
}

function closeNum(name, got, want, eps = EPS) {
  checks++;
  if (!Number.isFinite(got)) return fail(name, `got ${got}, want ${want}`);
  if (Math.abs(got - want) > eps) {
    fail(name, `got ${got}, want ${want} (Δ ${Math.abs(got - want).toExponential(2)})`);
  }
}

function closeList(name, got, want, eps = EPS) {
  checks++;
  if (!Array.isArray(got)) return fail(name, `got ${typeof got}, want an array`);
  if (got.length !== want.length) {
    return fail(name, `length ${got.length}, want ${want.length}`);
  }
  let worst = 0, at = -1;
  for (let i = 0; i < want.length; i++) {
    const a = got[i], b = want[i];
    const d = Array.isArray(b)
      ? Math.max(...b.map((v, j) => Math.abs((a[j] ?? NaN) - v)))
      : Math.abs(a - b);
    if (!(d <= eps) && d > worst) { worst = d; at = i; }
  }
  if (at >= 0) {
    fail(name, `worst Δ ${worst.toExponential(3)} at index ${at} `
      + `(got ${JSON.stringify(got[at])}, want ${JSON.stringify(want[at])})`);
  }
}

// ── constants ────────────────────────────────────────────────────────────────
// An identifier drift is silent and poisons every vector below it, so check the
// numbers themselves before anything that depends on them.
for (const [key, want] of Object.entries(V.constants)) {
  const got = ink[key];
  if (got === undefined) fail(`const ${key}`, "not exported by ink.js");
  else closeNum(`const ${key}`, got, want, 1e-12);
}

// ── scalars ──────────────────────────────────────────────────────────────────
for (const [arg, want] of Object.entries(V.scalars.dot_boost)) {
  closeNum(`dotBoost(${arg})`, ink.dotBoost(Number(arg)), want);
}
for (const [arg, want] of Object.entries(V.scalars.erase_radius)) {
  closeNum(`eraseRadius(${arg})`, ink.eraseRadius(Number(arg)), want);
}
closeList("hoverLeadIn", ink.hoverLeadIn(
  [[0.0, 0.0, 0.0], [5.0, 1.0, 20.0], [9.0, 2.0, 40.0],
   [60.0, 40.0, 55.0], [12.0, 3.0, 60.0]],
  13.0, 4.0, 80.0), V.scalars.hover_lead_in);

// ── strokes ──────────────────────────────────────────────────────────────────
for (const s of V.strokes) {
  const n = s.name;
  const pts = s.pts;
  const press = s.press;
  const trip = pts.map((p, i) => [p[0], p[1], i < press.length ? press[i] : 1.0]);

  closeNum(`${n}/featureSize`, ink.inkFeatureSize(pts), s.feature_size);
  const spacing = ink.adaptiveSpacing(pts);
  closeNum(`${n}/spacing`, spacing, s.spacing);

  const resampled = ink.resampleInk(trip, spacing);
  closeList(`${n}/resample`, resampled, s.resampled);
  closeList(`${n}/taubin`, ink.taubinSmooth(resampled, 0.5), s.smoothed);
  closeList(`${n}/widthProfile`,
    ink.widthProfile(pts, press.length ? press : null), s.profile);
  closeList(`${n}/trimLightTail`,
    ink.trimLightTail(pts, press, 0.15)[0], s.trimmed);

  const commits = [
    ["commit_0", { strength: 0.0, opts: {} }],
    ["commit_50", { strength: 0.5, opts: {} }],
    ["commit_100", { strength: 1.0, opts: {} }],
    ["commit_flat", { strength: 0.5, opts: { flat: true } }],
    ["commit_smear", { strength: 0.5, opts: { minPressure: 0.15 } }],
  ];
  for (const [key, { strength, opts }] of commits) {
    const want = s[key];
    const got = ink.finishInkStroke(pts, press, strength, opts);
    closeList(`${n}/${key}.pts`, got.pts, want.pts);
    checks++;
    if ((got.profile === null) !== (want.profile === null)) {
      fail(`${n}/${key}.profile`,
        `got ${got.profile === null ? "null" : "a profile"}, `
        + `want ${want.profile === null ? "null" : "a profile"}`);
    } else if (want.profile) {
      closeList(`${n}/${key}.profile`, got.profile, want.profile);
    }
  }

  const live = ink.liveInkStroke(pts, press, 0.5);
  closeList(`${n}/live.pts`, live.pts, V.strokes.find((x) => x.name === n).live_50.pts);
  const wantLive = s.live_50.profile;
  checks++;
  if ((live.profile === null) !== (wantLive === null)) {
    fail(`${n}/live.profile`,
      `got ${live.profile === null ? "null" : "a profile"}, `
      + `want ${wantLive === null ? "null" : "a profile"}`);
  } else if (wantLive) {
    closeList(`${n}/live.profile`, live.profile, wantLive);
  }
}

const strokes = V.strokes.length;
if (failures) {
  console.error(`\n✗ ${failures} of ${checks} checks failed `
    + `across ${failed.size} case(s), over ${strokes} strokes.`);
  process.exit(1);
}
console.log(`✓ ${checks} checks passed over ${strokes} strokes `
  + `(${V.strokes.filter((s) => s.name.includes(".jsonl")).length} of them real captures).`);
