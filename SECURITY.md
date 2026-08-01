# Security policy

VECTOR includes an authenticated self-hosted application backed by SQLite. Its public evaluation
fixtures are synthetic, but a self-hosted installation may contain private student, staff and host
organisation records.

## Supported versions

Only the newest published patch in the current minor release line receives security fixes. The
published release, its checksums and provenance—not an unreleased branch or arbitrary commit—define
the supported product.

| Release | Security support |
| --- | --- |
| Latest published `3.4.x` release | Supported |
| Earlier `3.4.x` patches | Not supported |
| `3.3.x` and earlier | Not supported |
| Unreleased branches and commits | Not supported |

Upgrade to the newest published release before reporting a problem that is already fixed there.

## Report a vulnerability

Use
[GitHub private vulnerability reporting](https://github.com/ejupi-djenis30/vector-placement-operations/security/advisories/new).
Do not open a public issue for a suspected vulnerability.

Include:

- the affected VECTOR version or commit;
- the deployment mode and relevant configuration with secrets removed;
- clear, minimal reproduction steps;
- the observed and expected result; and
- a practical impact assessment.

Use synthetic records in reproductions. Never attach a production database, backup, export,
credential, session cookie, token, private hostname or real person record. If real data is necessary
to understand an incident, describe its shape and sensitivity without copying the value.

## What happens after a report

Acknowledgement, follow-up questions and triage are coordinated inside the private GitHub security
advisory. A maintainer may ask for a smaller synthetic reproduction, confirm which supported release
is affected and discuss the practical impact with the reporter.

When a change is required, remediation and release preparation stay private in the advisory.
Public disclosure is coordinated after a fixed release is available so operators can update first.
No fixed acknowledgement or remediation SLA is promised; scope, severity and maintainer
availability determine the schedule. Do not send real records or secrets during any stage of this
process.

CI scans the checked-out source tree through an independent, fail-closed, checksum-pinned gate
alongside the application and container checks. Credentials, private records and other sensitive
material must never be committed to the repository.

## Operator responsibilities

This repository does not provide a managed service or compliance certification. Operators are
responsible for TLS, network access, secrets, named accounts, least privilege, security updates,
monitoring, backups, retention, incident response and applicable legal or contractual duties.

Follow the [self-hosting guide](docs/self-hosting.md) and
[privacy and retention guide](docs/privacy-and-retention.md) before using real records.

Licensing is governed by the repository's [MIT License](LICENSE).
