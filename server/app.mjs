import { randomUUID } from "node:crypto";
import cookieParser from "cookie-parser";
import express from "express";
import { rateLimit } from "express-rate-limit";
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
import { registerApiRoutes } from "./routes.mjs";
import { registerStaticRoutes } from "./static.mjs";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
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

function requestKey(request) {
  return `${request.method} ${request.originalUrl.split("?")[0]}`;
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

export async function buildApp(options = {}) {
  const config = options.config ?? loadConfig(options.env);
  const db = options.db ?? openDatabase(config.databasePath);
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
  app.disable("x-powered-by");
  app.enable("case sensitive routing");
  app.enable("strict routing");
  app.set("trust proxy", config.trustProxy);
  app.locals.vector = {
    db,
    config,
    bootstrap,
    close: () => {
      if (ownsDatabase && db.open) db.close();
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
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  app.use(rateLimit({
    windowMs: 60_000,
    limit: config.production ? 600 : 10_000,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (request, response) => {
      response.status(429).json(errorPayload(
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
  app.use(express.json({
    limit: config.bodyLimit,
    strict: true,
    type: "application/json",
  }));

  app.use("/api", (request, response, next) => {
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
                path: request.path,
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

  registerApiRoutes(app, options.services);
  registerStaticRoutes(app);

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

  app.use((error, request, response, _next) => {
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
    } else if (!(error instanceof AppError) && statusCode >= 500) {
      code = "internal_error";
      message = "The request could not be completed.";
      details = undefined;
    }

    if (request.invalidSessionCookie && !response.headersSent) {
      response.clearCookie(SESSION_COOKIE, sessionCookieOptions(config));
    }

    if (statusCode >= 500 && config.logLevel !== "silent") {
      console.error(JSON.stringify({
        level: "error",
        requestId: request.id,
        method: request.method,
        path: request.path,
        code,
        stack: config.production ? undefined : error.stack,
      }));
    }
    return response.status(statusCode).json(errorPayload(request, code, message, details));
  });

  return app;
}
