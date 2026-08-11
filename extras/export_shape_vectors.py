#!/usr/bin/env /usr/bin/python3
"""Dump the shape recogniser as JSON conformance vectors.

The classifier decides between a rectangle, an ellipse, a polygon and a line by
comparing residuals that are deliberately computed over the SAME points, plus
one rule that is NOT about residuals at all (a four-cornered quad square to the
page is a rectangle, however well a tilted quad fits). Getting the tie-breaks
wrong is invisible until a hand-drawn box stops snapping to a rectangle and
quietly takes the grid divider with it — so the port is checked, not read.

    extras/export_shape_vectors.py > web/test/shape-vectors.json
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("SIDEMARK_TEST", "1")

import sidemark as S  # noqa: E402


def wobble(i, amp=1.0):
    """Deterministic pseudo-noise, so both sides see identical input."""
    return amp * math.sin(i * 2.399) * math.cos(i * 1.117)


def circle(n=40, r=50.0, cx=100.0, cy=100.0, amp=0.0, close=True):
    pts = [(cx + r * math.cos(2 * math.pi * i / n) + wobble(i, amp),
            cy + r * math.sin(2 * math.pi * i / n) + wobble(i + 7, amp))
           for i in range(n + (1 if close else 0))]
    return pts


def oval(n=40, rx=80.0, ry=30.0):
    return [(100 + rx * math.cos(2 * math.pi * i / n),
             100 + ry * math.sin(2 * math.pi * i / n)) for i in range(n + 1)]


def box(w=100.0, h=60.0, amp=0.0, per=12):
    corners = [(0, 0), (w, 0), (w, h), (0, h), (0, 0)]
    pts = []
    for k in range(4):
        ax, ay = corners[k]
        bx, by = corners[k + 1]
        for i in range(per):
            t = i / per
            pts.append((ax + (bx - ax) * t + wobble(len(pts), amp),
                        ay + (by - ay) * t + wobble(len(pts) + 3, amp)))
    pts.append(corners[0])
    return pts


def tilted_quad(amp=0.0):
    corners = [(0, 0), (100, 25), (75, 90), (-20, 60), (0, 0)]
    pts = []
    for k in range(4):
        ax, ay = corners[k]
        bx, by = corners[k + 1]
        for i in range(10):
            t = i / 10
            pts.append((ax + (bx - ax) * t + wobble(len(pts), amp),
                        ay + (by - ay) * t + wobble(len(pts) + 5, amp)))
    pts.append(corners[0])
    return pts


def triangle():
    corners = [(0, 0), (100, 10), (50, 90), (0, 0)]
    pts = []
    for k in range(3):
        ax, ay = corners[k]
        bx, by = corners[k + 1]
        for i in range(12):
            t = i / 12
            pts.append((ax + (bx - ax) * t, ay + (by - ay) * t))
    pts.append(corners[0])
    return pts


def straight(n=20, bow=0.0):
    return [(i * 5.0, bow * math.sin(math.pi * i / n)) for i in range(n + 1)]


def elbow():
    return ([(i * 4.0, 0.0) for i in range(15)]
            + [(56.0, i * 4.0) for i in range(1, 15)])


CASES = {
    "circle-clean": circle(),
    "circle-wobbly": circle(amp=2.5),
    "oval": oval(),
    "box-clean": box(),
    "box-wobbly": box(amp=2.0),
    "tilted-quad": tilted_quad(),
    "triangle": triangle(),
    "straight-line": straight(),
    "bowed-line": straight(bow=6.0),
    "elbow": elbow(),
    "two-points": [(0.0, 0.0), (10.0, 5.0)],
    "single-point": [(3.0, 4.0)],
    "open-arc": circle(n=20, close=False)[:12],
}


def r(v, n=12):
    if isinstance(v, (list, tuple)):
        return [r(x, n) for x in v]
    return round(v, n)


def main():
    out = {"constants": {"POLYGON_MAX_CORNERS": S.POLYGON_MAX_CORNERS,
                         "CIRCLE_TOLERANCE": S.CIRCLE_TOLERANCE,
                         "LASSO_CLICK_SLOP_PX": S.LASSO_CLICK_SLOP_PX},
           "cases": []}
    for name, pts in CASES.items():
        # Round FIRST, then compute: the vectors carry the rounded points, so
        # everything derived from them must be derived from exactly those. A
        # sub-ulp difference in the input is invisible until it flips a discrete
        # decision — here, which point RDP calls the corner on a near-tie.
        pts = [tuple(p) for p in r(pts)]
        kind, new = S.recognize_shape(pts)
        entry = {
            "name": name,
            "pts": r(pts),
            "closed": S.polyline_is_closed(pts),
            "kind": kind,
            "shape": r(new),
            "polygon_corners": r(S.polygon_corners(pts)),
            "open_path_corners": r(S.open_path_corners(pts)),
            "rect_bbox": r(S.rect_bbox_of(pts)) if S.rect_bbox_of(pts) else None,
            "simplified": r(S.simplify_polyline(pts, 2.0)),
        }
        corners = S.polygon_corners(pts)
        entry["axis_aligned"] = (S.quad_is_axis_aligned(corners)
                                 if len(corners) == 4 else None)
        out["cases"].append(entry)
    out["dividers"] = {
        "3 across 0..100": r(S.even_divider_positions(0.0, 100.0, 3)),
        "1 across 10..20": r(S.even_divider_positions(10.0, 20.0, 1)),
        "5 across -5..5": r(S.even_divider_positions(-5.0, 5.0, 5)),
    }
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
