import path from "node:path";
import { assertIanaTimeZone } from "./school-time.mjs";

const BOOLEAN_TRUE = new Set(["1", "true", "yes", "on"]);
const BOOLEAN_FALSE = new Set(["0", "false", "no", "off"]);
const NODE_ENVIRONMENTS = new Set(["development", "test", "production"]);

function nodeEnvironmentFrom(value) {
  const nodeEnv = value ?? "development";
  if (typeof nodeEnv !== "string" || !NODE_ENVIRONMENTS.has(nodeEnv)) {
    throw new Error("NODE_ENV must be exactly development, test or production.");
  }
  return nodeEnv;
}

function booleanFrom(value, fallback, name) {
  if (value === undefined) return fallback;
  const normalized = String(value).toLowerCase();
  if (BOOLEAN_TRUE.has(normalized)) return true;
  if (BOOLEAN_FALSE.has(normalized)) return false;
  throw new Error(`${name} must be an explicit true or false value.`);
}

function integerFrom(value, fallback, { min, max, name }) {
  const text = value === undefined ? String(fallback) : String(value);
  const parsed = Number(text);
  if (
    !/^-?(?:0|[1-9]\d*)$/.test(text)
    || !Number.isSafeInteger(parsed)
    || String(parsed) !== text
    || parsed < min
    || parsed > max
  ) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function trustProxyFrom(value) {
  if (value === undefined || ["", "0", "false", "off", "no"].includes(String(value).toLowerCase())) {
    return false;
  }
  const hops = Number.parseInt(value, 10);
  if (!Number.isInteger(hops) || hops < 1 || hops > 5 || String(hops) !== String(value)) {
    throw new Error("VECTOR_TRUST_PROXY must be false or an integer hop count between 1 and 5.");
  }
  return hops;
}

function stringFrom(value, fallback, { name, max, pattern = null }) {
  const text = String(value ?? fallback).trim();
  if (!text || text.length > max || (pattern && !pattern.test(text))) {
    throw new Error(`${name} is not valid.`);
  }
  return text;
}

function originFrom(value, production) {
  const raw = value ?? (production ? null : "http://127.0.0.1:4173");
  if (!raw) throw new Error("VECTOR_ORIGIN is required in production.");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("VECTOR_ORIGIN must be an absolute HTTP or HTTPS origin.");
  }
  if (
    !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new Error("VECTOR_ORIGIN must be an absolute HTTP or HTTPS origin without a path.");
  }
  return url.origin;
}

function logLevelFrom(value, production) {
  const level = value ?? (production ? "info" : "warn");
  if (!["silent", "error", "warn", "info"].includes(level)) {
    throw new Error("VECTOR_LOG_LEVEL must be silent, error, warn or info.");
  }
  return level;
}

function bootstrapValue(env, name, required) {
  const value = env[name];
  if (required && (value === undefined || !String(value).trim())) {
    throw new Error(
      `${name} is required when VECTOR_BOOTSTRAP_ADMIN_PASSWORD is set in production.`,
    );
  }
  return value;
}

export function loadConfig(env = process.env, cwd = process.cwd()) {
  const nodeEnv = nodeEnvironmentFrom(env.NODE_ENV);
  const production = nodeEnv === "production";
  const databasePath = stringFrom(
    env.VECTOR_DB_PATH,
    path.join(cwd, "data", "vector.sqlite"),
    { name: "VECTOR_DB_PATH", max: 4096 },
  );
  const origin = originFrom(env.VECTOR_ORIGIN, production);
  const cookieSecure = booleanFrom(env.VECTOR_COOKIE_SECURE, production, "VECTOR_COOKIE_SECURE");
  if (production && !origin.startsWith("https://")) {
    throw new Error("VECTOR_ORIGIN must use HTTPS in production, including loopback deployments.");
  }
  if (production && !cookieSecure) {
    throw new Error("VECTOR_COOKIE_SECURE must stay enabled for an HTTPS production origin.");
  }

  const sessionHours = integerFrom(env.VECTOR_SESSION_HOURS, 12, {
    min: 1,
    max: 168,
    name: "VECTOR_SESSION_HOURS",
  });
  const sessionIdleMinutes = integerFrom(env.VECTOR_SESSION_IDLE_MINUTES, 45, {
    min: 5,
    max: 10_080,
    name: "VECTOR_SESSION_IDLE_MINUTES",
  });
  if (sessionIdleMinutes > sessionHours * 60) {
    throw new Error(
      "VECTOR_SESSION_IDLE_MINUTES must be less than or equal to "
      + "VECTOR_SESSION_HOURS converted to minutes.",
    );
  }
  const requestTimeoutMs = integerFrom(env.VECTOR_REQUEST_TIMEOUT_MS, 30_000, {
    min: 1_000,
    max: 120_000,
    name: "VECTOR_REQUEST_TIMEOUT_MS",
  });
  const headersTimeoutMs = integerFrom(env.VECTOR_HEADERS_TIMEOUT_MS, 10_000, {
    min: 1_000,
    max: 60_000,
    name: "VECTOR_HEADERS_TIMEOUT_MS",
  });
  if (headersTimeoutMs > requestTimeoutMs) {
    throw new Error(
      "VECTOR_HEADERS_TIMEOUT_MS must be less than or equal to VECTOR_REQUEST_TIMEOUT_MS.",
    );
  }
  const bootstrapAdminPassword = env.VECTOR_BOOTSTRAP_ADMIN_PASSWORD ?? null;
  const explicitProductionBootstrap = production
    && typeof bootstrapAdminPassword === "string"
    && bootstrapAdminPassword.length > 0;

  return Object.freeze({
    nodeEnv,
    production,
    host: stringFrom(env.VECTOR_HOST, "127.0.0.1", {
      name: "VECTOR_HOST",
      max: 255,
      pattern: /^[a-zA-Z0-9.:[\]_-]+$/,
    }),
    port: integerFrom(env.VECTOR_PORT, 4173, {
      min: 1,
      max: 65_535,
      name: "VECTOR_PORT",
    }),
    databasePath,
    origin,
    trustProxy: trustProxyFrom(env.VECTOR_TRUST_PROXY),
    cookieSecure,
    bodyLimit: integerFrom(env.VECTOR_BODY_LIMIT, 524_288, {
      min: 16_384,
      max: 2_097_152,
      name: "VECTOR_BODY_LIMIT",
    }),
    requestTimeoutMs,
    headersTimeoutMs,
    keepAliveTimeoutMs: integerFrom(env.VECTOR_KEEP_ALIVE_TIMEOUT_MS, 5_000, {
      min: 1_000,
      max: 60_000,
      name: "VECTOR_KEEP_ALIVE_TIMEOUT_MS",
    }),
    maxRequestsPerSocket: integerFrom(env.VECTOR_MAX_REQUESTS_PER_SOCKET, 1_000, {
      min: 1,
      max: 10_000,
      name: "VECTOR_MAX_REQUESTS_PER_SOCKET",
    }),
    shutdownGraceMs: integerFrom(env.VECTOR_SHUTDOWN_GRACE_MS, 10_000, {
      min: 1_000,
      max: 60_000,
      name: "VECTOR_SHUTDOWN_GRACE_MS",
    }),
    sessionHours,
    sessionIdleMinutes,
    bootstrapSchoolName: stringFrom(
      bootstrapValue(env, "VECTOR_BOOTSTRAP_SCHOOL_NAME", explicitProductionBootstrap),
      "VECTOR School",
      {
        name: "VECTOR_BOOTSTRAP_SCHOOL_NAME",
        max: 120,
      },
    ),
    bootstrapSchoolSlug: stringFrom(
      bootstrapValue(env, "VECTOR_BOOTSTRAP_SCHOOL_SLUG", explicitProductionBootstrap),
      "vector-school",
      {
        name: "VECTOR_BOOTSTRAP_SCHOOL_SLUG",
        max: 80,
        pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      },
    ),
    bootstrapTimeZone: assertIanaTimeZone(
      stringFrom(
        bootstrapValue(env, "VECTOR_BOOTSTRAP_TIME_ZONE", explicitProductionBootstrap),
        "UTC",
        {
          name: "VECTOR_BOOTSTRAP_TIME_ZONE",
          max: 100,
        },
      ),
      "VECTOR_BOOTSTRAP_TIME_ZONE",
    ),
    bootstrapAdminEmail: stringFrom(
      bootstrapValue(env, "VECTOR_BOOTSTRAP_ADMIN_EMAIL", explicitProductionBootstrap),
      "admin@example.test",
      {
        name: "VECTOR_BOOTSTRAP_ADMIN_EMAIL",
        max: 254,
        pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
      },
    ).toLowerCase(),
    bootstrapAdminName: stringFrom(
      bootstrapValue(env, "VECTOR_BOOTSTRAP_ADMIN_NAME", explicitProductionBootstrap),
      "School administrator",
      {
        name: "VECTOR_BOOTSTRAP_ADMIN_NAME",
        max: 120,
      },
    ),
    bootstrapAdminPassword,
    seedSynthetic: booleanFrom(
      env.VECTOR_SEED_SYNTHETIC,
      !production,
      "VECTOR_SEED_SYNTHETIC",
    ),
    logLevel: logLevelFrom(env.VECTOR_LOG_LEVEL, production),
  });
}
