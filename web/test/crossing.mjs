// The caret crossing the divider (row 162).
//
// The sheet is the whole sidecar and the canvas is on a page, so going either
// way is a translation between two coordinate systems for the same notes.
// `notes.mjs` pins the marker table itself against the Python oracle; what is
// checked here is the DECISION built on top of it — which page you land on when
// the sheet closes — because two of its three answers cannot come from the
// offset at all and are the ones that go quietly wrong.
//
// `fullTargetPage` reads only the document text, the caret offset and the two
// values remembered when the sheet opened, so it runs without a DOM: the state
// is duck-typed, exactly as view.mjs does for the surface.
//
//   node web/test/crossing.mjs

import { NotesModel, noteOffsetForPage } from "../src/notes-model.js";
import { NotesView } from "../src/notes.js";

let checks = 0, failures = 0;
function check(name, got, want) {
  checks++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failures++;
    console.error(`  ✗ ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

/** A sheet as `fullTargetPage` sees it: the sidecar's text, the caret somewhere
 * in it, and what opening it remembered. */
function sheet(model, { head, from, caret }) {
  const text = model.toText();
  return {
    model,
    _fullFrom: from,
    _fullCaret: caret,
    view: { state: { doc: { toString: () => text },
                     selection: { main: { head } } } },
  };
}

const target = (s) => NotesView.prototype.fullTargetPage.call(s);

// ── a plain document: three pages, each with its own notes ───────────────────
const plain = new NotesModel();
plain.pdfName = "lecture.pdf";   // the `![[embed]]` line, so offset 0 is above every marker
plain.set(0, "Intro.");
plain.set(3, "Eigenvalues.");
plain.set(7, "Jordan form.");
const plainText = plain.toText();
const openedAt = (idx) => noteOffsetForPage(plainText, plain.runStart(idx));

check("the caret where it was put comes back to the page it came from",
      target(sheet(plain, { head: openedAt(3), from: 3, caret: openedAt(3) })), 3);
check("the caret moved into another page's notes turns to that page",
      target(sheet(plain, { head: openedAt(7) + 2, from: 3, caret: openedAt(3) })), 7);
check("a caret nudged WITHIN its own section stays on that page",
      target(sheet(plain, { head: openedAt(3) + 3, from: 3, caret: openedAt(3) })), 3);
check("above the first marker there is no page to name, so the page it was "
      + "opened at wins",
      target(sheet(plain, { head: 0, from: 3, caret: openedAt(3) })), 3);
check("with nothing remembered, the offset is the whole answer",
      target(sheet(plain, { head: 0, from: null, caret: null })), null);

// ── a page with NO notes: the caret was parked in somebody else's section ─────
//
// `noteOffsetForPage` puts it where the notes WOULD go — the start of the first
// later section — so reading the offset back names page 7, a page you were
// never on. A caret that has not moved has learnt nothing since.
const emptyPage = openedAt(5);
check("a page with no notes of its own comes back to itself, not to the "
      + "section the caret was parked in",
      target(sheet(plain, { head: emptyPage, from: 5, caret: emptyPage })), 5);
check("…but once the caret moves there, that section is where you meant to be",
      target(sheet(plain, { head: emptyPage + 1, from: 5, caret: emptyPage })), 7);

// ── a linked run: one body, several pages (row 129) ──────────────────────────
const run = new NotesModel();
run.set(2, "A run's body, shared by pages 3 to 5.");
run.link(3);
run.link(4);
run.link(5);
run.set(9, "Somewhere else.");
const runText = run.toText();
const runBody = noteOffsetForPage(runText, run.runStart(4));

check("a run stores its body once, so the caret in it says the RUN and not "
      + "which of its pages you were reading",
      target(sheet(run, { head: runBody + 5, from: 4, caret: runBody })), 4);
check("leaving the run for another page turns to that page",
      target(sheet(run, { head: noteOffsetForPage(runText, 9) + 1,
                          from: 4, caret: runBody })), 9);
check("arriving at the run from outside it lands on the run's first page",
      target(sheet(run, { head: runBody + 5, from: 9,
                          caret: noteOffsetForPage(runText, 9) })), 2);

if (failures) {
  console.error(`\n✗ ${failures} of ${checks} crossing checks failed.`);
  process.exit(1);
}
console.log(`✓ ${checks} crossing checks passed (the caret crosses the divider `
            + `both ways).`);
