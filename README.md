<div align="center">
  <img src="site/assets/vector-lockup.svg" width="440" alt="VECTOR — Placement Operations" />

  # Placement operations schools can run themselves.

  VECTOR keeps students, host organisations, placements, evidence and follow-ups in one
  self-hosted workspace. It gives each role the access it needs and leaves an audit trail for
  sensitive actions.

  [View the product tour](https://ejupi-djenis30.github.io/vector-placement-operations/) ·
  [Read the self-hosting guide](docs/self-hosting.md)
</div>

## What VECTOR does

- Tracks cohorts, students, host organisations, placement periods and tutor assignments.
- Shows cohort coverage by period, including students without a placement and overlapping
  placement conflicts.
- Records hours, check-ins and evidence against a school-managed placement programme.
- Turns overdue evidence, pending hour reviews, placement dates and missing tutor assignments into
  one role-scoped attention inbox.
- Lets coordinators publish immutable programme versions with default hours, minimum check-ins and
  evidence requirements.
- Blocks completion until the selected programme's verified hours, check-ins and evidence are ready.
- Gives administrators, coordinators, tutors and viewers explicit, scoped permissions.
- Expires inactive sessions and retains at most ten active sessions per user for safer use on
  shared school computers.
- Imports validated CSV files atomically and exports only data visible to the current role.
- Pages large collections with bounded search and confidential, view-bound cursors.
- Bounds each placement detail to 500 time entries, 200 check-ins and 200 document records,
  rejecting further writes atomically instead of truncating operational history.
- Records append-only audit events without copying personal fields into audit metadata.
- Runs reviewed retention in deterministic batches with holds, previews and exact fingerprints.
- Applies school branding at runtime, including a validated PNG logo and accessible colour pairs.
- Ships with backup, inspection, restore, migration, diagnostics and administrator commands.

The GitHub Pages site is a product tour. The operational workspace runs only in a self-hosted
installation with its own database and administrator credentials.

## Architecture

VECTOR is a modular Node.js application:

- Express 5 serves the API and the presentation/workspace assets.
- SQLite stores one school's data per installation with foreign keys, strict tables, WAL and
  versioned migrations.
- Opaque server-side sessions, same-site cookies, origin checks and CSRF tokens protect authenticated
  changes.
- Zod validates API inputs and response DTOs.
- A dependency-light browser client consumes the same API without a frontend build step.

Single-school SQLite keeps operation and recovery understandable. If several schools need separate
administrative boundaries, run separate installations.

## Start with Docker Compose

1. Copy `.env.example` to `.env` and fill every blank bootstrap value.
2. Run the one-shot initializer, then remove `VECTOR_BOOTSTRAP_ADMIN_PASSWORD` from `.env`.
3. Start the service.

```bash
docker compose build --pull
docker compose run --rm --no-deps vector
# Remove VECTOR_BOOTSTRAP_ADMIN_PASSWORD from .env after the expected initialization message.
docker compose up -d
docker compose ps
```

The default Compose binding is loopback-only. Put VECTOR behind a TLS-terminating reverse proxy
before exposing it to a network. Forwarded headers are untrusted by default; set
`VECTOR_TRUST_PROXY` to an exact hop count only after that controlled proxy is in place. The
complete setup, proxy and upgrade procedure is in
[docs/self-hosting.md](docs/self-hosting.md).

## Run directly

Install a supported LTS runtime—Node.js 22.23.1 through the Node 22 line, or Node.js 24.18.0
through the Node 24 line—and the locked dependencies:

```bash
cp .env.example .env
# Edit .env: set the real origin, IANA time zone and a unique bootstrap password.
npm ci
npm start
# Remove VECTOR_BOOTSTRAP_ADMIN_PASSWORD from .env after the expected initialization message.
npm start
```

Developer, operator, audit and release commands run the same runtime preflight before starting
their workload, so unsupported Node versions fail immediately with the accepted range.

`npm start` loads `.env` with Node's built-in environment-file support. A new production database
will not bootstrap without `VECTOR_BOOTSTRAP_ADMIN_PASSWORD`; initialization then exits before
opening the HTTP listener so the secret can be removed. Review [.env.example](.env.example) for
every runtime setting. Keep `NODE_ENV=production` exactly; unsupported aliases, casing and
whitespace fail startup instead of falling back to evaluation defaults. Production also rejects
every plain-HTTP `VECTOR_ORIGIN`, including loopback: configure the external HTTPS origin while the
listener remains behind the TLS proxy. Synthetic example records are disabled in production unless
`VECTOR_SEED_SYNTHETIC=true` is set explicitly.

Useful operator commands:

```bash
npm run db:migrate
npm run doctor
npm run db:backup -- --output /safe/path/vector.sqlite
npm run db:inspect-backup -- --file /safe/path/vector.sqlite
npm run db:restore -- --file /safe/path/vector.sqlite --confirm-empty
npm run db:compact -- --confirm-maintenance
```

Backups and their `.manifest.json` sidecars are one unit. Read
[docs/backup-restore.md](docs/backup-restore.md) and test restoration before relying on a backup.
Compaction requires an inspected backup and a maintenance window with every VECTOR process stopped.

## Data responsibility

VECTOR provides technical controls; it does not decide whether an organisation may collect or keep
specific data. The operating institution remains responsible for legal basis, minimisation,
retention periods, access reviews, DPIA decisions where applicable, incident handling and TLS.

Never post real student, staff or host contact data in issues, pull requests, fixtures, screenshots
or logs. The bundled sample dataset is fictional.

See [docs/privacy-and-retention.md](docs/privacy-and-retention.md) and
[docs/import-export.md](docs/import-export.md) before loading operational records.

## Verification

```bash
npm test
npm run test:coverage
npm run check:site
npm run test:e2e
npm run check:release
npm run check:audit
```

The suite covers authentication, inactivity expiry and CSRF, role-scoped cohort coverage,
confidential cursor pagination, atomic audit writes, versioned programme readiness, governed
retention, safe imports/exports, session-free backup and verified restore, deterministic release
archives, full Chromium behaviour and a focused WebKit smoke path for login, roles, responsive
navigation, dialogs, import and downloads. The separate native coverage gate includes server,
operator-script and browser-application modules and enforces conservative 85% line, 75% branch and
85% function floors without making Node's experimental coverage mode part of the standard check.

For a descriptive production-mode rehearsal with 5,000 fictional students, 5,500 placements and
their related records, run `npm run audit:scale`. The command creates and always removes its own
temporary database; its latency and memory readings are diagnostic observations, not
hardware-independent pass/fail limits.

## Releases

Stable releases package the complete self-hosted product as deterministic `.zip` and `.tar.gz`
archives. Each candidate includes an exact file inventory, a CycloneDX SBOM built from the locked
runtime dependencies, source-commit evidence and SHA-256 checksums. Independent Ubuntu and Windows
builds must match byte for byte before a tagged release can publish.

## Contributing and support

The current edition grew from an earlier academic collaboration and credits that work collectively.
Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing changes. Use fictional records in every
public report, follow [SECURITY.md](SECURITY.md) for vulnerabilities and use [SUPPORT.md](SUPPORT.md)
to choose the right support channel.

## License

Released under the [MIT License](LICENSE).
