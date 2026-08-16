// The sidebar: page thumbnails and the document outline.
//
// The Outline/Pages switch appears only when the document HAS an outline — on a
// lecture deck there is nothing to switch to, and an empty half of a switch is
// worse than no switch.

/** The drag type one Sidemark window offers another: a key into the shared
 * `handoff` store, never the bytes. A `dataTransfer` string crosses windows;
 * an object URL does not. */
export const PAGES_MIME = "application/x-sidemark-pages";

/** How long a press must last before the pages under it are extracted ready for
 * a drag. Long enough that turning the page never pays for it, short enough
 * that the hand has not yet moved far enough to start one. */
const DRAG_ARM_MS = 130;

export class Sidebar {
  constructor(root, opts) {
    this.root = root;
    this.onGoToPage = opts.onGoToPage;
    this.onDropFiles = opts.onDropFiles;
    this.onMovePage = opts.onMovePage || (() => {});
    this.onDeletePages = opts.onDeletePages || (() => {});
    this.onExportPages = opts.onExportPages || (() => {});
    this.onSelectionChanged = opts.onSelectionChanged || (() => {});
    this.onDragPayload = opts.onDragPayload || (() => null);
    this.onDragArm = opts.onDragArm || (() => {});
    this.onDropPages = opts.onDropPages || (() => {});
    this.onDropBookmark = opts.onDropBookmark || (() => {});
    this.onToggleHidden = opts.onToggleHidden || (() => {});
    this.onAddPage = opts.onAddPage || (() => {});
    this.showBookmarks = opts.showBookmarks !== false;
    this.doc = null;
    this.page = 0;
    this.view = "pages";
    this._thumbCentred = null;
    this._dragPage = null;
    this._menu = null;
    // A multi-selection of PAGES, separate from which page is in front. Plain
    // click navigates and clears it; Ctrl+click picks; Shift+click extends.
    this.selected = new Set();
    this._anchor = null;   // "is this a new page or the same one?"

    this.switchEl = root.querySelector("#side-switch");
    this.listEl = root.querySelector("#side-list");
    this.pagesBtn = root.querySelector("#side-pages");
    this.outlineBtn = root.querySelector("#side-outline");

    this.pagesBtn.addEventListener("click", () => this.setView("pages"));
    this.outlineBtn.addEventListener("click", () => this.setView("outline"));
    const box = root.querySelector("#side-bookmarks");
    if (box) {
      box.checked = this.showBookmarks;
      box.addEventListener("change", () => {
        this.showBookmarks = box.checked;
        if (opts.onShowBookmarks) opts.onShowBookmarks(box.checked);
        this.rebuild();
      });
    }
    this._installDrop();
  }

  setView(view) {
    if (this.view === view) return;
    this.view = view;
    this.pagesBtn.classList.toggle("selected", view === "pages");
    this.outlineBtn.classList.toggle("selected", view === "outline");
    this._thumbCentred = null;
    this.rebuild();
  }

  setDoc(doc) {
    this.doc = doc;
    this._thumbCentred = null;      // a document change clears it
    // The switch appears when the document has a TOC *or* bookmarks — a lecture
    // deck rarely has a TOC and is exactly what you bookmark your way around.
    const marks = doc ? doc.notes.bookmarkPages() : [];
    const hasOutline = !!(doc && (doc.outline.length || marks.length));
    this.switchEl.hidden = !hasOutline;
    const box = this.root.querySelector("#side-bookmarks-row");
    if (box) box.hidden = !marks.length;
    if (!hasOutline && this.view === "outline") this.setView("pages");
    else this.rebuild();
  }

  /** Bookmarks merged INTO the outline's own order, never sorted with it: each
   * is emitted before the first entry starting AFTER its page, and one on the
   * same page as an entry follows it.
   *
   * Re-sorting the whole list by page looks identical on a well-formed outline
   * and silently hands a chapter drag the wrong span on one whose entries are
   * out of page order. */
  _mergedOutline() {
    const doc = this.doc;
    const entries = doc.outline.map((e) => ({ ...e, kind: "entry" }));
    if (!this.showBookmarks) return entries;
    const marks = doc.notes.bookmarkPages().map((page) => ({
      kind: "bookmark",
      page,
      level: 0,
      title: doc.notes.bookmarkLabel(page, this._chapterFor(page)),
    }));
    const out = entries.slice();
    for (const mark of marks) {
      let at = out.findIndex((e) => e.kind === "entry" && e.page > mark.page);
      if (at < 0) at = out.length;
      out.splice(at, 0, mark);
    }
    return out;
  }

  _chapterFor(page) {
    let best = null;
    for (const e of this.doc.outline) if (e.page <= page) best = e.title;
    return best;
  }

  setPage(page) {
    if (this.page === page) return;
    this.page = page;
    this.rebuild();
  }

  /** A rebuild puts the strip back exactly where it stood; a genuine page
   * change brings the new page into view. The two are told apart by
   * `_thumbCentred` — without it the strip jumps to the top on every rebuild. */
  rebuild() {
    if (!this.doc) { this.listEl.replaceChildren(); return; }
    const keep = this.listEl.scrollTop;
    this.listEl.replaceChildren();
    if (this.view === "pages") this._buildPages();
    else this._buildOutline();

    if (this._thumbCentred === this.page) {
      this.listEl.scrollTop = keep;
    } else {
      this._thumbCentred = this.page;
      // A freshly built row has no layout yet, so ask on the next frame — at
      // the instant we are called every row reports y = 0 and there is nothing
      // to scroll to, which is why the strip used to open at page 1.
      requestAnimationFrame(() => {
        const el = this.listEl.querySelector(".row.current");
        if (el) el.scrollIntoView({ block: "nearest" });
      });
    }
  }

  /** The pages the current one shares its notes with (row 129), when there is
   * more than one — a run's body is stored ONCE, so "which page am I reading?"
   * has no single answer inside one and highlighting the whole run is the only
   * honest thing the strip can say. Empty when the page stands alone, which is
   * what keeps the ordinary case looking exactly as it did. */
  _runPages() {
    if (!this.doc || this.page === null || this.page === undefined) return new Set();
    const pages = this.doc.notes.runPages(this.page);
    return pages.length > 1 ? new Set(pages) : new Set();
  }

  _buildPages() {
    const run = this._runPages();
    for (let i = 0; i < this.doc.pageCount; i++) {
      const row = document.createElement("button");
      row.className = "row thumb" + (i === this.page ? " current" : "")
        + (run.has(i) ? " in-run" : "")
        + (this.doc.notes.isHidden(i) ? " hidden-page" : "");
      row.dataset.page = String(i);

      const holder = document.createElement("span");
      holder.className = "thumb-img";
      row.appendChild(holder);

      const label = document.createElement("span");
      label.className = "thumb-no";
      label.textContent = String(i + 1);
      row.appendChild(label);

      if (this.selected.has(i)) row.classList.add("picked");
      row.addEventListener("click", (e) => this._clickPage(e, i));
      this._makeReorderable(row, i);
      this.listEl.appendChild(row);

      // rendered lazily — a 400-page deck must not render 400 thumbnails to
      // show you the first screenful
      this._observe(row, holder, i);
    }
  }

  _clickPage(e, index) {
    if (e.shiftKey && this._anchor !== null) {
      const [lo, hi] = this._anchor <= index ? [this._anchor, index]
                                             : [index, this._anchor];
      for (let i = lo; i <= hi; i++) this.selected.add(i);
    } else if (e.ctrlKey || e.metaKey) {
      if (this.selected.has(index)) this.selected.delete(index);
      else this.selected.add(index);
      this._anchor = index;
    } else {
      // a plain click is navigation, and navigation ends a selection — leaving
      // one behind means the next verb acts on pages you stopped thinking about
      this.selected.clear();
      this._anchor = index;
      this.onGoToPage(index);
      this.rebuild();
      this.onSelectionChanged([...this.selected]);
      return;
    }
    this.rebuild();
    this.onSelectionChanged([...this.selected]);
  }

  /** Which pages a per-page verb applies to: the multi-selection when the
   * clicked row is IN it, else that row alone. ONE rule, shared by the menu and
   * the drag-export, so the two cannot disagree about what you meant. */
  pagesActedOn(clicked) {
    if (this.selected.has(clicked)) return [...this.selected].sort((a, b) => a - b);
    return [clicked];
  }

  clearSelection() {
    if (!this.selected.size) return;
    this.selected.clear();
    this.rebuild();
    this.onSelectionChanged([]);
  }

  /** Drag a thumbnail to move its page. The drop lands at the GAP you are
   * hovering, which is the same rule a file drop uses — one meaning for
   * "between these two rows", whatever you are dragging. */
  _makeReorderable(row, index) {
    row.draggable = true;
    // A drag's payload must be set SYNCHRONOUSLY inside `dragstart`, and
    // extracting pages is async — so the press ARMS it. `pointerdown` is the
    // only moment there is: it precedes the drag by at least the distance the
    // hand has to move. Without this the export was ready only for a page you
    // had ctrl-clicked first, so an ordinary drag of an unselected thumbnail
    // carried no file at all and dropping it did nothing, anywhere.
    //
    // Held off by DRAG_ARM_MS, because extracting pages means parsing the whole
    // document: a plain click to turn the page must not pay for it. A press
    // that is still down after this long is going somewhere.
    row.addEventListener("pointerdown", () => {
      clearTimeout(this._armTimer);
      this._armTimer = setTimeout(() => this.onDragArm(index), DRAG_ARM_MS);
    });
    row.addEventListener("pointerup", () => clearTimeout(this._armTimer));
    row.addEventListener("dragstart", (e) => {
      this._dragPage = index;
      // …and again here, for the case the press was too quick for the arm: this
      // drag goes without a file, the next one has it ready
      clearTimeout(this._armTimer);
      this.onDragArm(index);
      e.dataTransfer.effectAllowed = "copyMove";
      // A drag needs SOME payload to start, and it must not be `text/plain`:
      // the notes editor accepts dropped text, so a page dragged over the notes
      // panel was inserting its own index there as characters. Our own type is
      // meaningless to everything else on the page, which is the point.
      e.dataTransfer.setData(PAGES_MIME, "");
      // …and if a file is ready for these pages, offer it to the DESKTOP as
      // well, so the same drag reorders inside the strip and exports outside it
      const payload = this.onDragPayload(index);
      if (payload) {
        if (payload.download) {
          try { e.dataTransfer.setData("DownloadURL", payload.download); }
          catch { /* not Chromium: the menu's export is the whole feature */ }
        }
        // The same drag also travels to ANOTHER Sidemark window, which cannot
        // read a `DownloadURL` (that type is for the desktop) nor an object URL
        // from this one. It gets a key into the shared database instead.
        if (payload.handoff) e.dataTransfer.setData(PAGES_MIME, payload.handoff);
      }
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => {
      this._dragPage = null;
      row.classList.remove("dragging");
      this._markGap(null);
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this._openPageMenu(e, index);
    });
  }

  /** Right-click a page for the verbs that have nowhere else to live. */
  _openPageMenu(e, index) {
    this._closePageMenu();
    const menu = document.createElement("div");
    menu.className = "page-menu";
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    const add = (label, fn, danger = false) => {
      const b = document.createElement("button");
      b.textContent = label;
      if (danger) b.classList.add("danger");
      b.addEventListener("click", () => { this._closePageMenu(); fn(); });
      menu.appendChild(b);
    };
    const pages = this.pagesActedOn(index);
    const many = pages.length > 1;
    const label = (verb) => (many ? `${verb} ${pages.length} pages` : verb);
    add(many ? `Export ${pages.length} pages…` : "Export this page…",
        () => this.onExportPages(pages));
    add("Go to page", () => this.onGoToPage(index));
    if (index > 0) add("Move up", () => this.onMovePage(index, index - 1));
    if (this.doc && index < this.doc.pageCount - 1) {
      add("Move down", () => this.onMovePage(index, index + 1));
    }
    // The verb offered is the one that CHANGES something, so a page you are
    // looking at never shows both.
    // the verb offered is the one that CHANGES something, so a mixed selection
    // needs no thought
    const allHidden = pages.every((p) => this.doc && this.doc.notes.isHidden(p));
    add(label(allHidden ? "Unhide" : "Hide"),
        () => pages.forEach((p) => this.onToggleHidden(p, allHidden)));
    add("Add blank page after", () => this.onAddPage(index, "plain"));
    add("  …with lines", () => this.onAddPage(index, "lines"));
    add("  …with squares", () => this.onAddPage(index, "squares"));
    add("  …with dots", () => this.onAddPage(index, "dots"));
    add(label("Delete"), () => this.onDeletePages(pages), true);
    document.body.appendChild(menu);
    this._menu = menu;
    // KEEP IT ON SCREEN. The strip is a column you scroll to the bottom of, so
    // most right-clicks land in the lower half of the window — and a menu is
    // nine entries tall. Placed naively at the pointer it ran 241 px past the
    // bottom on the last thumbnail, putting EVERY entry out of reach: the
    // handlers all worked, and nobody could click one.
    //
    // Measured after insertion, because the height is whatever the entries
    // came to. It flips ABOVE the pointer when there is more room there — never
    // just clamped to the bottom edge, which would drop the menu under the
    // hand that opened it.
    const m = menu.getBoundingClientRect();
    const margin = 6;
    if (m.bottom > window.innerHeight - margin) {
      const above = e.clientY - m.height;
      menu.style.top = `${above >= margin ? above
        : Math.max(margin, window.innerHeight - m.height - margin)}px`;
    }
    if (m.right > window.innerWidth - margin) {
      menu.style.left = `${Math.max(margin, window.innerWidth - m.width - margin)}px`;
    }
    // Close on a press OUTSIDE the menu — and only outside.
    //
    // A press anywhere used to close it, including on its own buttons: the
    // pointerdown removed the menu, so the button was gone before `click` could
    // reach it and every entry did nothing. A synthetic `.click()` hides this
    // completely, because it never dispatches a pointerdown.
    this._closeMenuOn = (e) => {
      if (this._menu && this._menu.contains(e.target)) return;
      this._closePageMenu();
    };
    setTimeout(() => {
      window.addEventListener("pointerdown", this._closeMenuOn, true);
    }, 0);
  }

  _closePageMenu() {
    if (this._closeMenuOn) {
      window.removeEventListener("pointerdown", this._closeMenuOn, true);
      this._closeMenuOn = null;
    }
    if (this._menu) { this._menu.remove(); this._menu = null; }
  }

  _observe(row, holder, index) {
    if (!this._io) {
      this._io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          this._io.unobserve(entry.target);
          const i = Number(entry.target.dataset.page);
          const slot = entry.target.querySelector(".thumb-img");
          this.doc.thumbnail(i).then((canvas) => {
            if (slot.isConnected) slot.replaceChildren(canvas);
          }).catch(() => { /* a page that will not render just stays blank */ });
        }
      }, { root: this.listEl, rootMargin: "200px" });
    }
    this._io.observe(row);
  }

  _buildOutline() {
    const entries = this._mergedOutline();
    const run = this._runPages();
    // WHERE YOU ARE IS A LINE when no entry names your page (row 153): on an
    // entry's own page that row gets the bar and a bold title; anywhere else a
    // rule carrying the page number is inserted BETWEEN the two entries you
    // fall between, and the containing entry keeps only a faint tint. It counts
    // every row, because "the entry above me" is whatever is actually above me.
    const exact = entries.findIndex((e) => e.page === this.page);
    let insertAt = -1;
    if (exact < 0) {
      insertAt = entries.findIndex((e) => e.page > this.page);
      if (insertAt < 0) insertAt = entries.length;
    }

    entries.forEach((entry, i) => {
      if (i === insertAt) this.listEl.appendChild(this._hereLine());
      const row = document.createElement("button");
      row.className = "row outline-row";
      if (i === exact) row.classList.add("current");
      else if (exact < 0 && i === insertAt - 1) row.classList.add("containing");
      if (run.has(entry.page)) row.classList.add("in-run");
      row.style.paddingLeft = `${10 + entry.level * 14}px`;
      row.dataset.page = String(entry.page);

      if (entry.kind === "bookmark") {
        const star = document.createElement("span");
        star.className = "star";
        star.textContent = "★";
        row.appendChild(star);
        row.addEventListener("contextmenu", (ev) => {
          ev.preventDefault();
          this.onDropBookmark(entry.page);
        });
      }
      const title = document.createElement("span");
      title.className = "outline-title";
      title.textContent = entry.title;
      row.appendChild(title);

      const no = document.createElement("span");
      no.className = "outline-page";
      no.textContent = String(entry.page + 1);
      row.appendChild(no);

      row.addEventListener("click", () => this.onGoToPage(entry.page));
      this.listEl.appendChild(row);
    });
    if (insertAt === entries.length) this.listEl.appendChild(this._hereLine());
  }

  /** Neither selectable nor activatable: a row you could click would be a
   * destination that does not exist. */
  _hereLine() {
    const line = document.createElement("div");
    line.className = "here-line current";
    const n = document.createElement("span");
    n.textContent = String(this.page + 1);
    line.appendChild(n);
    return line;
  }

  // ── drop ───────────────────────────────────────────────────────────────────

  /** A drop on the sidebar imports AT THAT GAP — between the two rows you
   * dropped between, or at the end when you drop in the empty space below. */
  _installDrop() {
    const el = this.listEl;
    el.addEventListener("dragover", (e) => {
      if (!this.doc) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = this._dragPage === null ? "copy" : "move";
      this._markGap(this._gapAt(e.clientY));
    });
    el.addEventListener("dragleave", () => this._markGap(null));
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const gap = this._gapAt(e.clientY);
      this._markGap(null);
      // a dragged PAGE moves; a dragged FILE imports — both at the same gap
      if (this._dragPage !== null && this._dragPage !== undefined) {
        const from = this._dragPage;
        this._dragPage = null;
        // the gap is expressed in the document WITH the page still in it, and
        // moveRangeOrder wants it with the block taken out
        const to = gap > from ? gap - 1 : gap;
        if (to !== from) this.onMovePage(from, to);
        return;
      }
      // Pages dragged out of ANOTHER Sidemark window. Checked before the files,
      // because a drag can carry both and this is the lossless half — it brings
      // the ink with it, where a file would arrive flattened.
      // an EMPTY key is the "this drag has started" marker, not a handoff
      const key = e.dataTransfer.getData(PAGES_MIME);
      if (key) return this.onDropPages(key, gap);
      if (e.dataTransfer.types.includes(PAGES_MIME)) return;   // ours, unready
      const files = [...(e.dataTransfer.files || [])];
      if (files.length) this.onDropFiles(files, gap);
    });
  }

  _gapAt(clientY) {
    const rows = [...this.listEl.querySelectorAll(".row")];
    for (const row of rows) {
      const r = row.getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return Number(row.dataset.page);
    }
    return this.doc ? this.doc.pageCount : 0;
  }

  _markGap(gap) {
    for (const row of this.listEl.querySelectorAll(".row")) {
      row.classList.toggle("gap-before", gap !== null && Number(row.dataset.page) === gap);
    }
    this.listEl.classList.toggle("gap-end",
      gap !== null && this.doc && gap >= this.doc.pageCount);
  }
}
