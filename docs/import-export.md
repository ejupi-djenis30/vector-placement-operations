# Import and export

Imports and exports are high-impact administrative operations. They can create many records at once
or place a complete working dataset outside VECTOR's access controls. Use a named administrator,
an approved source or destination and a documented reason for every transfer.

## Prepare source data

Before an import:

1. Make a verified VECTOR backup.
2. Work from an institution-approved source, not an attachment of unknown origin.
3. Remove columns and rows that are not needed for placement operations.
4. Normalise dates, email addresses and external references in the source system.
5. Resolve duplicate students and host organisations before upload.
6. Replace formulas with values and check for spreadsheet cells that begin with executable formula
   characters.
7. Test the workflow with synthetic data in an isolated installation.

Do not include passwords, session tokens, health information, government identifiers or unrelated
case notes in an import file.

## Import safely

Use VECTOR's authenticated import workflow rather than editing SQLite tables. The application
validates the complete file before applying accepted rows and reports rejected rows without
silently weakening field or relationship rules.

The current API accepts CSV for three resources:

```text
POST /api/import/students?dryRun=true
POST /api/import/hosts?dryRun=true
POST /api/import/placements?dryRun=true
```

Download the current header-only template instead of keeping a hand-edited copy:

```text
GET /api/import/students/template
GET /api/import/hosts/template
GET /api/import/placements/template
```

The response is a UTF-8 CSV attachment with a byte-order mark and these exact, case-sensitive
headers:

| Resource | Header row |
| --- | --- |
| Students | `externalRef,firstName,lastName,email,cohortName,cohortAcademicYear` |
| Hosts | `name,sector,contactName,contactEmail,contactPhone,address` |
| Placements | `studentExternalRef,hostName,programmeCode,periodName,schoolTutorEmail,hostTutorName,hostTutorEmail,startDate,endDate,targetHours,status,notes` |

Templates deliberately use stable operational keys, not VECTOR's internal UUIDs. Student imports
match a cohort by the pair `cohortName` and `cohortAcademicYear`. Placement imports match the
student's `studentExternalRef`, the host's `hostName`, an optional `periodName` and an optional
`schoolTutorEmail`. `programmeCode` selects the latest published version of an active programme.
Files made from an older VECTOR 3.0 template may omit that column; VECTOR then uses
`VECTOR_DEFAULT`. Add an explicit programme code to every new operational template so the policy
choice is visible and reviewable. Each reference must resolve to exactly one active record in the
signed-in administrator's school. Missing, inactive or ambiguous references reject the whole file.

Send the completed file as `text/csv`. Start with `dryRun=true`, review the returned row errors and
counts, then repeat the same validated file with `dryRun=false`. A dry run performs the same
validation but writes no records or audit event. Import is atomic: for a commit, VECTOR revalidates
duplicates and active references while holding the same immediate write transaction used for every
insert and its audit event. It does not commit a partial set when validation fails. A committed
import records one aggregated audit event instead of copying every input value into the audit trail.
One import can contain at most 10,000 data rows; parsing stops at the first row beyond that ceiling.

The endpoints require an authenticated user with the necessary role and data scope. Browser session
and request-forgery protections still apply; do not weaken them to automate an import.

Review the validation preview for:

- selected resource and accepted row count;
- required, duplicate and unrecognised columns;
- duplicate external references;
- missing programme, cohort, host, period or placement relationships;
- invalid dates, date ranges, statuses, email addresses and minute values; and
- records that already exist and would therefore be rejected.

Cancel when the selected resource or counts are unexpected. Fix the source file rather than
repeatedly importing partially corrected copies. The API reports row numbers, fields and error codes
without echoing rejected values; the source CSV itself still needs approved handling.

After a successful import, verify a small sample across cohorts and hosts, inspect the related audit
event and create a new backup.

## Treat spreadsheets as untrusted input

A CSV file is data, not executable content, but spreadsheet applications may interpret cells
beginning with `=`, `+`, `-` or `@` as formulas. Open untrusted files in a mode that treats cells as
text and does not fetch external content. CSV quoting alone does not prevent formula evaluation.
Never enable macros or external links to inspect an import error.

File validation does not prove that the institution has a lawful reason to import the records.
Review [privacy and retention](privacy-and-retention.md) separately.

## Export safely

Use the smallest available resource and an account with the narrowest suitable data scope. Check
the resource, format and expected record count before download. If the supported export is broader
than the approved task, do not create it merely to filter it later on an unmanaged device.

The current API exports students, hosts or placements as CSV or JSON:

```text
GET /api/export?resource=students&format=csv
GET /api/export?resource=hosts&format=json
GET /api/export?resource=placements&format=csv
```

Replace the resource and format only with the supported values shown above. Authentication, role
checks and the caller's data scope apply to every page read for the export. VECTOR reads the
selected dataset from one database transaction so the file does not mix records from different
points in time.

Exports fail closed with `422 export_row_limit` when the selected result would exceed 10,000 rows.
VECTOR does not silently truncate the file. Narrow the result and request it again:

- `query=<text>` searches the supported student, host or placement fields;
- `active=true` or `active=false` filters student and host exports (`active=all` is the default);
- `status=planned|active|review|complete|cancelled` filters placement exports (`status=all` is the
  default).

For example:

```text
GET /api/export?resource=students&format=csv&active=false&query=2024
GET /api/export?resource=placements&format=json&status=complete&query=Zurich
```

Treat a filtered export as sensitive even when it contains fewer rows. Record the filters alongside
the resulting count so another operator can reproduce the approved scope.

An export leaves VECTOR's session, role and audit boundaries. Store it only in an approved
encrypted location, share it through an approved channel and delete the working copy when the task
is complete. Do not attach production exports to GitHub issues, ordinary email or chat.

Treat exported student details, host contacts, placement history, time entries, check-ins, document
references and audit material as personal or confidential unless the institution has established
otherwise. A pseudonymous external reference can still identify a person when combined with other
records.

## Migration between installations

CSV import and export are intended for controlled data exchange, not a full-fidelity disaster
recovery or server migration. They may omit credentials, sessions, school configuration, audit
history or internal relationships.

Use a verified database backup for a complete move between compatible VECTOR installations. Follow
[backup and restore](backup-restore.md), deploy the same application release at the destination and
run `docker compose exec vector node scripts/doctor.mjs` before allowing users to sign in.

## Operational record

For each production transfer, record:

- requestor and approver;
- purpose and legal basis;
- source, destination and transfer time;
- scope and record count;
- validation result;
- who received the exported file;
- working-copy deletion date; and
- related VECTOR audit event.

Keep this record in the institution's controlled system without duplicating the transferred dataset
inside the ticket.
