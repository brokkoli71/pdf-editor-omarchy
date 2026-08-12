// The one place that owns the IndexedDB schema.
//
// Two modules keep state here — the session and the recents list — and they
// must not each open the database with their own version number: whichever
// opens second with a LOWER version fails outright, and a browser will not tell
// you why. One opener, one version, every store created together.

const DB_NAME = "sidemark";
const VERSION = 2;
export const STORES = { session: {}, recent: { keyPath: "id" } };

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
