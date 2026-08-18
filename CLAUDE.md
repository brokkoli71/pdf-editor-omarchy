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
  - **Only what the caret TOUCHES falls back to source (row 141)** — the
    `\command` under it, the script it is inside, the bold run it is in; the
    rest of the line stays rendered. A whole line reverting under a click moved
    every symbol on it just as you aimed at one. `_symbolize_map` is what makes
    that safe in both directions: it returns an index map beside the rendered
    text, so the caret is PLACED through the map (a click lands on the symbol,
    not on the column it pushed) and an edit that does land on a glyph is
    SPLICED back onto the source through it (`_line_source`) instead of
    freezing the line's other symbols as literal glyphs in the `.md`.
    Everything MARKED shows its source, on every line the selection covers —
    what you have selected is what you are about to cut or replace, and a
    selection whose text re-shaped itself as it grew is worse than lines that
    settle once. `_line_originals[ln]` is `(source, rendered, index map, open
    span)`; the open span is why a line the caret has just left gets
    re-rendered instead of being trusted as already done.
    **A HEADING MARKER is the one exception (row 161)**, and it opens from
    ANYWHERE on its line: it is a property of the whole line, it is the one
    construct whose source you cannot read off what it renders, and revealing
    it only pushes the line sideways — nothing on it re-renders.
    *ceiling: `\sqrt` is the radical sign alone — no overbar, so it cannot say
    where the root ends; a bar would have to be drawn, which is the wall `\vec`
    hit.*
    **`->` `<-` are NOT ours and must not be** (row 161): they are a **font
    ligature**, and substituting them was tried and reverted. The report that
    they had "stopped working" was a font-cache problem that a reboot fixed,
    and no substitution can match a ligature's look — it spans both cells, so
    a one-glyph `→` comes out visibly shorter. If they break again, the
    question is about the font, not about `_MD_SYMBOLS`.
  - **A task box is a ONE-FOR-ONE substitution** (`_boxify`, `_MD_TASK_RE`):
    `- [ ]`'s state character becomes the glyph and the `- [` / `]` around it
    are hidden with tags, so the construct is five columns of source and one
    glyph on screen with the **index map left as the identity** — nothing else
    on the line has to know boxes exist. Ticking (`toggle_task`) writes
    the state character over the glyph and lets `_line_source` splice it back;
    rewriting the source line by hand would freeze every other symbol on it.
    It is STYLED (`taskbox` / `taskdone`: 1.3×, grey, green when ticked, and an
    explicit colour because GtkSource paints a list marker RED and an empty box
    must not read as an error).
    - **Drawing a real control instead was tried and reverted, and neither
      reason will change.** A transparent foreground (`foreground-rgba` alpha
      0) **still paints**, so the glyph cannot be hidden under a drawing; and
      `get_iter_location` returns **the same x for adjacent characters** on a
      line carrying hidden runs, so there is no cell to align one to. Text
      aligns by construction — that is the argument. The only route to a real
      widget is a `GtkTextChildAnchor`, which is a real character in a buffer
      that IS the `.md`. Don't.
    - **A box does NOT open under the caret** — the one construct that must
      not. A heading marker reveals because `##` cannot be read off what it
      renders; a box renders its whole state, and the way to change it is to
      click it. Opening it grew the line by four columns the moment the caret
      landed, sliding the words out from under a pointer that had not moved. A
      SELECTION still shows source, and needs no special case: there the line
      is source already, so the branch does not run.
    - **The hit is resolved on the PRESS and acted on at the release**
      (`_task_press`), and that outlives the rule above: by the time a release
      arrives, ANY reveal on that line has re-rendered around the new caret, so
      the words have moved under a pointer that never left. Only the layout as
      it was when the finger came down can say where it came down; the release
      just checks the press has not travelled (`CLICK_SLOP_PX`).
    - **The click target is a COLUMN RANGE, never a rectangle**
      (`_task_box_at`): `get_iter_at_location` answers the question the CARET
      asks — which boundary is nearest — so past the middle of the box it
      returns the character AFTER it, and an equality test left the right half
      of every box dead. The range runs from the hidden bullet (zero width, so
      nothing can land in it) to the far edge of the glyph, and stops at the
      space behind it, because a checkbox is also a line you type in.
    **Enter reads the marker from the
    SOURCE** (`_continue_list`), or it writes the glyph into the `.md`; it
    opens an empty box, counts a number on, ends the list on an empty item, and
    only fires at the END of a line (elsewhere Enter is a split, and the
    caret's column there is a rendered one). *Not in the web port yet.*
  - **Search highlights are the view's own tags, found by searching the
    BUFFER** (`set_search_query` / `set_search_current`) — yellow for every
    occurrence, orange for the current one, the page's palette. This is the one
    surface whose text re-renders *under* the highlight, so a stored model
    offset points at the wrong column the moment a line renders. Three
    constraints: the tags live OUTSIDE `self._t` (`_rehighlight` clears that
    table every pass, and a highlight outlives a render) and are created LAST
    so they outrank `code`; `_rehighlight` re-applies them at the end of the
    pass, because a line it rewrote dropped them; and the current match is a
    MARK PAIR, so it rides `_buf_replace_line`. A hit is **never selected** —
    the selection colour is grey beside the page's yellow, and row 141 would
    un-render the line you were sent to read.
  - **Triple-click selects the whole LOGICAL line** (`line_bounds`) — one
    Return's worth of typing, however many rows it wraps onto. GtkTextView's
    own "line" is the DISPLAY line, a fragment of what looks like one. It is
    applied from an **idle, after the press** (`_select_clicked_line`), not in
    the handler: controllers on one widget fire NEWEST FIRST, so the view's own
    click gesture — installed before ours — runs *after* it and lays its
    display-line selection on top. A press handler that "does nothing" here is
    usually running and being overwritten. The idle also **denies the view's
    internal selection drag**, which by then holds the sequence: that drag
    re-derives the selection from the pointer at display-line granularity on
    every motion event, so without the denial the first flicker of the hand
    snaps the line back to one wrapped row.
  - **The maths grammar wins over Markdown's**: `_` is a SUBSCRIPT here, so the
    GtkSource language's `_emphasis_` is cancelled line by line with a
    `noitalic` tag and only `*italic*` puts the slant back. Its syntax tags sit
    at priority 0, so any tag of ours outranks them — but priority is the order
    tags are ADDED to the table, which is why `noitalic` is created *before*
    `italic`.
  - **An unbraced script ends at the first character that is not alphanumeric
    or a symbol GLYPH** (`a_i, b_j`; but `x^\alpha` lifts the α it became —
    `_MD_SCRIPT_BODY`, row 163), and a **terminating space is eaten on render**:
    you are forced to type it (`\alphax` is another command, `a_ib` subscripts
    "ib"), so showing it puts a hole inside "αx". Two spaces is how you ask for
    one. **ONE space, whatever follows it** (row 164) — the rule used to ask
    whether that character could have continued the expression, which rendered
    `\alpha a`, `\alpha 1` and `\alpha +` three different ways for a reason
    only the grammar could see. The cost was accepted with eyes open:
    `\alpha + \beta` reads "α+ β", and an operator that wants its spacing asks
    with two spaces. There is nothing left for the rule to depend on, which is
    why `at_end`/`_MD_*_END_RE` are GONE — the end of the line, the end of a
    `code` segment and an ordinary letter all terminate alike.
    **Commands and scripts obey one rule**, including the split that makes it
    work: the space is eaten, but the "is the caret still in this expression?"
    test uses the expression WITHOUT it (`_MD_COMMAND_RE`, `script_body_end`)
    — otherwise typing the terminator holds the thing you just finished open
    under the caret. There is **no per-symbol exception** — an operator's space
    is eaten too (`\cdot a` is "·a"), because half the table behaving
    differently is not a rule anyone can hold while writing.
    **BACKSPACE is the one thing that reads that split backwards**
    (`_open_eaten_terminator`, row 164): the eaten space is real source the
    caret is standing behind with nothing drawn for it, so GTK's Backspace
    landed on the glyph in front of it and the splice took the whole `\alpha `
    out in one keystroke. It reveals the line first, then defers to GTK. The
    two directions want opposite things — forwards you have finished writing
    the expression, backwards you are going back into it — so do not "unify"
    them by widening the caret test.
  - **A script that abuts the one before it is a script OF it** (`iter_scripts`
    yields a nesting *chain*): `a_i_j` is j indexing i and `a_i^2` puts the 2 on
    top of the i, each level placed on the one it sits on and shrunk again
    (`script_style`). The editor makes a tag per chain on demand; the callout
    renderer nests `<sub>`/`<sup>`. Anything between the two scripts ends the
    chain, which is how you still write two scripts of one base.
  - *ceiling: `\vec{A}` overlaps a capital.* Measured across 9 font families:
    every one places U+20D7 at x-height whatever the base, and giving the mark
    its own attribute run (a rise) detaches it from the base and Pango draws a
    dotted circle. It cannot be fixed through text attributes — only by drawing
    the glyph ourselves, which a `GtkTextView` cannot do inline. `\bar` and
    `\hat` are positioned correctly by the fonts, so this is specific to the
    arrow.
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
  table — **one per document mode** (`DEFAULT_TABLES`; persisted in
  settings.json under `button_bindings` as `{"pdf": …, "text": …}`), ONE
  instance per window shared by every canvas and sheet.
  PDF defaults (the user's table, 2026-07-31): left pen, middle lasso, right
  eraser, plus four chords — Ctrl+left pan, Ctrl+right text cursor, Shift+left
  zoom-to-region, **Alt+left text cursor** (Alt is how you follow a PDF link,
  and following a link IS the caret's click). The **thumb is unbound** (most
  mice have none). Nothing else is bound out of the box; the rest is the
  user's to bind.
  - **The MODEL is unified, the tables are not.** One class, one popover, the
    same chord ids, and a mode's table is the PDF one unless there is a reason
    (`TEXT_BINDING_OVERRIDES` is the whole list of reasons: a sheet is for
    TYPING, so left is the caret and Shift+left extends a selection; Alt+left
    then carries the pen so it stays reachable without rebinding). One table
    for both modes shipped first and did not survive the text page — what the
    left button should do is exactly what the mode decides.
    `bindings.mode` is what the CHROME acts on — toolbar, badges, tooltips,
    popover, binding surface — and `_update_header_for_mode` keeps it on the
    active tab. **Routing never reads it**: a canvas passes its own
    `doc_mode`, or the sheet's press router would follow whichever tab the
    header thinks is in front. Migration: a saved flat table becomes the PDF
    one and seeds the text one with the overrides on top; `Reset` resets the
    mode you are looking at, and the popover heading names it. `chord_tool()` is **vestigial** — the old fixed grammar, now
  with no production callers and only tests referencing it. Do not route
  anything new through it; `Bindings` is the table. It is kept because the
  older modifier chords it encodes are the obvious defaults to *offer* if a
  binding preset ever lands.
  - **The toolbar is the binding surface**: click a tool with the button you
    want it on — including a FINGER and the pen's eraser barrel
    (`toolbar_binding_for`), which is the same law, not an extension of it.
    Plain left-click is the exception — it stays "put this on the left
    button", so picking a tool feels unchanged, and a pen TIP tap goes down
    that path because a tip press IS a left press. **Claiming the press does
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
  - **A stylus's ends ARE mouse buttons (row 135).** `button_for_event()` maps
    the hardware to a button identity — tip→left, eraser barrel→right, other
    barrel+tip→middle, finger→`BTN_FINGER` — so the pen needs NO table of its
    own and every consumer (table, stripes, badges, tooltips, popover, the
    binding surface) is untouched. The shipped defaults are therefore already
    the pen workflow, and the eraser barrel wears the right button's colour,
    which is how the bar teaches the mapping. If you find yourself adding a
    source dimension to `Bindings`, you have taken the superseded design
    (`notes/stylus-input-plan.md`). *ceiling: tip and left-click are one
    identity and cannot hold different tools.*
    - **Read `get_device_tool()`, NEVER `device.get_source()`** — GTK delivers
      the LOGICAL pointer for a stylus, whose source reports `MOUSE`. The
      obvious API is the wrong one. A touch is the one with an event sequence.
    - **A finger pans, and that IS the palm rejection.** On a convertible the
      palm lands *before* the tip, so whatever a stray touch runs must not be
      the pen. libinput already drops a palm contact itself in ~110 ms and
      sends nothing at all during a pen stroke — so do **not** add proximity
      timers or `TOUCH_CANCEL` handling; re-measure first if a palm ever draws.
    - **The barrel button must be tracked and DENIED, not read off the
      gesture** (`track_barrel`): pressed before the tip it claims the
      `GestureDrag` and the tip's press then never produces a drag-begin at
      all. Same reason the window tracks held keys for touch.
    - **TWO FINGERS ARE A FACT ABOUT THE HAND, NEVER ABOUT THE GESTURE**
      (`TouchLatch` / `attach_touch_latch`, rows 148 + 150). `GestureZoom`
      cannot be what tells a surface a second finger landed: it only fires once
      it *recognises*, and it needs two sequences the press routers may already
      have taken — the sheet's router CLAIMS the first one, so the pinch there
      can be starved and never begin at all. So the count comes off the raw
      touch stream, on its own capture-phase legacy controller, for
      `track_barrel`'s reason. Two invariants: `multi` latches on the second
      touchdown and clears only when the **last** finger lifts (a pinch ends
      while a finger is still down, and `GtkGestureDrag` is single-point, so
      the survivor arrives as a brand-new press — routed through the table like
      any other, that is a dot with `finger: pen`); and a second finger
      **abandons** whatever the first started (`_on_second_finger`, on both
      surfaces) rather than committing it. Never gate any of this on the pinch
      gesture, and never clear `_post_pinch` while a finger is still down.
      - **The latch shipped DEAD twice, and neither cause was in its logic.**
        (1) PyGObject hands `EventControllerLegacy` a **NULL event** for some
        events — the pane-drag trap again — and dereferencing it raises, which
        in a signal handler is silent apart from a traceback: the latch simply
        stopped counting. `handle(None)` is a no-op and the controller's own
        `get_current_event()` is the second chance at the same event. (2)
        Capture controllers of ONE widget run in the order they were **added**,
        and a gesture that CLAIMS returns STOP — so a latch attached after the
        sheet's press router never saw the touches the router had taken. It is
        the **first** controller on both surfaces. Anything reading a raw event
        stream can be correct, unit-tested and never once run.
      - **The sheet's pinch is the latch's own arithmetic** (row 150): it keeps
        each finger's POSITION beside the count, and `_on_touch_frame` drives
        zoom and pan from centroid + spread. `GestureZoom` stays for the
        **touchpad**, which pinches with no touch sequences at all, and stands
        down while the latch holds fingers — one pinch, two ways in. Do NOT
        release the router's claim to feed the gesture instead: the claim is
        what keeps the `TextView` off the press, so releasing it gives the
        caret a click mid-pinch, which is the symptom. Four things the first
        working version got wrong, all of them about the sheet being a
        REFLOW and not a scale factor:
        - **Once per FRAME, not once per event** (`add_tick_callback`). A zoom
          here is a font change and a full relayout, and the panel reports
          several times faster than that lays out.
        - **The driver keeps its own float scroll** and re-applies it at the
          top of the next frame. A `GtkAdjustment` clamps against the extent
          of the layout it HAS, and the relayout to a new zoom is async — so
          the value set during a zoom-in is clamped to the old extent, which
          is the sheet snapping to the top-left. (The PDF canvas never meets
          this: its offsets are plain floats.)
        - **Incremental, measuring each frame against the last**, so a step
          that lands short cannot drag the whole gesture off.
        - **A lift RE-BASES rather than continuing** — one anchor
          (`_touch_anchor`: the centroid, or the one finger left), so a lift
          changes how many fingers make it and nothing else.
      - **The second finger has to be SWALLOWED on the sheet**
        (`consume_extra`): a `GtkGestureDrag` is single-point and *ignores* a
        second sequence, which is not denying it, so it sailed past the router
        into the `GtkTextView` and marked text. The FIRST sequence is never
        consumed — the router holds it, and eating its release leaves that
        drag live forever. The canvas swallows nothing: its `GestureZoom`
        needs both sequences and works.
      - **Abandoning at the touchdown is not enough** — GTK can cancel the
        first finger's drag when another controller takes the sequence, which
        fires `drag-end` with the tool still in hand. So the guard is also at
        the COMMIT (`_press_end`: two fingers down means no commit, whatever
        route got there), and ink a finger committed *earlier in this hand* is
        taken back off the page with its undo op (`_touch_strokes` /
        `_drop_touch_strokes`). Armed by `_capture_device == "touch"`, never by
        the touch count — a palm resting during a PEN stroke must arm nothing —
        and cleared when the glass empties or at any fresh press, so ink is
        revocable only for the hand that drew it.
        *ceiling: with the finger unbound (or bound to `text`) the router
        DENIES, so the `TextView` takes the first sequence and its own touch
        text-selection popup can still appear under a pinch — the exit is to
        give that selection UI to the finger only when the finger's tool IS
        the caret (row 150).*
    - **No tilt** on this class of panel: the axes exist and are flat zero, so
      a presence check passes and the feature silently does nothing.
    - **A new DEFAULT binding reaches nobody who has customised their table**
      — a saved table is the whole truth, which is what makes an unbind stick.
      `settings.json` therefore also stores `button_defaults_seeded`, the
      default keys ever offered; a key not on it is new and seeded once, a key
      on it but absent was cleared on purpose and stays gone. Never merge
      `DEFAULT_BINDINGS` over the saved table on load — that resurrects every
      binding the user removed. This is how `finger: pan` shipped dead.
  - **Links glow exactly when a click would follow one**: `link_hover_active()`
    is "the left button's tool right now is `text`", never "Alt is down". One
    predicate for the glow and for `_open_link_at`, or the modifier promises
    what the table cannot deliver.
  - **There are no keyboard tool shortcuts.** Ctrl+H (highlighter) and Ctrl+M
    (caret) were hold-to-borrow and were REMOVED with row 132 — a key that
    lends a button a tool is a second mapping beside the table, which is the
    one thing this design does not allow. Tools change by binding them. (The
    README documented both for a while after they stopped existing; if a
    shortcut is reintroduced it has to come from the table, not beside it.)
  - `TOOL_MODES` drives the bar order, the `_MODE_CHROME` tool rows and the
    resolver, so a tool cannot be in the bar and missing from the grammar.
    `"select"` is an alias of `"text"` — one I-beam button serves both modes.
  - Chord routing merges window-tracked held modifiers (`_chord_state`) so
    keyboard+touch works; see ideas.csv rows 115 and 132.
- **The ink pipeline (row 139)** — what the pen writes goes through THREE jobs
  on commit, and the whole design is that they stay apart. Conflating two of
  them is what made fast handwriting shrink. `finish_ink_stroke()` is the one
  entry point and also holds the policy (a snapped shape and the highlighter
  opt out); both canvases call it, nothing else does the steps by hand.
  1. **`resample_ink` INTERPOLATES** — centripetal Catmull-Rom, walked at fixed
     arc length. Catmull-Rom because it *interpolates*: the curve passes
     through every point the pen reported, so filling a gap can never move the
     line off where you drew it. The walk also thins a slow stroke's clusters,
     so spacing stops depending on pen speed. **It always runs** — the
     "Smoothing" slider is the denoiser only, and turning interpolation off
     would just bring back the facets on a fast stroke.
  2. **`taubin_smooth` DENOISES** — λ shrink alternating with a μ inflate pass.
     It replaced a plain Laplacian, which is a *diffusion* and so destroys
     curvature: a loop of N samples lost `1 − 2f(1 − cos(2π/N))` of its radius
     per pass, i.e. −19% at 12 samples but −2% at 40, so the damage grew with
     how fast you wrote. **The Laplacian must be the MIDPOINT form**
     `c + f·((a+b)/2 − c)`, never `c + f·(a+b−2c)`: the 2× difference puts the
     eigenvalues in [0,2] instead of [0,4], and Taubin's λ/μ are only a
     low-pass filter on the former — with the doubled form the μ pass
     *amplifies* Nyquist. It passes the circle test while broken. λ is capped
     at 0.5 by stability, so `INK_SMOOTH_PAIRS` is the only knob that deepens
     the stopband. **A big zigzag is not jitter** — resampled it is a
     long-wavelength shape, and preserving it is the same property that keeps a
     fast "o" round, so test denoising against a smooth arc plus per-sample
     noise, never a zigzag.
  - **The same three jobs run LIVE** (`live_ink_stroke`, row 143), so the line
    under the nib is the line you are left with. It skips exactly two steps of
    `finish_ink_stroke`, both because the stroke is not over: the raw capture
    (that file is one record per STROKE, so routing the live path through
    `finish_ink_stroke` spams it every frame) and `trim_light_tail` (mid-stroke
    the falling edge is just where the pen IS). The tail is the only place live
    and committed differ. Three things hold it up: a **snapped** stroke is
    exempt live exactly as at commit (`_straight_mode` — denoising a recognised
    rectangle rounds the corners the dwell just gave it); the **predicted tip
    is appended AFTER smoothing** (`lead=`), because `taubin_smooth` pins its
    endpoints and a guess run through the filter drags the last real samples
    onto it; and past `LIVE_SMOOTH_MAX_PTS` only the **tail** is re-shaped,
    since the pipeline is O(n) per motion event and `INK_MAX_POINTS` is 3000
    (the join needs no blending — resampling starts at the first point and
    denoising holds both endpoints, so head and tail meet at the sample they
    were split on). **Do not "fix" the re-indexing**: a new sample re-indexes
    nearly every resampled point while the *path* stays put, so a live-smoothing
    test must compare SHAPE — an index-aligned comparison fails against correct
    behaviour. `_live_stroke` is shared by class assignment (the sheet borrows
    the canvas's), so both modes get this at once; `_smoothing_now()` is the
    adapter for the one setting they hold differently.
    - **Its cost is the TAIL, and that is why there is a switch.** The line
      does not lag (the drawn tip sits exactly on the pen's latest sample) but
      the last stretch re-settles on every report — 0.21% of an x-height per
      sample at the median, 6.6% at worst, against exactly 0 for a raw
      polyline, which cannot move because appending a point never disturbs the
      points before it. At ~3 samples per x-height writing small, that reads as
      a wriggling tip. So the two modes fail in opposite directions and only
      the hand can choose: `live_smooth` ("Smooth while drawing") keeps both
      available, and the COMMITTED ink is identical either way. **Measuring the
      settled body is not measuring what the hand watches** — the pre-ship
      numbers excluded the tail as "expected to move", which is exactly where
      the user was looking.
  - **Every length here SCALES with the writing** (`ink_feature_size`,
    `adaptive_spacing`). They are all really "a fraction of a letter" and only
    looked like constants because they were tuned at one size: a fixed spacing
    is a fixed smoothing radius, which is a small share of large writing and a
    quarter of an x-height when writing small — so small writing was the only
    thing being averaged into mush. The measure is the **short side** of the
    bounding box (a cursive run's x-height is what must survive; its diagonal
    is just how long the word is), with a deliberately *small* diagonal
    fallback — at 0.15 it would win above ~6.6:1, which ordinary cursive
    exceeds, and the measure would then grow with word length.
  - **A DOT IS NOT A SHORT STROKE (row 144).** Two rules, both learned from
    captured taps after three futile rises of `INK_DOT_BOOST` — the multiplier
    was never the wrong *value*, it was the wrong knob. **The taper must not
    touch it**: a dot is nothing but endpoints, so `INK_TAPER_MIN` scales all
    of it, and capping the ramp's LENGTH (`INK_TAPER_FRAC`) does not help. That
    bit only the ≥3-sample path, because the too-short-to-resample branch
    passes `taper=False` — so the same tap painted **2.4× differently
    depending on how many samples the digitiser emitted**. **And its width must
    be CONSTANT along it**: the last sample of a tap reads ~0 pressure (the pen
    leaving the glass, not the shape), so per-point widths drew one end at the
    floor and the other at full boost, and on a mark of near-zero length an
    outline with two radii is a crescent with a bite out of it — a pac-man, not
    a dot. The profile is flattened to its PEAK. `trim_light_tail` cannot do
    this: a tap returns before it runs, and trimming two samples leaves nothing
    to draw. *ceiling: `INK_DOT_LEN` is FIXED at 5.0 units — the one length
    here not scaled to the writing — so a dot that slid past it gets nothing;
    unfixed because an i-dot that slid cannot be told from a t-crossbar by
    geometry.*
  3. **`width_profile` SHAPES** it. The end taper is capped at
     `INK_TAPER_FRAC` of the stroke as well as `INK_TAPER_LEN`: a ramp of fixed
     length is the *whole* of a short mark, which is why the dot on an "i" once
     came out at half width. A stroke's **`press` list is not raw
     pressure**: it is the finished per-point width factor in 0..1 with the end
     taper already folded in, painted as `width * factor`. One concept, not
     two — it lets a mouse stroke taper without a second flag, and makes "has a
     profile" mean exactly "is freehand" at render time. *ceiling: the taper is
     baked at commit, so changing `INK_TAPER_*` does not restyle existing ink.*
  - **`draw_ink_stroke` is THE ink painter** — all seven painters route through
    it (page render, live stroke, presenter mirror, both copy-render PNGs, both
    lasso glows, the text-page PDF export). With a profile it builds a closed
    OUTLINE and fills it once; per-segment strokes would double-darken where
    they overlap. `grow=` is how the lasso glow haloes a tapered stroke instead
    of wrapping a flat sausage round a thin tip.
  - **Pressure persists in the annot's `/Contents`** (`INK_PROFILE_TAG`),
    because a PDF ink annotation has ONE width — the old row 26 blocker.
    Sidemark reloads the taper; other readers see constant-width ink. Splitting
    a stroke into per-width-band annots was rejected: it costs the lasso, the
    eraser and the control points. Text sheet: a `press` key in the sidecar.
    Both guarded by a LENGTH match, so a mismatch loses the taper rather than
    shifting every width along the stroke.
  - **The smear trim is ASYMMETRIC, and that is the point.** `trim_light_tail`
    cuts the falling edge only. The two ends are opposite problems: the END is
    a real smear (the pen unloads before leaving the glass and trails into the
    next letter), while the START is already CLIPPED — the digitiser reports no
    contact until its own threshold is crossed, so the first sample already
    carries real pressure and the ink before it was never captured. A symmetric
    gate makes "the stroke starts too late" strictly worse. Never re-add a live
    per-sample gate.
  - **The pen's samples arrive COMPRESSED, and `motion_history()` is how the
    stroke gets them back (row 147).** GTK compresses POINTER motion to one
    event per frame, and a stylus is delivered as the logical pointer (row
    135), so the pen rides that path while a finger does not. Measured: the
    panel reports the pen at **133 Hz** and the canvas was seeing **30 Hz** —
    78% of every stroke discarded, which is the whole of what the pipeline
    called "undersampling" (spacing/feature 0.337 for the pen against 0.08 for
    touch). Both drawing routers walk the recovered trail into
    `current_stroke` *before* the event's own point. Two traps, both silent:
    the axes are **surface** coords while a gesture reports **widget** ones
    (offset taken from the event's own position, which is known in both), and
    `coord.time` is the **event** clock, not `GLib.get_monotonic_time()` — only
    the difference from the current event means anything, so `_note_sample`
    takes an `age_ms` and a frame's worth of samples never lands on one
    instant. It is guarded like the ink capture: extra samples are a bonus,
    and failing to get them must never cost the stroke. *This fixes SHAPE, not
    latency* — the newest sample is still only as fresh as the frame it came
    on, and 33.4 ms is two of them, so the canvas is also running at ~30 fps
    mid-stroke (an empty page manages 16.5 ms). Don't sell one as the other.
    `extras/device_rate.py` re-measures the raw rate below GTK.
  - **Latency: one recovery and one guess, kept apart.** `hover_lead_in` is
    free REAL data — a stylus is tracked in proximity, so the positions from
    just before contact are the ink that was otherwise lost; it walks backwards
    and stops at the first gap, or a pen swooping in from across the page draws
    its approach. `predict_point` is a GUESS and is confined to the screen:
    `_live_stroke()` adds the predicted tip, the commit path reads
    `current_stroke` which never contains it, so a bad guess flickers for one
    frame and can never reach the file. It extrapolates along an **arc**, not a
    tangent — out of the curve of an "o" a linear guess leaves the letter and
    is yanked back (8.6× the error at 40 ms). The guess is also damped across
    frames (`PREDICT_SMOOTH`), because it is rebuilt from scratch every motion
    event and consecutive guesses disagree by more than the pen moved; the
    **offset** is what gets damped, never the anchor, or the lag comes back.
    Both default OFF, and **prediction is settled: it cannot be the answer
    here (row 147).** The pen's end-to-end lag on this hardware is ~110 ms,
    measured two independent ways and shown to be UPSTREAM of the compositor
    (a hardware cursor plane lags the nib just as much), so it is not
    Sidemark's or Hyprland's to recover. Graded on 133 Hz ink, prediction
    recovers ~10% of the lag error at a 10–20 ms lead, ~0 at 40, and is
    NEGATIVE beyond — it makes things worse on a third of samples at best.
    Predicting 110 ms ahead means guessing the second half of a letter, which
    kinematics cannot know; a Kalman or learned model fits more parameters to a
    future that is not in the data. Don't build one. `PREDICT_SMOOTH_MS` is a
    TIME constant, never a per-event weight — as a weight it silently meant
    ~92 ms at 30 Hz and ~21 ms at 133, which is most of why prediction once
    measured as useless.
    Under a stylus the POINTER is hidden for drawing tools
    (`_hide_pointer`) — an arrow trailing the nib is what gives the lag away —
    but never under a mouse, where the pointer is all the hand has.
  - **Tune it on real ink, not on synthetic curves.**
    `SIDEMARK_CAPTURE_INK=<path>` appends every finished stroke's RAW samples
    (pre-interpolation) to a JSON-lines file, and `extras/ink_replay.py`
    replays, measures, sweeps and re-renders them. A record carries `pts`
    (document units, untimed) **and `samples`** — the same stroke in screen
    coords with a timestamp each, which is what `predict_point` sees live.
    Prediction is the one part of the pipeline that reads the CLOCK, so an
    untimed capture cannot grade it: the 41 strokes in `notes/` predate
    `samples` and can say nothing about the lead. `--predict` grades it, walking
    each stroke with the same window and EMA damping as the live path and
    scoring the arc against the no-prediction lag and against a linear
    extrapolation, broken down by curvature. Its ground truth is the
    digitiser's *later report*, so it measures how well the guess tracks the
    pen's path, **not** perceived latency — a prediction can score well here
    and still feel late. Its key statistic is
    **sample spacing ÷ feature size**: above ~0.25 the hardware is
    undersampling the writing and interpolation is carrying the result (write
    bigger); below ~0.06 the pen is oversampling and any roughness left is
    tremor, so denoising is the lever. That ratio is how to answer "is this
    fixable in software or is the hardware just too coarse?" — measure, don't
    guess. **Measured twice, and the second reading retired the first.**
    Before `motion_history` (row 147) the ratio was 0.337 — UNDERSAMPLED, ~3
    samples per x-height writing small — and the conclusion drawn was that
    small writing is an information limit and the denoiser must never be
    strengthened for it. That was a fact about the 30 Hz the canvas was
    *receiving*, not about the pen. At the pen's real rate the same hand
    writing SMALLER measures 0.091, "reasonable sampling", so **small writing
    is no longer information-limited** and that rule is void. What survives is
    the method: measure the ratio, don't guess. (Writing physically bigger
    still helps; zooming in still does not — the digitiser samples in physical
    space, so letter and spacing shrink together.)
  - **The denoiser is now near-inert, and that is expected.** Across its whole
    range the Taubin passes move the committed ink 0.11%→0.16% of an x-height
    (it was 0.44%→0.48% at 30 Hz): 0.0 and 1.0 differ by 0.05% of an x-height,
    which is nothing. It was never mainly removing tremor — it was cleaning up
    what INTERPOLATION invented between sparse samples, and there is little
    left to invent. The shaping is now done by `resample_ink`. Do not "fix"
    the slider by widening its range; if a stroke ever needs more filtering,
    the question is what changed about the sampling.
- **Page backgrounds (rows 139 + 140)** — `draw_page_background` rules a blank
  page (plain/lines/squares/dots) into the page CONTENT at creation: a
  background you write on is one you hand in, so it must print and export.
  `blank_pdf_file()` is THE blank page — New, `--new`, row 130's edge pull and
  `add_blank_page` all come from it, so a document does not go plain at page 2.
  Note `insert_page` cannot do this at all (it makes an *empty* page and the
  ruling is content), which is why an added page is built by cairo at the
  current page's size and merged with `insert_pdf`. *ceiling: fixed at creation
  — re-ruling later needs the row 118 optional-content machinery to know which
  pages are ours, and you can just make the page again.* PDF-only so far (the
  text sheet was offered and declined).
- **The divider is the way BETWEEN the modes (row 130)** — drag the notes
  panel to full width and the notes become the sheet; pull in from the sheet's
  LEFT edge and a page comes in beside it. It is a **VIEW state, never a
  conversion**: the PDF is still there behind the sheet, its notes are still
  per page, nothing is written either way, so a drag that crosses the line and
  comes back leaves no trace — which an accidental-drag-shaped gesture has to.
  - **`_full_notes_view()` is the whole distinction**, and it is the rule the
    codebase already had: a text-first page has NO `_path`. With one, the sheet
    is a view of the sidecar — **the whole file, markers and all**, the only
    way one buffer can hold a per-page model. The two paths that move text
    between buffer and model must say which they mean: `_commit_note_for`
    parses the sheet back (`set_from_text`), `_restore_note` fills it
    (`to_text`), and `_on_save`'s verbatim text-page branch is gated on `not
    _path` or a PDF's notes would be flattened onto page 0.
  - **The paned STAYS in text mode**, with the page side collapsed to zero and
    the sheet in the notes' slot (`_sheet_box`) — so the page *slides* in and
    out and the handle itself says there is something to pull. That needs
    `set_shrink_start_child(True)`: with shrink off the handle stops at the
    canvas's minimum and the gesture is unreachable on every window. The
    collapsed handle is the ONLY way back, so it wears a wide, visible grip
    (`page-edge`) — at the default width it is a few pixels hard against the
    window edge. And `_init_pane_position`, a realize-time idle that applies
    the default 62% split, must SKIP a text page: it fires after the mode is
    set, so applying it put the pages back and left the sheet in a corner.
  - **Quiet time stands in for letting go.** GtkPaned has no "drag finished",
    and the obvious substitute is a trap: `EventControllerLegacy` hands
    PyGObject a **NULL event** for some events, so reading
    `event.get_event_type()` crashes on the first move and the gesture never
    fires at all. `_on_pane_position` debounces instead (`PANE_SETTLE_MS`), and
    three things must gate it or it fires on its own: our OWN moves
    (`_mark_pane_programmatic` — an animation walks through the position that
    means the opposite switch), a window that is not mapped or is still being
    laid out, and a session whose tab has since closed. Miss the second and a
    headless test loop makes blank PDFs until it dies.
  - On a text-first page the pull makes an **untitled temp PDF**
    (`_blank_pdf_file`, shared with `New`/`--new`) — an accidental pull litters
    nothing beside the `.md`.
  - The view is remembered per document in `recent.json` beside the reading
    position (`_recent_full_notes`), for the same reason: it is a view state
    about a document, and a sidecar must not appear because you looked at one.
  - **The CARET crosses with you, both ways (row 162)** — the sheet opens at
    the page you were reading, and closing it turns to the page the caret is
    in. A page index and a character offset are two coordinate systems for the
    same notes, and `note_offset_for_page` / `note_page_at_offset` are the one
    marker table both read: two readings is how the caret comes back on a
    different page than it left. **Two of the answers cannot come from the
    offset**, which is why the session remembers the page the sheet was opened
    at *and* the offset it was opened at (`_full_notes_from` /
    `_full_notes_caret`): a run's shared body (row 129) says the RUN and not
    which of its pages you were reading, and a caret that never MOVED has
    learnt nothing since — which is also the only honest answer for a page with
    no notes, whose caret was parked in somebody else's section. Otherwise the
    caret's own marker wins. **On the way out, `_restore_note()` must run
    BEFORE the jump**: `go_to_page` commits the notes panel, and a panel still
    holding what it had before the sheet opened writes that back over the sheet
    edit. The jump is active-session only, or a background tab's page change
    paints the front tab's chrome. Scrolling the sheet there is
    `TextPageView.scroll_to_offset`, not `scroll_to_mark` — the view is a
    non-scrollable child and holds no scroll of its own.
  - **Replacing the sheet's text destroys every ink anchor.** A text page
    anchors each stroke and image to a `GtkTextMark`, and `set_text` deletes
    every mark in the buffer — so the drawings land in a heap at offset 0. The
    switch changes the text (a PDF's sheet has the page markers, a text page's
    does not), so it cannot be avoided; `_set_buffer_text` carries the anchors
    across. Two things about how, both learned from real ink:
    - It re-anchors the SAME objects (`anchor_records`/`reanchor`) rather than
      reloading them: `load_ink` rebuilds the dicts and clears the ink undo
      stack, so routing this through it makes every Ctrl+Z after a page load
      do nothing.
    - It passes a **`line_map`** (a `difflib` block diff of the two texts), and
      that is not optional. Most ink sits on BLANK lines, which all hash alike,
      so the sidecar's "nearest line with the same hash" rule can only guess
      between them — and it guesses PER STROKE, so a two-line shift moved the
      strokes of one drawing by different amounts and tore it apart. Measured
      on 29 real strokes: 23 changed paragraph and the vertical shift ranged
      over 161 px; with the map, one rigid translation and none changed.
      (The hash rule stays as the fallback — it is what handles a file edited
      outside Sidemark, where there is no old text to diff against.)
    Every path that replaces a notes buffer wholesale must go through
    `_set_buffer_text`.
- **HTML comments are hidden by default** (`MarkdownNotesView.show_comments`,
  the ☰ switch, persisted as `show_comments`). Not a special case for ours: a
  Markdown viewer renders no comment, and Sidemark's own per-page bookkeeping
  lives in them — on a sheet showing a whole sidecar they would be most of what
  is on screen. A whole-line comment hides its NEWLINE too, or a hidden marker
  still costs a blank line. Revealed on the cursor line like every other
  marker, rendered as nothing else (a marker is full of things that would read
  as maths), and never removed from the file.
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
  `_parse_note_link()` resolves the body into `{path, page, anchor, label}`.
  Rendering keeps the brackets hidden off the cursor line but leaves
  link/`code` contents verbatim — the parsing lives in
  `_notes_to_pango_markup` / `_split_markup` (`_MD_LINK_RE`, negative
  lookbehind so the `![[embed]]` line is left alone). When extending linking,
  keep link targets un-mangled and test both same-doc and cross-doc forms.
  - **A LINK POINTS AT A NAME (row 165)** — a bookmark (row 134) or an outline
    heading, the two things here that have both a name and a page:
    `[[#Eigenvalues]]`, `[[l2.pdf#Chapter Two]]`. That is not a syntax
    preference, it is the fix for the defect: nothing re-keys a `#page=N` when
    a slide is inserted, a chapter is dragged (row 123) or two decks are
    merged, while a bookmark follows its page. **The page forms stay readable
    for ever** — written notes are full of them — they are just never what the
    picker offers.
  - **`document_anchors()` indexes a document that is not open** (headings from
    the PDF, bookmarks parsed straight out of the sidecar's markers), cached on
    BOTH files' mtimes because what changes anchors is often not ours. The OPEN
    document is read LIVE (`_own_anchors`) instead, or a bookmark you have just
    made — precisely the one you are linking to — would not resolve until you
    saved.
  - **`_resolve_note_link` is the ONE resolver**, for following, for the
    strike-through and for the hover preview. Two would drift, and a link that
    looks live and does nothing is the worst of the three.
  - **A dead link is struck through, never under the caret**: a target is
    unresolvable for most of the time you spend typing one. The per-view memo
    EXPIRES (5 s) rather than being invalidated — another window edits what it
    resolves against — and `_populate_toc` drops it explicitly, since that runs
    on exactly the edits (bookmark, rename, outline) a dead link is waiting for.
  - **Discoverability is part of the feature, not a garnish**: ☰ *Link to a
    page…* / Ctrl+K inserts `[[]]` and opens the picker, so the entry teaches
    the syntax by leaving it on screen; ☰ *Copy link to this page* is row 100's
    link-to-here. A `#` in the query switches the picker to that file's names.
  - **The way BACK is part of following one**: `_link_return` remembers where
    the click came from and where it landed, and the notes header shows
    "↩ Back to p.N" only while you are still on the page the link put you on.
    Asking "am I where the link left me?" is what retires the offer by itself
    — no timer, and never a stale jump to somewhere you left ten pages ago.
  - **The picker anchors to the LINE, not to a point** (`_position_link_popup`,
    `halign=START`). Given a zero-height anchor GTK centres the popup on it and
    flips it back over the very text you are reading — the `[[` you just typed.
  - **PREVIEWS ARE DEFERRED (row 166), and the row is worth reading before
    rebuilding them.** Hovering a link and `![[embeds]]` both shipped and were
    both pulled the same day after a GTK abort ("Byte index N is off the end of
    the line") in the notes editor. **That abort is now understood and fixed**
    — it was `get_iter_at_location`, not the previews (see the crash note under
    Logging) — so the precondition for rebuilding them is met. The design that
    survives is in row 166, including which parts were sound: the marker, not
    the caret; a tag's `pixels-below-lines` rather than a paintable; a tooltip
    rather than a popover.
  - **`![[target]]` is an EMBED: the same link, showing the page it leads
    to**, under its line (`_MD_EMBED_RE`, `_sync_inline_preview`,
    `_snapshot_inline_preview`). Obsidian's syntax for exactly this, and
    already Sidemark's own — a sidecar's first line is `![[lecture.pdf]]`.
    `[[!target]]` would be neither, and was asked for; say so. **The MARKER
    decides, never the caret**: a preview that came and went as you moved
    through the text could not be read. `_MD_ANY_LINK_RE` is what most of the
    grammar wants (both forms follow, both render their body verbatim); the
    `!` only changes how many brackets are hidden and whether a page is drawn.
    The picker INSERTS the embed form — you asked for a link to a page, and
    the page is what you meant — and typing `[[` yourself keeps the plain one.
    - The space is a **tag** (`pixels-below-lines`, one per height via
      `_gap_tag`), so the notes below MOVE DOWN and the picture never lands on
      your writing. It cannot be a paintable in the buffer, which is what
      "render it like `\alpha`" would mean: symbol rendering swaps text for
      text, while a paintable is a real character — and this buffer IS the
      `.md` source, spliced back through a character-to-character index map.
    - Renders are memoised on the target string (`_rehighlight` runs per
      keystroke, over every line) and dropped by `forget_previews()` when the
      document changes. One per LINE — a second embed on the same line is just
      a link, because a line has one gap.
    - The sheet is the same widget, so text-first mode gets it unchanged.
  - **Every other link answers on HOVER, and that preview is a TOOLTIP
    (`query-tooltip`) — not a shortcut.**
    A popover is a real surface: shown near the pointer it takes the crossing,
    the view gets a LEAVE, the preview hides, the pointer is back on the link
    — and it oscillates. The symptom was a preview that appeared once in a
    while, mostly when you clicked. Tooltips keep away from the pointer by
    construction, never take it, and time themselves. `set_tip_area` is what
    stops it re-rendering the target page on every motion event.
  - *Not built: backlinks (row 100 item 4) — it needs a cross-file index and an
    invalidation story, and should wait until naming targets proves itself.*
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
  UI is one checkbox in the notes header (`_update_notes_link_ui`). A run of
  pages that carries nothing else is written as ONE **range** marker
  (`<!-- page:13-40 continued -->`) — the fact is about the run, not about each
  page; the reader expands a range and still accepts the per-page form, so old
  files need no migration, and a bookmark (a property of ONE page) breaks the
  range and takes its own marker. **The tick
  CASCADES**: `link_forward` carries the run through every following page that
  has nothing of its own, stopping at the first page that already has notes
  (`link()` would append it into the run — the one outcome you cannot see
  coming from a checkbox); `unlink_forward` breaks the run at that page and
  every page after it. One tick covers a run of slides, one untick undoes it.
  **A page inserted INSIDE a run joins it** (`shift_for_insert`), and that is
  not a nicety: the body is stored once, so breaking the link at the gap does
  not split the notes in two — it DELETES them from every page after the
  insertion point, and the pages look fine until you read them. It shipped that
  way in both apps, asserted by a test phrased "the tail is cut loose", which
  reads like a decision until you count the pages it empties. The question is
  asked BEFORE the shift and can only be true when the old page at `idx` was
  itself continued; at a run's START the blank pages precede it and the run just
  moves. The invariant to test re-keying against is **no page loses its text**,
  never "page N equals page M" — an insert inside a run legitimately gives the
  NEW page the run's text too, and an equality has to be relaxed to allow that,
  which is exactly how the loss went unnoticed.
  **Ctrl+Z reaches it**, as a `("links", snapshot)` op on the shared
  `_undo_timeline` — a whole-model `snapshot()`/`restore()`, because linking
  MERGES two bodies and no page/text pair describes that. A snapshot is keyed
  by page index, so any re-paging (insert/delete/reorder) DROPS the link ops
  (`_drop_link_timeline_ops`) rather than replaying them onto moved slides.
- **Bookmarks (row 134)** — a page can be marked, and the marks live in the
  SAME sidecar marker as the row-129 link flag: `<!-- page:13 bookmark -->`,
  `bookmark="Eigenvalues"` when renamed, composing with ` continued`. A name is
  escaped on write, and escaping `>` is what makes `-->` unrepresentable, so a
  name can never terminate the comment it lives in. **A bookmark needs no
  adjacency rule** — that is the whole difference from a link: a link is a
  relationship BETWEEN pages so every re-key must ask whether it survived, a
  bookmark is a property OF one page so it just follows it (and a deleted page
  takes its bookmark with it). **The label is derived, never stored** (the
  page's first `own_text` line, else its chapter, else nothing) so editing
  notes cannot leave a label describing what used to be there; renaming stores
  one that then wins. `_sync_bookmark_chrome` is the single place deciding
  where the verb lives — the header button when there is room, the ☰ menu entry
  when the header has collapsed, never both — and `_new_bookmark_list` is the
  single builder behind both list widgets. PDF-only.
  - **Making one and destroying one are both a moment, and both are handled
    there** (row 152). Adding opens the name field with the derived label in it
    and SELECTED (`_prompt_bookmark_name`), so the first keystroke replaces it
    — a bookmark you must go and rename later is one you name never. **The
    field IS the add**: nothing touches the model until Enter, so Escape leaves
    the page unmarked and the file not even dirty, and there is no
    create-then-undo to get wrong. (Storing the mark on the click and letting
    the popup edit it kept Ctrl+B a stricter one-key verb, and was rejected in
    the hand.) The header toggle flips itself on the click that opens the
    field, so cancelling must put it back; and with no chrome on screen to
    anchor the popover to, the bookmark is created UNNAMED rather than silently
    not at all. Committing the suggestion unchanged stores NO name, or the
    derived label would freeze into the file. Removing asks first, through one confirmation
    every path routes into (`_drop_bookmark` asks, `_do_drop_bookmark` acts) —
    with no "don't ask again", unlike the page-drop dialog: the name is stored
    nowhere else, and an opt-out is one stray click from losing the guard for
    good. A cancel must re-sync the header toggle, which already flipped
    itself on the click that opened the dialog.
  - **A second click RENAMES, it does not remove.** The page is already marked,
    so the useful verb is "say what this is" — the list opens scrolled to that
    page with the name selected. A stray click on a toggle must not raise a
    confirmation dialog. In the outline a **double-click** renames: F2 works
    too, but only once the list has keyboard focus, and a single click
    activates the row and takes focus with it, so by hand the key alone meant
    "click, click again, then F2". A rename's **focus-leave is delivered after
    the fact**, so `finish` is guarded by that edit's own token AND checks the
    entry still has its box as parent — a list rebuilt in between otherwise
    leaves it removing a child from a box that no longer owns it. **And the
    leave DEFERS to an idle**: ending the edit destroys the very widget GTK is
    moving focus out of, and doing that inline makes GTK go on walking a
    widget with no parent — `gtk_widget_get_parent` assertions without end
    (millions, not a handful). Enter and Escape are not inside a focus change
    and stay immediate.
  - **Where you are in the outline is a LINE when no entry names your page**
    (row 153). On an entry's own page that row gets the solid bar and a bold
    title; anywhere else a rule carrying the page number is inserted BETWEEN
    the two entries you fall between, and the containing entry keeps only a
    faint tint (a tint alone was too little to find while presenting). The line
    counts every row — chapters, sub-entries and bookmarks alike — because "the
    entry above me" is whatever is actually above me in the list; ignoring ★
    rows would point at a chapter several screens up. It is inserted and
    removed, never moved, so a stale second line is impossible, and it is
    neither selectable nor activatable: a row you could click would be a
    destination that does not exist.
  - **The document's OWN headings rename and delete the same way** (row 159):
    double-click, or right-click for both verbs. The sidebar is one list to the
    reader, so `_begin_rename` no longer knows what it is renaming — the ROW
    carries `_rename_read`/`_rename_write`, and `_attach_row_menu` builds the
    menu for both kinds. A heading writes into the PDF's outline (`set_toc`),
    so it dirties the FILE. An empty title is refused (a heading with no text
    is unreachable in other readers, and deleting is its own verb), and
    deleting **promotes the subtree by one level explicitly** — leaving that to
    `normalize_toc` promotes only the first orphan and hangs its siblings
    under it. The menu also changes an entry's PAGE and adds a heading or
    sub-heading **on the page of the row you clicked**, never the page you are
    viewing; a sibling lands after that row's own children. A double-click
    opens title and page together, the page field standing IN PLACE OF the page
    number (a row showing the page twice makes the untypeable one look
    editable), and both are written in one `set_toc` — separate writes rebuild
    the sidebar under the edit that is still running. **A move between the two
    fields is not "clicking away", and testing that needs the WINDOW's focus
    widget**: a `GtkEntry` delegates focus to an internal `GtkText`, so
    `entry.has_focus()` is False even while you type in it — the guard silently
    never fired and clicking the page field ended the rename.
  - **Bookmarks are outline entries too, and can BE the outline** (row 153).
    The Outline/Pages switch appears when the document has a TOC *or*
    bookmarks — a lecture deck rarely has a TOC and is exactly what you
    bookmark your way around — and a "Bookmarks" tick-box appears beside it
    only when there are some (persisted app-wide as `outline_bookmarks`). They
    are **merged INTO the outline's own order**, never sorted with it: each one
    is emitted before the first entry starting after its page, and a bookmark
    on the same page as an entry follows it. Re-sorting the whole list by page
    looks identical on a well-formed outline and silently hands a chapter drag
    the wrong span on one whose entries are out of page order, because
    `chapter_no` indexes `chapter_spans` in TOC order.
- **Search finds the FIRST match synchronously and the rest in the background
  (rows 154 + 155).** A keystroke may spend `SEARCH_SYNC_MS`; the remaining
  pages go to the idle loop in `SEARCH_CHUNK_MS` slices — scanning every page
  before returning is most of a second per character on a large PDF, and the
  next keystroke throws it all away. Pages are scanned from where you ARE,
  forwards, then wrapping, so the first hit found is the one you would have
  gone to anyway. What holds it up:
  - **The match list is ordered by PAGE and rebuilt as hits arrive**, never in
    the order the scan found them, and the current match is re-found by
    IDENTITY (`_rebuild_search_matches`) — a hit landing ahead of it renumbers
    the label without moving you.
  - **The count says when it is still climbing** (a trailing `…`) and **"not
    found" waits for the scan to finish**, or every long document flashes red
    at a term that is in it.
  - **Stepping off the end of a partial result set finishes the scan first**
    (`_step_search` → `_finish_search_scan`): wrapping to match 1 with pages
    unread silently skips everything between here and the end.
  - A tail of `SEARCH_SYNC_TAIL` pages is finished on the spot — deferring it
    costs more than doing it, and it keeps an ordinary document's count final
    the moment you stop typing.
  - **The idle slice reads its state through the ACTIVE-session proxies**, so
    it parks when its tab goes to the back and `_activate_session` restarts it
    (`_scan_session` is the check). Without that, a background tab's scan
    writes its hits into the front document's table.
  - **A notes hit is not scrolled to by `scroll_to_iter` on the sheet** — the
    sheet holds no scroll of its own, so `_select_note_match` takes
    `TextPageView.scroll_to_offset`; and on a PDF's full-notes sheet the hit's
    offsets are into ONE page's notes while the buffer is the whole sidecar, so
    they are rebased through `note_offset_for_page(run_start(page))`.
  - **Ctrl+F keeps the term and SELECTS it** rather than clearing: typing
    replaces it, Enter searches it again. `grab_focus` selects only when focus
    ARRIVES, so the explicit `select_region` is there for the case the feature
    is *for* — pressing Ctrl+F with the caret already in the entry. `_hide_search`
    keeps the text and drops the results, which is why Enter on a reopened bar
    re-runs the search instead of stepping through nothing.
- **The page counter and the bookmark toggle belong to the WINDOW, not the tab**
  (row 156), so `_sync_page_chrome()` is the one place that points them at the
  active document's page — called by the canvas's page-change callback *and* by
  `_activate_session`. Every structural change (add, delete, insert, reorder,
  merge) fires the callback through `PDFCanvas._load_page`, so those were never
  the problem; a TAB SWITCH changes which page is in front without any page
  changing, and so fires nothing at all.
- **The thumbnail strip selects like a text editor** (row 171): SHIFT marks the
  region from the anchor to the clicked page, CTRL adds or removes one, and a
  plain click starts again from there — one anchor shared by both, so Ctrl to
  pick a start then Shift to take the run works, and Ctrl+Shift adds a second
  region. It is ONE capture-phase handler (`_on_thumb_select_pressed`) and
  cannot be left to `GtkListBox`: the row carries a `DragSource` in the same
  phase which swallows a stationary press, so Ctrl never deselected and Shift
  never reached the listbox's range code at all. A Shift press is CLAIMED, so
  the row is not activated — marking a region is not a request to go to its last
  page — while a plain press falls through and still turns the page. The anchor
  is per session and dropped by `_populate_thumbnails`, since the rows it
  pointed into are gone.
- **Hidden pages (row 158)** — a page can be set aside: still in the document
  and still editable, but **skipped when paging, skipped when presenting, and
  left out of an export** (the PowerPoint "hide slide" meaning, not a sidebar
  filter). Right-click a thumbnail for Hide/Unhide. The flag lives in the same
  page marker as the row-129 link and the row-134 bookmark (` hidden`) and
  **ranges** like `continued` does — hiding a block of slides is one fact about
  a run — so the coalescing rule is now "same attributes, no body, not
  bookmarked" rather than a special case; a bookmark still breaks a range
  because it names ONE page. Like a bookmark it needs no adjacency rule.
  - **Skipping is resolved ONCE per navigation.** `_flip_visible` is the single
    entry that consults `next_page_for` (scroll-past-edge included);
    `_flip_page` takes a plain delta. Resolving in both is how paging from 1
    over a hidden 2–4 lands on 7 instead of 5.
  - **Only RELATIVE navigation skips.** A thumbnail click, a link and a
    bookmark still open a hidden page — that is what keeps it reachable and
    editable, and the dimmed row in the strip is the only way to select it
    again and bring it back.
  - The canvas has no notes model, so it asks the window through
    `next_page_for`, which takes the **session** rather than reading the
    active-tab proxies.
  - `_pages_acted_on` is the one rule for which pages a per-page verb applies
    to — the multi-selection when the clicked row is in it, else that row alone
    — shared with the drag-export so the two cannot disagree. The menu offers
    the verb that CHANGES something (Hide unless all are hidden), so a mixed
    selection needs no thought. PDF-only, like bookmarks.
- **Reopen where you left off** lives in `recent.json` (`_recent_page` /
  `_remember_recent_page`), NOT the sidecar: a sidecar appears only once you
  write something, and storing the reading position there would drop a `.md`
  beside every PDF you merely glanced at. Two traps: loading fires a page-0
  change, so `_restoring_page` stops it erasing the position it is about to
  restore, and the write must NOT re-order the list or "recent" comes to mean
  "whatever tab I scrolled in last".
- **An empty launch reopens the LAST DOCUMENT, and the scratchpad is the
  recents list's last resort (row 161).** `_open_last_document` walks
  `recent.json` and stops at the scratchpad entry — nothing below it is newer.
  Which makes the list the ONLY way into the scratchpad, so
  `_seed_scratchpad_recent` (called from `open_new_window`) creates the file
  and seeds it at the **TAIL**, never the front — at the front it would be "the
  last document" and every launch would reopen it, which is the behaviour this
  replaces — and `_add_recent` **pins** it against `RECENT_MAX`, dropping the
  oldest ordinary file instead. `_scratchpad_path()` is the one name for it.
  **"Recent" means last USED, not last opened**: every close refreshes the
  entry (`_touch_recent`, from `_remember_closed` for a tab and from
  `_destroy_all` for a window — oldest first, ACTIVE tab last), or opening A
  then B and working in A hands you back B.
  **And the walk SKIPS what is already on screen** (`_documents_open_elsewhere`,
  every window of the app): a second bare launch is a request for ANOTHER
  document, and the newest recent is by then the one in front of you. If the
  scratchpad itself is open, the fallback is a fresh blank sheet rather than a
  second view of one file — two windows saving one `.md` loses writing.
- **The thumbnail strip scrolls for a REASON, never as a side effect.** Opening
  it, or turning the page, brings the current page into view; a rebuild
  (`_populate_toc` runs on every bookmark, link, rename) puts the strip back
  exactly where it stood — `_thumb_centred_page` is the "is this a new page or
  the same one?" answer, and a document change clears it. Both paths go through
  a RETRY (`_scroll_thumb_into_view` / `_restore_toc_scroll`): the reveal is an
  animation and a rebuild has no allocation yet, so at the instant you are
  asked every row reports y=0 and the adjustment has nothing to scroll — which
  is why the strip used to open at page 1 whatever page you were on.
- **Ctrl+R reloads the CODE, so everything else has to be written down (row
  157).** It spawns a standalone process, so `session_state()` records every
  tab that has a file, the page each is on, which was active, and the window's
  view state; `--restore` hands the child a temp JSON file, which is **consumed**
  — read once and deleted whatever happens — so a stale session cannot come
  back twice. Neither an unreadable state nor a file deleted since is fatal: a
  poor reload beats a crash on startup. The divider position must be applied
  from a **LOW-priority idle**, because `_init_pane_position` is a realize-time
  idle applying the default 62% split and silently overwrites anything set
  before it. A tab with no file (an untitled blank) is dropped — there is
  nothing on disk to name — and multiple windows are out of scope: Ctrl+R
  replaces the window it was pressed in. It asks about **every dirty tab**, one
  at a time, bringing each to the front first: a reload replaces the whole
  window, so a tab you never looked at would lose its edits unmentioned, and a
  single "save all?" cannot offer "discard this one, keep that one".
  Cancelling any of them abandons the reload.
- Single-instance app (`Gio.Application`, `HANDLES_COMMAND_LINE`): a second
  launch forwards its argv to the primary, which opens the file as a tab in the
  last-used window (`_open_target`/`open_file_in_tab`). For manual testing
  always launch standalone: `SIDEMARK_STANDALONE=1 /usr/bin/python3
  sidemark.py [FILE]` (the env var sets `NON_UNIQUE` so it bypasses the running
  instance — Ctrl+R reload uses the same trick to re-read the code).
- **`--tmp` is a scratch document that closes without a word** — `--tmp` for a
  blank page, `--tmp --new-text` for paper. It is a MODIFIER on `--new`, not a
  third kind of document, and a named path beats it (a file you named is a file
  you care about). `_asks_to_save()` is the ONE predicate behind the tab close,
  the window close and the autosave skip — a throwaway leaves no recovery
  snapshot either, or the next launch nags about a page you threw away.
  `_new_blank_document` is the one place a launch flag makes a blank document,
  so the mark lands on the session the ☰ actions just created.
- **A COPY of the app is a different app.** `_copy_key()` is the one answer to
  "is this the installed script or a checkout?" — `""` for an installed path,
  else a hash of the source path (`SIDEMARK_INSTANCE=<name>` forces one). It
  suffixes both the GApplication id AND `settings.json`, so smoke-testing a
  checkout can neither join the running instance nor rewrite the button table,
  pen width or font size of the app you actually work in. Recent files
  (`recent.json`) stay shared on purpose — a copy is a different app, not a
  different person. Answer that question in one place or the two drift.

## Testing & verification

- `./run_tests.sh` runs `test_pdfeditor.py` inside a **headless Weston
  compositor** (GTK4 has no offscreen backend — never use
  `GDK_BACKEND=offscreen`; needs `weston` installed). Pytest args pass through
  (`./run_tests.sh -x test_pdfeditor.py::SomeTest`); `./run_tests.sh --stop`
  tears the compositor down.
- **The bare command is the FAST TIER (606 tests, ~18 s), and that is the
  default on purpose.** `--full` is all 905 (~140 s). The window tier — classes
  building real windows, auto-marked by `conftest.py` from the class source —
  is 299 tests and **87% of the runtime** (~410 ms each against ~30 ms), so
  making the expensive tier need a deliberate flag is what keeps a reflex from
  costing two minutes and a hot laptop. A misclassified test still *passes*, it
  just lands in the wrong tier. Asking for a test **by name** (`-k`, a `::`
  nodeid) overrides the tier and gives you that test, window or not — a
  selector that silently matches nothing is the worst failure a selector has.
- **You rarely need `--full` at all: CI runs the whole suite on every push and
  PR** (`.github/workflows/ci.yml`). Let the runner spend the two minutes.
  Keep `--full` for a release, or for a change whose blast radius you genuinely
  cannot bound (a shared constant is the usual case — one did break a test
  outside the class being edited).
- **Run the NARROWEST thing that could tell you something.** `-k <the classes
  you touched>` after each behavioural edit, the bare command at milestones,
  and nothing at all after a mechanical rename — it almost never finds what a
  targeted run didn't.
  Three traps that waste more time than the tests do: a long run is
  backgrounded, so start it, do other work, and read the output file **once**
  — polling it with short sleeps buys nothing, and an `until … sleep` loop
  OUTLIVES the run it was watching and respawns its `sleep`, so it must be
  killed at the parent shell (one span two hours here); never run two suites at
  once, since they share one compositor and both thrash; and never re-run a
  suite on an unchanged tree because the output was hard to read (fix the grep
  instead).
- **Test what could break by ACCIDENT, not what someone would change on
  purpose.** An assertion naming a tuned value — or echoing the constant that
  holds it, which is the same thing in disguise — can only fire when somebody
  edits it deliberately, so it is a speed bump on intentional change and no
  safety net at all. `INK_DOT_BOOST` has moved five times; the invariants
  worth pinning are that a dot is clearly fatter than the line beside it and
  fades out with length. Constants belong in assertions as **bounds**
  (`assertLess(near, INK_RESAMPLE_SPACING)`) or **identifiers** (`BTN_LEFT`),
  not as expected values. Same trap in a different coat: asserting a *proxy*
  for the behaviour (a point count standing in for "the line was resampled")
  breaks on correct changes and misses real ones.
- **Settings are isolated per run and per test.** `run_tests.sh` points
  `XDG_CONFIG_HOME` at a throwaway dir and a conftest fixture deletes
  `settings.json` after every test. `Bindings.save()` persists on every rebind,
  so without both the suite rewrote the *user's* button table and every later
  window test routed presses through whatever the last run left behind — a test
  that passes alone, fails in a suite, and blames the wrong feature.
- Tests set `SIDEMARK_TEST=1` and use the system `/usr/bin/python3` (not venv
  shims). Window tests build a real `PDFEditorWindow` inside a throwaway
  `Adw.Application` and pump the main loop (`_settle()` pattern — copy it).
- **Showing a `Gtk.Popover` in a PRESENTED test window kills the compositor.**
  It creates a Wayland surface the headless Weston cannot give, and weston
  dies — taking the rest of that run with it, so every later window test fails
  at `Gtk couldn't be initialized` and looks like a bug in itself. Reach popup
  UI through an UNPRESENTED window (`_run_in_window(present=False)`): the
  widgets that pop up guard their show on `get_mapped()` and fill their model
  either way, which is the seam to assert on. Same failure with another cause:
  a stale `$RT/$SOCK` after a crash or `--stop` — `run_tests.sh` now removes
  one unless the weston process is actually alive.
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
- **Editing `ideas.csv` from a script: force LF** (`csv.writer(f,
  lineterminator="\n")`, and read with `open(p, newline="")`). Python's csv
  writes CRLF by default, which churns all ~144 rows into the diff and buries
  the one line you added. `extras/sync_issues.py` — which owns the **Issue**
  and **Hash** columns, writing them back after it syncs a row to GitHub, so
  those are never yours to hand-edit — does this for the same reason, and its
  `validate_csv()` is the cheap check that a row you appended is well-formed.
- **Wayland file DnD** needs `Gtk.DropTargetAsync` + a drag-motion handler
  returning an action, or the drop never fires (portal transfer).
- **GTK4 popovers**: never popdown one popover and popup a sibling on the same
  widget synchronously — defer to the "closed" signal. And **tear one down with
  `_drop_popover`, never a bare `unparent()` in its own `closed` handler**:
  `unparent()` can itself emit `closed`, so the one-liner re-enters and
  unparents a widget that no longer has a parent. That prints
  `gtk_widget_get_parent: assertion 'GTK_IS_WIDGET (widget)' failed` and is not
  fatal, which is exactly why it ships.
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
  are exactly TWO stated exceptions today, both for the same reason — a
  text-first page is one endless sheet with no page structure: linked page
  notes (row 129) and bookmarks (row 134).
- **Never destroy a widget from inside the signal that is acting on it.** A
  `focus-leave` handler that removes the entry it belongs to (and rebuilds the
  list holding it) leaves GTK walking a widget it has just unparented — a
  `gtk_widget_get_parent` assertion **per iteration, for ever**: 3.5M lines and
  a killed process in one measurement, not the handful you see scroll past.
  Defer the teardown to a `GLib.idle_add`; the signal itself must only note
  what to do. The same shape hides in "closed" handlers (see the popover note
  below) and in any `clicked` that repopulates the list its button sits in.
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
    **Which is why the sheet has to coast on its own (row 175)**: GTK's kinetic
    scrolling belongs to the ScrolledWindow that never sees the event. The
    `KINETIC` flag on our controller is the whole of the "touchpad only" scope
    — GTK emits `::decelerate` only after a CONTINUOUS scroll, so a wheel notch
    keeps its instant `WHEEL_PAN_STEP` — and it hands over a velocity and
    nothing else, so the curve is ours: `KineticGlide`, exponential with
    `GLIDE_TAU_MS`, one class rather than a handler per surface. **That
    velocity is px/SECOND, whatever `::decelerate`'s documentation says**
    (`GLIDE_VEL_PER_MS`): GTK computes it as delta×1000 over event times in ms,
    and its own ScrolledWindow feeds it to a solver clocked in seconds. Reading
    the doc instead of the code is how the sheet shipped coasting ~1000× too
    far while the sidebar beside it felt right — and the two read the SAME
    signal, so when one surface scrolls unlike the other, suspect what is being
    READ before the curve. τ is now GtkScrolledWindow's own friction of 4/s
    (250 ms), because every other scrollable surface here IS a plain
    ScrolledWindow and one app settles at one rate; the 2.5×
    `MAGIC_SCROLL_FACTOR` it puts on both its drag delta and its flick velocity
    is deliberately not copied, since the sheet pans a surface delta
    one-for-one — **the invariant is that a flick carries on at the speed your
    fingers were moving the sheet**, not the number. `SIDEMARK_GLIDE_DEBUG=1`
    logs what each flick actually reports. Two things it
    must get right. The frame step is the **integral** of the decaying velocity
    across the frame (`glide_frame`), never `v × dt` decayed afterwards, or a
    coast travels further at 30 fps than at 60 — and a dropped frame under a
    relayout is exactly when that shows. And it **stops on anything that is a
    hand**: a fresh scroll, a press, a pinch, a programmatic
    `scroll_to_offset`, plus the end of the document, which it learns from the
    adjustment refusing to move (`_glide_scroll` reports that) rather than by
    measuring the extent. PDF pages are deliberately not in this: a scroll
    there flips the page at a boundary (`_handle_boundary_flip`), and a
    momentum glide into one would fling you through slides — a different
    feature needing its own judgement, not a parity gap to close quietly.
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
- **`buf.get_text(…, include_hidden_chars)` must be TRUE wherever the text is
  compared against an OFFSET.** A `GtkTextIter`'s line offset always counts the
  invisible characters; text fetched without them is a shorter string, so the
  offset points somewhere else in it — one place per hidden marker earlier on
  the line. The notes editor hides markers on every line the caret is not on,
  which is *most* lines, so this fails exactly where the feature is used and
  works while you test it with the caret in place. It killed two things at
  once (row 165): `_link_target_at` could not match `[[…]]` at all once the
  brackets were hidden — no hand cursor and no Ctrl+click — and
  `_cursor_line_and_col` shifted the `[[` query, so the picker stopped opening
  on any line that already had a link or a rendered symbol. Read it back the
  way the buffer stores it, or convert the offset first; never mix the two.
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
  **It is EVERY mark on the line, not just those two.** GtkTextView anchors a
  live double/triple-click selection drag to a pair of anonymous marks and
  re-derives the selection between them on each motion event — collapsed by
  the rewrite, they re-select nothing, so a selection made over rendered maths
  disappeared a moment later with no signal naming the culprit.
  `_buf_replace_line` walks the line by COLUMN collecting marks (never with
  `forward_char`, which reports failure when it lands on the buffer's end
  iterator — a real position, and the one the last line's marks sit on).
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
- **The pen belongs to the APP, not to a tab or a run** (`PEN_SETTINGS`). Every
  value the pen popover offers — width, colour, both highlighter ones,
  smoothing, smear trim, prediction, hover lead-in, live smoothing, shape snap
  — is loaded by each `PDFCanvas` at construction and written by
  `_set_pen_setting` to **every open canvas** and to `settings.json`. A text
  sheet needs nothing: `TextPageView` reads its session's canvas. Two things
  the table exists to prevent: a new tab handing back the stock blue pen after
  you picked red (it took the hardcoded defaults, and only `pen_color` was ever
  pushed onto a canvas, once, from the theme accent — which is now the
  *fallback* for an unpicked colour), and a saved value reaching the ink
  pipeline unvalidated, since `settings.json` is a plain file a user can edit.
  The accent fallback is applied per tab.
- **One table, not two**: `Bindings` (which button runs which tool),
  `zoom_factor_for_scroll` (scroll→zoom rate),
  `erase_radius` (what counts as touching ink),
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
  - **A HOLD IS NOT A FREEZE (row 160).** A hand holding a pen against glass
    drifts, so both dwells share ONE forgiving tolerance (`HOLD_SLOP_PX`) —
    there is one hold time to learn, so there is one slop. **They measure from
    different origins and that is the design**: circle-to-lasso from where the
    press LANDED, so a slow drag across the page can never become a selection;
    the shape dwell from wherever the pen was last MOVING, because you draw a
    shape and then stop. Never re-base the lasso anchor to be kind to a slow
    drag — that is the case the press origin exists to reject. The dwell's
    anchor is the load-bearing half: `_arm_straight_timer(at)` is called only
    once the pen has travelled past the slop from `_straight_anchor`, because
    re-arming per motion event lets a shaking hand restart the clock for ever
    and the dwell can never fire, whatever the tolerance. Both surfaces re-arm
    from their own motion handler, so a fix to one of them is invisible.
  - **An ELLIPSE stays resizable while the pen is still down (row 179)**, and
    it needs its own verb because it has no control point to keep hold of — it
    is a sampled curve, deliberately excluded from `shape_vertices`. So the
    whole shape scales about the centre the dwell found, by how much further
    out the pen has travelled (`ellipse_resize_state` / `resized_ellipse`,
    shared by both surfaces and ported to the web). The scale is **PER-AXIS**:
    the pen changes the RATIO and not merely the size, which is the box-handle
    verb every other selected shape already has — sideways widens, down
    heightens, the corner does both. It shipped UNIFORM first, on the argument
    that the dwell had already answered what shape this is; the user's answer
    was that stretching is the point, so that argument is dead. What survives
    of it is `circle_axes` having the last word: within its tolerance a circle
    stays a circle under a shaking hand, and past it you get the oval you were
    plainly asking for (*ceiling: a 12% dead zone around square, so the very
    flattest ovals are unreachable from a circle — lift and draw one*). An axis
    the pen had no LEVER on when the dwell fired follows the other
    (`ELLIPSE_LEVER_MIN`), because dividing by a near-zero offset turns a pixel
    of tremor into a large factor — a circle snapped at its equator would
    otherwise flatten the instant it moved. Recording the pen's OWN offset at
    the dwell is what makes the first motion event scale by exactly 1 on BOTH
    axes; a shape settling under a hand that has not moved is the defect. `sample_ellipse` rounds the sample count up to a **multiple of
    four** so the ring lands on all four extremes and its bounding box IS the
    ellipse's box — everything here re-derives geometry from the points rather
    than storing it (the `rect_bbox_of` pattern), and off a multiple of four
    the re-read centre and axes are a hair out. A rectangle and a grid divider
    are still frozen by the dwell.
- **Geometry you STORE must not go through the int-truncating coord helpers.**
  `window_to_buffer_coords`/`buffer_to_window_coords` only take ints, so a
  per-point conversion rounds every point on the way in *and* out. Invisible
  for a move (all points shift alike); it made a *rotated* stroke go lumpy, and
  compounded on every re-anchor. `TextPageView._overlay_to_buffer_f` /
  `_buffer_to_overlay` take the origin once and add the float delta — use them
  anywhere the result is persisted. Plain `_overlay_to_buffer` (int) is for
  hit-testing only. Symptom to recognise: shapes degrade a little per edit.
  A neighbouring trap: **`translate_coordinates` returns the POINT** — or
  nothing at all when the widgets share no root — never a `(ok, x, y)` triple,
  whatever the C signature suggests. Unpacking three raises at the first call.
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
  **To audit parity, reuse row 116's method**: walk `Bindings` × {pdf, text},
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
    both canvases). A red **delete** cross rides directly below it (row 138,
    `lasso_delete_*`), appearing under the same condition and calling
    `delete_selected_strokes()` — the Delete key's own op, so there is ONE
    delete verb. It is a bare red cross — no ground — against the chip's
    filled square: colour and shape are the only guard on a destructive target
    sitting next to a harmless one, so keep them distinct and keep their hit
    regions disjoint. Its PAINT is light, its hit box is not (full chip size)
    — never shrink the target to match the ink. **Any tap target on a canvas
    must kill the REST of the gesture** (`_ignoring` / `_ink_ignoring`), not
    just consume the press: a pen tap always jitters, and the drawing branch
    is the LAST one in `_on_drag_update`, so a consumed press that forgets
    this leaves a stray mark beside the button you pressed. Test it by
    dragging after the tap — a tap-only test passes against the bug.
    **Handles and the rotate knob hit-test to nothing in loop
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
  - **`insert_image` treats the rect as a SUGGESTION** — by default it fits
    the picture inside at the picture's own aspect and centres it. Our rect is
    the truth (row 122's side handles stretch one axis on purpose), so
    `keep_proportion=False` is required or every stretched image is written
    letterboxed and displaced: a saved file that does not match the canvas,
    and one that still looks plausible, which is why nothing caught it for so
    long. Assert the placement MATRIX, not the pixels — the shift shows
    nowhere else.
- **Importing the document's OWN images (row 167)** — ☰ *Import this page's
  images* turns a picture that arrived WITH the PDF into one of our objects.
  Everything else in this file is about images Sidemark placed; this is the
  other direction, and its promise is "open it in a browser and it looks the
  same until you move something".
  - **The promise is CHECKED, not assumed.** The one thing
    `import_candidates` refuses outright is a **rotated/flipped/skewed**
    placement: a tilt is baked into fresh pixels by `_layer_bytes_for`, so it
    would come back *resampled*.
  - **A SHARED image is COPIED, never refused.** Importing marks the xref
    `/OC` ours and ownership is what `strip_image_layer` acts on, so *reusing*
    the object for a logo that is page content on 40 other slides would strip
    it from all of them — an argument for giving the import its own object,
    not for declining. This shipped as a refusal first and the refusal was
    wrong: measured over 12 real lecture PDFs, sharing is the NORMAL case (70
    of 124 placements — every template logo), so refusing it left the feature
    working on 38% of real pictures against 98% now. Same answer for one image
    drawn twice on a page: two placements, two objects, two rects. **Measure
    the rule on real documents** — every rejection in the first version was
    defensible in the abstract and one was rejecting the majority case.
  - **Z-order cannot be read off a placement, so nothing tries.** Our layer is
    APPENDED, so anything we place draws above the whole page: invisible for a
    figure with nothing over it, wrong for a watermark under the text.
    `render_matches` renders the page as it is and as it would be SAVED and
    compares pixels — the only check that tests the promise, and it catches
    soft masks, blend modes, clipping and a caption over a figure in one step.
    All candidates are tried together first (one render pair, the answer on
    almost every page); only a failing page pays for the per-image bisect, and
    the survivors are re-tested AS A SET, since two images that each look fine
    alone can still swap order against *each other* once both are on top.
  - **The trial must place the image the way the SAVE will**, or it measures
    its own extra step. `_trial_page` re-encoded from bytes while
    `_write_image_layer` re-places BY REFERENCE — so a scanned page (one big
    JPEG with an ICC profile) lost the profile in the trial, shifted every
    colour, and was refused. It uses the trial's own copied xref
    (`insert_pdf` brings the object across, profile and all) and mirrors the
    save's `xref`/`stream`/`oc`/`keep_proportion` call exactly.
  - **A SOFT MASK is the common case, and the render check is what found
    it.** `extract_image` returns the base image *without* its `/SMask`, so a
    logo with a transparent background imports as an opaque block — two of the
    three images in the first real deck tried. `import_image_bytes` recomposes
    base+mask into an RGBA PNG and is shared by the trial and the commit path,
    or the trial stops predicting the save. That costs the by-reference
    re-placement (new bytes ⇒ `_xref` 0, one re-encode), which is the right
    trade. Nothing in the design anticipated soft masks; the pixels caught them
    anyway. *ceiling: a trial render is ~1.3 s for a 5000-px image and the
    bisect pays it once per image, so `IMPORT_MAX_TRIALS` bounds the count but
    not the size.*
  - **`content_placements` is a tokeniser, not a regex** — `Do` appears inside
    strings a page draws, a matrix can be built across operations, and an
    inline image's bytes can contain anything. It tracks the CTM through
    `q`/`Q`/`cm` and spans **only the `/Name Do`**: removing exactly the one
    paint operation cannot corrupt the page, where deleting the enclosing
    `q … cm … Q` would take a transform the next operator may share.
  - **Count placements by XREF, never by resource name.** PyMuPDF hands out a
    fresh name when it re-places an existing xref, so a name-based count says
    "drawn once" about a picture that is on the page twice. Ownership is a
    property of the object.
  - `_load_page` clears the selection (it is per-page and transient), so the
    re-render comes BEFORE selecting the imported images or there is nothing
    to drag. Undo restores **both** halves — the objects and the page's content
    stream — or the picture vanishes off the page altogether.
  - PDF-only, and not a parity gap: a text-first page has no page content to
    import from. *Not built: text and vector art (no model behind either),
    whole-document import, and inserting an image from a FILE — dropping a
    `.png` is still refused by `classify_import_paths`, which is the other half
    of the gap row 167 started from.*
- **Autosave snapshots only what CHANGED, and the default is the expensive
  answer (row 170).** Re-serialising the document costs ~500 ms on a long PDF
  — most of it re-creating every ink annotation, not the save itself — and it
  runs on the main loop, which the user sees as a UI that freezes for half a
  second and then catches up in a burst. Notes live in the `.md` sidecar and
  cannot change the PDF, so `_mark_dirty(pdf=False)` (the notes buffer, and
  ONLY the notes buffer) leaves `_pdf_dirty` alone and the tick skips
  `save_copy`. **The opt-out is opt-IN on purpose**: a snapshot is a
  data-safety feature, so a caller nobody has audited must cost a needless
  write, never a lost recovery. The snapshot is still written when there is
  none, because recovery reads `doc.pdf` and notes must never be half a pair.
  *Not done: per-page ink rewriting, which would cut the drawing case too —
  it needs to know which pages' ink changed, and getting that wrong loses
  strokes.*
- **PyMuPDF 1.27.2.3 calls a debug benchmark on every `Annot.update()`**
  (`update_timing_test`, counting to 30,000 in pure Python, result discarded):
  144 ms of the 420 ms it takes to write one lecture's ink.
  `_defuse_pymupdf_timing_test()` replaces it at import. Verified to leave the
  written PDF byte-identical apart from the trailer's random `/ID`, which
  differs between any two saves anyway.
- Logging: `logger` writes a per-session file under `~/.cache/sidemark/logs/`,
  auto-deleted on clean exit, **kept when anything logged at WARNING or above**
  and pruned to `LOG_KEEP`. Warning, not error, is deliberate: every warning
  site here is something having gone wrong, and the diagnostics that matter
  most — a GTK critical, a stalled loop, a slow render pass — all belong to a
  session that then exits perfectly cleanly, so an error-only rule deleted the
  log of exactly the run worth reading.
  - **A FREEZE is a blocked main loop, and only a thread outside it can see one
    (row 169).** The symptom users report is typing that stops appearing and
    then lands all at once: nothing is lost, the events were QUEUED while the
    loop was busy, so nothing inside the app notices anything wrong.
    `_watchdog` is a daemon thread watching a `STALL_BEAT_MS` heartbeat; once
    the loop is `STALL_WARN_MS` late it samples the MAIN thread's Python stack
    (`sys._current_frames()`) until it returns, and reports the busiest frames.
    Naming the frame is the whole point — "stalled 400 ms" is the symptom the
    user could already see. Reports are rate-limited (`STALL_REPEAT_S`), since
    the shape to expect is work repeating on every keystroke, and the thread
    never touches GTK. `SIDEMARK_NO_WATCHDOG=1` switches it off. Do not start
    it in the suite: `_loop_beat` frozen at the end of one test's loop makes
    every later moment look like a hang, and a stray warning breaks any test
    counting `assertLogs` records — test the pieces instead.
  - **A GTK abort writes NOTHING by itself, so two hooks make it readable (row
    169).** `g_error` kills the process from C: no exception, no
    `sys.excepthook`, and a log that just stops mid-session — which is all the
    2026-08-14 crash left behind, and why `coredumpctl` was the only thing that
    could answer it. `faulthandler` (pointed at the log's own stream) writes
    the PYTHON frames at SIGABRT/SIGSEGV, which is what names the handler;
    `_glib_log_writer` copies GTK's message in beside them, with a stack and an
    immediate flush. Four platform facts hold it up, all measured, and each is
    the opposite of the obvious guess:
    - **`g_log_set_handler` cannot see them** — modern GTK logs through the
      STRUCTURED API, so `g_log_set_writer_func` is the only hook that catches
      both paths.
    - **The writer cannot suppress a crash**: glib aborts in the caller ABOVE
      it whatever it returns. It is purely additive, and delegates to
      `g_log_writer_default` so stderr and the journal are unchanged.
    - **`FLAG_FATAL` is not set on the way in** — fatality is decided after the
      writer returns, so an always-fatal critical arrives as a plain level 8.
      `_glib_log_kind` classifies on `LEVEL_ERROR`, and gives a critical a
      stack too.
    - **`g_log_set_writer_func` may be called ONCE per process**; the second
      call is itself a `g_error`, so `_install_glib_log_bridge` is guarded — an
      unguarded re-install aborts the app with exactly the crash the hook
      exists to explain.
    PyGObject hands the writer the raw `GLogField` array, so values are
    gpointers read with `ctypes` (`_glib_log_fields`); the structured path also
    carries `CODE_FILE`/`LINE`/`FUNC`, naming the GTK source line that gave up.
  - **The row 166 crash is FIXED, and it was never the previews'** — it is
    `get_iter_at_location` itself. Hand GTK a y BELOW a line's text and its hit
    test answers "the end of that line", computed as the line's RAW byte count
    but converted as a VISIBLE line index: on a line carrying invisible
    characters the index overshoots by exactly the hidden bytes and
    `gtk_text_iter_set_visible_line_index` calls `g_error` — the process is
    gone where it stands, no exception, which is why the log simply stopped.
    **In this buffer nearly every line has hidden characters**, so a hover was
    enough. `MarkdownNotesView.iter_at_buffer_xy` clamps the y into the band
    the paragraph's display ROWS occupy first, and **every pointer→iter hit
    test in the notes view and the sheet goes through it — a bare
    `get_iter_at_location` on this buffer is a bug.** Two traps: the band must
    not be measured from the end-of-line iter (it sits on the newline and
    reports a 0×0 rect, which rejects clicks that are plainly on the text), and
    the regression test runs in a SUBPROCESS, because a regression there does
    not fail an assertion, it takes the interpreter with it.

## The browser port (`web/`)

A faithful port of the page, pen and notes runs in a browser out of `web/`,
published to <https://brokkoli71.github.io/sidemark/> on every push to master.
**`web/CLAUDE.md` is its reference** — read that before touching anything under
`web/`. The one rule that belongs here: the ported pipeline is checked against
`sidemark.py` by exported VECTORS (`extras/export_*_vectors.py`), so a change to
the ink pipeline, the maths grammar, the sidecar format, the lasso geometry or
the shape recogniser on this side may break `web/test/` — regenerate with
`npm run vectors` in `web/` and re-run `npm test`.

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

## Current work & loose ends (2026-08-10)

Everything shipped is described as behavior in the sections above; this section
is only *what is in flight* and *what is free to pick up*. Keep it that way —
when something lands, fold its invariants upward and delete it from here rather
than writing a line about having finished it. The chronology lives in
`ideas.csv` and git.

**START HERE (2026-08-17): six ideas were triaged with the user and each one's
open questions were ANSWERED by them — `ideas.csv` rows 175–180 hold the
answers, and re-deriving them is wasted work.** In the user's own order of
readiness: row 179 (a snapped ellipse stays resizable, small, the pattern
exists), row 175 (smoother scrolling — **touchpad only, the user cut the wheel
out**), then the two they asked to have PROTOTYPED IN THE WEB before anything
ships (row 176, only what is right of the cursor falls back to source, cursor
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

- **Row 150's leftover — the touch text-selection popup.** The sheet pinches
  now (see the stylus block), but with the finger unbound the `TextView` still
  takes the first sequence and can raise its selection bubble under the pinch.
  The user's proposal: that UI belongs to the finger only when the finger's
  tool IS the caret. Needs the panel and a decision about what a lone finger
  on a sheet should do at all (a PDF page pans).
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
