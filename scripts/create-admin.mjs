import { randomUUID } from "node:crypto";
import { writeAudit } from "../server/audit.mjs";
import { loadConfig } from "../server/config.mjs";
import { migrateDatabase, openDatabase } from "../server/db.mjs";
import { hashPassword } from "../server/password.mjs";
import { parseInput, UserCreateBody } from "../server/schemas.mjs";
import {
  assertUserCapacity,
  translateUserCapacityConstraint,
} from "../server/user-limits.mjs";
import { parseArgs, requireString } from "./cli-args.mjs";

const args = parseArgs(process.argv.slice(2), {
  strings: ["email", "name", "role", "scope"],
});
const password = process.env.VECTOR_NEW_USER_PASSWORD;
if (!password) throw new Error("VECTOR_NEW_USER_PASSWORD is required.");
const input = parseInput(UserCreateBody, {
  email: requireString(args, "email").toLowerCase(),
  displayName: requireString(args, "name"),
  role: requireString(args, "role"),
  dataScope: requireString(args, "scope"),
  password,
});

const config = loadConfig();
const db = openDatabase(config.databasePath);
try {
  migrateDatabase(db);
  const school = db.prepare("SELECT id FROM schools ORDER BY created_at LIMIT 1").get();
  if (!school) throw new Error("Bootstrap the installation before creating another user.");
  assertUserCapacity(db, school.id);
  const passwordHash = await hashPassword(input.password);
  const id = randomUUID();
  const now = new Date().toISOString();
  try {
    db.transaction(() => {
      assertUserCapacity(db, school.id);
      db.prepare(`
        INSERT INTO users (
          id, school_id, email, display_name, password_hash, role, data_scope,
          active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        id,
        school.id,
        input.email,
        input.displayName,
        passwordHash,
        input.role,
        input.dataScope,
        now,
        now,
      );
      writeAudit(db, {
        schoolId: school.id,
        action: "user.created_cli",
        entityType: "user",
        entityId: id,
        metadata: { role: input.role, scope: input.dataScope },
      });
    }).immediate();
  } catch (error) {
    translateUserCapacityConstraint(error);
  }
  console.log(JSON.stringify({
    status: "created",
    id,
    role: input.role,
    scope: input.dataScope,
  }));
} finally {
  db.close();
}
