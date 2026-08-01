# Releasing VECTOR

VECTOR releases are reproducible source snapshots of the complete self-hosted product. Each archive
contains the server, migrations, browser client, runtime operator commands, deployment files and
documentation. It excludes `node_modules`, test output, source-control metadata, databases, backups,
environment files and operational data.

## Release contract

A stable release is eligible for publication only when all of these statements are true:

1. `package.json`, `package-lock.json` and `CHANGELOG.md` declare the same stable version.
2. The canonical MIT license is present; unit, integration, browser and publication tests pass.
3. The production dependency, container vulnerability and secret audits pass.
4. The tag is named `v<version>`, annotated, GitHub-verified and points directly to a commit.
5. That commit is the current default-branch head when publication begins.
6. The annotated tagger and signing key match `release-policy.json`.
7. Independent Ubuntu and Windows builds are byte-for-byte identical.
8. Every asset matches `SHA256SUMS`, the release manifest and its build-provenance attestation.
9. GitHub reports the published release as immutable.

The gzip builder writes RFC 1952 operating-system value `255` into the header. A host-specific gzip
header, line-ending change or archive drift therefore fails reproducibility checks.

## Prepare the source

Work from a clean reviewed commit and use the locked dependency graph:

```bash
npm ci --no-audit --no-fund
npm run check
npm run test:coverage
npx --no-install playwright install chromium webkit
npm run test:e2e
docker build --check .
docker build --tag vector-release-audit .
trivy image --scanners vuln --severity HIGH,CRITICAL --exit-code 1 vector-release-audit
trivy image --scanners secret --exit-code 1 vector-release-audit
```

Use a current trusted Trivy binary and freshly updated databases. Do not waive a finding silently;
review upstream status and either move to a clean pinned base or record an explicit release blocker.
Do not place an `.env`, SQLite database or backup inside the release candidate.

CI and release readiness install the exact Trivy binary declared in the workflow and verify its
published SHA-256 before execution. They fail on high or critical image vulnerabilities and any
image secret finding, and upload a CycloneDX container SBOM. The vulnerability database is
deliberately refreshed rather than frozen: executable tooling is reproducible, while the gate must
reflect disclosures available at the time of the run.

## Build and compare candidates

```bash
commit="$(git rev-parse HEAD)"
candidate_root="$(mktemp -d)"
node scripts/release-cli.mjs build \
  --output "$candidate_root/release" \
  --commit "$commit"
node scripts/release-cli.mjs verify \
  --directory "$candidate_root/release" \
  --commit "$commit"
node scripts/release-cli.mjs accept \
  --directory "$candidate_root/release" \
  --commit "$commit"
node scripts/release-cli.mjs build \
  --output "$candidate_root/release-second" \
  --commit "$commit"
node scripts/release-cli.mjs compare \
  --directory "$candidate_root/release" \
  --other-directory "$candidate_root/release-second" \
  --commit "$commit"
```

Build both candidates outside the repository. Generating artifacts inside the worktree makes it
harder to distinguish source drift from release output and can invalidate the clean-source gate.

`accept` is stronger than archive verification. It safely extracts each distributable into a fresh
temporary directory, installs the locked dependencies with `npm ci`, runs the tests, static checks
and diagnostics from the extracted source, and rejects path traversal or archive-layout drift. A
candidate that verifies but does not pass `accept` is not releasable.

In PowerShell, create a unique directory below the system temporary directory and pass absolute
paths:

```powershell
$vectorCommit = git rev-parse HEAD
$vectorCandidateRoot = Join-Path `
  ([System.IO.Path]::GetTempPath()) `
  ("vector-release-" + [System.Guid]::NewGuid())
New-Item -ItemType Directory -Path $vectorCandidateRoot | Out-Null
$vectorCandidate = Join-Path $vectorCandidateRoot "release"
$vectorCandidateSecond = Join-Path $vectorCandidateRoot "release-second"
node scripts/release-cli.mjs build `
  --output $vectorCandidate `
  --commit $vectorCommit
node scripts/release-cli.mjs verify `
  --directory $vectorCandidate `
  --commit $vectorCommit
node scripts/release-cli.mjs accept `
  --directory $vectorCandidate `
  --commit $vectorCommit
node scripts/release-cli.mjs build `
  --output $vectorCandidateSecond `
  --commit $vectorCommit
node scripts/release-cli.mjs compare `
  --directory $vectorCandidate `
  --other-directory $vectorCandidateSecond `
  --commit $vectorCommit
```

## Rehearse on GitHub

Run the **Release readiness** workflow manually. Set `expected_tag` to the intended stable tag, such
as `v3.3.0`. A workflow-dispatch rehearsal builds and verifies the candidate but cannot enter the
tag-only publication job.

Download the `vector-release-candidate` artifact and verify and accept it again:

```bash
node scripts/release-cli.mjs verify --directory release --commit <workflow-commit>
node scripts/release-cli.mjs accept --directory release --commit <workflow-commit>
sha256sum --check release/SHA256SUMS
```

## Create the tag

Read the approved identity from the tracked policy instead of copying a person's name into scripts
or documentation:

```bash
tagger_name="$(node -p "JSON.parse(require('fs').readFileSync('release-policy.json')).tagger.name")"
tagger_email="$(node -p "JSON.parse(require('fs').readFileSync('release-policy.json')).tagger.email")"
commit="$(git rev-parse HEAD)"

node scripts/release-cli.mjs tag-preflight \
  --tag v3.3.0 \
  --commit "$commit" \
  --tagger-name "$tagger_name" \
  --tagger-email "$tagger_email"

git -c user.name="$tagger_name" \
  -c user.email="$tagger_email" \
  tag -s v3.3.0 "$commit" -m "VECTOR 3.3.0"

node scripts/release-cli.mjs tag-verify --tag v3.3.0 --commit "$commit"
git push origin refs/tags/v3.3.0:refs/tags/v3.3.0
```

The preflight rejects `GIT_COMMITTER_NAME` and `GIT_COMMITTER_EMAIL` because they override Git's
tagger configuration. The post-creation verifier reads the exact local tag object, requires a direct
commit target and checks the real tagger and signing-key fingerprint. Do not push if either gate
fails, and never move or reuse a tag.

The tag workflow repeats every test and reproducibility check. It builds the candidate, accepts the
extracted archives, then builds the exact Docker image with the source revision label. The smoke
gate confirms that `/app` is root-owned and non-writable by the runtime user even without
read-only mode, then runs the image with a read-only root filesystem, a bounded `nodev`, `noexec`,
`nosuid` temporary filesystem, dropped capabilities and a private data volume; checks readiness
and `doctor`; verifies clean `SIGTERM` shutdown; and exercises backup,
post-transfer inspection, restore, diagnostics and maintenance compaction on a second volume.
Ubuntu and Windows independently rebuild into runner-temporary directories and compare every
candidate byte.

The runtime image also contains the canonical project license at
`/usr/share/licenses/vector/LICENSE`; CI compares its SHA-256 digest with the repository copy.
The CycloneDX container SBOM remains the machine-readable inventory for dependency identities and
license metadata.

Only after those jobs pass does the final job verify the remote annotated tag through the GitHub
API, attest the assets, create an exact draft and publish after GitHub marks the release immutable.
An exact partial draft may be resumed; foreign or mismatched assets cause a closed failure.

## Verify and run a downloaded release

Verify checksums and provenance before extraction:

```bash
sha256sum --check SHA256SUMS
gh attestation verify vector-self-hosted-3.3.0.tar.gz \
  --repo ejupi-djenis30/vector-placement-operations \
  --signer-workflow ejupi-djenis30/vector-placement-operations/.github/workflows/release.yml
```

The archive expands into `vector-placement-operations-<version>`. Review
`docs/self-hosting.md`, create a new `.env` from `.env.example`, use a unique bootstrap password and
build the included Dockerfile. The CycloneDX file lists the locked production dependencies included
in that release contract.

If source or workflow changes are needed after publication, prepare the next version. Do not delete
or replace an existing release.
