import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { readDashboard } from "../server/data.mjs";
import { importCsv } from "../server/portability.mjs";
import { startTestApp } from "../test-support/server-test-helper.mjs";

const apps = new Set();

afterEach(async () => {
  await Promise.all([...apps].map((instance) => instance.close()));
  apps.clear();
});

function fixtureContext(db) {
  const school = db.prepare("SELECT id FROM schools LIMIT 1").get();
  const admin = db.prepare(`
    SELECT id, email, role, data_scope AS dataScope
    FROM users
    WHERE school_id = ? AND role = 'school_admin'
    LIMIT 1
  `).get(school.id);
  return {
    schoolId: school.id,
    user: {
      ...admin,
      schoolId: school.id,
      active: true,
    },
  };
}

async function collectPages(client, resource, limit) {
  const items = [];
  let cursor;
  do {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    const result = await client.request(`/api/${resource}?${query}`);
    assert.equal(result.response.status, 200);
    assert.ok(result.payload.items.length <= limit);
    items.push(...result.payload.items);
    cursor = result.payload.nextCursor;
  } while (cursor);
  return items;
}

function plans(db, sql, ...parameters) {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...parameters)
    .map((row) => row.detail);
}

test("collection indexes preserve deterministic cursor order without temporary sorts", async () => {
  const instance = await startTestApp();
  apps.add(instance);
  const { schoolId } = fixtureContext(instance.db);
  const now = new Date().toISOString();
  const insertStudent = instance.db.prepare(`
    INSERT INTO students (
      id, school_id, external_ref, first_name, last_name, email,
      active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);
  const insertHost = instance.db.prepare(`
    INSERT INTO hosts (
      id, school_id, name, sector, contact_name, active, created_at, updated_at
    ) VALUES (?, ?, ?, 'Testing', 'Scale contact', 1, ?, ?)
  `);
  instance.db.transaction(() => {
    for (let index = 0; index < 600; index += 1) {
      const padded = String(index).padStart(4, "0");
      insertStudent.run(
        `scale-student-${padded}`,
        schoolId,
        `SCALE-${padded}`,
        `First${String(index % 31).padStart(2, "0")}`,
        `Last${String((index * 17) % 97).padStart(2, "0")}`,
        `scale-${padded}@example.test`,
        now,
        now,
      );
    }
    for (let index = 0; index < 350; index += 1) {
      const padded = String(index).padStart(4, "0");
      insertHost.run(
        `scale-host-${padded}`,
        schoolId,
        `Scale host ${String((index * 19) % 401).padStart(4, "0")} ${padded}`,
        now,
        now,
      );
    }
  })();

  assert.equal((await instance.client.login()).response.status, 200);
  const students = await collectPages(instance.client, "students", 37);
  const hosts = await collectPages(instance.client, "hosts", 29);
  assert.equal(students.length, 600);
  assert.equal(hosts.length, 350);
  assert.equal(new Set(students.map((item) => item.id)).size, students.length);
  assert.equal(new Set(hosts.map((item) => item.id)).size, hosts.length);
  assert.deepEqual(
    students.map((item) => item.id),
    instance.db.prepare(`
      SELECT id
      FROM students
      WHERE school_id = ?
      ORDER BY LOWER(last_name), LOWER(first_name), id
    `).all(schoolId).map((row) => row.id),
  );
  assert.deepEqual(
    hosts.map((item) => item.id),
    instance.db.prepare(`
      SELECT id
      FROM hosts
      WHERE school_id = ?
      ORDER BY LOWER(name), id
    `).all(schoolId).map((row) => row.id),
  );

  const studentPlan = plans(instance.db, `
    SELECT id
    FROM students
    WHERE school_id = ?
    ORDER BY LOWER(last_name), LOWER(first_name), id
    LIMIT 101
  `, schoolId);
  const hostPlan = plans(instance.db, `
    SELECT id
    FROM hosts
    WHERE school_id = ?
    ORDER BY LOWER(name), id
    LIMIT 101
  `, schoolId);
  assert.ok(studentPlan.some((detail) => detail.includes("idx_students_school_name")));
  assert.ok(hostPlan.some((detail) => detail.includes("idx_hosts_school_name")));
  assert.equal(studentPlan.some((detail) => detail.includes("TEMP B-TREE")), false);
  assert.equal(hostPlan.some((detail) => detail.includes("TEMP B-TREE")), false);
});

function countPreparedStatements(db, callback) {
  const originalPrepare = db.prepare;
  let count = 0;
  db.prepare = function countedPrepare(...arguments_) {
    count += 1;
    return originalPrepare.apply(this, arguments_);
  };
  try {
    const result = callback();
    return { count, result };
  } finally {
    db.prepare = originalPrepare;
  }
}

function csvLines(header, count, rowForIndex) {
  return `${[
    header,
    ...Array.from({ length: count }, (_, index) => rowForIndex(index)),
  ].join("\r\n")}\r\n`;
}

test("large CSV dry runs batch references instead of preparing statements per row", async () => {
  const instance = await startTestApp();
  apps.add(instance);
  const { schoolId, user } = fixtureContext(instance.db);
  const now = new Date().toISOString();
  instance.db.prepare(`
    INSERT INTO cohorts (
      id, school_id, name, academic_year, track, tutor_user_id,
      active, created_at, updated_at
    ) VALUES ('scale-cohort', ?, 'Scale cohort', '2026/2027', '', ?, 1, ?, ?)
  `).run(schoolId, user.id, now, now);
  instance.db.prepare(`
    INSERT INTO placement_periods (
      id, school_id, name, start_date, end_date, active, created_at, updated_at
    ) VALUES ('scale-period', ?, 'Scale period', '2026-01-01', '2026-12-31', 1, ?, ?)
  `).run(schoolId, now, now);
  const insertStudent = instance.db.prepare(`
    INSERT INTO students (
      id, school_id, cohort_id, external_ref, first_name, last_name,
      active, created_at, updated_at
    ) VALUES (?, ?, 'scale-cohort', ?, ?, ?, 1, ?, ?)
  `);
  const insertHost = instance.db.prepare(`
    INSERT INTO hosts (
      id, school_id, name, sector, contact_name, active, created_at, updated_at
    ) VALUES (?, ?, ?, '', '', 1, ?, ?)
  `);
  instance.db.transaction(() => {
    for (let index = 0; index < 500; index += 1) {
      const padded = String(index).padStart(4, "0");
      insertStudent.run(
        `existing-student-${padded}`,
        schoolId,
        `EXISTING-${padded}`,
        `First${padded}`,
        `Last${padded}`,
        now,
        now,
      );
      insertHost.run(
        `existing-host-${padded}`,
        schoolId,
        `Existing host ${padded}`,
        now,
        now,
      );
    }
  })();

  const studentCsv = csvLines(
    "externalRef,firstName,lastName,email,cohortName,cohortAcademicYear",
    1_000,
    (index) => {
      const padded = String(index).padStart(4, "0");
      return `NEW-${padded},Import${padded},Student${padded},new-${padded}@example.test,Scale cohort,2026/2027`;
    },
  );
  const studentImport = countPreparedStatements(instance.db, () => importCsv(
    instance.db,
    user,
    "students",
    studentCsv,
    { dryRun: true },
    "scale-students",
  ));
  assert.equal(studentImport.result.accepted, 1_000);
  assert.ok(
    studentImport.count <= 2,
    `Student import prepared ${studentImport.count} statements.`,
  );

  const placementCsv = csvLines(
    "studentExternalRef,hostName,programmeCode,periodName,schoolTutorEmail,hostTutorName,hostTutorEmail,startDate,endDate,targetHours,status,notes",
    500,
    (index) => {
      const padded = String(index).padStart(4, "0");
      return `EXISTING-${padded},Existing host ${padded},VECTOR_DEFAULT,Scale period,${user.email},Host tutor,host-tutor@example.test,2026-09-01,2026-10-31,80,planned,`;
    },
  );
  const placementImport = countPreparedStatements(instance.db, () => importCsv(
    instance.db,
    user,
    "placements",
    placementCsv,
    { dryRun: true },
    "scale-placements",
  ));
  assert.equal(placementImport.result.accepted, 500);
  assert.ok(
    placementImport.count <= 6,
    `Placement import prepared ${placementImport.count} statements.`,
  );
});

test("CSV row limits stop parsing at the first out-of-bounds record", async () => {
  const instance = await startTestApp();
  apps.add(instance);
  const { user } = fixtureContext(instance.db);
  const oversized = [
    "externalRef,firstName,lastName,email,cohortName,cohortAcademicYear",
    ...Array.from(
      { length: 10_001 },
      (_, index) => `BOUND-${index},Bound,Student,,,`,
    ),
    // If parsing continued past the row ceiling, this record would instead
    // surface as a generic max-record-size parsing error.
    `BOUND-TRAILER,${"x".repeat(40_000)},Student,,,`,
    "",
  ].join("\n");
  assert.throws(
    () => importCsv(
      instance.db,
      user,
      "students",
      oversized,
      { dryRun: true },
      "scale-row-ceiling",
    ),
    (error) => error?.statusCode === 422 && error?.code === "too_many_rows",
  );
  assert.equal(instance.db.prepare("SELECT COUNT(*) FROM students").pluck().get(), 0);
});

test("dashboard aggregation returns bounded metrics without materialising placement rows", async () => {
  const instance = await startTestApp();
  apps.add(instance);
  const { schoolId, user } = fixtureContext(instance.db);
  const now = "2026-07-31T12:00:00.000Z";
  const programmeVersionId = instance.db.prepare(`
    SELECT version.id
    FROM programme_versions version
    JOIN programmes programme ON programme.id = version.programme_id
    WHERE programme.school_id = ?
    LIMIT 1
  `).get(schoolId).id;
  instance.db.prepare(`
    INSERT INTO hosts (
      id, school_id, name, sector, contact_name, active, created_at, updated_at
    ) VALUES ('dashboard-host', ?, 'Dashboard host', '', '', 1, ?, ?)
  `).run(schoolId, now, now);
  const insertStudent = instance.db.prepare(`
    INSERT INTO students (
      id, school_id, external_ref, first_name, last_name,
      active, created_at, updated_at
    ) VALUES (?, ?, ?, 'Scale', ?, 1, ?, ?)
  `);
  const insertPlacement = instance.db.prepare(`
    INSERT INTO placements (
      id, school_id, student_id, host_id, school_tutor_id,
      host_tutor_name, start_date, end_date, target_minutes,
      status, notes, programme_version_id, created_at, updated_at
    ) VALUES (?, ?, ?, 'dashboard-host', ?, '', '2030-01-01', '2030-02-28',
      9600, ?, '', ?, ?, ?)
  `);
  const statuses = ["planned", "active", "review", "complete", "cancelled"];
  instance.db.transaction(() => {
    for (let index = 0; index < 300; index += 1) {
      const studentId = `dashboard-student-${index}`;
      insertStudent.run(
        studentId,
        schoolId,
        `DASH-${index}`,
        `Student ${index}`,
        now,
        now,
      );
      insertPlacement.run(
        `dashboard-placement-${index}`,
        schoolId,
        studentId,
        user.id,
        statuses[index % statuses.length],
        programmeVersionId,
        now,
        now,
      );
    }
  })();

  const originalPrepare = instance.db.prepare;
  let aggregateGets = 0;
  let aggregateAlls = 0;
  instance.db.prepare = function instrumentedPrepare(sql, ...arguments_) {
    const statement = originalPrepare.call(this, sql, ...arguments_);
    if (!String(sql).includes("COUNT(*) AS placements")) return statement;
    return {
      get(...parameters) {
        aggregateGets += 1;
        return statement.get(...parameters);
      },
      all(...parameters) {
        aggregateAlls += 1;
        return statement.all(...parameters);
      },
    };
  };
  let dashboard;
  try {
    dashboard = readDashboard(instance.db, user, new Date(now));
  } finally {
    instance.db.prepare = originalPrepare;
  }
  assert.equal(aggregateGets, 1);
  assert.equal(aggregateAlls, 0);
  assert.deepEqual(
    {
      placements: dashboard.placements,
      active: dashboard.active,
      review: dashboard.review,
      complete: dashboard.complete,
      completion: dashboard.completion,
      documentGaps: dashboard.documentGaps,
    },
    {
      placements: 300,
      active: 60,
      review: 60,
      complete: 60,
      completion: 0,
      documentGaps: 900,
    },
  );
});

test("representative CRUD and cursor pagination loop retains bounded memory", async () => {
  assert.equal(
    typeof global.gc,
    "function",
    "The test gate must run Node with --expose-gc for deterministic heap measurements.",
  );
  const instance = await startTestApp();
  apps.add(instance);
  assert.equal((await instance.client.login()).response.status, 200);

  const mutatePair = async (index) => {
    const padded = String(index).padStart(4, "0");
    const student = await instance.client.request("/api/students", {
      method: "POST",
      body: {
        cohortId: null,
        externalRef: `LOOP-${padded}`,
        firstName: `Loop${padded}`,
        lastName: `Student${padded}`,
        email: `loop-student-${padded}@example.test`,
      },
    });
    assert.equal(student.response.status, 201);
    const updatedStudent = await instance.client.request(
      `/api/students/${student.payload.id}`,
      {
        method: "PATCH",
        body: {
          revision: 1,
          lastName: `Updated${padded}`,
          active: false,
        },
      },
    );
    assert.equal(updatedStudent.response.status, 200);
    assert.equal(updatedStudent.payload.revision, 2);

    const host = await instance.client.request("/api/hosts", {
      method: "POST",
      body: {
        name: `Loop host ${padded}`,
        sector: "Memory audit",
        contactName: `Contact ${padded}`,
        contactEmail: `loop-host-${padded}@example.test`,
      },
    });
    assert.equal(host.response.status, 201);
    const updatedHost = await instance.client.request(
      `/api/hosts/${host.payload.id}`,
      {
        method: "PATCH",
        body: {
          revision: 1,
          contactPhone: `+41000${padded}`,
          active: false,
        },
      },
    );
    assert.equal(updatedHost.response.status, 200);
    assert.equal(updatedHost.payload.revision, 2);
  };

  await mutatePair(0);
  await collectPages(instance.client, "students", 7);
  await collectPages(instance.client, "hosts", 7);
  global.gc();
  global.gc();
  const memoryBefore = process.memoryUsage();

  const iterations = 80;
  for (let index = 1; index <= iterations; index += 1) {
    await mutatePair(index);
    if (index % 10 === 0) {
      const students = await collectPages(instance.client, "students", 7);
      const hosts = await collectPages(instance.client, "hosts", 7);
      assert.equal(students.length, index + 1);
      assert.equal(hosts.length, index + 1);
      assert.equal(new Set(students.map((item) => item.id)).size, students.length);
      assert.equal(new Set(hosts.map((item) => item.id)).size, hosts.length);
      global.gc();
    }
  }

  global.gc();
  global.gc();
  const memoryAfter = process.memoryUsage();
  const heapDelta = memoryAfter.heapUsed - memoryBefore.heapUsed;
  const rssDelta = memoryAfter.rss - memoryBefore.rss;
  assert.ok(
    heapDelta < 16 * 1024 * 1024,
    `The representative loop retained ${heapDelta} heap bytes.`,
  );
  assert.ok(
    rssDelta < 64 * 1024 * 1024,
    `The representative loop retained ${rssDelta} RSS bytes.`,
  );
  assert.equal(
    instance.db.prepare("SELECT COUNT(*) FROM students").pluck().get(),
    iterations + 1,
  );
  assert.equal(
    instance.db.prepare("SELECT COUNT(*) FROM hosts").pluck().get(),
    iterations + 1,
  );
  assert.equal(instance.db.pragma("quick_check", { simple: true }), "ok");
});
