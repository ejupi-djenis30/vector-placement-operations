import { createHash, randomUUID } from "node:crypto";
import { writeAudit, parseAuditMetadata } from "./audit.mjs";
import { AppError, conflict, notFound } from "./errors.mjs";
import { canWritePlacement, hasPermission, hasSchoolScope, requirePermission } from "./rbac.mjs";
import {
  assertDateRange,
  assertTargetMinutesFeasible,
  hoursToMinutes,
  isIsoDate,
  minutesToHours,
} from "./validation.mjs";
import {
  assertNotFutureSchoolDate,
  currentSchoolDate,
  schoolDateForInstant,
} from "./school-time.mjs";
import {
  assertPlacementProgrammeMutable,
  currentProgrammeVersionByCode,
  programmeVersionForSchool,
  replacePlacementRequirements,
  seedPlacementRequirements,
} from "./programmes.mjs";

const STATUS_TRANSITIONS = Object.freeze({
  planned: new Set(["active", "cancelled"]),
  active: new Set(["review", "cancelled"]),
  review: new Set(["active", "complete", "cancelled"]),
  complete: new Set(),
  cancelled: new Set(["planned"]),
});
const DOCUMENT_STATUS_TRANSITIONS = Object.freeze({
  missing: new Set(["draft"]),
  draft: new Set(["missing", "ready"]),
  ready: new Set(["draft", "signed"]),
  signed: new Set(["archived"]),
  archived: new Set(),
});
const CHECK_IN_FUTURE_SKEW_MS = 5 * 60 * 1000;
const TERMINAL_PLACEMENT_STATUSES = Object.freeze(["complete", "cancelled"]);

function documentGapsExpression(alias = "p") {
  return `(
    SELECT COUNT(*)
    FROM programme_requirements pr
    WHERE pr.programme_version_id = ${alias}.programme_version_id
      AND NOT EXISTS (
        SELECT 1
        FROM placement_documents pd
        WHERE pd.placement_id = ${alias}.id
          AND pd.requirement_id = pr.id
          AND pd.superseded_at IS NULL
          AND pd.status IN (
            SELECT value FROM json_each(pr.accepted_statuses_json)
          )
      )
  )`;
}

function params(user) {
  return { schoolId: user.schoolId, userId: user.id };
}

function placementScope(user, alias = "p") {
  const school = `${alias}.school_id = @schoolId`;
  return hasSchoolScope(user) ? school : `${school} AND ${alias}.school_tutor_id = @userId`;
}

function relatedScope(user, foreignKeyExpression) {
  if (hasSchoolScope(user)) return "";
  return `AND EXISTS (
    SELECT 1 FROM placements scoped
    WHERE scoped.school_id = @schoolId
      AND scoped.school_tutor_id = @userId
      AND ${foreignKeyExpression}
  )`;
}

function searchPattern(value) {
  const escaped = value.trim()
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
  return `%${escaped}%`;
}

function cursorBinding(user, view, filters) {
  return {
    schoolId: user.schoolId,
    userId: user.id,
    role: user.role,
    dataScope: user.dataScope,
    view,
    filters,
  };
}

function pageRows(
  rows,
  limit,
  kind,
  cursorFor,
  cursorCodec,
  binding,
  mapRow = (row) => row,
) {
  const hasMore = rows.length > limit;
  const selected = rows.slice(0, limit);
  return {
    items: selected.map(mapRow),
    nextCursor: hasMore
      ? cursorCodec.encode(kind, cursorFor(selected[selected.length - 1]), binding)
      : null,
  };
}

function commitWithAudit(db, mutate, audit) {
  return db.transaction(() => {
    const result = mutate();
    writeAudit(db, audit);
    return result;
  })();
}

function assertPlacementActivitiesMutable(placement) {
  if (placement.status === "complete" || placement.status === "cancelled") {
    throw new AppError(
      409,
      "placement_frozen",
      `Activity records cannot change while the placement is ${placement.status}.`,
      { status: placement.status },
    );
  }
}

function assertCheckInTime(db, schoolId, placement, occurredAt) {
  const occurred = Date.parse(occurredAt);
  if (!Number.isFinite(occurred)) {
    throw new AppError(422, "invalid_check_in_date", "Check-in time is not valid.");
  }
  if (occurred > Date.now() + CHECK_IN_FUTURE_SKEW_MS) {
    throw new AppError(
      422,
      "future_check_in",
      "A check-in cannot be recorded in the future.",
    );
  }
  const date = schoolDateForInstant(db, schoolId, occurredAt);
  if (date < placement.startDate || date > placement.endDate) {
    throw new AppError(
      422,
      "check_in_outside_placement",
      "The check-in date must fall within the placement date range.",
    );
  }
}

function placementChildCounts(db, placementId) {
  return db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM time_entries WHERE placement_id = @placementId) AS timeEntries,
      (SELECT COUNT(*) FROM check_ins WHERE placement_id = @placementId) AS checkIns,
      (
        SELECT COUNT(*)
        FROM placement_documents pd
        LEFT JOIN programme_requirements pr ON pr.id = pd.requirement_id
        WHERE pd.placement_id = @placementId
          AND NOT (
            pd.requirement_id IS NOT NULL
            AND pd.title = pr.label
            AND pd.status = 'missing'
            AND pd.reference = ''
            AND pd.due_date IS NULL
            AND pd.revision = 1
            AND pd.superseded_at IS NULL
          )
      ) AS documents
  `).get({ placementId });
}

function assertPlacementIdentityMutable(db, placementId, changedFields) {
  if (changedFields.length === 0) return;
  const childCounts = placementChildCounts(db, placementId);
  const count = childCounts.timeEntries + childCounts.checkIns + childCounts.documents;
  if (count === 0) return;
  throw new AppError(
    409,
    "placement_identity_locked",
    "A placement with recorded activity cannot change student, host or period. Close or cancel it and create a new placement.",
    { count, changedFields },
  );
}

function assertPlacementChildrenWithinRange(db, schoolId, placementId, startDate, endDate) {
  const conflicts = db.prepare(`
    SELECT
      (
        SELECT COUNT(*)
        FROM time_entries
        WHERE placement_id = @placementId
          AND (entry_date < @startDate OR entry_date > @endDate)
      ) AS timeEntries
  `).get({ placementId, startDate, endDate });
  const checkIns = db.prepare(
    "SELECT occurred_at AS occurredAt FROM check_ins WHERE placement_id = ?",
  ).all(placementId).filter((row) => {
    const date = schoolDateForInstant(db, schoolId, row.occurredAt);
    return date < startDate || date > endDate;
  }).length;
  const count = conflicts.timeEntries + checkIns;
  if (count === 0) return;
  throw new AppError(
    422,
    "placement_date_conflict",
    "The selected dates would exclude existing time or check-in activity.",
    { count },
  );
}

function assertDocumentDueDate(placement, dueDate) {
  if (!dueDate) return;
  if (!isIsoDate(dueDate)) {
    throw new AppError(422, "invalid_due_date", "Document due date is not valid.");
  }
}

function assertCanDeactivate(db, schoolId, entityType, entityId, relationSql) {
  const count = db.prepare(`
    SELECT COUNT(*) AS count
    FROM placements p
    WHERE p.school_id = ?
      AND p.status NOT IN ('complete', 'cancelled')
      AND ${relationSql}
  `).get(schoolId, entityId).count;
  if (count === 0) return;
  throw new AppError(
    409,
    "entity_has_open_placements",
    `This ${entityType} has open placements. Close or reassign them before deactivation.`,
    { count, resource: entityType },
  );
}

function assertStudentDailyMinutes(
  db,
  schoolId,
  studentId,
  entryDate,
  minutes,
  verificationStatus,
  excludedEntryId = null,
) {
  if (verificationStatus === "rejected") return;
  const existing = db.prepare(`
    SELECT COALESCE(SUM(te.minutes), 0) AS minutes
    FROM time_entries te
    JOIN placements p ON p.id = te.placement_id
    WHERE p.school_id = ?
      AND p.student_id = ?
      AND te.entry_date = ?
      AND te.verification_status != 'rejected'
      AND (? IS NULL OR te.id != ?)
  `).get(schoolId, studentId, entryDate, excludedEntryId, excludedEntryId).minutes;
  if (existing + minutes > 1440) {
    throw new AppError(
      422,
      "daily_hours_exceeded",
      "A student cannot record more than 24 hours on one day across placements.",
    );
  }
}

function assertOwnedReference(db, user, table, id, label, extraSql = "", extraParams = []) {
  if (!id) return;
  const allowed = new Set(["students", "hosts", "placement_periods", "cohorts", "users"]);
  if (!allowed.has(table)) throw new Error("Unsafe reference table.");
  const row = db.prepare(`
    SELECT id
    FROM ${table}
    WHERE id = ? AND school_id = ? ${extraSql}
  `).get(id, user.schoolId, ...extraParams);
  if (!row) {
    throw new AppError(
      422,
      "invalid_reference",
      `${label} does not belong to this school or is not available.`,
    );
  }
}

export function assertSchoolReferences(db, user, references) {
  assertOwnedReference(db, user, "students", references.studentId, "Student", "AND active = 1");
  assertOwnedReference(db, user, "hosts", references.hostId, "Host", "AND active = 1");
  assertOwnedReference(db, user, "placement_periods", references.periodId, "Period", "AND active = 1");
  assertOwnedReference(db, user, "cohorts", references.cohortId, "Cohort", "AND active = 1");
  assertOwnedReference(
    db,
    user,
    "users",
    references.tutorUserId ?? references.schoolTutorId,
    "Tutor",
    "AND active = 1 AND role IN ('school_admin', 'coordinator', 'tutor')",
  );
}

export function assertPlacementPeriodRange(
  db,
  user,
  periodId,
  startDate,
  endDate,
) {
  if (!periodId) return;
  const period = db.prepare(`
    SELECT start_date AS startDate, end_date AS endDate
    FROM placement_periods
    WHERE id = ? AND school_id = ?
  `).get(periodId, user.schoolId);
  if (!period) {
    throw new AppError(422, "invalid_reference", "Placement period is not available.");
  }
  if (startDate < period.startDate || endDate > period.endDate) {
    throw new AppError(
      422,
      "placement_outside_period",
      "Placement dates must fall within the selected period.",
    );
  }
}

function mapPlacement(row) {
  return {
    id: row.id,
    studentId: row.student_id,
    studentName: row.student_name,
    cohortName: row.cohort_name ?? "",
    hostId: row.host_id,
    hostName: row.host_name,
    periodId: row.period_id,
    schoolTutorId: row.school_tutor_id,
    schoolTutorName: row.school_tutor_name ?? "Unassigned",
    programmeVersionId: row.programme_version_id,
    programmeCode: row.programme_code,
    programmeName: row.programme_name,
    programmeVersion: row.programme_version,
    hostTutorName: row.host_tutor_name,
    startDate: row.start_date,
    endDate: row.end_date,
    targetHours: minutesToHours(row.target_minutes),
    loggedHours: minutesToHours(row.logged_minutes),
    status: row.status,
    revision: row.revision,
    documentGaps: row.document_gaps,
    lastCheckInAt: row.last_check_in_at,
  };
}

const ATTENTION_CURSOR_TYPES = Object.freeze(["number", "string", "string", "string"]);
const COVERAGE_CURSOR_TYPES = Object.freeze(["number", "string", "string", "string"]);

function attentionCte(user) {
  const scope = placementScope(user);
  return `
    WITH attention AS (
      SELECT
        'evidence_' || pd.id AS id,
        p.id AS placement_id,
        'evidence' AS category,
        'document_due' AS reason,
        CASE WHEN pd.due_date < @today THEN 'overdue' ELSE 'due_soon' END AS severity,
        pd.title AS title,
        'Document status: ' || replace(pd.status, '_', ' ') || '.' AS detail,
        pd.due_date AS due_date,
        s.first_name || ' ' || s.last_name AS student_name,
        h.name AS host_name,
        COALESCE(u.display_name, '') AS school_tutor_name,
        CASE WHEN pd.due_date < @today THEN 0 ELSE 1 END AS priority,
        pd.due_date AS sort_date,
        s.id AS student_id
      FROM placements p
      JOIN students s ON s.id = p.student_id
      JOIN hosts h ON h.id = p.host_id
      LEFT JOIN users u ON u.id = p.school_tutor_id
      JOIN placement_documents pd ON pd.placement_id = p.id
      LEFT JOIN programme_requirements pr ON pr.id = pd.requirement_id
      WHERE ${scope}
        AND p.status NOT IN ('complete', 'cancelled')
        AND pd.superseded_at IS NULL
        AND pd.due_date IS NOT NULL
        AND pd.due_date <= date(@today, '+14 days')
        AND (
          (
            pd.requirement_id IS NULL
            AND pd.status NOT IN ('signed', 'archived')
          )
          OR (
            pd.requirement_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM json_each(pr.accepted_statuses_json)
              WHERE value = pd.status
            )
          )
        )

      UNION ALL

      SELECT
        'hours_' || p.id AS id,
        p.id AS placement_id,
        'hours' AS category,
        'hours_pending' AS reason,
        'review' AS severity,
        'Time entries need review' AS title,
        CAST(COUNT(*) AS TEXT) || ' pending time '
          || CASE WHEN COUNT(*) = 1 THEN 'entry needs' ELSE 'entries need' END
          || ' review.' AS detail,
        NULL AS due_date,
        s.first_name || ' ' || s.last_name AS student_name,
        h.name AS host_name,
        COALESCE(u.display_name, '') AS school_tutor_name,
        2 AS priority,
        MIN(te.entry_date) AS sort_date,
        s.id AS student_id
      FROM placements p
      JOIN students s ON s.id = p.student_id
      JOIN hosts h ON h.id = p.host_id
      LEFT JOIN users u ON u.id = p.school_tutor_id
      JOIN time_entries te ON te.placement_id = p.id
      WHERE ${scope}
        AND p.status NOT IN ('complete', 'cancelled')
        AND te.verification_status = 'pending'
      GROUP BY
        p.id,
        s.id,
        s.first_name,
        s.last_name,
        h.name,
        u.display_name

      UNION ALL

      SELECT
        'status_start_' || p.id AS id,
        p.id AS placement_id,
        'status' AS category,
        'placement_start' AS reason,
        CASE WHEN p.start_date < @today THEN 'overdue' ELSE 'due_soon' END AS severity,
        CASE
          WHEN p.start_date < @today THEN 'Placement start date has passed'
          ELSE 'Placement starts soon'
        END AS title,
        CASE
          WHEN p.start_date < @today THEN 'Start the placement, reschedule it or record a cancellation.'
          ELSE 'Confirm the placement is ready to start.'
        END AS detail,
        p.start_date AS due_date,
        s.first_name || ' ' || s.last_name AS student_name,
        h.name AS host_name,
        COALESCE(u.display_name, '') AS school_tutor_name,
        CASE WHEN p.start_date < @today THEN 0 ELSE 1 END AS priority,
        p.start_date AS sort_date,
        s.id AS student_id
      FROM placements p
      JOIN students s ON s.id = p.student_id
      JOIN hosts h ON h.id = p.host_id
      LEFT JOIN users u ON u.id = p.school_tutor_id
      WHERE ${scope}
        AND p.status = 'planned'
        AND p.start_date <= date(@today, '+14 days')

      UNION ALL

      SELECT
        'status_end_' || p.id AS id,
        p.id AS placement_id,
        'status' AS category,
        'placement_end' AS reason,
        CASE WHEN p.end_date < @today THEN 'overdue' ELSE 'due_soon' END AS severity,
        CASE
          WHEN p.end_date < @today THEN 'Placement end date has passed'
          ELSE 'Placement ends soon'
        END AS title,
        CASE
          WHEN p.end_date < @today THEN 'Move the placement to review or correct its dates.'
          ELSE 'Prepare the placement for close-out.'
        END AS detail,
        p.end_date AS due_date,
        s.first_name || ' ' || s.last_name AS student_name,
        h.name AS host_name,
        COALESCE(u.display_name, '') AS school_tutor_name,
        CASE WHEN p.end_date < @today THEN 0 ELSE 1 END AS priority,
        p.end_date AS sort_date,
        s.id AS student_id
      FROM placements p
      JOIN students s ON s.id = p.student_id
      JOIN hosts h ON h.id = p.host_id
      LEFT JOIN users u ON u.id = p.school_tutor_id
      WHERE ${scope}
        AND p.status = 'active'
        AND p.end_date <= date(@today, '+14 days')

      UNION ALL

      SELECT
        'status_review_' || p.id AS id,
        p.id AS placement_id,
        'status' AS category,
        'placement_review' AS reason,
        'review' AS severity,
        'Placement awaits close-out' AS title,
        'Review readiness and decide whether to complete the placement.' AS detail,
        NULL AS due_date,
        s.first_name || ' ' || s.last_name AS student_name,
        h.name AS host_name,
        COALESCE(u.display_name, '') AS school_tutor_name,
        2 AS priority,
        p.end_date AS sort_date,
        s.id AS student_id
      FROM placements p
      JOIN students s ON s.id = p.student_id
      JOIN hosts h ON h.id = p.host_id
      LEFT JOIN users u ON u.id = p.school_tutor_id
      WHERE ${scope}
        AND p.status = 'review'

      UNION ALL

      SELECT
        'assignment_' || p.id AS id,
        p.id AS placement_id,
        'assignment' AS category,
        'tutor_unassigned' AS reason,
        CASE WHEN p.start_date < @today THEN 'overdue' ELSE 'due_soon' END AS severity,
        CASE
          WHEN p.start_date < @today THEN 'School tutor assignment is overdue'
          ELSE 'School tutor not assigned'
        END AS title,
        'Assign a school tutor to own follow-up for this placement.' AS detail,
        p.start_date AS due_date,
        s.first_name || ' ' || s.last_name AS student_name,
        h.name AS host_name,
        '' AS school_tutor_name,
        CASE WHEN p.start_date < @today THEN 0 ELSE 1 END AS priority,
        p.start_date AS sort_date,
        s.id AS student_id
      FROM placements p
      JOIN students s ON s.id = p.student_id
      JOIN hosts h ON h.id = p.host_id
      WHERE ${scope}
        AND p.status IN ('planned', 'active')
        AND p.school_tutor_id IS NULL
        AND p.start_date <= date(@today, '+14 days')
    ),
    filtered_attention AS (
      SELECT *
      FROM attention
      WHERE (@category = 'all' OR category = @category)
        AND (
          @query = '%%'
          OR student_name LIKE @query ESCAPE '\\'
          OR host_name LIKE @query ESCAPE '\\'
          OR school_tutor_name LIKE @query ESCAPE '\\'
          OR title LIKE @query ESCAPE '\\'
        )
    )
  `;
}

function attentionQueryParams(user, { today, query = "", category = "all" }) {
  return {
    ...params(user),
    today,
    query: searchPattern(query),
    category,
  };
}

function mapAttentionRow(row) {
  return {
    id: row.id,
    placementId: row.placementId,
    category: row.category,
    reason: row.reason,
    severity: row.severity,
    title: row.title,
    detail: row.detail,
    dueDate: row.dueDate,
    studentName: row.studentName,
    hostName: row.hostName,
    schoolTutorName: row.schoolTutorName,
  };
}

function selectAttentionRows(db, user, filters, { position = null, limit }) {
  return db.prepare(`${attentionCte(user)}
    SELECT
      id,
      placement_id AS placementId,
      category,
      reason,
      severity,
      title,
      detail,
      due_date AS dueDate,
      student_name AS studentName,
      host_name AS hostName,
      school_tutor_name AS schoolTutorName,
      priority,
      sort_date AS sortDate,
      student_id AS studentId
    FROM filtered_attention
    WHERE @cursorPriority IS NULL
      OR priority > @cursorPriority
      OR (
        priority = @cursorPriority
        AND (
          sort_date > @cursorDate
          OR (
            sort_date = @cursorDate
            AND (
              student_id > @cursorStudentId
              OR (student_id = @cursorStudentId AND id > @cursorId)
            )
          )
        )
      )
    ORDER BY priority, sort_date, student_id, id
    LIMIT @rowLimit
  `).all({
    ...attentionQueryParams(user, filters),
    cursorPriority: position?.[0] ?? null,
    cursorDate: position?.[1] ?? "",
    cursorStudentId: position?.[2] ?? "",
    cursorId: position?.[3] ?? "",
    rowLimit: limit,
  });
}

function readAttentionSummary(db, user, today) {
  const filters = { today, query: "", category: "all" };
  const counts = db.prepare(`${attentionCte(user)}
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(severity = 'overdue'), 0) AS overdue,
      COALESCE(SUM(severity = 'due_soon'), 0) AS dueSoon,
      COALESCE(SUM(severity = 'review'), 0) AS review
    FROM filtered_attention
  `).get(attentionQueryParams(user, filters));
  const items = selectAttentionRows(db, user, filters, { limit: 6 });
  return {
    total: counts.total,
    overdue: counts.overdue,
    dueSoon: counts.dueSoon,
    review: counts.review,
    items: items.map(mapAttentionRow),
  };
}

export function listAttentionItems(
  db,
  user,
  {
    query = "",
    category = "all",
    limit = 50,
    cursor = undefined,
  } = {},
  cursorCodec,
  now = new Date(),
) {
  const today = currentSchoolDate(db, user.schoolId, now);
  const binding = cursorBinding(user, "attention", {
    query: query.trim(),
    category,
    today,
  });
  const position = cursorCodec.decode(
    cursor,
    "attention",
    ATTENTION_CURSOR_TYPES,
    binding,
  );
  const rows = selectAttentionRows(
    db,
    user,
    { today, query, category },
    { position, limit: limit + 1 },
  );
  return pageRows(
    rows,
    limit,
    "attention",
    (row) => [row.priority, row.sortDate, row.studentId, row.id],
    cursorCodec,
    binding,
    mapAttentionRow,
  );
}

const COVERAGE_CTE = `
  WITH eligible_students AS (
    SELECT
      s.id AS student_id,
      s.first_name || ' ' || s.last_name AS student_name,
      s.external_ref,
      s.cohort_id,
      c.name AS cohort_name,
      LOWER(s.last_name) AS sort_last_name,
      LOWER(s.first_name) AS sort_first_name
    FROM students s
    JOIN cohorts c
      ON c.id = s.cohort_id
      AND c.school_id = s.school_id
    WHERE s.school_id = @schoolId
      AND s.cohort_id = @cohortId
      AND s.active = 1
      AND (
        @query = '%%'
        OR s.first_name || ' ' || s.last_name LIKE @query ESCAPE '\\'
        OR s.last_name || ' ' || s.first_name LIKE @query ESCAPE '\\'
        OR COALESCE(s.external_ref, '') LIKE @query ESCAPE '\\'
        OR c.name LIKE @query ESCAPE '\\'
      )
  ),
  counted_placements AS (
    SELECT
      p.id,
      p.student_id,
      p.start_date,
      p.end_date
    FROM placements p
    JOIN eligible_students student ON student.student_id = p.student_id
    WHERE p.school_id = @schoolId
      AND p.status != 'cancelled'
      AND p.start_date <= @periodEnd
      AND p.end_date >= @periodStart
  ),
  classified_students AS (
    SELECT
      student.*,
      (
        SELECT COUNT(*)
        FROM counted_placements placement
        WHERE placement.student_id = student.student_id
      ) AS placement_count,
      EXISTS (
        SELECT 1
        FROM counted_placements first_placement
        JOIN counted_placements second_placement
          ON second_placement.student_id = first_placement.student_id
          AND second_placement.id > first_placement.id
        WHERE first_placement.student_id = student.student_id
          AND first_placement.start_date <= second_placement.end_date
          AND second_placement.start_date <= first_placement.end_date
      ) AS has_conflict
    FROM eligible_students student
  ),
  coverage_rows AS (
    SELECT
      classified.*,
      CASE
        WHEN has_conflict = 1 THEN 'conflict'
        WHEN placement_count = 0 THEN 'unplaced'
        ELSE 'placed'
      END AS coverage_status,
      CASE
        WHEN has_conflict = 1 THEN 0
        WHEN placement_count = 0 THEN 1
        ELSE 2
      END AS sort_status
    FROM classified_students classified
  )
`;

function coverageContext(db, user, cohortId, periodId) {
  if (!hasSchoolScope(user)) {
    throw new AppError(403, "forbidden", "You do not have permission to perform this action.");
  }
  const context = db.prepare(`
    SELECT
      cohort.id AS cohortId,
      period.id AS periodId,
      period.start_date AS periodStart,
      period.end_date AS periodEnd
    FROM cohorts cohort
    JOIN placement_periods period
      ON period.id = @periodId
      AND period.school_id = @schoolId
    WHERE cohort.id = @cohortId
      AND cohort.school_id = @schoolId
  `).get({
    schoolId: user.schoolId,
    cohortId,
    periodId,
  });
  if (!context) {
    throw new AppError(
      422,
      "invalid_reference",
      "The requested coverage cohort and period are not available.",
    );
  }
  return context;
}

export function listCoverage(
  db,
  user,
  {
    cohortId,
    periodId,
    status = "all",
    query = "",
    limit = 50,
    cursor,
  },
  cursorCodec,
) {
  const context = coverageContext(db, user, cohortId, periodId);
  const normalizedQuery = query.trim();
  const binding = cursorBinding(user, "coverage", {
    cohortId,
    periodId,
    status,
    query: normalizedQuery,
    limit,
  });
  const position = cursorCodec.decode(
    cursor,
    "coverage",
    COVERAGE_CURSOR_TYPES,
    binding,
  );
  const queryParams = {
    ...params(user),
    cohortId,
    periodStart: context.periodStart,
    periodEnd: context.periodEnd,
    query: searchPattern(normalizedQuery),
  };

  return db.transaction(() => {
    const counts = db.prepare(`${COVERAGE_CTE}
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(coverage_status = 'unplaced'), 0) AS unplaced,
        COALESCE(SUM(coverage_status = 'placed'), 0) AS placed,
        COALESCE(SUM(coverage_status = 'conflict'), 0) AS conflict
      FROM coverage_rows
    `).get(queryParams);

    const rows = db.prepare(`${COVERAGE_CTE}
      SELECT
        student_id AS studentId,
        student_name AS studentName,
        external_ref AS externalRef,
        cohort_id AS cohortId,
        cohort_name AS cohortName,
        coverage_status AS status,
        placement_count AS placementCount,
        sort_status AS sortStatus,
        sort_last_name AS sortLastName,
        sort_first_name AS sortFirstName
      FROM coverage_rows
      WHERE (@status = 'all' OR coverage_status = @status)
        AND (
          @cursorStatus IS NULL
          OR sort_status > @cursorStatus
          OR (
            sort_status = @cursorStatus
            AND (
              sort_last_name > @cursorLastName
              OR (
                sort_last_name = @cursorLastName
                AND (
                  sort_first_name > @cursorFirstName
                  OR (
                    sort_first_name = @cursorFirstName
                    AND student_id > @cursorStudentId
                  )
                )
              )
            )
          )
        )
      ORDER BY sort_status, sort_last_name, sort_first_name, student_id
      LIMIT @rowLimit
    `).all({
      ...queryParams,
      status,
      cursorStatus: position?.[0] ?? null,
      cursorLastName: position?.[1] ?? "",
      cursorFirstName: position?.[2] ?? "",
      cursorStudentId: position?.[3] ?? "",
      rowLimit: limit + 1,
    });
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const selectedStudentIds = selected.map((row) => row.studentId);
    const placementsByStudent = /** @type {Map<string, Array<{
     *   id: string,
     *   hostName: string,
     *   status: string,
     *   startDate: string,
     *   endDate: string
     * }>>} */ (new Map());
    for (const studentId of selectedStudentIds) {
      placementsByStudent.set(studentId, []);
    }
    if (selectedStudentIds.length > 0) {
      const placementRows = db.prepare(`
        WITH matching_placements AS (
          SELECT
            p.id,
            p.student_id AS studentId,
            h.name AS hostName,
            p.status,
            p.start_date AS startDate,
            p.end_date AS endDate,
            ROW_NUMBER() OVER (
              PARTITION BY p.student_id
              ORDER BY p.start_date, p.end_date, p.id
            ) AS placementRank
          FROM placements p
          JOIN hosts h
            ON h.id = p.host_id
            AND h.school_id = p.school_id
          WHERE p.school_id = @schoolId
            AND p.student_id IN (SELECT value FROM json_each(@studentIds))
            AND p.status != 'cancelled'
            AND p.start_date <= @periodEnd
            AND p.end_date >= @periodStart
        )
        SELECT id, studentId, hostName, status, startDate, endDate
        FROM matching_placements
        WHERE placementRank <= 5
        ORDER BY studentId, startDate, endDate, id
      `).all({
        schoolId: user.schoolId,
        studentIds: JSON.stringify(selectedStudentIds),
        periodStart: context.periodStart,
        periodEnd: context.periodEnd,
      });
      for (const placement of placementRows) {
        const studentPlacements = placementsByStudent.get(placement.studentId);
        if (Array.isArray(studentPlacements)) {
          studentPlacements.push({
            id: placement.id,
            hostName: placement.hostName,
            status: placement.status,
            startDate: placement.startDate,
            endDate: placement.endDate,
          });
        }
      }
    }
    const last = selected.at(-1);
    return {
      summary: {
        total: counts.total,
        unplaced: counts.unplaced,
        placed: counts.placed,
        conflict: counts.conflict,
      },
      items: selected.map((row) => {
        const selectedPlacements = placementsByStudent.get(row.studentId);
        const placements = Array.isArray(selectedPlacements)
          ? selectedPlacements
          : [];
        return {
          studentId: row.studentId,
          studentName: row.studentName,
          externalRef: row.externalRef,
          cohortId: row.cohortId,
          cohortName: row.cohortName,
          status: row.status,
          placementCount: row.placementCount,
          placements,
          additionalPlacements: row.placementCount - placements.length,
        };
      }),
      nextCursor: hasMore
        ? cursorCodec.encode(
          "coverage",
          [
            last.sortStatus,
            last.sortLastName,
            last.sortFirstName,
            last.studentId,
          ],
          binding,
        )
        : null,
    };
  })();
}

export function readDashboard(db, user, now = new Date()) {
  const scope = placementScope(user);
  const rows = db.prepare(`
    SELECT
      p.status,
      p.target_minutes,
      COALESCE((
        SELECT SUM(te.minutes)
        FROM time_entries te
        WHERE te.placement_id = p.id AND te.verification_status != 'rejected'
      ), 0) AS logged_minutes,
      ${documentGapsExpression("p")} AS document_gaps
    FROM placements p
    WHERE ${scope}
  `).all(params(user));

  const completionRows = rows.filter((row) => row.status !== "cancelled");
  const targetMinutes = completionRows.reduce((total, row) => total + row.target_minutes, 0);
  const loggedMinutes = completionRows.reduce((total, row) => total + row.logged_minutes, 0);
  const today = currentSchoolDate(db, user.schoolId, now);
  return {
    placements: rows.length,
    active: rows.filter((row) => row.status === "active").length,
    review: rows.filter((row) => row.status === "review").length,
    complete: rows.filter((row) => row.status === "complete").length,
    completion: targetMinutes === 0 ? 0 : Math.min(100, Math.round(loggedMinutes / targetMinutes * 100)),
    documentGaps: rows.reduce((total, row) => total + row.document_gaps, 0),
    attention: readAttentionSummary(db, user, today),
  };
}

export function placementReadiness(db, placementId) {
  const placement = db.prepare(`
    SELECT
      p.target_minutes AS targetMinutes,
      p.programme_version_id AS programmeVersionId,
      pv.version AS programmeVersion,
      pv.minimum_check_ins AS minimumCheckIns,
      programme.code AS programmeCode,
      programme.name AS programmeName
    FROM placements p
    JOIN programme_versions pv ON pv.id = p.programme_version_id
    JOIN programmes programme ON programme.id = pv.programme_id
    WHERE p.id = ?
  `).get(placementId);
  if (!placement) throw notFound("Placement");
  const loggedMinutes = db.prepare(`
    SELECT COALESCE(SUM(minutes), 0) AS value
    FROM time_entries
    WHERE placement_id = ? AND verification_status = 'verified'
  `).get(placementId).value;
  const checkIns = db.prepare(
    "SELECT COUNT(*) AS count FROM check_ins WHERE placement_id = ? AND voided = 0",
  ).get(placementId).count;
  const documentRows = db.prepare(`
      SELECT
        id,
        kind,
        status,
        requirement_id AS requirementId,
        superseded_at AS supersededAt
      FROM placement_documents
      WHERE placement_id = ?
      ORDER BY kind, id
    `).all(placementId);
  const requirementRows = db.prepare(`
    SELECT
      id,
      code,
      label,
      accepted_statuses_json AS acceptedStatusesJson
    FROM programme_requirements
    WHERE programme_version_id = ?
    ORDER BY sort_order, code
  `).all(placement.programmeVersionId);
  const documents = new Map(
    documentRows
      .filter((row) => row.requirementId !== null && row.supersededAt === null)
      .map((row) => [row.requirementId, row.status]),
  );
  const blockers = [];
  if (loggedMinutes < placement.targetMinutes) {
    blockers.push({
      code: "hours_incomplete",
      message: "Verified hours have not reached the placement target.",
    });
  }
  if (checkIns < placement.minimumCheckIns) {
    blockers.push({
      code: "check_in_missing",
      message: `Record at least ${placement.minimumCheckIns} placement check-in${
        placement.minimumCheckIns === 1 ? "" : "s"
      }.`,
    });
  }
  for (const requirement of requirementRows) {
    const accepted = new Set(JSON.parse(requirement.acceptedStatusesJson));
    if (!accepted.has(documents.get(requirement.id))) {
      blockers.push({
        code: `document_${requirement.code}`,
        message: `${requirement.label} is required.`,
      });
    }
  }
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({
      targetMinutes: placement.targetMinutes,
      loggedMinutes,
      checkIns,
      programmeVersionId: placement.programmeVersionId,
      minimumCheckIns: placement.minimumCheckIns,
      requirements: requirementRows.map((row) => [
        row.id,
        row.code,
        row.acceptedStatusesJson,
      ]),
      documents: documentRows.map((row) => [
        row.id,
        row.kind,
        row.status,
        row.supersededAt !== null,
        row.requirementId,
      ]),
      blockers: blockers.map((item) => item.code),
    }))
    .digest("hex");
  return {
    ready: blockers.length === 0,
    blockers,
    fingerprint,
    verifiedHours: minutesToHours(loggedMinutes),
    targetHours: minutesToHours(placement.targetMinutes),
    completedCheckIns: checkIns,
    minimumCheckIns: placement.minimumCheckIns,
    programmeCode: placement.programmeCode,
    programmeName: placement.programmeName,
    programmeVersion: placement.programmeVersion,
  };
}

export function listPlacements(
  db,
  user,
  {
    query = "",
    status = "all",
    limit = 50,
    cursor,
    cursorView = "collection",
  } = {},
  cursorCodec,
) {
  const scope = placementScope(user);
  const normalizedQuery = searchPattern(query);
  const binding = cursorBinding(user, cursorView, {
    query: query.trim(),
    status,
  });
  const position = cursorCodec.decode(cursor, "placements", [
    "number",
    "string",
    "string",
    "string",
  ], binding);
  const rows = db.prepare(`
    WITH matching AS (
      SELECT
        p.*,
        s.first_name || ' ' || s.last_name AS student_name,
        LOWER(s.first_name || ' ' || s.last_name) AS sort_student,
        c.name AS cohort_name,
        h.name AS host_name,
        u.display_name AS school_tutor_name,
        programme.code AS programme_code,
        programme.name AS programme_name,
        programme_version.version AS programme_version,
        CASE p.status
          WHEN 'review' THEN 0
          WHEN 'active' THEN 1
          WHEN 'planned' THEN 2
          WHEN 'complete' THEN 3
          ELSE 4
        END AS sort_status,
        COALESCE((
          SELECT SUM(te.minutes)
          FROM time_entries te
          WHERE te.placement_id = p.id AND te.verification_status != 'rejected'
        ), 0) AS logged_minutes,
        ${documentGapsExpression("p")} AS document_gaps,
        (
          SELECT MAX(ci.occurred_at)
          FROM check_ins ci
          WHERE ci.placement_id = p.id AND ci.voided = 0
        ) AS last_check_in_at
      FROM placements p
      JOIN students s ON s.id = p.student_id
      LEFT JOIN cohorts c ON c.id = s.cohort_id
      JOIN hosts h ON h.id = p.host_id
      LEFT JOIN users u ON u.id = p.school_tutor_id
      JOIN programme_versions programme_version ON programme_version.id = p.programme_version_id
      JOIN programmes programme ON programme.id = programme_version.programme_id
      WHERE ${scope}
        AND (@status = 'all' OR p.status = @status)
        AND (
          @query = '%%'
          OR s.first_name || ' ' || s.last_name LIKE @query ESCAPE '\\'
          OR h.name LIKE @query ESCAPE '\\'
          OR COALESCE(u.display_name, '') LIKE @query ESCAPE '\\'
        )
    )
    SELECT *
    FROM matching
    WHERE @cursorStatus IS NULL
      OR sort_status > @cursorStatus
      OR (
        sort_status = @cursorStatus
        AND (
          start_date > @cursorStartDate
          OR (
            start_date = @cursorStartDate
            AND (
              sort_student > @cursorStudent
              OR (sort_student = @cursorStudent AND id > @cursorId)
            )
          )
        )
      )
    ORDER BY
      sort_status,
      start_date,
      sort_student,
      id
    LIMIT @rowLimit
  `).all({
    ...params(user),
    query: normalizedQuery,
    status,
    cursorStatus: position?.[0] ?? null,
    cursorStartDate: position?.[1] ?? "",
    cursorStudent: position?.[2] ?? "",
    cursorId: position?.[3] ?? "",
    rowLimit: limit + 1,
  });
  return pageRows(
    rows,
    limit,
    "placements",
    (row) => [row.sort_status, row.start_date, row.sort_student, row.id],
    cursorCodec,
    binding,
    mapPlacement,
  );
}

export function getPlacement(db, user, placementId) {
  const row = db.prepare(`
    SELECT
      p.*,
      s.first_name || ' ' || s.last_name AS student_name,
      s.email AS student_email,
      s.external_ref,
      c.name AS cohort_name,
      h.name AS host_name,
      h.sector,
      h.contact_name,
      h.contact_email,
      h.contact_phone,
      h.address,
      u.display_name AS school_tutor_name,
      programme.code AS programme_code,
      programme.name AS programme_name,
      programme_version.version AS programme_version,
      COALESCE((
        SELECT SUM(te.minutes)
        FROM time_entries te
        WHERE te.placement_id = p.id AND te.verification_status != 'rejected'
      ), 0) AS logged_minutes,
      ${documentGapsExpression("p")} AS document_gaps,
      (
        SELECT MAX(ci.occurred_at)
        FROM check_ins ci
        WHERE ci.placement_id = p.id AND ci.voided = 0
      ) AS last_check_in_at
    FROM placements p
    JOIN students s ON s.id = p.student_id
    LEFT JOIN cohorts c ON c.id = s.cohort_id
    JOIN hosts h ON h.id = p.host_id
    LEFT JOIN users u ON u.id = p.school_tutor_id
    JOIN programme_versions programme_version ON programme_version.id = p.programme_version_id
    JOIN programmes programme ON programme.id = programme_version.programme_id
    WHERE p.id = @placementId AND ${placementScope(user)}
  `).get({ ...params(user), placementId });
  if (!row) throw notFound("Placement");

  const timeEntries = db.prepare(`
    SELECT
      id,
      entry_date AS entryDate,
      minutes,
      description,
      verification_status AS verificationStatus,
      created_by AS createdBy,
      revision,
      created_at AS createdAt
    FROM time_entries
    WHERE placement_id = ?
    ORDER BY entry_date DESC, created_at DESC
  `).all(placementId).map((entry) => ({
    ...entry,
    hours: minutesToHours(entry.minutes),
    canEdit: !["complete", "cancelled"].includes(row.status)
      && (hasPermission(user, "write") || entry.createdBy === user.id),
  }));
  const checkIns = db.prepare(`
    SELECT
      id,
      occurred_at AS occurredAt,
      channel,
      summary,
      next_action AS nextAction,
      voided,
      void_reason AS voidReason,
      created_by AS createdBy,
      revision,
      created_at AS createdAt
    FROM check_ins
    WHERE placement_id = ?
    ORDER BY occurred_at DESC
  `).all(placementId).map((checkIn) => ({
    ...checkIn,
    voided: checkIn.voided === 1,
    canEdit: checkIn.voided !== 1
      && !["complete", "cancelled"].includes(row.status)
      && (hasPermission(user, "write") || checkIn.createdBy === user.id),
    canVoid: checkIn.voided !== 1
      && !["complete", "cancelled"].includes(row.status)
      && hasPermission(user, "write"),
  }));
  const documents = db.prepare(`
    SELECT
      pd.id,
      pd.kind,
      pd.title,
      pd.status,
      pd.reference,
      pd.due_date AS dueDate,
      pd.superseded_at AS supersededAt,
      pd.superseded_by_id AS supersededById,
      pd.requirement_id AS requirementId,
      pd.supersede_reason_code AS supersedeReasonCode,
      pr.code AS requirementCode,
      pr.label AS requirementLabel,
      pd.revision,
      pd.updated_at AS updatedAt
    FROM placement_documents pd
    LEFT JOIN programme_requirements pr ON pr.id = pd.requirement_id
    WHERE pd.placement_id = ?
    ORDER BY pd.due_date IS NULL, pd.due_date, pd.title
  `).all(placementId).map((document) => ({
    ...document,
    superseded: document.supersededAt !== null,
    canEdit: document.supersededAt === null
      && !["signed", "archived"].includes(document.status)
      && !["complete", "cancelled"].includes(row.status)
      && (
        hasPermission(user, "write")
        || hasPermission(user, "write_assigned")
      ),
    canArchive: document.supersededAt === null
      && document.status === "signed"
      && !["complete", "cancelled"].includes(row.status)
      && hasPermission(user, "write"),
    canSupersede: document.supersededAt === null
      && ["signed", "archived"].includes(document.status)
      && !["complete", "cancelled"].includes(row.status)
      && hasPermission(user, "write"),
  }));

  return {
    ...mapPlacement(row),
    studentEmail: row.student_email ?? "",
    studentExternalRef: row.external_ref ?? "",
    hostSector: row.sector,
    hostContactName: row.contact_name,
    hostContactEmail: row.contact_email ?? "",
    hostContactPhone: row.contact_phone ?? "",
    hostAddress: row.address,
    hostTutorEmail: row.host_tutor_email ?? "",
    notes: row.notes,
    timeEntries,
    checkIns,
    documents,
    readiness: placementReadiness(db, placementId),
  };
}

export function listStudents(
  db,
  user,
  {
    query = "",
    active = "all",
    limit = 50,
    cursor,
    cursorView = "collection",
  } = {},
  cursorCodec,
) {
  const binding = cursorBinding(user, cursorView, {
    query: query.trim(),
    active,
  });
  const position = cursorCodec.decode(
    cursor,
    "students",
    ["string", "string", "string"],
    binding,
  );
  const rows = db.prepare(`
    SELECT
      s.id,
      s.external_ref AS externalRef,
      s.first_name AS firstName,
      s.last_name AS lastName,
      LOWER(s.last_name) AS sortLastName,
      LOWER(s.first_name) AS sortFirstName,
      s.email,
      s.active,
      s.retention_hold AS retentionHold,
      s.revision,
      c.id AS cohortId,
      c.name AS cohortName
    FROM students s
    LEFT JOIN cohorts c ON c.id = s.cohort_id
    WHERE s.school_id = @schoolId
      ${relatedScope(user, "scoped.student_id = s.id")}
      AND (
        @active = 'all'
        OR (@active = 'true' AND s.active = 1)
        OR (@active = 'false' AND s.active = 0)
      )
      AND (
        @query = '%%'
        OR s.first_name || ' ' || s.last_name LIKE @query ESCAPE '\\'
        OR COALESCE(s.external_ref, '') LIKE @query ESCAPE '\\'
        OR COALESCE(s.email, '') LIKE @query ESCAPE '\\'
        OR COALESCE(c.name, '') LIKE @query ESCAPE '\\'
      )
      AND (
        @cursorLastName IS NULL
        OR LOWER(s.last_name) > @cursorLastName
        OR (
          LOWER(s.last_name) = @cursorLastName
          AND (
            LOWER(s.first_name) > @cursorFirstName
            OR (
              LOWER(s.first_name) = @cursorFirstName
              AND s.id > @cursorId
            )
          )
        )
      )
    ORDER BY sortLastName, sortFirstName, s.id
    LIMIT @rowLimit
  `).all({
    ...params(user),
    query: searchPattern(query),
    active,
    cursorLastName: position?.[0] ?? null,
    cursorFirstName: position?.[1] ?? "",
    cursorId: position?.[2] ?? "",
    rowLimit: limit + 1,
  });
  return pageRows(
    rows,
    limit,
    "students",
    (row) => [row.sortLastName, row.sortFirstName, row.id],
    cursorCodec,
    binding,
    (row) => ({
      id: row.id,
      externalRef: row.externalRef,
      firstName: row.firstName,
      lastName: row.lastName,
      email: row.email ?? "",
      active: row.active === 1,
      retentionHold: row.retentionHold === 1,
      revision: row.revision,
      cohortId: row.cohortId,
      cohortName: row.cohortName,
    }),
  );
}

export function listHosts(
  db,
  user,
  {
    query = "",
    active = "all",
    limit = 50,
    cursor,
    cursorView = "collection",
  } = {},
  cursorCodec,
) {
  const binding = cursorBinding(user, cursorView, {
    query: query.trim(),
    active,
  });
  const position = cursorCodec.decode(
    cursor,
    "hosts",
    ["string", "string"],
    binding,
  );
  const rows = db.prepare(`
    SELECT
      h.id,
      h.name,
      LOWER(h.name) AS sortName,
      h.sector,
      h.contact_name AS contactName,
      h.contact_email AS contactEmail,
      h.contact_phone AS contactPhone,
      h.address,
      h.active,
      h.revision
    FROM hosts h
    WHERE h.school_id = @schoolId
      ${relatedScope(user, "scoped.host_id = h.id")}
      AND (
        @active = 'all'
        OR (@active = 'true' AND h.active = 1)
        OR (@active = 'false' AND h.active = 0)
      )
      AND (
        @query = '%%'
        OR h.name LIKE @query ESCAPE '\\'
        OR h.sector LIKE @query ESCAPE '\\'
        OR h.contact_name LIKE @query ESCAPE '\\'
        OR COALESCE(h.contact_email, '') LIKE @query ESCAPE '\\'
      )
      AND (
        @cursorName IS NULL
        OR LOWER(h.name) > @cursorName
        OR (LOWER(h.name) = @cursorName AND h.id > @cursorId)
      )
    ORDER BY sortName, h.id
    LIMIT @rowLimit
  `).all({
    ...params(user),
    query: searchPattern(query),
    active,
    cursorName: position?.[0] ?? null,
    cursorId: position?.[1] ?? "",
    rowLimit: limit + 1,
  });
  return pageRows(
    rows,
    limit,
    "hosts",
    (row) => [row.sortName, row.id],
    cursorCodec,
    binding,
    (row) => ({
      id: row.id,
      name: row.name,
      sector: row.sector,
      contactName: row.contactName,
      contactEmail: row.contactEmail ?? "",
      contactPhone: row.contactPhone ?? "",
      address: row.address,
      active: row.active === 1,
      revision: row.revision,
    }),
  );
}

export function listReferenceData(
  db,
  user,
  resource,
  {
    query = "",
    active = "all",
    limit = 50,
    cursor,
    cursorView = "reference",
  } = {},
  cursorCodec,
) {
  const scoped = !hasSchoolScope(user);
  const binding = cursorBinding(user, cursorView, {
    resource,
    query: query.trim(),
    active,
  });
  const common = {
    ...params(user),
    query: searchPattern(query),
    active,
    rowLimit: limit + 1,
  };
  if (resource === "cohorts") {
    const position = cursorCodec.decode(
      cursor,
      "cohorts",
      ["string", "string", "string"],
      binding,
    );
    const rows = db.prepare(`
      SELECT
        c.id,
        c.name,
        LOWER(c.name) AS sortName,
        c.academic_year AS academicYear,
        c.track,
        c.tutor_user_id AS tutorUserId,
        c.active,
        c.revision
      FROM cohorts c
      WHERE c.school_id = @schoolId
        ${scoped ? relatedScope(user, "scoped.student_id IN (SELECT id FROM students WHERE cohort_id = c.id)") : ""}
        AND (
          @active = 'all'
          OR (@active = 'true' AND c.active = 1)
          OR (@active = 'false' AND c.active = 0)
        )
        AND (
          @query = '%%'
          OR c.name LIKE @query ESCAPE '\\'
          OR c.academic_year LIKE @query ESCAPE '\\'
          OR c.track LIKE @query ESCAPE '\\'
        )
        AND (
          @cursorYear IS NULL
          OR c.academic_year < @cursorYear
          OR (
            c.academic_year = @cursorYear
            AND (
              LOWER(c.name) > @cursorName
              OR (LOWER(c.name) = @cursorName AND c.id > @cursorId)
            )
          )
        )
      ORDER BY c.academic_year DESC, sortName, c.id
      LIMIT @rowLimit
    `).all({
      ...common,
      cursorYear: position?.[0] ?? null,
      cursorName: position?.[1] ?? "",
      cursorId: position?.[2] ?? "",
    });
    return pageRows(
      rows,
      limit,
      "cohorts",
      (row) => [row.academicYear, row.sortName, row.id],
      cursorCodec,
      binding,
      (row) => ({
        id: row.id,
        name: row.name,
        academicYear: row.academicYear,
        track: row.track,
        tutorUserId: row.tutorUserId,
        active: row.active === 1,
        revision: row.revision,
      }),
    );
  }
  if (resource === "periods") {
    const position = cursorCodec.decode(
      cursor,
      "periods",
      ["string", "string", "string"],
      binding,
    );
    const rows = db.prepare(`
      SELECT
        pp.id,
        pp.name,
        LOWER(pp.name) AS sortName,
        pp.start_date AS startDate,
        pp.end_date AS endDate,
        pp.active,
        pp.revision
      FROM placement_periods pp
      WHERE pp.school_id = @schoolId
        ${scoped ? relatedScope(user, "scoped.period_id = pp.id") : ""}
        AND (
          @active = 'all'
          OR (@active = 'true' AND pp.active = 1)
          OR (@active = 'false' AND pp.active = 0)
        )
        AND (
          @query = '%%'
          OR pp.name LIKE @query ESCAPE '\\'
          OR pp.start_date LIKE @query ESCAPE '\\'
          OR pp.end_date LIKE @query ESCAPE '\\'
        )
        AND (
          @cursorStartDate IS NULL
          OR pp.start_date < @cursorStartDate
          OR (
            pp.start_date = @cursorStartDate
            AND (
              LOWER(pp.name) > @cursorName
              OR (LOWER(pp.name) = @cursorName AND pp.id > @cursorId)
            )
          )
        )
      ORDER BY pp.start_date DESC, sortName, pp.id
      LIMIT @rowLimit
    `).all({
      ...common,
      cursorStartDate: position?.[0] ?? null,
      cursorName: position?.[1] ?? "",
      cursorId: position?.[2] ?? "",
    });
    return pageRows(
      rows,
      limit,
      "periods",
      (row) => [row.startDate, row.sortName, row.id],
      cursorCodec,
      binding,
      (row) => ({
        id: row.id,
        name: row.name,
        startDate: row.startDate,
        endDate: row.endDate,
        active: row.active === 1,
        revision: row.revision,
      }),
    );
  }
  const position = cursorCodec.decode(
    cursor,
    "tutors",
    ["string", "string"],
    binding,
  );
  const rows = db.prepare(`
    SELECT
      u.id,
      u.display_name AS displayName,
      LOWER(u.display_name) AS sortName,
      u.active
    FROM users u
    WHERE u.school_id = @schoolId
      AND u.role IN ('school_admin', 'coordinator', 'tutor')
      AND (@schoolScope = 1 OR u.id = @userId)
      AND (
        @active = 'all'
        OR (@active = 'true' AND u.active = 1)
        OR (@active = 'false' AND u.active = 0)
      )
      AND (@query = '%%' OR u.display_name LIKE @query ESCAPE '\\')
      AND (
        @cursorName IS NULL
        OR LOWER(u.display_name) > @cursorName
        OR (LOWER(u.display_name) = @cursorName AND u.id > @cursorId)
      )
    ORDER BY sortName, u.id
    LIMIT @rowLimit
  `).all({
    ...common,
    schoolScope: hasSchoolScope(user) ? 1 : 0,
    cursorName: position?.[0] ?? null,
    cursorId: position?.[1] ?? "",
  });
  return pageRows(
    rows,
    limit,
    "tutors",
    (row) => [row.sortName, row.id],
    cursorCodec,
    binding,
    (row) => ({
      id: row.id,
      displayName: row.displayName,
      active: row.active === 1,
    }),
  );
}

export function listLookups(db, user, resource, options, cursorCodec) {
  let page;
  if (resource === "students") {
    page = listStudents(
      db,
      user,
      { ...options, active: "true", cursorView: "lookup" },
      cursorCodec,
    );
    return {
      ...page,
      items: page.items.map((item) => ({
        id: item.id,
        label: `${item.firstName} ${item.lastName}`,
        secondary: item.externalRef ?? item.cohortName ?? "",
      })),
    };
  }
  if (resource === "hosts") {
    page = listHosts(
      db,
      user,
      { ...options, active: "true", cursorView: "lookup" },
      cursorCodec,
    );
    return {
      ...page,
      items: page.items.map((item) => ({
        id: item.id,
        label: item.name,
        secondary: item.sector,
      })),
    };
  }
  page = listReferenceData(
    db,
    user,
    resource,
    { ...options, active: "true", cursorView: "lookup" },
    cursorCodec,
  );
  return {
    ...page,
    items: page.items.map((item) => ({
      id: item.id,
      label: item.name ?? item.displayName,
      secondary: resource === "cohorts"
        ? [item.academicYear, item.track].filter(Boolean).join(" · ")
        : resource === "periods"
          ? `${item.startDate} — ${item.endDate}`
          : "",
    })),
  };
}

export function createStudent(db, user, input, requestId) {
  requirePermission(user, "write");
  assertSchoolReferences(db, user, { cohortId: input.cohortId });
  const id = randomUUID();
  const now = new Date().toISOString();
  commitWithAudit(db, () => db.prepare(`
      INSERT INTO students (
        id, school_id, cohort_id, external_ref, first_name, last_name, email,
        active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      id,
      user.schoolId,
      input.cohortId || null,
      input.externalRef || null,
      input.firstName,
      input.lastName,
      input.email || null,
      now,
      now,
    ), {
    schoolId: user.schoolId,
    actorUserId: user.id,
    action: "student.created",
    entityType: "student",
    entityId: id,
    metadata: { changedFields: ["cohortId", "externalRef", "firstName", "lastName", "email"] },
    requestId,
  });
  return id;
}

export function createHost(db, user, input, requestId) {
  requirePermission(user, "write");
  const id = randomUUID();
  const now = new Date().toISOString();
  commitWithAudit(db, () => db.prepare(`
      INSERT INTO hosts (
        id, school_id, name, sector, contact_name, contact_email, contact_phone,
        address, active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      id,
      user.schoolId,
      input.name,
      input.sector ?? "",
      input.contactName ?? "",
      input.contactEmail || null,
      input.contactPhone || null,
      input.address ?? "",
      now,
      now,
    ), {
    schoolId: user.schoolId,
    actorUserId: user.id,
    action: "host.created",
    entityType: "host",
    entityId: id,
    metadata: {
      changedFields: ["name", "sector", "contactName", "contactEmail", "contactPhone", "address"],
    },
    requestId,
  });
  return id;
}

export function updateStudent(db, user, studentId, input, requestId) {
  requirePermission(user, "write");
  if (input.retentionHold !== undefined) requirePermission(user, "erase");
  const current = db.prepare(`
    SELECT
      id,
      cohort_id AS cohortId,
      external_ref AS externalRef,
      first_name AS firstName,
      last_name AS lastName,
      email,
      active,
      retention_hold AS retentionHold,
      revision
    FROM students
    WHERE id = ? AND school_id = ?
  `).get(studentId, user.schoolId);
  if (!current) throw notFound("Student");
  if (current.revision !== input.revision) {
    throw conflict("The student changed after it was loaded. Refresh and try again.");
  }
  const cohortId = input.cohortId === undefined ? current.cohortId : input.cohortId || null;
  assertSchoolReferences(db, user, { cohortId });
  const values = {
    cohortId,
    externalRef: input.externalRef === undefined ? current.externalRef : input.externalRef || null,
    firstName: input.firstName ?? current.firstName,
    lastName: input.lastName ?? current.lastName,
    email: input.email === undefined ? current.email : input.email || null,
    active: input.active === undefined ? current.active : input.active ? 1 : 0,
    retentionHold: input.retentionHold === undefined
      ? current.retentionHold
      : input.retentionHold ? 1 : 0,
  };
  if (current.active === 1 && values.active === 0) {
    assertCanDeactivate(db, user.schoolId, "student", studentId, "p.student_id = ?");
  }
  const changedFields = [
    "cohortId",
    "externalRef",
    "firstName",
    "lastName",
    "email",
    "active",
    "retentionHold",
  ]
    .filter((field) => input[field] !== undefined);
  commitWithAudit(db, () => {
    const result = db.prepare(`
      UPDATE students
      SET
        cohort_id = @cohortId,
        external_ref = @externalRef,
        first_name = @firstName,
        last_name = @lastName,
        email = @email,
        active = @active,
        retention_hold = @retentionHold,
        revision = revision + 1,
        updated_at = @now
      WHERE id = @id AND school_id = @schoolId AND revision = @revision
    `).run({
      ...values,
      id: studentId,
      schoolId: user.schoolId,
      revision: input.revision,
      now: new Date().toISOString(),
    });
    if (result.changes !== 1) throw conflict("The student changed while it was being saved.");
  }, {
    schoolId: user.schoolId,
    actorUserId: user.id,
    action: "student.updated",
    entityType: "student",
    entityId: studentId,
    metadata: { status: values.active === 1 ? "active" : "inactive", changedFields },
    requestId,
  });
  return input.revision + 1;
}

export function updateHost(db, user, hostId, input, requestId) {
  requirePermission(user, "write");
  const current = db.prepare(`
    SELECT
      id,
      name,
      sector,
      contact_name AS contactName,
      contact_email AS contactEmail,
      contact_phone AS contactPhone,
      address,
      active,
      revision
    FROM hosts
    WHERE id = ? AND school_id = ?
  `).get(hostId, user.schoolId);
  if (!current) throw notFound("Host");
  if (current.revision !== input.revision) {
    throw conflict("The host changed after it was loaded. Refresh and try again.");
  }
  const values = {
    name: input.name ?? current.name,
    sector: input.sector ?? current.sector,
    contactName: input.contactName ?? current.contactName,
    contactEmail: input.contactEmail === undefined ? current.contactEmail : input.contactEmail || null,
    contactPhone: input.contactPhone === undefined ? current.contactPhone : input.contactPhone || null,
    address: input.address ?? current.address,
    active: input.active === undefined ? current.active : input.active ? 1 : 0,
  };
  if (current.active === 1 && values.active === 0) {
    assertCanDeactivate(db, user.schoolId, "host", hostId, "p.host_id = ?");
  }
  const changedFields = [
    "name",
    "sector",
    "contactName",
    "contactEmail",
    "contactPhone",
    "address",
    "active",
  ].filter((field) => input[field] !== undefined);
  commitWithAudit(db, () => {
    const result = db.prepare(`
      UPDATE hosts
      SET
        name = @name,
        sector = @sector,
        contact_name = @contactName,
        contact_email = @contactEmail,
        contact_phone = @contactPhone,
        address = @address,
        active = @active,
        revision = revision + 1,
        updated_at = @now
      WHERE id = @id AND school_id = @schoolId AND revision = @revision
    `).run({
      ...values,
      id: hostId,
      schoolId: user.schoolId,
      revision: input.revision,
      now: new Date().toISOString(),
    });
    if (result.changes !== 1) throw conflict("The host changed while it was being saved.");
  }, {
    schoolId: user.schoolId,
    actorUserId: user.id,
    action: "host.updated",
    entityType: "host",
    entityId: hostId,
    metadata: { status: values.active === 1 ? "active" : "inactive", changedFields },
    requestId,
  });
  return input.revision + 1;
}

export function createCohort(db, user, input, requestId) {
  requirePermission(user, "write");
  assertSchoolReferences(db, user, { tutorUserId: input.tutorUserId });
  const id = randomUUID();
  const now = new Date().toISOString();
  commitWithAudit(db, () => db.prepare(`
      INSERT INTO cohorts (
        id, school_id, name, academic_year, track, tutor_user_id, active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      id,
      user.schoolId,
      input.name,
      input.academicYear,
      input.track ?? "",
      input.tutorUserId || null,
      now,
      now,
    ), {
    schoolId: user.schoolId,
    actorUserId: user.id,
    action: "cohort.created",
    entityType: "cohort",
    entityId: id,
    metadata: { changedFields: ["name", "academicYear", "track", "tutorUserId"] },
    requestId,
  });
  return id;
}

export function createPeriod(db, user, input, requestId) {
  requirePermission(user, "write");
  assertDateRange(input.startDate, input.endDate);
  const id = randomUUID();
  const now = new Date().toISOString();
  commitWithAudit(db, () => db.prepare(`
      INSERT INTO placement_periods (
        id, school_id, name, start_date, end_date, active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).run(id, user.schoolId, input.name, input.startDate, input.endDate, now, now), {
    schoolId: user.schoolId,
    actorUserId: user.id,
    action: "period.created",
    entityType: "placement_period",
    entityId: id,
    metadata: { changedFields: ["name", "startDate", "endDate"] },
    requestId,
  });
  return id;
}

export function updateCohort(db, user, cohortId, input, requestId) {
  requirePermission(user, "write");
  const current = db.prepare(`
    SELECT
      id,
      name,
      academic_year AS academicYear,
      track,
      tutor_user_id AS tutorUserId,
      active,
      revision
    FROM cohorts
    WHERE id = ? AND school_id = ?
  `).get(cohortId, user.schoolId);
  if (!current) throw notFound("Cohort");
  if (current.revision !== input.revision) {
    throw conflict("The cohort changed after it was loaded. Refresh and try again.");
  }
  if (input.tutorUserId !== undefined) {
    assertSchoolReferences(db, user, { tutorUserId: input.tutorUserId });
  }
  const values = {
    name: input.name ?? current.name,
    academicYear: input.academicYear ?? current.academicYear,
    track: input.track ?? current.track,
    tutorUserId: input.tutorUserId === undefined
      ? current.tutorUserId
      : input.tutorUserId || null,
    active: input.active === undefined ? current.active : input.active ? 1 : 0,
  };
  if (current.active === 1 && values.active === 0) {
    assertCanDeactivate(
      db,
      user.schoolId,
      "cohort",
      cohortId,
      "p.student_id IN (SELECT id FROM students WHERE cohort_id = ?)",
    );
  }
  const changedFields = ["name", "academicYear", "track", "tutorUserId", "active"]
    .filter((field) => input[field] !== undefined);
  commitWithAudit(db, () => {
    const result = db.prepare(`
      UPDATE cohorts
      SET
        name = @name,
        academic_year = @academicYear,
        track = @track,
        tutor_user_id = @tutorUserId,
        active = @active,
        revision = revision + 1,
        updated_at = @now
      WHERE id = @id AND school_id = @schoolId AND revision = @revision
    `).run({
      ...values,
      id: cohortId,
      schoolId: user.schoolId,
      revision: input.revision,
      now: new Date().toISOString(),
    });
    if (result.changes !== 1) throw conflict("The cohort changed while it was being saved.");
  }, {
    schoolId: user.schoolId,
    actorUserId: user.id,
    action: "cohort.updated",
    entityType: "cohort",
    entityId: cohortId,
    metadata: { status: values.active === 1 ? "active" : "inactive", changedFields },
    requestId,
  });
  return input.revision + 1;
}

export function updatePeriod(db, user, periodId, input, requestId) {
  requirePermission(user, "write");
  const current = db.prepare(`
    SELECT
      id,
      name,
      start_date AS startDate,
      end_date AS endDate,
      active,
      revision
    FROM placement_periods
    WHERE id = ? AND school_id = ?
  `).get(periodId, user.schoolId);
  if (!current) throw notFound("Period");
  if (current.revision !== input.revision) {
    throw conflict("The period changed after it was loaded. Refresh and try again.");
  }
  const values = {
    name: input.name ?? current.name,
    startDate: input.startDate ?? current.startDate,
    endDate: input.endDate ?? current.endDate,
    active: input.active === undefined ? current.active : input.active ? 1 : 0,
  };
  assertDateRange(values.startDate, values.endDate);
  if (current.active === 1 && values.active === 0) {
    assertCanDeactivate(db, user.schoolId, "period", periodId, "p.period_id = ?");
  }
  const placementsOutsideRange = db.prepare(`
    SELECT COUNT(*) AS count
    FROM placements
    WHERE school_id = ?
      AND period_id = ?
      AND (start_date < ? OR end_date > ?)
  `).get(user.schoolId, periodId, values.startDate, values.endDate).count;
  if (placementsOutsideRange > 0) {
    throw new AppError(
      422,
      "period_date_conflict",
      "The selected period dates would exclude linked placements.",
      { count: placementsOutsideRange },
    );
  }
  const changedFields = ["name", "startDate", "endDate", "active"]
    .filter((field) => input[field] !== undefined);
  commitWithAudit(db, () => {
    const result = db.prepare(`
      UPDATE placement_periods
      SET
        name = @name,
        start_date = @startDate,
        end_date = @endDate,
        active = @active,
        revision = revision + 1,
        updated_at = @now
      WHERE id = @id AND school_id = @schoolId AND revision = @revision
    `).run({
      ...values,
      id: periodId,
      schoolId: user.schoolId,
      revision: input.revision,
      now: new Date().toISOString(),
    });
    if (result.changes !== 1) throw conflict("The period changed while it was being saved.");
  }, {
    schoolId: user.schoolId,
    actorUserId: user.id,
    action: "period.updated",
    entityType: "placement_period",
    entityId: periodId,
    metadata: { status: values.active === 1 ? "active" : "inactive", changedFields },
    requestId,
  });
  return input.revision + 1;
}

export function createPlacement(db, user, input, requestId) {
  requirePermission(user, "write");
  assertDateRange(input.startDate, input.endDate);
  const programme = input.programmeVersionId
    ? programmeVersionForSchool(db, user.schoolId, input.programmeVersionId)
    : currentProgrammeVersionByCode(db, user.schoolId, "VECTOR_DEFAULT");
  if (!programme) {
    throw new AppError(
      422,
      "programme_required",
      "Select an active programme before creating the placement.",
    );
  }
  assertSchoolReferences(db, user, input);
  assertPlacementPeriodRange(
    db,
    user,
    input.periodId,
    input.startDate,
    input.endDate,
  );
  const initialStatus = input.status ?? "planned";
  if (!["planned", "active"].includes(initialStatus)) {
    throw new AppError(
      422,
      "invalid_initial_status",
      "A new placement must start as planned or active.",
    );
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const targetMinutes = hoursToMinutes(input.targetHours);
  assertTargetMinutesFeasible(input.startDate, input.endDate, targetMinutes);
  commitWithAudit(db, () => {
    const result = db.prepare(`
      INSERT INTO placements (
        id, school_id, student_id, host_id, period_id, school_tutor_id,
        host_tutor_name, host_tutor_email, start_date, end_date, target_minutes,
        status, notes, programme_version_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      user.schoolId,
      input.studentId,
      input.hostId,
      input.periodId || null,
      input.schoolTutorId || null,
      input.hostTutorName ?? "",
      input.hostTutorEmail || null,
      input.startDate,
      input.endDate,
      targetMinutes,
      initialStatus,
      input.notes ?? "",
      programme.id,
      now,
      now,
    );
    seedPlacementRequirements(db, user.schoolId, id, programme.id, now);
    return result;
  }, {
    schoolId: user.schoolId,
    actorUserId: user.id,
    action: "placement.created",
    entityType: "placement",
    entityId: id,
    metadata: {
      status: initialStatus,
      programmeCode: programme.programmeCode,
      programmeVersion: programme.version,
    },
    requestId,
  });
  return id;
}

export function updatePlacement(db, user, placementId, input, requestId) {
  requirePermission(user, "write");
  const current = db.prepare(`
    SELECT
      id,
      school_id AS schoolId,
      student_id AS studentId,
      host_id AS hostId,
      period_id AS periodId,
      school_tutor_id AS schoolTutorId,
      host_tutor_name AS hostTutorName,
      host_tutor_email AS hostTutorEmail,
      status,
      notes,
      start_date AS startDate,
      end_date AS endDate,
      target_minutes AS targetMinutes,
      programme_version_id AS programmeVersionId,
      revision
    FROM placements
    WHERE id = ? AND school_id = ?
  `).get(placementId, user.schoolId);
  if (!current) throw notFound("Placement");
  if (!canWritePlacement(user, current)) {
    throw new AppError(403, "forbidden", "This placement is outside your assigned scope.");
  }
  if (current.revision !== input.revision) {
    throw conflict("The placement changed after it was loaded. Refresh and try again.");
  }

  const reopeningComplete = current.status === "complete"
    && input.status === "review";
  let previousFingerprint = null;
  if (current.status === "complete") {
    const changedFields = Object.keys(input).filter((field) => field !== "revision");
    if (
      user.role !== "school_admin"
      || !reopeningComplete
      || !input.reopenReasonCode
      || changedFields.length !== 2
      || !changedFields.includes("status")
      || !changedFields.includes("reopenReasonCode")
    ) {
      throw new AppError(
        user.role === "school_admin" ? 409 : 403,
        user.role === "school_admin" ? "placement_frozen" : "forbidden",
        "Only a school administrator can reopen a completed placement for review with a reason.",
        { status: current.status },
      );
    }
    previousFingerprint = placementReadiness(db, placementId).fingerprint;
  }
  if (current.status === "cancelled") {
    const changedFields = Object.keys(input).filter((field) => field !== "revision");
    if (
      changedFields.length !== 1
      || changedFields[0] !== "status"
      || input.status !== "planned"
    ) {
      throw new AppError(
        409,
        "placement_frozen",
        "A cancelled placement can only be reopened as planned.",
        { status: current.status },
      );
    }
  }

  const status = input.status ?? current.status;
  if (
    status !== current.status
    && !reopeningComplete
    && !STATUS_TRANSITIONS[current.status].has(status)
  ) {
    throw new AppError(
      422,
      "invalid_status_transition",
      `A placement cannot move from ${current.status} to ${status}.`,
    );
  }
  if (status === "complete" && current.status !== "complete") {
    const structuralFields = [
      "studentId",
      "hostId",
      "periodId",
      "schoolTutorId",
      "startDate",
      "endDate",
      "targetHours",
      "programmeVersionId",
    ].filter((field) => input[field] !== undefined);
    if (structuralFields.length > 0) {
      throw new AppError(
        422,
        "completion_transition_requires_stable_record",
        "Save placement structure before completing the placement.",
        { changedFields: structuralFields },
      );
    }
    const readiness = placementReadiness(db, placementId);
    if (!readiness.ready) {
      throw new AppError(
        422,
        "placement_not_ready",
        "Complete the placement readiness checklist before closing it.",
        { blockers: readiness.blockers },
      );
    }
  }
  const startDate = input.startDate ?? current.startDate;
  const endDate = input.endDate ?? current.endDate;
  assertDateRange(startDate, endDate);
  if (input.startDate !== undefined || input.endDate !== undefined) {
    assertPlacementChildrenWithinRange(
      db,
      user.schoolId,
      placementId,
      startDate,
      endDate,
    );
  }
  assertSchoolReferences(db, user, {
    studentId: input.studentId,
    hostId: input.hostId,
    periodId: input.periodId,
    schoolTutorId: input.schoolTutorId,
  });
  const studentId = input.studentId ?? current.studentId;
  const hostId = input.hostId ?? current.hostId;
  const periodId = input.periodId === undefined ? current.periodId : input.periodId || null;
  const schoolTutorId = input.schoolTutorId === undefined
    ? current.schoolTutorId
    : input.schoolTutorId || null;
  const hostTutorName = input.hostTutorName ?? current.hostTutorName;
  const hostTutorEmail = input.hostTutorEmail === undefined
    ? current.hostTutorEmail
    : input.hostTutorEmail || null;
  const identityFields = [
    studentId !== current.studentId ? "studentId" : null,
    hostId !== current.hostId ? "hostId" : null,
    periodId !== current.periodId ? "periodId" : null,
  ].filter(Boolean);
  assertPlacementIdentityMutable(db, placementId, identityFields);
  assertPlacementPeriodRange(db, user, periodId, startDate, endDate);
  const targetMinutes = input.targetHours === undefined
    ? current.targetMinutes
    : hoursToMinutes(input.targetHours);
  assertTargetMinutesFeasible(startDate, endDate, targetMinutes);
  const programmeVersionId = input.programmeVersionId ?? current.programmeVersionId;
  const programme = programmeVersionForSchool(
    db,
    user.schoolId,
    programmeVersionId,
    { activeOnly: input.programmeVersionId !== undefined },
  );
  const programmeChanged = programmeVersionId !== current.programmeVersionId;
  const notes = input.notes ?? current.notes;
  const now = new Date().toISOString();
  const changedFields = [
    "studentId",
    "hostId",
    "periodId",
    "schoolTutorId",
    "hostTutorName",
    "hostTutorEmail",
    "status",
    "notes",
    "startDate",
    "endDate",
    "targetHours",
    "programmeVersionId",
  ]
    .filter((field) => input[field] !== undefined);
  commitWithAudit(db, () => {
    if (programmeChanged) {
      assertPlacementProgrammeMutable(db, user.schoolId, placementId);
    }
    const result = db.prepare(`
      UPDATE placements
      SET
        student_id = ?,
        host_id = ?,
        period_id = ?,
        school_tutor_id = ?,
        host_tutor_name = ?,
        host_tutor_email = ?,
        status = ?,
        notes = ?,
        start_date = ?,
        end_date = ?,
        target_minutes = ?,
        programme_version_id = ?,
        revision = revision + 1,
        updated_at = ?
      WHERE id = ? AND school_id = ? AND revision = ?
    `).run(
      studentId,
      hostId,
      periodId,
      schoolTutorId,
      hostTutorName,
      hostTutorEmail,
      status,
      notes,
      startDate,
      endDate,
      targetMinutes,
      programmeVersionId,
      now,
      placementId,
      user.schoolId,
      input.revision,
    );
    if (result.changes !== 1) throw conflict("The placement changed while it was being saved.");
    if (programmeChanged) {
      replacePlacementRequirements(
        db,
        user.schoolId,
        placementId,
        programmeVersionId,
        now,
      );
    }
    return result;
  }, {
    schoolId: user.schoolId,
    actorUserId: user.id,
    action: reopeningComplete
      ? "placement.reopened"
      : status !== current.status ? "placement.status_changed" : "placement.updated",
    entityType: "placement",
    entityId: placementId,
    metadata: {
      status,
      previousStatus: current.status,
      changedFields,
      programmeCode: programme.programmeCode,
      programmeVersion: programme.version,
      ...(reopeningComplete
        ? {
            reasonCode: input.reopenReasonCode,
            previousFingerprint,
          }
        : {}),
    },
    requestId,
  });
  return input.revision + 1;
}

export function addTimeEntry(db, user, placementId, input, requestId) {
  const placement = getPlacement(db, user, placementId);
  if (!canWritePlacement(user, placement)) {
    throw new AppError(403, "forbidden", "This placement is outside your assigned scope.");
  }
  assertPlacementActivitiesMutable(placement);
  if (
    !isIsoDate(input.entryDate)
    || input.entryDate < placement.startDate
    || input.entryDate > placement.endDate
  ) {
    throw new AppError(
      422,
      "invalid_entry_date",
      "The time entry date must fall within the placement date range.",
    );
  }
  assertNotFutureSchoolDate(db, user.schoolId, input.entryDate);
  const id = randomUUID();
  const now = new Date().toISOString();
  const minutes = hoursToMinutes(input.hours);
  if (minutes > 1440) {
    throw new AppError(422, "invalid_hours", "A time entry cannot exceed 24 hours.");
  }
  const verificationStatus = hasPermission(user, "write")
    ? input.verificationStatus ?? "pending"
    : "pending";
  commitWithAudit(db, () => {
    assertStudentDailyMinutes(
      db,
      user.schoolId,
      placement.studentId,
      input.entryDate,
      minutes,
      verificationStatus,
    );
    return db.prepare(`
      INSERT INTO time_entries (
        id, school_id, placement_id, entry_date, minutes, description,
        verification_status, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      user.schoolId,
      placementId,
      input.entryDate,
      minutes,
      input.description ?? "",
      verificationStatus,
      user.id,
      now,
      now,
    );
  }, {
    schoolId: user.schoolId,
    actorUserId: user.id,
    action: "time_entry.created",
    entityType: "time_entry",
    entityId: id,
    metadata: { status: verificationStatus },
    requestId,
  });
  return id;
}

export function addCheckIn(db, user, placementId, input, requestId) {
  const placement = getPlacement(db, user, placementId);
  if (!canWritePlacement(user, placement)) {
    throw new AppError(403, "forbidden", "This placement is outside your assigned scope.");
  }
  assertPlacementActivitiesMutable(placement);
  assertCheckInTime(db, user.schoolId, placement, input.occurredAt);
  const id = randomUUID();
  const now = new Date().toISOString();
  commitWithAudit(db, () => db.prepare(`
      INSERT INTO check_ins (
        id, school_id, placement_id, occurred_at, channel, summary,
        next_action, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      user.schoolId,
      placementId,
      input.occurredAt,
      input.channel,
      input.summary,
      input.nextAction ?? "",
      user.id,
      now,
      now,
    ), {
    schoolId: user.schoolId,
    actorUserId: user.id,
    action: "check_in.created",
    entityType: "check_in",
    entityId: id,
    metadata: {},
    requestId,
  });
  return id;
}

export function addDocument(db, user, placementId, input, requestId) {
  const placement = getPlacement(db, user, placementId);
  if (!canWritePlacement(user, placement)) {
    throw new AppError(403, "forbidden", "This placement is outside your assigned scope.");
  }
  assertPlacementActivitiesMutable(placement);
  assertDocumentDueDate(placement, input.dueDate);
  if (
    !hasPermission(user, "write")
    && !["missing", "draft", "ready"].includes(input.status)
  ) {
    throw new AppError(
      403,
      "document_validation_required",
      "A coordinator or administrator must validate signed and archived documents.",
    );
  }
  const existing = input.kind === "other" ? null : db.prepare(`
      SELECT
        id,
        title,
        status,
        reference,
        requirement_id AS requirementId,
        revision
      FROM placement_documents
      WHERE school_id = ? AND placement_id = ? AND kind = ?
        AND superseded_at IS NULL
    `).get(user.schoolId, placementId, input.kind);
  if (existing) {
    const fillsUntouchedPlaceholder = existing.requirementId !== null
      && existing.status === "missing"
      && existing.reference === ""
      && existing.revision === 1
      && (
        input.status !== "missing"
        || (input.reference ?? "") !== ""
        || input.dueDate != null
      );
    if (fillsUntouchedPlaceholder) {
      const now = new Date().toISOString();
      const revision = existing.revision + 1;
      commitWithAudit(db, () => {
        const result = db.prepare(`
          UPDATE placement_documents
          SET
            status = ?,
            reference = ?,
            due_date = ?,
            revision = revision + 1,
            updated_at = ?
          WHERE id = ?
            AND school_id = ?
            AND placement_id = ?
            AND revision = ?
            AND status = 'missing'
            AND reference = ''
            AND superseded_at IS NULL
        `).run(
          input.status,
          input.reference ?? "",
          input.dueDate || null,
          now,
          existing.id,
          user.schoolId,
          placementId,
          existing.revision,
        );
        if (result.changes !== 1) {
          throw conflict("The document changed while the programme placeholder was being saved.");
        }
      }, {
        schoolId: user.schoolId,
        actorUserId: user.id,
        action: "document.updated",
        entityType: "placement_document",
        entityId: existing.id,
        metadata: {
          status: input.status,
          previousStatus: existing.status,
          changedFields: ["status", "reference", "dueDate"]
            .filter((field) => input[field] !== undefined),
          programmeRequirement: true,
          placeholderFilled: true,
        },
        requestId,
      });
      return { id: existing.id, revision, created: false };
    }
    throw new AppError(
      409,
      "document_kind_exists",
      "This placement already has a document for that kind. Update the existing record.",
      { documentId: existing.id, kind: input.kind },
    );
  }

  const compatibleRequirement = input.kind === "other" ? null : db.prepare(`
    SELECT pr.id, pr.label
    FROM placements p
    JOIN programme_requirements pr
      ON pr.programme_version_id = p.programme_version_id
    LEFT JOIN placement_documents pd
      ON pd.placement_id = p.id
      AND pd.requirement_id = pr.id
      AND pd.superseded_at IS NULL
    WHERE p.id = ?
      AND p.school_id = ?
      AND pr.code = ? COLLATE NOCASE
      AND pd.id IS NULL
  `).get(placementId, user.schoolId, input.kind);
  const id = randomUUID();
  const now = new Date().toISOString();
  commitWithAudit(db, () => db.prepare(`
      INSERT INTO placement_documents (
        id, school_id, placement_id, kind, title, status, reference, due_date,
        requirement_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      user.schoolId,
      placementId,
      input.kind,
      compatibleRequirement?.label ?? input.title,
      input.status,
      input.reference ?? "",
      input.dueDate || null,
      compatibleRequirement?.id ?? null,
      now,
      now,
    ), {
    schoolId: user.schoolId,
    actorUserId: user.id,
    action: "document.created",
    entityType: "placement_document",
    entityId: id,
    metadata: {
      status: input.status,
      programmeRequirement: Boolean(compatibleRequirement),
    },
    requestId,
  });
  return { id, revision: 1, created: true };
}

export function updateTimeEntry(db, user, placementId, entryId, input, requestId) {
  const entry = db.prepare(`
    SELECT
      te.id,
      te.entry_date AS entryDate,
      te.minutes,
      te.description,
      te.verification_status AS verificationStatus,
      te.created_by AS createdBy,
      te.revision,
      p.start_date AS startDate,
      p.end_date AS endDate,
      p.student_id AS studentId,
      p.school_tutor_id AS schoolTutorId,
      p.status AS placementStatus
    FROM time_entries te
    JOIN placements p ON p.id = te.placement_id
    WHERE te.id = ? AND te.placement_id = ? AND p.school_id = ?
  `).get(entryId, placementId, user.schoolId);
  if (!entry) throw notFound("Time entry");
  if (!canWritePlacement(user, entry)) {
    throw new AppError(403, "forbidden", "This placement is outside your assigned scope.");
  }
  assertPlacementActivitiesMutable({ status: entry.placementStatus });
  const schoolWideWriter = hasPermission(user, "write");
  if (!schoolWideWriter && entry.createdBy !== user.id) {
    throw new AppError(403, "forbidden", "Tutors can correct only entries they recorded.");
  }
  if (
    !schoolWideWriter
    && input.verificationStatus !== undefined
    && input.verificationStatus !== "pending"
  ) {
    throw new AppError(
      403,
      "verification_required",
      "A coordinator or administrator must validate time entries.",
    );
  }
  if (entry.revision !== input.revision) {
    throw conflict("The time entry changed after it was loaded. Refresh and try again.");
  }
  const entryDate = input.entryDate ?? entry.entryDate;
  if (
    !isIsoDate(entryDate)
    || entryDate < entry.startDate
    || entryDate > entry.endDate
  ) {
    throw new AppError(
      422,
      "invalid_entry_date",
      "The time entry date must fall within the placement date range.",
    );
  }
  assertNotFutureSchoolDate(db, user.schoolId, entryDate);
  const minutes = input.hours === undefined ? entry.minutes : hoursToMinutes(input.hours);
  if (minutes > 1440) {
    throw new AppError(422, "invalid_hours", "A time entry cannot exceed 24 hours.");
  }
  const description = input.description ?? entry.description;
  const contentChanged = ["entryDate", "hours", "description"]
    .some((field) => input[field] !== undefined);
  const verificationStatus = schoolWideWriter
    ? input.verificationStatus ?? entry.verificationStatus
    : contentChanged ? "pending" : entry.verificationStatus;
  const changedFields = ["entryDate", "hours", "description", "verificationStatus"]
    .filter((field) => input[field] !== undefined || (!schoolWideWriter && field === "verificationStatus" && contentChanged));
  commitWithAudit(db, () => {
    assertStudentDailyMinutes(
      db,
      user.schoolId,
      entry.studentId,
      entryDate,
      minutes,
      verificationStatus,
      entryId,
    );
    const result = db.prepare(`
      UPDATE time_entries
      SET
        entry_date = ?,
        minutes = ?,
        description = ?,
        verification_status = ?,
        revision = revision + 1,
        updated_at = ?
      WHERE id = ? AND revision = ?
    `).run(
      entryDate,
      minutes,
      description,
      verificationStatus,
      new Date().toISOString(),
      entryId,
      input.revision,
    );
    if (result.changes !== 1) throw conflict("The time entry changed while it was being saved.");
  }, {
    schoolId: user.schoolId,
    actorUserId: user.id,
    action: "time_entry.updated",
    entityType: "time_entry",
    entityId: entryId,
    metadata: {
      status: verificationStatus,
      previousStatus: entry.verificationStatus,
      changedFields,
    },
    requestId,
  });
  return input.revision + 1;
}

export function updateCheckIn(db, user, placementId, checkInId, input, requestId) {
  const current = db.prepare(`
    SELECT
      ci.id,
      ci.occurred_at AS occurredAt,
      ci.channel,
      ci.summary,
      ci.next_action AS nextAction,
      ci.voided,
      ci.void_reason AS voidReason,
      ci.created_by AS createdBy,
      ci.revision,
      p.start_date AS startDate,
      p.end_date AS endDate,
      p.school_tutor_id AS schoolTutorId,
      p.status AS placementStatus
    FROM check_ins ci
    JOIN placements p ON p.id = ci.placement_id
    WHERE ci.id = ? AND ci.placement_id = ? AND p.school_id = ?
  `).get(checkInId, placementId, user.schoolId);
  if (!current) throw notFound("Check-in");
  if (!canWritePlacement(user, current)) {
    throw new AppError(403, "forbidden", "This placement is outside your assigned scope.");
  }
  assertPlacementActivitiesMutable({ status: current.placementStatus });
  if (current.voided === 1) {
    throw new AppError(
      409,
      "check_in_voided",
      "A voided check-in is immutable. Record a replacement check-in instead.",
    );
  }
  if (current.revision !== input.revision) {
    throw conflict("The check-in changed after it was loaded. Refresh and try again.");
  }
  if (
    !hasPermission(user, "write")
    && current.createdBy !== user.id
  ) {
    throw new AppError(403, "forbidden", "Tutors can correct only check-ins they recorded.");
  }
  if (input.voided === true && !hasPermission(user, "write")) {
    throw new AppError(
      403,
      "check_in_void_permission_required",
      "A coordinator or administrator must void a check-in.",
    );
  }
  if (input.voided === true) {
    const changedFields = Object.keys(input).filter((field) => field !== "revision");
    if (
      changedFields.length !== 2
      || !changedFields.includes("voided")
      || !changedFields.includes("voidReason")
    ) {
      throw new AppError(
        400,
        "invalid_check_in_void",
        "Voiding a check-in cannot also alter its original contents.",
      );
    }
  } else if (input.voidReason !== undefined) {
    throw new AppError(
      400,
      "invalid_check_in_void",
      "A void reason is accepted only when voiding a check-in.",
    );
  }
  const occurredAt = input.occurredAt ?? current.occurredAt;
  assertCheckInTime(db, user.schoolId, current, occurredAt);
  const values = {
    occurredAt,
    channel: input.channel ?? current.channel,
    summary: input.summary ?? current.summary,
    nextAction: input.nextAction ?? current.nextAction,
    voided: input.voided === true ? 1 : 0,
    voidReason: input.voided === true ? input.voidReason : "",
  };
  const changedFields = ["occurredAt", "channel", "summary", "nextAction", "voided", "voidReason"]
    .filter((field) => input[field] !== undefined);
  commitWithAudit(db, () => {
    const result = db.prepare(`
      UPDATE check_ins
      SET
        occurred_at = @occurredAt,
        channel = @channel,
        summary = @summary,
        next_action = @nextAction,
        voided = @voided,
        void_reason = @voidReason,
        revision = revision + 1,
        updated_at = @updatedAt
      WHERE id = @id AND placement_id = @placementId AND revision = @revision
    `).run({
      ...values,
      id: checkInId,
      placementId,
      revision: input.revision,
      updatedAt: new Date().toISOString(),
    });
    if (result.changes !== 1) throw conflict("The check-in changed while it was being saved.");
  }, {
    schoolId: user.schoolId,
    actorUserId: user.id,
    action: "check_in.updated",
    entityType: "check_in",
    entityId: checkInId,
    metadata: {
      status: values.voided === 1 ? "voided" : "active",
      changedFields,
    },
    requestId,
  });
  return input.revision + 1;
}

export function updateDocument(db, user, placementId, documentId, input, requestId) {
  const document = db.prepare(`
    SELECT
      pd.id,
      pd.kind,
      pd.title,
      pd.status,
      pd.reference,
      pd.due_date AS dueDate,
      pd.requirement_id AS requirementId,
      pd.superseded_at AS supersededAt,
      pd.superseded_by_id AS supersededById,
      pd.revision,
      p.start_date AS startDate,
      p.end_date AS endDate,
      p.school_tutor_id AS schoolTutorId,
      p.status AS placementStatus
    FROM placement_documents pd
    JOIN placements p ON p.id = pd.placement_id
    WHERE pd.id = ? AND pd.placement_id = ? AND p.school_id = ?
  `).get(documentId, placementId, user.schoolId);
  if (!document) throw notFound("Document");
  if (!canWritePlacement(user, document)) {
    throw new AppError(403, "forbidden", "This placement is outside your assigned scope.");
  }
  assertPlacementActivitiesMutable({ status: document.placementStatus });
  if (document.supersededAt !== null) {
    throw new AppError(409, "document_superseded", "Superseded evidence is immutable.");
  }
  if (document.revision !== input.revision) {
    throw conflict("The document changed after it was loaded. Refresh and try again.");
  }
  if (document.status === "archived") {
    throw new AppError(409, "document_frozen", "Archived evidence is immutable.");
  }
  if (
    document.requirementId !== null
    && (
      (input.kind !== undefined && input.kind !== document.kind)
      || (input.title !== undefined && input.title !== document.title)
    )
  ) {
    throw new AppError(
      409,
      "programme_requirement_locked",
      "The type and title of a programme requirement cannot be changed on one placement.",
    );
  }
  if (
    document.status === "signed"
    && (
      Object.keys(input).some((field) => !["revision", "status"].includes(field))
      || (input.status !== undefined && input.status !== "archived")
    )
  ) {
    throw new AppError(
      409,
      "document_frozen",
      "Signed evidence can only be archived or superseded with a preserved replacement record.",
    );
  }
  if (!hasPermission(user, "write") && document.status === "signed") {
    throw new AppError(
      403,
      "document_validation_required",
      "Validated documents can be changed only by a coordinator or administrator.",
    );
  }
  if (
    !hasPermission(user, "write")
    && input.status !== undefined
    && !["missing", "draft", "ready"].includes(input.status)
  ) {
    throw new AppError(
      403,
      "document_validation_required",
      "A coordinator or administrator must validate signed and archived documents.",
    );
  }
  const kind = input.kind ?? document.kind;
  if (kind !== "other" && kind !== document.kind) {
    const existing = db.prepare(`
      SELECT id
      FROM placement_documents
      WHERE school_id = ? AND placement_id = ? AND kind = ? AND id != ?
        AND superseded_at IS NULL
    `).get(user.schoolId, placementId, kind, documentId);
    if (existing) {
      throw new AppError(
        409,
        "document_kind_exists",
        "This placement already has a document for that kind.",
        { documentId: existing.id, kind },
      );
    }
  }
  const title = input.title ?? document.title;
  const status = input.status ?? document.status;
  if (
    status !== document.status
    && !DOCUMENT_STATUS_TRANSITIONS[document.status].has(status)
  ) {
    throw new AppError(
      422,
      "invalid_document_transition",
      `A document cannot move from ${document.status} to ${status}.`,
    );
  }
  const reference = input.reference ?? document.reference;
  const dueDate = input.dueDate === undefined ? document.dueDate : input.dueDate;
  assertDocumentDueDate(document, dueDate);
  commitWithAudit(db, () => {
    const result = db.prepare(`
      UPDATE placement_documents
      SET
        kind = ?,
        title = ?,
        status = ?,
        reference = ?,
        due_date = ?,
        revision = revision + 1,
        updated_at = ?
      WHERE id = ? AND revision = ?
    `).run(
      kind,
      title,
      status,
      reference,
      dueDate,
      new Date().toISOString(),
      documentId,
      input.revision,
    );
    if (result.changes !== 1) throw conflict("The document changed while it was being saved.");
  }, {
    schoolId: user.schoolId,
    actorUserId: user.id,
    action: "document.updated",
    entityType: "placement_document",
    entityId: documentId,
    metadata: {
      status,
      previousStatus: document.status,
      changedFields: ["kind", "title", "status", "reference", "dueDate"]
        .filter((field) => input[field] !== undefined),
    },
    requestId,
  });
  return input.revision + 1;
}

export function supersedeDocument(db, user, placementId, documentId, input, requestId) {
  requirePermission(user, "write");
  const document = db.prepare(`
    SELECT
      pd.id,
      pd.kind,
      pd.status,
      pd.requirement_id AS requirementId,
      pd.superseded_at AS supersededAt,
      pd.revision,
      p.start_date AS startDate,
      p.end_date AS endDate,
      p.status AS placementStatus
    FROM placement_documents pd
    JOIN placements p ON p.id = pd.placement_id
    WHERE pd.id = ? AND pd.placement_id = ? AND p.school_id = ?
  `).get(documentId, placementId, user.schoolId);
  if (!document) throw notFound("Document");
  assertPlacementActivitiesMutable({ status: document.placementStatus });
  if (document.revision !== input.revision) {
    throw conflict("The document changed after it was loaded. Refresh and try again.");
  }
  if (document.supersededAt !== null) {
    throw new AppError(409, "document_superseded", "This evidence was already superseded.");
  }
  if (!["signed", "archived"].includes(document.status)) {
    throw new AppError(
      409,
      "document_not_supersedable",
      "Only signed or archived evidence can be superseded with a preserved replacement record.",
    );
  }
  assertDocumentDueDate(document, input.dueDate);
  const replacementId = randomUUID();
  const now = new Date().toISOString();
  db.transaction(() => {
    const marked = db.prepare(`
      UPDATE placement_documents
      SET
        superseded_at = ?,
        supersede_reason_code = ?,
        revision = revision + 1,
        updated_at = ?
      WHERE id = ? AND revision = ? AND superseded_at IS NULL
    `).run(now, input.reasonCode, now, documentId, input.revision);
    if (marked.changes !== 1) {
      throw conflict("The document changed while it was being superseded.");
    }
    db.prepare(`
      INSERT INTO placement_documents (
        id, school_id, placement_id, kind, title, status, reference, due_date,
        requirement_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      replacementId,
      user.schoolId,
      placementId,
      document.kind,
      input.title,
      input.status,
      input.reference ?? "",
      input.dueDate || null,
      document.requirementId,
      now,
      now,
    );
    db.prepare(`
      UPDATE placement_documents
      SET superseded_by_id = ?
      WHERE id = ?
    `).run(replacementId, documentId);
    writeAudit(db, {
      schoolId: user.schoolId,
      actorUserId: user.id,
      action: "document.superseded",
      entityType: "placement_document",
      entityId: documentId,
      metadata: {
        status: input.status,
        reasonCode: input.reasonCode,
        oldId: documentId,
        newId: replacementId,
      },
      requestId,
    });
  })();
  return {
    id: replacementId,
    revision: 1,
    supersededId: documentId,
    supersededRevision: input.revision + 1,
  };
}

function auditRows(db, user, filters, limit, cursorCodec, cursor = null) {
  const binding = cursorBinding(user, "audit", {
    action: filters.action ?? "",
    actorId: filters.actorId ?? null,
    fromDate: filters.fromDate ?? null,
    toDate: filters.toDate ?? null,
  });
  const decoded = cursorCodec.decode(
    cursor,
    "audit",
    ["string", "string"],
    binding,
  );
  return db.prepare(`
    SELECT
      ae.id,
      ae.action,
      ae.entity_type AS entityType,
      ae.entity_id AS entityId,
      ae.metadata_json AS metadataJson,
      ae.request_id AS requestId,
      ae.created_at AS createdAt,
      COALESCE(u.display_name, 'System') AS actorName
    FROM audit_events ae
    LEFT JOIN users u ON u.id = ae.actor_user_id
    WHERE ae.school_id = @schoolId
      AND (@action = '' OR ae.action = @action)
      AND (@actorId IS NULL OR ae.actor_user_id = @actorId)
      AND (@fromDate IS NULL OR ae.created_at >= @fromDate)
      AND (@toDate IS NULL OR ae.created_at <= @toDate)
      AND (
        @cursorCreatedAt IS NULL
        OR ae.created_at < @cursorCreatedAt
        OR (ae.created_at = @cursorCreatedAt AND ae.id < @cursorId)
      )
    ORDER BY ae.created_at DESC, ae.id DESC
    LIMIT @limit
  `).all({
    schoolId: user.schoolId,
    action: filters.action ?? "",
    actorId: filters.actorId ?? null,
    fromDate: filters.fromDate ? `${filters.fromDate}T00:00:00.000Z` : null,
    toDate: filters.toDate ? `${filters.toDate}T23:59:59.999Z` : null,
    cursorCreatedAt: decoded?.[0] ?? null,
    cursorId: decoded?.[1] ?? null,
    limit,
  }).map(({ metadataJson, ...row }) => ({
    ...row,
    metadata: parseAuditMetadata(metadataJson),
  }));
}

export function listAuditEvents(db, user, filters = {}, cursorCodec) {
  requirePermission(user, "audit");
  const limit = filters.limit ?? 100;
  const rows = auditRows(
    db,
    user,
    filters,
    limit + 1,
    cursorCodec,
    filters.cursor,
  );
  const items = rows.slice(0, limit);
  const binding = cursorBinding(user, "audit", {
    action: filters.action ?? "",
    actorId: filters.actorId ?? null,
    fromDate: filters.fromDate ?? null,
    toDate: filters.toDate ?? null,
  });
  return {
    items,
    nextCursor: rows.length > limit && items.length > 0
      ? cursorCodec.encode(
          "audit",
          [items.at(-1).createdAt, items.at(-1).id],
          binding,
        )
      : null,
  };
}

function auditCsvCell(value) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^(?:[\t\r\n]|[\u0000-\u0020]*[=+\-@])/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function exportAuditEvents(db, user, filters, requestId, cursorCodec) {
  requirePermission(user, "audit");
  requirePermission(user, "export");
  const rows = auditRows(db, user, filters, 10_001, cursorCodec);
  if (rows.length > 10_000) {
    throw new AppError(
      422,
      "audit_export_limit",
      "Narrow the audit filters before exporting more than 10,000 events.",
    );
  }
  const columns = [
    "id",
    "createdAt",
    "action",
    "actorName",
    "entityType",
    "entityId",
    "requestId",
    "metadata",
  ];
  const body = [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => auditCsvCell(
      column === "metadata" ? JSON.stringify(row.metadata) : row[column],
    )).join(",")),
  ].join("\r\n");
  writeAudit(db, {
    schoolId: user.schoolId,
    actorUserId: user.id,
    action: "export.created",
    entityType: "export",
    metadata: { resource: "audit", rowCount: rows.length, count: rows.length, version: 1 },
    requestId,
  });
  return {
    filename: `vector-audit-${new Date().toISOString().slice(0, 10)}.csv`,
    body: `\uFEFF${body}\r\n`,
  };
}

const RETENTION_CANDIDATE_LIMIT = 1000;

function retentionSnapshot(db, schoolId, beforeDate) {
  const eligibility = `
    s.school_id = @schoolId
    AND s.active = 0
    AND (
      (
        NOT EXISTS (SELECT 1 FROM placements p WHERE p.student_id = s.id)
        AND s.updated_at < @beforeDate
      )
      OR (
        EXISTS (SELECT 1 FROM placements p WHERE p.student_id = s.id)
        AND NOT EXISTS (
          SELECT 1 FROM placements p
          WHERE p.student_id = s.id
            AND (
              p.status NOT IN ('complete', 'cancelled')
              OR p.end_date >= @beforeDate
            )
        )
      )
    )
  `;
  const rows = db.prepare(`
    SELECT
      s.id,
      s.external_ref AS externalRef,
      s.revision,
      s.updated_at AS updatedAt,
      (SELECT COUNT(*) FROM placements p WHERE p.student_id = s.id) AS placementCount,
      (SELECT MAX(p.end_date) FROM placements p WHERE p.student_id = s.id) AS lastPlacementEnd
    FROM students s
    WHERE ${eligibility}
      AND s.retention_hold = 0
    ORDER BY COALESCE(lastPlacementEnd, s.updated_at), s.id
    LIMIT @limit
  `).all({
    schoolId,
    beforeDate,
    limit: RETENTION_CANDIDATE_LIMIT + 1,
  });
  const hasMore = rows.length > RETENTION_CANDIDATE_LIMIT;
  const students = rows.slice(0, RETENTION_CANDIDATE_LIMIT);

  let held = 0;
  const heldHasher = createHash("sha256");
  for (const row of db.prepare(`
    SELECT s.id, s.revision, s.updated_at AS updatedAt
    FROM students s
    WHERE ${eligibility}
      AND s.retention_hold = 1
    ORDER BY s.id
  `).iterate({ schoolId, beforeDate })) {
    held += 1;
    heldHasher.update(JSON.stringify(row)).update("\n");
  }
  const heldFingerprint = heldHasher.digest("hex");
  const studentIds = students.map((row) => row.id);
  const placements = studentIds.length === 0 ? [] : db.prepare(`
    SELECT id, student_id AS studentId, revision, status, end_date AS endDate, updated_at AS updatedAt
    FROM placements
    WHERE student_id IN (${studentIds.map(() => "?").join(",")})
    ORDER BY id
  `).all(...studentIds);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({
      version: 2,
      beforeDate,
      hasMore,
      held,
      heldFingerprint,
      students,
      placements,
    }))
    .digest("hex");
  return {
    students,
    studentIds,
    placements,
    fingerprint,
    hasMore,
    held,
  };
}

function retentionResponse(snapshot, beforeDate, dryRun, deletedStudents = 0) {
  return {
    beforeDate,
    dryRun,
    deletedPlacements: dryRun ? 0 : snapshot.placements.length,
    deletedStudents,
    candidates: snapshot.studentIds.length,
    hasMore: snapshot.hasMore,
    held: snapshot.held,
    cleanupPending: false,
    fingerprint: snapshot.fingerprint,
    preview: snapshot.students.map((student) => ({
      id: student.id,
      externalRef: student.externalRef ?? null,
      placementCount: student.placementCount,
      lastPlacementEnd: student.lastPlacementEnd ?? null,
      updatedAt: student.updatedAt,
    })),
  };
}

function checkpointAfterRetention(db) {
  try {
    const [checkpoint] = db.pragma("wal_checkpoint(PASSIVE)");
    return Boolean(
      checkpoint?.busy > 0
      || (
        Number.isInteger(checkpoint?.log)
        && Number.isInteger(checkpoint?.checkpointed)
        && checkpoint.log > checkpoint.checkpointed
      )
    );
  } catch {
    return true;
  }
}

export function runRetention(
  db,
  user,
  { beforeDate, dryRun, fingerprint: approvedFingerprint },
  requestId,
) {
  requirePermission(user, "erase");
  if (!isIsoDate(beforeDate)) {
    throw new AppError(422, "invalid_retention_date", "Retention cut-off is not a valid date.");
  }

  if (dryRun) {
    const snapshot = db.transaction(() => retentionSnapshot(
      db,
      user.schoolId,
      beforeDate,
    ))();
    return {
      ...retentionResponse(snapshot, beforeDate, true),
    };
  }

  const result = db.transaction(() => {
    const snapshot = retentionSnapshot(db, user.schoolId, beforeDate);
    if (snapshot.fingerprint !== approvedFingerprint) {
      throw new AppError(
        409,
        "retention_snapshot_changed",
        "Retention candidates changed after the dry run. Review a new dry run.",
      );
    }
    if (snapshot.studentIds.length > 0) {
      const placeholders = snapshot.studentIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM placements WHERE student_id IN (${placeholders})`)
        .run(...snapshot.studentIds);
      db.prepare(`DELETE FROM students WHERE id IN (${placeholders})`)
        .run(...snapshot.studentIds);
    }
    writeAudit(db, {
      schoolId: user.schoolId,
      actorUserId: user.id,
      action: "retention.executed",
      entityType: "school",
      entityId: user.schoolId,
      metadata: {
        beforeDate,
        candidates: snapshot.studentIds.length,
        deletedPlacements: snapshot.placements.length,
        deletedStudents: snapshot.studentIds.length,
        dryRun: false,
        hasMore: snapshot.hasMore,
        held: snapshot.held,
        fingerprint: snapshot.fingerprint,
      },
      requestId,
    });
    return retentionResponse(
      snapshot,
      beforeDate,
      false,
      snapshot.studentIds.length,
    );
  })();
  result.cleanupPending = checkpointAfterRetention(db);
  return result;
}
