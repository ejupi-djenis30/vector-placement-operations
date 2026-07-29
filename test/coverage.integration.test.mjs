import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { startTestApp } from "../test-support/server-test-helper.mjs";

const running = new Set();

afterEach(async () => {
  await Promise.all([...running].map((instance) => instance.close()));
  running.clear();
});

async function app() {
  const instance = await startTestApp();
  running.add(instance);
  assert.equal((await instance.client.login()).response.status, 200);
  return instance;
}

async function createCohort(instance, name = "Coverage cohort") {
  const result = await instance.client.request("/api/cohorts", {
    method: "POST",
    body: {
      name,
      academicYear: "2026/27",
      track: "Placement operations",
      tutorUserId: null,
    },
  });
  assert.equal(result.response.status, 201);
  return result.payload.id;
}

async function createPeriod(
  instance,
  name = "Coverage period",
  startDate = "2026-05-01",
  endDate = "2026-05-31",
) {
  const result = await instance.client.request("/api/periods", {
    method: "POST",
    body: { name, startDate, endDate },
  });
  assert.equal(result.response.status, 201);
  return result.payload.id;
}

async function createStudent(instance, cohortId, {
  firstName,
  lastName,
  externalRef,
  active = true,
}) {
  const result = await instance.client.request("/api/students", {
    method: "POST",
    body: {
      cohortId,
      externalRef,
      firstName,
      lastName,
      email: "",
    },
  });
  assert.equal(result.response.status, 201);
  if (!active) {
    instance.db.prepare(`
      UPDATE students
      SET active = 0, revision = revision + 1, updated_at = datetime('now')
      WHERE id = ?
    `).run(result.payload.id);
  }
  return result.payload.id;
}

async function createHost(instance, name = "Coverage host") {
  const result = await instance.client.request("/api/hosts", {
    method: "POST",
    body: { name },
  });
  assert.equal(result.response.status, 201);
  return result.payload.id;
}

async function createPlacement(instance, {
  studentId,
  hostId,
  startDate,
  endDate,
  status = "active",
}) {
  const result = await instance.client.request("/api/placements", {
    method: "POST",
    body: {
      studentId,
      hostId,
      periodId: null,
      schoolTutorId: null,
      startDate,
      endDate,
      targetHours: 1,
      status,
    },
  });
  assert.equal(result.response.status, 201);
  return result.payload.id;
}

async function createRoleClient(instance, role) {
  const password = `${role}-coverage-password-2026`;
  const email = `${role}.coverage@example.test`;
  const created = await instance.client.request("/api/users", {
    method: "POST",
    body: {
      email,
      displayName: `${role} coverage`,
      password,
      role,
      dataScope: role === "tutor" ? "assigned" : "school",
    },
  });
  assert.equal(created.response.status, 201);
  instance.db.prepare(
    "UPDATE users SET must_change_password = 0 WHERE id = ?",
  ).run(created.payload.id);
  const client = instance.newClient();
  assert.equal((await client.login(email, password)).response.status, 200);
  return { id: created.payload.id, client };
}

function coveragePath(fixture, options = {}) {
  const params = new URLSearchParams({
    cohortId: options.cohortId ?? fixture.cohortId,
    periodId: options.periodId ?? fixture.periodId,
  });
  for (const key of ["status", "query", "limit", "cursor"]) {
    if (options[key] !== undefined) params.set(key, String(options[key]));
  }
  return `/api/coverage?${params}`;
}

async function createCoverageFixture(instance) {
  const cohortId = await createCohort(instance);
  const periodId = await createPeriod(instance);
  const hostId = await createHost(instance);
  const students = {
    conflict: await createStudent(instance, cohortId, {
      firstName: "Ada",
      lastName: "Conflict",
      externalRef: "COV-GROUP-CONFLICT",
    }),
    consecutive: await createStudent(instance, cohortId, {
      firstName: "Ben",
      lastName: "Consecutive",
      externalRef: "COV-GROUP-PLACED",
    }),
    unplaced: await createStudent(instance, cohortId, {
      firstName: "Cara",
      lastName: "Unplaced",
      externalRef: "COV-GROUP-UNPLACED",
    }),
    outside: await createStudent(instance, cohortId, {
      firstName: "Daria",
      lastName: "Outside",
      externalRef: "COV-OUTSIDE",
    }),
    cancelled: await createStudent(instance, cohortId, {
      firstName: "Eli",
      lastName: "Cancelled",
      externalRef: "COV-CANCELLED",
    }),
    single: await createStudent(instance, cohortId, {
      firstName: "Farah",
      lastName: "Single",
      externalRef: "COV-SINGLE",
    }),
    inactive: await createStudent(instance, cohortId, {
      firstName: "Ghost",
      lastName: "Inactive",
      externalRef: "COV-INACTIVE",
      active: false,
    }),
  };

  const conflictPlacements = [];
  for (const [startDate, endDate] of [
    ["2026-05-01", "2026-05-10"],
    ["2026-05-10", "2026-05-12"],
    ["2026-05-13", "2026-05-14"],
    ["2026-05-15", "2026-05-16"],
    ["2026-05-17", "2026-05-18"],
    ["2026-05-19", "2026-05-20"],
  ]) {
    conflictPlacements.push(await createPlacement(instance, {
      studentId: students.conflict,
      hostId,
      startDate,
      endDate,
    }));
  }

  const consecutivePlacements = [
    await createPlacement(instance, {
      studentId: students.consecutive,
      hostId,
      startDate: "2026-05-01",
      endDate: "2026-05-10",
    }),
    await createPlacement(instance, {
      studentId: students.consecutive,
      hostId,
      startDate: "2026-05-11",
      endDate: "2026-05-20",
    }),
  ];
  const outsidePlacement = await createPlacement(instance, {
    studentId: students.outside,
    hostId,
    startDate: "2026-04-01",
    endDate: "2026-04-30",
  });
  const cancelledPlacement = await createPlacement(instance, {
    studentId: students.cancelled,
    hostId,
    startDate: "2026-05-05",
    endDate: "2026-05-09",
  });
  instance.db.prepare(`
    UPDATE placements
    SET status = 'cancelled', revision = revision + 1, updated_at = datetime('now')
    WHERE id = ?
  `).run(cancelledPlacement);
  const singlePlacement = await createPlacement(instance, {
    studentId: students.single,
    hostId,
    startDate: "2026-05-21",
    endDate: "2026-05-28",
  });

  return {
    cohortId,
    periodId,
    hostId,
    students,
    conflictPlacements,
    consecutivePlacements,
    outsidePlacement,
    cancelledPlacement,
    singlePlacement,
  };
}

function assertInvalidCursor(result) {
  assert.equal(result.response.status, 422);
  assert.equal(result.payload.error.code, "invalid_cursor");
}

test("coverage classifies active cohort students and returns bounded placement evidence", async () => {
  const instance = await app();
  const fixture = await createCoverageFixture(instance);
  const auditBefore = instance.db.prepare(
    "SELECT COUNT(*) AS count FROM audit_events",
  ).get().count;

  const result = await instance.client.request(
    coveragePath(fixture, { limit: 100 }),
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.payload.summary, {
    total: 6,
    unplaced: 3,
    placed: 2,
    conflict: 1,
  });
  assert.equal(result.payload.nextCursor, null);
  assert.deepEqual(
    result.payload.items.map((item) => item.studentId),
    [
      fixture.students.conflict,
      fixture.students.cancelled,
      fixture.students.outside,
      fixture.students.unplaced,
      fixture.students.consecutive,
      fixture.students.single,
    ],
  );

  const conflict = result.payload.items[0];
  assert.deepEqual(
    {
      studentName: conflict.studentName,
      externalRef: conflict.externalRef,
      cohortId: conflict.cohortId,
      cohortName: conflict.cohortName,
      status: conflict.status,
      placementCount: conflict.placementCount,
      additionalPlacements: conflict.additionalPlacements,
    },
    {
      studentName: "Ada Conflict",
      externalRef: "COV-GROUP-CONFLICT",
      cohortId: fixture.cohortId,
      cohortName: "Coverage cohort",
      status: "conflict",
      placementCount: 6,
      additionalPlacements: 1,
    },
  );
  assert.equal(conflict.placements.length, 5);
  assert.deepEqual(
    conflict.placements.map((placement) => placement.id),
    fixture.conflictPlacements.slice(0, 5),
  );
  assert.ok(
    conflict.placements.every(
      (placement) =>
        placement.hostName === "Coverage host"
        && placement.status === "active",
    ),
  );

  const consecutive = result.payload.items.find(
    (item) => item.studentId === fixture.students.consecutive,
  );
  assert.equal(consecutive.status, "placed");
  assert.equal(consecutive.placementCount, 2);
  assert.equal(consecutive.additionalPlacements, 0);
  assert.deepEqual(
    consecutive.placements.map((placement) => placement.id),
    fixture.consecutivePlacements,
  );

  for (const studentId of [
    fixture.students.unplaced,
    fixture.students.outside,
    fixture.students.cancelled,
  ]) {
    const item = result.payload.items.find((candidate) => candidate.studentId === studentId);
    assert.equal(item.status, "unplaced");
    assert.equal(item.placementCount, 0);
    assert.deepEqual(item.placements, []);
    assert.equal(item.additionalPlacements, 0);
  }
  assert.equal(
    result.payload.items.some((item) => item.studentId === fixture.students.inactive),
    false,
  );
  assert.equal(
    instance.db.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count,
    auditBefore,
  );
});

test("coverage search, status summaries and encrypted pagination remain filter-bound", async () => {
  const instance = await app();
  const fixture = await createCoverageFixture(instance);

  const searched = await instance.client.request(coveragePath(fixture, {
    query: "COV-GROUP",
    status: "placed",
    limit: 100,
  }));
  assert.equal(searched.response.status, 200);
  assert.deepEqual(searched.payload.summary, {
    total: 3,
    unplaced: 1,
    placed: 1,
    conflict: 1,
  });
  assert.deepEqual(
    searched.payload.items.map((item) => item.studentId),
    [fixture.students.consecutive],
  );

  const first = await instance.client.request(
    coveragePath(fixture, { limit: 2 }),
  );
  assert.equal(first.response.status, 200);
  assert.equal(first.payload.items.length, 2);
  assert.ok(first.payload.nextCursor);
  const firstCursor = first.payload.nextCursor;
  const allItems = [...first.payload.items];
  let cursor = firstCursor;
  while (cursor) {
    const page = await instance.client.request(
      coveragePath(fixture, { limit: 2, cursor }),
    );
    assert.equal(page.response.status, 200);
    assert.deepEqual(page.payload.summary, first.payload.summary);
    allItems.push(...page.payload.items);
    cursor = page.payload.nextCursor;
  }
  assert.deepEqual(
    allItems.map((item) => item.studentId),
    [
      fixture.students.conflict,
      fixture.students.cancelled,
      fixture.students.outside,
      fixture.students.unplaced,
      fixture.students.consecutive,
      fixture.students.single,
    ],
  );
  assert.equal(new Set(allItems.map((item) => item.studentId)).size, 6);

  const otherCohortId = await createCohort(instance, "Other coverage cohort");
  const otherPeriodId = await createPeriod(
    instance,
    "Other coverage period",
    "2026-06-01",
    "2026-06-30",
  );
  for (const options of [
    { limit: 2, status: "placed", cursor: firstCursor },
    { limit: 2, query: "COV-GROUP", cursor: firstCursor },
    { limit: 3, cursor: firstCursor },
    { limit: 2, cohortId: otherCohortId, cursor: firstCursor },
    { limit: 2, periodId: otherPeriodId, cursor: firstCursor },
  ]) {
    assertInvalidCursor(
      await instance.client.request(coveragePath(fixture, options)),
    );
  }

  const sealStart = firstCursor.indexOf(".") + 2;
  const replacement = firstCursor[sealStart] === "A" ? "B" : "A";
  const tampered = `${firstCursor.slice(0, sealStart)}${replacement}${firstCursor.slice(sealStart + 1)}`;
  assertInvalidCursor(
    await instance.client.request(
      coveragePath(fixture, { limit: 2, cursor: tampered }),
    ),
  );

  const coordinator = await createRoleClient(instance, "coordinator");
  assertInvalidCursor(
    await coordinator.client.request(
      coveragePath(fixture, { limit: 2, cursor: firstCursor }),
    ),
  );
  assert.equal(
    (await instance.client.request(coveragePath(fixture, { limit: 101 }))).response.status,
    400,
  );
});

test("coverage fails closed across authentication, roles and school references without audit writes", async () => {
  const instance = await app();
  const fixture = await createCoverageFixture(instance);
  const coordinator = await createRoleClient(instance, "coordinator");
  const viewer = await createRoleClient(instance, "viewer");
  const tutor = await createRoleClient(instance, "tutor");
  const anonymous = instance.newClient();

  const now = new Date().toISOString();
  instance.db.prepare(`
    INSERT INTO schools (id, slug, name, short_name, created_at, updated_at)
    VALUES ('coverage-foreign-school', 'coverage-foreign-school', 'Foreign school', 'Foreign', ?, ?)
  `).run(now, now);
  instance.db.prepare(`
    INSERT INTO cohorts (
      id, school_id, name, academic_year, created_at, updated_at
    ) VALUES (
      'coverage-foreign-cohort', 'coverage-foreign-school',
      'Foreign cohort', '2026/27', ?, ?
    )
  `).run(now, now);
  instance.db.prepare(`
    INSERT INTO placement_periods (
      id, school_id, name, start_date, end_date, created_at, updated_at
    ) VALUES (
      'coverage-foreign-period', 'coverage-foreign-school',
      'Foreign period', '2026-05-01', '2026-05-31', ?, ?
    )
  `).run(now, now);
  const auditBefore = instance.db.prepare(
    "SELECT COUNT(*) AS count FROM audit_events",
  ).get().count;

  assert.equal(
    (await anonymous.request(coveragePath(fixture))).response.status,
    401,
  );
  assert.equal(
    (await coordinator.client.request(coveragePath(fixture))).response.status,
    200,
  );
  assert.equal(
    (await viewer.client.request(coveragePath(fixture))).response.status,
    200,
  );
  instance.db.pragma("ignore_check_constraints = ON");
  try {
    instance.db.prepare(
      "UPDATE users SET data_scope = 'assigned' WHERE id = ?",
    ).run(viewer.id);
  } finally {
    instance.db.pragma("ignore_check_constraints = OFF");
  }
  const assignedViewer = await viewer.client.request(coveragePath(fixture));
  assert.equal(assignedViewer.response.status, 403);
  assert.equal(assignedViewer.payload.error.code, "forbidden");
  for (const path of [
    coveragePath(fixture),
    coveragePath(fixture, {
      cohortId: "missing-cohort",
      periodId: "missing-period",
    }),
  ]) {
    const rejected = await tutor.client.request(path);
    assert.equal(rejected.response.status, 403);
    assert.equal(rejected.payload.error.code, "forbidden");
  }

  let expectedReferenceMessage;
  for (const options of [
    { cohortId: "missing-cohort" },
    { periodId: "missing-period" },
    { cohortId: "coverage-foreign-cohort" },
    { periodId: "coverage-foreign-period" },
    {
      cohortId: "coverage-foreign-cohort",
      periodId: "coverage-foreign-period",
    },
  ]) {
    const rejected = await instance.client.request(coveragePath(fixture, options));
    assert.equal(rejected.response.status, 422);
    assert.equal(rejected.payload.error.code, "invalid_reference");
    expectedReferenceMessage ??= rejected.payload.error.message;
    assert.equal(rejected.payload.error.message, expectedReferenceMessage);
  }

  assert.equal(
    (await instance.client.request("/api/coverage")).response.status,
    400,
  );
  assert.equal(
    (
      await instance.client.request(
        `/api/coverage?cohortId=${fixture.cohortId}`,
      )
    ).response.status,
    400,
  );
  assert.equal(
    instance.db.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count,
    auditBefore,
  );
});
