import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { afterEach, test } from "node:test";
import { parseArgs } from "../scripts/cli-args.mjs";
import {
  assertBackupFileSize,
  inspectDatabase,
  sha256File,
} from "../scripts/backup-lib.mjs";
import { startTestApp } from "../test-support/server-test-helper.mjs";

const roots = new Set();
const apps = new Set();
const repository = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

afterEach(async () => {
  await Promise.all([...apps].map((instance) => instance.close()));
  apps.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function temporaryRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "vector-operations-test-"));
  roots.add(root);
  return root;
}

function cli(script, args, env) {
  return spawnSync(process.execPath, [path.join(repository, script), ...args], {
    cwd: repository,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function cliAsync(script, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(repository, script), ...args], {
      cwd: repository,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("strict CLI parsing rejects unknown, duplicate and valued boolean flags", () => {
  const contract = { strings: ["file"], booleans: ["confirm-empty"] };
  assert.deepEqual(
    parseArgs(["--file", "backup.sqlite", "--confirm-empty"], contract),
    { file: "backup.sqlite", "confirm-empty": true },
  );
  assert.throws(() => parseArgs(["--other", "x"], contract), /Unknown argument/);
  assert.throws(
    () => parseArgs(["--file", "a", "--file", "b"], contract),
    /Duplicate argument/,
  );
  assert.throws(
    () => parseArgs(["--confirm-empty=yes"], contract),
    /does not accept a value/,
  );
});

test("source and container ignore rules exclude operational databases and backups", () => {
  for (const filename of [".gitignore", ".dockerignore"]) {
    const rules = readFileSync(path.join(repository, filename), "utf8");
    for (const token of [
      "data",
      "backup",
      "backups",
      "*.sqlite",
      "*.sqlite-*",
      "*.sqlite3",
      "*.sqlite3-*",
      "*.db",
      "*.db-*",
      "*.sqlite.manifest.json",
      "*.backup",
    ]) {
      assert.ok(rules.includes(token), `${filename} is missing ${token}`);
    }
  }
});

test("backup, manifest inspection and restore form a verified session-free round trip", async () => {
  const root = temporaryRoot();
  const source = path.join(root, "source.sqlite");
  const backup = path.join(root, "backup.sqlite");
  const restored = path.join(root, "restored.sqlite");
  const instance = await startTestApp({ databasePath: source, seedSynthetic: true });
  apps.add(instance);
  await instance.client.login();
  assert.equal(instance.db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 1);
  await instance.close();
  apps.delete(instance);
  if (process.platform !== "win32") {
    assert.equal(statSync(root).mode & 0o777, 0o700);
    assert.equal(statSync(source).mode & 0o777, 0o600);
  }

  const environment = {
    VECTOR_DB_PATH: source,
    VECTOR_ORIGIN: "http://127.0.0.1:4173",
    VECTOR_BOOTSTRAP_ADMIN_PASSWORD: "not-used-for-existing-database",
    VECTOR_SEED_SYNTHETIC: "false",
  };
  const created = cli("scripts/backup.mjs", ["--output", backup], environment);
  assert.equal(created.status, 0, created.stderr);
  const manifest = JSON.parse(readFileSync(`${backup}.manifest.json`, "utf8"));
  assert.equal(manifest.appVersion, "3.0.0");
  assert.equal(manifest.counts.sessions, 0);
  if (process.platform !== "win32") {
    assert.equal(statSync(backup).mode & 0o777, 0o600);
    assert.equal(statSync(`${backup}.manifest.json`).mode & 0o777, 0o600);
  }
  assert.equal(existsSync(`${backup}-wal`), false);
  assert.equal(existsSync(`${backup}-shm`), false);

  const inspected = cli("scripts/inspect-backup.mjs", ["--file", backup], environment);
  assert.equal(inspected.status, 0, inspected.stderr);

  for (const suffix of ["-wal", "-shm", "-journal"]) {
    writeFileSync(`${restored}${suffix}`, "");
    const stale = cli(
      "scripts/restore.mjs",
      ["--file", backup, "--confirm-empty"],
      { ...environment, VECTOR_DB_PATH: restored },
    );
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /target state already exists/i);
    rmSync(`${restored}${suffix}`);
  }

  const restoredResult = cli(
    "scripts/restore.mjs",
    ["--file", backup, "--confirm-empty"],
    { ...environment, VECTOR_DB_PATH: restored },
  );
  assert.equal(restoredResult.status, 0, restoredResult.stderr);
  const restoredDb = new Database(restored, { readonly: true, fileMustExist: true });
  assert.equal(restoredDb.prepare("SELECT COUNT(*) AS count FROM users").get().count, 2);
  assert.equal(restoredDb.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);
  restoredDb.close();
  if (process.platform !== "win32") {
    assert.equal(statSync(restored).mode & 0o777, 0o600);
  }

  const sessionBearing = path.join(root, "session-bearing.sqlite");
  copyFileSync(source, sessionBearing);
  const sessionState = inspectDatabase(sessionBearing);
  assert.equal(sessionState.counts.sessions, 1);
  const sessionStats = statSync(sessionBearing);
  writeFileSync(`${sessionBearing}.manifest.json`, `${JSON.stringify({
    formatVersion: 1,
    product: "VECTOR",
    appVersion: "3.0.0",
    createdAt: new Date().toISOString(),
    bytes: sessionStats.size,
    sha256: sha256File(sessionBearing),
    migrationVersion: sessionState.migrationVersion,
    counts: sessionState.counts,
  })}\n`);
  const sessionFailure = cli(
    "scripts/inspect-backup.mjs",
    ["--file", sessionBearing],
    environment,
  );
  assert.notEqual(sessionFailure.status, 0);
  assert.match(sessionFailure.stderr, /session-free|active sessions/i);

  const tamperedManifestFile = path.join(root, "manifest-tamper.sqlite");
  copyFileSync(backup, tamperedManifestFile);
  const tamperedManifest = {
    ...manifest,
    counts: { ...manifest.counts, students: manifest.counts.students + 1 },
  };
  writeFileSync(
    `${tamperedManifestFile}.manifest.json`,
    `${JSON.stringify(tamperedManifest)}\n`,
  );
  const manifestFailure = cli(
    "scripts/inspect-backup.mjs",
    ["--file", tamperedManifestFile],
    environment,
  );
  assert.notEqual(manifestFailure.status, 0);
  assert.match(manifestFailure.stderr, /record count/i);

  const tamperedDatabaseFile = path.join(root, "database-tamper.sqlite");
  copyFileSync(backup, tamperedDatabaseFile);
  copyFileSync(`${backup}.manifest.json`, `${tamperedDatabaseFile}.manifest.json`);
  const bytes = readFileSync(tamperedDatabaseFile);
  bytes[bytes.length - 1] ^= 0xff;
  writeFileSync(tamperedDatabaseFile, bytes);
  const databaseFailure = cli(
    "scripts/inspect-backup.mjs",
    ["--file", tamperedDatabaseFile],
    environment,
  );
  assert.notEqual(databaseFailure.status, 0);
  assert.match(databaseFailure.stderr, /checksum/i);

  const multiSchool = path.join(root, "multi-school.sqlite");
  copyFileSync(backup, multiSchool);
  const multiSchoolDb = new Database(multiSchool);
  const now = new Date().toISOString();
  multiSchoolDb.prepare(`
    INSERT INTO schools (id, slug, name, short_name, created_at, updated_at)
    VALUES ('other-school', 'other-school', 'Other school', 'Other', ?, ?)
  `).run(now, now);
  multiSchoolDb.close();
  assert.throws(
    () => inspectDatabase(multiSchool, { requireSessionFree: true }),
    /exactly one school/i,
  );

  const foreignKeyBroken = path.join(root, "foreign-key-broken.sqlite");
  copyFileSync(backup, foreignKeyBroken);
  const foreignKeyDb = new Database(foreignKeyBroken);
  foreignKeyDb.pragma("foreign_keys = OFF");
  const hostId = foreignKeyDb.prepare("SELECT id FROM hosts LIMIT 1").get().id;
  foreignKeyDb.prepare("UPDATE hosts SET school_id = 'missing-school' WHERE id = ?").run(hostId);
  foreignKeyDb.close();
  assert.throws(
    () => inspectDatabase(foreignKeyBroken, { requireSessionFree: true }),
    /foreign_key_check/i,
  );

  const bounded = path.join(root, "bounded-backup.sqlite");
  writeFileSync(bounded, "1234");
  assert.throws(() => assertBackupFileSize(bounded, 3), /supported range/i);
});

test("concurrent backup and restore jobs preserve the winning files", async () => {
  const root = temporaryRoot();
  const source = path.join(root, "race-source.sqlite");
  const backup = path.join(root, "race-backup.sqlite");
  const destination = path.join(root, "race-restored.sqlite");
  const instance = await startTestApp({ databasePath: source, seedSynthetic: true });
  apps.add(instance);
  await instance.client.login();
  await instance.close();
  apps.delete(instance);
  const environment = {
    VECTOR_DB_PATH: source,
    VECTOR_ORIGIN: "http://127.0.0.1:4173",
    VECTOR_BOOTSTRAP_ADMIN_PASSWORD: "not-used-for-existing-database",
    VECTOR_SEED_SYNTHETIC: "false",
  };

  const backupResults = await Promise.all([
    cliAsync("scripts/backup.mjs", ["--output", backup], environment),
    cliAsync("scripts/backup.mjs", ["--output", backup], environment),
  ]);
  assert.equal(backupResults.filter((result) => result.status === 0).length, 1);
  assert.equal(existsSync(backup), true);
  assert.equal(existsSync(`${backup}.manifest.json`), true);
  assert.equal(
    cli("scripts/inspect-backup.mjs", ["--file", backup], environment).status,
    0,
  );

  const restoreEnvironment = { ...environment, VECTOR_DB_PATH: destination };
  const restoreResults = await Promise.all([
    cliAsync(
      "scripts/restore.mjs",
      ["--file", backup, "--confirm-empty"],
      restoreEnvironment,
    ),
    cliAsync(
      "scripts/restore.mjs",
      ["--file", backup, "--confirm-empty"],
      restoreEnvironment,
    ),
  ]);
  assert.equal(restoreResults.filter((result) => result.status === 0).length, 1);
  assert.equal(existsSync(destination), true);
  assert.equal(
    inspectDatabase(destination, { requireSessionFree: true }).counts.schools,
    1,
  );
  assert.deepEqual(
    readdirSync(root).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("backup size limits fail closed without publishing partial output", async () => {
  const root = temporaryRoot();
  const source = path.join(root, "bounded-source.sqlite");
  const backup = path.join(root, "bounded-output.sqlite");
  const instance = await startTestApp({ databasePath: source, seedSynthetic: true });
  apps.add(instance);
  await instance.client.login();
  const sourceBytes = statSync(source).size;
  const logicalBytes = instance.db.pragma("page_count", { simple: true })
    * instance.db.pragma("page_size", { simple: true });
  assert.ok(logicalBytes > 4096);
  const limit = Math.max(4096, Math.min(sourceBytes, logicalBytes - 1));
  assert.ok(sourceBytes <= limit);
  assert.ok(logicalBytes > limit);
  const environment = {
    VECTOR_DB_PATH: source,
    VECTOR_ORIGIN: "http://127.0.0.1:4173",
    VECTOR_BOOTSTRAP_ADMIN_PASSWORD: "not-used-for-existing-database",
    VECTOR_SEED_SYNTHETIC: "false",
    VECTOR_BACKUP_MAX_BYTES: String(limit),
  };
  const result = cli("scripts/backup.mjs", ["--output", backup], environment);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /during the SQLite snapshot/i);
  assert.equal(existsSync(backup), false);
  assert.equal(existsSync(`${backup}.manifest.json`), false);
  assert.deepEqual(
    readdirSync(root).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("backup refuses an existing non-private parent without changing its mode", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX directory modes are not available on Windows.");
    return;
  }
  const root = temporaryRoot();
  const privateData = path.join(root, "private-data");
  const shared = path.join(root, "shared-output");
  const source = path.join(privateData, "source.sqlite");
  const output = path.join(shared, "backup.sqlite");
  const instance = await startTestApp({ databasePath: source });
  apps.add(instance);
  await instance.close();
  apps.delete(instance);
  await import("node:fs/promises").then(({ mkdir }) => mkdir(shared, { mode: 0o750 }));
  chmodSync(shared, 0o750);
  const environment = {
    VECTOR_DB_PATH: source,
    VECTOR_ORIGIN: "http://127.0.0.1:4173",
    VECTOR_BOOTSTRAP_ADMIN_PASSWORD: "not-used-for-existing-database",
    VECTOR_SEED_SYNTHETIC: "false",
  };
  const result = cli("scripts/backup.mjs", ["--output", output], environment);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /private.*0700/i);
  assert.equal(statSync(shared).mode & 0o777, 0o750);
  assert.equal(existsSync(output), false);
});
