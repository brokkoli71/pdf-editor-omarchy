// Writing ink into a PDF as annotations, driven in Node.
//
// What matters here is not that pdf-lib can write a dict — it is that the ink
// survives as an ANNOTATION with the profile intact, that a re-save replaces
// our annotations instead of accumulating them, and that ink from another
// application is left alone.
//
//   node test/inkpdf.mjs

import { PDFDocument, PDFName, PDFString } from "../vendor/pdf-lib.esm.js";
import { writeInk, readInk, INK_PROFILE_TAG } from "../src/inkpdf.js";

let failures = 0, checks = 0;
function check(name, got, want) {
  checks++;
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

// ── the ROUND TRIP: reopened ink must come back editable ────────────────────
// The bug this guards is silent: without reading annotations back, a reopened
// file SHOWS its ink (pdf.js paints the appearance streams) while the model
// knows nothing about it, so nothing on the page can be erased, lassoed or
// undone. It looks perfect and is dead.
{
  const doc = await makePdf(3);
  writeInk(doc, new Map([[0, [tapered, flat]], [2, [tapered]]]));
  const reloaded = await PDFDocument.load(await doc.save());
  const ink = readInk(reloaded);

  check("ink comes back on the right pages", [...ink.keys()].sort(), [0, 2]);
  check("both strokes on page 1", ink.get(0)?.length, 2);

  const back = ink.get(0)[0];
  check("points survive", back.pts.map((p) => p.map((v) => Math.round(v * 100) / 100)),
        tapered.pts);
  check("profile survives", back.profile, tapered.profile);
  check("width survives", back.width, tapered.width);
  check("colour survives", back.color.map((v) => Math.round(v * 100) / 100),
        tapered.color);

  const backFlat = ink.get(0)[1];
  check("a flat stroke stays flat", backFlat.profile, null);
  check("its opacity survives", Math.round(backFlat.opacity * 100) / 100, flat.opacity);

  // …and reading STRIPS, so the renderer cannot paint them a second time
  check("annots removed after adoption", inkAnnots(reloaded).length, 0);

  // a second round trip must not drift
  writeInk(reloaded, ink);
  const twice = readInk(await PDFDocument.load(await reloaded.save()));
  check("stable across two round trips",
        twice.get(0)[0].pts.map((p) => p.map((v) => Math.round(v * 100) / 100)),
        tapered.pts);
}

// a foreign /Ink annotation is NOT adopted as ours, and stays on the page
{
  const doc = await makePdf();
  const ctx = doc.context;
  const foreign = ctx.obj({ Type: "Annot", Subtype: "Ink", Rect: [0, 0, 10, 10] });
  foreign.set(PDFName.of("Contents"), PDFString.of("someone else's annotation"));
  doc.getPages()[0].node.addAnnot(ctx.register(foreign));
  const ink = readInk(doc);
  check("foreign ink not adopted", ink.size, 0);
  check("foreign ink left on the page", inkAnnots(doc).length, 1);
}

// ── images: the round trip ──────────────────────────────────────────────────
// A pasted image is a /Stamp annotation marked as ours, with the ORIGINAL bytes
// beside it in a private stream. What must hold: the bytes come back exactly
// (an image re-encoded on every save gets worse every time), the frame comes
// back including a rotation the /Rect cannot express, a save REGENERATES rather
// than accumulating, and a stamp somebody else put there is never touched.
{
  const { writeImages, readImages, IMAGE_TAG } = await import("../src/inkpdf.js");
  const { PDFDocument: PD, PDFName: PN, PDFString: PS } = await import("../vendor/pdf-lib.esm.js");

  // the smallest valid PNG: 1x1, opaque
  const PNG = Uint8Array.from(atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
  ), (c) => c.charCodeAt(0));
  const decode = async (bytes, mime) => ({ bytes, mime, bitmap: null });
  const quad = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];

  const make = async () => {
    const d = await PD.create();
    d.addPage([400, 600]);
    return d;
  };

  // a plain, axis-aligned image
  {
    const d = await make();
    const obj = { image: { bytes: PNG, mime: "image/png" }, pts: quad(50, 60, 120, 90) };
    check("one image written", await writeImages(d, new Map([[0, [obj]]])), 1);
    const back = await readImages(await PD.load(await d.save()), decode);
    const got = back.get(0)?.[0];
    check("it comes back", !!got, true);
    check("with the same bytes", got && [...got.image.bytes].join(",") === [...PNG].join(","), true);
    check("and the same frame", JSON.stringify(got?.pts), JSON.stringify(quad(50, 60, 120, 90)));
  }

  // a ROTATED frame: the /Rect is axis-aligned, so the corners are what carry it
  {
    const d = await make();
    const pts = [[100, 100], [180, 140], [160, 180], [80, 140], [100, 100]];
    await writeImages(d, new Map([[0, [{ image: { bytes: PNG, mime: "image/png" }, pts }]]]));
    const back = await readImages(await PD.load(await d.save()), decode);
    check("a rotated frame survives", JSON.stringify(back.get(0)?.[0]?.pts), JSON.stringify(pts));
  }

  // saving twice must REGENERATE, not accumulate
  {
    const d = await make();
    const objs = [{ image: { bytes: PNG, mime: "image/png" }, pts: quad(10, 10, 50, 50) }];
    await writeImages(d, new Map([[0, objs]]));
    await writeImages(d, new Map([[0, objs]]));
    const back = await readImages(await PD.load(await d.save()), decode);
    check("still one image after two saves", back.get(0)?.length, 1);
  }

  // somebody ELSE's stamp is left exactly where it is
  {
    const d = await make();
    const page = d.getPages()[0];
    const ctx = d.context;
    const theirs = ctx.obj({ Type: "Annot", Subtype: "Stamp", Rect: [0, 0, 10, 10] });
    theirs.set(PN.of("Contents"), PS.of("someone else's stamp"));
    page.node.addAnnot(ctx.register(theirs));
    await writeImages(d, new Map([[0, [{ image: { bytes: PNG, mime: "image/png" }, pts: quad(5, 5, 20, 20) }]]]));
    const reloaded = await PD.load(await d.save());
    const annots = reloaded.getPages()[0].node.Annots();
    let mine = 0, foreign = 0;
    for (let i = 0; i < annots.size(); i++) {
      const dict = reloaded.getPages()[0].node.context.lookup(annots.get(i));
      const t = String(dict.get(PN.of("Contents"))?.asString?.() ?? "");
      if (t.includes(IMAGE_TAG)) mine++; else foreign++;
    }
    check("ours is written", mine, 1);
    check("and theirs is untouched", foreign, 1);
  }
}


if (failures) {
  console.error(`\n✗ ${failures} ink-PDF check(s) failed.`);
  process.exit(1);
}
console.log(`✓ ${checks} ink-PDF checks passed (annots, appearance, profile, images, regeneration, foreign ink).`);

