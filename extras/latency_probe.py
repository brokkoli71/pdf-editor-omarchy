#!/usr/bin/env python3
"""Measure the pen's end-to-end latency by chasing a moving dot (row 147).

A dot sweeps back and forth at a known speed. You keep the pen tip ON it. The
dot's position is known for every frame and the pen's for every sample, so the
time offset that best aligns the two curves is how far behind the pen's ink
lands — the whole loop, in milliseconds.

    extras/latency_probe.py                 # 20 s, then the number
    extras/latency_probe.py --seconds 30 --period 2.0
    extras/latency_probe.py --selftest      # check the fit, no hardware

WHAT IT MEASURES, and the honest limits:

  pen -> app -> compositor -> panel -> your eye -> your hand -> pen

is one loop and this measures ALL of it. It cannot tell the display half from
the input half. Your own tracking is inside the number too, and because the
sweep is PREDICTABLE people anticipate it — so the result is closer to a lower
bound on the machine than an upper one.

Which is why the number to trust is a DIFFERENCE. Run it twice, changing one
thing (prediction on/off, a compositor setting, another machine): the human
term is roughly constant between runs, so the delta is real even when the
absolute is soft. A single reading in isolation says much less.

Deliberately standalone: it imports nothing from sidemark, so it measures the
platform rather than this app, and can be pointed at a different toolkit or
machine for comparison.
"""
import argparse
import math
import statistics
import sys

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
from gi.repository import Gdk, GLib, Gtk  # noqa: E402

# The sweep is a SINE, not a triangle: a triangle's velocity flips instantly at
# each end, which no hand can follow, and the tracking error there would swamp
# the lag being measured. A sine is smooth everywhere and its phase offset is
# exactly what the fit is looking for.
MAX_LAG_MS = 200.0
LAG_STEP_MS = 1.0


def best_lag(dots, pens, max_lag=MAX_LAG_MS, step=LAG_STEP_MS):
    """The delay that best explains the pen curve as a copy of the dot curve.

    `dots` is [(t_ms, x)] as DRAWN, `pens` is [(t_ms, x)] as REPORTED. Returns
    (lag_ms, normalised residual). The residual matters as much as the lag: a
    good fit means the hand really was tracking, and a poor one means the run
    should be thrown away rather than believed.
    """
    if len(dots) < 8 or len(pens) < 8:
        return None, None
    d_t = [t for t, _ in dots]
    d_x = [x for _, x in dots]

    def dot_at(t):
        if t <= d_t[0] or t >= d_t[-1]:
            return None
        lo, hi = 0, len(d_t) - 1
        while hi - lo > 1:                      # the dot log is long; bisect
            mid = (lo + hi) // 2
            if d_t[mid] <= t:
                lo = mid
            else:
                hi = mid
        span = d_t[hi] - d_t[lo]
        if span <= 0:
            return d_x[lo]
        f = (t - d_t[lo]) / span
        return d_x[lo] + (d_x[hi] - d_x[lo]) * f

    spread = statistics.pstdev([x for _, x in pens]) or 1.0
    best = (None, None)
    lag = 0.0
    while lag <= max_lag:
        errs = []
        for t, px in pens:
            dx = dot_at(t - lag)
            if dx is not None:
                errs.append((px - dx) ** 2)
        if len(errs) >= 8:
            rms = math.sqrt(statistics.fmean(errs)) / spread
            if best[1] is None or rms < best[1]:
                best = (lag, rms)
        lag += step
    return best


def _selftest():
    """Feed the fit a known lag — the maths must be checked without hardware,
    since a wrong answer here looks exactly like a fast machine."""
    ok = True
    for truth in (0.0, 17.0, 45.0, 90.0):
        dots = [(t * 4.0, 300 * math.sin(2 * math.pi * t * 4.0 / 1500.0))
                for t in range(600)]
        pens = [(t * 8.0, 300 * math.sin(2 * math.pi * (t * 8.0 - truth) / 1500.0))
                for t in range(40, 280)]
        lag, rms = best_lag(dots, pens)
        good = lag is not None and abs(lag - truth) <= 2.0 and rms < 0.02
        ok &= good
        print(f"  true {truth:>5.0f} ms -> fitted {lag:>5.1f} ms  "
              f"(residual {rms:.4f})  {'ok' if good else 'FAILED'}")
    # and a hand that was NOT tracking must be reported as a bad fit, not as a
    # confident number
    dots = [(t * 4.0, 300 * math.sin(2 * math.pi * t * 4.0 / 1500.0))
            for t in range(600)]
    pens = [(t * 8.0, 300 * math.sin(t * 0.7)) for t in range(40, 280)]
    _lag, rms = best_lag(dots, pens)
    noise_ok = rms > 0.2
    ok &= noise_ok
    print(f"  not tracking      -> residual {rms:.3f}  "
          f"{'ok (rejected)' if noise_ok else 'FAILED (looked like a fit)'}")
    return 0 if ok else 1


class Probe(Gtk.ApplicationWindow):
    def __init__(self, app, seconds, period, amplitude):
        super().__init__(application=app, title="Sidemark latency probe")
        self.set_default_size(1000, 400)
        self._seconds, self._period, self._amp = seconds, period, amplitude
        self._dots, self._pens = [], []
        self._t0 = None
        self._done = False
        self._dot_x = 0.0

        self._area = Gtk.DrawingArea()
        self._area.set_draw_func(self._draw)
        self.set_child(self._area)

        # motion only — the tip must be DOWN, so this is the same event path a
        # stroke takes, not a hover
        motion = Gtk.EventControllerMotion()
        motion.connect("motion", self._on_motion)
        self._area.add_controller(motion)
        drag = Gtk.GestureDrag()
        drag.connect("drag-update", self._on_drag)
        self._area.add_controller(drag)

        self._area.add_tick_callback(self._tick)

    def _now(self):
        return GLib.get_monotonic_time() / 1000.0

    def _tick(self, _widget, _clock):
        now = self._now()
        if self._t0 is None:
            self._t0 = now
        t = now - self._t0
        if t >= self._seconds:
            self._done = True
            self.close()
            return GLib.SOURCE_REMOVE
        w = self._area.get_width() or 1000
        centre = w / 2.0
        amp = min(self._amp, centre - 40)
        self._dot_x = centre + amp * math.sin(2 * math.pi * t / self._period)
        # logged at the time it is HANDED to the compositor, which is the only
        # timestamp we have any right to
        self._dots.append((now, self._dot_x))
        self._area.queue_draw()
        return GLib.SOURCE_CONTINUE

    def _record(self, x):
        if self._t0 is not None:
            self._pens.append((self._now(), float(x)))

    def _on_motion(self, _c, x, _y):
        self._record(x)

    def _on_drag(self, gesture, ox, _oy):
        ok, sx, _sy = gesture.get_start_point()
        if ok:
            self._record(sx + ox)

    def _draw(self, _area, ctx, width, height):
        ctx.set_source_rgb(0.08, 0.08, 0.10)
        ctx.paint()
        y = height / 2.0
        ctx.set_source_rgb(0.25, 0.25, 0.30)
        ctx.set_line_width(1)
        ctx.move_to(0, y)
        ctx.line_to(width, y)
        ctx.stroke()
        ctx.set_source_rgb(0.95, 0.75, 0.15)
        ctx.arc(self._dot_x, y, 14, 0, 2 * math.pi)
        ctx.fill()
        ctx.set_source_rgb(0.6, 0.6, 0.65)
        ctx.move_to(16, 26)
        ctx.show_text("keep the PEN TIP on the dot — press down, don't hover")
        ctx.new_path()


def main():
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seconds", type=float, default=20.0)
    ap.add_argument("--period", type=float, default=1.6,
                    help="seconds per full sweep (default 1.6)")
    ap.add_argument("--amplitude", type=float, default=380.0)
    ap.add_argument("--selftest", action="store_true",
                    help="check the fit against known lags, no hardware")
    args = ap.parse_args()

    if args.selftest:
        return _selftest()

    out = {}
    app = Gtk.Application(application_id="de.hspitz.sidemark.latencyprobe")

    def on_activate(a):
        win = Probe(a, args.seconds, args.period, args.amplitude)

        def on_close(_w):
            out["dots"], out["pens"] = win._dots, win._pens
            return False          # let the window close

        win.connect("close-request", on_close)
        win.present()

    app.connect("activate", on_activate)
    app.run([])

    dots, pens = out.get("dots") or [], out.get("pens") or []
    print(f"\n  {len(dots)} dot frames, {len(pens)} pen samples")
    if len(pens) < 50:
        print("  too few pen samples — was the tip down on the dot?")
        return 1
    span = (pens[-1][0] - pens[0][0]) / max(1, len(pens) - 1)
    print(f"  pen sample interval  {span:.1f} ms (~{1000 / span:.0f} Hz)")
    frame = (dots[-1][0] - dots[0][0]) / max(1, len(dots) - 1)
    print(f"  frame interval       {frame:.1f} ms (~{1000 / frame:.0f} fps)")

    lag, rms = best_lag(dots, pens)
    if lag is None:
        print("  not enough overlap to fit")
        return 1
    print(f"\n  END-TO-END LAG  {lag:.0f} ms      (fit residual {rms:.3f})")
    if rms > 0.2:
        print("  POOR FIT — the hand was not really tracking the dot.")
        print("  Discard this run rather than believing the number.")
    elif rms > 0.08:
        print("  Fit is loose; treat the number as approximate.")
    print("\n  This is the WHOLE loop, your own tracking included, and a")
    print("  predictable sweep is one people anticipate — so read it as a")
    print("  lower bound on the machine. Compare RUNS, not absolutes.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
