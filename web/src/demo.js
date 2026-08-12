// The tour.
//
// Six steps over a REAL Sidemark in an iframe. Each one watches the app until
// it can see that you did the thing, then moves on — because the features worth
// a tour are the ones you would never find, and a gesture you have only read
// about is one you still cannot do. The dwell is the whole argument: nothing on
// screen suggests that holding still does anything.
//
// Every check reads the LIVE MODEL through `window.__sidemark` (or a toast,
// which is the app's own account of what it just did). Nothing here reaches
// into the app to make something happen — if a step can pass without you doing
// it, the step is wrong.

import { shapeVertices, VERTEX_WELD_EPS } from "./lasso.js";

const frame = document.getElementById("demo-frame");
const el = {
  title: document.getElementById("demo-title"),
  body: document.getElementById("demo-body"),
  hint: document.getElementById("demo-hint"),
  extra: document.getElementById("demo-extra"),
  dots: document.getElementById("demo-dots"),
  done: document.getElementById("demo-done"),
  doneText: document.getElementById("demo-done-text"),
  prev: document.getElementById("demo-prev"),
  skip: document.getElementById("demo-skip"),
  end: document.getElementById("demo-end"),
  again: document.getElementById("demo-again"),
  panel: document.getElementById("demo-panel"),
};

/** The app's live model, or null while it is still starting. */
const app = () => frame.contentWindow && frame.contentWindow.__sidemark;

/** A pointing device with more than one button. Two steps ask for the middle
 * or right button, which a trackpad or a touchscreen may not have — better to
 * say so than to leave someone stuck on an instruction they cannot follow. */
const hasButtons = () => matchMedia("(pointer: fine)").matches;

// ── watching the app ─────────────────────────────────────────────────────────

/** The last toast the app raised, with the time it appeared.
 *
 * A toast is the app's OWN account of what it just did ("Page 2 → 4"), which
 * makes it the honest signal for the verbs that leave no trace in the model —
 * a reorder changes the page order and nothing else observable from out here.
 */
let lastToast = { text: "", at: 0 };
function watchToasts() {
  const doc = frame.contentDocument;
  const toast = doc && doc.getElementById("toast");
  if (!toast) return false;
  new MutationObserver(() => {
    if (!toast.hidden && toast.textContent) {
      lastToast = { text: toast.textContent, at: Date.now() };
    }
  }).observe(toast, { childList: true, characterData: true, subtree: true,
                      attributes: true, attributeFilter: ["hidden"] });
  return true;
}

/** A page leaving the window: the drag that hands a PDF to the desktop.
 *
 * There is no way to see where a drag LANDS — the drop happens in a file
 * manager this page will never hear from. What can be checked is the half that
 * was broken until recently and is the whole of Sidemark's side: that the drag
 * left carrying a file at all. */
let pageDragOut = 0;
function watchPageDrags() {
  const doc = frame.contentDocument;
  if (!doc) return false;
  doc.addEventListener("dragstart", (e) => {
    const types = [...(e.dataTransfer?.types || [])].map((t) => t.toLowerCase());
    if (types.includes("downloadurl") || types.includes("application/x-sidemark-pages")) {
      pageDragOut = Date.now();
    }
  }, true);
  return true;
}

/** Two strokes sharing a corner — the weld, re-derived exactly as the app
 * re-derives it, rather than asking the app whether it thinks it welded. */
function weldedPair(strokes) {
  const shapes = strokes.map((s) => shapeVertices(s.pts)).filter((v) => v.length);
  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      for (const a of shapes[i]) {
        for (const b of shapes[j]) {
          if (Math.abs(a[0] - b[0]) <= VERTEX_WELD_EPS
              && Math.abs(a[1] - b[1]) <= VERTEX_WELD_EPS) return true;
        }
      }
    }
  }
  return false;
}

// ── the steps ────────────────────────────────────────────────────────────────
//
// `arm` runs once when the step opens and may record what "before" looked like;
// `check` runs a few times a second and returns true when the app shows it
// happened. Keep checks about the RESULT, never about the route taken to it.

const steps = [
  {
    id: "draw",
    title: "Draw on it",
    body: "This is a real page of a real PDF. Draw something under the definition — an arrow, a sketch of a vector being stretched, anything.",
    hint: "The pen is already on your left button.",
    arm(ctx) { ctx.n0 = (app()?.strokes || []).length; },
    check(ctx) { return (app()?.strokes || []).length > ctx.n0; },
    done: "That ink is an annotation in the PDF, not a layer on top of it.",
  },

  {
    id: "buttons",
    title: "Put a tool on a button",
    body: "There is no “current tool”. Every mouse button holds one, and you say which: click any tool in the bar with your MIDDLE button — the highlighter, say.",
    hint: "Then use both at once: draw with the left button, highlight with the middle one, nothing to switch.",
    skipIf: () => !hasButtons(),
    skipNote: "This one needs a mouse with more than one button.",
    // What the middle button held when the step OPENED, not a named tool: the
    // lasso is already there by default, so asking for it passed the step
    // before anyone had done anything. The lesson is that YOU choose, so the
    // check is that the choice changed.
    arm(ctx) {
      const a = app();
      ctx.was = a ? a.bindings.toolFor(2, false, false, false, "pdf") : null;
    },
    check(ctx) {
      const a = app();
      return !!a && a.bindings.toolFor(2, false, false, false, "pdf") !== ctx.was;
    },
    done: "Both buttons are live at once. The coloured stripe under each tool says which button it is on.",
  },

  {
    id: "dwell",
    title: "Hold still, then join",
    body: "Draw a rough box and STOP MOVING without lifting. It becomes a clean rectangle. Then, still without lifting, drag the point you are holding onto a corner of it — the two snap together.",
    hint: "Half a second of stillness is enough. A label appears naming what you are about to get.",
    arm(ctx) { ctx.snapped = false; },
    check(ctx) {
      const a = app();
      if (!a) return false;
      // the dwell is a MOMENT, so it is caught as it happens rather than found
      // afterwards; the weld is a fact about the page and can be measured at
      // any time
      if (a.surface._snapKind) ctx.snapped = true;
      return ctx.snapped && weldedPair(a.strokes);
    },
    done: "Nothing was stored to join them: two points at the same place ARE one point, worked out afresh every time you grab one.",
  },

  {
    id: "lasso",
    title: "Circle something with the pen",
    body: "Draw a loop around some of your ink and LIFT. Then press and hold inside it. The loop becomes the selection — and the pen is still in your hand.",
    hint: "Hold for about half a second. Drag the selection once it appears.",
    check() {
      const a = app();
      return !!a && a.selected.length > 0 && !!a.surface.selectionLoop;
    },
    done: "The selection wears the loop you drew, not a box around it — so what you grab is what you circled.",
  },

  {
    id: "notes",
    title: "Write the maths",
    body: "In the notes on the right, type  \\alpha  and then  x^2 . They become α and x² as you type.",
    hint: "The file on disk still says \\alpha — put the caret on it and you will see the source come back.",
    check() {
      const a = app();
      if (!a || !a.doc) return false;
      const text = a.doc.notes.get(a.surface.pageIndex) || "";
      return /\\[A-Za-z]+/.test(text) && /\^|_/.test(text);
    },
    done: "The notes are a plain Markdown file. Nothing here is a Sidemark format you would need Sidemark to read.",
  },

  {
    id: "pages",
    title: "Move pages around",
    body: "Open the page strip, then do these three:",
    list: [
      "Drag a thumbnail to a different position.",
      "Drag the handout below into the strip.",
      "Drag a thumbnail out onto your desktop.",
    ],
    hint: "The strip is the leftmost button in the bar.",
    handout: true,
    arm(ctx) {
      ctx.pages0 = app()?.doc?.pageCount ?? 0;
      ctx.moved = false;
      ctx.added = false;
      ctx.out = false;
      lastToast = { text: "", at: 0 };
      pageDragOut = 0;
    },
    check(ctx) {
      const a = app();
      if (!a || !a.doc) return false;
      if (/^Page \d+ → \d+$/.test(lastToast.text)) ctx.moved = true;
      if (a.doc.pageCount > ctx.pages0) ctx.added = true;
      if (pageDragOut) ctx.out = true;
      progress(ctx);
      return ctx.moved && ctx.added && ctx.out;
    },
    done: "A dragged page leaves as an ordinary PDF, with its ink in it — into your files, or into another Sidemark window.",
  },
];

/** Tick the three boxes of the last step as they happen, so it is obvious which
 * part is still outstanding. */
function progress(ctx) {
  const items = el.extra.querySelectorAll(".demo-task");
  [ctx.moved, ctx.added, ctx.out].forEach((ok, i) => {
    if (items[i]) items[i].classList.toggle("ticked", !!ok);
  });
}

// ── running them ─────────────────────────────────────────────────────────────

let index = 0;
let ctx = {};
let timer = null;

function paintDots() {
  el.dots.textContent = "";
  steps.forEach((_, i) => {
    const d = document.createElement("i");
    d.className = i < index ? "past" : i === index ? "now" : "";
    el.dots.appendChild(d);
  });
}

function show(i) {
  clearInterval(timer);
  index = Math.max(0, Math.min(steps.length - 1, i));
  const step = steps[index];
  ctx = {};
  el.done.hidden = true;
  el.panel.classList.remove("passed");
  el.title.textContent = step.title;
  el.body.textContent = step.body;
  el.hint.textContent = step.hint || "";
  el.hint.hidden = !step.hint;
  el.prev.disabled = index === 0;
  paintDots();

  // the extras: the three-part checklist, and the draggable handout
  el.extra.textContent = "";
  el.extra.hidden = !(step.list || step.handout);
  if (step.list) {
    const ul = document.createElement("ul");
    ul.className = "demo-tasks";
    for (const item of step.list) {
      const li = document.createElement("li");
      li.className = "demo-task";
      li.textContent = item;
      ul.appendChild(li);
    }
    el.extra.appendChild(ul);
  }
  if (step.handout) el.extra.appendChild(handoutCard());

  if (step.skipIf && step.skipIf()) {
    el.hint.hidden = false;
    el.hint.textContent = step.skipNote || "Not available on this device.";
  }

  if (step.arm) step.arm(ctx);
  timer = setInterval(() => {
    let ok = false;
    try { ok = step.check(ctx); } catch { ok = false; }   // the app may be reloading
    if (ok) pass();
  }, 250);
}

function pass() {
  clearInterval(timer);
  const step = steps[index];
  el.doneText.textContent = step.done || "Done";
  el.done.hidden = false;
  el.panel.classList.add("passed");
  // a beat to read what just happened, rather than the panel changing under
  // the hand that is still finishing the gesture
  setTimeout(() => {
    if (index === steps.length - 1) finish();
    else show(index + 1);
  }, 2600);
}

function finish() {
  clearInterval(timer);
  el.end.hidden = false;
}

/** The page you drag INTO the document. A real file, offered by a real drag —
 * the same path a PDF dragged out of a file manager takes, which is the point:
 * the app is not being told about it, it is being dropped on. */
function handoutCard() {
  const card = document.createElement("div");
  card.className = "demo-handout";
  card.draggable = true;
  card.innerHTML = '<span class="demo-file">PDF</span><span>handout.pdf<small>drag me into the page strip</small></span>';
  card.addEventListener("dragstart", async (e) => {
    // `setData` must run synchronously inside dragstart, so the bytes are
    // fetched when the step opens, not here
    if (!handoutFile) return;
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.items.add(handoutFile);
  });
  return card;
}

let handoutFile = null;
async function loadHandout() {
  try {
    const bytes = await fetch("demo/handout.pdf").then((r) => r.arrayBuffer());
    handoutFile = new File([bytes], "handout.pdf", { type: "application/pdf" });
  } catch { /* the step still passes on a page dragged in from anywhere else */ }
}

// ── starting up ──────────────────────────────────────────────────────────────

/** Put the lecture in front of the reader, through the app's own drop path.
 *
 * Deliberately not a private "load this" entry point: the tour should exercise
 * what everyone else exercises, and a seam built only for the demo is a seam
 * that can rot without anyone noticing. */
async function seed() {
  const W = frame.contentWindow;
  const bytes = await fetch("demo/lecture.pdf").then((r) => r.arrayBuffer());
  const dt = new W.DataTransfer();
  dt.items.add(new W.File([bytes], "lecture.pdf", { type: "application/pdf" }));
  for (const type of ["dragover", "drop"]) {
    W.dispatchEvent(new W.DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  }
}

async function start() {
  // wait for the app to be up: the hook appears at the end of its own start-up
  for (let i = 0; i < 80 && !app(); i++) await new Promise((r) => setTimeout(r, 100));
  if (!app()) {
    el.title.textContent = "Sidemark did not start";
    el.body.textContent = "The tour needs the app running in the frame beside it. The browser console will say why.";
    return;
  }
  watchToasts();
  watchPageDrags();
  await loadHandout();
  await seed();
  await new Promise((r) => setTimeout(r, 600));
  show(0);
}

el.prev.addEventListener("click", () => show(index - 1));
el.skip.addEventListener("click", () => {
  if (index === steps.length - 1) finish();
  else show(index + 1);
});
el.again.addEventListener("click", () => {
  el.end.hidden = true;
  frame.src = "index.html?sandbox=1";
  frame.addEventListener("load", () => start(), { once: true });
});

frame.addEventListener("load", () => start(), { once: true });
