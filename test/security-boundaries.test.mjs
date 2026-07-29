import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadConfig } from "../server/config.mjs";
import { createCursorCodec } from "../server/cursor.mjs";
import { hashPassword, verifyPassword } from "../server/password.mjs";
import {
  assertBrandPalette,
  assertPng,
  hoursToMinutes,
  isIsoDate,
} from "../server/validation.mjs";

test("production configuration requires an origin and bounded proxy trust", () => {
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
  assert.throws(
    () => loadConfig({
      NODE_ENV: "production",
      VECTOR_ORIGIN: "http://vector.example.test",
      VECTOR_COOKIE_SECURE: "false",
    }),
    /local loopback/,
  );
  const loopback = loadConfig({
    NODE_ENV: "production",
    VECTOR_ORIGIN: "http://127.0.0.1:4173",
    VECTOR_COOKIE_SECURE: "false",
  });
  assert.equal(loopback.cookieSecure, false);
  const config = loadConfig({
    NODE_ENV: "production",
    VECTOR_ORIGIN: "https://vector.example.test",
    VECTOR_TRUST_PROXY: "1",
  });
  assert.equal(config.trustProxy, 1);
  assert.equal(config.cookieSecure, true);
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

test("password verification accepts a valid scrypt hash and rejects malformed cost parameters", async () => {
  const hash = await hashPassword("a-strong-test-password-2026");
  assert.equal(await verifyPassword("a-strong-test-password-2026", hash), true);
  assert.equal(await verifyPassword("wrong-password", hash), false);
  assert.equal(
    await verifyPassword("a-strong-test-password-2026", hash.replace("$16384$", "$1048576$")),
    false,
  );
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
