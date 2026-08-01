import assert from "node:assert/strict";
import test from "node:test";
import {
  auditQueryParams,
  isFrozenPlacement,
  parseProgrammeRequirements,
  placementTransitions,
  programmeRequirementsText,
  statusClass,
  toDateTimeLocal,
  workspaceAccess,
} from "../site/app/workspace-domain.mjs";

test("workspace access capabilities fail closed and preserve the role matrix", () => {
  const capabilities = (role, dataScope) => workspaceAccess({ role, dataScope });

  assert.deepEqual(workspaceAccess(null), {
    canWrite: false,
    canViewCoverage: false,
    canManagePeople: false,
    canManagePlacement: false,
    canManageProgrammes: false,
    canReviewEvidence: false,
    isSchoolAdmin: false,
    canAudit: false,
    canManageBranding: false,
    canExport: false,
  });
  assert.deepEqual(capabilities("school_admin", "school"), {
    canWrite: true,
    canViewCoverage: true,
    canManagePeople: true,
    canManagePlacement: true,
    canManageProgrammes: true,
    canReviewEvidence: true,
    isSchoolAdmin: true,
    canAudit: true,
    canManageBranding: true,
    canExport: true,
  });
  assert.equal(capabilities("coordinator", "school").canManageProgrammes, true);
  assert.equal(capabilities("coordinator", "school").canManageBranding, false);
  assert.equal(capabilities("tutor", "assigned").canWrite, true);
  assert.equal(capabilities("tutor", "assigned").canViewCoverage, false);
  assert.equal(capabilities("viewer", "school").canViewCoverage, true);
  assert.equal(capabilities("viewer", "assigned").canViewCoverage, false);
  assert.deepEqual(workspaceAccess({ role: "future_role", dataScope: "school" }), {
    ...workspaceAccess(null),
  });
});

test("placement presentation rules remain deterministic and immutable", () => {
  assert.deepEqual(placementTransitions("planned"), ["active", "cancelled"]);
  assert.deepEqual(placementTransitions("review"), ["active", "complete", "cancelled"]);
  assert.deepEqual(placementTransitions("unknown"), []);
  assert.equal(Object.isFrozen(placementTransitions("planned")), true);
  assert.equal(isFrozenPlacement({ status: "complete" }), true);
  assert.equal(isFrozenPlacement({ status: "cancelled" }), true);
  assert.equal(isFrozenPlacement({ status: "active" }), false);
  assert.equal(statusClass("DUE_SOON"), "status-pill status-due-soon");
});

test("audit query construction trims filters and omits pagination from exports", () => {
  const filters = {
    action: "  placement.updated  ",
    actorId: "actor-1",
    fromDate: "2026-07-01",
    toDate: "2026-07-31",
  };
  assert.equal(
    auditQueryParams({ limit: 25, cursor: "opaque", filters }),
    "limit=25&cursor=opaque&action=placement.updated&actorId=actor-1&fromDate=2026-07-01&toDate=2026-07-31",
  );
  assert.equal(
    auditQueryParams({ limit: 25, cursor: "opaque", exportOnly: true, filters }),
    "action=placement.updated&actorId=actor-1&fromDate=2026-07-01&toDate=2026-07-31",
  );
  assert.equal(auditQueryParams(), "limit=50");
  assert.equal(filters.action, "  placement.updated  ");
});

test("programme requirement text round-trips and malformed policy lines fail closed", () => {
  const requirements = [
    {
      code: "training_agreement",
      label: "Signed training agreement",
      acceptedStatuses: ["signed", "archived"],
    },
    {
      code: "evaluation",
      label: "Completed evaluation",
      acceptedStatuses: ["ready", "signed"],
    },
  ];
  const text = programmeRequirementsText(requirements);
  assert.equal(
    text,
    "training_agreement | Signed training agreement | signed, archived\n"
      + "evaluation | Completed evaluation | ready, signed",
  );
  assert.deepEqual(parseProgrammeRequirements(text), requirements);

  for (const malformed of [
    "A | Invalid code | signed",
    "valid_code | | signed",
    "valid_code | Label | missing",
    "valid_code | Label | signed, signed",
    "valid_code | Label | signed | ignored",
    "valid_code | Label | signed\nvalid_code | Duplicate | archived",
  ]) {
    assert.throws(
      () => parseProgrammeRequirements(malformed),
      /Requirement line \d+ must be/,
      malformed,
    );
  }
});

test("date-time controls receive the same local wall-clock representation", () => {
  assert.equal(toDateTimeLocal(""), "");
  assert.equal(toDateTimeLocal("not-a-timestamp"), "");
  const value = "2026-07-31T10:45:00.000Z";
  const date = new Date(value);
  const expected = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
  assert.equal(toDateTimeLocal(value), expected);
});
