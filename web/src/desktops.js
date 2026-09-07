// The phone's list of computers it can attach to, and the camera that fills it.
//
// WHY THIS IS A LIST OF ADDRESSES AND NOT A CLIENT. A live session runs on the
// desktop's OWN origin — the desktop serves this same port under its share
// token and the page talks back to the machine that served it. An installed
// copy from GitHub Pages cannot do that job itself: a LAN address fails mixed
// content (no CA issues a certificate for `192.168.x.x`, so there is no HTTPS
// version to ask for), and a tailnet address over real TLS is refused by
// Chrome's Local Network Access, which counts the tailnet as local. Both were
// measured; `web/CLAUDE.md` holds the numbers. Installing changes neither —
// installation is not a permission grant, and the checks happen per REQUEST
// against the same origin a tab would have.
//
// So this hub does the one thing that is not blocked: it NAVIGATES. Tapping a
// desktop leaves for that desktop's address, where the live session runs
// exactly as it does today. In a standalone window that opens as a browser
// tab, which is the visible seam of the whole design and is not worth hiding.
//
// What the QR scanner is FOR, given the camera app also opens links: the
// public-link tier's token is fresh every session and is never saved, so it is
// the one address that cannot be a bookmark. Scanning it into the list is the
// only fast way to take it. A saved private address, by contrast, stays valid
// until the desktop rotates its token — which is exactly what rotating is for.

import { withStore } from "./db.js";

const STORE_NAME = "desktops";

/** A scanned or pasted string, turned into something worth saving — or null.
 *
 * Kept strict on PURPOSE: this list is tapped later, from a menu, with no
 * address bar to read. Anything but a plain web address would be navigating
 * somewhere the user cannot see they are going. */
export function parseDesktopLink(text) {
  let url;
  try {
    url = new URL(String(text || "").trim());
  } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  // The share address is `<host>/<token>/`, and the trailing slash matters —
  // without it the server redirects, and every relative URL in the app would
  // resolve one level too high if it did not.
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  url.hash = "";
  return { id: url.toString(), url: url.toString(), label: labelFor(url) };
}

/** What to call a machine we only know by address.
 *
 * A tailnet name (`thinkpad.tailnet.ts.net`) already IS the machine's name, so
 * the first label is the useful one. A bare IP has no name to take, and saying
 * `192.168.1.5` back is more honest than inventing "My computer". */
function labelFor(url) {
  const host = url.hostname;
  if (/^[0-9.]+$/.test(host) || host.includes(":")) return host;
  return host.split(".")[0] || host;
}

export async function listDesktops() {
  try {
    const all = await withStore(STORE_NAME, "readonly", (s) => s.getAll());
    return (all || []).sort((a, b) => (b.at || 0) - (a.at || 0));
  } catch { return []; }
}

export async function rememberDesktop(entry) {
  try {
    await withStore(STORE_NAME, "readwrite",
                    (s) => s.put({ ...entry, at: Date.now() }));
  } catch (err) { console.warn("could not save the desktop", err); }
}

export async function forgetDesktop(id) {
  try {
    await withStore(STORE_NAME, "readwrite", (s) => s.delete(id));
  } catch (err) { console.warn("could not forget the desktop", err); }
}

// ── the camera ───────────────────────────────────────────────────────────────

/** `BarcodeDetector` is native on Android Chrome, and absent elsewhere.
 *
 * ONE capability check and no second code path, the same shape as File System
 * Access — where there is no detector the panel offers a paste box instead,
 * which is a worse gesture but the same feature. A vendored decoder would be
 * another 40 kB carried by every visitor for a button most never press. */
export function canScan() {
  return typeof window !== "undefined" && "BarcodeDetector" in window &&
         !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

/** Run the camera until a QR code resolves to a link, or `stop()` is called.
 *
 * The loop is a `setTimeout` rather than `requestAnimationFrame`: detection is
 * the expensive part and 60 attempts a second buys nothing over 8, while a
 * phone holding a camera open is spending battery either way. */
export function startScanner({ video, onFound, onError }) {
  let stream = null;
  let stopped = false;
  let timer = null;

  (async () => {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (!formats.includes("qr_code")) throw new Error("no QR support");
      const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" }, audio: false,
      });
      if (stopped) { closeStream(stream); return; }
      video.srcObject = stream;
      await video.play();
      const tick = async () => {
        if (stopped) return;
        try {
          const codes = await detector.detect(video);
          for (const code of codes) {
            const parsed = parseDesktopLink(code.rawValue);
            if (parsed) { onFound(parsed); return; }
          }
        } catch { /* a frame that cannot be read is not a failure */ }
        timer = setTimeout(tick, 120);
      };
      tick();
    } catch (err) {
      if (!stopped && onError) onError(err);
    }
  })();

  return function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    // The track outlives the element, and a camera left running is a light
    // left on: the phone shows the recording indicator until the tab is closed.
    closeStream(stream);
    stream = null;
    try { video.srcObject = null; } catch { /* already gone */ }
  };
}

function closeStream(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try { track.stop(); } catch { /* already stopped */ }
  }
}
