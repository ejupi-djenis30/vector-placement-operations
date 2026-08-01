import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Database from "better-sqlite3";

const repository = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

function vectorEnvironment(root, port) {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name === "NODE_ENV" || name.startsWith("VECTOR_")) delete environment[name];
  }
  return {
    ...environment,
    NODE_ENV: "test",
    VECTOR_ORIGIN: `http://127.0.0.1:${port}`,
    VECTOR_HOST: "127.0.0.1",
    VECTOR_PORT: String(port),
    VECTOR_DB_PATH: path.join(root, "vector.sqlite"),
    VECTOR_BOOTSTRAP_ADMIN_PASSWORD: "vector-process-test-password-2026",
    VECTOR_COOKIE_SECURE: "false",
    VECTOR_LOG_LEVEL: "info",
    VECTOR_SHUTDOWN_GRACE_MS: "1000",
  };
}

function spawnVector(root, port, { lifecycleChild = false } = {}) {
  const entrypoint = lifecycleChild
    ? path.join(repository, "test-support", "server-lifecycle-child.mjs")
    : path.join(repository, "server", "index.mjs");
  const child = spawn(process.execPath, [entrypoint], {
    cwd: root,
    env: vectorEnvironment(root, port),
    stdio: lifecycleChild
      ? ["ignore", "pipe", "pipe", "ipc"]
      : ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({
      exitCode,
      signal,
      get stdout() {
        return stdout;
      },
      get stderr() {
        return stderr;
      },
    }));
  });
  return { child, exited };
}

async function within(promise, message, milliseconds = 10_000) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForReady(port, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`VECTOR exited before readiness with code ${child.exitCode}.`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health/ready`);
      if (response.ok) return;
    } catch {
      // The listener is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("VECTOR did not become ready before the process-test deadline.");
}

async function assertDatabaseReleased(databasePath) {
  const db = new Database(databasePath, { fileMustExist: true });
  try {
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  } finally {
    db.close();
  }
}

test("listen failure exits non-zero and releases the initialized SQLite database", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vector-startup-failure-"));
  const blocker = createServer();
  let child;
  context.after(async () => {
    if (child?.exitCode === null) child.kill("SIGTERM");
    await new Promise((resolve) => blocker.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  const port = blocker.address().port;
  const spawned = spawnVector(root, port);
  child = spawned.child;
  const result = await within(spawned.exited, "startup failure left the child process running");

  assert.notEqual(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.match(result.stderr, /"message":"VECTOR failed to start"/);
  assert.match(result.stderr, /"code":"EADDRINUSE"/);
  await assertDatabaseReleased(path.join(root, "vector.sqlite"));
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`${signal} lifecycle event drains the listener and exits cleanly`, async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vector-signal-shutdown-"));
    const port = await availablePort();
    const spawned = spawnVector(root, port, { lifecycleChild: true });
    const { child } = spawned;
    context.after(async () => {
      if (child.exitCode === null) child.kill("SIGTERM");
      await rm(root, { recursive: true, force: true });
    });
    await waitForReady(port, child);

    child.send(signal);
    const result = await within(spawned.exited, `${signal} did not stop VECTOR cleanly`);
    assert.equal(result.exitCode, 0);
    assert.equal(result.signal, null);
    assert.match(result.stdout, new RegExp(`"message":"shutting down","signal":"${signal}"`));
    assert.doesNotMatch(result.stdout, /forcing remaining connections closed/);
    assert.equal(result.stderr, "");
    await assertDatabaseReleased(path.join(root, "vector.sqlite"));
  });
}
