# Changelog

Notable changes to VECTOR are recorded here.

## Unreleased

- No unreleased changes.

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
