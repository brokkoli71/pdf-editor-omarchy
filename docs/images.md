# Images: pasted, imported, and the PDF layer

> One UX contract, and a layer that corrupts documents if you get it wrong.

> Split out of `CLAUDE.md`, which is the starting point and links here.
>
> **This is not a changelog, and it must not become one.** Keep only what is
> TRUE NOW and can be broken by accident: an invariant, a constraint the
> platform imposes, a trap. When behaviour changes, REPLACE the old text —
> never append the new alongside it. Delete anything that has stopped being
> load-bearing.
>
> The *why* — what was tried, what was measured, what was rejected — belongs
> in `ideas.csv`, one row per feature. Link to the row instead of retelling
> it here. Present tense about how it behaves, not past tense about how it
> got here.

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
