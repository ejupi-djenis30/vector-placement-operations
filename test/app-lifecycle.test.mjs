import assert from "node:assert/strict";
import test from "node:test";
import { MemoryStore } from "express-rate-limit";
import { buildApp } from "../server/app.mjs";
import { loadConfig } from "../server/config.mjs";
import { openDatabase } from "../server/db.mjs";

function config() {
  return loadConfig({
    NODE_ENV: "test",
    VECTOR_DB_PATH: ":memory:",
    VECTOR_BOOTSTRAP_ADMIN_PASSWORD: "vector-app-lifecycle-password-2026",
    VECTOR_COOKIE_SECURE: "false",
    VECTOR_LOG_LEVEL: "silent",
  });
}

function failingServices() {
  const services = {};
  Object.defineProperty(services, "verifyPassword", {
    get() {
      throw new Error("route initialization failed");
    },
  });
  return services;
}

class TrackingStore extends MemoryStore {
  shutdownCalls = 0;

  shutdown() {
    this.shutdownCalls += 1;
    super.shutdown();
  }
}

class FailingTrackingStore extends TrackingStore {
  shutdown() {
    super.shutdown();
    throw new Error("rate-limit timer cleanup failed");
  }
}

test("application construction closes its owned database after route initialization fails", async () => {
  let db;
  let closes = 0;
  await assert.rejects(
    buildApp({
      config: config(),
      services: failingServices(),
      openDatabase: (databasePath) => {
        db = openDatabase(databasePath);
        const close = db.close.bind(db);
        db.close = () => {
          closes += 1;
          close();
        };
        return db;
      },
    }),
    /route initialization failed/,
  );
  assert.equal(closes, 1);
  assert.equal(db.open, false);
});

test("application construction never closes an injected database it does not own", async () => {
  const db = openDatabase(":memory:");
  try {
    await assert.rejects(
      buildApp({ config: config(), db, services: failingServices() }),
      /route initialization failed/,
    );
    assert.equal(db.open, true);
  } finally {
    db.close();
  }
});

test("application close stops rate-limit timers and owned SQLite state exactly once", async () => {
  let db;
  const apiRateLimitStore = new TrackingStore();
  const loginRateLimitStore = new TrackingStore();
  const app = await buildApp({
    config: config(),
    services: { apiRateLimitStore, loginRateLimitStore },
    openDatabase: (databasePath) => {
      db = openDatabase(databasePath);
      return db;
    },
  });

  app.locals.vector.close();
  app.locals.vector.close();
  assert.equal(apiRateLimitStore.shutdownCalls, 1);
  assert.equal(loginRateLimitStore.shutdownCalls, 1);
  assert.equal(app.locals.vector.isDraining(), true);
  assert.equal(db.open, false);
});

test("a timer cleanup failure cannot skip the remaining cleanup or SQLite close", async () => {
  let db;
  const apiRateLimitStore = new TrackingStore();
  const loginRateLimitStore = new FailingTrackingStore();
  const app = await buildApp({
    config: config(),
    services: { apiRateLimitStore, loginRateLimitStore },
    openDatabase: (databasePath) => {
      db = openDatabase(databasePath);
      return db;
    },
  });

  assert.throws(() => app.locals.vector.close(), /rate-limit timer cleanup failed/);
  assert.equal(apiRateLimitStore.shutdownCalls, 1);
  assert.equal(loginRateLimitStore.shutdownCalls, 1);
  assert.equal(db.open, false);
  assert.doesNotThrow(() => app.locals.vector.close());
});
