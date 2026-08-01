import { parseArgs, requireString } from "./cli-args.mjs";
import {
  backupByteLimit,
  readAndVerifyManifest,
  resolveSafeOutput,
} from "./backup-lib.mjs";

const args = parseArgs(process.argv.slice(2), { strings: ["file"] });
const file = resolveSafeOutput(requireString(args, "file"));
const maximumBytes = backupByteLimit(process.env.VECTOR_BACKUP_MAX_BYTES);
const result = readAndVerifyManifest(file, maximumBytes);
console.log(JSON.stringify({ status: "valid", file, ...result }, null, 2));
