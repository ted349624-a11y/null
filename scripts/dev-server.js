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

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://local");
  const host = String(req.headers.host || "");
  const m = /^\/api\/([a-z-]+)$/.exec(url.pathname);
  if (m) {
    const file = path.join(apiDir, m[1] + ".js");
    if (!fs.existsSync(file)) { res.statusCode = 404; return res.end("not found"); }
    return require(file)(req, res);
  }
  let p = url.pathname;
  if (p === "/") p = host.startsWith("testnet.") ? "/app.html" : "/quests.html";
  else if (p === "/app") p = "/app.html";
  const file = path.join(root, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end("not found"); }
  res.setHeader("content-type", types[path.extname(file)] || "application/octet-stream");
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`dev server on http://localhost:${port} (testnet app: http://testnet.localhost:${port})`));
