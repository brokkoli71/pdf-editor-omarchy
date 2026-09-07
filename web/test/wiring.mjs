// A static guard against the failure that shipped four dead menu entries.
//
// Every one of them was a callback the sidebar reads and app.js never supplied,
// or a function referenced and never defined. Neither is a syntax error, so
// `node --check` passes and the entry simply does nothing when clicked — the
// quietest possible way to ship something broken.
//
// The cause was a series of string-anchored edits where a later anchor no
// longer matched, and `String.replace` returns the original when it finds
// nothing. This is what catches that class.
//
//   node test/wiring.mjs

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (f) => readFileSync(join(src, f), "utf8");
let failures = 0;
const fail = (msg) => { failures++; console.error("  ✗ " + msg); };

// ── every callback a module READS must be SUPPLIED where it is constructed ──
const app = read("app.js");
for (const [file, ctor] of [["sidebar.js", "Sidebar"], ["notes.js", "NotesView"],
                            ["surface.js", "Surface"], ["presenter.js", "Presenter"]]) {
  const wanted = new Set([...read(file).matchAll(/opts\.(on[A-Za-z]+)/g)].map((m) => m[1]));
  if (!wanted.size) continue;
  const block = app.match(new RegExp(`new ${ctor}\\(.*?\\n\\}\\);`, "s"));
  if (!block) { fail(`${ctor} is never constructed in app.js`); continue; }
  const given = new Set([...block[0].matchAll(/(on[A-Za-z]+)\s*:/g)].map((m) => m[1]));
  for (const cb of wanted) {
    if (!given.has(cb)) fail(`${ctor} reads opts.${cb}, app.js never passes it`);
  }
}

// ── every BARE call must resolve to something this module has ───────────────
const BUILTIN = new Set([
  "if", "for", "while", "switch", "catch", "return", "typeof", "function",
  "Math", "Number", "String", "Object", "Array", "JSON", "Set", "Map", "Promise",
  "parseFloat", "parseInt", "setTimeout", "setInterval", "clearTimeout",
  "clearInterval", "requestAnimationFrame", "cancelAnimationFrame",
  "requestIdleCallback", "cancelIdleCallback", "console", "document", "window",
  "localStorage", "indexedDB", "URL", "Blob", "File", "FileReader", "Image",
  "DataTransfer", "fetch", "await", "of", "in", "new", "Date", "performance",
  "navigator", "structuredClone", "alert", "confirm", "prompt", "super",
  "OffscreenCanvas", "ImageBitmap", "createImageBitmap", "PointerEvent",
  "async", "else", "case", "do", "try", "yield", "void", "delete", "throw",
  "constructor",
  "MouseEvent", "DragEvent", "Worker", "IntersectionObserver", "RegExp",
  "Uint8Array", "Error", "Boolean", "globalThis", "isNaN", "isFinite", "escape",
  "matchMedia", "MutationObserver", "URLSearchParams", "DragEvent", "ClipboardItem",
]);

/** Comments and string literals are not code. Without stripping them, every
 * prose word followed by "(" reads as a call — which is most of a well
 * commented file. */
function stripNonCode(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")       // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")     // line comments (not ://)
    .replace(/`(?:\\.|[^`\\])*`/g, "``")      // template literals
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")   // single-quoted
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');  // double-quoted
}

for (const file of readdirSync(src).filter((f) => f.endsWith(".js"))) {
  const code = stripNonCode(read(file));
  const defined = new Set([
    ...[...code.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
    ...[...code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]),
    ...[...code.matchAll(/class\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
    // parameters and destructured names, coarsely. `}` closes the set as well
    // as `,` and `)`, or the LAST name of a destructured parameter list —
    // `function f({ a, b, onError })` — reads as undefined and every call to it
    // is reported.
    ...[...code.matchAll(/[({,]\s*([A-Za-z_$][\w$]*)\s*(?=[,)=}])/g)].map((m) => m[1]),
    // class methods and getters, which are definitions and not calls
    ...[...code.matchAll(/^\s*(?:static\s+|async\s+|get\s+|set\s+|\*\s*)*([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/gm)]
      .map((m) => m[1]),
    // object-literal methods: `name(args) {`
    ...[...code.matchAll(/[,{]\s*(?:get\s+|set\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/g)]
      .map((m) => m[1]),
  ]);
  const imported = new Set();
  for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name) imported.add(name);
    }
  }
  for (const m of code.matchAll(/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)/g)) imported.add(m[1]);

  // bare calls only: not `x.foo(`, not `.foo(`
  for (const m of code.matchAll(/(^|[^.\w$])([a-z][\w$]{3,})\s*\(/gm)) {
    const name = m[2];
    if (BUILTIN.has(name) || defined.has(name) || imported.has(name)) continue;
    fail(`${file}: calls ${name}() which is neither defined nor imported`);
  }
}

// ── every element the code reaches for must EXIST in the page ───────────────
// A missing id throws on the line that touches it, which aborts module
// evaluation — so a mistyped or never-added element does not just break its own
// button, it stops everything after it from initialising at all.
// Each module is checked against the page that LOADS it, not against index.html
// for everything: the tour has its own page, and pooling the two ids together
// would let a demo id satisfy an app lookup that has nothing to serve it.
const PAGE_OF = { "demo.js": "demo.html" };
{
  const idsIn = (file) => new Set(
    [...readFileSync(join(src, "..", file), "utf8").matchAll(/\sid="([^"]+)"/g)]
      .map((m) => m[1]));
  const pages = new Map();
  for (const file of readdirSync(src).filter((f) => f.endsWith(".js"))) {
    // presenter.js reaches into a document it WRITES itself, not this page
    if (file === "presenter.js") continue;
    const page = PAGE_OF[file] || "index.html";
    if (!pages.has(page)) pages.set(page, idsIn(page));
    const present = pages.get(page);
    const code = readFileSync(join(src, file), "utf8");
    // `document.` specifically: a lookup on some OTHER document — the tour
    // reaching into the app in its frame — belongs to a page this check cannot
    // know, and guessing at it would fail correct code.
    for (const m of code.matchAll(/\bdocument\.getElementById\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
      if (!present.has(m[1])) fail(`${file}: getElementById("${m[1]}") — no such id in ${page}`);
    }
  }
}

// ── every BUTTON in the page must be reached by some module ─────────────────
// The other direction of the same failure: an element that exists, is painted,
// and that nothing ever listens to. A button moved between containers keeps its
// id and its handler — one rebuilt as a copy in its new home does not, and a
// menu of dead entries is exactly what this suite was written for.
{
  const html = readFileSync(join(src, "..", "index.html"), "utf8");
  const code = readdirSync(src).filter((f) => f.endsWith(".js"))
    .map((f) => read(f)).join("\n");
  for (const m of html.matchAll(/<button\b[^>]*\sid="([^"]+)"/g)) {
    const id = m[1];
    // reached by id or by selector — `getElementById("x")` or `querySelector("#x")`
    const forms = [`"${id}"`, `'${id}'`, `"#${id}"`, `'#${id}'`];
    if (!forms.some((f) => code.includes(f))) {
      fail(`index.html: <button id="${id}"> is never referenced by any module`);
    }
  }
}

if (failures) {
  console.error(`\n✗ ${failures} wiring problem(s).`);
  process.exit(1);
}
console.log("✓ wiring checks passed (callbacks supplied, bare calls resolve).");
