# Changelog

Notable changes to VECTOR are recorded here.

## Unreleased

- No unreleased changes.

## 2.0.1 — 2026-07-23

- Carries the 2.0.0 browser runtime forward unchanged; application behaviour and the data model are
  identical.
- Leaves `v2.0.0` as an unpublished historical tag. Its corporate tagger email was not associated
  with a GitHub account, so GitHub correctly refused to verify it.
- Adds a tracked tagger-identity policy and a preflight command that must pass before creating a
  release tag.

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
