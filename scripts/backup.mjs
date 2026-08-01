import {
  chmodSync,
  existsSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { loadConfig } from "../server/config.mjs";
import { openDatabase, openExistingDatabase } from "../server/db.mjs";
import { parseArgs, requireString } from "./cli-args.mjs";
import {
  APP_VERSION,
  assertBackupFileSize,
  backupByteLimit,
  ensurePrivateDirectory,
  fsyncDirectory,
  inspectDatabase,
  inspectDatabaseConnection,
  publishHardLink,
  removeFileIfOwned,
  resolveSafeOutput,
  sha256File,
  writeManifestAtomic,
} from "./backup-lib.mjs";

if (process.platform !== "win32") process.umask(0o077);

const args = parseArgs(process.argv.slice(2), { strings: ["output"] });
const output = resolveSafeOutput(requireString(args, "output"));
const config = loadConfig();
const comparablePath = (value) => {
  const resolved = path.resolve(value);
  return ["darwin", "win32"].includes(process.platform)
    ? resolved.toLowerCase()
    : resolved;
};
const liveDatabase = path.resolve(config.databasePath);
const reservedLiveState = new Set([
  liveDatabase,
  `${liveDatabase}-wal`,
  `${liveDatabase}-shm`,
  `${liveDatabase}-journal`,
].map(comparablePath));
if ([output, `${output}.manifest.json`].some(
  (candidate) => reservedLiveState.has(comparablePath(candidate)),
)) {
  throw new Error("Backup output must not overlap the live SQLite database or its companions.");
}
if (existsSync(output) || existsSync(`${output}.manifest.json`)) {
  throw new Error("Backup output already exists.");
}
ensurePrivateDirectory(path.dirname(output));
const temporary = `${output}.backup-${process.pid}-${randomUUID()}.tmp`;
const maximumBytes = backupByteLimit(process.env.VECTOR_BACKUP_MAX_BYTES);

function removeTemporary(file) {
  if (!existsSync(file)) return;
  rmSync(file);
  fsyncDirectory(path.dirname(file), { strict: false });
}

// Keep inspection and SQLite backup bound to the same safely opened inode. The
// immutable snapshot still receives the full index-aware integrity check.
const db = openExistingDatabase(config.databasePath, { readonly: true });
try {
  inspectDatabaseConnection(db, { fullIntegrity: false });
  assertBackupFileSize(config.databasePath, maximumBytes);
  const pageSize = db.pragma("page_size", { simple: true });
  await db.backup(temporary, {
    progress({ totalPages }) {
      if (totalPages * pageSize > maximumBytes) {
        throw new Error("Backup exceeds the configured limit during the SQLite snapshot.");
      }
      return 200;
    },
  });
  if (process.platform !== "win32") chmodSync(temporary, 0o600);
  assertBackupFileSize(temporary, maximumBytes);
} catch (error) {
  removeTemporary(temporary);
  throw error;
} finally {
  db.close();
}

let manifest;
let outputIdentity = null;
let manifestIdentity = null;
try {
  const backup = openDatabase(temporary);
  try {
    backup.pragma("secure_delete = ON");
    backup.transaction(() => {
      backup.prepare("DELETE FROM sessions").run();
    })();
    backup.pragma("wal_checkpoint(TRUNCATE)");
    backup.pragma("journal_mode = DELETE");
    backup.exec("VACUUM");
  } finally {
    backup.close();
  }

  const inspected = inspectDatabase(temporary, { requireSessionFree: true });
  const stats = assertBackupFileSize(temporary, maximumBytes);
  manifest = {
    formatVersion: 1,
    product: "VECTOR",
    appVersion: APP_VERSION,
    createdAt: new Date().toISOString(),
    bytes: stats.size,
    sha256: sha256File(temporary),
    migrationVersion: inspected.migrationVersion,
    counts: inspected.counts,
  };
  outputIdentity = publishHardLink(temporary, output);
  unlinkSync(temporary);
  fsyncDirectory(path.dirname(temporary), { strict: false });
  manifestIdentity = writeManifestAtomic(output, manifest);
} catch (error) {
  removeTemporary(temporary);
  removeFileIfOwned(output, outputIdentity);
  removeFileIfOwned(`${output}.manifest.json`, manifestIdentity);
  throw error;
}
console.log(JSON.stringify({ status: "created", file: output, manifest }, null, 2));
