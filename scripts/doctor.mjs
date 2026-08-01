import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { loadConfig } from "../server/config.mjs";
import {
  assertMigrationState,
  databaseReady,
  latestMigrationVersion,
  openExistingDatabase,
} from "../server/db.mjs";
import { parseArgs } from "./cli-args.mjs";

parseArgs(process.argv.slice(2));
const config = loadConfig();
const checks = [];

function check(name, run) {
  try {
    const detail = run();
    checks.push({ name, ok: true, detail });
  } catch (error) {
    checks.push({ name, ok: false, detail: error.message });
  }
}

check("database_exists", () => {
  if (!existsSync(config.databasePath)) throw new Error("Database file does not exist.");
  return config.databasePath;
});

let db;
if (existsSync(config.databasePath)) {
  check("database_open", () => {
    db = openExistingDatabase(config.databasePath, { readonly: true });
    return "ok";
  });
}

check("storage_writable", () => {
  if (!db) throw new Error("Database path did not pass the safe-open check.");
  const directory = path.dirname(path.resolve(config.databasePath));
  const probe = path.join(directory, `.vector-write-probe-${randomUUID()}`);
  let descriptor;
  try {
    descriptor = openSync(probe, "wx", 0o600);
    writeSync(descriptor, randomBytes(32));
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(probe)) unlinkSync(probe);
  }
  return directory;
});

check("storage_permissions", () => {
  const database = path.resolve(config.databasePath);
  const directory = path.dirname(database);
  if (process.platform === "win32") {
    return "Verify the NTFS ACL grants access only to the VECTOR service identity and backup operators.";
  }
  const expectedUid = process.getuid();
  const directoryStats = statSync(directory);
  if ((directoryStats.mode & 0o077) !== 0 || directoryStats.uid !== expectedUid) {
    throw new Error("The database directory must be owned by the service user with mode 0700.");
  }
  for (const file of [database, `${database}-wal`, `${database}-shm`, `${database}-journal`]) {
    if (!existsSync(file)) continue;
    const stats = statSync(file);
    if ((stats.mode & 0o077) !== 0 || stats.uid !== expectedUid) {
      throw new Error(`${file} must be owned by the service user with mode 0600.`);
    }
  }
  return { directoryMode: "0700", databaseMode: "0600", uid: expectedUid };
});

if (db) {
  check("integrity", () => {
    const result = db.pragma("quick_check", { simple: true });
    if (result !== "ok") throw new Error("SQLite quick_check failed.");
    return result;
  });
  check("foreign_keys", () => {
    const violations = db.pragma("foreign_key_check");
    if (violations.length > 0) {
      throw new Error(`SQLite foreign_key_check found ${violations.length} invalid reference(s).`);
    }
    return "ok";
  });
  check("single_school", () => {
    const count = db.prepare("SELECT COUNT(*) AS count FROM schools").get().count;
    if (count !== 1) throw new Error(`Expected exactly one school; found ${count}.`);
    return count;
  });
  check("migrations_current", () => {
    const state = assertMigrationState(db);
    const applied = state.applied === 0
      ? 0
      : Number(db.prepare(
        "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
      ).get().version);
    const latest = latestMigrationVersion();
    if (applied !== latest) throw new Error(`Applied ${applied}; expected ${latest}.`);
    return { applied, latest };
  });
  check("readiness", () => {
    if (!databaseReady(db)) throw new Error("Database readiness checks failed.");
    return "ready";
  });
  db.close();
}

const ok = checks.every((item) => item.ok);
console.log(JSON.stringify({ status: ok ? "ok" : "failed", checks }, null, 2));
if (!ok) process.exitCode = 1;
