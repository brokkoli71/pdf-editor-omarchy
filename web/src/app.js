// The chrome: the toolbar as a binding surface, the live stripes, the pen
// popover and the bindings list. Ported from PDFEditorWindow's tool-bar and
// pen-popover code, minus the rows this prototype does not implement.

import {
  Bindings, TOOL_BAR_ORDER, TOOL_LABELS, TOOL_MODES, BUTTON_NAMES,
  BUTTON_LABELS, canonicalTool, toolInMode, chordId, chordLabel,
  toolbarBindingFor, BTN_LEFT,
} from "./bindings.js";
import { Surface, IMPLEMENTED_TOOLS } from "./surface.js";
import { Doc, mergeDocuments, insertDocuments } from "./doc.js";
import { Sidebar } from "./sidebar.js";
import { NotesView } from "./notes.js";
import { NotesModel } from "./notes-model.js";
import { saveDocument, openWithPicker, canSaveInPlace } from "./save.js";

// ── settings (the settings.json analogue) ────────────────────────────────────

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
  onChange: () => { refreshUndo(); markDirty(true); },
  onPageChange: (page) => {
    sidebar.setPage(page);
    notes.showPage(page);
    syncPageChrome();
  },
});

const notes = new NotesView(document.getElementById("notes"), {
  onDirty: () => markDirty(true),
});

const sidebar = new Sidebar(document.getElementById("sidebar"), {
  onGoToPage: (page) => surface.setPage(page),   // absolute nav, never a flip
  onDropFiles: (files, gap) => importAt(files, gap),
});

const toolStrips = new Map();   // tool → [strip elements]

buildToolbar(document.getElementById("toolbar"));
buildToolbar(document.getElementById("popover-toolbar"));
buildSwatches();
wirePopover();
wireKeys();
wireDocument();
wireDivider();
refreshToolBindings();
refreshUndo();

window.addEventListener("resize", () => { surface.fit(); surface.requestDraw(); });
surface.requestDraw();

// open on a blank A4 sheet, the same page `blank_pdf_file()` makes
Doc.blank()
  .then((doc) => setDoc(doc, "Untitled"))
  .catch((err) => {
    // A blank page that fails to appear is the whole app failing to start, so
    // it must say so rather than leaving an empty canvas that looks deliberate.
    console.error("could not create the blank page", err);
    toast(`Could not start: ${err.message}`);
  });

// ── the document ─────────────────────────────────────────────────────────────

async function setDoc(doc, title) {
  await surface.setDoc(doc, 0);
  document.getElementById("doc-title").textContent = title || doc.name;
  sidebar.setDoc(doc);
  sidebar.setPage(0);
  notes.setModel(doc.notes);
  syncPageChrome();
  refreshUndo();
  // setDoc runs through the change callback on its way in; what it just loaded
  // is by definition not an unsaved edit
  markDirty(false);
}

/** The divider between the page and the notes. GtkPaned's position, by hand. */
function wireDivider() {
  const divider = document.getElementById("divider");
  const paned = document.getElementById("paned");
  const stage = document.getElementById("stage");
  let dragging = false;

  const apply = (x) => {
    const r = paned.getBoundingClientRect();
    const frac = Math.max(0.15, Math.min(0.92, (x - r.left) / r.width));
    stage.style.flexBasis = `${(frac * 100).toFixed(2)}%`;
    store.set("pane_fraction", frac);
    surface.fit();
    surface.requestDraw();
  };

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
}

/** The page counter and the pager belong to the WINDOW, not to the page, so
 * there is ONE place that points them at the document's current page. */
function syncPageChrome() {
  const doc = surface.doc;
  const counter = document.getElementById("page-counter");
  counter.textContent = doc ? `${surface.pageIndex + 1} / ${doc.pageCount}` : "—";
  document.getElementById("prev-page").disabled = !doc || surface.pageIndex <= 0;
  document.getElementById("next-page").disabled =
    !doc || surface.pageIndex >= doc.pageCount - 1;
}

async function readFiles(files) {
  const list = [...files];
  const pdfs = [];
  // A `.md` dropped alongside its PDF is that PDF's SIDECAR — the same pairing
  // the desktop makes, where a document is a `.pdf` plus the `.md` beside it.
  // Matching is by base name, which is the rule the file layout already
  // encodes.
  const sidecars = new Map();
  for (const f of list) {
    if (/\.md$/i.test(f.name)) {
      sidecars.set(f.name.replace(/\.[^.]+$/, ""), await f.text());
    }
  }
  for (const f of list) {
    if (!/\.pdf$/i.test(f.name) && f.type !== "application/pdf") continue;
    pdfs.push({
      bytes: new Uint8Array(await f.arrayBuffer()),
      name: f.name,
      notesText: sidecars.get(f.name.replace(/\.[^.]+$/, "")) ?? null,
    });
  }
  // a `.md` on its own is a notes file for the document already open
  if (!pdfs.length && sidecars.size && surface.doc) {
    return { loneNotes: [...sidecars.values()][0] };
  }
  return pdfs;
}

/** One file OPENS; several MERGE into one document with a chapter per file.
 * That is the whole point of dropping more than one at once — you get a single
 * document whose outline names where each source began, not a pile of tabs. */
async function openFiles(files) {
  const sources = await readFiles(files);
  if (sources.loneNotes !== undefined) {
    // a sidecar for the document already open
    surface.doc.notes.setFromText(sources.loneNotes);
    notes.setModel(surface.doc.notes);
    notes.showPage(surface.pageIndex);
    markDirty(false);
    return toast("Notes loaded");
  }
  return openSources(sources);
}

/** `sources` are {bytes, name, handle?, notesText?} — one OPENS, several MERGE
 * into one document with a chapter per file. */
async function openSources(sources) {
  if (!sources.length) return toast("No PDFs in that drop");
  try {
    if (sources.length === 1) {
      const doc = await Doc.open(sources[0].bytes, sources[0].name);
      if (sources[0].handle) doc.handles = { pdf: sources[0].handle };
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
    toast(result.inPlace ? `Saved ${what}` : `Downloaded ${what}`);
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
  const sources = await readFiles(files);
  if (!sources.length) return toast("No PDFs in that drop");
  try {
    const host = surface.doc;
    const { bytes, ink } = await insertDocuments(host, sources, gap);
    const doc = await Doc.open(bytes, host.name);
    doc.ink = ink;
    await setDoc(doc, document.getElementById("doc-title").textContent);
    await surface.setPage(gap);
    toast(`Inserted ${sources.length} document${sources.length > 1 ? "s" : ""} at page ${gap + 1}`);
  } catch (err) {
    toast(`Could not insert: ${err.message}`);
  }
}

function wireDocument() {
  const input = document.getElementById("file-input");
  document.getElementById("open-btn").addEventListener("click", async () => {
    // The picker is preferred over <input type=file> because it hands back a
    // HANDLE — which is what lets a later save write to the same file instead
    // of dropping a copy in ~/Downloads.
    const picked = canSaveInPlace ? await openWithPicker(true) : null;
    if (picked === null) { if (!canSaveInPlace) input.click(); return; }
    if (picked.length) openSources(picked);
  });
  input.addEventListener("change", () => {
    if (input.files.length) openFiles(input.files);
    input.value = "";
  });

  document.getElementById("sidebar-btn").addEventListener("click", () => {
    const bar = document.getElementById("sidebar");
    bar.hidden = !bar.hidden;
    if (!bar.hidden) sidebar.rebuild();
    surface.fit();
    surface.requestDraw();
  });

  document.getElementById("save-btn").addEventListener("click", () => doSave());
  window.addEventListener("beforeunload", (e) => {
    // nothing is written until you say so, so leaving with unsaved work has to
    // be a deliberate act
    if (dirty) { e.preventDefault(); e.returnValue = ""; }
  });

  document.getElementById("prev-page").addEventListener("click", () => surface.flipPage(-1));
  document.getElementById("next-page").addEventListener("click", () => surface.flipPage(1));

  // The window's own drop target. The sidebar has its own and stops the event,
  // so a drop there imports at the gap instead of replacing the document.
  const hint = document.getElementById("drop-hint");
  let depth = 0;
  window.addEventListener("dragenter", (e) => {
    e.preventDefault();
    depth++;
    const n = e.dataTransfer?.items?.length || 0;
    document.getElementById("drop-title").textContent =
      n > 1 ? `Drop to merge ${n} files` : "Drop to open";
    hint.hidden = false;
  });
  window.addEventListener("dragover", (e) => { e.preventDefault(); });
  window.addEventListener("dragleave", (e) => {
    e.preventDefault();
    if (--depth <= 0) { depth = 0; hint.hidden = true; }
  });
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    hint.hidden = true;
    if (e.dataTransfer.files.length) openFiles(e.dataTransfer.files);
  });
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

/** The plain left-click path — put `tool` on the left button. */
function pickTool(tool) {
  bindChord(chordId(BTN_LEFT), tool);
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

function buildSwatches() {
  const host = document.getElementById("swatches");
  host.replaceChildren();
  for (const [name, rgb] of SWATCHES) {
    const b = document.createElement("button");
    b.title = name;
    b.style.background = cssRgb(rgb);
    b.addEventListener("click", () => {
      setPenSetting("pen_color", rgb);
      document.getElementById("color-btn").value = toHex(rgb);
      surface.invalidateLayer();
      surface.requestDraw();
    });
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
  color.addEventListener("input", () => {
    setPenSetting("pen_color", fromHex(color.value));
    surface.invalidateLayer();
    surface.requestDraw();
  });

  bindCheck("hover-lead", pen.hover_lead, (on) => setPenSetting("hover_lead", on));
  bindCheck("live-smooth", pen.live_smooth, (on) => setPenSetting("live_smooth", on));

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
    } else if ((e.ctrlKey || e.metaKey) && key === "s") {
      e.preventDefault();
      doSave({ reask: e.shiftKey });          // Ctrl+Shift+S is Save As
    } else if ((e.ctrlKey || e.metaKey) && key === "y") {
      e.preventDefault();
      surface.redo();
    }
    else if (key === "pagedown" || key === "arrowright") { surface.flipPage(1); }
    else if (key === "pageup" || key === "arrowleft") { surface.flipPage(-1); }
    // There are NO keyboard tool shortcuts. A key that lends a button a tool is
    // a second mapping beside the table, which is the one thing this design
    // does not allow — tools change by binding them.
  });

  document.getElementById("undo-btn").addEventListener("click", () => surface.undo());
  document.getElementById("redo-btn").addEventListener("click", () => surface.redo());
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
