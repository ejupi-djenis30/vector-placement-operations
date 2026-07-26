import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { expectedMigrations, latestMigrationVersion } from "../server/db.mjs";
import { APP_VERSION } from "../server/version.mjs";

const COUNTED_TABLES = [
  "schools",
  "users",
  "cohorts",
  "students",
  "hosts",
  "placement_periods",
  "placements",
  "time_entries",
  "check_ins",
  "placement_documents",
  "sessions",
  "audit_events",
];
const EXPECTED_TABLES = new Set(["schema_migrations", ...COUNTED_TABLES]);
export const MAX_BACKUP_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const HASH_BUFFER_BYTES = 1024 * 1024;
export { APP_VERSION };

export function backupByteLimit(value = undefined) {
  if (value === undefined) return MAX_BACKUP_BYTES;
  const text = String(value);
  const parsed = Number(text);
  if (
    !/^[1-9]\d*$/.test(text)
    || !Number.isSafeInteger(parsed)
    || parsed < 4096
    || parsed > MAX_BACKUP_BYTES
  ) {
    throw new Error(
      `VECTOR_BACKUP_MAX_BYTES must be an integer from 4096 to ${MAX_BACKUP_BYTES}.`,
    );
  }
  return parsed;
}

export function ensurePrivateDirectory(directory) {
  const resolved = path.resolve(directory);
  const existed = existsSync(resolved);
  if (!existed) {
    mkdirSync(resolved, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(resolved, 0o700);
    return { created: true, path: resolved };
  }
  const stats = statSync(resolved);
  if (!stats.isDirectory()) throw new Error(`Backup parent is not a directory: ${resolved}`);
  if (process.platform !== "win32") {
    if (stats.uid !== process.getuid() || (stats.mode & 0o077) !== 0) {
      throw new Error(
        `Backup parent must be owned by the current user and private (mode 0700): ${resolved}`,
      );
    }
  }
  return { created: false, path: resolved };
}

export function sha256File(file) {
  const hash = createHash("sha256");
  const descriptor = openSync(file, "r");
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  try {
    let bytesRead;
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

export function manifestPath(file) {
  return `${file}.manifest.json`;
}

export function inspectDatabase(file, { requireSessionFree = false } = {}) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma("quick_check", { simple: true });
    if (integrity !== "ok") throw new Error("SQLite quick_check failed.");
    const foreignKeyViolations = db.pragma("foreign_key_check");
    if (foreignKeyViolations.length > 0) {
      throw new Error("SQLite foreign_key_check found invalid references.");
    }
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()
        .map((row) => row.name),
    );
    const missingTables = [...EXPECTED_TABLES].filter((table) => !tables.has(table));
    if (missingTables.length > 0) {
      throw new Error(`Backup is missing required tables: ${missingTables.join(", ")}.`);
    }
    const appliedMigrations = db.prepare(`
      SELECT version, name, checksum
      FROM schema_migrations
      ORDER BY version
    `).all();
    const expected = expectedMigrations();
    if (
      appliedMigrations.length !== expected.length
      || expected.some((migration, index) => (
        appliedMigrations[index]?.version !== migration.version
        || appliedMigrations[index]?.name !== migration.name
        || appliedMigrations[index]?.checksum !== migration.checksum
      ))
    ) {
      throw new Error("Backup migrations do not match this VECTOR build.");
    }
    const migrationVersion = appliedMigrations.at(-1)?.version ?? 0;
    const counts = Object.fromEntries(
      COUNTED_TABLES.map(
        (table) => [table, db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count],
      ),
    );
    if (counts.schools !== 1) {
      throw new Error("A VECTOR backup must contain exactly one school.");
    }
    if (requireSessionFree && counts.sessions !== 0) {
      throw new Error("A VECTOR backup must not contain active sessions.");
    }
    return { integrity, migrationVersion, counts, appliedMigrations };
  } finally {
    db.close();
  }
}

function assertManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Backup manifest is not an object.");
  }
  if (
    manifest.formatVersion !== 1
    || manifest.product !== "VECTOR"
    || manifest.appVersion !== APP_VERSION
  ) {
    throw new Error("Unsupported backup manifest.");
  }
  const expectedKeys = [
    "formatVersion",
    "product",
    "appVersion",
    "createdAt",
    "bytes",
    "sha256",
    "migrationVersion",
    "counts",
  ];
  const actualKeys = Object.keys(manifest).sort();
  if (
    actualKeys.length !== expectedKeys.length
    || expectedKeys.some((key) => !actualKeys.includes(key))
  ) {
    throw new Error("Backup manifest has unexpected or missing fields.");
  }
  if (
    typeof manifest.createdAt !== "string"
    || !Number.isFinite(Date.parse(manifest.createdAt))
    || new Date(manifest.createdAt).toISOString() !== manifest.createdAt
  ) {
    throw new Error("Backup manifest contains an invalid creation timestamp.");
  }
  if (
    !Number.isSafeInteger(manifest.bytes)
    || manifest.bytes <= 0
    || manifest.bytes > MAX_BACKUP_BYTES
  ) {
    throw new Error("Backup manifest contains an invalid size.");
  }
  if (typeof manifest.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(manifest.sha256)) {
    throw new Error("Backup manifest contains an invalid checksum.");
  }
  if (
    !Number.isInteger(manifest.migrationVersion)
    || manifest.migrationVersion !== latestMigrationVersion()
  ) {
    throw new Error("Backup manifest contains an unsupported migration version.");
  }
  if (!manifest.counts || typeof manifest.counts !== "object" || Array.isArray(manifest.counts)) {
    throw new Error("Backup manifest contains invalid record counts.");
  }
  const countKeys = Object.keys(manifest.counts).sort();
  const expectedCountKeys = [...COUNTED_TABLES].sort();
  if (
    countKeys.length !== expectedCountKeys.length
    || expectedCountKeys.some((key, index) => countKeys[index] !== key)
  ) {
    throw new Error("Backup manifest record counts do not match the expected schema.");
  }
  for (const table of COUNTED_TABLES) {
    if (!Number.isSafeInteger(manifest.counts[table]) || manifest.counts[table] < 0) {
      throw new Error(`Backup manifest count is invalid for ${table}.`);
    }
  }
  if (manifest.counts.schools !== 1) {
    throw new Error("Backup manifest must describe exactly one school.");
  }
  if (manifest.counts.sessions !== 0) {
    throw new Error("Backup manifest must describe a session-free snapshot.");
  }
}

export function verifyDatabaseAgainstManifest(file, manifest) {
  const stats = assertBackupFileSize(file);
  if (stats.size !== manifest.bytes) throw new Error("Backup size does not match its manifest.");
  const digest = sha256File(file);
  if (digest !== manifest.sha256) throw new Error("Backup checksum does not match its manifest.");
  const inspected = inspectDatabase(file, { requireSessionFree: true });
  if (inspected.migrationVersion !== manifest.migrationVersion) {
    throw new Error("Backup migration version does not match its manifest.");
  }
  for (const table of COUNTED_TABLES) {
    if (inspected.counts[table] !== manifest.counts[table]) {
      throw new Error(`Backup record count does not match its manifest for ${table}.`);
    }
  }
  return inspected;
}

export function readAndVerifyManifest(file) {
  const sidecar = manifestPath(file);
  if (!existsSync(file) || !existsSync(sidecar)) {
    throw new Error("The backup and its manifest must both exist.");
  }
  const manifestStats = statSync(sidecar);
  if (manifestStats.size <= 0 || manifestStats.size > MAX_MANIFEST_BYTES) {
    throw new Error("Backup manifest size is outside the supported range.");
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(sidecar, "utf8"));
  } catch {
    throw new Error("Backup manifest is not valid JSON.");
  }
  assertManifest(manifest);
  assertBackupFileSize(file);
  const inspected = verifyDatabaseAgainstManifest(file, manifest);
  return { manifest, inspected };
}

export function captureFileIdentity(file) {
  const stats = statSync(file);
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    birthtimeMs: stats.birthtimeMs,
  };
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && (
      left.ino !== 0
      || (
        left.size === right.size
        && left.birthtimeMs === right.birthtimeMs
      )
    );
}

export function removeFileIfOwned(file, identity) {
  if (!identity || !existsSync(file)) return false;
  let current;
  try {
    current = captureFileIdentity(file);
  } catch {
    return false;
  }
  if (!sameIdentity(current, identity)) return false;
  unlinkSync(file);
  return true;
}

export function atomicCopy(source, destination, maximumBytes = MAX_BACKUP_BYTES) {
  const temporary = `${destination}.restore-${process.pid}-${randomUUID()}.tmp`;
  let sourceDescriptor = null;
  let descriptor = null;
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  let copied = 0;
  try {
    sourceDescriptor = openSync(source, "r");
    descriptor = openSync(temporary, "wx", 0o600);
    let bytesRead;
    do {
      bytesRead = readSync(sourceDescriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        copied += bytesRead;
        if (copied > maximumBytes) {
          throw new Error("Backup size is outside the supported range.");
        }
        let offset = 0;
        while (offset < bytesRead) {
          offset += writeSync(
            descriptor,
            buffer,
            offset,
            bytesRead - offset,
            null,
          );
        }
      }
    } while (bytesRead > 0);
    if (copied <= 0) throw new Error("Backup size is outside the supported range.");
    fsyncSync(descriptor);
    closeSync(sourceDescriptor);
    sourceDescriptor = null;
    closeSync(descriptor);
    descriptor = null;
    if (sha256File(source) !== sha256File(temporary)) {
      throw new Error("Temporary restore copy failed checksum verification.");
    }
    const identity = captureFileIdentity(temporary);
    linkSync(temporary, destination);
    return identity;
  } finally {
    if (sourceDescriptor !== null) closeSync(sourceDescriptor);
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function assertBackupFileSize(file, maximumBytes = MAX_BACKUP_BYTES) {
  const stats = statSync(file);
  if (
    !Number.isSafeInteger(maximumBytes)
    || maximumBytes <= 0
    || stats.size <= 0
    || stats.size > maximumBytes
  ) {
    throw new Error("Backup size is outside the supported range.");
  }
  return stats;
}

export function writeManifestAtomic(file, manifest) {
  const destination = manifestPath(file);
  const temporary = `${destination}.${process.pid}-${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeSync(descriptor, `${JSON.stringify(manifest, null, 2)}\n`, null, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    const identity = captureFileIdentity(temporary);
    linkSync(temporary, destination);
    return identity;
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function resolveSafeOutput(value) {
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) throw new Error("Refusing to use a filesystem root.");
  return resolved;
}
