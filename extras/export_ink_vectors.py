#!/usr/bin/env /usr/bin/python3
"""Dump the ink pipeline's behaviour as JSON conformance vectors.

The web port (`web/src/ink.js`) is a hand translation of geometry that was
tuned by measurement, not by taste — and the traps in it (the midpoint
Laplacian, the dot's flattened profile, the asymmetric smear trim) all pass a
casual eye and some of them pass a circle test while broken. So the port is not
checked by reading it: it is checked by running BOTH implementations over the
same inputs and comparing numbers.

The inputs are the REAL captured strokes in notes/*.jsonl wherever there are
any — the same hand and the same digitiser the constants were tuned against —
plus synthetic cases for the shapes a capture happens not to contain (a
two-sample flick, a straight line, an exact circle).

    extras/export_ink_vectors.py > web/test/vectors.json
    node web/test/conformance.mjs
"""

import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("SIDEMARK_TEST", "1")

import sidemark as S  # noqa: E402


def _load_captures(limit=24):
    """Real strokes, if any were ever captured. Each record's `pts` are document
    units and `press` the matching raw pressures."""
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = []
    notes = os.path.join(here, "notes")
    for name in sorted(os.listdir(notes)) if os.path.isdir(notes) else []:
        if not name.endswith(".jsonl"):
            continue
        with open(os.path.join(notes, name)) as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                pts = [tuple(p) for p in rec.get("pts") or []]
                if len(pts) < 2:
                    continue
                out.append({
                    "name": f"{name}#{len(out)}",
                    "pts": pts,
                    "press": list(rec.get("press") or []),
                })
                if len(out) >= limit:
                    return out
    return out


def _synthetic():
    """The shapes a capture happens not to contain."""
    cases = []

    # a fast "o": few samples round a circle, the case Taubin exists for
    circle = [(50 + 20 * math.cos(a), 50 + 20 * math.sin(a))
              for a in [i * 2 * math.pi / 12 for i in range(13)]]
    cases.append({"name": "circle-12", "pts": circle, "press": [0.6] * 13})

    # a smooth arc plus per-sample noise — the RIGHT way to test denoising (a
    # zigzag is a long-wavelength shape once resampled, not jitter)
    arc = []
    press = []
    for i in range(60):
        t = i / 59
        a = math.pi * t
        j = 0.35 * math.sin(i * 2.7)          # deterministic "tremor"
        arc.append((40 + 30 * math.cos(a) + j, 60 + 30 * math.sin(a) - j))
        press.append(0.25 + 0.5 * math.sin(math.pi * t))
    cases.append({"name": "noisy-arc", "pts": arc, "press": press})

    # a dot: a tap whose last sample reads ~0 because the pen is leaving
    cases.append({"name": "dot-3", "pts": [(10, 10), (10.3, 10.2), (10.4, 10.3)],
                  "press": [0.5, 0.62, 0.03]})
    # the same tap with two samples — the too-short-to-resample branch, which
    # must paint the SAME size (row 144)
    cases.append({"name": "dot-2", "pts": [(10, 10), (10.4, 10.3)],
                  "press": [0.5, 0.03]})
    # a straight line, and one long enough for a real taper
    cases.append({"name": "line", "pts": [(0, 0), (40, 0), (80, 0)],
                  "press": [0.4, 0.9, 0.35]})
    # a light tail that the smear trim should cut
    cases.append({"name": "smear-tail",
                  "pts": [(0, 0), (10, 2), (20, 3), (30, 3.5), (36, 3.6), (40, 3.7)],
                  "press": [0.55, 0.7, 0.65, 0.12, 0.05, 0.02]})
    # no pressure at all — a mouse stroke, which must still taper
    cases.append({"name": "mouse", "pts": [(0, 0), (15, 8), (30, 4), (45, 12)],
                  "press": []})
    # small writing, which is what adaptive spacing exists for
    cases.append({"name": "small",
                  "pts": [(0, 0), (0.8, 1.4), (1.9, 0.9), (2.6, 2.1), (3.4, 1.0)],
                  "press": [0.4, 0.5, 0.45, 0.5, 0.3]})
    return cases


def _round(v, n=12):
    if isinstance(v, (list, tuple)):
        return [_round(x, n) for x in v]
    return round(v, n)


def main():
    strokes = _load_captures() + _synthetic()
    vectors = {"strokes": [], "scalars": {}}

    for case in strokes:
        # Round FIRST, then compute. The vectors carry rounded points, so every
        # expected output must be derived from exactly those — otherwise a
        # sub-ulp difference in the input shows up as a divergence in the port,
        # and the port gets blamed for the exporter's rounding.
        pts = [tuple(p) for p in _round([(float(x), float(y)) for x, y in case["pts"]])]
        press = _round([float(p) for p in case["press"]])
        trip = [(x, y, press[i] if i < len(press) else 1.0)
                for i, (x, y) in enumerate(pts)]
        spacing = S.adaptive_spacing(pts)

        entry = {
            "name": case["name"],
            "pts": _round(pts),
            "press": _round(press),
            "feature_size": _round(S.ink_feature_size(pts)),
            "spacing": _round(spacing),
            "resampled": _round(S.resample_ink(trip, spacing)),
            "smoothed": _round(S.taubin_smooth(S.resample_ink(trip, spacing), 0.5)),
            "profile": _round(S.width_profile(pts, press or None)),
            "trimmed": _round(S.trim_light_tail(pts, press, 0.15)[0]),
        }
        # the whole commit pipeline, at three smoothing settings and both flags
        for label, kwargs in (
            ("commit_0", {"strength": 0.0}),
            ("commit_50", {"strength": 0.5}),
            ("commit_100", {"strength": 1.0}),
            ("commit_flat", {"strength": 0.5, "flat": True}),
            ("commit_smear", {"strength": 0.5, "min_pressure": 0.15}),
        ):
            strength = kwargs.pop("strength")
            out_pts, prof = S.finish_ink_stroke(list(pts), list(press), strength,
                                                **kwargs)
            entry[label] = {"pts": _round(out_pts),
                            "profile": _round(prof) if prof else None}
        live_pts, live_prof = S.live_ink_stroke(list(pts), list(press), 0.5)
        entry["live_50"] = {"pts": _round(live_pts),
                            "profile": _round(live_prof) if live_prof else None}
        vectors["strokes"].append(entry)

    vectors["scalars"] = {
        "dot_boost": {str(v): _round(S.dot_boost(v))
                      for v in (0.0, 1.0, 2.5, 4.9, 5.0, 9.0)},
        "erase_radius": {str(v): _round(S.erase_radius(v))
                         for v in (0.3, 2.0, 12.0, 24.0)},
        "hover_lead_in": _round(S.hover_lead_in(
            [(0.0, 0.0, 0.0), (5.0, 1.0, 20.0), (9.0, 2.0, 40.0),
             (60.0, 40.0, 55.0), (12.0, 3.0, 60.0)],
            13.0, 4.0, 80.0)),
    }
    vectors["constants"] = {
        k: getattr(S, k) for k in (
            "INK_RESAMPLE_SPACING", "INK_SPACING_FRAC", "INK_SPACING_MIN",
            "INK_SPACING_MAX", "INK_MAX_POINTS", "INK_SMOOTH_PAIRS",
            "TAUBIN_MU_RATIO", "INK_PRESS_FLOOR", "INK_PRESS_GAMMA",
            "INK_TAPER_LEN", "INK_TAPER_FRAC", "INK_TAPER_MIN", "INK_DOT_LEN",
            "INK_DOT_BOOST", "LIVE_SMOOTH_MAX_PTS", "HOVER_LEAD_MS",
            "HOVER_LEAD_MAX_STEP", "ERASE_SLACK_PX", "HOVER_TRAIL_MS",
        )
    }
    json.dump(vectors, sys.stdout)


if __name__ == "__main__":
    main()
