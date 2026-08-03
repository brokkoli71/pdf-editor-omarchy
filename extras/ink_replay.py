#!/usr/bin/env python3
"""Replay captured ink through the pipeline, to tune it on real handwriting.

Sidemark's ink constants were chosen against synthetic curves, which cannot
show what one hand on one digitiser actually produces. Capture a page of real
writing, then measure and re-render it here.

    SIDEMARK_CAPTURE_INK=/tmp/ink.jsonl sidemark --new     # write a page
    extras/ink_replay.py /tmp/ink.jsonl                    # what came out
    extras/ink_replay.py /tmp/ink.jsonl --png out.png      # see it
    extras/ink_replay.py /tmp/ink.jsonl --sweep smoothing  # compare settings

The capture holds RAW samples — exactly what the digitiser reported, before
any interpolation or smoothing — so a replay can try settings the strokes were
never drawn with.
"""
import argparse
import json
import math
import os
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("SIDEMARK_TEST", "1")   # import without starting a UI

import sidemark as sm  # noqa: E402


def load(path):
    out = []
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def arc_length(pts):
    return sum(math.dist(a, b) for a, b in zip(pts, pts[1:]))


def sample_stats(rec):
    """What the HARDWARE gave us — the numbers every tuning decision rests on."""
    pts = [tuple(p) for p in rec["pts"]]
    press = rec.get("press") or []
    steps = [math.dist(a, b) for a, b in zip(pts, pts[1:])]
    return {
        "n": len(pts),
        "arc": arc_length(pts),
        "feature": sm.ink_feature_size(pts),
        "step_median": statistics.median(steps) if steps else 0.0,
        "press_min": min(press) if press else None,
        "press_max": max(press) if press else None,
    }


def describe(recs):
    print(f"{len(recs)} strokes captured\n")
    rows = [sample_stats(r) for r in recs]
    def col(key):
        vals = [r[key] for r in rows if r[key] is not None]
        return vals or [0.0]

    print("  RAW SAMPLES (what the digitiser gave)")
    print(f"    points per stroke   median {statistics.median(col('n')):.0f}"
          f"   range {min(col('n')):.0f}..{max(col('n')):.0f}")
    print(f"    sample spacing      median {statistics.median(col('step_median')):.2f} units")
    print(f"    stroke arc length   median {statistics.median(col('arc')):.1f} units")
    print(f"    feature size        median {statistics.median(col('feature')):.1f} units")
    have_press = [r for r in rows if r["press_min"] is not None]
    if have_press:
        print(f"    pressure            {min(col('press_min')):.2f}..{max(col('press_max')):.2f}")
    else:
        print("    pressure            none reported (mouse, or no pressure axis)")

    # The key ratio: a sample spacing that is a large share of the feature size
    # means the hardware is undersampling the writing, and interpolation is
    # doing most of the work. A small share means the pen is oversampling and
    # denoising matters more than filling gaps.
    ratios = [r["step_median"] / r["feature"] for r in rows if r["feature"] > 0]
    if ratios:
        med = statistics.median(ratios)
        print(f"\n  sample spacing / feature size: {med:.3f}")
        if med > 0.25:
            print("    -> UNDERSAMPLED. Few samples per letter: interpolation is")
            print("       carrying the result, and writing bigger would help most.")
        elif med < 0.06:
            print("    -> oversampled. Plenty of samples per letter: any remaining")
            print("       roughness is tremor/digitiser noise, so denoising is the lever.")
        else:
            print("    -> reasonable sampling for the size being written.")

    print("\n  AFTER THE PIPELINE")
    grew = shrank = 0
    for rec in recs:
        pts = [tuple(p) for p in rec["pts"]]
        if len(pts) < 3:
            continue
        out, _ = sm.finish_ink_stroke(pts, rec.get("press"),
                                      rec.get("smoothing", 0.5))
        before, after = arc_length(pts), arc_length(out)
        if before > 0:
            (grew, shrank) = ((grew + 1, shrank) if after > before
                              else (grew, shrank + 1))
    print(f"    strokes that got longer/shorter: {grew}/{shrank}")


def sweep(recs, what):
    """How a setting changes the result, measured on the real strokes."""
    values = {
        "smoothing": [0.0, 0.25, 0.5, 0.75, 1.0],
        "spacing": [0.12, 0.25, 0.5, 1.0, 2.0],
    }[what]
    print(f"sweeping {what}\n")
    print(f"  {what:>10} {'mean pts':>9} {'mean arc':>9} {'vs raw':>8}")
    for v in values:
        pts_n, arcs, ratios = [], [], []
        for rec in recs:
            pts = [tuple(p) for p in rec["pts"]]
            if len(pts) < 3:
                continue
            kw = ({"strength": v} if what == "smoothing"
                  else {"strength": rec.get("smoothing", 0.5), "spacing": v})
            out, _ = sm.finish_ink_stroke(pts, rec.get("press"), **kw)
            pts_n.append(len(out))
            arcs.append(arc_length(out))
            raw = arc_length(pts)
            if raw > 0:
                ratios.append(arc_length(out) / raw)
        if pts_n:
            print(f"  {v:>10.2f} {statistics.mean(pts_n):>9.0f} "
                  f"{statistics.mean(arcs):>9.1f} "
                  f"{statistics.mean(ratios):>7.1%}")


def render(recs, path, scale=2.0, pad=20.0):
    """Draw the replayed strokes exactly as Sidemark would paint them."""
    import cairo
    xs = [p[0] for r in recs for p in r["pts"]]
    ys = [p[1] for r in recs for p in r["pts"]]
    if not xs:
        print("nothing to draw")
        return
    x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
    w = int((x1 - x0 + 2 * pad) * scale)
    h = int((y1 - y0 + 2 * pad) * scale)
    surf = cairo.ImageSurface(cairo.FORMAT_ARGB32, max(w, 1), max(h, 1))
    ctx = cairo.Context(surf)
    ctx.set_source_rgb(1, 1, 1)
    ctx.paint()
    ctx.scale(scale, scale)
    ctx.translate(-x0 + pad, -y0 + pad)
    ctx.set_line_cap(cairo.LINE_CAP_ROUND)
    ctx.set_line_join(cairo.LINE_JOIN_ROUND)
    ctx.set_source_rgb(0.05, 0.05, 0.8)
    for rec in recs:
        pts = [tuple(p) for p in rec["pts"]]
        out, prof = sm.finish_ink_stroke(pts, rec.get("press"),
                                         rec.get("smoothing", 0.5))
        sm.draw_ink_stroke(ctx, out, 2.0, prof)
    surf.write_to_png(path)
    print(f"wrote {path} ({w}x{h})")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("capture", help="the .jsonl written by SIDEMARK_CAPTURE_INK")
    ap.add_argument("--png", help="render the replayed strokes to this file")
    ap.add_argument("--sweep", choices=("smoothing", "spacing"),
                    help="compare a setting across the captured strokes")
    ap.add_argument("--scale", type=float, default=2.0)
    args = ap.parse_args()

    recs = load(args.capture)
    if not recs:
        print("no strokes in that file")
        return 1
    if args.sweep:
        sweep(recs, args.sweep)
    else:
        describe(recs)
    if args.png:
        render(recs, args.png, args.scale)
    return 0


if __name__ == "__main__":
    sys.exit(main())
