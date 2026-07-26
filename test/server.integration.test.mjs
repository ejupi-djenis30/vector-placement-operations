import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, test } from "node:test";
import { ADMIN_PASSWORD, startTestApp } from "../test-support/server-test-helper.mjs";

const running = new Set();

afterEach(async () => {
  await Promise.all([...running].map((instance) => instance.close()));
  running.clear();
});

async function app(options) {
  const instance = await startTestApp(options);
  running.add(instance);
  return instance;
}

async function createUser(client, input) {
  const result = await client.request("/api/users", { method: "POST", body: input });
  assert.equal(result.response.status, 201);
  return result.payload.id;
}

async function replaceTemporaryPassword(client, email, currentPassword, newPassword) {
  const login = await client.login(email, currentPassword);
  assert.equal(login.response.status, 200);
  assert.equal(login.payload.user.mustChangePassword, true);
  const changed = await client.request("/api/auth/change-password", {
    method: "POST",
    body: { currentPassword, newPassword },
  });
  assert.equal(changed.response.status, 200);
  const replacement = await client.login(email, newPassword);
  assert.equal(replacement.response.status, 200);
  assert.equal(replacement.payload.user.mustChangePassword, false);
}

test("login rejects a cross-origin request and accepts the configured origin", async () => {
  const instance = await app();
  const health = await instance.client.request("/api/health/live");
  assert.equal(health.response.status, 200);
  assert.ok(health.response.headers.get("ratelimit-policy"));
  const workspace = await fetch(`${instance.baseUrl}/app/`, { redirect: "manual" });
  assert.equal(workspace.status, 200);
  assert.ok(workspace.headers.get("ratelimit-policy"));
  const crossOrigin = await instance.client.request("/api/auth/login", {
    method: "POST",
    body: {
      email: "admin@example.test",
      password: ADMIN_PASSWORD,
    },
    includeCsrf: false,
    headers: { origin: "https://attacker.example" },
  });
  assert.equal(crossOrigin.response.status, 403);
  assert.equal(crossOrigin.payload.error.code, "invalid_origin");
  assert.equal((await instance.client.login()).response.status, 200);
});

test("authentication, CSRF and transactional audit controls protect mutations", async () => {
  const instance = await app();
  const { client, db } = instance;

  const anonymous = await client.request("/api/dashboard");
  assert.equal(anonymous.response.status, 401);
  assert.equal(anonymous.response.headers.get("cache-control"), "no-store");

  const unknown = await client.login("nobody@example.test", "incorrect-password");
  assert.equal(unknown.response.status, 401);
  assert.equal(unknown.payload.error.code, "invalid_credentials");

  const login = await client.login();
  assert.equal(login.response.status, 200);
  assert.match(login.response.headers.get("set-cookie"), /HttpOnly/i);
  assert.match(login.response.headers.get("set-cookie"), /SameSite=Strict/i);

  const withoutCsrf = await client.request("/api/hosts", {
    method: "POST",
    body: { name: "Blocked host" },
    includeCsrf: false,
  });
  assert.equal(withoutCsrf.response.status, 403);
  assert.equal(withoutCsrf.payload.error.code, "invalid_csrf");

  db.exec(`
    CREATE TRIGGER reject_audit_insert
    BEFORE INSERT ON audit_events
    BEGIN
      SELECT RAISE(ABORT, 'audit unavailable');
    END
  `);
  const failed = await client.request("/api/hosts", {
    method: "POST",
    body: { name: "Must roll back" },
  });
  assert.equal(failed.response.status, 500);
  assert.equal(failed.payload.error.code, "internal_error");
  assert.equal("stack" in failed.payload.error, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM hosts").get().count, 0);
  db.exec("DROP TRIGGER reject_audit_insert");

  const audit = db.prepare("SELECT id FROM audit_events LIMIT 1").get();
  assert.throws(
    () => db.prepare("UPDATE audit_events SET action = 'changed' WHERE id = ?").run(audit.id),
    /append-only/,
  );
  assert.throws(
    () => db.prepare("DELETE FROM audit_events WHERE id = ?").run(audit.id),
    /append-only/,
  );
});

test("logo mutations require a strong branding revision and admit one concurrent winner", async () => {
  const instance = await app();
  const { client, db } = instance;
  await client.login();
  const branding = await client.request("/api/public/branding");
  const revision = branding.payload.revision;
  assert.equal(branding.response.headers.get("etag"), `"${revision}"`);
  const png = await readFile(new URL("../site/assets/social-preview.png", import.meta.url));

  const missingPrecondition = await client.request("/api/branding/logo", {
    method: "PUT",
    contentType: "image/png",
    body: png,
  });
  assert.equal(missingPrecondition.response.status, 428);
  assert.equal(missingPrecondition.payload.error.code, "precondition_required");

  const malformedPrecondition = await client.request("/api/branding/logo", {
    method: "PUT",
    contentType: "image/png",
    headers: { "if-match": `W/"${revision}"` },
    body: png,
  });
  assert.equal(malformedPrecondition.response.status, 400);
  assert.equal(malformedPrecondition.payload.error.code, "invalid_precondition");

  const wrongMediaType = await client.request("/api/branding/logo", {
    method: "PUT",
    headers: { "if-match": `"${revision}"` },
    body: { disguisedAs: "a PNG" },
  });
  assert.equal(wrongMediaType.response.status, 422);
  assert.equal(wrongMediaType.payload.error.code, "invalid_logo");

  const contenders = await Promise.all([
    client.request("/api/branding/logo", {
      method: "PUT",
      contentType: "image/png",
      headers: { "if-match": `"${revision}"` },
      body: png,
    }),
    client.request("/api/branding/logo", {
      method: "PUT",
      contentType: "image/png",
      headers: { "if-match": `"${revision}"` },
      body: png,
    }),
  ]);
  const winner = contenders.find((result) => result.response.status === 200);
  const stale = contenders.find((result) => result.response.status === 409);
  assert.ok(winner);
  assert.ok(stale);
  assert.equal(stale.payload.error.code, "conflict");
  assert.equal(winner.payload.revision, revision + 1);
  assert.equal(winner.response.headers.get("etag"), `"${revision + 1}"`);
  assert.equal(
    db.prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'branding.logo_updated'",
    ).get().count,
    1,
  );

  const removed = await client.request("/api/branding/logo", {
    method: "DELETE",
    headers: { "if-match": `"${revision + 1}"` },
  });
  assert.equal(removed.response.status, 200);
  assert.equal(removed.payload.revision, revision + 2);
  assert.equal(removed.response.headers.get("etag"), `"${revision + 2}"`);
  assert.equal((await client.request("/api/public/branding/logo")).response.status, 404);
  assert.equal(
    db.prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'branding.logo_deleted'",
    ).get().count,
    1,
  );
});

test("a user can replace their own password and revoke every active session", async () => {
  const instance = await app({ requireBootstrapPasswordChange: true });
  const { client, db } = instance;
  const secondSession = instance.newClient();
  const initialLogin = await client.login();
  assert.equal(initialLogin.response.status, 200);
  assert.equal(initialLogin.payload.user.mustChangePassword, true);
  assert.equal((await secondSession.login()).response.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 2);
  const blockedWorkspace = await client.request("/api/dashboard");
  assert.equal(blockedWorkspace.response.status, 403);
  assert.equal(blockedWorkspace.payload.error.code, "password_change_required");

  const incorrect = await client.request("/api/auth/change-password", {
    method: "POST",
    body: {
      currentPassword: "not-the-current-password",
      newPassword: "replacement-password-2026",
    },
  });
  assert.equal(incorrect.response.status, 422);
  assert.equal(incorrect.payload.error.code, "invalid_current_password");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 2);

  const changed = await client.request("/api/auth/change-password", {
    method: "POST",
    body: {
      currentPassword: ADMIN_PASSWORD,
      newPassword: "replacement-password-2026",
    },
  });
  assert.equal(changed.response.status, 200);
  assert.match(changed.response.headers.get("set-cookie"), /vector_session=;/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);
  assert.equal(
    db.prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'user.password_changed'",
    ).get().count,
    1,
  );

  assert.equal((await secondSession.request("/api/dashboard")).response.status, 401);
  assert.equal((await instance.newClient().login()).response.status, 401);
  const replacementLogin = await instance.newClient().login(
      "admin@example.test",
      "replacement-password-2026",
    );
  assert.equal(replacementLogin.response.status, 200);
  assert.equal(replacementLogin.payload.user.mustChangePassword, false);
});

test("roles enforce school-wide read-only access and tutor assignment boundaries", async () => {
  const instance = await app({ seedSynthetic: true });
  const { client } = instance;
  assert.equal((await client.login()).response.status, 200);

  const tutorPassword = "assigned-tutor-password-2026";
  const viewerPassword = "school-viewer-password-2026";
  const tutorId = await createUser(client, {
    email: "assigned.tutor@example.test",
    displayName: "Assigned tutor",
    password: tutorPassword,
    role: "tutor",
    dataScope: "assigned",
  });
  await createUser(client, {
    email: "school.viewer@example.test",
    displayName: "School viewer",
    password: viewerPassword,
    role: "viewer",
    dataScope: "school",
  });

  const students = (await client.request("/api/students")).payload.items;
  const hosts = (await client.request("/api/hosts")).payload.items;
  const placement = await client.request("/api/placements", {
    method: "POST",
    body: {
      studentId: students[0].id,
      hostId: hosts[0].id,
      periodId: null,
      schoolTutorId: tutorId,
      startDate: "2026-07-01",
      endDate: "2026-07-31",
      targetHours: 40,
      status: "active",
    },
  });
  assert.equal(placement.response.status, 201);

  const tutor = instance.newClient();
  const tutorCurrentPassword = "assigned-tutor-password-2026";
  await replaceTemporaryPassword(
    tutor,
    "assigned.tutor@example.test",
    tutorCurrentPassword,
    "assigned-tutor-replacement-2026",
  );
  const assigned = await tutor.request("/api/placements");
  assert.equal(assigned.response.status, 200);
  assert.deepEqual(assigned.payload.items.map((item) => item.id), [placement.payload.id]);

  for (const body of [
    { revision: 1, status: "review" },
    { revision: 1, targetHours: 80, notes: "Tutors cannot change placement structure." },
  ]) {
    const structuralWrite = await tutor.request(`/api/placements/${placement.payload.id}`, {
      method: "PATCH",
      body,
    });
    assert.equal(structuralWrite.response.status, 403);
    assert.equal(structuralWrite.payload.error.code, "forbidden");
  }

  const time = await tutor.request(`/api/placements/${placement.payload.id}/time-entries`, {
    method: "POST",
    body: {
      entryDate: "2026-07-02",
      hours: 4,
      verificationStatus: "verified",
      description: "Student-submitted activity",
    },
  });
  assert.equal(time.response.status, 201);
  const detail = await tutor.request(`/api/placements/${placement.payload.id}`);
  assert.equal(detail.payload.timeEntries[0].verificationStatus, "pending");
  assert.equal(detail.payload.timeEntries[0].canEdit, true);

  const draft = await tutor.request(`/api/placements/${placement.payload.id}/documents`, {
    method: "POST",
    body: {
      kind: "other",
      title: "Tutor draft evidence",
      status: "draft",
    },
  });
  assert.equal(draft.response.status, 201);
  const tutorDetail = await tutor.request(`/api/placements/${placement.payload.id}`);
  assert.equal(
    tutorDetail.payload.documents.find((item) => item.id === draft.payload.id).canEdit,
    true,
  );

  const signed = await tutor.request(`/api/placements/${placement.payload.id}/documents`, {
    method: "POST",
    body: {
      kind: "evaluation",
      title: "Evaluation",
      status: "signed",
    },
  });
  assert.equal(signed.response.status, 403);
  assert.equal(signed.payload.error.code, "document_validation_required");

  const viewer = instance.newClient();
  await replaceTemporaryPassword(
    viewer,
    "school.viewer@example.test",
    viewerPassword,
    "school-viewer-replacement-2026",
  );
  assert.equal((await viewer.request("/api/placements")).payload.items.length, 7);
  const viewerDetail = await viewer.request(`/api/placements/${placement.payload.id}`);
  assert.equal(viewerDetail.payload.timeEntries[0].canEdit, false);
  assert.equal(
    viewerDetail.payload.documents.find((item) => item.id === draft.payload.id).canEdit,
    false,
  );
  const adminDetail = await client.request(`/api/placements/${placement.payload.id}`);
  assert.equal(adminDetail.payload.timeEntries[0].canEdit, true);
  assert.equal(
    adminDetail.payload.documents.find((item) => item.id === draft.payload.id).canEdit,
    true,
  );
  const viewerWrite = await viewer.request("/api/hosts", {
    method: "POST",
    body: { name: "Viewer cannot create this" },
  });
  assert.equal(viewerWrite.response.status, 403);
  assert.equal(viewerWrite.payload.error.code, "forbidden");
});

test("operational collections and reference lookups use bounded opaque cursors", async () => {
  const instance = await app({ seedSynthetic: true });
  const { client, db } = instance;
  await client.login();

  const placementIds = [];
  let cursor;
  do {
    const search = new URLSearchParams({ limit: "2", status: "all", query: "" });
    if (cursor) search.set("cursor", cursor);
    const page = await client.request(`/api/placements?${search}`);
    assert.equal(page.response.status, 200);
    assert.ok(page.payload.items.length <= 2);
    placementIds.push(...page.payload.items.map((item) => item.id));
    cursor = page.payload.nextCursor;
  } while (cursor);
  assert.equal(placementIds.length, 6);
  assert.equal(new Set(placementIds).size, placementIds.length);

  const students = await client.request("/api/students?limit=2&active=true&query=");
  assert.equal(students.response.status, 200);
  assert.equal(students.payload.items.length, 2);
  assert.match(students.payload.nextCursor, /^[A-Za-z0-9_.-]+$/);
  const [cursorHeader, sealedCursor] = students.payload.nextCursor.split(".");
  const tamperedCursor = `${cursorHeader}.${sealedCursor[0] === "A" ? "B" : "A"}${sealedCursor.slice(1)}`;
  const tampered = await client.request(
    `/api/students?limit=2&active=true&query=&cursor=${tamperedCursor}`,
  );
  assert.equal(tampered.response.status, 422);
  assert.equal(tampered.payload.error.code, "invalid_cursor");
  const rebound = await client.request(
    `/api/students?limit=2&active=false&query=&cursor=${students.payload.nextCursor}`,
  );
  assert.equal(rebound.response.status, 422);
  assert.equal(rebound.payload.error.code, "invalid_cursor");
  await createUser(client, {
    email: "cursor.viewer@example.test",
    displayName: "Cursor viewer",
    password: "cursor-viewer-password-2026",
    role: "viewer",
    dataScope: "school",
  });
  const viewer = instance.newClient();
  await replaceTemporaryPassword(
    viewer,
    "cursor.viewer@example.test",
    "cursor-viewer-password-2026",
    "cursor-viewer-replacement-2026",
  );
  const reboundScope = await viewer.request(
    `/api/students?limit=2&active=true&query=&cursor=${students.payload.nextCursor}`,
  );
  assert.equal(reboundScope.response.status, 422);
  assert.equal(reboundScope.payload.error.code, "invalid_cursor");
  const nextStudents = await client.request(
    `/api/students?limit=2&active=true&query=&cursor=${students.payload.nextCursor}`,
  );
  assert.equal(nextStudents.response.status, 200);
  assert.equal(
    nextStudents.payload.items.some(
      (item) => students.payload.items.some((previous) => previous.id === item.id),
    ),
    false,
  );

  const privateFirst = await client.request("/api/students", {
    method: "POST",
    body: {
      externalRef: "SYN-CURSOR-PRIVACY-01",
      firstName: "ConfidentialGivenMarker",
      lastName: "ConfidentialFamilyMarker",
      email: "",
      cohortId: null,
    },
  });
  assert.equal(privateFirst.response.status, 201);
  assert.equal((await client.request("/api/students", {
    method: "POST",
    body: {
      externalRef: "SYN-CURSOR-PRIVACY-02",
      firstName: "ConfidentialGivenMarkerTwo",
      lastName: "ConfidentialFamilyMarkerTwo",
      email: "",
      cohortId: null,
    },
  })).response.status, 201);
  const privatePage = await client.request(
    "/api/students?limit=1&active=true&query=SYN-CURSOR-PRIVACY-",
  );
  assert.equal(privatePage.response.status, 200);
  assert.ok(privatePage.payload.nextCursor);
  const privateEnvelope = privatePage.payload.nextCursor
    .split(".")
    .map((part) => Buffer.from(part, "base64url").toString("utf8"))
    .join("");
  for (const privatePosition of [
    privatePage.payload.items[0].firstName,
    privatePage.payload.items[0].firstName.toLowerCase(),
    privatePage.payload.items[0].lastName,
    privatePage.payload.items[0].lastName.toLowerCase(),
    privateFirst.payload.id,
  ]) {
    assert.equal(privatePage.payload.nextCursor.includes(privatePosition), false);
    assert.equal(privateEnvelope.includes(privatePosition), false);
  }

  const cohorts = await client.request("/api/reference-data/cohorts?limit=1");
  assert.equal(cohorts.response.status, 200);
  assert.equal(cohorts.payload.items.length, 1);
  assert.ok(cohorts.payload.nextCursor);
  const studentLookups = await client.request("/api/lookups/students?limit=2&query=");
  assert.equal(studentLookups.response.status, 200);
  assert.deepEqual(
    Object.keys(studentLookups.payload.items[0]).sort(),
    ["id", "label", "secondary"],
  );
  assert.equal((await client.request("/api/reference-data")).response.status, 404);

  const invalidCursor = await client.request("/api/hosts?cursor=not-a-cursor");
  assert.equal(invalidCursor.response.status, 422);
  assert.equal(invalidCursor.payload.error.code, "invalid_cursor");
  const oversizedPage = await client.request("/api/hosts?limit=101");
  assert.equal(oversizedPage.response.status, 400);
  assert.equal(oversizedPage.payload.error.code, "invalid_request");

  const schoolId = db.prepare("SELECT id FROM schools").get().id;
  const insert = db.prepare(`
    INSERT INTO students (
      id, school_id, external_ref, first_name, last_name, active,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
  `);
  const timestamp = "2020-01-01T00:00:00.000Z";
  db.transaction(() => {
    for (let index = 0; index < 1005; index += 1) {
      const suffix = String(index).padStart(4, "0");
      insert.run(
        `page-${suffix}`,
        schoolId,
        `SYN-PAGE-${suffix}`,
        "Page",
        `Student ${suffix}`,
        timestamp,
        timestamp,
      );
    }
    for (let index = 0; index < 2; index += 1) {
      insert.run(
        `unicode-${index}`,
        schoolId,
        `SYN-UNICODE-${index}`,
        "漢".repeat(120),
        `漢${index}`,
        timestamp,
        timestamp,
      );
    }
  })();
  const traversed = [];
  cursor = null;
  do {
    const search = new URLSearchParams({
      limit: "100",
      active: "false",
      query: "SYN-PAGE-",
    });
    if (cursor) search.set("cursor", cursor);
    const page = await client.request(`/api/students?${search}`);
    assert.equal(page.response.status, 200);
    traversed.push(...page.payload.items.map((item) => item.id));
    cursor = page.payload.nextCursor;
  } while (cursor);
  assert.equal(traversed.length, 1005);
  assert.equal(new Set(traversed).size, 1005);

  const unicode = await client.request(
    "/api/students?limit=1&active=false&query=SYN-UNICODE-",
  );
  assert.equal(unicode.response.status, 200);
  assert.ok(unicode.payload.nextCursor.length <= 2048);
  const unicodeNext = await client.request(
    `/api/students?limit=1&active=false&query=SYN-UNICODE-&cursor=${unicode.payload.nextCursor}`,
  );
  assert.equal(unicodeNext.response.status, 200);
});

test("exports fail closed above the documented cap and accept narrowing filters", async () => {
  const instance = await app();
  const { client, db } = instance;
  await client.login();
  const schoolId = db.prepare("SELECT id FROM schools").get().id;
  const insert = db.prepare(`
    INSERT INTO students (
      id, school_id, external_ref, first_name, last_name, active,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
  `);
  const timestamp = "2020-01-01T00:00:00.000Z";
  db.transaction(() => {
    for (let index = 0; index < 10_001; index += 1) {
      const suffix = String(index).padStart(5, "0");
      insert.run(
        `export-${suffix}`,
        schoolId,
        `SYN-EXPORT-${suffix}`,
        "Synthetic",
        `Export ${suffix}`,
        timestamp,
        timestamp,
      );
    }
  })();

  const rejected = await client.request("/api/export?resource=students&format=csv");
  assert.equal(rejected.response.status, 422);
  assert.equal(rejected.payload.error.code, "export_row_limit");

  const narrowed = await client.request(
    "/api/export?resource=students&format=csv&query=SYN-EXPORT-00000",
  );
  assert.equal(narrowed.response.status, 200, JSON.stringify(narrowed.payload));
  assert.match(narrowed.payload, /SYN-EXPORT-00000/);
});

test("audit cursors reject tampering, filter replay and another authorized user", async () => {
  const instance = await app();
  const { client } = instance;
  await client.login();
  for (let index = 0; index < 4; index += 1) {
    const createdHost = await client.request("/api/hosts", {
      method: "POST",
      body: { name: `Audit cursor host ${index}` },
    });
    assert.equal(createdHost.response.status, 201);
  }
  await createUser(client, {
    email: "cursor.coordinator@example.test",
    displayName: "Cursor coordinator",
    password: "cursor-coordinator-password-2026",
    role: "coordinator",
    dataScope: "school",
  });
  const page = await client.request("/api/audit?limit=2&action=");
  assert.equal(page.response.status, 200);
  assert.ok(page.payload.nextCursor);
  const [headerPart, sealedPart] = page.payload.nextCursor.split(".");
  const tamperedCursor = `${headerPart}.${sealedPart[0] === "A" ? "B" : "A"}${sealedPart.slice(1)}`;
  const tampered = await client.request(
    `/api/audit?limit=2&action=&cursor=${tamperedCursor}`,
  );
  assert.equal(tampered.response.status, 422);
  assert.equal(tampered.payload.error.code, "invalid_cursor");
  const rebound = await client.request(
    `/api/audit?limit=2&action=host.created&cursor=${page.payload.nextCursor}`,
  );
  assert.equal(rebound.response.status, 422);
  assert.equal(rebound.payload.error.code, "invalid_cursor");

  const coordinator = instance.newClient();
  await replaceTemporaryPassword(
    coordinator,
    "cursor.coordinator@example.test",
    "cursor-coordinator-password-2026",
    "cursor-coordinator-replacement-2026",
  );
  const reboundUser = await coordinator.request(
    `/api/audit?limit=2&action=&cursor=${page.payload.nextCursor}`,
  );
  assert.equal(reboundUser.response.status, 422);
  assert.equal(reboundUser.payload.error.code, "invalid_cursor");
});

test("a placement can close only after verified hours, a check-in and required evidence", async () => {
  const instance = await app();
  const { client } = instance;
  await client.login();

  const student = await client.request("/api/students", {
    method: "POST",
    body: {
      externalRef: "SYN-READY-01",
      firstName: "Alex",
      lastName: "Morgan",
      email: "alex.morgan@example.test",
      cohortId: null,
    },
  });
  const host = await client.request("/api/hosts", {
    method: "POST",
    body: { name: "Fictional Engineering Cooperative", sector: "Engineering" },
  });
  const invalidInitialState = await client.request("/api/placements", {
    method: "POST",
    body: {
      studentId: student.payload.id,
      hostId: host.payload.id,
      periodId: null,
      schoolTutorId: null,
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      targetHours: 2,
      status: "complete",
    },
  });
  assert.equal(invalidInitialState.response.status, 422);
  assert.equal(invalidInitialState.payload.error.code, "invalid_initial_status");
  const placement = await client.request("/api/placements", {
    method: "POST",
    body: {
      studentId: student.payload.id,
      hostId: host.payload.id,
      periodId: null,
      schoolTutorId: null,
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      targetHours: 2,
    },
  });
  const path = `/api/placements/${placement.payload.id}`;
  assert.equal(
    (await client.request(path, {
      method: "PATCH",
      body: { revision: 1, status: "active" },
    })).payload.revision,
    2,
  );
  assert.equal(
    (await client.request(path, {
      method: "PATCH",
      body: { revision: 2, status: "review" },
    })).payload.revision,
    3,
  );

  const premature = await client.request(path, {
    method: "PATCH",
    body: { revision: 3, status: "complete" },
  });
  assert.equal(premature.response.status, 422);
  assert.equal(premature.payload.error.code, "placement_not_ready");
  assert.deepEqual(
    premature.payload.error.details.blockers.map((item) => item.code).sort(),
    [
      "check_in_missing",
      "document_attendance_log",
      "document_evaluation",
      "document_training_agreement",
      "hours_incomplete",
    ],
  );

  const timeEntry = await client.request(`${path}/time-entries`, {
    method: "POST",
    body: {
      entryDate: "2026-06-03",
      hours: 2,
      verificationStatus: "verified",
      description: "Verified synthetic activity",
    },
  });
  assert.equal(timeEntry.response.status, 201);
  await client.request(`${path}/check-ins`, {
    method: "POST",
    body: {
      occurredAt: "2026-06-10T09:00:00.000Z",
      channel: "video",
      summary: "Synthetic progress check.",
    },
  });
  const documentIds = [];
  for (const document of [
    ["training_agreement", "Training agreement", "signed"],
    ["attendance_log", "Attendance log", "signed"],
    ["evaluation", "Evaluation", "ready"],
  ]) {
    const result = await client.request(`${path}/documents`, {
      method: "POST",
      body: { kind: document[0], title: document[1], status: document[2] },
    });
    assert.equal(result.response.status, 201);
    documentIds.push(result.payload.id);
  }

  const duplicateDocument = await client.request(`${path}/documents`, {
    method: "POST",
    body: {
      kind: "evaluation",
      title: "Conflicting evaluation",
      status: "draft",
    },
  });
  assert.equal(duplicateDocument.response.status, 409);
  assert.equal(duplicateDocument.payload.error.code, "document_kind_exists");
  assert.deepEqual(
    duplicateDocument.payload.error.details,
    { documentId: documentIds[2], kind: "evaluation" },
  );

  const complete = await client.request(path, {
    method: "PATCH",
    body: { revision: 3, status: "complete" },
  });
  assert.equal(complete.response.status, 200);
  const detail = await client.request(path);
  assert.equal(detail.payload.status, "complete");
  assert.equal(detail.payload.readiness.ready, true);
  assert.match(detail.payload.readiness.fingerprint, /^[0-9a-f]{64}$/);

  for (const blockedMutation of [
    client.request(`${path}/time-entries`, {
      method: "POST",
      body: {
        entryDate: "2026-06-04",
        hours: 1,
        description: "Must not reopen completed evidence",
      },
    }),
    client.request(`${path}/check-ins`, {
      method: "POST",
      body: {
        occurredAt: "2026-06-11T09:00:00.000Z",
        channel: "phone",
        summary: "Must not alter a completed placement.",
      },
    }),
    client.request(`${path}/documents`, {
      method: "POST",
      body: {
        kind: "completion_certificate",
        title: "Must not be added",
        status: "draft",
      },
    }),
    client.request(`${path}/time-entries/${timeEntry.payload.id}`, {
      method: "PATCH",
      body: { revision: 1, verificationStatus: "rejected" },
    }),
    client.request(`${path}/documents/${documentIds[2]}`, {
      method: "PATCH",
      body: { revision: 1, status: "archived" },
    }),
    client.request(path, {
      method: "PATCH",
      body: { revision: 4, notes: "Completed records are immutable." },
    }),
  ]) {
    const result = await blockedMutation;
    assert.equal(result.response.status, 409);
    assert.equal(result.payload.error.code, "placement_frozen");
  }
});

test("cancelled placements freeze evidence until explicitly reopened as planned", async () => {
  const instance = await app();
  const { client } = instance;
  await client.login();

  const student = await client.request("/api/students", {
    method: "POST",
    body: {
      externalRef: "SYN-CANCEL-01",
      firstName: "Jordan",
      lastName: "Quinn",
      email: "jordan.quinn@example.test",
      cohortId: null,
    },
  });
  const host = await client.request("/api/hosts", {
    method: "POST",
    body: { name: "Synthetic Design Studio", sector: "Design" },
  });
  const placement = await client.request("/api/placements", {
    method: "POST",
    body: {
      studentId: student.payload.id,
      hostId: host.payload.id,
      periodId: null,
      schoolTutorId: null,
      startDate: "2026-05-01",
      endDate: "2026-05-31",
      targetHours: 20,
    },
  });
  const path = `/api/placements/${placement.payload.id}`;
  const cancelled = await client.request(path, {
    method: "PATCH",
    body: { revision: 1, status: "cancelled" },
  });
  assert.equal(cancelled.response.status, 200);

  const blockedEvidence = await client.request(`${path}/check-ins`, {
    method: "POST",
    body: {
      occurredAt: "2026-05-02T09:00:00.000Z",
      channel: "email",
      summary: "This must remain frozen.",
    },
  });
  assert.equal(blockedEvidence.response.status, 409);
  assert.equal(blockedEvidence.payload.error.code, "placement_frozen");

  const blockedEdit = await client.request(path, {
    method: "PATCH",
    body: { revision: 2, notes: "No edits while cancelled." },
  });
  assert.equal(blockedEdit.response.status, 409);
  assert.equal(blockedEdit.payload.error.code, "placement_frozen");

  const mixedReopen = await client.request(path, {
    method: "PATCH",
    body: { revision: 2, status: "planned", notes: "No bundled edits." },
  });
  assert.equal(mixedReopen.response.status, 409);
  assert.equal(mixedReopen.payload.error.code, "placement_frozen");

  const reopened = await client.request(path, {
    method: "PATCH",
    body: { revision: 2, status: "planned" },
  });
  assert.equal(reopened.response.status, 200);
  assert.equal(reopened.payload.revision, 3);

  const mutableAgain = await client.request(`${path}/check-ins`, {
    method: "POST",
    body: {
      occurredAt: "2026-05-02T09:00:00.000Z",
      channel: "email",
      summary: "The placement was explicitly reopened.",
    },
  });
  assert.equal(mutableAgain.response.status, 201);
});

test("CSV import is all-or-nothing and export neutralizes spreadsheet formulas", async () => {
  const instance = await app();
  const { client } = instance;
  await client.login();
  const header = "externalRef,firstName,lastName,email,cohortName,cohortAcademicYear";
  const record = "SYN-CSV-01,Robin,Gray,robin.gray@example.test,,";
  const template = await client.request("/api/import/students/template");
  assert.equal(template.response.status, 200);
  assert.equal(
    template.response.headers.get("content-disposition"),
    'attachment; filename="vector-students-import-template.csv"',
  );
  assert.equal(template.response.headers.get("cache-control"), "no-store");
  assert.equal(template.payload, `${header}\r\n`);
  const dryRun = await client.request("/api/import/students?dryRun=true", {
    method: "POST",
    contentType: "text/csv",
    body: `${header}\n${record}\n`,
  });
  assert.equal(dryRun.response.status, 200);
  assert.equal(dryRun.payload.accepted, 1);
  assert.equal((await client.request("/api/students")).payload.items.length, 0);

  const committed = await client.request("/api/import/students?dryRun=false", {
    method: "POST",
    contentType: "text/csv",
    body: `${header}\n${record}\n`,
  });
  assert.equal(committed.response.status, 200);
  assert.equal((await client.request("/api/students")).payload.items.length, 1);

  const duplicateFile = await client.request("/api/import/students?dryRun=false", {
    method: "POST",
    contentType: "text/csv",
    body: `${header}\nSYN-CSV-02,Jamie,Lee,,,\nsyn-csv-02,Casey,Lee,,,\n`,
  });
  assert.equal(duplicateFile.response.status, 422);
  assert.equal(duplicateFile.payload.error.code, "import_rejected");
  assert.equal((await client.request("/api/students")).payload.items.length, 1);

  const longEmail = `${"x".repeat(255)}@example.test`;
  const invalid = await client.request("/api/import/students?dryRun=false", {
    method: "POST",
    contentType: "text/csv",
    body: `${header}\nSYN-CSV-03,Long,Email,${longEmail},,\n`,
  });
  assert.equal(invalid.response.status, 422);
  assert.equal(invalid.payload.error.code, "import_rejected");
  assert.equal(
    invalid.payload.error.details.errors.some(
      (error) => error.field === "email" && error.code === "field_too_long",
    ),
    true,
  );

  const unknownHeader = await client.request("/api/import/students?dryRun=true", {
    method: "POST",
    contentType: "text/csv",
    body: `${header},unexpected\nSYN-CSV-04,A,B,,,,value\n`,
  });
  assert.equal(unknownHeader.response.status, 422);
  assert.equal(unknownHeader.payload.error.code, "invalid_csv_headers");

  const duplicateHeader = await client.request("/api/import/students?dryRun=true", {
    method: "POST",
    contentType: "text/csv",
    body: "externalRef,firstName,lastName,firstName\nSYN-CSV-05,A,B,C\n",
  });
  assert.equal(duplicateHeader.response.status, 422);
  assert.deepEqual(duplicateHeader.payload.error.details.duplicate, ["firstName"]);

  await client.request("/api/hosts", {
    method: "POST",
    body: {
      name: "=SUM(1,2)",
      sector: "Synthetic test",
      contactName: "  =REMOTE()",
    },
  });
  const exported = await client.request("/api/export?resource=hosts&format=csv");
  assert.equal(exported.response.status, 200);
  assert.match(exported.payload, /"'=SUM\(1,2\)"/);
  assert.match(exported.payload, /'  =REMOTE\(\)/);

  const completedImport = await client.request("/api/import/placements?dryRun=false", {
    method: "POST",
    contentType: "text/csv",
    body: [
      "studentExternalRef,hostName,periodName,schoolTutorEmail,hostTutorName,hostTutorEmail,startDate,endDate,targetHours,status,notes",
      'SYN-CSV-01,"=SUM(1,2)",,,,,2026-10-01,2026-10-31,20,complete,',
      "",
    ].join("\n"),
  });
  assert.equal(completedImport.response.status, 422);
  assert.equal(
    completedImport.payload.error.details.errors.some(
      (error) => error.field === "status" && error.code === "completion_evidence_required",
    ),
    true,
  );
});

test("references from another school are rejected without a partial placement or audit event", async () => {
  const instance = await app();
  const { client, db } = instance;
  await client.login();
  const host = await client.request("/api/hosts", {
    method: "POST",
    body: { name: "Local fictional host" },
  });
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO schools (
      id, slug, name, short_name, product_name, contact_text, footer_text,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "foreign-school",
    "foreign-school",
    "Foreign synthetic school",
    "Foreign",
    "VECTOR",
    "Synthetic contact",
    "Synthetic footer",
    now,
    now,
  );
  db.prepare(`
    INSERT INTO students (
      id, school_id, external_ref, first_name, last_name, active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    "foreign-student",
    "foreign-school",
    "SYN-FOREIGN-01",
    "Foreign",
    "Student",
    now,
    now,
  );
  const auditBefore = db.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count;
  const rejected = await client.request("/api/placements", {
    method: "POST",
    body: {
      studentId: "foreign-student",
      hostId: host.payload.id,
      periodId: null,
      schoolTutorId: null,
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      targetHours: 40,
    },
  });
  assert.equal(rejected.response.status, 422);
  assert.equal(rejected.payload.error.code, "invalid_reference");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM placements").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count, auditBefore);
});

test("student and host corrections use optimistic revisions and remain auditable", async () => {
  const instance = await app();
  const { client } = instance;
  await client.login();
  const student = await client.request("/api/students", {
    method: "POST",
    body: {
      externalRef: "SYN-EDIT-01",
      firstName: "Before",
      lastName: "Student",
      cohortId: null,
    },
  });
  const host = await client.request("/api/hosts", {
    method: "POST",
    body: { name: "Before host" },
  });
  let students = (await client.request("/api/students")).payload.items;
  let hosts = (await client.request("/api/hosts")).payload.items;
  assert.equal(students[0].revision, 1);
  assert.equal(hosts[0].revision, 1);

  const studentUpdate = await client.request(`/api/students/${student.payload.id}`, {
    method: "PATCH",
    body: { revision: 1, firstName: "After", active: false },
  });
  const hostUpdate = await client.request(`/api/hosts/${host.payload.id}`, {
    method: "PATCH",
    body: { revision: 1, name: "After host", contactEmail: "contact@example.test" },
  });
  assert.equal(studentUpdate.payload.revision, 2);
  assert.equal(hostUpdate.payload.revision, 2);

  const stale = await client.request(`/api/students/${student.payload.id}`, {
    method: "PATCH",
    body: { revision: 1, lastName: "Stale" },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.payload.error.code, "conflict");

  students = (await client.request("/api/students")).payload.items;
  hosts = (await client.request("/api/hosts")).payload.items;
  assert.equal(students[0].firstName, "After");
  assert.equal(students[0].active, false);
  assert.equal(hosts[0].name, "After host");
  assert.equal(hosts[0].contactEmail, "contact@example.test");
  const audit = await client.request("/api/audit?limit=20");
  assert.equal(audit.payload.items.some((item) => item.action === "student.updated"), true);
  assert.equal(audit.payload.items.some((item) => item.action === "host.updated"), true);
});

test("retention deletes deterministic approved batches while preserving held records", async () => {
  const instance = await app();
  const { client, db } = instance;
  await client.login();
  const schoolId = db.prepare("SELECT id FROM schools").get().id;
  const insert = db.prepare(`
    INSERT INTO students (
      id, school_id, external_ref, first_name, last_name, active,
      retention_hold, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
  `);
  const oldTimestamp = "2020-01-01T00:00:00.000Z";
  db.transaction(() => {
    for (let index = 0; index < 1002; index += 1) {
      const suffix = String(index).padStart(4, "0");
      insert.run(
        `retention-${suffix}`,
        schoolId,
        `SYN-RET-${suffix}`,
        "Synthetic",
        "Retention",
        index === 1001 ? 1 : 0,
        oldTimestamp,
        oldTimestamp,
      );
    }
  })();

  const dryRun = await client.request("/api/maintenance/retention", {
    method: "POST",
    body: { beforeDate: "2025-01-01", dryRun: true, confirm: "" },
  });
  assert.equal(dryRun.response.status, 200);
  assert.equal(dryRun.payload.candidates, 1000);
  assert.equal(dryRun.payload.hasMore, true);
  assert.equal(dryRun.payload.held, 1);
  assert.equal(dryRun.payload.preview.length, 1000);

  db.prepare("UPDATE students SET revision = revision + 1 WHERE id = ?")
    .run(dryRun.payload.preview[0].id);
  const staleExecution = await client.request("/api/maintenance/retention", {
    method: "POST",
    body: {
      beforeDate: "2025-01-01",
      dryRun: false,
      confirm: "ERASE EXPIRED RECORDS",
      fingerprint: dryRun.payload.fingerprint,
    },
  });
  assert.equal(staleExecution.response.status, 409);
  assert.equal(staleExecution.payload.error.code, "retention_snapshot_changed");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM students").get().count, 1002);

  const approved = await client.request("/api/maintenance/retention", {
    method: "POST",
    body: { beforeDate: "2025-01-01", dryRun: true, confirm: "" },
  });
  const firstBatch = await client.request("/api/maintenance/retention", {
    method: "POST",
    body: {
      beforeDate: "2025-01-01",
      dryRun: false,
      confirm: "ERASE EXPIRED RECORDS",
      fingerprint: approved.payload.fingerprint,
    },
  });
  assert.equal(firstBatch.response.status, 200);
  assert.equal(firstBatch.payload.deletedStudents, 1000);
  assert.equal(firstBatch.payload.hasMore, true);
  assert.equal(typeof firstBatch.payload.cleanupPending, "boolean");

  const remainder = await client.request("/api/maintenance/retention", {
    method: "POST",
    body: { beforeDate: "2025-01-01", dryRun: true, confirm: "" },
  });
  assert.equal(remainder.payload.candidates, 1);
  assert.equal(remainder.payload.hasMore, false);
  assert.equal(remainder.payload.held, 1);
  const finalBatch = await client.request("/api/maintenance/retention", {
    method: "POST",
    body: {
      beforeDate: "2025-01-01",
      dryRun: false,
      confirm: "ERASE EXPIRED RECORDS",
      fingerprint: remainder.payload.fingerprint,
    },
  });
  assert.equal(finalBatch.payload.deletedStudents, 1);

  const empty = await client.request("/api/maintenance/retention", {
    method: "POST",
    body: { beforeDate: "2025-01-01", dryRun: true, confirm: "" },
  });
  assert.equal(empty.payload.candidates, 0);
  assert.equal(empty.payload.held, 1);
  const emptyExecution = await client.request("/api/maintenance/retention", {
    method: "POST",
    body: {
      beforeDate: "2025-01-01",
      dryRun: false,
      confirm: "ERASE EXPIRED RECORDS",
      fingerprint: empty.payload.fingerprint,
    },
  });
  assert.equal(emptyExecution.payload.deletedStudents, 0);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'retention.executed'")
      .get().count,
    3,
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM students").get().count, 1);

  const individualErase = await client.request("/api/students/retention-1001", {
    method: "DELETE",
    body: { confirm: "ERASE STUDENT" },
  });
  assert.equal(individualErase.response.status, 404);
});
