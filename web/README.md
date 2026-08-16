# Sidemark in your browser

**[▶ Open the demo](https://brokkoli71.github.io/sidemark/)** — nothing to
install, and your files never leave your machine.

Sidemark's page, pen and notes, running in a browser tab. Open a PDF, draw on
it with a stylus or a mouse, write live-Markdown notes beside it, and save the
whole thing back as a normal `.pdf` with real ink annotations plus a `.md`
sidecar.

New here? **[Take the six-step tour](https://brokkoli71.github.io/sidemark/demo.html)**
— it walks you through the parts you would never find on your own, driving a
real Sidemark beside it. It writes nothing to your settings.

This is a **preview of the [desktop app](../README.md)**, not a replacement for
it: a large part of Sidemark is here, but not all of it (see below).

## Which browser

**Use Chromium, Chrome or Edge.** Firefox draws exactly as well — the two
engines are indistinguishable for ink, both reading a stylus at its full report
rate — but only Chromium-based browsers can save *in place*, over the file you
opened. On Firefox, saving gives you a download instead.

Safari is not supported.

## What you can do

- **Draw** with a pressure-sensitive pen, highlighter and eraser — saved as
  native PDF ink annotations, so they open anywhere.
- **Notes beside the page**, per page, on a draggable divider. `\alpha` becomes
  α and `x^2` lifts as you type, while the `.md` keeps the plain source. Drag
  the divider all the way across and the notes become one sheet, opened at the
  page you were reading; the sidebar follows the caret as you write, and
  dragging the divider back turns the page to wherever the caret ended up.
- **Open both files.** A document is a `.pdf` plus the `.md` notes beside it, so
  select the two together in the file picker (or drop them together) and they
  come back paired — the browser cannot go looking for a sidecar on its own.
- **Tools live on mouse buttons** — left draws, right erases and middle lassos
  *at the same time*. Click a tool with the button you want it on. A stylus
  needs no setup: the tip draws and the eraser barrel erases.
- **Lasso** — loop around ink to select it, then move, resize, rotate,
  duplicate or delete it. `Ctrl+C` copies it as a picture to any other app, and
  back into Sidemark as editable ink.
- **Shape snap** — hold still mid-stroke and a rough loop becomes a clean
  rectangle, ellipse or polygon; a line inside a box becomes an evenly-spaced
  grid divider. Draw a loop, lift, then press and hold on it and it becomes a
  lasso selection.
- **Paste an image** (`Ctrl+V`) — it lands as an object you can move, resize
  and rotate forever, never a flattened stamp.
- **Pages** — start a new blank document, flip, reorder, insert blank pages with
  the four rulings, hide pages, bookmark them, and merge several dropped PDFs
  into one document with a chapter each.
- **Find things** — search across the PDF text and your notes, plus an outline
  and thumbnail sidebar.
- **Present** (`F5`) — a bare mirror for a second screen with your ink
  appearing live, and a timer on your screen only.
- **Save** (`Ctrl+S`) — the PDF with the ink in it, plus the `.md` sidecar.

Two fingers pinch to zoom, and a finger pans rather than draws — so a resting
palm cannot scribble on the page while you write.

## Not in the browser version

The desktop app additionally has tabs, text-first Markdown pages, `[[wiki
links]]`, notes export, OCR for scans, PowerPoint import, and live
share-to-phone. Image cropping is missing on both.

## Run it yourself

It is a static site — no build step, no server code, no dependencies.

```sh
cd web && python3 -m http.server 8000     # → http://localhost:8000
```

Or build a single self-contained HTML file you can hand to someone:

```sh
./build.py                                 # → dist/sidemark.html
```

Working on the code? See [CLAUDE.md](CLAUDE.md).
