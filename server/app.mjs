import { randomUUID } from "node:crypto";
import cookieParser from "cookie-parser";
import express from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { readSession, requireAuthenticated, verifyCsrf, verifyRequestOrigin } from "./auth.mjs";
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
  migrateDatabase(db);
  const bootstrap = await bootstrapDatabase(db, config);

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

  app.use("/api", (request, _response, next) => {
    const session = readSession(db, request.cookies.vector_session);
    request.session = session;
    request.user = session?.user ?? null;
    next();
  });

  app.use("/api", (request, _response, next) => {
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
      if (!SAFE_METHODS.has(request.method)) {
        verifyRequestOrigin(request, config);
        verifyCsrf(request);
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
