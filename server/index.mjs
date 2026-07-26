import { createServer } from "node:http";
import { buildApp } from "./app.mjs";
import { loadConfig } from "./config.mjs";

const config = loadConfig();
const app = await buildApp({ config });
const server = createServer(app);

async function shutdown(signal) {
  if (config.logLevel !== "silent") {
    console.info(JSON.stringify({ level: "info", message: "shutting down", signal }));
  }
  server.close((error) => {
    app.locals.vector.close();
    if (error) {
      console.error(JSON.stringify({ level: "error", message: "graceful shutdown failed" }));
      process.exitCode = 1;
    }
  });
  server.closeIdleConnections();
  setTimeout(() => server.closeAllConnections(), 10_000).unref();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

server.on("error", (error) => {
  console.error(JSON.stringify({
    level: "error",
    message: "VECTOR failed to start",
    code: error.code,
  }));
  app.locals.vector.close();
  process.exitCode = 1;
});

server.listen(config.port, config.host, () => {
  if (config.logLevel !== "silent") {
    console.info(JSON.stringify({
      level: "info",
      message: "VECTOR is ready",
      address: server.address(),
    }));
  }
});
