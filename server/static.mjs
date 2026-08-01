import path from "node:path";
import { fileURLToPath } from "node:url";
import { constants as zlibConstants } from "node:zlib";
import compression from "compression";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "site");
const compressStatic = compression({
  threshold: 1_024,
  brotli: {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
    },
  },
});
const PRIVATE_ROBOTS = "User-agent: *\nDisallow: /\n";
const FILES = Object.freeze({
  "/styles/marketing.css": "styles/marketing.css",
  "/styles/shared.css": "styles/shared.css",
  "/styles/workspace.css": "styles/workspace.css",
  "/assets/vector-mark.svg": "assets/vector-mark.svg",
  "/assets/vector-lockup.svg": "assets/vector-lockup.svg",
  "/assets/social-preview.png": "assets/social-preview.png",
  "/app/": "app/index.html",
  "/app/index.html": "app/index.html",
  "/app/api-client.mjs": "app/api-client.mjs",
  "/app/core.mjs": "app/core.mjs",
  "/app/workspace-domain.mjs": "app/workspace-domain.mjs",
  "/app/workspace-programmes.mjs": "app/workspace-programmes.mjs",
  "/app/workspace-ui.mjs": "app/workspace-ui.mjs",
  "/app/workspace.mjs": "app/workspace.mjs",
});

export function registerStaticRoutes(app) {
  app.get("/", (_request, response) => response.redirect(302, "/app/"));
  app.get("/index.html", (_request, response) => response.redirect(302, "/app/"));
  app.get("/app", (_request, response) => response.redirect(308, "/app/"));
  // The checked-in robots.txt belongs to the public GitHub Pages product tour.
  // A self-hosted installation is an operational workspace and must not advertise
  // that public sitemap or invite crawlers onto its private origin.
  app.get("/robots.txt", (_request, response) => {
    response
      .type("text/plain; charset=utf-8")
      .set("Cache-Control", "no-cache")
      .send(PRIVATE_ROBOTS);
  });
  for (const [url, relativePath] of Object.entries(FILES)) {
    app.get(url, compressStatic, (_request, response, next) => {
      response.set(
        "Cache-Control",
        "no-cache",
      );
      response.sendFile(path.join(ROOT, relativePath), {
        dotfiles: "deny",
        acceptRanges: false,
      }, (error) => {
        if (error) next(error);
      });
    });
  }
}
