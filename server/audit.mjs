import { randomUUID } from "node:crypto";

const ALLOWED_KEYS = new Set([
  "status",
  "previousStatus",
  "count",
  "resource",
  "rowCount",
  "imported",
  "rejected",
  "role",
  "scope",
  "dryRun",
  "version",
  "reasonCode",
  "changedFields",
  "beforeDate",
  "deletedPlacements",
  "deletedStudents",
  "candidates",
  "hasMore",
  "held",
  "cleanupPending",
  "fingerprint",
  "previousFingerprint",
  "oldId",
  "newId",
]);

function safeValue(value) {
  if (typeof value === "string") return value.slice(0, 120);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    return value
      .filter((item) => typeof item === "string")
      .slice(0, 30)
      .map((item) => item.slice(0, 80));
  }
  return undefined;
}

function sanitize(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => ALLOWED_KEYS.has(key))
      .map(([key, item]) => [key, safeValue(item)])
      .filter(([, item]) => item !== undefined),
  );
}

export function writeAudit(db, {
  schoolId,
  actorUserId = null,
  action,
  entityType,
  entityId = null,
  metadata = {},
  requestId = null,
  now = new Date().toISOString(),
}) {
  db.prepare(`
    INSERT INTO audit_events (
      id, school_id, actor_user_id, action, entity_type, entity_id, metadata_json, request_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    schoolId,
    actorUserId,
    action,
    entityType,
    entityId,
    JSON.stringify(sanitize(metadata)),
    requestId,
    now,
  );
}

export function parseAuditMetadata(raw) {
  try {
    return sanitize(JSON.parse(raw));
  } catch {
    return {};
  }
}
