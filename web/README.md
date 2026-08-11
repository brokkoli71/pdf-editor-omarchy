# Sidemark — browser ink prototype

The ink half of Sidemark, running in a browser. No build step and no
dependencies: open `index.html` from any static server.

```sh
cd web && python3 -m http.server 8000
# → http://localhost:8000
```

## What this is for

To answer one question before any more of the port is written: **does the pen
still feel right on the web?** Everything else about a browser port is
tractable work; this is the part that either survives the substrate or doesn't.

It is a faithful port, not a reimplementation. The ink pipeline, the button
binding table and the stylus mapping are the real designs, with the real
constants.

## What is here

- **The whole ink pipeline** — `resampleInk` (centripetal Catmull-Rom at fixed
  arc length), `taubinSmooth` (λ/μ denoise), `widthProfile` (pressure, end
  taper, the dot rules), `trimLightTail`, `finishInkStroke`, `liveInkStroke`,
  `hoverLeadIn`. Ported from `sidemark.py` and checked against it (below).
- **The binding table** — every button, alone or under modifiers, HAS a tool.
  Click a tool with the button you want it on. The stripes under the tools are
  a live readout: hold Ctrl or Alt and they repaint from the chord table.
- **The stylus mapping** — pen tip → left, eraser barrel → right, barrel+tip →
  middle, finger → finger. No table of its own, so the shipped defaults already
  are the pen workflow.
- **Two fingers** counted off the raw pointer stream, driving pinch zoom/pan
  from centroid and spread, with a second finger abandoning what the first
  started — and the revocation armed by the capture device, never the touch
  count, so a resting palm cannot eat a pen stroke.
- Pen, highlighter, eraser, pan, zoom-to-region; undo/redo; the pen popover.

## What is deliberately not here

Scope limits, not oversights:

- **No PDF.** The page is a blank A4 sheet. `pdf.js` is the port target.
- **No notes panel.** `MarkdownNotesView` is the hard part of the full port
  (CodeMirror 6 is the target) and is a separate exercise.
- **Lasso, text cursor and anchor** stay in the table and in the bar — removing
  them would change the binding model — but a press that resolves to one does
  nothing here. They are marked in the tooltip.
- **No shape snap** (the extended dwell) and **no prediction**. Prediction is
  settled: it was graded against 133 Hz captured ink and recovers ~10% of the
  lag error at best, negative past 40 ms. `getPredictedEvents()` is the same
  guess with a vendor's name on it — don't reach for it.
- Nothing is saved. Reload and the page is blank.

## Conformance

The pipeline was tuned by measurement, and several of its traps pass a casual
eye while broken — the doubled Laplacian smooths a circle correctly *and*
amplifies the Nyquist frequency; a dot with a per-point profile looks fine until
you notice it is a teardrop. So the port is not checked by reading it:

```sh
../extras/export_ink_vectors.py > test/vectors.json   # the Python is the oracle
node test/conformance.mjs
```

766 checks over 32 strokes, 24 of them **real captured strokes** from
`notes/*.jsonl` — the same hand and digitiser the constants were tuned against.
It earned its place on the first run by catching an invented constant
(`ERASE_SLACK_PX` guessed at 4.0 against the real 3.0).

Agreement is to 1e-6 document units. There is no algorithmic divergence: an
earlier 2e-6 gap was the vectors' own rounding perturbing the input, and it
vanished when the exporter's precision went up.

Re-run it after any edit to `src/ink.js`. It is what tells you whether you
changed the shape of the ink or just the code.
