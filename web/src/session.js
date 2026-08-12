// Reopen where you left off.
//
// The desktop keeps this in `recent.json` — the document and the page you were
// on — deliberately NOT in the sidecar, because a sidecar appearing beside a PDF
// you merely glanced at is worse than forgetting where you were.
//
// A browser cannot reopen a path, so the session keeps the document's BYTES in
// IndexedDB alongside the ink, the notes and the page. That restores everything
// with no permission prompt. The file HANDLE is stored beside them (handles are
// structured-cloneable) purely so save-in-place can resume — using it needs a
// user gesture, so it is asked for on the first save rather than on load.
//
// Cheap by construction: the stored bytes are the SOURCE document, written once,
// and the ink rides as JSON. Rebuilding the annotated PDF on every stroke would
// cost far more than it saves.

import { withStore } from "./db.js";
import { makeImage } from "./images.js";

const STORE_NAME = "session";
const KEY = "last";


/** Ink is a Map of page → strokes; strokes are plain objects, so the only work
 * is turning the Map into something structured-cloneable and back. */
function inkToJson(ink) {
  // An image's BITMAP is a decoded copy of its own bytes, so it is dropped here
  // and made again on the way back: storing it would put a second, larger
  // representation of every picture in the session record for no gain.
  const strip = (o) => (o && o.image
    ? { ...o, image: { bytes: o.image.bytes, mime: o.image.mime } }
    : o);
  return [...ink.entries()]
    .filter(([, s]) => s && s.length)
    .map(([page, objs]) => [page, objs.map(strip)]);
}

/** Decode the images a restored session brought back. Async, and deliberately
 * tolerant: a picture that will not decode is dropped and the rest of the
 * session still opens. */
async function rehydrate(ink) {
  for (const [page, objs] of ink) {
    const out = [];
    for (const o of objs) {
      if (!o.image) { out.push(o); continue; }
      if (o.image.bitmap) { out.push(o); continue; }
      try { out.push({ ...o, image: await makeImage(o.image.bytes, o.image.mime) }); }
      catch { /* dropped */ }
    }
    ink.set(page, out);
  }
  return ink;
}

function inkFromJson(raw) {
  const ink = new Map();
  if (!Array.isArray(raw)) return ink;
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [page, strokes] = entry;
    if (typeof page !== "number" || !Array.isArray(strokes)) continue;
    // a junk record must fall back to "no ink", never reach the renderer
    const clean = strokes.filter((s) => s && Array.isArray(s.pts) && s.pts.length);
    if (clean.length) ink.set(page, clean);
  }
  return ink;
}

export async function saveSession(doc, page) {
  if (!doc) return;
  try {
    await withStore(STORE_NAME, "readwrite", (store) => store.put({
      name: doc.name,
      bytes: doc.bytes,
      ink: inkToJson(doc.ink),
      notes: doc.notes.hasContent() ? doc.notes.toText() : null,
      page,
      handle: doc.handles?.pdf ?? null,
      at: Date.now(),
    }, KEY));
  } catch {
    // a session that cannot be written is not worth an error in the user's
    // face; the document is still open and still savable
  }
}

export async function loadSession() {
  try {
    const rec = await withStore(STORE_NAME, "readonly", (store) => store.get(KEY));
    if (!rec || !rec.bytes) return null;
    return { ...rec, ink: await rehydrate(inkFromJson(rec.ink)) };
  } catch {
    return null;
  }
}

export async function clearSession() {
  try {
    await withStore(STORE_NAME, "readwrite", (store) => store.delete(KEY));
  } catch { /* nothing to clear is not a failure */ }
}
