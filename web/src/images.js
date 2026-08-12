// Pasted images.
//
// AN IMAGE IS AN OBJECT, modelled and behaving like ink: bytes plus a place on
// the page, editable for ever, never a flattened stamp. That is the whole
// design, and everything here follows from it.
//
// It carries the same `pts` a stroke carries — the four corners of its frame,
// closed — which is not a trick but the reason the rest of the app needs no
// changes: the bounding box, the move, the eight resize handles, the rotate
// knob and the undo entries all read and write `pts` and cannot tell the two
// apart. What they must tell apart is painting (an image is drawn, not
// stroked), erasing (the eraser ignores images) and recolouring (there is no
// pen colour on a photograph), and those ask `isImage`.
//
// The tilt is NOT baked into the pixels: the frame is rotated and the bitmap is
// drawn into it at render, so rotating twice costs nothing and loses nothing.
//
// ceiling: a non-uniform stretch of a ROTATED image stretches along the page's
// axes rather than the image's, because a frame of four corners can hold a
// rotation but not a skew. Same limit as the desktop. If it ever matters, the
// frame has to become a real 2x3 transform, and `imageFrame` is where that
// would be read.

export const IMAGE_MIME = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** Is this object an image rather than a stroke? */
export const isImage = (o) => !!(o && o.image);

/** The closed quad of an axis-aligned rectangle, in document units. */
export function imageQuad(x, y, w, h) {
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
}

/** Centre, size and angle of a frame — what it takes to draw the bitmap.
 *
 * Derived from the corners every time rather than stored beside them, so a
 * transform that moved the corners can never disagree with the picture. The
 * width and height are the lengths of the two edges meeting at corner 0, which
 * is what makes a rotated frame come out at its own size instead of its
 * bounding box's. */
export function imageFrame(pts) {
  const [p0, p1, , p3] = pts;
  const w = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  const h = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
  const angle = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
  return { cx: (p0[0] + pts[2][0]) / 2, cy: (p0[1] + pts[2][1]) / 2, w, h, angle };
}

/** How big a pasted image lands: the SMALLEST of four caps.
 *
 * A third of the page per axis stops a screenshot arriving as a page-filling
 * slab; half the visible window per axis is the one that matters when you are
 * zoomed in, where a third of the page can be several screens across; and the
 * image's own pixels on screen stop a small icon being blown up into a blur.
 * All four are needed — each is the only one that binds in some situation. */
export function pasteScale(natural, page, view, zoom) {
  const [nw, nh] = natural;
  if (!nw || !nh) return [0, 0];
  const caps = [
    page[0] / 3 / nw, page[1] / 3 / nh,
    view[0] / 2 / zoom / nw, view[1] / 2 / zoom / nh,
    1 / zoom,                                  // its own pixels, at this zoom
  ];
  const f = Math.min(...caps);
  return [nw * f, nh * f];
}

/** Paint an image into its frame. */
export function drawImageObject(ctx, obj) {
  const bitmap = obj.image && obj.image.bitmap;
  if (!bitmap) return;
  const { cx, cy, w, h, angle } = imageFrame(obj.pts);
  if (!(w > 0 && h > 0)) return;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, -w / 2, -h / 2, w, h);
  ctx.restore();
}

/** Is a document point inside an image's frame? The frame can be rotated, so
 * the point is taken back into the frame's own axes rather than tested against
 * a bounding box that would catch the corners of a tilted picture. */
export function imageHit(obj, x, y) {
  const { cx, cy, w, h, angle } = imageFrame(obj.pts);
  const dx = x - cx, dy = y - cy;
  const c = Math.cos(-angle), s = Math.sin(-angle);
  return Math.abs(dx * c - dy * s) <= w / 2 && Math.abs(dx * s + dy * c) <= h / 2;
}

/** Decode bytes into something drawable, keeping the ORIGINAL bytes beside it.
 *
 * The bytes are what gets written back to the PDF, so they must survive the
 * round trip untouched — re-encoding a pasted JPEG on every save would make it
 * worse each time. */
export async function makeImage(bytes, mime) {
  const blob = new Blob([bytes], { type: mime || "image/png" });
  const bitmap = await createImageBitmap(blob);
  return { bytes, mime: mime || "image/png", bitmap,
           natural: [bitmap.width, bitmap.height] };
}
