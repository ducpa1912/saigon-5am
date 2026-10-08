/**
 * Minimal static file server for local verification.
 * Usage: node tools/serve.mjs [port]
 *
 * Gzip is enabled on purpose. Every free static host (Netlify, Cloudflare Pages,
 * Vercel, GitHub Pages) compresses text responses, so serving uncompressed here
 * would make Lighthouse measure a payload no real visitor ever downloads and
 * would understate FCP/LCP by hundreds of milliseconds.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.argv[2] || 8099);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
};

const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg", ".map"]);

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.join(ROOT, rel);

    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404, { "content-type": "text/plain" }).end("404 " + rel);
        return;
      }
      const ext = path.extname(file);
      const type = MIME[ext] || "application/octet-stream";
      const headers = {
        "content-type": type,
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      };

      const accepts = String(req.headers["accept-encoding"] || "");
      if (COMPRESSIBLE.has(ext) && /gzip/.test(accepts) && buf.length > 512) {
        zlib.gzip(buf, (zerr, gz) => {
          if (zerr) {
            res.writeHead(200, headers).end(buf);
            return;
          }
          headers["content-encoding"] = "gzip";
          headers["content-length"] = gz.length;
          res.writeHead(200, headers).end(gz);
        });
        return;
      }
      res.writeHead(200, headers).end(buf);
    });
  })
  .listen(PORT, () => console.log(`serving ${ROOT} on http://localhost:${PORT} (gzip on)`));