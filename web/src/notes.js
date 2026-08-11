// The live-Markdown notes panel — the column beside the page.
//
// Built on CodeMirror 6 because the live rendering this panel exists for needs
// exactly what CM6's decoration system provides: replacing a range of SOURCE
// with rendered text while the source stays in the document underneath. The
// desktop app does this with GtkTextView tags and an index map; here the
// mapping is CM6's own, which is the one part of the port that gets simpler.
//
// Per-page notes are held by NotesModel, never by the editor: the buffer is a
// view of one page's body. The two paths that move text between buffer and
// model have to say which they mean — `commit()` parses the buffer back into
// the model, `showPage()` fills it — and everything else goes through them.

import {
  EditorView, EditorState, keymap, history, defaultKeymap, historyKeymap,
  indentWithTab, markdown, syntaxHighlighting, HighlightStyle, tags, placeholder,
} from "../vendor/codemirror.js";

/** Markdown highlighting, kept deliberately quiet.
 *
 * NB the maths grammar wins over Markdown's: `_` is a SUBSCRIPT here, so
 * `_emphasis_` must not be slanted — only `*italic*` puts the slant back. That
 * is why emphasis is styled by weight and colour rather than by italics. */
const mdHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontWeight: "700", fontSize: "1.25em" },
  { tag: tags.heading2, fontWeight: "700", fontSize: "1.15em" },
  { tag: tags.heading3, fontWeight: "700", fontSize: "1.05em" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "normal" },
  { tag: tags.monospace, fontFamily: "ui-monospace, monospace" },
  { tag: tags.link, color: "var(--accent-bg)" },
  { tag: tags.list, color: "var(--dim)" },
  { tag: tags.quote, color: "var(--dim)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "15px", backgroundColor: "var(--view-bg)",
         color: "var(--window-fg)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "Cantarell, 'Adwaita Sans', Inter, system-ui, sans-serif",
    lineHeight: "1.55",
    padding: "14px 16px",
  },
  ".cm-content": { caretColor: "var(--window-fg)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--window-fg)" },
  ".cm-gutters": { display: "none" },
  ".cm-activeLine": { backgroundColor: "transparent" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--accent-bg) 30%, transparent)",
  },
  ".cm-placeholder": { color: "var(--dim)" },
});

export class NotesView {
  constructor(host, opts = {}) {
    this.model = null;
    this.page = 0;
    this.onDirty = opts.onDirty || (() => {});
    this._loading = false;

    this.view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: "",
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          markdown(),
          syntaxHighlighting(mdHighlight),
          theme,
          EditorView.lineWrapping,
          placeholder("Notes for this page…"),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !this._loading) this._onEdit();
          }),
        ],
      }),
    });
  }

  setModel(model) {
    this.model = model;
    this.showPage(0);
  }

  /** Write the buffer back to the page it belongs to. Goes to the run's first
   * page when the page is linked, so a shared body stays stored exactly once —
   * `NotesModel.set` is what knows that, which is why this must not touch the
   * model's internals. */
  commit() {
    if (!this.model) return;
    this.model.set(this.page, this.view.state.doc.toString().trim());
  }

  /** Show a page's notes. Commits the page being left FIRST — a page change
   * that dropped the buffer would lose whatever was typed last. */
  showPage(page) {
    if (!this.model) return;
    if (page !== this.page) this.commit();
    this.page = page;
    const text = this.model.get(page);
    this._loading = true;      // our own fill must not mark the file dirty
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
      selection: { anchor: Math.min(text.length, this.view.state.selection.main.anchor) },
    });
    this._loading = false;
  }

  _onEdit() {
    this.commit();
    this.onDirty();
  }

  focus() { this.view.focus(); }
}
