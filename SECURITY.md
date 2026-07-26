# Security policy

VECTOR includes an authenticated self-hosted application backed by SQLite. Its public evaluation
fixtures are synthetic, but a self-hosted installation may contain private student, staff and host
organisation records.

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

## Operator responsibilities

This repository does not provide a managed service or compliance certification. Operators are
responsible for TLS, network access, secrets, named accounts, least privilege, security updates,
monitoring, backups, retention, incident response and applicable legal or contractual duties.

Follow the [self-hosting guide](docs/self-hosting.md) and
[privacy and retention guide](docs/privacy-and-retention.md) before using real records.

Licensing is governed by the repository's [MIT License](LICENSE).
