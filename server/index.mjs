import { assertSupportedNodeVersion } from "./version.mjs";

assertSupportedNodeVersion();

const [
  { createServer },
  { buildApp },
  { loadConfig },
  {
    closeHttpServer,
    configureHttpServer,
    once,
  },
] = await Promise.all([
  import("node:http"),
  import("./app.mjs"),
  import("./config.mjs"),
  import("./http.mjs"),
]);

const config = loadConfig();
const app = await buildApp({ config });
const server = configureHttpServer(createServer(app), config);
const closeApplication = once(() => app.locals.vector.close());
let listening = false;
let shutdownPromise = null;

function shutdown(signal) {
  if (shutdownPromise) return shutdownPromise;
  app.locals.vector.beginDrain();
  if (config.logLevel !== "silent") {
    console.info(JSON.stringify({ level: "info", message: "shutting down", signal }));
  }
  shutdownPromise = closeHttpServer(server, {
    beginDrain: () => app.locals.vector.beginDrain(),
    closeApplication,
    graceMs: config.shutdownGraceMs,
    onForce: () => {
      if (config.logLevel !== "silent") {
        console.warn(JSON.stringify({
          level: "warn",
          message: "forcing remaining connections closed",
          signal,
        }));
      }
    },
  }).catch(() => {
    console.error(JSON.stringify({ level: "error", message: "graceful shutdown failed" }));
    process.exitCode = 1;
  }).finally(() => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  });
  return shutdownPromise;
}

function onSigint() {
  void shutdown("SIGINT");
}

function onSigterm() {
  void shutdown("SIGTERM");
}

process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);

server.on("error", (error) => {
  console.error(JSON.stringify({
    level: "error",
    message: listening ? "VECTOR HTTP server failed" : "VECTOR failed to start",
    code: error.code,
  }));
  process.exitCode = 1;
  if (listening) {
    void shutdown("server_error");
  } else {
    try {
      closeApplication();
    } catch {
      console.error(JSON.stringify({ level: "error", message: "application cleanup failed" }));
    }
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
});

server.listen(config.port, config.host, () => {
  listening = true;
  if (config.logLevel !== "silent") {
    console.info(JSON.stringify({
      level: "info",
      message: "VECTOR is ready",
      address: server.address(),
    }));
  }
});
