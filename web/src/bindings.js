// Button bindings: THE table (row 132), ported from sidemark.py.
//
// There is no "active tool". Every button, alone or under modifiers, HAS a
// tool, and pressing that button uses it — left draws, right erases, middle
// lassos, and that is true at the same time. Clicking a tool in the toolbar
// with a mouse button binds the tool to THAT button.
//
// Everything that routes a press, paints a stripe or writes a tooltip reads
// this table. A second mapping is how the bar comes to claim one thing while
// the pointer does another.

export const TOOL_BAR_ORDER = ["pen", "highlighter", "eraser", "lasso", "text",
                              "pan", "zoom", "anchor"];

export const TOOL_MODES = {
  pen:         ["pdf", "text"],
  highlighter: ["pdf", "text"],
  eraser:      ["pdf", "text"],
  lasso:       ["pdf", "text"],
  text:        ["pdf", "text"],
  pan:         ["pdf", "text"],
  zoom:        ["pdf", "text"],
  anchor:      ["pdf"],          // the one genuinely PDF-only tool
};

export const TOOL_LABELS = {
  pen: "Pen", highlighter: "Highlighter", eraser: "Eraser", lasso: "Lasso",
  text: "Text cursor", pan: "Pan", zoom: "Zoom to region",
  anchor: "Anchor / callout",
};

// "select" is the caret tool's old id, still accepted anywhere a tool is named.
const TOOL_ALIASES = { select: "text" };

export function canonicalTool(tool) {
  return TOOL_ALIASES[tool] || tool;
}

export function toolInMode(tool, mode) {
  return (TOOL_MODES[canonicalTool(tool)] || []).includes(mode);
}

export const BTN_LEFT = 1, BTN_MIDDLE = 2, BTN_RIGHT = 3, BTN_THUMB = 10;
// A finger is its own button, not button 1. It is the only input with no
// physical button behind it, so it gets a synthetic number above every real
// one; everything downstream then treats it as an ordinary button for free.
export const BTN_FINGER = 11;

export const BUTTON_NAMES = {
  [BTN_LEFT]: "left", [BTN_MIDDLE]: "middle", [BTN_RIGHT]: "right",
  [BTN_THUMB]: "thumb", [BTN_FINGER]: "finger",
};
export const BUTTON_LABELS = {
  left: "Left", middle: "Middle", right: "Right", thumb: "Thumb",
  finger: "Finger",
};

// order matters: it is the order modifiers are written in a chord id, so one
// chord has exactly one spelling and the saved settings stay diffable
const MOD_ORDER = ["ctrl", "shift", "alt"];

/** The canonical id of a button+modifier chord, e.g. `ctrl+shift+left`. */
export function chordId(button, ctrl = false, shift = false, alt = false) {
  const name = BUTTON_NAMES[button] || String(button);
  const mods = MOD_ORDER.filter((_, i) => [ctrl, shift, alt][i]);
  return mods.concat([name]).join("+");
}

/** A chord id as a human reads it: `ctrl+shift+left` → `Ctrl+Shift+left`. */
export function chordLabel(chord) {
  const parts = chord.split("+");
  return parts.slice(0, -1).map((p) => p[0].toUpperCase() + p.slice(1))
    .concat([parts[parts.length - 1]]).join("+");
}

export const DEFAULT_BINDINGS = {
  // The shipped defaults: the three buttons every mouse has, and four chords,
  // no more. Every chord is bindable, so this is a starting point rather than a
  // grammar — a short table keeps it clear what is yours and what was ours.
  left: "pen",
  middle: "lasso",
  right: "eraser",
  "ctrl+left": "pan",
  "ctrl+right": "text",
  "shift+left": "zoom",
  // Alt+left is the text cursor because Alt is how you follow a PDF link, and
  // following a link IS the cursor tool's click. Left unbound under Alt meant
  // Alt lit the links up and then nothing opened them — the modifier promised
  // something the table could not deliver.
  "alt+left": "text",
  // A FINGER PANS, and that is what makes a resting palm harmless: on a
  // convertible the palm lands before the pen tip does, so whatever a stray
  // touch runs, it must not be the pen.
  finger: "pan",
  // The THUMB is deliberately unbound: most mice do not have one, and a default
  // nobody can press is a default nobody chose.
};

// The TEXT page's table. Same defaults unless there is a reason — the two modes
// are one app, so a chord you learned on a PDF must not mean something else on a
// sheet. The reasons here are the mode itself: a text page is for TYPING, so the
// left button is the caret rather than the pen. Alt+left then carries the pen,
// because the pen must stay reachable without rebinding.
export const TEXT_BINDING_OVERRIDES = {
  left: "text",
  "shift+left": "text",
  "alt+left": "pen",
};
export const DEFAULT_TEXT_BINDINGS = { ...DEFAULT_BINDINGS, ...TEXT_BINDING_OVERRIDES };
export const DEFAULT_TABLES = { pdf: DEFAULT_BINDINGS, text: DEFAULT_TEXT_BINDINGS };
export const BINDING_MODES = Object.keys(DEFAULT_TABLES);

/** THE mapping from a physical input to a BUTTON IDENTITY (row 135).
 *
 * A stylus and a touchscreen do not get their own binding table: the pen's ends
 * *are* mouse buttons, so everything downstream — the table, the colour
 * stripes, the badges, the tooltips, the popover, the toolbar binding surface —
 * keeps speaking one language and needs no change at all.
 *
 *     pen tip              -> left      (draws, by default)
 *     eraser barrel + tip  -> right     (erases, by default)
 *     other barrel + tip   -> middle    (lassos, by default)
 *     finger               -> finger    (pans, by default)
 *
 * So the shipped defaults already ARE the pen workflow, and the eraser barrel
 * literally wears the right button's colour in the bar, which is how the
 * mapping teaches itself.
 *
 * ceiling: tip and left-click are ONE identity and cannot hold different tools.
 * If they ever must, the identity needs a source qualifier — which costs the
 * whole table a dimension.
 *
 * The web is kinder here than GTK was. `pointerType` is authoritative (GTK
 * delivers the LOGICAL pointer for a stylus, whose source reports MOUSE, so the
 * obvious API was the wrong one), and the barrel arrives in `event.buttons`
 * on the same event as the tip — so there is no barrel to track separately and
 * no press to deny. Both of the traps that made the GTK version hard are simply
 * absent. */
export function buttonForEvent(event) {
  if (event.pointerType === "touch") return BTN_FINGER;
  if (event.pointerType === "pen") {
    // Per the PointerEvent spec: button 5 / buttons bit 32 is the eraser end,
    // button 2 / buttons bit 2 is the barrel. `buttons` is the held mask, which
    // is what makes barrel+tip resolvable from one event.
    if (event.button === 5 || (event.buttons & 32)) return BTN_RIGHT;
    if (event.buttons & 2) return BTN_MIDDLE;
    return BTN_LEFT;
  }
  // A mouse. DOM buttons are 0/1/2 (left/middle/right); ours are 1/2/3, and
  // button 3 ("back") is the thumb.
  if (event.button === 0) return BTN_LEFT;
  if (event.button === 1) return BTN_MIDDLE;
  if (event.button === 2) return BTN_RIGHT;
  if (event.button === 3) return BTN_THUMB;
  return BTN_LEFT;
}

/** What a press on a TOOL BUTTON should do: the chord to bind, or null for the
 * plain pick.
 *
 * `null` is the ordinary "put this on the left button" toggle, which is what an
 * unmodified left press and a pen TIP tap both are. Anything else names the
 * chord to bind, so the bar binds what you touched it with: a finger tap binds
 * `finger`, an eraser-barrel tap binds `right`. */
export function toolbarBindingFor(event, ctrl, shift, alt) {
  const btn = buttonForEvent(event);
  if (btn === BTN_LEFT && !(ctrl || shift || alt)) return null;
  return chordId(btn, ctrl, shift, alt);
}

/** The mutable button tables — ONE PER DOCUMENT MODE. Unknown tools are dropped
 * on load rather than kept: a binding nothing can execute would silently
 * swallow the press.
 *
 * `mode` is the table the UI acts on: the toolbar, its stripes and tooltips and
 * the popover all read and write the table of the document you are looking at.
 * Everything that ROUTES a press passes its own mode explicitly instead,
 * because a surface knows what it is and must never depend on which tab the
 * chrome thinks is in front. */
export class Bindings {
  constructor(tables = null, mode = "pdf") {
    tables = tables || {};
    this._tables = {};
    for (const m of BINDING_MODES) {
      this._tables[m] = { ...(tables[m] || DEFAULT_TABLES[m]) };
    }
    this.mode = this._tables[mode] ? mode : "pdf";
  }

  tableFor(mode) {
    return this._tables[mode || this.mode] || this._tables.pdf;
  }

  // ── reading ────────────────────────────────────────────────────────────────

  /** The tool this chord runs in this document mode, or null. */
  toolFor(button, ctrl = false, shift = false, alt = false, mode = "pdf") {
    const raw = this.tableFor(mode)[chordId(button, ctrl, shift, alt)];
    if (raw == null) return null;
    const tool = canonicalTool(raw);
    return toolInMode(tool, mode) ? tool : null;
  }

  toolForChord(chord, mode = null) {
    const raw = this.tableFor(mode)[chord];
    return raw ? canonicalTool(raw) : null;
  }

  /** Every chord bound to a tool, in a stable order (plain buttons before
   * modified ones) — this is what the tooltips are built from, so they can
   * never disagree with what the pointer does. */
  chordsFor(tool, mode = null) {
    tool = canonicalTool(tool);
    const table = this.tableFor(mode);
    if (mode !== null && !toolInMode(tool, mode)) return [];
    return Object.keys(table).filter((c) => canonicalTool(table[c]) === tool)
      .sort(chordSort);
  }

  /** The UNMODIFIED buttons a tool owns — the ones that earn a stripe. Modified
   * chords deliberately get none, or every button in the bar wears a
   * constellation; they live in the tooltip instead. */
  plainButtonsFor(tool, mode = null) {
    const table = this.tableFor(mode);
    tool = canonicalTool(tool);
    return Object.keys(table)
      .filter((c) => canonicalTool(table[c]) === tool && !c.includes("+"))
      .sort(chordSort);
  }

  /** (chord, tool) pairs, plain buttons first — the popover's list. */
  items(mode = null) {
    const table = this.tableFor(mode);
    return Object.keys(table).sort(chordSort).map((c) => [c, table[c]]);
  }

  // ── writing ────────────────────────────────────────────────────────────────

  /** Bind a chord in one mode's table, returning the tool it took it from (null
   * if free). A chord maps to exactly ONE tool per mode, so binding MOVES it —
   * that is what the toast reports, and why there is no silent double-binding. */
  bind(chord, tool, mode = null) {
    const table = this.tableFor(mode);
    tool = canonicalTool(tool);
    const previous = table[chord];
    table[chord] = tool;
    this.save();
    return previous ? canonicalTool(previous) : null;
  }

  clear(chord, mode = null) {
    const table = this.tableFor(mode);
    const had = table[chord];
    delete table[chord];
    this.save();
    return had || null;
  }

  /** Back to the defaults — of the active mode only. The other mode's table is a
   * different question and nobody asked it. */
  reset(mode = null) {
    const m = mode || this.mode;
    this._tables[m] = { ...DEFAULT_TABLES[m] };
    this.save();
  }

  // ── persistence ────────────────────────────────────────────────────────────

  toJSON() {
    const out = {};
    for (const m of BINDING_MODES) out[m] = { ...this._tables[m] };
    return out;
  }

  static _clean(data) {
    const table = {};
    for (const [chord, raw] of Object.entries(data || {})) {
      const tool = typeof raw === "string" ? canonicalTool(raw) : null;
      if (tool && TOOL_MODES[tool]) table[chord] = tool;
    }
    return table;
  }

  /** Load the saved table, SEEDING any default that has never been offered.
   *
   * A saved table is the whole truth — that is what lets you unbind a chord and
   * have it stay unbound. But it also means a default added later reaches nobody
   * who has ever customised their bindings. So the settings remember which
   * default KEYS have been seen: a key missing from that list is new and gets
   * seeded once; a key on the list but absent from the table was deliberately
   * cleared, and stays gone.
   *
   * Do NOT "fix" this by merging DEFAULT_BINDINGS over the saved table on every
   * load — that resurrects every binding the user ever removed. */
  static load(store) {
    const saved = store.get("button_bindings");
    const tables = {};
    for (const m of BINDING_MODES) {
      tables[m] = (saved && typeof saved[m] === "object")
        ? Bindings._clean(saved[m]) : null;
    }
    const bindings = new Bindings(tables);
    let seen = store.get("button_defaults_seeded");
    if (!seen || typeof seen !== "object") {
      // First run under this scheme. A table already saved predates the list, so
      // everything in it counts as seen; a fresh install has just taken the
      // defaults wholesale and is seeded by them.
      seen = {};
      for (const m of BINDING_MODES) {
        seen[m] = (saved && saved[m]) ? Object.keys(saved[m]) : [];
      }
    }
    let dirty = false;
    for (const m of BINDING_MODES) {
      const known = seen[m] || [];
      const fresh = Object.keys(DEFAULT_TABLES[m]).filter((c) => !known.includes(c));
      for (const chord of fresh) {
        if (!(chord in bindings._tables[m])) {
          bindings._tables[m][chord] = DEFAULT_TABLES[m][chord];
        }
      }
      if (fresh.length) {
        seen[m] = [...new Set(known.concat(Object.keys(DEFAULT_TABLES[m])))].sort();
        dirty = true;
      }
    }
    bindings._store = store;
    if (dirty) {
      store.set("button_defaults_seeded", seen);
      bindings.save();
    }
    return bindings;
  }

  save() {
    if (this._store) this._store.set("button_bindings", this.toJSON());
  }
}

function chordSort(a, b) {
  const na = (a.match(/\+/g) || []).length, nb = (b.match(/\+/g) || []).length;
  return na - nb || (a < b ? -1 : a > b ? 1 : 0);
}
