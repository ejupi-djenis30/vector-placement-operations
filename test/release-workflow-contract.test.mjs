import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const releaseWorkflowUrl = new URL("../.github/workflows/release.yml", import.meta.url);
const ciWorkflowUrl = new URL("../.github/workflows/ci.yml", import.meta.url);

test("release workflow keeps rehearsal, reproducibility, attestation and immutable publication gates", async () => {
  const workflow = await readFile(releaseWorkflowUrl, "utf8");
  for (const token of [
    "workflow_dispatch:",
    "expected_tag:",
    'tags:\n      - "v*"',
    "npm ci --ignore-scripts --no-audit --no-fund",
    "npm run check",
    "npm run test:e2e",
    "Independent reproducibility gate",
    "scripts/release-cli.mjs compare",
    "subject-checksums: release/SHA256SUMS",
    "subject-path: release/SHA256SUMS",
    "gh attestation verify",
    "scripts/publish-release.mjs",
    "if: github.event_name == 'push' && github.ref_type == 'tag'",
    "contents: write",
    "attestations: write",
    "artifact-metadata: write",
    "RELEASE_PUBLICATION_ENABLED: \"true\"",
  ]) {
    assert.ok(workflow.includes(token), `release.yml is missing ${token}`);
  }
  assert.equal((workflow.match(/contents: write/g) ?? []).length, 1);
  assert.equal((workflow.match(/pull_request_target\s*:/g) ?? []).length, 0);
  for (const match of workflow.matchAll(/\buses:\s*([^\s#]+)/g)) {
    assert.match(match[1], /@[0-9a-f]{40}$/i, `${match[1]} is not pinned to a full commit SHA`);
  }
});

test("CI installs actionlint from an exact checksummed release", async () => {
  const workflow = await readFile(ciWorkflowUrl, "utf8");
  for (const token of [
    'ACTIONLINT_VERSION: "1.7.12"',
    'ACTIONLINT_SHA256: "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"',
    "https://github.com/rhysd/actionlint/releases/download/",
    "sha256sum --check --strict",
    '\"${RUNNER_TEMP}/actionlint\"',
  ]) {
    assert.ok(workflow.includes(token), `ci.yml is missing ${token}`);
  }
});
