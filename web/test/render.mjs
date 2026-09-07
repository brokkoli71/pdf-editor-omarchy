// What the page does while it is not ready yet.
//
// Three failures, all of which look like "the app is broken" and none of which
// throws:
//
//   * A container with no size produced a NEGATIVE zoom — `(0 - 48) / 595` is
//     a perfectly good number — which renders a 1px bitmap that `draw` refuses
//     to blit, cached under a key so nothing re-rendered. The page stayed
//     white until a gesture happened to change the scale, which is exactly how
//     it was reported: "blank until I zoom in a bit".
//   * The owed re-fit was paid only inside `draw`'s canvas-resize branch, so a
//     fit owed while the canvas was already the right size was never paid.
//   * Two renders shared ONE bitmap, so a slower earlier one could finish last
//     and overwrite the image the key says is on screen.
//
//   node web/test/render.mjs

import { Surface, MIN_ZOOM, MAX_RENDER_SIDE, PREVIEW_SIDE } from "../src/surface.js";
import { Doc } from "../src/doc.js";

let checks = 0, failures = 0;
const ok = (name, cond, detail = "") => {
  checks++;
  if (!cond) { failures++; console.error(`  ✗ ${name}${detail ? ": " + detail : ""}`); }
};

// ── fit() against a container that is not there yet ─────────────────────────

function view(w, h) {
  return {
    pageW: 595, pageH: 842, zoom: 1, offX: 0, offY: 0, _fitPending: false,
    el: { clientWidth: w, clientHeight: h },
    get cssW() { return this.el.clientWidth; },
    get cssH() { return this.el.clientHeight; },
    _snapView() {}, invalidateLayer() {}, _schedulePageRender() {},
  };
}

for (const [w, h, label] of [[0, 0, "0x0"], [0, 800, "0x800"], [500, 0, "500x0"]]) {
  const v = view(w, h);
  Surface.prototype.fit.call(v);
  ok(`a ${label} container yields no zoom at all`, v.zoom === 1,
     `zoom became ${v.zoom}`);
  ok(`a ${label} container leaves the fit OWED`, v._fitPending === true);
}

{
  // the case that actually shipped: a negative scale renders a 1px page
  const v = view(0, 0);
  Surface.prototype.fit.call(v);
  ok("and never a negative zoom", v.zoom > 0, String(v.zoom));
}

for (const [w, h] of [[40, 40], [80, 300], [1200, 900]]) {
  const v = view(w, h);
  Surface.prototype.fit.call(v);
  ok(`a ${w}x${h} container fits to a usable zoom`,
     v.zoom >= MIN_ZOOM && v.zoom < 100, String(v.zoom));
  ok(`a ${w}x${h} container is not left owing a fit`, v._fitPending === false);
}

{
  const v = view(1200, 900);
  Surface.prototype.fit.call(v);
  // the page is inside the box, which is the whole job
  ok("the fitted page fits", v.pageW * v.zoom <= 1200 && v.pageH * v.zoom <= 900);
}

// ── _renderScale never asks for a bitmap nobody can use ────────────────────

globalThis.window = globalThis.window || {};
window.devicePixelRatio = 3;
for (const zoom of [MIN_ZOOM, 0.5, 1, 8, 16]) {
  const scale = Surface.prototype._renderScale.call(
    { zoom, pageW: 595, pageH: 842 });
  ok(`zoom ${zoom} gives a positive scale`, scale > 0, String(scale));
  ok(`zoom ${zoom} stays inside the canvas limit`,
     842 * scale <= MAX_RENDER_SIDE + 1, String(842 * scale));
}

// ── the render pipeline: private buffers, no cached duds, a preview first ──

/** A stand-in Surface with just the fields _renderPage touches. `doc.render`
 * is driven by hand so the ORDER two renders finish in can be chosen. */
function renderer(render) {
  return {
    doc: { render }, pageIndex: 0, pageW: 595, pageH: 842, zoom: 1,
    _pageCanvas: { width: 0, height: 0 }, _pageKey: null, _renderToken: 0,
    draws: 0,
    requestDraw() { this.draws++; },
    _renderScale: Surface.prototype._renderScale,
    _renderAt: Surface.prototype._renderAt,
    _showingPage: Surface.prototype._showingPage,
    render() { return Surface.prototype._renderPage.call(this); },
  };
}

// a canvas the way `doc.render` hands one back
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ({}) }),
};

{
  // a render that comes back 1px wide — the degenerate case — must not be
  // remembered as the page
  const r = renderer(async (i, scale, canvas) => { canvas.width = 1; canvas.height = 1; });
  await r.render();
  ok("a 1px render is never cached as the page", r._pageKey === null);
}

{
  const sizes = [];
  const r = renderer(async (i, scale, canvas) => {
    sizes.push(Math.round(595 * scale));
    canvas.width = Math.round(595 * scale);
    canvas.height = Math.round(842 * scale);
  });
  await r.render();
  ok("a page with nothing on screen renders twice: preview, then full",
     sizes.length === 2, JSON.stringify(sizes));
  ok("the preview is the smaller of the two", sizes[0] < sizes[1],
     JSON.stringify(sizes));
  ok("the preview is about the preview size",
     sizes[0] <= PREVIEW_SIDE + 1, String(sizes[0]));
  ok("the page ends up at full scale", r._pageKey === "0@3.000", r._pageKey);
  ok("both passes asked for a repaint", r.draws === 2, String(r.draws));
}

{
  // ...and a page already on screen is NOT dropped to a blurry one first
  const sizes = [];
  const r = renderer(async (i, scale, canvas) => {
    sizes.push(Math.round(595 * scale));
    canvas.width = Math.round(595 * scale); canvas.height = 1000;
  });
  r._pageKey = "0@1.000";        // this page, at some other scale
  await r.render();
  ok("a page already showing re-renders once, not twice",
     sizes.length === 1, JSON.stringify(sizes));
}

{
  // two renders in flight, the OLDER finishing last: the newer bitmap must
  // survive, because they no longer share a buffer
  let release;
  const gate = new Promise((res) => { release = res; });
  let first = true;
  const r = renderer(async (i, scale, canvas) => {
    canvas.width = Math.round(595 * scale); canvas.height = 1000;
    if (first) { first = false; canvas.tag = "old"; await gate; }
    else canvas.tag = "new";
  });
  r._pageKey = "0@0.500";                    // no preview pass, keeps it simple
  const a = r.render();
  r.zoom = 2;                                // the view moved under it
  const b = r.render();
  await b;
  const afterNew = r._pageCanvas.tag;
  release();
  await a;
  ok("the newer render is what is on screen", afterNew === "new", String(afterNew));
  ok("and the older one finishing later does not replace it",
     r._pageCanvas.tag === "new", String(r._pageCanvas.tag));
}

// ── prefetching the next page (LIVE mode) ──────────────────────────────────

{
  const asked = [];
  const doc = Object.create(Doc.prototype);
  doc.pageCount = 10;
  doc._pageCache = new Map();
  doc._sizeCache = new Map();
  doc.ink = new Map();
  doc._lazy = { have: 0, docs: new Map(),
                fetch: async (n) => { asked.push(n); return { page: { n }, pdf: {}, ink: [] }; } };
  doc._lastPage = 4;

  doc.prefetchPage(5);
  ok("a prefetch fetches the page", asked.includes(5), JSON.stringify(asked));
  ok("a prefetch does NOT move where you are", doc._lastPage === 4,
     `_lastPage became ${doc._lastPage}`);

  doc.prefetchPage(-1);
  doc.prefetchPage(10);
  ok("a prefetch off either end does nothing",
     !asked.includes(-1) && !asked.includes(10), JSON.stringify(asked));

  const before = asked.length;
  await new Promise((res) => setTimeout(res, 0));
  doc._pageCache.set(7, { n: 7 });
  doc.prefetchPage(7);
  ok("a page already in hand is not fetched again", asked.length === before,
     JSON.stringify(asked));
}

{
  // and it is a no-op when the whole document is already here
  const doc = Object.create(Doc.prototype);
  doc.pageCount = 10;
  doc._pageCache = new Map();
  doc._lazy = null;
  let threw = false;
  try { doc.prefetchPage(1); } catch { threw = true; }
  ok("prefetching a non-lazy document is a harmless no-op", !threw);
}

if (failures) {
  console.error(`\n✗ ${failures} of ${checks} render checks failed.`);
  process.exit(1);
}
console.log(`✓ ${checks} render checks passed (fit, scale, preview, races, prefetch).`);
