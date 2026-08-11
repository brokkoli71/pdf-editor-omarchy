// Check the maths grammar port against vectors generated from sidemark.py.
//
//   extras/export_math_vectors.py > web/test/math-vectors.json
//   node web/test/math.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  MD_SYMBOLS, MD_ACCENTS, MAX_SCRIPT_DEPTH, SCRIPT_SCALE,
  symbolize, splitMarkup, iterScripts, scriptBodyEnd, scriptContent,
  RENDERABLE_RE,
} from "../src/mathrender.js";

const here = dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(readFileSync(join(here, "math-vectors.json"), "utf8"));

let checks = 0, failures = 0;
function check(name, got, want) {
  checks++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) {
    failures++;
    if (failures <= 20) console.error(`  ✗ ${name}\n      got  ${g}\n      want ${w}`);
  }
}

check("symbol table", MD_SYMBOLS, V.symbols);
check("accent table", MD_ACCENTS, V.accents);
check("MAX_SCRIPT_DEPTH", MAX_SCRIPT_DEPTH, V.max_depth);
check("SCRIPT_SCALE", SCRIPT_SCALE, V.scale);

for (const c of V.cases) {
  const label = JSON.stringify(c.raw);
  check(`${label} symbolize`, symbolize(c.raw, true), c.symbolize);
  check(`${label} symbolize(fragment)`, symbolize(c.raw, false), c.symbolize_fragment);
  check(`${label} splitMarkup`,
    splitMarkup(c.raw).map((s) => [s.text, s.kind]), c.split);
  check(`${label} scripts`,
    iterScripts(c.raw, true).map((s) => ({
      from: s.from, to: s.to, body_end: scriptBodyEnd(s.match),
      content: scriptContent(s.match) ?? null, chain: s.chain,
    })),
    c.scripts.map((s) => ({ ...s, content: s.content ?? null })));
  check(`${label} scripts(fragment)`,
    iterScripts(c.raw, false).map((s) => ({ from: s.from, to: s.to, chain: s.chain })),
    c.scripts_fragment);
  check(`${label} renderable`, RENDERABLE_RE.test(c.raw), c.renderable);
}

if (failures) {
  console.error(`\n✗ ${failures} of ${checks} maths checks failed.`);
  process.exit(1);
}
console.log(`✓ ${checks} maths checks passed over ${V.cases.length} lines.`);
