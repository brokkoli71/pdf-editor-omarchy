// Writing ink into the PDF as real annotations.
//
// Ink is stored as PDF /Ink annotations, not painted into the page content, so
// it stays a separate, removable object — the same choice the desktop makes.
//
// A PDF ink annotation has ONE width, which is why variable-width ink was
// blocked for so long. The per-point profile therefore rides in /Contents
// behind INK_PROFILE_TAG — a free text field that survives a round trip
// untouched — and `width` stays the stroke's width at full pressure. So the
// taper can be reloaded exactly.
//
// One deliberate difference from the desktop: the appearance stream here draws
// the TAPERED outline rather than a constant-width polyline. On the desktop
// that constant width is PyMuPDF's appearance generator, described in the
// source as "a graceful degradation" — not a design choice. Writing the outline
// ourselves costs nothing and means the saved file looks like what you drew, in
// every reader. `/BS /W` still carries the nominal width for anything that
// re-generates its own appearance.

import { PDFName, PDFNumber, PDFString, PDFArray } from "../vendor/pdf-lib.esm.js";
import { strokeOutline } from "./draw.js";

export const INK_PROFILE_TAG = "sidemark:press=";
/** Ours among the /Stamp annotations, by the same rule the ink uses: a marker
 * in /Contents, which is a free text field that survives a round trip
 * untouched. It is what lets a save STRIP AND REGENERATE our images while
 * leaving a stamp some other application put there exactly where it is. */
export const IMAGE_TAG = "sidemark:image=";

const f = (v) => (Math.round(v * 1000) / 1000).toString();

/** Document units have y DOWN from the top-left; PDF has y UP from the
 * bottom-left. Every coordinate written here goes through this. */
const toPdf = (p, pageH) => [p[0], pageH - p[1]];

function bboxOf(points, pad = 0) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

/** The appearance stream's drawing operators for one stroke. */
function strokeOps(stroke, pageH) {
  const [r, g, b] = stroke.color;
  const ops = [];
  const hasAlpha = (stroke.opacity ?? 1) < 1;
  if (hasAlpha) ops.push("/GS0 gs");

  if (stroke.profile && stroke.pts.length >= 2) {
    // a filled OUTLINE, exactly the shape the screen painter builds — filling
    // per-segment strokes instead would double-darken where they overlap
    const outline = strokeOutline(stroke.pts, stroke.width, stroke.profile)
      .map((p) => toPdf(p, pageH));
    if (!outline.length) return { ops: [], points: [] };
    ops.push(`${f(r)} ${f(g)} ${f(b)} rg`);
    ops.push(`${f(outline[0][0])} ${f(outline[0][1])} m`);
    for (const p of outline.slice(1)) ops.push(`${f(p[0])} ${f(p[1])} l`);
    ops.push("h f");
    return { ops, points: outline };
  }

  // no profile: the plain constant-width polyline (a snapped shape, the
  // highlighter, an imported annotation)
  const pts = stroke.pts.map((p) => toPdf(p, pageH));
  ops.push(`${f(r)} ${f(g)} ${f(b)} RG`);
  ops.push(`${f(stroke.width)} w 1 J 1 j`);
  if (pts.length === 1) {
    // a dot with no profile still has to make a mark
    ops.push(`${f(pts[0][0])} ${f(pts[0][1])} m ${f(pts[0][0])} ${f(pts[0][1])} l S`);
  } else {
    ops.push(`${f(pts[0][0])} ${f(pts[0][1])} m`);
    for (const p of pts.slice(1)) ops.push(`${f(p[0])} ${f(p[1])} l`);
    ops.push("S");
  }
  return { ops, points: pts };
}

/** Add one stroke to a page as an /Ink annotation with its own appearance. */
function addInkAnnot(doc, page, stroke, pageH) {
  if (!stroke.pts || !stroke.pts.length) return false;
  const ctx = doc.context;
  const { ops, points } = strokeOps(stroke, pageH);
  if (!ops.length) return false;

  const opacity = stroke.opacity ?? 1;
  // the appearance box has to cover the ink at its widest, including the cap
  const pad = stroke.width * (stroke.profile ? Math.max(...stroke.profile, 1) : 1) + 2;
  const rect = bboxOf(points, pad);

  const resources = { ProcSet: ["PDF"] };
  if (opacity < 1) {
    resources.ExtGState = { GS0: { Type: "ExtGState", ca: opacity, CA: opacity } };
  }
  const apDict = ctx.obj({
    Type: "XObject",
    Subtype: "Form",
    FormType: 1,
    BBox: rect,
    Resources: resources,
  });
  const apRef = ctx.register(ctx.stream(ops.join("\n"), apDict));

  // /InkList is the CENTRELINE, whatever the appearance draws — a reader that
  // regenerates its own appearance must get the stroke back, not its outline
  const inkList = PDFArray.withContext(ctx);
  const line = PDFArray.withContext(ctx);
  const centre = stroke.pts.length > 1 ? stroke.pts : [stroke.pts[0], stroke.pts[0]];
  for (const p of centre) {
    const [x, y] = toPdf(p, pageH);
    line.push(PDFNumber.of(Math.round(x * 1000) / 1000));
    line.push(PDFNumber.of(Math.round(y * 1000) / 1000));
  }
  inkList.push(line);

  const annot = ctx.obj({
    Type: "Annot",
    Subtype: "Ink",
    Rect: rect,
    C: stroke.color,
    CA: opacity,
    F: 4,                                   // print
    BS: { W: stroke.width, S: "S" },
    AP: { N: apRef },
  });
  annot.set(PDFName.of("InkList"), inkList);
  if (stroke.profile && stroke.profile.length === stroke.pts.length) {
    annot.set(PDFName.of("Contents"), PDFString.of(
      INK_PROFILE_TAG + stroke.profile.map((p) => p.toFixed(2)).join(",")));
  }
  page.node.addAnnot(ctx.register(annot));
  return true;
}

/** Strip the ink annotations WE wrote, so a save regenerates rather than
 * accumulates. Ours are the ones carrying the profile tag; an /Ink annotation
 * from another application is left exactly where it is. */
function stripOurInk(doc) {
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const ref = annots.get(i);
      const dict = page.node.context.lookup(ref);
      if (!dict || !dict.get) continue;
      const subtype = dict.get(PDFName.of("Subtype"));
      if (!subtype || subtype.asString?.() !== "/Ink") continue;
      const contents = dict.get(PDFName.of("Contents"));
      const text = contents?.asString?.() ?? contents?.decodeText?.() ?? "";
      if (String(text).includes(INK_PROFILE_TAG)) annots.remove(i);
    }
  }
}

/** Write every page's ink into `doc` (a pdf-lib PDFDocument). `ink` is the
 * page → strokes map. Returns how many annotations were written. */
export function writeInk(doc, ink) {
  stripOurInk(doc);
  const pages = doc.getPages();
  let written = 0;
  for (const [index, strokes] of ink) {
    const page = pages[index];
    if (!page || !strokes || !strokes.length) continue;
    const pageH = page.getSize().height;
    for (const stroke of strokes) {
      if (addInkAnnot(doc, page, stroke, pageH)) written++;
    }
  }
  return written;
}

/** Read OUR ink back out of a document, and strip it.
 *
 * This is the other half of the round trip, and without it a reopened file
 * shows its ink but cannot edit it — the strokes render as annotations while
 * the model knows nothing about them.
 *
 * Stripping is not optional: pdf.js paints annotation appearances onto the
 * page, so ink left in the document would be drawn once by the renderer and
 * once by us. Same trap as the desktop's image layer, which is taken back OUT
 * of the open document after it is adopted.
 *
 * Only annotations carrying INK_PROFILE_TAG, or a bare /Ink we can parse, are
 * claimed — and a foreign one is left alone if we cannot make a stroke of it.
 * Losing the taper is a far better failure than refusing to open a file, so
 * anything unparseable simply is not ink.
 *
 * Returns a Map of page index → strokes. */
export function readInk(doc) {
  const ink = new Map();
  const pages = doc.getPages();
  pages.forEach((page, index) => {
    const annots = page.node.Annots();
    if (!annots) return;
    const pageH = page.getSize().height;
    const strokes = [];
    for (let i = annots.size() - 1; i >= 0; i--) {
      const dict = page.node.context.lookup(annots.get(i));
      if (!dict || !dict.get) continue;
      if (dict.get(PDFName.of("Subtype"))?.asString?.() !== "/Ink") continue;
      const stroke = strokeFromAnnot(dict, pageH);
      if (!stroke) continue;
      strokes.unshift(stroke);        // annots are walked backwards to remove
      annots.remove(i);
    }
    if (strokes.length) ink.set(index, strokes);
  });
  return ink;
}

function numbersOf(arr) {
  const out = [];
  for (let i = 0; i < arr.size(); i++) {
    const v = arr.get(i);
    const n = v?.asNumber?.();
    if (typeof n !== "number" || !Number.isFinite(n)) return null;
    out.push(n);
  }
  return out;
}

function strokeFromAnnot(dict, pageH) {
  const inkList = dict.get(PDFName.of("InkList"));
  if (!inkList?.size?.()) return null;
  const line = inkList.get(0);          // one polyline per stroke, as written
  if (!line?.size) return null;
  const flat = numbersOf(line);
  if (!flat || flat.length < 2 || flat.length % 2) return null;

  const pts = [];
  for (let i = 0; i < flat.length; i += 2) pts.push([flat[i], pageH - flat[i + 1]]);
  // a one-point stroke was written as its point twice; give it back as one
  if (pts.length === 2 && pts[0][0] === pts[1][0] && pts[0][1] === pts[1][1]) {
    pts.length = 1;
  }

  const colorArr = dict.get(PDFName.of("C"));
  const color = colorArr?.size?.() === 3 ? numbersOf(colorArr) : null;
  const bs = dict.get(PDFName.of("BS"));
  const width = bs?.get?.(PDFName.of("W"))?.asNumber?.() ?? 2.0;
  const opacity = dict.get(PDFName.of("CA"))?.asNumber?.() ?? 1.0;

  // The width profile, stashed on /Contents by the writer. Guarded by a LENGTH
  // match, so a mismatch loses the taper rather than shifting every width along
  // the stroke.
  let profile = null;
  const contents = dict.get(PDFName.of("Contents"));
  const text = contents?.decodeText?.() ?? String(contents?.asString?.() ?? "");
  const at = text.indexOf(INK_PROFILE_TAG);
  if (at >= 0) {
    const parsed = text.slice(at + INK_PROFILE_TAG.length)
      .replace(/\)$/, "").split(",").map(Number);
    if (parsed.length === pts.length && parsed.every(Number.isFinite)) {
      profile = parsed;
    }
  }
  return {
    pts, profile,
    width: width > 0 ? width : 2.0,
    color: color || [0, 0, 0],
    opacity: opacity > 0 && opacity <= 1 ? opacity : 1.0,
    // `flat` records which TOOL drew a stroke, and a PDF carries no such thing:
    // a missing profile means "constant width", which is equally true of a
    // highlighter and of a snapped rectangle. Deriving it from the profile made
    // every reloaded shape claim to be a highlighter. Nothing renders from it —
    // width, colour and opacity all round-trip — so it is left unclaimed.
    flat: false,
  };
}

// ── images ──────────────────────────────────────────────────────────────────
//
// A pasted image is a /Stamp annotation whose appearance stream draws an image
// XObject. That is the same decision ink made, for the same reason: an
// annotation is a separate, removable object with an owner we can mark, so a
// save can strip ours and write them again without ever touching the page's own
// content stream — which is where the desktop's hardest bugs live. Every reader
// renders stamp annotations, so the file looks right elsewhere; only Sidemark
// takes them apart again.

/** Frame a quad as PDF's own (x, y, w, h, angle-free) rectangle plus the matrix
 * that puts the picture back at the angle you left it. */
function imagePlacement(pts, pageH) {
  const [p0, p1, , p3] = pts;
  const w = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  const h = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
  const cx = (p0[0] + pts[2][0]) / 2;
  const cy = (p0[1] + pts[2][1]) / 2;
  // document y is DOWN, PDF y is UP, so the angle turns the other way
  const angle = -Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
  const [px, py] = toPdf([cx, cy], pageH);
  return { w, h, cx: px, cy: py, angle };
}

async function addImageAnnot(doc, page, obj, pageH) {
  if (!obj.image || !obj.image.bytes || !obj.image.bytes.length) return false;
  const { w, h, cx, cy, angle } = imagePlacement(obj.pts, pageH);
  if (!(w > 0 && h > 0)) return false;

  const bytes = obj.image.bytes;
  const jpeg = /jpe?g/i.test(obj.image.mime || "");
  let embedded;
  try {
    embedded = jpeg ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
  } catch {
    return false;              // an image we cannot embed must not lose the save
  }

  const ctx = doc.context;
  // The annotation's /Rect is axis-aligned, so a ROTATED image needs a box big
  // enough to hold it — the appearance stream then turns the picture inside it.
  const c = Math.abs(Math.cos(angle)), s2 = Math.abs(Math.sin(angle));
  const bw = w * c + h * s2, bh = w * s2 + h * c;
  const rect = [cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2].map(f).join(" ");

  const resources = ctx.obj({ XObject: ctx.obj({ Img: embedded.ref }) });
  const apDict = ctx.obj({
    Type: "XObject", Subtype: "Form",
    BBox: ctx.obj([0, 0, bw, bh].map((v) => PDFNumber.of(Math.round(v * 1000) / 1000))),
    Resources: resources,
  });
  // place it centred in the box, turned, and scaled to its own size
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const ops = [
    "q",
    `1 0 0 1 ${f(bw / 2)} ${f(bh / 2)} cm`,
    `${f(cos)} ${f(sin)} ${f(-sin)} ${f(cos)} 0 0 cm`,
    `${f(w)} 0 0 ${f(h)} ${f(-w / 2)} ${f(-h / 2)} cm`,
    "/Img Do",
    "Q",
  ];
  const apRef = ctx.register(ctx.stream(ops.join("\n"), apDict));

  const annot = ctx.obj({
    Type: "Annot",
    Subtype: "Stamp",
    Rect: rect.split(" ").map((v) => PDFNumber.of(Number(v))),
    F: 4,                                   // print
    AP: { N: apRef },
  });
  // ours, and the frame as we mean it — the /Rect cannot express a rotation, so
  // the corners ride along and are what gets read back
  annot.set(PDFName.of("Contents"), PDFString.of(
    IMAGE_TAG + JSON.stringify({ mime: obj.image.mime, pts: obj.pts })));
  // THE ORIGINAL BYTES, kept verbatim in a private stream beside the appearance.
  //
  // Reading the picture back out of the appearance is not the same thing: a PNG
  // is embedded as raw samples under Flate, so recovering a file from it means
  // re-encoding, and an image re-encoded on every save gets worse every time.
  // A private key is ignored by every other reader, and this way what comes
  // back is byte-for-byte what you pasted.
  //
  // ceiling: a PNG is therefore stored twice, once as the appearance and once
  // as itself. If that ever matters, a JPEG's appearance stream already IS its
  // file (DCTDecode) and could be referenced instead of copied.
  annot.set(PDFName.of("Sidemark_Src"), ctx.register(ctx.stream(bytes)));
  page.node.addAnnot(ctx.register(annot));
  return true;
}

/** Strip the stamps WE wrote, for the reason ink is stripped: a save must
 * REGENERATE rather than accumulate. */
function stripOurImages(doc) {
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const dict = page.node.context.lookup(annots.get(i));
      if (!dict || !dict.get) continue;
      const subtype = dict.get(PDFName.of("Subtype"));
      if (!subtype || subtype.asString?.() !== "/Stamp") continue;
      const contents = dict.get(PDFName.of("Contents"));
      const text = contents?.asString?.() ?? contents?.decodeText?.() ?? "";
      if (String(text).includes(IMAGE_TAG)) annots.remove(i);
    }
  }
}

/** Write every page's images. `images` is the page → objects map. */
export async function writeImages(doc, images) {
  stripOurImages(doc);
  const pages = doc.getPages();
  let written = 0;
  for (const [index, objs] of images) {
    const page = pages[index];
    if (!page || !objs || !objs.length) continue;
    const pageH = page.getSize().height;
    for (const obj of objs) {
      if (await addImageAnnot(doc, page, obj, pageH)) written++;
    }
  }
  return written;
}

/** Read our images back, page → objects, with the bytes exactly as pasted.
 *
 * `decode` turns bytes into something drawable and is passed in, because that
 * needs a browser and this module is also read by the tests in node. */
export async function readImages(doc, decode) {
  const out = new Map();
  const pages = doc.getPages();
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index];
    const annots = page.node.Annots();
    if (!annots) continue;
    const objs = [];
    // BACKWARDS, because each adopted image is removed on the way past: leaving
    // it in means pdf.js paints the stamp as well, and the picture you drag is
    // then sitting on its own ghost. Same trap the ink meets.
    for (let i = annots.size() - 1; i >= 0; i--) {
      const dict = page.node.context.lookup(annots.get(i));
      if (!dict || !dict.get) continue;
      const subtype = dict.get(PDFName.of("Subtype"));
      if (!subtype || subtype.asString?.() !== "/Stamp") continue;
      const contents = dict.get(PDFName.of("Contents"));
      const text = String(contents?.asString?.() ?? contents?.decodeText?.() ?? "");
      const at = text.indexOf(IMAGE_TAG);
      if (at < 0) continue;
      let meta;
      try { meta = JSON.parse(text.slice(at + IMAGE_TAG.length).replace(/\)$/, "")); }
      catch { continue; }
      if (!meta || !Array.isArray(meta.pts)) continue;
      const srcRef = dict.get(PDFName.of("Sidemark_Src"));
      const stream = srcRef && page.node.context.lookup(srcRef);
      const bytes = stream && (stream.contents || stream.getContents?.());
      if (!bytes || !bytes.length) continue;
      try {
        objs.unshift({ image: await decode(bytes, meta.mime), pts: meta.pts });
        annots.remove(i);
      } catch { /* an unreadable image is dropped, never a failed load */ }
    }
    if (objs.length) out.set(index, objs);
  }
  return out;
}
