#!/usr/bin/env python3
"""Build Sidemark-web into ONE self-contained HTML file.

Everything ends up inline — the stylesheet, all of `src/`, and the four vendored
libraries — so the result can be handed to someone as a single file with no
folder to keep beside it.

    ./build.py            → dist/sidemark.html  and  dist/serve.py

The one thing that cannot simply be inlined is pdf.js's WORKER: it is a separate
script by definition, loaded from a URL. So its source is embedded as a string,
turned into a Blob at startup and handed to pdf.js as a ready-made Worker
(`workerPort`), which is why `doc.js` looks for `__SIDEMARK_PDF_WORKER__`.

Needs `esbuild` once, to flatten the module graph — a hand-rolled bundler would
have to resolve imports and topologically sort them, and getting that subtly
wrong is a silent failure. It is fetched with npx if it is not installed.
"""

import base64
import json
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, "dist")
ESBUILD_VERSION = "0.24.0"


def run_esbuild(entry, out):
    """Flatten the module graph. Prefers a local esbuild, falls back to npx."""
    stub = os.path.join(HERE, "build", "node-stub.js")
    args = [
        "--bundle",
        # ESM, not IIFE: `import.meta.url` stays legal in an inline module
        # script, and the bundle has no external imports left to trip on.
        "--format=esm",
        "--target=es2022",
        # pdf.js keeps a Node.js branch a browser never takes; esbuild still has
        # to resolve it, so it is pointed at an empty module.
        f"--alias:fs={stub}", f"--alias:http={stub}",
        f"--alias:https={stub}", f"--alias:url={stub}",
        f"--outfile={out}", entry,
    ]
    for cmd in (["esbuild"], ["npx", "--yes", f"esbuild@{ESBUILD_VERSION}"]):
        if shutil.which(cmd[0]) is None:
            continue
        try:
            subprocess.run(cmd + args, check=True, cwd=HERE,
                           stdout=subprocess.DEVNULL)
            return
        except subprocess.CalledProcessError as exc:
            sys.exit(f"esbuild failed: {exc}")
    sys.exit("need esbuild or npx on PATH to build the single file")


def inline(html, tag_re, replacement):
    return re.sub(tag_re, lambda _m: replacement, html, count=1)


def main():
    os.makedirs(DIST, exist_ok=True)
    bundle_path = os.path.join(DIST, "_bundle.js")
    run_esbuild(os.path.join(HERE, "src", "app.js"), bundle_path)
    with open(bundle_path, encoding="utf-8") as fh:
        bundle = fh.read()
    os.remove(bundle_path)

    with open(os.path.join(HERE, "src", "style.css"), encoding="utf-8") as fh:
        css = fh.read()
    with open(os.path.join(HERE, "vendor", "pdf.worker.min.mjs"),
              encoding="utf-8") as fh:
        worker = fh.read()
    with open(os.path.join(HERE, "index.html"), encoding="utf-8") as fh:
        html = fh.read()
    def data_uri(name, mime):
        with open(os.path.join(HERE, name), "rb") as fh:
            return f"data:{mime};base64," + base64.b64encode(fh.read()).decode("ascii")

    # The worker rides as a JSON string rather than inside a <script> block: its
    # source contains sequences that would close the tag, and JSON escaping is
    # the one encoding that cannot be confused by its contents.
    shim = (
        "<script>\n"
        "// pdf.js needs a worker, and a worker needs a URL. With nothing to\n"
        "// fetch from, the source is inlined and turned into one here.\n"
        "(function () {\n"
        "  var src = " + json.dumps(worker) + ";\n"
        "  try {\n"
        "    var url = URL.createObjectURL(\n"
        "      new Blob([src], { type: 'text/javascript' }));\n"
        "    globalThis.__SIDEMARK_PDF_WORKER__ = new Worker(url, { type: 'module' });\n"
        "  } catch (e) {\n"
        "    // A blob worker is refused on some file:// pages. Say so plainly:\n"
        "    // pdf.js would otherwise just hang with a blank sheet.\n"
        "    console.error('could not start the PDF worker', e);\n"
        "    globalThis.__SIDEMARK_WORKER_FAILED__ = true;\n"
        "  }\n"
        "})();\n"
        "</script>\n"
    )

    # the icons ride as data URIs; a single file has nothing to fetch them from
    html = inline(html, r'<link rel="icon"[^>]*>',
                  '<link rel="icon" type="image/png" sizes="32x32" href="'
                  + data_uri("icon-32.png", "image/png") + '">')
    html = inline(html, r'<link rel="apple-touch-icon"[^>]*>',
                  '<link rel="apple-touch-icon" sizes="180x180" href="'
                  + data_uri("icon-180.png", "image/png") + '">')
    html = inline(html, r'<link rel="stylesheet"[^>]*>',
                  "<style>\n" + css + "\n</style>")
    html = inline(html, r'<script type="module" src="src/app\.js"></script>',
                  shim + '<script type="module">\n' + bundle + "\n</script>")
    html = html.replace("<title>Sidemark — browser prototype</title>",
                        "<title>Sidemark</title>")

    out = os.path.join(DIST, "sidemark.html")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(html)

    with open(os.path.join(DIST, "serve.py"), "w", encoding="utf-8") as fh:
        fh.write(SERVE_PY)
    os.chmod(os.path.join(DIST, "serve.py"), 0o755)

    size = os.path.getsize(out)
    print(f"dist/sidemark.html  {size / 1e6:.1f} MB")
    print("dist/serve.py       run it, or open sidemark.html over any web server")


SERVE_PY = '''#!/usr/bin/env python3
"""Open Sidemark. Serves this folder and points a browser at it.

A single HTML file still wants a web server: browsers refuse some things to a
page opened straight off the disk. This is the whole server — it reads files and
sends them, nothing else.

    python3 serve.py
"""

import http.server
import os
import socketserver
import threading
import webbrowser

PORT = 8765
os.chdir(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass                      # a quiet terminal is friendlier than a log

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    for port in range(PORT, PORT + 20):
        try:
            with socketserver.TCPServer(("127.0.0.1", port), Handler) as httpd:
                url = f"http://localhost:{port}/sidemark.html"
                print(f"Sidemark is at {url}")
                print("Leave this window open. Press Ctrl+C to stop.")
                threading.Timer(0.5, lambda: webbrowser.open(url)).start()
                httpd.serve_forever()
            return
        except OSError:
            continue              # that port was busy; try the next one
    print("could not find a free port")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\\nstopped")
'''


if __name__ == "__main__":
    main()
