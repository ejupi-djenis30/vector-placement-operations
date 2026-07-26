import Database from "better-sqlite3";
import { loadConfig } from "../server/config.mjs";
import { inspectDatabase } from "./backup-lib.mjs";
import { parseArgs } from "./cli-args.mjs";

const args = parseArgs(process.argv.slice(2), {
  booleans: ["confirm-maintenance"],
});
if (args["confirm-maintenance"] !== true) {
  throw new Error(
    "--confirm-maintenance is required. Stop VECTOR and create an inspected backup first.",
  );
}

const config = loadConfig();
inspectDatabase(config.databasePath);
const db = new Database(config.databasePath, { fileMustExist: true, timeout: 5_000 });
try {
  db.pragma("foreign_keys = ON");
  db.pragma("secure_delete = ON");
  const before = db.pragma("wal_checkpoint(TRUNCATE)")[0];
  if (before.busy !== 0) {
    throw new Error("SQLite is busy. Stop every VECTOR process before compaction.");
  }
  db.exec("VACUUM");
  const after = db.pragma("wal_checkpoint(TRUNCATE)")[0];
  if (after.busy !== 0 || after.log !== after.checkpointed) {
    throw new Error("SQLite could not finish the maintenance checkpoint.");
  }
  console.log(JSON.stringify({
    status: "compacted",
    checkpoint: after,
  }, null, 2));
} finally {
  db.close();
}
