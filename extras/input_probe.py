#!/usr/bin/env python3
"""Input probe: what does this machine's stylus/touchscreen actually send?

Sidemark routes every press purely on BUTTON NUMBER (Bindings.tool_for), which
means a stylus tip, a fingertip and a resting palm are indistinguishable to it.
Before extending the bindings table with an input-source key, we need the
ground truth from real hardware: which Gdk.InputSource / Gdk.DeviceToolType
each end of the pen reports, which button number the barrel sends, whether
pressure is a real axis or a constant, and whether the compositor already
suppresses touch while the pen hovers.

Run it, work through the checklist, then read the log. Not part of the app.

    /usr/bin/python3 extras/input_probe.py            # log -> $PROBE_LOG or /tmp
    PROBE_LOG=/path/to/x.log /usr/bin/python3 extras/input_probe.py

Keys: 1-9 stamp a step marker into the log, c clears the canvas, q quits.
"""
import os
import sys
import time

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
from gi.repository import Gdk, Gio, Gtk  # noqa: E402

LOG_PATH = os.environ.get("PROBE_LOG") or "/tmp/stylus-probe.log"

# Motion/touch-update events arrive at the panel's full report rate; logging
# every one buries the button and proximity events that actually answer the
# question. Sample them, but track the pressure RANGE across every sample so
# the per-stroke summary still sees the true min/max.
MOTION_SAMPLE = 8

AXES = (("press", Gdk.AxisUse.PRESSURE),
        ("xtilt", Gdk.AxisUse.XTILT),
        ("ytilt", Gdk.AxisUse.YTILT),
        ("dist", Gdk.AxisUse.DISTANCE),
        ("rot", Gdk.AxisUse.ROTATION))


def _enum_names(enum_class):
    """int -> NAME for a Gdk enum, so the log reads in words not numbers."""
    out = {}
    for name in dir(enum_class):
        if not name.isupper():
            continue
        value = getattr(enum_class, name)
        if isinstance(value, enum_class):
            out[int(value)] = name
    return out


EVENT_NAMES = _enum_names(Gdk.EventType)
SOURCE_NAMES = _enum_names(Gdk.InputSource)
TOOL_NAMES = _enum_names(Gdk.DeviceToolType)

# What each source paints, so the canvas answers "did that press come from the
# pen or my palm?" without reading a single log line.
SOURCE_COLORS = {
    "PEN": (0.15, 0.45, 0.95),
    "ERASER": (0.95, 0.25, 0.20),
    "TOUCHSCREEN": (0.95, 0.65, 0.10),
    "TOUCHPAD": (0.55, 0.35, 0.85),
    "MOUSE": (0.45, 0.45, 0.45),
}

CHECKLIST = (
    "1 pen tip: draw a slow line, press LIGHT then HARD",
    "2 pen tip: hover above the glass without touching",
    "3 barrel button: hold it and draw",
    "4 eraser end: flip the pen over and draw",
    "5 one finger: draw a line",
    "6 palm: rest your hand, then write with the pen",
    "7 two fingers: pinch and drag",
    "8 mouse/touchpad: click and drag",
)

# Round two: the questions the first pass could not answer, because every
# button was pressed BEFORE the tip landed. What a button does mid-stroke is a
# different question from what it does on approach, and the answer decides
# whether a barrel button can be a live modifier or only a tool identity.
FOLLOWUP = (
    "1 tip down FIRST, then press the ERASER button mid-stroke",
    "2 tip down FIRST, then press the OTHER button mid-stroke",
    "3 hold ERASER button + press the other one, then draw",
    "4 press each button while HOVERING, no contact at all",
    "5 palm down and KEEP it down, then bring the pen in",
    "6 pen stroke in progress, then tap the glass with a finger",
)


class Probe(Gtk.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app, title="Sidemark input probe")
        self.set_default_size(1280, 860)

        self._log = open(LOG_PATH, "w", buffering=1)
        self._t0 = time.monotonic()
        self._lines = []          # recent log lines, painted on the canvas
        self._dots = []           # (x, y, radius, rgb) painted marks
        self._strokes = {}        # key -> live per-stroke stats
        self._motion_n = 0
        self._step = 0
        self._checklist = FOLLOWUP if "--followup" in sys.argv else CHECKLIST

        self._area = Gtk.DrawingArea()
        self._area.set_draw_func(self._draw)
        self.set_child(self._area)

        # ONE legacy controller in the capture phase sees every event before any
        # gesture can claim it — the point is to observe what the hardware sends,
        # not what GTK's gesture recognisers make of it.
        legacy = Gtk.EventControllerLegacy()
        legacy.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
        legacy.connect("event", self._on_event)
        self.add_controller(legacy)

        # GestureStylus is the API Sidemark would actually adopt, so run it side
        # by side: if it stays silent while the legacy controller reports a PEN
        # source, the gesture is not the right vehicle on this stack.
        stylus = Gtk.GestureStylus()
        for signal in ("down", "motion", "up", "proximity"):
            stylus.connect(signal, self._on_stylus, signal)
        self._area.add_controller(stylus)

        # THE load-bearing question for the bindings change: Sidemark's press
        # routers are GestureDrag handlers, and a GestureDrag hands over only
        # (gesture, x, y) — no event. If get_current_event() comes back empty
        # there, the tool cannot be read where routing happens and the source
        # has to be stamped from a capture-phase legacy controller instead
        # (the trick the thumb button already needs).
        drag = Gtk.GestureDrag()
        drag.set_button(0)
        drag.connect("drag-begin", self._on_drag_begin)
        self._area.add_controller(drag)

        keys = Gtk.EventControllerKey()
        keys.connect("key-pressed", self._on_key)
        self.add_controller(keys)

        self._dump_devices()
        self.emit_line("READY — press 1-9 to stamp a step, c clears, q quits")

    # ---------------------------------------------------------------- logging

    def emit_line(self, text):
        stamp = f"{time.monotonic() - self._t0:7.2f}"
        line = f"{stamp}  {text}"
        self._log.write(line + "\n")
        self._lines.append(line)
        del self._lines[:-26]
        self._area.queue_draw()

    def _dump_devices(self):
        self.emit_line(f"log file: {LOG_PATH}")
        display = self.get_display()
        self.emit_line(f"display: {type(display).__name__} {display.get_name()}")
        seat = display.get_default_seat()
        for dev in seat.get_devices(Gdk.SeatCapabilities.ALL):
            source = SOURCE_NAMES.get(int(dev.get_source()), "?")
            self.emit_line(f"device: {dev.get_name()!r} source={source}")

    # ------------------------------------------------------------- event dump

    def _describe(self, event):
        """The identity half of a log line: who sent this and with what."""
        bits = []
        device = event.get_device()
        source = "?"
        if device is not None:
            source = SOURCE_NAMES.get(int(device.get_source()), "?")
            bits.append(f"src={source}")
            bits.append(f"dev={device.get_name()!r}")
        tool = event.get_device_tool()
        if tool is not None:
            # THE field the whole probe exists for: PEN vs ERASER is how the
            # two ends of one stylus tell themselves apart, and it is carried
            # by the tool, not by the device or the button.
            bits.append("tool=" + TOOL_NAMES.get(int(tool.get_tool_type()), "?"))
            bits.append(f"serial={tool.get_serial()}")
            bits.append(f"hwid={tool.get_hardware_id()}")
        return source, " ".join(bits)

    def _axes(self, event):
        out = []
        for label, axis in AXES:
            ok, value = event.get_axis(axis)
            if ok:
                out.append(f"{label}={value:.4f}")
        return " ".join(out)

    def _stroke_key(self, event):
        seq = event.get_event_sequence()
        if seq is not None:
            return f"touch:{id(seq)}"
        device = event.get_device()
        return f"ptr:{device.get_name() if device else '?'}"

    def _on_event(self, ctrl, event):
        if event is None:
            # The legacy controller emits a few events (grab-broken and
            # friends) that PyGObject hands over as None; the controller still
            # knows the current one.
            event = ctrl.get_current_event()
            if event is None:
                return False
        etype = int(event.get_event_type())
        name = EVENT_NAMES.get(etype, str(etype))
        source, who = self._describe(event)
        axes = self._axes(event)
        ok, x, y = event.get_position()
        pos = f"@{x:.0f},{y:.0f}" if ok else ""
        mods = int(event.get_modifier_state())
        key = self._stroke_key(event)

        if name in ("MOTION_NOTIFY", "TOUCH_UPDATE"):
            stroke = self._strokes.get(key)
            if stroke is not None and ok:
                self._track(stroke, event, x, y, source)
            self._motion_n += 1
            if self._motion_n % MOTION_SAMPLE:
                return False
            self.emit_line(f"{name:14s} {pos} {axes}  {who}")
            return False

        extra = ""
        if name in ("BUTTON_PRESS", "BUTTON_RELEASE"):
            # Sidemark's entire routing key today. Whether the barrel arrives
            # here as 2 or 3 — or as a keyboard event, or not at all — decides
            # whether it can be bound like any other button.
            extra = f"button={event.get_button()}"
        if name in ("BUTTON_PRESS", "TOUCH_BEGIN"):
            self._strokes[key] = {"n": 0, "pmin": 9.0, "pmax": -1.0,
                                  "source": source, "who": who}
            if ok:
                self._track(self._strokes[key], event, x, y, source)
        self.emit_line(f"{name:14s} {pos} {extra} mods={mods:#x} {axes}  {who}")
        if name in ("BUTTON_RELEASE", "TOUCH_END", "TOUCH_CANCEL"):
            self._summarize(key)
        return False

    def _track(self, stroke, event, x, y, source):
        ok, pressure = event.get_axis(Gdk.AxisUse.PRESSURE)
        pressure = pressure if ok else -1.0
        stroke["n"] += 1
        if ok:
            stroke["pmin"] = min(stroke["pmin"], pressure)
            stroke["pmax"] = max(stroke["pmax"], pressure)
        radius = 2.0 + (pressure * 16.0 if ok else 3.0)
        self._dots.append((x, y, radius, SOURCE_COLORS.get(source, (0, 0, 0))))
        del self._dots[:-6000]

    def _summarize(self, key):
        stroke = self._strokes.pop(key, None)
        if not stroke or not stroke["n"]:
            return
        if stroke["pmax"] < 0:
            # No pressure axis at all — the difference between "the panel is
            # not pressure-sensitive" and "it is, but flat", which a single
            # constant reading would not distinguish.
            press = "NO PRESSURE AXIS"
        elif stroke["pmax"] - stroke["pmin"] < 1e-6:
            press = f"pressure CONSTANT {stroke['pmax']:.4f}"
        else:
            press = f"pressure {stroke['pmin']:.4f}..{stroke['pmax']:.4f}"
        self.emit_line(f"  STROKE END  {stroke['n']} pts  {press}  "
                       f"src={stroke['source']}")

    def _on_stylus(self, gesture, *args):
        signal = args[-1]
        tool = gesture.get_device_tool()
        tool_name = TOOL_NAMES.get(int(tool.get_tool_type()), "?") if tool else "-"
        ok, pressure = gesture.get_axis(Gdk.AxisUse.PRESSURE)
        self.emit_line(f"  GestureStylus:{signal} tool={tool_name} "
                       f"pressure={pressure:.4f}" if ok else
                       f"  GestureStylus:{signal} tool={tool_name} pressure=n/a")
        return False

    def _on_drag_begin(self, gesture, _x, _y):
        event = gesture.get_current_event()
        if event is None:
            self.emit_line("  GestureDrag:begin  NO EVENT — source must be "
                           "stamped from a legacy controller")
            return
        tool = event.get_device_tool()
        tool_name = TOOL_NAMES.get(int(tool.get_tool_type()), "?") if tool else "None"
        state = int(gesture.get_current_event_state())
        self.emit_line(f"  GestureDrag:begin  btn={gesture.get_current_button()} "
                       f"tool={tool_name} state={state:#x} "
                       f"(BUTTON2={bool(state & Gdk.ModifierType.BUTTON2_MASK)})")

    def _on_key(self, _ctrl, keyval, _code, _state):
        char = chr(keyval) if 32 <= keyval < 127 else ""
        if char == "q":
            self.close()
        elif char == "c":
            self._dots.clear()
            self._area.queue_draw()
        elif char.isdigit() and char != "0":
            self._step = int(char)
            self.emit_line(f"===== STEP {char}: "
                           f"{self._checklist[self._step - 1][2:]} =====")
        return True

    # ---------------------------------------------------------------- drawing

    def _draw(self, _area, ctx, width, height):
        ctx.set_source_rgb(1, 1, 1)
        ctx.paint()

        for x, y, radius, (r, g, b) in self._dots:
            ctx.set_source_rgba(r, g, b, 0.55)
            ctx.new_sub_path()
            ctx.arc(x, y, radius, 0, 6.2832)
            ctx.fill()
        ctx.new_path()

        ctx.select_font_face("monospace")
        ctx.set_font_size(12)
        ctx.set_source_rgba(1, 1, 1, 0.85)
        ctx.rectangle(0, 0, width, 350)
        ctx.fill()
        ctx.set_source_rgb(0.1, 0.1, 0.1)
        for i, line in enumerate(self._lines):
            ctx.move_to(8, 16 + i * 13)
            ctx.show_text(line)
        ctx.new_path()

        ctx.set_font_size(13)
        for i, item in enumerate(self._checklist):
            done = int(item[0]) <= self._step
            ctx.set_source_rgb(*((0.6, 0.6, 0.6) if done else (0.1, 0.1, 0.4)))
            ctx.move_to(8, height - 18 - (len(self._checklist) - i) * 16)
            ctx.show_text(("✓ " if done else "  ") + item)
        ctx.new_path()


def main():
    app = Gtk.Application(application_id="de.sidemark.InputProbe",
                          flags=Gio.ApplicationFlags.NON_UNIQUE)
    app.connect("activate", lambda a: Probe(a).present())
    # GApplication parses argv itself and rejects flags it does not know, so
    # our own are read off sys.argv directly and never handed to it.
    return app.run(sys.argv[:1])


if __name__ == "__main__":
    sys.exit(main())
