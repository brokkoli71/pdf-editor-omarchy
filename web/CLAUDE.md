# CLAUDE.md — working on Sidemark for the web

> The root `CLAUDE.md` is the desktop app and is still the authority on every
> *design decision* this port inherits. This file is the browser side only:
> what differs, what is not here, and how the port is kept honest. Maintain it
> the same way — replace stale facts, keep it lean, put the long *why* in
> `ideas.csv`.

## What this is

A faithful browser port of Sidemark's page, pen and notes. No build step and no
dependencies at runtime: `index.html` plus ES modules under `src/` and four
vendored libraries under `vendor/`. Serve it from any static server.

```sh
cd web && python3 -m http.server 8000     # → http://localhost:8000
```

It is a **port, not a reimplementation**. The ink pipeline, the button binding
table and the stylus mapping are the real designs with the real constants, and
they are checked against `sidemark.py` by exported vectors (below) rather than
by reading them.

### The question it was built to answer

**Does the pen still feel right on the web?** Everything else about a browser
port is tractable work; this is the part that either survives the substrate or
does not. It was judged in the hand and the answer was yes, so the rest
followed. Don't reopen it without a new measurement.

## Layout

- `index.html` — the app. `demo.html` — the six-step tour (below).
  `input-probe.html` — the device measurement harness.
- `src/` — one module per concern; `app.js` wires them. `ink.js`, `bindings.js`,
  `lasso.js`, `shapes.js`, `notes-model.js` and `mathrender.js` are the ported
  ones and are under conformance test.
- `vendor/` — pdf.js (+ its worker), pdf-lib, CodeMirror 6. Vendored, not
  fetched; `package.json`'s `vendor:cm` records how the CodeMirror bundle is
  rebuilt.
- `test/` — node runners plus the exported vector JSON. `package.json` has
  `test`, `check` (a `node --check` sweep) and `vectors` (regenerate from the
  Python oracle).
- `build.py` — flattens everything into ONE self-contained
  `dist/sidemark.html`, for handing to someone as a single file. pdf.js's
  worker is the one thing that cannot be inlined as a script, so its source is
  embedded as a string and turned into a Blob at startup — which is why
  `doc.js` looks for `__SIDEMARK_PDF_WORKER__`. Needs `esbuild` (fetched with
  npx if absent): a hand-rolled bundler would have to resolve imports and
  topologically sort them, and getting that subtly wrong fails silently.

## The tour

`demo.html` teaches the parts you would never find on your own — the dwell,
welding, tools on buttons — by driving a real Sidemark beside it and waiting
until you have actually done each one. It runs the app with `?sandbox=1`, which
reads your settings but writes nothing back, so a tour costs the visitor
neither their session nor their button table.

It teaches **Export**, not a drag that cannot land (see the DnD note below).

## Conformance — how the port is kept honest

The pipeline was tuned by measurement, and several of its traps pass a casual
eye while broken: the doubled Laplacian smooths a circle correctly *and*
amplifies Nyquist; a dot with a per-point profile looks fine until you notice
it is a teardrop. So the port is not checked by reading it.

```sh
../extras/export_ink_vectors.py > test/vectors.json   # the Python is the oracle
node test/conformance.mjs
npm test                                              # all the runners
```

| suite | checks | over |
|---|---|---|
| `conformance.mjs` | 766 | 32 strokes, 24 of them real captures |
| `merge.mjs` | — | chapters, ink re-keying, insert-at-gap |
| `notes.mjs` | 405 | 12 sidecar shapes, byte-identical round trips, page↔offset |
| `math.mjs` | 226 | 37 lines of maths source |
| `lasso.mjs` | 184 | handle points, anchors, scale factors, chip, polygon |
| `shapes.mjs` | 100 | 13 strokes through the recogniser |
| `inkpdf.mjs` | — | annots, appearance, profile, regeneration, foreign ink |
| `crossing.mjs` | 15 | which page the sheet closes onto, and the caret readout |
| `wiring.mjs` | — | callbacks supplied, bare calls resolve, DOM ids exist |

The ink vectors are **real captured strokes** from `notes/*.jsonl` — the same
hand and digitiser the constants were tuned against. The oracle earned its
place on the first run by catching an invented constant (`ERASE_SLACK_PX`
guessed at 4.0 against the real 3.0).

Agreement is to 1e-6 document units, and there is **no algorithmic
divergence** — an earlier 2e-6 gap was the vectors' own rounding perturbing the
input, and it vanished when the exporter's precision went up.

Re-run it after any edit to `src/ink.js`. It is what tells you whether you
changed the shape of the ink or just the code.

**Export rounding is load-bearing.** Each exporter rounds its inputs FIRST and
derives every expected output from exactly the points it publishes. Rounding
after the fact feeds the port slightly different input than the oracle used —
invisible for continuous outputs, but it flips DISCRETE decisions (it changed
which point RDP called a corner on a near-tie) and the port then gets blamed
for the exporter's arithmetic.

## The wiring guard

`test/wiring.mjs` exists because of a specific failure: four page-menu entries
shipped DEAD. They were callbacks a module reads that `app.js` never supplied,
and functions referenced that were never defined — none of which is a syntax
error, so `node --check` passed and the entries simply did nothing when
clicked. The cause was string-anchored edits whose anchors had drifted, and
`String.replace` returns the original silently when it finds nothing.

It checks three things, each of which has caught a real bug: every callback a
module READS is supplied where it is constructed, every bare call resolves, and
every `getElementById` names something that exists in the page. That last one
matters more than it sounds — a missing id throws on the line that touches it,
which aborts module evaluation, so one mistyped element stops everything after
it from initialising.

## Verifying gestures

The conformance suites cover geometry, not wiring — and wiring is where the
real bugs live. Gestures are checked by constructing a real `Surface` and
dispatching real `PointerEvent`s at it, so the actual press router is under
test and the app needs no debug hooks. Four things that harness taught, all of
which will bite again:

- **Pin the view first.** `draw()` re-fits on its first frame, so an `await`
  between computing a screen coordinate and pressing it lets a frame callback
  move the target out from under the test.
- A synthetic event has no `getCoalescedEvents()`, which is why the reader
  falls back to `[e]` rather than assuming the method exists.
- **`element.click()` is not a click.** It dispatches only a click, where a
  hand sends pointerdown first — and pointerdown is what closes a menu. A whole
  context menu was dead to real clicks while a synthetic test reported every
  entry working. Send the full sequence.
- **A synthetic click carries no user activation**
  (`navigator.userActivation.isActive` is false), so no script can open a file
  picker. Anything gated on a gesture needs `Input.dispatchMouseEvent` over
  CDP, or a hand.

Unlike the desktop, this side CAN be driven by an agent through Chrome — see
the memory note on handing off GUI checks.

## A document is two files, and the browser cannot find the second one

The desktop opens a `.pdf` and reads the `.md` beside it. A browser is handed
FILES, never the directory they came from, so the sidecar can only arrive if the
user selects it too — which is why the open picker offers `.md` alongside `.pdf`
(inserting pages does not: a `.md` means nothing there) and why the button, the
drop overlay and the README all say to pick both.

`pairSources` is the ONE pairing rule, shared by the drop and the picker: base
name first, but one PDF and one `.md` opened together are paired whatever they
are called — the desktop lets you choose a notes file by hand and those are
often named for the course. It also carries the sidecar's **handle**, which is
the real payoff: with it a later save writes the notes back in place instead of
`saveDocument` returning `notesPending` and asking for a second gesture.

## The caret crosses the divider (row 162)

Dragging the notes to full width makes them one sheet, and going either way is a
translation between two coordinate systems for the same notes — a page index and
a character offset. `noteOffsetForPage` / `notePageAtOffset` are the one marker
table both directions read; two readings of it is exactly how the caret comes
back on a different page than it left.

Two of the three answers cannot come from the offset, so `NotesView` also
remembers the page the sheet was opened at and the offset it put the caret at: a
linked run shares one body (row 129), so a caret in it says the RUN and not which
of its pages you were reading, and a caret that never MOVED has learnt nothing
since — which is also the only honest answer for a page with no notes, whose
caret was parked in somebody else's section.

**The sidebar follows the caret while the sheet is open**, and only the
sidebar: `onCaretPage` points `Sidebar.setPage` at the page the caret is in, so
the current thumbnail, the outline's "where you are" line (row 153) and the
scroll all follow the text you are writing in. The canvas is NOT turned — it
would re-render a page nobody can see on every keystroke, and it is `setFull` on
the way out that knows how to read a caret that never moved. Clicking a row goes
the other way (`NotesView.goToPage`), and moves the page the sheet was opened at
with it, or closing would take you back to where you started rather than where
you asked to be. The readout is DEBOUNCED and its marker table cached: the scan
is over the whole sidecar and typing must not pay for it per character.

`setModel` resets the panel to one page, and the divider's state outlives a
document change — so every path that swaps the model calls `syncFullNotes()` to
re-enter the sheet. Without it the panel is full width, showing one page.

## Browser differences (measured, not assumed)

Taken with `input-probe.html` on the Goodix GXTP7380 panel, Linux/Wayland:

| | pen | finger | mouse |
|---|---|---|---|
| Firefox | **133 Hz**, 2.21 samples/event, pressure 0–0.81 | 96 Hz | 122 Hz |
| Chromium | **134 Hz**, 2.22 samples/event, pressure 0–0.85 | 100 Hz | 130 Hz |

**The two engines are indistinguishable for ink.** Both recover the panel's
full 133 Hz through `getCoalescedEvents()` — the same rate the desktop gets
after row 147's `motion_history()` fix, and the thing that decides ink quality.
Both deliver ~60 Hz without coalescing, already twice what the GTK canvas saw
before that fix. So Chromium is the recommendation for *visitors* only because
of File System Access; Firefox is equally good to develop in.

- **File System Access is Chromium-only**, so save-in-place cannot exist on
  Firefox. The fallback is a download — one capability check, not a second code
  path.
- **Touch pressure** reads 0.00 on Firefox and 0.50 on Chromium. It costs
  nothing, because pressure is taken from the pen only: the browser's flat 0.5
  for a mouse is a lie about the device, and `finger` is a button identity, not
  a nib.
- **Tilt is reported by neither**, matching the desktop's finding that this
  class of panel has no usable tilt axes.
- Spacing ÷ feature size came out **0.017–0.036** across every device:
  oversampled, so denoising is the lever and interpolation is not carrying the
  result — the same regime the desktop measured at 133 Hz, where the Taubin
  passes are near-inert. Do not widen the smoothing range to compensate.

Safari is not supported and is not being tested.

## Why a page cannot be dragged to a file manager

Dragging thumbnails OUT works into another Sidemark window's page strip. A
Linux file manager will not take it, and the reason is worth knowing before
anyone tries to "fix" it: the browser can drag out a file that already EXISTS
(a download leaves as a `file://` URI), but a page offering bytes it has not
written yet needs `DownloadURL`, the file-promise type Chromium implements on
**Windows and macOS only**. Extracted pages live in memory, so there is no file
to point at. Export writes one — which is what the tour teaches instead.

## Deliberately not here

Scope limits, not oversights: no image crop, no tabs, no wiki links, no
text-first mode, no notes export, no OCR, no PowerPoint import, no
share-to-phone (a browser tab cannot listen on a socket).

**No prediction, and it is settled.** It was graded against 133 Hz captured ink
and recovers ~10% of the lag error at best, negative past 40 ms.
`getPredictedEvents()` is the same guess with a vendor's name on it — don't
reach for it.

## Publishing

`.github/workflows/pages.yml` deploys `web/` to GitHub Pages on every push to
`master` (<https://brokkoli71.github.io/sidemark/>). It is a static site, so
the job copies files and nothing else; `test/` and `package.json` are
development-only and are left out. Over HTTPS the File System Access API works,
which is what gives save-in-place — the one thing a `file://` copy or a plain
http server cannot offer.
