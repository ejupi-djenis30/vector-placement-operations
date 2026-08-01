import { randomUUID } from "node:crypto";
import cookieParser from "cookie-parser";
import express from "express";
import { MemoryStore, rateLimit } from "express-rate-limit";
import helmet from "helmet";
import {
  SESSION_COOKIE,
  readSession,
  requireAuthenticated,
  sessionCookieOptions,
  touchSession,
  verifyCsrf,
  verifyRequestOrigin,
} from "./auth.mjs";
import { loadConfig } from "./config.mjs";
import { bootstrapDatabase, migrateDatabase, openDatabase } from "./db.mjs";
import { AppError } from "./errors.mjs";
import { MAX_HEADER_COUNT } from "./http.mjs";
import { registerApiRoutes } from "./routes.mjs";
import { registerStaticRoutes } from "./static.mjs";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const HEALTH_ROUTES = new Set([
  "GET /api/health/live",
  "GET /api/health/ready",
]);
const HEALTH_PROBE_BUDGET_HEADERS = new Set([
  "authorization",
  "content-encoding",
  "content-length",
  "content-type",
  "cookie",
  "transfer-encoding",
  "x-csrf-token",
]);
const PUBLIC_ROUTES = new Set([
  "GET /api/health/live",
  "GET /api/health/ready",
  "GET /api/public/branding",
  "GET /api/public/branding.css",
  "GET /api/public/branding/logo",
  "GET /api/session",
  "POST /api/auth/login",
]);
const PASSWORD_CHANGE_ROUTES = new Set([
  "POST /api/auth/change-password",
  "POST /api/auth/logout",
]);
const SINGLETON_REQUEST_HEADERS = new Set([
  "authorization",
  "content-encoding",
  "content-length",
  "content-type",
  "cookie",
  "forwarded",
  "host",
  "origin",
  "transfer-encoding",
  "x-csrf-token",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
]);

function hasDuplicateCookie(request, cookieName) {
  const header = request.headers.cookie;
  if (typeof header !== "string") return false;
  let matches = 0;
  for (const segment of header.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 0 || segment.slice(0, separator).trim() !== cookieName) continue;
    matches += 1;
    if (matches > 1) return true;
  }
  return false;
}

function requestKey(request) {
  const method = request.method === "HEAD" ? "GET" : request.method;
  return `${method} ${request.originalUrl.split("?")[0]}`;
}

function isBareHealthProbe(request) {
  if (!HEALTH_ROUTES.has(requestKey(request))) return false;
  if (request.originalUrl.includes("?")) return false;
  return !Object.keys(request.headers).some((name) => (
    HEALTH_PROBE_BUDGET_HEADERS.has(name)
  ));
}

function errorPayload(request, code, message, details = undefined) {
  return {
    error: {
      code,
      message,
      requestId: request.id,
      ...(details === undefined ? {} : { details }),
    },
  };
}

function logRoute(request) {
  const route = request.route?.path;
  if (typeof route === "string" && route.startsWith("/")) return route;
  return request.path?.startsWith("/api")
    ? "/api/<unmatched>"
    : "/<unmatched>";
}

export function createErrorHandler(config) {
  return (error, request, response, next) => {
    let statusCode = error.statusCode ?? error.status ?? 500;
    let code = error.code ?? "internal_error";
    let message = error.message;
    let details = error.details;

    if (error instanceof SyntaxError && error.type === "entity.parse.failed") {
      statusCode = 400;
      code = "invalid_json";
      message = "The request body is not valid JSON.";
    } else if (error.type === "entity.too.large") {
      statusCode = 413;
      code = "payload_too_large";
      message = "The request body exceeds the configured limit.";
    } else if (error.type === "encoding.unsupported") {
      statusCode = 415;
      code = "unsupported_content_encoding";
      message = "The request body uses an unsupported content encoding.";
    } else if (error.type === "charset.unsupported") {
      statusCode = 415;
      code = "unsupported_charset";
      message = "The request body uses an unsupported character set.";
    } else if (
      statusCode === 400
      && typeof error.code === "string"
      && /^Z_[A-Z0-9_]+$/.test(error.code)
    ) {
      code = "invalid_content_encoding";
      message = "The compressed request body is not valid.";
    } else if (
      typeof error.code === "string"
      && /^SQLITE_BUSY(?:_|$)/.test(error.code)
    ) {
      statusCode = 503;
      code = "database_busy";
      message = "The database is busy. Try again shortly.";
      details = undefined;
    } else if (
      ["SQLITE_CONSTRAINT_UNIQUE", "SQLITE_CONSTRAINT_PRIMARYKEY"].includes(error.code)
    ) {
      statusCode = 409;
      code = "duplicate_record";
      message = "A record with the same identifying fields already exists.";
    } else if (
      [
        "SQLITE_CONSTRAINT_FOREIGNKEY",
        "SQLITE_CONSTRAINT_CHECK",
        "SQLITE_CONSTRAINT_NOTNULL",
      ].includes(error.code)
    ) {
      statusCode = 422;
      code = "invalid_reference";
      message = "The record references missing or incompatible data.";
    } else if (!(error instanceof AppError)) {
      if (
        Number.isInteger(statusCode)
        && statusCode >= 400
        && statusCode < 500
      ) {
        code = "request_rejected";
        message = "The request could not be accepted.";
      } else {
        statusCode = 500;
        code = "internal_error";
        message = "The request could not be completed.";
      }
      details = undefined;
    }

    if (statusCode >= 500 && config.logLevel !== "silent") {
      console.error(JSON.stringify({
        level: "error",
        requestId: request.id,
        method: request.method,
        route: logRoute(request),
        code,
        stack: config.production ? undefined : error.stack,
      }));
    }

    if (response.headersSent) return next(error);

    if (request.invalidSessionCookie) {
      response.clearCookie(SESSION_COOKIE, sessionCookieOptions(config));
    }
    response.set("Cache-Control", "no-store");
    if (code === "database_busy") response.set("Retry-After", "1");
    return response
      .status(statusCode)
      .json(errorPayload(request, code, message, details));
  };
}

export async function buildApp(options = {}) {
  const config = options.config ?? loadConfig(options.env);
  const databaseOpener = options.openDatabase ?? openDatabase;
  const db = options.db ?? databaseOpener(config.databasePath);
  const ownsDatabase = !options.db;
  let bootstrap;
  try {
    migrateDatabase(db);
    bootstrap = await bootstrapDatabase(db, config);
    if (config.production && config.bootstrapAdminPassword) {
      const message = bootstrap.created
        ? "VECTOR initialization completed. Remove VECTOR_BOOTSTRAP_ADMIN_PASSWORD from the "
          + "environment and restart VECTOR before serving users."
        : "VECTOR_BOOTSTRAP_ADMIN_PASSWORD must be removed after initialization. Remove it "
          + "from the environment and restart VECTOR.";
      throw new Error(message);
    }
  } catch (error) {
    if (ownsDatabase && db.open) db.close();
    throw error;
  }

  const app = express();
  let draining = false;
  let applicationClosed = false;
  const applicationCleanups = [];
  app.disable("x-powered-by");
  app.enable("case sensitive routing");
  app.enable("strict routing");
  app.set("trust proxy", config.trustProxy);
  app.locals.vector = {
    db,
    config,
    bootstrap,
    beginDrain: () => {
      draining = true;
    },
    isDraining: () => draining,
    registerCleanup: (cleanup) => {
      if (typeof cleanup !== "function") throw new TypeError("Cleanup must be a function.");
      if (applicationClosed) return cleanup();
      applicationCleanups.push(cleanup);
      return undefined;
    },
    close: () => {
      if (applicationClosed) return;
      applicationClosed = true;
      draining = true;
      let closeError = null;
      for (const cleanup of applicationCleanups.reverse()) {
        try {
          cleanup();
        } catch (error) {
          closeError ??= error;
        }
      }
      try {
        if (ownsDatabase && db.open) db.close();
      } catch (error) {
        closeError ??= error;
      }
      if (closeError) throw closeError;
    },
  };

  app.use((request, response, next) => {
    request.startedAt = new Date();
    request.id = randomUUID();
    response.set("X-Request-ID", request.id);
    next();
  });
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        "upgrade-insecure-requests": config.production ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  app.use((_request, response, next) => {
    response.set(
      "Permissions-Policy",
      "camera=(), display-capture=(), geolocation=(), microphone=(), payment=(), usb=()",
    );
    next();
  });
  app.use((request, _response, next) => {
    if (request.rawHeaders.length / 2 > MAX_HEADER_COUNT) {
      return next(new AppError(
        431,
        "too_many_headers",
        `Requests may contain at most ${MAX_HEADER_COUNT} headers.`,
      ));
    }
    const seen = new Set();
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index].toLowerCase();
      if (!SINGLETON_REQUEST_HEADERS.has(name)) continue;
      if (seen.has(name)) {
        return next(new AppError(
          400,
          "ambiguous_request_headers",
          "The request contains ambiguous duplicate headers.",
        ));
      }
      seen.add(name);
    }
    // A browser may send both a host-only session cookie and a less-specific
    // domain/path cookie with the same name. cookie-parser selects one value,
    // but different intermediaries need not make the same choice. Reject the
    // ambiguity before authentication instead of accepting a cookie-tossed
    // bearer credential.
    if (hasDuplicateCookie(request, SESSION_COOKIE)) {
      return next(new AppError(
        400,
        "ambiguous_request_headers",
        "The request contains an ambiguous duplicate session cookie.",
      ));
    }
    return next();
  });
  app.use((request, response, next) => {
    if (!app.locals.vector.isDraining()) return next();
    response.set("Connection", "close");
    if (requestKey(request) === "GET /api/health/live") return next();
    return response
      .set("Cache-Control", "no-store")
      .set("Retry-After", "1")
      .status(503)
      .json(errorPayload(
        request,
        "service_draining",
        "The service is shutting down and is not accepting new work.",
      ));
  });
  app.use("/api", (request, _response, next) => {
    // Reject explicit browser cross-origin mutations before request accounting
    // and body inflation. The authenticated gate below repeats the check so an
    // unsafe request with a missing Origin header still fails closed.
    if (SAFE_METHODS.has(request.method) || request.headers.origin === undefined) {
      return next();
    }
    try {
      verifyRequestOrigin(request, config);
      return next();
    } catch (error) {
      return next(error);
    }
  });
  const apiRateLimitStore = options.services?.apiRateLimitStore ?? new MemoryStore();
  app.locals.vector.registerCleanup(() => apiRateLimitStore.shutdown?.());
  app.use("/api", rateLimit({
    windowMs: 60_000,
    limit: config.production ? 600 : 10_000,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    store: apiRateLimitStore,
    // Only exact, credential-free, body-free orchestrator probes bypass accounting.
    // A browser or unusual client cannot turn the public route into an
    // unmetered credential/session or request-body processing path.
    skip: isBareHealthProbe,
    validate: config.trustProxy === false
      ? { xForwardedForHeader: false }
      : true,
    handler: (request, response) => {
      response
        .set("Cache-Control", "no-store")
        .status(429)
        .json(errorPayload(
          request,
          "rate_limited",
          "Too many requests. Try again shortly.",
        ));
    },
  }));
  app.use(cookieParser());
  app.use("/api", (_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });
  app.use(
    "/api/branding/logo",
    express.raw({ type: "image/png", limit: "256kb" }),
  );
  app.use(
    "/api/import",
    express.text({ type: "text/csv", limit: config.bodyLimit }),
  );
  // Parsing belongs to the API boundary. Keeping it off presentation and
  // unmatched paths prevents those unmetered routes from becoming a JSON
  // inflation/parsing path that bypasses the API request budget.
  app.use("/api", express.json({
    limit: config.bodyLimit,
    strict: true,
    type: "application/json",
  }));

  app.use("/api", (request, response, next) => {
    if (HEALTH_ROUTES.has(requestKey(request))) {
      request.session = null;
      request.user = null;
      return next();
    }
    const token = request.cookies[SESSION_COOKIE];
    const session = readSession(db, token, config.sessionIdleMinutes);
    if (token && !session) {
      if (requestKey(request) === "POST /api/auth/login") {
        request.invalidSessionCookie = true;
      } else {
        response.clearCookie(SESSION_COOKIE, sessionCookieOptions(config));
      }
    }
    request.session = session;
    request.user = session?.user ?? null;
    next();
  });

  app.use("/api", (request, response, next) => {
    if (PUBLIC_ROUTES.has(requestKey(request))) return next();
    try {
      requireAuthenticated(request);
      if (
        request.user.mustChangePassword
        && !PASSWORD_CHANGE_ROUTES.has(requestKey(request))
      ) {
        throw new AppError(
          403,
          "password_change_required",
          "Change the temporary password before using the workspace.",
        );
      }
      const safeMethod = SAFE_METHODS.has(request.method);
      if (!safeMethod) {
        verifyRequestOrigin(request, config);
        verifyCsrf(request);
      }
      const sameOriginSignal = request.get("sec-fetch-site") === "same-origin"
        || request.get("origin") === config.origin;
      if (!safeMethod || sameOriginSignal) {
        const sessionId = request.session.id;
        const startedAt = request.startedAt;
        response.once("finish", () => {
          try {
            if (response.statusCode < 400) {
              touchSession(db, sessionId, startedAt);
            }
          } catch (error) {
            if (config.logLevel !== "silent") {
              console.error(JSON.stringify({
                level: "error",
                requestId: request.id,
                method: request.method,
                route: logRoute(request),
                code: "session_touch_failed",
                stack: config.production ? undefined : error.stack,
              }));
            }
          }
        });
      }
      return next();
    } catch (error) {
      return next(error);
    }
  });

  try {
    registerApiRoutes(app, options.services);
    registerStaticRoutes(app);
  } catch (error) {
    app.locals.vector.close();
    throw error;
  }

  app.use("/api", (request, response) => {
    response.status(404).json(errorPayload(
      request,
      "not_found",
      "The requested endpoint does not exist.",
    ));
  });

  app.use((request, response) => {
    if (request.accepts("html")) return response.redirect(302, "/");
    return response.status(404).json(errorPayload(request, "not_found", "Resource not found."));
  });

  app.use(createErrorHandler(config));

  return app;
}
