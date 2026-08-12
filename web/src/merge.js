// The merge import: several documents become ONE, with a chapter per file.
//
// Kept apart from doc.js on purpose — this half needs only pdf-lib, no DOM and
// no renderer, which is what lets `test/merge.mjs` drive it in Node. The page
// arithmetic and the outline writing are the parts worth testing, and they are
// exactly the parts a browser adds nothing to.

import { PDFDocument, PDFName, PDFDict, PDFArray, PDFNumber, PDFString, rgb }
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

// ── page management ──────────────────────────────────────────────────────────

/** The page order after moving `count` pages from `src` to gap `dst`.
 *
 * `dst` is the gap index in the document with the block ALREADY taken out,
 * which is the only reading that makes "drop it here" mean the same thing
 * whether you dragged forwards or backwards. */
export function moveRangeOrder(n, src, count, dst) {
  const all = range(0, n);
  const block = all.splice(src, count);
  const at = Math.max(0, Math.min(all.length, dst));
  all.splice(at, 0, ...block);
  return all;
}

/** Rebuild `bytes` with its pages in `order` (old indices, in their new
 * positions). Returns `{bytes, oldToNew}`.
 *
 * The outline is re-pointed AND re-sorted: copying pages renumbers what the
 * entries point at but leaves them in their old sequence, so without the sort a
 * moved chapter is listed first while sitting at page 30. */
export async function applyPageOrder(bytes, order, outline = []) {
  const donor = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const copied = await out.copyPages(donor, order);
  for (const p of copied) out.addPage(p);

  const oldToNew = new Map();
  order.forEach((old, next) => oldToNew.set(old, next));

  const moved = outline
    .filter((e) => oldToNew.has(e.page))
    .map((e) => ({ ...e, page: oldToNew.get(e.page) }))
    .sort((a, b) => a.page - b.page);
  if (moved.length) writeOutline(out, moved);
  return { bytes: await out.save(), oldToNew, outline: moved };
}

/** Drop pages by index. Returns `{bytes, oldToNew}`; `oldToNew` omits the pages
 * that went, so a caller re-keying per-page state can tell "moved" from "gone". */
export async function deletePages(bytes, indices, outline = []) {
  const donor = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const total = donor.getPageCount();
  const drop = new Set(indices);
  const keep = range(0, total).filter((i) => !drop.has(i));
  if (!keep.length) throw new Error("a document cannot lose its last page");
  return applyPageOrder(bytes, keep, outline);
}

// ── blank pages ──────────────────────────────────────────────────────────────
//
// The ruling is drawn into the page CONTENT when the page is made, not painted
// under it at render time: a background you write on is one you hand in, so it
// has to export, print and survive being opened anywhere else.
//
// The cost of that choice is that it is fixed at creation. Changing it later
// would mean marking which pages are ours, and it is not worth that to re-rule
// a page you can simply make again.

export const PAGE_BACKGROUNDS = ["plain", "lines", "squares", "dots"];
export const PAGE_BG_SPACING = 20.0;   // PDF units between rulings (~7 mm on A4)
export const PAGE_BG_RGB = [0.72, 0.76, 0.82];
export const PAGE_BG_MARGIN = 28.0;    // unruled border, so ruling never touches
                                       // the edge

/** Rule a page. THE one painter for this, so a page made from the menu and one
 * made by "add blank page" can never come out ruled differently. */
export function drawPageBackground(page, kind, spacing = PAGE_BG_SPACING) {
  if (!PAGE_BACKGROUNDS.includes(kind) || kind === "plain" || spacing <= 0) return;
  const { width, height } = page.getSize();
  const x0 = PAGE_BG_MARGIN, y0 = PAGE_BG_MARGIN;
  const x1 = width - PAGE_BG_MARGIN, y1 = height - PAGE_BG_MARGIN;
  if (x1 <= x0 || y1 <= y0) return;
  const color = rgb(PAGE_BG_RGB[0], PAGE_BG_RGB[1], PAGE_BG_RGB[2]);

  if (kind === "dots") {
    for (let y = y0; y <= y1 + 1e-9; y += spacing) {
      for (let x = x0; x <= x1 + 1e-9; x += spacing) {
        page.drawCircle({ x, y, size: 0.6, color, borderWidth: 0 });
      }
    }
    return;
  }
  for (let y = y0; y <= y1 + 1e-9; y += spacing) {
    page.drawLine({ start: { x: x0, y }, end: { x: x1, y },
                    thickness: 0.4, color });
  }
  if (kind === "squares") {
    for (let x = x0; x <= x1 + 1e-9; x += spacing) {
      page.drawLine({ start: { x, y: y0 }, end: { x, y: y1 },
                      thickness: 0.4, color });
    }
  }
}

/** A blank page's bytes — THE blank page, so a document does not go plain at
 * page 2. */
export async function blankPdfBytes(width = 595, height = 842, kind = "plain") {
  const doc = await PDFDocument.create();
  drawPageBackground(doc.addPage([width, height]), kind);
  return doc.save();
}

/** Insert a blank page after `afterIndex`, at the size of the page it follows.
 * Returns `{bytes, oldToNew}` — the caller re-keys per-page state with it. */
export async function addBlankPage(bytes, afterIndex, kind = "plain", outline = []) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pages = doc.getPages();
  const at = Math.max(0, Math.min(afterIndex, pages.length - 1));
  const { width, height } = pages[at].getSize();
  drawPageBackground(doc.insertPage(at + 1, [width, height]), kind);

  const oldToNew = new Map();
  for (let i = 0; i < pages.length; i++) oldToNew.set(i, i > at ? i + 1 : i);
  const moved = outline
    .map((e) => ({ ...e, page: oldToNew.get(e.page) ?? e.page }))
    .sort((a, b) => a.page - b.page);
  if (moved.length) writeOutline(doc, moved);
  return { bytes: await doc.save(), oldToNew, outline: moved, inserted: at + 1 };
}
