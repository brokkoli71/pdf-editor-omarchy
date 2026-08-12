// The view following its container.
//
// A window resize is not the only thing that changes the canvas's size —
// hiding the sidebar, dragging the divider, or the frame the tour runs in
// settling all do it with no window event at all. The app used to call `fit()`
// by hand from the sidebar toggle, which ran BEFORE the layout and so fitted
// the page to the box it had just left; the page kept a scale for a container
// that no longer existed.
//
// The other half is what must NOT happen: a resize may not throw away a zoom
// the hand chose.
//
//   node web/test/view.mjs

import { Surface } from "../src/surface.js";

let checks = 0, failures = 0;
function check(name, got, want) {
  checks++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failures++;
    console.error(`  ✗ ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

/** `_onHostResize` touches only view state and three notifications, so it runs
 * without a DOM. The host is whatever reports a size. */
function view(state = {}) {
  return {
    offX: 100, offY: 50, zoom: 1, _fitted: true, _fitPending: false,
    _hostSize: null, drew: 0, renders: 0,
    ...state,
    _snapView() {},
    invalidateLayer() {},
    requestDraw() { this.drew++; },
    _schedulePageRender() { this.renders++; },
    resize(w, h) { Surface.prototype._onHostResize.call(this, { clientWidth: w, clientHeight: h }); },
  };
}

// ── the first measurement just records the size ──────────────────────────────
{
  const v = view();
  v.resize(800, 600);
  check("the first size is remembered", v._hostSize, [800, 600]);
  check("and asks for a fit", v._fitPending, true);
}

// ── a fit view RE-FITS, and the fit is deferred to the draw ─────────────────
// `fit` measures the CANVAS, which is resized from the host during the draw —
// so at this moment it still carries the old size, and fitting here would
// compute the same wrong number the old code did.
{
  const v = view({ _hostSize: [800, 600] });
  v.resize(500, 600);
  check("a re-fit is pending", v._fitPending, true);
  check("the offsets are left to the fit", [v.offX, v.offY], [100, 50]);
}

// ── a CHOSEN zoom survives, with the middle of the view held ────────────────
{
  const v = view({ _hostSize: [800, 600], _fitted: false, zoom: 2.5 });
  v.resize(600, 400);
  check("no re-fit", v._fitPending, false);
  check("the zoom is untouched", v.zoom, 2.5);
  // half the width lost each side, half the height each top and bottom
  check("what was centred stays centred", [v.offX, v.offY], [0, -50]);
  check("the page is re-rendered at the new size", v.renders, 1);
}

// ── a size that did not change does nothing at all ──────────────────────────
// ResizeObserver fires for reasons other than a change in size, and a fit on
// every one of them would fight a zoom in progress.
{
  const v = view({ _hostSize: [800, 600], _fitted: false, zoom: 2.5 });
  v.resize(800, 600);
  check("nothing pending", v._fitPending, false);
  check("nothing drawn", v.drew, 0);
  check("offsets untouched", [v.offX, v.offY], [100, 50]);
}

// ── a container laid out to nothing is not a size ───────────────────────────
// A hidden panel reports 0×0. Fitting a page into no space gives a zoom of
// zero or worse, and the state would then be remembered as the real one.
{
  const v = view({ _hostSize: [800, 600] });
  v.resize(0, 0);
  check("zero is ignored", v._hostSize, [800, 600]);
  check("and nothing is pending", v._fitPending, false);
}

if (failures) {
  console.error(`\n✗ ${failures} of ${checks} view checks failed.`);
  process.exit(1);
}
console.log(`✓ ${checks} view checks passed (the page follows its container, the zoom survives).`);
