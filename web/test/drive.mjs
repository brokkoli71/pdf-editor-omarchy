// Drive the real app in headless Chromium over CDP and ask the live model what
// happened. node's global WebSocket, so no dependencies.
const BASE = "http://127.0.0.1:9222";

async function target() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`${BASE}/json`)).json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("no debuggable page");
}

const t = await target();
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));

let id = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
function send(method, params = {}) {
  const n = ++id;
  return new Promise((res) => { pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
}

async function evalJs(expr) {
  const r = await send("Runtime.evaluate", {
    expression: `(async () => { ${expr} })()`,
    awaitPromise: true, returnByValue: true,
  });
  if (r.result?.exceptionDetails) {
    throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description
                                   || r.result.exceptionDetails));
  }
  return r.result?.result?.value;
}

await send("Page.enable");
await send("Runtime.enable");
// Chrome will re-serve index.html from its memory cache across navigations to
// the same URL, so an edit you just made is invisible and the probe fails on an
// element that IS in the file. Never debug that twice.
await send("Network.enable");
await send("Network.setCacheDisabled", { cacheDisabled: true });
const url = process.argv[2] || "http://127.0.0.1:8321/index.html";
await send("Page.navigate", { url });
await new Promise((r) => setTimeout(r, 4000));

const out = await evalJs(process.argv[3] || "return 'no script'");
console.log(JSON.stringify(out, null, 1));
ws.close();
process.exit(0);
