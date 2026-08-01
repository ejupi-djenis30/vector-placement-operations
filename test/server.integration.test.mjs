import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { gzipSync } from "node:zlib";
import Database from "better-sqlite3";
import {
  createSession,
  deleteExpiredSessions,
  MAX_ACTIVE_SESSIONS_PER_USER,
  readSession,
  touchSession,
} from "../server/auth.mjs";
import { createErrorHandler } from "../server/app.mjs";
import { ADMIN_PASSWORD, startTestApp } from "../test-support/server-test-helper.mjs";

const running = new Set();

afterEach(async () => {
  await Promise.all([...running].map((instance) => instance.close()));
  running.clear();
});

async function app(options) {
  const instance = await startTestApp(options);
  running.add(instance);
  return instance;
}

function compressedAsset(baseUrl, pathname, encoding) {
  const url = new URL(pathname, baseUrl);
  return new Promise((resolve, reject) => {
    const request = httpGet({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: { "Accept-Encoding": encoding },
    }, (response) => {
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
      });
      response.on("end", () => resolve({
        bytes,
        contentType: response.headers["content-type"],
        encoding: response.headers["content-encoding"],
        status: response.statusCode,
      }));
    });
    request.on("error", reject);
  });
}

function conditionalAsset(baseUrl, pathname, etag) {
  const url = new URL(pathname, baseUrl);
  return new Promise((resolve, reject) => {
    const request = httpGet({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: {
        "Accept-Encoding": "identity",
        "If-None-Match": etag,
      },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
  });
}

function rawHttp(baseUrl, headerLines, body = "") {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname);
    let response = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.once("end", () => resolve(response));
    socket.once("connect", () => {
      socket.end(`${headerLines.join("\r\n")}\r\n\r\n${body}`);
    });
  });
}

function disconnectMidBody(baseUrl, headerLines, partialBody) {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname);
    let settled = false;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      if (error && error.code !== "ECONNRESET") reject(error);
      else resolve();
    };
    socket.once("error", finish);
    socket.once("close", () => finish());
    socket.once("connect", () => {
      socket.write(`${headerLines.join("\r\n")}\r\n\r\n${partialBody}`);
      setImmediate(() => socket.destroy());
    });
  });
}

async function createUser(client, input) {
  const result = await client.request("/api/users", { method: "POST", body: input });
  assert.equal(result.response.status, 201);
  return result.payload.id;
}

function assertApiSessionCookie(header, { cleared = false } = {}) {
  assert.ok(header);
  assert.match(header, /(?:^|;\s*)Path=\/api(?:;|$)/);
  assert.doesNotMatch(header, /(?:^|;\s*)Path=\/(?:;|$)/);
  if (cleared) assert.match(header, /^vector_session=;/);
  else assert.doesNotMatch(header, /^vector_session=;/);
}

async function replaceTemporaryPassword(client, email, currentPassword, newPassword) {
  const login = await client.login(email, currentPassword);
  assert.equal(login.response.status, 200);
  assert.equal(login.payload.user.mustChangePassword, true);
  const changed = await client.request("/api/auth/change-password", {
    method: "POST",
    body: { currentPassword, newPassword },
  });
  assert.equal(changed.response.status, 200);
  const replacement = await client.login(email, newPassword);
  assert.equal(replacement.response.status, 200);
  assert.equal(replacement.payload.user.mustChangePassword, false);
}

test("API throttling, static compression and browser capability boundaries stay scoped", async () => {
  const instance = await app();
  const health = await instance.client.request("/api/health/live");
  assert.equal(health.response.status, 200);
  assert.equal(health.response.headers.get("ratelimit-policy"), null);
  assert.equal(
    health.response.headers.get("permissions-policy"),
    "camera=(), display-capture=(), geolocation=(), microphone=(), payment=(), usb=()",
  );
  const healthWithBody = await rawHttp(instance.baseUrl, [
    "GET /api/health/live HTTP/1.1",
    "Host: 127.0.0.1",
    "Accept: application/json",
    "Content-Type: application/json",
    "Content-Length: 2",
    "Connection: close",
  ], "{}");
  assert.match(healthWithBody, /^HTTP\/1\.1 200 OK/);
  assert.match(healthWithBody, /RateLimit-Policy:/i);
  const workspace = await fetch(`${instance.baseUrl}/app/`, { redirect: "manual" });
  assert.equal(workspace.status, 200);
  assert.equal(workspace.headers.get("ratelimit-policy"), null);
  assert.doesNotMatch(
    workspace.headers.get("content-security-policy") ?? "",
    /upgrade-insecure-requests/i,
  );
  const workspaceAsset = await fetch(`${instance.baseUrl}/app/workspace.mjs`, {
    headers: { "accept-encoding": "gzip" },
  });
  assert.equal(workspaceAsset.status, 200);
  assert.equal(workspaceAsset.headers.get("content-encoding"), "gzip");
  assert.equal(workspaceAsset.headers.get("cache-control"), "no-cache");
  assert.match(workspaceAsset.headers.get("vary") ?? "", /Accept-Encoding/i);
  assert.equal(workspaceAsset.headers.get("ratelimit-policy"), null);
  assert.equal(
    workspaceAsset.headers.get("permissions-policy"),
    "camera=(), display-capture=(), geolocation=(), microphone=(), payment=(), usb=()",
  );
  const brotliAsset = await compressedAsset(
    instance.baseUrl,
    "/app/workspace.mjs",
    "br",
  );
  assert.equal(brotliAsset.status, 200);
  assert.equal(brotliAsset.encoding, "br");
  assert.ok(
    brotliAsset.bytes < 35_000,
    `The compressed workspace exceeded its 35 KB transfer budget: ${brotliAsset.bytes} bytes.`,
  );
  let workspaceModuleBytes = brotliAsset.bytes;
  for (const pathname of [
    "/app/workspace-domain.mjs",
    "/app/workspace-programmes.mjs",
    "/app/workspace-ui.mjs",
  ]) {
    const moduleAsset = await compressedAsset(instance.baseUrl, pathname, "br");
    assert.equal(moduleAsset.status, 200, pathname);
    assert.equal(moduleAsset.encoding, "br", pathname);
    assert.match(moduleAsset.contentType, /javascript/, pathname);
    workspaceModuleBytes += moduleAsset.bytes;
  }
  assert.ok(
    workspaceModuleBytes < 35_000,
    `The compressed workspace module graph exceeded its 35 KB transfer budget: ${workspaceModuleBytes} bytes.`,
  );

  const cssAssets = new Map();
  for (const pathname of [
    "/styles/shared.css",
    "/styles/marketing.css",
    "/styles/workspace.css",
  ]) {
    const asset = await compressedAsset(instance.baseUrl, pathname, "br");
    assert.equal(asset.status, 200, pathname);
    assert.equal(asset.encoding, "br", pathname);
    assert.match(asset.contentType, /^text\/css\b/i, pathname);
    cssAssets.set(pathname, asset.bytes);
  }
  assert.ok(
    cssAssets.get("/styles/shared.css") < 1_500,
    `Shared CSS exceeded its 1.5 KB Brotli budget: ${cssAssets.get("/styles/shared.css")} bytes.`,
  );
  assert.ok(
    cssAssets.get("/styles/shared.css") + cssAssets.get("/styles/marketing.css") < 7_000,
    "The public presentation CSS graph exceeded its 7 KB Brotli budget.",
  );
  assert.ok(
    cssAssets.get("/styles/shared.css") + cssAssets.get("/styles/workspace.css") < 7_000,
    "The authenticated workspace CSS graph exceeded its 7 KB Brotli budget.",
  );
  const legacyStylesheet = await fetch(`${instance.baseUrl}/styles.css`, {
    headers: { Accept: "text/css" },
    redirect: "manual",
  });
  assert.equal(legacyStylesheet.status, 404);

  const etag = workspaceAsset.headers.get("etag");
  assert.ok(etag);
  assert.equal(
    await conditionalAsset(instance.baseUrl, "/app/workspace.mjs", etag),
    304,
  );

  const tinyAsset = await fetch(`${instance.baseUrl}/robots.txt`, {
    headers: { "accept-encoding": "gzip" },
  });
  assert.equal(tinyAsset.status, 200);
  assert.equal(tinyAsset.headers.get("content-encoding"), null);
  assert.equal(tinyAsset.headers.get("cache-control"), "no-cache");
  assert.match(tinyAsset.headers.get("content-type") ?? "", /^text\/plain\b/i);
  assert.equal(await tinyAsset.text(), "User-agent: *\nDisallow: /\n");

  const unsupportedCompression = await fetch(`${instance.baseUrl}/app/workspace.mjs`, {
    headers: { "accept-encoding": "compress" },
  });
  assert.equal(unsupportedCompression.status, 200);
  assert.equal(unsupportedCompression.headers.get("content-encoding"), null);

  for (const pathname of [
    "/app/%2e%2e%2fserver%2fapp.mjs",
    "/app/%2e%2e%5cserver%5capp.mjs",
    "/assets/%2e%2e%2fpackage.json",
  ]) {
    const traversal = await fetch(`${instance.baseUrl}${pathname}`, {
      headers: { accept: "application/json" },
      redirect: "manual",
    });
    assert.equal(traversal.status, 404);
    assert.equal((await traversal.text()).includes("bootstrapDatabase"), false);
  }
});

test("draining keeps liveness observable while readiness and new work fail closed", async () => {
  const instance = await app();
  assert.equal(instance.app.locals.vector.isDraining(), false);
  instance.app.locals.vector.beginDrain();
  instance.app.locals.vector.beginDrain();
  assert.equal(instance.app.locals.vector.isDraining(), true);

  const live = await instance.client.request("/api/health/live");
  assert.equal(live.response.status, 200);
  assert.equal(live.payload.status, "ok");
  assert.equal(live.response.headers.get("connection"), "close");

  for (const path of ["/api/health/ready", "/api/public/branding", "/app/"]) {
    const response = await fetch(`${instance.baseUrl}${path}`, {
      headers: { accept: "application/json" },
    });
    const payload = await response.json();
    assert.equal(response.status, 503, path);
    assert.equal(response.ok, false, path);
    assert.equal(response.headers.get("cache-control"), "no-store", path);
    assert.equal(response.headers.get("connection"), "close", path);
    assert.equal(response.headers.get("retry-after"), "1", path);
    assert.equal(payload.error.code, "service_draining", path);
    assert.equal(payload.error.requestId, response.headers.get("x-request-id"), path);
  }
  assert.equal(instance.db.open, true);
});

test("public HEAD mirrors GET while private HEAD stays authenticated and side-effect-free", async () => {
  const instance = await app();
  for (const [pathname, status, contentType] of [
    ["/api/health/live", 200, "application/json"],
    ["/api/health/ready", 200, "application/json"],
    ["/api/public/branding", 200, "application/json"],
    ["/api/public/branding.css", 200, "text/css"],
    ["/api/public/branding/logo", 404, "application/json"],
    ["/api/session", 200, "application/json"],
  ]) {
    const response = await fetch(`${instance.baseUrl}${pathname}`, { method: "HEAD" });
    assert.equal(response.status, status, pathname);
    assert.match(response.headers.get("content-type") ?? "", new RegExp(contentType));
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  }

  const anonymous = await fetch(`${instance.baseUrl}/api/dashboard`, { method: "HEAD" });
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.arrayBuffer()).byteLength, 0);

  assert.equal((await instance.client.login()).response.status, 200);
  const before = instance.db.prepare(
    "SELECT last_seen_at AS lastSeenAt FROM sessions LIMIT 1",
  ).get();
  const authenticated = await fetch(`${instance.baseUrl}/api/dashboard`, {
    method: "HEAD",
    headers: { cookie: instance.client.cookie },
  });
  assert.equal(authenticated.status, 200);
  assert.equal((await authenticated.arrayBuffer()).byteLength, 0);
  const after = instance.db.prepare(
    "SELECT last_seen_at AS lastSeenAt FROM sessions LIMIT 1",
  ).get();
  assert.deepEqual(after, before);
});

test("header, body and partial-response failures stay bounded and use stable errors", async () => {
  const instance = await app();
  const requestHeaders = (count) => [
    "GET /api/health/live HTTP/1.1",
    "Host: 127.0.0.1",
    "Accept: application/json",
    ...Array.from(
      { length: count - 3 },
      (_value, index) => `X-Probe-${index}: ${index}`,
    ),
    "Connection: close",
  ];
  const boundary = await rawHttp(instance.baseUrl, requestHeaders(100));
  assert.match(boundary, /^HTTP\/1\.1 200 OK/);

  const excessive = await rawHttp(instance.baseUrl, requestHeaders(101));
  assert.match(excessive, /^HTTP\/1\.1 431 /);
  assert.match(excessive, /"code":"too_many_headers"/);
  assert.match(excessive, /Cache-Control: no-store/i);

  const oversizedHeaderBlock = await rawHttp(instance.baseUrl, [
    "GET /api/health/live HTTP/1.1",
    "Host: 127.0.0.1",
    `X-Oversized: ${"x".repeat(17_000)}`,
    "Connection: close",
  ]);
  assert.match(oversizedHeaderBlock, /^HTTP\/1\.1 431 /);

  const duplicateHeaderRequests = [
    {
      name: "host",
      headers: [
        "GET /api/health/live HTTP/1.1",
        "Host: 127.0.0.1",
        "Host: attacker.example",
        "Connection: close",
      ],
      body: "",
    },
    {
      name: "origin",
      headers: [
        "POST /api/auth/login HTTP/1.1",
        "Host: 127.0.0.1",
        `Origin: ${instance.config.origin}`,
        "Origin: https://attacker.example",
        "Content-Type: application/json",
        "Content-Length: 2",
        "Connection: close",
      ],
      body: "{}",
    },
    {
      name: "content type",
      headers: [
        "POST /api/auth/login HTTP/1.1",
        "Host: 127.0.0.1",
        `Origin: ${instance.config.origin}`,
        "Content-Type: application/json",
        "Content-Type: text/plain",
        "Content-Length: 2",
        "Connection: close",
      ],
      body: "{}",
    },
    {
      name: "content encoding",
      headers: [
        "POST /api/auth/login HTTP/1.1",
        "Host: 127.0.0.1",
        `Origin: ${instance.config.origin}`,
        "Content-Type: application/json",
        "Content-Encoding: identity",
        "Content-Encoding: gzip",
        "Content-Length: 2",
        "Connection: close",
      ],
      body: "{}",
    },
    {
      name: "session cookie within one header field",
      headers: [
        "GET /api/session HTTP/1.1",
        "Host: 127.0.0.1",
        "Cookie: vector_session=first; vector_session=second",
        "Connection: close",
      ],
      body: "",
    },
  ];
  for (const probe of duplicateHeaderRequests) {
    const response = await rawHttp(instance.baseUrl, probe.headers, probe.body);
    assert.match(response, /^HTTP\/1\.1 400 /, probe.name);
    assert.match(response, /"code":"ambiguous_request_headers"/, probe.name);
  }

  for (const probe of [
    {
      name: "content-length plus transfer-encoding",
      headers: [
        "POST /api/auth/login HTTP/1.1",
        "Host: 127.0.0.1",
        "Content-Type: application/json",
        "Content-Length: 2",
        "Transfer-Encoding: chunked",
        "Connection: close",
      ],
      body: "0\r\n\r\n",
    },
    {
      name: "duplicate content-length",
      headers: [
        "POST /api/auth/login HTTP/1.1",
        "Host: 127.0.0.1",
        "Content-Type: application/json",
        "Content-Length: 2",
        "Content-Length: 2",
        "Connection: close",
      ],
      body: "{}",
    },
  ]) {
    const response = await rawHttp(instance.baseUrl, probe.headers, probe.body);
    assert.match(response, /^HTTP\/1\.1 400 /, probe.name);
  }

  const compressedBomb = gzipSync(JSON.stringify({
    value: "x".repeat(instance.config.bodyLimit + 1),
  }));
  assert.ok(compressedBomb.length < instance.config.bodyLimit);
  const bombResponse = await fetch(`${instance.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      accept: "application/json",
      origin: instance.config.origin,
      "content-type": "application/json",
      "content-encoding": "gzip",
    },
    body: compressedBomb,
  });
  assert.equal(bombResponse.status, 413);
  assert.equal((await bombResponse.json()).error.code, "payload_too_large");

  const truncatedGzip = gzipSync(JSON.stringify({ value: "complete" }));
  const truncatedResponse = await fetch(`${instance.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      accept: "application/json",
      origin: instance.config.origin,
      "content-type": "application/json",
      "content-encoding": "gzip",
    },
    body: truncatedGzip.subarray(0, Math.floor(truncatedGzip.length / 2)),
  });
  assert.equal(truncatedResponse.status, 400);
  assert.equal(
    (await truncatedResponse.json()).error.code,
    "invalid_content_encoding",
  );

  assert.equal((await instance.client.login()).response.status, 200);
  const malformedPath = await rawHttp(instance.baseUrl, [
    "GET /api/placements/% HTTP/1.1",
    "Host: 127.0.0.1",
    "Accept: application/json",
    `Cookie: ${instance.client.cookie}`,
    "Connection: close",
  ]);
  assert.match(malformedPath, /^HTTP\/1\.1 400 /);
  assert.match(malformedPath, /"code":"request_rejected"/);

  const beforeAbortedLogin = instance.db.prepare(
    "SELECT COUNT(*) FROM audit_events WHERE action = 'auth.login_failed'",
  ).pluck().get();
  await disconnectMidBody(instance.baseUrl, [
    "POST /api/auth/login HTTP/1.1",
    "Host: 127.0.0.1",
    `Origin: ${instance.config.origin}`,
    "Content-Type: application/json",
    "Content-Length: 4096",
    "Connection: close",
  ], '{"email":"partial@example.test",');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    instance.db.prepare(
      "SELECT COUNT(*) FROM audit_events WHERE action = 'auth.login_failed'",
    ).pluck().get(),
    beforeAbortedLogin,
  );
  assert.equal(
    (await instance.client.request("/api/health/ready")).response.status,
    200,
  );

  const malformedBodies = [
    {
      name: "invalid JSON",
      headers: { "content-type": "application/json" },
      body: "{",
      status: 400,
      code: "invalid_json",
    },
    {
      name: "invalid gzip",
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
      },
      body: "not-gzip",
      status: 400,
      code: "invalid_content_encoding",
    },
    {
      name: "unsupported content encoding",
      headers: {
        "content-type": "application/json",
        "content-encoding": "compress",
      },
      body: "{}",
      status: 415,
      code: "unsupported_content_encoding",
    },
    {
      name: "unsupported charset",
      headers: { "content-type": "application/json; charset=x-unknown" },
      body: "{}",
      status: 415,
      code: "unsupported_charset",
    },
    {
      name: "oversized JSON",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(instance.config.bodyLimit) }),
      status: 413,
      code: "payload_too_large",
    },
  ];
  for (const probe of malformedBodies) {
    const response = await fetch(`${instance.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        accept: "application/json",
        origin: instance.config.origin,
        ...probe.headers,
      },
      body: probe.body,
    });
    const payload = await response.json();
    assert.equal(response.status, probe.status, probe.name);
    assert.equal(payload.error.code, probe.code, probe.name);
    assert.equal(
      response.headers.get("x-request-id"),
      payload.error.requestId,
      probe.name,
    );
    assert.equal(response.headers.get("cache-control"), "no-store", probe.name);
    assert.equal("stack" in payload.error, false, probe.name);
  }

  const forwarded = [];
  const handler = createErrorHandler({ logLevel: "silent", production: true });
  handler(
    new Error("stream failed"),
    { id: "request-id", method: "GET", path: "/download" },
    {
      headersSent: true,
      status() {
        throw new Error("must not write a second response");
      },
    },
    (error) => forwarded.push(error),
  );
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].message, "stream failed");
});

test("non-API routes never enter the metered JSON parser", async () => {
  const instance = await app();
  const response = await fetch(`${instance.baseUrl}/not-an-api-route`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: "{",
  });
  const payload = await response.json();
  assert.equal(response.status, 404);
  assert.equal(payload.error.code, "not_found");
  assert.equal(response.headers.get("ratelimit-policy"), null);
  assert.equal(response.headers.get("x-request-id"), payload.error.requestId);
});

test("readiness fails closed when migration identity or schema no longer matches the build", async () => {
  const instance = await app();
  const ready = await instance.client.request("/api/health/ready");
  assert.equal(ready.response.status, 200);
  const migration = instance.db.prepare(`
    SELECT version, checksum
    FROM schema_migrations
    ORDER BY version DESC
    LIMIT 1
  `).get();
  instance.db.prepare(
    "UPDATE schema_migrations SET checksum = ? WHERE version = ?",
  ).run("0".repeat(64), migration.version);
  const unavailable = await instance.client.request("/api/health/ready");
  assert.equal(unavailable.response.status, 503);
  assert.equal(unavailable.payload.error.code, "not_ready");
  assert.equal(
    unavailable.response.headers.get("x-request-id"),
    unavailable.payload.error.requestId,
  );
  instance.db.prepare(
    "UPDATE schema_migrations SET checksum = ? WHERE version = ?",
  ).run(migration.checksum, migration.version);
  assert.equal(
    (await instance.client.request("/api/health/ready")).response.status,
    200,
  );
  instance.db.exec("DROP TRIGGER sessions_user_capacity");
  const drifted = await instance.client.request("/api/health/ready");
  assert.equal(drifted.response.status, 503);
  assert.equal(drifted.payload.error.code, "not_ready");
});

test("bounded SQLite write contention returns a retryable service response", async () => {
  const root = await mkdtemp(join(tmpdir(), "vector-api-busy-"));
  let instance = null;
  let blocker = null;
  try {
    const databasePath = join(root, "vector.sqlite");
    instance = await app({ databasePath });
    assert.equal((await instance.client.login()).response.status, 200);
    instance.db.pragma("busy_timeout = 75");
    blocker = new Database(databasePath, { fileMustExist: true });
    blocker.exec("BEGIN IMMEDIATE");

    const startedAt = Date.now();
    const result = await instance.client.request("/api/auth/logout", {
      method: "POST",
      body: {},
    });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(result.response.status, 503);
    assert.equal(result.payload.error.code, "database_busy");
    assert.equal(result.payload.error.message, "The database is busy. Try again shortly.");
    assert.equal(result.response.headers.get("retry-after"), "1");
    assert.equal("details" in result.payload.error, false);
    assert.ok(elapsedMs >= 50, `SQLite returned before its busy wait: ${elapsedMs} ms.`);
    assert.ok(elapsedMs < 1_000, `SQLite exceeded the bounded API wait: ${elapsedMs} ms.`);
  } finally {
    if (blocker?.inTransaction) blocker.exec("ROLLBACK");
    blocker?.close();
    if (instance) {
      running.delete(instance);
      await instance.close();
    }
    await rm(root, { force: true, recursive: true });
  }
});

test("unknown non-application 4xx errors fail closed without exposing library diagnostics", () => {
  const state = { headers: {} };
  const response = {
    headersSent: false,
    set(name, value) {
      state.headers[name] = value;
      return this;
    },
    status(value) {
      state.status = value;
      return this;
    },
    json(value) {
      state.payload = value;
      return this;
    },
  };
  const handler = createErrorHandler({ logLevel: "silent", production: true });
  const error = Object.assign(
    new Error("future-library-private-diagnostic"),
    {
      status: 422,
      code: "future_library_failure",
      details: { record: "SensitiveRecordIdentifier" },
    },
  );
  handler(
    error,
    {
      id: "request-library-4xx",
      method: "GET",
      path: "/api/placements/SensitiveRecordIdentifier",
      route: { path: "/api/placements/:id" },
    },
    response,
    () => assert.fail("The normalized response must not be delegated."),
  );
  assert.equal(state.status, 422);
  assert.equal(state.headers["Cache-Control"], "no-store");
  assert.deepEqual(state.payload, {
    error: {
      code: "request_rejected",
      message: "The request could not be accepted.",
      requestId: "request-library-4xx",
    },
  });
  assert.equal(JSON.stringify(state.payload).includes("future-library"), false);
  assert.equal(JSON.stringify(state.payload).includes("SensitiveRecordIdentifier"), false);
});

test("rate-limit identity ignores spoofed forwarding headers unless a proxy hop is trusted", async () => {
  const direct = await app();
  const validationLogs = [];
  const originalConsoleError = console.error;
  console.error = (...values) => validationLogs.push(values.join(" "));
  try {
    const statuses = [];
    for (let index = 1; index <= 9; index += 1) {
      const result = await direct.client.request("/api/auth/login", {
        method: "POST",
        body: {
          email: "nobody@example.test",
          password: "incorrect-password",
        },
        includeCsrf: false,
        headers: { "x-forwarded-for": `203.0.113.${index}` },
      });
      statuses.push(result.response.status);
    }
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 401, 401, 401, 429]);
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(
    validationLogs.some((entry) => entry.includes("ERR_ERL_UNEXPECTED_X_FORWARDED_FOR")),
    false,
  );

  const proxied = await app({ env: { VECTOR_TRUST_PROXY: "1" } });
  const duplicateForwarded = await rawHttp(proxied.baseUrl, [
    "GET /api/health/live HTTP/1.1",
    "Host: 127.0.0.1",
    "X-Forwarded-For: 198.51.100.10",
    "X-Forwarded-For: 203.0.113.10",
    "Connection: close",
  ]);
  assert.match(duplicateForwarded, /^HTTP\/1\.1 400 /);
  assert.match(duplicateForwarded, /"code":"ambiguous_request_headers"/);
  const proxiedStatuses = [];
  for (let index = 1; index <= 9; index += 1) {
    const result = await proxied.client.request("/api/auth/login", {
      method: "POST",
      body: {
        email: "nobody@example.test",
        password: "incorrect-password",
      },
      includeCsrf: false,
      headers: { "x-forwarded-for": `198.51.100.${index}` },
    });
    proxiedStatuses.push(result.response.status);
  }
  assert.deepEqual(proxiedStatuses, [401, 401, 401, 401, 401, 401, 401, 401, 401]);
});

test("explicit cross-origin mutations are rejected before API budgets and body parsing", async () => {
  const instance = await app();
  const malformed = await fetch(`${instance.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      accept: "application/json",
      origin: "https://attacker.example",
      "content-type": "application/json",
      "content-encoding": "gzip",
    },
    body: "not-a-gzip-stream",
  });
  assert.equal(malformed.status, 403);
  assert.equal((await malformed.json()).error.code, "invalid_origin");
  assert.equal(malformed.headers.get("ratelimit-policy"), null);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const crossOrigin = await instance.client.request("/api/auth/login", {
      method: "POST",
      body: {
        email: "admin@example.test",
        password: ADMIN_PASSWORD,
      },
      includeCsrf: false,
      headers: { origin: "https://attacker.example" },
    });
    assert.equal(crossOrigin.response.status, 403);
    assert.equal(crossOrigin.payload.error.code, "invalid_origin");
    assert.equal(crossOrigin.response.headers.get("ratelimit-policy"), null);
  }
  assert.equal((await instance.client.login()).response.status, 200);

  const missingOrigin = await fetch(`${instance.baseUrl}/api/hosts`, {
    method: "POST",
    headers: {
      accept: "application/json",
      cookie: instance.client.cookie,
      "content-type": "application/json",
      "x-csrf-token": instance.client.csrfToken,
    },
    body: JSON.stringify({ name: "Origin must still be present" }),
  });
  assert.equal(missingOrigin.status, 403);
  assert.equal((await missingOrigin.json()).error.code, "invalid_origin");
  assert.ok(missingOrigin.headers.get("ratelimit-policy"));
});

test("failed login auditing is identity-blind for known, unknown and inactive accounts", async () => {
  const instance = await app();
  const { client, db } = instance;
  assert.equal((await client.login()).response.status, 200);
  const inactiveId = await createUser(client, {
    email: "inactive.login@example.test",
    displayName: "Inactive login",
    password: "inactive-login-password-2026",
    role: "viewer",
    dataScope: "school",
  });
  db.prepare("UPDATE users SET active = 0 WHERE id = ?").run(inactiveId);
  const schoolId = db.prepare("SELECT id FROM schools ORDER BY created_at, id LIMIT 1").pluck().get();

  const attempts = [
    ["admin@example.test", "incorrect-known-password"],
    ["unknown.login@example.test", "incorrect-unknown-password"],
    ["inactive.login@example.test", "inactive-login-password-2026"],
  ];
  const auditShapes = [];
  for (const [email, password] of attempts) {
    const before = db.prepare(
      "SELECT COUNT(*) FROM audit_events WHERE action = 'auth.login_failed'",
    ).pluck().get();
    const result = await instance.newClient().login(email, password);
    assert.equal(result.response.status, 401);
    assert.equal(result.payload.error.code, "invalid_credentials");
    assert.equal(result.payload.error.message, "Email or password is incorrect.");
    assert.match(result.response.headers.get("ratelimit-policy"), /w=60/);
    const after = db.prepare(
      "SELECT COUNT(*) FROM audit_events WHERE action = 'auth.login_failed'",
    ).pluck().get();
    assert.equal(after, before + 1);
    auditShapes.push(db.prepare(`
      SELECT
        school_id AS schoolId,
        actor_user_id AS actorUserId,
        entity_type AS entityType,
        entity_id AS entityId,
        metadata_json AS metadata
      FROM audit_events
      WHERE action = 'auth.login_failed'
      ORDER BY rowid DESC
      LIMIT 1
    `).get());
  }

  assert.deepEqual(auditShapes, Array.from({ length: attempts.length }, () => ({
    schoolId,
    actorUserId: null,
    entityType: "user",
    entityId: null,
    metadata: '{"reasonCode":"invalid_credentials"}',
  })));
});

test("invalid login attempts do not take the global expired-session cleanup path", async () => {
  const instance = await app();
  const userId = instance.db.prepare(
    "SELECT id FROM users WHERE email = 'admin@example.test'",
  ).pluck().get();
  instance.db.prepare(`
    INSERT INTO sessions (
      id, user_id, token_hash, csrf_token, expires_at, created_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    "expired-session-awaiting-authenticated-cleanup",
    userId,
    "expired-session-token-hash",
    "expired-session-csrf",
    "2000-01-01T00:00:00.000Z",
    "2000-01-01T00:00:00.000Z",
    "2000-01-01T00:00:00.000Z",
  );

  const invalid = await instance.newClient().login(
    "unknown.cleanup@example.test",
    "incorrect-cleanup-password",
  );
  assert.equal(invalid.response.status, 401);
  assert.equal(
    instance.db.prepare("SELECT COUNT(*) FROM sessions WHERE id = ?")
      .pluck().get("expired-session-awaiting-authenticated-cleanup"),
    1,
  );

  const valid = await instance.newClient().login();
  assert.equal(valid.response.status, 200);
  assert.equal(
    instance.db.prepare("SELECT COUNT(*) FROM sessions WHERE id = ?")
      .pluck().get("expired-session-awaiting-authenticated-cleanup"),
    0,
  );
});

test("authentication, CSRF and transactional audit controls protect mutations", async () => {
  const instance = await app();
  const { client, db } = instance;

  const anonymous = await client.request("/api/dashboard");
  assert.equal(anonymous.response.status, 401);
  assert.equal(anonymous.response.headers.get("cache-control"), "no-store");

  const invalidSession = await client.request("/api/dashboard", {
    headers: { cookie: "vector_session=not-a-valid-session" },
  });
  assert.equal(invalidSession.response.status, 401);
  assertApiSessionCookie(
    invalidSession.response.headers.get("set-cookie"),
    { cleared: true },
  );

  const unknown = await client.login("nobody@example.test", "incorrect-password");
  assert.equal(unknown.response.status, 401);
  assert.equal(unknown.payload.error.code, "invalid_credentials");

  const login = await client.login();
  assert.equal(login.response.status, 200);
  assertApiSessionCookie(login.response.headers.get("set-cookie"));
  assert.match(login.response.headers.get("set-cookie"), /HttpOnly/i);
  assert.match(login.response.headers.get("set-cookie"), /SameSite=Strict/i);

  const withoutCsrf = await client.request("/api/hosts", {
    method: "POST",
    body: { name: "Blocked host" },
    includeCsrf: false,
  });
  assert.equal(withoutCsrf.response.status, 403);
  assert.equal(withoutCsrf.payload.error.code, "invalid_csrf");

  db.exec(`
    CREATE TRIGGER reject_audit_insert
    BEFORE INSERT ON audit_events
    BEGIN
      SELECT RAISE(ABORT, 'audit unavailable');
    END
  `);
  const failed = await client.request("/api/hosts", {
    method: "POST",
    body: { name: "Must roll back" },
  });
  assert.equal(failed.response.status, 500);
  assert.equal(failed.payload.error.code, "internal_error");
  assert.equal("stack" in failed.payload.error, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM hosts").get().count, 0);
  db.exec("DROP TRIGGER reject_audit_insert");

  const audit = db.prepare("SELECT id FROM audit_events LIMIT 1").get();
  assert.throws(
    () => db.prepare("UPDATE audit_events SET action = 'changed' WHERE id = ?").run(audit.id),
    /append-only/,
  );
  assert.throws(
    () => db.prepare("DELETE FROM audit_events WHERE id = ?").run(audit.id),
    /append-only/,
  );

  const logout = await client.request("/api/auth/logout", {
    method: "POST",
    body: {},
  });
  assert.equal(logout.response.status, 200);
  assertApiSessionCookie(logout.response.headers.get("set-cookie"), { cleared: true });
});

test("logo mutations require a strong branding revision and admit one concurrent winner", async () => {
  const instance = await app();
  const { client, db } = instance;
  await client.login();
  const branding = await client.request("/api/public/branding");
  const revision = branding.payload.revision;
  assert.equal(branding.response.headers.get("etag"), `"${revision}"`);
  const png = await readFile(new URL("../site/assets/social-preview.png", import.meta.url));

  const missingPrecondition = await client.request("/api/branding/logo", {
    method: "PUT",
    contentType: "image/png",
    body: png,
  });
  assert.equal(missingPrecondition.response.status, 428);
  assert.equal(missingPrecondition.payload.error.code, "precondition_required");

  const malformedPrecondition = await client.request("/api/branding/logo", {
    method: "PUT",
    contentType: "image/png",
    headers: { "if-match": `W/"${revision}"` },
    body: png,
  });
  assert.equal(malformedPrecondition.response.status, 400);
  assert.equal(malformedPrecondition.payload.error.code, "invalid_precondition");

  const wrongMediaType = await client.request("/api/branding/logo", {
    method: "PUT",
    headers: { "if-match": `"${revision}"` },
    body: { disguisedAs: "a PNG" },
  });
  assert.equal(wrongMediaType.response.status, 415);
  assert.equal(wrongMediaType.payload.error.code, "unsupported_media_type");

  const contenders = await Promise.all([
    client.request("/api/branding/logo", {
      method: "PUT",
      contentType: "image/png",
      headers: { "if-match": `"${revision}"` },
      body: png,
    }),
    client.request("/api/branding/logo", {
      method: "PUT",
      contentType: "image/png",
      headers: { "if-match": `"${revision}"` },
      body: png,
    }),
  ]);
  const winner = contenders.find((result) => result.response.status === 200);
  const stale = contenders.find((result) => result.response.status === 409);
  assert.ok(winner);
  assert.ok(stale);
  assert.equal(stale.payload.error.code, "conflict");
  assert.equal(winner.payload.revision, revision + 1);
  assert.equal(winner.response.headers.get("etag"), `"${revision + 1}"`);
  assert.equal(
    db.prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'branding.logo_updated'",
    ).get().count,
    1,
  );

  const removed = await client.request("/api/branding/logo", {
    method: "DELETE",
    headers: { "if-match": `"${revision + 1}"` },
  });
  assert.equal(removed.response.status, 200);
  assert.equal(removed.payload.revision, revision + 2);
  assert.equal(removed.response.headers.get("etag"), `"${revision + 2}"`);
  assert.equal((await client.request("/api/public/branding/logo")).response.status, 404);
  assert.equal(
    db.prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'branding.logo_deleted'",
    ).get().count,
    1,
  );
});

test("a user can replace their own password and revoke every active session", async () => {
  const instance = await app({ requireBootstrapPasswordChange: true });
  const { client, db } = instance;
  const secondSession = instance.newClient();
  const initialLogin = await client.login();
  assert.equal(initialLogin.response.status, 200);
  assert.equal(initialLogin.payload.user.mustChangePassword, true);
  assert.equal((await secondSession.login()).response.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 2);
  const blockedWorkspace = await client.request("/api/dashboard");
  assert.equal(blockedWorkspace.response.status, 403);
  assert.equal(blockedWorkspace.payload.error.code, "password_change_required");

  const incorrect = await client.request("/api/auth/change-password", {
    method: "POST",
    body: {
      currentPassword: "not-the-current-password",
      newPassword: "replacement-password-2026",
    },
  });
  assert.equal(incorrect.response.status, 422);
  assert.equal(incorrect.payload.error.code, "invalid_current_password");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 2);

  const changed = await client.request("/api/auth/change-password", {
    method: "POST",
    body: {
      currentPassword: ADMIN_PASSWORD,
      newPassword: "replacement-password-2026",
    },
  });
  assert.equal(changed.response.status, 200);
  assertApiSessionCookie(changed.response.headers.get("set-cookie"), { cleared: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);
  assert.equal(
    db.prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'user.password_changed'",
    ).get().count,
    1,
  );

  assert.equal((await secondSession.request("/api/dashboard")).response.status, 401);
  assert.equal((await instance.newClient().login()).response.status, 401);
  const replacementLogin = await instance.newClient().login(
      "admin@example.test",
      "replacement-password-2026",
    );
  assert.equal(replacementLogin.response.status, 200);
  assert.equal(replacementLogin.payload.user.mustChangePassword, false);
});

test("roles enforce school-wide read-only access and tutor assignment boundaries", async () => {
  const instance = await app({ seedSynthetic: true });
  const { client } = instance;
  assert.equal((await client.login()).response.status, 200);

  const tutorPassword = "assigned-tutor-password-2026";
  const viewerPassword = "school-viewer-password-2026";
  const tutorId = await createUser(client, {
    email: "assigned.tutor@example.test",
    displayName: "Assigned tutor",
    password: tutorPassword,
    role: "tutor",
    dataScope: "assigned",
  });
  await createUser(client, {
    email: "school.viewer@example.test",
    displayName: "School viewer",
    password: viewerPassword,
    role: "viewer",
    dataScope: "school",
  });

  const students = (await client.request("/api/students")).payload.items;
  const hosts = (await client.request("/api/hosts")).payload.items;
  const placement = await client.request("/api/placements", {
    method: "POST",
    body: {
      studentId: students[0].id,
      hostId: hosts[0].id,
      periodId: null,
      schoolTutorId: tutorId,
      startDate: "2026-07-01",
      endDate: "2026-07-31",
      targetHours: 40,
      status: "active",
    },
  });
  assert.equal(placement.response.status, 201);

  const tutor = instance.newClient();
  const tutorCurrentPassword = "assigned-tutor-password-2026";
  await replaceTemporaryPassword(
    tutor,
    "assigned.tutor@example.test",
    tutorCurrentPassword,
    "assigned-tutor-replacement-2026",
  );
  const assigned = await tutor.request("/api/placements");
  assert.equal(assigned.response.status, 200);
  assert.deepEqual(assigned.payload.items.map((item) => item.id), [placement.payload.id]);

  for (const body of [
    { revision: 1, status: "review" },
    { revision: 1, targetHours: 80, notes: "Tutors cannot change placement structure." },
  ]) {
    const structuralWrite = await tutor.request(`/api/placements/${placement.payload.id}`, {
      method: "PATCH",
      body,
    });
    assert.equal(structuralWrite.response.status, 403);
    assert.equal(structuralWrite.payload.error.code, "forbidden");
  }

  const time = await tutor.request(`/api/placements/${placement.payload.id}/time-entries`, {
    method: "POST",
    body: {
      entryDate: "2026-07-02",
      hours: 4,
      verificationStatus: "verified",
      description: "Student-submitted activity",
    },
  });
  assert.equal(time.response.status, 201);
  const detail = await tutor.request(`/api/placements/${placement.payload.id}`);
  assert.equal(detail.payload.timeEntries[0].verificationStatus, "pending");
  assert.equal(detail.payload.timeEntries[0].canEdit, true);

  const draft = await tutor.request(`/api/placements/${placement.payload.id}/documents`, {
    method: "POST",
    body: {
      kind: "other",
      title: "Tutor draft evidence",
      status: "draft",
    },
  });
  assert.equal(draft.response.status, 201);
  const tutorDetail = await tutor.request(`/api/placements/${placement.payload.id}`);
  assert.equal(
    tutorDetail.payload.documents.find((item) => item.id === draft.payload.id).canEdit,
    true,
  );

  const signed = await tutor.request(`/api/placements/${placement.payload.id}/documents`, {
    method: "POST",
    body: {
      kind: "evaluation",
      title: "Evaluation",
      status: "signed",
    },
  });
  assert.equal(signed.response.status, 403);
  assert.equal(signed.payload.error.code, "document_validation_required");

  const viewer = instance.newClient();
  await replaceTemporaryPassword(
    viewer,
    "school.viewer@example.test",
    viewerPassword,
    "school-viewer-replacement-2026",
  );
  assert.equal((await viewer.request("/api/placements")).payload.items.length, 7);
  const viewerDetail = await viewer.request(`/api/placements/${placement.payload.id}`);
  assert.equal(viewerDetail.payload.timeEntries[0].canEdit, false);
  assert.equal(
    viewerDetail.payload.documents.find((item) => item.id === draft.payload.id).canEdit,
    false,
  );
  const adminDetail = await client.request(`/api/placements/${placement.payload.id}`);
  assert.equal(adminDetail.payload.timeEntries[0].canEdit, true);
  assert.equal(
    adminDetail.payload.documents.find((item) => item.id === draft.payload.id).canEdit,
    true,
  );
  const viewerWrite = await viewer.request("/api/hosts", {
    method: "POST",
    body: { name: "Viewer cannot create this" },
  });
  assert.equal(viewerWrite.response.status, 403);
  assert.equal(viewerWrite.payload.error.code, "forbidden");
});

test("assigned tutors cannot enumerate child records on unassigned placements", async () => {
  const instance = await app({ seedSynthetic: true });
  const { client } = instance;
  assert.equal((await client.login()).response.status, 200);
  const tutorPassword = "scope-tutor-temporary-2026";
  await createUser(client, {
    email: "scope.tutor@example.test",
    displayName: "Scope tutor",
    password: tutorPassword,
    role: "tutor",
    dataScope: "assigned",
  });

  const placements = await client.request("/api/placements?limit=100&status=active&query=");
  const placementId = placements.payload.items[0].id;
  const detail = await client.request(`/api/placements/${placementId}`);
  const timeEntry = await client.request(`/api/placements/${placementId}/time-entries`, {
    method: "POST",
    body: {
      entryDate: detail.payload.startDate,
      hours: 1,
      description: "Unassigned scope probe",
      verificationStatus: "pending",
    },
  });
  const checkIn = await client.request(`/api/placements/${placementId}/check-ins`, {
    method: "POST",
    body: {
      occurredAt: `${detail.payload.startDate}T10:00:00.000Z`,
      channel: "phone",
      summary: "Unassigned scope probe",
      nextAction: "",
    },
  });
  const document = await client.request(`/api/placements/${placementId}/documents`, {
    method: "POST",
    body: {
      kind: "other",
      title: "Unassigned scope probe",
      status: "draft",
      reference: "",
      dueDate: null,
    },
  });
  for (const result of [timeEntry, checkIn, document]) {
    assert.ok([200, 201].includes(result.response.status), JSON.stringify(result.payload));
  }

  const tutor = instance.newClient();
  await replaceTemporaryPassword(
    tutor,
    "scope.tutor@example.test",
    tutorPassword,
    "scope-tutor-permanent-2026",
  );
  assert.equal(
    (await tutor.request(`/api/placements/${placementId}`)).response.status,
    404,
  );
  const probes = [
    {
      known: `/api/placements/${placementId}/time-entries/${timeEntry.payload.id}`,
      missing: `/api/placements/${placementId}/time-entries/missing-time-entry`,
      body: { revision: 1, description: "Blocked" },
    },
    {
      known: `/api/placements/${placementId}/check-ins/${checkIn.payload.id}`,
      missing: `/api/placements/${placementId}/check-ins/missing-check-in`,
      body: { revision: 1, summary: "Blocked" },
    },
    {
      known: `/api/placements/${placementId}/documents/${document.payload.id}`,
      missing: `/api/placements/${placementId}/documents/missing-document`,
      body: { revision: document.payload.revision, title: "Blocked" },
    },
  ];
  for (const probe of probes) {
    const known = await tutor.request(probe.known, { method: "PATCH", body: probe.body });
    const missing = await tutor.request(probe.missing, { method: "PATCH", body: probe.body });
    assert.equal(known.response.status, 404);
    assert.equal(missing.response.status, 404);
    assert.equal(known.payload.error.code, "not_found");
    assert.deepEqual(known.payload.error.message, missing.payload.error.message);
  }
});

test("operational collections and reference lookups use bounded opaque cursors", async () => {
  const instance = await app({ seedSynthetic: true });
  const { client, db } = instance;
  await client.login();

  const placementIds = [];
  let cursor;
  do {
    const search = new URLSearchParams({ limit: "2", status: "all", query: "" });
    if (cursor) search.set("cursor", cursor);
    const page = await client.request(`/api/placements?${search}`);
    assert.equal(page.response.status, 200);
    assert.ok(page.payload.items.length <= 2);
    placementIds.push(...page.payload.items.map((item) => item.id));
    cursor = page.payload.nextCursor;
  } while (cursor);
  assert.equal(placementIds.length, 6);
  assert.equal(new Set(placementIds).size, placementIds.length);

  const students = await client.request("/api/students?limit=2&active=true&query=");
  assert.equal(students.response.status, 200);
  assert.equal(students.payload.items.length, 2);
  assert.match(students.payload.nextCursor, /^[A-Za-z0-9_.-]+$/);
  const [cursorHeader, sealedCursor] = students.payload.nextCursor.split(".");
  const tamperedCursor = `${cursorHeader}.${sealedCursor[0] === "A" ? "B" : "A"}${sealedCursor.slice(1)}`;
  const tampered = await client.request(
    `/api/students?limit=2&active=true&query=&cursor=${tamperedCursor}`,
  );
  assert.equal(tampered.response.status, 422);
  assert.equal(tampered.payload.error.code, "invalid_cursor");
  const rebound = await client.request(
    `/api/students?limit=2&active=false&query=&cursor=${students.payload.nextCursor}`,
  );
  assert.equal(rebound.response.status, 422);
  assert.equal(rebound.payload.error.code, "invalid_cursor");
  await createUser(client, {
    email: "cursor.viewer@example.test",
    displayName: "Cursor viewer",
    password: "cursor-viewer-password-2026",
    role: "viewer",
    dataScope: "school",
  });
  const viewer = instance.newClient();
  await replaceTemporaryPassword(
    viewer,
    "cursor.viewer@example.test",
    "cursor-viewer-password-2026",
    "cursor-viewer-replacement-2026",
  );
  const reboundScope = await viewer.request(
    `/api/students?limit=2&active=true&query=&cursor=${students.payload.nextCursor}`,
  );
  assert.equal(reboundScope.response.status, 422);
  assert.equal(reboundScope.payload.error.code, "invalid_cursor");
  const nextStudents = await client.request(
    `/api/students?limit=2&active=true&query=&cursor=${students.payload.nextCursor}`,
  );
  assert.equal(nextStudents.response.status, 200);
  assert.equal(
    nextStudents.payload.items.some(
      (item) => students.payload.items.some((previous) => previous.id === item.id),
    ),
    false,
  );

  const privateFirst = await client.request("/api/students", {
    method: "POST",
    body: {
      externalRef: "SYN-CURSOR-PRIVACY-01",
      firstName: "ConfidentialGivenMarker",
      lastName: "ConfidentialFamilyMarker",
      email: "",
      cohortId: null,
    },
  });
  assert.equal(privateFirst.response.status, 201);
  assert.equal((await client.request("/api/students", {
    method: "POST",
    body: {
      externalRef: "SYN-CURSOR-PRIVACY-02",
      firstName: "ConfidentialGivenMarkerTwo",
      lastName: "ConfidentialFamilyMarkerTwo",
      email: "",
      cohortId: null,
    },
  })).response.status, 201);
  const privatePage = await client.request(
    "/api/students?limit=1&active=true&query=SYN-CURSOR-PRIVACY-",
  );
  assert.equal(privatePage.response.status, 200);
  assert.ok(privatePage.payload.nextCursor);
  const privateEnvelope = privatePage.payload.nextCursor
    .split(".")
    .map((part) => Buffer.from(part, "base64url").toString("utf8"))
    .join("");
  for (const privatePosition of [
    privatePage.payload.items[0].firstName,
    privatePage.payload.items[0].firstName.toLowerCase(),
    privatePage.payload.items[0].lastName,
    privatePage.payload.items[0].lastName.toLowerCase(),
    privateFirst.payload.id,
  ]) {
    assert.equal(privatePage.payload.nextCursor.includes(privatePosition), false);
    assert.equal(privateEnvelope.includes(privatePosition), false);
  }

  const cohorts = await client.request("/api/reference-data/cohorts?limit=1");
  assert.equal(cohorts.response.status, 200);
  assert.equal(cohorts.payload.items.length, 1);
  assert.ok(cohorts.payload.nextCursor);
  const studentLookups = await client.request("/api/lookups/students?limit=2&query=");
  assert.equal(studentLookups.response.status, 200);
  assert.deepEqual(
    Object.keys(studentLookups.payload.items[0]).sort(),
    ["id", "label", "secondary"],
  );
  assert.equal((await client.request("/api/reference-data")).response.status, 404);

  const invalidCursor = await client.request("/api/hosts?cursor=not-a-cursor");
  assert.equal(invalidCursor.response.status, 422);
  assert.equal(invalidCursor.payload.error.code, "invalid_cursor");
  const oversizedPage = await client.request("/api/hosts?limit=101");
  assert.equal(oversizedPage.response.status, 400);
  assert.equal(oversizedPage.payload.error.code, "invalid_request");

  const schoolId = db.prepare("SELECT id FROM schools").get().id;
  const insert = db.prepare(`
    INSERT INTO students (
      id, school_id, external_ref, first_name, last_name, active,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
  `);
  const timestamp = "2020-01-01T00:00:00.000Z";
  db.transaction(() => {
    for (let index = 0; index < 1005; index += 1) {
      const suffix = String(index).padStart(4, "0");
      insert.run(
        `page-${suffix}`,
        schoolId,
        `SYN-PAGE-${suffix}`,
        "Page",
        `Student ${suffix}`,
        timestamp,
        timestamp,
      );
    }
    for (let index = 0; index < 2; index += 1) {
      insert.run(
        `unicode-${index}`,
        schoolId,
        `SYN-UNICODE-${index}`,
        "漢".repeat(120),
        `漢${index}`,
        timestamp,
        timestamp,
      );
    }
  })();
  const traversed = [];
  cursor = null;
  do {
    const search = new URLSearchParams({
      limit: "100",
      active: "false",
      query: "SYN-PAGE-",
    });
    if (cursor) search.set("cursor", cursor);
    const page = await client.request(`/api/students?${search}`);
    assert.equal(page.response.status, 200);
    traversed.push(...page.payload.items.map((item) => item.id));
    cursor = page.payload.nextCursor;
  } while (cursor);
  assert.equal(traversed.length, 1005);
  assert.equal(new Set(traversed).size, 1005);

  const unicode = await client.request(
    "/api/students?limit=1&active=false&query=SYN-UNICODE-",
  );
  assert.equal(unicode.response.status, 200);
  assert.ok(unicode.payload.nextCursor.length <= 2048);
  const unicodeNext = await client.request(
    `/api/students?limit=1&active=false&query=SYN-UNICODE-&cursor=${unicode.payload.nextCursor}`,
  );
  assert.equal(unicodeNext.response.status, 200);
});

test("exports fail closed above the documented cap and accept narrowing filters", async () => {
  const instance = await app();
  const { client, db } = instance;
  await client.login();
  const schoolId = db.prepare("SELECT id FROM schools").get().id;
  const insert = db.prepare(`
    INSERT INTO students (
      id, school_id, external_ref, first_name, last_name, active,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
  `);
  const timestamp = "2020-01-01T00:00:00.000Z";
  db.transaction(() => {
    for (let index = 0; index < 10_001; index += 1) {
      const suffix = String(index).padStart(5, "0");
      insert.run(
        `export-${suffix}`,
        schoolId,
        `SYN-EXPORT-${suffix}`,
        "Synthetic",
        `Export ${suffix}`,
        timestamp,
        timestamp,
      );
    }
  })();

  const rejected = await client.request("/api/export?resource=students&format=csv");
  assert.equal(rejected.response.status, 422);
  assert.equal(rejected.payload.error.code, "export_row_limit");

  const narrowed = await client.request(
    "/api/export?resource=students&format=csv&query=SYN-EXPORT-00000",
  );
  assert.equal(narrowed.response.status, 200, JSON.stringify(narrowed.payload));
  assert.match(narrowed.payload, /SYN-EXPORT-00000/);
});

test("audit cursors reject tampering, filter replay and another authorized user", async () => {
  const instance = await app();
  const { client } = instance;
  await client.login();
  for (let index = 0; index < 4; index += 1) {
    const createdHost = await client.request("/api/hosts", {
      method: "POST",
      body: { name: `Audit cursor host ${index}` },
    });
    assert.equal(createdHost.response.status, 201);
  }
  await createUser(client, {
    email: "cursor.coordinator@example.test",
    displayName: "Cursor coordinator",
    password: "cursor-coordinator-password-2026",
    role: "coordinator",
    dataScope: "school",
  });
  const page = await client.request("/api/audit?limit=2&action=");
  assert.equal(page.response.status, 200);
  assert.ok(page.payload.nextCursor);
  const [headerPart, sealedPart] = page.payload.nextCursor.split(".");
  const tamperedCursor = `${headerPart}.${sealedPart[0] === "A" ? "B" : "A"}${sealedPart.slice(1)}`;
  const tampered = await client.request(
    `/api/audit?limit=2&action=&cursor=${tamperedCursor}`,
  );
  assert.equal(tampered.response.status, 422);
  assert.equal(tampered.payload.error.code, "invalid_cursor");
  const rebound = await client.request(
    `/api/audit?limit=2&action=host.created&cursor=${page.payload.nextCursor}`,
  );
  assert.equal(rebound.response.status, 422);
  assert.equal(rebound.payload.error.code, "invalid_cursor");

  const coordinator = instance.newClient();
  await replaceTemporaryPassword(
    coordinator,
    "cursor.coordinator@example.test",
    "cursor-coordinator-password-2026",
    "cursor-coordinator-replacement-2026",
  );
  const reboundUser = await coordinator.request(
    `/api/audit?limit=2&action=&cursor=${page.payload.nextCursor}`,
  );
  assert.equal(reboundUser.response.status, 422);
  assert.equal(reboundUser.payload.error.code, "invalid_cursor");
});

test("a placement can close only after verified hours, a check-in and required evidence", async () => {
  const instance = await app();
  const { client } = instance;
  await client.login();

  const student = await client.request("/api/students", {
    method: "POST",
    body: {
      externalRef: "SYN-READY-01",
      firstName: "Alex",
      lastName: "Morgan",
      email: "alex.morgan@example.test",
      cohortId: null,
    },
  });
  const host = await client.request("/api/hosts", {
    method: "POST",
    body: { name: "Fictional Engineering Cooperative", sector: "Engineering" },
  });
  const invalidInitialState = await client.request("/api/placements", {
    method: "POST",
    body: {
      studentId: student.payload.id,
      hostId: host.payload.id,
      periodId: null,
      schoolTutorId: null,
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      targetHours: 2,
      status: "complete",
    },
  });
  assert.equal(invalidInitialState.response.status, 422);
  assert.equal(invalidInitialState.payload.error.code, "invalid_initial_status");
  const placement = await client.request("/api/placements", {
    method: "POST",
    body: {
      studentId: student.payload.id,
      hostId: host.payload.id,
      periodId: null,
      schoolTutorId: null,
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      targetHours: 2,
    },
  });
  const path = `/api/placements/${placement.payload.id}`;
  assert.equal(
    (await client.request(path, {
      method: "PATCH",
      body: { revision: 1, status: "active" },
    })).payload.revision,
    2,
  );
  assert.equal(
    (await client.request(path, {
      method: "PATCH",
      body: { revision: 2, status: "review" },
    })).payload.revision,
    3,
  );

  const premature = await client.request(path, {
    method: "PATCH",
    body: { revision: 3, status: "complete" },
  });
  assert.equal(premature.response.status, 422);
  assert.equal(premature.payload.error.code, "placement_not_ready");
  assert.deepEqual(
    premature.payload.error.details.blockers.map((item) => item.code).sort(),
    [
      "check_in_missing",
      "document_attendance_log",
      "document_evaluation",
      "document_training_agreement",
      "hours_incomplete",
    ],
  );

  const timeEntry = await client.request(`${path}/time-entries`, {
    method: "POST",
    body: {
      entryDate: "2026-06-03",
      hours: 2,
      verificationStatus: "verified",
      description: "Verified synthetic activity",
    },
  });
  assert.equal(timeEntry.response.status, 201);
  await client.request(`${path}/check-ins`, {
    method: "POST",
    body: {
      occurredAt: "2026-06-10T09:00:00.000Z",
      channel: "video",
      summary: "Synthetic progress check.",
    },
  });
  const documentIds = [];
  for (const document of [
    ["training_agreement", "Training agreement", "signed"],
    ["attendance_log", "Attendance log", "signed"],
    ["evaluation", "Evaluation", "ready"],
  ]) {
    const result = await client.request(`${path}/documents`, {
      method: "POST",
      body: { kind: document[0], title: document[1], status: document[2] },
    });
    assert.equal(result.response.status, 200);
    documentIds.push(result.payload.id);
  }

  const duplicateDocument = await client.request(`${path}/documents`, {
    method: "POST",
    body: {
      kind: "evaluation",
      title: "Conflicting evaluation",
      status: "draft",
    },
  });
  assert.equal(duplicateDocument.response.status, 409);
  assert.equal(duplicateDocument.payload.error.code, "document_kind_exists");
  assert.deepEqual(
    duplicateDocument.payload.error.details,
    { documentId: documentIds[2], kind: "evaluation" },
  );

  const complete = await client.request(path, {
    method: "PATCH",
    body: { revision: 3, status: "complete" },
  });
  assert.equal(complete.response.status, 200);
  const detail = await client.request(path);
  assert.equal(detail.payload.status, "complete");
  assert.equal(detail.payload.readiness.ready, true);
  assert.match(detail.payload.readiness.fingerprint, /^[0-9a-f]{64}$/);

  for (const blockedMutation of [
    client.request(`${path}/time-entries`, {
      method: "POST",
      body: {
        entryDate: "2026-06-04",
        hours: 1,
        description: "Must not reopen completed evidence",
      },
    }),
    client.request(`${path}/check-ins`, {
      method: "POST",
      body: {
        occurredAt: "2026-06-11T09:00:00.000Z",
        channel: "phone",
        summary: "Must not alter a completed placement.",
      },
    }),
    client.request(`${path}/documents`, {
      method: "POST",
      body: {
        kind: "completion_certificate",
        title: "Must not be added",
        status: "draft",
      },
    }),
    client.request(`${path}/time-entries/${timeEntry.payload.id}`, {
      method: "PATCH",
      body: { revision: 1, verificationStatus: "rejected" },
    }),
    client.request(`${path}/documents/${documentIds[2]}`, {
      method: "PATCH",
      body: { revision: 1, status: "archived" },
    }),
    client.request(path, {
      method: "PATCH",
      body: { revision: 4, notes: "Completed records are immutable." },
    }),
  ]) {
    const result = await blockedMutation;
    assert.equal(result.response.status, 409);
    assert.equal(result.payload.error.code, "placement_frozen");
  }
});

test("cancelled placements freeze evidence until explicitly reopened as planned", async () => {
  const instance = await app();
  const { client } = instance;
  await client.login();

  const student = await client.request("/api/students", {
    method: "POST",
    body: {
      externalRef: "SYN-CANCEL-01",
      firstName: "Jordan",
      lastName: "Quinn",
      email: "jordan.quinn@example.test",
      cohortId: null,
    },
  });
  const host = await client.request("/api/hosts", {
    method: "POST",
    body: { name: "Synthetic Design Studio", sector: "Design" },
  });
  const placement = await client.request("/api/placements", {
    method: "POST",
    body: {
      studentId: student.payload.id,
      hostId: host.payload.id,
      periodId: null,
      schoolTutorId: null,
      startDate: "2026-05-01",
      endDate: "2026-05-31",
      targetHours: 20,
    },
  });
  const path = `/api/placements/${placement.payload.id}`;
  const cancelled = await client.request(path, {
    method: "PATCH",
    body: { revision: 1, status: "cancelled" },
  });
  assert.equal(cancelled.response.status, 200);

  const blockedEvidence = await client.request(`${path}/check-ins`, {
    method: "POST",
    body: {
      occurredAt: "2026-05-02T09:00:00.000Z",
      channel: "email",
      summary: "This must remain frozen.",
    },
  });
  assert.equal(blockedEvidence.response.status, 409);
  assert.equal(blockedEvidence.payload.error.code, "placement_frozen");

  const blockedEdit = await client.request(path, {
    method: "PATCH",
    body: { revision: 2, notes: "No edits while cancelled." },
  });
  assert.equal(blockedEdit.response.status, 409);
  assert.equal(blockedEdit.payload.error.code, "placement_frozen");

  const mixedReopen = await client.request(path, {
    method: "PATCH",
    body: { revision: 2, status: "planned", notes: "No bundled edits." },
  });
  assert.equal(mixedReopen.response.status, 409);
  assert.equal(mixedReopen.payload.error.code, "placement_frozen");

  const reopened = await client.request(path, {
    method: "PATCH",
    body: { revision: 2, status: "planned" },
  });
  assert.equal(reopened.response.status, 200);
  assert.equal(reopened.payload.revision, 3);

  const mutableAgain = await client.request(`${path}/check-ins`, {
    method: "POST",
    body: {
      occurredAt: "2026-05-02T09:00:00.000Z",
      channel: "email",
      summary: "The placement was explicitly reopened.",
    },
  });
  assert.equal(mutableAgain.response.status, 201);
});

test("CSV import is all-or-nothing and export neutralizes spreadsheet formulas", async () => {
  const instance = await app();
  const { client } = instance;
  await client.login();
  const header = "externalRef,firstName,lastName,email,cohortName,cohortAcademicYear";
  const record = "SYN-CSV-01,Robin,Gray,robin.gray@example.test,,";
  const template = await client.request("/api/import/students/template");
  assert.equal(template.response.status, 200);
  assert.equal(
    template.response.headers.get("content-disposition"),
    'attachment; filename="vector-students-import-template.csv"',
  );
  assert.equal(template.response.headers.get("cache-control"), "no-store");
  assert.equal(template.payload, `${header}\r\n`);
  const dryRun = await client.request("/api/import/students?dryRun=true", {
    method: "POST",
    contentType: "text/csv",
    body: `${header}\n${record}\n`,
  });
  assert.equal(dryRun.response.status, 200);
  assert.equal(dryRun.payload.accepted, 1);
  assert.equal((await client.request("/api/students")).payload.items.length, 0);

  const committed = await client.request("/api/import/students?dryRun=false", {
    method: "POST",
    contentType: "text/csv",
    body: `${header}\n${record}\n`,
  });
  assert.equal(committed.response.status, 200);
  assert.equal((await client.request("/api/students")).payload.items.length, 1);

  const duplicateFile = await client.request("/api/import/students?dryRun=false", {
    method: "POST",
    contentType: "text/csv",
    body: `${header}\nSYN-CSV-02,Jamie,Lee,,,\nsyn-csv-02,Casey,Lee,,,\n`,
  });
  assert.equal(duplicateFile.response.status, 422);
  assert.equal(duplicateFile.payload.error.code, "import_rejected");
  assert.equal((await client.request("/api/students")).payload.items.length, 1);

  const longEmail = `${"x".repeat(255)}@example.test`;
  const invalid = await client.request("/api/import/students?dryRun=false", {
    method: "POST",
    contentType: "text/csv",
    body: `${header}\nSYN-CSV-03,Long,Email,${longEmail},,\n`,
  });
  assert.equal(invalid.response.status, 422);
  assert.equal(invalid.payload.error.code, "import_rejected");
  assert.equal(
    invalid.payload.error.details.errors.some(
      (error) => error.field === "email" && error.code === "field_too_long",
    ),
    true,
  );

  const unknownHeader = await client.request("/api/import/students?dryRun=true", {
    method: "POST",
    contentType: "text/csv",
    body: `${header},unexpected\nSYN-CSV-04,A,B,,,,value\n`,
  });
  assert.equal(unknownHeader.response.status, 422);
  assert.equal(unknownHeader.payload.error.code, "invalid_csv_headers");

  const duplicateHeader = await client.request("/api/import/students?dryRun=true", {
    method: "POST",
    contentType: "text/csv",
    body: "externalRef,firstName,lastName,firstName\nSYN-CSV-05,A,B,C\n",
  });
  assert.equal(duplicateHeader.response.status, 422);
  assert.deepEqual(duplicateHeader.payload.error.details.duplicate, ["firstName"]);

  await client.request("/api/hosts", {
    method: "POST",
    body: {
      name: "=SUM(1,2)",
      sector: "Synthetic test",
      contactName: "  =REMOTE()",
    },
  });
  const exported = await client.request("/api/export?resource=hosts&format=csv");
  assert.equal(exported.response.status, 200);
  assert.match(exported.payload, /"'=SUM\(1,2\)"/);
  assert.match(exported.payload, /'  =REMOTE\(\)/);

  const completedImport = await client.request("/api/import/placements?dryRun=false", {
    method: "POST",
    contentType: "text/csv",
    body: [
      "studentExternalRef,hostName,periodName,schoolTutorEmail,hostTutorName,hostTutorEmail,startDate,endDate,targetHours,status,notes",
      'SYN-CSV-01,"=SUM(1,2)",,,,,2026-10-01,2026-10-31,20,complete,',
      "",
    ].join("\n"),
  });
  assert.equal(completedImport.response.status, 422);
  assert.equal(
    completedImport.payload.error.details.errors.some(
      (error) => error.field === "status" && error.code === "completion_evidence_required",
    ),
    true,
  );
});

test("references from another school are rejected without a partial placement or audit event", async () => {
  const instance = await app();
  const { client, db } = instance;
  await client.login();
  const host = await client.request("/api/hosts", {
    method: "POST",
    body: { name: "Local fictional host" },
  });
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO schools (
      id, slug, name, short_name, product_name, contact_text, footer_text,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "foreign-school",
    "foreign-school",
    "Foreign synthetic school",
    "Foreign",
    "VECTOR",
    "Synthetic contact",
    "Synthetic footer",
    now,
    now,
  );
  db.prepare(`
    INSERT INTO students (
      id, school_id, external_ref, first_name, last_name, active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    "foreign-student",
    "foreign-school",
    "SYN-FOREIGN-01",
    "Foreign",
    "Student",
    now,
    now,
  );
  const auditBefore = db.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count;
  const rejected = await client.request("/api/placements", {
    method: "POST",
    body: {
      studentId: "foreign-student",
      hostId: host.payload.id,
      periodId: null,
      schoolTutorId: null,
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      targetHours: 40,
    },
  });
  assert.equal(rejected.response.status, 422);
  assert.equal(rejected.payload.error.code, "invalid_reference");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM placements").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count, auditBefore);
});

test("student and host corrections use optimistic revisions and remain auditable", async () => {
  const instance = await app();
  const { client } = instance;
  await client.login();
  const student = await client.request("/api/students", {
    method: "POST",
    body: {
      externalRef: "SYN-EDIT-01",
      firstName: "Before",
      lastName: "Student",
      cohortId: null,
    },
  });
  const host = await client.request("/api/hosts", {
    method: "POST",
    body: { name: "Before host" },
  });
  let students = (await client.request("/api/students")).payload.items;
  let hosts = (await client.request("/api/hosts")).payload.items;
  assert.equal(students[0].revision, 1);
  assert.equal(hosts[0].revision, 1);

  const studentUpdate = await client.request(`/api/students/${student.payload.id}`, {
    method: "PATCH",
    body: { revision: 1, firstName: "After", active: false },
  });
  const hostUpdate = await client.request(`/api/hosts/${host.payload.id}`, {
    method: "PATCH",
    body: { revision: 1, name: "After host", contactEmail: "contact@example.test" },
  });
  assert.equal(studentUpdate.payload.revision, 2);
  assert.equal(hostUpdate.payload.revision, 2);

  const stale = await client.request(`/api/students/${student.payload.id}`, {
    method: "PATCH",
    body: { revision: 1, lastName: "Stale" },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.payload.error.code, "conflict");

  students = (await client.request("/api/students")).payload.items;
  hosts = (await client.request("/api/hosts")).payload.items;
  assert.equal(students[0].firstName, "After");
  assert.equal(students[0].active, false);
  assert.equal(hosts[0].name, "After host");
  assert.equal(hosts[0].contactEmail, "contact@example.test");
  const audit = await client.request("/api/audit?limit=20");
  assert.equal(audit.payload.items.some((item) => item.action === "student.updated"), true);
  assert.equal(audit.payload.items.some((item) => item.action === "host.updated"), true);
});

test("retention deletes deterministic approved batches while preserving held records", async () => {
  const instance = await app();
  const { client, db } = instance;
  await client.login();
  const schoolId = db.prepare("SELECT id FROM schools").get().id;
  const insert = db.prepare(`
    INSERT INTO students (
      id, school_id, external_ref, first_name, last_name, active,
      retention_hold, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
  `);
  const oldTimestamp = "2020-01-01T00:00:00.000Z";
  db.transaction(() => {
    for (let index = 0; index < 1002; index += 1) {
      const suffix = String(index).padStart(4, "0");
      insert.run(
        `retention-${suffix}`,
        schoolId,
        `SYN-RET-${suffix}`,
        "Synthetic",
        "Retention",
        index === 1001 ? 1 : 0,
        oldTimestamp,
        oldTimestamp,
      );
    }
  })();

  const dryRun = await client.request("/api/maintenance/retention", {
    method: "POST",
    body: { beforeDate: "2025-01-01", dryRun: true, confirm: "" },
  });
  assert.equal(dryRun.response.status, 200);
  assert.equal(dryRun.payload.candidates, 1000);
  assert.equal(dryRun.payload.hasMore, true);
  assert.equal(dryRun.payload.held, 1);
  assert.equal(dryRun.payload.preview.length, 1000);

  db.prepare("UPDATE students SET revision = revision + 1 WHERE id = ?")
    .run(dryRun.payload.preview[0].id);
  const staleExecution = await client.request("/api/maintenance/retention", {
    method: "POST",
    body: {
      beforeDate: "2025-01-01",
      dryRun: false,
      confirm: "ERASE EXPIRED RECORDS",
      fingerprint: dryRun.payload.fingerprint,
    },
  });
  assert.equal(staleExecution.response.status, 409);
  assert.equal(staleExecution.payload.error.code, "retention_snapshot_changed");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM students").get().count, 1002);

  const approved = await client.request("/api/maintenance/retention", {
    method: "POST",
    body: { beforeDate: "2025-01-01", dryRun: true, confirm: "" },
  });
  const firstBatch = await client.request("/api/maintenance/retention", {
    method: "POST",
    body: {
      beforeDate: "2025-01-01",
      dryRun: false,
      confirm: "ERASE EXPIRED RECORDS",
      fingerprint: approved.payload.fingerprint,
    },
  });
  assert.equal(firstBatch.response.status, 200);
  assert.equal(firstBatch.payload.deletedStudents, 1000);
  assert.equal(firstBatch.payload.hasMore, true);
  assert.equal(typeof firstBatch.payload.cleanupPending, "boolean");

  const remainder = await client.request("/api/maintenance/retention", {
    method: "POST",
    body: { beforeDate: "2025-01-01", dryRun: true, confirm: "" },
  });
  assert.equal(remainder.payload.candidates, 1);
  assert.equal(remainder.payload.hasMore, false);
  assert.equal(remainder.payload.held, 1);
  const finalBatch = await client.request("/api/maintenance/retention", {
    method: "POST",
    body: {
      beforeDate: "2025-01-01",
      dryRun: false,
      confirm: "ERASE EXPIRED RECORDS",
      fingerprint: remainder.payload.fingerprint,
    },
  });
  assert.equal(finalBatch.payload.deletedStudents, 1);

  const empty = await client.request("/api/maintenance/retention", {
    method: "POST",
    body: { beforeDate: "2025-01-01", dryRun: true, confirm: "" },
  });
  assert.equal(empty.payload.candidates, 0);
  assert.equal(empty.payload.held, 1);
  const emptyExecution = await client.request("/api/maintenance/retention", {
    method: "POST",
    body: {
      beforeDate: "2025-01-01",
      dryRun: false,
      confirm: "ERASE EXPIRED RECORDS",
      fingerprint: empty.payload.fingerprint,
    },
  });
  assert.equal(emptyExecution.payload.deletedStudents, 0);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'retention.executed'")
      .get().count,
    3,
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM students").get().count, 1);

  const individualErase = await client.request("/api/students/retention-1001", {
    method: "DELETE",
    body: { confirm: "ERASE STUDENT" },
  });
  assert.equal(individualErase.response.status, 404);
});

test("expired-session cleanup applies absolute and exact inactivity boundaries", async () => {
  const instance = await app();
  const clients = [instance.client, instance.newClient(), instance.newClient()];
  for (const client of clients) {
    const login = await client.login();
    assert.equal(login.response.status, 200);
  }

  const sessions = instance.db.prepare("SELECT id FROM sessions ORDER BY id").all();
  assert.equal(sessions.length, 3);
  const now = new Date();
  const idleCutoff = new Date(now.getTime() - 45 * 60_000);
  const future = new Date(now.getTime() + 60 * 60_000);
  const updateSession = instance.db.prepare(`
    UPDATE sessions
    SET expires_at = ?, last_seen_at = ?
    WHERE id = ?
  `);
  updateSession.run(
    now.toISOString(),
    future.toISOString(),
    sessions[0].id,
  );
  updateSession.run(
    future.toISOString(),
    idleCutoff.toISOString(),
    sessions[1].id,
  );
  updateSession.run(
    future.toISOString(),
    new Date(idleCutoff.getTime() + 1).toISOString(),
    sessions[2].id,
  );

  assert.equal(deleteExpiredSessions(instance.db, 45, now), 2);
  assert.deepEqual(
    instance.db.prepare("SELECT id FROM sessions ORDER BY id").all(),
    [{ id: sessions[2].id }],
  );
});

test("unknown session cookies stay on a read-only database path", async () => {
  const instance = await app();
  instance.db.pragma("query_only = ON");
  try {
    assert.equal(
      readSession(instance.db, "forged-session-cookie", 45, new Date()),
      null,
    );
  } finally {
    instance.db.pragma("query_only = OFF");
  }
});

test("health probes never resolve sessions and only bare probes bypass API accounting", async () => {
  const instance = await app();
  assert.equal((await instance.client.login()).response.status, 200);
  instance.db.prepare(`
    UPDATE sessions
    SET last_seen_at = '2000-01-01T00:00:00.000Z'
  `).run();
  instance.db.pragma("query_only = ON");
  try {
    for (const pathname of ["/api/health/live", "/api/health/ready"]) {
      const credentialed = await instance.client.request(pathname);
      assert.equal(credentialed.response.status, 200, pathname);
      assert.ok(credentialed.response.headers.get("ratelimit-policy"), pathname);
    }
  } finally {
    instance.db.pragma("query_only = OFF");
  }
  assert.equal(
    instance.db.prepare("SELECT COUNT(*) FROM sessions").pluck().get(),
    1,
  );

  const bare = await fetch(`${instance.baseUrl}/api/health/live`);
  assert.equal(bare.status, 200);
  assert.equal(bare.headers.get("ratelimit-policy"), null);

  const queried = await fetch(`${instance.baseUrl}/api/health/live?probe=browser`);
  assert.equal(queried.status, 200);
  assert.ok(queried.headers.get("ratelimit-policy"));
});

test("session activity updates remain monotonic for out-of-order requests", async () => {
  const instance = await app();
  const login = await instance.client.login();
  assert.equal(login.response.status, 200);
  const token = decodeURIComponent(instance.client.cookie.split("=", 2)[1]);
  const session = instance.db.prepare("SELECT id FROM sessions").get();
  const firstRequest = new Date();
  const laterRequest = new Date(firstRequest.getTime() + 5 * 60_000);
  const absoluteExpiry = new Date(firstRequest.getTime() + 60 * 60_000);
  const initialLastSeen = new Date(firstRequest.getTime() - 60_000).toISOString();
  instance.db.prepare(`
    UPDATE sessions
    SET expires_at = ?, last_seen_at = ?
    WHERE id = ?
  `).run(
    absoluteExpiry.toISOString(),
    initialLastSeen,
    session.id,
  );

  const readLastSeen = instance.db.prepare(
    "SELECT last_seen_at FROM sessions WHERE id = ?",
  );
  assert.ok(readSession(instance.db, token, 45, laterRequest));
  assert.equal(readLastSeen.get(session.id).last_seen_at, initialLastSeen);

  assert.equal(touchSession(instance.db, session.id, laterRequest, laterRequest), 1);
  assert.equal(readLastSeen.get(session.id).last_seen_at, laterRequest.toISOString());
  assert.ok(readSession(instance.db, token, 45, firstRequest));
  assert.equal(readLastSeen.get(session.id).last_seen_at, laterRequest.toISOString());
  assert.equal(touchSession(instance.db, session.id, firstRequest, firstRequest), 1);
  assert.equal(readLastSeen.get(session.id).last_seen_at, laterRequest.toISOString());

  instance.db.prepare(`
    UPDATE sessions
    SET expires_at = ?, last_seen_at = ?
    WHERE id = ?
  `).run(firstRequest.toISOString(), initialLastSeen, session.id);
  assert.equal(touchSession(instance.db, session.id, laterRequest, laterRequest), 0);
  assert.equal(readLastSeen.get(session.id).last_seen_at, initialLastSeen);
});

test("only successful authenticated same-origin requests renew inactivity", async () => {
  const instance = await app();
  const login = await instance.client.login();
  assert.equal(login.response.status, 200);
  const session = instance.db.prepare("SELECT id FROM sessions").get();
  const resetLastSeen = () => {
    const value = new Date(Date.now() - 60_000).toISOString();
    instance.db.prepare(`
      UPDATE sessions
      SET expires_at = ?, last_seen_at = ?
      WHERE id = ?
    `).run(
      new Date(Date.now() + 60 * 60_000).toISOString(),
      value,
      session.id,
    );
    return value;
  };
  const readLastSeen = () => instance.db.prepare(
    "SELECT last_seen_at FROM sessions WHERE id = ?",
  ).get(session.id).last_seen_at;
  const retentionBody = { beforeDate: "2025-01-01", dryRun: true, confirm: "" };

  for (const path of [
    "/api/health/live",
    "/api/public/branding",
    "/api/session",
  ]) {
    const before = resetLastSeen();
    const result = await instance.client.request(path, {
      headers: { "sec-fetch-site": "same-origin" },
    });
    assert.equal(result.response.status, 200);
    assert.equal(readLastSeen(), before);
  }

  let before = resetLastSeen();
  const unsignedGet = await instance.client.request("/api/dashboard");
  assert.equal(unsignedGet.response.status, 200);
  assert.equal(readLastSeen(), before);

  before = resetLastSeen();
  const missing = await instance.client.request("/api/not-a-route", {
    headers: { "sec-fetch-site": "same-origin" },
  });
  assert.equal(missing.response.status, 404);
  assert.equal(readLastSeen(), before);

  before = resetLastSeen();
  const invalidOrigin = await instance.client.request("/api/maintenance/retention", {
    method: "POST",
    body: retentionBody,
    headers: { origin: "https://attacker.example" },
  });
  assert.equal(invalidOrigin.response.status, 403);
  assert.equal(invalidOrigin.payload.error.code, "invalid_origin");
  assert.equal(readLastSeen(), before);

  before = resetLastSeen();
  const invalidCsrf = await instance.client.request("/api/maintenance/retention", {
    method: "POST",
    body: retentionBody,
    includeCsrf: false,
  });
  assert.equal(invalidCsrf.response.status, 403);
  assert.equal(invalidCsrf.payload.error.code, "invalid_csrf");
  assert.equal(readLastSeen(), before);

  before = resetLastSeen();
  const fetchMetadataGet = await instance.client.request("/api/dashboard", {
    headers: { "sec-fetch-site": "same-origin" },
  });
  assert.equal(fetchMetadataGet.response.status, 200);
  assert.ok(readLastSeen() > before);

  before = resetLastSeen();
  const originGet = await instance.client.request("/api/dashboard", {
    headers: { origin: instance.config.origin },
  });
  assert.equal(originGet.response.status, 200);
  assert.ok(readLastSeen() > before);

  before = resetLastSeen();
  const mutation = await instance.client.request("/api/maintenance/retention", {
    method: "POST",
    body: retentionBody,
  });
  assert.equal(mutation.response.status, 200);
  assert.ok(readLastSeen() > before);
});

test("successful logins retain only the ten most recent active sessions per user", async () => {
  const instance = await app();
  const userId = instance.db.prepare(
    "SELECT id FROM users WHERE email = 'admin@example.test'",
  ).pluck().get();
  assert.throws(
    () => createSession(instance.db, userId, 12, 45),
    /active database transaction/,
  );

  const sequentialClients = Array.from(
    { length: MAX_ACTIVE_SESSIONS_PER_USER + 2 },
    () => instance.newClient(),
  );
  for (const client of sequentialClients) {
    const login = await client.login();
    assert.equal(login.response.status, 200);
    assertApiSessionCookie(login.response.headers.get("set-cookie"));
  }
  assert.equal(
    instance.db.prepare("SELECT COUNT(*) FROM sessions WHERE user_id = ?")
      .pluck().get(userId),
    MAX_ACTIVE_SESSIONS_PER_USER,
  );
  for (const client of sequentialClients.slice(0, 2)) {
    const session = await client.request("/api/session");
    assert.equal(session.payload.authenticated, false);
    assertApiSessionCookie(session.response.headers.get("set-cookie"), { cleared: true });
  }
  for (const client of sequentialClients.slice(2)) {
    assert.equal((await client.request("/api/session")).payload.authenticated, true);
  }

  const concurrentClients = Array.from(
    { length: MAX_ACTIVE_SESSIONS_PER_USER - 2 },
    () => instance.newClient(),
  );
  const concurrentLogins = await Promise.all(
    concurrentClients.map((client) => client.login()),
  );
  assert.equal(
    concurrentLogins.filter((result) => result.response.status === 200).length,
    concurrentClients.length,
  );
  assert.equal(
    instance.db.prepare("SELECT COUNT(*) FROM sessions WHERE user_id = ?")
      .pluck().get(userId),
    MAX_ACTIVE_SESSIONS_PER_USER,
  );
  assert.equal(
    instance.db.prepare(`
      SELECT COUNT(DISTINCT token_hash)
      FROM sessions
      WHERE user_id = ?
    `).pluck().get(userId),
    MAX_ACTIVE_SESSIONS_PER_USER,
  );

  const queryPlan = instance.db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT id
    FROM sessions
    WHERE user_id = ?
    ORDER BY last_seen_at DESC, created_at DESC, id DESC
    LIMIT 9
  `).all(userId).map((row) => row.detail);
  assert.ok(queryPlan.some((detail) => detail.includes("idx_sessions_user_recency")));
  assert.equal(queryPlan.some((detail) => detail.includes("TEMP B-TREE")), false);

  const cleanupPlan = instance.db.prepare(`
    EXPLAIN QUERY PLAN
    DELETE FROM sessions
    WHERE expires_at <= ?
      OR last_seen_at <= ?
  `).all(
    "2026-07-31T12:00:00.000Z",
    "2026-07-31T11:15:00.000Z",
  ).map((row) => row.detail);
  assert.ok(cleanupPlan.some((detail) => detail.includes("MULTI-INDEX OR")));
  assert.ok(cleanupPlan.some((detail) => detail.includes("idx_sessions_expires_at")));
  assert.ok(cleanupPlan.some((detail) => detail.includes("idx_sessions_last_seen_at")));

  assert.throws(
    () => instance.db.prepare(`
      INSERT INTO sessions (
        id, user_id, token_hash, csrf_token, expires_at, created_at, last_seen_at
      ) VALUES (
        'session-trigger-overflow', ?, 'trigger-overflow', 'trigger-overflow',
        '2099-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z',
        '2024-01-01T00:00:00.000Z'
      )
    `).run(userId),
    /active session capacity reached/,
  );

  instance.db.prepare(`
    UPDATE sessions
    SET
      expires_at = '2099-01-01T00:00:00.000Z',
      last_seen_at = '2000-01-01T00:00:00.000Z'
    WHERE user_id = ?
  `).run(userId);
  const replacement = instance.db.transaction(() => createSession(
    instance.db,
    userId,
    12,
    45,
    new Date("2026-07-31T12:00:00.000Z"),
  )).immediate();
  assert.ok(replacement.token);
  assert.equal(
    instance.db.prepare("SELECT COUNT(*) FROM sessions WHERE user_id = ?")
      .pluck().get(userId),
    1,
  );
});

test("a successful re-login rotates and revokes the browser's previous session", async () => {
  const instance = await app();
  assert.equal((await instance.client.login()).response.status, 200);
  const previousCookie = instance.client.cookie;

  const replacement = await instance.client.login();
  assert.equal(replacement.response.status, 200);
  assert.notEqual(instance.client.cookie, previousCookie);
  assert.equal(
    instance.db.prepare("SELECT COUNT(*) FROM sessions").pluck().get(),
    1,
  );

  const replay = await instance.newClient().request("/api/dashboard", {
    headers: { cookie: previousCookie },
  });
  assert.equal(replay.response.status, 401);
  assert.equal(replay.payload.error.code, "authentication_required");
  assertApiSessionCookie(replay.response.headers.get("set-cookie"), { cleared: true });
  assert.equal((await instance.client.request("/api/dashboard")).response.status, 200);
});

test("direct re-login replaces an idle-expired cookie once", async () => {
  const instance = await app();
  const initialLogin = await instance.client.login();
  assert.equal(initialLogin.response.status, 200);
  const oldCookie = instance.client.cookie;
  const now = new Date();
  instance.db.prepare(`
    UPDATE sessions
    SET expires_at = ?, last_seen_at = ?
  `).run(
    new Date(now.getTime() + 60 * 60_000).toISOString(),
    new Date(now.getTime() - 46 * 60_000).toISOString(),
  );

  const replacement = await instance.client.login();
  assert.equal(replacement.response.status, 200);
  const setCookie = replacement.response.headers.get("set-cookie");
  assertApiSessionCookie(setCookie);
  assert.equal(setCookie.match(/vector_session=/g).length, 1);
  assert.doesNotMatch(setCookie, /^vector_session=;/);
  assert.notEqual(instance.client.cookie, oldCookie);
  assert.equal(instance.db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 1);

  const dashboard = await instance.client.request("/api/dashboard", {
    headers: { "sec-fetch-site": "same-origin" },
  });
  assert.equal(dashboard.response.status, 200);
});


test("failed login clears an idle-expired cookie", async () => {
  const instance = await app();
  const initialLogin = await instance.client.login();
  assert.equal(initialLogin.response.status, 200);
  const now = new Date();
  instance.db.prepare(`
    UPDATE sessions
    SET expires_at = ?, last_seen_at = ?
  `).run(
    new Date(now.getTime() + 60 * 60_000).toISOString(),
    new Date(now.getTime() - 46 * 60_000).toISOString(),
  );

  const failed = await instance.client.login(
    "admin@example.test",
    "wrong-password-that-must-not-authenticate",
  );
  assert.equal(failed.response.status, 401);
  assertApiSessionCookie(failed.response.headers.get("set-cookie"), { cleared: true });
  assert.equal(instance.db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);
});

test("idle and absolute expiry remove the database session and browser cookie", async () => {
  const instance = await app();
  const initialLogin = await instance.client.login();
  assert.equal(initialLogin.response.status, 200);
  const now = new Date();
  instance.db.prepare(`
    UPDATE sessions
    SET expires_at = ?, last_seen_at = ?
  `).run(
    new Date(now.getTime() + 60 * 60_000).toISOString(),
    new Date(now.getTime() - 46 * 60_000).toISOString(),
  );

  const idleExpired = await instance.client.request("/api/dashboard");
  assert.equal(idleExpired.response.status, 401);
  assert.equal(idleExpired.payload.error.code, "authentication_required");
  assertApiSessionCookie(
    idleExpired.response.headers.get("set-cookie"),
    { cleared: true },
  );
  assert.equal(instance.db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);

  const replacementLogin = await instance.client.login();
  assert.equal(replacementLogin.response.status, 200);
  const activeDashboard = await instance.client.request("/api/dashboard");
  assert.equal(activeDashboard.response.status, 200);

  const absoluteNow = new Date();
  instance.db.prepare(`
    UPDATE sessions
    SET expires_at = ?, last_seen_at = ?
  `).run(
    new Date(absoluteNow.getTime() - 1).toISOString(),
    new Date(absoluteNow.getTime() + 60 * 60_000).toISOString(),
  );
  const absoluteExpired = await instance.client.request("/api/dashboard");
  assert.equal(absoluteExpired.response.status, 401);
  assertApiSessionCookie(
    absoluteExpired.response.headers.get("set-cookie"),
    { cleared: true },
  );
  assert.equal(instance.db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);
});
