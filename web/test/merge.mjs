// The merge import's page arithmetic, driven in Node.
//
// What is worth testing here is not that pdf-lib can copy pages — it is the
// bookkeeping around it: that a chapter lands on the page it says it does, that
// an insert shifts the ink and the outline of everything after it by the right
// amount, and that the merged document has an outline at all (without one a
// merge is indistinguishable from concatenating the files).
//
//   node test/merge.mjs

import { PDFDocument } from "../vendor/pdf-lib.esm.js";
import { mergeDocuments, insertDocuments } from "../src/merge.js";

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failures++; console.error(`  ✗ ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
  return ok;
}

async function makePdf(pages) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([595, 842]);
  return new Uint8Array(await doc.save());
}

async function pageCount(bytes) {
  return (await PDFDocument.load(bytes)).getPageCount();
}

async function outlineTitles(bytes) {
  const doc = await PDFDocument.load(bytes);
  const cat = doc.catalog;
  const outlines = cat.lookupMaybe?.(
    (await import("../vendor/pdf-lib.esm.js")).PDFName.of("Outlines"),
    (await import("../vendor/pdf-lib.esm.js")).PDFDict);
  return outlines ? outlines.get(
    (await import("../vendor/pdf-lib.esm.js")).PDFName.of("Count"))?.asNumber?.() : null;
}

// ── a plain merge: a chapter per file, in order ──────────────────────────────
{
  const sources = [
    { bytes: await makePdf(6), name: "lecture1.pdf" },
    { bytes: await makePdf(3), name: "lecture2.pdf" },
    { bytes: await makePdf(4), name: "lecture3.pdf" },
  ];
  const { bytes, chapters } = await mergeDocuments(sources);
  check("merged page count", await pageCount(bytes), 13);
  check("chapter titles", chapters.map((c) => c.title),
        ["lecture1", "lecture2", "lecture3"]);
  check("chapter offsets", chapters.map((c) => c.page), [0, 6, 9]);
  check("outline count written", await outlineTitles(bytes), 3);
}

// ── ink is re-keyed by each chapter's page offset ────────────────────────────
{
  const sources = [
    { bytes: await makePdf(2), name: "a.pdf", ink: new Map([[1, ["strokeA"]]]) },
    { bytes: await makePdf(2), name: "b.pdf", ink: new Map([[0, ["strokeB"]]]) },
  ];
  const { ink } = await mergeDocuments(sources);
  check("ink re-keyed", [...ink.entries()].sort((x, y) => x[0] - y[0]),
        [[1, ["strokeA"]], [2, ["strokeB"]]]);
}

// ── a source that cannot be read must not lose the rest ──────────────────────
{
  const sources = [
    { bytes: await makePdf(2), name: "good.pdf" },
    { bytes: new Uint8Array([1, 2, 3]), name: "broken.pdf" },
    { bytes: await makePdf(3), name: "also-good.pdf" },
  ];
  const { bytes, chapters } = await mergeDocuments(sources);
  check("broken source skipped", chapters.map((c) => c.title), ["good", "also-good"]);
  check("survivors' pages kept", await pageCount(bytes), 5);
}

// ── insert at a gap: pages, ink and the outline all shift together ───────────
{
  const host = {
    bytes: await makePdf(6),
    name: "host.pdf",
    // page 0 is before the gap and must stay; page 4 is after it and must move
    ink: new Map([[0, ["before"]], [4, ["after"]]]),
    outline: [{ title: "Ch1", page: 0, level: 0 }, { title: "Ch2", page: 4, level: 0 }],
  };
  const { bytes, ink } = await insertDocuments(
    host, [{ bytes: await makePdf(3), name: "insert.pdf" }], 2);
  check("insert page count", await pageCount(bytes), 9);
  check("ink before the gap stays", ink.get(0), ["before"]);
  check("ink after the gap shifts by the insert", ink.get(7), ["after"]);
  check("outline written for host + insert", await outlineTitles(bytes), 3);
}

if (failures) {
  console.error(`\n✗ ${failures} merge check(s) failed.`);
  process.exit(1);
}
console.log("✓ merge checks passed (chapters, ink re-keying, broken sources, insert-at-gap).");
