// The merge import: several documents become ONE, with a chapter per file.
//
// Kept apart from doc.js on purpose — this half needs only pdf-lib, no DOM and
// no renderer, which is what lets `test/merge.mjs` drive it in Node. The page
// arithmetic and the outline writing are the parts worth testing, and they are
// exactly the parts a browser adds nothing to.

import { PDFDocument, PDFName, PDFDict, PDFArray, PDFNumber, PDFString }
  from "../vendor/pdf-lib.esm.js";

/** Merge several documents into ONE, with a CHAPTER PER FILE.
 *
 * This is the whole point of dropping more than one file at once: you get a
 * single document whose outline names where each source began, not a pile of
 * tabs. Per-page state is re-keyed by each chapter's page offset.
 *
 * `sources` are `{bytes, name, ink}`; `ink` is an optional page→strokes Map
 * that is carried across and re-keyed.
 *
 * Returns `{bytes, chapters, ink}`. */
export async function mergeDocuments(sources) {
  const merged = await PDFDocument.create();
  const chapters = [];
  const ink = new Map();
  let offset = 0;

  for (const src of sources) {
    let donor;
    try {
      donor = await PDFDocument.load(src.bytes, { ignoreEncryption: true });
    } catch {
      continue;                      // a file we cannot read must not lose the rest
    }
    const indices = donor.getPageIndices();
    if (!indices.length) continue;
    const copied = await merged.copyPages(donor, indices);
    for (const page of copied) merged.addPage(page);

    chapters.push({ title: stripExt(src.name), page: offset, level: 0 });
    if (src.ink) {
      for (const [page, strokes] of src.ink) {
        if (strokes && strokes.length) ink.set(page + offset, strokes);
      }
    }
    offset += indices.length;
  }
  if (!chapters.length) throw new Error("nothing could be read");

  writeOutline(merged, chapters);
  const bytes = await merged.save();
  return { bytes, chapters, ink };
}

function stripExt(name) {
  return String(name || "Untitled").replace(/\.[^.]+$/, "");
}

/** Write a flat outline into the merged document.
 *
 * pdf-lib has no outline API, so the /Outlines tree is built by hand. It is
 * what makes a merge a document with chapters rather than a heap of pages —
 * without it the sidebar has nothing to show and the merge is indistinguishable
 * from concatenating the files. */
function writeOutline(doc, chapters) {
  const ctx = doc.context;
  const pages = doc.getPages();
  const rootRef = ctx.nextRef();

  const refs = chapters.map(() => ctx.nextRef());
  chapters.forEach((chapter, i) => {
    const page = pages[Math.min(chapter.page, pages.length - 1)];
    const dest = PDFArray.withContext(ctx);
    dest.push(page.ref);
    dest.push(PDFName.of("Fit"));

    const item = PDFDict.withContext(ctx);
    item.set(PDFName.of("Title"), PDFString.of(chapter.title));
    item.set(PDFName.of("Parent"), rootRef);
    item.set(PDFName.of("Dest"), dest);
    if (i > 0) item.set(PDFName.of("Prev"), refs[i - 1]);
    if (i < refs.length - 1) item.set(PDFName.of("Next"), refs[i + 1]);
    ctx.assign(refs[i], item);
  });

  const root = PDFDict.withContext(ctx);
  root.set(PDFName.of("Type"), PDFName.of("Outlines"));
  if (refs.length) {
    root.set(PDFName.of("First"), refs[0]);
    root.set(PDFName.of("Last"), refs[refs.length - 1]);
  }
  root.set(PDFName.of("Count"), PDFNumber.of(refs.length));
  ctx.assign(rootRef, root);
  doc.catalog.set(PDFName.of("Outlines"), rootRef);
}

/** Insert one or more documents INTO an open one at a page gap — the sidebar
 * drop. Same pipeline as a fresh merge, with the host as the first source, so
 * the two entry points cannot drift. */
export async function insertDocuments(host, sources, atPage) {
  const before = { bytes: host.bytes, name: host.name, ink: sliceInk(host.ink, 0, atPage) };
  const after = { bytes: host.bytes, name: host.name, ink: sliceInk(host.ink, atPage, Infinity) };
  const merged = await PDFDocument.create();
  const donor = await PDFDocument.load(host.bytes, { ignoreEncryption: true });
  const total = donor.getPageCount();

  const head = await merged.copyPages(donor, range(0, Math.min(atPage, total)));
  for (const p of head) merged.addPage(p);

  const chapters = [];
  const ink = new Map();
  for (const [page, strokes] of before.ink) ink.set(page, strokes);
  let offset = Math.min(atPage, total);

  for (const src of sources) {
    let d;
    try { d = await PDFDocument.load(src.bytes, { ignoreEncryption: true }); }
    catch { continue; }
    const idx = d.getPageIndices();
    if (!idx.length) continue;
    const copied = await merged.copyPages(d, idx);
    for (const p of copied) merged.addPage(p);
    chapters.push({ title: stripExt(src.name), page: offset, level: 0 });
    offset += idx.length;
  }

  const tailIdx = range(Math.min(atPage, total), total);
  const tail = await merged.copyPages(donor, tailIdx);
  for (const p of tail) merged.addPage(p);
  const shift = offset - Math.min(atPage, total);
  for (const [page, strokes] of after.ink) ink.set(page + shift, strokes);

  const existing = host.outline.map((e) => ({
    ...e, page: e.page >= atPage ? e.page + shift : e.page,
  }));
  const all = [...existing, ...chapters].sort((a, b) => a.page - b.page);
  if (all.length) writeOutline(merged, all);
  return { bytes: await merged.save(), ink };
}

function sliceInk(map, from, to) {
  const out = new Map();
  for (const [page, strokes] of map) if (page >= from && page < to) out.set(page, strokes);
  return out;
}

function range(a, b) {
  const out = [];
  for (let i = a; i < b; i++) out.push(i);
  return out;
}
