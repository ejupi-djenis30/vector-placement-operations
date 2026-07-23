# Releasing VECTOR

VECTOR releases are static, reproducible snapshots of the public browser application. A release does
not include `node_modules`, test output, source-control metadata or any private operational data.

## Release contract

A stable release is eligible for publication only when all of these statements are true:

1. `package.json`, `package-lock.json` and the changelog declare the same stable version.
2. The repository contains the canonical MIT license and the complete test suite passes.
3. The release tag is named `v<version>`, is annotated, has a GitHub-verified signature and resolves
   directly to a commit rather than another tag.
4. That commit is exactly the current default-branch head when publication begins.
5. Two clean candidate builds are byte-for-byte identical.
6. Every release asset matches `SHA256SUMS` and its GitHub build-provenance attestation.
7. The GitHub Release becomes immutable. The publisher refuses to modify an existing published
   release or an unrelated draft.
8. The annotated tagger name, email, SSH principal and signing-key fingerprint match
   `release-policy.json`.

The `.tar.gz` builder writes RFC 1952 operating-system value `255` (`unknown`) into the gzip header.
The release gate compares an Ubuntu candidate with independent Ubuntu and Windows rebuilds, so a
host-specific gzip header or checkout transformation cannot pass as reproducible.

## 2.0.1 recovery

The immutable `v2.0.0` tag remains as an unpublished historical marker. Its corporate tagger email
was not associated with a GitHub account, so GitHub could not verify the otherwise valid signature
and the publisher failed closed. Do not delete, move, reuse or rerun that tag. Version 2.0.1 carries
the same browser runtime forward and adds the tagger-identity preflight; there is no runtime change.

## Local candidate

Use the locked dependency graph and build a candidate from a clean commit:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npx --no-install playwright install chromium
npm run test:e2e
node scripts/release-cli.mjs build --output release --commit "$(git rev-parse HEAD)"
node scripts/release-cli.mjs verify --directory release --commit "$(git rev-parse HEAD)"
```

Build a second candidate into another directory and compare it before relying on the first:

```bash
node scripts/release-cli.mjs build --output release-second --commit "$(git rev-parse HEAD)"
node scripts/release-cli.mjs compare --directory release --other-directory release-second \
  --commit "$(git rev-parse HEAD)"
```

On Windows PowerShell, replace `$(git rev-parse HEAD)` with the output of `git rev-parse HEAD`.

## Rehearsal

Run **Release readiness** manually with `expected_tag` set to the intended stable tag, for example
`v2.0.1`. A rehearsal builds, tests, inventories and reproduces the full candidate, but the publish
job remains skipped because the event is not a tag push.

Download the `vector-release-candidate` workflow artifact and verify it locally:

```bash
node scripts/release-cli.mjs verify --directory release --commit <workflow-commit>
sha256sum --check release/SHA256SUMS
```

## Publication

After the rehearsal passes, create a signed annotated tag locally at the exact reviewed default-branch
commit. Never rewrite or reuse an existing tag. Run the tracked identity preflight with the same
name and email that will be embedded in the annotated tag:

```bash
node scripts/release-cli.mjs tag-preflight \
  --tag v2.0.1 \
  --commit <reviewed-commit> \
  --tagger-name "Djenis Ejupi" \
  --tagger-email "69587167+ejupi-djenis30@users.noreply.github.com"
git -c user.name='Djenis Ejupi' \
  -c user.email='69587167+ejupi-djenis30@users.noreply.github.com' \
  tag -s v2.0.1 <reviewed-commit> -m "VECTOR 2.0.1"
node scripts/release-cli.mjs tag-verify \
  --tag v2.0.1 \
  --commit <reviewed-commit>
git push origin refs/tags/v2.0.1:refs/tags/v2.0.1
```

The preflight rejects `GIT_COMMITTER_NAME` and `GIT_COMMITTER_EMAIL`; those variables override
Git configuration during annotated-tag creation. The post-creation verifier reads the exact local
`refs/tags/v2.0.1` object, requires a direct commit target and checks the real tagger plus the
cryptographic SSH principal and key fingerprint. Never push when either gate fails.

The tag workflow repeats the complete candidate build. Publication is the final job and runs only for
the tag event. It verifies the remote tag object and signature through the GitHub API, checks that the
tag still equals the default-branch head, attests the checksummed assets, uploads an exact draft and
publishes it. The workflow then requires GitHub to report the release as immutable.

If source or workflow changes are needed after a tag is published, prepare the next patch version.
Do not move or delete the existing release.

## Consumer verification

Download an archive, `SHA256SUMS` and the release manifest from the GitHub Release. Then verify both
the checksum and GitHub provenance:

```bash
sha256sum --check SHA256SUMS
gh attestation verify vector-site-2.0.1.tar.gz \
  --repo ejupi-djenis30/vector-placement-operations \
  --signer-workflow ejupi-djenis30/vector-placement-operations/.github/workflows/release.yml
```

Extract either archive and serve its top-level `vector-placement-operations-<version>` directory with
any static HTTP server. VECTOR has no production runtime dependencies and makes no network requests.
