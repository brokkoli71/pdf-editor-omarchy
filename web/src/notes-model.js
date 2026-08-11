// Per-page Markdown notes, backed by a sidecar `.md` file.
//
// Ported from sidemark.py's NotesModel. The SIDECAR FORMAT is a real file
// shared with the desktop app, so this parses and writes the whole of it —
// including the linked-run, bookmark and hidden-page markers — even though the
// prototype's UI does not expose those yet. A reader that silently dropped a
// marker it did not understand would quietly damage a file the desktop app
// wrote, which is worse than not opening it at all.
//
// A page may CONTINUE the one before it: a run of linked pages shares ONE body,
// stored once on the run's first page. That is what makes duplication
// impossible rather than merely discouraged — but it means every reader has to
// say which text it wants:
//
//   get(idx)      the RESOLVED body — what the editor shows on this page.
//   ownText(idx)  the text this page STORES, "" on a continued page — what
//                 export, page marks and search want, so a run appears once
//                 instead of once per page.
//
// Reach for `get` only where a human is looking at that one page.

// `<!-- page:12 -->` opens a page's notes. One marker carries every invisible
// per-page fact and they compose: ` continued` says the page continues the one
// before it, ` hidden` sets it aside, ` bookmark="Eigenvalues"` names it. A
// marker can also name a RANGE — `<!-- page:13-40 continued -->` — because the
// fact is about the run, not about each page; the reader expands a range onto
// every page in it, so the per-page form keeps working and an older file needs
// no migration.
const MARKER_ATTRS = String.raw`(?:\s+continued|\s+hidden|\s+bookmark(?:="[^"\n]*")?)*`;
const PAGE_MARKER_RE = new RegExp(
  String.raw`<!--\s*page:(\d+)(?:-(\d+))?(` + MARKER_ATTRS + String.raw`)\s*-->`);
const PAGE_MARKER_SPLIT = new RegExp(PAGE_MARKER_RE.source, "g");
const EMBED_RE = /^\s*!\[\[.*?\]\]\n+/;

/** A bookmark name, safe inside a marker. Escaping `>` is what makes `-->`
 * unrepresentable, so a name can never terminate the comment it lives in. */
function escMarker(text) {
  return String(text ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    .replace(/>/g, "&gt;").replace(/\n/g, " ").trim();
}

function unescMarker(text) {
  return String(text ?? "").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/** What a notes sidecar says. `hadMarkers` is the distinction the loader hides:
 * a file with no `<!-- page:N -->` markers at all is an externally authored
 * note, and treating it as page 0 is a fallback, not a parse. */
export function parseNoteSections(raw) {
  raw = String(raw ?? "").replace(EMBED_RE, "");
  const parts = raw.split(PAGE_MARKER_SPLIT);
  if (parts.length === 1) {
    const text = raw.trim();
    return {
      sections: text ? { 0: text } : {},
      linked: new Set(), hadMarkers: false,
      bookmarks: {}, hidden: new Set(),
    };
  }
  const sections = {}, linked = new Set(), bookmarks = {}, hidden = new Set();
  // split yields [prefix, page, end, attrs, body, ...] — one entry per capture
  // group, so the stride is 4, not 2.
  for (let i = 1; i < parts.length; i += 4) {
    const idx = parseInt(parts[i], 10);
    const last = parts[i + 1] ? parseInt(parts[i + 1], 10) : idx;
    const attrs = parts[i + 2] || "";
    const content = (parts[i + 3] || "").trim();
    // a range applies its attributes to every page in it; a body (which a range
    // never has when we wrote it) stays with the first page
    const span = [];
    for (let p = idx; p <= Math.max(last, idx); p++) span.push(p);
    if (/\bcontinued\b/.test(attrs)) for (const p of span) linked.add(p);
    if (/\bhidden\b/.test(attrs)) for (const p of span) hidden.add(p);
    const bm = attrs.match(/\bbookmark\b(?:="([^"\n]*)")?/);
    if (bm) for (const p of span) bookmarks[p] = unescMarker(bm[1] || "");
    if (content) sections[idx] = content;
  }
  return { sections, linked, hadMarkers: true, bookmarks, hidden };
}

export class NotesModel {
  constructor() {
    this._notes = {};        // page idx → body
    this._links = new Set(); // pages that continue their predecessor
    this._bookmarks = {};    // page idx → label ("" = derive one for display)
    this._hidden = new Set();
    this.pdfName = null;     // written as ![[name.pdf]] at the top of the file
  }

  // ── runs ───────────────────────────────────────────────────────────────────

  isLinked(idx) { return this._links.has(idx); }

  /** The page that holds the body idx displays — itself when unlinked. */
  runStart(idx) {
    while (this._links.has(idx)) idx -= 1;
    return idx;
  }

  runPages(idx) {
    const start = this.runStart(idx);
    const pages = [start];
    let next = start + 1;
    while (this._links.has(next)) { pages.push(next); next += 1; }
    return pages;
  }

  runEnd(idx) { const p = this.runPages(idx); return p[p.length - 1]; }

  /** Continue idx's notes from the page before it. Any text idx had of its own
   * is APPENDED to the run's body — a link must never silently eat what someone
   * already wrote. */
  link(idx) {
    if (idx <= 0 || this._links.has(idx)) return false;
    const mine = (this._notes[idx] || "").trim();
    delete this._notes[idx];
    this._links.add(idx);
    if (mine) {
      const start = this.runStart(idx);
      const head = (this._notes[start] || "").trim();
      this._notes[start] = head ? `${head}\n\n${mine}` : mine;
    }
    return true;
  }

  unlink(idx) { return this._links.delete(idx); }

  // ── text ───────────────────────────────────────────────────────────────────

  /** The body shown on page idx — the run's, if it is part of one. */
  get(idx) { return this._notes[this.runStart(idx)] || ""; }

  /** What page idx stores; "" on a continued page. */
  ownText(idx) { return this._notes[idx] || ""; }

  /** Write page idx's notes — to the run's first page when it is linked, so the
   * shared body stays stored exactly once. */
  set(idx, text) {
    const start = this.runStart(idx);
    if (text) this._notes[start] = text;
    else delete this._notes[start];
  }

  /** True if anything is worth a sidecar (drives lazy file creation) — a bare
   * link flag or bookmark counts: losing a link would silently re-split a run,
   * and losing a bookmark loses the only copy of it. */
  hasContent() {
    return this._links.size > 0 || Object.keys(this._bookmarks).length > 0
      || this._hidden.size > 0
      || Object.values(this._notes).some((v) => v.trim());
  }

  pagesWithNotes() {
    return Object.keys(this._notes).map(Number)
      .filter((i) => (this._notes[i] || "").trim()).sort((a, b) => a - b);
  }

  isBookmarked(idx) { return idx in this._bookmarks; }
  isHidden(idx) { return this._hidden.has(idx); }

  // ── serialisation ──────────────────────────────────────────────────────────

  /** The attribute text of one page's marker. One builder, so the writer and
   * the range test can never disagree about what a page carries. */
  _markerAttrs(idx) {
    let attrs = "";
    if (this._links.has(idx)) attrs += " continued";
    if (this._hidden.has(idx)) attrs += " hidden";
    if (idx in this._bookmarks) {
      const name = this._bookmarks[idx];
      attrs += name ? ` bookmark="${escMarker(name)}"` : " bookmark";
    }
    return attrs;
  }

  _pageBody(idx) {
    return this._links.has(idx) ? "" : (this._notes[idx] || "").trim();
  }

  /** The sidecar's whole text — the sectioned form that gets written. */
  toText() {
    const pages = [...new Set([
      ...Object.keys(this._notes).map(Number),
      ...this._links,
      ...Object.keys(this._bookmarks).map(Number),
      ...this._hidden,
    ])].sort((a, b) => a - b);

    const sections = [];
    let i = 0;
    while (i < pages.length) {
      const idx = pages[i];
      let last = idx;
      const attrs = this._markerAttrs(idx);
      const body = this._pageBody(idx);
      // Coalesce the maximal run of adjacent pages carrying the SAME attributes
      // and no body into one range marker — the fact is about the run, not
      // about each page. A BOOKMARK ends a range in both directions: it names
      // one page, and a range would claim its name for every page in the span.
      if (attrs && !body && !(idx in this._bookmarks)) {
        while (i + 1 < pages.length && pages[i + 1] === last + 1
               && !(pages[i + 1] in this._bookmarks)
               && this._markerAttrs(pages[i + 1]) === attrs
               && !this._pageBody(pages[i + 1])) {
          i += 1;
          last = pages[i];
        }
      }
      i += 1;
      if (!attrs && !body) continue;
      // an EMPTY page is still written out when it carries a marker — a
      // continued page or a bookmark is invisible state that exists nowhere else
      const span = last === idx ? `${idx}` : `${idx}-${last}`;
      sections.push(`<!-- page:${span}${attrs} -->` + (body ? `\n\n${body}` : ""));
    }
    const body = sections.length ? sections.join("\n\n") + "\n" : "";
    const embed = this.pdfName ? `![[${this.pdfName}]]\n\n` : "";
    return embed + body;
  }

  /** Replace the whole model from a sidecar's text. Text with no page markers
   * at all becomes page 0's notes, exactly as loading an externally authored
   * file does. */
  setFromText(raw) {
    const parsed = parseNoteSections(raw);
    this._notes = { ...parsed.sections };
    this._links = new Set(parsed.linked);
    this._bookmarks = { ...parsed.bookmarks };
    this._hidden = new Set(parsed.hidden);
    this._normalize();
  }

  /** Restore the invariant a hand-edited sidecar can break: page 0 can continue
   * nothing, and a continued page holds no body of its own. */
  _normalize() {
    this._links = new Set([...this._links].filter((i) => i > 0));
    for (const idx of [...this._links].sort((a, b) => a - b)) {
      const body = (this._notes[idx] || "").trim();
      delete this._notes[idx];
      if (body) {
        const start = this.runStart(idx);
        const head = (this._notes[start] || "").trim();
        this._notes[start] = head ? `${head}\n\n${body}` : body;
      }
    }
  }

  /** Re-key every per-page fact by a page offset — what the merge import needs
   * when a document becomes a chapter of a larger one. */
  shiftBy(offset) {
    const out = new NotesModel();
    out.pdfName = this.pdfName;
    for (const [k, v] of Object.entries(this._notes)) out._notes[Number(k) + offset] = v;
    for (const i of this._links) out._links.add(i + offset);
    for (const [k, v] of Object.entries(this._bookmarks)) out._bookmarks[Number(k) + offset] = v;
    for (const i of this._hidden) out._hidden.add(i + offset);
    return out;
  }
}
