import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
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

export function openDatabase(databasePath) {
  if (databasePath !== ":memory:") {
    const directory = path.dirname(path.resolve(databasePath));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(directory, 0o700);
  }

  const db = new Database(databasePath, { timeout: 5_000 });
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = FULL");
  db.pragma("secure_delete = ON");
  db.pragma("wal_autocheckpoint = 1000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT
  `);

  if (databasePath !== ":memory:" && process.platform !== "win32") {
    for (const file of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      if (existsSync(file)) chmodSync(file, 0o600);
    }
  }

  return db;
}

export function migrateDatabase(db) {
  const state = assertMigrationState(db, { allowPending: true });

  const apply = db.transaction((name, sql, digest) => {
    db.exec(sql);
    db.prepare(`
      INSERT INTO schema_migrations (version, name, checksum, applied_at)
      VALUES (?, ?, ?, ?)
    `).run(Number.parseInt(name.slice(0, 3), 10), name, digest, new Date().toISOString());
  });

  for (const expected of expectedMigrations().slice(state.applied)) {
    const { name, checksum: digest } = expected;
    const sql = readFileSync(path.join(MIGRATIONS_DIRECTORY, name), "utf8");
    apply(name, sql, digest);
  }
  assertMigrationState(db);
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
      status, notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTime = db.prepare(`
    INSERT INTO time_entries (
      id, school_id, placement_id, entry_date, minutes, description,
      verification_status, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertDocument = db.prepare(`
    INSERT INTO placement_documents (
      id, school_id, placement_id, kind, title, status, reference, due_date, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      now,
      now,
    );
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
    assertMigrationState(db);
    const school = db.prepare("SELECT COUNT(*) AS count FROM schools").get();
    const readable = db.prepare("SELECT 1 AS value").get().value;
    return school.count === 1 && readable === 1;
  } catch {
    return false;
  }
}
