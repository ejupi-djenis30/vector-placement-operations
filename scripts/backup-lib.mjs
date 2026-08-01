import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import {
  assertDatabaseSchema,
  disableTrustedSchemaExecution,
  expectedMigrations,
  latestMigrationVersion,
  openExistingDatabase,
} from "../server/db.mjs";
import { APP_VERSION } from "../server/version.mjs";

const COUNTED_TABLES = [
  "schools",
  "users",
  "cohorts",
  "students",
  "hosts",
  "placement_periods",
  "programmes",
  "programme_versions",
  "programme_requirements",
  "placements",
  "time_entries",
  "check_ins",
  "placement_documents",
  "sessions",
  "audit_events",
];
const EXPECTED_TABLES = new Set(["schema_migrations", ...COUNTED_TABLES]);
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
export const MAX_BACKUP_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const HASH_BUFFER_BYTES = 1024 * 1024;
export { APP_VERSION };

export function assertNoSymbolicLinkComponents(value) {
  const resolved = path.resolve(value);
  const root = path.parse(resolved).root;
  const components = resolved.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = path.join(current, component);
    let stats;
    try {
      stats = lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT") return resolved;
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`Backup path must not contain symbolic links: ${current}`);
    }
  }
  return resolved;
}

function assertSafeWritableAncestors(value) {
  const resolved = assertNoSymbolicLinkComponents(value);
  if (process.platform === "win32") return resolved;
  const root = path.parse(resolved).root;
  const components = resolved.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = path.join(current, component);
    let stats;
    try {
      stats = lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT") return resolved;
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`Backup path must not contain symbolic links: ${current}`);
    }
    if (!stats.isDirectory()) continue;
    if (stats.uid !== 0 && stats.uid !== process.getuid()) {
      throw new Error(
        `Backup path ancestor must be owned by root or the current user: ${current}`,
      );
    }
    if ((stats.mode & 0o022) !== 0 && (stats.mode & 0o1000) === 0) {
      throw new Error(
        `Backup path ancestor must not be writable by other users: ${current}`,
      );
    }
  }
  return resolved;
}

export function fsyncDirectory(
  directory,
  { strict = process.platform !== "win32" } = {},
) {
  if (process.platform === "win32") return false;
  const resolved = assertNoSymbolicLinkComponents(directory);
  let descriptor = null;
  try {
    descriptor = openSync(
      resolved,
      constants.O_RDONLY
        | (constants.O_DIRECTORY ?? 0)
        | (constants.O_NOFOLLOW ?? 0),
    );
    fsyncSync(descriptor);
    return true;
  } catch (error) {
    if (!strict) return false;
    const code = typeof error?.code === "string" ? error.code : "unknown_error";
    throw new Error(`Backup directory metadata could not be synchronized (${code}).`);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

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

function assertPrivateBackupDirectory(directory) {
  const stats = lstatSync(directory);
  if (stats.isSymbolicLink()) {
    throw new Error(`Backup parent must not be a symbolic link: ${directory}`);
  }
  if (!stats.isDirectory()) throw new Error(`Backup parent is not a directory: ${directory}`);
  if (
    process.platform !== "win32"
    && (stats.uid !== process.getuid() || (stats.mode & 0o777) !== 0o700)
  ) {
    throw new Error(
      `Backup parent must be owned by the current user and private (mode 0700): ${directory}`,
    );
  }
  return stats;
}

export function ensurePrivateDirectory(directory) {
  const resolved = path.resolve(directory);
  assertSafeWritableAncestors(resolved);
  const existed = existsSync(resolved);
  if (!existed) {
    mkdirSync(resolved, { recursive: true, mode: 0o700 });
    assertSafeWritableAncestors(resolved);
    if (process.platform !== "win32") chmodSync(resolved, 0o700);
    assertPrivateBackupDirectory(resolved);
    return { created: true, path: resolved };
  }
  assertPrivateBackupDirectory(resolved);
  return { created: false, path: resolved };
}

function stableFileState(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function openRegularFile(file) {
  assertNoSymbolicLinkComponents(file);
  let pathStats;
  try {
    pathStats = lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("Backup file does not exist.");
    throw error;
  }
  if (pathStats.isSymbolicLink()) {
    throw new Error("Backup file must not be a symbolic link.");
  }
  if (!pathStats.isFile()) {
    throw new Error("Backup file must be a regular file.");
  }
  if (pathStats.nlink !== 1) {
    throw new Error("Backup file must not be hard-linked.");
  }

  let descriptor;
  try {
    // The descriptor is opened without following links, then fstat is compared
    // with both path snapshots before any bytes are consumed.
    descriptor = openSync(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "unknown_error";
    throw new Error(`Backup file could not be opened safely (${code}).`);
  }
  const descriptorStats = fstatSync(descriptor);
  assertNoSymbolicLinkComponents(file);
  const afterOpen = lstatSync(file);
  if (
    !descriptorStats.isFile()
    || descriptorStats.nlink !== 1
    || afterOpen.nlink !== 1
    || (
      pathStats.ino !== 0
      && afterOpen.ino !== 0
      && (
        pathStats.dev !== afterOpen.dev
        || pathStats.ino !== afterOpen.ino
      )
    )
    || (
      pathStats.ino !== 0
      && descriptorStats.ino !== 0
      && (
        pathStats.dev !== descriptorStats.dev
        || pathStats.ino !== descriptorStats.ino
      )
    )
  ) {
    closeSync(descriptor);
    throw new Error("Backup file changed while it was being opened.");
  }
  return { descriptor, stats: descriptorStats };
}

function sha256Descriptor(descriptor) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  let bytesRead;
  do {
    bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
    if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
  } while (bytesRead > 0);
  return hash.digest("hex");
}

function assertCanonicalSnapshotHeader(file) {
  const { descriptor, stats: beforeRead } = openRegularFile(file);
  try {
    const header = Buffer.alloc(20);
    const bytesRead = readSync(descriptor, header, 0, header.length, 0);
    const afterRead = fstatSync(descriptor);
    if (!stableFileState(beforeRead, afterRead)) {
      throw new Error("Backup file changed while its SQLite header was being read.");
    }
    if (
      bytesRead !== header.length
      || header.subarray(0, 16).toString("binary") !== "SQLite format 3\0"
    ) {
      throw new Error("Backup does not contain a valid SQLite 3 header.");
    }
    if (header[18] !== 1 || header[19] !== 1) {
      throw new Error(
        "Backup must be a self-contained rollback-journal snapshot, not a WAL-mode main file.",
      );
    }
  } finally {
    closeSync(descriptor);
  }
}

export function sha256File(file) {
  const { descriptor, stats: beforeRead } = openRegularFile(file);
  try {
    const digest = sha256Descriptor(descriptor);
    const afterRead = fstatSync(descriptor);
    if (!stableFileState(beforeRead, afterRead)) {
      throw new Error("Backup file changed while it was being read.");
    }
    return digest;
  } finally {
    closeSync(descriptor);
  }
}

export function manifestPath(file) {
  return `${file}.manifest.json`;
}

function assertSelfContainedBackup(file) {
  for (const suffix of SQLITE_COMPANION_SUFFIXES) {
    const companion = `${file}${suffix}`;
    try {
      lstatSync(companion);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    throw new Error(
      `Backup must be self-contained; unexpected SQLite companion exists: ${path.basename(companion)}.`,
    );
  }
}

export function inspectDatabaseConnection(
  db,
  { requireSessionFree = false, fullIntegrity = true } = {},
) {
  disableTrustedSchemaExecution(db);
  const integrityPragma = fullIntegrity ? "integrity_check" : "quick_check";
  const integrity = db.pragma(integrityPragma, { simple: true });
  if (integrity !== "ok") {
    throw new Error(`SQLite ${integrityPragma} failed.`);
  }
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
  const expected = expectedMigrations();
  assertDatabaseSchema(db, { migrationCount: expected.length });
  const appliedMigrations = db.prepare(`
    SELECT version, name, checksum
    FROM schema_migrations
    ORDER BY version
  `).all();
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
}

export function inspectDatabase(file, options = {}) {
  const db = openExistingDatabase(file, { readonly: true });
  try {
    return inspectDatabaseConnection(db, options);
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

export function verifyDatabaseAgainstManifest(
  file,
  manifest,
  maximumBytes = MAX_BACKUP_BYTES,
) {
  const stats = assertBackupFileSize(file, maximumBytes);
  assertSelfContainedBackup(file);
  if (stats.size !== manifest.bytes) throw new Error("Backup size does not match its manifest.");
  const digest = sha256File(file);
  if (digest !== manifest.sha256) throw new Error("Backup checksum does not match its manifest.");
  assertCanonicalSnapshotHeader(file);
  const inspected = inspectDatabase(file, { requireSessionFree: true });
  assertSelfContainedBackup(file);
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

export function readAndVerifyManifest(file, maximumBytes = MAX_BACKUP_BYTES) {
  const sidecar = manifestPath(file);
  assertNoSymbolicLinkComponents(file);
  assertNoSymbolicLinkComponents(sidecar);
  if (!existsSync(file)) {
    throw new Error("The backup and its manifest must both exist.");
  }
  assertBackupFileSize(file, maximumBytes);
  assertSelfContainedBackup(file);
  let descriptor;
  try {
    descriptor = openSync(
      sidecar,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("The backup and its manifest must both exist.");
    }
    const code = typeof error?.code === "string" ? error.code : "unknown_error";
    throw new Error(`Backup manifest could not be opened safely (${code}).`);
  }
  let manifestText;
  try {
    const beforeRead = fstatSync(descriptor);
    if (!beforeRead.isFile()) {
      throw new Error("Backup manifest must be a regular file.");
    }
    if (beforeRead.nlink !== 1) {
      throw new Error("Backup manifest must not be hard-linked.");
    }
    if (beforeRead.size <= 0 || beforeRead.size > MAX_MANIFEST_BYTES) {
      throw new Error("Backup manifest size is outside the supported range.");
    }
    let manifestBytes;
    try {
      manifestBytes = readFileSync(descriptor);
    } catch {
      throw new Error("Backup manifest could not be read.");
    }
    const afterRead = fstatSync(descriptor);
    assertNoSymbolicLinkComponents(sidecar);
    if (
      beforeRead.dev !== afterRead.dev
      || beforeRead.ino !== afterRead.ino
      || afterRead.nlink !== 1
      || beforeRead.size !== afterRead.size
      || beforeRead.mtimeMs !== afterRead.mtimeMs
      || beforeRead.ctimeMs !== afterRead.ctimeMs
      || manifestBytes.length !== beforeRead.size
    ) {
      throw new Error("Backup manifest changed while it was being read.");
    }
    manifestText = manifestBytes.toString("utf8");
  } finally {
    closeSync(descriptor);
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new Error("Backup manifest is not valid JSON.");
  }
  assertManifest(manifest);
  const inspected = verifyDatabaseAgainstManifest(file, manifest, maximumBytes);
  return { manifest, inspected };
}

export function captureFileIdentity(file) {
  assertNoSymbolicLinkComponents(file);
  const stats = lstatSync(file);
  if (!stats.isFile()) throw new Error(`Backup path is not a regular file: ${file}`);
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
  fsyncDirectory(path.dirname(file), { strict: false });
  return true;
}

function removeTemporaryFile(file) {
  if (!existsSync(file)) return;
  unlinkSync(file);
  fsyncDirectory(path.dirname(file), { strict: false });
}

export function publishHardLink(
  source,
  destination,
  { syncDirectory = fsyncDirectory } = {},
) {
  assertNoSymbolicLinkComponents(source);
  assertNoSymbolicLinkComponents(destination);
  const identity = captureFileIdentity(source);
  let published = false;
  try {
    linkSync(source, destination);
    published = true;
    syncDirectory(path.dirname(destination));
    return identity;
  } catch (error) {
    if (published) {
      try {
        removeFileIfOwned(destination, identity);
      } catch {
        // Preserve the publication failure; cleanup is best-effort.
      }
    }
    throw error;
  }
}

export function atomicCopy(
  source,
  destination,
  maximumBytes = MAX_BACKUP_BYTES,
  expectedSha256 = undefined,
  { cleanupTemporary = removeTemporaryFile } = {},
) {
  const temporary = `${destination}.restore-${process.pid}-${randomUUID()}.tmp`;
  let sourceDescriptor = null;
  let descriptor = null;
  let destinationIdentity = null;
  let copyFailure = null;
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  const sourceHash = createHash("sha256");
  let copied = 0;
  try {
    const openedSource = openRegularFile(source);
    sourceDescriptor = openedSource.descriptor;
    const sourceStats = openedSource.stats;
    if (
      !Number.isSafeInteger(maximumBytes)
      || maximumBytes <= 0
      || sourceStats.size <= 0
      || sourceStats.size > maximumBytes
    ) {
      throw new Error("Backup size is outside the supported range.");
    }
    descriptor = openSync(temporary, "wx", 0o600);
    let bytesRead;
    do {
      bytesRead = readSync(sourceDescriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        copied += bytesRead;
        if (copied > maximumBytes) {
          throw new Error("Backup size is outside the supported range.");
        }
        sourceHash.update(buffer.subarray(0, bytesRead));
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
    if (copied <= 0 || copied !== sourceStats.size) {
      throw new Error("Backup changed while it was being copied.");
    }
    const afterCopy = fstatSync(sourceDescriptor);
    if (!stableFileState(sourceStats, afterCopy)) {
      throw new Error("Backup changed while it was being copied.");
    }
    const sourceDigest = sourceHash.digest("hex");
    if (expectedSha256 !== undefined && sourceDigest !== expectedSha256) {
      throw new Error("Backup checksum does not match its manifest.");
    }
    fsyncSync(descriptor);
    closeSync(sourceDescriptor);
    sourceDescriptor = null;
    closeSync(descriptor);
    descriptor = null;
    if (sourceDigest !== sha256File(temporary)) {
      throw new Error("Temporary restore copy failed checksum verification.");
    }
    destinationIdentity = publishHardLink(temporary, destination);
  } catch (error) {
    copyFailure = error;
  } finally {
    if (sourceDescriptor !== null) closeSync(sourceDescriptor);
    if (descriptor !== null) closeSync(descriptor);
  }

  let cleanupFailure = null;
  if (existsSync(temporary)) {
    try {
      cleanupTemporary(temporary);
    } catch (error) {
      cleanupFailure = error;
    }
  }
  if (cleanupFailure) {
    if (destinationIdentity) {
      try {
        removeFileIfOwned(destination, destinationIdentity);
      } catch {
        // Preserve the cleanup failure; destination rollback is best-effort.
      }
    }
    if (copyFailure) {
      throw new AggregateError(
        [copyFailure, cleanupFailure],
        "Restore copy failed and its temporary file could not be removed.",
      );
    }
    throw cleanupFailure;
  }
  if (copyFailure) throw copyFailure;
  return destinationIdentity;
}

export function assertBackupFileSize(file, maximumBytes = MAX_BACKUP_BYTES) {
  assertNoSymbolicLinkComponents(file);
  const stats = lstatSync(file);
  if (stats.isSymbolicLink()) {
    throw new Error("Backup file must not be a symbolic link.");
  }
  if (!stats.isFile()) {
    throw new Error("Backup file must be a regular file.");
  }
  if (stats.nlink !== 1) {
    throw new Error("Backup file must not be hard-linked.");
  }
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

export function writeManifestAtomic(
  file,
  manifest,
  { cleanupTemporary = removeTemporaryFile } = {},
) {
  const destination = manifestPath(file);
  const temporary = `${destination}.${process.pid}-${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  let destinationIdentity = null;
  let writeFailure = null;
  try {
    writeSync(descriptor, `${JSON.stringify(manifest, null, 2)}\n`, null, "utf8");
    fsyncSync(descriptor);
  } catch (error) {
    writeFailure = error;
  } finally {
    closeSync(descriptor);
  }

  if (!writeFailure) {
    try {
      destinationIdentity = publishHardLink(temporary, destination);
    } catch (error) {
      writeFailure = error;
    }
  }
  let cleanupFailure = null;
  if (existsSync(temporary)) {
    try {
      cleanupTemporary(temporary);
    } catch (error) {
      cleanupFailure = error;
    }
  }
  if (cleanupFailure) {
    if (destinationIdentity) {
      try {
        removeFileIfOwned(destination, destinationIdentity);
      } catch {
        // Preserve the cleanup failure; destination rollback is best-effort.
      }
    }
    if (writeFailure) {
      throw new AggregateError(
        [writeFailure, cleanupFailure],
        "Backup manifest creation failed and its temporary file could not be removed.",
      );
    }
    throw cleanupFailure;
  }
  if (writeFailure) throw writeFailure;
  return destinationIdentity;
}

export function resolveSafeOutput(value) {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error("Backup path is invalid.");
  }
  const segments = value.replaceAll("\\", "/").split("/");
  if (segments.includes("..")) {
    throw new Error("Refusing to use a backup path containing parent traversal.");
  }
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) throw new Error("Refusing to use a filesystem root.");
  if (process.platform === "win32") {
    const normalized = resolved.replaceAll("/", "\\");
    if (/^\\\\[.?]\\/.test(normalized)) {
      throw new Error("Windows backup paths must not use a device namespace.");
    }
    const relative = normalized.slice(path.parse(normalized).root.length);
    if (relative.includes(":")) {
      throw new Error("Windows backup paths must not use an alternate data stream.");
    }
    for (const segment of relative.split("\\").filter(Boolean)) {
      const withoutTrailingAliases = segment.replace(/[ .]+$/u, "");
      const stem = withoutTrailingAliases.split(".", 1)[0].trimEnd().toLowerCase();
      if (
        withoutTrailingAliases !== segment
        || WINDOWS_RESERVED_DEVICE_NAMES.has(stem)
        || /^(?:com|lpt)[1-9¹²³]$/u.test(stem)
      ) {
        throw new Error("Windows backup paths must not use a reserved device name or alias.");
      }
    }
  }
  assertNoSymbolicLinkComponents(resolved);
  return resolved;
}
