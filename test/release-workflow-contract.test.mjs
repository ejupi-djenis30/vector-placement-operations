import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const releaseWorkflowUrl = new URL("../.github/workflows/release.yml", import.meta.url);
const ciWorkflowUrl = new URL("../.github/workflows/ci.yml", import.meta.url);
const pagesWorkflowUrl = new URL("../.github/workflows/pages.yml", import.meta.url);

function workflowJob(workflow, name) {
  const marker = `  ${name}:\n`;
  const start = workflow.indexOf(marker, workflow.indexOf("\njobs:\n"));
  assert.notEqual(start, -1, `missing ${name} job`);
  const remainder = workflow.slice(start + marker.length);
  const nextJob = remainder.search(/^  [a-z0-9][a-z0-9-]*:\n/mu);
  return workflow.slice(
    start,
    nextJob === -1 ? undefined : start + marker.length + nextJob,
  );
}

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
    "--tmpfs \"/tmp:rw,nodev,noexec,nosuid,size=64m\"",
    "test ! -w /app/server/index.mjs",
    "test ! -w /app/node_modules",
    "sha256sum LICENSE",
    "/usr/share/licenses/vector/LICENSE",
    "--cap-drop ALL",
    "node scripts/doctor.mjs",
    "docker stop --time 15",
    "node scripts/backup.mjs",
    "docker cp --archive",
    "--cap-add CHOWN",
    "chown root:root /transfer",
    "chown node:node",
    'chown -R "${runner_uid}:${runner_gid}" /transfer',
    "node scripts/inspect-backup.mjs",
    "node scripts/restore.mjs",
    "node scripts/compact.mjs",
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
  assert.equal((workflow.match(/--cap-add CHOWN/g) ?? []).length, 2);
  assert.equal((workflow.match(/chown node:node/g) ?? []).length, 1);
  assert.equal((workflow.match(/chown root:root \/transfer/g) ?? []).length, 1);
  assert.equal((workflow.match(/chown -R "\$\{runner_uid\}:\$\{runner_gid\}" \/transfer/g) ?? []).length, 1);
  assert.match(workflow, /--network none[\s\S]*--user root[\s\S]*--cap-drop ALL[\s\S]*--cap-add CHOWN/);
  assert.equal(workflow.includes("npm ci --ignore-scripts"), false);
  assert.equal((workflow.match(/contents: write/g) ?? []).length, 1);
  assert.equal(
    (workflow.match(/DEFAULT_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}/g) ?? [])
      .length,
    2,
    "Default-branch context must cross each shell boundary through an environment variable.",
  );
  assert.ok(workflow.includes('--default-branch "${DEFAULT_BRANCH}"'));
  assert.equal(
    workflow.includes('--default-branch "${{ github.event.repository.default_branch }}"'),
    false,
    "Attacker-controllable GitHub context must not be interpolated directly into a run block.",
  );
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

test("all workflows pin actions, bound jobs and grant only reviewed permissions", async () => {
  const expectedWritePermissions = new Map([
    ["ci.yml", []],
    ["pages.yml", ["id-token", "pages", "pages"]],
    ["release.yml", ["artifact-metadata", "attestations", "contents", "id-token"]],
  ]);

  for (const [name, url] of [
    ["ci.yml", ciWorkflowUrl],
    ["pages.yml", pagesWorkflowUrl],
    ["release.yml", releaseWorkflowUrl],
  ]) {
    const workflow = (await readFile(url, "utf8")).replaceAll("\r\n", "\n");
    assert.match(workflow, /^permissions:\n  contents: read$/mu, name);
    assert.doesNotMatch(workflow, /permissions:\s*write-all|pull_request_target\s*:/iu);

    const actions = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gmu)];
    assert.ok(actions.length > 0, `${name} must use at least one reviewed action.`);
    for (const [, action] of actions) {
      assert.match(
        action,
        /^[^@\s]+@[0-9a-f]{40}$/u,
        `${name}: ${action} is not pinned to a full commit SHA.`,
      );
    }

    const checkoutCount = actions.filter(([, action]) =>
      action.startsWith("actions/checkout@"),
    ).length;
    assert.equal(
      (workflow.match(/persist-credentials: false/gu) ?? []).length,
      checkoutCount,
      `${name} must disable persisted credentials for every checkout.`,
    );

    const jobs = workflow.slice(workflow.indexOf("\njobs:\n"));
    const jobNames = [...jobs.matchAll(/^  ([a-z0-9][a-z0-9-]*):\n/gmu)].map(
      ([, jobName]) => jobName,
    );
    assert.ok(jobNames.length > 0, `${name} must define jobs.`);
    for (const jobName of jobNames) {
      assert.match(
        workflowJob(workflow, jobName),
        /^    timeout-minutes: [1-9][0-9]*$/mu,
        `${name}:${jobName} must have a positive timeout.`,
      );
    }

    const writes = [
      ...workflow.matchAll(/^      ([a-z-]+): write(?:\s+#.*)?$/gmu),
    ]
      .map(([, permission]) => permission)
      .sort();
    assert.deepEqual(writes, expectedWritePermissions.get(name), name);
  }
});

test("CI source-tree secret scanning is checksum-pinned and fail-closed", async () => {
  const workflow = (await readFile(ciWorkflowUrl, "utf8")).replaceAll("\r\n", "\n");
  const securityJob = workflowJob(workflow, "security");
  for (const token of [
    "    name: Source-tree secret scan",
    "    runs-on: ubuntu-24.04",
    "    timeout-minutes: 5",
    "    permissions:\n      contents: read",
    "uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "persist-credentials: false",
    'GITLEAKS_VERSION: "8.30.1"',
    'GITLEAKS_SHA256: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"',
    "set -euo pipefail",
    "curl --fail --silent --show-error --location --proto '=https' --tlsv1.2",
    "sha256sum --check --strict",
    'tar --extract --gzip --file "${RUNNER_TEMP}/${archive}"',
    '\"${RUNNER_TEMP}/gitleaks\" dir . --redact --no-banner --no-color --exit-code 1',
  ]) {
    assert.ok(securityJob.includes(token), `security job is missing ${token}`);
  }

  const download = securityJob.indexOf("curl --fail");
  const checksum = securityJob.indexOf("sha256sum --check --strict");
  const extraction = securityJob.indexOf("tar --extract");
  const scan = securityJob.indexOf('"${RUNNER_TEMP}/gitleaks" dir .');
  assert.ok(download < checksum && checksum < extraction && extraction < scan);
  assert.doesNotMatch(securityJob, /continue-on-error|\|\|\s*true/u);
});

test("container security gates install the exact amd64 Trivy asset and publish SBOMs", async () => {
  const expectedVersion = 'TRIVY_VERSION: "0.72.0"';
  const expectedChecksum =
    'TRIVY_SHA256: "bbb64b9695866ce4a7a8f5c9592002c5961cab378577fa3f8a040df362b9b2ea"';
  for (const [name, url] of [
    ["ci.yml", ciWorkflowUrl],
    ["release.yml", releaseWorkflowUrl],
  ]) {
    const workflow = await readFile(url, "utf8");
    for (const token of [
      expectedVersion,
      expectedChecksum,
      "trivy_${TRIVY_VERSION}_Linux-64bit.tar.gz",
      "sha256sum --check --strict",
      "--format cyclonedx",
      "--scanners vuln",
      "--severity HIGH,CRITICAL",
      "--scanners secret",
      "--exit-code 1",
      "container-sbom",
    ]) {
      assert.ok(workflow.includes(token), `${name} is missing ${token}`);
    }
    assert.equal(
      workflow.includes("8d863cbe9fd543f36e915aa95a932788ca32e2a05745d9c650ea09908a40cc39"),
      false,
      `${name} must not use the checksum for another Trivy architecture.`,
    );
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
    assert.match(workflow, /VECTOR_ORIGIN=https:\/\//);
    assert.match(workflow, /VECTOR_COOKIE_SECURE=true/);
    assert.doesNotMatch(workflow, /VECTOR_ORIGIN=http:\/\//);
    assert.doesNotMatch(workflow, /VECTOR_COOKIE_SECURE=false/);
    for (const identityName of [
      "VECTOR_BOOTSTRAP_SCHOOL_NAME",
      "VECTOR_BOOTSTRAP_SCHOOL_SLUG",
      "VECTOR_BOOTSTRAP_TIME_ZONE",
      "VECTOR_BOOTSTRAP_ADMIN_EMAIL",
      "VECTOR_BOOTSTRAP_ADMIN_NAME",
    ]) {
      assert.ok(
        workflow.includes(identityName),
        `${name} must initialize with an explicit ${identityName}.`,
      );
    }
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
    assert.ok(
      workflow.includes("for removed_tool in npm npx corepack yarn yarnpkg pnpm pnpx"),
      `${name} must verify that package-manager CLIs are absent from the runtime.`,
    );
    assert.ok(
      workflow.includes('command -v ${removed_tool}'),
      `${name} must resolve each forbidden runtime command.`,
    );
    assert.ok(
      workflow.includes("node scripts/doctor.mjs"),
      `${name} must run diagnostics directly with Node.`,
    );
    assert.ok(
      workflow.includes("nodev,noexec,nosuid"),
      `${name} must prevent devices, execution and set-id semantics in temporary storage.`,
    );
    assert.ok(
      workflow.includes("test ! -w /app/node_modules/better-sqlite3/build/Release/better_sqlite3.node"),
      `${name} must verify application code is immutable even without a read-only root filesystem.`,
    );
    assert.ok(
      workflow.includes("test ! -w /usr/share/licenses/vector/LICENSE"),
      `${name} must verify the canonical license is immutable in the runtime image.`,
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
