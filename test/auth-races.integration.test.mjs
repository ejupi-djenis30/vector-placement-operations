import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { hashPassword, verifyPassword } from "../server/password.mjs";
import { startTestApp } from "../test-support/server-test-helper.mjs";

const running = new Set();

afterEach(async () => {
  await Promise.all([...running].map((instance) => instance.close()));
  running.clear();
});

function gate() {
  let enter;
  let release;
  return {
    entered: new Promise((resolve) => {
      enter = resolve;
    }),
    released: new Promise((resolve) => {
      release = resolve;
    }),
    enter: () => enter(),
    release: () => release(),
  };
}

async function app(options) {
  const instance = await startTestApp(options);
  running.add(instance);
  assert.equal((await instance.client.login()).response.status, 200);
  return instance;
}

async function createUser(client, input) {
  const result = await client.request("/api/users", { method: "POST", body: input });
  assert.equal(result.response.status, 201, JSON.stringify(result.payload));
  return result.payload.id;
}

async function replaceTemporaryPassword(instance, email, oldPassword, newPassword) {
  const client = instance.newClient();
  assert.equal((await client.login(email, oldPassword)).response.status, 200);
  assert.equal(
    (await client.request("/api/auth/change-password", {
      method: "POST",
      body: { currentPassword: oldPassword, newPassword },
    })).response.status,
    200,
  );
  assert.equal((await client.login(email, newPassword)).response.status, 200);
  return client;
}

test("stale user administration cannot reactivate an offboarded account", async () => {
  const instance = await app();
  const { client, db } = instance;
  const temporary = "offboard-temporary-2026";
  const replacement = "offboard-replacement-2026";
  const userId = await createUser(client, {
    email: "offboard@example.test",
    displayName: "Synthetic offboard target",
    password: temporary,
    role: "viewer",
    dataScope: "school",
  });
  const target = await replaceTemporaryPassword(
    instance,
    "offboard@example.test",
    temporary,
    replacement,
  );
  const users = await client.request("/api/users");
  const revision = users.payload.items.find((item) => item.id === userId).revision;

  const deactivated = await client.request(`/api/users/${userId}`, {
    method: "PATCH",
    body: { revision, active: false },
  });
  assert.equal(deactivated.response.status, 200);
  assert.equal(deactivated.payload.revision, revision + 1);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?").get(userId).count,
    0,
  );

  const stale = await client.request(`/api/users/${userId}`, {
    method: "PATCH",
    body: {
      revision,
      active: true,
      displayName: "Stale reactivation",
    },
  });
  assert.equal(stale.response.status, 409);
  assert.equal((await target.request("/api/dashboard")).response.status, 401);
  assert.equal(
    db.prepare("SELECT active FROM users WHERE id = ?").get(userId).active,
    0,
  );
});

test("a password reset wins safely against a login verifying the old hash", async () => {
  const loginGate = gate();
  let gateEnabled = false;
  const oldPassword = "login-race-replacement-2026";
  const instance = await app({
    services: {
      async verifyPassword(password, encoded) {
        const matches = await verifyPassword(password, encoded);
        if (gateEnabled && matches && password === oldPassword) {
          loginGate.enter();
          await loginGate.released;
        }
        return matches;
      },
    },
  });
  const { client } = instance;
  const temporary = "login-race-temporary-2026";
  const userId = await createUser(client, {
    email: "login.race@example.test",
    displayName: "Synthetic login race",
    password: temporary,
    role: "viewer",
    dataScope: "school",
  });
  await replaceTemporaryPassword(
    instance,
    "login.race@example.test",
    temporary,
    oldPassword,
  );
  const users = await client.request("/api/users");
  const revision = users.payload.items.find((item) => item.id === userId).revision;

  gateEnabled = true;
  const racingLogin = instance.newClient().login("login.race@example.test", oldPassword);
  await loginGate.entered;
  const resetPassword = "login-race-reset-2026";
  const reset = await client.request(`/api/users/${userId}/reset-password`, {
    method: "POST",
    body: { revision, password: resetPassword },
  });
  assert.equal(reset.response.status, 200);
  loginGate.release();
  const staleLogin = await racingLogin;
  assert.equal(staleLogin.response.status, 401);
  assert.equal(staleLogin.payload.error.code, "invalid_credentials");
  assert.equal(
    (await instance.newClient().login("login.race@example.test", oldPassword))
      .response.status,
    401,
  );
  assert.equal(
    (await instance.newClient().login("login.race@example.test", resetPassword))
      .response.status,
    200,
  );
});

test("self-service password change cannot overwrite a concurrent administrator reset", async () => {
  const hashGate = gate();
  const racingPassword = "self-race-new-password-2026";
  const instance = await app({
    services: {
      async hashPassword(password) {
        if (password === racingPassword) {
          hashGate.enter();
          await hashGate.released;
        }
        return hashPassword(password);
      },
    },
  });
  const { client } = instance;
  const temporary = "self-race-temporary-2026";
  const currentPassword = "self-race-current-2026";
  const userId = await createUser(client, {
    email: "self.race@example.test",
    displayName: "Synthetic password race",
    password: temporary,
    role: "viewer",
    dataScope: "school",
  });
  const target = await replaceTemporaryPassword(
    instance,
    "self.race@example.test",
    temporary,
    currentPassword,
  );
  const users = await client.request("/api/users");
  const revision = users.payload.items.find((item) => item.id === userId).revision;

  const racingChange = target.request("/api/auth/change-password", {
    method: "POST",
    body: {
      currentPassword,
      newPassword: racingPassword,
    },
  });
  await hashGate.entered;
  const resetPassword = "self-race-admin-reset-2026";
  const reset = await client.request(`/api/users/${userId}/reset-password`, {
    method: "POST",
    body: { revision, password: resetPassword },
  });
  assert.equal(reset.response.status, 200);
  hashGate.release();
  const staleChange = await racingChange;
  assert.equal(staleChange.response.status, 409);
  assert.equal(
    (await instance.newClient().login("self.race@example.test", racingPassword))
      .response.status,
    401,
  );
  assert.equal(
    (await instance.newClient().login("self.race@example.test", resetPassword))
      .response.status,
    200,
  );
});

test("an administrator demoted during password hashing cannot create a user", async () => {
  const hashGate = gate();
  const blockedPassword = "created-during-race-2026";
  const instance = await app({
    services: {
      async hashPassword(password) {
        if (password === blockedPassword) {
          hashGate.enter();
          await hashGate.released;
        }
        return hashPassword(password);
      },
    },
  });
  const { client, db } = instance;
  const actor = db.prepare(
    "SELECT id FROM users WHERE email = 'admin@example.test'",
  ).get();
  await createUser(client, {
    email: "remaining.admin@example.test",
    displayName: "Remaining administrator",
    password: "remaining-admin-password-2026",
    role: "school_admin",
    dataScope: "school",
  });

  const racingCreate = client.request("/api/users", {
    method: "POST",
    body: {
      email: "must.not.exist@example.test",
      displayName: "Must not exist",
      password: blockedPassword,
      role: "viewer",
      dataScope: "school",
    },
  });
  await hashGate.entered;
  db.prepare(`
    UPDATE users
    SET role = 'coordinator', revision = revision + 1
    WHERE id = ?
  `).run(actor.id);
  hashGate.release();
  const result = await racingCreate;
  assert.equal(result.response.status, 403);
  assert.equal(
    db.prepare(
      "SELECT COUNT(*) AS count FROM users WHERE email = 'must.not.exist@example.test'",
    ).get().count,
    0,
  );
});

test("an administrator deactivated during password hashing cannot reset a user", async () => {
  const hashGate = gate();
  const blockedPassword = "reset-during-race-2026";
  const instance = await app({
    services: {
      async hashPassword(password) {
        if (password === blockedPassword) {
          hashGate.enter();
          await hashGate.released;
        }
        return hashPassword(password);
      },
    },
  });
  const { client, db } = instance;
  const actor = db.prepare(
    "SELECT id FROM users WHERE email = 'admin@example.test'",
  ).get();
  await createUser(client, {
    email: "remaining.reset.admin@example.test",
    displayName: "Remaining reset administrator",
    password: "remaining-reset-admin-2026",
    role: "school_admin",
    dataScope: "school",
  });
  const targetId = await createUser(client, {
    email: "reset.target@example.test",
    displayName: "Reset target",
    password: "reset-target-temporary-2026",
    role: "viewer",
    dataScope: "school",
  });
  const before = db.prepare(
    "SELECT password_hash AS passwordHash, revision FROM users WHERE id = ?",
  ).get(targetId);

  const racingReset = client.request(`/api/users/${targetId}/reset-password`, {
    method: "POST",
    body: { revision: before.revision, password: blockedPassword },
  });
  await hashGate.entered;
  db.prepare(`
    UPDATE users
    SET active = 0, revision = revision + 1
    WHERE id = ?
  `).run(actor.id);
  hashGate.release();
  const result = await racingReset;
  assert.equal(result.response.status, 403);
  const after = db.prepare(
    "SELECT password_hash AS passwordHash, revision FROM users WHERE id = ?",
  ).get(targetId);
  assert.deepEqual(after, before);
});
