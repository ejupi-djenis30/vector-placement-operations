import { createServer } from "node:http";
import { buildApp } from "../server/app.mjs";
import { loadConfig } from "../server/config.mjs";
import { closeHttpServer, configureHttpServer } from "../server/http.mjs";

const ORIGIN = "http://127.0.0.1:4173";
const ADMIN_PASSWORD = "vector-integration-password-2026";

function clientFor(baseUrl, origin = ORIGIN) {
  let cookie = "";
  let csrfToken = "";

  return {
    get cookie() {
      return cookie;
    },
    get csrfToken() {
      return csrfToken;
    },
    async request(path, {
      method = "GET",
      body,
      contentType = "application/json",
      includeCsrf = true,
      headers = {},
    } = {}) {
      const unsafe = !["GET", "HEAD", "OPTIONS"].includes(method);
      const requestHeaders = {
        accept: "application/json",
        ...headers,
      };
      if (cookie) requestHeaders.cookie = cookie;
      if (unsafe && requestHeaders.origin === undefined) requestHeaders.origin = origin;
      if (unsafe && includeCsrf && csrfToken) requestHeaders["x-csrf-token"] = csrfToken;
      let requestBody;
      if (body !== undefined) {
        requestHeaders["content-type"] = contentType;
        requestBody = contentType === "application/json" ? JSON.stringify(body) : body;
      }
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: requestHeaders,
        body: requestBody,
        redirect: "manual",
      });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";", 1)[0];
      const responseType = response.headers.get("content-type") ?? "";
      const payload = responseType.includes("application/json")
        ? await response.json()
        : await response.text();
      return { response, payload };
    },
    async login(email = "admin@example.test", password = ADMIN_PASSWORD) {
      const result = await this.request("/api/auth/login", {
        method: "POST",
        body: { email, password },
        includeCsrf: false,
      });
      if (result.response.ok) csrfToken = result.payload.csrfToken;
      return result;
    },
  };
}

export async function startTestApp({
  seedSynthetic = false,
  databasePath = ":memory:",
  requireBootstrapPasswordChange = false,
  services,
  logLevel = "silent",
  env = {},
} = {}) {
  const production = env.NODE_ENV === "production";
  const config = loadConfig({
    NODE_ENV: production ? "production" : "test",
    VECTOR_DB_PATH: databasePath,
    VECTOR_ORIGIN: production ? "https://vector.example.test" : ORIGIN,
    VECTOR_COOKIE_SECURE: production ? "true" : "false",
    VECTOR_BOOTSTRAP_ADMIN_PASSWORD: ADMIN_PASSWORD,
    VECTOR_SEED_SYNTHETIC: seedSynthetic ? "true" : "false",
    VECTOR_LOG_LEVEL: logLevel,
    ...env,
  });
  const app = await buildApp({ config, services });
  if (!requireBootstrapPasswordChange) {
    app.locals.vector.db.prepare(
      "UPDATE users SET must_change_password = 0 WHERE email = ?",
    ).run("admin@example.test");
  }
  const server = configureHttpServer(createServer(app), config);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    app,
    db: app.locals.vector.db,
    config,
    server,
    baseUrl,
    client: clientFor(baseUrl, config.origin),
    newClient: () => clientFor(baseUrl, config.origin),
    async close() {
      await closeHttpServer(server, {
        beginDrain: () => app.locals.vector.beginDrain(),
        closeApplication: () => app.locals.vector.close(),
        graceMs: config.shutdownGraceMs,
      });
    },
  };
}

export { ADMIN_PASSWORD, ORIGIN };
