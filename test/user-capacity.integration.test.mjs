import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { MAX_USERS_PER_SCHOOL } from "../server/user-limits.mjs";
import { startTestApp } from "../test-support/server-test-helper.mjs";

const running = new Set();

afterEach(async () => {
  await Promise.all([...running].map((instance) => instance.close()));
  running.clear();
});

test("the complete administrative user directory has an enforced capacity boundary", async () => {
  const instance = await startTestApp();
  running.add(instance);
  assert.equal((await instance.client.login()).response.status, 200);

  const { db } = instance;
  const admin = db.prepare(`
    SELECT school_id AS schoolId, password_hash AS passwordHash
    FROM users
    WHERE email = 'admin@example.test'
  `).get();
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO users (
      id, school_id, email, display_name, password_hash, role, data_scope,
      active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'viewer', 'school', 1, ?, ?)
  `);
  db.transaction(() => {
    for (let index = 1; index < MAX_USERS_PER_SCHOOL; index += 1) {
      insert.run(
        `capacity-user-${index}`,
        admin.schoolId,
        `capacity-user-${index}@example.test`,
        `Capacity user ${String(index).padStart(3, "0")}`,
        admin.passwordHash,
        now,
        now,
      );
    }
  }).immediate();

  const complete = await instance.client.request("/api/users");
  assert.equal(complete.response.status, 200);
  assert.equal(complete.payload.items.length, MAX_USERS_PER_SCHOOL);

  const rejected = await instance.client.request("/api/users", {
    method: "POST",
    body: {
      email: "capacity-overflow@example.test",
      displayName: "Capacity overflow",
      password: "capacity-overflow-password-2026",
      role: "viewer",
      dataScope: "school",
    },
  });
  assert.equal(rejected.response.status, 422);
  assert.equal(rejected.payload.error.code, "user_limit_reached");
  assert.equal(rejected.payload.error.details.maximum, MAX_USERS_PER_SCHOOL);
  assert.equal(
    db.prepare("SELECT COUNT(*) FROM users WHERE school_id = ?").pluck().get(admin.schoolId),
    MAX_USERS_PER_SCHOOL,
  );
  assert.throws(
    () => insert.run(
      "capacity-trigger-overflow",
      admin.schoolId,
      "capacity-trigger-overflow@example.test",
      "Capacity trigger overflow",
      admin.passwordHash,
      now,
      now,
    ),
    /user capacity reached/i,
  );

  // Simulate a database that was modified outside VECTOR after migration. The
  // read still fetches at most maximum + 1 rows and rejects the unsupported state.
  db.exec("DROP TRIGGER users_school_capacity");
  insert.run(
    "capacity-unsupported-overflow",
    admin.schoolId,
    "capacity-unsupported-overflow@example.test",
    "Capacity unsupported overflow",
    admin.passwordHash,
    now,
    now,
  );
  const unsupported = await instance.client.request("/api/users");
  assert.equal(unsupported.response.status, 422);
  assert.equal(unsupported.payload.error.code, "user_capacity_exceeded");
  assert.deepEqual(unsupported.payload.error.details, {
    maximum: MAX_USERS_PER_SCHOOL,
    minimumObserved: MAX_USERS_PER_SCHOOL + 1,
  });
});
