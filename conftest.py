"""Auto-tier the test suite so the default `./run_tests.sh` can skip the slow part.

Building a real window (PDFEditorWindow / Adw.Application / PresenterWindow)
dominates the suite's runtime; pure-logic and single-widget tests run in
seconds. Rather than hand-marking ~75 classes (which would rot), a test class
is marked `window` when its source references one of the window types.

Misclassification is harmless for *correctness* — every test still runs under
the headless compositor, so a "fast" test that turns out to need a window
still passes; it only lands in the wrong speed tier. The full suite
(no -m filter) is unaffected, as is CI's `python3 test_pdfeditor.py`.
"""
import inspect
import os
import re

import pytest

_WINDOW_RE = re.compile(r"PDFEditorWindow|PresenterWindow|Adw\.Application")
_seen = {}


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "window: builds real windows/apps — the slow tier, skipped by "
        "the default ./run_tests.sh (-m 'not window'); --full runs them)")


@pytest.fixture(autouse=True)
def _fresh_settings():
    """Every test starts from the SHIPPED defaults.

    Settings are one file (`_settings_path`, under XDG_CONFIG_HOME — pointed at
    a throwaway dir by run_tests.sh) and `Bindings.save()` writes to it on every
    rebind. Without this, a test that binds a chord leaks its table into every
    window built after it, in file order: the failure is a test that passes
    alone and fails in a suite, blaming the wrong feature. Deleting the file
    between tests is enough — the table is only read when a window is built."""
    yield
    import sidemark
    try:
        os.unlink(sidemark._settings_path())
    except OSError:
        pass


def pytest_collection_modifyitems(config, items):
    for item in items:
        cls = getattr(item, "cls", None)
        if cls is None:
            continue
        if cls not in _seen:
            try:
                src = inspect.getsource(cls)
            except (OSError, TypeError):
                src = ""
            _seen[cls] = bool(_WINDOW_RE.search(src))
        if _seen[cls]:
            item.add_marker(pytest.mark.window)
