// Local stand-in for Vercel: serves frontend/ with the same rewrites as vercel.json and runs /api/* handlers.
// Points are kept in memory (NULL_DEV=1). Usage: node scripts/dev-server.js [port] [frontendDir]
process.env.NULL_DEV = "1";
const http = require("http");
const fs = require("fs");
const path = require("path");

const port = Number(process.argv[2] || 8095);
const root = path.resolve(process.argv[3] || path.join(__dirname, "../frontend"));
const apiDir = path.join(__dirname, "../api");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".txt": "text/plain" };

// The plain rewrites of vercel.json (":name" segments allowed; host-conditioned ones are handled below).
const rewrites = (JSON.parse(fs.readFileSync(path.join(__dirname, "../vercel.json"), "utf8")).rewrites || [])
  .filter((r) => !r.has && r.source !== "/")
  .map((r) => ({ re: new RegExp("^" + r.source.replace(/:[a-z]+/gi, "[^/]+") + "$"), dest: r.destination }));

const redirects = (JSON.parse(fs.readFileSync(path.join(__dirname, "../vercel.json"), "utf8")).redirects || []).map((r) => ({
  re: new RegExp("^" + r.source.replace("/:path*", "(?:/(.*))?").replace(/:[a-z]+/gi, "[^/]+") + "$"),
  host: (r.has || []).find((h) => h.type === "host")?.value?.replace(/\.nullfamily\.fun$/, "."),
  dest: r.destination,
}));

http.createServer(async (req, res) => {
  let url = new URL(req.url, "http://local");
  const reqHost = String(req.headers.host || "");
  const rd = redirects.find((r) => r.re.test(url.pathname) && (!r.host || reqHost.startsWith(r.host)));
  if (rd) {
    const rest = (rd.re.exec(url.pathname) || [])[1] || "";
    const dest = rd.dest.replace(":path*", rest).replace("https://nullfamily.fun", "http://localhost:" + port);
    res.writeHead(307, { location: dest });
    return res.end();
  }
  const rw = rewrites.find((r) => r.re.test(url.pathname));
  if (rw) {
    const d = new URL(rw.dest, "http://local");
    url.searchParams.forEach((v, k) => { if (!d.searchParams.has(k)) d.searchParams.set(k, v); });
    req.url = d.pathname + d.search;
    url = d;
  }
  const host = String(req.headers.host || "");
  const m = /^\/api\/([a-z-]+)$/.exec(url.pathname);
  if (m) {
    const file = path.join(apiDir, m[1] + ".js");
    if (!fs.existsSync(file)) { res.statusCode = 404; return res.end("not found"); }
    return require(file)(req, res);
  }
  let p = url.pathname;
  if (p === "/") p = "/index.html";
  const file = path.join(root, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end("not found"); }
  res.setHeader("content-type", types[path.extname(file)] || "application/octet-stream");
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`dev server on http://localhost:${port}`));
