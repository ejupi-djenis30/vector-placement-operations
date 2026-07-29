import { randomUUID } from "node:crypto";
import { writeAudit } from "./audit.mjs";
import { AppError, conflict, notFound } from "./errors.mjs";
import { requirePermission } from "./rbac.mjs";
import { hoursToMinutes, minutesToHours } from "./validation.mjs";

const STATUS_ORDER = new Map([
  ["draft", 0],
  ["ready", 1],
  ["signed", 2],
  ["archived", 3],
]);

const MAX_PROGRAMMES_PER_SCHOOL = 200;
const MAX_VERSIONS_PER_PROGRAMME = 100;

function assertProgrammeCapacity(db, schoolId) {
  const { count } = db.prepare(`
    SELECT COUNT(*) AS count
    FROM programmes
    WHERE school_id = ?
  `).get(schoolId);
  if (count >= MAX_PROGRAMMES_PER_SCHOOL) {
    throw new AppError(
      422,
      "programme_limit_reached",
      `A school can configure at most ${MAX_PROGRAMMES_PER_SCHOOL} programmes.`,
      { maximum: MAX_PROGRAMMES_PER_SCHOOL },
    );
  }
}

function assertProgrammeVersionCapacity(db, programmeId) {
  const { count } = db.prepare(`
    SELECT COUNT(*) AS count
    FROM programme_versions
    WHERE programme_id = ?
  `).get(programmeId);
  if (count >= MAX_VERSIONS_PER_PROGRAMME) {
    throw new AppError(
      422,
      "programme_version_limit_reached",
      `A programme can contain at most ${MAX_VERSIONS_PER_PROGRAMME} published versions.`,
      { maximum: MAX_VERSIONS_PER_PROGRAMME },
    );
  }
}

function acceptedStatuses(value) {
  return [...new Set(value)].sort(
    (left, right) => STATUS_ORDER.get(left) - STATUS_ORDER.get(right),
  );
}

function mapRequirement(row) {
  return {
    id: row.id,
    code: row.code,
    label: row.label,
    acceptedStatuses: JSON.parse(row.acceptedStatusesJson),
    sortOrder: row.sortOrder,
  };
}

function readRequirements(db, programmeVersionId) {
  return db.prepare(`
    SELECT
      id,
      code,
      label,
      accepted_statuses_json AS acceptedStatusesJson,
      sort_order AS sortOrder
    FROM programme_requirements
    WHERE programme_version_id = ?
    ORDER BY sort_order, code
  `).all(programmeVersionId).map(mapRequirement);
}

function mapVersion(db, row) {
  return {
    id: row.id,
    version: row.version,
    defaultTargetHours: minutesToHours(row.defaultTargetMinutes),
    minimumCheckIns: row.minimumCheckIns,
    publishedAt: row.publishedAt,
    requirements: readRequirements(db, row.id),
  };
}

function versionRows(db, programmeId) {
  return db.prepare(`
    SELECT
      id,
      version,
      default_target_minutes AS defaultTargetMinutes,
      minimum_check_ins AS minimumCheckIns,
      published_at AS publishedAt
    FROM programme_versions
    WHERE programme_id = ?
    ORDER BY version DESC
  `).all(programmeId);
}

function currentVersionRow(db, programmeId) {
  return db.prepare(`
    SELECT
      id,
      version,
      default_target_minutes AS defaultTargetMinutes,
      minimum_check_ins AS minimumCheckIns,
      published_at AS publishedAt
    FROM programme_versions
    WHERE programme_id = ?
    ORDER BY version DESC
    LIMIT 1
  `).get(programmeId);
}

function programmeRow(db, schoolId, programmeId) {
  return db.prepare(`
    SELECT
      id,
      code,
      name,
      description,
      active,
      revision
    FROM programmes
    WHERE id = ? AND school_id = ?
  `).get(programmeId, schoolId);
}

function mapProgramme(db, row) {
  const current = currentVersionRow(db, row.id);
  if (!current) {
    throw new Error(`Programme ${row.id} has no published version.`);
  }
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    active: Boolean(row.active),
    revision: row.revision,
    currentVersion: mapVersion(db, current),
  };
}

function insertVersion(db, programmeId, version, input, actorUserId, now) {
  const versionId = randomUUID();
  db.prepare(`
    INSERT INTO programme_versions (
      id,
      programme_id,
      version,
      default_target_minutes,
      minimum_check_ins,
      created_by,
      published_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    versionId,
    programmeId,
    version,
    hoursToMinutes(input.defaultTargetHours),
    input.minimumCheckIns,
    actorUserId,
    now,
  );
  const insertRequirement = db.prepare(`
    INSERT INTO programme_requirements (
      id,
      programme_version_id,
      code,
      label,
      accepted_statuses_json,
      sort_order
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  input.requirements.forEach((requirement, index) => {
    insertRequirement.run(
      randomUUID(),
      versionId,
      requirement.code,
      requirement.label,
      JSON.stringify(acceptedStatuses(requirement.acceptedStatuses)),
      (index + 1) * 10,
    );
  });
  return versionId;
}

function translateConstraint(error, message) {
  if (String(error?.code ?? "").startsWith("SQLITE_CONSTRAINT")) {
    throw conflict(message);
  }
  throw error;
}

export function listProgrammes(db, user) {
  requirePermission(user, "read");
  return {
    items: db.prepare(`
      SELECT id, code, name, description, active, revision
      FROM programmes
      WHERE school_id = ?
      ORDER BY active DESC, name COLLATE NOCASE, id
    `).all(user.schoolId).map((row) => mapProgramme(db, row)),
  };
}

export function listProgrammeVersions(db, user, programmeId) {
  requirePermission(user, "read");
  const programme = programmeRow(db, user.schoolId, programmeId);
  if (!programme) throw notFound("Programme");
  return {
    items: versionRows(db, programmeId).map((row) => mapVersion(db, row)),
  };
}

export function createProgramme(db, user, input, requestId) {
  requirePermission(user, "manage_programmes");
  const programmeId = randomUUID();
  const now = new Date().toISOString();
  let versionId;
  try {
    db.transaction(() => {
      assertProgrammeCapacity(db, user.schoolId);
      db.prepare(`
        INSERT INTO programmes (
          id, school_id, code, name, description, active, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)
      `).run(
        programmeId,
        user.schoolId,
        input.code,
        input.name,
        input.description ?? "",
        now,
        now,
      );
      versionId = insertVersion(db, programmeId, 1, input, user.id, now);
      writeAudit(db, {
        schoolId: user.schoolId,
        actorUserId: user.id,
        action: "programme.created",
        entityType: "programme",
        entityId: programmeId,
        metadata: {
          code: input.code,
          version: 1,
          requirementCount: input.requirements.length,
        },
        requestId,
      });
    })();
  } catch (error) {
    translateConstraint(error, "A programme with this code or name already exists.");
  }
  return { programmeId, versionId };
}

export function updateProgramme(db, user, programmeId, input, requestId) {
  requirePermission(user, "manage_programmes");
  const current = programmeRow(db, user.schoolId, programmeId);
  if (!current) throw notFound("Programme");
  if (current.revision !== input.revision) {
    throw conflict("The programme changed after it was loaded. Refresh and try again.");
  }
  const name = input.name ?? current.name;
  const description = input.description ?? current.description;
  const active = input.active === undefined ? current.active : Number(input.active);
  const now = new Date().toISOString();
  const changedFields = ["name", "description", "active"]
    .filter((field) => input[field] !== undefined);
  try {
    db.transaction(() => {
      const result = db.prepare(`
        UPDATE programmes
        SET
          code = ?,
          name = ?,
          description = ?,
          active = ?,
          revision = revision + 1,
          updated_at = ?
        WHERE id = ? AND school_id = ? AND revision = ?
      `).run(
        current.code,
        name,
        description,
        active,
        now,
        programmeId,
        user.schoolId,
        input.revision,
      );
      if (result.changes !== 1) {
        throw conflict("The programme changed while it was being saved.");
      }
      writeAudit(db, {
        schoolId: user.schoolId,
        actorUserId: user.id,
        action: "programme.updated",
        entityType: "programme",
        entityId: programmeId,
        metadata: { changedFields },
        requestId,
      });
    })();
  } catch (error) {
    if (error instanceof AppError) throw error;
    translateConstraint(error, "A programme with this code or name already exists.");
  }
  return input.revision + 1;
}

export function publishProgrammeVersion(db, user, programmeId, input, requestId) {
  requirePermission(user, "manage_programmes");
  const current = programmeRow(db, user.schoolId, programmeId);
  if (!current) throw notFound("Programme");
  if (current.revision !== input.revision) {
    throw conflict("The programme changed after it was loaded. Refresh and try again.");
  }
  const now = new Date().toISOString();
  let versionId;
  let nextVersion;
  db.transaction(() => {
    assertProgrammeVersionCapacity(db, programmeId);
    nextVersion = db.prepare(`
      SELECT COALESCE(MAX(version), 0) + 1 AS version
      FROM programme_versions
      WHERE programme_id = ?
    `).get(programmeId).version;
    const result = db.prepare(`
      UPDATE programmes
      SET revision = revision + 1, updated_at = ?
      WHERE id = ? AND school_id = ? AND revision = ?
    `).run(now, programmeId, user.schoolId, input.revision);
    if (result.changes !== 1) {
      throw conflict("The programme changed while its new version was being published.");
    }
    versionId = insertVersion(db, programmeId, nextVersion, input, user.id, now);
    writeAudit(db, {
      schoolId: user.schoolId,
      actorUserId: user.id,
      action: "programme.version_published",
      entityType: "programme",
      entityId: programmeId,
      metadata: {
        version: nextVersion,
        requirementCount: input.requirements.length,
      },
      requestId,
    });
  })();
  return {
    id: versionId,
    version: nextVersion,
    revision: input.revision + 1,
  };
}

export function programmeVersionForSchool(
  db,
  schoolId,
  programmeVersionId,
  { activeOnly = true } = {},
) {
  const row = db.prepare(`
    SELECT
      pv.id,
      pv.programme_id AS programmeId,
      pv.version,
      pv.default_target_minutes AS defaultTargetMinutes,
      pv.minimum_check_ins AS minimumCheckIns,
      pv.published_at AS publishedAt,
      p.code AS programmeCode,
      p.name AS programmeName,
      p.active
    FROM programme_versions pv
    JOIN programmes p ON p.id = pv.programme_id
    WHERE pv.id = ? AND p.school_id = ?
  `).get(programmeVersionId, schoolId);
  if (!row || (activeOnly && !row.active)) {
    throw new AppError(
      422,
      "invalid_programme_version",
      "Select an active programme version from this school.",
    );
  }
  return {
    ...row,
    defaultTargetHours: minutesToHours(row.defaultTargetMinutes),
    requirements: readRequirements(db, row.id),
  };
}

export function currentProgrammeVersionByCode(db, schoolId, code) {
  const row = db.prepare(`
    SELECT pv.id
    FROM programmes p
    JOIN programme_versions pv ON pv.programme_id = p.id
    WHERE p.school_id = ? AND p.code = ? COLLATE NOCASE AND p.active = 1
    ORDER BY pv.version DESC
    LIMIT 1
  `).get(schoolId, code);
  if (!row) return null;
  return programmeVersionForSchool(db, schoolId, row.id);
}

export function seedPlacementRequirements(
  db,
  schoolId,
  placementId,
  programmeVersionId,
  now = new Date().toISOString(),
) {
  const requirements = readRequirements(db, programmeVersionId);
  const insert = db.prepare(`
    INSERT INTO placement_documents (
      id,
      school_id,
      placement_id,
      kind,
      title,
      status,
      reference,
      due_date,
      requirement_id,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, 'missing', '', NULL, ?, ?, ?)
  `);
  for (const requirement of requirements) {
    const kind = [
      "training_agreement",
      "attendance_log",
      "evaluation",
      "completion_certificate",
    ].includes(requirement.code)
      ? requirement.code
      : "other";
    insert.run(
      randomUUID(),
      schoolId,
      placementId,
      kind,
      requirement.label,
      requirement.id,
      now,
      now,
    );
  }
}

export function assertPlacementProgrammeMutable(db, schoolId, placementId) {
  const activity = db.prepare(`
    SELECT
      EXISTS(
        SELECT 1
        FROM time_entries
        WHERE placement_id = ? AND school_id = ?
      ) AS hasTimeEntries,
      EXISTS(
        SELECT 1
        FROM check_ins
        WHERE placement_id = ? AND school_id = ?
      ) AS hasCheckIns,
      EXISTS(
        SELECT 1
        FROM placement_documents
        WHERE placement_id = ?
          AND school_id = ?
          AND (
            requirement_id IS NULL
            OR status <> 'missing'
            OR reference <> ''
            OR revision <> 1
            OR superseded_at IS NOT NULL
          )
      ) AS hasEvidence
  `).get(
    placementId,
    schoolId,
    placementId,
    schoolId,
    placementId,
    schoolId,
  );
  if (activity.hasTimeEntries || activity.hasCheckIns || activity.hasEvidence) {
    throw new AppError(
      409,
      "programme_policy_frozen",
      "The programme cannot change after time, check-ins or evidence have been recorded.",
    );
  }
}

export function replacePlacementRequirements(
  db,
  schoolId,
  placementId,
  programmeVersionId,
  now = new Date().toISOString(),
) {
  assertPlacementProgrammeMutable(db, schoolId, placementId);
  db.prepare(`
    DELETE FROM placement_documents
    WHERE placement_id = ?
      AND school_id = ?
      AND requirement_id IS NOT NULL
      AND status = 'missing'
      AND reference = ''
      AND revision = 1
      AND superseded_at IS NULL
  `).run(placementId, schoolId);
  seedPlacementRequirements(db, schoolId, placementId, programmeVersionId, now);
}
