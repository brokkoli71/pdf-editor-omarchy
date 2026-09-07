// Sidemark as an INSTALLED app: the offline shell, the Android share sheet, and
// "open with Sidemark".
//
// All three are the same manifest doing three jobs, and none of them changes
// what the app can reach over the network. Installing is not a permission
// grant: the origin is the same in a standalone window as in a tab, so an
// installed copy served from GitHub Pages still cannot talk to a desktop's
// share server (mixed content on a LAN address, Local Network Access on a
// tailnet one — both measured, see `web/CLAUDE.md`). The desktop is reached by
// NAVIGATING to it, which is what `desktops.js` does.
//
// This module is deliberately DOM-free, and it imports NOTHING from `app.js` —
// the mode flags are passed in. `app.js` is the top of the module graph and a
// cycle back into it would be the one import order this port cannot reason
// about; the flags stay defined in exactly one place either way.

const HANDOFF = "sidemark-handoff";
const HANDOFF_INDEX = "./_shared/index.json";

/** Put the service worker on this origin — or deliberately do not.
 *
 * A SECURE ORIGIN ONLY, which is the whole shape of this feature. Registration
 * throws on a plain-http page, so the LAN and tailnet-http share tiers get no
 * worker and cannot be installed; the desktop's `tailscale serve` address can,
 * because it carries a real certificate. That is not a policy here — it is the
 * platform, and it is why that share tier exists.
 *
 * LIVE MODE REGISTERS A DIFFERENT WORKER, flagged in the script URL. A phone
 * attached to a desktop runs these same files under that desktop's token path,
 * and two things must hold there: the worker must never serve app code a
 * checkout has moved on from (network-first, so an edited `web/` is picked up
 * on the next load, not the one after), and it must never touch the session's
 * own data. `../state`, `../live.pdf`, `../page.pdf` and `../ws` sit one level
 * ABOVE the app directory the worker is scoped to, so they are unreachable
 * from it by construction rather than by a rule someone has to keep.
 *
 * Not in a SANDBOX for the reason the sandbox exists at all: the tour must
 * cost the visitor nothing it did not ask for, and an installed app is not
 * nothing. */
export function registerServiceWorker({ live, sandbox } = {}) {
  if (sandbox) return;
  if (!("serviceWorker" in navigator)) return;
  // `isSecureContext`, not a protocol test: registration throws on a `file://`
  // or plain-http page, and the set of origins the platform treats as secure
  // is wider than "https" — 127.0.0.1 and ::1 are in it, and a hand-rolled
  // hostname check quietly left them out.
  if (!window.isSecureContext) return;
  const script = live ? "sw.js?live=1" : "sw.js";
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(script, { scope: "./" })
      .catch((err) => console.warn("service worker did not register", err));
  });
}

/** True when this load is the landing after something was shared INTO us. */
export function isSharedLaunch() {
  return new URLSearchParams(location.search).has("shared");
}

/** Collect what the share sheet handed the service worker, exactly once.
 *
 * Emptied as it is read, and the query parameter is stripped, because both
 * halves are how a reload re-opens files the user shared minutes ago. */
export async function takeSharedFiles() {
  const url = new URL(location.href);
  url.searchParams.delete("shared");
  history.replaceState(null, "", url);
  if (!("caches" in self)) return [];
  try {
    const cache = await caches.open(HANDOFF);
    const res = await cache.match(HANDOFF_INDEX);
    if (!res) return [];
    const index = await res.json();
    const files = [];
    for (const entry of index) {
      const hit = await cache.match(entry.key);
      if (!hit) continue;
      const blob = await hit.blob();
      files.push(new File([blob], entry.name, { type: entry.type || blob.type }));
      await cache.delete(entry.key);
    }
    await cache.delete(HANDOFF_INDEX);
    return files;
  } catch (err) {
    console.warn("could not read the shared files", err);
    return [];
  }
}

/** "Open with Sidemark" from the file manager.
 *
 * The launch carries HANDLES, not bytes, which is the whole prize: a document
 * opened this way can be saved back in place with no second gesture, the same
 * as one opened through the picker. */
export function consumeLaunchFiles(open) {
  if (!("launchQueue" in window)) return;
  try {
    window.launchQueue.setConsumer(async (params) => {
      if (!params || !params.files || !params.files.length) return;
      const items = [];
      for (const handle of params.files) {
        try {
          const file = await handle.getFile();
          items.push({ file, handle });
        } catch (err) { console.warn("could not read a launched file", err); }
      }
      if (items.length) open(items);
    });
  } catch (err) {
    console.warn("launchQueue is present but refused a consumer", err);
  }
}

// ── the install prompt ───────────────────────────────────────────────────────
//
// Chrome fires `beforeinstallprompt` when it decides the app is installable and
// then does nothing unless we keep the event: it can only be used once, from a
// real gesture, and it never fires again in that page. So it is stashed, and
// the menu entry appears only while there is one to fire.

let deferred = null;
let onAvailability = null;

export function watchInstallPrompt(cb) {
  onAvailability = cb;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();          // or Chrome shows its own bar instead of ours
    deferred = e;
    if (onAvailability) onAvailability(true);
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    if (onAvailability) onAvailability(false);
  });
  cb(false);
}

export function canInstall() {
  return deferred !== null;
}

/** Fire the stashed prompt. Resolves to true if the app was installed.
 *
 * The event is spent whichever way the user answers — a dismissal does not
 * hand it back — so the entry goes away either way, and Chrome will offer a
 * new one on a later visit if it still thinks the app is worth installing. */
export async function promptInstall() {
  if (!deferred) return false;
  const event = deferred;
  deferred = null;
  if (onAvailability) onAvailability(false);
  try {
    event.prompt();
    const choice = await event.userChoice;
    return choice && choice.outcome === "accepted";
  } catch (err) {
    console.warn("the install prompt failed", err);
    return false;
  }
}

/** Already running as an installed app, rather than in a browser tab. */
export function isInstalled() {
  return matchMedia("(display-mode: standalone)").matches ||
         matchMedia("(display-mode: window-controls-overlay)").matches ||
         navigator.standalone === true;
}
