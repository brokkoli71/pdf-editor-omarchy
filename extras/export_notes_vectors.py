#!/usr/bin/env /usr/bin/python3
"""Dump the notes sidecar format as JSON conformance vectors.

The `.md` sidecar is a real file shared with the desktop app, so the browser
port must parse and write byte-identical text — including the markers it does
not yet have a UI for. A reader that silently dropped a `continued` or
`bookmark` marker would quietly damage a file Sidemark wrote, and the damage
would only show up later, as a run that had re-split itself.

    extras/export_notes_vectors.py > web/test/notes-vectors.json
    node web/test/notes.mjs
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("SIDEMARK_TEST", "1")

import sidemark as S  # noqa: E402


CASES = {
    "empty": "",
    "no-markers": "Just a hand-written note.\n\nSecond paragraph.",
    "embed-only": "![[lecture.pdf]]\n\nA note with no page markers.",
    "one-page": "<!-- page:0 -->\n\nFirst page notes.\n",
    "several-pages": (
        "![[lecture.pdf]]\n\n"
        "<!-- page:0 -->\n\nIntro notes.\n\n"
        "<!-- page:3 -->\n\nEigenvalues.\n\nSecond paragraph here.\n"
    ),
    "linked-run": (
        "<!-- page:2 -->\n\nA run's body.\n\n"
        "<!-- page:3 continued -->\n\n"
        "<!-- page:4 continued -->\n"
    ),
    "linked-range": "<!-- page:5 -->\n\nBody.\n\n<!-- page:6-40 continued -->\n",
    "bookmark": '<!-- page:7 bookmark="Eigenvalues" -->\n\nNotes here.\n',
    "bookmark-unnamed": "<!-- page:8 bookmark -->\n",
    "hidden-range": "<!-- page:10-14 hidden -->\n",
    "composed": (
        '<!-- page:12 continued hidden bookmark="Odd &amp; ends" -->\n'
    ),
    # a hand-edited file that breaks the invariant: page 0 cannot continue
    # anything, and a continued page must hold no body of its own
    "hand-edited": (
        "<!-- page:0 continued -->\n\nOrphan body.\n\n"
        "<!-- page:1 -->\n\nReal body.\n\n"
        "<!-- page:2 continued -->\n\nText that must be absorbed.\n"
    ),
}


def main():
    out = {}
    for name, raw in CASES.items():
        parsed = S.parse_note_sections(raw)
        model = S.NotesModel()
        model.set_from_text(raw)
        pages = sorted(set(parsed.sections) | set(parsed.linked)
                       | set(parsed.bookmarks) | set(parsed.hidden) | {0})
        out[name] = {
            "raw": raw,
            "sections": {str(k): v for k, v in parsed.sections.items()},
            "linked": sorted(parsed.linked),
            "had_markers": parsed.had_markers,
            "bookmarks": {str(k): v for k, v in parsed.bookmarks.items()},
            "hidden": sorted(parsed.hidden),
            # the round trip: what the model writes back out
            "to_text": model.to_text(),
            "has_content": model.has_content(),
            # resolved vs stored, per page — the distinction a run turns on
            "get": {str(p): model.get(p) for p in pages},
            "own_text": {str(p): model.own_text(p) for p in pages},
            "run_start": {str(p): model.run_start(p) for p in pages},
        }
    json.dump(out, sys.stdout, indent=1)


if __name__ == "__main__":
    main()
