# Testing: the details

> The RULES are in `CLAUDE.md` and must be read there. This is the
> reference for when one of them bites.

- **Settings are isolated per run and per test.** `run_tests.sh` points
  `XDG_CONFIG_HOME` at a throwaway dir and a conftest fixture deletes
  `settings.json` after every test. `Bindings.save()` persists on every rebind,
  so without both the suite rewrote the *user's* button table and every later
  window test routed presses through whatever the last run left behind — a test
  that passes alone, fails in a suite, and blames the wrong feature.
- Tests set `SIDEMARK_TEST=1` and use the system `/usr/bin/python3` (not venv
  shims). Window tests build a real `PDFEditorWindow` inside a throwaway
  `Adw.Application` and pump the main loop (`_settle()` pattern — copy it).

- **Layout needs a live frame clock, and a full run does not have one.**
  Allocation happens in the frame clock's layout phase, which is driven by the
  compositor's frame callbacks — and by late in a full suite Weston has taken
  the surface away (`VK_ERROR_SURFACE_LOST_KHR` in the captured stderr). After
  that NOTHING re-allocates: `_settle()` pumps idles all it likes, a widget
  keeps whatever size it last had, and even an explicit `set_size_request` is
  never honoured. So a `GtkTextView` never grows to its content height, and
  anything downstream of that (an adjustment's `upper`, a scroll position, a
  `translate_coordinates` result) is stale. **Test the property or the model,
  not the pixels** — and where a gesture-level assertion really is the point,
  make it `skipTest` on the unmet precondition instead of failing for the
  environment (`test_focusing_the_sheet_does_not_scroll_it` is the pattern:
  property always, scroll only when the sheet actually laid out). The tell is
  a test that passes alone, fails only in a full run, and dies at a geometry
  precondition rather than at what it means to assert.
