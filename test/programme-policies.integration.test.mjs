import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { addDocument } from "../server/data.mjs";
import {
  expectedMigrations,
  migrateDatabase,
  openDatabase,
} from "../server/db.mjs";
import { startTestApp } from "../test-support/server-test-helper.mjs";

const NOW = "2026-07-01T09:00:00.000Z";

test("the v3.1 migration backfills existing placements and seeds future schools", () => {
  const db = openDatabase(":memory:");
  try {
    db.exec(readFileSync(new URL("../migrations/001_initial.sql", import.meta.url), "utf8"));
    const initial = expectedMigrations()[0];
    db.prepare(`
      INSERT INTO schema_migrations (version, name, checksum, applied_at)
      VALUES (?, ?, ?, ?)
    `).run(initial.version, initial.name, initial.checksum, NOW);
    db.prepare(`
      INSERT INTO schools (
        id, slug, name, short_name, product_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("legacy-school", "legacy-school", "Legacy School", "LS", "VECTOR", NOW, NOW);
    db.prepare(`
      INSERT INTO students (
        id, school_id, external_ref, first_name, last_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("legacy-student", "legacy-school", "LEG-01", "Legacy", "Student", NOW, NOW);
    db.prepare(`
      INSERT INTO hosts (id, school_id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run("legacy-host", "legacy-school", "Legacy Host", NOW, NOW);
    db.prepare(`
      INSERT INTO placements (
        id, school_id, student_id, host_id, start_date, end_date,
        target_minutes, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-placement",
      "legacy-school",
      "legacy-student",
      "legacy-host",
      "2026-08-01",
      "2026-08-31",
      1200,
      "active",
      NOW,
      NOW,
    );
    db.prepare(`
      INSERT INTO placement_documents (
        id, school_id, placement_id, kind, title, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-document",
      "legacy-school",
      "legacy-placement",
      "training_agreement",
      "Agreement",
      "signed",
      NOW,
      NOW,
    );

    migrateDatabase(db);

    const placement = db.prepare(`
      SELECT programme_version_id AS programmeVersionId
      FROM placements
      WHERE id = 'legacy-placement'
    `).get();
    assert.equal(
      placement.programmeVersionId,
      "programme_version_default_legacy-school",
    );
    assert.equal(
      db.prepare(`
        SELECT requirement_id AS requirementId
        FROM placement_documents
        WHERE id = 'legacy-document'
      `).get().requirementId,
      "requirement_training_legacy-school",
    );

    db.prepare(`
      INSERT INTO users (
        id, school_id, email, display_name, password_hash, role, data_scope,
        must_change_password, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-admin",
      "legacy-school",
      "legacy.admin@example.test",
      "Legacy administrator",
      "not-used-by-this-test",
      "school_admin",
      "school",
      0,
      NOW,
      NOW,
    );
    const linkedEvidence = addDocument(
      db,
      {
        id: "legacy-admin",
        schoolId: "legacy-school",
        role: "school_admin",
        dataScope: "school",
      },
      "legacy-placement",
      {
        kind: "attendance_log",
        title: "Legacy attendance evidence",
        status: "signed",
        reference: "records://legacy/attendance",
        dueDate: null,
      },
      "migration-regression",
    );
    assert.equal(linkedEvidence.created, true);
    assert.equal(linkedEvidence.revision, 1);
    assert.deepEqual(
      db.prepare(`
        SELECT
          requirement_id AS requirementId,
          title,
          status,
          revision
        FROM placement_documents
        WHERE id = ?
      `).get(linkedEvidence.id),
      {
        requirementId: "requirement_attendance_legacy-school",
        title: "Signed attendance log",
        status: "signed",
        revision: 1,
      },
    );

    db.prepare(`
      INSERT INTO schools (
        id, slug, name, short_name, product_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("future-school", "future-school", "Future School", "FS", "VECTOR", NOW, NOW);
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM programme_requirements
        WHERE programme_version_id = 'programme_version_default_future-school'
      `).get().count,
      3,
    );
  } finally {
    db.close();
  }
});


test("automatic requirement placeholders stay neutral until a person edits evidence", async (context) => {
  const instance = await startTestApp();
  context.after(() => instance.close());
  const { client, db } = instance;
  assert.equal((await client.login()).response.status, 200);

  const firstStudent = await client.request("/api/students", {
    method: "POST",
    body: {
      externalRef: "PLACEHOLDER-01",
      firstName: "Initial",
      lastName: "Student",
      email: "",
      cohortId: null,
    },
  });
  const correctedStudent = await client.request("/api/students", {
    method: "POST",
    body: {
      externalRef: "PLACEHOLDER-02",
      firstName: "Corrected",
      lastName: "Student",
      email: "",
      cohortId: null,
    },
  });
  const firstHost = await client.request("/api/hosts", {
    method: "POST",
    body: { name: "Initial placeholder host" },
  });
  const correctedHost = await client.request("/api/hosts", {
    method: "POST",
    body: { name: "Corrected placeholder host" },
  });
  const placement = await client.request("/api/placements", {
    method: "POST",
    body: {
      studentId: firstStudent.payload.id,
      hostId: firstHost.payload.id,
      periodId: null,
      schoolTutorId: null,
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      targetHours: 4,
    },
  });
  assert.equal(placement.response.status, 201);

  const initialDetail = await client.request(`/api/placements/${placement.payload.id}`);
  assert.equal(initialDetail.payload.documents.length, 3);
  assert.equal(
    initialDetail.payload.documents.every((document) => (
      document.requirementId
      && document.status === "missing"
      && document.revision === 1
    )),
    true,
  );

  const correction = await client.request(`/api/placements/${placement.payload.id}`, {
    method: "PATCH",
    body: {
      revision: initialDetail.payload.revision,
      studentId: correctedStudent.payload.id,
      hostId: correctedHost.payload.id,
    },
  });
  assert.equal(correction.response.status, 200);
  assert.equal(correction.payload.revision, initialDetail.payload.revision + 1);

  const placeholder = initialDetail.payload.documents.find(
    (document) => document.requirementCode === "training_agreement",
  );
  const filled = await client.request(`/api/placements/${placement.payload.id}/documents`, {
    method: "POST",
    body: {
      kind: "training_agreement",
      title: "Caller-supplied title must not replace the policy label",
      status: "signed",
      reference: "records://placements/agreement-01",
      dueDate: null,
    },
  });
  assert.equal(filled.response.status, 200);
  assert.equal(filled.payload.id, placeholder.id);
  assert.equal(filled.payload.revision, placeholder.revision + 1);

  const stored = db.prepare(`
    SELECT title, status, reference, revision
    FROM placement_documents
    WHERE id = ?
  `).get(placeholder.id);
  assert.deepEqual(stored, {
    title: placeholder.requirementLabel,
    status: "signed",
    reference: "records://placements/agreement-01",
    revision: 2,
  });

  const staleUpdate = await client.request(
    `/api/placements/${placement.payload.id}/documents/${placeholder.id}`,
    {
      method: "PATCH",
      body: { revision: 1, status: "archived" },
    },
  );
  assert.equal(staleUpdate.response.status, 409);
  assert.equal(staleUpdate.payload.error.code, "conflict");

  const auditRows = db.prepare(`
    SELECT action, metadata_json AS metadataJson
    FROM audit_events
    WHERE entity_type = 'placement_document' AND entity_id = ?
    ORDER BY created_at, id
  `).all(placeholder.id);
  assert.deepEqual(auditRows.map((row) => row.action), ["document.updated"]);
  assert.deepEqual(JSON.parse(auditRows[0].metadataJson), {
    changedFields: ["status", "reference", "dueDate"],
    placeholderFilled: true,
    previousStatus: "missing",
    programmeRequirement: true,
    status: "signed",
  });

  const lockedCorrection = await client.request(`/api/placements/${placement.payload.id}`, {
    method: "PATCH",
    body: {
      revision: correction.payload.revision,
      studentId: firstStudent.payload.id,
    },
  });
  assert.equal(lockedCorrection.response.status, 409);
  assert.equal(lockedCorrection.payload.error.code, "placement_identity_locked");
  assert.equal(lockedCorrection.payload.error.details.count, 1);
});

test("programme versions drive placement readiness and CSV references atomically", async (context) => {
  const instance = await startTestApp();
  context.after(() => instance.close());
  const { client, db } = instance;
  assert.equal((await client.login()).response.status, 200);

  const createdProgramme = await client.request("/api/programmes", {
    method: "POST",
    body: {
      code: "ENGINEERING_PATHWAY",
      name: "Engineering pathway",
      description: "A supervised engineering placement policy.",
      defaultTargetHours: 4,
      minimumCheckIns: 2,
      requirements: [{
        code: "mentor_report",
        label: "Mentor close-out report",
        acceptedStatuses: ["ready", "signed", "archived"],
      }],
    },
  });
  assert.equal(createdProgramme.response.status, 201);

  let programmes = (await client.request("/api/programmes")).payload.items;
  let programme = programmes.find((item) => item.id === createdProgramme.payload.id);
  assert.equal(programme.currentVersion.version, 1);
  const firstVersionId = programme.currentVersion.id;

  const published = await client.request(`/api/programmes/${programme.id}/versions`, {
    method: "POST",
    body: {
      revision: programme.revision,
      defaultTargetHours: 6,
      minimumCheckIns: 3,
      requirements: [{
        code: "mentor_report",
        label: "Mentor close-out report",
        acceptedStatuses: ["signed", "archived"],
      }],
    },
  });
  assert.equal(published.response.status, 201);
  assert.equal(published.payload.version, 2);
  const versions = await client.request(`/api/programmes/${programme.id}/versions`);
  assert.deepEqual(versions.payload.items.map((item) => item.version), [2, 1]);
  assert.throws(
    () => db.prepare(`
      UPDATE programme_versions
      SET minimum_check_ins = 99
      WHERE id = ?
    `).run(firstVersionId),
    /programme versions are immutable/,
  );
  programmes = (await client.request("/api/programmes")).payload.items;
  programme = programmes.find((item) => item.id === programme.id);

  const student = await client.request("/api/students", {
    method: "POST",
    body: {
      externalRef: "PROGRAMME-01",
      firstName: "Taylor",
      lastName: "Reed",
      email: "",
      cohortId: null,
    },
  });
  const host = await client.request("/api/hosts", {
    method: "POST",
    body: { name: "Programme Test Host" },
  });
  const placement = await client.request("/api/placements", {
    method: "POST",
    body: {
      studentId: student.payload.id,
      hostId: host.payload.id,
      periodId: null,
      schoolTutorId: null,
      programmeVersionId: firstVersionId,
      startDate: "2026-08-01",
      endDate: "2026-08-31",
      targetHours: 4,
    },
  });
  assert.equal(placement.response.status, 201);

  const detail = await client.request(`/api/placements/${placement.payload.id}`);
  assert.equal(detail.payload.programmeCode, "ENGINEERING_PATHWAY");
  assert.equal(detail.payload.programmeVersion, 1);
  assert.equal(detail.payload.readiness.minimumCheckIns, 2);
  assert.equal(detail.payload.documents.length, 1);
  assert.equal(detail.payload.documents[0].requirementCode, "mentor_report");
  assert.equal(detail.payload.documents[0].status, "missing");

  const evidence = detail.payload.documents[0];
  const draftEvidence = await client.request(
    `/api/placements/${placement.payload.id}/documents/${evidence.id}`,
    {
      method: "PATCH",
      body: {
        revision: evidence.revision,
        status: "draft",
        reference: "records://mentor-report/01",
      },
    },
  );
  assert.equal(draftEvidence.response.status, 200);
  const updatedEvidence = await client.request(
    `/api/placements/${placement.payload.id}/documents/${evidence.id}`,
    {
      method: "PATCH",
      body: {
        revision: draftEvidence.payload.revision,
        status: "ready",
        reference: "records://mentor-report/01",
      },
    },
  );
  assert.equal(updatedEvidence.response.status, 200);

  const policyChange = await client.request(`/api/placements/${placement.payload.id}`, {
    method: "PATCH",
    body: {
      revision: detail.payload.revision,
      programmeVersionId: programme.currentVersion.id,
    },
  });
  assert.equal(policyChange.response.status, 409);
  assert.equal(policyChange.payload.error.code, "programme_policy_frozen");

  const beforeImport = db.prepare("SELECT COUNT(*) AS count FROM placements").get().count;
  const imported = await client.request("/api/import/placements?dryRun=false", {
    method: "POST",
    contentType: "text/csv",
    body: [
      "studentExternalRef,hostName,programmeCode,startDate,endDate,targetHours,status",
      "PROGRAMME-01,Programme Test Host,UNKNOWN_PATHWAY,2026-09-01,2026-09-30,4,planned",
      "",
    ].join("\n"),
  });
  assert.equal(imported.response.status, 422);
  assert.equal(imported.payload.error.code, "import_rejected");
  assert.equal(
    imported.payload.error.details.errors.some((error) => (
      error.field === "programmeCode"
      && error.code === "reference_not_found_or_inactive"
    )),
    true,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM placements").get().count,
    beforeImport,
  );
  const validImport = await client.request("/api/import/placements?dryRun=false", {
    method: "POST",
    contentType: "text/csv",
    body: [
      "studentExternalRef,hostName,programmeCode,startDate,endDate,targetHours,status",
      "PROGRAMME-01,Programme Test Host,ENGINEERING_PATHWAY,2026-10-01,2026-10-31,6,planned",
      "",
    ].join("\n"),
  });
  assert.equal(validImport.response.status, 200);
  const importedPlacement = db.prepare(`
    SELECT id, programme_version_id AS programmeVersionId
    FROM placements
    WHERE start_date = '2026-10-01'
  `).get();
  assert.equal(importedPlacement.programmeVersionId, programme.currentVersion.id);
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM placement_documents
      WHERE placement_id = ? AND requirement_id IS NOT NULL
    `).get(importedPlacement.id).count,
    1,
  );

  const viewerPassword = "viewer-programme-password-2026";
  const viewerAccount = await client.request("/api/users", {
    method: "POST",
    body: {
      email: "programme.viewer@example.test",
      displayName: "Programme viewer",
      password: viewerPassword,
      role: "viewer",
      dataScope: "school",
    },
  });
  assert.equal(viewerAccount.response.status, 201);
  db.prepare("UPDATE users SET must_change_password = 0 WHERE id = ?")
    .run(viewerAccount.payload.id);
  const viewer = instance.newClient();
  assert.equal(
    (await viewer.login("programme.viewer@example.test", viewerPassword)).response.status,
    200,
  );
  assert.equal((await viewer.request("/api/programmes")).response.status, 200);
  const viewerMutation = await viewer.request("/api/programmes", {
    method: "POST",
    body: {
      code: "VIEWER_FORBIDDEN",
      name: "Viewer forbidden",
      defaultTargetHours: 1,
      minimumCheckIns: 0,
      requirements: [],
    },
  });
  assert.equal(viewerMutation.response.status, 403);

  const coordinatorPassword = "coordinator-programme-password-2026";
  const coordinatorAccount = await client.request("/api/users", {
    method: "POST",
    body: {
      email: "programme.coordinator@example.test",
      displayName: "Programme coordinator",
      password: coordinatorPassword,
      role: "coordinator",
      dataScope: "school",
    },
  });
  assert.equal(coordinatorAccount.response.status, 201);
  db.prepare("UPDATE users SET must_change_password = 0 WHERE id = ?")
    .run(coordinatorAccount.payload.id);
  const coordinator = instance.newClient();
  assert.equal(
    (
      await coordinator.login(
        "programme.coordinator@example.test",
        coordinatorPassword,
      )
    ).response.status,
    200,
  );
  const coordinatorMutation = await coordinator.request("/api/programmes", {
    method: "POST",
    body: {
      code: "COORDINATOR_PATHWAY",
      name: "Coordinator pathway",
      defaultTargetHours: 2,
      minimumCheckIns: 1,
      requirements: [],
    },
  });
  assert.equal(coordinatorMutation.response.status, 201);
});


test("programme reassignment preserves records and freezes after real activity", async (context) => {
  const instance = await startTestApp();
  context.after(() => instance.close());
  const { client, db } = instance;
  assert.equal((await client.login()).response.status, 200);

  async function createPolicy(code, name, requirement) {
    const created = await client.request("/api/programmes", {
      method: "POST",
      body: {
        code,
        name,
        defaultTargetHours: 4,
        minimumCheckIns: 1,
        requirements: [requirement],
      },
    });
    assert.equal(created.response.status, 201);
    const programmes = (await client.request("/api/programmes")).payload.items;
    return programmes.find((programme) => programme.id === created.payload.id);
  }

  const policyA = await createPolicy(
    "POLICY_ALPHA",
    "Policy alpha",
    {
      code: "training_agreement",
      label: "Training agreement",
      acceptedStatuses: ["signed", "archived"],
    },
  );
  const policyB = await createPolicy(
    "POLICY_BETA",
    "Policy beta",
    {
      code: "evaluation",
      label: "Evaluation",
      acceptedStatuses: ["ready", "signed", "archived"],
    },
  );
  const host = await client.request("/api/hosts", {
    method: "POST",
    body: { name: "Policy Integrity Host" },
  });
  assert.equal(host.response.status, 201);

  async function createPlacement(suffix) {
    const student = await client.request("/api/students", {
      method: "POST",
      body: {
        externalRef: `POLICY-${suffix}`,
        firstName: "Policy",
        lastName: suffix,
        email: "",
        cohortId: null,
      },
    });
    assert.equal(student.response.status, 201);
    const placement = await client.request("/api/placements", {
      method: "POST",
      body: {
        studentId: student.payload.id,
        hostId: host.payload.id,
        periodId: null,
        schoolTutorId: null,
        programmeVersionId: policyA.currentVersion.id,
        startDate: "2026-06-01",
        endDate: "2026-06-30",
        targetHours: 4,
      },
    });
    assert.equal(placement.response.status, 201);
    return placement.payload.id;
  }

  async function changePolicy(placementId) {
    const detail = await client.request(`/api/placements/${placementId}`);
    return client.request(`/api/placements/${placementId}`, {
      method: "PATCH",
      body: {
        revision: detail.payload.revision,
        programmeVersionId: policyB.currentVersion.id,
      },
    });
  }

  const neutralPlacementId = await createPlacement("NEUTRAL");
  const neutralBefore = await client.request(`/api/placements/${neutralPlacementId}`);
  const oldPlaceholderId = neutralBefore.payload.documents[0].id;
  const changed = await changePolicy(neutralPlacementId);
  assert.equal(changed.response.status, 200);
  const neutralAfter = await client.request(`/api/placements/${neutralPlacementId}`);
  assert.equal(neutralAfter.payload.programmeCode, "POLICY_BETA");
  assert.deepEqual(
    neutralAfter.payload.documents.map((document) => document.requirementCode),
    ["evaluation"],
  );
  assert.equal(
    neutralAfter.payload.documents.some((document) => document.id === oldPlaceholderId),
    false,
  );

  const manualPlacementId = await createPlacement("MANUAL");
  const manualDocument = await client.request(
    `/api/placements/${manualPlacementId}/documents`,
    {
      method: "POST",
      body: {
        kind: "other",
        title: "Staff note attachment",
        status: "draft",
        reference: "records://manual-evidence/01",
      },
    },
  );
  assert.equal(manualDocument.response.status, 201);
  const manualChange = await changePolicy(manualPlacementId);
  assert.equal(manualChange.response.status, 409);
  assert.equal(manualChange.payload.error.code, "programme_policy_frozen");
  const manualAfter = await client.request(`/api/placements/${manualPlacementId}`);
  assert.equal(manualAfter.payload.programmeCode, "POLICY_ALPHA");
  assert.equal(
    manualAfter.payload.documents.some((document) => document.id === manualDocument.payload.id),
    true,
  );

  const timePlacementId = await createPlacement("TIME");
  const timeEntry = await client.request(`/api/placements/${timePlacementId}/time-entries`, {
    method: "POST",
    body: {
      entryDate: "2026-06-10",
      hours: 1,
      description: "Recorded work",
    },
  });
  assert.equal(timeEntry.response.status, 201);
  const timeChange = await changePolicy(timePlacementId);
  assert.equal(timeChange.response.status, 409);
  assert.equal(timeChange.payload.error.code, "programme_policy_frozen");
  assert.throws(
    () => db.prepare(`
      UPDATE placements
      SET programme_version_id = ?
      WHERE id = ?
    `).run(policyB.currentVersion.id, timePlacementId),
    /programme policy is frozen after recorded activity/,
  );

  const checkInPlacementId = await createPlacement("CHECKIN");
  const checkIn = await client.request(`/api/placements/${checkInPlacementId}/check-ins`, {
    method: "POST",
    body: {
      occurredAt: "2026-06-10T09:00:00.000Z",
      channel: "video",
      summary: "Recorded review",
    },
  });
  assert.equal(checkIn.response.status, 201);
  const checkInChange = await changePolicy(checkInPlacementId);
  assert.equal(checkInChange.response.status, 409);
  assert.equal(checkInChange.payload.error.code, "programme_policy_frozen");
});

test("programme and version capacities are complete, visible and enforced on write", async (context) => {
  const instance = await startTestApp();
  context.after(() => instance.close());
  const { client, db } = instance;
  assert.equal((await client.login()).response.status, 200);

  const created = await client.request("/api/programmes", {
    method: "POST",
    body: {
      code: "CAPACITY_BASE",
      name: "Capacity base",
      defaultTargetHours: 1,
      minimumCheckIns: 0,
      requirements: [],
    },
  });
  assert.equal(created.response.status, 201);
  const schoolId = db.prepare("SELECT id FROM schools LIMIT 1").get().id;
  const base = (await client.request("/api/programmes")).payload.items
    .find((programme) => programme.id === created.payload.id);
  const now = "2026-07-01T10:00:00.000Z";

  db.transaction(() => {
    const insertProgramme = db.prepare(`
      INSERT INTO programmes (
        id, school_id, code, name, description, active, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, '', 1, 1, ?, ?)
    `);
    const insertVersion = db.prepare(`
      INSERT INTO programme_versions (
        id, programme_id, version, default_target_minutes,
        minimum_check_ins, created_by, published_at
      ) VALUES (?, ?, 1, 60, 0, NULL, ?)
    `);
    const currentCount = db.prepare(`
      SELECT COUNT(*) AS count FROM programmes WHERE school_id = ?
    `).get(schoolId).count;
    for (let index = currentCount; index < 200; index += 1) {
      const programmeId = `capacity-programme-${index}`;
      insertProgramme.run(
        programmeId,
        schoolId,
        `CAP_${index}`,
        `Capacity programme ${index}`,
        now,
        now,
      );
      insertVersion.run(`capacity-version-${index}`, programmeId, now);
    }
  })();

  const completeProgrammeList = await client.request("/api/programmes");
  assert.equal(completeProgrammeList.response.status, 200);
  assert.equal(completeProgrammeList.payload.items.length, 200);
  const overProgrammeCapacity = await client.request("/api/programmes", {
    method: "POST",
    body: {
      code: "CAPACITY_OVERFLOW",
      name: "Capacity overflow",
      defaultTargetHours: 1,
      minimumCheckIns: 0,
      requirements: [],
    },
  });
  assert.equal(overProgrammeCapacity.response.status, 422);
  assert.equal(overProgrammeCapacity.payload.error.code, "programme_limit_reached");
  assert.equal(overProgrammeCapacity.payload.error.details.maximum, 200);
  assert.throws(
    () => db.prepare(`
      INSERT INTO programmes (
        id, school_id, code, name, description, active, revision, created_at, updated_at
      ) VALUES ('capacity-overflow', ?, 'CAP_OVERFLOW', 'Capacity overflow', '', 1, 1, ?, ?)
    `).run(schoolId, now, now),
    /programme capacity reached/,
  );

  db.transaction(() => {
    const insertVersion = db.prepare(`
      INSERT INTO programme_versions (
        id, programme_id, version, default_target_minutes,
        minimum_check_ins, created_by, published_at
      ) VALUES (?, ?, ?, 60, 0, NULL, ?)
    `);
    const currentCount = db.prepare(`
      SELECT COUNT(*) AS count FROM programme_versions WHERE programme_id = ?
    `).get(base.id).count;
    for (let version = currentCount + 1; version <= 100; version += 1) {
      insertVersion.run(`capacity-base-version-${version}`, base.id, version, now);
    }
  })();

  const completeVersionHistory = await client.request(`/api/programmes/${base.id}/versions`);
  assert.equal(completeVersionHistory.response.status, 200);
  assert.equal(completeVersionHistory.payload.items.length, 100);
  assert.equal(completeVersionHistory.payload.items[0].version, 100);
  assert.equal(completeVersionHistory.payload.items.at(-1).version, 1);
  const overVersionCapacity = await client.request(`/api/programmes/${base.id}/versions`, {
    method: "POST",
    body: {
      revision: base.revision,
      defaultTargetHours: 1,
      minimumCheckIns: 0,
      requirements: [],
    },
  });
  assert.equal(overVersionCapacity.response.status, 422);
  assert.equal(overVersionCapacity.payload.error.code, "programme_version_limit_reached");
  assert.equal(overVersionCapacity.payload.error.details.maximum, 100);
  assert.throws(
    () => db.prepare(`
      INSERT INTO programme_versions (
        id, programme_id, version, default_target_minutes,
        minimum_check_ins, created_by, published_at
      ) VALUES ('capacity-base-overflow', ?, 101, 60, 0, NULL, ?)
    `).run(base.id, now),
    /programme version capacity reached/,
  );
});
