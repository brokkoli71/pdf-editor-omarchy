// pdf.js carries a Node.js code path (fs/http/https/url) that a browser never
// takes. esbuild still has to resolve it, so it is pointed here: an empty
// module, which is exactly what those imports are worth in a browser.
export default {};
