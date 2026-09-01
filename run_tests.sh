#!/usr/bin/env bash
# Run the test suite inside a headless Weston compositor so GTK4 windows never
# appear on your real screen (GTK4 has no offscreen backend, so the tests need a
# real compositor — this mirrors the CI setup in .github/workflows/ci.yml).
#
# Usage:
#   ./run_tests.sh                      # FAST TIER (606 tests, ~18 s) — default
#   ./run_tests.sh --full               # everything (905 tests, ~140 s)
#   ./run_tests.sh -k TestCallouts      # any pytest args pass straight through
#   ./run_tests.sh -x -q test_pdfeditor.py::TestPageInsertAndConfirm
#
# THE DEFAULT IS THE CHEAP ONE ON PURPOSE. The window tier is 299 of the 905
# tests and 87% of the runtime (~410 ms each against ~30 ms), so a bare run used
# to cost 140 s and a warm laptop — and a bare run is what anyone reaches for by
# reflex. Making the expensive tier need a deliberate flag fixes that at the
# tool instead of relying on everyone remembering.
#
# Workflow: bare ./run_tests.sh (or -k for the area you touched) after every
# change. You rarely need --full at all: CI runs the whole suite on every push
# and PR (.github/workflows/ci.yml), so let the runner spend the two minutes.
# Keep --full for a release, or when you have changed something whose blast
# radius you genuinely cannot bound.
#
# A headless Weston is started once on a private socket and left running for fast
# repeat runs; `./run_tests.sh --stop` tears it down.
set -euo pipefail

RT="${SIDEMARK_TEST_RUNTIME:-/tmp/sidemark-test-wl}"
SOCK="wayland-sidemark-test"
LOG="/tmp/sidemark-weston.log"

if [ "${1:-}" = "--stop" ]; then
  pkill -f "weston.*$SOCK" 2>/dev/null && echo "stopped headless weston" || echo "not running"
  # …and take the SOCKET with it. A dead compositor leaves its socket file
  # behind, and the reuse check below is "does the socket exist" — so every
  # later run connects to nothing and every window test fails with GTK's
  # "couldn't be initialized", which reads like a broken test, not a missing
  # compositor.
  rm -f "$RT/$SOCK" "$RT/$SOCK.lock"
  exit 0
fi

# Fast tier unless --full is asked for. --fast is still accepted so old muscle
# memory and any script that predates the flip keep working — it is now simply
# what you get anyway.
TIER=(-m "not window")
FORCED=""
case "${1:-}" in
  --full) shift; TIER=(); FORCED=1 ;;
  --fast) shift; FORCED=1 ;;
esac

# ASKING FOR A TEST BY NAME MUST GIVE YOU THAT TEST. Without this, `-k
# TestMergeImportInWindow` quietly collects nothing at all — the tier filter
# deselects it — which reads as "my test vanished" and is the worst possible
# failure for a selector. An explicit selection is already the narrow, cheap
# path, so it overrides the default tier rather than being filtered by it.
if [ -z "$FORCED" ]; then
  for a in "$@"; do
    case "$a" in
      -k|--deselect|*::*) TIER=(); break ;;
    esac
  done
fi

if ! command -v weston >/dev/null 2>&1; then
  echo "weston not found. Install it once with:  sudo pacman -S weston" >&2
  exit 1
fi

mkdir -p "$RT"
chmod 700 "$RT"

# Reuse the running compositor, but only if it IS running: a crash (or a kill)
# leaves the socket file in place, and connecting to a stale one fails in a way
# that names neither weston nor this script.
if ! pgrep -f "weston.*$SOCK" >/dev/null 2>&1; then
  rm -f "$RT/$SOCK" "$RT/$SOCK.lock"
fi
if [ ! -S "$RT/$SOCK" ]; then
  XDG_RUNTIME_DIR="$RT" weston --backend=headless --socket="$SOCK" --idle-time=0 \
    >"$LOG" 2>&1 &
  for _ in $(seq 40); do [ -S "$RT/$SOCK" ] && break; sleep 0.25; done
  [ -S "$RT/$SOCK" ] || { echo "weston failed to start; see $LOG" >&2; exit 1; }
fi

# A THROWAWAY CONFIG HOME, or the suite runs against — and WRITES — your real
# settings.json. `Bindings.save()` persists on every rebind, so a test that
# rebinds a chord silently rewrote the user's button table, and every window
# test after it resolved presses through whatever the last run happened to
# leave behind. Both failure modes are invisible: the tests still pass on the
# machine that broke them, and the app comes up with a table nobody chose.
CFG="$RT/config"
mkdir -p "$CFG"

# SIDEMARK_TEST_HARNESS is what conftest.py checks before letting the suite
# run at all: without it, a bare `pytest` would drive the REAL desktop session
# — popping windows over your work and rewriting the settings of the app you
# actually use. Only this script may set it.
exec env XDG_RUNTIME_DIR="$RT" WAYLAND_DISPLAY="$SOCK" GDK_BACKEND=wayland \
  XDG_CONFIG_HOME="$CFG" \
  SIDEMARK_TEST=1 SIDEMARK_TEST_HARNESS=1 \
  /usr/bin/python3 -m pytest "${TIER[@]}" "${@:-test_pdfeditor.py}" -q
