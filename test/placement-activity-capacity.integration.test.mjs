import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { PLACEMENT_CHILD_LIMITS } from "../server/placement-activity-limits.mjs";
import { seedPlacementRequirements } from "../server/programmes.mjs";
import { startTestApp } from "../test-support/server-test-helper.mjs";

const apps = new Set();
const FIXTURE_NOW = "2024-06-01T08:00:00.000Z";

afterEach(async () => {
  await Promise.all([...apps].map((instance) => instance.close()));
  apps.clear();
});

function preparePlacements(db) {
  const school = db.prepare("SELECT id FROM schools LIMIT 1").get();
  const admin = db.prepare(`
    SELECT id
    FROM users
    WHERE school_id = ? AND role = 'school_admin'
    LIMIT 1
  `).get(school.id);
  const programmeVersion = db.prepare(`
    SELECT pv.id
    FROM programme_versions pv
    JOIN programmes p ON p.id = pv.programme_id
    WHERE p.school_id = ?
    ORDER BY pv.version DESC
    LIMIT 1
  `).get(school.id);
  const placements = {
    timeEntries: "capacity-placement-time",
    checkIns: "capacity-placement-check",
    documents: "capacity-placement-document",
    programmeSeed: "capacity-placement-programme",
  };
  const insertStudent = db.prepare(`
    INSERT INTO students (
      id, school_id, external_ref, first_name, last_name, active, created_at, updated_at
    ) VALUES (?, ?, ?, 'Capacity', ?, 1, ?, ?)
  `);
  const insertPlacement = db.prepare(`
    INSERT INTO placements (
      id, school_id, student_id, host_id, school_tutor_id, host_tutor_name,
      start_date, end_date, target_minutes, status, notes, programme_version_id,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'capacity-host', ?, '', '2024-01-01', '2024-12-31',
      60, 'active', '', ?, ?, ?)
  `);
  db.transaction(() => {
    db.prepare(`
      INSERT INTO hosts (
        id, school_id, name, sector, contact_name, active, created_at, updated_at
      ) VALUES ('capacity-host', ?, 'Capacity host', '', '', 1, ?, ?)
    `).run(school.id, FIXTURE_NOW, FIXTURE_NOW);
    Object.entries(placements).forEach(([collection, placementId], index) => {
      const studentId = `capacity-student-${index}`;
      insertStudent.run(
        studentId,
        school.id,
        `CAP-${index}`,
        collection,
        FIXTURE_NOW,
        FIXTURE_NOW,
      );
      insertPlacement.run(
        placementId,
        school.id,
        studentId,
        admin.id,
        programmeVersion.id,
        FIXTURE_NOW,
        FIXTURE_NOW,
      );
    });
  })();
  return {
    adminId: admin.id,
    placements,
    programmeVersionId: programmeVersion.id,
    schoolId: school.id,
  };
}

function seedActivityAtCapMinusOne(db, fixture) {
  const insertTimeEntry = db.prepare(`
    INSERT INTO time_entries (
      id, school_id, placement_id, entry_date, minutes, description,
      verification_status, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, '2024-06-01', 60, '', 'rejected', ?, ?, ?)
  `);
  const insertCheckIn = db.prepare(`
    INSERT INTO check_ins (
      id, school_id, placement_id, occurred_at, channel, summary, next_action,
      created_by, created_at, updated_at
    ) VALUES (?, ?, ?, '2024-06-01T09:00:00.000Z', 'video', 'Capacity check', '',
      ?, ?, ?)
  `);
  const insertDocument = db.prepare(`
    INSERT INTO placement_documents (
      id, school_id, placement_id, kind, title, status, reference, due_date,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'other', 'Capacity document', ?, '', NULL, ?, ?)
  `);
  db.transaction(() => {
    for (let index = 0; index < PLACEMENT_CHILD_LIMITS.timeEntries - 1; index += 1) {
      insertTimeEntry.run(
        `capacity-time-${String(index).padStart(4, "0")}`,
        fixture.schoolId,
        fixture.placements.timeEntries,
        fixture.adminId,
        FIXTURE_NOW,
        FIXTURE_NOW,
      );
    }
    for (let index = 0; index < PLACEMENT_CHILD_LIMITS.checkIns - 1; index += 1) {
      insertCheckIn.run(
        `capacity-check-${String(index).padStart(4, "0")}`,
        fixture.schoolId,
        fixture.placements.checkIns,
        fixture.adminId,
        FIXTURE_NOW,
        FIXTURE_NOW,
      );
    }
    for (let index = 0; index < PLACEMENT_CHILD_LIMITS.documents - 1; index += 1) {
      insertDocument.run(
        `capacity-document-${String(index).padStart(4, "0")}`,
        fixture.schoolId,
        fixture.placements.documents,
        index === 0 ? "signed" : "draft",
        FIXTURE_NOW,
        FIXTURE_NOW,
      );
    }
    for (let index = 0; index < PLACEMENT_CHILD_LIMITS.documents - 2; index += 1) {
      insertDocument.run(
        `capacity-seed-document-${String(index).padStart(4, "0")}`,
        fixture.schoolId,
        fixture.placements.programmeSeed,
        "draft",
        FIXTURE_NOW,
        FIXTURE_NOW,
      );
    }
  })();
  return { insertCheckIn, insertDocument, insertTimeEntry };
}

function countRows(db, table, placementId) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE placement_id = ?`)
    .get(placementId).count;
}

function auditCount(db, action) {
  return db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = ?")
    .get(action).count;
}

function assertCapacityError(result, code, collection, maximum) {
  assert.equal(result.response.status, 409);
  assert.equal(result.payload.error.code, code);
  assert.equal(result.payload.error.details.collection, collection);
  assert.equal(result.payload.error.details.maximum, maximum);
}

function assertIndexedPlan(db, sql, placementId, limit, indexName) {
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(placementId, limit)
    .map((row) => row.detail);
  assert.ok(plan.some((detail) => detail.includes(indexName)), plan.join("\n"));
  assert.equal(plan.some((detail) => detail.includes("TEMP B-TREE")), false);
}

test("placement activity collections enforce cap-1, cap and cap+1 without truncation", async () => {
  const instance = await startTestApp();
  apps.add(instance);
  const fixture = preparePlacements(instance.db);
  const statements = seedActivityAtCapMinusOne(instance.db, fixture);

  assertIndexedPlan(
    instance.db,
    `SELECT id FROM time_entries
      WHERE placement_id = ?
      ORDER BY entry_date DESC, created_at DESC, id
      LIMIT ?`,
    fixture.placements.timeEntries,
    PLACEMENT_CHILD_LIMITS.timeEntries + 1,
    "idx_time_entries_placement_detail",
  );
  assertIndexedPlan(
    instance.db,
    `SELECT id FROM check_ins
      WHERE placement_id = ?
      ORDER BY occurred_at DESC, id
      LIMIT ?`,
    fixture.placements.checkIns,
    PLACEMENT_CHILD_LIMITS.checkIns + 1,
    "idx_check_ins_placement_detail",
  );
  assertIndexedPlan(
    instance.db,
    `SELECT id FROM placement_documents
      WHERE placement_id = ?
      ORDER BY due_date IS NULL, due_date, title, id
      LIMIT ?`,
    fixture.placements.documents,
    PLACEMENT_CHILD_LIMITS.documents + 1,
    "idx_documents_placement_detail",
  );

  assert.equal((await instance.client.login()).response.status, 200);

  const timeAtCapMinusOne = await instance.client.request(
    `/api/placements/${fixture.placements.timeEntries}`,
  );
  assert.equal(timeAtCapMinusOne.response.status, 200);
  assert.equal(
    timeAtCapMinusOne.payload.timeEntries.length,
    PLACEMENT_CHILD_LIMITS.timeEntries - 1,
  );
  assert.deepEqual(
    timeAtCapMinusOne.payload.timeEntries.slice(0, 2).map((row) => row.id),
    ["capacity-time-0000", "capacity-time-0001"],
  );
  const timeAuditBefore = auditCount(instance.db, "time_entry.created");
  const timeCreated = await instance.client.request(
    `/api/placements/${fixture.placements.timeEntries}/time-entries`,
    {
      method: "POST",
      body: {
        entryDate: "2024-06-01",
        hours: 1,
        description: "Boundary entry",
        verificationStatus: "rejected",
      },
    },
  );
  assert.equal(timeCreated.response.status, 201);
  const timeAtCap = await instance.client.request(
    `/api/placements/${fixture.placements.timeEntries}`,
  );
  assert.equal(timeAtCap.payload.timeEntries.length, PLACEMENT_CHILD_LIMITS.timeEntries);
  assert.ok(Buffer.byteLength(JSON.stringify(timeAtCap.payload), "utf8") < 300_000);
  const timeRejected = await instance.client.request(
    `/api/placements/${fixture.placements.timeEntries}/time-entries`,
    {
      method: "POST",
      body: {
        entryDate: "2024-06-01",
        hours: 1,
        verificationStatus: "rejected",
      },
    },
  );
  assertCapacityError(
    timeRejected,
    "placement_activity_capacity_reached",
    "timeEntries",
    PLACEMENT_CHILD_LIMITS.timeEntries,
  );
  assert.equal(auditCount(instance.db, "time_entry.created"), timeAuditBefore + 1);
  assert.equal(
    countRows(instance.db, "time_entries", fixture.placements.timeEntries),
    PLACEMENT_CHILD_LIMITS.timeEntries,
  );
  assert.throws(
    () => statements.insertTimeEntry.run(
      "capacity-time-trigger-overflow",
      fixture.schoolId,
      fixture.placements.timeEntries,
      fixture.adminId,
      FIXTURE_NOW,
      FIXTURE_NOW,
    ),
    /placement time-entry capacity reached/,
  );
  instance.db.exec("DROP TRIGGER time_entries_placement_capacity");
  statements.insertTimeEntry.run(
    "capacity-time-legacy-overflow",
    fixture.schoolId,
    fixture.placements.timeEntries,
    fixture.adminId,
    FIXTURE_NOW,
    FIXTURE_NOW,
  );
  const timeOverCap = await instance.client.request(
    `/api/placements/${fixture.placements.timeEntries}`,
  );
  assertCapacityError(
    timeOverCap,
    "placement_activity_capacity_exceeded",
    "timeEntries",
    PLACEMENT_CHILD_LIMITS.timeEntries,
  );

  const checkAtCapMinusOne = await instance.client.request(
    `/api/placements/${fixture.placements.checkIns}`,
  );
  assert.equal(checkAtCapMinusOne.response.status, 200);
  assert.equal(
    checkAtCapMinusOne.payload.checkIns.length,
    PLACEMENT_CHILD_LIMITS.checkIns - 1,
  );
  assert.deepEqual(
    checkAtCapMinusOne.payload.checkIns.slice(0, 2).map((row) => row.id),
    ["capacity-check-0000", "capacity-check-0001"],
  );
  const checkAuditBefore = auditCount(instance.db, "check_in.created");
  const checkCreated = await instance.client.request(
    `/api/placements/${fixture.placements.checkIns}/check-ins`,
    {
      method: "POST",
      body: {
        occurredAt: "2024-06-01T09:00:00.000Z",
        channel: "video",
        summary: "Boundary check-in",
      },
    },
  );
  assert.equal(checkCreated.response.status, 201);
  const checkAtCap = await instance.client.request(
    `/api/placements/${fixture.placements.checkIns}`,
  );
  assert.equal(checkAtCap.payload.checkIns.length, PLACEMENT_CHILD_LIMITS.checkIns);
  assert.ok(Buffer.byteLength(JSON.stringify(checkAtCap.payload), "utf8") < 200_000);
  const checkRejected = await instance.client.request(
    `/api/placements/${fixture.placements.checkIns}/check-ins`,
    {
      method: "POST",
      body: {
        occurredAt: "2024-06-01T09:00:00.000Z",
        channel: "video",
        summary: "Rejected boundary check-in",
      },
    },
  );
  assertCapacityError(
    checkRejected,
    "placement_activity_capacity_reached",
    "checkIns",
    PLACEMENT_CHILD_LIMITS.checkIns,
  );
  assert.equal(auditCount(instance.db, "check_in.created"), checkAuditBefore + 1);
  assert.equal(
    countRows(instance.db, "check_ins", fixture.placements.checkIns),
    PLACEMENT_CHILD_LIMITS.checkIns,
  );
  assert.throws(
    () => statements.insertCheckIn.run(
      "capacity-check-trigger-overflow",
      fixture.schoolId,
      fixture.placements.checkIns,
      fixture.adminId,
      FIXTURE_NOW,
      FIXTURE_NOW,
    ),
    /placement check-in capacity reached/,
  );
  instance.db.exec("DROP TRIGGER check_ins_placement_capacity");
  statements.insertCheckIn.run(
    "capacity-check-legacy-overflow",
    fixture.schoolId,
    fixture.placements.checkIns,
    fixture.adminId,
    FIXTURE_NOW,
    FIXTURE_NOW,
  );
  const checkOverCap = await instance.client.request(
    `/api/placements/${fixture.placements.checkIns}`,
  );
  assertCapacityError(
    checkOverCap,
    "placement_activity_capacity_exceeded",
    "checkIns",
    PLACEMENT_CHILD_LIMITS.checkIns,
  );

  const documentAtCapMinusOne = await instance.client.request(
    `/api/placements/${fixture.placements.documents}`,
  );
  assert.equal(documentAtCapMinusOne.response.status, 200);
  assert.equal(
    documentAtCapMinusOne.payload.documents.length,
    PLACEMENT_CHILD_LIMITS.documents - 1,
  );
  assert.deepEqual(
    documentAtCapMinusOne.payload.documents.slice(0, 2).map((row) => row.id),
    ["capacity-document-0000", "capacity-document-0001"],
  );
  const documentAuditBefore = auditCount(instance.db, "document.created");
  const documentCreated = await instance.client.request(
    `/api/placements/${fixture.placements.documents}/documents`,
    {
      method: "POST",
      body: {
        kind: "other",
        title: "Boundary document",
        status: "draft",
      },
    },
  );
  assert.equal(documentCreated.response.status, 201);
  const documentAtCap = await instance.client.request(
    `/api/placements/${fixture.placements.documents}`,
  );
  assert.equal(documentAtCap.payload.documents.length, PLACEMENT_CHILD_LIMITS.documents);
  assert.ok(Buffer.byteLength(JSON.stringify(documentAtCap.payload), "utf8") < 250_000);
  const documentRejected = await instance.client.request(
    `/api/placements/${fixture.placements.documents}/documents`,
    {
      method: "POST",
      body: {
        kind: "other",
        title: "Rejected boundary document",
        status: "draft",
      },
    },
  );
  assertCapacityError(
    documentRejected,
    "placement_activity_capacity_reached",
    "documents",
    PLACEMENT_CHILD_LIMITS.documents,
  );
  assert.equal(auditCount(instance.db, "document.created"), documentAuditBefore + 1);
  assert.equal(
    countRows(instance.db, "placement_documents", fixture.placements.documents),
    PLACEMENT_CHILD_LIMITS.documents,
  );

  const supersedeAuditBefore = auditCount(instance.db, "document.superseded");
  const supersedeRejected = await instance.client.request(
    `/api/placements/${fixture.placements.documents}/documents/capacity-document-0000/supersede`,
    {
      method: "POST",
      body: {
        revision: 1,
        reasonCode: "replacement_received",
        title: "Capacity replacement",
        status: "draft",
      },
    },
  );
  assertCapacityError(
    supersedeRejected,
    "placement_activity_capacity_reached",
    "documents",
    PLACEMENT_CHILD_LIMITS.documents,
  );
  assert.equal(auditCount(instance.db, "document.superseded"), supersedeAuditBefore);
  assert.deepEqual(
    instance.db.prepare(`
      SELECT superseded_at AS supersededAt, superseded_by_id AS supersededById, revision
      FROM placement_documents
      WHERE id = 'capacity-document-0000'
    `).get(),
    { supersededAt: null, supersededById: null, revision: 1 },
  );

  assert.throws(
    () => statements.insertDocument.run(
      "capacity-document-trigger-overflow",
      fixture.schoolId,
      fixture.placements.documents,
      "draft",
      FIXTURE_NOW,
      FIXTURE_NOW,
    ),
    /placement document capacity reached/,
  );
  instance.db.exec("DROP TRIGGER documents_placement_capacity");
  statements.insertDocument.run(
    "capacity-document-legacy-overflow",
    fixture.schoolId,
    fixture.placements.documents,
    "draft",
    FIXTURE_NOW,
    FIXTURE_NOW,
  );
  const documentOverCap = await instance.client.request(
    `/api/placements/${fixture.placements.documents}`,
  );
  assertCapacityError(
    documentOverCap,
    "placement_activity_capacity_exceeded",
    "documents",
    PLACEMENT_CHILD_LIMITS.documents,
  );

  const seedCountBefore = countRows(
    instance.db,
    "placement_documents",
    fixture.placements.programmeSeed,
  );
  const seedTransaction = instance.db.transaction(() => seedPlacementRequirements(
    instance.db,
    fixture.schoolId,
    fixture.placements.programmeSeed,
    fixture.programmeVersionId,
    FIXTURE_NOW,
  ));
  assert.throws(
    () => seedTransaction.immediate(),
    (error) => (
      error.code === "placement_activity_capacity_reached"
      && error.details.collection === "documents"
    ),
  );
  assert.equal(
    countRows(
      instance.db,
      "placement_documents",
      fixture.placements.programmeSeed,
    ),
    seedCountBefore,
  );
});
