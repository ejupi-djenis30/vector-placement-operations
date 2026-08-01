# Changelog

Notable changes to VECTOR are recorded here.

## Unreleased

- No unreleased changes.

## 3.4.0 — 2026-08-01

- Kept JSON inflation and parsing inside the metered `/api` boundary, rejected replaceable POSIX
  ancestors before creating backup destinations, enforced exact private backup-directory modes and
  covered the remaining legacy Windows DOS-device aliases used by `CLOCK$`, superscript-numbered
  `COM`/`LPT` names and space-before-extension forms.
- Made live SQLite startup fail closed on symbolic-link, junction, hard-link and non-regular database
  aliases; private POSIX ownership/modes and the WAL, SHM and rollback-journal companions are now
  validated before and after the guarded open. Persistent connections must confirm WAL mode, and
  trusted-schema execution is disabled before migrations or application queries use the schema.
- Applied that guarded existing-file boundary to backup, inspection, compaction and diagnostics.
  Integrity checks and backup/VACUUM work now stay on the same opened SQLite connection, while doctor
  refuses to write its probe until the configured database path passes the safe-open check.
- Rejected duplicate session-cookie values before authentication and made startup, readiness,
  inspection and restore compare the migration-owned SQLite schema exactly, including pre-upgrade
  validation that prevents drifted triggers from executing during a pending migration. Backup
  publication now also refuses every live SQLite database and companion path.
- Kept unknown or forged session-cookie lookups on a read-only SQLite path while preserving
  targeted cleanup for matching expired or disabled-user sessions.
- Added an immediate supported-Node preflight to developer, operator, audit and release commands
  so an untested runtime fails before a long-running workload starts.
- Resolved the local npm CLI across bundled, npm-invoked and `PATH` installations, then bound
  extracted-release scripts and diagnostics to the same supported Node executable that launched
  acceptance.
- Closed active dialogs and restored an operable, focused login screen when a session expires;
  unauthenticated states no longer expose a skip link whose workspace target does not exist.
- Cleared every authenticated collection, filter, pending paged request and transient notification
  at session boundaries, and suppressed the duplicate sign-in error announcement after centralized
  expiry recovery.
- Returned bounded SQLite lock contention as a retryable `503 database_busy`, rejected disallowed
  login origins before the sign-in budget, and contained shutdown-observer failures until the
  HTTP server and application state are closed.
- Added indexed, stable student and host pagination plus batched CSV reference validation for
  predictable list, export and import behaviour at larger school data volumes.
- Added a focused WebKit acceptance project and kept the full Chromium suite, covering public
  presentation, login, role capabilities, responsive navigation, dialogs, import and downloads;
  the E2E server now uses an in-memory fixture so forced Windows teardown leaves no SQLite residue.
- Added explicit native coverage floors and production-mode scale and CRUD rehearsals that report
  query plans, response sizes, concurrency, import statement counts and bounded memory retention
  without retaining temporary databases.
- Compiled the SQLite native addon inside the pinned container builder so ARM64 images use the
  runtime image's libc ABI instead of an incompatible upstream prebuild.
- Pinned production containers and primary CI to Node 24 LTS, kept Node 22 LTS in the compatibility
  matrix and rejected untested or non-LTS Node major versions before application startup.
- Reduced the production image to a pinned Alpine runtime without a package-manager toolchain.
  Application code is root-owned and non-writable by the runtime user, temporary storage rejects
  device, executable and set-id semantics. CI/release readiness installs a checksummed Trivy binary,
  rejects high or critical vulnerabilities and embedded secrets, and publishes a container
  CycloneDX SBOM. The runtime ships the canonical MIT license with a digest equality gate.
- Required every school and administrator identity field explicitly whenever a production
  bootstrap password is configured, preventing demo defaults from seeding a real installation.
- Rejected every non-exact `NODE_ENV` value so misspelled production settings cannot inherit
  evaluation origins, cookie defaults or synthetic seeding.
- Rejected plain-HTTP production origins even on loopback, kept the internal listener compatible
  with a host TLS proxy and narrowed the secure session cookie path to `/api`.
- Made failed-login responses and audit writes identity-blind across known, unknown and inactive
  accounts while retaining the dedicated sign-in limiter.
- Capped active sessions at ten per user with transactional expiry cleanup, deterministic
  least-recently-used eviction, an indexed lookup and a database trigger backstop.
- Hardened live WAL backup and restore against source symlinks, path traversal and source changes
  during copy; added concurrent-reader/writer and byte-logical round-trip recovery coverage.
- Applied the configurable backup byte ceiling before inspection, hashing or SQLite open as well
  as during snapshot creation and restore copy, with fail-closed CLI regression coverage.
- Kept the Compose stop deadline above VECTOR's maximum 60-second drain window so the container
  runtime cannot pre-empt graceful HTTP and SQLite shutdown for a supported configuration.
- Rolled back a newly published restore or backup manifest if its final temporary-file cleanup
  fails, so a reported failure cannot silently leave that final target in place.
- Rejected ambiguous duplicate security and proxy headers, and added raw HTTP regressions for
  content-length/transfer-encoding conflicts, compressed-body limits, malformed paths and aborted
  request bodies. CSRF tokens now use timing-safe comparison with explicit length handling.
  Public `HEAD` requests mirror their `GET` authorization contract, forwarded headers are
  untrusted by default, and assigned tutors cannot enumerate child records outside their scope.
- Bound public role claims to the server's canonical role/scope matrix, separated application
  administration from host-level recovery, documented the supported security-release and private
  disclosure process, and verified every public same-origin resource without masked request failures.
- Canonicalised every workspace API path before fetch, added restrictive public/workspace CSP
  policies and versioned SoftwareApplication metadata, and bounded placement detail to 500 time
  entries, 200 check-ins and 200 document records. Capacity checks, programme/import seeding and
  evidence replacement now fail atomically with indexed reads and database-level backstops instead
  of truncating history.
- Separated crawler policy by deployment surface: the public product tour keeps its discoverable
  sitemap, while every self-hosted operational workspace now serves a private `robots.txt` that
  disallows indexing and does not advertise the public origin.
- Bounded the complete administrative user directory at 500 retained accounts, including inactive
  history. API and CLI creation now fail before expensive work at capacity, migration 006 adds the
  indexed database trigger backstop, and externally over-capacity databases fail closed on reads.

## 3.3.0 — 2026-07-29

- Added school-managed placement programmes with immutable policy versions for target hours,
  check-ins and required evidence. Existing placements retain a compatibility policy, and published
  rules stay attached to the records that used them.
- Added programme-aware placement creation, CSV import, readiness checks and exports. Coordinators
  can reassign an untouched placement, while VECTOR protects records that already contain hours,
  check-ins or evidence.
- Added a role-scoped attention inbox for overdue evidence, pending hour reviews, placement
  transitions and missing tutor assignments. Deadlines follow the school's time zone and the
  encrypted pagination cursor keeps queue order stable.
- Exposed check-in next actions, document dates and references, and placement contact details
  directly on the operational record.
- Added a cohort coverage board that shows unplaced students, current coverage and overlapping
  placement conflicts for a selected cohort and period.
- Added direct, prefilled placement creation from uncovered students so coordinators can close a
  planning gap without returning to a separate register.
- Added a server-enforced idle session timeout for safer use on shared school computers, including
  a configurable policy, session cleanup and operator guidance.
- Made production initialization a one-shot, fail-closed operation. VECTOR creates the first school
  without opening a listener and refuses to serve until the bootstrap secret has been removed.
- Removed sample institution identity values from the production environment template and aligned
  the self-hosting guide and release acceptance tests with the initialize-then-serve workflow.

## 3.2.0 — 2026-07-26

- Added a role-scoped attention inbox for overdue evidence, pending hour reviews, placement
  transitions and missing tutor assignments, with stable encrypted pagination and school-time-zone
  deadline handling.
- Made previously hidden check-in next actions, document dates/references and placement contact
  details visible from the operational record.
- Made production bootstrap a one-shot, fail-closed operation: VECTOR initializes the first school
  without opening a listener, then requires the bootstrap secret to be removed before serving.
- Removed sample institution identity values from the production environment template and updated
  release acceptance to exercise initialization and serving as two separate phases.

## 3.1.0 — 2026-07-26

- Added school-managed placement programmes with immutable, auditable policy versions.
- Made target hours, minimum check-ins and required evidence programme-specific while preserving
  every existing VECTOR 3.0 placement through an automatic compatibility policy.
- Added programme selection to placement creation, programme-aware readiness and atomic
  `programmeCode` handling for CSV imports and placement exports.
- Added administrator and coordinator controls for publishing policy versions without rewriting
  the rules attached to existing placements.
- Added a compact, complete version-history view and enforced explicit capacities of 200 programmes
  per school and 100 immutable versions per programme.
- Froze programme reassignment after any recorded time, check-in or non-placeholder evidence, while
  limiting allowed reassignment cleanup to untouched requirement placeholders.

## 3.0.0 — 2026-07-26

- Rebuilt VECTOR as a self-hosted, multi-user placement operations platform.
- Added persistent SQLite storage with versioned migrations, scoped roles, secure sessions and
  append-only audit records.
- Added runtime school branding, placement evidence and completion-readiness controls.
- Added validated CSV import, scoped CSV/JSON export and operator-facing backup, restore and
  diagnostics commands.
- Added container deployment files and production operation guides.

## 2.0.1 — 2026-07-23

- Carries the 2.0.0 browser runtime forward unchanged; application behaviour and the data model are
  identical.
- Leaves `v2.0.0` as an unpublished historical tag. Its corporate tagger email was not associated
  with a GitHub account, so GitHub correctly refused to verify it.
- Adds a tracked tagger and signing-key policy, rejects Git identity environment overrides before
  tag creation, then verifies the exact local tag object, target, identity and SSH signature before
  it can be pushed.

## 2.0.0 — 2026-07-22

- Rebuilt the placement workspace around fictional records and local-only browser storage.
- Added cohort search, status filters, progress summaries, milestone updates and a full workspace reset.
- Added schema validation and recovery for malformed persisted data.
- Refined the responsive interface with measured geometry and browser acceptance tests down to a
  320-pixel viewport.
- Removed legacy documents and media from the public edition, licensed the project under MIT with
  contributor approval and credited collaboration collectively.
- Added pinned CI and GitHub Pages workflows plus contribution, support, security and conduct policies.
- Added deterministic static-site archives with a platform-neutral RFC 1952 gzip header, an exact
  file inventory, a CycloneDX SBOM, consolidated SHA-256 checksums, cross-platform reproducibility
  checks and build-provenance attestations.
