// Entry point for the vendored CodeMirror 6 bundle.
//
// The prototype has no build step; this is the one exception, run by hand and
// its OUTPUT committed (vendor/codemirror.js). Everything the notes view needs
// must be re-exported here, because CodeMirror is very sensitive to being
// loaded twice: two copies of @codemirror/state means two different Facet
// identities and nothing works. One bundle, one instance.
//
// Regenerate with:  npm run vendor:cm
export { EditorView, Decoration, WidgetType, ViewPlugin, keymap, placeholder }
  from "@codemirror/view";
export { EditorState, StateField, StateEffect, RangeSetBuilder, Compartment }
  from "@codemirror/state";
export { history, defaultKeymap, historyKeymap, indentWithTab }
  from "@codemirror/commands";
export { markdown } from "@codemirror/lang-markdown";
export { syntaxHighlighting, HighlightStyle, syntaxTree } from "@codemirror/language";
export { tags } from "@lezer/highlight";
