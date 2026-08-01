import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { hashPassword } from "./password.mjs";
import { writeAudit } from "./audit.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIRECTORY = path.join(ROOT, "migrations");
const SQLITE_COMPANION_SUFFIXES = ["-wal", "-shm", "-journal"];
const WINDOWS_RESERVED_DEVICE_NAMES = new Set([
  "aux",
  "clock$",
  "con",
  "conin$",
  "conout$",
  "nul",
  "prn",
]);
const SCHEMA_INVENTORY_SQL = `
  SELECT type, name, tbl_name AS tableName, sql
  FROM sqlite_schema
  WHERE sql IS NOT NULL
  ORDER BY type, name, tbl_name
`;
const canonicalSchemaInventories = new Map();

function migrationFiles() {
  return readdirSync(MIGRATIONS_DIRECTORY)
    .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/i.test(name))
    .sort();
}

export function latestMigrationVersion() {
  const files = migrationFiles();
  return files.length === 0 ? 0 : Number.parseInt(files.at(-1).slice(0, 3), 10);
}

function checksum(content) {
  return createHash("sha256").update(content).digest("hex");
}

function createMigrationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT
  `);
}

function schemaInventory(db) {
  return db.prepare(SCHEMA_INVENTORY_SQL).all();
}

function expectedSchemaInventory(migrationCount) {
  if (canonicalSchemaInventories.has(migrationCount)) {
    return canonicalSchemaInventories.get(migrationCount);
  }
  const migrations = expectedMigrations();
  if (
    !Number.isInteger(migrationCount)
    || migrationCount < 0
    || migrationCount > migrations.length
  ) {
    throw new TypeError("migrationCount is outside the available migration range.");
  }
  const canonical = new Database(":memory:");
  try {
    canonical.pragma("foreign_keys = ON");
    disableTrustedSchemaExecution(canonical);
    createMigrationTable(canonical);
    for (const migration of migrations.slice(0, migrationCount)) {
      canonical.exec(readFileSync(path.join(MIGRATIONS_DIRECTORY, migration.name), "utf8"));
    }
    const inventory = schemaInventory(canonical);
    canonicalSchemaInventories.set(migrationCount, inventory);
    return inventory;
  } finally {
    canonical.close();
  }
}

export function assertDatabaseSchema(
  db,
  { migrationCount = expectedMigrations().length } = {},
) {
  const expected = expectedSchemaInventory(migrationCount);
  const actual = schemaInventory(db);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Database schema does not match this VECTOR build.");
  }
  return { objects: actual.length };
}

export function expectedMigrations() {
  return migrationFiles().map((name) => {
    const content = readFileSync(path.join(MIGRATIONS_DIRECTORY, name), "utf8");
    return {
      version: Number.parseInt(name.slice(0, 3), 10),
      name,
      checksum: checksum(content),
    };
  });
}

export function assertMigrationState(db, { allowPending = false } = {}) {
  const applied = db.prepare(`
    SELECT version, name, checksum
    FROM schema_migrations
    ORDER BY version
  `).all();
  const expected = expectedMigrations();
  if (applied.length > expected.length) {
    throw new Error("Database contains migrations newer than this VECTOR build.");
  }
  for (let index = 0; index < applied.length; index += 1) {
    const actual = applied[index];
    const wanted = expected[index];
    if (
      !wanted
      || actual.version !== wanted.version
      || actual.name !== wanted.name
      || actual.checksum !== wanted.checksum
    ) {
      throw new Error("Database migration history does not match this VECTOR build.");
    }
  }
  if (!allowPending && applied.length !== expected.length) {
    throw new Error("Database migrations are not current.");
  }
  return { applied: applied.length, expected: expected.length };
}

function existingPathStats(value) {
  try {
    return lstatSync(value);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function sameFilesystemObject(left, right) {
  return left.ino !== 0
    && right.ino !== 0
    && left.dev === right.dev
    && left.ino === right.ino;
}

function isReservedWindowsDeviceName(component) {
  const stem = component.split(".", 1)[0].trimEnd().toLowerCase();
  return WINDOWS_RESERVED_DEVICE_NAMES.has(stem)
    || /^(?:com|lpt)[1-9¹²³]$/u.test(stem);
}

function assertSupportedWindowsPath(resolved) {
  if (process.platform !== "win32") return;
  if (resolved.startsWith("\\\\")) {
    throw new Error(
      "Database path must use a local Windows drive, not a UNC or device namespace.",
    );
  }
  const root = path.parse(resolved).root;
  const components = resolved.slice(root.length).split(path.sep).filter(Boolean);
  for (const component of components) {
    if (component.includes(":")) {
      throw new Error("Database path must not use an NTFS alternate data stream.");
    }
    if (/[ .]$/u.test(component)) {
      throw new Error("Database path components must not end in a space or dot on Windows.");
    }
    if (isReservedWindowsDeviceName(component)) {
      throw new Error(`Database path must not use a reserved Windows device name: ${component}`);
    }
  }
}

function assertNoSymbolicLinkComponents(value) {
  const resolved = path.resolve(value);
  assertSupportedWindowsPath(resolved);
  const root = path.parse(resolved).root;
  const components = resolved.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = path.join(current, component);
    const stats = existingPathStats(current);
    if (!stats) return resolved;
    if (stats.isSymbolicLink()) {
      throw new Error(`Database path must not contain symbolic links or junctions: ${current}`);
    }
    if (
      process.platform !== "win32"
      && stats.isDirectory()
      && stats.uid !== 0
      && stats.uid !== process.getuid()
    ) {
      throw new Error(
        `Database path ancestor must be owned by root or the current user: ${current}`,
      );
    }
    if (
      process.platform !== "win32"
      && stats.isDirectory()
      && (stats.mode & 0o022) !== 0
      && (stats.mode & 0o1000) === 0
    ) {
      throw new Error(
        `Database path ancestor must not be writable by other users: ${current}`,
      );
    }
  }
  return resolved;
}

function assertPrivateDirectoryStats(stats, directory) {
  if (!stats.isDirectory()) {
    throw new Error(`Database parent must be a directory: ${directory}`);
  }
  if (process.platform !== "win32") {
    if (stats.uid !== process.getuid() || (stats.mode & 0o777) !== 0o700) {
      throw new Error(
        `Database parent must be owned by the current user and private (mode 0700): ${directory}`,
      );
    }
  }
}

function assertPrivateRegularFileStats(stats, file) {
  if (!stats.isFile()) {
    throw new Error(`SQLite storage must be a regular file: ${file}`);
  }
  if (stats.nlink !== 1) {
    throw new Error(`SQLite storage must not be hard-linked: ${file}`);
  }
  if (process.platform !== "win32") {
    if (stats.uid !== process.getuid() || (stats.mode & 0o777) !== 0o600) {
      throw new Error(
        `SQLite storage must be owned by the current user and private (mode 0600): ${file}`,
      );
    }
  }
}

function openDirectoryGuard(directory) {
  assertNoSymbolicLinkComponents(directory);
  const firstCreated = mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertNoSymbolicLinkComponents(directory);
  const pathStats = lstatSync(directory);
  if (pathStats.isSymbolicLink()) {
    throw new Error(`Database parent must not be a symbolic link or junction: ${directory}`);
  }

  if (process.platform === "win32") {
    assertPrivateDirectoryStats(pathStats, directory);
    return { descriptor: null, stats: pathStats };
  }

  // O_NOFOLLOW binds this descriptor to the checked directory; the fstat and
  // second lstat below must identify the same object before it is trusted.
  // codeql[js/file-system-race]
  const descriptor = openSync(
    directory,
    constants.O_RDONLY
      | (constants.O_DIRECTORY ?? 0)
      | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    if (firstCreated !== undefined) fchmodSync(descriptor, 0o700);
    const descriptorStats = fstatSync(descriptor);
    const afterOpen = lstatSync(directory);
    assertPrivateDirectoryStats(descriptorStats, directory);
    if (!sameFilesystemObject(descriptorStats, afterOpen)) {
      throw new Error("Database parent changed while it was being opened.");
    }
    return { descriptor, stats: descriptorStats };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function assertDirectoryGuard(directory, guard) {
  assertNoSymbolicLinkComponents(directory);
  const pathStats = lstatSync(directory);
  assertPrivateDirectoryStats(pathStats, directory);
  if (!sameFilesystemObject(guard.stats, pathStats)) {
    throw new Error("Database parent changed while SQLite was opening.");
  }
  if (guard.descriptor !== null) {
    const descriptorStats = fstatSync(guard.descriptor);
    if (!sameFilesystemObject(descriptorStats, pathStats)) {
      throw new Error("Database parent changed while SQLite was opening.");
    }
  }
}

function openMainDatabaseGuard(file, { allowCreate }) {
  assertNoSymbolicLinkComponents(file);
  const existing = existingPathStats(file);
  if (existing) {
    // Do not open and close an extra descriptor for a live SQLite database.
    // On POSIX, closing any descriptor for the file can release process-scoped
    // fcntl locks that SQLite still owns through its own descriptor.
    assertPrivateRegularFileStats(existing, file);
    return { created: false, stats: existing };
  }
  if (!allowCreate) {
    throw new Error("A new database must not have pre-existing SQLite companion files.");
  }

  let descriptor = null;
  try {
    descriptor = openSync(
      file,
      constants.O_RDWR
        | constants.O_CREAT
        | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  assertNoSymbolicLinkComponents(file);
  const pathStats = lstatSync(file);
  assertPrivateRegularFileStats(pathStats, file);
  return { created: true, stats: pathStats };
}

function assertMainDatabaseGuard(file, guard) {
  assertNoSymbolicLinkComponents(file);
  const pathStats = lstatSync(file);
  assertPrivateRegularFileStats(pathStats, file);
  if (!sameFilesystemObject(guard.stats, pathStats)) {
    throw new Error("Database file changed while SQLite was opening.");
  }
}

function validateExistingStorageFile(file) {
  assertNoSymbolicLinkComponents(file);
  const stats = existingPathStats(file);
  if (!stats) return false;
  assertPrivateRegularFileStats(stats, file);
  return true;
}

export function disableTrustedSchemaExecution(db) {
  db.pragma("trusted_schema = OFF");
  if (db.pragma("trusted_schema", { simple: true }) !== 0) {
    throw new Error("SQLite did not disable trusted schema execution.");
  }
}

function configureDatabaseConnection(db, { requireWal }) {
  db.pragma("foreign_keys = ON");
  // Treat schema text as data, not as a trusted place from which to invoke
  // extension or application-defined SQL functions. VECTOR's migrations use
  // only SQLite built-ins and the canonical schema inventory is checked later.
  disableTrustedSchemaExecution(db);
  const journalMode = db.pragma("journal_mode = WAL", { simple: true });
  if (requireWal && journalMode !== "wal") {
    throw new Error("SQLite did not enable the required WAL journal mode.");
  }
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = FULL");
  db.pragma("secure_delete = ON");
  db.pragma("wal_autocheckpoint = 1000");
}

export function openExistingDatabase(databasePath, { readonly = false } = {}) {
  if (
    typeof databasePath !== "string"
    || databasePath.length === 0
    || databasePath === ":memory:"
  ) {
    throw new TypeError("Existing database path must be a non-empty filesystem path.");
  }
  if (typeof readonly !== "boolean") {
    throw new TypeError("Existing database readonly mode must be a boolean.");
  }

  const resolved = assertNoSymbolicLinkComponents(databasePath);
  // Fail before openDirectoryGuard so a read/maintenance command cannot create
  // a missing configured parent as a side effect of inspecting an absent file.
  const initial = existingPathStats(resolved);
  if (!initial) throw new Error("SQLite database file does not exist.");
  assertPrivateRegularFileStats(initial, resolved);

  const directory = path.dirname(resolved);
  const directoryGuard = openDirectoryGuard(directory);
  let db = null;
  try {
    for (const suffix of SQLITE_COMPANION_SUFFIXES) {
      validateExistingStorageFile(`${resolved}${suffix}`);
    }
    const mainGuard = openMainDatabaseGuard(resolved, { allowCreate: false });
    db = new Database(resolved, {
      timeout: 5_000,
      readonly,
      fileMustExist: true,
    });
    db.pragma("foreign_keys = ON");
    disableTrustedSchemaExecution(db);
    db.pragma("busy_timeout = 5000");

    assertDirectoryGuard(directory, directoryGuard);
    assertMainDatabaseGuard(resolved, mainGuard);
    for (const suffix of SQLITE_COMPANION_SUFFIXES) {
      validateExistingStorageFile(`${resolved}${suffix}`);
    }
    return db;
  } catch (error) {
    if (db?.open) db.close();
    throw error;
  } finally {
    if (directoryGuard.descriptor !== null) closeSync(directoryGuard.descriptor);
  }
}

export function openDatabase(databasePath) {
  if (databasePath === ":memory:") {
    const db = new Database(databasePath, { timeout: 5_000 });
    try {
      configureDatabaseConnection(db, { requireWal: false });
      createMigrationTable(db);
      return db;
    } catch (error) {
      if (db.open) db.close();
      throw error;
    }
  }
  if (typeof databasePath !== "string" || databasePath.length === 0) {
    throw new TypeError("Database path must be a non-empty filesystem path.");
  }

  const resolved = assertNoSymbolicLinkComponents(databasePath);
  const directory = path.dirname(resolved);
  const directoryGuard = openDirectoryGuard(directory);
  let mainGuard = null;
  let db = null;
  const previousUmask = process.platform === "win32" ? null : process.umask(0o077);
  try {
    const companionsBeforeOpen = SQLITE_COMPANION_SUFFIXES
      .map((suffix) => `${resolved}${suffix}`)
      .filter((file) => validateExistingStorageFile(file));
    // If companions were observed, the main file must still exist when its
    // guard is acquired. Refusing creation here prevents a deletion race from
    // turning stale WAL/SHM state into a plausible new main database.
    mainGuard = openMainDatabaseGuard(resolved, {
      allowCreate: companionsBeforeOpen.length === 0,
    });

    db = new Database(resolved, { timeout: 5_000 });
    configureDatabaseConnection(db, { requireWal: true });
    createMigrationTable(db);

    assertDirectoryGuard(directory, directoryGuard);
    assertMainDatabaseGuard(resolved, mainGuard);
    for (const suffix of SQLITE_COMPANION_SUFFIXES) {
      validateExistingStorageFile(`${resolved}${suffix}`);
    }
    return db;
  } catch (error) {
    // Once SQLite has opened the newly created inode, do not unlink it on an
    // error: another connection may already have attached to and written that
    // same inode. A closed, unbootstrapped database is recoverable; deleting a
    // concurrently initialized database is not.
    if (db?.open) db.close();
    throw error;
  } finally {
    if (previousUmask !== null) process.umask(previousUmask);
    if (directoryGuard.descriptor !== null) closeSync(directoryGuard.descriptor);
  }
}

export function migrateDatabase(db) {
  const migrate = db.transaction(() => {
    // Acquire the writer reservation before reading migration state. This makes
    // concurrent startup safe: a second process waits, then re-reads the state
    // committed by the first process instead of applying a stale pending list.
    const state = assertMigrationState(db, { allowPending: true });
    // Validate the exact schema represented by the already-applied ledger
    // before running any pending SQL. Otherwise an added trigger could execute
    // during the upgrade before the final drift check gets a chance to reject it.
    assertDatabaseSchema(db, { migrationCount: state.applied });
    const migrations = expectedMigrations();
    const recordMigration = db.prepare(`
      INSERT INTO schema_migrations (version, name, checksum, applied_at)
      VALUES (?, ?, ?, ?)
    `);

    for (const expected of migrations.slice(state.applied)) {
      const { name, checksum: digest } = expected;
      const sql = readFileSync(path.join(MIGRATIONS_DIRECTORY, name), "utf8");
      db.exec(sql);
      recordMigration.run(
        expected.version,
        name,
        digest,
        new Date().toISOString(),
      );
    }
    assertMigrationState(db);
    // The migration ledger alone is not proof of schema integrity: a copied or
    // manually edited database can retain valid checksums while dropping a
    // capacity/immutability trigger or adding executable schema objects.
    assertDatabaseSchema(db, { migrationCount: migrations.length });
  });

  // Keep the complete pending set atomic. A failed later migration must not
  // leave an installation at an unplanned intermediate build state.
  migrate.immediate();
}

function isoNow() {
  return new Date().toISOString();
}

function shortLabel(value, maxLength = 40) {
  if (value.length <= maxLength) return value;
  const candidate = value.slice(0, maxLength + 1);
  const boundary = candidate.lastIndexOf(" ");
  return (boundary >= Math.floor(maxLength * 0.6)
    ? candidate.slice(0, boundary)
    : value.slice(0, maxLength)).trim();
}

function insertSyntheticDataset(db, schoolId, tutorId) {
  const now = isoNow();
  const cohortIds = ["cohort-software", "cohort-systems"];
  const periodId = "period-spring-2026";
  const hosts = [
    ["host-atlas", "Atlas Workshop", "Industrial design"],
    ["host-cobalt", "Cobalt Systems", "Software"],
    ["host-northline", "Northline Studio", "Digital media"],
    ["host-fieldnote", "Fieldnote Labs", "Research"],
    ["host-common", "Common Ground", "Community services"],
    ["host-orbit", "Orbit Works", "Automation"],
  ];
  const students = [
    ["student-maya", "Maya", "Keller", cohortIds[0]],
    ["student-sofia", "Sofia", "Marin", cohortIds[0]],
    ["student-jonas", "Jonas", "Weber", cohortIds[1]],
    ["student-lea", "Lea", "Dubois", cohortIds[1]],
    ["student-noah", "Noah", "Rossi", cohortIds[0]],
    ["student-ines", "Ines", "Meyer", cohortIds[1]],
  ];
  const placements = [
    ["placement-104", students[0][0], hosts[0][0], "planned", 180 * 60, 0],
    ["placement-101", students[1][0], hosts[1][0], "review", 180 * 60, 164 * 60],
    ["placement-106", students[2][0], hosts[2][0], "review", 160 * 60, 142 * 60],
    ["placement-102", students[3][0], hosts[3][0], "complete", 180 * 60, 180 * 60],
    ["placement-105", students[4][0], hosts[4][0], "active", 160 * 60, 72 * 60],
    ["placement-103", students[5][0], hosts[5][0], "active", 200 * 60, 102 * 60],
  ];

  const insertCohort = db.prepare(`
    INSERT INTO cohorts (
      id, school_id, name, academic_year, track, tutor_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertCohort.run(cohortIds[0], schoolId, "4A Software", "2025/2026", "Software", tutorId, now, now);
  insertCohort.run(cohortIds[1], schoolId, "4B Systems", "2025/2026", "Systems", tutorId, now, now);

  db.prepare(`
    INSERT INTO placement_periods (
      id, school_id, name, start_date, end_date, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(periodId, schoolId, "Spring 2026", "2026-03-02", "2026-06-26", now, now);

  const insertHost = db.prepare(`
    INSERT INTO hosts (
      id, school_id, name, sector, contact_name, contact_email, address, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const [id, name, sector] of hosts) {
    insertHost.run(
      id,
      schoolId,
      name,
      sector,
      "Placement contact",
      `${id.replace("host-", "")}@example.test`,
      "Fictional address",
      now,
      now,
    );
  }

  const insertStudent = db.prepare(`
    INSERT INTO students (
      id, school_id, cohort_id, external_ref, first_name, last_name, email, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const [id, firstName, lastName, cohortId] of students) {
    insertStudent.run(
      id,
      schoolId,
      cohortId,
      `SYN-${id.slice(-4).toUpperCase()}`,
      firstName,
      lastName,
      `${firstName}.${lastName}@example.test`.toLowerCase(),
      now,
      now,
    );
  }

  const insertPlacement = db.prepare(`
    INSERT INTO placements (
      id, school_id, student_id, host_id, period_id, school_tutor_id,
      host_tutor_name, host_tutor_email, start_date, end_date, target_minutes,
      status, notes, programme_version_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTime = db.prepare(`
    INSERT INTO time_entries (
      id, school_id, placement_id, entry_date, minutes, description,
      verification_status, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertDocument = db.prepare(`
    INSERT INTO placement_documents (
      id, school_id, placement_id, kind, title, status, reference, due_date,
      requirement_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const [id, studentId, hostId, status, targetMinutes, loggedMinutes] of placements) {
    insertPlacement.run(
      id,
      schoolId,
      studentId,
      hostId,
      periodId,
      tutorId,
      "Fictional host tutor",
      "host.tutor@example.test",
      "2026-03-02",
      "2026-06-26",
      targetMinutes,
      status,
      "",
      `programme_version_default_${schoolId}`,
      now,
      now,
    );
    if (loggedMinutes > 0) {
      let remaining = loggedMinutes;
      let entryIndex = 0;
      while (remaining > 0) {
        const minutes = Math.min(remaining, 8 * 60);
        const entryDate = new Date(Date.UTC(2026, 2, 9 + entryIndex)).toISOString().slice(0, 10);
        insertTime.run(
          `time-${id}-${entryIndex + 1}`,
          schoolId,
          id,
          entryDate,
          minutes,
          "Synthetic placement activity",
          "verified",
          tutorId,
          now,
          now,
        );
        remaining -= minutes;
        entryIndex += 1;
      }
    }
    insertDocument.run(
      `document-${id}`,
      schoolId,
      id,
      "training_agreement",
      "Training agreement",
      status === "planned" ? "draft" : "signed",
      "",
      "2026-03-01",
      `requirement_training_${schoolId}`,
      now,
      now,
    );
    for (const [kind, title, requirementPrefix] of [
      ["attendance_log", "Attendance log", "attendance"],
      ["evaluation", "Evaluation", "evaluation"],
    ]) {
      insertDocument.run(
        `document-${kind}-${id}`,
        schoolId,
        id,
        kind,
        title,
        "missing",
        "",
        null,
        `requirement_${requirementPrefix}_${schoolId}`,
        now,
        now,
      );
    }
  }

  writeAudit(db, {
    schoolId,
    action: "dataset.seeded",
    entityType: "school",
    entityId: schoolId,
    metadata: { count: placements.length, resource: "synthetic_dataset" },
  });
}

export async function bootstrapDatabase(db, config) {
  const schoolCount = db.prepare("SELECT COUNT(*) AS count FROM schools").get().count;
  if (schoolCount > 1) {
    throw new Error("VECTOR supports exactly one school per installation.");
  }
  let school;
  let created = false;

  if (schoolCount === 0) {
    const password = config.bootstrapAdminPassword;
    if (!password) {
      throw new Error("VECTOR_BOOTSTRAP_ADMIN_PASSWORD is required for a new database.");
    }

    const schoolId = randomUUID();
    const adminId = randomUUID();
    const tutorId = config.seedSynthetic ? randomUUID() : null;
    const passwordHash = await hashPassword(password);
    const now = isoNow();

    db.transaction(() => {
      db.prepare(`
        INSERT INTO schools (
          id, slug, name, short_name, product_name, time_zone, support_email,
          contact_text, footer_text, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        schoolId,
        config.bootstrapSchoolSlug,
        config.bootstrapSchoolName,
        shortLabel(config.bootstrapSchoolName),
        "VECTOR",
        config.bootstrapTimeZone,
        config.bootstrapAdminEmail,
        "Contact your school placement office for access and support.",
        "Self-hosted placement operations.",
        now,
        now,
      );
      db.prepare(`
        INSERT INTO users (
          id, school_id, email, display_name, password_hash, role, data_scope,
          active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'school_admin', 'school', 1, ?, ?)
      `).run(
        adminId,
        schoolId,
        config.bootstrapAdminEmail.toLowerCase(),
        config.bootstrapAdminName,
        passwordHash,
        now,
        now,
      );
      if (config.seedSynthetic) {
        db.prepare(`
          INSERT INTO users (
            id, school_id, email, display_name, password_hash, role, data_scope,
            active, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'tutor', 'assigned', 0, ?, ?)
        `).run(
          tutorId,
          schoolId,
          "synthetic.tutor@example.test",
          "Synthetic tutor",
          "!locked",
          now,
          now,
        );
      }
      writeAudit(db, {
        schoolId,
        actorUserId: adminId,
        action: "installation.bootstrapped",
        entityType: "school",
        entityId: schoolId,
        metadata: { role: "school_admin", scope: "school" },
      });
      if (config.seedSynthetic) insertSyntheticDataset(db, schoolId, tutorId);
    })();

    created = true;
  }

  school = db.prepare(`
    SELECT id, slug, name, short_name AS shortName, product_name AS productName
    FROM schools ORDER BY created_at LIMIT 1
  `).get();

  return { created, school };
}

export function databaseReady(db) {
  try {
    const migrations = assertMigrationState(db);
    assertDatabaseSchema(db, { migrationCount: migrations.expected });
    const school = db.prepare("SELECT COUNT(*) AS count FROM schools").get();
    const readable = db.prepare("SELECT 1 AS value").get().value;
    return school.count === 1 && readable === 1;
  } catch {
    return false;
  }
}
