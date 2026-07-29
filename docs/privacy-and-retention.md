# Privacy and retention

VECTOR can hold student, staff and host-organisation records. The software does not determine
whether an institution may collect that data or how long it should keep it. The deploying
institution remains responsible for its legal basis, notices, data minimisation, access controls,
retention, data-subject requests and incident response.

Nothing in this guide is a compliance certification or legal opinion. Obtain qualified advice for
the institution's jurisdiction and use case.

## Before importing real records

The institution should document:

- the specific placement process VECTOR supports and the legal basis for each use;
- which teams act as controller, operator or service provider;
- the minimum fields needed for that process;
- who may see school-wide data and who is limited to assigned placements;
- the retention period and deletion trigger for each record category;
- how access, correction, export, restriction and deletion requests are handled;
- where the host, backups, logs and support material are stored;
- which processors or infrastructure providers receive data;
- the incident and breach-notification process; and
- whether a data protection impact assessment is required.

Complete a DPIA before launch when the institution's assessment or applicable law requires one.
Revisit it when the purpose, data categories, integrations, users or hosting arrangement changes.

## Minimise what VECTOR receives

Collect only fields staff need to operate placements. Avoid placing health information,
government-issued identifiers, disciplinary details, free-form safeguarding notes or unrelated
special-category data in general notes or document references.

Use stable institution identifiers only when they are necessary. Do not repurpose email addresses
or external references as public identifiers. Synthetic fixtures are for evaluation and training;
do not mix them into a real installation.

Imports and exports can broaden exposure quickly. Review
[the import and export guide](import-export.md) before moving data.

## Access and accountability

- Give each staff member a named account.
- Grant the least role and data scope needed for the person's work.
- Limit school-wide administrator and coordinator access.
- Treat the cohort coverage board as a school-wide planning view: it includes active students who
  do not yet have a placement and is therefore unavailable to tutor accounts.
- Review active accounts and assignments on a documented schedule.
- Remove or disable access promptly when responsibilities change.
- Protect administrator credentials with an institution-approved password process.
- Set the absolute and inactivity session limits for the risks of shared school computers; neither
  replaces signing out when leaving a device.
- Review audit events for unexpected exports, bulk changes and administrative actions.
- Keep support reports, screenshots and logs free of real records whenever possible.

The application audit trail supports operational review; it does not replace the institution's
governance or monitoring process.

## Retention design

Set retention from the placement purpose and applicable obligations, not from available disk space.
A single blanket period is often inappropriate. Consider separate decisions for:

| Record category | Decision to document |
| --- | --- |
| Student and placement details | End event, operational need and any statutory record period |
| Host contacts | Whether the contact remains relevant for active placement work |
| Time entries and evaluations | Education or employment record obligations |
| Check-ins and free-text notes | Shortest period needed for follow-up and accountability |
| Document references | Whether the referenced source still exists and who owns it |
| User accounts and sessions | Disablement trigger and session expiry |
| Audit events | Security and accountability need balanced against personal-data exposure |
| Imports, exports and backups | Short working-copy lifetime plus approved backup retention |

Before automated deletion is enabled, define how linked records, audit events, legal holds and
backups are handled. Test the policy with synthetic data and require an authorized review before
the first production deletion.

Deleting a live record does not immediately remove copies held in backups. Document when expired
backups age out, how restored data is brought back under the current retention policy, and how legal
holds pause disposal.

## Run a retention review

VECTOR does not expose an individual student-delete endpoint. Production erasure goes through the
governed retention endpoint, which is restricted to a school administrator:

```text
POST /api/maintenance/retention
```

`beforeDate` is an exclusive cut-off. A student is eligible only when `active` is false,
`retentionHold` is false and one of these conditions is true:

- the student has no placements and the student's `updated_at` timestamp is earlier than the
  cut-off; or
- the student has placements, every placement is `complete` or `cancelled`, and every placement
  `end_date` is earlier than the cut-off.

Administrators can set `retentionHold: true` on a student while a legal, safeguarding or records
hold is active. Held records are excluded from deletion and counted in `held`.

Start with a dry run:

```json
{
  "beforeDate": "2024-08-01",
  "dryRun": true,
  "confirm": ""
}
```

The response describes one deterministic batch of at most 1,000 students:

```json
{
  "beforeDate": "2024-08-01",
  "dryRun": true,
  "deletedPlacements": 0,
  "deletedStudents": 0,
  "candidates": 2,
  "hasMore": false,
  "held": 1,
  "cleanupPending": false,
  "fingerprint": "3d7a5f5d413de392ed2fc640ba9f8c7d127e6e00f6e15f97ad9ef60efcfc4912",
  "preview": [
    {
      "id": "7cf48d0b-9ff4-4783-8ba9-c403fd9615c8",
      "externalRef": "STU-1042",
      "placementCount": 1,
      "lastPlacementEnd": "2024-06-28",
      "updatedAt": "2024-07-02T10:04:12.000Z"
    }
  ]
}
```

Review the cut-off, `candidates`, `held`, every preview row and `hasMore` against the approved
schedule and a newly inspected backup. The `fingerprint` binds the exact candidate batch and its
placement state. Do not edit or shorten it.

Execute only the reviewed batch by sending that fingerprint with the exact confirmation phrase
`ERASE EXPIRED RECORDS`:

```json
{
  "beforeDate": "2024-08-01",
  "dryRun": false,
  "confirm": "ERASE EXPIRED RECORDS",
  "fingerprint": "3d7a5f5d413de392ed2fc640ba9f8c7d127e6e00f6e15f97ad9ef60efcfc4912"
}
```

VECTOR rejects the execution with `409 retention_snapshot_changed` if any candidate, hold,
placement status, date or revision changed after review. Run a new dry run and review it again; do
not retry with the old fingerprint. Deleting a student also removes that student's placements and
dependent placement records. VECTOR writes one aggregated `retention.executed` audit event for
each execution, including a zero-candidate execution.

When `hasMore` is true, the approved fingerprint covers only the current batch. After it executes,
request a new dry run, review the next batch and repeat until a dry run returns `hasMore: false`.
Never reuse a fingerprint between batches.

The database deletion is committed before VECTOR attempts a passive WAL checkpoint. A response
with `cleanupPending: true` therefore means the deletion succeeded but SQLite could not fully
checkpoint the write-ahead log. Schedule a maintenance window, create and inspect another backup,
stop VECTOR and run:

```sh
npm run db:compact -- --confirm-maintenance
```

Compaction enables SQLite secure deletion for the maintenance operation, checkpoints WAL and runs
`VACUUM`. It cannot erase copies already present in backups, host snapshots, exports or logs. Those
copies must expire under their own approved schedules. Even with secure deletion, storage-layer
snapshots and flash-media behaviour can prevent a guarantee of physical erasure.

The endpoint is a controlled deletion mechanism, not a retention policy. The institution must still
decide the cutoff, approve the run, account for backups and verify the result.

## Hosting and transport

- Use HTTPS for every production session and keep `VECTOR_COOKIE_SECURE=true`.
- Trust forwarding headers only from the exact controlled proxy hop count; never use unrestricted
  proxy trust.
- Encrypt backup and export storage and restrict it to authorized operators.
- Keep the SQLite volume on a protected local filesystem.
- Patch the operating system, container runtime, proxy and VECTOR release.
- Avoid verbose logs that include request bodies, record content, credentials or tokens.
- Configure reverse-proxy access logs to omit the entire query string. A `query=` search can contain
  a student, staff member or host name; do not copy it into access logs, analytics or error reports.
- Apply the institution's requirements for hosting region, subprocessors and international
  transfers.

Encryption, TLS and access controls reduce risk; they do not establish a lawful purpose by
themselves.

## Requests and incidents

Define an authenticated process for locating all records connected to a person, correcting them and
producing or deleting them where required. Verify the requester's identity outside public issue
trackers. Record approvals and exceptions without copying unnecessary personal data into tickets.

For a suspected incident:

1. restrict further access without destroying evidence;
2. preserve relevant, access-controlled logs and audit events;
3. identify affected systems, records and time periods;
4. involve the institution's security and privacy contacts; and
5. follow applicable assessment and notification deadlines.

Do not send production databases or raw exports to the public project issue tracker. Use the
[security reporting channel](../SECURITY.md) for product vulnerabilities and keep affected personal
records out of the report.
