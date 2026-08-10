#!/usr/bin/env python3
"""Measure the pen's end-to-end latency by chasing a moving dot (row 147).

A dot travels a circle at constant speed. You keep the pen tip ON it. The dot's
position is known for every frame and the pen's for every sample, so the time
offset that best aligns the two curves is how far behind the pen's ink lands —
the whole loop, in milliseconds.

    extras/latency_probe.py                 # 20 s, then the number
    extras/latency_probe.py --period 3.5    # slower, if it is hard to follow
    extras/latency_probe.py --path line     # the old back-and-forth sweep
    extras/latency_probe.py --selftest      # check the fit, no hardware

Follow it round several times before trusting a run: the first lap is spent
learning the path, and a hand that is still catching up is a hand contributing
its own lag to the number. Slow it down until you can stay ON the dot rather
than chase it — a clean fit at a slow speed beats a ragged one at a fast.

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

# A CIRCLE at constant angular speed is the default path, and the reason is the
# hand rather than the maths. A back-and-forth sweep changes speed through every
# cycle — fastest at the centre, stopping dead at each end — and a reversal is
# the hardest thing there is to track, so the tracking error peaks exactly where
# the measurement lives. A circle has no reversals and one constant speed, so
# the hand settles into it and its error becomes a steady phase offset, which is
# precisely what the fit reads. A guide ring is drawn under it for the same
# reason: you cannot anticipate a path you cannot see, and anticipation is what
# keeps the human term out of the number.
MAX_LAG_MS = 200.0
LAG_STEP_MS = 1.0


def best_lag(dots, pens, max_lag=MAX_LAG_MS, step=LAG_STEP_MS):
    """The delay that best explains the pen curve as a copy of the dot curve.

    `dots` is [(t_ms, x, y)] as DRAWN and `pens` [(t_ms, x, y)] as REPORTED;
    the error is the 2D distance, so a circular path is fitted on both axes at
    once and a straight one degenerates to the single axis that moves.

    Returns (lag_ms, normalised residual). The residual matters as much as the
    lag: a good fit means the hand really was tracking, and a poor one means
    the run should be thrown away rather than believed.
    """
    if len(dots) < 8 or len(pens) < 8:
        return None, None
    d_t = [t for t, _, _ in dots]
    d_x = [x for _, x, _ in dots]
    d_y = [y for _, _, y in dots]

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
            return (d_x[lo], d_y[lo])
        f = (t - d_t[lo]) / span
        return (d_x[lo] + (d_x[hi] - d_x[lo]) * f,
                d_y[lo] + (d_y[hi] - d_y[lo]) * f)

    spread = math.hypot(statistics.pstdev([x for _, x, _ in pens]),
                        statistics.pstdev([y for _, _, y in pens])) or 1.0
    best = (None, None)
    lag = 0.0
    while lag <= max_lag:
        errs = []
        for t, px, py in pens:
            d = dot_at(t - lag)
            if d is not None:
                errs.append((px - d[0]) ** 2 + (py - d[1]) ** 2)
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
    P = 1500.0

    def circle(t, lag=0.0):
        a = 2 * math.pi * (t - lag) / P
        return (300 * math.cos(a), 300 * math.sin(a))

    def line(t, lag=0.0):
        return (300 * math.sin(2 * math.pi * (t - lag) / P), 0.0)

    for name, path in (("circle", circle), ("line", line)):
        for truth in (0.0, 17.0, 45.0, 90.0):
            dots = [(t * 4.0, *path(t * 4.0)) for t in range(600)]
            pens = [(t * 8.0, *path(t * 8.0, truth)) for t in range(40, 280)]
            lag, rms = best_lag(dots, pens)
            good = lag is not None and abs(lag - truth) <= 2.0 and rms < 0.02
            ok &= good
            print(f"  {name:<6} true {truth:>5.0f} ms -> fitted {lag:>5.1f} ms"
                  f"  (residual {rms:.4f})  {'ok' if good else 'FAILED'}")
    # a hand that was NOT tracking must be reported as a bad fit, not as a
    # confident number — the run that matters most is the one to throw away
    dots = [(t * 4.0, *circle(t * 4.0)) for t in range(600)]
    pens = [(t * 8.0, 300 * math.sin(t * 0.7), 300 * math.cos(t * 0.31))
            for t in range(40, 280)]
    _lag, rms = best_lag(dots, pens)
    noise_ok = rms > 0.2
    ok &= noise_ok
    print(f"  not tracking          -> residual {rms:.3f}  "
          f"{'ok (rejected)' if noise_ok else 'FAILED (looked like a fit)'}")
    return 0 if ok else 1


class Probe(Gtk.ApplicationWindow):
    def __init__(self, app, seconds, period, amplitude, path="circle"):
        super().__init__(application=app, title="Sidemark latency probe")
        self.set_default_size(900, 760)      # tall enough for a real circle
        # MILLISECONDS from here down. Every timestamp in this file is ms
        # (that is what the fit works in), so the two settings that arrive in
        # seconds are converted ONCE, here, and named for it — mixing the two
        # closed the window one frame in, which reads as broken hardware.
        self._run_ms = seconds * 1000.0
        self._period_ms = period * 1000.0
        self._amp = amplitude
        self._path = path
        self._dots, self._pens = [], []
        self._t0 = None
        self._done = False
        self._dot_x = self._dot_y = 0.0
        self._radius = 0.0

        self._area = Gtk.DrawingArea()
        self._area.set_draw_func(self._draw)
        self.set_child(self._area)

        # ONE controller, and motion rather than a drag: the tip must be DOWN
        # so this is the event path a stroke takes, and a GestureDrag beside
        # it would report the same motion again, putting every sample into the
        # fit twice.
        motion = Gtk.EventControllerMotion()
        motion.connect("motion", self._on_motion)
        self._area.add_controller(motion)

        self._area.add_tick_callback(self._tick)

    def _now(self):
        return GLib.get_monotonic_time() / 1000.0

    def _tick(self, _widget, _clock):
        now = self._now()
        if self._t0 is None:
            self._t0 = now
        t = now - self._t0                      # ms since the sweep began
        if t >= self._run_ms:
            self._done = True
            self.close()
            return GLib.SOURCE_REMOVE
        w = self._area.get_width() or 1000
        h = self._area.get_height() or 400
        cx, cy = w / 2.0, h / 2.0
        phase = 2 * math.pi * t / self._period_ms
        if self._path == "line":
            self._radius = min(self._amp, cx - 40)
            self._dot_x = cx + self._radius * math.sin(phase)
            self._dot_y = cy
        else:
            self._radius = max(30.0, min(self._amp, cx - 40, cy - 40))
            self._dot_x = cx + self._radius * math.cos(phase)
            self._dot_y = cy + self._radius * math.sin(phase)
        # logged at the time it is HANDED to the compositor, which is the only
        # timestamp we have any right to
        self._dots.append((now, self._dot_x, self._dot_y))
        self._area.queue_draw()
        return GLib.SOURCE_CONTINUE

    def _record(self, x, y, age_ms=0.0):
        if self._t0 is not None:
            self._pens.append((self._now() - age_ms, float(x), float(y)))

    def _record_history(self, controller, x, y):
        """The samples GTK compressed away since the last delivered event.

        Without these the probe would sample the pen once per FRAME and then
        report the frame rate as the pen rate — the exact confusion that made
        a 133 Hz pen look like a 30 Hz one for this whole investigation.

        The history is in SURFACE coordinates while `x` arrives in widget
        ones, so it is translated by the offset between the two — which the
        current event gives us, being known in both. Skipping that would not
        merely shift the curve: history and delivered samples would sit in
        different spaces in one list, putting a sawtooth into the very signal
        the lag is fitted to. Times are in the event clock, so only the
        difference from the current event is usable.
        """
        ev = controller.get_current_event()
        if ev is None or ev.get_event_type() != Gdk.EventType.MOTION_NOTIFY:
            return
        try:
            hist = ev.get_history()
            if not hist:
                return
            ok, sx, sy = ev.get_position()
            ev_time = ev.get_time()
        except (AttributeError, TypeError, ValueError):
            return
        if not ok:
            return
        dx, dy = x - sx, y - sy              # surface -> widget
        for coord in hist:
            if not (coord.flags & Gdk.AxisFlags.X
                    and coord.flags & Gdk.AxisFlags.Y):
                continue
            age = float(ev_time - coord.time)
            if 0.0 <= age <= 200.0:
                self._record(coord.axes[int(Gdk.AxisUse.X)] + dx,
                             coord.axes[int(Gdk.AxisUse.Y)] + dy, age)

    def _on_motion(self, c, x, y):
        self._record_history(c, x, y)
        self._record(x, y)

    def _draw(self, _area, ctx, width, height):
        ctx.set_source_rgb(0.08, 0.08, 0.10)
        ctx.paint()
        cx, cy = width / 2.0, height / 2.0
        # the path itself, faint: anticipation is what keeps the hand's own lag
        # out of the number, and you cannot anticipate what you cannot see
        ctx.set_source_rgb(0.25, 0.25, 0.30)
        ctx.set_line_width(1)
        ctx.new_sub_path()
        if self._path == "line":
            ctx.move_to(cx - self._radius, cy)
            ctx.line_to(cx + self._radius, cy)
        elif self._radius > 0:
            ctx.arc(cx, cy, self._radius, 0, 2 * math.pi)
        ctx.stroke()
        ctx.set_source_rgb(0.95, 0.75, 0.15)
        ctx.new_sub_path()
        ctx.arc(self._dot_x, self._dot_y, 14, 0, 2 * math.pi)
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
    ap.add_argument("--period", type=float, default=3.0,
                    help="seconds per lap (default 3.0 — slow it down if you "
                         "cannot stay ON the dot)")
    ap.add_argument("--amplitude", type=float, default=260.0,
                    help="circle radius / sweep half-width, px")
    ap.add_argument("--path", choices=("circle", "line"), default="circle",
                    help="circle (default) has no reversals and one constant "
                         "speed, so the hand tracks it far better")
    ap.add_argument("--selftest", action="store_true",
                    help="check the fit against known lags, no hardware")
    args = ap.parse_args()

    if args.selftest:
        return _selftest()

    out = {}
    app = Gtk.Application(application_id="de.hspitz.sidemark.latencyprobe")

    def on_activate(a):
        win = Probe(a, args.seconds, args.period, args.amplitude,
                    args.path)

        def on_close(_w):
            out["dots"], out["pens"] = win._dots, win._pens
            return False          # let the window close

        win.connect("close-request", on_close)
        win.present()

    app.connect("activate", on_activate)
    app.run([])

    dots, pens = out.get("dots") or [], out.get("pens") or []
    pens.sort()          # recovered history is inserted before its own event
    print(f"\n  {len(dots)} dot frames, {len(pens)} pen samples")
    if len(pens) < 50:
        print("  too few pen samples — was the tip down on the dot?")
        return 1
    span = (pens[-1][0] - pens[0][0]) / max(1, len(pens) - 1)
    print(f"  pen sample interval  {span:.1f} ms (~{1000 / span:.0f} Hz)")
    frame = (dots[-1][0] - dots[0][0]) / max(1, len(dots) - 1)
    print(f"  frame interval       {frame:.1f} ms (~{1000 / frame:.0f} fps)")

    # how far the dot moves in a millisecond decides what a lag of N ms even
    # looks like — without it a number is unreadable
    speed = 0.0
    if len(dots) > 1:
        moved = sum(math.dist(a[1:], b[1:]) for a, b in zip(dots, dots[1:]))
        speed = moved / max(1e-6, dots[-1][0] - dots[0][0])
    print(f"  dot speed            {speed * 1000:.0f} px/s "
          f"({speed * 10:.1f} px per 10 ms)")

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
