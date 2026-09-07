import assert from "node:assert/strict";
import test from "node:test";
import { startTestApp } from "../test-support/server-test-helper.mjs";

test("zero-minute input returns 422 without changing placement activity or its audit trail", async () => {
  const instance = await startTestApp();
  try {
    const { client, db } = instance;
    await client.login();
    const student = await client.request("/api/students", {
      method: "POST",
      body: { externalRef: "HOURS-01", firstName: "Alex", lastName: "Example" },
    });
    assert.equal(student.response.status, 201);
    const host = await client.request("/api/hosts", {
      method: "POST",
      body: { name: "Fictional Hours Host" },
    });
    assert.equal(host.response.status, 201);
    const placement = await client.request("/api/placements", {
      method: "POST",
      body: {
        studentId: student.payload.id,
        hostId: host.payload.id,
        startDate: "2020-01-01",
        endDate: "2020-01-31",
        targetHours: 2,
      },
    });
    assert.equal(placement.response.status, 201);
    const endpoint = `/api/placements/${placement.payload.id}/time-entries`;
    const countAudit = () => db.prepare(
      "SELECT COUNT(*) FROM audit_events WHERE action LIKE 'time_entry.%'",
    ).pluck().get();
    const auditBefore = countAudit();

    const rejectedCreate = await client.request(endpoint, {
      method: "POST",
      body: { entryDate: "2020-01-03", hours: 1e-12 },
    });
    assert.equal(rejectedCreate.response.status, 422);
    assert.equal(rejectedCreate.payload.error.code, "invalid_hours");
    assert.equal(db.prepare("SELECT COUNT(*) FROM time_entries").pluck().get(), 0);
    assert.equal(countAudit(), auditBefore);

    const valid = await client.request(endpoint, {
      method: "POST",
      body: { entryDate: "2020-01-03", hours: 1 },
    });
    assert.equal(valid.response.status, 201);
    const auditAfterCreate = countAudit();
    const rejectedUpdate = await client.request(`${endpoint}/${valid.payload.id}`, {
      method: "PATCH",
      body: { revision: 1, hours: 1e-12 },
    });
    assert.equal(rejectedUpdate.response.status, 422);
    assert.equal(rejectedUpdate.payload.error.code, "invalid_hours");
    assert.deepEqual(
      db.prepare("SELECT minutes, revision FROM time_entries WHERE id = ?").get(valid.payload.id),
      { minutes: 60, revision: 1 },
    );
    assert.equal(countAudit(), auditAfterCreate);
  } finally {
    await instance.close();
  }
});
