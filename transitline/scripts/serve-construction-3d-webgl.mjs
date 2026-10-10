// Local-only WebGL preview server. Unity's compressed artifacts need their
// Content-Encoding header; a generic file server often omits it and creates a
// false browser failure. This server is never part of the game runtime.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(process.argv[2] ?? path.join(projectRoot, "unity-construction-client", "Build", "WebGL"));
const port = Number.parseInt(process.argv[3] ?? "4173", 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("WebGL preview port must be an integer from 1 to 65535.");
const mime = Object.freeze({ ".css": "text/css; charset=utf-8", ".data": "application/octet-stream", ".html": "text/html; charset=utf-8", ".ico": "image/x-icon", ".js": "application/javascript; charset=utf-8", ".png": "image/png", ".wasm": "application/wasm" });
const requestPath = (url) => {
  const pathname = new URL(url ?? "/", "http://localhost").pathname;
  const target = path.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
  return target === root || target.startsWith(`${root}${path.sep}`) ? target : null;
};
http.createServer(async (request, response) => {
  const target = requestPath(request.url);
  if (!target) { response.writeHead(403); response.end(); return; }
  try {
    const body = await readFile(target);
    const extension = path.extname(target.replace(/\.gz$/i, "")).toLowerCase();
    response.setHeader("Content-Type", mime[extension] ?? "application/octet-stream");
    if (target.toLowerCase().endsWith(".gz")) response.setHeader("Content-Encoding", "gzip");
    response.setHeader("Cache-Control", "no-store");
    response.writeHead(200); response.end(body);
  } catch (error) {
    response.writeHead(error?.code === "ENOENT" ? 404 : 500); response.end();
  }
}).listen(port, "127.0.0.1", () => console.log(`Unity WebGL preview: http://127.0.0.1:${port}/`));
