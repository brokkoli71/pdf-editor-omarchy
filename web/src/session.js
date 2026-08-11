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

const DB_NAME = "sidemark";
const STORE = "session";
const KEY = "last";

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** Ink is a Map of page → strokes; strokes are plain objects, so the only work
 * is turning the Map into something structured-cloneable and back. */
function inkToJson(ink) {
  return [...ink.entries()].filter(([, s]) => s && s.length);
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
    await withStore("readwrite", (store) => store.put({
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
    const rec = await withStore("readonly", (store) => store.get(KEY));
    if (!rec || !rec.bytes) return null;
    return { ...rec, ink: inkFromJson(rec.ink) };
  } catch {
    return null;
  }
}

export async function clearSession() {
  try {
    await withStore("readwrite", (store) => store.delete(KEY));
  } catch { /* nothing to clear is not a failure */ }
}
