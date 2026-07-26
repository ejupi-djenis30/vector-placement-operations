import { loadConfig } from "../server/config.mjs";
import { latestMigrationVersion, migrateDatabase, openDatabase } from "../server/db.mjs";
import { parseArgs } from "./cli-args.mjs";

parseArgs(process.argv.slice(2));
const config = loadConfig();
const db = openDatabase(config.databasePath);
try {
  migrateDatabase(db);
  const applied = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version;
  console.log(JSON.stringify({
    status: "migrated",
    databasePath: config.databasePath,
    version: Number(applied),
    latestVersion: latestMigrationVersion(),
  }));
} finally {
  db.close();
}
