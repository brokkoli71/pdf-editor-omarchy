# Sidemark — browser prototype

Sidemark's page, pen and notes, running in a browser. No build step and no
dependencies: open `index.html` from any static server.

```sh
cd web && python3 -m http.server 8000
# → http://localhost:8000
```

## What this is for

To answer one question before any more of the port is written: **does the pen
still feel right on the web?** Everything else about a browser port is tractable
work; this is the part that either survives the substrate or doesn't. It was
judged in the hand and the answer was yes, so the rest followed.

It is a faithful port, not a reimplementation. The ink pipeline, the button
binding table and the stylus mapping are the real designs, with the real
constants.

## What is here

- **The notes panel** — a live-Markdown column beside the page, per page, on a
  draggable divider. `\alpha` becomes α and `x^2` lifts as you type, while the
  source stays in the document underneath: only what the CARET touches falls
  back to source, and a SELECTION reveals every line it covers. Built on
  CodeMirror 6, whose position mapping does the job the desktop needs an index
  map for.
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
- **PDFs** — open one or drop it; pages flip one at a time as they do on the
  desktop, with ink stored per page. A sidebar switches Pages/Outline, and the
  outline carries the "you are here" rule. Drop several files at once and they
  merge into ONE document with a chapter per file; drop onto the sidebar and
  they insert at that gap.

## Which browser

**Chromium is the recommendation for the people you send this to; Firefox is
equally good to develop in.** That is a measurement, not a preference — taken
with `input-probe.html` on the Goodix GXTP7380 panel, Linux/Wayland:

| | pen | finger | mouse |
|---|---|---|---|
| Firefox | **133 Hz**, 2.21 samples/event, pressure 0–0.81 | 96 Hz | 122 Hz |
| Chromium | **134 Hz**, 2.22 samples/event, pressure 0–0.85 | 100 Hz | 130 Hz |

The two engines are indistinguishable for ink. Both recover the panel's **full
133 Hz** through `getCoalescedEvents()` — the same rate the desktop app gets
after row 147's `motion_history()` fix, and the thing that decides ink quality.
Both deliver ~60 Hz without coalescing, which is already twice what the GTK
canvas was seeing before that fix.

Two differences, neither about ink:

- **File System Access** is Chromium-only, so save-in-place cannot exist on
  Firefox. The fallback is a download, which is one capability check, not a
  second code path.
- **Touch pressure** reads 0.00 on Firefox and 0.50 on Chromium. It costs
  nothing here because pressure is taken from the pen only — the browser's
  flat 0.5 for a mouse is a lie about the device, and `finger` is a button
  identity, not a nib.

Tilt is reported by neither, which matches the desktop's finding that this
class of panel has no usable tilt axes. Spacing ÷ feature size came out
0.017–0.036 across every device: **oversampled**, so denoising is the lever and
interpolation is not carrying the result — the same regime the desktop measured
at 133 Hz, where the Taubin passes are near-inert. Do not widen the smoothing
range to compensate; that was settled by measurement on the desktop too.

Safari is not supported and is not being tested.

## What is deliberately not here

Scope limits, not oversights:

- **No saving.** Nothing is written to disk — reload and the work is gone. The
  `.md` sidecar format is fully implemented (`notes-model.js`), so this is a
  file-handle question, not a format one.
- **Lasso, text cursor and anchor** stay in the table and in the bar — removing
  them would change the binding model — but a press that resolves to one does
  nothing here. They are marked in the tooltip.
- **No shape snap** (the extended dwell) and **no prediction**. Prediction is
  settled: it was graded against 133 Hz captured ink and recovers ~10% of the
  lag error at best, negative past 40 ms. `getPredictedEvents()` is the same
  guess with a vendor's name on it — don't reach for it.
- **No text-first mode**, no bookmarks, no wiki links, no presenter or share.

## Conformance

The pipeline was tuned by measurement, and several of its traps pass a casual
eye while broken — the doubled Laplacian smooths a circle correctly *and*
amplifies the Nyquist frequency; a dot with a per-point profile looks fine until
you notice it is a teardrop. So the port is not checked by reading it:

```sh
../extras/export_ink_vectors.py > test/vectors.json   # the Python is the oracle
node test/conformance.mjs
```

The same method covers the notes sidecar and the maths grammar — three
exporters under `extras/`, three runners under `test/`:

| suite | checks | over |
|---|---|---|
| `conformance.mjs` | 766 | 32 strokes, 24 of them real captures |
| `merge.mjs` | — | chapters, ink re-keying, insert-at-gap |
| `notes.mjs` | 282 | 12 sidecar shapes, byte-identical round trips |
| `math.mjs` | 226 | 37 lines of maths source |

The ink vectors are **real captured strokes** from `notes/*.jsonl` — the same
hand and digitiser the constants were tuned against. The oracle earned its place
on the first run by catching an invented constant (`ERASE_SLACK_PX` guessed at
4.0 against the real 3.0).

Agreement is to 1e-6 document units. There is no algorithmic divergence: an
earlier 2e-6 gap was the vectors' own rounding perturbing the input, and it
vanished when the exporter's precision went up.

Re-run it after any edit to `src/ink.js`. It is what tells you whether you
changed the shape of the ink or just the code.
