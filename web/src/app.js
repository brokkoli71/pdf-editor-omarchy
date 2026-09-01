// The chrome: the toolbar as a binding surface, the live stripes, the pen
// popover and the bindings list. Ported from PDFEditorWindow's tool-bar and
// pen-popover code, minus the rows this prototype does not implement.

import {
  Bindings, TOOL_BAR_ORDER, TOOL_LABELS, TOOL_MODES, BUTTON_NAMES,
  BUTTON_LABELS, canonicalTool, toolInMode, chordId, chordLabel,
  toolbarBindingFor, BTN_LEFT, BTN_FINGER,
} from "./bindings.js";
import { Surface, IMPLEMENTED_TOOLS } from "./surface.js";
import { Doc, mergeDocuments, insertDocuments } from "./doc.js";
import { applyPageOrder, deletePages, moveRangeOrder, addBlankPage,
         blankPdfBytes } from "./merge.js";
import { Sidebar } from "./sidebar.js";
import { NotesView } from "./notes.js";
import { NotesModel } from "./notes-model.js";
import { saveDocument, openWithPicker, canSaveInPlace, exportPages,
         extractPages, exportName, saveNotesAs } from "./save.js";
import { saveSession, loadSession, clearSession } from "./session.js";
import { listRecent, rememberRecent, forgetRecent, clearRecent,
         recentState, openRecent } from "./recent.js";
import { Search } from "./search.js";
import { Presenter, Timer } from "./presenter.js";
import { putHandoff, takeHandoff } from "./db.js";

// ── settings (the settings.json analogue) ────────────────────────────────────

/** SANDBOX MODE — the app running as somebody's exhibit rather than as their
 * app. `/demo` embeds a real Sidemark and drives it, and a tutorial must not
 * cost you anything: settings are READ so the sandbox looks like your app, and
 * nothing is written back. The session and the recents list are left alone
 * entirely. Deliberately one query parameter rather than a build flag — it has
 * to BE the app, or the demo teaches something else.
 *
 * The button table is the load-bearing one: a step that asks you to put the
 * lasso on the middle button would otherwise rebind your real Sidemark, since
 * `Bindings.save()` persists on every rebind. */
export const SANDBOX = new URLSearchParams(location.search).has("sandbox");

/** LIVE MODE — this port running as a phone attached to a desktop Sidemark.
 * The desktop's `_ShareServer` serves these files under its own token path and
 * points the phone at `?live=1`; the document then arrives over the wire from
 * `../live.pdf` instead of from a file somebody picked, and the DESKTOP stays
 * the truth — every change there re-delivers it (`../state`'s `rev`).
 *
 * It exists because the phone needs a camera of its own. The small viewer the
 * desktop also serves is an image of the desktop's view, so it can only ever
 * show what the desktop shows — which is why zoom had to be deferred there.
 * Here the phone holds the real document and its own zoom, and ink drawn on it
 * is in DOCUMENT coordinates, which is what a stroke has to be to survive
 * being drawn under a camera the desktop knows nothing about.
 *
 * Nothing is persisted in this mode: the document belongs to another machine
 * and is open only as long as the connection is, so writing it into this
 * browser's session or recents would strand a stale copy of somebody else's
 * file here. */
export const LIVE = new URLSearchParams(location.search).has("live");

/** A touch-only device — a phone or a tablet, not a laptop with a touchscreen.
 *
 * `hover: none` is what separates them: a laptop reports `hover: hover` for
 * its mouse even when it also has a digitiser, and the whole point of the
 * mobile layout is that there is no second pointer and no hovering. It also
 * means the binding stripes have nothing to say — every press comes from one
 * finger, so a readout of which BUTTON holds which tool is a column of
 * identical colours taking up the bar.
 *
 * Read once: a device does not grow a mouse mid-session, and re-deciding the
 * layout underneath somebody is worse than getting a rare case wrong. */
export const MOBILE = matchMedia("(pointer: coarse) and (hover: none)").matches;

const STORE_KEY = "sidemark.web.settings";
const store = {
  _data: null,
  _load() {
    if (this._data) return this._data;
    try { this._data = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
    catch { this._data = {}; }
    return this._data;
  },
  get(key) { return this._load()[key]; },
  set(key, value) {
    this._load()[key] = value;
    if (SANDBOX) return;              // remembered for this visit, and no longer
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this._data)); } catch { /* private mode */ }
  },
};

// The pen belongs to the APP, not to a tab or a run. Each entry carries the
// range the value is legal in, because the store is something a user can edit:
// a junk value must fall back to the default, not reach the ink pipeline.
const PEN_SETTINGS = {
  pen_color:    ["rgb", null],
  pen_width:    ["num", [0.3, 5.0]],
  hl_color:     ["rgb", null],
  hl_width:     ["num", [4.0, 24.0]],
  smoothing:    ["num", [0.0, 1.0]],
  min_pressure: ["num", [0.0, 0.5]],
  hover_lead:   ["bool", null],
  live_smooth:  ["bool", null],
  shape_snap:   ["choice", ["off", "lines", "shapes"]],
};

const PEN_DEFAULTS = {
  pen_color: [0.05, 0.05, 0.8],
  pen_width: 2.0,
  hl_color: [1.0, 0.85, 0.0],
  hl_width: 12.0,
  hl_opacity: 0.40,
  smoothing: 0.5,
  min_pressure: 0.0,
  hover_lead: false,
  live_smooth: true,
  shape_snap: "shapes",
};

function penSetting(saved, key, def) {
  const [kind, bounds] = PEN_SETTINGS[key] || [];
  const v = saved[key];
  if (v === undefined) return def;
  if (kind === "num") {
    if (typeof v !== "number" || !Number.isFinite(v)) return def;
    return Math.max(bounds[0], Math.min(bounds[1], v));
  }
  if (kind === "bool") return typeof v === "boolean" ? v : def;
  if (kind === "choice") return bounds.includes(v) ? v : def;
  if (kind === "rgb") {
    if (!Array.isArray(v) || v.length !== 3) return def;
    if (!v.every((c) => typeof c === "number" && c >= 0 && c <= 1)) return def;
    return v;
  }
  return def;
}

const savedPen = store.get("pen") || {};
const pen = { ...PEN_DEFAULTS };
for (const key of Object.keys(PEN_SETTINGS)) {
  pen[key] = penSetting(savedPen, key, PEN_DEFAULTS[key]);
}

function setPenSetting(key, value) {
  pen[key] = value;
  const raw = store.get("pen") || {};
  raw[key] = value;
  store.set("pen", raw);
}

// ── tool glyphs ──────────────────────────────────────────────────────────────

const GLYPHS = {
  pen: '<path d="M12.4 2.4a1.5 1.5 0 0 1 2.2 2.2L6.4 12.8 3 14l1.2-3.4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
  highlighter: '<path d="M5 11.5 10.8 5.7a1.6 1.6 0 0 1 2.3 0l.2.2a1.6 1.6 0 0 1 0 2.3L7.5 14H4.4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M2.6 15.4h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  eraser: '<path d="M7.4 13.4H14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M2.7 10.1 8.3 4.5a1.5 1.5 0 0 1 2.1 0l2.6 2.6a1.5 1.5 0 0 1 0 2.1l-4 4H4.6l-1.9-1.9a1.5 1.5 0 0 1 0-2.2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
  lasso: '<ellipse cx="8.5" cy="7" rx="5.5" ry="4.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2.4 2"/><path d="M5 10.6c-.8 1.6-.4 2.9.8 3.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  text: '<path d="M6 3h4M6 13h4M8 3v10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  pan: '<path d="M8 2.5v11M2.5 8h11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M5.6 5 8 2.6 10.4 5M11 5.6 13.4 8 11 10.4M10.4 11 8 13.4 5.6 11M5 10.4 2.6 8 5 5.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  zoom: '<circle cx="7" cy="7" r="4.3" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.2 10.2 14 14M5 7h4M7 5v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  anchor: '<circle cx="8" cy="4.4" r="1.8" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 6.2V14M4.4 10.4A3.6 3.6 0 0 0 8 14a3.6 3.6 0 0 0 3.6-3.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
};

// one colour per button, painted rather than themed
const ACCENT = [0.208, 0.518, 0.894];        // Adwaita #3584e4
const BUTTON_COLORS = {
  left: null,                                 // null = the theme accent
  right: [0.83, 0.34, 0.17],
  middle: [0.23, 0.60, 0.36],
  thumb: [0.79, 0.60, 0.12],
  finger: [0.55, 0.35, 0.85],
};
const cssRgb = (c) => `rgb(${c.map((v) => Math.round(v * 255)).join(" ")})`;

const SWATCHES = [
  ["Accent", ACCENT],
  ["Red", [0.75, 0.11, 0.16]],
  ["Black", [0.05, 0.05, 0.05]],
  ["Brown", [0.60, 0.40, 0.18]],
  ["Teal", [0.13, 0.55, 0.55]],
  ["Gray", [0.50, 0.50, 0.52]],
];

// ── boot ─────────────────────────────────────────────────────────────────────

const bindings = Bindings.load(store);
const heldMods = { ctrl: false, shift: false, alt: false };

const surface = new Surface(document.getElementById("page"), pen, bindings, {
  onChange: () => { refreshUndo(); markDirty(true); rememberSession(); },
  // LIVE mode: mirror raw samples to the desktop as they are drawn. Null in
  // every other mode, which is what keeps the stream out of the normal app.
  onInkStream: LIVE ? (msg) => liveSend(msg) : null,
  onStrokeDone: (stroke) => onStrokeDoneForAdvance(stroke),
  onLiveDraw: () => presenter.request(),
  // an anchor edits the NOTES, so the panel has to be told to re-read them
  onNotesChanged: () => { notes.showPage(surface.pageIndex); markDirty(true); },
  // a press proved a tracked modifier was not really held; the window's copy is
  // what the stripes are generated from, so it has to follow
  onHeldModsCorrected: (mods) => { Object.assign(heldMods, mods); refreshToolBindings(); },
  onNotesRestored: () => {
    notes.showPage(surface.pageIndex);
    syncPageChrome();
    sidebar.setDoc(surface.doc);
  },
  onPageChange: (page) => {
    sidebar.setPage(page);
    notes.showPage(page);
    syncPageChrome();
    presenter.request();
    rememberSession();
  },
});

const notes = new NotesView(document.getElementById("notes"), {
  onDirty: () => { markDirty(true); rememberSession(); },
  // WHERE YOU ARE follows the caret while the sheet is open (row 153): the
  // pages are off screen, so the sidebar's current row and its outline line are
  // the only thing left saying which page you are writing on — and pointing
  // `setPage` at it scrolls the strip to that row for free.
  //
  // The SIDEBAR only. The canvas is not turned until the sheet closes: it would
  // re-render a page nobody can see on every keystroke, and it is `setFull` on
  // the way out that knows how to read a caret that never moved.
  onCaretPage: (page) => sidebar.setPage(page),
});

const presenter = new Presenter({
  // paging from the projected window drives the EDITOR, so the two cannot drift
  onNav: (delta) => surface.flipPage(delta),
  onNeedFrame: async () => {
    const size = presenter.frameSize();
    if (!size) return;
    presenter.show(await surface.mirrorFrame(size[0], size[1]));
  },
  onClose: () => syncPresenting(),
});

const timer = new Timer(() => {
  document.getElementById("timer").textContent = Timer.format(timer.seconds);
});

const sidebar = new Sidebar(document.getElementById("sidebar"), {
  // Absolute nav, never a flip — and on the sheet "go to page" can only mean
  // "go to its notes", or the row you just clicked would light up while nothing
  // moved. `goToPage` is a no-op unless the sheet is open.
  onGoToPage: (page) => { surface.setPage(page); notes.goToPage(page); },
  onDropFiles: (files, gap) => importAt(files, gap),
  onMovePage: (from, to) => movePage(from, to),
  onDeletePages: (pages) => removePages(pages),
  onExportPages: (pages) => doExportPages(pages),
  onSelectionChanged: (pages) => preparePageDrag(pages),
  onDragArm: (index) => preparePageDrag(sidebar.pagesActedOn(index)),
  onDragPayload: (index) => pageDragPayload(index),
  onDropPages: (key, gap) => importHandoff(key, gap),
  onDropBookmark: (page) => dropBookmark(page),
  onToggleHidden: (page, unhide) => toggleHidden(page, unhide),
  onAddPage: (page, kind) => addPageAfter(page, kind),
  showBookmarks: store.get("outline_bookmarks") !== false,
  onShowBookmarks: (on) => store.set("outline_bookmarks", on),
});

const search = new Search(
  { get pageCount() { return surface.doc ? surface.doc.pageCount : 0; },
    get notes() { return surface.doc ? surface.doc.notes : null; },
    getPage: (i) => surface.doc.page(i) },
  {
    onUpdate: () => refreshSearch(),
    onGoTo: (m) => { if (m.page !== surface.pageIndex) surface.setPage(m.page);
                     else surface.requestDraw(); },
  });
surface.searchRects = (page) => search.rectsOn(page);

const toolStrips = new Map();   // tool → [strip elements]

buildToolbar(document.getElementById("toolbar"));
buildToolbar(document.getElementById("popover-toolbar"));
buildSwatches();
refreshPenSwatch();
wirePopover();
wireKeys();
wireDocument();
wireDivider();
wireSearch();
wireBookmarks();
wireRecent();
wireMoreMenu();
wirePaste();
wirePresenter();
wireNotesPanel();
refreshToolBindings();
refreshUndo();

// A read-only window onto the live model, for driving the app from a browser
// session rather than reading its source. Everything painful in this port has
// been WIRING — a handler that is correct and never reached — and the only way
// to tell those apart is to press the thing for real and then ask the model what
// happened. Squinting at a screenshot answers "is there a line?", never "do
// these two points share a coordinate". Nothing here is written to; it is the
// same objects the app is using, so reading it cannot change behaviour.
window.__sidemark = {
  get surface() { return surface; },
  get doc() { return surface.doc; },
  get strokes() { return surface.strokes; },
  get selected() { return surface.selected; },
  get bindings() { return bindings; },
  get pen() { return pen; },
  get notes() { return notes; },
  get sidebar() { return sidebar; },
  // The divider IS the way between the modes, so driving it is how the sheet
  // gets opened without a synthetic drag that carries no user activation.
  setSplit(frac) { wireDivider.setSplit(frac, { remember: false }); },
};

/** The mobile layout. Everything it can do with a class it does with a class —
 * the CSS is where "less vertical space" actually lives — and it only reaches
 * into the DOM for the three things that are a MOVE rather than a hide.
 *
 * The rule behind all of it: a phone has one finger, a small screen and, in a
 * shared session, no business saving somebody else's document. */
function applyMobileLayout() {
  document.body.classList.toggle("mobile", MOBILE);
  document.body.classList.toggle("live", LIVE);

  // A shared session is a window onto somebody ELSE'S live document, whatever
  // it is opened on — Open would replace it and Save would write a copy of it
  // onto this device, and neither is anything the person who scanned the code
  // means by them. Download stays, in the menu, because wanting a copy is
  // legitimate. Not gated on MOBILE: a laptop that scans the link is just as
  // much a guest.
  if (LIVE) {
    for (const id of ["open-btn", "save-btn"]) {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    }
    addMenuLink("Download this document", "../doc.pdf");
  }

  if (!MOBILE) return;

  // The sidebar AND the notes start collapsed. They are the two biggest space
  // costs on a phone and both are one tap away. The notes go through
  // toggleNotes rather than the divider directly, so the button's own state
  // cannot disagree with where the split actually sits.
  const bar = document.getElementById("sidebar");
  if (bar) bar.hidden = true;
  // after the divider has been wired and the first layout has happened, or
  // the split is applied to a pane that has not been measured yet
  requestAnimationFrame(() => toggleNotes(false));

  // Presenter mode leaves the header for the menu: mirroring to a second
  // screen is not a thing you do from a phone often enough to spend a button.
  moveToMenu("present-btn", "Presenter mode");

  addFullscreenEntry();

  // Writing on a phone runs out of room in a few words; this moves the page
  // for you when you stop. Off by default — a view that moves on its own is
  // the last thing you want when you are not writing prose.
  advanceOn = !!store.get("write_advance");
  const item = addMenuToggle("Advance while writing", advanceOn, (on) => {
    advanceOn = on;
    store.set("write_advance", on);
    resetAdvanceRun();
    if (!on) cancelAdvance();
  });
  if (item) item.title = "When you write to the edge of the screen and pause, "
                       + "the page moves along so you can carry on.";
  // starting another stroke means you had not finished after all
  const page = document.getElementById("page");
  if (page) page.addEventListener("pointerdown", cancelAdvance, { capture: true });
}

/** Fullscreen, which on a phone is worth more than any layout tweak: the
 * browser's own chrome is the single biggest consumer of height, and in
 * landscape it is most of what is left after the page.
 *
 * Offered only where it EXISTS. Safari implements `requestFullscreen` for
 * video and nothing else, so on iOS this entry would be a button that does
 * nothing — there the answer is Add to Home Screen, which runs without chrome
 * (see the apple-mobile-web-app-capable meta in index.html) and is the only
 * route Apple gives.
 *
 * The state is the BROWSER's, not ours: you can leave fullscreen with a
 * gesture or the Escape key without touching this, so the label follows
 * `fullscreenchange` rather than what we last asked for. */
function addFullscreenEntry() {
  const root = document.documentElement;
  const request = root.requestFullscreen || root.webkitRequestFullscreen;
  if (!request) return;                 // iOS Safari: nothing to offer
  const menu = document.getElementById("more-popover");
  if (!menu) return;

  const item = document.createElement("button");
  item.className = "flat menu-item";

  // ...and a BUTTON IN THE HEADER as well, beside the ☰. In landscape the
  // browser's own chrome is most of what is left after the page, so this is
  // the control you reach for first — a menu entry for it is two taps for
  // the thing that gives you back the room to work in. Same handler, so the
  // two cannot disagree.
  const hdr = document.createElement("button");
  hdr.className = "flat icon-btn fullscreen-btn";
  hdr.setAttribute("aria-label", "Fullscreen");
  hdr.innerHTML =
    '<svg viewBox="0 0 16 16" aria-hidden="true">'
    + '<path d="M2 6V2.5h3.5M14 6V2.5h-3.5M2 10v3.5h3.5M14 10v3.5h-3.5"'
    + ' fill="none" stroke="currentColor" stroke-width="1.5"'
    + ' stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const more = document.getElementById("more-btn");
  if (more && more.parentNode) more.parentNode.insertBefore(hdr, more);

  const paint = () => {
    const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
    item.textContent = on ? "Leave fullscreen" : "Fullscreen";
    item.setAttribute("aria-pressed", String(on));
    hdr.setAttribute("aria-pressed", String(on));
    hdr.title = on ? "Leave fullscreen" : "Fullscreen";
    hdr.classList.toggle("on", on);
  };
  paint();
  hdr.addEventListener("click", () => item.click());
  item.addEventListener("click", () => {
    // the click IS the user gesture the API requires; a rejected promise just
    // means the browser said no, which is not worth an error on screen
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else {
      request.call(root);
    }
  });
  for (const ev of ["fullscreenchange", "webkitfullscreenchange"]) {
    document.addEventListener(ev, () => {
      paint();
      // the viewport just changed size by the height of the browser's chrome
      surface.requestDraw();
    });
  }
  (menu.querySelector(".popover-body") || menu).appendChild(item);
}

/** A menu row that remembers an on/off state. */
function addMenuToggle(label, initial, onChange) {
  const menu = document.getElementById("more-popover");
  if (!menu) return null;
  const item = document.createElement("button");
  item.className = "flat menu-item";
  item.setAttribute("aria-pressed", String(initial));
  const paint = (on) => { item.textContent = (on ? "✓ " : "") + label; };
  paint(initial);
  item.addEventListener("click", () => {
    const on = item.getAttribute("aria-pressed") !== "true";
    item.setAttribute("aria-pressed", String(on));
    paint(on);
    onChange(on);
  });
  (menu.querySelector(".popover-body") || menu).appendChild(item);
  return item;
}

// ── write and advance ────────────────────────────────────────────────────────
// Writing on a phone runs out of room in about four words. The page then has
// to move, and the only moment it can move WITHOUT interrupting you is the one
// after you have finished a stroke near the edge and not started another.
//
// Deliberately no character segmentation and no recognition. The question here
// is "have you run out of room?", which a stroke's own end position answers
// exactly; asking "was that a letter?" needs to know where one character stops
// and the next begins, and a pen lift does not tell you that (i, t, x and every
// capital are several strokes). That is a different feature — see the note in
// ideas.csv row 182.
//
// Purely a camera move: the phone already holds its own view (row 182's
// independent camera), ink is committed in DOCUMENT coordinates, and the
// desktop is not consulted. So this cannot displace a stroke or desync a
// shared session — the worst it can do is scroll at a moment you did not want.
const ADVANCE_EDGE = 0.72;      // "near the edge": a fraction of the viewport
const ADVANCE_REST = 0.15;      // where the writing's right edge lands after
const ADVANCE_WAIT_MS = 450;    // the pause that means "I have finished"
const ADVANCE_MS = 260;         // how long the move itself takes
const ADVANCE_LINE = 1.7;       // line spacing, in multiples of what you wrote
const ADVANCE_MARGIN = 0.04;    // where the page's left edge sits on a new line

let advanceOn = false;
let advanceTimer = null;
let advanceAnim = null;
// The extent of what has been written since the last move, in document units.
// Tracked across STROKES, not per stroke, because "have I reached the edge?"
// is a question about the writing and not about the last mark: the stroke that
// happens to finish a word is often a short one going backwards — the dot of
// an i, the bar of a t — and judging by it alone means the page refuses to
// move at exactly the moment you have run out of room.
let advanceRight = -Infinity;

function cancelAdvance() {
  clearTimeout(advanceTimer);
  advanceTimer = null;
  if (advanceAnim) cancelAnimationFrame(advanceAnim);
  advanceAnim = null;
}

/** Forget the run's extent — after a move, and whenever the view is no longer
 * the one the extent was measured against. */
function resetAdvanceRun() {
  advanceRight = -Infinity;
}

/** Glide the view by (dx, dy) view pixels. Animated because a page that
 * teleports leaves you hunting for where you had got to. */
function advanceGlide(dx, dy) {
  const t0 = performance.now();
  // panBy is INCREMENTAL, so each frame moves by the difference from the last
  // one rather than the total — accumulating the eased total instead would
  // apply the whole distance again on every frame.
  let sx = 0, sy = 0;
  const step = (now) => {
    const k = Math.min(1, (now - t0) / ADVANCE_MS);
    const e = 1 - Math.pow(1 - k, 3);        // ease-out: moves, then settles
    const wx = dx * e, wy = dy * e;
    surface.panBy(wx - sx, wy - sy);
    sx = wx; sy = wy;
    advanceAnim = k < 1 ? requestAnimationFrame(step) : null;
  };
  advanceAnim = requestAnimationFrame(step);
}

function onStrokeDoneForAdvance(stroke) {
  if (!advanceOn || !stroke || !stroke.pts || !stroke.pts.length) return;
  cancelAdvance();
  let minY = Infinity, maxY = -Infinity;
  for (const [x, y] of stroke.pts) {
    if (x > advanceRight) advanceRight = x;
    if (y > maxY) maxY = y; if (y < minY) minY = y;
  }
  // The RIGHTMOST point written in this run, not where the pen was lifted —
  // a letter that curls back (a, o, e) and a trailing i-dot both finish well
  // left of where the writing actually reaches.
  const reach = advanceRight * surface.zoom + surface.offX;
  if (reach < surface.cssW * ADVANCE_EDGE) return;     // still room to write
  const height = Math.max((maxY - minY) * surface.zoom, 12);
  advanceTimer = setTimeout(() => {
    advanceTimer = null;
    // How far right of the page is left? If the writing has reached the page
    // edge there is nowhere to advance TO, so it wraps to the next line
    // instead — back to where this line started, and down by the size of what
    // you have actually been writing, which needs no configured line height.
    const pageRightView = surface.pageW * surface.zoom + surface.offX;
    const dx = surface.cssW * ADVANCE_REST - reach;
    if (pageRightView + dx < surface.cssW * 0.9) {
      // Back to the PAGE's left margin, not to where this run happened to
      // start: the run has been advancing along the line, so its own leftmost
      // point is wherever the last move left it, not where you began writing.
      const pageLeftView = surface.offX;
      advanceGlide(surface.cssW * ADVANCE_MARGIN - pageLeftView,
                   -height * ADVANCE_LINE);
    } else {
      advanceGlide(dx, 0);
    }
    resetAdvanceRun();
  }, ADVANCE_WAIT_MS);
}

/** Move a header button into the ☰ menu, keeping its handler. */
function moveToMenu(id, label) {
  const btn = document.getElementById(id);
  const menu = document.getElementById("more-popover");
  if (!btn || !menu) return;
  btn.hidden = true;
  const item = document.createElement("button");
  item.className = "flat menu-item";
  item.textContent = label;
  // click the original rather than re-binding its handler, so this cannot
  // drift from what the button does
  item.addEventListener("click", () => btn.click());
  (menu.querySelector(".popover-body") || menu).appendChild(item);
}

function addMenuLink(label, href) {
  const menu = document.getElementById("more-popover");
  if (!menu) return;
  const a = document.createElement("a");
  a.className = "flat menu-item";
  a.href = href;
  a.setAttribute("download", "");
  a.textContent = label;
  (menu.querySelector(".popover-body") || menu).appendChild(a);
}

applyMobileLayout();

// The view follows its container through a ResizeObserver inside the Surface,
// which fires AFTER layout and knows whether you had chosen a zoom. Re-fitting
// from here as well would run before the canvas had its new size — fitting the
// page to the box it just left — and would throw away that zoom every time the
// window moved.
surface.requestDraw();

// Reopen where you left off; a blank A4 sheet when there is nothing to reopen.
// A poor restore beats a failure to start, so anything unreadable falls through
// to the blank page rather than stopping here.
watchForStalledStart();
noteSavingSupport();
(LIVE ? openLiveDocument() : restoreSession())
  .catch(async (err) => {
    // A session that cannot be restored would fail again on every load, so it
    // is thrown away rather than kept. A stale document is not worth an app
    // that greets you with an error for ever.
    console.error("could not restore the last session", err);
    await clearSession();
    return null;
  })
  .then((restored) => (restored ? null : Doc.blank().then((d) => setDoc(d, "Untitled"))))
  .catch((err) => {
    // A blank page that fails to appear is the whole app failing to start, so
    // it must say so rather than leaving an empty canvas that looks deliberate.
    console.error("could not create the blank page", err);
    toast(`Could not start: ${err.message}`);
  });

/** pdf.js needs a Worker, and a Worker built from a blob is refused on a
 * `file://` page — it is created without complaint and then never loads, so the
 * app simply hangs with an empty sheet and no error anywhere. Nothing else in
 * the startup path can detect that, so it is detected by NOT HAPPENING. */
/** Say once, in browsers that cannot do it, that saving writes a COPY.
 *
 * File System Access is Chromium-only, so everywhere else Ctrl+S produces a
 * download instead of writing back to the file you opened. That is a real
 * difference in how the app behaves, and finding it out by looking in your
 * downloads folder for work you thought you had saved is the wrong way to learn
 * it. Said once and remembered, because a banner on every visit is noise. */
function noteSavingSupport() {
  if (canSaveInPlace || store.get("save_note_seen")) return;
  const note = document.createElement("div");
  note.className = "startup-error info";
  note.innerHTML =
    "<strong>Saving works differently in this browser.</strong><br>"
    + "Ctrl+S will download a copy of the PDF and the notes rather than writing "
    + "back to the files you opened.<br>"
    + "For save-in-place, open Sidemark in <strong>Chrome</strong> or "
    + "<strong>Edge</strong>.";
  const ok = document.createElement("button");
  ok.className = "small";
  ok.textContent = "Got it";
  ok.addEventListener("click", () => {
    store.set("save_note_seen", true);
    note.remove();
  });
  note.appendChild(document.createElement("br"));
  note.appendChild(ok);
  document.body.appendChild(note);
}

function watchForStalledStart() {
  setTimeout(() => {
    if (surface.doc) return;
    const local = location.protocol === "file:";
    const note = document.createElement("div");
    note.className = "startup-error";
    note.innerHTML = local
      ? "<strong>Sidemark needs a web server.</strong><br>"
        + "Opened straight off the disk, the browser blocks the PDF engine.<br>"
        + "Run <code>python3 serve.py</code> in this folder and use the link it prints."
      : "<strong>Sidemark could not start.</strong><br>"
        + "The PDF engine did not load. The browser console will say why.";
    document.body.appendChild(note);
  }, 6000);
}

/** Take the document from the desktop that served this page (LIVE mode).
 *
 * `../live.pdf` is the desktop's real document with our ink still as
 * annotations, so `Doc.open` adopts it into editable strokes exactly as it
 * does for a file you picked — the phone gets the ink, not a picture of it.
 * The desktop's Download button serves a different, flattened export; this is
 * deliberately not that one. */
async function openLiveDocument() {
  diag("open-start");
  const state = await fetch("../state", { cache: "no-store" })
    .then((r) => r.json()).catch(() => ({}));
  const first = state.page || 0;
  diag("state", `pages=${state.pages} page=${first}`);
  // ONE page, not the document. A lecture deck is tens of megabytes and the
  // phone is about to look at a single slide of it; the rest arrives as it is
  // reached (attachLazyPages). Ink rides along on each page, so a page is
  // never briefly blank waiting for a delta.
  const r = await fetch(`../page.pdf?n=${first}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`page.pdf answered ${r.status}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  diag("page-pdf", `${(bytes.length / 1024).toFixed(0)}KB`);
  const doc = await Doc.open(bytes, state.title || "Shared document");
  diag("doc-open");
  doc.pageIndexLoaded = first;
  if (state.pages > 1) {
    doc.attachLazyPages(state.pages, async (n) => {
      const res = await fetch(`../page.pdf?n=${n}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`page ${n} answered ${res.status}`);
      // adopted and stripped by the same code a whole document goes through,
      // so a page fetched alone behaves like one that arrived with the file
      return Doc.openLoosePage(new Uint8Array(await res.arrayBuffer()));
    });
  }
  await setDoc(doc, doc.name);
  diag("set-doc");
  if (first) await surface.setPage(first);
  liveRev = state.rev ?? null;
  livePage = state.page ?? null;
  liveWriting = !!state.writing;
  liveBanner();
  liveConnect();
  liveWatchView();
  // the first frame is the expensive one: pdf.js rasterises the page and the
  // ink layer is allocated. If the phone dies here, that is the answer.
  requestAnimationFrame(() => requestAnimationFrame(() => diag("first-frame")));
  return true;
}

/** Say plainly whether ink is reaching the desktop.
 *
 * Not decoration: the two ways this can quietly fail are the connection
 * dropping (the phone locks, the wifi goes) and the desktop being set to
 * Sharing rather than Writing — and in BOTH the phone still draws perfectly,
 * on its own copy. Ink you believe is on the lecture and is not is the worst
 * outcome this feature has, and it is silent unless something says so. */
let liveWriting = false;
let liveBannerEl = null;

function liveBanner() {
  liveBannerEl = document.createElement("div");
  if (MOBILE) {
    // On a phone a full-width bar costs a line of the page for a sentence you
    // read once. It becomes a CHIP beside the document name — same three
    // states, same colours, no vertical space — which is the only place on a
    // landscape phone that has room to spare.
    liveBannerEl.className = "live-chip";
    const title = document.getElementById("doc-title");
    if (title && title.parentNode) title.parentNode.insertBefore(
      liveBannerEl, title.nextSibling);
    else document.body.appendChild(liveBannerEl);
  } else {
    liveBannerEl.className = "live-banner";
    document.body.appendChild(liveBannerEl);
  }
  liveStatus(false);
}

function liveStatus(connected) {
  if (!liveBannerEl) return;
  const state = !connected ? "off"
              : liveWriting ? "writing" : "viewing";
  liveBannerEl.dataset.state = state;
  const long = state === "off" ? "Reconnecting to the desktop…"
             : state === "writing" ? "Live — your ink goes to the desktop"
             : "Live — viewing only. Switch the desktop to Writing to draw.";
  // The chip still says which of the three it is — "Live" alone cannot tell
  // you your ink is going nowhere — and carries the sentence as its tooltip.
  liveBannerEl.textContent = MOBILE
    ? (state === "off" ? "offline" : state === "writing" ? "Live" : "Live · read-only")
    : long;
  liveBannerEl.title = long;
}

// ── breadcrumbs, for a browser that dies without saying why ─────────────────
// A renderer crash takes the console with it, so nothing the page could show
// or log survives. What DOES survive is what has already left the device:
// `sendBeacon` hands the payload to the browser's own queue, which outlives
// the page. So the desktop's log ends with the last stage the phone reached,
// and the crash is bisected without ever attaching a debugger.
//
// LIVE mode only, and cheap: a short string per milestone.
let diagSeq = 0;

function diag(stage, detail) {
  if (!LIVE) return;
  try {
    const mem = performance.memory
      ? ` heap=${(performance.memory.usedJSHeapSize / 1048576).toFixed(1)}MB`
      : "";
    const line = `#${++diagSeq} ${stage}${detail ? " " + detail : ""}`
               + `${mem} dpr=${devicePixelRatio} ${innerWidth}x${innerHeight}`;
    const url = new URL("../diag", location.href).toString();
    // A keepalive FETCH first, not sendBeacon. Brave — the browser this was
    // built to diagnose — neutralises `sendBeacon` as an anti-tracking
    // measure, and it does so by returning TRUE and discarding the payload,
    // so a `if (!sendBeacon(...))` fallback never fires and the breadcrumbs
    // vanish silently. A keepalive fetch is an ordinary same-origin request
    // and makes the same promise: the browser keeps it alive past the page.
    fetch(url, { method: "POST", body: line, keepalive: true }).catch(() => {
      try { navigator.sendBeacon && navigator.sendBeacon(url, line); } catch {}
    });
  } catch { /* a breadcrumb must never be the thing that breaks the page */ }
}

if (LIVE) {
  diag("boot", navigator.userAgent.slice(0, 90));
  window.addEventListener("error", (e) =>
    diag("ERROR", `${e.message} @ ${(e.filename || "").split("/").pop()}:${e.lineno}`));
  window.addEventListener("unhandledrejection", (e) =>
    diag("REJECT", String(e.reason && e.reason.message || e.reason).slice(0, 140)));
  // A crash usually follows memory climbing, and the last heartbeat before
  // the silence is the reading that matters — but a trend needs a handful of
  // readings, not a hundred, and every one of them is a request. Every 30 s
  // still shows memory climbing over a session and costs two lines a minute.
  setInterval(() => diag("alive"), 30000);
}

// ── the live connection ──────────────────────────────────────────────────────
// A socket, not a poll, and that is the whole feature. Ink has to reach the
// desktop while the finger is still down, and a change made on the desktop has
// to arrive when it happens rather than up to a poll interval later. The page
// is served BY the desktop, so this is same-origin — which is the only reason
// it is allowed at all: the copy hosted on GitHub Pages cannot open a socket
// to a machine on your LAN or your tailnet (mixed content, and Chrome's Local
// Network Access, which TLS does not lift — measured, see
// notes/phone-web-port-sync-plan.md).
let liveSock = null;
let liveRev = null, livePage = null;
// what a touch does right now with the desktop's modifiers held — display
// only, so letting go needs no message
let liveHeldTool = null;
let liveRetry = 500;
// often enough to feel attached to the hand, rare enough to be invisible
// beside ink on the same socket
const LIVE_VIEW_MS = 120;

function liveSend(msg) {
  if (liveSock && liveSock.readyState === WebSocket.OPEN) {
    liveSock.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

function liveConnect() {
  const url = new URL("../ws", location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  let sock;
  try { sock = new WebSocket(url); } catch { return void setTimeout(liveConnect, 2000); }
  liveSock = sock;
  sock.addEventListener("open", () => {
    liveRetry = 500;                       // a good connection resets the backoff
    diag("ws-open");
    liveStatus(true);
    sock.send(JSON.stringify({ t: "hello" }));
  });
  sock.addEventListener("message", (e) => {
    let s; try { s = JSON.parse(e.data); } catch { return; }
    if (s.t === "state") onLiveState(s);
    else if (s.t === "live") onLiveStroke(s);
    else if (s.t === "camera") onLiveCamera(s);
    else if (s.t === "tool") onLiveTool(s);
  });
  const gone = () => {
    if (liveSock !== sock) return;         // a newer socket already took over
    liveSock = null;
    liveStatus(false);
    // The phone locks its screen, the wifi drops, the desktop stops sharing.
    // Backoff so a desktop that has genuinely gone is not hammered, capped so
    // picking the phone back up reconnects in seconds rather than minutes.
    setTimeout(liveConnect, liveRetry);
    liveRetry = Math.min(liveRetry * 2, 10000);
  };
  sock.addEventListener("close", gone);
  sock.addEventListener("error", gone);
}

/** The desktop's finger tool changed — because somebody picked one there, or
 * because a modifier is being held on its keyboard.
 *
 * `tool` is what a touch does RIGHT NOW (modifiers included) and `base` is
 * what the finger is bound to with nothing held. The BASE is what we store,
 * so releasing the key returns to it without a second message; `tool` only
 * moves what the bar shows, the same way the desktop's own stripes move under
 * a held modifier. */
function onLiveTool(s) {
  if (!MOBILE) return;
  if (s.base) {
    bindings.bind(chordId(BTN_FINGER), s.base, bindings.mode);
  }
  liveHeldTool = s.tool || null;
  refreshToolBindings();
}

/** The desktop is drawing right now — show it while their pen is down.
 *
 * Transient by construction: it is never put in the page's stroke list, so
 * nothing here can be erased, lassoed or undone, and there is no state to
 * reconcile when the real ink lands. `pts: null` is the lift, and the commit
 * follows immediately as an ordinary ink delta. */
function onLiveStroke(s) {
  surface.remoteLive = s.pts
    ? { page: s.page, pts: s.pts, width: s.w,
        color: s.c || [0, 0, 0], opacity: s.o ?? 1 }
    : null;
  surface.requestDraw();
}

/** The desktop is pointing at something — go and look at it.
 *
 * A SUGGESTION, not a lock. Nothing here disables the phone's own pinch: the
 * moment you move, `liveWatchView` reports the new viewport and the desktop's
 * rectangle follows you again, exactly as it did before. That is the whole
 * model — there is ONE box, it is where the phone is looking, and either end
 * can move it.
 *
 * The region is fitted rather than matched exactly: the phone's aspect ratio
 * is not the desktop's, so the drawn rectangle is CONTAINED (the smaller of
 * the two scales) — showing everything that was pointed at and a little more
 * beats cropping half of it away. */
function onLiveCamera(s) {
  if (!surface.doc || !s.rect || s.rect.length !== 4) return;
  const [x0, y0, x1, y1] = s.rect;
  const w = Math.max(x1 - x0, 1e-3), h = Math.max(y1 - y0, 1e-3);
  const go = async () => {
    if (s.page !== undefined && s.page !== surface.pageIndex) {
      await surface.setPage(s.page);
      livePage = s.page;
    }
    const zoom = Math.min(surface.cssW / w, surface.cssH / h);
    surface.zoom = Math.max(0.05, Math.min(16, zoom));
    // centre what was pointed at, which is not the same as putting its corner
    // at the origin once the aspect ratios differ
    surface.offX = surface.cssW / 2 - (x0 + w / 2) * surface.zoom;
    surface.offY = surface.cssH / 2 - (y0 + h / 2) * surface.zoom;
    surface.requestDraw();
  };
  go();
}

/** Tell the desktop where this phone is looking (row 182's indicator).
 *
 * The whole point of the editor is that the phone has a camera of its own, so
 * the person at the laptop cannot otherwise tell which corner of the page the
 * ink is about to land in. Polled rather than hooked into the view: zoom and
 * pan change from a pinch, a scroll, a page turn and a re-fit, and one cheap
 * comparison catches all of them where four hooks would eventually miss one.
 *
 * Sent only when it CHANGED, and it is a hint rather than state — a dropped
 * update costs nothing, so it must never compete with ink for the socket. */
function liveWatchView() {
  let last = "";
  setInterval(() => {
    if (!surface.doc || !liveSock || liveSock.readyState !== WebSocket.OPEN) return;
    const [x0, y0] = surface.toDoc(0, 0);
    const [x1, y1] = surface.toDoc(surface.cssW, surface.cssH);
    const page = surface.pageIndex;
    const sig = `${page}|${x0.toFixed(1)},${y0.toFixed(1)},${x1.toFixed(1)},${y1.toFixed(1)}`;
    if (sig === last) return;
    last = sig;
    liveSend({ t: "view", page, rect: [x0, y0, x1, y1] });
  }, LIVE_VIEW_MS);
}

/** Take one page's ink from the desktop, wholesale.
 *
 * REPLACES rather than merges, and that is what makes it correct as well as
 * quick: the desktop's list for a page is the entire truth for it — ink this
 * phone drew is in there too, because it was committed on the desktop — so
 * there is no pair of edits that can disagree and nothing to reconcile.
 *
 * The array is emptied and refilled rather than swapped out, so anything
 * already holding the page's stroke list (the renderer's layer, a live
 * selection) is looking at the same array afterwards. */
function applyInkDelta(ink) {
  if (!surface.doc || !ink) return;
  // the committed ink is here, so the transient it replaces must go with it
  // or the stroke is briefly drawn twice
  surface.remoteLive = null;
  const list = surface.doc.strokesFor(ink.page);
  list.length = 0;
  for (const w of ink.strokes) {
    list.push({
      pts: w.pts, width: w.w, color: w.c, opacity: w.o,
      profile: w.p || null, flat: w.o < 1,
    });
  }
  if (ink.page === surface.pageIndex) {
    surface.invalidateLayer();
    surface.requestDraw();
  }
}

/** The desktop says something changed. */
async function onLiveState(s) {
  const structural = s.pages !== undefined && surface.doc
                     && s.pages !== surface.doc.pageCount;
  if (structural) {
    // A page was added, deleted or reordered — a per-page stroke list would
    // now describe the wrong page, so this is the one case still worth a
    // whole document.
    try {
      const r = await fetch("../live.pdf", { cache: "no-store" });
      if (r.ok) {
        const keep = surface.pageIndex;
        const doc = await Doc.open(new Uint8Array(await r.arrayBuffer()),
                                   s.title || "Shared document");
        await setDoc(doc, doc.name);
        await surface.setPage(Math.min(keep, doc.pageCount - 1));
      }
    } catch { /* keep what we have; the next change will try again */ }
  } else if (s.ink) {
    // the ordinary case: somebody drew or erased on the desktop
    applyInkDelta(s.ink);
  }
  if (livePage !== null && s.page !== livePage) {
    // Follow the presenter's page only when THEY turn it. Setting it on every
    // message would yank back a phone that had navigated on its own, which is
    // most of the point of having a camera of your own.
    await surface.setPage(s.page);
  }
  liveRev = s.rev; livePage = s.page;
  liveWriting = !!s.writing;
  liveStatus(true);
}

async function restoreSession() {
  if (SANDBOX) return false;
  const rec = await loadSession();
  if (!rec) return false;
  const doc = await Doc.open(rec.bytes, rec.name);
  // the stored bytes were already stripped of our ink when they were saved, so
  // the session's copy is the truth — adopting twice would double it
  doc.ink = rec.ink;
  if (rec.notes) doc.notes.setFromText(rec.notes);
  // the handle rides along so save-in-place can resume; USING it needs a user
  // gesture, so it is not touched until the first save
  if (rec.handle) doc.handles = { pdf: rec.handle };
  await setDoc(doc, rec.name);
  if (rec.page) await surface.setPage(rec.page);
  return true;
}

/** Written on a debounce, the way the desktop writes recent.json — often enough
 * that a reload loses nothing, rarely enough that it costs nothing. */
let sessionTimer = null;
function rememberSession() {
  if (SANDBOX || LIVE) return;   // LIVE: the document is another machine's
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => saveSession(surface.doc, surface.pageIndex), 800);
}

// ── the document ─────────────────────────────────────────────────────────────

async function setDoc(doc, title) {
  await surface.setDoc(doc, 0);
  document.getElementById("doc-title").textContent = title || doc.name;
  sidebar.setDoc(doc);
  sidebar.setPage(0);
  notes.setModel(doc.notes);
  syncFullNotes();
  search.stop();
  search.clearCache();
  search.matches = [];
  search.current = null;
  syncPageChrome();
  refreshUndo();
  // setDoc runs through the change callback on its way in; what it just loaded
  // is by definition not an unsaved edit
  markDirty(false);
  rememberSession();
  // an untitled blank is not a document anyone wants to come back to
  // LIVE is excluded for the same reason as SANDBOX: a live document is not a
  // file this browser opened, and it will not be there to reopen.
  if (!SANDBOX && !LIVE && doc.name && doc.name !== "Untitled") {
    rememberRecent({ name: doc.name, bytes: doc.bytes,
                     handle: doc.handles?.pdf || null, page: 0 });
  }
}

/** The divider between the page and the notes. GtkPaned's position, by hand. */
/** Re-enter the sheet on a model that has just been swapped in. `setModel`
 * resets the panel to one page's notes — the divider's state outlives a
 * document change, so without this the panel is full width and showing one
 * page, and the caret has nothing to cross with (row 162). */
function syncFullNotes() {
  if (document.getElementById("paned").classList.contains("full-notes")) {
    notes.setFull(true, surface.pageIndex);
  }
}

function wireDivider() {
  const divider = document.getElementById("divider");
  const paned = document.getElementById("paned");
  const stage = document.getElementById("stage");
  let dragging = false;

  // Past this, the page has nowhere useful left to be and the notes take the
  // window: the divider is the way BETWEEN the modes (row 130).
  const FULL_AT = 0.06;

  const apply = (x, { remember = true } = {}) => {
    const r = paned.getBoundingClientRect();
    let frac = Math.max(0, Math.min(0.94, (x - r.left) / r.width));
    if (frac < FULL_AT) frac = 0;
    setSplit(frac, { remember });
  };

  const setSplit = (frac, { remember = true } = {}) => {
    const full = frac <= 0;
    stage.style.flexBasis = full ? "0%" : `${(frac * 100).toFixed(2)}%`;
    document.getElementById("paned").classList.toggle("full-notes", full);
    // A VIEW state, never a conversion: the PDF is still there behind the
    // sheet, its notes are still per page, and nothing is written either way —
    // so a drag that crosses the line and comes back leaves no trace.
    //
    // The CARET crosses with you (row 162): going in, the sheet opens at the
    // page you were reading; coming out, `setFull` hands back the page the
    // caret ended up in and the canvas turns to it.
    const target = notes.setFull(full, surface.pageIndex);
    if (!full && target !== null && target !== surface.pageIndex) {
      surface.setPage(target);
    }
    if (remember && !full) store.set("pane_fraction", frac);
    store.set("full_notes", full);
    surface.requestDraw();
  };
  wireDivider.setSplit = setSplit;

  divider.addEventListener("pointerdown", (e) => {
    dragging = true;
    divider.setPointerCapture(e.pointerId);
    divider.classList.add("dragging");
    e.preventDefault();
  });
  divider.addEventListener("pointermove", (e) => { if (dragging) apply(e.clientX); });
  divider.addEventListener("pointerup", (e) => {
    dragging = false;
    divider.classList.remove("dragging");
    divider.releasePointerCapture(e.pointerId);
  });

  const saved = store.get("pane_fraction");
  if (typeof saved === "number" && saved > 0.1 && saved < 0.95) {
    stage.style.flexBasis = `${(saved * 100).toFixed(2)}%`;
  }
  // The view is remembered per session for the same reason the desktop keeps it
  // in recent.json: it is a view state about a document, and looking at one
  // must not change a file.
  if (store.get("full_notes")) {
    requestAnimationFrame(() => setSplit(0, { remember: false }));
  }

  // The collapsed handle is the ONLY way back, so it wears a wide, visible
  // grip — at the default width it would be a few pixels hard against the
  // window edge.
  divider.addEventListener("dblclick", () => {
    const full = document.getElementById("paned").classList.contains("full-notes");
    setSplit(full ? (store.get("pane_fraction") || 0.62) : 0, { remember: false });
  });
}

/** The page counter and the pager belong to the WINDOW, not to the page, so
 * there is ONE place that points them at the document's current page. */
function syncPageChrome() {
  const doc = surface.doc;
  const counter = document.getElementById("page-counter");
  counter.textContent = doc ? `${surface.pageIndex + 1} / ${doc.pageCount}` : "—";
  syncBookmarkChrome();
  document.getElementById("prev-page").disabled = !doc || surface.pageIndex <= 0;
  document.getElementById("next-page").disabled =
    !doc || surface.pageIndex >= doc.pageCount - 1;
}

/** Pair each PDF with the `.md` beside it. ONE rule, shared by the drop and the
 * file picker — the two ways in cannot be allowed to disagree about what a pair
 * means.
 *
 * A `.md` opened alongside its PDF is that PDF's SIDECAR — the same pairing the
 * desktop makes, where a document is a `.pdf` plus the `.md` beside it. Base
 * name FIRST, because that is the rule the file layout encodes; but the desktop
 * also remembers a notes file chosen by hand, and those are often named for the
 * course rather than the file (`0_merged.pdf` beside `26-sose-inhalte_nlp.md`).
 * So one PDF and one `.md` opened together are paired whatever they are called
 * — there is nothing else they could mean.
 *
 * `items` are {name, bytes, handle?}; the handles are what make a later save
 * write both files back in place. */
function pairSources(items) {
  const base = (name) => name.replace(/\.[^.]+$/, "");
  const dec = new TextDecoder();
  const pdfs = [];
  const sidecars = new Map();
  for (const it of items) {
    if (/\.md$/i.test(it.name)) {
      sidecars.set(base(it.name), { text: dec.decode(it.bytes), handle: it.handle || null });
    }
  }
  for (const it of items) {
    if (!/\.pdf$/i.test(it.name) && it.type !== "application/pdf") continue;
    const side = sidecars.get(base(it.name)) || null;
    pdfs.push({
      bytes: it.bytes,
      name: it.name,
      handle: it.handle || null,
      notesText: side ? side.text : null,
      notesHandle: side ? side.handle : null,
    });
  }
  if (pdfs.length === 1 && sidecars.size === 1 && !pdfs[0].notesText) {
    const only = [...sidecars.values()][0];
    pdfs[0].notesText = only.text;
    pdfs[0].notesHandle = only.handle;
  }
  // a `.md` on its own is a notes file for the document already open
  if (!pdfs.length && sidecars.size && surface.doc) {
    const only = [...sidecars.values()][0];
    return { loneNotes: only.text, loneNotesHandle: only.handle };
  }
  return pdfs;
}

async function readFiles(files) {
  const items = [];
  for (const f of [...files]) {
    items.push({ name: f.name, type: f.type, bytes: new Uint8Array(await f.arrayBuffer()) });
  }
  return pairSources(items);
}

/** One file OPENS; several MERGE into one document with a chapter per file.
 * That is the whole point of dropping more than one at once — you get a single
 * document whose outline names where each source began, not a pile of tabs. */
async function openFiles(files) {
  return openPaired(await readFiles(files));
}

/** What `pairSources` produced: a PDF (or several to merge), or a lone sidecar
 * for the document already open. Both ways in — the drop and the picker — land
 * here, so neither can grow its own idea of what opening a `.md` means. */
async function openPaired(sources) {
  if (sources.loneNotes !== undefined) {
    // a sidecar for the document already open
    surface.doc.notes.setFromText(sources.loneNotes);
    if (sources.loneNotesHandle) {
      surface.doc.handles = surface.doc.handles || {};
      surface.doc.handles.notes = sources.loneNotesHandle;
    }
    notes.setModel(surface.doc.notes);
    notes.showPage(surface.pageIndex);
    syncFullNotes();
    markDirty(false);
    return toast("Notes loaded");
  }
  return openSources(sources);
}

/** `sources` are {bytes, name, handle?, notesText?} — one OPENS, several MERGE
 * into one document with a chapter per file. */
async function openSources(sources) {
  // Reachable from the picker too, now that it takes `.md` — and there the
  // useful answer is not "wrong file" but the pairing rule itself.
  if (!sources.length) {
    return toast("No PDF in that \u2014 a .md is a PDF's notes, so open the two together");
  }
  try {
    if (sources.length === 1) {
      const doc = await Doc.open(sources[0].bytes, sources[0].name);
      // Both handles, so a later save writes the PDF *and* its notes back where
      // they came from — the sidecar cannot be derived from the PDF's handle
      // (the API hands out a file, never its directory), so picking it here is
      // the only way to have it.
      if (sources[0].handle || sources[0].notesHandle) {
        doc.handles = { pdf: sources[0].handle || null,
                        notes: sources[0].notesHandle || null };
      }
      if (sources[0].notesText) doc.notes.setFromText(sources[0].notesText);
      await setDoc(doc, sources[0].name);
      toast(sources[0].notesText ? `Opened ${sources[0].name} with its notes`
                                 : `Opened ${sources[0].name}`);
      return;
    }
    const { bytes, chapters, ink } = await mergeDocuments(sources);
    const doc = await Doc.open(bytes, "Merged");
    doc.ink = ink;
    await setDoc(doc, `Merged — ${chapters.length} chapters`);
    markDirty(true);      // a merge exists only in memory until it is saved
    toast(`Merged ${chapters.length} documents, a chapter each`);
  } catch (err) {
    toast(`Could not open: ${err.message}`);
  }
}

// ── saving ───────────────────────────────────────────────────────────────────

let dirty = false;

function markDirty(on) {
  if (dirty === on) return;
  dirty = on;
  const title = document.getElementById("doc-title");
  title.classList.toggle("dirty", on);
  document.getElementById("save-btn").classList.toggle("suggested", on);
}

async function doSave({ reask = false } = {}) {
  if (!surface.doc) return;
  const btn = document.getElementById("save-btn");
  btn.disabled = true;
  try {
    const result = await saveDocument(surface.doc, { reask });
    if (!result) return;                       // cancelled
    markDirty(false);
    const what = result.notes ? `${result.pdf} + ${result.notes}` : result.pdf;
    if (result.notesPending) {
      // the picker spends the gesture, so choosing where the NOTES go has to be
      // its own click rather than a second dialog in the same one
      toast(`Saved ${what}`, {
        action: "Save notes…",
        onAction: async () => {
          try {
            const name = await saveNotesAs(surface.doc);
            if (name) toast(`Saved ${name}`);
          } catch (err) { toast(`Could not save notes: ${err.message}`); }
        },
      });
    } else {
      toast(result.inPlace ? `Saved ${what}`
                           : `Downloaded ${what} — this browser cannot write back to the original`);
    }
  } catch (err) {
    toast(`Could not save: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

/** A drop on the SIDEBAR imports at that gap, keeping the document you are in.
 * Everywhere else opens or merges into a new one. */
async function importAt(files, gap) {
  if (!surface.doc) return openFiles(files);
  // Are these already-read sources, or Files to read?
  //
  // NOT a truthiness test on `.bytes`: `Blob.prototype.bytes()` is a METHOD in
  // current browsers, so every File has a truthy `.bytes` and every dropped
  // file was handed to pdf-lib as a FUNCTION. It failed with "must be of type
  // Uint8Array but was actually of type NaN" inside a `catch { continue }`,
  // which is why the drop looked like it did nothing at all.
  const ready = ArrayBuffer.isView(files[0]?.bytes);
  const sources = ready ? files : await readFiles(files);
  if (!sources.length) return toast("No PDFs in that drop");
  try {
    const host = surface.doc;
    const was = host.pageCount;
    const { bytes, ink, skipped } = await insertDocuments(host, sources, gap);
    if (skipped && skipped.length) console.warn("import skipped:", skipped);
    const doc = await Doc.open(bytes, host.name);
    doc.ink = ink;
    await setDoc(doc, document.getElementById("doc-title").textContent);
    await surface.setPage(gap);
    // the COUNT, not just "inserted": an import that silently added nothing is
    // the failure this reports, and it is otherwise invisible
    const added = doc.pageCount - was;
    toast(added > 0
      ? `Inserted ${added} page${added > 1 ? "s" : ""} at page ${gap + 1}`
      : "Nothing was inserted — those pages could not be read");
  } catch (err) {
    toast(`Could not insert: ${err.message}`);
  }
}

// ── page management ──────────────────────────────────────────────────────────

/** Rebuild the document with its pages in `order`, carrying every per-page fact
 * across. ONE rebuild and ONE re-key for the whole change — doing it page by
 * page would re-render the document once per page, which a 40-page chapter
 * feels. */
async function rebuildPages(order, { deleted = null } = {}) {
  const doc = surface.doc;
  if (!doc) return;
  const wasPage = surface.pageIndex;
  try {
    const { bytes, oldToNew, outline } = await applyPageOrder(doc.bytes, order,
                                                              doc.outline);
    const next = await Doc.open(bytes, doc.name);
    next.outline = outline.length ? outline : next.outline;

    const ink = new Map();
    for (const [page, strokes] of doc.ink) {
      if (oldToNew.has(page)) ink.set(oldToNew.get(page), strokes);
    }
    next.ink = ink;

    // Notes are re-keyed by the rule that fits what happened: a DELETE has to
    // hand a run's body to the next page in the run, which a permutation map
    // cannot express, while a REORDER keeps a run only if it moved as a block.
    if (deleted) {
      for (const idx of [...deleted].sort((a, b) => b - a)) doc.notes.shiftForDelete(idx);
    } else {
      doc.notes.reorder(oldToNew);
    }
    next.notes = doc.notes;
    next.handles = doc.handles;

    await setDoc(next, document.getElementById("doc-title").textContent);
    const land = deleted ? Math.min(wasPage, next.pageCount - 1)
                         : (oldToNew.get(wasPage) ?? 0);
    await surface.setPage(land);
    markDirty(true);
    return next;
  } catch (err) {
    toast(`Could not change pages: ${err.message}`);
    return null;
  }
}

async function movePage(from, to) {
  if (!surface.doc || from === to) return;
  const order = moveRangeOrder(surface.doc.pageCount, from, 1, to);
  await rebuildPages(order);
  toast(`Page ${from + 1} → ${to + 1}`);
}

async function removePages(pages) {
  const doc = surface.doc;
  if (!doc) return;
  const drop = new Set(pages);
  if (drop.size >= doc.pageCount) {
    return toast("A document cannot lose its last page");
  }
  const keep = [];
  for (let i = 0; i < doc.pageCount; i++) if (!drop.has(i)) keep.push(i);
  sidebar.clearSelection();
  await rebuildPages(keep, { deleted: [...drop] });
  toast(drop.size > 1 ? `Deleted ${drop.size} pages` : `Deleted page ${pages[0] + 1}`);
}

async function doExportPages(pages) {
  const doc = surface.doc;
  if (!doc || !pages.length) return;
  try {
    const name = await exportPages(doc, pages);
    if (name) toast(`Exported ${name}`);
  } catch (err) {
    toast(`Could not export: ${err.message}`);
  }
}

/** Prepare what a page DRAG will hand over — a file for the desktop, and a key
 * for another Sidemark window.
 *
 * `dataTransfer.setData` has to run synchronously inside `dragstart` and
 * extracting pages is async, so the bytes are built AHEAD: when the selection
 * changes, and again on the press that starts a drag (`onDragArm`). The press
 * is the one that matters — dragging a thumbnail you never selected is the
 * ordinary case, and it used to carry nothing at all.
 *
 * `DownloadURL` is Chromium-only, and only ever reaches the desktop; the
 * `handoff` key is what crosses to a second window, in every browser. */
let pageDrag = null;
let pageDragSeq = 0;
async function preparePageDrag(pages) {
  const want = pages.join(",");
  if (pageDrag && pageDrag.pages === want) return;   // already in hand
  const seq = ++pageDragSeq;
  const doc = surface.doc;
  if (!doc || !pages.length) return;
  try {
    const bytes = await extractPages(doc, pages);
    // A slower extraction that has since been superseded must not overwrite the
    // one the hand is actually dragging.
    if (seq !== pageDragSeq) return;
    if (pageDrag) URL.revokeObjectURL(pageDrag.url);
    const key = `pages-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pageDrag = {
      pages: want,
      key,
      name: exportName(doc.name, pages),
      url: URL.createObjectURL(new Blob([bytes], { type: "application/pdf" })),
    };
    await putHandoff(key, { name: pageDrag.name, bytes });
  } catch { /* a drag that cannot be prepared still reorders inside the strip */ }
}

/** The payloads for a drag starting on `index`, or null when the bytes for
 * exactly these pages are not ready yet. */
function pageDragPayload(index) {
  const pages = sidebar.pagesActedOn(index);
  if (!pageDrag || pageDrag.pages !== pages.join(",")) return null;
  return {
    download: `application/pdf:${pageDrag.name}:${pageDrag.url}`,
    handoff: pageDrag.key,
  };
}

/** Pages dragged in from another Sidemark window: the bytes are waiting in the
 * shared database under the key the drag carried. Imported through the ordinary
 * merge pipeline, so a page from another window lands exactly like a dropped
 * file — at the gap, with its notes re-keyed. */
async function importHandoff(key, gap) {
  try {
    const rec = await takeHandoff(key);
    if (!rec) return toast("Those pages are no longer available");
    await importAt([{ name: rec.name, bytes: rec.bytes }], gap);
  } catch (err) {
    toast(`Could not insert: ${err.message}`);
  }
}

/** Insert pages from a file, at the current page. The same pipeline as a drop
 * on the sidebar, so the menu and the gesture cannot drift. */
/** Set a page aside: still in the document and still editable, but skipped when
 * paging. Like a bookmark it is a property OF one page, so it needs no
 * adjacency rule — it just follows its page through every re-key. */
function toggleHidden(index, unhide = null) {
  const doc = surface.doc;
  if (!doc) return;
  const notes = doc.notes;
  const hidden = unhide === null ? notes.isHidden(index) : unhide;
  notes.setHidden(index, !hidden);
  markDirty(true);
  rememberSession();
  sidebar.setDoc(doc);
  sidebar.setPage(surface.pageIndex);
  toast(hidden ? `Page ${index + 1} shown` : `Page ${index + 1} hidden`);
}

async function addPageAfter(index, kind = "plain") {
  const doc = surface.doc;
  if (!doc) return;
  try {
    const r = await addBlankPage(doc.bytes, index, kind, doc.outline);
    const next = await Doc.open(r.bytes, doc.name);
    next.outline = r.outline.length ? r.outline : next.outline;
    const ink = new Map();
    for (const [page, strokes] of doc.ink) ink.set(r.oldToNew.get(page) ?? page, strokes);
    next.ink = ink;
    doc.notes.shiftForInsert(r.inserted, 1);
    next.notes = doc.notes;
    next.handles = doc.handles;
    await setDoc(next, document.getElementById("doc-title").textContent);
    await surface.setPage(r.inserted);
    markDirty(true);
    toast(kind === "plain" ? "Blank page added" : `Blank page added (${kind})`);
  } catch (err) {
    toast(`Could not add a page: ${err.message}`);
  }
}

async function newDocument(kind = "plain") {
  try {
    const doc = await Doc.open(await blankPdfBytes(595, 842, kind), "Untitled");
    await setDoc(doc, "Untitled");
    toast("New document");
  } catch (err) {
    toast(`Could not create a document: ${err.message}`);
  }
}

async function insertPagesFromPicker() {
  if (!surface.doc) return;
  const at = surface.pageIndex;
  if (canSaveInPlace) {
    const picked = await openWithPicker(true);
    if (picked && picked.length) return importAt(picked, at);
    if (picked !== null) return;
  }
  const input = document.getElementById("insert-input");
  input.onchange = () => {
    if (input.files.length) importAt([...input.files], at);
    input.value = "";
  };
  input.click();
}

// ── recent documents ─────────────────────────────────────────────────────────

function whenText(at) {
  const mins = Math.round((Date.now() - at) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

async function buildRecentList() {
  const host = document.getElementById("recent-list");
  const entries = await listRecent();
  host.replaceChildren();
  if (!entries.length) {
    const p = document.createElement("p");
    p.className = "recent-empty";
    p.textContent = "Nothing yet — documents you open appear here.";
    host.appendChild(p);
    return;
  }
  for (const entry of entries) {
    const state = await recentState(entry);
    const row = document.createElement("div");
    row.className = "recent-row" + (state === "gone" ? " gone" : "");

    const open = document.createElement("button");
    open.className = "open";
    open.innerHTML = `<span class="name"></span><span class="when"></span>`;
    open.querySelector(".name").textContent = entry.name;
    open.querySelector(".when").textContent =
      state === "gone" ? "no longer available"
      : state === "needs-permission" ? `${whenText(entry.at)} · will ask permission`
      : whenText(entry.at);
    open.disabled = state === "gone";
    open.addEventListener("click", () => reopenRecent(entry));
    row.appendChild(open);

    const drop = document.createElement("button");
    drop.className = "drop";
    drop.textContent = "×";
    drop.title = "Forget this document";
    drop.addEventListener("click", async () => {
      await forgetRecent(entry.id);
      buildRecentList();
    });
    row.appendChild(drop);
    host.appendChild(row);
  }
}

async function reopenRecent(entry) {
  document.getElementById("recent-popover").hidden = true;
  try {
    // called straight from the click, because asking for permission on a handle
    // needs a user gesture and an await before it would lose one
    const opened = await openRecent(entry);
    if (!opened) return toast("That document could not be opened");
    const doc = await Doc.open(opened.bytes, opened.name);
    if (opened.handle) doc.handles = { pdf: opened.handle };
    await setDoc(doc, opened.name);
    if (entry.page) await surface.setPage(entry.page);
    toast(`Opened ${opened.name}`);
  } catch (err) {
    toast(`Could not open: ${err.message}`);
  }
}

function syncPresenting() {
  const on = presenter.open;
  document.getElementById("presenting").hidden = !on;
  document.getElementById("present-btn").classList.toggle("suggested", on);
  if (!on) timer.pause();
  // Closing the projected window by hand does not always reach us — `pagehide`
  // is not guaranteed — and the timer sitting in the header afterwards claims a
  // presentation that ended. So while it is open, its being open is CHECKED.
  clearInterval(syncPresenting._watch);
  if (on) {
    syncPresenting._watch = setInterval(() => {
      if (!presenter.open) { clearInterval(syncPresenting._watch); syncPresenting(); }
    }, 1000);
  }
}

/** Show or hide the notes column. The same two states the divider drag moves
 * between, so the button and the drag cannot disagree about where it sits. */
function toggleNotes(force = null) {
  const stage = document.getElementById("stage");
  const cur = parseFloat(stage.style.flexBasis) / 100;
  const hidden = Number.isFinite(cur) && cur > 0.97;
  const show = force === null ? hidden : force;
  wireDivider.setSplit(show ? (store.get("pane_fraction") || 0.62) : 0.999,
                       { remember: false });
  const btn = document.getElementById("notes-btn");
  btn.setAttribute("aria-pressed", String(show));
  btn.classList.toggle("suggested", false);
  document.getElementById("paned").classList.toggle("notes-hidden", !show);
}

/** Open a notes file for the document already open — for a sidecar named for
 * the course rather than the file, which is what the desktop's "choose notes
 * file" is for. */
function openNotesFile() {
  const input = document.getElementById("notes-input");
  input.onchange = async () => {
    const f = input.files[0];
    input.value = "";
    if (!f || !surface.doc) return;
    surface.doc.notes.setFromText(await f.text());
    notes.setModel(surface.doc.notes);
    notes.showPage(surface.pageIndex);
    syncFullNotes();
    sidebar.setDoc(surface.doc);
    syncPageChrome();
    markDirty(true);
    rememberSession();
    toast(`Notes loaded from ${f.name}`);
  };
  input.click();
}

function wireNotesPanel() {
  document.getElementById("notes-btn").addEventListener("click", () => toggleNotes());
  // a long press, or a right-click, opens a notes file instead of toggling
  document.getElementById("notes-btn").addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openNotesFile();
  });
}

function wirePresenter() {
  document.getElementById("present-btn").addEventListener("click", () => {
    if (presenter.open) { presenter.stop(); return; }
    if (!presenter.start()) {
      return toast("The browser blocked the presenter window — allow popups for this page");
    }
    timer.reset();
    timer.start();
    syncPresenting();
  });
  document.getElementById("timer-toggle").addEventListener("click", () => timer.toggle());
  document.getElementById("timer-reset").addEventListener("click", () => timer.reset());
  // a presenter window outlives a reload otherwise, mirroring a dead editor
  window.addEventListener("pagehide", () => presenter.stop());
}

function wireRecent() {
  const pop = document.getElementById("recent-popover");
  const btn = document.getElementById("recent-btn");
  btn.addEventListener("click", async () => {
    pop.hidden = !pop.hidden;
    if (!pop.hidden) await buildRecentList();
  });
  document.addEventListener("pointerdown", (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !btn.contains(e.target)) {
      pop.hidden = true;
    }
  }, true);
  document.getElementById("recent-clear").addEventListener("click", async () => {
    await clearRecent();
    buildRecentList();
  });
}

/** The overflow menu: the verbs that are reached rather than reflexed.
 *
 * It holds the very buttons that used to stand in the bar, so there is nothing
 * to keep in step — a menu that rebuilt them as copies would be a second set of
 * handlers, which is how one of them comes to be dead. It closes on any of
 * them, because two popovers share the header's top-right corner and the second
 * would open behind the first. */
function wireMoreMenu() {
  const pop = document.getElementById("more-popover");
  const btn = document.getElementById("more-btn");
  btn.addEventListener("click", () => { pop.hidden = !pop.hidden; });
  for (const item of pop.querySelectorAll(".menu-item")) {
    item.addEventListener("click", () => { pop.hidden = true; });
  }
  document.addEventListener("pointerdown", (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !btn.contains(e.target)) {
      pop.hidden = true;
    }
  }, true);
}

// ── bookmarks and linked notes ───────────────────────────────────────────────

/** The header toggle and the notes checkbox both belong to the WINDOW, not to
 * the page, so there is ONE place that points them at the current page. */
function syncBookmarkChrome() {
  const doc = surface.doc;
  const btn = document.getElementById("bookmark-btn");
  const marked = !!doc && doc.notes.isBookmarked(surface.pageIndex);
  btn.classList.toggle("marked", marked);
  btn.setAttribute("aria-pressed", String(marked));
  btn.title = marked ? "Rename this bookmark (Ctrl+B)" : "Bookmark this page (Ctrl+B)";

  const row = document.getElementById("link-check-row");
  const check = document.getElementById("link-check");
  // linked runs are a PDF-only idea: a text sheet has no page structure for a
  // run to span
  row.hidden = !doc || doc.pageCount <= 1;
  check.checked = !!doc && doc.notes.isLinked(surface.pageIndex);
  check.disabled = !doc || surface.pageIndex === 0;   // page 0 continues nothing
}

function chapterFor(page) {
  const doc = surface.doc;
  if (!doc) return null;
  let best = null;
  for (const e of doc.outline) if (e.page <= page) best = e.title;
  return best;
}

/** Adding opens the name field with the derived label in it and SELECTED, so
 * the first keystroke replaces it — a bookmark you must go and rename later is
 * one you name never. A second press RENAMES; it does not remove. */
function toggleBookmark() {
  const doc = surface.doc;
  if (!doc) return;
  const page = surface.pageIndex;
  const pop = document.getElementById("bookmark-popover");
  const field = document.getElementById("bookmark-name");
  field.value = doc.notes.bookmarkLabel(page, chapterFor(page));
  pop.hidden = false;
  field.focus();
  field.select();
  pop.dataset.page = String(page);
  // the toggle flips itself on the click that opens the field, so cancelling
  // has to put it back
  document.getElementById("bookmark-btn").classList.add("marked");
}

function commitBookmark() {
  const doc = surface.doc;
  const pop = document.getElementById("bookmark-popover");
  const page = Number(pop.dataset.page);
  const typed = document.getElementById("bookmark-name").value.trim();
  const derived = doc.notes.bookmarkLabel(page, chapterFor(page));
  // committing the suggestion UNCHANGED stores no name, or the derived label
  // would freeze into the file
  doc.notes.setBookmark(page, typed === derived ? "" : typed);
  pop.hidden = true;
  markDirty(true);
  rememberSession();
  syncPageChrome();
  sidebar.setDoc(doc);
  toast(typed ? `Bookmarked “${typed}”` : `Bookmarked page ${page + 1}`);
}

function cancelBookmark() {
  document.getElementById("bookmark-popover").hidden = true;
  syncPageChrome();      // put the toggle back
}

function dropBookmark(page) {
  const doc = surface.doc;
  if (!doc || !doc.notes.isBookmarked(page)) return;
  const name = doc.notes.bookmarkLabel(page, chapterFor(page));
  // Removing ASKS — the name is stored nowhere else, and there is deliberately
  // no "don't ask again": an opt-out is one stray click from losing the guard
  // for good.
  if (!window.confirm(`Remove the bookmark “${name}”?`)) return;
  doc.notes.dropBookmark(page);
  markDirty(true);
  rememberSession();
  syncPageChrome();
  sidebar.setDoc(doc);
}

function toggleLinked(on) {
  const doc = surface.doc;
  if (!doc) return;
  const page = surface.pageIndex;
  const before = doc.notes.snapshot();
  if (on) doc.notes.linkForward(page, doc.pageCount);
  else doc.notes.unlinkForward(page);
  // Ctrl+Z reaches it as a whole-model snapshot, because linking MERGES two
  // bodies and no page/text pair describes that
  surface.undoStack.push({ type: "notes", page, before,
                           after: doc.notes.snapshot() });
  surface.redoStack.length = 0;
  notes.showPage(page);
  markDirty(true);
  rememberSession();
  syncPageChrome();
  refreshUndo();
}

function wireBookmarks() {
  document.getElementById("bookmark-btn").addEventListener("click", toggleBookmark);
  document.getElementById("bookmark-ok").addEventListener("click", commitBookmark);
  document.getElementById("bookmark-cancel").addEventListener("click", cancelBookmark);
  document.getElementById("bookmark-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commitBookmark(); }
    else if (e.key === "Escape") { e.preventDefault(); cancelBookmark(); }
  });
  document.getElementById("link-check").addEventListener("change", (e) =>
    toggleLinked(e.target.checked));
}

// ── search ───────────────────────────────────────────────────────────────────

function refreshSearch() {
  const entry = document.getElementById("search-entry");
  const count = document.getElementById("search-count");
  const n = search.matches.length;
  // the trailing ellipsis is how the count says it is still climbing
  count.textContent = !search.query ? ""
    : n ? `${search.index} of ${n}${search.scanning ? "…" : ""}`
        : (search.scanning ? "…" : "No results");
  // "not found" WAITS for the scan to finish, or every long document flashes
  // red at a term that is in it
  entry.classList.toggle("not-found", !!search.query && !n && !search.scanning);
  surface.requestDraw();
}

function showSearch() {
  const bar = document.getElementById("searchbar");
  const entry = document.getElementById("search-entry");
  bar.hidden = false;
  entry.focus();
  // grab_focus selects only when focus ARRIVES, so this is here for the case
  // the feature is FOR: pressing Ctrl+F with the caret already in the entry
  entry.select();
  if (entry.value) search.setQuery(entry.value, surface.pageIndex);
}

function hideSearch() {
  document.getElementById("searchbar").hidden = true;
  // keep the TEXT and drop the results, so reopening and pressing Enter
  // re-runs the search instead of stepping through nothing
  search.stop();
  search.matches = [];
  search.current = null;
  search.query = "";
  surface.requestDraw();
  surface.el.focus?.();
}

function wireSearch() {
  const entry = document.getElementById("search-entry");
  entry.addEventListener("input", () => search.setQuery(entry.value, surface.pageIndex));
  entry.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); search.step(e.shiftKey ? -1 : 1); }
    else if (e.key === "Escape") { e.preventDefault(); hideSearch(); }
  });
  document.getElementById("search-next").addEventListener("click", () => search.step(1));
  document.getElementById("search-prev").addEventListener("click", () => search.step(-1));
  document.getElementById("search-close").addEventListener("click", hideSearch);
}

function wireDocument() {
  const input = document.getElementById("file-input");
  document.getElementById("open-btn").addEventListener("click", async () => {
    // The picker is preferred over <input type=file> because it hands back a
    // HANDLE — which is what lets a later save write to the same file instead
    // of dropping a copy in ~/Downloads.
    const picked = canSaveInPlace ? await openWithPicker(true, { notes: true }) : null;
    if (picked === null) { if (!canSaveInPlace) input.click(); return; }
    if (picked.length) openPaired(pairSources(picked));
  });
  input.addEventListener("change", () => {
    if (input.files.length) openFiles(input.files);
    input.value = "";
  });

  document.getElementById("sidebar-btn").addEventListener("click", () => {
    const bar = document.getElementById("sidebar");
    bar.hidden = !bar.hidden;
    if (!bar.hidden) sidebar.rebuild();
    surface.requestDraw();
  });

  document.getElementById("save-btn").addEventListener("click", () => doSave());
  document.getElementById("insert-btn").addEventListener("click", insertPagesFromPicker);
  // The keyboard cannot reach these two in a browser: Ctrl+N and Ctrl+Shift+N
  // are the browser's own window and incognito window, reserved before a page
  // sees them, so `preventDefault` never runs. The shortcuts stay for the
  // desktop build's sake; the menu is what makes the verbs exist here.
  document.getElementById("new-btn").addEventListener("click", () => newDocument());
  document.getElementById("add-page-btn").addEventListener("click",
                                                           () => addPageAfter(surface.pageIndex));
  // The strip's right-click menu had the only Delete, which is a verb you have
  // to already know is there. `removePages` is the same entry point, so the two
  // cannot disagree about what deleting a page does to the notes.
  document.getElementById("del-page-btn").addEventListener("click",
                                                           () => removePages([surface.pageIndex]));
  window.addEventListener("beforeunload", (e) => {
    // nothing is written until you say so, so leaving with unsaved work has to
    // be a deliberate act — but a SANDBOX has nothing of yours in it, and a
    // tour that will not let you leave is a tour nobody finishes
    if (dirty && !SANDBOX && !LIVE) { e.preventDefault(); e.returnValue = ""; }
  });

  const atCentre = (f) => {
    // zoom about the middle of the view, which is where you are looking
    surface.zoomAt(f, surface.cssW / 2, surface.cssH / 2);
  };
  document.getElementById("zoom-in").addEventListener("click", () => atCentre(1.25));
  document.getElementById("zoom-out").addEventListener("click", () => atCentre(1 / 1.25));
  // The swatch is a COLOUR button, not a second way into the settings: opening
  // the popover as well meant one click produced two surfaces at once.
  document.getElementById("pen-swatch").addEventListener("click", () => {
    document.getElementById("color-btn").click();
  });

  document.getElementById("prev-page").addEventListener("click", () => surface.flipPage(-1));
  document.getElementById("next-page").addEventListener("click", () => surface.flipPage(1));

  // The window's own drop target. The sidebar has its own and stops the event,
  // so a drop there imports at the gap instead of replacing the document.
  const hint = document.getElementById("drop-hint");
  let depth = 0;

  /** How many FILES this drag carries. Not `items.length`, which counts data
   * TYPES: a page dragged out of the strip carries three of them (the plain
   * text, the desktop's `DownloadURL`, the other-window handoff key), so the
   * window offered to "merge 3 files" for a drag that was carrying one page and
   * no files at all. `types` naming "Files" is the signal that survives a drag
   * whose data cannot be read yet. */
  const fileCount = (dt) => {
    if (!dt || ![...(dt.types || [])].includes("Files")) return 0;
    return [...(dt.items || [])].filter((i) => i.kind === "file").length;
  };

  const clear = () => { depth = 0; hint.hidden = true; };

  window.addEventListener("dragenter", (e) => {
    e.preventDefault();
    const n = fileCount(e.dataTransfer);
    // an internal page drag is not an offer to open anything
    if (!n) return;
    depth++;
    // A drag exposes its data TYPES, never its file names, so the title cannot
    // know whether two files are two PDFs to merge or a PDF and its sidecar.
    // It says how many; the sub-line below says what each case means.
    document.getElementById("drop-title").textContent =
      n > 1 ? `Drop ${n} files` : "Drop to open";
    hint.hidden = false;
  });
  window.addEventListener("dragover", (e) => { e.preventDefault(); });
  window.addEventListener("dragleave", (e) => {
    e.preventDefault();
    if (--depth <= 0) clear();
  });
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    clear();
    if (e.dataTransfer.files.length) openFiles(e.dataTransfer.files);
  });
  // A DRAG THAT ENDS ELSEWHERE STILL ENDS. Dropping a page onto the desktop
  // finishes the gesture outside this window: no `drop` here, and the last
  // `dragleave` can go missing across a frame or a child element, so the
  // enter/leave count never returns to zero and the hint stays on screen for
  // ever. `dragend` fires on the source for every outcome, including cancel.
  window.addEventListener("dragend", clear, true);
  // and a drag that left the window entirely — the pointer is gone, so nothing
  // else will arrive to balance the count
  document.addEventListener("mouseleave", () => { if (depth) clear(); });
}

// ── the toolbar as a binding surface ─────────────────────────────────────────

function buildToolbar(host) {
  host.replaceChildren();
  for (const tool of TOOL_BAR_ORDER) {
    const btn = document.createElement("button");
    btn.className = "tool-btn";
    btn.dataset.tool = tool;
    btn.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${GLYPHS[tool]}</svg>`;
    if (!IMPLEMENTED_TOOLS.has(tool)) btn.classList.add("unavailable");

    const strip = document.createElement("span");
    strip.className = "strip";
    btn.appendChild(strip);
    if (!toolStrips.has(tool)) toolStrips.set(tool, []);
    toolStrips.get(tool).push(strip);

    // Click a tool with the button you want it on, and it goes there —
    // including a FINGER and the pen's eraser barrel, which are button
    // identities like any other. Plain unmodified LEFT is the exception: it
    // stays the ordinary "put this on the left button" toggle, and a pen TIP
    // tap goes down that path because a tip press is a left press.
    //
    // The GTK version needed a `_binding_press` flag here, because GtkButton's
    // own click gesture is capture-phase too and fires even when ours claims
    // the press. The DOM has no such race: `pointerdown` is the only handler,
    // so the two paths are exclusive by construction.
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const mods = {
        ctrl: e.ctrlKey || heldMods.ctrl,
        shift: e.shiftKey || heldMods.shift,
        alt: e.altKey || heldMods.alt,
      };
      const chord = toolbarBindingFor(e, mods.ctrl, mods.shift, mods.alt);
      if (chord === null) pickTool(tool);       // the plain pick
      else bindChord(chord, tool);
    });
    btn.addEventListener("contextmenu", (e) => e.preventDefault());
    host.appendChild(btn);
  }
}

/** The plain left-click path — put `tool` on the left button.
 *
 * On a TOUCH device that button is the finger, and in LIVE mode the finger's
 * tool is shared with the desktop: this is one system reached from two places,
 * not two apps with their own pens. So picking here binds the finger and tells
 * the desktop, and the desktop's own toolbar moves with it. */
function pickTool(tool) {
  const chord = chordId(MOBILE ? BTN_FINGER : BTN_LEFT);
  bindChord(chord, tool);
  if (LIVE && MOBILE) liveSend({ t: "settool", tool: canonicalTool(tool) });
}

function bindChord(chord, tool) {
  const previous = bindings.bind(chord, tool, bindings.mode);
  refreshToolBindings();
  const label = TOOL_LABELS[canonicalTool(tool)];
  toast(previous && canonicalTool(previous) !== canonicalTool(tool)
    ? `${chordLabel(chord)} → ${label} (was ${TOOL_LABELS[canonicalTool(previous)]})`
    : `${chordLabel(chord)} → ${label}`);
}

/** The buttons that would run `tool` RIGHT NOW.
 *
 * With nothing held that is the plain table. With a modifier down it is the
 * chord table under those modifiers, so the stripes MOVE as you hold Ctrl or
 * Alt and the bar is a live readout of your hand rather than a static badge. A
 * button whose chord is unbound shows nothing, because that is what pressing it
 * would do — the table has no fallback to the plain binding, and neither does
 * the paint. */
function liveButtonsFor(tool) {
  const { ctrl, shift, alt } = heldMods;
  if (!(ctrl || shift || alt)) return bindings.plainButtonsFor(tool, bindings.mode);
  return Object.keys(BUTTON_NAMES).map(Number).sort((a, b) => a - b)
    .filter((btn) => bindings.toolFor(btn, ctrl, shift, alt, bindings.mode)
                     === canonicalTool(tool))
    .map((btn) => BUTTON_NAMES[btn]);
}

/** Routing, stripes and tooltips all read the table — generated together, so a
 * second mapping can never come to claim one thing while the pointer does
 * another. */
function refreshToolBindings() {
  for (const tool of TOOL_BAR_ORDER) {
    const names = liveButtonsFor(tool);
    for (const strip of toolStrips.get(tool) || []) {
      strip.replaceChildren();
      // a segment per button that would run this tool as the pointer sits now,
      // side by side — so a tool on two buttons wears both colours and one no
      // button reaches wears none
      for (const name of names) {
        const seg = document.createElement("i");
        seg.style.background = cssRgb(BUTTON_COLORS[name] || ACCENT);
        strip.appendChild(seg);
      }
    }
    const chords = bindings.chordsFor(tool, bindings.mode);
    const label = TOOL_LABELS[tool];
    const parts = [label];
    if (chords.length) parts.push(chords.map(chordLabel).join(" · "));
    if (!IMPLEMENTED_TOOLS.has(tool)) parts.push("not in this prototype");
    for (const btn of document.querySelectorAll(`.tool-btn[data-tool="${tool}"]`)) {
      btn.title = parts.join(" — ");
      btn.setAttribute("aria-label", label);
      btn.classList.toggle("unavailable",
        !IMPLEMENTED_TOOLS.has(tool) || !toolInMode(tool, bindings.mode));
    }
  }
  buildBindingsList();
}

function buildBindingsList() {
  const host = document.getElementById("bindings-list");
  host.replaceChildren();
  for (const [chord, tool] of bindings.items(bindings.mode)) {
    const row = document.createElement("div");
    row.className = "binding";

    const name = chord.split("+").pop();
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = cssRgb(BUTTON_COLORS[name] || ACCENT);
    row.appendChild(sw);

    const c = document.createElement("span");
    c.className = "chord";
    c.textContent = chordLabel(chord);
    row.appendChild(c);

    const t = document.createElement("span");
    t.className = "tool";
    t.textContent = TOOL_LABELS[canonicalTool(tool)] || tool;
    row.appendChild(t);

    const clear = document.createElement("button");
    clear.textContent = "Clear";
    clear.title = `Unbind ${chordLabel(chord)}`;
    clear.addEventListener("click", () => {
      bindings.clear(chord, bindings.mode);
      refreshToolBindings();
      toast(`${chordLabel(chord)} unbound`);
    });
    row.appendChild(clear);
    host.appendChild(row);
  }
}

// ── the pen popover ──────────────────────────────────────────────────────────

/** The pen's colour lives in the bar as well as the popover, so the thing you
 * change most often is one click away and visible without opening anything. */
/** Setting a colour with ink LASSOED recolours it — one gesture, not "change
 * the pen, then wonder why the selection did not follow". */
function applyPenColor(rgb) {
  setPenSetting("pen_color", rgb);
  document.getElementById("color-btn").value = toHex(rgb);
  refreshPenSwatch();
  if (surface.recolourSelected(rgb)) toast("Recoloured");
  surface.invalidateLayer();
  surface.requestDraw();
}

function refreshPenSwatch() {
  const el = document.getElementById("pen-swatch");
  if (el) el.style.background = cssRgb(pen.pen_color);
}

function buildSwatches() {
  const host = document.getElementById("swatches");
  host.replaceChildren();
  for (const [name, rgb] of SWATCHES) {
    const b = document.createElement("button");
    b.title = name;
    b.style.background = cssRgb(rgb);
    b.addEventListener("click", () => applyPenColor(rgb));
    host.appendChild(b);
  }
}

function toHex(rgb) {
  return "#" + rgb.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
}
function fromHex(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
}

function wirePopover() {
  const pop = document.getElementById("pen-popover");
  const penBtn = document.getElementById("pen-btn");
  penBtn.addEventListener("click", () => { pop.hidden = !pop.hidden; });
  document.addEventListener("pointerdown", (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !penBtn.contains(e.target)) {
      pop.hidden = true;
    }
  }, true);

  bindScale("width-scale", "width-out", pen.pen_width, (v) => v.toFixed(1),
    (v) => setPenSetting("pen_width", v));
  bindScale("smooth-scale", "smooth-out", pen.smoothing * 100, (v) => String(Math.round(v)),
    (v) => setPenSetting("smoothing", v / 100));
  bindScale("smear-scale", "smear-out", pen.min_pressure * 100, (v) => String(Math.round(v)),
    (v) => setPenSetting("min_pressure", v / 100));

  const color = document.getElementById("color-btn");
  color.value = toHex(pen.pen_color);
  color.addEventListener("input", () => applyPenColor(fromHex(color.value)));

  bindCheck("hover-lead", pen.hover_lead, (on) => setPenSetting("hover_lead", on));
  bindCheck("live-smooth", pen.live_smooth, (on) => setPenSetting("live_smooth", on));

  const snap = document.getElementById("shape-snap");
  snap.value = pen.shape_snap;
  snap.addEventListener("change", () => setPenSetting("shape_snap", snap.value));

  document.getElementById("reset-bindings").addEventListener("click", () => {
    bindings.reset(bindings.mode);
    refreshToolBindings();
    toast("Buttons reset");
  });
}

function bindScale(id, outId, value, fmt, apply) {
  const el = document.getElementById(id);
  const out = document.getElementById(outId);
  el.value = value;
  out.textContent = fmt(value);
  el.addEventListener("input", () => {
    const v = parseFloat(el.value);
    out.textContent = fmt(v);
    apply(v);
  });
}

function bindCheck(id, value, apply) {
  const el = document.getElementById(id);
  el.checked = value;
  el.addEventListener("change", () => apply(el.checked));
}

// ── keys ─────────────────────────────────────────────────────────────────────

function wireKeys() {
  // The stripes follow the modifiers, so the held state is tracked on the
  // WINDOW — the same reason the Python version tracks held keys rather than
  // reading an event mask: a press can arrive without one.
  const sync = (e) => {
    const next = { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey };
    if (next.ctrl === heldMods.ctrl && next.shift === heldMods.shift
        && next.alt === heldMods.alt) return;
    Object.assign(heldMods, next);
    surface.setHeldMods(heldMods);
    refreshToolBindings();
  };
  window.addEventListener("keydown", sync);
  window.addEventListener("keyup", sync);
  window.addEventListener("blur", () => {
    Object.assign(heldMods, { ctrl: false, shift: false, alt: false });
    surface.setHeldMods(heldMods);
    refreshToolBindings();
  });

  window.addEventListener("keydown", (e) => {
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === "z") {
      e.preventDefault();
      if (e.shiftKey) surface.redo(); else surface.undo();
    } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && key === "n") {
      e.preventDefault();
      addPageAfter(surface.pageIndex);
    } else if ((e.ctrlKey || e.metaKey) && key === "n") {
      e.preventDefault();
      newDocument();
    } else if ((e.ctrlKey || e.metaKey) && key === "o") {
      e.preventDefault();
      document.getElementById("open-btn").click();
    } else if ((e.ctrlKey || e.metaKey) && key === "0") {
      e.preventDefault();
      surface.fit();
      surface.requestDraw();
    } else if ((e.ctrlKey || e.metaKey) && (key === "\\" || e.code === "Backslash")) {
      e.preventDefault();
      toggleNotes();
    } else if ((e.ctrlKey || e.metaKey) && key === "b") {
      e.preventDefault();
      toggleBookmark();
    } else if ((e.ctrlKey || e.metaKey) && key === "c") {
      // App-level keys belong on the WINDOW so they fire whatever has focus,
      // and the window asks the surface rather than the surface owning the key.
      // The editor keeps Ctrl+C while the caret is in it.
      //
      // A LASSO selection wins over a text one: the ink you have selected is
      // what you meant by copy.
      if (surface.hasSelection() && !typingInNotes()) {
        e.preventDefault();
        surface.copySelected().then((r) => {
          if (!r) return;
          toast(r.picture ? `Copied ${r.count} stroke${r.count > 1 ? "s" : ""}`
                          : `Copied ${r.count} — the picture could not reach the system clipboard`);
        });
      } else if (surface.hasTextSelection() && !typingInNotes()) {
        e.preventDefault();
        navigator.clipboard.writeText(surface.selectedText)
          .then(() => toast("Copied"))
          .catch(() => toast("Could not copy"));
      }
    } else if ((e.ctrlKey || e.metaKey) && key === "f") {
      e.preventDefault();
      showSearch();
    } else if ((e.ctrlKey || e.metaKey) && key === "s") {
      e.preventDefault();
      doSave({ reask: e.shiftKey });          // Ctrl+Shift+S is Save As
    } else if ((e.ctrlKey || e.metaKey) && key === "y") {
      e.preventDefault();
      surface.redo();
    }
    else if (key === "delete" || key === "backspace") {
      // Delete belongs to the EDITOR while the caret is in it — an app-level
      // shortcut that fires whatever has focus would eat a character you were
      // trying to remove from your notes.
      if (surface.hasSelection() && !typingInNotes()) {
        e.preventDefault();
        surface.deleteSelected();
      }
    } else if ((e.ctrlKey || e.metaKey) && key === "d") {
      if (surface.hasSelection() && !typingInNotes()) {
        e.preventDefault();
        surface.duplicateSelected();
      }
    } else if (key === "escape") {
      if (!document.getElementById("searchbar").hidden) hideSearch();
      surface.clearSelection();
    } else if (key === "pagedown" || key === "arrowright") { surface.flipPage(1); }
    else if (key === "pageup" || key === "arrowleft") { surface.flipPage(-1); }
    // There are NO keyboard tool shortcuts. A key that lends a button a tool is
    // a second mapping beside the table, which is the one thing this design
    // does not allow — tools change by binding them.
  });

  document.getElementById("undo-btn").addEventListener("click", () => surface.undo());
  document.getElementById("redo-btn").addEventListener("click", () => surface.redo());
}

/** Is the caret in the notes editor? CodeMirror puts focus on a contenteditable
 * inside the panel, so asking the panel whether it CONTAINS the focused node is
 * the reliable test — `.has-focus` on the wrapper is not always set yet. */
/** Ctrl+V, all of it, in one place.
 *
 * It has to be the `paste` EVENT rather than a key: the system clipboard cannot
 * be read from a keydown, and an image lives only there. That makes this the
 * one path, which is what stops the two kinds of paste disagreeing about which
 * of them just happened.
 *
 * The order is the rule: the notes editor keeps its own paste; then our OWN
 * objects, because pasting ink back as editable ink is the point of copying it
 * and the system clipboard also holds a flat picture of that same ink; then an
 * image from anywhere else.
 */
function wirePaste() {
  window.addEventListener("paste", async (e) => {
    if (typingInNotes()) return;
    const [px, py] = surface.pastePoint();
    if (surface.pasteAt(px, py)) { e.preventDefault(); return toast("Pasted"); }
    // `getAsFile` must be called before any await: the clipboard items are only
    // alive for the duration of the event
    const item = [...(e.clipboardData?.items || [])]
      .find((i) => i.kind === "file" && i.type.startsWith("image/"));
    const file = item && item.getAsFile();
    if (!file) return;
    e.preventDefault();
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const ok = await surface.pasteImageAt(bytes, file.type, px, py);
      toast(ok ? "Image pasted" : "That image could not be read");
    } catch (err) {
      toast(`Could not paste: ${err.message}`);
    }
  });
}

function typingInNotes() {
  const panel = document.getElementById("notes");
  return !!(panel && document.activeElement && panel.contains(document.activeElement));
}

function refreshUndo() {
  document.getElementById("undo-btn").disabled = !surface.undoStack.length;
  document.getElementById("redo-btn").disabled = !surface.redoStack.length;
}

// ── toast ────────────────────────────────────────────────────────────────────

let toastTimer = null;
function toast(text) {
  const el = document.getElementById("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}
