import { existsSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../server/config.mjs";
import { parseArgs, requireString } from "./cli-args.mjs";
import {
  atomicCopy,
  backupByteLimit,
  ensurePrivateDirectory,
  readAndVerifyManifest,
  removeFileIfOwned,
  resolveSafeOutput,
  verifyDatabaseAgainstManifest,
} from "./backup-lib.mjs";

if (process.platform !== "win32") process.umask(0o077);

const args = parseArgs(process.argv.slice(2), {
  strings: ["file"],
  booleans: ["confirm-empty"],
});
if (args["confirm-empty"] !== true) {
  throw new Error("--confirm-empty is required. Restore never overwrites an existing database.");
}
const file = resolveSafeOutput(requireString(args, "file"));
const config = loadConfig();
const destination = resolveSafeOutput(config.databasePath);
for (const candidate of [
  destination,
  `${destination}-wal`,
  `${destination}-shm`,
  `${destination}-journal`,
]) {
  if (existsSync(candidate)) {
    throw new Error(`Restore target state already exists: ${candidate}`);
  }
}
const maximumBytes = backupByteLimit(process.env.VECTOR_BACKUP_MAX_BYTES);
const { manifest } = readAndVerifyManifest(file, maximumBytes);
ensurePrivateDirectory(path.dirname(destination));
let verified;
let destinationIdentity = null;
try {
  destinationIdentity = atomicCopy(
    file,
    destination,
    maximumBytes,
    manifest.sha256,
  );
  verified = verifyDatabaseAgainstManifest(destination, manifest, maximumBytes);
} catch (error) {
  removeFileIfOwned(destination, destinationIdentity);
  throw error;
}
console.log(JSON.stringify({
  status: "restored",
  destination,
  migrationVersion: verified.migrationVersion,
  counts: verified.counts,
}, null, 2));
