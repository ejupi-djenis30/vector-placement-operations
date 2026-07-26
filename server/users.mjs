import { randomUUID } from "node:crypto";
import { writeAudit } from "./audit.mjs";
import { AppError, conflict, notFound } from "./errors.mjs";
import { hashPassword, verifyPassword } from "./password.mjs";
import { hasPermission, requirePermission } from "./rbac.mjs";

function assertRoleScope(role, dataScope) {
  const valid = (
    (["school_admin", "coordinator"].includes(role) && dataScope === "school")
    || (role === "tutor" && dataScope === "assigned")
    || (role === "viewer" && dataScope === "school")
  );
  if (!valid) {
    throw new AppError(422, "invalid_role_scope", "The selected role and data scope are incompatible.");
  }
}

function requireCurrentUserManager(db, actor) {
  const current = db.prepare(`
    SELECT id, school_id AS schoolId, role, data_scope AS dataScope, active
    FROM users
    WHERE id = ? AND school_id = ?
  `).get(actor.id, actor.schoolId);
  if (!current || current.active !== 1 || !hasPermission(current, "manage_users")) {
    throw new AppError(
      403,
      "forbidden",
      "Your account no longer has permission to manage users.",
    );
  }
  return current;
}

export function listUsers(db, actor) {
  requirePermission(actor, "manage_users");
  return db.prepare(`
    SELECT
      id,
      email,
      display_name AS displayName,
      role,
      data_scope AS dataScope,
      active,
      must_change_password AS mustChangePassword,
      revision,
      last_login_at AS lastLoginAt,
      created_at AS createdAt
    FROM users
    WHERE school_id = ?
    ORDER BY active DESC, display_name
  `).all(actor.schoolId).map((row) => ({
    ...row,
    active: row.active === 1,
    mustChangePassword: row.mustChangePassword === 1,
  }));
}

export async function createUser(db, actor, input, requestId, services = {}) {
  requirePermission(actor, "manage_users");
  assertRoleScope(input.role, input.dataScope);
  const passwordHash = await (services.hashPassword ?? hashPassword)(input.password);
  const id = randomUUID();
  const now = new Date().toISOString();
  db.transaction(() => {
    requireCurrentUserManager(db, actor);
    db.prepare(`
      INSERT INTO users (
        id, school_id, email, display_name, password_hash, role, data_scope,
        active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      id,
      actor.schoolId,
      input.email.trim().toLowerCase(),
      input.displayName.trim(),
      passwordHash,
      input.role,
      input.dataScope,
      now,
      now,
    );
    writeAudit(db, {
      schoolId: actor.schoolId,
      actorUserId: actor.id,
      action: "user.created",
      entityType: "user",
      entityId: id,
      metadata: { role: input.role, scope: input.dataScope },
      requestId,
    });
  }).immediate();
  return id;
}

export function updateUser(db, actor, userId, input, requestId) {
  requirePermission(actor, "manage_users");
  const current = db.prepare(`
    SELECT id, display_name AS displayName, role, data_scope AS dataScope, active, revision
    FROM users
    WHERE id = ? AND school_id = ?
  `).get(userId, actor.schoolId);
  if (!current) throw notFound("User");
  if (current.revision !== input.revision) {
    throw conflict("The user changed after it was loaded. Refresh and try again.");
  }

  const role = input.role ?? current.role;
  const dataScope = input.dataScope ?? current.dataScope;
  const active = input.active ?? current.active === 1;
  assertRoleScope(role, dataScope);
  if (userId === actor.id && !active) {
    throw new AppError(422, "cannot_deactivate_self", "You cannot deactivate your own account.");
  }
  if (current.role === "school_admin" && (role !== "school_admin" || !active)) {
    const activeAdmins = db.prepare(`
      SELECT COUNT(*) AS count
      FROM users
      WHERE school_id = ? AND role = 'school_admin' AND active = 1
    `).get(actor.schoolId).count;
    if (activeAdmins <= 1) {
      throw new AppError(422, "last_administrator", "The installation must keep an active administrator.");
    }
  }

  const displayName = input.displayName?.trim() ?? current.displayName;
  const now = new Date().toISOString();
  db.transaction(() => {
    requireCurrentUserManager(db, actor);
    if (current.role === "school_admin" && (role !== "school_admin" || !active)) {
      const activeAdmins = db.prepare(`
        SELECT COUNT(*) AS count
        FROM users
        WHERE school_id = ? AND role = 'school_admin' AND active = 1
      `).get(actor.schoolId).count;
      if (activeAdmins <= 1) {
        throw new AppError(
          422,
          "last_administrator",
          "The installation must keep an active administrator.",
        );
      }
    }
    const result = db.prepare(`
      UPDATE users
      SET
        display_name = ?,
        role = ?,
        data_scope = ?,
        active = ?,
        revision = revision + 1,
        updated_at = ?
      WHERE id = ? AND school_id = ? AND revision = ?
    `).run(
      displayName,
      role,
      dataScope,
      active ? 1 : 0,
      now,
      userId,
      actor.schoolId,
      input.revision,
    );
    if (result.changes !== 1) {
      throw conflict("The user changed while it was being saved.");
    }
    if (!active) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    writeAudit(db, {
      schoolId: actor.schoolId,
      actorUserId: actor.id,
      action: "user.updated",
      entityType: "user",
      entityId: userId,
      metadata: {
        role,
        scope: dataScope,
        status: active ? "active" : "inactive",
        changedFields: ["displayName", "role", "dataScope", "active"]
          .filter((field) => input[field] !== undefined),
      },
      requestId,
    });
  }).immediate();
  return input.revision + 1;
}

export async function resetUserPassword(
  db,
  actor,
  userId,
  input,
  requestId,
  services = {},
) {
  requirePermission(actor, "manage_users");
  const target = db.prepare(
    "SELECT id, revision FROM users WHERE id = ? AND school_id = ?",
  ).get(userId, actor.schoolId);
  if (!target) throw notFound("User");
  if (target.revision !== input.revision) {
    throw conflict("The user changed after it was loaded. Refresh and try again.");
  }
  const passwordHash = await (services.hashPassword ?? hashPassword)(input.password);
  db.transaction(() => {
    requireCurrentUserManager(db, actor);
    const result = db.prepare(`
      UPDATE users
      SET
        password_hash = ?,
        must_change_password = 1,
        revision = revision + 1,
        updated_at = ?
      WHERE id = ? AND school_id = ? AND revision = ?
    `).run(
      passwordHash,
      new Date().toISOString(),
      userId,
      actor.schoolId,
      input.revision,
    );
    if (result.changes !== 1) {
      throw conflict("The user changed while the password was being reset.");
    }
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    writeAudit(db, {
      schoolId: actor.schoolId,
      actorUserId: actor.id,
      action: "user.password_reset",
      entityType: "user",
      entityId: userId,
      metadata: {},
      requestId,
    });
  }).immediate();
  return input.revision + 1;
}

export async function changeOwnPassword(
  db,
  actor,
  currentPassword,
  newPassword,
  requestId,
  services = {},
) {
  const current = db.prepare(`
    SELECT id, password_hash AS passwordHash, revision
    FROM users
    WHERE id = ? AND school_id = ? AND active = 1
  `).get(actor.id, actor.schoolId);
  if (!current) throw notFound("User");
  const verify = services.verifyPassword ?? verifyPassword;
  if (!await verify(currentPassword, current.passwordHash)) {
    throw new AppError(
      422,
      "invalid_current_password",
      "The current password is incorrect.",
    );
  }
  if (await verify(newPassword, current.passwordHash)) {
    throw new AppError(
      422,
      "password_reuse",
      "Choose a password that differs from the current password.",
    );
  }

  const passwordHash = await (services.hashPassword ?? hashPassword)(newPassword);
  const now = new Date().toISOString();
  db.transaction(() => {
    const result = db.prepare(`
      UPDATE users
      SET
        password_hash = ?,
        must_change_password = 0,
        revision = revision + 1,
        updated_at = ?
      WHERE id = ?
        AND school_id = ?
        AND active = 1
        AND revision = ?
        AND password_hash = ?
    `).run(
      passwordHash,
      now,
      actor.id,
      actor.schoolId,
      current.revision,
      current.passwordHash,
    );
    if (result.changes !== 1) {
      throw conflict("Your account changed while the password was being saved. Sign in again.");
    }
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(actor.id);
    writeAudit(db, {
      schoolId: actor.schoolId,
      actorUserId: actor.id,
      action: "user.password_changed",
      entityType: "user",
      entityId: actor.id,
      metadata: {},
      requestId,
    });
  }).immediate();
  return current.revision + 1;
}
