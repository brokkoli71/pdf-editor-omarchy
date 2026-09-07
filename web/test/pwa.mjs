// The installed app: the offline shell's file list, the manifest, and the one
// place the service worker must NOT go.
//
// Three failures this catches, all of them silent in a browser:
//
//   * A new module lands in `src/` and nobody adds it to `sw.js`. The app then
//     works perfectly until it is offline, which is the one place nobody tests
//     and the whole reason the worker exists.
//   * `sw.js` and `pwa.js` disagree about where a shared file waits between the
//     POST and the app reading it. Sharing then succeeds and opens nothing.
//   * The worker registers in LIVE mode. It would scope itself to a DESKTOP's
//     share token, outlive that session, and answer the next one out of a cache
//     of the last — with somebody else's document in it.
//
//   node web/test/pwa.mjs

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let checks = 0, failures = 0;
const ok = (name, cond, detail = "") => {
  checks++;
  if (!cond) { failures++; console.error(`  ✗ ${name}${detail ? ": " + detail : ""}`); }
};

// ── the precache list covers the app ────────────────────────────────────────
const sw = readFileSync(join(root, "sw.js"), "utf8");
const precache = new Set(
  [...sw.matchAll(/^\s*"(\.\/[^"]*)",$/gm)].map((m) => m[1]));
ok("sw.js has a precache list", precache.size > 10, `found ${precache.size} entries`);

for (const dir of ["src", "vendor"]) {
  for (const file of readdirSync(join(root, dir))) {
    ok(`sw.js precaches ${dir}/${file}`, precache.has(`./${dir}/${file}`),
       "add it to PRECACHE in web/sw.js, or the app breaks only when offline");
  }
}
for (const file of ["./", "./index.html", "./manifest.webmanifest",
                    "./icon-512.png"]) {
  ok(`sw.js precaches ${file}`, precache.has(file));
}
// The other direction: a listed file that no longer exists fails the install
// silently (it is caught per entry on purpose, so the app still works).
for (const url of precache) {
  if (url === "./") continue;
  const rel = url.slice(2);
  let there = true;
  try { readFileSync(join(root, rel)); } catch { there = false; }
  ok(`precached ${url} exists`, there, "remove it from PRECACHE");
}

// ── the worker never answers for a live session ─────────────────────────────
// These live one level ABOVE the app directory, so they are outside the
// worker's scope and never reach it — the check is that they stay that way.
for (const path of ["live.pdf", "page.pdf", "state", "ws", "doc.pdf"]) {
  ok(`sw.js does not precache ${path}`,
     ![...precache].some((u) => u.endsWith("/" + path)),
     "a live session belongs to another machine and is never persisted here");
}

// ── sw.js and pwa.js agree about the share-target handoff ───────────────────
const pwa = readFileSync(join(root, "src", "pwa.js"), "utf8");
const cacheName = (text) => (text.match(/HANDOFF\s*=\s*"([^"]+)"/) || [])[1];
const indexPath = (text) => (text.match(/HANDOFF_INDEX\s*=\s*"([^"]+)"/) || [])[1];
ok("the handoff cache has one name",
   cacheName(sw) && cacheName(sw) === cacheName(pwa),
   `sw.js ${cacheName(sw)} vs pwa.js ${cacheName(pwa)}`);
ok("the handoff index has one path",
   indexPath(sw) && indexPath(sw) === indexPath(pwa),
   `sw.js ${indexPath(sw)} vs pwa.js ${indexPath(pwa)}`);
ok("the worker redirects a share to a page the app reads",
   /\?shared=1/.test(sw) && /has\("shared"\)/.test(pwa));

// ── the manifest ────────────────────────────────────────────────────────────
const manifest = JSON.parse(readFileSync(join(root, "manifest.webmanifest"), "utf8"));
// Relative throughout, so ONE file serves the app wherever it is hosted — the
// Pages copy under /sidemark/ and a desktop's copy under its share token.
for (const key of ["start_url", "scope"]) {
  ok(`manifest ${key} is relative`, String(manifest[key]).startsWith("."),
     `${key} is ${manifest[key]}`);
}
ok("manifest is standalone", manifest.display === "standalone");
ok("share_target action is inside the scope",
   String(manifest.share_target.action).startsWith("./"));
ok("share_target posts files",
   manifest.share_target.method === "POST" &&
   manifest.share_target.enctype === "multipart/form-data" &&
   manifest.share_target.params.files[0].name === "files");
ok("the worker reads the field share_target names",
   sw.includes(`getAll("${manifest.share_target.params.files[0].name}")`));
ok("the worker answers the share_target action",
   sw.includes(manifest.share_target.action.replace("./", "/")));
for (const icon of manifest.icons) {
  let there = true;
  try { readFileSync(join(root, icon.src)); } catch { there = false; }
  ok(`icon ${icon.src} exists`, there);
}
ok("index.html links the manifest",
   readFileSync(join(root, "index.html"), "utf8")
     .includes('rel="manifest" href="manifest.webmanifest"'));

// ── registration refuses live and sandbox ───────────────────────────────────
const { registerServiceWorker } = await import("../src/pwa.js");

function withEnv(href, run) {
  const registered = [];
  const listeners = [];
  const fake = {
    serviceWorker: { register: (url, opts) => { registered.push([url, opts]); return Promise.resolve(); } },
  };
  const prev = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: fake, configurable: true });
  globalThis.location = new URL(href);
  // What the platform actually gates on. https, localhost and the loopback
  // addresses are all secure; everything else is not.
  const u = new URL(href);
  globalThis.isSecureContext =
    u.protocol === "https:" ||
    ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  globalThis.window = {
    addEventListener: (name, fn) => listeners.push([name, fn]),
    isSecureContext: globalThis.isSecureContext,
  };
  globalThis.addEventListener = globalThis.window.addEventListener;
  try {
    run();
    // registration is deferred to `load`, so fire it
    for (const [name, fn] of listeners) if (name === "load") fn();
  } finally {
    if (prev) Object.defineProperty(globalThis, "navigator", prev);
    else delete globalThis.navigator;
  }
  return registered;
}

ok("registers on https",
   withEnv("https://brokkoli71.github.io/sidemark/",
           () => registerServiceWorker({})).length === 1);
ok("registers with the app's own directory as its scope",
   withEnv("https://brokkoli71.github.io/sidemark/",
           () => registerServiceWorker({}))[0][1].scope === "./");
{
  const live = withEnv("https://laptop.tailnet.ts.net:8443/tok/app/",
                       () => registerServiceWorker({ live: true }));
  ok("registers in live mode too, so a desktop copy can be installed",
     live.length === 1);
  ok("the live worker is FLAGGED as live",
     live.length === 1 && /\?live=1/.test(live[0][0]),
     "without the flag it would cache-first a checkout somebody is editing");
  ok("the live worker is scoped to the app directory, never the token root",
     live.length === 1 && live[0][1].scope === "./",
     "a wider scope would put ../state and ../live.pdf inside it");
}
ok("the worker's live flavour is network-first",
   /LIVE\s*\?\s*networkFirst/.test(sw),
   "a cache-first live worker serves app code the checkout has moved past");
ok("the live flavour precaches nothing",
   /if \(LIVE\) return;/.test(sw));
ok("never registers in a sandbox",
   withEnv("https://brokkoli71.github.io/sidemark/",
           () => registerServiceWorker({ sandbox: true })).length === 0);
ok("never registers over plain http, live or not",
   withEnv("http://192.168.1.5:8756/tok/app/",
           () => registerServiceWorker({ live: true })).length === 0,
   "a LAN address is not a secure context — which is why the share dialog "
   + "has a `tailscale serve` tier at all");
ok("registers on localhost, which IS a secure context",
   withEnv("http://localhost:8000/", () => registerServiceWorker({})).length === 1);
ok("registers on 127.0.0.1, which is secure too",
   withEnv("http://127.0.0.1:8321/", () => registerServiceWorker({})).length === 1,
   "a hand-rolled hostname check leaves the loopback address out");

// ── what a scanned code is allowed to be ────────────────────────────────────
const { parseDesktopLink } = await import("../src/desktops.js");

const good = parseDesktopLink("http://192.168.1.5:8756/abc123");
ok("a share link parses", !!good);
ok("a missing trailing slash is added", good && good.url.endsWith("/"),
   good && good.url);
ok("a bare address is labelled by its host",
   good && good.label === "192.168.1.5", good && good.label);
ok("a tailnet name is labelled by the machine",
   parseDesktopLink("https://thinkpad.tailnet.ts.net/abc/").label === "thinkpad");
ok("a fragment is dropped",
   !parseDesktopLink("https://a.ts.net/t/#x").url.includes("#"));
ok("whitespace around a pasted link is ignored",
   !!parseDesktopLink("  https://a.ts.net/t/  "));
for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "not a url",
                   "", null, "data:text/html,<b>hi", "sidemark://x"]) {
  ok(`refuses ${JSON.stringify(bad)}`, parseDesktopLink(bad) === null);
}

if (failures) {
  console.error(`\n✗ ${failures} of ${checks} PWA checks failed.`);
  process.exit(1);
}
console.log(`✓ ${checks} PWA checks passed (shell, manifest, share target, links).`);
