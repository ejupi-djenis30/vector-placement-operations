import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "site");
const FILES = Object.freeze({
  "/styles.css": "styles.css",
  "/app.mjs": "app.mjs",
  "/robots.txt": "robots.txt",
  "/assets/vector-mark.svg": "assets/vector-mark.svg",
  "/assets/vector-lockup.svg": "assets/vector-lockup.svg",
  "/assets/social-preview.png": "assets/social-preview.png",
  "/app/": "app/index.html",
  "/app/index.html": "app/index.html",
  "/app/workspace.mjs": "app/workspace.mjs",
});

export function registerStaticRoutes(app) {
  app.get("/", (_request, response) => response.redirect(302, "/app/"));
  app.get("/index.html", (_request, response) => response.redirect(302, "/app/"));
  app.get("/app", (_request, response) => response.redirect(308, "/app/"));
  for (const [url, relativePath] of Object.entries(FILES)) {
    app.get(url, (_request, response, next) => {
      response.set(
        "Cache-Control",
        relativePath.endsWith(".html") ? "no-cache" : "public, max-age=300, must-revalidate",
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
