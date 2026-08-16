// What a page insert, delete or reorder does to everything keyed BY page.
//
// Notes, linked runs, bookmarks and hidden flags are all stored against a page
// index, so every structural edit has to re-key four things at once — and three
// of them are invisible state that exists nowhere else. The failure mode is not
// a crash: it is a page quietly showing somebody else's notes, or none.
//
// The load-bearing check here is NO PAGE LOSES ITS TEXT. A run of linked pages
// shares one body stored on its first page, so a link broken by arithmetic does
// not split notes in two — it deletes them from every page after the break, and
// the pages still look fine until you read them. That shipped, in both the
// desktop app and here, until an insert INSIDE a run was tested.
//
//   node web/test/paging.mjs

import { NotesModel, noteMarkerSpans } from "../src/notes-model.js";
import { addBlankPage, applyPageOrder } from "../src/merge.js";
import { PDFDocument } from "../vendor/pdf-lib.esm.js";

let checks = 0, failures = 0;
function check(name, got, want) {
  checks++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failures++;
    console.error(`  ✗ ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

const PAGES = 10;

/** A document with one of everything: a page of notes, a three-page run, a
 * named bookmark, and a hidden page. */
function model() {
  const m = new NotesModel();
  m.set(0, "Intro.");
  m.set(3, "Eigenvalues, the whole section.");
  m.link(4);
  m.link(5);
  m.set(7, "Jordan form.");
  m.setBookmark(7, "Jordan");
  m.setHidden(8, true);
  return m;
}

const state = (m, n = PAGES) => Array.from({ length: n }, (_, i) => ({
  text: m.get(i),
  bookmark: m.isBookmarked(i) ? m.bookmarkLabel(i) : null,
  hidden: m.isHidden(i),
}));

/** Every page that existed before must still show what it showed, at whatever
 * index it moved to. `where(old)` is null for a page that was deleted.
 *
 * Stated as "nothing is LOST" rather than "page N equals page M": an insert
 * inside a run legitimately gives the NEW page the run's text too, and a rule
 * written as an equality would have to be relaxed to allow that — relaxing it
 * is exactly how the real defect would have slipped through. */
function nothingLost(label, before, after, where) {
  for (let old = 0; old < before.length; old++) {
    const to = where(old);
    if (to === null) continue;
    const b = before[old], a = after[to];
    if (a === undefined) { check(`${label}: page ${old} → ${to} exists`, false, true); continue; }
    check(`${label}: page ${old} → ${to} keeps its notes`, a.text, b.text);
    check(`${label}: page ${old} → ${to} keeps its bookmark`, a.bookmark, b.bookmark);
    check(`${label}: page ${old} → ${to} keeps its hidden flag`, a.hidden, b.hidden);
  }
}

/** The sidecar must survive a write/read round trip after every edit — a format
 * that drifts on each save corrupts a file a little at a time. */
function stable(label, m) {
  const again = new NotesModel();
  again.setFromText(m.toText());
  check(`${label}: round trip is stable`, again.toText(), m.toText());
  // and every marker it wrote must still parse
  check(`${label}: markers parse`, noteMarkerSpans(m.toText()).length >= 0, true);
}

// ── insert ───────────────────────────────────────────────────────────────────

const base = state(model());

for (const at of [0, 1, 3, 4, 5, 6, 7, 8, 9]) {
  for (const count of [1, 3]) {
    const m = model();
    m.shiftForInsert(at, count);
    const after = state(m, PAGES + count);
    nothingLost(`insert ${count} at ${at}`, base, after,
                (old) => (old >= at ? old + count : old));
    stable(`insert ${count} at ${at}`, m);
  }
}

// The defect this file exists for, stated as what a reader sees.
{
  const m = model();
  m.shiftForInsert(4, 1);   // between pages 4 and 5 of the run 3-4-5
  check("a page inserted INSIDE a run joins it, and no page of the run goes blank",
        [3, 4, 5, 6].map((p) => m.get(p)),
        Array(4).fill("Eigenvalues, the whole section."));
  check("…and the run is one run, not two",
        m.runPages(6), [3, 4, 5, 6]);
}
{
  const m = model();
  m.shiftForInsert(3, 1);   // AT the run's start: the blank page comes before it
  check("a page inserted at a run's START stays outside it", m.runPages(4), [4, 5, 6]);
  check("…and the new page has no notes of its own", m.get(3), "");
}

// ── delete ───────────────────────────────────────────────────────────────────

for (const at of [0, 1, 3, 4, 5, 6, 7, 8, 9]) {
  const m = model();
  m.shiftForDelete(at);
  const after = state(m, PAGES - 1);
  nothingLost(`delete ${at}`, base, after, (old) => {
    if (old === at) return null;                       // it went, with its own state
    return old > at ? old - 1 : old;
  });
  stable(`delete ${at}`, m);
}

{
  const m = model();
  m.shiftForDelete(3);      // the run's START — the body must go to the next in it
  check("deleting a run's start hands the body on rather than taking it",
        [3, 4].map((p) => m.get(p)),
        ["Eigenvalues, the whole section.", "Eigenvalues, the whole section."]);
  const m2 = model();
  m2.shiftForDelete(7);
  check("a deleted page takes its bookmark with it", m2.isBookmarked(7), false);
  check("…and the pages after it keep theirs", m2.isHidden(7), true);
}

// ── reorder ──────────────────────────────────────────────────────────────────

{
  // move page 7 (bookmarked, with notes) to the front
  const order = [7, 0, 1, 2, 3, 4, 5, 6, 8, 9];
  const m = model();
  m.reorder(new Map(order.map((old, next) => [old, next])));
  const after = state(m);
  nothingLost("reorder", base, after, (old) => order.indexOf(old));
  stable("reorder", m);
  check("a run that moved as a block keeps its links", m.runPages(5), [4, 5, 6]);
}
{
  // tear a run apart: page 5 (its tail) goes to the front
  const order = [5, 0, 1, 2, 3, 4, 6, 7, 8, 9];
  const m = model();
  m.reorder(new Map(order.map((old, next) => [old, next])));
  check("a run torn apart degrades to unlinked, never re-links a stranger",
        m.isLinked(0), false);
  check("…and the page it was torn from keeps the body",
        m.get(4), "Eigenvalues, the whole section.");
  stable("torn reorder", m);
}

// ── the PDF side: the outline is re-keyed by the same edits ──────────────────

async function pdf(n) {
  const d = await PDFDocument.create();
  for (let i = 0; i < n; i++) d.addPage([595, 842]);
  return new Uint8Array(await d.save());
}

const outline = [{ title: "One", page: 0, level: 0 },
                 { title: "Two", page: 4, level: 0 },
                 { title: "Three", page: 8, level: 0 }];

{
  const r = await addBlankPage(await pdf(PAGES), 4, "plain", outline);
  check("insert: the new page lands after the one you clicked", r.inserted, 5);
  check("insert: the outline shifts only what is after it",
        r.outline.map((e) => [e.title, e.page]),
        [["One", 0], ["Two", 4], ["Three", 9]]);
  check("insert: oldToNew shifts only what is after it",
        [0, 4, 5, 9].map((p) => r.oldToNew.get(p)), [0, 4, 6, 10]);
}
{
  const keep = [0, 1, 2, 3, 5, 6, 7, 8, 9];   // page 4 deleted — "Two" sits on it
  const r = await applyPageOrder(await pdf(PAGES), keep, outline);
  check("delete: an entry on the deleted page goes with it",
        r.outline.map((e) => [e.title, e.page]), [["One", 0], ["Three", 7]]);
}

if (failures) {
  console.error(`\n✗ ${failures} of ${checks} paging checks failed.`);
  process.exit(1);
}
console.log(`✓ ${checks} paging checks passed (insert, delete and reorder `
            + `re-key notes, runs, bookmarks, hidden pages and the outline).`);
