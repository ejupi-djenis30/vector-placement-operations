# Contributing to VECTOR

VECTOR is a self-hosted placement operations product. A useful change should make the workflow more
reliable, understandable, accessible or recoverable without weakening role boundaries or data
controls.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Protect operational data

Search existing issues before opening one. Never attach real student, school, host organisation or
staff information. Reproduce problems with the bundled fictional records or replace every
identifying value before sharing a screenshot, export, request trace, database or log.

Report vulnerabilities through [SECURITY.md](SECURITY.md), not a public issue.

## Local setup

Install Node.js 22.23.1 or newer within the Node 22 line, or Node.js 24.18.0 or newer within the
Node 24 line, then run:

```bash
npm ci
npm test
npm run test:coverage
npm run check:site
npm run check:audit
```

Install Chromium and WebKit before running browser acceptance tests:

```bash
npx --no-install playwright install chromium webkit
npm run test:e2e
```

Use an isolated database and a unique test-only bootstrap password. Do not point a development
process or test at an operational VECTOR volume.

`npm run test:coverage` uses Node's experimental native coverage mode as a separate gate and
requires at least 85% lines, 75% branches and 85% functions across loaded server, operator-script
and browser-application modules. `npm run audit:scale` builds a fixed, fictional large-school
fixture in a temporary database, reports query plans, response sizes, concurrency, import statement
counts and memory observations, then deletes that database. Treat timings as local diagnostics,
not portable performance thresholds.

## What a good change includes

- A focused regression test for every changed permission, calculation, migration or recovery path.
- Explicit validation at API boundaries and explicit response DTOs.
- A database migration for schema changes; never edit an already-applied migration.
- An audit event in the same transaction as each sensitive mutation.
- Scope checks on every query that can expose student, host or placement data.
- Keyboard access, visible focus, reduced-motion support and a 320-pixel layout.
- Operator documentation for configuration, upgrade, backup or retention changes.
- Fictional fixtures and screenshots only.

Do not add a default password, client-side credential storage, hidden telemetry, remote fonts,
third-party analytics or a silent network dependency.

## Database and migration work

SQLite foreign keys and strict tables must remain enabled. Store durations as integer minutes and
use optimistic revisions on records that can be edited concurrently. A migration must be
deterministic, checksummed and safe to apply once; test both a fresh database and an upgrade from the
previous schema.

## Pull requests

Keep commits narrow and describe the result, for example `fix: keep tutor exports inside assignment
scope`. In the pull request, state what failed before, what now enforces the behaviour and the exact
commands you ran. Confirm that the branch, fixtures, logs and description contain fictional data
only.

By submitting a contribution, you confirm that you have the right to provide it and agree that it
will be licensed under the project's [MIT License](LICENSE).
