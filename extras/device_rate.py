#!/usr/bin/env python3
"""How fast does an input device actually report? (ideas.csv row 147)

Sidemark's ink capture timestamps a sample when the APP handles it, and GTK
delivers a stylus as the logical pointer — whose motion is compressed to the
frame clock. So the capture can only ever measure DELIVERY: it showed the pen
arriving at exactly 2.00 display frames per sample against a finger's 0.44,
which says the pen is frame-locked but cannot say whether samples are being
discarded on the way or were never sent.

This reads the evdev node directly, below GTK and below libinput, and counts
SYN_REPORT packets — one per report the hardware actually emitted. If the raw
rate is ~60 Hz while Sidemark sees 30, the samples exist and we are losing
them. If the raw rate is ~30 Hz, the panel is the limit and no amount of
plumbing will help.

    sudo extras/device_rate.py                 # auto-pick the stylus
    sudo extras/device_rate.py --list
    sudo extras/device_rate.py --device /dev/input/event17 --seconds 15

Pure stdlib on purpose: neither the `libinput` CLI nor `evtest` is installed
on the machine this was written for, and a measurement that needs a package
installed first is a measurement that does not get taken.
"""
import argparse
import os
import re
import statistics
import struct
import sys
import time

# struct input_event { struct timeval time; __u16 type, code; __s32 value; }
# — 8 + 8 + 2 + 2 + 4 on 64-bit. The kernel's own timestamp, so this measures
# the DEVICE's cadence and not how promptly we got round to reading it.
EVENT_FMT = "llHHi"
EVENT_SIZE = struct.calcsize(EVENT_FMT)

EV_SYN, EV_KEY, EV_ABS = 0x00, 0x01, 0x03
SYN_REPORT = 0
ABS_X, ABS_Y = 0x00, 0x01


def devices():
    """[(name, /dev/input/eventN)] from /proc — readable without root, which
    is what lets --list work before you have decided to use sudo."""
    out, name = [], None
    with open("/proc/bus/input/devices") as fh:
        for line in fh:
            if line.startswith("N: Name="):
                name = line.split("=", 1)[1].strip().strip('"')
            elif line.startswith("H: Handlers=") and name:
                m = re.search(r"\bevent(\d+)\b", line)
                if m:
                    out.append((name, f"/dev/input/event{m.group(1)}"))
                name = None
    return out


def pick(want):
    """The device whose name contains `want` (case-insensitive)."""
    matches = [d for d in devices() if want.lower() in d[0].lower()]
    if not matches:
        sys.exit(f"no input device matching {want!r} — try --list")
    if len(matches) > 1:
        print(f"note: {len(matches)} devices match {want!r}, using the first")
    return matches[0]


def measure(path, seconds, quiet_ms=200.0):
    """Interval between reports that carried MOTION, in ms.

    Only reports containing ABS_X/ABS_Y count: a pen in proximity also emits
    pressure, tilt and button packets, and counting those would report a rate
    the pen never moved at. Gaps longer than `quiet_ms` are dropped as pauses
    between strokes rather than treated as one very slow sample.
    """
    gaps, moved, last = [], False, None
    deadline = time.monotonic() + seconds
    with open(path, "rb", buffering=0) as fh:
        os.set_blocking(fh.fileno(), False)
        while time.monotonic() < deadline:
            try:
                data = fh.read(EVENT_SIZE * 64)
            except BlockingIOError:
                data = None
            if not data:
                time.sleep(0.002)
                continue
            for i in range(0, len(data) - EVENT_SIZE + 1, EVENT_SIZE):
                sec, usec, etype, code, _val = struct.unpack_from(
                    EVENT_FMT, data, i)
                if etype == EV_ABS and code in (ABS_X, ABS_Y):
                    moved = True
                elif etype == EV_SYN and code == SYN_REPORT:
                    if moved:
                        now = sec * 1000.0 + usec / 1000.0
                        if last is not None and now - last <= quiet_ms:
                            gaps.append(now - last)
                        last = now
                    moved = False
    return gaps


def main():
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--device", help="/dev/input/eventN (else --name)")
    ap.add_argument("--name", default="stylus",
                    help="pick the device by name substring (default: stylus)")
    ap.add_argument("--seconds", type=float, default=15.0)
    ap.add_argument("--list", action="store_true", help="list devices and exit")
    args = ap.parse_args()

    if args.list:
        for name, path in devices():
            print(f"  {path:<22} {name}")
        return 0

    path = args.device
    name = "(given)"
    if not path:
        name, path = pick(args.name)
    if not os.access(path, os.R_OK):
        sys.exit(f"cannot read {path} — run under sudo, or join the `input` group")

    print(f"reading {path}  {name}")
    print(f"draw continuously for {args.seconds:.0f}s ...")
    gaps = measure(path, args.seconds)
    if len(gaps) < 10:
        print(f"only {len(gaps)} motion reports — was the device moving?")
        return 1

    med = statistics.median(gaps)
    print(f"\n  {len(gaps)} motion reports")
    print(f"  interval  median {med:.2f} ms   "
          f"p10 {sorted(gaps)[len(gaps) // 10]:.2f}   "
          f"p90 {sorted(gaps)[len(gaps) * 9 // 10]:.2f}")
    print(f"  RAW REPORT RATE  ~{1000 / med:.0f} Hz")
    # the comparison the whole exercise is for
    print(f"\n  Sidemark sees this device at ~30 Hz (33.4 ms) for the pen.")
    if med < 24.0:
        print("  -> the hardware is FASTER than what reaches the canvas:")
        print("     samples exist and are being lost between here and there.")
    else:
        print("  -> the hardware is the limit; plumbing cannot recover more.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
