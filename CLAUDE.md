# CLAUDE.md — working on Sidemark

> **Read this file completely before doing anything.** It is short on purpose:
> everything in it is something you can break by accident, and a rule you
> skimmed past is a rule you will break. Detail lives in `docs/` — follow the
> link for the area you are touching, and only that one.
>
> **This file has a budget: 400 lines.** CI fails if it grows past it. That is
> deliberate — it was 2254 lines once and sessions stopped reading it, which is
> how the rules below came to be missed. If your addition does not fit, it
> belongs in `docs/<area>.md`, in a code comment at the thing it describes, or
> in `ideas.csv`. **Never** add a changelog entry here.

## The rules

Break any of these and the damage is silent or expensive. They are first
because position matters.

1. **Never run the tests against the live desktop session.** Always
   `./run_tests.sh`, which starts an isolated Weston. A bare `pytest` is
   refused by `conftest.py` for this reason. GTK4 has no offscreen backend —
   never `GDK_BACKEND=offscreen`.
2. **Never show a `Gtk.Popover` in a PRESENTED test window.** It needs a
   Wayland surface headless Weston cannot give, weston dies, and every later
   window test fails at `Gtk couldn't be initialized` looking like a bug in
   itself. Use `_run_in_window(present=False)` and assert on the model.
3. **Both modes, always.** Every feature is for PDF *and* text-first pages
   unless there is a stated reason it cannot be. A feature missing on one side
   reads as a bug. If one side genuinely cannot have it, say so loudly in
   `ideas.csv`. (Only two stated exceptions today: linked page notes and
   bookmarks, both because a text page has no page structure.)
4. **Whether it LOOKS right is the user's call.** Do not screenshot the app to
   judge layout, spacing or a new widget. Build it, then hand over a short
   numbered checklist. Screenshots are for factual yes/no questions only.
5. **You cannot drive gestures on this machine** — there is no
   `wtype`/`ydotool`. Anything gesture-, pen- or undo-shaped is **not
   verified** until the user runs it. Say so rather than implying otherwise.
6. **Test what could break by ACCIDENT**, not what someone would change on
   purpose. An assertion naming a tuned value only fires when somebody edits
   it deliberately. Constants belong in assertions as **bounds** or
   **identifiers**, never as expected values. Asserting a *proxy* for the
   behaviour is the same trap in a different coat.
7. **Do not merge or push the `deck` branch into `master` without asking.**
8. **Editing `ideas.csv` from a script: force LF** (`csv.writer(f,
   lineterminator="\n")`, read with `open(p, newline="")`). Python writes CRLF
   by default and churns all ~190 rows into the diff. The **Issue** and
   **Hash** columns belong to `extras/sync_issues.py`; never hand-edit them.
9. **Maintain the docs you invalidate, in the same change** — this file, the
   right `docs/` guide, `ideas.csv`. But keep this file lean: replace facts,
   never append.

## What this is

A **single-file GTK4/libadwaita Python app** (`sidemark.py`, ~28k lines): a PDF
annotator with a live Markdown notes panel, built for lecture notes and
presenting. One window, two document modes (PDF + text). There is no other
source module on this branch. Deps: PyGObject/GTK4/Adw/GtkSource, PyMuPDF
(`fitz`), cairo, numpy.

Files stay plain: `.pdf` + `.md` sidecar notes, `<name>-ink.json` ink sidecars.
The `.md` names its PDF with an `![[name.pdf]]` embed line at the top.

Launch a checkout standalone: `SIDEMARK_STANDALONE=1 /usr/bin/python3
sidemark.py [FILE]` — the env var bypasses the running single instance.
`sidemark --version` says which copy is running when that is in doubt.

## Where things are

- `PDFCanvas` — the page canvas: ink, lasso, anchors, zoom/pan, images.
- `MarkdownNotesView` — the live-Markdown editor (`\alpha`→α, `x^2` scripts;
  source text stays intact, rendering is display-only).
- `TextPageView` — text-first mode: an A4 Markdown sheet you can draw on.
- `DocumentSession` — one open document (one tab). `PDFEditorWindow` owns an
  `Adw.TabView` of them and **proxies the active session's attributes onto
  itself** (`_session_prop`), so window code reads `self.canvas` and follows
  the active tab. New per-document state goes in `DocumentSession.STATE` /
  `WIDGETS`, kept in sync with that proxy list.
- **Modes**: a tab is PDF or text-first (`doc_mode`). Which header chrome each
  shows is a table (`_MODE_CHROME`), not per-mode `if`s — extend the table.

## Read before you touch

Each guide is the invariants for one area. Read the one you are working in.

| touching | read |
|---|---|
| buttons, chords, stylus, touch, the toolbar | `docs/input.md` |
| the pen, stroke shape, smoothing, latency | `docs/ink.md` |
| the notes editor, maths, links, the sheet, `GtkTextView` | `docs/notes-text.md` |
| page navigation, bookmarks, search, thumbnails, hidden pages | `docs/pages.md` |
| pasted or imported images, the PDF image layer | `docs/images.md` |
| share to phone, the phone as a tablet, the transport | `docs/share.md` |
| Ctrl+R reload, app copies, autosave, logging, the watchdog | `docs/lifecycle.md` |
| anything where a handler "does nothing" | `docs/gtk-traps.md` |
| a test that behaves oddly | `docs/testing.md` |

`ideas.csv` is the decision log — **why** things are the way they are, one row
per feature with long Notes. This file and `docs/` are **what breaks if you
change it**. When you need the reasoning, go to the row.

**The same budget discipline applies to `docs/`**: they are references, not
changelogs. Keep only what is true now and can be broken by accident, REPLACE
rather than append when behaviour changes, and delete what has stopped being
load-bearing. A guide that records every version of a decision is one nobody
can trust to describe the current one.

`docs/open-ends.md` is what is in flight and what is free to pick up. **Read it
after this file.** It is the churny one, so this file does not have to be.

`notes/` holds per-thread plans and handoffs and is **git-ignored** — local to
one machine. Anything a future session must not miss belongs in `docs/`.

## Testing

- `./run_tests.sh` runs `test_pdfeditor.py` in a headless Weston. Pytest args
  pass through (`./run_tests.sh -x test_pdfeditor.py::SomeTest`); `--stop`
  tears the compositor down.
- **The bare command is the FAST TIER and that is the default on purpose.**
  `--full` is everything. The window tier is a third of the tests and ~87% of
  the runtime, so making it need a flag keeps a reflex from costing two
  minutes. Asking for a test **by name** (`-k`, a `::` nodeid) overrides the
  tier.
- **CI runs the whole suite on every push and PR**, so you rarely need
  `--full`. Keep it for a release or a change whose blast radius you cannot
  bound (a shared constant is the usual case).
- **Run the NARROWEST thing that could tell you something**: `-k <the classes
  you touched>` after a behavioural edit, the bare command at milestones,
  nothing after a mechanical rename.
- Long runs go in the background: start one, do other work, read the output
  **once**. Never poll with short sleeps, never run two suites at once (they
  share one compositor), never re-run because the output was hard to read.
- Tests set `SIDEMARK_TEST=1` and use `/usr/bin/python3`. Window tests build a
  real `PDFEditorWindow` in a throwaway `Adw.Application` and pump the loop
  (`_settle()` — copy the pattern).

## Every feature needs

1. Tests in `test_pdfeditor.py`.
2. A row in `ideas.csv` with detailed Notes (rows 96–99 are the style).
3. README **only if a user must know** — 1–3 lines at the altitude of "what it
   does for you", folded into an existing bullet. Not sub-behaviours, not edge
   cases, not internal names. Bug fixes and refactors get nothing.
4. Packaging if files or deps changed: `install.sh`, `PKGBUILD`,
   `aur/sidemark/PKGBUILD`, `extras/sidemark.bash`, `.desktop` keywords.

## Conventions

- **Commits**: Conventional Commits with scope (`feat(notes):`, `fix(nav):`);
  changelog via git-cliff; end with the Claude co-author trailer. When WIP is
  co-mingled, one commit is fine.
- **The codebase favours long comments about *why*** — an invariant, a
  constraint the platform imposes, a trap. Present tense about how it behaves,
  not past tense about how it got here. The test: does the comment still earn
  its space once the change is old?
- **Mark a deliberate corner-cut** as `# ceiling: <the limit>, <what to do if
  it ever matters>`. It stops a knowing choice reading as an oversight and
  stops the same debate being re-run.
- **One table, not two.** `Bindings`, `zoom_factor_for_scroll`, `erase_radius`,
  the clipboard, `draw_image`, the shape-snap helpers — all shared by both
  canvases on purpose. Duplicating a *decision* is how the two sides drift;
  duplicating *mechanics* is fine, they have different substrates. **Before
  fixing a bug in a shared helper, grep every caller**: a report names one
  symptom on one path, and the fix belongs where all callers route through.
- **The pen belongs to the APP, not a tab** (`PEN_SETTINGS`): every value the
  pen popover offers is loaded per canvas and written to every open canvas and
  to `settings.json`.
- **Wayland file DnD** needs `Gtk.DropTargetAsync` plus a drag-motion handler
  returning an action, or the drop never fires.

## The browser port (`web/`)

A faithful port of the page, pen and notes runs in a browser out of `web/`,
published to <https://brokkoli71.github.io/sidemark/> on every push to master.
It is also what a phone gets when you Share to phone. **`web/CLAUDE.md` is its
reference — read that before touching anything under `web/`.**

Two rules belong here. The ported pipeline is checked against `sidemark.py`
by exported VECTORS (`extras/export_*_vectors.py`), so a change to the ink
pipeline, the maths grammar, the sidecar format, the lasso geometry or the
shape recogniser on this side may break `web/test/`. Regenerate with
`npm run vectors` in `web/` and re-run `npm test`.

And the Pages copy is an **installable app** (row 190): `manifest.webmanifest`
and `sw.js` are load-bearing, `sw.js` must be deployed at the SITE ROOT (a
service worker cannot claim a scope above its own path), and its precache list
is checked against `src/` and `vendor/` both ways — add a module there and
`web/test/pwa.mjs` will tell you.

## The deck branch (parked — not a concern)

An experimental Sidemark **Deck** presentation editor lives on the `deck`
branch (checked out at `../pdfeditor/`, with its own CLAUDE.md if it is ever
picked up). **Treat it as dormant**: do not weigh merge cost when designing or
refactoring, and do not audit master's changes against it. It may be revived,
may become an extension, or may never land. See rule 7.
