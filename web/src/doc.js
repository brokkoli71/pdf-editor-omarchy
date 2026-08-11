// The open document: pages, outline, per-page ink, and the merge import.
//
// Sidemark shows ONE page at a time and flips between them — it is not a
// continuous scroll — so this exposes a page index and a renderer for it rather
// than a strip of laid-out pages.

import * as pdfjs from "../vendor/pdf.min.mjs";
import { PDFDocument } from "../vendor/pdf-lib.esm.js";
import { NotesModel } from "./notes-model.js";
import { readInk } from "./inkpdf.js";

// The single-file build has no URLs to fetch from, so it hands us a Worker it
// built from an inlined blob. Served normally, the worker is just a file next
// to us.
if (globalThis.__SIDEMARK_PDF_WORKER__) {
  pdfjs.GlobalWorkerOptions.workerPort = globalThis.__SIDEMARK_PDF_WORKER__;
} else {
  pdfjs.GlobalWorkerOptions.workerSrc =
    new URL("../vendor/pdf.worker.min.mjs", import.meta.url).href;
}

export const A4 = [595.0, 842.0];

/** One open document. `ink` is per page: index → array of strokes. */
export class Doc {
  constructor(pdf, bytes, name) {
    this.pdf = pdf;              // a pdf.js PDFDocumentProxy
    this.bytes = bytes;          // the source bytes, for a re-merge
    this.name = name;
    this.pageCount = pdf ? pdf.numPages : 1;
    this.ink = new Map();        // page index → strokes[]
    // The `.md` sidecar's model. It belongs to the document, not to the editor:
    // the panel is a view of one page of it.
    this.notes = new NotesModel();
    // the `![[name.pdf]]` embed line names the PDF the notes belong to — only
    // when there IS one, so an untitled blank does not claim a file
    this.notes.pdfName = /\.pdf$/i.test(name || "") ? name : null;
    this.outline = [];           // [{title, page, level}]
    this._pageCache = new Map(); // page index → pdf.js PDFPageProxy
    this._sizeCache = new Map();
    this._thumbs = new Map();
  }

  static async open(bytes, name) {
    // Adopt any ink WE wrote and take it back out of the document before
    // rendering. Without this the strokes are painted by pdf.js as annotation
    // appearances while the model knows nothing about them — the file looks
    // right and nothing on it can be erased, lassoed or undone. Stripping is
    // what stops it then rendering twice, which is the desktop's image-layer
    // trap in a different coat.
    let ink = new Map();
    try {
      const lib = await PDFDocument.load(bytes, { ignoreEncryption: true });
      ink = readInk(lib);
      if (ink.size) bytes = await lib.save();
    } catch {
      // an unreadable document is pdf.js's problem to report, not ours; a file
      // we cannot adopt ink from still opens
    }
    const pdf = await pdfjs.getDocument({
      data: bytes.slice(0),      // pdf.js transfers the buffer; keep ours intact
      isEvalSupported: false,
    }).promise;
    const doc = new Doc(pdf, bytes, name);
    doc.ink = ink;
    await doc._readOutline();
    return doc;
  }

  /** An empty document — the blank A4 sheet `blank_pdf_file()` makes. */
  static async blank() {
    const pdf = await PDFDocument.create();
    pdf.addPage(A4);
    const bytes = await pdf.save();
    return Doc.open(bytes, "Untitled");
  }

  strokesFor(page) {
    if (!this.ink.has(page)) this.ink.set(page, []);
    return this.ink.get(page);
  }

  async _readOutline() {
    let raw;
    try { raw = await this.pdf.getOutline(); } catch { raw = null; }
    if (!raw || !raw.length) { this.outline = []; return; }
    const out = [];
    const walk = async (items, level) => {
      for (const item of items) {
        let page = null;
        try {
          const dest = typeof item.dest === "string"
            ? await this.pdf.getDestination(item.dest) : item.dest;
          if (dest && dest[0]) {
            page = await this.pdf.getPageIndex(dest[0]);
          }
        } catch { /* a broken destination is not worth losing the row over */ }
        out.push({ title: item.title || "Untitled", page: page ?? 0, level });
        if (item.items && item.items.length) await walk(item.items, level + 1);
      }
    };
    await walk(raw, 0);
    this.outline = out;
  }

  async page(index) {
    if (this._pageCache.has(index)) return this._pageCache.get(index);
    const p = await this.pdf.getPage(index + 1);
    this._pageCache.set(index, p);
    return p;
  }

  /** The page's size in PDF points — which ARE the document units the ink
   * pipeline's lengths are calibrated in, so nothing needs converting. */
  async pageSize(index) {
    if (this._sizeCache.has(index)) return this._sizeCache.get(index);
    const p = await this.page(index);
    const vp = p.getViewport({ scale: 1 });
    const size = [vp.width, vp.height];
    this._sizeCache.set(index, size);
    return size;
  }

  /** Render a page to a canvas at `scale` device pixels per document unit. */
  async render(index, scale, canvas) {
    const p = await this.page(index);
    const vp = p.getViewport({ scale });
    canvas.width = Math.max(1, Math.round(vp.width));
    canvas.height = Math.max(1, Math.round(vp.height));
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await p.render({ canvasContext: ctx, viewport: vp }).promise;
    return canvas;
  }

  async thumbnail(index, width = 120) {
    if (this._thumbs.has(index)) return this._thumbs.get(index);
    const [w] = await this.pageSize(index);
    const canvas = document.createElement("canvas");
    await this.render(index, width / w, canvas);
    this._thumbs.set(index, canvas);
    return canvas;
  }

  dropThumbnails() { this._thumbs.clear(); }
}

export { mergeDocuments, insertDocuments } from "./merge.js";
