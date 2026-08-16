// Check the notes sidecar port against vectors generated from sidemark.py.
//
// The sidecar is a file the desktop app also reads and writes, so "close
// enough" is not a passing grade: the text written back must be byte-identical,
// and every marker must survive a round trip through a UI that does not yet
// expose it.
//
//   extras/export_notes_vectors.py > web/test/notes-vectors.json
//   node web/test/notes.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseNoteSections, NotesModel, noteOffsetForPage, notePageAtOffset }
  from "../src/notes-model.js";

const here = dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(readFileSync(join(here, "notes-vectors.json"), "utf8"));

let checks = 0, failures = 0;
function check(name, got, want) {
  checks++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) {
    failures++;
    console.error(`  ✗ ${name}\n      got  ${g}\n      want ${w}`);
  }
}

for (const [name, want] of Object.entries(V)) {
  const parsed = parseNoteSections(want.raw);

  check(`${name}/sections`,
    Object.fromEntries(Object.entries(parsed.sections).map(([k, v]) => [String(k), v])),
    want.sections);
  check(`${name}/linked`, [...parsed.linked].sort((a, b) => a - b), want.linked);
  check(`${name}/hadMarkers`, parsed.hadMarkers, want.had_markers);
  check(`${name}/bookmarks`,
    Object.fromEntries(Object.entries(parsed.bookmarks).map(([k, v]) => [String(k), v])),
    want.bookmarks);
  check(`${name}/hidden`, [...parsed.hidden].sort((a, b) => a - b), want.hidden);

  const model = new NotesModel();
  model.setFromText(want.raw);
  // the round trip is the load-bearing one: what we write must be what the
  // desktop app would have written
  check(`${name}/toText`, model.toText(), want.to_text);
  check(`${name}/hasContent`, model.hasContent(), want.has_content);

  for (const [page, text] of Object.entries(want.get)) {
    check(`${name}/get(${page})`, model.get(Number(page)), text);
  }
  for (const [page, text] of Object.entries(want.own_text)) {
    check(`${name}/ownText(${page})`, model.ownText(Number(page)), text);
  }
  for (const [page, start] of Object.entries(want.run_start)) {
    check(`${name}/runStart(${page})`, model.runStart(Number(page)), start);
  }

  // The page ↔ offset table the caret crosses the divider on (row 162). Both
  // directions, at every marker boundary — an off-by-one here does not fail
  // loudly, it lands you on the neighbouring page.
  for (const [page, off] of Object.entries(want.offset_for_page)) {
    check(`${name}/offsetForPage(${page})`,
          noteOffsetForPage(want.raw, Number(page)), off);
  }
  for (const [off, page] of Object.entries(want.page_at_offset)) {
    check(`${name}/pageAtOffset(${off})`,
          notePageAtOffset(want.raw, Number(off)), page);
  }

  // writing the text back out and re-reading it must be a fixed point — a
  // format that drifts on each save corrupts a file a little at a time
  const again = new NotesModel();
  again.setFromText(model.toText());
  check(`${name}/round-trip is stable`, again.toText(), model.toText());
}

if (failures) {
  console.error(`\n✗ ${failures} of ${checks} notes checks failed.`);
  process.exit(1);
}
console.log(`✓ ${checks} notes checks passed over ${Object.keys(V).length} sidecar shapes.`);
