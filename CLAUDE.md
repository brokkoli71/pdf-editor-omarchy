# CLAUDE.md — working on Sidemark

> **Maintain this file.** It is every future session's first impression of the
> project — when your work makes it stale (new module, changed architecture,
> new convention or workflow, a gotcha worth recording), update it in the same
> change. Edit in place and keep it lean: replace outdated facts rather than
> appending, and don't let it grow into a changelog — detailed *why* belongs
> in `ideas.csv`, session state in `notes/` handoffs.

## What this is

Sidemark is a **single-file GTK4/libadwaita Python app** (`sidemark.py`, ~16.7k
lines): a PDF annotator with a live Markdown notes panel, built for lecture
notes and presenting. One window, two document modes (PDF + text — see below).
There is no other source module on this branch. Dependencies:
PyGObject/GTK4/Adw/GtkSource, PyMuPDF (`fitz`), cairo, numpy. Files stay plain:
`.pdf` + `.md` sidecar notes, `<name>-ink.json` ink sidecars. The `.md` file
names its PDF with an `![[name.pdf]]` embed line at the top.

## Architecture in one minute

- `PDFCanvas` — the PDF page canvas (ink, lasso, anchors, zoom/pan).
- `MarkdownNotesView` — the live-Markdown editor (math substitution `\alpha`→α,
  `x^2` scripts; source text stays intact — display-only rendering). `code`
  spans and `[[wiki links]]` render verbatim (no LaTeX/scripts/bold inside).
- `TextPageView` — text-first mode: an A4-styled Markdown sheet (a
  `MarkdownNotesView` as white paper) you can draw on. Ink lives in a
  `<name>-ink.json` sidecar.
- `DocumentSession` — one open document (one tab). The window
  (`PDFEditorWindow`) owns an `Adw.TabView` of sessions and **proxies the
  active session's attributes onto itself** via `_session_prop` — window code
  reads `self.canvas`, `self._notes_view` etc. and transparently follows the
  active tab. When adding per-document state, add it to `DocumentSession.STATE`
  / `WIDGETS` (kept in sync with the `_session_prop` proxy list).
- **Button bindings — there is no "active tool" (row 132).** Every mouse
  button, alone or under modifiers, HAS a tool, and pressing it uses that tool:
  left draws, right erases, middle pans, at the same time. `Bindings` is THE
  table (`DEFAULT_BINDINGS`; persisted in settings.json under
  `button_bindings`), ONE instance per window shared by every canvas and sheet.
  Defaults (the user's table, 2026-07-31): left pen, middle lasso, right
  eraser, plus four chords — Ctrl+left pan, Ctrl+right text cursor, Shift+left
  zoom-to-region, **Alt+left text cursor** (Alt is how you follow a PDF link,
  and following a link IS the caret's click). The **thumb is unbound** (most
  mice have none). Nothing else is bound out of the box; the rest is the
  user's to bind. `chord_tool()` survives as a thin resolver for callers that
  only want the left button's grammar.
  - **The toolbar is the binding surface**: click a tool with the button you
    want it on. Plain left-click is the exception — it stays "put this on the
    left button", so picking a tool feels unchanged. **Claiming the press does
    not swallow the click**: `GtkButton`'s own gesture is CAPTURE-phase too and
    was added first, so `clicked` fires anyway — `_binding_press` is the flag
    that makes the two paths exclusive, not the claim.
  - **The stripes are a LIVE readout, and they are the ONLY signal.** Holding
    a modifier repaints them from the chord table (`_live_buttons_for`), so the
    bar always shows what each button would do right now; an unbound chord
    shows nothing, because that is what pressing it would do. There is no
    second highlight — a glow that lit one tool without naming a button said
    something different from the stripe beside it about the same table.
  - **Routing, badges and tooltips all read the table** (`_refresh_tool_bindings`
    generates both). A second mapping is how the bar comes to claim one thing
    while the mouse does another. Each canvas has ONE press router
    (`PDFCanvas._on_drag_begin` → `_begin_tool`, `TextPageView._on_press_begin`);
    the sheet's router either claims the press for its tool or DENIES so the
    caret keeps it.
  - **`canvas.tool` is derived**: the tool of the button being pressed, else
    what LEFT would do. Assigning to it binds left. `highlighter` /
    `select_mode` are derived the same way — **never assign them alongside a
    tool change**, or `select_mode = False` hands the caret's button back to
    the pen.
  - **Two exceptions, both AT the router, neither a fork of the table**: with
    the lasso on the plain button Shift ADDS to the selection (Shift+lasso is
    still the lasso), and a live selection is grabbable with any tool (row 125)
    — which on the sheet must be claimed on the capture gesture or a pasted
    image is unmovable.
  - **The thumb is a real button**: button 10 never reaches a `GestureDrag`, so
    its press is replayed through the same router with a `_SyntheticDrag`.
    That is what lets it hold any tool instead of a hardwired pan.
  - **Links glow exactly when a click would follow one**: `link_hover_active()`
    is "the left button's tool right now is `text`", never "Alt is down". One
    predicate for the glow and for `_open_link_at`, or the modifier promises
    what the table cannot deliver.
  - **Keyboard tool shortcuts are hold-to-borrow**: Ctrl+H lends left the
    highlighter while held (`_borrow_tool` / `_on_borrow_release`), Ctrl+M the
    caret. Releasing either key gives the button back.
  - `TOOL_MODES` drives the bar order, the `_MODE_CHROME` tool rows and the
    resolver, so a tool cannot be in the bar and missing from the grammar.
    `"select"` is an alias of `"text"` — one I-beam button serves both modes.
  - Chord routing merges window-tracked held modifiers (`_chord_state`) so
    keyboard+touch works; see ideas.csv rows 115 and 132.
- **Modes**: a tab is either a PDF or a text-first page, tracked by
  `doc_mode` (`"pdf"` | `"text"`) on the session
  (`_enter_text_mode`/`_leave_text_mode`; `_text_mode` survives as a
  compatibility boolean property). Which header chrome each mode shows is
  declared in the `_MODE_CHROME` table (widget name → modes tuple; `_mode_*`
  tool buttons drive their `_pmode_*` popover twins automatically) — when
  mode behavior changes, extend the table instead of adding per-mode `if`s.
  The table takes further modes without reshaping (row 107).
- **Pasted images** — an image is an OBJECT, modelled and behaving like ink:
  bytes + rect + `rotate` (+ a crop rect one day, row 119), anchored the same
  way its surface anchors ink, editable forever, never a flattened stamp. The
  clipboard is one shared layer (`SIDEMARK_MIME`, `clipboard_content_for`,
  `paste_objects`, `pasted_extent`). Both modes ship (row 118) — **read "Image
  UX is one contract" below before touching either, and "The PDF image layer"
  before touching that.** On a PDF the
  `<name>-ink.json` sidecar is the truth and the PDF's optional-content layer
  is a render target regenerated on save; `attach_images()` is THE entry point
  after `canvas.load()` (it loads or adopts, then takes the layer back OUT of
  the open document — leave it in and every image renders twice).
- **Merge import (row 123)** — dropping several documents at once makes ONE
  document with a chapter per file. `merge_documents()` is the single pipeline
  behind both entry points (thumbnails → insert chapters at the gap; window →
  "Open All / Merge…" into a new file). Notes and image sidecars are re-keyed by
  each chapter's page offset; ink needs no code (strokes are native PDF
  annotations). **Before touching it, read row 123's traps** — the load-bearing
  one is that a source's image layer MUST be stripped before `insert_pdf`, or
  every pasted image renders twice forever (`take_source_images`). Chapters
  reorder by dragging an outline row: `chapter_spans` → `move_page_range` (one
  `select()`, one re-key) → `resort_toc` (`select()` re-pages the outline but
  does not re-order it). A drop lands the same way wherever it falls: the
  sidebar (outline rows, thumbnails, the empty space below either) imports at
  that gap, everywhere else — including a text-first page — opens or merges
  into a new file.
- **`[[wiki links]]` (the linking workflow)** — this is the feature the project
  was designed around and it has shipped (ideas.csv row 99). In notes,
  `[[target]]` is a clickable link (Ctrl+click follows, hover shows a hand).
  `_parse_note_link()` resolves the body into `{path, page, label}`:
  `[[#page=N]]` jumps within the current document; `[[file]]` /
  `[[file#page=N]]` opens another document via `open_file_in_tab`. Rendering
  keeps the brackets hidden off the cursor line but leaves link/`code` contents
  verbatim — the parsing lives in `_notes_to_pango_markup` / `_split_markup`
  (`_MD_LINK_RE`, negative lookbehind so the `![[embed]]` line is left alone).
  When extending linking, keep link targets un-mangled and test both same-doc
  and cross-doc forms.
- **Linked page notes (row 129)** — a page can CONTINUE the one before it, and
  a run of linked pages shares ONE body stored once on the run's first page
  (`NotesModel._links`, `run_start`/`run_pages`/`run_end`; the sidecar marker
  is `<!-- page:13 continued -->` with an empty body, the one case where an
  empty page is still written out). **The trap is which text you ask for**:
  `get(idx)` RESOLVES through the run — for the human looking at that page —
  while `own_text(idx)` is what the page stores and is `""` on a continued
  page. Everything that walks all pages (export, share render, page marks,
  search) must read `own_text`, or a run prints on every slide instead of
  once. `set(idx)` writes to the run start, so undo, the merge import and the
  drag-export need no special casing. Re-keying degrades to UNLINKED rather
  than re-linking two unrelated slides; the load-bearing one is
  `shift_for_delete`, where deleting a run's START hands the body to the next
  page in the run instead of dropping the whole run's text. PDF-only, and the
  UI is one checkbox in the notes header (`_update_notes_link_ui`). **The tick
  CASCADES**: `link_forward` carries the run through every following page that
  has nothing of its own, stopping at the first page that already has notes
  (`link()` would append it into the run — the one outcome you cannot see
  coming from a checkbox); `unlink_forward` breaks the run at that page and
  every page after it. One tick covers a run of slides, one untick undoes it.
- Single-instance app (`Gio.Application`, `HANDLES_COMMAND_LINE`): a second
  launch forwards its argv to the primary, which opens the file as a tab in the
  last-used window (`_open_target`/`open_file_in_tab`). For manual testing
  always launch standalone: `SIDEMARK_STANDALONE=1 /usr/bin/python3
  sidemark.py [FILE]` (the env var sets `NON_UNIQUE` so it bypasses the running
  instance — Ctrl+R reload uses the same trick to re-read the code).
- **A COPY of the app is a different app.** `_copy_key()` is the one answer to
  "is this the installed script or a checkout?" — `""` for an installed path,
  else a hash of the source path (`SIDEMARK_INSTANCE=<name>` forces one). It
  suffixes both the GApplication id AND `settings.json`, so smoke-testing a
  checkout can neither join the running instance nor rewrite the button table,
  pen width or font size of the app you actually work in. Recent files
  (`recent.json`) stay shared on purpose — a copy is a different app, not a
  different person. Answer that question in one place or the two drift.

## Testing & verification

- `./run_tests.sh` runs the whole suite (`test_pdfeditor.py`) inside a
  **headless Weston compositor** (GTK4 has no offscreen backend — never use
  `GDK_BACKEND=offscreen`; needs `weston` installed). Pytest args pass through
  (`./run_tests.sh -x -q test_pdfeditor.py::SomeTest`); `./run_tests.sh --stop`
  tears the compositor down.
- **Iterate with `./run_tests.sh --fast`** (~3 s): it skips the `window`-marked
  tier (classes that build real windows; auto-marked by `conftest.py` from the
  class source — a misclassified test still *passes*, it just lands in the
  wrong speed tier).
- **Run the NARROWEST thing that could tell you something.** `-k <the classes
  you touched>` after each behavioural edit, `--fast` at milestones, the full
  suite once before committing, and nothing at all after a mechanical rename.
  A full run is ~3–5 min: during a refactor it is the difference between a
  tight loop and a crawl, and it almost never finds what a targeted run
  didn't. Note `-k` matching a window-tier class is as slow as a full run, so
  keep the selector tight.
  Two traps that waste more time than the tests do: a run over 120 s is
  backgrounded, so start it, do other work, and read the output file **once**
  — polling it with short sleeps buys nothing; and never re-run a suite on an
  unchanged tree because the output was hard to read (fix the grep instead).
- **Settings are isolated per run and per test.** `run_tests.sh` points
  `XDG_CONFIG_HOME` at a throwaway dir and a conftest fixture deletes
  `settings.json` after every test. `Bindings.save()` persists on every rebind,
  so without both the suite rewrote the *user's* button table and every later
  window test routed presses through whatever the last run left behind — a test
  that passes alone, fails in a suite, and blames the wrong feature.
- Tests set `SIDEMARK_TEST=1` and use the system `/usr/bin/python3` (not venv
  shims). Window tests build a real `PDFEditorWindow` inside a throwaway
  `Adw.Application` and pump the main loop (`_settle()` pattern — copy it).
- **Layout needs a live frame clock, and a full run does not have one.**
  Allocation happens in the frame clock's layout phase, which is driven by the
  compositor's frame callbacks — and by late in a full suite Weston has taken
  the surface away (`VK_ERROR_SURFACE_LOST_KHR` in the captured stderr). After
  that NOTHING re-allocates: `_settle()` pumps idles all it likes, a widget
  keeps whatever size it last had, and even an explicit `set_size_request` is
  never honoured. So a `GtkTextView` never grows to its content height, and
  anything downstream of that (an adjustment's `upper`, a scroll position, a
  `translate_coordinates` result) is stale. **Test the property or the model,
  not the pixels** — and where a gesture-level assertion really is the point,
  make it `skipTest` on the unmet precondition instead of failing for the
  environment (`test_focusing_the_sheet_does_not_scroll_it` is the pattern:
  property always, scroll only when the sheet actually laid out). The tell is
  a test that passes alone, fails only in a full run, and dies at a geometry
  precondition rather than at what it means to assert.
- **Whether it LOOKS right is the user's call, not yours.** Don't screenshot
  the app to judge a layout, spacing or a new widget — build it, then hand over
  a short numbered checklist and let them look. Agent screenshots are for
  answering a *factual* question that has a yes/no answer ("does the strip
  appear at all?", "is the ghost line gone?"), never for taste. Set up the
  state the user needs to see (seed a file/sidecar so the thing is on screen
  the moment the app opens) instead of asking them to reproduce it.
  When you do launch: standalone env var above, focus via
  `hyprctl dispatch focuswindow address:...`, screenshot with `grim`
  (Hyprland). Don't leave repeated windows popping up on the user's screen, and
  don't close them with `hyprctl dispatch closewindow` — it can raise an
  unsaved-changes dialog you then cannot dismiss. Kill only the process you
  started yourself; other Sidemark instances on screen may be theirs.
- **There is no key-injection tool on this machine** (no `wtype`/`ydotool`), so
  an agent cannot drive gestures, Ctrl+Z or Ctrl+V. Script what you can against
  the model, and hand the user a short numbered checklist for the rest.
  Anything gesture- or undo-shaped is **not verified** until they run it.

## Feature acceptance checklist (every feature)

1. Tests in `test_pdfeditor.py`.
2. A row in `ideas.csv` (the project's decision log — write detailed Notes,
   they are the long-term memory of *why*; see rows 96–99 for the style).
3. README, **only if a user must know about it** — and then at most 1–3 lines
   at the altitude of "what it does for you", folded into an *existing* bullet
   or table row where one fits. The README is the sales pitch and quick
   reference for humans, not the feature log: sub-behaviors, edge cases,
   internal names, and anything a user would discover on their own belong in
   the `ideas.csv` Notes (and code comments), not here. Bug fixes, refactors,
   and dev-workflow changes get **no README text at all**. When in doubt, ask:
   would a new user's decision or daily use change without this sentence? If
   not, leave the README alone.
4. Packaging if files/deps changed: `install.sh`, `PKGBUILD`, and
   `aur/sidemark/PKGBUILD`; bash completion in `extras/sidemark.bash`;
   `.desktop` keywords.

## Conventions & gotchas

- **Commits**: Conventional Commits WITH scope (`feat(notes):`, `fix(nav):`);
  changelog via git-cliff. End commit messages with the Claude co-author
  trailer. Pragmatic granularity: when WIP is co-mingled, one commit is fine.
- **Wayland file DnD** needs `Gtk.DropTargetAsync` + a drag-motion handler
  returning an action, or the drop never fires (portal transfer).
- **GTK4 popovers**: never popdown one popover and popup a sibling on the same
  widget synchronously — defer to the "closed" signal.
- **cairo's `save()`/`restore()` does not save the PATH.** A painter that ends
  with `show_text()` leaves a current point behind, and the next `arc()` joins
  onto it with a straight line — which is how a ghost line appeared from the
  snap label to the snap ring. End a shared painter with `new_path()`, and
  start an arc with `new_sub_path()`.
- **Both modes, always.** Every feature is designed for PDF *and* text-first
  pages unless there is a stated reason it cannot be — the two are one app to
  the user, and a feature missing on one side reads as a bug, not a scope call.
  This generalises the image contract and the chord grammar below; it is not
  their private rule. Walk a new feature through both before calling it done,
  and if one side genuinely can't have it, say so loudly in `ideas.csv`. There
  is exactly ONE stated exception today: linked page notes (row 129), because a
  text-first page has no page-to-page structure to continue.
- **Event reachability — a correct handler can still never run.** When a
  gesture "does nothing", test the PATH, not the handler (all of these tested
  fine in isolation while being unreachable in the app):
  - **A `GtkTextView` installs its own `GtkDropTarget` for `gchararray`**, and
    a file manager offers `text/plain` beside the uris — so the editor matched
    first and every file dropped on the notes panel or the text sheet
    disappeared, while the window's own target sat there working. Two targets
    on one widget are tried in the order they were ADDED, so the built-in has
    to be *replaced*, not supplemented (`attach_file_drop`).
  - `GtkScrolledWindow` installs its OWN capture-phase scroll controller and
    STOPS scroll it can use, so a Ctrl+scroll zoom must be captured on an
    ancestor **above** it (`MarkdownNotesView.attach_zoom_scroll`,
    `TextPageView._on_sheet_scroll`). The ScrolledWindow itself is too late —
    same widget + same phase run in add order and GTK's is first.
  - A drawing tool makes the ink overlay the event **target**
    (`ink.set_can_target`), which cuts the ScrolledWindow out of the path
    entirely — so `TextPageView` owns plain scrolling too, not just zoom.
  - Window shortcuts that must beat a focused editor live in capture-phase
    controllers (`_on_global_key`, `_on_undo_key`, the sheet's own). `_on_key`
    is **bubble** and loses to whatever has focus — put a new app-level
    shortcut in capture unless the editor should win (Ctrl+C, Delete, arrows).
  - **A widget in the wrong CONTAINER is unreachable the same way.** Ctrl+F
    "did nothing" on a text page because the search revealer lived inside the
    PDF column (`_paned`), which text mode HIDES — the handler ran and revealed
    something nobody could see. It lives above both modes now (`s._body`).
    Whenever a feature is dead in exactly one mode, check where its widget
    hangs before reading its handler.
  - **Capture on a CHILD only fires while focus is inside that child.**
    Ctrl+C/Ctrl+V on `TextPageView` looked right and died the moment you
    picked a tool from the toolbar — that focuses the *button*, so the sheet
    was off the key path. Clues: a sibling shortcut in the SAME handler still
    worked (Ctrl+D), i.e. the handler was fine, focus was not. App-level keys
    belong on the WINDOW's capture controller, which fires whatever has focus;
    let it ask the surface (`wants_paste()`, `has_lasso_selection()`) instead
    of the surface owning the key.
- **A viewport SCROLLS TO ITS FOCUS WIDGET, and the sheet's is the whole
  paper.** `TextPageView`'s Box wrapper makes the text view a non-scrollable
  child, so `GtkScrolledWindow` wraps it in a `GtkViewport` — whose
  `scroll-to-focus` defaults to TRUE. The only focusable child is the
  full-height view, never fully visible, so revealing it means jumping to the
  top of the paper. It fires on a focus CHANGE, which is why it hid behind the
  tool switch (picking a tool focuses the button; GTK's press handler then
  calls `grab_focus()` on the view) and why the tool code looked innocent. The
  sheet moved mid-press and GTK resolved the pointer against the moved view,
  landing the caret pages from the click. Turned off in `__init__` — if you
  ever re-wrap the sheet, turn it off again.
- **A GtkTextMark displaced by an EDIT moves without a `mark-set` signal.**
  Rewriting a line under the caret (`_buf_replace_line`, how the live-Markdown
  renderer un-renders `α`→`\alpha`) deletes and re-inserts it, and `insert` +
  `selection_bound` sit inside that range: the delete collapses them onto the
  line start and the re-insert drags them to the line END on their right
  gravity. Any such rewrite must carry both marks across by hand — save
  COLUMNS (ints) before, re-derive iters after, since the edit invalidates
  every iter. Row 128 is what this costs when you don't: the caret jumped, and
  because a pen press always jitters, GTK's follow-up drag-update moved
  `insert` alone (`move_mark_to_pointer_and_scroll`) and a plain click became a
  selection running to the end of the text. Two lessons for debugging it: a
  mark that moves with no `mark-set` is riding an edit, and instrumenting the
  real app was the only thing that showed it — every static reading of the
  handlers tested clean.
- **`save()` rebinds `self.document` — anything holding the OLD one is stale.**
  `save()` reopens the file, so every cached PyMuPDF object from before it
  belongs to an orphaned document. `self.page` is the one that bites: the page
  render (`_rerender_now`) renders `self.page`, so a stale one kept painting
  the layer `_write_image_layer` had just baked in — an image rendered twice,
  invisible until you moved it (the object sits on its own ghost) and cleared
  by a reload (`_load_page` rebinds). **The file on disk was correct the whole
  time**, so neither the tests nor another viewer could see it. If you cache a
  `Page`/xref across a save, rebind it there, and test the RENDER path
  (`canvas.page.read_contents()`), not just the file.
- **A text page has no `_path`.** A `.md` opened without a PDF lives in
  `_notes_path`; `_path` is the PDF. Code reading `_path` alone silently
  no-ops in text mode (this is what broke Ctrl+R) — use
  `self._path or self._notes_path`. If a feature really is PDF-only, say so
  loudly (`_on_export`, `_ocr_current`) rather than returning in silence.
- **One table, not two**: `chord_tool` (chords), `zoom_factor_for_scroll`
  (scroll→zoom rate), `erase_radius` (what counts as touching ink),
  `clipboard_content_for`/`paste_objects` (the clipboard), `draw_image` (how a
  pasted image looks), `recognize_shape`/`rect_bbox_of`/`even_divider_positions`
  /`draw_snap_label` (the extended-dwell shape snap, row 121) are shared by both
  canvases on purpose. Duplicating a *decision* is how the PDF and text sides
  drift; duplicating *mechanics* is fine — they have genuinely different
  substrates (a scale-transform canvas vs a reflowing ScrolledWindow).
  **Before fixing a bug here, grep every caller of the function you are about
  to touch.** A report names one symptom on one path; the fix belongs where all
  callers route through. One guard in the shared helper is a *smaller* diff than
  a guard per caller, and patching only the path the report named leaves every
  sibling caller broken — which is exactly how the eraser drifted (row 116).
- **The extended dwell (`_snap_to_shape`, rows 121 + 127).** Holding still
  mid-stroke no longer only makes a line: `recognize_shape()` cleans a closed
  loop into an axis-aligned **rectangle**, an **ellipse** (a near-circle snaps
  to a true circle), or an irregular **polygon**, and a straight line drawn
  inside a rectangle becomes an evenly-spaced **grid divider** (re-spacing its
  siblings, one undo entry — PDF's `("grid", …)` op / the sheet's grouped
  `("reshape", …)`). Recognised shapes are ordinary **strokes** (polylines), no
  new object kind — they lasso/erase/round-trip for free. The **line is always
  the fallback**, so the `shape_snap` setting's "lines"/"off" can't regress the
  classic snap. Rectangles are detected geometrically (`rect_bbox_of`), so grid
  snapping survives a reload with no stored tag — **which is why rect must beat
  polygon on ANGLE, not on fit**: a tilted quad through a box's real corners
  fits better than its bbox, so on residual alone the polygon takes the grid
  snap away (`quad_is_axis_aligned`). Every kind needs an entry in the shared
  `SNAP_LABELS`; a missing one is a KeyError mid-gesture.
- **Geometry you STORE must not go through the int-truncating coord helpers.**
  `window_to_buffer_coords`/`buffer_to_window_coords` only take ints, so a
  per-point conversion rounds every point on the way in *and* out. Invisible
  for a move (all points shift alike); it made a *rotated* stroke go lumpy, and
  compounded on every re-anchor. `TextPageView._overlay_to_buffer_f` /
  `_buffer_to_overlay` take the origin once and add the float delta — use them
  anywhere the result is persisted. Plain `_overlay_to_buffer` (int) is for
  hit-testing only. Symptom to recognise: shapes degrade a little per edit.
- The codebase favors long, explanatory comments about *why* (and records
  hard-won platform quirks inline) — match that style. The test is whether the
  comment still earns its space once the change is old: an invariant, a
  constraint the platform imposes, or a trap does; the *story of the edit* does
  not. Write "this must come from `_selection_bbox()` or the frame drifts from
  what a grab hits", not "this used to be recomputed from the strokes". Present
  tense about how it behaves, not past tense about how it got here — the
  sequence is `ideas.csv`'s and git's job.
- **Mark a deliberate corner-cut with its ceiling and its exit**, as
  `# ceiling: <the limit>, <what to do if it ever matters>`. This is for a
  simplification that is *known* to be limited, not a bug: e.g.
  `# ceiling: stretches along page axes, not the image's — the rect cannot
  skew`. It keeps a knowing choice from reading as an oversight to the next
  session, and stops the same debate being re-run. Current unmarked ones worth
  labelling when you next touch them: the non-uniform stretch of a rotated
  image, Ctrl+Z removing a just-snapped shape instead of un-snapping it (row
  121), and crop-at-render (row 119) once it lands.
- **Image UX is one contract, not two implementations.** Text pages defined it
  and the PDF side matches it (row 118); anything new (crop, row 119) lands
  ONCE, for both. Reuse the shared pieces (`clipboard_content_for` /
  `paste_objects` / `SIDEMARK_MIME` / `pasted_extent`, `draw_image`,
  `_texture_from_png` / `_png_from_texture`) and keep the *decisions* below.
  The row 116 audit's lesson applies exactly: every behavior that reused a
  shared helper held parity; the one place that reimplemented (the eraser) was
  the one with a live bug. If one mode genuinely cannot do one of these, say so
  loudly in `ideas.csv` — do not let it drift silently.
  **To audit parity, reuse row 116's method**: walk `chord_tool` × {pdf, text},
  compare sign / magnitude / **anchor** / clamping on each, and for every
  behavior ask "does a test drive BOTH sides?". It is what found the eraser.
  - **Ctrl+V pastes at the POINTER** when it is over the surface, else the
    centre of the view — never at the caret. Pasting must work with any tool;
    with a pen or lasso in hand there is no useful caret (`paste_point()`).
  - **Paste size is `paste_scale()`** — the smallest of four caps: a third of
    the page per axis, half the VISIBLE window per axis, and the image's own
    pixels on screen (`native / zoom`). The window cap is the one that matters
    when zoomed in, where a third of the page can be several screens wide; the
    page caps are what stop a screenshot landing as a page-filling slab.
  - **A selection is editable with ANY tool** (`selection_grab_at()`), and a
    paste comes back selected — so a fresh paste drags immediately, with the
    pen or the caret still in hand. On the sheet this MUST be claimed on the
    capture-phase gesture above the overlay: with the caret the ink overlay is
    not targetable, so `_on_ink_begin` never runs (the reachability trap).
  - **A lasso click selects what is under it** (`_object_at`, ink before
    images — ink paints on top); **Shift adds** to the selection, by clicking
    or circling (`_merge_selection`, which merges by IDENTITY: strokes and
    images are plain dicts, so `==`/`in` compare by VALUE and would silently
    collapse a duplicate).
  - **Sizes are DOCUMENT units** — store at the base scale, never the zoom you
    happened to paste at (the pen-width lesson, row 116).
  - **Ink draws ON TOP of images; text is not covered by them.** On a text page
    that means images live on the view's `BELOW_TEXT` layer, not the ink
    overlay. Get this wrong and it also breaks the PDF export, which
    rasterises the view (one cause, two symptoms). On a PDF page it means
    `_draw_images` runs between the page blit and the strokes.
  - **Ctrl+C on a lasso selection wins over text copy** (text selection keeps
    it otherwise) and publishes BOTH: our objects (private mime) and a
    `COPY_RENDER_SCALE`× supersampled PNG. In-app paste is lossless — ink
    comes back as editable INK, an image as an image — every other app gets a
    picture. This is a hard user requirement, not a nicety.
  - **A selection wears the LOOP it was drawn with** (row 125), not a box: it
    is stored in document coords (`_selection_loop`), it is the GRAB region
    (`_point_in_selection` → point-in-polygon), and a chip diagonally outside
    the box's top-left corner switches to the 8-handle resize box and back
    (`lasso_chip_centre`/`lasso_chip_hit`/`draw_lasso_chip`, one policy for
    both canvases). **Handles and the rotate knob hit-test to nothing in loop
    mode** — a hit-test that outlives its painter is exactly how a frame drifts
    from what a grab catches. A click / paste / duplicate / additive selection
    has no loop and so shows the box; `_set_selected` clears the loop and
    `_finish_lasso` puts it back, never the other way round. Transforms carry
    the loop along (PDF: the drag snapshot; sheet: `_reanchor_selected`), and a
    stale loop after an undone move is impossible only because undo already
    calls `clear_lasso_selection()` — don't remove that. On the sheet the loop
    is anchored **like a stroke** (mark + buffer offsets + `font_px`) so it
    reflows; overlay coords would drift on the first edit.
  - **Circle to lasso** (row 126): draw a loop with the pen, lift, then
    press-and-hold on it — or anywhere inside it — and it becomes the lasso
    path. It does NOT collide with the dwell shape-snap, and the reason is the
    thing to keep: the two are separated by the **pen lift**, not by the shape
    (hold *without* lifting = snap; hold on a *finished* stroke = lasso), so a
    stroke available to convert was by construction never snapped. Only the
    **last** stroke converts — anything else means a resting hand eats ink into
    a selection — and `circle_lasso_target` is that decision for both canvases.
    Not gated on `shape_snap` (that setting governs the dwell). The **tool does
    not change**: the pen stays in your hand, which is the entire point.
  - **Control points** (row 127): EVERY selected corner polyline — line, path,
    polygon, rectangle — grows round vertex handles in BOX mode; dragging one
    moves both edges meeting there. `shape_vertices` re-derives them from the
    geometry each time (nothing stored, the `rect_bbox_of` pattern), excludes
    sampled curves (an ellipse is 24+ points) and drops a closed ring's
    repeated last point — moving vertex 0 must move both ends. Capped at
    `MAX_VISIBLE_VERTICES`, same hedgehog argument. A control point sits inside
    the box on top of a resize handle and **wins** there; both press routers
    test it first, and `selection_grab_at` includes it. One `("reshape", …)`
    undo entry per drag.
  - **Welding** (row 127): a dragged control point snaps onto the nearest other
    one within `vertex_snap_radius` (a fraction of the VIEWPORT — a reach on
    screen must not shrink as you zoom in), visually first, so pulling away
    before release lets go. Release leaves them sharing a coordinate, and
    `welded_vertices()` re-derives the join at every grab so they drag as one.
    **Nothing is stored** — that is what makes a weld survive a reload, a
    sidecar round-trip and undo. `snap_point` falls back to the nearest point
    on an EDGE when no vertex is in reach (a vertex must win, or you land
    beside the corner you aimed at); that snap is **positional only** — the
    point lands there and does not follow the edge afterwards, which is what
    keeps row 131's false-positive problem out, since nothing is persisted.
    After the dwell fires the pen keeps hold of the last control point of a
    `line`/`path`/`polygon` (index 0 for a closed ring), and every corner
    polyline on the PAGE becomes a live magnet for it (`_live_snap_shapes`,
    frozen at dwell time, only those within reach painted) — so a fresh shape
    joins what is already drawn without lifting. The live shape's OWN points
    and edges are targets too (the held point and its two edges excluded, or it
    pins itself). **Freehand ink** snaps as well, via `snap_point`'s `curves`
    list: its two endpoints as vertices, its polyline as edges, its interior
    samples deliberately not vertices. Snap candidate sets are **frozen per
    gesture** and bbox-filtered (`curve_snap_shapes`) — rebuilding them per
    motion event on a page of handwriting is tens of thousands of segments.
  - **Lasso verbs**: select / move / resize / rotate / `Ctrl+D` duplicate /
    `Del`. Rotation is a knob on a stalk above the box; Shift snaps to
    `ROTATE_SNAP_DEG`. A tilt is stored as an ANGLE and applied at render — it
    is never baked into the pixels, so repeat rotations never degrade.
  - **Resize is 8 handles (row 122)**: 4 corners scale uniformly, 4 side
    midpoints stretch ONE axis (aspect changes). One shared policy —
    `lasso_handle_points`/`lasso_handle_anchor`/`lasso_scale_factors`
    /`lasso_handle_cursor` — drives both canvases and both the hit-test and the
    painter. Scale is per-axis `(fx, fy)` about an anchor (opposite edge for a
    side, opposite corner for a corner); the `("lasso_scale", …, fx, fy, ax,
    ay)` op and stroke width (`sqrt(fx*fy)`) follow. A non-uniform stretch of a
    *rotated image* stretches along page axes, not the image's (the rect can't
    skew — same limit as rotation).
  - **One undo entry per gesture**, even when it moved ink and images together
    (the `("group", [ops])` op).
  - **The eraser ignores images** (lasso + `Del` removes them); **recolour
    skips images** — there is no pen colour on a photograph.
  - Gate on `has_lasso_selection()`, never on `self._selected` — that list is
    STROKES, and reading it as "the selection" is what made an images-only
    selection unpickable, unmovable and undeletable. Same for `_selection_bbox()`:
    one box, used by the frame AND the hit-tests, or they drift apart.
- **The PDF image layer corrupts documents silently if you get it wrong (row
  118).** Every trap below is guarded by a test that was checked to fail when
  the trap is reintroduced — read this before touching the layer at all.
  - `/OC` marks ownership — the only marker that survives a round-trip, and
    what tells our images from the document's own.
  - `uniquify_png()` before an insert, or PyMuPDF DEDUPLICATES byte-identical
    images onto one xref and ownership dies on the first reopen. The real
    workflow that hits it: copy a figure out of the PDF, paste it back.
  - Strip-and-regenerate, never `delete_image()` (it only blanks the xref and
    LEAKS a ghost placement per save) and not `clean_contents()`.
  - Re-place unchanged images with `insert_image(xref=...)` — no re-encode,
    ~0.45 s/save at 100 heavy images.
  - Do NOT trust `get_image_info(xrefs=True)` or `get_image_rects()`: they
    resolve placements by visual match and lie about xrefs. The content stream
    plus the Resources dict are ground truth.
- Logging: `logger` writes a per-session file under `~/.cache/sidemark/logs/`,
  auto-deleted on clean exit, kept on errors.

## The deck branch (parked — not a concern)

An experimental Sidemark **Deck** presentation editor lives on the `deck`
branch (checked out at `../pdfeditor/`, with its own CLAUDE.md as the reference
*if* it is ever picked up again). It adds `deck.py`, a `deck` document mode,
PPTX→deck import and themes.

**Treat it as dormant.** Do not let it shape decisions on master: don't weigh
merge cost when designing or refactoring, and don't audit master's changes
against it. It may be revived some day, may become a separate extension, or may
never land at all — that call is deferred indefinitely. The one rule that
stays, because it is free: **do NOT merge/push Deck into `master` without
asking.**

## Current work & loose ends (2026-07-31)

Everything shipped is described as behavior in the sections above; this section
is only *what is in flight* and *what is free to pick up*. Keep it that way —
when something lands, fold its invariants upward and delete it from here rather
than writing a line about having finished it. The chronology lives in
`ideas.csv` and git.

**In flight — all three are code-verified and need a pass in the real app:**

- **Rows 125–127 (the lasso keeps its loop; circle to lasso; shape
  recognition and control points).** Unit-tested on both canvases
  (`TestLassoSelect`'s row-125/126/127 blocks, `TestShapeRecognition`,
  `TestTextPageLasso`). The 500 ms hold is confirmed by hand; everything else
  is a gesture and so unverified — whether the chip and the control points are
  big enough to hit with a pen first time, and whether an auto-selected shape
  ever gets in the way.

- **Row 123 (merge import).** What needs real hardware: the drops themselves
  (several PDFs on the window → "Merge…"; several on the page thumbnails →
  chapters at the gap), the `.pptx` path through LibreOffice, and the chapter
  drag in the outline. Unit-tested end to end (`TestMergeImport`,
  `TestChapterReorder`, `TestMergeImportInWindow`), including the two corrupting
  traps. *Deliberately not done:* no drag-reorder inside the import dialog —
  chapters reorder in the outline afterwards, and the dialog says so.
- **Row 121 (shape & grid recognition).** The classifier, grid spacing and the
  PDF grid-divider commit/undo/redo are unit-tested (`TestShapeRecognition`,
  `TestGridDivider`); the dwell gestures need the app. Hand the user a
  checklist.

**Loose ends, roughly in order of how ready they are:**

- **Row 130 (gestures between the modes)** — drag the notes panel to full
  width → text-first; drag in from the left edge → a blank PDF beside the text.
  Settle first whether it is a view state or a real file conversion (ink lives
  in different substrates), and make an accidental drag leave no trace.
- **Row 119 (crop)** — the last piece of the image feature. Its design is
  settled in row 118 and must not be re-litigated: a field on the model applied
  at render, never a destructive re-encode, landing ONCE for both modes.
- **Row 121's un-snap** — Ctrl+Z on a just-snapped shape *removes* it rather
  than reverting to the raw freehand. The `shape_snap` setting and the 500 ms
  dwell are the escapes for now.
- **Row 100** — link authoring: link-to-here and backlinks.
- **Rows 92–94** — text-page items: text-snapping highlighter, pagination/print
  view, margin inks that don't reflow.
- **Row 111** — duplicate-download dialog.
- **Row 117** — the suite is flaky under full-run load: one test fails per full
  run while passing in isolation and on a clean tree. Wants its own session.
  TWO causes are now known, and both read exactly like a race, so check them
  first: a stalled frame clock (see "layout needs a live frame clock" above)
  and shared settings state (a test that rebound a chord leaked its table into
  every window built after it — fixed by the isolation note under Testing, so
  re-measure the flakiness before digging).
- **Rows 26/27/64** — older, unranked.

**Won't do:** presenter/share for text mode (row 106 item 7); a vertex truly
BOUND to a point on another edge (row 131) — the positional edge snap gives the
useful half without needing stored constraints and stable per-stroke ids. Both
the user's call.
