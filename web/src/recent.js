// Recently opened documents.
//
// The desktop keeps this in `recent.json` alongside the reading position. A
// browser has no paths, so an entry keeps whatever will actually reopen the
// document:
//
//   * a file HANDLE, where the browser has them. Reopening then reads the file
//     from disk as it is NOW, which is the only version worth calling recent —
//     and it needs one permission click, because a page that could silently
//     re-read files you once opened would be a different thing entirely.
//   * a copy of the BYTES otherwise, under a budget. Without this the list
//     would exist and do nothing in Firefox, which is worse than no list.
//
// Cookies were the other option and are the wrong tool twice over: a few
// kilobytes of storage, sent to a server on every request. IndexedDB is where
// this belongs.

import { withStore } from "./db.js";

const STORE_NAME = "recent";
const MAX_ENTRIES = 12;
// A lecture PDF runs to tens of megabytes and a browser's storage is shared with
// every other site. Keep a few documents openable, not a library.
const MAX_BYTES_PER_DOC = 40e6;
const MAX_BYTES_TOTAL = 150e6;


/** An id that survives a reopen: the name and size together, which is as close
 * to a path as a browser will give us. Two different files with the same name
 * and size would collide; two copies of the same file are the same document,
 * which is the case that actually happens. */
export function recentId(name, size) {
  return `${name}::${size || 0}`;
}

export async function listRecent() {
  try {
    const all = await withStore(STORE_NAME, "readonly", (store) => store.getAll());
    return (all || []).sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

/** Remember a document. `bytes` is stored only when there is no handle to reopen
 * it with and it fits the budget — a handle is always better, because it reads
 * the file as it is now rather than as it was. */
export async function rememberRecent({ name, bytes, handle, page = 0, thumb = null }) {
  try {
    const id = recentId(name, bytes ? bytes.length : 0);
    const entry = { id, name, at: Date.now(), page, handle: handle || null, thumb };
    if (!handle && bytes && bytes.length <= MAX_BYTES_PER_DOC) {
      entry.bytes = bytes;
    }
    await withStore(STORE_NAME, "readwrite", (store) => store.put(entry));
    await prune();
  } catch {
    // a recents list that cannot be written is not worth an error in the way
  }
}

export async function forgetRecent(id) {
  try {
    await withStore(STORE_NAME, "readwrite", (store) => store.delete(id));
  } catch { /* nothing to forget is not a failure */ }
}

export async function clearRecent() {
  try {
    await withStore(STORE_NAME, "readwrite", (store) => store.clear());
  } catch { /* ditto */ }
}

/** Keep the list short and the stored copies within budget. Entries are dropped
 * oldest-first, and a cached COPY is dropped before the entry itself is — a
 * name you can no longer open is still worth showing, because it tells you the
 * document exists and what it was called. */
async function prune() {
  const all = await listRecent();
  for (const entry of all.slice(MAX_ENTRIES)) await forgetRecent(entry.id);

  let total = 0;
  for (const entry of all.slice(0, MAX_ENTRIES)) {
    const size = entry.bytes ? entry.bytes.length : 0;
    if (!size) continue;
    if (total + size <= MAX_BYTES_TOTAL) { total += size; continue; }
    const stripped = { ...entry };
    delete stripped.bytes;
    await withStore(STORE_NAME, "readwrite", (store) => store.put(stripped));
  }
}

/** Can this entry actually be opened? A handle needs permission, which needs a
 * user gesture, so this only reports what is POSSIBLE. */
export async function recentState(entry) {
  if (entry.bytes) return "ready";
  if (!entry.handle) return "gone";
  try {
    const perm = await entry.handle.queryPermission({ mode: "read" });
    return perm === "granted" ? "ready" : "needs-permission";
  } catch {
    return "gone";
  }
}

/** The document's bytes, asking for permission if the handle needs it. Must be
 * called from a user gesture when it does. */
export async function openRecent(entry) {
  if (entry.handle) {
    try {
      let perm = await entry.handle.queryPermission({ mode: "read" });
      if (perm !== "granted") {
        perm = await entry.handle.requestPermission({ mode: "read" });
      }
      if (perm === "granted") {
        const file = await entry.handle.getFile();
        return { bytes: new Uint8Array(await file.arrayBuffer()),
                 name: file.name, handle: entry.handle };
      }
    } catch {
      // the file may have been moved or deleted since; fall through to the copy
    }
  }
  if (entry.bytes) {
    return { bytes: new Uint8Array(entry.bytes), name: entry.name, handle: null };
  }
  return null;
}
