// Dismissing a selection.
//
// A press that missed the selection means you are done with it, and the press
// that says so must not also land on the page: a stroke drawn while a selection
// was still up is one you have to undo, and it lands on top of the work you had
// just been arranging. So the press dismisses and is SWALLOWED — including the
// rest of the gesture, since a pen press always jitters and the drawing branch
// would otherwise take the motion and leave a mark beside the selection you
// were only dismissing.
//
//   node web/test/selection.mjs

import { pressDismissesSelection, VIEW_TOOLS, IMPLEMENTED_TOOLS } from "../src/surface.js";

let checks = 0, failures = 0;
function check(name, got, want) {
  checks++;
  if (got !== want) {
    failures++;
    console.error(`  ✗ ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

// ── anything that marks the page dismisses ──────────────────────────────────
for (const tool of ["pen", "highlighter", "eraser", "lasso", "text", "anchor"]) {
  check(`${tool} dismisses`, pressDismissesSelection(tool), true);
}

// ── moving the view does not ────────────────────────────────────────────────
// Panning to see the rest of the page is a thing you do WHILE arranging a
// selection. It changes nothing on the page, so it takes nothing away.
for (const tool of ["pan", "zoom"]) {
  check(`${tool} keeps the selection`, pressDismissesSelection(tool), false);
}

// ── the exemption list is only about the VIEW ───────────────────────────────
// A tool added to VIEW_TOOLS stops dismissing, which is invisible until someone
// loses a selection they were still using — or keeps one they had finished with.
for (const tool of VIEW_TOOLS) {
  check(`${tool} is a real tool`, IMPLEMENTED_TOOLS.has(tool), true);
}
check("and there are only the two", VIEW_TOOLS.size, 2);

if (failures) {
  console.error(`\n✗ ${failures} of ${checks} selection checks failed.`);
  process.exit(1);
}
console.log(`✓ ${checks} selection checks passed (a press outside dismisses, and marks nothing).`);
