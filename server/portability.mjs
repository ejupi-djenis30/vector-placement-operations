import { randomUUID } from "node:crypto";
import { parse } from "csv-parse/sync";
import { writeAudit } from "./audit.mjs";
import {
  assertPlacementPeriodRange,
  listHosts,
  listPlacements,
  listStudents,
} from "./data.mjs";
import { AppError } from "./errors.mjs";
import {
  currentProgrammeVersionByCode,
  seedPlacementRequirements,
} from "./programmes.mjs";
import { hasPermission, requirePermission } from "./rbac.mjs";
import {
  assertDateRange,
  assertTargetMinutesFeasible,
  cleanText,
  hoursToMinutes,
  isIsoDate,
} from "./validation.mjs";

const RESOURCES = new Set(["students", "hosts", "placements"]);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATUSES = new Set(["planned", "active", "review", "complete", "cancelled"]);
const EXPORT_ROW_LIMIT = 10_000;
const IMPORT_HEADERS = Object.freeze({
  students: {
    required: ["externalRef", "firstName", "lastName"],
    allowed: [
      "externalRef",
      "firstName",
      "lastName",
      "email",
      "cohortName",
      "cohortAcademicYear",
    ],
  },
  hosts: {
    required: ["name"],
    allowed: [
      "name",
      "sector",
      "contactName",
      "contactEmail",
      "contactPhone",
      "address",
    ],
  },
  placements: {
    required: [
      "studentExternalRef",
      "hostName",
      "startDate",
      "endDate",
      "targetHours",
    ],
    allowed: [
      "studentExternalRef",
      "hostName",
      "programmeCode",
      "periodName",
      "schoolTutorEmail",
      "hostTutorName",
      "hostTutorEmail",
      "startDate",
      "endDate",
      "targetHours",
      "status",
      "notes",
    ],
  },
});

function csvCell(value) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^(?:[\t\r\n]|[\u0000-\u0020]*[=+\-@])/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csv(rows) {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  return [
    headers.map(csvCell).join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
  ].join("\r\n");
}

function importError(row, field, code) {
  return { row, field, code };
}

function safeText(value, maxLength, row, field, errors) {
  try {
    return cleanText(value, maxLength);
  } catch {
    errors.push(importError(row, field, "field_too_long"));
    return "";
  }
}

function optionalEmail(value, row, field, errors) {
  const normalized = safeText(value, 254, row, field, errors);
  if (normalized && !EMAIL.test(normalized)) errors.push(importError(row, field, "invalid_email"));
  return normalized;
}

function parseCsv(text, resource) {
  if (typeof text !== "string" || !text.trim()) {
    throw new AppError(422, "empty_csv", "The CSV file is empty.");
  }
  let headers = [];
  try {
    const rows = parse(text, {
      bom: true,
      columns: (rawHeaders) => {
        headers = rawHeaders.map((header) => header.trim());
        return headers;
      },
      skip_empty_lines: true,
      trim: true,
      max_record_size: 32_768,
      relax_column_count: false,
    });
    const contract = IMPORT_HEADERS[resource];
    const unknown = headers.filter((header) => !contract.allowed.includes(header));
    const missing = contract.required.filter((header) => !headers.includes(header));
    const duplicate = [...new Set(
      headers.filter((header, index) => headers.indexOf(header) !== index),
    )];
    if (unknown.length > 0 || missing.length > 0 || duplicate.length > 0) {
      throw new AppError(
        422,
        "invalid_csv_headers",
        "The CSV headers do not match the selected import resource.",
        { unknown, missing, duplicate, expected: contract.allowed },
      );
    }
    if (rows.length === 0) {
      throw new AppError(422, "empty_csv", "The CSV file does not contain any data rows.");
    }
    return rows;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(422, "invalid_csv", "The CSV file could not be parsed.");
  }
}

function resolveReference(rows, row, field, errors) {
  if (rows.length === 0) {
    errors.push(importError(row, field, "reference_not_found"));
    return "";
  }
  if (rows.length > 1) {
    errors.push(importError(row, field, "reference_ambiguous"));
    return "";
  }
  if (rows[0].active !== 1) {
    errors.push(importError(row, field, "reference_inactive"));
    return "";
  }
  return rows[0].id;
}

function resolveCohort(db, user, name, academicYear, row, errors) {
  if (!name && !academicYear) return null;
  if (!name || !academicYear) {
    errors.push(importError(row, !name ? "cohortName" : "cohortAcademicYear", "paired_reference_required"));
    return "";
  }
  return resolveReference(db.prepare(`
    SELECT id, active
    FROM cohorts
    WHERE school_id = ?
      AND name = ? COLLATE NOCASE
      AND academic_year = ? COLLATE NOCASE
    ORDER BY id
    LIMIT 2
  `).all(user.schoolId, name, academicYear), row, "cohortName", errors);
}

function resolvePlacementReferences(
  db,
  user,
  { studentExternalRef, hostName, periodName, schoolTutorEmail },
  row,
  errors,
) {
  const studentId = studentExternalRef
    ? resolveReference(db.prepare(`
        SELECT id, active
        FROM students
        WHERE school_id = ? AND external_ref = ? COLLATE NOCASE
        ORDER BY id
        LIMIT 2
      `).all(user.schoolId, studentExternalRef), row, "studentExternalRef", errors)
    : "";
  const hostId = hostName
    ? resolveReference(db.prepare(`
        SELECT id, active
        FROM hosts
        WHERE school_id = ? AND name = ? COLLATE NOCASE
        ORDER BY id
        LIMIT 2
      `).all(user.schoolId, hostName), row, "hostName", errors)
    : "";
  const periodId = periodName
    ? resolveReference(db.prepare(`
        SELECT id, active
        FROM placement_periods
        WHERE school_id = ? AND name = ? COLLATE NOCASE
        ORDER BY id
        LIMIT 2
      `).all(user.schoolId, periodName), row, "periodName", errors)
    : null;
  const schoolTutorId = schoolTutorEmail
    ? resolveReference(db.prepare(`
        SELECT id, active
        FROM users
        WHERE school_id = ?
          AND email = ? COLLATE NOCASE
          AND role IN ('school_admin', 'coordinator', 'tutor')
        ORDER BY id
        LIMIT 2
      `).all(user.schoolId, schoolTutorEmail), row, "schoolTutorEmail", errors)
    : null;
  return { studentId, hostId, periodId, schoolTutorId };
}

function validateStudentRows(db, user, rows) {
  const errors = [];
  const seen = new Set();
  const records = rows.map((row, index) => {
    const number = index + 2;
    const externalRef = safeText(row.externalRef, 160, number, "externalRef", errors);
    const firstName = safeText(row.firstName, 120, number, "firstName", errors);
    const lastName = safeText(row.lastName, 120, number, "lastName", errors);
    const cohortName = safeText(row.cohortName, 160, number, "cohortName", errors);
    const cohortAcademicYear = safeText(
      row.cohortAcademicYear,
      20,
      number,
      "cohortAcademicYear",
      errors,
    );
    if (!externalRef) errors.push(importError(number, "externalRef", "required"));
    if (!firstName) errors.push(importError(number, "firstName", "required"));
    if (!lastName) errors.push(importError(number, "lastName", "required"));
    if (externalRef && seen.has(externalRef.toLowerCase())) {
      errors.push(importError(number, "externalRef", "duplicate_in_file"));
    }
    if (externalRef) seen.add(externalRef.toLowerCase());
    if (externalRef && db.prepare(
      "SELECT 1 FROM students WHERE school_id = ? AND external_ref = ?",
    ).get(user.schoolId, externalRef)) {
      errors.push(importError(number, "externalRef", "already_exists"));
    }
    const cohortId = resolveCohort(
      db,
      user,
      cohortName,
      cohortAcademicYear,
      number,
      errors,
    );
    return {
      id: randomUUID(),
      externalRef,
      firstName,
      lastName,
      email: optionalEmail(row.email, number, "email", errors),
      cohortId: cohortId || null,
    };
  });
  return { errors, records };
}

function validateHostRows(db, user, rows) {
  const errors = [];
  const seen = new Set();
  const records = rows.map((row, index) => {
    const number = index + 2;
    const name = safeText(row.name, 200, number, "name", errors);
    if (!name) errors.push(importError(number, "name", "required"));
    if (name && seen.has(name.toLowerCase())) {
      errors.push(importError(number, "name", "duplicate_in_file"));
    }
    if (name) seen.add(name.toLowerCase());
    if (name && db.prepare(
      "SELECT 1 FROM hosts WHERE school_id = ? AND name = ? COLLATE NOCASE",
    ).get(user.schoolId, name)) {
      errors.push(importError(number, "name", "already_exists"));
    }
    return {
      id: randomUUID(),
      name,
      sector: safeText(row.sector, 160, number, "sector", errors),
      contactName: safeText(row.contactName, 160, number, "contactName", errors),
      contactEmail: optionalEmail(row.contactEmail, number, "contactEmail", errors),
      contactPhone: safeText(row.contactPhone, 80, number, "contactPhone", errors),
      address: safeText(row.address, 500, number, "address", errors),
    };
  });
  return { errors, records };
}

function validatePlacementRows(db, user, rows) {
  const errors = [];
  const seen = new Set();
  const records = rows.map((row, index) => {
    const number = index + 2;
    const studentExternalRef = safeText(
      row.studentExternalRef,
      160,
      number,
      "studentExternalRef",
      errors,
    );
    const hostName = safeText(row.hostName, 200, number, "hostName", errors);
    const programmeCode = safeText(
      row.programmeCode,
      40,
      number,
      "programmeCode",
      errors,
    ) || "VECTOR_DEFAULT";
    const periodName = safeText(row.periodName, 160, number, "periodName", errors);
    const schoolTutorEmail = optionalEmail(
      row.schoolTutorEmail,
      number,
      "schoolTutorEmail",
      errors,
    );
    const startDate = safeText(row.startDate, 10, number, "startDate", errors);
    const endDate = safeText(row.endDate, 10, number, "endDate", errors);
    const status = safeText(row.status, 20, number, "status", errors) || "planned";
    for (const [field, value] of [
      ["studentExternalRef", studentExternalRef],
      ["hostName", hostName],
      ["programmeCode", programmeCode],
    ]) {
      if (!value) errors.push(importError(number, field, "required"));
    }
    const { studentId, hostId, periodId, schoolTutorId } = resolvePlacementReferences(
      db,
      user,
      {
        studentExternalRef,
        hostName,
        periodName,
        schoolTutorEmail: EMAIL.test(schoolTutorEmail) ? schoolTutorEmail : "",
      },
      number,
      errors,
    );
    const programmeVersion = programmeCode
      ? currentProgrammeVersionByCode(db, user.schoolId, programmeCode)
      : null;
    if (programmeCode && !programmeVersion) {
      errors.push(importError(number, "programmeCode", "reference_not_found_or_inactive"));
    }
    if (!isIsoDate(startDate) || !isIsoDate(endDate) || endDate < startDate) {
      errors.push(importError(number, "dates", "invalid_date_range"));
    } else {
      try {
        assertPlacementPeriodRange(
          db,
          user,
          periodId || null,
          startDate,
          endDate,
        );
      } catch {
        errors.push(importError(number, "dates", "outside_period"));
      }
    }
    if (!STATUSES.has(status)) errors.push(importError(number, "status", "invalid_status"));
    if (status === "complete") {
      errors.push(importError(number, "status", "completion_evidence_required"));
    }
    const placementKey = [studentId, hostId, startDate].join("\u0000").toLowerCase();
    if (studentId && hostId && startDate) {
      if (seen.has(placementKey)) {
        errors.push(importError(number, "placement", "duplicate_in_file"));
      }
      seen.add(placementKey);
    }
    let targetMinutes = 0;
    try {
      targetMinutes = hoursToMinutes(row.targetHours);
      if (isIsoDate(startDate) && isIsoDate(endDate) && endDate >= startDate) {
        assertTargetMinutesFeasible(startDate, endDate, targetMinutes);
      }
    } catch {
      errors.push(importError(number, "targetHours", "invalid_or_impossible_hours"));
    }
    const hostTutorEmail = optionalEmail(
      row.hostTutorEmail,
      number,
      "hostTutorEmail",
      errors,
    );
    if (studentId && hostId && startDate && db.prepare(`
      SELECT 1
      FROM placements
      WHERE school_id = ? AND student_id = ? AND host_id = ? AND start_date = ?
    `).get(user.schoolId, studentId, hostId, startDate)) {
      errors.push(importError(number, "placement", "already_exists"));
    }
    return {
      id: randomUUID(),
      studentId,
      hostId,
      periodId: periodId || null,
      schoolTutorId: schoolTutorId || null,
      programmeVersionId: programmeVersion?.id ?? "",
      programmeCode: programmeVersion?.programmeCode ?? programmeCode,
      hostTutorName: safeText(row.hostTutorName, 120, number, "hostTutorName", errors),
      hostTutorEmail,
      startDate,
      endDate,
      targetMinutes,
      status,
      notes: safeText(row.notes, 4000, number, "notes", errors),
    };
  });
  return { errors, records };
}

function validateRows(db, user, resource, rows) {
  if (rows.length > 10_000) {
    throw new AppError(422, "too_many_rows", "An import cannot contain more than 10,000 rows.");
  }
  if (resource === "students") return validateStudentRows(db, user, rows);
  if (resource === "hosts") return validateHostRows(db, user, rows);
  return validatePlacementRows(db, user, rows);
}

function insertRows(db, user, resource, records, requestId) {
  const now = new Date().toISOString();
  db.transaction(() => {
    if (resource === "students") {
      const statement = db.prepare(`
        INSERT INTO students (
          id, school_id, cohort_id, external_ref, first_name, last_name,
          email, active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `);
      for (const record of records) {
        statement.run(
          record.id,
          user.schoolId,
          record.cohortId,
          record.externalRef,
          record.firstName,
          record.lastName,
          record.email || null,
          now,
          now,
        );
      }
    } else if (resource === "hosts") {
      const statement = db.prepare(`
        INSERT INTO hosts (
          id, school_id, name, sector, contact_name, contact_email,
          contact_phone, address, active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `);
      for (const record of records) {
        statement.run(
          record.id,
          user.schoolId,
          record.name,
          record.sector,
          record.contactName,
          record.contactEmail || null,
          record.contactPhone || null,
          record.address,
          now,
          now,
        );
      }
    } else {
      const statement = db.prepare(`
        INSERT INTO placements (
          id, school_id, student_id, host_id, period_id, school_tutor_id,
          host_tutor_name, host_tutor_email, start_date, end_date,
          target_minutes, status, notes, programme_version_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const record of records) {
        assertDateRange(record.startDate, record.endDate);
        statement.run(
          record.id,
          user.schoolId,
          record.studentId,
          record.hostId,
          record.periodId,
          record.schoolTutorId,
          record.hostTutorName,
          record.hostTutorEmail || null,
          record.startDate,
          record.endDate,
          record.targetMinutes,
          record.status,
          record.notes,
          record.programmeVersionId,
          now,
          now,
        );
        seedPlacementRequirements(
          db,
          user.schoolId,
          record.id,
          record.programmeVersionId,
          now,
        );
      }
    }
    writeAudit(db, {
      schoolId: user.schoolId,
      actorUserId: user.id,
      action: "import.committed",
      entityType: "import",
      metadata: {
        resource,
        rowCount: records.length,
        imported: records.length,
        rejected: 0,
        dryRun: false,
        version: 1,
      },
      requestId,
    });
  })();
}

export function importCsv(db, user, resource, text, { dryRun }, requestId) {
  requirePermission(user, "import");
  if (!RESOURCES.has(resource)) throw new AppError(404, "unknown_resource", "Import resource not found.");
  const rows = parseCsv(text, resource);
  const { errors, records } = validateRows(db, user, resource, rows);
  if (errors.length > 0) {
    throw new AppError(
      422,
      "import_rejected",
      "The import contains invalid rows. No records were changed.",
      { errorCount: errors.length, errors: errors.slice(0, 500) },
    );
  }
  if (!dryRun) insertRows(db, user, resource, records, requestId);
  return {
    resource,
    dryRun,
    accepted: records.length,
    rejected: 0,
    errors: [],
  };
}

export function importTemplate(user, resource) {
  requirePermission(user, "import");
  if (!RESOURCES.has(resource)) {
    throw new AppError(404, "unknown_resource", "Import resource not found.");
  }
  return {
    filename: `vector-${resource}-import-template.csv`,
    contentType: "text/csv; charset=utf-8",
    body: `\uFEFF${IMPORT_HEADERS[resource].allowed.map(csvCell).join(",")}\r\n`,
  };
}

function exportRows(
  db,
  user,
  resource,
  { query = "", active = "all", status = "all" } = {},
  cursorCodec,
) {
  const collect = (load) => {
    const items = [];
    let cursor;
    do {
      const page = load({ limit: 100, cursor });
      if (
        items.length + page.items.length > EXPORT_ROW_LIMIT
        || (
          items.length + page.items.length === EXPORT_ROW_LIMIT
          && page.nextCursor
        )
      ) {
        throw new AppError(
          422,
          "export_row_limit",
          `Narrow the data set before exporting more than ${EXPORT_ROW_LIMIT} records.`,
          { count: EXPORT_ROW_LIMIT },
        );
      }
      items.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return items;
  };
  if (resource === "students") {
    return collect((options) => listStudents(db, user, {
      ...options,
      query,
      active,
    }, cursorCodec)).map((student) => ({
      id: student.id,
      externalRef: student.externalRef,
      firstName: student.firstName,
      lastName: student.lastName,
      email: student.email,
      cohortId: student.cohortId,
      cohortName: student.cohortName,
      active: student.active,
    }));
  }
  if (resource === "hosts") {
    return collect((options) => listHosts(db, user, {
      ...options,
      query,
      active,
    }, cursorCodec)).map((host) => ({
      id: host.id,
      name: host.name,
      sector: host.sector,
      contactName: host.contactName,
      contactEmail: host.contactEmail,
      contactPhone: host.contactPhone,
      address: host.address,
      active: host.active,
    }));
  }
  return collect((options) => listPlacements(db, user, {
    ...options,
    query,
    status,
  }, cursorCodec)).map((placement) => ({
    id: placement.id,
    studentId: placement.studentId,
    studentName: placement.studentName,
    hostId: placement.hostId,
    hostName: placement.hostName,
    schoolTutorId: placement.schoolTutorId,
    schoolTutorName: placement.schoolTutorName,
    programmeCode: placement.programmeCode,
    programmeName: placement.programmeName,
    programmeVersion: placement.programmeVersion,
    startDate: placement.startDate,
    endDate: placement.endDate,
    targetHours: placement.targetHours,
    loggedHours: placement.loggedHours,
    status: placement.status,
    revision: placement.revision,
  }));
}

export function exportData(
  db,
  user,
  { resource, format, query, active, status },
  requestId,
  cursorCodec,
) {
  if (!RESOURCES.has(resource)) throw new AppError(404, "unknown_resource", "Export resource not found.");
  if (!hasPermission(user, "export") && !hasPermission(user, "export_assigned")) {
    throw new AppError(403, "forbidden", "You do not have permission to export data.");
  }
  const rows = db.transaction(() => exportRows(
    db,
    user,
    resource,
    { query, active, status },
    cursorCodec,
  ))();
  writeAudit(db, {
    schoolId: user.schoolId,
    actorUserId: user.id,
    action: "export.created",
    entityType: "export",
    metadata: { resource, rowCount: rows.length, count: rows.length, version: 1 },
    requestId,
  });
  const date = new Date().toISOString().slice(0, 10);
  if (format === "csv") {
    return {
      filename: `vector-${resource}-${date}.csv`,
      contentType: "text/csv; charset=utf-8",
      body: `\uFEFF${csv(rows)}\r\n`,
    };
  }
  return {
    filename: `vector-${resource}-${date}.json`,
    contentType: "application/json; charset=utf-8",
    body: `${JSON.stringify({ version: 1, resource, exportedAt: new Date().toISOString(), rows }, null, 2)}\n`,
  };
}
