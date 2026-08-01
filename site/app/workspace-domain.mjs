const MANAGEMENT_ROLES = new Set(["school_admin", "coordinator"]);
const WRITE_ROLES = new Set(["school_admin", "coordinator", "tutor"]);
const PLACEMENT_TRANSITIONS = Object.freeze({
  planned: Object.freeze(["active", "cancelled"]),
  active: Object.freeze(["review", "cancelled"]),
  review: Object.freeze(["active", "complete", "cancelled"]),
  cancelled: Object.freeze(["planned"]),
  complete: Object.freeze(["review"]),
});
const NO_TRANSITIONS = Object.freeze([]);
const ALLOWED_DOCUMENT_STATUSES = new Set(["draft", "ready", "signed", "archived"]);

export function workspaceAccess(user) {
  const role = user?.role;
  const managesOperations = MANAGEMENT_ROLES.has(role);
  const schoolViewer = role === "viewer" && user?.dataScope === "school";
  return {
    canWrite: WRITE_ROLES.has(role),
    canViewCoverage: managesOperations || schoolViewer,
    canManagePeople: managesOperations,
    canManagePlacement: managesOperations,
    canManageProgrammes: managesOperations,
    canReviewEvidence: managesOperations,
    isSchoolAdmin: role === "school_admin",
    canAudit: managesOperations,
    canManageBranding: role === "school_admin",
    canExport: WRITE_ROLES.has(role),
  };
}

export function isFrozenPlacement(placement) {
  return ["complete", "cancelled"].includes(placement.status);
}

export function placementTransitions(status) {
  return PLACEMENT_TRANSITIONS[status] ?? NO_TRANSITIONS;
}

export function statusClass(status) {
  return `status-pill status-${String(status).toLowerCase().replaceAll("_", "-")}`;
}

export function auditQueryParams({
  limit,
  cursor,
  exportOnly = false,
  filters = {},
} = {}) {
  const params = new URLSearchParams();
  if (!exportOnly) params.set("limit", String(limit ?? 50));
  if (!exportOnly && cursor) params.set("cursor", cursor);
  const { action = "", actorId = "", fromDate = "", toDate = "" } = filters;
  if (action.trim()) params.set("action", action.trim());
  if (actorId) params.set("actorId", actorId);
  if (fromDate) params.set("fromDate", fromDate);
  if (toDate) params.set("toDate", toDate);
  return params.toString();
}

export function toDateTimeLocal(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function programmeRequirementsText(requirements) {
  return requirements
    .map((requirement) => (
      `${requirement.code} | ${requirement.label} | ${requirement.acceptedStatuses.join(", ")}`
    ))
    .join("\n");
}

export function parseProgrammeRequirements(value) {
  const codes = new Set();
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .map((line, index) => {
      const [rawCode, rawLabel, rawStatuses, ...extra] = line.split("|");
      const code = rawCode?.trim() ?? "";
      const label = rawLabel?.trim() ?? "";
      const acceptedStatuses = (rawStatuses ?? "")
        .split(",")
        .map((status) => status.trim().toLowerCase())
        .filter(Boolean);
      if (
        extra.length
        || !/^[a-z][a-z0-9_]{1,39}$/.test(code)
        || !label
        || !acceptedStatuses.length
        || acceptedStatuses.some((status) => !ALLOWED_DOCUMENT_STATUSES.has(status))
        || new Set(acceptedStatuses).size !== acceptedStatuses.length
        || codes.has(code)
      ) {
        throw new Error(
          `Requirement line ${index + 1} must be: code | label | draft, ready, signed or archived.`,
        );
      }
      codes.add(code);
      return { code, label, acceptedStatuses };
    });
}
