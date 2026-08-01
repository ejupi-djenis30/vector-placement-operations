import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolveE2ePorts } from "../scripts/e2e-ports.mjs";
import {
  assertSupportedNodeVersion,
  isSupportedNodeVersion,
  SUPPORTED_NODE_RANGE,
} from "../server/version.mjs";

const dependabotUrl = new URL("../.github/dependabot.yml", import.meta.url);
const dockerfileUrl = new URL("../Dockerfile", import.meta.url);
const environmentExampleUrl = new URL("../.env.example", import.meta.url);
const packageUrl = new URL("../package.json", import.meta.url);
const e2eServerUrl = new URL("../scripts/serve-e2e.mjs", import.meta.url);
const runtimePreflightUrl = new URL("../scripts/runtime-preflight.mjs", import.meta.url);
const securityPolicyUrl = new URL("../SECURITY.md", import.meta.url);

test("Dependabot applies a seven-day cooldown to each scheduled ecosystem", async () => {
  const source = await readFile(dependabotUrl, "utf8");
  const blocks = source
    .split(/\r?\n(?=  - package-ecosystem:)/)
    .filter((block) => block.includes("package-ecosystem:"));
  const ecosystems = new Map(blocks.map((block) => {
    const ecosystem = block.match(/package-ecosystem:\s*([^\s]+)/)?.[1];
    return [ecosystem, block];
  }));

  assert.deepEqual([...ecosystems.keys()], ["github-actions", "npm", "docker"]);
  for (const [ecosystem, block] of ecosystems) {
    assert.match(
      block,
      /(?:^|\r?\n)    cooldown:\r?\n      default-days: 7(?:\r?\n|$)/,
      `${ecosystem} updates must retain the seven-day cooldown`,
    );
  }
});

test("E2E ports keep stable defaults and accept an isolated pair", () => {
  assert.deepEqual(resolveE2ePorts({}), {
    presentation: 4_174,
    workspace: 4_173,
  });
  assert.deepEqual(resolveE2ePorts({
    VECTOR_E2E_PRESENTATION_PORT: "4274",
    VECTOR_E2E_WORKSPACE_PORT: "4273",
  }), {
    presentation: 4_274,
    workspace: 4_273,
  });
  assert.throws(
    () => resolveE2ePorts({ VECTOR_E2E_PRESENTATION_PORT: "invalid" }),
    /must be an integer TCP port/,
  );
  assert.throws(
    () => resolveE2ePorts({
      VECTOR_E2E_PRESENTATION_PORT: "4273",
      VECTOR_E2E_WORKSPACE_PORT: "4273",
    }),
    /ports must be different/,
  );
});

test("the E2E server leaves no file-backed fixture behind when Playwright force-stops it", async () => {
  const source = await readFile(e2eServerUrl, "utf8");
  assert.match(source, /VECTOR_DB_PATH:\s*":memory:"/);
  assert.doesNotMatch(source, /\b(?:mkdtemp|rmSync|temporaryDirectory)\b/);
});

test("the production image compiles its SQLite addon against the pinned runtime base", async () => {
  const dockerfile = await readFile(dockerfileUrl, "utf8");
  const normalized = dockerfile.replace(/\\\r?\n\s*/g, " ");
  assert.match(
    normalized,
    /npm ci --omit=dev --ignore-scripts --no-audit --no-fund\s+&& cd node_modules\/better-sqlite3\s+&& node \/usr\/local\/lib\/node_modules\/npm\/node_modules\/node-gyp\/bin\/node-gyp\.js rebuild --release --force_build=1\s+&& rm -rf prebuilds\s+&& cd \/app/,
  );
  assert.equal(
    (dockerfile.match(/FROM node:24\.18\.0-alpine3\.24@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd/g) ?? []).length,
    2,
  );
  assert.match(normalized, /apk add --no-cache g\+\+ make python3/);
  assert.match(
    normalized,
    /rm -rf\s+\/usr\/local\/lib\/node_modules\/npm\s+\/usr\/local\/lib\/node_modules\/corepack\s+\/opt\/yarn-v1\.22\.22\s+&& rm -f\s+\/usr\/local\/bin\/npm\s+\/usr\/local\/bin\/npx\s+\/usr\/local\/bin\/corepack\s+\/usr\/local\/bin\/yarn\s+\/usr\/local\/bin\/yarnpkg\s+\/usr\/local\/bin\/pnpm\s+\/usr\/local\/bin\/pnpx/,
  );
  assert.match(normalized, /COPY --from=dependencies --chown=root:root \/app\/node_modules \.\/node_modules/);
  assert.match(normalized, /COPY --chown=root:root LICENSE \/usr\/share\/licenses\/vector\/LICENSE/);
  assert.match(normalized, /RUN chown -R root:root \/app\s+&& chmod -R go-w \/app/);
  assert.match(normalized, /chmod 0444 \/usr\/share\/licenses\/vector\/LICENSE/);
  assert.equal(dockerfile.includes("--chown=node:node /app"), false);
  assert.match(normalized, /ENTRYPOINT \[\]\s+CMD \["node", "server\/index\.mjs"\]/);
});

test("runtime support is limited to the two pinned LTS release lines", () => {
  assert.equal(SUPPORTED_NODE_RANGE, ">=22.23.1 <23 || >=24.18.0 <25");
  for (const version of ["22.23.1", "22.99.0", "v24.18.0", "24.99.0"]) {
    assert.equal(isSupportedNodeVersion(version), true, version);
    assert.doesNotThrow(() => assertSupportedNodeVersion(version));
  }
  for (const version of [
    "22.23.0",
    "23.11.1",
    "24.16.0",
    "24.17.9",
    "25.8.0",
    "26.5.0",
    "invalid",
  ]) {
    assert.equal(isSupportedNodeVersion(version), false, version);
    assert.throws(
      () => assertSupportedNodeVersion(version),
      new RegExp(SUPPORTED_NODE_RANGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
  assert.throws(
    () => assertSupportedNodeVersion("24.16.0"),
    /VECTOR requires Node\.js .*; received 24\.16\.0\./,
  );
});

test("developer, operator and release scripts reject unsupported Node before work", async () => {
  const [packageText, preflight] = await Promise.all([
    readFile(packageUrl, "utf8"),
    readFile(runtimePreflightUrl, "utf8"),
  ]);
  const { scripts } = JSON.parse(packageText);
  const preflightCommand = "node scripts/runtime-preflight.mjs && ";
  for (const name of [
    "test",
    "test:coverage",
    "test:e2e",
    "test:e2e:webkit",
    "audit:scale",
    "db:migrate",
    "db:backup",
    "db:inspect-backup",
    "db:restore",
    "db:compact",
    "admin:create",
    "doctor",
    "check:audit",
    "check:site",
    "check:release",
    "release:tag-preflight",
    "release:tag-verify",
    "release:build",
    "release:verify",
    "check",
  ]) {
    assert.ok(
      scripts[name].startsWith(preflightCommand),
      `${name} must fail before executing its workload`,
    );
  }
  assert.match(
    preflight,
    /import \{ assertSupportedNodeVersion \} from "\.\.\/server\/version\.mjs";/,
  );
  assert.match(preflight, /assertSupportedNodeVersion\(\);/);
});

test("the example deployment fails closed for forwarded client headers", async () => {
  const environment = await readFile(environmentExampleUrl, "utf8");
  assert.match(environment, /^VECTOR_TRUST_PROXY=false$/m);
  assert.match(environment, /^VECTOR_COOKIE_SECURE=true$/m);
  assert.match(environment, /Production startup requires HTTPS/i);
  assert.equal(/^VECTOR_ORIGIN=http:/m.test(environment), false);
  assert.equal(/^VECTOR_TRUST_PROXY=[1-5]$/m.test(environment), false);
  assert.match(
    environment,
    /set the\s*\n?# proxy hop count only after placing VECTOR behind/i,
  );
});

test("the security policy supports only the latest patch and defines private disclosure", async () => {
  const [packageText, policy] = await Promise.all([
    readFile(packageUrl, "utf8"),
    readFile(securityPolicyUrl, "utf8"),
  ]);
  const { version } = JSON.parse(packageText);
  const minor = version.split(".").slice(0, 2).join(".");

  assert.ok(
    policy.includes(`| Latest published \`${minor}.x\` release | Supported |`),
  );
  assert.ok(policy.includes(`| Earlier \`${minor}.x\` patches | Not supported |`));
  assert.match(policy, /\| Unreleased branches and commits \| Not supported \|/);
  assert.match(policy, /coordinated inside the private GitHub security\s+advisory/i);
  assert.match(policy, /Public disclosure is coordinated after a fixed release is available/i);
  assert.match(policy, /No fixed acknowledgement or remediation SLA is promised/i);
  assert.match(policy, /Do not send real records or secrets during any stage/i);
});
