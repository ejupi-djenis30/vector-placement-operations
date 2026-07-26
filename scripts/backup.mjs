import {
  chmodSync,
  existsSync,
  linkSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import { loadConfig } from "../server/config.mjs";
import { openDatabase } from "../server/db.mjs";
import { parseArgs, requireString } from "./cli-args.mjs";
import {
  APP_VERSION,
  assertBackupFileSize,
  backupByteLimit,
  captureFileIdentity,
  ensurePrivateDirectory,
  inspectDatabase,
  removeFileIfOwned,
  resolveSafeOutput,
  sha256File,
  writeManifestAtomic,
} from "./backup-lib.mjs";

if (process.platform !== "win32") process.umask(0o077);

const args = parseArgs(process.argv.slice(2), { strings: ["output"] });
const output = resolveSafeOutput(requireString(args, "output"));
if (existsSync(output) || existsSync(`${output}.manifest.json`)) {
  throw new Error("Backup output already exists.");
}
ensurePrivateDirectory(path.dirname(output));
const temporary = `${output}.backup-${process.pid}-${randomUUID()}.tmp`;
const maximumBytes = backupByteLimit(process.env.VECTOR_BACKUP_MAX_BYTES);

const config = loadConfig();
inspectDatabase(config.databasePath);
assertBackupFileSize(config.databasePath, maximumBytes);
const db = new Database(config.databasePath, { readonly: true, fileMustExist: true });
try {
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
  if (existsSync(temporary)) rmSync(temporary);
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
  outputIdentity = captureFileIdentity(temporary);
  linkSync(temporary, output);
  unlinkSync(temporary);
  manifestIdentity = writeManifestAtomic(output, manifest);
} catch (error) {
  if (existsSync(temporary)) rmSync(temporary);
  removeFileIfOwned(output, outputIdentity);
  removeFileIfOwned(`${output}.manifest.json`, manifestIdentity);
  throw error;
}
console.log(JSON.stringify({ status: "created", file: output, manifest }, null, 2));
