import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const releaseWorkflowUrl = new URL("../.github/workflows/release.yml", import.meta.url);
const ciWorkflowUrl = new URL("../.github/workflows/ci.yml", import.meta.url);

test("release workflow keeps rehearsal, reproducibility, attestation and immutable publication gates", async () => {
  const workflow = (await readFile(releaseWorkflowUrl, "utf8")).replaceAll("\r\n", "\n");
  for (const token of [
    "workflow_dispatch:",
    "expected_tag:",
    'tags:\n      - "v*"',
    "npm ci --no-audit --no-fund",
    "npm run check",
    "npm run test:e2e",
    'NODE_VERSION: "22.23.1"',
    "scripts/release-cli.mjs accept",
    "docker build --check .",
    "VECTOR_BUILD_REVISION=${GITHUB_SHA}",
    "--read-only",
    "--cap-drop ALL",
    "npm run doctor",
    "docker stop --time 15",
    "npm run db:backup",
    "docker cp --archive",
    "--cap-add CHOWN",
    "chown node:node",
    "npm run db:inspect-backup",
    "npm run db:restore",
    "npm run db:compact",
    "Independent reproducibility gate",
    "runs-on: ${{ matrix.os }}",
    "- ubuntu-24.04",
    "- windows-2022",
    "scripts/release-cli.mjs compare",
    'path: ${{ runner.temp }}/expected-release',
    '--output "${RUNNER_TEMP}/rebuilt-release"',
    "Verify exact release tag signing key",
    "releaseSigningPublicKey",
    "validateReleaseMetadata",
    "git config --local gpg.format ssh",
    'git config --local gpg.ssh.allowedSignersFile "${allowed_signers}"',
    "scripts/release-cli.mjs tag-verify",
    '--tag "${GITHUB_REF_NAME}"',
    '--commit "${GITHUB_SHA}"',
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
  const publishJob = workflow.indexOf("\n  publish:");
  const keyGate = workflow.indexOf("- name: Verify exact release tag signing key", publishJob);
  const attest = workflow.indexOf("- name: Attest checksummed release assets", publishJob);
  assert.ok(publishJob >= 0 && keyGate > publishJob, "The exact-key gate must run in the publish job.");
  assert.ok(attest > keyGate, "The exact-key gate must run before release attestation.");
  assert.equal((workflow.match(/scripts\/release-cli\.mjs tag-verify/g) ?? []).length, 1);
  assert.equal((workflow.match(/gpg\.ssh\.allowedSignersFile/g) ?? []).length, 1);
  assert.equal((workflow.match(/docker cp --archive/g) ?? []).length, 2);
  assert.equal((workflow.match(/--cap-add CHOWN/g) ?? []).length, 1);
  assert.equal((workflow.match(/chown node:node/g) ?? []).length, 1);
  assert.match(workflow, /--network none[\s\S]*--user root[\s\S]*--cap-drop ALL[\s\S]*--cap-add CHOWN/);
  assert.equal(workflow.includes("npm ci --ignore-scripts"), false);
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

test("production container smokes enforce one-shot bootstrap secret removal", async () => {
  const initializationMessage =
    "VECTOR initialization completed. Remove VECTOR_BOOTSTRAP_ADMIN_PASSWORD from the environment and restart VECTOR before serving users.";
  const retainedSecretMessage =
    "VECTOR_BOOTSTRAP_ADMIN_PASSWORD must be removed after initialization. Remove it from the environment and restart VECTOR.";
  for (const [name, url] of [
    ["ci.yml", ciWorkflowUrl],
    ["release.yml", releaseWorkflowUrl],
  ]) {
    const workflow = (await readFile(url, "utf8")).replaceAll("\r\n", "\n");
    const initialization = workflow.indexOf('initialization_output="$(');
    const retainedSecret = workflow.indexOf('retained_secret_output="$(', initialization);
    const servingStartup = workflow.indexOf("docker run --detach", retainedSecret);
    const readiness = workflow.indexOf("/api/health/ready", servingStartup);

    assert.ok(initialization >= 0, `${name} is missing the initialization phase.`);
    assert.ok(
      retainedSecret > initialization,
      `${name} must reject a retained secret after initialization.`,
    );
    assert.ok(
      servingStartup > retainedSecret,
      `${name} must start the serving container only after both bootstrap rejections.`,
    );
    assert.ok(
      readiness > servingStartup,
      `${name} must check readiness only after starting without the secret.`,
    );
    assert.ok(workflow.includes(initializationMessage), `${name} is missing the initialization message.`);
    assert.ok(workflow.includes(retainedSecretMessage), `${name} is missing the retained-secret message.`);
    assert.ok(
      workflow.includes('[[ "${initialization_status}" == "0" ]]'),
      `${name} must reject a successful initialization process.`,
    );
    assert.ok(
      workflow.includes('[[ "${retained_secret_status}" == "0" ]]'),
      `${name} must reject a successful retained-secret process.`,
    );
    assert.equal(
      (workflow.match(/"\$\{runtime_args\[@\]\}"/g) ?? []).length,
      3,
      `${name} must use the same hardened runtime and volume for both probes and serving.`,
    );
    assert.equal(
      (workflow.match(/"\$\{bootstrap_args\[@\]\}"/g) ?? []).length,
      2,
      `${name} must pass bootstrap credentials only to the two expected failures.`,
    );
    const servingBlock = workflow.slice(servingStartup, readiness);
    assert.equal(
      servingBlock.includes("bootstrap_args"),
      false,
      `${name} must not retain bootstrap credentials for the serving startup.`,
    );
    assert.equal(
      servingBlock.includes("VECTOR_BOOTSTRAP_ADMIN_PASSWORD"),
      false,
      `${name} must not pass the bootstrap secret to the serving startup.`,
    );
  }
});
