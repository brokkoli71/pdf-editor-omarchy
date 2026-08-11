// Check the lasso's shared geometry against vectors from sidemark.py.
//
//   extras/export_lasso_vectors.py > web/test/lasso-vectors.json
//   node web/test/lasso.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  lassoHandlePoints, lassoHandleAnchor, lassoScaleFactors, lassoHandleCursor,
  lassoChipCentre, lassoDeleteCentre, pointInPolygon,
  LASSO_CHIP_SIZE, LASSO_CHIP_GAP,
} from "../src/lasso.js";

const here = dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(readFileSync(join(here, "lasso-vectors.json"), "utf8"));

let checks = 0, failures = 0;
const near = (a, b) => Math.abs(a - b) < 1e-9;
function check(name, got, want) {
  checks++;
  const ok = Array.isArray(want)
    ? Array.isArray(got) && got.length === want.length
      && got.every((v, i) => (typeof v === "number" ? near(v, want[i])
        : JSON.stringify(v) === JSON.stringify(want[i])))
    : (typeof want === "number" ? near(got, want)
      : JSON.stringify(got) === JSON.stringify(want));
  if (!ok) {
    failures++;
    if (failures <= 15) {
      console.error(`  ✗ ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
  }
}

check("LASSO_CHIP_SIZE", LASSO_CHIP_SIZE, V.chip_size);
check("LASSO_CHIP_GAP", LASSO_CHIP_GAP, V.chip_gap);

for (const b of V.boxes) {
  const [x0, y0, x1, y1] = b.box;
  const tag = `box ${JSON.stringify(b.box)}`;
  const handles = lassoHandlePoints(x0, y0, x1, y1, V.pad);
  handles.forEach((p, i) => check(`${tag} handle ${i}`, p, b.handles[i]));
  check(`${tag} chip`, lassoChipCentre(x0, y0, V.pad), b.chip);
  check(`${tag} delete`, lassoDeleteCentre(x0, y0, V.pad), b.delete);
  for (const a of b.anchors) {
    const got = lassoHandleAnchor(a.handle, b.box);
    check(`${tag} anchor ${a.handle} mode`, got.mode, a.mode);
    check(`${tag} anchor ${a.handle} point`, got.anchor, a.anchor);
  }
  b.cursors.forEach((c, i) => check(`${tag} cursor ${i}`, lassoHandleCursor(i), c));
  for (const s of b.scales) {
    const { mode, anchor } = lassoHandleAnchor(s.handle, b.box);
    const [fx, fy] = lassoScaleFactors(mode, anchor, handles[s.handle], s.cur);
    check(`${tag} scale h${s.handle} → ${JSON.stringify(s.cur)}`, [fx, fy], [s.fx, s.fy]);
  }
}

for (const p of V.polygon.points) {
  check(`pointInPolygon ${JSON.stringify(p.p)}`,
    pointInPolygon(p.p[0], p.p[1], V.polygon.poly), p.inside);
}

if (failures) {
  console.error(`\n✗ ${failures} of ${checks} lasso checks failed.`);
  process.exit(1);
}
console.log(`✓ ${checks} lasso checks passed (handles, anchors, scale factors, chip, polygon).`);
