// Copying a selection.
//
// A copy publishes the same thing twice, as it does on the desktop: our own
// objects verbatim, so pasting back into Sidemark returns editable INK, and a
// picture, so every other application gets something usable. That in-app paste
// being lossless is a requirement, not a nicety — a copy that came back as a
// flat image would make the lasso a one-way door.
//
// The browser's clipboard only carries a fixed set of types, so the two halves
// live in different places: the PICTURE goes on the system clipboard where
// other apps can reach it, and the OBJECTS stay in the tab. That costs
// cross-tab paste and keeps the thing that matters.

import { drawInkStroke, rgbCss } from "./draw.js";

export const SIDEMARK_MIME = "application/x-sidemark-objects+json";
export const COPY_RENDER_SCALE = 3.0;   // supersample the picture other apps get
export const COPY_PAD = 6.0;            // document units of margin round the ink

/** The objects held for an in-app paste. Module state rather than the system
 * clipboard, because no browser will carry our own type between tabs. */
let held = null;

/** The bounding box of some strokes, padded, in document units. */
export function selectionBounds(strokes, pad = COPY_PAD) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) {
    const half = (s.width || 0) / 2 * Math.max(1, ...(s.profile || [1]));
    for (const [x, y] of s.pts) {
      if (x - half < x0) x0 = x - half;
      if (x + half > x1) x1 = x + half;
      if (y - half < y0) y0 = y - half;
      if (y + half > y1) y1 = y + half;
    }
  }
  if (!Number.isFinite(x0)) return null;
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

/** A PNG of the strokes — what OTHER applications get.
 *
 * Rendered at COPY_RENDER_SCALE× the selection's document size: ink is vectors,
 * so rendering bigger costs only a moment and gives whoever pastes it something
 * that survives being scaled up. */
export async function renderSelectionPng(strokes, scale = COPY_RENDER_SCALE) {
  const box = selectionBounds(strokes);
  if (!box) return null;
  const [x0, y0, x1, y1] = box;
  const w = Math.max(1, Math.round((x1 - x0) * scale));
  const h = Math.max(1, Math.round((y1 - y0) * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  // transparent ground: a copied annotation pasted over something else should
  // not bring a white rectangle with it
  ctx.save();
  ctx.scale(scale, scale);
  ctx.translate(-x0, -y0);
  for (const s of strokes) {
    ctx.fillStyle = rgbCss(s.color, s.opacity);
    ctx.strokeStyle = ctx.fillStyle;
    drawInkStroke(ctx, s.pts, s.width, s.profile);
  }
  ctx.restore();
  return canvas.convertToBlob({ type: "image/png" });
}

/** Copy a selection: the picture to the system clipboard, the objects to the
 * tab. Returns what was published, for the toast. */
export async function copySelection(strokes) {
  if (!strokes || !strokes.length) return null;
  const box = selectionBounds(strokes);
  // deep enough that a later edit of the original cannot reach the copy
  held = {
    origin: [box[0], box[1]],
    strokes: strokes.map((s) => ({
      pts: s.pts.map((p) => [p[0], p[1]]),
      profile: s.profile ? s.profile.slice() : null,
      width: s.width,
      color: s.color.slice(),
      opacity: s.opacity,
      flat: !!s.flat,
    })),
  };
  const png = await renderSelectionPng(strokes);
  let picture = false;
  try {
    if (png && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      picture = true;
    }
  } catch {
    // writing an image needs permission and a secure context; the in-app copy
    // is the half that matters and must not be lost with it
  }
  return { count: strokes.length, picture };
}

export function hasCopy() { return !!(held && held.strokes.length); }

/** The held objects, placed with their top-left at (x, y). Fresh copies every
 * time, so pasting twice gives two independent sets. */
export function takeCopy(x, y) {
  if (!hasCopy()) return [];
  const [ox, oy] = held.origin;
  return held.strokes.map((s) => ({
    ...s,
    pts: s.pts.map((p) => [p[0] - ox + x, p[1] - oy + y]),
    profile: s.profile ? s.profile.slice() : null,
    color: s.color.slice(),
  }));
}

/** The size of what is held, so a caller can place it under the pointer. */
export function copyExtent() {
  if (!hasCopy()) return null;
  const box = selectionBounds(held.strokes);
  return box ? [box[2] - box[0], box[3] - box[1]] : null;
}
