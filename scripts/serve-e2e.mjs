import { createServer } from "node:http";
import { buildApp } from "../server/app.mjs";
import { loadConfig } from "../server/config.mjs";
import { resolveE2ePorts } from "./e2e-ports.mjs";

const HOST = "127.0.0.1";
const { workspace: PORT } = resolveE2ePorts();
const password = process.env.VECTOR_E2E_PASSWORD ?? "vector-e2e-password-2026";
const config = loadConfig({
  NODE_ENV: "test",
  VECTOR_HOST: HOST,
  VECTOR_PORT: String(PORT),
  // Playwright force-stops web servers on Windows, where POSIX shutdown
  // signals are unavailable. An in-memory fixture avoids leaking temporary
  // SQLite directories while file-backed WAL behaviour remains covered by
  // the integration and release-acceptance suites.
  VECTOR_DB_PATH: ":memory:",
  VECTOR_ORIGIN: `http://${HOST}:${PORT}`,
  VECTOR_COOKIE_SECURE: "false",
  VECTOR_BOOTSTRAP_ADMIN_EMAIL: "vector-e2e-admin@example.test",
  VECTOR_BOOTSTRAP_ADMIN_NAME: "VECTOR E2E Administrator",
  VECTOR_BOOTSTRAP_ADMIN_PASSWORD: password,
  VECTOR_SEED_SYNTHETIC: "true",
  VECTOR_LOG_LEVEL: "silent",
});
const app = await buildApp({ config });
const server = createServer(app);
let closing = false;
let cleaned = false;

function cleanup() {
  if (cleaned) return;
  cleaned = true;
  app.locals.vector.close();
}

function shutdown(exitCode = 0) {
  if (closing) return;
  closing = true;
  server.close(() => {
    cleanup();
    process.exit(exitCode);
  });
  server.closeIdleConnections();
  setTimeout(() => {
    server.closeAllConnections();
    cleanup();
    process.exit(exitCode);
  }, 5_000).unref();
}

server.once("error", (error) => {
  console.error(`VECTOR E2E server failed: ${error.code ?? error.message}`);
  cleanup();
  process.exit(1);
});
process.once("SIGINT", () => shutdown());
process.once("SIGTERM", () => shutdown());
process.once("exit", () => {
  if (!closing) cleanup();
});

server.listen(PORT, HOST, () => {
  console.log(`VECTOR E2E workspace listening on http://${HOST}:${PORT}`);
});
