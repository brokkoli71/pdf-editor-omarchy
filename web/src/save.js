// Saving: the annotated PDF and the `.md` sidecar.
//
// Files stay plain, exactly as they do on the desktop — a `.pdf` you can open
// anywhere with the ink in it as real annotations, and a `.md` beside it that
// is the same sidecar format the desktop app reads. Nothing is bundled into a
// private container.
//
// Two ways out, chosen by capability rather than by browser:
//
//   * File System Access (Chromium) — the file is written back IN PLACE, so
//     Ctrl+S after the first save prompts for nothing. This is what makes it
//     feel like an application rather than a page.
//   * a download (Firefox, and anywhere the API is missing) — every save
//     produces a new file in the downloads folder. One capability check, not a
//     second code path.
//
// The sidecar is only written when there is something in it. That is the
// desktop's rule too: a `.md` must not appear beside every PDF you merely
// glanced at.

import { PDFDocument } from "../vendor/pdf-lib.esm.js";
import { writeInk, writeImages } from "./inkpdf.js";
import { isImage } from "./images.js";

export const canSaveInPlace = typeof window !== "undefined"
  && "showSaveFilePicker" in window;


/** The page → objects map, split into the two things a PDF stores differently.
 * One list everywhere else; the split lives here and nowhere else. */
function splitObjects(ink) {
  const strokes = new Map(), images = new Map();
  for (const [page, objs] of ink) {
    const s = objs.filter((o) => !isImage(o));
    const i = objs.filter(isImage);
    if (s.length) strokes.set(page, s);
    if (i.length) images.set(page, i);
  }
  return { strokes, images };
}

/** The annotated PDF's bytes: the document as opened, with every page's ink and
 * images written in as annotations. */
export async function buildPdf(doc) {
  const pdf = await PDFDocument.load(doc.bytes, { ignoreEncryption: true });
  const { strokes, images } = splitObjects(doc.ink);
  writeInk(pdf, strokes);
  await writeImages(pdf, images);
  return pdf.save();
}

function baseName(name) {
  return String(name || "Untitled").replace(/\.[^.]+$/, "");
}

function download(bytes, filename, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // revoke on the next turn — revoking synchronously can beat the download
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function writeHandle(handle, bytes) {
  const w = await handle.createWritable();
  await w.write(bytes);
  await w.close();
}

// A FILE PICKER MUST BE THE FIRST THING THE GESTURE DOES.
//
// `showSaveFilePicker` requires transient user activation, and awaiting
// anything before it spends that activation — the call then fails with "Must be
// handling a user gesture", which reads to the user as the menu entry doing
// nothing. So every path here asks for the file FIRST and builds the bytes
// afterwards, even though building first would read more naturally.

/** Ask for somewhere to put a file, or null if the user cancelled. */
async function pickSave(suggestedName, description, accept) {
  try {
    return await window.showSaveFilePicker({
      suggestedName,
      types: [{ description, accept }],
    });
  } catch (err) {
    if (err.name === "AbortError") return null;   // cancelling is not an error
    throw err;
  }
}

/** Save the document. `doc.handles` remembers where it went, so the next save
 * is silent; `reask` forces the picker (Save As).
 *
 * Returns what happened, for the toast: {pdf, notes, inPlace}. */
export async function saveDocument(doc, { reask = false } = {}) {
  const base = baseName(doc.name);
  doc.handles = doc.handles || {};
  const result = { pdf: null, notes: null, inPlace: false, notesPending: false };

  // ASK FIRST — see the note above pickSave. Nothing may be awaited before it.
  if (canSaveInPlace && (reask || !doc.handles.pdf)) {
    const handle = await pickSave(`${base}.pdf`, "PDF document",
                                  { "application/pdf": [".pdf"] });
    if (!handle) return null;                     // cancelled: nothing written
    doc.handles.pdf = handle;
    doc.handles.notes = null;                     // a new home needs a new sidecar
  }

  const pdfBytes = await buildPdf(doc);
  const notesText = doc.notes.hasContent() ? doc.notes.toText() : null;

  if (!canSaveInPlace) {
    download(pdfBytes, `${base}.pdf`, "application/pdf");
    result.pdf = `${base}.pdf`;
    if (notesText !== null) {
      download(notesText, `${base}.md`, "text/markdown");
      result.notes = `${base}.md`;
    }
    return result;
  }

  await writeHandle(doc.handles.pdf, pdfBytes);
  result.pdf = doc.handles.pdf.name;
  result.inPlace = true;

  if (notesText !== null) {
    if (doc.handles.notes) {
      await writeHandle(doc.handles.notes, notesText);
      result.notes = doc.handles.notes.name;
    } else {
      // The sidecar cannot be derived from the PDF's handle — the API hands out
      // a file, never its directory — and this gesture's activation has already
      // gone on the PDF, so a second picker here would fail. The caller offers
      // it as its own action instead.
      result.notesPending = true;
    }
  }
  return result;
}

/** Choose where the notes go. Must be called straight from a user gesture. */
export async function saveNotesAs(doc) {
  const handle = await pickSave(`${baseName(doc.name)}.md`, "Markdown notes",
                                { "text/markdown": [".md"] });
  if (!handle) return null;
  doc.handles = doc.handles || {};
  doc.handles.notes = handle;
  await writeHandle(handle, doc.notes.toText());
  return handle.name;
}

/** Open a PDF through the picker, keeping the handle so a later save can write
 * back to the same file. Returns [{bytes, name, handle}] or null if cancelled. */
export async function openWithPicker(multiple = true) {
  if (!canSaveInPlace) return null;               // fall back to <input type=file>
  let handles;
  try {
    handles = await window.showOpenFilePicker({
      multiple,
      types: [{ description: "PDF document", accept: { "application/pdf": [".pdf"] } }],
    });
  } catch (err) {
    if (err.name === "AbortError") return null;
    throw err;
  }
  const out = [];
  for (const handle of handles) {
    const file = await handle.getFile();
    out.push({ bytes: new Uint8Array(await file.arrayBuffer()), name: file.name, handle });
  }
  return out;
}

// ── exporting a subset of pages ──────────────────────────────────────────────

/** A PDF of just `indices`, in the order given, with their ink written in.
 *
 * The ink is re-keyed to the new page numbers rather than dropped: exporting a
 * few slides to hand to somebody and having your annotations not come with them
 * is the one thing that would make the feature pointless. */
export async function extractPages(doc, indices) {
  const donor = await PDFDocument.load(doc.bytes, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const wanted = indices.filter((i) => i >= 0 && i < donor.getPageCount());
  if (!wanted.length) throw new Error("no pages selected");
  const copied = await out.copyPages(donor, wanted);
  for (const p of copied) out.addPage(p);

  const ink = new Map();
  wanted.forEach((old, next) => {
    const strokes = doc.ink.get(old);
    if (strokes && strokes.length) ink.set(next, strokes);
  });
  const { strokes, images } = splitObjects(ink);
  writeInk(out, strokes);
  await writeImages(out, images);
  return out.save();
}

/** A name for the exported file that says what is in it. */
export function exportName(docName, indices) {
  const base = String(docName || "pages").replace(/\.[^.]+$/, "");
  if (indices.length === 1) return `${base} p${indices[0] + 1}.pdf`;
  const runs = [];
  let start = indices[0], prev = indices[0];
  for (const i of indices.slice(1)) {
    if (i === prev + 1) { prev = i; continue; }
    runs.push(start === prev ? `${start + 1}` : `${start + 1}-${prev + 1}`);
    start = prev = i;
  }
  runs.push(start === prev ? `${start + 1}` : `${start + 1}-${prev + 1}`);
  // a name that lists every page of a 40-page selection is not a name
  const span = runs.length > 3 ? `${indices.length} pages` : `p${runs.join(",")}`;
  return `${base} ${span}.pdf`;
}

/** Save an extracted set of pages, in place where that is possible and as a
 * download where it is not. */
export async function exportPages(doc, indices) {
  const name = exportName(doc.name, indices);   // sync: nothing awaited yet
  if (!canSaveInPlace) {
    download(await extractPages(doc, indices), name, "application/pdf");
    return name;
  }
  // the picker FIRST, then the work — see the note above pickSave
  const handle = await pickSave(name, "PDF document", { "application/pdf": [".pdf"] });
  if (!handle) return null;
  await writeHandle(handle, await extractPages(doc, indices));
  return handle.name;
}
