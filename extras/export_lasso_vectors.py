#!/usr/bin/env /usr/bin/python3
"""Dump the lasso's shared geometry policy as JSON conformance vectors.

The handle points, their anchors and the scale factors are ONE policy behind
both the hit-test and the painter — a handle has to be grabbed exactly where it
is drawn, and the chip and the delete cross have to sit where the hand expects
after a hundred repetitions. That makes them worth pinning across the port.

    extras/export_lasso_vectors.py > web/test/lasso-vectors.json
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("SIDEMARK_TEST", "1")

import sidemark as S  # noqa: E402

BOXES = [(10.0, 20.0, 110.0, 80.0), (0.0, 0.0, 50.0, 50.0),
         (-30.5, 12.25, 4.5, 90.75)]
PAD = 8.0


def main():
    out = {"pad": PAD, "chip_size": S.LASSO_CHIP_SIZE,
           "chip_gap": S.LASSO_CHIP_GAP, "boxes": []}
    for box in BOXES:
        x0, y0, x1, y1 = box
        entry = {
            "box": list(box),
            "handles": [list(p) for p in S.lasso_handle_points(x0, y0, x1, y1, PAD)],
            "anchors": [],
            "chip": list(S.lasso_chip_centre(x0, y0, PAD)),
            "delete": list(S.lasso_delete_centre(x0, y0, PAD)),
            "cursors": [S.lasso_handle_cursor(h) for h in range(8)],
            "scales": [],
        }
        for h in range(8):
            mode, anchor = S.lasso_handle_anchor(h, box)
            entry["anchors"].append({"handle": h, "mode": mode,
                                     "anchor": list(anchor)})
            start = S.lasso_handle_points(x0, y0, x1, y1, PAD)[h]
            for cur in ((start[0] + 20, start[1] + 12), (start[0] - 40, start[1] - 5),
                        anchor):
                fx, fy = S.lasso_scale_factors(mode, anchor, start, cur)
                entry["scales"].append({"handle": h, "cur": list(cur),
                                        "fx": round(fx, 9), "fy": round(fy, 9)})
        out["boxes"].append(entry)
    # the polygon test, which is the GRAB region in loop mode
    poly = [(0, 0), (10, 0), (10, 10), (5, 4), (0, 10)]
    out["polygon"] = {"poly": [list(p) for p in poly],
                      "points": [{"p": [p[0], p[1]],
                                  "inside": S.PDFCanvas._point_in_polygon(p[0], p[1], poly)}
                                 for p in [(5, 1), (5, 8), (1, 9), (-1, 5), (9, 9),
                                           (10, 5), (5, 3.9), (5, 4.1)]]}
    json.dump(out, sys.stdout, indent=1)


if __name__ == "__main__":
    main()
