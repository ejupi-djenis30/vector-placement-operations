import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  await new Promise((resolve, reject) => server.close((error) => (
    error ? reject(error) : resolve()
  )));
  return port;
}

async function waitFor(url, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`VECTOR exited early with ${child.exitCode}.`);
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("VECTOR did not become ready.");
}

function spawnVector(root, environment) {
  return spawn(
    process.execPath,
    ["--env-file-if-exists=.env", path.join(repository, "server", "index.mjs")],
    {
      cwd: root,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

async function waitForExit(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { exitCode, stdout, stderr };
}

test("direct start loads production clean-install settings from .env", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vector-clean-install-"));
  let child;
  context.after(async () => {
    if (child?.exitCode === null) {
      const closed = new Promise((resolve) => child.once("close", resolve));
      child.kill("SIGTERM");
      await closed;
    }
    await rm(root, { recursive: true, force: true });
  });

  const databasePath = path.join(root, "data", "clean.sqlite");
  const port = await availablePort();
  const bootstrapPassword = "clean-install-password-2026";
  const environmentLines = [
    "NODE_ENV=production",
    "VECTOR_ORIGIN=https://vector.clean-install.example.test",
    "VECTOR_HOST=127.0.0.1",
    `VECTOR_PORT=${port}`,
    `VECTOR_DB_PATH=${databasePath.replaceAll("\\", "/")}`,
    "VECTOR_BOOTSTRAP_SCHOOL_NAME=Clean Install School",
    "VECTOR_BOOTSTRAP_SCHOOL_SLUG=clean-install-school",
    "VECTOR_BOOTSTRAP_TIME_ZONE=Europe/Zurich",
    "VECTOR_BOOTSTRAP_ADMIN_EMAIL=clean.admin@example.test",
    "VECTOR_BOOTSTRAP_ADMIN_NAME=Clean administrator",
    "VECTOR_COOKIE_SECURE=true",
    "VECTOR_TRUST_PROXY=false",
    "VECTOR_SEED_SYNTHETIC=false",
    "VECTOR_LOG_LEVEL=silent",
  ];
  const writeEnvironment = async (password = "") => {
    const lines = password
      ? [...environmentLines, `VECTOR_BOOTSTRAP_ADMIN_PASSWORD=${password}`, ""]
      : [...environmentLines, ""];
    await writeFile(path.join(root, ".env"), lines.join("\n"), { mode: 0o600 });
  };
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name === "NODE_ENV" || name.startsWith("VECTOR_")) delete environment[name];
  }

  await writeEnvironment();
  child = spawnVector(root, environment);
  const missingSecret = await waitForExit(child);
  assert.notEqual(missingSecret.exitCode, 0);
  assert.match(
    missingSecret.stderr,
    /VECTOR_BOOTSTRAP_ADMIN_PASSWORD is required for a new database/,
  );

  await writeEnvironment(bootstrapPassword);
  child = spawnVector(root, environment);
  const initialized = await waitForExit(child);
  assert.notEqual(initialized.exitCode, 0);
  assert.match(
    initialized.stderr,
    /initialization completed.*Remove VECTOR_BOOTSTRAP_ADMIN_PASSWORD.*restart VECTOR/is,
  );
  assert.equal(initialized.stderr.includes(bootstrapPassword), false);

  let db = new Database(databasePath, { readonly: true, fileMustExist: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM schools").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM students").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM placements").get().count, 0);
  db.close();

  child = spawnVector(root, environment);
  const retainedSecret = await waitForExit(child);
  assert.notEqual(retainedSecret.exitCode, 0);
  assert.match(
    retainedSecret.stderr,
    /VECTOR_BOOTSTRAP_ADMIN_PASSWORD must be removed.*restart VECTOR/is,
  );
  assert.equal(retainedSecret.stderr.includes(bootstrapPassword), false);

  await writeEnvironment();
  child = spawnVector(root, environment);
  await waitFor(`http://127.0.0.1:${port}/api/health/ready`, child);
  const branding = await fetch(`http://127.0.0.1:${port}/api/public/branding`)
    .then((response) => response.json());
  assert.equal(branding.schoolName, "Clean Install School");
  assert.equal(branding.timeZone, "Europe/Zurich");

  db = new Database(databasePath, { readonly: true, fileMustExist: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM schools").get().count, 1);
  assert.equal(
    db.prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'installation.bootstrapped'",
    ).get().count,
    1,
  );
  db.close();

  const packageJson = JSON.parse(
    await readFile(path.join(repository, "package.json"), "utf8"),
  );
  assert.match(packageJson.scripts.start, /--env-file-if-exists=\.env/);
});
