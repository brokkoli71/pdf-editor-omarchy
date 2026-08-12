// Presenter mode: a view-only mirror of the page for a second screen.
//
// Deliberately bare, as on the desktop — fullscreen, no chrome, just the
// current page with LIVE ink on a black surround. It keeps its own fit-to-page
// view, so the editor can zoom in to work on a slide while the audience still
// sees it whole. The timer and the large controls live on the EDITOR's window,
// which is the presenter's own screen, not on the projected slide.
//
// It still pages when focused, though: space, the arrows, PageUp/Down and a
// click all navigate, so a clicker works. They drive the EDITOR rather than
// moving alone, so the two windows cannot drift apart.
//
// The mirror is streamed as frames rather than given its own renderer. A second
// pdf.js in the popup would duplicate the document in memory and then need the
// live stroke shipped to it anyway; sending the finished picture is less
// machinery and gets live ink for nothing. `ImageBitmap` is transferable, so a
// frame costs a handle rather than a copy.

const POPUP_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Sidemark — Presenter</title>
<style>
  html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
  canvas { display: block; width: 100%; height: 100%; }
  .hint {
    position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
    font: 13px Cantarell, system-ui, sans-serif; color: #fff; opacity: .65;
    background: rgba(0,0,0,.55); padding: 6px 12px; border-radius: 999px;
    pointer-events: none; transition: opacity .4s;
  }
</style></head>
<body>
  <canvas id="m"></canvas>
  <div class="hint" id="h">Space / arrows to page · F for fullscreen · Esc to close</div>
</body></html>`;

export class Presenter {
  /** `opts.onNav(delta)` pages the editor; `opts.onNeedFrame()` is called when
   * the mirror wants a new picture (a resize, or the editor changing). */
  constructor(opts = {}) {
    this.win = null;
    this.canvas = null;
    this.onNav = opts.onNav || (() => {});
    this.onNeedFrame = opts.onNeedFrame || (() => {});
    this.onClose = opts.onClose || (() => {});
    this._pending = false;
  }

  get open() { return !!(this.win && !this.win.closed); }

  start() {
    if (this.open) { this.win.focus(); return true; }
    const win = window.open("", "sidemark-presenter",
                            "width=1280,height=800,menubar=no,toolbar=no");
    if (!win) return false;            // a blocked popup is not an error to throw
    win.document.write(POPUP_HTML);
    win.document.close();
    this.win = win;
    this.canvas = win.document.getElementById("m");

    const nav = (delta) => this.onNav(delta);
    win.addEventListener("keydown", (e) => {
      const k = e.key;
      if (k === "Escape") { this.stop(); return; }
      if (k === "f" || k === "F") {
        // a projector wants the whole screen, and only a gesture can ask
        if (win.document.fullscreenElement) win.document.exitFullscreen();
        else win.document.documentElement.requestFullscreen?.();
        return;
      }
      if ([" ", "ArrowRight", "ArrowDown", "PageDown", "Enter"].includes(k)) {
        e.preventDefault(); nav(1);
      } else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(k)) {
        e.preventDefault(); nav(-1);
      }
    });
    // click to advance, right-click to go back — what a clicker sends
    win.addEventListener("mousedown", (e) => {
      e.preventDefault();
      nav(e.button === 2 || e.button === 3 ? -1 : 1);
    });
    win.addEventListener("contextmenu", (e) => e.preventDefault());
    win.addEventListener("resize", () => this.request());
    win.addEventListener("pagehide", () => this.stop());
    // the hint fades once, so it explains itself and then gets out of the way
    setTimeout(() => {
      const h = win.document.getElementById("h");
      if (h) h.style.opacity = "0";
    }, 4000);

    this.request();
    return true;
  }

  stop() {
    const win = this.win;
    this.win = null;
    this.canvas = null;
    if (win && !win.closed) win.close();
    this.onClose();
  }

  /** The size the mirror wants a frame at, in device pixels. */
  frameSize() {
    if (!this.open) return null;
    const dpr = this.win.devicePixelRatio || 1;
    return [Math.max(1, Math.round(this.canvas.clientWidth * dpr)),
            Math.max(1, Math.round(this.canvas.clientHeight * dpr))];
  }

  /** Ask for a new frame, at most one per animation frame — the editor pings
   * this on every motion event while a stroke is being drawn. */
  request() {
    if (!this.open || this._pending) return;
    this._pending = true;
    (this.win.requestAnimationFrame || setTimeout)(() => {
      this._pending = false;
      if (this.open) this.onNeedFrame();
    }, 16);
  }

  /** Show a frame. Takes ownership of the bitmap. */
  show(bitmap) {
    if (!this.open || !bitmap) { bitmap?.close?.(); return; }
    const c = this.canvas;
    if (c.width !== bitmap.width || c.height !== bitmap.height) {
      c.width = bitmap.width;
      c.height = bitmap.height;
    }
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
  }
}

/** A presentation clock: elapsed time, pausable, resettable. Lives on the
 * editor's window because that is the screen only you can see. */
export class Timer {
  constructor(onTick) {
    this.onTick = onTick || (() => {});
    this.elapsed = 0;
    this.running = false;
    this._since = 0;
    this._iv = null;
  }
  get seconds() {
    return Math.floor((this.elapsed + (this.running ? Date.now() - this._since : 0)) / 1000);
  }
  start() {
    if (this.running) return;
    this.running = true;
    this._since = Date.now();
    this._iv = setInterval(() => this.onTick(), 250);
    this.onTick();
  }
  pause() {
    if (!this.running) return;
    this.elapsed += Date.now() - this._since;
    this.running = false;
    clearInterval(this._iv);
    this._iv = null;
    this.onTick();
  }
  toggle() { this.running ? this.pause() : this.start(); }
  reset() {
    this.elapsed = 0;
    this._since = Date.now();
    this.onTick();
  }
  stop() { this.pause(); this.elapsed = 0; this.onTick(); }
  static format(secs) {
    const m = Math.floor(secs / 60), s = secs % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }
}
