// Find in document.
//
// The FIRST match is found synchronously and jumped to; the rest of the pages
// are scanned in the background, so the count keeps climbing while you carry on
// typing. The whole point is that a keystroke never waits for the document —
// scanning every page before returning is most of a second per character on a
// large PDF, and the next keystroke throws all of it away.
//
// Ported from rows 154/155, including the parts that are easy to leave out and
// then miss:
//
//   * matches are ordered by PAGE and rebuilt as hits arrive, never in the
//     order the scan found them, and the current match is re-found by IDENTITY
//     — a hit landing ahead of it renumbers the label without moving you.
//   * the count says when it is still climbing, and "not found" WAITS for the
//     scan to finish, or every long document flashes red at a term that is in
//     it.
//   * stepping off the end of a partial result set finishes the scan first:
//     wrapping to match 1 with pages unread silently skips everything between
//     here and the end.

export const SEARCH_SYNC_MS = 25;
export const SEARCH_CHUNK_MS = 8;
// A tail this short is finished on the spot rather than handed to the idle
// loop: deferring it costs more than doing it, and it keeps an ordinary
// document's count final the moment you stop typing.
export const SEARCH_SYNC_TAIL = 8;

/** Page text plus the map from string offset back to the items it came from,
 * which is what turns a match into rectangles on the page. */
export async function pageText(page) {
  const content = await page.getTextContent();
  let text = "";
  const spans = [];
  for (const item of content.items) {
    if (typeof item.str !== "string") continue;
    if (item.str) {
      spans.push({ at: text.length, len: item.str.length, item });
      text += item.str;
    }
    // pdf.js marks a line break on the item that ends one; without this,
    // "the end" and "of a line" run together and a search for "endof" hits
    if (item.hasEOL) text += "\n";
  }
  return { text, spans };
}

/** Rectangles for a match, in PDF user space (y UP from the bottom-left).
 *
 * A match can span several text items, so it is clipped against each one and a
 * rect emitted per overlap. Within an item the offset is proportional to the
 * character count, which is wrong for a proportional font and close enough for
 * a highlight — the alternative is measuring glyph advances we do not have. */
export function matchRects(spans, from, to) {
  const rects = [];
  for (const { at, len, item } of spans) {
    const s = Math.max(from, at), e = Math.min(to, at + len);
    if (e <= s || !len) continue;
    const tr = item.transform;
    const x = tr[4], y = tr[5];
    const h = item.height || Math.abs(tr[3]) || 10;
    const w = item.width || 0;
    const x0 = x + (w * (s - at)) / len;
    const x1 = x + (w * (e - at)) / len;
    rects.push([x0, y, x1 - x0, h]);
  }
  return rects;
}

export class Search {
  /** `provider` answers `pageCount` and `getPage(i)`; `onUpdate` is called
   * whenever the results or the scan state change. */
  constructor(provider, { onUpdate = () => {}, onGoTo = () => {} } = {}) {
    this.provider = provider;
    this.onUpdate = onUpdate;
    this.onGoTo = onGoTo;
    this.query = "";
    this.matches = [];        // {page, from, to} ordered by page
    this.current = null;      // the match object itself, not an index
    this.scanning = false;
    this._cache = new Map();  // page → {text, spans}
    this._token = 0;
    this._pending = [];
    this._idle = null;
  }

  clearCache() { this._cache.clear(); }

  get index() {
    const i = this.matches.indexOf(this.current);
    return i < 0 ? 0 : i + 1;
  }

  async _textFor(page) {
    if (this._cache.has(page)) return this._cache.get(page);
    const rec = await pageText(await this.provider.getPage(page));
    this._cache.set(page, rec);
    return rec;
  }

  _hitsIn(text, page) {
    const out = [];
    const needle = this.query.toLowerCase();
    if (!needle) return out;
    const hay = text.toLowerCase();
    let at = hay.indexOf(needle);
    while (at >= 0) {
      out.push({ page, from: at, to: at + needle.length });
      at = hay.indexOf(needle, at + needle.length);
    }
    return out;
  }

  /** Pages in the order they should be scanned: from where you ARE, forwards,
   * then wrapping — so the first hit found is the one you would have gone to
   * anyway. */
  _scanOrder(from) {
    const n = this.provider.pageCount;
    const order = [];
    for (let i = 0; i < n; i++) order.push((from + i) % n);
    return order;
  }

  async setQuery(query, fromPage) {
    this.stop();
    this.query = query;
    this.matches = [];
    this.current = null;
    if (!query) { this.onUpdate(); return; }

    const order = this._scanOrder(fromPage);
    const deadline = performance.now() + SEARCH_SYNC_MS;
    const token = ++this._token;
    let i = 0;
    let firstFound = null;
    // spend the sync budget, but always far enough to have the first match
    while (i < order.length
           && (performance.now() < deadline || !this.matches.length)) {
      const hits = await this._scanPage(order[i++], token);
      if (token !== this._token) return;
      if (!firstFound && hits.length) firstFound = hits[0];
    }
    this._pending = order.slice(i);
    // …and finish a short tail on the spot rather than deferring it
    if (this._pending.length && this._pending.length <= SEARCH_SYNC_TAIL) {
      const more = await this._finish(token);
      if (token !== this._token) return;
      if (!firstFound && more) firstFound = more;
    }
    // Jump to the first hit FOUND, not the first by page: the scan runs
    // forwards from where you are, so that is the one you would have gone to
    // anyway. The LIST stays in page order, which is why the two differ.
    if (firstFound) this._goTo(firstFound);
    this.scanning = this._pending.length > 0;
    this.onUpdate();
    if (this.scanning) this._pump(token);
  }

  /** Returns the hits found on this page, so the caller can tell which was
   * found FIRST — the list itself is kept in page order and cannot say. */
  async _scanPage(page, token) {
    let rec;
    try { rec = await this._textFor(page); } catch { return []; }
    if (token !== this._token) return [];
    const hits = this._hitsIn(rec.text, page);
    if (!hits.length) return [];
    // rebuilt in PAGE order, never in the order the scan found them
    this.matches = this.matches.concat(hits).sort((a, b) =>
      a.page - b.page || a.from - b.from);
    return hits;
  }

  _pump(token) {
    this._idle = (window.requestIdleCallback || window.setTimeout)(async () => {
      if (token !== this._token) return;
      const deadline = performance.now() + SEARCH_CHUNK_MS;
      while (this._pending.length && performance.now() < deadline) {
        await this._scanPage(this._pending.shift(), token);
        if (token !== this._token) return;
      }
      this.scanning = this._pending.length > 0;
      this.onUpdate();
      if (this.scanning) this._pump(token);
    }, 1);
  }

  /** Scan whatever is left, now. Returns the first hit it found, if any. */
  async _finish(token) {
    let first = null;
    while (this._pending.length) {
      const hits = await this._scanPage(this._pending.shift(), token);
      if (token !== this._token) return null;
      if (!first && hits.length) first = hits[0];
    }
    this.scanning = false;
    return first;
  }

  stop() {
    this._token++;
    this._pending = [];
    this.scanning = false;
    if (this._idle !== null) {
      (window.cancelIdleCallback || window.clearTimeout)(this._idle);
      this._idle = null;
    }
  }

  /** Step to the next/previous match. Stepping off the END of a partial result
   * set finishes the scan first — wrapping to match 1 with pages still unread
   * silently skips everything between here and the end. */
  async step(delta) {
    if (!this.matches.length) return;
    let i = this.matches.indexOf(this.current);
    if (i < 0) i = 0; else i += delta;
    if ((i >= this.matches.length || i < 0) && this.scanning) {
      const token = this._token;
      await this._finish(token);
      if (token !== this._token) return;
      this.onUpdate();
      i = this.matches.indexOf(this.current) + delta;
    }
    if (i >= this.matches.length) i = 0;
    if (i < 0) i = this.matches.length - 1;
    this._goTo(this.matches[i]);
    this.onUpdate();
  }

  _goTo(match) {
    this.current = match;
    this.onGoTo(match);
  }

  /** Rects for every match on a page, in PDF user space, with the current one
   * flagged so the painter can tell them apart. */
  rectsOn(page) {
    const rec = this._cache.get(page);
    if (!rec) return [];
    const out = [];
    for (const m of this.matches) {
      if (m.page !== page) continue;
      for (const r of matchRects(rec.spans, m.from, m.to)) {
        out.push({ rect: r, current: m === this.current });
      }
    }
    return out;
  }
}
