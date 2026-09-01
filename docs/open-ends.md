# Open ends

> What is IN FLIGHT and what is free to pick up. `CLAUDE.md` is the
> starting point and links here; read that first, then this.

> Keep this file the churny one. When something lands, fold its invariants
> into `CLAUDE.md` or the right `docs/` guide and DELETE it from here — this
> is a to-do list, not a changelog. The chronology lives in `ideas.csv`
> and git.


Everything shipped is described as behavior in the sections above; this section
is only *what is in flight* and *what is free to pick up*. Keep it that way —
when something lands, fold its invariants upward and delete it from here rather
than writing a line about having finished it. The chronology lives in
`ideas.csv` and git.

**START HERE (2026-08-18): row 181's three levers all SHIPPED, and the only
thing owed on them is a pass IN THE HAND — the checklist is at the end of
`notes/text-mode-parity-plan.md`.** Lever 3 replaced GTK's pointer handling on
the text sheet (the router claims every press; the caret is a tool), and none
of it has been driven by a real pointer, pen or finger, because there is no
key-injection tool on this machine. Start the session by handing the user that
checklist. Two answers are wanted back rather than just pass/fail: whether a
finger selecting text with no selection handles is worse than the bubble it
replaced, and whether an unbound chord doing NOTHING on the sheet (it used to
fall through and move the caret) reads as right. The plan file keeps the
diagnosis — text mode's recurring bugs are a GTK SEAM, not a model
disagreement, and a translation layer or a new text model was asked for and
ruled out. Do not re-derive it.

Rows 175 and 179 shipped; row 166's crash is fixed (`iter_at_buffer_xy`), which
also lifts the precondition on rebuilding the link previews.

**Also open (2026-08-17): six ideas were triaged with the user and each one's
open questions were ANSWERED by them — `ideas.csv` rows 175–180 hold the
answers, and re-deriving them is wasted work.** In the user's own order of
readiness, minus the two that have shipped: the two they asked to have
PROTOTYPED IN THE WEB before anything ships (row 176, only what is right of the cursor falls back to source, cursor
line only; row 177, four options for shapes that stretch when text is inserted
through them — they especially want to feel the freehand one), then row 178
(draw while scrolling, which they clarified as *scroll while the pen is down*),
and row 180 (Nextcloud), which is blocked on ONE answer from them: their own
instance, or anyone's?

**Also unstarted: an APPROVED plan from 2026-08-14 —**
`notes/text-objects-plan.md` (row 168) — type your own text on a page, stored
like a drawing and written into the PDF as REAL selectable text. It was agreed
with the user on 2026-08-14, its phase 0 is a standalone fix for a live bug
(the notes export writes `α ∑ ℝ →` as `?????`, because base-14 `helv` cannot
encode them), and it opens with the design decisions already made — read it
before designing anything in that area. Editing the PDF's OWN text was analysed
and REJECTED there with the user's agreement; don't reopen it.

Two smaller things are also queued and unstarted: **inserting an image from a
FILE** (dropping a `.png` is still refused by `classify_import_paths`, and
there is no menu entry — the gap row 167 started from, and small), and **row
160's `HOLD_SLOP_PX = 16.0` still wants judging in the hand**, since 16 was
chosen on a 1.5× display.

**Two refinements to row 162 shipped on the WEB first and are owed to the
desktop** (2026-08-16, both verified in a browser, both small):

- **The caret must keep its EXACT position, not just its page.** Today
  `_place_full_notes_caret` goes to the START of the page's section and
  `_restore_note` refills the panel from the top, so crossing the divider
  mid-sentence loses your place — which is most of the times you cross it. The
  two buffers hold the SAME body (the panel shows a page's notes, the sheet
  shows them inside the whole file), so the offset within that body is the same
  number on both sides and only where the body STARTS changes. The web's
  `_offsetInBody` is the whole of it: in the panel it is the caret offset less
  the leading whitespace the commit is about to trim, on the sheet it is the
  offset less `note_offset_for_page(run_start(page))`. Clamp it to the body's
  length, or a long caret position walks into the next page's marker; a page
  with no body clamps to 0, which is the marker it was already going to.
- **A linked RUN should light up as a whole in the sidebar.** A run's body is
  stored once (row 129), so inside one there is no single answer to "which page
  am I reading?" — highlighting every page of the run is the only honest thing
  the thumbnail strip and the outline can say, with the page you are actually
  on keeping the solid outline. Only when the run has more than one page, so
  the ordinary case looks exactly as it does now.

**The older thread below is a VALIDATION session, not a feature one —
`notes/validation-session.md` is the checklist.** The ink/latency thread
(rows 139/143/147) is CLOSED; do not reopen it without a new measurement.
**The INPUT thread is closed too**: row 135's stylus block and §1b's three
fixes were all accepted in the hand on 2026-08-11 — the pen tip, both barrels,
a finger panning, the palm not drawing while you write, toolbar binding by
device, and the row 150 pinch. That was the largest untested surface in the
app and the whole of the "a stylus's ends ARE mouse buttons" design; it holds,
and it is now behavior described above rather than work in flight. Begin at:

1. The **merge drops** (row 123).
2. Then the shape/grid dwell (row 121), the divider gesture (row 130), and
   rows 140–142.

*Closed 2026-08-10, with the measurements in `ideas.csv` rows 139/143/147:
live smoothing ON, dot size and shape, pointer hiding, the smear trim (no felt
difference at any setting), and PREDICTION — settled by grading, not taste, and
nothing further is to be built for it. The pen's remaining ~110 ms of lag was
measured to be UPSTREAM of the compositor and is not ours to recover.*

**In flight — code-verified, needing a pass in the real app. The whole list is
one validation session; `notes/validation-session.md` is its checklist.**

- **Row 135 (stylus, touch and palm) — ACCEPTED IN THE HAND 2026-08-11**, so
  it is no longer in flight; what it does is described in the input sections
  above. Hardware is a Goodix GXTP7380 convertible panel and the measurements
  behind every decision are in `ideas.csv` row 135, which
  `extras/input_probe.py` re-runs (`--followup` for the awkward cases). Three
  things outlive the validation:
  - **Open, its own session:** on this laptop palm detection stops working
    while the CHARGER IS PLUGGED IN — most likely charger noise on the
    capacitive digitiser rather than anything in Sidemark (the accepted palm
    result above was judged on battery). Re-measure on AC vs battery with
    `extras/input_probe.py` before touching code; the question is whether
    libinput's ~110 ms `TOUCH_END` still arrives when plugged in.
  - Two rough edges were judged and **deliberately left**: an eraser-barrel
    *tap* opens the sheet's context menu (a right press is deferred there, and
    forking the router on device is worse), and row 126's circle-to-lasso
    relies on a pen *lift* that a mid-stroke barrel flip manufactures. Fix
    either only if it becomes painful in real use — not pre-emptively.
  - Row 136 (a hardware-report script + GitHub issue template for other
    people's devices) is the planned follow-up.

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
- **Row 147's SECOND half is open: the text sheet still repaints its ink every
  frame.** The PDF canvas caches committed strokes into a surface and blits
  them (flat ~1.5 ms/frame against 66 ms at 400 strokes); the sheet's ink lives
  on an overlay with a different substrate, so it does not transfer for free —
  but the parity rule says it should follow. Copy the *decisions* (a
  fingerprint-keyed cache, an append painted onto the existing layer), not the
  code. Also unfinished and trivial: two captures under `GSK_RENDERER=gl` vs
  the default would settle whether to set a renderer in the launcher — the
  probe measured 41 fps vs 60, but judged by feel in the app it was
  "similar, maybe a tiny bit faster", which is not evidence to hardcode on.
  **Deliberately NOT built, needs the user's call:** stroke-onset recovery —
  it invents ink that was never measured.

**Loose ends, roughly in order of how ready they are:**

- **Row 168 — text objects on the page.** Approved and planned in full
  (`notes/text-objects-plan.md`); see START HERE above. Phase 0 (embed a
  Unicode font) is a standalone bug fix and can land on its own.
- **Row 167's leftover — insert an image from a FILE.** Small: a drop path
  through `classify_import_paths` plus a ☰ entry. Both modes; the model,
  rendering and persistence all exist already.
- **Row 145 — audit the test suite, and restructure THIS FILE using it as the
  instrument.** The suite is 905 tests / ~140 s, of which the window tier is a
  third of the tests and 87% of the time, and 26 of those are ≤6-line tests
  dragged into the slow tier because `conftest.py` marks per CLASS. The sharper
  half is value, not cost: three specimens found in one pass asserted *what the
  code says* rather than *what the user gets*. Same session: note per area
  whether this file helped, was silent, or was stale — then split it by WHEN a
  thing is read (architecture = orient once; pitfalls = look up on touch;
  process rules = put in tooling if they can be). **A test audit is a biased
  sample**, so "unused" means unobserved, not useless.

- **Row 150's leftover is CLOSED by lever 3, and it needs confirming in the
  hand.** The sheet's router now claims every press, so the `TextView` never
  takes the first sequence and its touch selection bubble cannot appear under
  a pinch — the user's proposal ("that UI belongs to the finger only when the
  finger's tool IS the caret") is satisfied by construction rather than by a
  rule. *ceiling: our caret tool draws no touch selection handles at all, so
  selecting text with a FINGER on the sheet is now a plain drag with nothing
  to grab afterwards. Nobody has judged whether that is worse than the bubble
  it replaces — it needs the panel.*
- **Row 151 — a survivor finger should keep panning.** LOW priority, and the
  one piece of row 150's pinch that was never built: lift one finger of a
  two-finger gesture on a sheet and the gesture ENDS, because the survivor
  reaches the router as a brand-new press (`GtkGestureDrag` is single-point)
  and is re-resolved through the binding table. The latch already re-bases on
  the finger that is left, so what is missing is a decision, not arithmetic —
  and it belongs as a third exception AT the router, beside Shift+lasso and
  the grabbable selection, never as a fork of the table. PDF pages are
  unaffected (a finger there pans already). Only worth doing if it starts to
  feel wrong in the hand.
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
