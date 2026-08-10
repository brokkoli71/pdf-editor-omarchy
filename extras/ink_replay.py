#!/usr/bin/env python3
"""Replay captured ink through the pipeline, to tune it on real handwriting.

Sidemark's ink constants were chosen against synthetic curves, which cannot
show what one hand on one digitiser actually produces. Capture a page of real
writing, then measure and re-render it here.

    SIDEMARK_CAPTURE_INK=/tmp/ink.jsonl sidemark --new     # write a page
    extras/ink_replay.py /tmp/ink.jsonl                    # what came out
    extras/ink_replay.py /tmp/ink.jsonl --png out.png      # see it
    extras/ink_replay.py /tmp/ink.jsonl --sweep smoothing  # compare settings
    extras/ink_replay.py /tmp/ink.jsonl --predict          # grade prediction

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
    report_rates(recs)
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


def truth_at(samples, t):
    """Where the pen actually was at time `t`, interpolated between reports.

    None past the end of the stroke — there is no ground truth for a guess
    about a pen that has already been lifted, and counting those as hits or
    misses would grade prediction on the one moment it cannot be wrong.
    """
    if t > samples[-1][2] or t < samples[0][2]:
        return None
    for a, b in zip(samples, samples[1:]):
        if a[2] <= t <= b[2]:
            span = b[2] - a[2]
            if span <= 0:
                return (a[0], a[1])
            f = (t - a[2]) / span
            return (a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)
    return None


def linear_point(window, lead_ms):
    """The straight-line guess, as the baseline the ARC has to beat."""
    if len(window) < 2 or lead_ms <= 0:
        return None
    (x0, y0, t0), (x1, y1, t1) = window[0], window[-1]
    span = t1 - t0
    if span <= 0:
        return None
    vx, vy = (x1 - x0) / span, (y1 - y0) / span
    return (x1 + vx * lead_ms, y1 + vy * lead_ms)


def predict_errors(recs, lead_ms, damped=True):
    """Grade prediction against what the pen went on to do.

    Walks each captured stroke sample by sample exactly as the live path does
    — the same PREDICT_WINDOW of history, the same EMA on the OFFSET — and
    compares three positions against the truth `lead_ms` later:

      lag     the last reported sample, i.e. what you see with no prediction.
              This is the error prediction exists to cancel, so it is the
              number every other one is a fraction OF.
      arc     what Sidemark draws (`predict_point`).
      linear  straight-line extrapolation, the thing the arc claims to beat.

    Returns per-sample error lists in the capture's own units.

    The honest caveat: the truth here is the DIGITISER's later report, so this
    measures how well the extrapolation guesses the pen's path — not how much
    lag the hand perceives, which includes the panel's own reporting delay and
    the compositor's. A prediction can score perfectly here and still feel
    late.
    """
    W = sm.PDFCanvas.PREDICT_WINDOW
    out = {"lag": [], "arc": [], "linear": [], "speed": [], "turn": []}
    for rec in recs:
        samples = [tuple(s) for s in rec.get("samples") or []]
        if len(samples) < W + 2 or rec.get("straight"):
            continue
        offset = None
        for i in range(len(samples)):
            window = samples[max(0, i - W + 1):i + 1]
            here = samples[i]
            truth = truth_at(samples, here[2] + lead_ms)
            if truth is None:
                continue
            raw = sm.predict_point(window, lead_ms)
            if raw is None:
                guess = (here[0], here[1])
            else:
                off = (raw[0] - here[0], raw[1] - here[1])
                if damped:
                    if offset is not None:
                        off = (offset[0] + (off[0] - offset[0]) * sm.PREDICT_SMOOTH,
                               offset[1] + (off[1] - offset[1]) * sm.PREDICT_SMOOTH)
                    offset = off
                guess = (here[0] + off[0], here[1] + off[1])
            lin = linear_point(window, lead_ms) or (here[0], here[1])
            out["lag"].append(math.dist((here[0], here[1]), truth))
            out["arc"].append(math.dist(guess, truth))
            out["linear"].append(math.dist(lin, truth))
            # how fast and how sharply the pen was turning right there, so the
            # error can be read against the cusps prediction is known to miss
            span = window[-1][2] - window[0][2]
            out["speed"].append(
                math.dist(window[0][:2], window[-1][:2]) / span if span else 0.0)
            out["turn"].append(turn_at(samples, i))
    return out


def turn_at(samples, i):
    """Heading change per unit length around sample i, in radians/unit — the
    curvature that decides whether an arc guess or a linear one is right."""
    if i < 1 or i + 1 >= len(samples):
        return 0.0
    a, b, c = samples[i - 1][:2], samples[i][:2], samples[i + 1][:2]
    d1, d2 = math.dist(a, b), math.dist(b, c)
    if d1 <= 0 or d2 <= 0:
        return 0.0
    h1 = math.atan2(b[1] - a[1], b[0] - a[0])
    h2 = math.atan2(c[1] - b[1], c[0] - b[0])
    d = (h2 - h1 + math.pi) % (2 * math.pi) - math.pi
    return abs(d) / ((d1 + d2) / 2)


def report_rates(recs):
    """How often each device actually reports — the number every constant in
    the pipeline secretly depends on.

    Spacing, smoothing radius and the prediction window are all "a few
    samples", so a device that reports at half the rate of another is a
    different instrument, and tuning them together tunes neither. This is the
    first thing to read in a capture: at a low enough rate the writing is
    undersampled, and then no filter and no predictor can recover what was
    never measured.
    """
    by_dev = {}
    for rec in recs:
        s = [tuple(x) for x in rec.get("samples") or []]
        if len(s) < 3:
            continue
        dts = [b[2] - a[2] for a, b in zip(s, s[1:])]
        by_dev.setdefault(rec.get("device") or "?", []).append(
            statistics.median(dts))
    if not by_dev:
        return
    print("  REPORT RATE (per stroke, median interval between samples)")
    for dev, dts in sorted(by_dev.items()):
        med = statistics.median(dts)
        print(f"    {dev:<8} {len(dts):>3} strokes   {med:>6.1f} ms "
              f"  ~{1000 / med:>3.0f} Hz   "
              f"(range {min(dts):.1f}..{max(dts):.1f})")
    print()


def report_prediction(recs, leads):
    timed = [r for r in recs if r.get("samples")]
    print(f"{len(timed)} of {len(recs)} strokes carry per-sample times\n")
    if not timed:
        print("  Nothing to measure. Timed capture is newer than this file —")
        print("  re-capture with SIDEMARK_CAPTURE_INK to grade prediction.")
        return
    report_rates(recs)
    print("  Error against where the pen actually went, per sample.")
    print("  'lag' is the no-prediction error — the thing being cancelled;")
    print("  recovered = how much of it the arc removes (negative = worse).\n")
    head = (f"  {'lead':>5} {'n':>6} {'lag p50':>8} {'arc p50':>8} "
            f"{'lin p50':>8} {'arc p90':>8} {'recovered':>10} {'worse':>7}")
    print(head)
    for lead in leads:
        e = predict_errors(recs, lead)
        if not e["lag"]:
            continue
        lag50 = statistics.median(e["lag"])
        arc50 = statistics.median(e["arc"])
        lin50 = statistics.median(e["linear"])
        arc90 = quantile(e["arc"], 0.9)
        worse = sum(1 for a, l in zip(e["arc"], e["lag"]) if a > l) / len(e["arc"])
        rec = (lag50 - arc50) / lag50 if lag50 else 0.0
        print(f"  {lead:>5.0f} {len(e['lag']):>6} {lag50:>8.2f} {arc50:>8.2f} "
              f"{lin50:>8.2f} {arc90:>8.2f} {rec:>9.1%} {worse:>7.1%}")

    # where it goes wrong: the sharpest turns are where an extrapolation of any
    # kind overshoots, and the flattest are where it should be free
    lead = leads[-1]
    e = predict_errors(recs, lead)
    if not e["turn"]:
        return
    print(f"\n  By curvature, at {lead:.0f} ms (quartiles of turn rate):\n")
    print(f"  {'turn':>18} {'n':>6} {'lag p50':>8} {'arc p50':>8} "
          f"{'lin p50':>8} {'recovered':>10}")
    order = sorted(range(len(e["turn"])), key=lambda i: e["turn"][i])
    for q in range(4):
        idx = order[q * len(order) // 4:(q + 1) * len(order) // 4]
        if not idx:
            continue
        lag50 = statistics.median([e["lag"][i] for i in idx])
        arc50 = statistics.median([e["arc"][i] for i in idx])
        lin50 = statistics.median([e["linear"][i] for i in idx])
        lo, hi = e["turn"][idx[0]], e["turn"][idx[-1]]
        rec = (lag50 - arc50) / lag50 if lag50 else 0.0
        print(f"  {lo:>7.3f}..{hi:<9.3f} {len(idx):>6} {lag50:>8.2f} "
              f"{arc50:>8.2f} {lin50:>8.2f} {rec:>9.1%}")


def quantile(vals, q):
    s = sorted(vals)
    return s[min(len(s) - 1, int(q * len(s)))]


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
    ap.add_argument("--predict", nargs="?", const="10,20,40,60,80", default=None,
                    metavar="MS,MS",
                    help="grade prediction against what the pen went on to do, "
                         "at these lead times (needs a timed capture)")
    ap.add_argument("--scale", type=float, default=2.0)
    args = ap.parse_args()

    recs = load(args.capture)
    if not recs:
        print("no strokes in that file")
        return 1
    if args.predict is not None:
        report_prediction(recs, [float(v) for v in args.predict.split(",")])
    elif args.sweep:
        sweep(recs, args.sweep)
    else:
        describe(recs)
    if args.png:
        render(recs, args.png, args.scale)
    return 0


if __name__ == "__main__":
    sys.exit(main())
