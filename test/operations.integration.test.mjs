import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
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
  atomicCopy,
  assertNoSymbolicLinkComponents,
  assertBackupFileSize,
  backupByteLimit,
  ensurePrivateDirectory,
  fsyncDirectory,
  inspectDatabase,
  MAX_BACKUP_BYTES,
  publishHardLink,
  readAndVerifyManifest,
  resolveSafeOutput,
  sha256File,
  writeManifestAtomic,
} from "../scripts/backup-lib.mjs";
import {
  assertDatabaseSchema,
  expectedMigrations,
  migrateDatabase,
  openDatabase,
} from "../server/db.mjs";
import { importCsv } from "../server/portability.mjs";
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

function logicalDatabaseDigest(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  const hash = createHash("sha256");
  try {
    const tables = db.prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).pluck().all();
    for (const table of tables) {
      const identifier = `"${table.replaceAll('"', '""')}"`;
      const columns = db.prepare(`PRAGMA table_info(${identifier})`).all()
        .map((column) => `"${column.name.replaceAll('"', '""')}"`);
      const rows = db.prepare(`
        SELECT ${columns.join(", ")}
        FROM ${identifier}
        ORDER BY ${columns.join(", ")}
      `).all();
      hash.update(JSON.stringify([table, columns, rows]));
    }
    return hash.digest("hex");
  } finally {
    db.close();
  }
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
  assert.throws(
    () => resolveSafeOutput("backups/../outside.sqlite"),
    /parent traversal/i,
  );
});

test("backup byte ceilings accept exact bounds and reject ambiguous or unsafe values", () => {
  assert.equal(backupByteLimit(), MAX_BACKUP_BYTES);
  assert.equal(backupByteLimit("4096"), 4_096);
  assert.equal(backupByteLimit(String(MAX_BACKUP_BYTES)), MAX_BACKUP_BYTES);

  for (const value of [
    "0",
    "04096",
    "4095",
    String(MAX_BACKUP_BYTES + 1),
    "9007199254740992",
    "1e6",
  ]) {
    assert.throws(
      () => backupByteLimit(value),
      /VECTOR_BACKUP_MAX_BYTES must be an integer/i,
      `Expected ${value} to fail closed.`,
    );
  }
});

test("backup verification rejects incomplete and oversized pairs before SQLite parsing", () => {
  const root = temporaryRoot();
  const missing = path.join(root, "missing.sqlite");
  assert.throws(
    () => readAndVerifyManifest(missing),
    /backup and its manifest must both exist/i,
  );

  const orphan = path.join(root, "orphan.sqlite");
  writeFileSync(orphan, Buffer.alloc(4_096));
  assert.throws(
    () => readAndVerifyManifest(orphan),
    /backup and its manifest must both exist/i,
  );

  writeFileSync(`${orphan}.manifest.json`, "");
  assert.throws(
    () => readAndVerifyManifest(orphan),
    /manifest size is outside the supported range/i,
  );

  writeFileSync(`${orphan}.manifest.json`, "x".repeat(64 * 1_024 + 1));
  assert.throws(
    () => readAndVerifyManifest(orphan),
    /manifest size is outside the supported range/i,
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

test("backup paths reject symlinked ancestors and publication syncs its directory", (context) => {
  const root = temporaryRoot();
  if (process.platform === "win32") {
    for (const unsafePath of [
      path.join(root, "backup.sqlite:hidden-stream"),
      path.join(root, "NUL.sqlite"),
      path.join(root, "CLOCK$.sqlite"),
      path.join(root, "COM¹.sqlite"),
      path.join(root, "LPT³.backup"),
      path.join(root, "CON .sqlite"),
      path.join(root, "backup.sqlite. "),
      `\\\\?\\${path.join(root, "extended.sqlite")}`,
    ]) {
      assert.throws(
        () => resolveSafeOutput(unsafePath),
        /Windows backup paths must not use/i,
        unsafePath,
      );
    }
  }
  const realParent = path.join(root, "real-parent");
  const linkedParent = path.join(root, "linked-parent");
  mkdirSync(realParent);
  writeFileSync(path.join(realParent, "source.sqlite"), "source");
  try {
    symlinkSync(
      realParent,
      linkedParent,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) {
      context.diagnostic(`Ancestor symlink probe unavailable: ${error.code}`);
    } else {
      throw error;
    }
  }
  if (existsSync(linkedParent)) {
    const nestedOutput = path.join(linkedParent, "child", "backup.sqlite");
    assert.throws(
      () => assertNoSymbolicLinkComponents(nestedOutput),
      /must not contain symbolic links/i,
    );
    assert.throws(
      () => resolveSafeOutput(nestedOutput),
      /must not contain symbolic links/i,
    );
    assert.throws(
      () => ensurePrivateDirectory(path.dirname(nestedOutput)),
      /must not contain symbolic links/i,
    );
    assert.throws(
      () => sha256File(path.join(linkedParent, "source.sqlite")),
      /must not contain symbolic links/i,
    );
  }

  const temporary = path.join(root, "publish.tmp");
  const destination = path.join(root, "published.sqlite");
  writeFileSync(temporary, "durable publication");
  const synchronized = [];
  publishHardLink(temporary, destination, {
    syncDirectory(directory) {
      synchronized.push(directory);
      return true;
    },
  });
  assert.deepEqual(synchronized, [root]);
  assert.equal(readFileSync(destination, "utf8"), "durable publication");

  const failedDestination = path.join(root, "failed-publication.sqlite");
  assert.throws(
    () => publishHardLink(temporary, failedDestination, {
      syncDirectory() {
        throw new Error("simulated directory fsync failure");
      },
    }),
    /simulated directory fsync failure/,
  );
  assert.equal(existsSync(failedDestination), false);
  assert.equal(
    fsyncDirectory(root),
    process.platform !== "win32",
  );
});

test("backup destinations reject replaceable POSIX ancestors before creating children", {
  skip: process.platform === "win32",
}, () => {
  const root = temporaryRoot();
  const shared = path.join(root, "replaceable-parent");
  const destination = path.join(shared, "private", "backups");
  mkdirSync(shared, { mode: 0o777 });
  chmodSync(shared, 0o777);

  assert.throws(
    () => ensurePrivateDirectory(destination),
    /ancestor must not be writable by other users/i,
  );
  assert.equal(existsSync(path.join(shared, "private")), false);
});

test("backup destinations require exact POSIX mode 0700 and verify newly created storage", {
  skip: process.platform === "win32",
}, () => {
  const root = temporaryRoot();
  const created = path.join(root, "created-backups");

  assert.deepEqual(ensurePrivateDirectory(created), {
    created: true,
    path: created,
  });
  const createdStats = statSync(created);
  assert.equal(createdStats.uid, process.getuid());
  assert.equal(createdStats.mode & 0o777, 0o700);
  assert.deepEqual(ensurePrivateDirectory(created), {
    created: false,
    path: created,
  });

  for (const mode of [0o500, 0o600]) {
    const existing = path.join(root, `existing-${mode.toString(8)}`);
    mkdirSync(existing, { mode: 0o700 });
    chmodSync(existing, mode);
    assert.throws(
      () => ensurePrivateDirectory(existing),
      /owned by the current user and private \(mode 0700\)/i,
    );
    assert.equal(statSync(existing).mode & 0o777, mode);
  }
});

test("late temporary cleanup failures roll back restore and manifest publication", () => {
  const root = temporaryRoot();
  const source = path.join(root, "source.bin");
  const destination = path.join(root, "restored.bin");
  writeFileSync(source, "verified restore payload");
  const cleanupFailure = () => {
    throw new Error("injected temporary cleanup failure");
  };

  assert.throws(
    () => atomicCopy(
      source,
      destination,
      4_096,
      sha256File(source),
      { cleanupTemporary: cleanupFailure },
    ),
    /injected temporary cleanup failure/,
  );
  assert.equal(existsSync(destination), false);

  const manifestBase = path.join(root, "backup.sqlite");
  assert.throws(
    () => writeManifestAtomic(
      manifestBase,
      { formatVersion: 1 },
      { cleanupTemporary: cleanupFailure },
    ),
    /injected temporary cleanup failure/,
  );
  assert.equal(existsSync(`${manifestBase}.manifest.json`), false);
});

test("migrations are idempotent and a mid-migration failure rolls back every partial change", () => {
  const current = openDatabase(":memory:");
  try {
    migrateDatabase(current);
    const applied = current.prepare(`
      SELECT version, name, checksum
      FROM schema_migrations
      ORDER BY version
    `).all();
    const changes = current.prepare("SELECT total_changes() AS count").get().count;
    migrateDatabase(current);
    assert.deepEqual(
      current.prepare(`
        SELECT version, name, checksum
        FROM schema_migrations
        ORDER BY version
      `).all(),
      applied,
    );
    assert.equal(
      current.prepare("SELECT total_changes() AS count").get().count,
      changes,
    );
  } finally {
    current.close();
  }

  const interrupted = openDatabase(":memory:");
  try {
    interrupted.exec(
      readFileSync(new URL("../migrations/001_initial.sql", import.meta.url), "utf8"),
    );
    const initial = expectedMigrations()[0];
    interrupted.prepare(`
      INSERT INTO schema_migrations (version, name, checksum, applied_at)
      VALUES (?, ?, ?, ?)
    `).run(initial.version, initial.name, initial.checksum, new Date().toISOString());
    interrupted.exec(
      "ALTER TABLE placements ADD COLUMN programme_version_id TEXT",
    );

    assert.throws(
      () => migrateDatabase(interrupted),
      /schema does not match this VECTOR build/i,
    );
    assert.deepEqual(
      interrupted.prepare(
        "SELECT version FROM schema_migrations ORDER BY version",
      ).all(),
      [{ version: 1 }],
    );
    assert.equal(
      interrupted.prepare(`
        SELECT COUNT(*) AS count
        FROM sqlite_schema
        WHERE type = 'table' AND name IN (
          'programmes',
          'programme_versions',
          'programme_requirements'
        )
      `).get().count,
      0,
    );
  } finally {
    interrupted.close();
  }

  const laterFailure = openDatabase(":memory:");
  try {
    for (const migration of expectedMigrations().slice(0, 2)) {
      laterFailure.exec(
        readFileSync(new URL(`../migrations/${migration.name}`, import.meta.url), "utf8"),
      );
      laterFailure.prepare(`
        INSERT INTO schema_migrations (version, name, checksum, applied_at)
        VALUES (?, ?, ?, ?)
      `).run(
        migration.version,
        migration.name,
        migration.checksum,
        new Date().toISOString(),
      );
    }
    laterFailure.exec(`
      CREATE INDEX idx_time_entries_placement_detail
      ON time_entries(placement_id, entry_date DESC, created_at DESC, id)
    `);

    assert.throws(
      () => migrateDatabase(laterFailure),
      /schema does not match this VECTOR build/i,
    );
    assert.deepEqual(
      laterFailure.prepare(
        "SELECT version FROM schema_migrations ORDER BY version",
      ).all(),
      [{ version: 1 }, { version: 2 }],
    );
    assert.equal(
      laterFailure.prepare(`
        SELECT COUNT(*)
        FROM sqlite_schema
        WHERE type = 'index' AND name = 'idx_students_school_name'
      `).pluck().get(),
      0,
      "An earlier pending migration must roll back when a later one fails.",
    );
  } finally {
    laterFailure.close();
  }
});

test("migration and backup validation reject schema drift hidden behind a valid ledger", () => {
  const databasePath = path.join(temporaryRoot(), "schema-drift.sqlite");
  const db = openDatabase(databasePath);
  try {
    migrateDatabase(db);
    assert.doesNotThrow(() => assertDatabaseSchema(db));
    db.exec(`
      DROP TRIGGER sessions_user_capacity;
      CREATE TRIGGER sessions_user_capacity
      BEFORE INSERT ON sessions
      BEGIN
        SELECT 1;
      END;
    `);

    assert.throws(
      () => assertDatabaseSchema(db),
      /schema does not match this VECTOR build/i,
    );
    assert.throws(
      () => migrateDatabase(db),
      /schema does not match this VECTOR build/i,
    );
  } finally {
    db.close();
  }
  assert.throws(
    () => inspectDatabase(databasePath),
    /schema does not match this VECTOR build/i,
  );
});

test("concurrent migrators serialize before reading state and commit one atomic upgrade", async () => {
  const root = temporaryRoot();
  const databasePath = path.join(root, "concurrent-migrations.sqlite");
  const blocker = openDatabase(databasePath);
  const workerSource = `
    import { migrateDatabase, openDatabase } from ${JSON.stringify(new URL("../server/db.mjs", import.meta.url).href)};
    const db = openDatabase(process.env.VECTOR_TEST_DATABASE);
    process.send({ type: "ready" });
    process.once("message", (message) => {
      let exitCode = 0;
      try {
        if (message !== "migrate") throw new Error("Unexpected migration worker command.");
        migrateDatabase(db);
      } catch (error) {
        exitCode = 1;
        process.stderr.write(String(error?.stack ?? error) + "\\n");
      } finally {
        db.close();
      }
      process.disconnect();
      setImmediate(() => process.exit(exitCode));
    });
  `;
  const startWorker = () => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", workerSource],
      {
        cwd: repository,
        env: { ...process.env, VECTOR_TEST_DATABASE: databasePath },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const ready = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.on("message", (message) => {
        if (message?.type === "ready") resolve();
      });
      child.once("close", (status) => {
        if (status !== 0) reject(new Error(stderr || `Migration worker exited ${status}.`));
      });
    });
    const result = new Promise((resolve) => {
      child.once("close", (status) => resolve({ status, stderr }));
    });
    return { child, ready, result };
  };

  const workers = [startWorker(), startWorker()];
  try {
    await Promise.all(workers.map((worker) => worker.ready));
    blocker.exec("BEGIN IMMEDIATE");
    for (const worker of workers) worker.child.send("migrate");

    // Both old-style migrators can read the same pre-upgrade state while this
    // lock is held. The production implementation must instead block on its
    // own writer reservation before reading that state.
    await new Promise((resolve) => setTimeout(resolve, 200));
    blocker.exec("ROLLBACK");

    const results = await Promise.all(workers.map((worker) => worker.result));
    assert.deepEqual(results.map((result) => result.status), [0, 0], results
      .map((result) => result.stderr)
      .filter(Boolean)
      .join("\n"));
    assert.equal(
      blocker.prepare("SELECT COUNT(*) FROM schema_migrations").pluck().get(),
      expectedMigrations().length,
    );
    assert.doesNotThrow(() => migrateDatabase(blocker));
  } finally {
    if (blocker.inTransaction) blocker.exec("ROLLBACK");
    blocker.close();
  }
});

test("full backup inspection catches index corruption that SQLite quick_check misses", async () => {
  const root = temporaryRoot();
  const source = path.join(root, "index-source.sqlite");
  const corrupted = path.join(root, "index-corrupted.sqlite");
  const instance = await startTestApp({ databasePath: source, seedSynthetic: true });
  apps.add(instance);
  await instance.close();
  apps.delete(instance);
  copyFileSync(source, corrupted);

  const editor = new Database(corrupted);
  try {
    editor.unsafeMode(true);
    editor.pragma("writable_schema = ON");
    const changed = editor.prepare(`
      UPDATE sqlite_schema
      SET sql = REPLACE(sql, 'LOWER(last_name)', 'UPPER(last_name)')
      WHERE type = 'index' AND name = 'idx_students_school_name'
    `).run();
    assert.equal(changed.changes, 1);
    editor.pragma("writable_schema = OFF");
    const schemaVersion = editor.pragma("schema_version", { simple: true });
    editor.pragma(`schema_version = ${schemaVersion + 1}`);
  } finally {
    editor.close();
  }

  const quickReader = new Database(corrupted, { readonly: true, fileMustExist: true });
  try {
    assert.equal(quickReader.pragma("quick_check", { simple: true }), "ok");
  } finally {
    quickReader.close();
  }
  assert.throws(
    () => inspectDatabase(corrupted),
    /SQLite integrity_check failed/i,
  );
});

test("committed CSV imports revalidate active references inside the write transaction", async () => {
  const root = temporaryRoot();
  const databasePath = path.join(root, "import-race.sqlite");
  const instance = await startTestApp({ databasePath });
  apps.add(instance);
  const schoolId = instance.db.prepare("SELECT id FROM schools LIMIT 1").pluck().get();
  const user = {
    ...instance.db.prepare(`
      SELECT id, email, role, data_scope AS dataScope
      FROM users
      WHERE school_id = ? AND role = 'school_admin'
      LIMIT 1
    `).get(schoolId),
    schoolId,
    active: true,
  };
  const now = new Date().toISOString();
  instance.db.prepare(`
    INSERT INTO cohorts (
      id, school_id, name, academic_year, track, active, created_at, updated_at
    ) VALUES ('import-race-cohort', ?, 'Import race', '2026/2027', '', 1, ?, ?)
  `).run(schoolId, now, now);

  const competitor = new Database(databasePath, { timeout: 5_000 });
  const originalTransaction = instance.db.transaction;
  let injected = false;
  instance.db.transaction = function transactionWithConcurrentChange(...arguments_) {
    if (!injected) {
      competitor.prepare(
        "UPDATE cohorts SET active = 0 WHERE id = 'import-race-cohort'",
      ).run();
      injected = true;
    }
    return originalTransaction.apply(this, arguments_);
  };
  try {
    const csv = [
      "externalRef,firstName,lastName,email,cohortName,cohortAcademicYear",
      "IMPORT-RACE-1,Race,Student,,Import race,2026/2027",
      "",
    ].join("\n");
    assert.throws(
      () => importCsv(
        instance.db,
        user,
        "students",
        csv,
        { dryRun: false },
        "import-race-request",
      ),
      (error) => error?.code === "import_rejected"
        && error?.details?.errors?.some(
          (item) => item.field === "cohortName" && item.code === "reference_inactive",
        ),
    );
    assert.equal(injected, true);
    assert.equal(
      instance.db.prepare(
        "SELECT COUNT(*) FROM students WHERE external_ref = 'IMPORT-RACE-1'",
      ).pluck().get(),
      0,
    );
    assert.equal(
      instance.db.prepare(
        "SELECT COUNT(*) FROM audit_events WHERE action = 'import.committed'",
      ).pluck().get(),
      0,
    );
  } finally {
    instance.db.transaction = originalTransaction;
    competitor.close();
  }
});

test("SQLite WAL readers stay available and bounded busy waits recover after contention", () => {
  const root = temporaryRoot();
  const databasePath = path.join(root, "concurrency.sqlite");
  const writer = openDatabase(databasePath);
  const contender = openDatabase(databasePath);
  try {
    migrateDatabase(writer);
    migrateDatabase(contender);
    writer.exec("CREATE TABLE concurrency_probe (value TEXT PRIMARY KEY) STRICT");
    for (const db of [writer, contender]) {
      assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
      assert.equal(db.pragma("busy_timeout", { simple: true }), 5_000);
      assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
      assert.equal(db.pragma("synchronous", { simple: true }), 2);
    }

    writer.exec("BEGIN IMMEDIATE");
    writer.prepare("INSERT INTO concurrency_probe (value) VALUES ('writer')").run();
    assert.equal(
      contender.prepare("SELECT COUNT(*) AS count FROM concurrency_probe").get().count,
      0,
    );

    contender.pragma("busy_timeout = 75");
    const startedAt = Date.now();
    assert.throws(
      () => contender.prepare(
        "INSERT INTO concurrency_probe (value) VALUES ('contender')",
      ).run(),
      (error) => error?.code === "SQLITE_BUSY",
    );
    const waitedMs = Date.now() - startedAt;
    assert.ok(waitedMs >= 50, `SQLite returned before its busy wait: ${waitedMs} ms.`);
    assert.ok(waitedMs < 1_000, `SQLite exceeded the bounded busy wait: ${waitedMs} ms.`);

    writer.exec("ROLLBACK");
    contender.prepare(
      "INSERT INTO concurrency_probe (value) VALUES ('contender')",
    ).run();
    assert.deepEqual(
      contender.prepare(
        "SELECT value FROM concurrency_probe ORDER BY value",
      ).all(),
      [{ value: "contender" }],
    );
  } finally {
    if (writer.inTransaction) writer.exec("ROLLBACK");
    writer.close();
    contender.close();
  }
});

test("production error logs correlate request IDs without leaking queries, cookies or stack data", async () => {
  const root = temporaryRoot();
  const databasePath = path.join(root, "privacy-safe-logging.sqlite");
  const initializer = await startTestApp({ databasePath });
  apps.add(initializer);
  await initializer.close();
  apps.delete(initializer);

  const instance = await startTestApp({
    databasePath,
    env: {
      NODE_ENV: "production",
      VECTOR_BOOTSTRAP_ADMIN_PASSWORD: undefined,
    },
    logLevel: "info",
  });
  apps.add(instance);
  const workspace = await fetch(`${instance.baseUrl}/app/`);
  assert.match(
    workspace.headers.get("content-security-policy") ?? "",
    /upgrade-insecure-requests/i,
  );
  assert.equal((await instance.client.login()).response.status, 200);

  const logs = [];
  const originalConsoleError = console.error;
  const originalPrepare = instance.db.prepare;
  instance.db.prepare = function failingPlacementRead(sql, ...arguments_) {
    if (String(sql).includes("WHERE p.id = @placementId")) {
      throw new Error("private-backend-diagnostic-must-not-leak");
    }
    return originalPrepare.call(this, sql, ...arguments_);
  };
  console.error = (...values) => logs.push(values.join(" "));
  let failed;
  try {
    failed = await instance.client.request(
      "/api/placements/SensitiveRecordIdentifier-123?query=SensitiveLearnerName",
    );
  } finally {
    console.error = originalConsoleError;
    instance.db.prepare = originalPrepare;
  }

  assert.equal(failed.response.status, 500);
  assert.equal(failed.payload.error.code, "internal_error");
  assert.equal(
    failed.response.headers.get("x-request-id"),
    failed.payload.error.requestId,
  );
  assert.equal(logs.length, 1);
  const event = JSON.parse(logs[0]);
  assert.deepEqual(
    Object.keys(event).sort(),
    ["code", "level", "method", "requestId", "route"],
  );
  assert.deepEqual(event, {
    level: "error",
    requestId: failed.payload.error.requestId,
    method: "GET",
    route: "/api/placements/:id",
    code: "internal_error",
  });
  assert.equal(logs[0].includes("SensitiveLearnerName"), false);
  assert.equal(logs[0].includes("SensitiveRecordIdentifier"), false);
  assert.equal(logs[0].includes(instance.client.cookie), false);
  assert.equal(logs[0].includes("private-backend-diagnostic-must-not-leak"), false);
  assert.equal(logs[0].includes("stack"), false);
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
  const reservedOutput = `${source}-journal`;
  const reservedFailure = cli(
    "scripts/backup.mjs",
    ["--output", reservedOutput],
    environment,
  );
  assert.notEqual(reservedFailure.status, 0);
  assert.match(reservedFailure.stderr, /must not overlap the live SQLite database/i);
  assert.equal(existsSync(reservedOutput), false);
  assert.equal(existsSync(`${reservedOutput}.manifest.json`), false);

  const created = cli("scripts/backup.mjs", ["--output", backup], environment);
  assert.equal(created.status, 0, created.stderr);
  const manifest = JSON.parse(readFileSync(`${backup}.manifest.json`, "utf8"));
  assert.equal(manifest.appVersion, "3.3.0");
  assert.equal(manifest.counts.sessions, 0);
  assert.equal(manifest.counts.programmes, 1);
  assert.equal(manifest.counts.programme_versions, 1);
  assert.equal(manifest.counts.programme_requirements, 3);
  if (process.platform !== "win32") {
    assert.equal(statSync(backup).mode & 0o777, 0o600);
    assert.equal(statSync(`${backup}.manifest.json`).mode & 0o777, 0o600);
  }
  assert.equal(existsSync(`${backup}-wal`), false);
  assert.equal(existsSync(`${backup}-shm`), false);

  const inspected = cli("scripts/inspect-backup.mjs", ["--file", backup], environment);
  assert.equal(inspected.status, 0, inspected.stderr);

  const hardLinkedBackup = path.join(root, "hard-linked-backup.sqlite");
  linkSync(backup, hardLinkedBackup);
  copyFileSync(`${backup}.manifest.json`, `${hardLinkedBackup}.manifest.json`);
  const hardLinkInspection = cli(
    "scripts/inspect-backup.mjs",
    ["--file", hardLinkedBackup],
    environment,
  );
  assert.notEqual(hardLinkInspection.status, 0);
  assert.match(hardLinkInspection.stderr, /must not be hard-linked/i);
  unlinkSync(hardLinkedBackup);
  unlinkSync(`${hardLinkedBackup}.manifest.json`);

  for (const suffix of ["-wal", "-shm", "-journal"]) {
    writeFileSync(`${backup}${suffix}`, "unexpected companion");
    assert.throws(
      () => readAndVerifyManifest(backup),
      /backup must be self-contained.*SQLite companion/i,
    );
    unlinkSync(`${backup}${suffix}`);
  }

  const walHeaderFile = path.join(root, "wal-header.sqlite");
  copyFileSync(backup, walHeaderFile);
  const walHeaderDatabase = new Database(walHeaderFile);
  try {
    assert.equal(
      walHeaderDatabase.pragma("journal_mode = WAL", { simple: true }),
      "wal",
    );
  } finally {
    walHeaderDatabase.close();
  }
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${walHeaderFile}${suffix}`)) unlinkSync(`${walHeaderFile}${suffix}`);
  }
  const walHeaderStats = statSync(walHeaderFile);
  writeFileSync(`${walHeaderFile}.manifest.json`, `${JSON.stringify({
    ...manifest,
    bytes: walHeaderStats.size,
    sha256: sha256File(walHeaderFile),
  })}\n`);
  assert.throws(
    () => readAndVerifyManifest(walHeaderFile),
    /self-contained rollback-journal snapshot.*WAL-mode main file/i,
  );
  assert.equal(existsSync(`${walHeaderFile}-wal`), false);
  assert.equal(existsSync(`${walHeaderFile}-shm`), false);

  const boundedBytes = statSync(backup).size - 1;
  assert.ok(boundedBytes >= 4_096);
  assert.throws(
    () => readAndVerifyManifest(backup, boundedBytes),
    /size is outside the supported range/i,
  );
  const boundedInspection = cli(
    "scripts/inspect-backup.mjs",
    ["--file", backup],
    { ...environment, VECTOR_BACKUP_MAX_BYTES: String(boundedBytes) },
  );
  assert.notEqual(boundedInspection.status, 0);
  assert.match(boundedInspection.stderr, /size is outside the supported range/i);
  const boundedDestination = path.join(root, "bounded-cli-restore.sqlite");
  const boundedFailure = cli(
    "scripts/restore.mjs",
    ["--file", backup, "--confirm-empty"],
    {
      ...environment,
      VECTOR_BACKUP_MAX_BYTES: String(boundedBytes),
      VECTOR_DB_PATH: boundedDestination,
    },
  );
  assert.notEqual(boundedFailure.status, 0);
  assert.match(boundedFailure.stderr, /size is outside the supported range/i);
  assert.equal(existsSync(boundedDestination), false);

  if (process.platform !== "win32") {
    const symlinkedBackup = path.join(root, "symlinked-backup.sqlite");
    symlinkSync(backup, symlinkedBackup);
    copyFileSync(
      `${backup}.manifest.json`,
      `${symlinkedBackup}.manifest.json`,
    );
    const backupSymlinkFailure = cli(
      "scripts/inspect-backup.mjs",
      ["--file", symlinkedBackup],
      environment,
    );
    assert.notEqual(backupSymlinkFailure.status, 0);
    assert.match(backupSymlinkFailure.stderr, /symbolic link/i);

    const symlinked = path.join(root, "symlinked-manifest.sqlite");
    copyFileSync(backup, symlinked);
    symlinkSync(
      `${backup}.manifest.json`,
      `${symlinked}.manifest.json`,
    );
    const symlinkFailure = cli(
      "scripts/inspect-backup.mjs",
      ["--file", symlinked],
      environment,
    );
    assert.notEqual(symlinkFailure.status, 0);
    assert.match(
      symlinkFailure.stderr,
      /(?:symbolic links|opened safely \(ELOOP\))/i,
    );
  }

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
  assert.equal(sha256File(restored), manifest.sha256);
  assert.equal(logicalDatabaseDigest(restored), logicalDatabaseDigest(backup));
  if (process.platform !== "win32") {
    assert.equal(statSync(restored).mode & 0o777, 0o600);
  }

  const sessionBearing = path.join(root, "session-bearing.sqlite");
  copyFileSync(backup, sessionBearing);
  const sessionDatabase = new Database(sessionBearing);
  try {
    assert.equal(sessionDatabase.pragma("journal_mode", { simple: true }), "delete");
    const userId = sessionDatabase.prepare(
      "SELECT id FROM users ORDER BY id LIMIT 1",
    ).pluck().get();
    const sessionNow = new Date().toISOString();
    sessionDatabase.prepare(`
      INSERT INTO sessions (
        id, user_id, token_hash, csrf_token, expires_at, created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "backup-session-probe",
      userId,
      "f".repeat(64),
      "backup-session-csrf",
      "2099-01-01T00:00:00.000Z",
      sessionNow,
      sessionNow,
    );
  } finally {
    sessionDatabase.close();
  }
  const sessionState = inspectDatabase(sessionBearing);
  assert.equal(sessionState.counts.sessions, 1);
  const sessionStats = statSync(sessionBearing);
  writeFileSync(`${sessionBearing}.manifest.json`, `${JSON.stringify({
    formatVersion: 1,
    product: "VECTOR",
    appVersion: "3.3.0",
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

  const schemaTamperedFile = path.join(root, "schema-tamper.sqlite");
  copyFileSync(backup, schemaTamperedFile);
  const schemaTamperedDb = new Database(schemaTamperedFile);
  try {
    schemaTamperedDb.exec(`
      DROP TRIGGER sessions_user_capacity;
      CREATE TRIGGER sessions_user_capacity
      BEFORE INSERT ON sessions
      BEGIN
        SELECT 1;
      END;
    `);
  } finally {
    schemaTamperedDb.close();
  }
  const schemaTamperedStats = statSync(schemaTamperedFile);
  writeFileSync(`${schemaTamperedFile}.manifest.json`, `${JSON.stringify({
    ...manifest,
    bytes: schemaTamperedStats.size,
    sha256: sha256File(schemaTamperedFile),
  })}\n`);
  const schemaFailure = cli(
    "scripts/inspect-backup.mjs",
    ["--file", schemaTamperedFile],
    environment,
  );
  assert.notEqual(schemaFailure.status, 0);
  assert.match(schemaFailure.stderr, /schema does not match this VECTOR build/i);

  const truncatedDatabaseFile = path.join(root, "database-truncated.sqlite");
  copyFileSync(backup, truncatedDatabaseFile);
  const backupBytes = readFileSync(backup);
  const truncatedBytes = backupBytes.subarray(
    0,
    Math.floor(backupBytes.length / 2),
  );
  writeFileSync(truncatedDatabaseFile, truncatedBytes);
  writeFileSync(
    `${truncatedDatabaseFile}.manifest.json`,
    `${JSON.stringify({
      ...manifest,
      bytes: truncatedBytes.length,
      sha256: sha256File(truncatedDatabaseFile),
    })}\n`,
  );
  const truncatedFailure = cli(
    "scripts/inspect-backup.mjs",
    ["--file", truncatedDatabaseFile],
    environment,
  );
  assert.notEqual(truncatedFailure.status, 0);
  assert.match(truncatedFailure.stderr, /database|SQLite|malformed/i);
  const truncatedDestination = path.join(root, "truncated-restore.sqlite");
  const truncatedRestore = cli(
    "scripts/restore.mjs",
    ["--file", truncatedDatabaseFile, "--confirm-empty"],
    { ...environment, VECTOR_DB_PATH: truncatedDestination },
  );
  assert.notEqual(truncatedRestore.status, 0);
  assert.equal(existsSync(truncatedDestination), false);

  const malformedManifestFile = path.join(root, "manifest-truncated.sqlite");
  copyFileSync(backup, malformedManifestFile);
  writeFileSync(`${malformedManifestFile}.manifest.json`, '{"formatVersion":1');
  const malformedManifestFailure = cli(
    "scripts/inspect-backup.mjs",
    ["--file", malformedManifestFile],
    environment,
  );
  assert.notEqual(malformedManifestFailure.status, 0);
  assert.match(malformedManifestFailure.stderr, /not valid JSON/i);

  const boundedRestore = path.join(root, "bounded-restore.sqlite");
  assert.throws(
    () => atomicCopy(backup, boundedRestore, 4_096),
    /size is outside the supported range/i,
  );
  assert.equal(existsSync(boundedRestore), false);
  assert.deepEqual(
    readdirSync(root).filter((name) => name.includes(".restore-") && name.endsWith(".tmp")),
    [],
  );
  const checksumMismatchRestore = path.join(root, "checksum-mismatch-restore.sqlite");
  assert.throws(
    () => atomicCopy(
      backup,
      checksumMismatchRestore,
      statSync(backup).size,
      "0".repeat(64),
    ),
    /checksum does not match/i,
  );
  assert.equal(existsSync(checksumMismatchRestore), false);

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

test("maintenance CLIs reject a hard-linked live database before reading or mutating it", async () => {
  const root = temporaryRoot();
  const source = path.join(root, "source.sqlite");
  const alias = path.join(root, "maintenance-alias.sqlite");
  const backup = path.join(root, "should-not-exist.sqlite");
  const instance = await startTestApp({ databasePath: source, seedSynthetic: true });
  apps.add(instance);
  await instance.close();
  apps.delete(instance);
  const before = logicalDatabaseDigest(source);
  const baseEnvironment = {
    VECTOR_ORIGIN: "http://127.0.0.1:4173",
    VECTOR_BOOTSTRAP_ADMIN_PASSWORD: "not-used-for-existing-database",
    VECTOR_SEED_SYNTHETIC: "false",
  };
  const directEnvironment = { ...baseEnvironment, VECTOR_DB_PATH: source };
  const directDoctor = cli("scripts/doctor.mjs", [], directEnvironment);
  assert.equal(directDoctor.status, 0, directDoctor.stderr);
  const directCompact = cli(
    "scripts/compact.mjs",
    ["--confirm-maintenance"],
    directEnvironment,
  );
  assert.equal(directCompact.status, 0, directCompact.stderr);
  assert.equal(logicalDatabaseDigest(source), before);

  linkSync(source, alias);
  const environment = { ...baseEnvironment, VECTOR_DB_PATH: alias };

  const compacted = cli(
    "scripts/compact.mjs",
    ["--confirm-maintenance"],
    environment,
  );
  assert.notEqual(compacted.status, 0);
  assert.match(compacted.stderr, /must not be hard-linked/i);
  assert.equal(logicalDatabaseDigest(source), before);

  const backedUp = cli("scripts/backup.mjs", ["--output", backup], environment);
  assert.notEqual(backedUp.status, 0);
  assert.match(backedUp.stderr, /must not be hard-linked/i);
  assert.equal(existsSync(backup), false);
  assert.equal(existsSync(`${backup}.manifest.json`), false);

  const diagnosed = cli("scripts/doctor.mjs", [], environment);
  assert.notEqual(diagnosed.status, 0);
  const report = JSON.parse(diagnosed.stdout);
  assert.equal(report.status, "failed");
  assert.match(
    report.checks.find((item) => item.name === "database_open").detail,
    /must not be hard-linked/i,
  );
  assert.match(
    report.checks.find((item) => item.name === "storage_writable").detail,
    /safe-open check/i,
  );
  assert.equal(
    readdirSync(root).some((name) => name.startsWith(".vector-write-probe-")),
    false,
  );
});

test("live WAL backup survives concurrent reads and writes with a byte-logical restore", async () => {
  const root = temporaryRoot();
  const source = path.join(root, "live-source.sqlite");
  const backup = path.join(root, "live-backup.sqlite");
  const restored = path.join(root, "live-restored.sqlite");
  const instance = await startTestApp({ databasePath: source, seedSynthetic: true });
  apps.add(instance);
  await instance.client.login();

  const schoolId = instance.db.prepare(
    "SELECT id FROM schools ORDER BY created_at, id LIMIT 1",
  ).pluck().get();
  const insertAudit = instance.db.prepare(`
    INSERT INTO audit_events (
      id, school_id, actor_user_id, action, entity_type, entity_id,
      metadata_json, request_id, created_at
    ) VALUES (?, ?, NULL, 'test.concurrent_backup', 'system', NULL, ?, NULL, ?)
  `);
  const seedAudit = instance.db.transaction(() => {
    for (let index = 0; index < 3_000; index += 1) {
      insertAudit.run(
        randomUUID(),
        schoolId,
        JSON.stringify({ index, padding: "x".repeat(2_048) }),
        new Date(1_750_000_000_000 + index).toISOString(),
      );
    }
  });
  seedAudit();

  const beforeCount = instance.db.prepare(
    "SELECT COUNT(*) FROM audit_events",
  ).pluck().get();
  const reader = new Database(source, { readonly: true, fileMustExist: true });
  const environment = {
    VECTOR_DB_PATH: source,
    VECTOR_ORIGIN: "http://127.0.0.1:4173",
    VECTOR_BOOTSTRAP_ADMIN_PASSWORD: "not-used-for-existing-database",
    VECTOR_SEED_SYNTHETIC: "false",
  };
  let afterCount;
  try {
    reader.exec("BEGIN");
    assert.equal(
      reader.prepare("SELECT COUNT(*) FROM audit_events").pluck().get(),
      beforeCount,
    );

    const backupJob = cliAsync("scripts/backup.mjs", ["--output", backup], environment);
    for (let index = 0; index < 200; index += 1) {
      insertAudit.run(
        randomUUID(),
        schoolId,
        JSON.stringify({ concurrent: index }),
        new Date(1_760_000_000_000 + index).toISOString(),
      );
      if (index % 10 === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    const created = await backupJob;
    assert.equal(created.status, 0, created.stderr);

    assert.equal(
      reader.prepare("SELECT COUNT(*) FROM audit_events").pluck().get(),
      beforeCount,
    );
    reader.exec("COMMIT");
    afterCount = instance.db.prepare(
      "SELECT COUNT(*) FROM audit_events",
    ).pluck().get();
    assert.equal(
      reader.prepare("SELECT COUNT(*) FROM audit_events").pluck().get(),
      afterCount,
    );
  } finally {
    if (reader.inTransaction) reader.exec("ROLLBACK");
    reader.close();
  }

  const inspected = inspectDatabase(backup, { requireSessionFree: true });
  assert.ok(inspected.counts.audit_events >= beforeCount);
  assert.ok(inspected.counts.audit_events <= afterCount);
  const restoredResult = cli(
    "scripts/restore.mjs",
    ["--file", backup, "--confirm-empty"],
    { ...environment, VECTOR_DB_PATH: restored },
  );
  assert.equal(restoredResult.status, 0, restoredResult.stderr);
  const manifest = JSON.parse(readFileSync(`${backup}.manifest.json`, "utf8"));
  assert.equal(sha256File(restored), manifest.sha256);
  assert.equal(logicalDatabaseDigest(restored), logicalDatabaseDigest(backup));
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
