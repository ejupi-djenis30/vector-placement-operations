import { AppError } from "./errors.mjs";

export const ROLES = Object.freeze(["school_admin", "coordinator", "tutor", "viewer"]);
export const ROLE_DATA_SCOPES = Object.freeze({
  school_admin: "school",
  coordinator: "school",
  tutor: "assigned",
  viewer: "school",
});

const PERMISSIONS = Object.freeze({
  school_admin: new Set([
    "read",
    "write",
    "manage_users",
    "manage_branding",
    "manage_programmes",
    "import",
    "export",
    "audit",
    "erase",
  ]),
  coordinator: new Set([
    "read",
    "write",
    "manage_programmes",
    "import",
    "export",
    "audit",
  ]),
  tutor: new Set(["read", "write_assigned", "export_assigned"]),
  viewer: new Set(["read"]),
});

export function hasPermission(user, permission) {
  return Boolean(user && PERMISSIONS[user.role]?.has(permission));
}

export function requirePermission(user, permission) {
  if (!hasPermission(user, permission)) {
    throw new AppError(403, "forbidden", "You do not have permission to perform this action.");
  }
}

export function hasValidRoleScope(role, dataScope) {
  return ROLE_DATA_SCOPES[role] === dataScope;
}

export function hasSchoolScope(user) {
  return Boolean(
    user
      && ROLE_DATA_SCOPES[user.role] === "school"
      && user.dataScope === "school",
  );
}

export function canWritePlacement(user, placement) {
  if (hasPermission(user, "write")) return true;
  return hasPermission(user, "write_assigned") && placement.schoolTutorId === user.id;
}
