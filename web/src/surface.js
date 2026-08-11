// The drawing surface: one press router, the live stroke, and the committed
// ink layer. This is the prototype's stand-in for PDFCanvas — the page is a
// blank sheet rather than a rendered PDF, but everything about how a press
// becomes ink is the real design.

import {
  adaptiveSpacing, finishInkStroke, liveInkStroke, hoverLeadIn, eraseRadius,
  HOVER_TRAIL_MS,
} from "./ink.js";
import { drawInkStroke, strokeHit, rgbCss } from "./draw.js";
import { BTN_FINGER, buttonForEvent, chordId } from "./bindings.js";
import {
  pointInPolygon, lassoHandlePoints, lassoHandleAnchor, lassoScaleFactors,
  lassoHandleCursor, lassoChipCentre, lassoChipHit, lassoDeleteCentre,
  lassoDeleteHit, drawLassoChip, drawLassoDelete, mergeSelection, selectionBbox,
  scalePoint, rotatePoint, rotateKnobCentre, rotateKnobHit, drawRotateKnob,
  LASSO_PAD, HANDLE_HIT, ROTATE_SNAP_DEG, DUPLICATE_OFFSET,
} from "./lasso.js";

export const PAGE_W = 595.0, PAGE_H = 842.0;   // A4 in document units, the size
                                               // blank_pdf_file() makes

// Tools this prototype implements. The others stay in the table and in the bar
// — removing them would change the binding model, which is not ours to change —
// but a press that resolves to one of them does nothing here.
export const IMPLEMENTED_TOOLS = new Set(["pen", "highlighter", "eraser", "pan",
                                          "zoom", "lasso"]);

/** How many fingers are on the glass — and whether THIS hand ever had two.
 *
 * TWO FINGERS ARE A FACT ABOUT THE HAND, NEVER ABOUT THE GESTURE (rows 148 and
 * 150). The count must come off the raw pointer stream, not off a recognised
 * pinch: a gesture recogniser only fires once it recognises, by which time the
 * press router may already have claimed the first finger.
 *
 * Two invariants: `multi` latches on the second touchdown and clears only when
 * the LAST finger lifts (a pinch ends while a finger is still down, and the
 * survivor then arrives as a brand-new press); and a second finger ABANDONS
 * whatever the first started rather than committing it. */
export class TouchLatch {
  constructor() {
    this.points = new Map();   // pointerId → [x, y]
    this.multi = false;
  }
  down(id, x, y) {
    this.points.set(id, [x, y]);
    if (this.points.size >= 2) this.multi = true;
    return this.points.size;
  }
  move(id, x, y) {
    if (this.points.has(id)) this.points.set(id, [x, y]);
  }
  up(id) {
    this.points.delete(id);
    if (this.points.size === 0) this.multi = false;   // only the LAST lift
    return this.points.size;
  }
  get count() { return this.points.size; }
  /** Centroid and mean spread — the pinch's own arithmetic, kept beside the
   * count so no gesture recogniser is needed to drive zoom and pan. */
  metrics() {
    const pts = [...this.points.values()];
    if (!pts.length) return null;
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const spread = pts.length < 2 ? 0
      : pts.reduce((s, p) => s + Math.hypot(p[0] - cx, p[1] - cy), 0) / pts.length;
    return { cx, cy, spread };
  }
}

export class Surface {
  constructor(canvas, pen, bindings, opts = {}) {
    this.el = canvas;
    this.ctx = canvas.getContext("2d");
    this.pen = pen;             // the shared pen settings object
    this.bindings = bindings;
    this.docMode = "pdf";       // routing NEVER reads bindings.mode
    this.onChange = opts.onChange || (() => {});
    this.onPageChange = opts.onPageChange || (() => {});

    // The document, and which page is in front. Sidemark shows ONE page at a
    // time and flips between them; it is not a continuous scroll.
    this.doc = null;
    this.pageIndex = 0;
    this.pageW = PAGE_W;
    this.pageH = PAGE_H;
    this._pageCanvas = document.createElement("canvas");
    this._pageKey = null;
    this._renderToken = 0;

    this.undoStack = [];
    this.redoStack = [];

    // The lasso selection. `selected` is the strokes; `loop` is the path you
    // drew, in DOCUMENT units, and is the grab region while it exists — a
    // selection wears the loop it was drawn with, not a box. The chip switches
    // to the 8-handle box, which is the only way to scale.
    this.selected = [];
    this.selectionLoop = null;
    this.selectionBoxed = false;

    // view: document units → CSS px is `zoom`, origin at (offX, offY)
    this.zoom = 1.0;
    this.offX = 0.0;
    this.offY = 0.0;
    this._fitPending = true;

    // the press in flight
    this.active = null;
    this.hoverTrail = [];       // [x, y, t_ms] in DOCUMENT units
    this.latch = new TouchLatch();
    this._heldMods = { ctrl: false, shift: false, alt: false };
    this._pinch = null;
    this._frame = null;
    this._layer = null;         // cached committed ink
    this._layerKey = null;

    this._install();
  }

  // ── the document ───────────────────────────────────────────────────────────

  /** Strokes are stored PER PAGE on the document, so paging away and back
   * finds the ink where you left it. */
  get strokes() {
    return this.doc ? this.doc.strokesFor(this.pageIndex) : (this._loose ||= []);
  }

  async setDoc(doc, page = 0) {
    this.doc = doc;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    await this.setPage(page, { fit: true });
    this.onChange();
  }

  async setPage(index, { fit = false } = {}) {
    if (!this.doc) return;
    index = Math.max(0, Math.min(this.doc.pageCount - 1, index));
    this.pageIndex = index;
    [this.pageW, this.pageH] = await this.doc.pageSize(index);
    if (fit) this.fit();
    this._pageKey = null;
    this.invalidateLayer();
    await this._renderPage();
    this.onPageChange(index);
    this.requestDraw();
  }

  /** Only RELATIVE navigation is a "flip" — a thumbnail click or an outline row
   * goes straight to its page. */
  flipPage(delta) {
    if (!this.doc) return;
    const next = this.pageIndex + delta;
    if (next < 0 || next >= this.doc.pageCount) return;
    this.setPage(next, { fit: false });
  }

  async _renderPage() {
    if (!this.doc) return;
    const dpr = window.devicePixelRatio || 1;
    const scale = this.zoom * dpr;
    const key = `${this.pageIndex}@${scale.toFixed(3)}`;
    if (this._pageKey === key) return;
    const token = ++this._renderToken;
    try {
      await this.doc.render(this.pageIndex, scale, this._pageCanvas);
    } catch {
      return;                    // a page that will not render must not wedge
    }
    if (token !== this._renderToken) return;   // a newer render won
    this._pageKey = key;
    this.requestDraw();
  }

  // ── view ───────────────────────────────────────────────────────────────────

  get cssW() { return this.el.clientWidth; }
  get cssH() { return this.el.clientHeight; }

  fit() {
    const m = 24;
    this.zoom = Math.min((this.cssW - m * 2) / this.pageW,
                         (this.cssH - m * 2) / this.pageH);
    this.offX = (this.cssW - this.pageW * this.zoom) / 2;
    this.offY = (this.cssH - this.pageH * this.zoom) / 2;
    this.invalidateLayer();
    this._schedulePageRender();
  }

  /** Re-rendering the page is expensive, so it is debounced behind the zoom
   * gesture: the old bitmap is scaled meanwhile, which is what keeps a pinch
   * smooth instead of blocking on pdf.js at every step. */
  _schedulePageRender() {
    clearTimeout(this._renderTimer);
    this._renderTimer = setTimeout(() => this._renderPage(), 120);
  }

  toDoc(x, y) { return [(x - this.offX) / this.zoom, (y - this.offY) / this.zoom]; }
  toView(x, y) { return [x * this.zoom + this.offX, y * this.zoom + this.offY]; }

  zoomAt(factor, cx, cy) {
    const [dx, dy] = this.toDoc(cx, cy);
    this.zoom = Math.max(0.05, Math.min(16, this.zoom * factor));
    this.offX = cx - dx * this.zoom;
    this.offY = cy - dy * this.zoom;
    this.invalidateLayer();
    this._schedulePageRender();
    this.requestDraw();
  }

  panBy(dx, dy) {
    this.offX += dx;
    this.offY += dy;
    this.invalidateLayer();
    this.requestDraw();
  }

  // ── the press router ───────────────────────────────────────────────────────

  setHeldMods(mods) { this._heldMods = mods; }

  /** Merge the event's own modifier state with the window-tracked held keys —
   * the same rule the Python routers use, because a press can arrive without
   * the modifier mask and a Ctrl+press that reads as unmodified falls into the
   * wrong branch. */
  _chordState(e) {
    return {
      ctrl: e.ctrlKey || this._heldMods.ctrl,
      shift: e.shiftKey || this._heldMods.shift,
      alt: e.altKey || this._heldMods.alt,
    };
  }

  /** The tool this press runs. Routing passes its OWN doc mode rather than
   * reading `bindings.mode`, which belongs to the chrome. */
  toolForEvent(e) {
    const { ctrl, shift, alt } = this._chordState(e);
    return this.bindings.toolFor(buttonForEvent(e), ctrl, shift, alt, this.docMode);
  }

  /** `canvas.tool` is DERIVED: the tool of the button being pressed, else what
   * LEFT would do. There is no stored active tool. */
  get tool() {
    if (this.active) return this.active.tool;
    const { ctrl, shift, alt } = this._heldMods;
    return this.bindings.toolFor(1, ctrl, shift, alt, this.docMode);
  }

  _install() {
    const el = this.el;
    el.addEventListener("pointerdown", (e) => this._onDown(e));
    el.addEventListener("pointermove", (e) => this._onMove(e));
    el.addEventListener("pointerup", (e) => this._onUp(e));
    el.addEventListener("pointercancel", (e) => this._onUp(e, true));
    el.addEventListener("pointerleave", (e) => this._onLeave(e));
    // the right button and the pen barrel both raise a context menu otherwise,
    // and both of them are bound buttons here
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    el.addEventListener("wheel", (e) => this._onWheel(e), { passive: false });
    // `touch-action: none` in CSS is what stops the browser's own pan/zoom from
    // stealing the gesture before a pointer event is ever delivered.
  }

  _onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey) {
      // the touchpad pinch, which arrives as ctrl+wheel and carries no pointers
      this.zoomAt(Math.exp(-e.deltaY * 0.01), e.offsetX, e.offsetY);
      return;
    }
    // Scrolling PAST THE EDGE turns the page — the page is the unit of
    // navigation here, so a scroll that has nowhere left to go means "next".
    const pageTop = this.offY;
    const pageBottom = this.offY + this.pageH * this.zoom;
    const atBottom = pageBottom <= this.cssH + 1;
    const atTop = pageTop >= -1;
    if (e.deltaY > 0 && atBottom) { this._flipVisible(1); return; }
    if (e.deltaY < 0 && atTop) { this._flipVisible(-1); return; }
    this.panBy(-e.deltaX, -e.deltaY);
  }

  /** Scroll-past-edge and the page buttons resolve navigation in ONE place, so
   * the two cannot disagree about where "next" lands. */
  _flipVisible(delta) {
    const now = performance.now();
    if (now - (this._lastFlip || 0) < 220) return;   // one page per gesture
    this._lastFlip = now;
    this.flipPage(delta);
  }

  _onDown(e) {
    this.el.setPointerCapture(e.pointerId);
    const [dx, dy] = this.toDoc(e.offsetX, e.offsetY);

    if (e.pointerType === "touch") {
      const n = this.latch.down(e.pointerId, e.offsetX, e.offsetY);
      if (n >= 2) {
        // A SECOND FINGER ABANDONS whatever the first started, rather than
        // committing it — and the guard is here AND at the commit, because a
        // press can be cancelled with the tool still in hand.
        this._abandon();
        this._pinch = { ...this.latch.metrics(), zoom: this.zoom };
        this.requestDraw();
        return;
      }
      // A lone finger falls through and is routed through the table like any
      // other press. That includes the SURVIVOR of a pinch: a pinch ends while
      // a finger is still down, so the one left arrives here as a brand-new
      // press and is re-resolved. ceiling: it therefore restarts its tool
      // rather than continuing the pan (row 151) — worth a third exception AT
      // the router if it ever feels wrong in the hand, never a fork of the
      // table.
    }

    // ── the selection's own targets, before any tool is resolved ────────────
    // A live selection is grabbable with ANY tool (row 125), and its chip and
    // delete cross are tap targets that have to beat the tool underneath them.
    if (this.hasSelection() && this._selectionPress(e, dx, dy)) return;

    const tool = this.toolForEvent(e);
    if (!tool || !IMPLEMENTED_TOOLS.has(tool)) return;

    const startPts = [];
    const startPress = [];
    if ((tool === "pen" || tool === "highlighter") && this.pen.hover_lead
        && e.pointerType === "pen") {
      // free REAL data: the positions from just before contact, which the panel
      // tracked anyway. Nothing is guessed here.
      for (const [hx, hy] of hoverLeadIn(this.hoverTrail, dx, dy, e.timeStamp)) {
        startPts.push([hx, hy]);
        startPress.push(0.0);
      }
    }
    startPts.push([dx, dy]);
    startPress.push(this._pressureOf(e));

    this.active = {
      pointerId: e.pointerId,
      tool,
      device: e.pointerType,
      pts: startPts,
      press: startPress,
      lastView: [e.offsetX, e.offsetY],
      startView: [e.offsetX, e.offsetY],
      erased: [],
      touchStrokes: [],
    };
    if (tool === "eraser") this._eraseAt(dx, dy);
    this._updateCursor();
    this.requestDraw();
  }

  _pressureOf(e) {
    // A mouse has no pressure, and Sidemark treats "no pressure" as a real
    // state: the profile then comes from the taper alone. The browser reports a
    // flat 0.5 for a mouse, which would be a lie about the device.
    return e.pointerType === "pen" ? e.pressure : 1.0;
  }

  _hasPressure() {
    return this.active && this.active.device === "pen";
  }

  _onMove(e) {
    const [dx, dy] = this.toDoc(e.offsetX, e.offsetY);

    if (e.pointerType === "touch") this.latch.move(e.pointerId, e.offsetX, e.offsetY);

    if (this._pinch && this.latch.count >= 2) {
      // The pinch is the latch's OWN arithmetic — centroid and spread — rather
      // than a recognised gesture, and it is applied INCREMENTALLY so a step
      // that lands short cannot drag the whole gesture off.
      const m = this.latch.metrics();
      if (m && this._pinch.spread > 1) {
        const f = m.spread / this._pinch.spread;
        this.zoomAt(f, m.cx, m.cy);
        this.panBy(m.cx - this._pinch.cx, m.cy - this._pinch.cy);
      }
      this._pinch = { ...m, zoom: this.zoom };
      return;
    }

    if (!this.active) {
      // a stylus in proximity: this is the hover trail the lead-in reads
      if (e.pointerType === "pen" && e.buttons === 0) {
        this.hoverTrail.push([dx, dy, e.timeStamp]);
        const cut = e.timeStamp - HOVER_TRAIL_MS;
        while (this.hoverTrail.length && this.hoverTrail[0][2] < cut) {
          this.hoverTrail.shift();
        }
      }
      return;
    }
    if (e.pointerId !== this.active.pointerId) return;

    const a = this.active;
    if (a.tool === "pan") {
      this.panBy(e.offsetX - a.lastView[0], e.offsetY - a.lastView[1]);
      a.lastView = [e.offsetX, e.offsetY];
      return;
    }
    if (a.tool === "zoom") {
      a.lastView = [e.offsetX, e.offsetY];
      this.requestDraw();
      return;
    }
    if (a.tool === "move" || a.tool === "resize" || a.tool === "rotate") {
      this._transformSelection(a, dx, dy);
      a.lastView = [e.offsetX, e.offsetY];
      return;
    }

    // THE PEN'S SAMPLES ARRIVE COMPRESSED (row 147). The browser delivers one
    // pointermove per frame and buffers the rest; `getCoalescedEvents()` is the
    // trail back. Measured on this hardware the panel reports at 133 Hz while a
    // frame-rate stream sees ~30 — 78% of every stroke discarded, which is the
    // whole of what the pipeline used to call "undersampling". Walk the
    // recovered samples in BEFORE the event's own point.
    const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    const samples = coalesced.length ? coalesced : [e];
    for (const s of samples) {
      const [sx, sy] = this.toDoc(s.offsetX, s.offsetY);
      if (a.tool === "eraser") {
        this._eraseAt(sx, sy);
      } else {
        a.pts.push([sx, sy]);
        a.press.push(this._pressureOf(s));
      }
    }
    a.lastView = [e.offsetX, e.offsetY];
    this.requestDraw();
  }

  _onUp(e, cancelled = false) {
    if (e.pointerType === "touch") {
      const left = this.latch.up(e.pointerId);
      if (left < 2) this._pinch = null;
      if (left === 0) this.requestDraw();
    }
    if (!this.active || e.pointerId !== this.active.pointerId) return;
    const a = this.active;
    this.active = null;
    this._updateCursor();

    // Abandoning at the touchdown is not enough — a press can be cancelled with
    // the tool still in hand — so the guard is also HERE, at the commit.
    //
    // It is armed by the CAPTURE DEVICE, never by the touch count: a palm
    // resting on the glass during a PEN stroke must arm nothing, or writing
    // with your hand down silently loses the stroke. Ink is revocable only for
    // the hand that drew it.
    if (cancelled || (a.device === "touch" && this.latch.multi)) {
      this.requestDraw();
      return;
    }

    if (a.tool === "pen" || a.tool === "highlighter") {
      this._commitStroke(a);
    } else if (a.tool === "eraser") {
      if (a.erased.length) {
        this._pushUndo({ type: "erase", page: this.pageIndex, strokes: a.erased });
      }
    } else if (a.tool === "zoom") {
      this._zoomToRegion(a.startView, [e.offsetX, e.offsetY]);
    } else if (a.tool === "lasso") {
      const { shift } = this._chordState(e);
      this._finishLasso(a.pts, shift);
    } else if (a.tool === "move" || a.tool === "resize" || a.tool === "rotate") {
      this._commitTransform(a);
    }
    this.requestDraw();
  }

  _onLeave(e) {
    if (e.pointerType === "pen") this.hoverTrail.length = 0;
  }

  /** A second finger abandons the stroke the first FINGER began — it is taken
   * off the page rather than committed. A pen stroke is never abandoned: on a
   * convertible the palm lands before the tip does, so a touch arriving
   * mid-stroke is the hand you are writing with. */
  _abandon() {
    if (this.active && this.active.device === "touch") {
      this.active = null;
      this._updateCursor();
    }
  }

  // ── the lasso selection ────────────────────────────────────────────────────

  hasSelection() { return this.selected.length > 0; }

  /** ONE box, used by the frame AND the hit-tests, or they drift apart. */
  _selectionBbox() { return selectionBbox(this.selected); }

  _selectionScreenBox() {
    const b = this._selectionBbox();
    if (!b) return null;
    const [x0, y0] = this.toView(b[0], b[1]);
    const [x1, y1] = this.toView(b[2], b[3]);
    return [x0, y0, x1, y1];
  }

  /** The GRAB region: the LOOP in loop mode, the padded box otherwise. It has
   * to match what is painted — with the loop on screen, a press in the corner
   * of the box but outside the loop is not a grab, it is a new lasso. */
  _pointInSelection(px, py) {
    if (!this.selectionBoxed && this.selectionLoop) {
      return pointInPolygon(px, py, this.selectionLoop);
    }
    const b = this._selectionBbox();
    if (!b) return false;
    const pad = LASSO_PAD / this.zoom;
    return px >= b[0] - pad && px <= b[2] + pad
        && py >= b[1] - pad && py <= b[3] + pad;
  }

  _handleAt(sx, sy) {
    const box = this._selectionScreenBox();
    if (!box) return null;
    const pts = lassoHandlePoints(box[0], box[1], box[2], box[3], LASSO_PAD);
    for (let i = 0; i < pts.length; i++) {
      if (Math.abs(sx - pts[i][0]) <= HANDLE_HIT
          && Math.abs(sy - pts[i][1]) <= HANDLE_HIT) return i;
    }
    return null;
  }

  /** A deep copy of the selected strokes' geometry, for the undo op. */
  _snapshotSelected() {
    return this.selected.map((s) => ({
      stroke: s,
      pts: s.pts.map((p) => [p[0], p[1]]),
      width: s.width,
      loop: this.selectionLoop ? this.selectionLoop.map((p) => [p[0], p[1]]) : null,
    }));
  }

  /** Chip, delete cross, resize handle or a grab — in that order. Returns true
   * when the press has been claimed. */
  _selectionPress(e, dx, dy) {
    const box = this._selectionScreenBox();
    if (!box) return false;
    const [chx, chy] = lassoChipCentre(box[0], box[1], LASSO_PAD);
    const [dlx, dly] = lassoDeleteCentre(box[0], box[1], LASSO_PAD);

    // ANY tap target on a canvas must kill the REST of the gesture, not just
    // consume the press: a pen tap always jitters, and the drawing branch is
    // the last one in the router, so a consumed press that forgets this leaves
    // a stray mark beside the button you pressed.
    if (lassoDeleteHit(dlx, dly, e.offsetX, e.offsetY)) {
      this.deleteSelected();
      return true;
    }
    if (lassoChipHit(chx, chy, e.offsetX, e.offsetY)) {
      this.selectionBoxed = !this.selectionBoxed;
      this.requestDraw();
      return true;
    }
    const base = {
      pointerId: e.pointerId, device: e.pointerType,
      start: [dx, dy], before: this._snapshotSelected(),
      lastView: [e.offsetX, e.offsetY], startView: [e.offsetX, e.offsetY],
      pts: [], press: [], erased: [],
    };
    if (this.selectionBoxed) {
      const bbox = this._selectionBbox();
      const [kx, ky] = rotateKnobCentre(box[0], box[1], box[2]);
      if (rotateKnobHit(kx, ky, e.offsetX, e.offsetY)) {
        const cx = (bbox[0] + bbox[2]) / 2, cy = (bbox[1] + bbox[3]) / 2;
        this.active = { ...base, tool: "rotate", centre: [cx, cy],
                        startAngle: Math.atan2(dy - cy, dx - cx) };
        return true;
      }
      const handle = this._handleAt(e.offsetX, e.offsetY);
      if (handle !== null) {
        this.active = { ...base, tool: "resize", handle, bbox };
        return true;
      }
    }
    if (this._pointInSelection(dx, dy)) {
      this.active = { ...base, tool: "move" };
      this._updateCursor();
      return true;
    }
    return false;
  }

  /** Turn the drawn loop into a selection. Shift ADDS to what was already
   * selected — Shift+lasso is still the lasso, which is why this is an
   * exception AT the router rather than a fork of the binding table. */
  _finishLasso(loop, additive) {
    if (loop.length < 3) {
      // a click, not a loop: select what is under it, ink before images
      const hit = this._strokeAt(loop[0]);
      this._setSelected(hit ? [hit] : [], null);
      return;
    }
    const caught = this.strokes.filter((s) =>
      s.pts.some((p) => pointInPolygon(p[0], p[1], loop)));
    this._setSelected(additive ? mergeSelection(this.selected, caught) : caught, loop);
  }

  _strokeAt(pt) {
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      const s = this.strokes[i];
      if (strokeHit(s.pts, pt[0], pt[1], Math.max(s.width, 6) / 2 + 3)) return s;
    }
    return null;
  }

  /** `loop` null means BOX mode — a click, a paste or an additive selection has
   * no loop to wear. `_finishLasso` is the only thing that puts one back. */
  _setSelected(strokes, loop) {
    this.selected = strokes;
    this.selectionLoop = strokes.length ? loop : null;
    if (!loop) this.selectionBoxed = strokes.length > 0;
    else this.selectionBoxed = false;
    this._updateCursor();
    this.requestDraw();
  }

  clearSelection() { this._setSelected([], null); }

  deleteSelected() {
    if (!this.hasSelection()) return;
    const removed = [];
    for (const s of this.selected) {
      const i = this.strokes.indexOf(s);
      if (i >= 0) { this.strokes.splice(i, 1); removed.push({ stroke: s, index: i }); }
    }
    if (removed.length) {
      this._pushUndo({ type: "erase", page: this.pageIndex, strokes: removed });
    }
    this.clearSelection();
    this.invalidateLayer();
    this.onChange();
    this.requestDraw();
  }

  duplicateSelected() {
    if (!this.hasSelection()) return;
    const offset = DUPLICATE_OFFSET / this.zoom;
    const copies = this.selected.map((s) => ({
      ...s,
      pts: s.pts.map((p) => [p[0] + offset, p[1] + offset]),
      profile: s.profile ? s.profile.slice() : null,
    }));
    for (const c of copies) this.strokes.push(c);
    this._pushUndo({ type: "add", page: this.pageIndex, strokes: copies });
    // the copy comes back selected, so it drags immediately — with the pen or
    // the caret still in hand
    this._setSelected(copies, null);
    this.invalidateLayer();
    this.onChange();
    this.requestDraw();
  }

  /** Move or scale the live selection. One undo entry per GESTURE. */
  _transformSelection(a, dx, dy) {
    if (a.tool === "move") {
      const ox = dx - a.start[0], oy = dy - a.start[1];
      for (const rec of a.before) {
        rec.stroke.pts = rec.pts.map((p) => [p[0] + ox, p[1] + oy]);
      }
      if (a.before[0]?.loop) {
        this.selectionLoop = a.before[0].loop.map((p) => [p[0] + ox, p[1] + oy]);
      }
    } else if (a.tool === "rotate") {
      const [cx, cy] = a.centre;
      let angle = Math.atan2(dy - cy, dx - cx) - a.startAngle;
      if (this._heldMods.shift) {
        // Shift snaps the TOTAL angle, not the delta — snapping the delta would
        // make the result depend on where you grabbed the knob
        const step = (ROTATE_SNAP_DEG * Math.PI) / 180;
        angle = Math.round(angle / step) * step;
      }
      for (const rec of a.before) {
        rec.stroke.pts = rec.pts.map((p) => rotatePoint(p, angle, cx, cy));
      }
      if (a.before[0]?.loop) {
        this.selectionLoop = a.before[0].loop.map((p) => rotatePoint(p, angle, cx, cy));
      }
    } else {
      const { mode, anchor } = lassoHandleAnchor(a.handle, a.bbox);
      const [fx, fy] = lassoScaleFactors(mode, anchor, a.start, [dx, dy]);
      for (const rec of a.before) {
        rec.stroke.pts = rec.pts.map((p) => scalePoint(p, fx, fy, anchor[0], anchor[1]));
        // a stroke's width scales with the area, so a uniform resize keeps it
        // looking like the same pen
        rec.stroke.width = rec.width * Math.sqrt(Math.abs(fx * fy));
      }
      if (a.before[0]?.loop) {
        this.selectionLoop = a.before[0].loop
          .map((p) => scalePoint(p, fx, fy, anchor[0], anchor[1]));
      }
    }
    this.invalidateLayer();
    this.requestDraw();
  }

  _commitTransform(a) {
    const moved = a.before.some((rec, i) =>
      rec.pts.length !== rec.stroke.pts.length
      || rec.pts.some((p, j) => p[0] !== rec.stroke.pts[j][0]
                             || p[1] !== rec.stroke.pts[j][1]));
    if (!moved) return;
    this._pushUndo({ type: "reshape", page: this.pageIndex, records: a.before,
                     after: a.before.map((rec) => ({
                       pts: rec.stroke.pts.map((p) => [p[0], p[1]]),
                       width: rec.stroke.width,
                     })) });
    this.onChange();
  }

  // ── committing ─────────────────────────────────────────────────────────────

  _commitStroke(a) {
    const flat = a.tool === "highlighter";
    const press = this._hasPressureFor(a) ? a.press : [];
    const { pts, profile } = finishInkStroke(a.pts, press, this.pen.smoothing, {
      flat,
      minPressure: this.pen.min_pressure,
    });
    if (pts.length < 1) return;
    const stroke = {
      pts,
      profile,
      width: flat ? this.pen.hl_width : this.pen.pen_width,
      color: flat ? this.pen.hl_color : this.pen.pen_color,
      opacity: flat ? this.pen.hl_opacity : 1.0,
      flat,
    };
    this.strokes.push(stroke);
    this._pushUndo({ type: "draw", page: this.pageIndex, stroke });
    this._appendToLayer(stroke);
    this.onChange();
  }

  _hasPressureFor(a) { return a.device === "pen"; }

  _eraseAt(x, y) {
    // The eraser deletes a whole stroke on contact — this is not a brush size,
    // it is "did I touch the ink", which is why the radius tracks the stroke's
    // own width. One undo entry per drag, not per stroke removed.
    const a = this.active;
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      const s = this.strokes[i];
      if (strokeHit(s.pts, x, y, eraseRadius(s.width))) {
        this.strokes.splice(i, 1);
        a.erased.push({ stroke: s, index: i });
        this.invalidateLayer();
        this.onChange();
      }
    }
  }

  _zoomToRegion(from, to) {
    const x = Math.min(from[0], to[0]), y = Math.min(from[1], to[1]);
    const w = Math.abs(to[0] - from[0]), h = Math.abs(to[1] - from[1]);
    if (w < 8 || h < 8) return;      // a click, not a region
    const f = Math.min(this.cssW / w, this.cssH / h);
    const cx = x + w / 2, cy = y + h / 2;
    this.zoomAt(f, cx, cy);                            // the centre stays put…
    this.panBy(this.cssW / 2 - cx, this.cssH / 2 - cy);  // …then moves to middle
  }

  // ── undo ───────────────────────────────────────────────────────────────────

  _pushUndo(op) {
    this.undoStack.push(op);
    this.redoStack.length = 0;
  }

  /** The page an undo op belongs to — an op carries its own, so undoing a
   * stroke drawn three pages back edits THAT page rather than whatever is in
   * front now. Undo also brings you to the page it changed: a Ctrl+Z whose
   * effect you cannot see reads as nothing having happened. */
  _opStrokes(op) {
    if (!this.doc) return this.strokes;
    if (op.page !== this.pageIndex) this.setPage(op.page);
    return this.doc.strokesFor(op.page);
  }

  undo() {
    const op = this.undoStack.pop();
    if (!op) return;
    const strokes = this._opStrokes(op);
    if (op.type === "draw") {
      const i = strokes.lastIndexOf(op.stroke);
      if (i >= 0) strokes.splice(i, 1);
    } else if (op.type === "erase") {
      for (const { stroke, index } of op.strokes) {
        strokes.splice(Math.min(index, strokes.length), 0, stroke);
      }
    } else if (op.type === "add") {
      for (const stroke of op.strokes) {
        const i = strokes.lastIndexOf(stroke);
        if (i >= 0) strokes.splice(i, 1);
      }
    } else if (op.type === "reshape") {
      for (const rec of op.records) {
        rec.stroke.pts = rec.pts.map((p) => [p[0], p[1]]);
        rec.stroke.width = rec.width;
      }
    }
    // a stale loop after an undone move is impossible only because undo clears
    // the selection — do not remove this
    this.clearSelection();
    this.redoStack.push(op);
    this.invalidateLayer();
    this.onChange();
    this.requestDraw();
  }

  redo() {
    const op = this.redoStack.pop();
    if (!op) return;
    const strokes = this._opStrokes(op);
    if (op.type === "draw") {
      strokes.push(op.stroke);
    } else if (op.type === "erase") {
      for (const { stroke } of op.strokes) {
        const i = strokes.lastIndexOf(stroke);
        if (i >= 0) strokes.splice(i, 1);
      }
    } else if (op.type === "add") {
      for (const stroke of op.strokes) strokes.push(stroke);
    } else if (op.type === "reshape") {
      op.records.forEach((rec, i) => {
        rec.stroke.pts = op.after[i].pts.map((p) => [p[0], p[1]]);
        rec.stroke.width = op.after[i].width;
      });
    }
    this.clearSelection();
    this.undoStack.push(op);
    this.invalidateLayer();
    this.onChange();
    this.requestDraw();
  }

  clear() {
    const strokes = this.strokes;
    if (!strokes.length) return;
    this._pushUndo({ type: "erase", page: this.pageIndex,
                     strokes: strokes.map((s, i) => ({ stroke: s, index: i })) });
    strokes.length = 0;          // in place: `strokes` is the page's own array
    this.invalidateLayer();
    this.onChange();
    this.requestDraw();
  }

  // ── painting ───────────────────────────────────────────────────────────────

  requestDraw() {
    if (this._frame) return;
    this._frame = requestAnimationFrame(() => {
      this._frame = null;
      this.draw();
    });
  }

  invalidateLayer() { this._layerKey = null; }

  /** Committed ink is cached into its own layer and blitted, so a page of
   * handwriting costs one image draw per frame instead of re-outlining every
   * stroke (row 147: flat ~1.5 ms/frame against 66 ms at 400 strokes). An
   * append is painted onto the existing layer rather than rebuilding it. */
  _ensureLayer() {
    const dpr = window.devicePixelRatio || 1;
    const key = `${this.cssW}x${this.cssH}@${dpr}:${this.zoom}:${this.offX}:${this.offY}:${this.strokes.length}`;
    if (this._layerKey === key) return;
    if (!this._layer) this._layer = document.createElement("canvas");
    this._layer.width = Math.max(1, Math.round(this.cssW * dpr));
    this._layer.height = Math.max(1, Math.round(this.cssH * dpr));
    const lc = this._layer.getContext("2d");
    lc.setTransform(dpr, 0, 0, dpr, 0, 0);
    lc.clearRect(0, 0, this.cssW, this.cssH);
    for (const s of this.strokes) this._paintStroke(lc, s);
    this._layerKey = key;
  }

  _appendToLayer(stroke) {
    if (this._layerKey === null || !this._layer) return;   // nothing to append to
    const dpr = window.devicePixelRatio || 1;
    const lc = this._layer.getContext("2d");
    lc.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._paintStroke(lc, stroke);
    this._layerKey = `${this.cssW}x${this.cssH}@${dpr}:${this.zoom}:${this.offX}:${this.offY}:${this.strokes.length}`;
  }

  _paintStroke(ctx, s) {
    ctx.save();
    ctx.translate(this.offX, this.offY);
    ctx.scale(this.zoom, this.zoom);
    ctx.fillStyle = rgbCss(s.color, s.opacity);
    ctx.strokeStyle = rgbCss(s.color, s.opacity);
    drawInkStroke(ctx, s.pts, s.width, s.profile);
    ctx.restore();
  }

  draw() {
    const dpr = window.devicePixelRatio || 1;
    const ctx = this.ctx;
    if (this.el.width !== Math.round(this.cssW * dpr)
        || this.el.height !== Math.round(this.cssH * dpr)) {
      this.el.width = Math.round(this.cssW * dpr);
      this.el.height = Math.round(this.cssH * dpr);
      this.invalidateLayer();
      if (this._fitPending) { this._fitPending = false; this.fit(); }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);

    // the page itself: the rendered PDF, or white paper before one is open.
    // The bitmap is drawn to the page's document-unit rect whatever scale it
    // was rendered at, so a zoom shows a stretched page for one beat rather
    // than blocking on pdf.js — the re-render lands behind it.
    ctx.save();
    ctx.translate(this.offX, this.offY);
    ctx.scale(this.zoom, this.zoom);
    ctx.fillStyle = "#ffffff";
    ctx.shadowColor = "rgba(0,0,0,0.28)";
    ctx.shadowBlur = 12 / this.zoom;
    ctx.shadowOffsetY = 2 / this.zoom;
    ctx.fillRect(0, 0, this.pageW, this.pageH);
    ctx.restore();
    if (this._pageKey && this._pageCanvas.width > 1) {
      ctx.save();
      ctx.translate(this.offX, this.offY);
      ctx.scale(this.zoom, this.zoom);
      ctx.drawImage(this._pageCanvas, 0, 0, this.pageW, this.pageH);
      ctx.restore();
    }

    this._ensureLayer();
    ctx.drawImage(this._layer, 0, 0, this.cssW, this.cssH);

    this._drawLive(ctx);
    this._drawLassoPath(ctx);
    this._drawSelection(ctx);
    this._drawZoomMarquee(ctx);
  }

  _drawLive(ctx) {
    const a = this.active;
    if (!a || (a.tool !== "pen" && a.tool !== "highlighter")) return;
    const flat = a.tool === "highlighter";
    const press = this._hasPressureFor(a) ? a.press : [];
    let pts = a.pts, profile = null;
    if (this.pen.live_smooth) {
      // The same three jobs run LIVE, so the line under the nib is the line you
      // are left with. Its cost is the TAIL re-settling on each report — which
      // is why this is a switch and not a default nobody chose.
      const out = liveInkStroke(a.pts, press, this.pen.smoothing, { flat });
      pts = out.pts;
      profile = out.profile;
    } else if (!flat && press.length) {
      // off, the raw polyline never moves once drawn, and re-forms on release
      pts = a.pts;
    }
    ctx.save();
    ctx.translate(this.offX, this.offY);
    ctx.scale(this.zoom, this.zoom);
    const color = flat ? this.pen.hl_color : this.pen.pen_color;
    const width = flat ? this.pen.hl_width : this.pen.pen_width;
    ctx.fillStyle = rgbCss(color, flat ? this.pen.hl_opacity : 1.0);
    ctx.strokeStyle = rgbCss(color, flat ? this.pen.hl_opacity : 1.0);
    drawInkStroke(ctx, pts, width, profile);
    ctx.restore();
  }

  /** The loop being drawn, in flight. */
  _drawLassoPath(ctx) {
    const a = this.active;
    if (!a || a.tool !== "lasso" || a.pts.length < 2) return;
    ctx.save();
    ctx.translate(this.offX, this.offY);
    ctx.scale(this.zoom, this.zoom);
    ctx.strokeStyle = "rgba(53, 132, 228, 0.9)";
    ctx.lineWidth = 1.2 / this.zoom;
    ctx.setLineDash([5 / this.zoom, 4 / this.zoom]);
    ctx.beginPath();
    ctx.moveTo(a.pts[0][0], a.pts[0][1]);
    for (const p of a.pts.slice(1)) ctx.lineTo(p[0], p[1]);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  /** The selection frame. A selection wears the LOOP it was drawn with; the
   * chip switches to the box, and the resize handles exist ONLY there — a
   * hit-test that outlives its painter is exactly how a frame drifts from what
   * a grab catches. */
  _drawSelection(ctx) {
    if (!this.hasSelection()) return;
    const box = this._selectionScreenBox();
    if (!box) return;
    const accent = "rgb(53, 132, 228)";
    ctx.save();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.2;

    if (!this.selectionBoxed && this.selectionLoop) {
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      const first = this.toView(this.selectionLoop[0][0], this.selectionLoop[0][1]);
      ctx.moveTo(first[0], first[1]);
      for (const p of this.selectionLoop.slice(1)) {
        const v = this.toView(p[0], p[1]);
        ctx.lineTo(v[0], v[1]);
      }
      ctx.closePath();
      ctx.stroke();
    } else {
      const [x0, y0, x1, y1] = box;
      const p = LASSO_PAD;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x0 - p, y0 - p, (x1 - x0) + p * 2, (y1 - y0) + p * 2);
      ctx.setLineDash([]);
      ctx.fillStyle = "#ffffff";
      for (const [hx, hy] of lassoHandlePoints(x0, y0, x1, y1, p)) {
        ctx.beginPath();
        ctx.rect(hx - 4, hy - 4, 8, 8);
        ctx.fill();
        ctx.stroke();
      }
      drawRotateKnob(ctx, x0, y0, x1, accent);
    }
    ctx.restore();

    const [chx, chy] = lassoChipCentre(box[0], box[1], LASSO_PAD);
    drawLassoChip(ctx, chx, chy, this.selectionBoxed, accent);
    const [dlx, dly] = lassoDeleteCentre(box[0], box[1], LASSO_PAD);
    drawLassoDelete(ctx, dlx, dly);
  }

  _drawZoomMarquee(ctx) {
    const a = this.active;
    if (!a || a.tool !== "zoom") return;
    const [x0, y0] = a.startView, [x1, y1] = a.lastView;
    ctx.save();
    ctx.strokeStyle = "rgba(53, 132, 228, 0.9)";
    ctx.fillStyle = "rgba(53, 132, 228, 0.12)";
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    const x = Math.min(x0, x1), y = Math.min(y0, y1);
    const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    ctx.restore();
  }

  /** Under a stylus the POINTER is hidden for drawing tools — an arrow trailing
   * the nib is what gives the lag away — but never under a mouse, where the
   * pointer is all the hand has. */
  _updateCursor() {
    const a = this.active;
    const drawing = a && (a.tool === "pen" || a.tool === "highlighter");
    if (drawing && a.device === "pen") this.el.style.cursor = "none";
    else if (a && a.tool === "pan") this.el.style.cursor = "grabbing";
    else if (a && a.tool === "move") this.el.style.cursor = "grabbing";
    else if (a && a.tool === "rotate") this.el.style.cursor = "grabbing";
    else this.el.style.cursor = "crosshair";
  }
}
