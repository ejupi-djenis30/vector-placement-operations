import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { startTestApp } from "../test-support/server-test-helper.mjs";
import { importCsv } from "../server/portability.mjs";
import { parseArgs } from "./cli-args.mjs";

parseArgs();
const temporaryDirectory = path.resolve(tmpdir());
const databasePath = path.join(
  temporaryDirectory,
  `vector-scale-audit-${process.pid}-${Date.now()}.sqlite`,
);
assert.equal(
  path.dirname(path.resolve(databasePath)),
  temporaryDirectory,
  "The scale audit database must stay directly inside the system temporary directory.",
);
const counts = Object.freeze({
  cohorts: 20,
  students: 5_000,
  hosts: 500,
  audit: 9_000,
});
const now = "2026-07-31T12:00:00.000Z";

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

function bytes(value) {
  return Buffer.byteLength(
    typeof value === "string" ? value : JSON.stringify(value),
    "utf8",
  );
}

async function collectTimings(client, requestPath, iterations = 7) {
  for (let index = 0; index < 2; index += 1) {
    const warm = await client.request(requestPath);
    if (!warm.response.ok) {
      throw new Error(`Warm-up failed for ${requestPath}: ${warm.response.status}`);
    }
  }
  const values = [];
  let responseBytes = 0;
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    const result = await client.request(requestPath);
    values.push(performance.now() - startedAt);
    if (!result.response.ok) {
      throw new Error(`${requestPath} failed: ${result.response.status} ${JSON.stringify(result.payload)}`);
    }
    responseBytes = bytes(result.payload);
  }
  return {
    p50Ms: Number(percentile(values, 0.5).toFixed(2)),
    p95Ms: Number(percentile(values, 0.95).toFixed(2)),
    maxMs: Number(Math.max(...values).toFixed(2)),
    responseBytes,
  };
}

function seedDatabase(db) {
  const school = db.prepare("SELECT id FROM schools LIMIT 1").get();
  const admin = db.prepare(
    "SELECT id, email FROM users WHERE school_id = ? AND role = 'school_admin' LIMIT 1",
  ).get(school.id);
  const programmeVersion = db.prepare(`
    SELECT pv.id
    FROM programme_versions pv
    JOIN programmes p ON p.id = pv.programme_id
    WHERE p.school_id = ?
    ORDER BY pv.version DESC
    LIMIT 1
  `).get(school.id);
  const requirements = db.prepare(`
    SELECT id, code
    FROM programme_requirements
    WHERE programme_version_id = ?
    ORDER BY sort_order
  `).all(programmeVersion.id);

  const insertCohort = db.prepare(`
    INSERT INTO cohorts (
      id, school_id, name, academic_year, track, tutor_user_id,
      active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);
  const insertStudent = db.prepare(`
    INSERT INTO students (
      id, school_id, cohort_id, external_ref, first_name, last_name,
      email, active, retention_hold, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `);
  const insertHost = db.prepare(`
    INSERT INTO hosts (
      id, school_id, name, sector, contact_name, contact_email,
      contact_phone, address, active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);
  const insertPeriod = db.prepare(`
    INSERT INTO placement_periods (
      id, school_id, name, start_date, end_date, active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `);
  const insertPlacement = db.prepare(`
    INSERT INTO placements (
      id, school_id, student_id, host_id, period_id, school_tutor_id,
      host_tutor_name, host_tutor_email, start_date, end_date, target_minutes,
      status, notes, programme_version_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTime = db.prepare(`
    INSERT INTO time_entries (
      id, school_id, placement_id, entry_date, minutes, description,
      verification_status, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertCheckIn = db.prepare(`
    INSERT INTO check_ins (
      id, school_id, placement_id, occurred_at, channel, summary, next_action,
      voided, void_reason, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, '', ?, ?, ?)
  `);
  const insertDocument = db.prepare(`
    INSERT INTO placement_documents (
      id, school_id, placement_id, kind, title, status, reference, due_date,
      requirement_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?)
  `);
  const insertAudit = db.prepare(`
    INSERT INTO audit_events (
      id, school_id, actor_user_id, action, entity_type, entity_id,
      metadata_json, request_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let placementCount = 0;
  let timeEntryCount = 0;
  let checkInCount = 0;
  let documentCount = 0;
  db.transaction(() => {
    for (let index = 0; index < counts.cohorts; index += 1) {
      insertCohort.run(
        `cohort-${String(index).padStart(2, "0")}`,
        school.id,
        `Scale cohort ${String(index).padStart(2, "0")}`,
        "2026/2027",
        `Track ${index % 4}`,
        admin.id,
        now,
        now,
      );
    }
    insertPeriod.run(
      "period-scale",
      school.id,
      "Scale period 2026",
      "2026-01-01",
      "2026-12-31",
      now,
      now,
    );
    for (let index = 0; index < counts.hosts; index += 1) {
      const padded = String(index).padStart(4, "0");
      insertHost.run(
        `host-${padded}`,
        school.id,
        `Host organisation ${padded}`,
        `Sector ${index % 12}`,
        `Contact ${padded}`,
        `contact-${padded}@example.test`,
        `+41000${padded}`,
        `${padded} Synthetic Street`,
        now,
        now,
      );
    }
    for (let index = 0; index < counts.students; index += 1) {
      const padded = String(index).padStart(5, "0");
      insertStudent.run(
        `student-${padded}`,
        school.id,
        `cohort-${String(index % counts.cohorts).padStart(2, "0")}`,
        `SCALE-${padded}`,
        `First${String(index % 200).padStart(3, "0")}`,
        `Last${String((index * 37) % 700).padStart(3, "0")}`,
        `student-${padded}@example.test`,
        index % 97 === 0 ? 1 : 0,
        now,
        now,
      );
    }

    const statuses = ["planned", "active", "review", "complete", "cancelled"];
    const addPlacement = (studentIndex, sequence) => {
      const placementIndex = placementCount;
      const placementId = `placement-${String(placementIndex).padStart(6, "0")}`;
      const hostIndex = (studentIndex + sequence * 137) % counts.hosts;
      const hostId = `host-${String(hostIndex).padStart(4, "0")}`;
      const status = statuses[(studentIndex + sequence) % statuses.length];
      const startDate = sequence === 0 ? "2026-07-01" : "2026-07-15";
      const endDate = sequence === 0 ? "2026-08-10" : "2026-08-30";
      insertPlacement.run(
        placementId,
        school.id,
        `student-${String(studentIndex).padStart(5, "0")}`,
        hostId,
        "period-scale",
        placementIndex % 7 === 0 ? null : admin.id,
        `Host tutor ${hostIndex}`,
        `tutor-${hostIndex}@example.test`,
        startDate,
        endDate,
        9_600,
        status,
        "",
        programmeVersion.id,
        now,
        now,
      );
      placementCount += 1;

      for (let entry = 0; entry < 2; entry += 1) {
        insertTime.run(
          `time-${String(timeEntryCount).padStart(7, "0")}`,
          school.id,
          placementId,
          `2026-07-${String(5 + entry).padStart(2, "0")}`,
          1_200,
          "Synthetic scale activity",
          entry === 0 ? "verified" : "pending",
          admin.id,
          now,
          now,
        );
        timeEntryCount += 1;
      }
      insertCheckIn.run(
        `checkin-${String(checkInCount).padStart(7, "0")}`,
        school.id,
        placementId,
        "2026-07-20T09:00:00.000Z",
        "video",
        "Synthetic check-in",
        "Synthetic follow-up",
        admin.id,
        now,
        now,
      );
      checkInCount += 1;

      for (let requirementIndex = 0; requirementIndex < requirements.length; requirementIndex += 1) {
        const requirement = requirements[requirementIndex];
        const kind = requirement.code;
        const statusForDocument = (placementIndex + requirementIndex) % 4 === 0
          ? "signed"
          : requirementIndex === 0 ? "draft" : "missing";
        insertDocument.run(
          `document-${String(documentCount).padStart(7, "0")}`,
          school.id,
          placementId,
          kind,
          `Required ${kind}`,
          statusForDocument,
          "2026-08-05",
          requirement.id,
          now,
          now,
        );
        documentCount += 1;
      }
    };

    for (let index = 0; index < counts.students; index += 1) {
      if (index % 10 !== 0) addPlacement(index, 0);
      if (index % 5 === 1) addPlacement(index, 1);
    }
    for (let index = 0; index < counts.audit; index += 1) {
      insertAudit.run(
        `audit-scale-${String(index).padStart(6, "0")}`,
        school.id,
        admin.id,
        index % 3 === 0 ? "placement.updated" : "student.updated",
        index % 3 === 0 ? "placement" : "student",
        `entity-${index % counts.students}`,
        JSON.stringify({ count: index % 100, status: statuses[index % statuses.length] }),
        `scale-request-${index % 100}`,
        new Date(Date.UTC(2026, 0, 1) + index * 1_000).toISOString(),
      );
    }
  })();

  return {
    school,
    admin,
    programmeVersion,
    requirements,
    placementCount,
    timeEntryCount,
    checkInCount,
    documentCount,
  };
}

function queryPlans(db, schoolId) {
  const plan = (sql, ...parameters) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...parameters)
    .map((row) => row.detail);
  return {
    students: plan(`
      SELECT id
      FROM students
      WHERE school_id = ?
      ORDER BY LOWER(last_name), LOWER(first_name), id
      LIMIT 101
    `, schoolId),
    hosts: plan(`
      SELECT id
      FROM hosts
      WHERE school_id = ?
      ORDER BY LOWER(name), id
      LIMIT 101
    `, schoolId),
    audit: plan(`
      SELECT id
      FROM audit_events
      WHERE school_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 201
    `, schoolId),
    placements: plan(`
      SELECT p.id
      FROM placements p
      JOIN students s ON s.id = p.student_id
      WHERE p.school_id = ?
      ORDER BY
        CASE p.status
          WHEN 'review' THEN 0
          WHEN 'active' THEN 1
          WHEN 'planned' THEN 2
          WHEN 'complete' THEN 3
          ELSE 4
        END,
        p.start_date,
        LOWER(s.first_name || ' ' || s.last_name),
        p.id
      LIMIT 101
    `, schoolId),
    dashboard: plan(`
      SELECT
        p.status,
        p.target_minutes,
        COALESCE((
          SELECT SUM(te.minutes)
          FROM time_entries te
          WHERE te.placement_id = p.id AND te.verification_status != 'rejected'
        ), 0)
      FROM placements p
      WHERE p.school_id = ?
    `, schoolId),
  };
}

function buildStudentCsv(rowCount) {
  const lines = ["externalRef,firstName,lastName,email,cohortName,cohortAcademicYear"];
  for (let index = 0; index < rowCount; index += 1) {
    const padded = String(index).padStart(5, "0");
    lines.push(
      `IMPORT-${padded},Import${padded},Student${padded},import-${padded}@example.test,Scale cohort 00,2026/2027`,
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

function buildPlacementCsv(rowCount) {
  const lines = [
    "studentExternalRef,hostName,programmeCode,periodName,schoolTutorEmail,hostTutorName,hostTutorEmail,startDate,endDate,targetHours,status,notes",
  ];
  for (let index = 0; index < rowCount; index += 1) {
    const student = String(index * 2 + 1).padStart(5, "0");
    const host = String((index + 211) % counts.hosts).padStart(4, "0");
    lines.push(
      `SCALE-${student},Host organisation ${host},VECTOR_DEFAULT,Scale period 2026,admin@example.test,Import tutor,import-tutor@example.test,2026-09-01,2026-10-31,80,planned,`,
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

async function measureImport(db, user, resource, csvText) {
  const originalPrepare = db.prepare;
  let prepareCount = 0;
  db.prepare = function countedPrepare(...arguments_) {
    prepareCount += 1;
    return originalPrepare.apply(this, arguments_);
  };
  const startedAt = performance.now();
  try {
    const result = importCsv(
      db,
      user,
      resource,
      csvText,
      { dryRun: true },
      "scale-import",
    );
    return {
      accepted: result.accepted,
      durationMs: Number((performance.now() - startedAt).toFixed(2)),
      prepareCount,
    };
  } finally {
    db.prepare = originalPrepare;
  }
}

async function main() {
  let initializer;
  let production;
  try {
    initializer = await startTestApp({ databasePath });
    const fixture = seedDatabase(initializer.db);
    await initializer.close();
    initializer = undefined;

    production = await startTestApp({
      databasePath,
      env: {
        NODE_ENV: "production",
        VECTOR_BOOTSTRAP_ADMIN_PASSWORD: undefined,
        VECTOR_BODY_LIMIT: "2097152",
      },
      logLevel: "silent",
    });
    const fixtureTableCounts = Object.fromEntries(
      [
        "students",
        "hosts",
        "placements",
        "time_entries",
        "check_ins",
        "placement_documents",
        "audit_events",
      ].map((table) => [
        table,
        production.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
      ]),
    );
    assert.deepEqual(
      fixtureTableCounts,
      {
        students: counts.students,
        hosts: counts.hosts,
        placements: fixture.placementCount,
        time_entries: fixture.timeEntryCount,
        check_ins: fixture.checkInCount,
        placement_documents: fixture.documentCount,
        audit_events: counts.audit + 1,
      },
      "The production audit must open the complete deterministic fixture.",
    );
    const login = await production.client.login();
    if (!login.response.ok) throw new Error(`Login failed: ${login.response.status}`);

    global.gc?.();
    const memoryBefore = process.memoryUsage();
    const endpoints = {};
    for (const [name, requestPath] of [
      ["dashboard", "/api/dashboard"],
      ["attention", "/api/attention?limit=100"],
      ["coverage", "/api/coverage?cohortId=cohort-00&periodId=period-scale&limit=100"],
      ["placements", "/api/placements?limit=100"],
      ["students", "/api/students?limit=100"],
      ["hosts", "/api/hosts?limit=100"],
      ["audit", "/api/audit?limit=200"],
    ]) {
      endpoints[name] = await collectTimings(production.client, requestPath);
    }
    const exportMetrics = await collectTimings(
      production.client,
      "/api/export?resource=students&format=json",
      3,
    );
    global.gc?.();
    const memoryAfter = process.memoryUsage();

    const user = {
      id: fixture.admin.id,
      schoolId: fixture.school.id,
      role: "school_admin",
      dataScope: "school",
      active: true,
    };
    const studentImport = await measureImport(
      production.db,
      user,
      "students",
      buildStudentCsv(1_000),
    );
    const placementImport = await measureImport(
      production.db,
      user,
      "placements",
      buildPlacementCsv(500),
    );

    const concurrencyStartedAt = performance.now();
    const concurrent = await Promise.all(
      Array.from({ length: 20 }, (_, index) => production.client.request(
        index % 2 === 0
          ? "/api/students?limit=100"
          : "/api/placements?limit=100",
      )),
    );
    const concurrency = {
      requests: concurrent.length,
      ok: concurrent.filter((result) => result.response.ok).length,
      durationMs: Number((performance.now() - concurrencyStartedAt).toFixed(2)),
    };

    const integrity = production.db.pragma("integrity_check", { simple: true });
    const tableCounts = Object.fromEntries(
      [
        "students",
        "hosts",
        "placements",
        "time_entries",
        "check_ins",
        "placement_documents",
        "audit_events",
      ].map((table) => [
        table,
        production.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
      ]),
    );
    const expectedTableCounts = {
      students: counts.students,
      hosts: counts.hosts,
      placements: fixture.placementCount,
      time_entries: fixture.timeEntryCount,
      check_ins: fixture.checkInCount,
      placement_documents: fixture.documentCount,
      // One bootstrap, one login and five measured/warm-up exports are intentionally audited.
      audit_events: counts.audit + 7,
    };
    assert.deepEqual(
      tableCounts,
      expectedTableCounts,
      "The production audit must exercise the complete deterministic fixture.",
    );
    assert.equal(production.config.nodeEnv, "production");
    assert.equal(integrity, "ok");
    assert.equal(concurrency.ok, concurrency.requests);
    assert.equal(studentImport.accepted, 1_000);
    assert.equal(placementImport.accepted, 500);
    console.log(JSON.stringify({
      syntheticDatabase: {
        temporary: true,
        deletedAfterRun: true,
      },
      nodeEnv: production.config.nodeEnv,
      fixture: {
        configured: counts,
        placements: fixture.placementCount,
        timeEntries: fixture.timeEntryCount,
        checkIns: fixture.checkInCount,
        documents: fixture.documentCount,
      },
      tableCounts,
      databaseBytes: production.db.prepare(
        "SELECT page_count * page_size AS value FROM pragma_page_count(), pragma_page_size()",
      ).get().value,
      integrity,
      endpoints,
      export: exportMetrics,
      imports: { students: studentImport, placements: placementImport },
      concurrency,
      memory: {
        rssBefore: memoryBefore.rss,
        rssAfter: memoryAfter.rss,
        rssDelta: memoryAfter.rss - memoryBefore.rss,
        heapUsedBefore: memoryBefore.heapUsed,
        heapUsedAfter: memoryAfter.heapUsed,
        heapUsedDelta: memoryAfter.heapUsed - memoryBefore.heapUsed,
      },
      plans: queryPlans(production.db, fixture.school.id),
    }, null, 2));
  } finally {
    if (production) await production.close();
    if (initializer) await initializer.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      await rm(`${databasePath}${suffix}`, { force: true });
    }
  }
}

await main();
