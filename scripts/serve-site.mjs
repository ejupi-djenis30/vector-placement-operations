import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const PORT = 4173;
const PAGE_PATH = "/vector-placement-operations/";
const SITE_ROOT = fileURLToPath(new URL("../site/", import.meta.url));
const SITE_PREFIX = SITE_ROOT.endsWith(sep) ? SITE_ROOT : SITE_ROOT + sep;
const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
]);

function send(response, status, body) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

const server = createServer(async (request, response) => {
  if (!["GET", "HEAD"].includes(request.method ?? "")) {
    send(response, 405, "Method not allowed");
    return;
  }

  try {
    const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
    const pathname = decodeURIComponent(url.pathname);
    if (!pathname.startsWith(PAGE_PATH)) {
      send(response, 404, "Not found");
      return;
    }
    const pageRelativePath = pathname.slice(PAGE_PATH.length);
    const relativePath = pageRelativePath === "" ? "index.html" : pageRelativePath;
    const filePath = resolve(SITE_ROOT, relativePath);
    if (!filePath.startsWith(SITE_PREFIX)) {
      send(response, 403, "Forbidden");
      return;
    }

    const metadata = await stat(filePath);
    if (!metadata.isFile()) {
      send(response, 404, "Not found");
      return;
    }

    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Length": metadata.size,
      "Content-Type": CONTENT_TYPES.get(extname(filePath)) ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(filePath).pipe(response);
  } catch {
    send(response, 404, "Not found");
  }
});

server.on("clientError", (_error, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});

server.listen(PORT, HOST, () => {
  console.log(`VECTOR test server listening on http://${HOST}:${PORT}`);
});
