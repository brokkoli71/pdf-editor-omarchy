// Writing ink into a PDF as annotations, driven in Node.
//
// What matters here is not that pdf-lib can write a dict — it is that the ink
// survives as an ANNOTATION with the profile intact, that a re-save replaces
// our annotations instead of accumulating them, and that ink from another
// application is left alone.
//
//   node test/inkpdf.mjs

import { PDFDocument, PDFName, PDFString } from "../vendor/pdf-lib.esm.js";
import { writeInk, INK_PROFILE_TAG } from "../src/inkpdf.js";

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failures++; console.error(`  ✗ ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

async function makePdf(pages = 2) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([595, 842]);
  return doc;
}

function inkAnnots(doc) {
  const out = [];
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const dict = page.node.context.lookup(annots.get(i));
      const subtype = dict?.get?.(PDFName.of("Subtype"));
      if (subtype?.asString?.() !== "/Ink") continue;
      const contents = dict.get(PDFName.of("Contents"));
      out.push({
        contents: String(contents?.asString?.() ?? contents?.decodeText?.() ?? ""),
        hasAP: !!dict.get(PDFName.of("AP")),
        hasInkList: !!dict.get(PDFName.of("InkList")),
      });
    }
  }
  return out;
}

const tapered = {
  pts: [[10, 10], [20, 14], [30, 12]],
  profile: [0.4, 1.0, 0.4],
  width: 2.0, color: [0, 0, 0.8], opacity: 1.0, flat: false,
};
const flat = {
  pts: [[40, 40], [80, 44]],
  profile: null, width: 12.0, color: [1, 0.85, 0], opacity: 0.4, flat: true,
};

// ── a stroke becomes an annotation, with an appearance and its profile ───────
{
  const doc = await makePdf();
  const written = writeInk(doc, new Map([[0, [tapered, flat]]]));
  check("wrote both strokes", written, 2);
  const annots = inkAnnots(doc);
  check("two ink annots", annots.length, 2);
  check("each has an appearance stream", annots.every((a) => a.hasAP), true);
  check("each has an InkList centreline", annots.every((a) => a.hasInkList), true);
  check("the tapered one carries its profile",
    annots.some((a) => a.contents.startsWith(INK_PROFILE_TAG)
      && a.contents.includes("0.40,1.00,0.40")), true);
  check("the flat one carries none",
    annots.filter((a) => a.contents.includes(INK_PROFILE_TAG)).length, 1);
  // it must survive being written out and read back
  const reloaded = await PDFDocument.load(await doc.save());
  check("annots survive a save/load", inkAnnots(reloaded).length, 2);
}

// ── re-saving REPLACES our ink rather than accumulating it ───────────────────
{
  const doc = await makePdf();
  writeInk(doc, new Map([[0, [tapered]]]));
  writeInk(doc, new Map([[0, [tapered]]]));
  writeInk(doc, new Map([[0, [tapered, flat]]]));
  check("no accumulation across saves", inkAnnots(doc).length, 2);
}

// ── an /Ink annotation from ANOTHER application is left alone ────────────────
{
  const doc = await makePdf();
  const ctx = doc.context;
  const page = doc.getPages()[0];
  // NB pdf-lib's obj() turns a bare JS string into a NAME, not a string — so a
  // text field has to be built with PDFString explicitly, exactly as the writer
  // does for the profile tag.
  const foreign = ctx.obj({ Type: "Annot", Subtype: "Ink", Rect: [0, 0, 10, 10] });
  foreign.set(PDFName.of("Contents"), PDFString.of("someone else's annotation"));
  page.node.addAnnot(ctx.register(foreign));
  writeInk(doc, new Map([[0, [tapered]]]));
  writeInk(doc, new Map([[0, [tapered]]]));      // twice, to exercise the strip
  const annots = inkAnnots(doc);
  check("foreign ink kept", annots.filter((a) => a.contents.includes("someone else")).length, 1);
  check("ours still regenerated once", annots.filter((a) => a.contents.includes(INK_PROFILE_TAG)).length, 1);
}

// ── ink lands on the page it belongs to ─────────────────────────────────────
{
  const doc = await makePdf(3);
  writeInk(doc, new Map([[2, [tapered]]]));
  const perPage = doc.getPages().map((p) => p.node.Annots()?.size() ?? 0);
  check("only page 3 has ink", perPage, [0, 0, 1]);
}

if (failures) {
  console.error(`\n✗ ${failures} ink-PDF check(s) failed.`);
  process.exit(1);
}
console.log("✓ ink-PDF checks passed (annots, appearance, profile, regeneration, foreign ink).");
