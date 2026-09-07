// The installed app's offline shell, and the Android share sheet's landing pad.
//
// Registered by `src/pwa.js` from the page, so its SCOPE is the directory the
// app is served from — `/sidemark/` on GitHub Pages. Everything below is
// written relative to that, so the same file works wherever the app is hosted.
//
// TWO THINGS IT MUST NEVER DO, both of which would be silent:
//
//   * Cache a LIVE session's data. `../state`, `../live.pdf`, `../page.pdf`
//     and `../ws` are somebody else's open document, and live mode's rule is
//     that nothing is persisted in this browser. They sit one level ABOVE the
//     app directory, so they are outside this scope and never reach us at all
//     — unreachable by construction rather than by a rule anyone has to keep.
//   * Serve a shell newer or older than the modules it loads. There is no
//     `skipWaiting()` here on purpose: pdf.js's worker is fetched lazily, so a
//     worker swapped in under a running page could answer that fetch from a
//     different deploy than the page came from. An update takes effect at the
//     next launch, which is the ordinary PWA contract.
//
// TWO FLAVOURS, one file. `pwa.js` registers this as `sw.js?live=1` when the
// page is a phone attached to a desktop, and the difference is the CACHING
// STRATEGY, not the rules:
//
//   * Hosted (GitHub Pages): precache the whole app, then cache-first. A
//     launch is instant and works with no network, and a deploy arrives one
//     launch later.
//   * Live (served by a desktop): network-first, no precache. The desktop
//     serves `web/` straight off the disk of a checkout somebody may be
//     editing — the server's short max-age exists for exactly that — so a
//     cache-first worker there would hand the phone yesterday's app and make
//     an edit look like it had not landed. The network is a LAN or a tailnet
//     hop away and the server answers with an ETag, so first-asking costs a
//     304. The cache is only the answer for a desktop that has gone away.

const LIVE = new URL(self.location.href).searchParams.has("live");

const VERSION = "1";
const SHELL = `sidemark-shell-v${VERSION}`;
// Kept OUT of the versioned name: a file arriving from the share sheet must
// survive the update that may be installing while the user shares.
const HANDOFF = "sidemark-handoff";

/** Where a shared file waits between the POST and the app reading it. */
const HANDOFF_INDEX = "./_shared/index.json";

/** The whole app, precached on install so a launch with no network works.
 *
 * It is an EXPLICIT list rather than something derived, because a service
 * worker cannot read a directory — and it is checked against the directory by
 * `test/pwa.mjs`, which is the part that matters: the way this breaks is a new
 * module landing in `src/` and nobody remembering this file exists. That fails
 * only offline, which is exactly where nobody tests.
 *
 * `vendor/` is 3.7 MB of it. That is the cost of an app that opens a PDF on a
 * train, and it is paid once at install. */
const PRECACHE = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-32.png",
  "./icon-180.png",
  "./icon-512.png",
  "./demo.html",
  "./demo/handout.pdf",
  "./demo/lecture.pdf",
  "./src/anchors.js",
  "./src/app.js",
  "./src/bindings.js",
  "./src/clipboard.js",
  "./src/db.js",
  "./src/demo.css",
  "./src/demo.js",
  "./src/desktops.js",
  "./src/doc.js",
  "./src/draw.js",
  "./src/images.js",
  "./src/ink.js",
  "./src/inkpdf.js",
  "./src/lasso.js",
  "./src/mathrender.js",
  "./src/merge.js",
  "./src/notes-model.js",
  "./src/notes.js",
  "./src/presenter.js",
  "./src/pwa.js",
  "./src/recent.js",
  "./src/save.js",
  "./src/search.js",
  "./src/session.js",
  "./src/shapes.js",
  "./src/sidebar.js",
  "./src/style.css",
  "./src/surface.js",
  "./src/textlayer.js",
  "./vendor/codemirror-entry.js",
  "./vendor/codemirror.js",
  "./vendor/pdf-lib.esm.js",
  "./vendor/pdf.min.mjs",
  "./vendor/pdf.worker.min.mjs",
];

self.addEventListener("install", (event) => {
  // Nothing is precached in live mode: the page has already loaded everything
  // it needs from the desktop, and pulling 4 MB a second time over somebody's
  // phone connection to duplicate it would be the whole cost of the feature
  // for none of its benefit. The runtime cache fills itself from what is
  // actually fetched.
  if (LIVE) return;
  // `cache.add` per entry rather than `addAll`, which rejects the WHOLE
  // install if any single file 404s — one renamed asset would then leave the
  // app with no offline copy at all and no clue which file did it.
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await Promise.all(PRECACHE.map((url) => cache.add(url).catch((err) => {
      console.warn("sw: could not precache", url, err);
    })));
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name !== SHELL && name !== HANDOFF && name.startsWith("sidemark-")) {
        await caches.delete(name);
      }
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // The share sheet's POST is the one non-GET this worker answers.
  if (req.method === "POST" && url.pathname.endsWith("/share-target")) {
    event.respondWith(receiveShare(req));
    return;
  }
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  // A navigation is always the app shell: `start_url`, a file handler's launch
  // and a share-target redirect all land on the same page.
  if (req.mode === "navigate") {
    event.respondWith(shellOrNetwork(req));
    return;
  }
  event.respondWith(LIVE ? networkFirst(req) : staleWhileRevalidate(req));
});

/** Ask the desktop every time, and fall back to what we have.
 *
 * The inverse trade from the hosted copy, for the inverse reason — see the
 * header. What it buys is that a cache here can never disagree with the
 * checkout being served. */
async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    if (res && res.ok && res.type === "basic") cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req, { ignoreSearch: true });
    return hit || new Response("The computer sharing this is not reachable",
                               { status: 504 });
  }
}

/** Cache first, then refresh in the background.
 *
 * The trade is deliberate: a launch is instant and works offline, and a deploy
 * arrives one launch later. Network-first would make every start wait on a
 * round trip to be one launch fresher, which is the wrong way round for an app
 * whose whole point is that it opens. */
async function staleWhileRevalidate(req) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(req, { ignoreSearch: true });
  const network = fetch(req).then((res) => {
    if (res && res.ok && res.type === "basic") cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  if (hit) return hit;
  const res = await network;
  if (res) return res;
  return new Response("Offline and not cached", { status: 504 });
}

async function shellOrNetwork(req) {
  const cache = await caches.open(SHELL);
  const fresh = await fetch(req).catch(() => null);
  if (fresh && fresh.ok) {
    cache.put("./index.html", fresh.clone());
    return fresh;
  }
  return (await cache.match("./index.html")) ||
         (await cache.match("./")) ||
         new Response("Offline", { status: 504 });
}

/** Take the files Android handed us and park them for the app to collect.
 *
 * The Cache API rather than IndexedDB ON PURPOSE: `src/db.js` owns the one
 * database and its one version number, and a second opener here — in a worker
 * that updates on its own schedule — is exactly the mismatch that file exists
 * to prevent. A cache has no schema to disagree about.
 *
 * The response is a REDIRECT, because the POST's own URL is not a page: the
 * app has to be reached by a GET it can reload, or a refresh re-posts. */
async function receiveShare(req) {
  const to = new URL("./?shared=1", self.location).toString();
  try {
    const form = await req.formData();
    const files = form.getAll("files").filter((f) => f && f.name);
    const cache = await caches.open(HANDOFF);
    const index = [];
    for (let i = 0; i < files.length; i++) {
      const key = `./_shared/${i}`;
      await cache.put(key, new Response(files[i]));
      index.push({ key, name: files[i].name, type: files[i].type || "" });
    }
    await cache.put(HANDOFF_INDEX, new Response(JSON.stringify(index),
      { headers: { "Content-Type": "application/json" } }));
  } catch (err) {
    console.warn("sw: share target failed", err);
  }
  return Response.redirect(to, 303);
}
