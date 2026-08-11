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
import { writeInk } from "./inkpdf.js";

export const canSaveInPlace = typeof window !== "undefined"
  && "showSaveFilePicker" in window;

/** The annotated PDF's bytes: the document as opened, with every page's ink
 * written in as annotations. */
export async function buildPdf(doc) {
  const pdf = await PDFDocument.load(doc.bytes, { ignoreEncryption: true });
  writeInk(pdf, doc.ink);
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
  const pdfBytes = await buildPdf(doc);
  const notesText = doc.notes.hasContent() ? doc.notes.toText() : null;
  const result = { pdf: null, notes: null, inPlace: false };

  if (!canSaveInPlace) {
    download(pdfBytes, `${base}.pdf`, "application/pdf");
    result.pdf = `${base}.pdf`;
    if (notesText !== null) {
      download(notesText, `${base}.md`, "text/markdown");
      result.notes = `${base}.md`;
    }
    return result;
  }

  if (reask || !doc.handles.pdf) {
    const handle = await pickSave(`${base}.pdf`, "PDF document",
                                  { "application/pdf": [".pdf"] });
    if (!handle) return null;                     // cancelled: nothing written
    doc.handles.pdf = handle;
    doc.handles.notes = null;                     // a new home needs a new sidecar
  }
  await writeHandle(doc.handles.pdf, pdfBytes);
  result.pdf = doc.handles.pdf.name;
  result.inPlace = true;

  if (notesText !== null) {
    if (!doc.handles.notes) {
      // The sidecar cannot be derived from the PDF's handle — the API hands out
      // a file, never its directory — so the first save asks where the notes
      // go. Once. After that both write silently.
      doc.handles.notes = await pickSave(`${base}.md`, "Markdown notes",
                                         { "text/markdown": [".md"] });
    }
    if (doc.handles.notes) {
      await writeHandle(doc.handles.notes, notesText);
      result.notes = doc.handles.notes.name;
    }
  }
  return result;
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
