#!/usr/bin/env /usr/bin/python3
"""Prototype: draw on Sidemark from a phone's touchscreen, over the LAN.

Row 182 in ideas.csv. This is deliberately STANDALONE - it does not touch
sidemark.py's app code - so the transport and the feel of "phone as a
graphics tablet" can be judged before any of this goes near the real window.

    extras/phone_remote_prototype.py
    -> prints a URL (and a QR code, if `qrencode` is installed)
    -> open it on a phone on the same network
    -> draw with a finger; strokes appear live in the desktop window

MUST run under the SYSTEM python3 (/usr/bin/python3), not a pyenv/mise/asdf
shim - PyGObject (`gi`) is a system package, and sidemark.py's own shebang
makes the same choice for the same reason (see CLAUDE.md, "Single-instance
app" section). If `python3 extras/phone_remote_prototype.py` fails with
`ModuleNotFoundError: No module named 'gi'`, that shim is the cause: run
`/usr/bin/python3 extras/phone_remote_prototype.py` instead.

It reuses the REAL ink pipeline (finish_ink_stroke / draw_ink_stroke) from
sidemark.py, imported the same way extras/ink_replay.py does, so a stroke
drawn from a phone is shaped exactly like one drawn with a local pen.

Two things this prototype is deliberately careless about, both flagged in
ideas.csv row 182 as open questions rather than decided here: SECURITY (the
only guard is an unguessable token in the URL - fine on a home LAN, no more
than that) and PRESSURE (a touchscreen finger mostly reports a flat ~0.5, so
don't expect a stylus-like taper).
"""
import http.server
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("SIDEMARK_TEST", "1")  # import without starting a UI

import sidemark as sm  # noqa: E402

import gi  # noqa: E402
gi.require_version("Gtk", "4.0")
from gi.repository import Gtk, GLib, Gdk  # noqa: E402
import cairo  # noqa: E402

PORT = 8765
CANVAS_W, CANVAS_H = 900, 700
PEN_WIDTH = 2.2

# The phone page. Pointer Events (not touch events) so it works with a mouse
# too, for testing without a phone at all. touch-action: none is what stops
# the browser scrolling/zooming the page instead of drawing on it.
#
# Coordinates sent to the server are RAW CSS pixels in the phone's own canvas,
# not normalized 0..1 - normalizing independently per axis is what threw the
# phone's aspect ratio away before it ever reached the desktop, since 0..1 on
# a tall phone and 0..1 on a squarer desktop canvas are not the same shape.
# w/h (the phone's own canvas size) rides along with every batch so the
# server can letterbox instead of stretch (see _map_point).
#
# Each pointer is tracked by its OWN pointerId (`last`, a Map) end to end, so
# two fingers down at once are two independent strokes rather than one shared
# `drawing`/`lastX`/`lastY` triplet that the second touch would stomp on -
# that shared-state shape is what "multitouch does not work" was.
PAGE_HTML = """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<title>Sidemark remote</title>
<style>
  html,body {{ margin:0; height:100%; overflow:hidden; background:#222; }}
  canvas {{ display:block; width:100vw; height:100vh; touch-action:none; background:#fff; }}
</style></head><body>
<canvas id="c"></canvas>
<script>
const c = document.getElementById('c');
const ctx = c.getContext('2d');
function resize() {{ c.width = innerWidth; c.height = innerHeight; }}
resize(); addEventListener('resize', resize);

const TOKEN = {token!r};
let buf = [];
const last = new Map();  // pointerId -> {{x, y}}, one entry per active finger

function queue(x, y, p, phase, pid) {{
  buf.push({{x, y, p, ph: phase, pid}});
}}

function flush() {{
  if (buf.length) {{
    const body = JSON.stringify({{w: c.width, h: c.height, points: buf}});
    buf = [];
    fetch('/' + TOKEN + '/ink', {{method: 'POST', body}}).catch(() => {{}});
  }}
  requestAnimationFrame(flush);
}}
requestAnimationFrame(flush);

function pos(e) {{
  const r = c.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}}

c.addEventListener('pointerdown', e => {{
  c.setPointerCapture(e.pointerId);
  const [x, y] = pos(e);
  last.set(e.pointerId, {{x, y}});
  queue(x, y, e.pressure || 0.5, 'down', e.pointerId);
}});
c.addEventListener('pointermove', e => {{
  const p = last.get(e.pointerId);
  if (!p) return;
  const [x, y] = pos(e);
  queue(x, y, e.pressure || 0.5, 'move', e.pointerId);
  // one segment per event, drawn immediately - no shared ctx path, so a
  // second finger's segments can never land on the first finger's line.
  ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(x, y); ctx.stroke();
  last.set(e.pointerId, {{x, y}});
}});
function up(e) {{
  if (!last.has(e.pointerId)) return;
  last.delete(e.pointerId);
  const [x, y] = pos(e);
  queue(x, y, 0.0, 'up', e.pointerId);
}}
c.addEventListener('pointerup', up);
c.addEventListener('pointercancel', e => {{
  const p = last.get(e.pointerId);
  if (!p) return;
  last.delete(e.pointerId);
  queue(p.x, p.y, 0.0, 'cancel', e.pointerId);
}});
</script></body></html>"""


class RemoteInk:
    """Owns the finished/in-progress strokes and the GTK redraw. Every method
    here runs on the GTK MAIN thread - the HTTP handler never touches this
    directly, it only ever schedules calls via GLib.idle_add. Same discipline
    as the watchdog thread (ideas.csv row 169): a background thread that
    reaches into GTK without that indirection is a crash waiting to happen,
    not a maybe.
    """

    def __init__(self, area):
        self.area = area
        self.strokes = []          # finished: list of (pts, press)
        self.active = {}           # pointerId -> (pts, press), each mid-stroke

    def handle_batch(self, payload):
        w = payload.get("w") or CANVAS_W
        h = payload.get("h") or CANVAS_H
        for pt in payload.get("points", []):
            self._handle_one(pt, w, h)
        self.area.queue_draw()

    def _handle_one(self, pt, w, h):
        x, y = _map_point(pt["x"], pt["y"], w, h)
        p = pt.get("p", 0.5)
        phase = pt.get("ph")
        pid = pt.get("pid")
        if phase == "down":
            self.active[pid] = ([(x, y)], [p])
        elif phase == "move":
            entry = self.active.get(pid)
            if entry:
                entry[0].append((x, y))
                entry[1].append(p)
        elif phase == "up":
            entry = self.active.pop(pid, None)
            if entry:
                pts, press = entry
                pts.append((x, y))
                press.append(p)
                self._commit(pts, press)
        elif phase == "cancel":
            self.active.pop(pid, None)

    def _commit(self, pts, press):
        if len(pts) < 2:
            return
        # The real pipeline: interpolate, denoise, taper - exactly what a
        # local stylus stroke gets (sidemark.py's finish_ink_stroke).
        pts2, press2 = sm.finish_ink_stroke(pts, press, strength=0.5)
        self.strokes.append((pts2, press2))

    def draw(self, area, ctx, w, h):
        ctx.set_source_rgb(1, 1, 1)
        ctx.paint()
        ctx.set_source_rgb(0.05, 0.05, 0.05)
        for pts, press in self.strokes:
            sm.draw_ink_stroke(ctx, pts, PEN_WIDTH, profile=press)
        for pts, _press in self.active.values():          # each finger still down
            if len(pts) >= 2:
                sm.draw_ink_stroke(ctx, pts, PEN_WIDTH)


def _map_point(x, y, w, h):
    """Map a point from the phone's own pixel space onto the desktop canvas
    by a single UNIFORM scale (min of the two axis ratios), centred - the
    same fit an image gets in a letterboxed frame. Scaling each axis to its
    own ratio independently (what this did at first) stretched a tall phone
    screen onto a squarer desktop canvas and turned every circle into an
    ellipse; a uniform scale is what keeps a circle a circle."""
    if not w or not h:
        return x, y
    scale = min(CANVAS_W / w, CANVAS_H / h)
    off_x = (CANVAS_W - w * scale) / 2
    off_y = (CANVAS_H - h * scale) / 2
    return x * scale + off_x, y * scale + off_y


def _print_qr(url):
    """Best-effort: shell out to the `qrencode` CLI (an optional system tool,
    same pattern as ocrmypdf - present it if there, say how to get it if not)
    for a terminal-rendered QR code. No point vendoring a QR encoder for a
    prototype when the distro already ships one."""
    if not shutil.which("qrencode"):
        print("(install `qrencode` for a scannable QR code here - "
              "e.g. `sudo pacman -S qrencode` - for now, type the URL by hand)")
        return
    # subprocess output reaches the terminal through the raw fd, bypassing
    # Python's own buffered stdout - without this flush, redirecting output
    # anywhere but an interactive TTY reorders every QR ahead of its label.
    sys.stdout.flush()
    subprocess.run(["qrencode", "-t", "ANSIUTF8", "-o", "-", url])


def _lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))  # no packet actually sent for UDP connect
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def _other_lan_ips(exclude):
    """A machine can have more than one interface on the LAN (Wi-Fi plus a
    docked/USB adapter, say) - _lan_ip()'s default-route guess picks ONE, and
    if the phone is actually on a different one of them the connection can
    never succeed no matter what else is right. List the rest so there is
    somewhere to go without guessing blind."""
    try:
        out = subprocess.run(["ip", "-4", "-o", "addr", "show", "scope", "global"],
                             capture_output=True, text=True, timeout=2).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    found = []
    for line in out.splitlines():
        parts = line.split()
        # e.g. "2: wlo1    inet 192.168.178.108/24 ..."
        if len(parts) >= 4 and parts[2] == "inet":
            ip = parts[3].split("/")[0]
            if ip != exclude:
                found.append((parts[1], ip))
    return found


def make_handler(token, ink):
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass  # the phone polls every frame; the default logging is noise

        def do_GET(self):
            if self.path.rstrip("/") == "/" + token:
                body = PAGE_HTML.format(token=token).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            else:
                self.send_response(404)
                self.end_headers()

        def do_POST(self):
            if self.path != "/" + token + "/ink":
                self.send_response(404)
                self.end_headers()
                return
            length = int(self.headers.get("Content-Length", 0))
            try:
                data = json.loads(self.rfile.read(length))
            except ValueError:
                data = {}
            if data.get("points"):
                GLib.idle_add(ink.handle_batch, data)
            self.send_response(204)
            self.end_headers()

    return Handler


def main():
    token = secrets.token_urlsafe(6)
    ip = _lan_ip()
    candidates = [("this machine's default route", ip)]
    candidates += _other_lan_ips(exclude=ip)

    print("Try these on your phone, in order - one QR per candidate address, "
          "since a machine with more than one network interface (Wi-Fi, a "
          "docked adapter, Tailscale, ...) can't say which one your phone can "
          "actually reach:\n")
    for label, addr in candidates:
        url = f"http://{addr}:{PORT}/{token}/"
        print(f"--- {label} ({addr}) ---\n\n    {url}\n")
        _print_qr(url)
        print()

    print("If NONE of those load: check for a firewall blocking incoming "
          f"connections on port {PORT} (`sudo ufw status`), and that the phone "
          "is really on the same Wi-Fi (not a guest network with client "
          "isolation, and not mobile data). If a Tailscale address is in the "
          "list above, it needs Tailscale ACTIVE on the phone too, signed "
          "into the same tailnet, to be reachable.\n")

    def on_activate(app):
        win = Gtk.ApplicationWindow(application=app, title="Sidemark remote-ink prototype")
        area = Gtk.DrawingArea()
        area.set_content_width(CANVAS_W)
        area.set_content_height(CANVAS_H)
        ink = RemoteInk(area)
        area.set_draw_func(ink.draw)
        win.set_child(area)
        win.present()

        server = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), make_handler(token, ink))
        threading.Thread(target=server.serve_forever, daemon=True).start()

    app = Gtk.Application(application_id="dev.sidemark.PhoneRemoteProto")
    app.connect("activate", on_activate)
    app.run([])


if __name__ == "__main__":
    main()
