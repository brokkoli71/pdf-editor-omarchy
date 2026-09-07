// The one place that owns the IndexedDB schema.
//
// Three modules keep state here — the session, the recents list and the saved
// desktops — and they must not each open the database with their own version number: whichever
// opens second with a LOWER version fails outright, and a browser will not tell
// you why. One opener, one version, every store created together.

const DB_NAME = "sidemark";
const VERSION = 4;
// `handoff` carries dragged PAGES between two Sidemark windows. A drag's
// payload has to be readable by the window that receives it, and neither an
// object URL nor module state crosses one — but IndexedDB is per ORIGIN, so
// both windows already share it. The drag then carries only a key.
// `desktops` is the phone's list of computers it can attach to (desktops.js).
// It holds ADDRESSES, never a document — the live session runs on the desktop's
// own origin, and nothing of it is persisted here.
export const STORES = { session: {}, recent: { keyPath: "id" }, handoff: {},
                        desktops: { keyPath: "id" } };

export function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, opts] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, opts);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** How long a dragged-pages record is kept. It exists for the seconds between a
 * `dragstart` and a drop; anything older belongs to a window that went away
 * mid-drag, and a megabyte of PDF must not outlive it for good. */
const HANDOFF_TTL_MS = 60 * 60 * 1000;

/** Park pages for another window to pick up, pruning any left behind. */
export async function putHandoff(key, value) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction("handoff", "readwrite");
      const store = tx.objectStore("handoff");
      store.put({ ...value, at: Date.now() }, key);
      // Pruned on WRITE rather than on read: the window that reads may never
      // come, and this is the moment we know the store is being used at all.
      const cutoff = Date.now() - HANDOFF_TTL_MS;
      const cur = store.openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return;
        if (c.key !== key && !(c.value && c.value.at > cutoff)) c.delete();
        c.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Read parked pages. Deliberately NOT a delete: the same selection can be
 * dragged into a second window, and the source window holds the one key for it
 * until the selection changes. */
export async function takeHandoff(key) {
  return withStore("handoff", "readonly", (s) => s.get(key));
}

/** Run one request against a store and resolve its result. */
export async function withStore(store, mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}
