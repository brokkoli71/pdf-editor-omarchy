// Check the shape recogniser against vectors from sidemark.py.
//
//   extras/export_shape_vectors.py > web/test/shape-vectors.json
//   node web/test/shapes.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  recognizeShape, polylineIsClosed, polygonCorners, openPathCorners,
  rectBboxOf, simplifyPolyline, quadIsAxisAligned, evenDividerPositions,
  POLYGON_MAX_CORNERS, CIRCLE_TOLERANCE, LASSO_CLICK_SLOP_PX,
} from "../src/shapes.js";

const here = dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(readFileSync(join(here, "shape-vectors.json"), "utf8"));

let checks = 0, failures = 0;
const EPS = 1e-6;
function check(name, got, want) {
  checks++;
  const ok = deepNear(got, want);
  if (!ok) {
    failures++;
    if (failures <= 15) {
      console.error(`  ✗ ${name}\n      got  ${JSON.stringify(got)?.slice(0, 160)}`
        + `\n      want ${JSON.stringify(want)?.slice(0, 160)}`);
    }
  }
}
function deepNear(a, b) {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= EPS;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepNear(v, b[i]));
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

check("POLYGON_MAX_CORNERS", POLYGON_MAX_CORNERS, V.constants.POLYGON_MAX_CORNERS);
check("CIRCLE_TOLERANCE", CIRCLE_TOLERANCE, V.constants.CIRCLE_TOLERANCE);
check("LASSO_CLICK_SLOP_PX", LASSO_CLICK_SLOP_PX, V.constants.LASSO_CLICK_SLOP_PX);

for (const c of V.cases) {
  const n = c.name;
  check(`${n}/closed`, polylineIsClosed(c.pts), c.closed);
  const got = recognizeShape(c.pts);
  check(`${n}/kind`, got.kind, c.kind);
  check(`${n}/shape`, got.pts, c.shape);
  check(`${n}/polygonCorners`, polygonCorners(c.pts), c.polygon_corners);
  check(`${n}/openPathCorners`, openPathCorners(c.pts), c.open_path_corners);
  check(`${n}/rectBboxOf`, rectBboxOf(c.pts), c.rect_bbox);
  check(`${n}/simplifyPolyline`, simplifyPolyline(c.pts, 2.0), c.simplified);
  if (c.axis_aligned !== null) {
    check(`${n}/quadIsAxisAligned`, quadIsAxisAligned(polygonCorners(c.pts)),
          c.axis_aligned);
  }
}

for (const [label, want] of Object.entries(V.dividers)) {
  const m = label.match(/^(\d+) across (-?[\d.]+)\.\.(-?[\d.]+)$/);
  if (!m) continue;
  const [, count, lo, hi] = m;
  check(`dividers ${label}`,
    evenDividerPositions(Number(lo), Number(hi), Number(count)), want);
}

if (failures) {
  console.error(`\n✗ ${failures} of ${checks} shape checks failed.`);
  process.exit(1);
}
console.log(`✓ ${checks} shape checks passed over ${V.cases.length} strokes.`);
