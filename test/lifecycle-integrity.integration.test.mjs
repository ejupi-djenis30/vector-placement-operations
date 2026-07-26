import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { startTestApp } from "../test-support/server-test-helper.mjs";
import { currentSchoolDate } from "../server/school-time.mjs";

const running = new Set();

afterEach(async () => {
  await Promise.all([...running].map((instance) => instance.close()));
  running.clear();
});

async function app(options) {
  const instance = await startTestApp(options);
  running.add(instance);
  assert.equal((await instance.client.login()).response.status, 200);
  return instance;
}

async function created(client, path, body) {
  const result = await client.request(path, { method: "POST", body });
  assert.equal(result.response.status, 201, `${path}: ${JSON.stringify(result.payload)}`);
  return result.payload.id;
}

async function fixture(client, suffix, {
  startDate = "2024-06-01",
  endDate = "2024-06-30",
  targetHours = 8,
} = {}) {
  const cohortId = await created(client, "/api/cohorts", {
    name: `Cohort ${suffix}`,
    academicYear: "2023/2024",
    track: "Operations",
    tutorUserId: null,
  });
  const periodId = await created(client, "/api/periods", {
    name: `Period ${suffix}`,
    startDate,
    endDate,
  });
  const studentId = await created(client, "/api/students", {
    cohortId,
    externalRef: `STUDENT-${suffix}`,
    firstName: "Synthetic",
    lastName: suffix,
    email: `${suffix.toLowerCase()}@example.test`,
  });
  const hostId = await created(client, "/api/hosts", {
    name: `Host ${suffix}`,
    sector: "Synthetic",
  });
  const placementId = await created(client, "/api/placements", {
    studentId,
    hostId,
    periodId,
    schoolTutorId: null,
    startDate,
    endDate,
    targetHours,
    status: "active",
  });
  return { cohortId, periodId, studentId, hostId, placementId, startDate, endDate };
}

async function addRequiredEvidence(client, placementId, suffix) {
  const ids = {};
  for (const [kind, status] of [
    ["training_agreement", "signed"],
    ["attendance_log", "signed"],
    ["evaluation", "ready"],
  ]) {
    ids[kind] = await created(client, `/api/placements/${placementId}/documents`, {
      kind,
      title: `${kind} ${suffix}`,
      status,
    });
  }
  return ids;
}

test("placement identity is locked by each class of recorded activity", async () => {
  const { client } = await app();

  const timeFixture = await fixture(client, "IDENTITY-TIME");
  await created(client, `/api/placements/${timeFixture.placementId}/time-entries`, {
    entryDate: "2024-06-10",
    hours: 1,
    verificationStatus: "verified",
  });
  const alternateStudent = await created(client, "/api/students", {
    cohortId: timeFixture.cohortId,
    externalRef: "STUDENT-IDENTITY-ALTERNATE",
    firstName: "Alternate",
    lastName: "Student",
  });
  const studentChange = await client.request(`/api/placements/${timeFixture.placementId}`, {
    method: "PATCH",
    body: { revision: 1, studentId: alternateStudent },
  });
  assert.equal(studentChange.response.status, 409);
  assert.equal(studentChange.payload.error.code, "placement_identity_locked");

  const checkInFixture = await fixture(client, "IDENTITY-CHECKIN");
  await created(client, `/api/placements/${checkInFixture.placementId}/check-ins`, {
    occurredAt: "2024-06-10T09:00:00.000Z",
    channel: "video",
    summary: "Synthetic check-in",
  });
  const alternateHost = await created(client, "/api/hosts", {
    name: "Host Identity Alternate",
  });
  const hostChange = await client.request(`/api/placements/${checkInFixture.placementId}`, {
    method: "PATCH",
    body: { revision: 1, hostId: alternateHost },
  });
  assert.equal(hostChange.response.status, 409);
  assert.equal(hostChange.payload.error.code, "placement_identity_locked");

  const documentFixture = await fixture(client, "IDENTITY-DOCUMENT");
  await created(client, `/api/placements/${documentFixture.placementId}/documents`, {
    kind: "other",
    title: "Recorded evidence",
    status: "draft",
  });
  const alternatePeriod = await created(client, "/api/periods", {
    name: "Period Identity Alternate",
    startDate: "2024-06-01",
    endDate: "2024-06-30",
  });
  const periodChange = await client.request(`/api/placements/${documentFixture.placementId}`, {
    method: "PATCH",
    body: { revision: 1, periodId: alternatePeriod },
  });
  assert.equal(periodChange.response.status, 409);
  assert.equal(periodChange.payload.error.code, "placement_identity_locked");
});

test("placement and evidence dates remain coherent", async () => {
  const { client } = await app();
  const record = await fixture(client, "DATES");
  const checkInId = await created(client, `/api/placements/${record.placementId}/check-ins`, {
    occurredAt: "2024-06-10T09:00:00.000Z",
    channel: "phone",
    summary: "Within placement",
  });
  await created(client, `/api/placements/${record.placementId}/documents`, {
    kind: "other",
    title: "Evidence due in placement",
    status: "draft",
    dueDate: "2024-06-20",
  });

  const excludesCheckIn = await client.request(`/api/placements/${record.placementId}`, {
    method: "PATCH",
    body: { revision: 1, startDate: "2024-06-11" },
  });
  assert.equal(excludesCheckIn.response.status, 422);
  assert.equal(excludesCheckIn.payload.error.code, "placement_date_conflict");

  const allowsDeadlineBeyondNewRange = await client.request(`/api/placements/${record.placementId}`, {
    method: "PATCH",
    body: { revision: 1, endDate: "2024-06-19" },
  });
  assert.equal(allowsDeadlineBeyondNewRange.response.status, 200);
  assert.equal(allowsDeadlineBeyondNewRange.payload.revision, 2);

  const outsideCreate = await client.request(`/api/placements/${record.placementId}/check-ins`, {
    method: "POST",
    body: {
      occurredAt: "2024-07-01T09:00:00.000Z",
      channel: "email",
      summary: "Outside",
    },
  });
  assert.equal(outsideCreate.response.status, 422);
  assert.equal(outsideCreate.payload.error.code, "check_in_outside_placement");

  const outsideUpdate = await client.request(
    `/api/placements/${record.placementId}/check-ins/${checkInId}`,
    {
      method: "PATCH",
      body: { revision: 1, occurredAt: "2024-07-01T09:00:00.000Z" },
    },
  );
  assert.equal(outsideUpdate.response.status, 422);
  assert.equal(outsideUpdate.payload.error.code, "check_in_outside_placement");

  const postPlacementDeadline = await client.request(
    `/api/placements/${record.placementId}/documents`,
    {
      method: "POST",
      body: {
        kind: "completion_certificate",
        title: "Outside due date",
        status: "draft",
        dueDate: "2024-07-01",
      },
    },
  );
  assert.equal(postPlacementDeadline.response.status, 201);
  const prePlacementDeadline = await client.request(
    `/api/placements/${record.placementId}/documents`,
    {
      method: "POST",
      body: {
        kind: "training_agreement",
        title: "Agreement before start",
        status: "draft",
        dueDate: "2024-06-01",
      },
    },
  );
  assert.equal(prePlacementDeadline.response.status, 201);
});

test("dependent records cannot be deactivated while placements remain open", async () => {
  const { client } = await app();
  const record = await fixture(client, "DEACTIVATE");
  for (const [resource, id] of [
    ["students", record.studentId],
    ["hosts", record.hostId],
    ["cohorts", record.cohortId],
    ["periods", record.periodId],
  ]) {
    const blocked = await client.request(`/api/${resource}/${id}`, {
      method: "PATCH",
      body: { revision: 1, active: false },
    });
    assert.equal(blocked.response.status, 409);
    assert.equal(blocked.payload.error.code, "entity_has_open_placements");
    assert.equal(blocked.payload.error.details.count, 1);
  }

  const cancelled = await client.request(`/api/placements/${record.placementId}`, {
    method: "PATCH",
    body: { revision: 1, status: "cancelled" },
  });
  assert.equal(cancelled.response.status, 200);
  for (const [resource, id] of [
    ["students", record.studentId],
    ["hosts", record.hostId],
    ["cohorts", record.cohortId],
    ["periods", record.periodId],
  ]) {
    const deactivated = await client.request(`/api/${resource}/${id}`, {
      method: "PATCH",
      body: { revision: 1, active: false },
    });
    assert.equal(deactivated.response.status, 200);
  }
});

test("only an administrator can reopen a completed placement with an audited reason", async () => {
  const instance = await app();
  const { client, db } = instance;
  const record = await fixture(client, "REOPEN", { targetHours: 1 });
  await created(client, `/api/placements/${record.placementId}/time-entries`, {
    entryDate: "2024-06-10",
    hours: 1,
    verificationStatus: "verified",
  });
  await created(client, `/api/placements/${record.placementId}/check-ins`, {
    occurredAt: "2024-06-10T09:00:00.000Z",
    channel: "in_person",
    summary: "Readiness check-in",
  });
  await addRequiredEvidence(client, record.placementId, "REOPEN");
  assert.equal(
    (await client.request(`/api/placements/${record.placementId}`, {
      method: "PATCH",
      body: { revision: 1, status: "review" },
    })).response.status,
    200,
  );
  assert.equal(
    (await client.request(`/api/placements/${record.placementId}`, {
      method: "PATCH",
      body: { revision: 2, status: "complete" },
    })).response.status,
    200,
  );

  const coordinatorPassword = "coordinator-temporary-2026";
  const coordinatorId = await created(client, "/api/users", {
    email: "coordinator.reopen@example.test",
    displayName: "Synthetic coordinator",
    password: coordinatorPassword,
    role: "coordinator",
    dataScope: "school",
  });
  const coordinator = instance.newClient();
  assert.equal(
    (await coordinator.login("coordinator.reopen@example.test", coordinatorPassword))
      .response.status,
    200,
  );
  assert.equal(
    (await coordinator.request("/api/auth/change-password", {
      method: "POST",
      body: {
        currentPassword: coordinatorPassword,
        newPassword: "coordinator-replacement-2026",
      },
    })).response.status,
    200,
  );
  assert.equal(
    (await coordinator.login(
      "coordinator.reopen@example.test",
      "coordinator-replacement-2026",
    )).response.status,
    200,
  );
  const forbidden = await coordinator.request(`/api/placements/${record.placementId}`, {
    method: "PATCH",
    body: {
      revision: 3,
      status: "review",
      reopenReasonCode: "administrative_correction",
    },
  });
  assert.equal(forbidden.response.status, 403);

  const reopened = await client.request(`/api/placements/${record.placementId}`, {
    method: "PATCH",
    body: {
      revision: 3,
      status: "review",
      reopenReasonCode: "administrative_correction",
    },
  });
  assert.equal(reopened.response.status, 200);
  const audit = db.prepare(`
    SELECT metadata_json AS metadata
    FROM audit_events
    WHERE action = 'placement.reopened' AND entity_id = ?
  `).get(record.placementId);
  assert.ok(audit);
  const metadata = JSON.parse(audit.metadata);
  assert.equal(metadata.previousStatus, "complete");
  assert.match(metadata.previousFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(metadata.reasonCode, "administrative_correction");

  const newCheckIn = await client.request(`/api/placements/${record.placementId}/check-ins`, {
    method: "POST",
    body: {
      occurredAt: "2024-06-11T09:00:00.000Z",
      channel: "video",
      summary: "Evidence is mutable again after the audited reopen.",
    },
  });
  assert.equal(newCheckIn.response.status, 201);
  assert.ok(coordinatorId);
});

test("voided check-ins stay visible but no longer satisfy readiness", async () => {
  const { client, db } = await app();
  const record = await fixture(client, "VOID", { targetHours: 1 });
  await created(client, `/api/placements/${record.placementId}/time-entries`, {
    entryDate: "2024-06-10",
    hours: 1,
    verificationStatus: "verified",
  });
  const checkInId = await created(client, `/api/placements/${record.placementId}/check-ins`, {
    occurredAt: "2024-06-10T09:00:00.000Z",
    channel: "video",
    summary: "Duplicate check-in",
  });
  await addRequiredEvidence(client, record.placementId, "VOID");
  const ready = await client.request(`/api/placements/${record.placementId}`);
  assert.equal(ready.payload.readiness.ready, true);

  const voided = await client.request(
    `/api/placements/${record.placementId}/check-ins/${checkInId}`,
    {
      method: "PATCH",
      body: {
        revision: 1,
        voided: true,
        voidReason: "Duplicate for Jane Private jane.private@example.test; do not count it.",
      },
    },
  );
  assert.equal(voided.response.status, 200);
  const detail = await client.request(`/api/placements/${record.placementId}`);
  assert.equal(detail.payload.checkIns[0].voided, true);
  assert.equal(detail.payload.checkIns[0].canEdit, false);
  assert.equal(detail.payload.lastCheckInAt, null);
  assert.equal(
    detail.payload.readiness.blockers.some((item) => item.code === "check_in_missing"),
    true,
  );
  const audit = db.prepare(`
    SELECT metadata_json AS metadata
    FROM audit_events
    WHERE action = 'check_in.updated' AND entity_id = ?
  `).get(checkInId);
  assert.equal(audit.metadata.includes("Jane Private"), false);
  assert.equal(audit.metadata.includes("jane.private@example.test"), false);
});

test("signed evidence is immutable and can be superseded without erasing history", async () => {
  const { client } = await app();
  const record = await fixture(client, "SUPERSEDE", { targetHours: 1 });
  await created(client, `/api/placements/${record.placementId}/time-entries`, {
    entryDate: "2024-06-10",
    hours: 1,
    verificationStatus: "verified",
  });
  await created(client, `/api/placements/${record.placementId}/check-ins`, {
    occurredAt: "2024-06-10T09:00:00.000Z",
    channel: "video",
    summary: "Readiness check",
  });
  const evidence = await addRequiredEvidence(client, record.placementId, "SUPERSEDE");

  const tamper = await client.request(
    `/api/placements/${record.placementId}/documents/${evidence.training_agreement}`,
    {
      method: "PATCH",
      body: { revision: 1, reference: "silently-replaced-reference" },
    },
  );
  assert.equal(tamper.response.status, 409);
  assert.equal(tamper.payload.error.code, "document_frozen");

  const superseded = await client.request(
    `/api/placements/${record.placementId}/documents/${evidence.training_agreement}/supersede`,
    {
      method: "POST",
      body: {
        revision: 1,
        reasonCode: "replacement_received",
        title: "Replacement training agreement",
        status: "draft",
        reference: "replacement-record",
      },
    },
  );
  assert.equal(superseded.response.status, 201);
  const detail = await client.request(`/api/placements/${record.placementId}`);
  const oldRecord = detail.payload.documents.find(
    (item) => item.id === evidence.training_agreement,
  );
  const replacement = detail.payload.documents.find(
    (item) => item.id === superseded.payload.id,
  );
  assert.equal(oldRecord.superseded, true);
  assert.equal(oldRecord.supersededById, replacement.id);
  assert.equal(replacement.status, "draft");
  assert.equal(
    detail.payload.readiness.blockers.some(
      (item) => item.code === "document_training_agreement",
    ),
    true,
  );

  const certificate = await created(client, `/api/placements/${record.placementId}/documents`, {
    kind: "completion_certificate",
    title: "Completion certificate",
    status: "signed",
  });
  const archived = await client.request(
    `/api/placements/${record.placementId}/documents/${certificate}`,
    {
      method: "PATCH",
      body: { revision: 1, status: "archived" },
    },
  );
  assert.equal(archived.response.status, 200);
  const archivedTamper = await client.request(
    `/api/placements/${record.placementId}/documents/${certificate}`,
    {
      method: "PATCH",
      body: { revision: 2, title: "Changed after archive" },
    },
  );
  assert.equal(archivedTamper.response.status, 409);
  assert.equal(archivedTamper.payload.error.code, "document_frozen");
  const archivedDetail = await client.request(`/api/placements/${record.placementId}`);
  assert.equal(
    archivedDetail.payload.documents.find((item) => item.id === certificate).canSupersede,
    true,
  );
  const correctedArchive = await client.request(
    `/api/placements/${record.placementId}/documents/${certificate}/supersede`,
    {
      method: "POST",
      body: {
        revision: 2,
        reasonCode: "administrative_correction",
        title: "Corrected completion certificate",
        status: "draft",
      },
    },
  );
  assert.equal(correctedArchive.response.status, 201);
});

test("retention removes placements with preserved supersession chains", async () => {
  const { client, db } = await app();
  const record = await fixture(client, "RETENTION-CHAIN");
  const documentId = await created(
    client,
    `/api/placements/${record.placementId}/documents`,
    {
      kind: "completion_certificate",
      title: "Archived certificate",
      status: "signed",
    },
  );
  const archived = await client.request(
    `/api/placements/${record.placementId}/documents/${documentId}`,
    {
      method: "PATCH",
      body: { revision: 1, status: "archived" },
    },
  );
  assert.equal(archived.response.status, 200);
  const replacement = await client.request(
    `/api/placements/${record.placementId}/documents/${documentId}/supersede`,
    {
      method: "POST",
      body: {
        revision: 2,
        reasonCode: "replacement_received",
        title: "Replacement certificate",
        status: "draft",
      },
    },
  );
  assert.equal(replacement.response.status, 201);
  const cancelled = await client.request(`/api/placements/${record.placementId}`, {
    method: "PATCH",
    body: { revision: 1, status: "cancelled" },
  });
  assert.equal(cancelled.response.status, 200);
  const deactivated = await client.request(`/api/students/${record.studentId}`, {
    method: "PATCH",
    body: { revision: 1, active: false },
  });
  assert.equal(deactivated.response.status, 200);

  const dryRun = await client.request("/api/maintenance/retention", {
    method: "POST",
    body: { beforeDate: "2025-01-01", dryRun: true, confirm: "" },
  });
  assert.equal(dryRun.payload.candidates, 1);
  const executed = await client.request("/api/maintenance/retention", {
    method: "POST",
    body: {
      beforeDate: "2025-01-01",
      dryRun: false,
      confirm: "ERASE EXPIRED RECORDS",
      fingerprint: dryRun.payload.fingerprint,
    },
  });
  assert.equal(executed.response.status, 200);
  assert.equal(executed.payload.deletedStudents, 1);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM placement_documents").get().count,
    0,
  );
});

test("time entries accept the school's today and reject its tomorrow on create and edit", async () => {
  const { client, db } = await app();
  const school = db.prepare("SELECT id FROM schools").get();
  db.prepare("UPDATE schools SET time_zone = 'Pacific/Auckland' WHERE id = ?").run(school.id);
  const today = currentSchoolDate(db, school.id);
  const tomorrow = new Date(`${today}T00:00:00.000Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const tomorrowText = tomorrow.toISOString().slice(0, 10);
  const record = await fixture(client, "FUTURE-HOURS", {
    startDate: today,
    endDate: tomorrowText,
  });
  const accepted = await client.request(
    `/api/placements/${record.placementId}/time-entries`,
    {
      method: "POST",
      body: {
        entryDate: today,
        hours: 1,
        verificationStatus: "verified",
      },
    },
  );
  assert.equal(accepted.response.status, 201);

  const futureCreate = await client.request(
    `/api/placements/${record.placementId}/time-entries`,
    {
      method: "POST",
      body: {
        entryDate: tomorrowText,
        hours: 1,
        verificationStatus: "verified",
      },
    },
  );
  assert.equal(futureCreate.response.status, 422);
  assert.equal(futureCreate.payload.error.code, "future_time_entry");

  const futureEdit = await client.request(
    `/api/placements/${record.placementId}/time-entries/${accepted.payload.id}`,
    {
      method: "PATCH",
      body: {
        revision: 1,
        entryDate: tomorrowText,
      },
    },
  );
  assert.equal(futureEdit.response.status, 422);
  assert.equal(futureEdit.payload.error.code, "future_time_entry");
});

test("a time-zone change cannot reinterpret historical check-ins outside placement dates", async () => {
  const { client, db } = await app();
  const record = await fixture(client, "TIME-ZONE", {
    startDate: "2024-01-02",
    endDate: "2024-01-02",
  });
  await created(client, `/api/placements/${record.placementId}/check-ins`, {
    occurredAt: "2024-01-02T00:30:00.000Z",
    channel: "video",
    summary: "UTC boundary check-in",
  });
  const branding = (await client.request("/api/public/branding")).payload;
  assert.equal(branding.timeZone, "UTC");
  const changed = await client.request("/api/branding", {
    method: "PATCH",
    body: {
      revision: branding.revision,
      schoolName: branding.schoolName,
      shortName: branding.shortName,
      productName: branding.productName,
      timeZone: "Pacific/Honolulu",
      primaryColor: branding.primaryColor,
      accentColor: branding.accentColor,
      surfaceColor: branding.surfaceColor,
      supportEmail: branding.supportEmail,
      contactText: branding.contactText,
      footerText: branding.footerText,
    },
  });
  assert.equal(changed.response.status, 422);
  assert.equal(changed.payload.error.code, "time_zone_activity_conflict");
  assert.equal(changed.payload.error.details.count, 1);
  const stored = db.prepare(
    "SELECT time_zone AS timeZone, revision FROM schools",
  ).get();
  assert.equal(stored.timeZone, "UTC");
  assert.equal(stored.revision, branding.revision);
});
