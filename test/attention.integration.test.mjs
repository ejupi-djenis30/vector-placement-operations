import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { createCursorCodec } from "../server/cursor.mjs";
import { listAttentionItems } from "../server/data.mjs";
import { currentSchoolDate } from "../server/school-time.mjs";
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
  instance.db.prepare("UPDATE schools SET time_zone = 'UTC'").run();
  return instance;
}

function dateFrom(isoDate, offsetDays) {
  const value = new Date(`${isoDate}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + offsetDays);
  return value.toISOString().slice(0, 10);
}

async function createTutor(instance, label) {
  const email = `${label.toLowerCase()}@example.test`;
  const password = `${label}-temporary-password-2026`;
  const result = await instance.client.request("/api/users", {
    method: "POST",
    body: {
      email,
      displayName: label,
      password,
      role: "tutor",
      dataScope: "assigned",
    },
  });
  assert.equal(result.response.status, 201);
  instance.db.prepare(
    "UPDATE users SET must_change_password = 0 WHERE id = ?",
  ).run(result.payload.id);
  return { id: result.payload.id, email, password };
}

async function createPlacement(instance, {
  label,
  status = "active",
  tutorId = null,
  startDate,
  endDate,
}) {
  const student = await instance.client.request("/api/students", {
    method: "POST",
    body: {
      cohortId: null,
      externalRef: `ATTN-${label}`,
      firstName: label,
      lastName: "Learner",
      email: "",
    },
  });
  assert.equal(student.response.status, 201);
  const host = await instance.client.request("/api/hosts", {
    method: "POST",
    body: { name: `${label} Host` },
  });
  assert.equal(host.response.status, 201);
  const placement = await instance.client.request("/api/placements", {
    method: "POST",
    body: {
      studentId: student.payload.id,
      hostId: host.payload.id,
      periodId: null,
      schoolTutorId: tutorId,
      startDate,
      endDate,
      targetHours: 1,
      status,
    },
  });
  assert.equal(placement.response.status, 201);
  return {
    id: placement.payload.id,
    studentId: student.payload.id,
    hostId: host.payload.id,
  };
}

function setTrainingAgreement(instance, placementId, {
  status,
  dueDate,
  superseded = false,
}) {
  const result = instance.db.prepare(`
    UPDATE placement_documents
    SET
      status = ?,
      due_date = ?,
      superseded_at = CASE WHEN ? THEN datetime('now') ELSE NULL END,
      revision = revision + 1,
      updated_at = datetime('now')
    WHERE placement_id = ?
      AND kind = 'training_agreement'
      AND superseded_at IS NULL
  `).run(status, dueDate, superseded ? 1 : 0, placementId);
  assert.equal(result.changes, 1);
}

async function addPendingEntries(instance, placementId, entryDate, count = 1) {
  for (let index = 0; index < count; index += 1) {
    const result = await instance.client.request(
      `/api/placements/${placementId}/time-entries`,
      {
        method: "POST",
        body: {
          entryDate,
          hours: 0.25,
          verificationStatus: "pending",
          description: `Synthetic pending entry ${index + 1}`,
        },
      },
    );
    assert.equal(result.response.status, 201);
  }
}

function forceStatus(instance, placementId, status) {
  instance.db.prepare(`
    UPDATE placements
    SET status = ?, revision = revision + 1, updated_at = datetime('now')
    WHERE id = ?
  `).run(status, placementId);
}

function schoolContext(instance) {
  const school = instance.db.prepare(
    "SELECT id FROM schools ORDER BY id LIMIT 1",
  ).get();
  return {
    schoolId: school.id,
    today: currentSchoolDate(instance.db, school.id),
  };
}

test("attention derives a stable operational queue and dashboard summary", async () => {
  const instance = await app();
  const { today } = schoolContext(instance);
  const tutor = await createTutor(instance, "QueueTutor");

  const overduePlan = await createPlacement(instance, {
    label: "OverduePlan",
    status: "planned",
    startDate: dateFrom(today, -5),
    endDate: dateFrom(today, 30),
  });
  setTrainingAgreement(instance, overduePlan.id, {
    status: "draft",
    dueDate: dateFrom(today, -3),
  });
  await addPendingEntries(
    instance,
    overduePlan.id,
    dateFrom(today, -4),
    2,
  );

  const dueActive = await createPlacement(instance, {
    label: "DueActive",
    tutorId: tutor.id,
    startDate: dateFrom(today, -10),
    endDate: dateFrom(today, 4),
  });
  setTrainingAgreement(instance, dueActive.id, {
    status: "draft",
    dueDate: dateFrom(today, 2),
  });

  const review = await createPlacement(instance, {
    label: "ReviewPlacement",
    tutorId: tutor.id,
    startDate: dateFrom(today, -20),
    endDate: dateFrom(today, -1),
  });
  forceStatus(instance, review.id, "review");

  const terminal = await createPlacement(instance, {
    label: "TerminalPlacement",
    tutorId: tutor.id,
    startDate: dateFrom(today, -20),
    endDate: dateFrom(today, -1),
  });
  setTrainingAgreement(instance, terminal.id, {
    status: "draft",
    dueDate: dateFrom(today, -2),
  });
  await addPendingEntries(instance, terminal.id, dateFrom(today, -5));
  forceStatus(instance, terminal.id, "complete");

  const satisfied = await createPlacement(instance, {
    label: "SatisfiedEvidence",
    tutorId: tutor.id,
    startDate: dateFrom(today, -10),
    endDate: dateFrom(today, 30),
  });
  setTrainingAgreement(instance, satisfied.id, {
    status: "signed",
    dueDate: dateFrom(today, 2),
  });

  const superseded = await createPlacement(instance, {
    label: "SupersededEvidence",
    tutorId: tutor.id,
    startDate: dateFrom(today, -10),
    endDate: dateFrom(today, 30),
  });
  setTrainingAgreement(instance, superseded.id, {
    status: "draft",
    dueDate: dateFrom(today, 1),
    superseded: true,
  });

  const farFuture = await createPlacement(instance, {
    label: "FarFuture",
    status: "planned",
    startDate: dateFrom(today, 20),
    endDate: dateFrom(today, 40),
  });

  const result = await instance.client.request("/api/attention?limit=100");
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.nextCursor, null);
  assert.deepEqual(
    result.payload.items.map((item) => item.reason),
    [
      "tutor_unassigned",
      "placement_start",
      "document_due",
      "document_due",
      "placement_end",
      "hours_pending",
      "placement_review",
    ],
  );
  assert.deepEqual(
    result.payload.items.map((item) => item.severity),
    [
      "overdue",
      "overdue",
      "overdue",
      "due_soon",
      "due_soon",
      "review",
      "review",
    ],
  );
  assert.match(
    result.payload.items.find((item) => item.reason === "hours_pending").detail,
    /^2 pending time entries need review\.$/,
  );

  const visiblePlacementIds = new Set(
    result.payload.items.map((item) => item.placementId),
  );
  for (const excluded of [terminal, satisfied, superseded, farFuture]) {
    assert.equal(visiblePlacementIds.has(excluded.id), false);
  }

  const dashboard = await instance.client.request("/api/dashboard");
  assert.equal(dashboard.response.status, 200);
  assert.deepEqual(
    {
      total: dashboard.payload.attention.total,
      overdue: dashboard.payload.attention.overdue,
      dueSoon: dashboard.payload.attention.dueSoon,
      review: dashboard.payload.attention.review,
    },
    { total: 7, overdue: 3, dueSoon: 2, review: 2 },
  );
  assert.equal(dashboard.payload.attention.items.length, 6);
  assert.deepEqual(
    dashboard.payload.attention.items,
    result.payload.items.slice(0, 6),
  );
});

test("attention pagination, filters and encrypted cursors stay bound to scope and school date", async () => {
  const instance = await app();
  const { schoolId, today } = schoolContext(instance);
  const tutorAlpha = await createTutor(instance, "TutorAlpha");
  const tutorBeta = await createTutor(instance, "TutorBeta");

  const alphaActive = await createPlacement(instance, {
    label: "TutorAlphaOne",
    tutorId: tutorAlpha.id,
    startDate: dateFrom(today, -5),
    endDate: dateFrom(today, 1),
  });
  await addPendingEntries(instance, alphaActive.id, dateFrom(today, -1));
  const alphaPlanned = await createPlacement(instance, {
    label: "TutorAlphaTwo",
    status: "planned",
    tutorId: tutorAlpha.id,
    startDate: dateFrom(today, 2),
    endDate: dateFrom(today, 20),
  });
  const betaActive = await createPlacement(instance, {
    label: "TutorBetaOne",
    tutorId: tutorBeta.id,
    startDate: dateFrom(today, -5),
    endDate: dateFrom(today, 3),
  });
  await addPendingEntries(instance, betaActive.id, dateFrom(today, -2));
  const unassigned = await createPlacement(instance, {
    label: "UnassignedOne",
    status: "planned",
    startDate: dateFrom(today, -1),
    endDate: dateFrom(today, 20),
  });

  const anonymous = instance.newClient();
  assert.equal(
    (await anonymous.request("/api/attention")).response.status,
    401,
  );

  const first = await instance.client.request(
    "/api/attention?limit=1&category=status&query=TutorAlpha",
  );
  assert.equal(first.response.status, 200);
  assert.equal(first.payload.items.length, 1);
  assert.ok(first.payload.nextCursor);
  const second = await instance.client.request(
    `/api/attention?limit=1&category=status&query=TutorAlpha&cursor=${encodeURIComponent(first.payload.nextCursor)}`,
  );
  assert.equal(second.response.status, 200);
  assert.equal(second.payload.items.length, 1);
  assert.notEqual(second.payload.items[0].id, first.payload.items[0].id);
  assert.equal(second.payload.nextCursor, null);
  assert.deepEqual(
    new Set([
      first.payload.items[0].placementId,
      second.payload.items[0].placementId,
    ]),
    new Set([alphaActive.id, alphaPlanned.id]),
  );

  const hours = await instance.client.request(
    "/api/attention?category=hours",
  );
  assert.equal(hours.response.status, 200);
  assert.ok(hours.payload.items.every((item) => item.category === "hours"));
  assert.deepEqual(
    new Set(hours.payload.items.map((item) => item.placementId)),
    new Set([alphaActive.id, betaActive.id]),
  );

  const betaSearch = await instance.client.request(
    "/api/attention?query=TutorBeta",
  );
  assert.equal(betaSearch.response.status, 200);
  assert.ok(
    betaSearch.payload.items.every(
      (item) => item.placementId === betaActive.id,
    ),
  );
  const assignments = await instance.client.request(
    "/api/attention?category=assignment",
  );
  assert.deepEqual(
    assignments.payload.items.map((item) => item.placementId),
    [unassigned.id],
  );

  const cursor = first.payload.nextCursor;
  const sealStart = cursor.indexOf(".") + 2;
  const tamperedCharacter = cursor[sealStart] === "A" ? "B" : "A";
  const tampered = `${cursor.slice(0, sealStart)}${tamperedCharacter}${cursor.slice(sealStart + 1)}`;
  for (const path of [
    `/api/attention?limit=1&category=status&query=TutorAlpha&cursor=${encodeURIComponent(tampered)}`,
    `/api/attention?limit=1&category=hours&query=TutorAlpha&cursor=${encodeURIComponent(cursor)}`,
    `/api/attention?limit=1&category=status&query=TutorBeta&cursor=${encodeURIComponent(cursor)}`,
  ]) {
    const rejected = await instance.client.request(path);
    assert.equal(rejected.response.status, 422);
    assert.equal(rejected.payload.error.code, "invalid_cursor");
  }
  assert.equal(
    (
      await instance.client.request("/api/attention?limit=101")
    ).response.status,
    400,
  );

  const tutorClient = instance.newClient();
  assert.equal(
    (await tutorClient.login(tutorAlpha.email, tutorAlpha.password)).response.status,
    200,
  );
  const assigned = await tutorClient.request("/api/attention");
  assert.equal(assigned.response.status, 200);
  assert.deepEqual(
    new Set(assigned.payload.items.map((item) => item.placementId)),
    new Set([alphaActive.id, alphaPlanned.id]),
  );
  const crossUserCursor = await tutorClient.request(
    `/api/attention?limit=1&category=status&query=TutorAlpha&cursor=${encodeURIComponent(cursor)}`,
  );
  assert.equal(crossUserCursor.response.status, 422);
  assert.equal(crossUserCursor.payload.error.code, "invalid_cursor");

  const admin = instance.db.prepare(`
    SELECT
      id,
      school_id AS schoolId,
      role,
      data_scope AS dataScope
    FROM users
    WHERE email = 'admin@example.test'
  `).get();
  const cursorCodec = createCursorCodec(Buffer.alloc(32, 7));
  const noon = new Date(`${today}T12:00:00.000Z`);
  const direct = listAttentionItems(
    instance.db,
    admin,
    {
      limit: 1,
      category: "status",
      query: "TutorAlpha",
    },
    cursorCodec,
    noon,
  );
  assert.ok(direct.nextCursor);
  const binding = {
    schoolId,
    userId: admin.id,
    role: admin.role,
    dataScope: admin.dataScope,
    view: "attention",
    filters: {
      query: "TutorAlpha",
      category: "status",
      today,
    },
  };
  const position = cursorCodec.decode(
    direct.nextCursor,
    "attention",
    ["number", "string", "string", "string"],
    binding,
  );
  assert.equal(position.length, 4);
  assert.equal(position.some((value) => String(value).includes("TutorAlpha")), false);
  assert.equal(position[2], alphaActive.studentId);
  assert.throws(
    () => listAttentionItems(
      instance.db,
      admin,
      {
        limit: 1,
        category: "status",
        query: "TutorAlpha",
        cursor: direct.nextCursor,
      },
      cursorCodec,
      new Date(`${dateFrom(today, 1)}T12:00:00.000Z`),
    ),
    (error) => error?.code === "invalid_cursor",
  );
});
