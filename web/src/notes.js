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
  Decoration, WidgetType, ViewPlugin, RangeSetBuilder,
} from "../vendor/codemirror.js";
import { renderSpans, scriptStyle, RENDERABLE_RE } from "./mathrender.js";

// ── the live rendering ───────────────────────────────────────────────────────
//
// Each span that renders as something other than itself is REPLACED by a
// widget showing the glyph, while the source stays in the document underneath.
// Two rules decide what falls back to source, and they are different on
// purpose:
//
//   * the CARET reveals only what it TOUCHES — the `\command` under it, the
//     script it is inside — and the rest of the line stays rendered. A whole
//     line reverting under a click moved every symbol on it just as you aimed
//     at one.
//   * a SELECTION reveals every line it covers, entirely. What you have
//     selected is what you are about to cut or replace, and a selection whose
//     text re-shaped itself as it grew is worse than lines that settle once.

class GlyphWidget extends WidgetType {
  constructor(text, cls) { super(); this.text = text; this.cls = cls; }
  eq(other) { return other.text === this.text && other.cls === this.cls; }
  toDOM() {
    const span = document.createElement("span");
    span.className = this.cls;
    span.textContent = this.text;
    return span;
  }
  ignoreEvent() { return false; }
}

class ScriptWidget extends WidgetType {
  constructor(text, chain) { super(); this.text = text; this.chain = chain; }
  eq(other) {
    return other.text === this.text && other.chain.join() === this.chain.join();
  }
  toDOM() {
    const { rise, scale } = scriptStyle(this.chain);
    const span = document.createElement("span");
    span.className = "sm-script";
    span.textContent = this.text;
    span.style.fontSize = `${(scale * 100).toFixed(1)}%`;
    // relative to the BASE em, not to the shrunken one, which is what puts the
    // `2` of `a_i^2` at the top of the i instead of the top of the a
    span.style.verticalAlign = `${(rise / scale).toFixed(3)}em`;
    return span;
  }
  ignoreEvent() { return false; }
}

// A whole-line comment hides its NEWLINE too, or a hidden marker still costs a
// blank line where it used to be.
const COMMENT_RE = /<!--[\s\S]*?-->/g;

/** HTML comments are hidden, as in any Markdown viewer — and Sidemark's own
 * per-page bookkeeping lives in them (page markers, anchors, callouts), so on a
 * sheet showing a whole sidecar they would be most of what is on screen.
 *
 * Never REMOVED from the file, only from the view, and revealed on the cursor's
 * line like every other marker. */
function commentRanges(text, lineFrom) {
  const out = [];
  COMMENT_RE.lastIndex = 0;
  for (const m of text.matchAll(COMMENT_RE)) {
    const from = m.index, to = m.index + m[0].length;
    const whole = text.slice(0, from).trim() === "" && text.slice(to).trim() === "";
    out.push({ from: lineFrom + from, to: lineFrom + to, whole });
  }
  return out;
}

function buildDecorations(view) {
  const builder = new RangeSetBuilder();
  const { state } = view;
  const sel = state.selection.main;
  // every line a non-empty selection covers shows its source, whole
  const selFrom = sel.empty ? -1 : sel.from;
  const selTo = sel.empty ? -1 : sel.to;

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = state.doc.lineAt(pos);
      pos = line.to + 1;
      if (!RENDERABLE_RE.test(line.text)) continue;   // plain prose renders as itself
      // a selection touching this line at all reveals the whole line
      if (selFrom >= 0 && selFrom <= line.to && selTo >= line.from) continue;

      const onThisLine = sel.empty && sel.head >= line.from && sel.head <= line.to;
      const comments = onThisLine ? [] : commentRanges(line.text, line.from);
      const hidden = (a, b) => comments.some((c) => a < c.to && c.from < b);
      // A RangeSetBuilder demands ranges in ascending order, and a line's
      // comments and its maths are interleaved in the source — so the line's
      // decorations are COLLECTED and sorted rather than added as they are
      // found. Adding them in two passes throws.
      const onLine = [];
      // A line that is ONLY a comment has to lose its NEWLINE too, or a hidden
      // marker still costs a blank line. A plugin may not replace a line break
      // — CodeMirror refuses that outright — so the LINE is hidden instead,
      // which removes its height and its break together.
      if (comments.some((c) => c.whole)) {
        builder.add(line.from, line.from,
                    Decoration.line({ attributes: { class: "sm-hidden-line" } }));
        continue;
      }
      for (const c of comments) {
        onLine.push({ from: c.from, to: c.to, deco: Decoration.replace({}) });
      }

      for (const span of renderSpans(line.text)) {
        const a = line.from + span.from, b = line.from + span.to;
        // The caret reveals only the expression it is INSIDE, edges included:
        // standing at either end means you are still writing it. Tested against
        // `caretTo`, which stops before the space the expression ate — typing
        // that space is how you say you are finished, so it must not be the
        // thing that keeps the source open under the caret.
        const caretB = line.from + (span.caretTo ?? span.to);
        if (sel.empty && sel.head >= a && sel.head <= caretB) continue;
        if (hidden(a, b)) continue;    // already replaced as part of a comment
        const widget = span.kind === "script"
          ? new ScriptWidget(span.text, span.chain)
          : new GlyphWidget(span.text, "sm-glyph");
        onLine.push({ from: a, to: b, deco: Decoration.replace({ widget }) });
      }
      onLine.sort((p, q) => p.from - q.from || p.to - q.to);
      for (const d of onLine) builder.add(d.from, d.to, d.deco);
    }
  }
  return builder.finish();
}

const liveMath = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = buildDecorations(view); }
  update(u) {
    // the caret moving is enough to change what is rendered, so a selection
    // change has to rebuild just as a document change does
    if (u.docChanged || u.selectionSet || u.viewportChanged) {
      this.decorations = buildDecorations(u.view);
    }
  }
}, { decorations: (v) => v.decorations });

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
  ".sm-script": { lineHeight: "0" },   // a lifted script must not open the line
  ".sm-hidden-line": { display: "none" },
});

export class NotesView {
  constructor(host, opts = {}) {
    this.model = null;
    this.page = 0;
    this.full = false;          // the whole sidecar, rather than one page
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
          liveMath,
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

  /** Point the panel at a different document's notes.
   *
   * The buffer belongs to the model it was filled from, so it is committed to
   * the OLD one before the swap. Assigning the model first and then calling
   * showPage writes whatever is on screen into the new document at the page
   * number the old one happened to be on — opening document B while on page 3
   * of A silently gave B page 3 of A's notes. */
  setModel(model) {
    if (this.model && this.model !== model) this.commit();
    this.model = model;
    this.page = 0;
    this.full = false;
    this.showPage(0);
  }

  /** FULL-NOTES view (row 130): the sheet shows the whole sidecar — markers and
   * all — instead of one page's body. That is the only way one buffer can hold
   * a per-page model, and it is what the divider dragged to full width gives
   * you.
   *
   * A VIEW state, never a conversion: nothing is written either way, so a drag
   * that crosses the line and comes back leaves no trace. */
  setFull(on) {
    if (!this.model || on === this.full) return;
    this.commitFull();                 // write the view being left
    this.full = on;
    const text = on ? this.model.toText() : this.model.get(this.page);
    this._fill(text);
  }

  /** Commit whichever view is on screen. The two paths have to say which they
   * mean — parsing a per-page buffer as a whole file would eat the markers. */
  commitFull() {
    if (!this.model) return;
    if (this.full) this.model.setFromText(this.view.state.doc.toString());
    else this.commit();
  }

  /** Write the buffer back to the page it belongs to. Goes to the run's first
   * page when the page is linked, so a shared body stays stored exactly once —
   * `NotesModel.set` is what knows that, which is why this must not touch the
   * model's internals. */
  commit() {
    if (!this.model) return;
    if (this.full) { this.commitFull(); return; }
    this.model.set(this.page, this.view.state.doc.toString().trim());
  }

  /** Show a page's notes. Commits the page being left FIRST — a page change
   * that dropped the buffer would lose whatever was typed last. */
  showPage(page) {
    if (!this.model) return;
    if (page !== this.page) this.commit();
    this.page = page;
    // in the full view the sheet is the whole file, so a page change moves the
    // canvas and leaves the text alone
    if (this.full) return;
    this._fill(this.model.get(page));
  }

  _fill(text) {
    this._loading = true;      // our own fill must not mark the file dirty
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
      selection: { anchor: Math.min(text.length, this.view.state.selection.main.anchor) },
    });
    this._loading = false;
  }

  _onEdit() {
    this.commitFull();
    this.onDirty();
  }

  focus() { this.view.focus(); }
}
