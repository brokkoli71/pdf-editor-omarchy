// The press router's modifier state.
//
// Tracked held keys exist because a press can arrive without a modifier mask,
// and a Ctrl+press that reads as unmodified takes the wrong branch. The failure
// on the other side is worse and silent: a keyup that never arrives leaves a
// modifier held for ever, `toolFor` then resolves a chord nobody is pressing —
// usually bound to nothing — and the pen stops drawing with no visible cause.
// `blur` only covers the case where focus moves.
//
//   node web/test/chord.mjs

import { Surface } from "../src/surface.js";

let checks = 0, failures = 0;
function check(name, got, want) {
  checks++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failures++; console.error(`  ✗ ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

// `_chordState` reads and writes only `_heldMods` and the correction callback,
// so it can be exercised without a DOM.
function router(held) {
  return {
    _heldMods: { ...held },
    corrections: [],
    onHeldModsCorrected(mods) { this.corrections.push({ ...mods }); },
    state(e) { return Surface.prototype._chordState.call(this, e); },
  };
}
const press = (mods = {}) => ({ type: "pointerdown", ctrlKey: false, shiftKey: false, altKey: false, ...mods });

// ── the mask still wins when it carries a key the tracker missed ─────────────
{
  const r = router({ ctrl: false, shift: false, alt: false });
  check("event's own Ctrl is honoured", r.state(press({ ctrlKey: true })),
        { ctrl: true, shift: false, alt: false });
  check("no correction when nothing was stale", r.corrections.length, 0);
}

// ── a press with no modifiers CLEARS a tracked key that is not really held ───
{
  const r = router({ ctrl: true, shift: true, alt: false });
  check("stale Ctrl+Shift are dropped", r.state(press()),
        { ctrl: false, shift: false, alt: false });
  check("the window is told once", r.corrections, [{ ctrl: false, shift: false, alt: false }]);
  check("and the tracker itself is fixed", r._heldMods,
        { ctrl: false, shift: false, alt: false });
}

// ── a correction keeps the modifiers that ARE held ───────────────────────────
{
  const r = router({ ctrl: true, shift: true, alt: false });
  check("Ctrl survives, Shift does not", r.state(press({ ctrlKey: true })),
        { ctrl: true, shift: false, alt: false });
}

// ── a NON-press event never corrects: only a real press knows ────────────────
// A pointermove mid-stroke carries a mask too, but the tracked state is what
// drives the toolbar readout between presses, and rewriting it from any passing
// event would make the stripes flicker against what the keyboard is doing.
{
  const r = router({ ctrl: true, shift: false, alt: false });
  const move = { type: "pointermove", ctrlKey: false, shiftKey: false, altKey: false };
  check("a move still merges rather than corrects", r.state(move),
        { ctrl: true, shift: false, alt: false });
  check("and corrects nothing", r.corrections.length, 0);
}

// ── the dead pen this prevents, end to end ──────────────────────────────────
// With Ctrl+Shift stuck, the left button resolves a chord that is bound to
// nothing: `toolFor` returns null and the page silently stops taking ink.
{
  const table = {
    toolFor(button, ctrl, shift, alt) {
      if (button !== 1) return null;
      if (!ctrl && !shift && !alt) return "pen";
      if (ctrl && !shift && !alt) return "pan";
      return null;                       // Ctrl+Shift+left is bound to nothing
    },
  };
  const r = router({ ctrl: true, shift: true, alt: false });
  const stale = r._heldMods;
  check("stuck modifiers would resolve to no tool",
        table.toolFor(1, stale.ctrl, stale.shift, stale.alt), null);
  const s = r.state(press());
  check("after one press the pen is back", table.toolFor(1, s.ctrl, s.shift, s.alt), "pen");
}

if (failures) {
  console.error(`\n✗ ${failures} of ${checks} chord checks failed.`);
  process.exit(1);
}
console.log(`✓ ${checks} chord checks passed (stale modifiers cannot kill the pen).`);
