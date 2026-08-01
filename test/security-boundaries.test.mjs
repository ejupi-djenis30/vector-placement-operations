import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { verifyCsrf } from "../server/auth.mjs";
import { loadConfig } from "../server/config.mjs";
import { createCursorCodec } from "../server/cursor.mjs";
import { hashPassword, verifyPassword } from "../server/password.mjs";
import {
  assertBrandPalette,
  assertPng,
  hoursToMinutes,
  isIsoDate,
} from "../server/validation.mjs";

test("NODE_ENV accepts only exact supported environments", () => {
  assert.equal(loadConfig({}).nodeEnv, "development");
  for (const nodeEnv of ["development", "test"]) {
    assert.equal(loadConfig({ NODE_ENV: nodeEnv }).nodeEnv, nodeEnv);
  }
  assert.equal(
    loadConfig({
      NODE_ENV: "production",
      VECTOR_ORIGIN: "https://vector.example.test",
    }).nodeEnv,
    "production",
  );

  for (const nodeEnv of [
    "",
    "prod",
    "Production",
    " production",
    "production ",
    "TEST",
    "staging",
  ]) {
    assert.throws(
      () => loadConfig({ NODE_ENV: nodeEnv }),
      /NODE_ENV must be exactly development, test or production/,
      nodeEnv,
    );
  }
});

test("production configuration requires HTTPS, secure cookies and bounded proxy trust", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "production" }), /VECTOR_ORIGIN is required/);
  assert.throws(
    () => loadConfig({
      NODE_ENV: "production",
      VECTOR_ORIGIN: "https://vector.example.test",
      VECTOR_TRUST_PROXY: "true",
    }),
    /integer hop count/,
  );
  assert.throws(
    () => loadConfig({
      NODE_ENV: "production",
      VECTOR_ORIGIN: "https://vector.example.test",
      VECTOR_COOKIE_SECURE: "treu",
    }),
    /explicit true or false/,
  );
  for (const origin of [
    "http://vector.example.test",
    "http://127.0.0.1:4173",
    "http://localhost:4173",
    "http://[::1]:4173",
  ]) {
    assert.throws(
      () => loadConfig({
        NODE_ENV: "production",
        VECTOR_ORIGIN: origin,
        VECTOR_COOKIE_SECURE: "false",
      }),
      /must use HTTPS in production/,
      origin,
    );
  }
  assert.throws(
    () => loadConfig({
      NODE_ENV: "production",
      VECTOR_ORIGIN: "https://vector.example.test",
      VECTOR_COOKIE_SECURE: "false",
    }),
    /must stay enabled/,
  );
  const config = loadConfig({
    NODE_ENV: "production",
    VECTOR_ORIGIN: "https://vector.example.test",
    VECTOR_TRUST_PROXY: "1",
  });
  assert.equal(config.trustProxy, 1);
  assert.equal(config.cookieSecure, true);
  const evaluation = loadConfig({
    NODE_ENV: "test",
    VECTOR_ORIGIN: "http://127.0.0.1:4173",
    VECTOR_COOKIE_SECURE: "false",
  });
  assert.equal(evaluation.cookieSecure, false);
});

test("production bootstrap requires every institution identity explicitly", () => {
  const bootstrap = {
    NODE_ENV: "production",
    VECTOR_ORIGIN: "https://vector.example.test",
    VECTOR_BOOTSTRAP_SCHOOL_NAME: "Example training school",
    VECTOR_BOOTSTRAP_SCHOOL_SLUG: "example-training-school",
    VECTOR_BOOTSTRAP_TIME_ZONE: "Europe/Zurich",
    VECTOR_BOOTSTRAP_ADMIN_EMAIL: "placement.admin@example.test",
    VECTOR_BOOTSTRAP_ADMIN_NAME: "Placement administrator",
    VECTOR_BOOTSTRAP_ADMIN_PASSWORD: "bootstrap-password-2026",
  };
  for (const name of [
    "VECTOR_BOOTSTRAP_SCHOOL_NAME",
    "VECTOR_BOOTSTRAP_SCHOOL_SLUG",
    "VECTOR_BOOTSTRAP_TIME_ZONE",
    "VECTOR_BOOTSTRAP_ADMIN_EMAIL",
    "VECTOR_BOOTSTRAP_ADMIN_NAME",
  ]) {
    const incomplete = { ...bootstrap };
    delete incomplete[name];
    assert.throws(
      () => loadConfig(incomplete),
      new RegExp(`${name} is required when VECTOR_BOOTSTRAP_ADMIN_PASSWORD`),
    );
  }

  const configured = loadConfig(bootstrap);
  assert.equal(configured.bootstrapSchoolName, "Example training school");
  assert.equal(configured.bootstrapSchoolSlug, "example-training-school");
  assert.equal(configured.bootstrapTimeZone, "Europe/Zurich");
  assert.equal(configured.bootstrapAdminEmail, "placement.admin@example.test");
  assert.equal(configured.bootstrapAdminName, "Placement administrator");

  const testDefaults = loadConfig({
    NODE_ENV: "test",
    VECTOR_BOOTSTRAP_ADMIN_PASSWORD: "test-only-password-2026",
  });
  assert.equal(testDefaults.bootstrapSchoolName, "VECTOR School");
  assert.equal(testDefaults.bootstrapAdminEmail, "admin@example.test");
  assert.equal(testDefaults.bootstrapTimeZone, "UTC");
});

test("session inactivity policy is bounded by the absolute lifetime", () => {
  const defaults = loadConfig({ NODE_ENV: "test" });
  assert.equal(defaults.sessionHours, 12);
  assert.equal(defaults.sessionIdleMinutes, 45);

  const equalLimit = loadConfig({
    NODE_ENV: "test",
    VECTOR_SESSION_HOURS: "1",
    VECTOR_SESSION_IDLE_MINUTES: "60",
  });
  assert.equal(equalLimit.sessionIdleMinutes, 60);

  assert.throws(
    () => loadConfig({ NODE_ENV: "test", VECTOR_SESSION_IDLE_MINUTES: "4" }),
    /integer between 5 and 10080/,
  );
  assert.throws(
    () => loadConfig({ NODE_ENV: "test", VECTOR_SESSION_IDLE_MINUTES: "5.5" }),
    /integer between 5 and 10080/,
  );
  assert.throws(
    () => loadConfig({
      NODE_ENV: "test",
      VECTOR_SESSION_HOURS: "1",
      VECTOR_SESSION_IDLE_MINUTES: "61",
    }),
    /less than or equal to VECTOR_SESSION_HOURS/,
  );
});

test("HTTP transport limits are finite and reject contradictory header timing", () => {
  const defaults = loadConfig({ NODE_ENV: "test" });
  assert.equal(defaults.requestTimeoutMs, 30_000);
  assert.equal(defaults.headersTimeoutMs, 10_000);
  assert.equal(defaults.keepAliveTimeoutMs, 5_000);
  assert.equal(defaults.maxRequestsPerSocket, 1_000);
  assert.equal(defaults.shutdownGraceMs, 10_000);

  assert.throws(
    () => loadConfig({
      NODE_ENV: "test",
      VECTOR_REQUEST_TIMEOUT_MS: "5000",
      VECTOR_HEADERS_TIMEOUT_MS: "6000",
    }),
    /HEADERS_TIMEOUT_MS must be less than or equal/,
  );
  assert.throws(
    () => loadConfig({ NODE_ENV: "test", VECTOR_MAX_REQUESTS_PER_SOCKET: "0" }),
    /integer between 1 and 10000/,
  );
});

test("password verification accepts canonical scrypt hashes and rejects malformed encodings", async () => {
  const hash = await hashPassword("a-strong-test-password-2026");
  assert.equal(await verifyPassword("a-strong-test-password-2026", hash), true);
  assert.equal(await verifyPassword("wrong-password", hash), false);
  for (const malformed of [
    hash.replace("$16384$", "$1048576$"),
    hash.replace("$16384$", "$016384$"),
    `${hash}$ignored-field`,
    `${hash.slice(0, hash.lastIndexOf("$") + 1)}${"a".repeat(257)}`,
    hash.replace(/([^$]+)$/, "$1!"),
    hash.replace(/([^$]+)(\$[^$]+)$/, "$1!$2"),
  ]) {
    assert.equal(
      await verifyPassword("a-strong-test-password-2026", malformed),
      false,
    );
  }
});

test("CSRF verification uses exact tokens and safely rejects different lengths", () => {
  const csrfToken = "0123456789abcdef0123456789abcdef";
  assert.doesNotThrow(() => verifyCsrf({
    headers: { "x-csrf-token": csrfToken },
    session: { csrfToken },
  }));
  for (const provided of [
    "1123456789abcdef0123456789abcdef",
    "short",
    `${csrfToken}extra`,
    undefined,
  ]) {
    assert.throws(
      () => verifyCsrf({
        headers: { "x-csrf-token": provided },
        session: { csrfToken },
      }),
      (error) => error.statusCode === 403 && error.code === "invalid_csrf",
    );
  }
});

test("branding enforces contrast and PNG structure, dimensions and CRC integrity", () => {
  const palette = assertBrandPalette({
    primaryColor: "#17324d",
    accentColor: "#ff6b56",
    surfaceColor: "#f5efe5",
  });
  assert.equal(palette.onPrimaryColor, "#ffffff");
  assert.throws(
    () => assertBrandPalette({
      primaryColor: "#777777",
      accentColor: "#ff6b56",
      surfaceColor: "#888888",
    }),
    /contrast ratio/,
  );

  const png = readFileSync(new URL("../site/assets/social-preview.png", import.meta.url));
  assert.deepEqual(assertPng(png), { width: 1200, height: 630 });
  assert.throws(() => assertPng("not-a-buffer"), /must be a PNG file/);
  assert.throws(() => assertPng(new Uint8Array(png)), /must be a PNG file/);
  const corrupted = Buffer.from(png);
  corrupted[corrupted.length - 1] ^= 0xff;
  assert.throws(() => assertPng(corrupted), /integrity check/);
  assert.throws(() => assertPng(Buffer.alloc(64)), /not a valid PNG/);
});

test("pagination cursors encrypt positions and authenticate their view binding", () => {
  const codec = createCursorCodec(Buffer.alloc(32, 0x42));
  const position = [
    "confidential-family-marker",
    "confidential-given-marker",
    "private-record-position",
  ];
  const binding = {
    schoolId: "school-marker",
    userId: "user-marker",
    role: "coordinator",
    dataScope: "school",
    view: "collection",
    filters: { query: "confidential-search-marker", active: "true" },
  };
  const cursor = codec.encode("students", position, binding);
  const secondCursor = codec.encode("students", position, binding);
  assert.notEqual(cursor, secondCursor);
  assert.match(cursor, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const decodedEnvelope = cursor
    .split(".")
    .map((part) => Buffer.from(part, "base64url").toString("utf8"))
    .join("");
  for (const secret of [
    ...position,
    ...Object.values(binding).filter((value) => typeof value === "string"),
    binding.filters.query,
  ]) {
    assert.equal(cursor.includes(secret), false);
    assert.equal(decodedEnvelope.includes(secret), false);
  }
  assert.deepEqual(
    codec.decode(cursor, "students", ["string", "string", "string"], binding),
    position,
  );
  assert.throws(
    () => codec.decode(
      cursor,
      "students",
      ["string", "string", "string"],
      { ...binding, userId: "another-user" },
    ),
    /pagination cursor is invalid/,
  );
  const [header, sealed] = cursor.split(".");
  const tampered = `${header}.${sealed[0] === "A" ? "B" : "A"}${sealed.slice(1)}`;
  assert.throws(
    () => codec.decode(tampered, "students", ["string", "string", "string"], binding),
    /pagination cursor is invalid/,
  );
});

test("dates must exist and time values must resolve to whole minutes", () => {
  assert.equal(isIsoDate("2024-02-29"), true);
  assert.equal(isIsoDate("2025-02-29"), false);
  assert.equal(hoursToMinutes(1.25), 75);
  assert.throws(() => hoursToMinutes(1 / 7), /whole minutes/);
});
