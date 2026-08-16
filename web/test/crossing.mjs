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

// ── the caret keeps its EXACT place, not just its page ───────────────────────
//
// The two buffers hold the same body — the panel shows a page's notes, the
// sheet shows them inside the whole file — so the offset within that body is
// the same number on both sides and only the start moves.

function inBody(model, { full, text, head }) {
  return NotesView.prototype._offsetInBody.call({
    model, full, view: { state: { doc: { toString: () => text },
                                  selection: { main: { head } } } },
  });
}

function placed(model, idx, within, text) {
  let anchor = null;
  const self = {
    model,
    view: { state: { doc: { toString: () => text } },
            dispatch: (tr) => { anchor = tr.selection.head ?? tr.selection.anchor; } },
  };
  NotesView.prototype._placeCaretForPage.call(self, idx, within);
  return { anchor, fullCaret: self._fullCaret };
}

const body3 = plain.get(3);
check("in the panel, the offset within the body IS the caret offset",
      inBody(plain, { full: false, text: body3, head: 7 }), 7);
check("…less the leading whitespace the commit is about to trim",
      inBody(plain, { full: false, text: `\n\n${body3}`, head: 9 }), 7);
check("panel → sheet keeps the offset, moving only where the body starts",
      placed(plain, 3, 7, plainText).anchor, openedAt(3) + 7);
check("sheet → panel reads it back the same",
      inBody(plain, { full: true, text: plainText, head: openedAt(3) + 7 }), 7);
check("a caret past the end of a body cannot walk into the next page",
      placed(plain, 3, 999, plainText).anchor, openedAt(3) + body3.length);
check("a page with no body of its own takes the caret to its marker, never past",
      placed(plain, 5, 999, plainText).anchor, openedAt(5));
check("on the sheet, a caret above every marker belongs to no page and reads 0",
      inBody(plain, { full: true, text: plainText, head: 0 }), 0);
check("inside a run the offset is measured from the body's one home",
      inBody(run, { full: true, text: runText, head: runBody + 4 }), 4);

// A SELECTION crosses too — it is the same two offsets, so carrying both costs
// nothing, and text you had marked and then lost by widening the window is a
// selection you have to make again for no reason you can see.
function span(model, { full, text, anchor, head }) {
  const self = {
    model, full,
    _offsetInBody: NotesView.prototype._offsetInBody,
    view: { state: { doc: { toString: () => text },
                     selection: { main: { anchor, head } } } },
  };
  return NotesView.prototype._spanInBody.call(self);
}

check("a marked region reads as two body offsets, not one",
      span(plain, { full: false, text: body3, anchor: 4, head: 11 }),
      { anchor: 4, head: 11 });
check("…and on the sheet the same region reads back the same",
      span(plain, { full: true, text: plainText,
                    anchor: openedAt(3) + 4, head: openedAt(3) + 11 }),
      { anchor: 4, head: 11 });
check("a collapsed caret is the same path, not a second one",
      span(plain, { full: false, text: body3, anchor: 5, head: 5 }),
      { anchor: 5, head: 5 });
check("panel → sheet moves both ends together",
      placed(plain, 3, { anchor: 4, head: 11 }, plainText).anchor, openedAt(3) + 11);

// ── the sidebar's readout follows the caret ──────────────────────────────────
//
// While the sheet is open the pages are off screen, so the sidebar's current
// row is the only thing saying which page you are writing on.

function reader(model, head, { caretPage = null } = {}) {
  const text = model.toText();
  const seen = [];
  const self = {
    model, full: true, _markers: null, _caretPage: caretPage,
    onCaretPage: (p) => seen.push(p),
    view: { state: { doc: { toString: () => text },
                     selection: { main: { head } } } },
  };
  NotesView.prototype._reportCaretPage.call(self);
  return { seen, self };
}

check("the caret in a page's notes names that page",
      reader(plain, openedAt(7) + 2).seen, [7]);
check("a caret that has not left its page reports nothing — a rebuild per "
      + "keystroke is a strip that flickers while you type",
      reader(plain, openedAt(3) + 1, { caretPage: 3 }).seen, []);
check("above the first marker there is no page, so the readout holds",
      reader(plain, 0, { caretPage: 3 }).seen, []);
check("inside a run, every page of it reads as the page the body is stored on",
      reader(run, runBody + 5).seen, [2]);
check("the marker table is cached, and an edit is what drops it",
      reader(plain, openedAt(7) + 2).self._markers.length > 0, true);

if (failures) {
  console.error(`\n✗ ${failures} of ${checks} crossing checks failed.`);
  process.exit(1);
}
console.log(`✓ ${checks} crossing checks passed (the caret crosses the divider `
            + `both ways).`);
