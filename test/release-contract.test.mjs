import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";

import {
  acceptReleaseCandidate,
  assertCleanTaggerEnvironment,
  assertReleaseInputAllowed,
  buildReleaseCandidate,
  canonicalGzipOperatingSystem,
  canonicalizeGzipHeader,
  compareReleaseCandidates,
  releaseSigningKeyFingerprint,
  releaseSigningPublicKey,
  validateLocalSignedTag,
  validateReleaseMetadata,
  validateReleaseSourceState,
  validateTagPreflight,
  verifyReleaseCandidate,
} from "../scripts/release-lib.mjs";

const COMMIT = "a".repeat(40);
const TAG_OBJECT = "b".repeat(40);
const UNAPPROVED_TAGGER_EMAIL = ["info", "ejupilabs.com"].join("@");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const releaseCli = fileURLToPath(new URL("../scripts/release-cli.mjs", import.meta.url));

test("published release notes stay immutable while later work remains Unreleased", async () => {
  const changelog = (await readFile(
    new URL("../CHANGELOG.md", import.meta.url),
    "utf8",
  )).replaceAll("\r\n", "\n");
  const published330 = changelog.match(
    /^## 3\.3\.0[^\n]*\n\n[\s\S]*?(?=^## )/m,
  );
  assert.ok(published330, "CHANGELOG.md must retain its 3.3.0 section.");
  assert.equal(
    sha256(`${published330[0].trimEnd()}\n`),
    "3c9b6c2973bf2e1824bb13208f375ed8e0903782b14cafa0a83b1be76c43bf57",
  );
  const published340 = changelog.match(
    /^## 3\.4\.0[^\n]*\n\n[\s\S]*?(?=^## )/m,
  );
  assert.ok(published340, "CHANGELOG.md must retain its 3.4.0 section.");
  assert.equal(
    sha256(`${published340[0].trimEnd()}\n`),
    "e54c921e5e1f6828cf9c162f81ab48861a29e24cc67c209f449aeaf01edd9d0f",
  );
  assert.match(published340[0], /live WAL backup and restore/);
  assert.match(published340[0], /checksummed Trivy binary/);
  const unreleased = changelog.match(
    /^## Unreleased\n\n([\s\S]*?)(?=^## )/m,
  );
  assert.ok(unreleased, "CHANGELOG.md must retain its Unreleased section.");
  assert.equal(unreleased[1].trim(), "- No unreleased changes.");
});

test("release inputs reject untracked environment, database, backup and oversized content", () => {
  const text = Buffer.from("safe release documentation\n");
  assert.doesNotThrow(() => assertReleaseInputAllowed("docs/self-hosting.md", text));
  assert.doesNotThrow(() => assertReleaseInputAllowed(".env.example", text));
  for (const path of [
    "site/foo.sqlite",
    "site/foo.sqlite-wal",
    "docs/.env",
    "docs/.env.production",
    "site/backups/export.bin",
    "server/runtime.log",
  ]) {
    assert.throws(
      () => assertReleaseInputAllowed(path, text),
      /forbidden/i,
      path,
    );
  }
  assert.throws(
    () => assertReleaseInputAllowed(
      "site/not-a-database.txt",
      Buffer.from("SQLite format 3\0payload", "binary"),
    ),
    /SQLite content is forbidden/i,
  );
  assert.throws(
    () => assertReleaseInputAllowed("docs/too-large.md", Buffer.alloc(5 * 1024 * 1024 + 1)),
    /size is outside/i,
  );
  const privateMarkers = ["OPENSSH", "RSA", "EC", "DSA"]
    .map((kind) => `-----BEGIN ${kind} PRIVATE KEY-----`);
  privateMarkers.push("-----BEGIN " + "PGP PRIVATE KEY BLOCK-----");
  for (const marker of privateMarkers) {
    assert.throws(
      () => assertReleaseInputAllowed(
        "docs/late-marker.txt",
        Buffer.from(`${"safe-prefix\n".repeat(40)}${marker}\n`),
      ),
      /Private-key content is forbidden/i,
    );
  }
  for (const path of ["docs/secret.pem", "site/signing.key", "server/store.p12"]) {
    assert.throws(
      () => assertReleaseInputAllowed(path, text),
      /forbidden/i,
    );
  }
});

test("release source binding rejects a dirty tree and a mismatched HEAD", () => {
  const runGit = (arguments_) => {
    const command = arguments_.join(" ");
    if (command === "rev-parse --verify HEAD") {
      return { stdout: `${COMMIT}\n`, stderr: "" };
    }
    if (command === "status --porcelain=v1 --untracked-files=all") {
      return { stdout: "", stderr: "" };
    }
    assert.fail(`Unexpected git command: ${command}`);
  };
  assert.deepEqual(validateReleaseSourceState({ runGit, sourceCommit: COMMIT }), {
    sourceCommit: COMMIT,
  });
  assert.throws(
    () => validateReleaseSourceState({
      runGit,
      sourceCommit: "f".repeat(40),
    }),
    /does not match.*HEAD/i,
  );
  assert.throws(
    () => validateReleaseSourceState({
      sourceCommit: COMMIT,
      runGit(arguments_) {
        if (arguments_[0] === "rev-parse") return { stdout: `${COMMIT}\n`, stderr: "" };
        return { stdout: "?? secret.pem\n", stderr: "" };
      },
    }),
    /must be clean/i,
  );
});

function localTagGit({
  fingerprint = releaseSigningKeyFingerprint,
  objectType = "tag",
  peeledTarget = COMMIT,
  tagTarget = COMMIT,
  taggerEmail = "69587167+ejupi-djenis30@users.noreply.github.com",
  taggerName = "ejupi-djenis30",
} = {}) {
  const calls = [];
  const runGit = (arguments_) => {
    calls.push(arguments_);
    const invocation = arguments_.join("\0");
    if (invocation === `show-ref\0--verify\0--hash\0refs/tags/v3.4.0`) {
      return { stderr: "", stdout: `${TAG_OBJECT}\n` };
    }
    if (invocation === `cat-file\0-t\0${TAG_OBJECT}`) {
      return { stderr: "", stdout: `${objectType}\n` };
    }
    if (invocation === `cat-file\0-p\0${TAG_OBJECT}`) {
      return {
        stderr: "",
        stdout:
          `object ${tagTarget}\n` +
          "type commit\n" +
          "tag v3.4.0\n" +
          `tagger ${taggerName} <${taggerEmail}> 1784764800 +0200\n\n` +
          "VECTOR 3.4.0\n",
      };
    }
    if (invocation === `cat-file\0-t\0${COMMIT}`) {
      return { stderr: "", stdout: "commit\n" };
    }
    if (invocation === "rev-parse\0--verify\0refs/tags/v3.4.0^{}") {
      return { stderr: "", stdout: `${peeledTarget}\n` };
    }
    if (invocation === "verify-tag\0--raw\0refs/tags/v3.4.0") {
      return {
        stderr:
          `Good "git" signature for 69587167+ejupi-djenis30@users.noreply.github.com ` +
          `with ED25519 key ${fingerprint}\n`,
        stdout: "",
      };
    }
    assert.fail(`Unexpected fake git invocation: ${arguments_.join(" ")}`);
  };
  return { calls, runGit };
}

test("version metadata stays synchronized and accepts only its stable tag", async () => {
  const metadata = await validateReleaseMetadata({ tag: "v3.4.0" });
  assert.equal(metadata.version, "3.4.0");
  assert.match(metadata.notes, /live WAL backup and restore/);
  assert.match(metadata.notes, /checksummed Trivy binary/);
  await assert.rejects(() => validateReleaseMetadata({ tag: "v2.0.0" }), /does not match package version/);
  await assert.rejects(() => validateReleaseMetadata({ tag: "3.4.0" }), /does not match package version/);
});

test("tag preflight requires the tracked GitHub-verifiable tagger identity", async () => {
  const result = await validateTagPreflight({
    sourceCommit: COMMIT,
    tag: "v3.4.0",
    taggerName: "ejupi-djenis30",
    taggerEmail: "69587167+ejupi-djenis30@users.noreply.github.com",
  });
  assert.deepEqual(result, {
    sourceCommit: COMMIT,
    tag: "v3.4.0",
    tagger: {
      email: "69587167+ejupi-djenis30@users.noreply.github.com",
      name: "ejupi-djenis30",
    },
    version: "3.4.0",
  });
  await assert.rejects(
    () => validateTagPreflight({
      sourceCommit: COMMIT,
      tag: "v3.4.0",
      taggerName: "Unapproved Tagger",
      taggerEmail: UNAPPROVED_TAGGER_EMAIL,
    }),
    /Tagger name differs from release-policy/,
  );
  await assert.rejects(
    () => validateTagPreflight({
      sourceCommit: COMMIT,
      tag: "v3.4.0",
      taggerName: "ejupi-djenis30",
      taggerEmail: UNAPPROVED_TAGGER_EMAIL,
    }),
    /Tagger email differs from release-policy/,
  );
});

test("tag preflight CLI fails closed for the unpublished corporate tagger identity", () => {
  const baseArguments = [
    releaseCli,
    "tag-preflight",
    "--tag", "v3.4.0",
    "--commit", COMMIT,
    "--tagger-name", "ejupi-djenis30",
    "--tagger-email",
  ];
  const approved = spawnSync(process.execPath, [
    ...baseArguments,
    "69587167+ejupi-djenis30@users.noreply.github.com",
  ], { encoding: "utf8", windowsHide: true });
  assert.equal(approved.status, 0, approved.stderr);
  assert.match(approved.stdout, /tag preflight passed/);

  const rejected = spawnSync(process.execPath, [
    ...baseArguments,
    UNAPPROVED_TAGGER_EMAIL,
  ], { encoding: "utf8", windowsHide: true });
  assert.notEqual(rejected.status, 0);
  assert.match(`${rejected.stdout}\n${rejected.stderr}`, /Tagger email differs from release-policy/);
});

test("tag preflight rejects Git tagger environment overrides before tag creation", () => {
  assert.throws(
    () => assertCleanTaggerEnvironment({
      PATH: process.env.PATH,
      git_committer_email: UNAPPROVED_TAGGER_EMAIL,
    }),
    /GIT_COMMITTER_EMAIL.*overrides are forbidden/,
  );
  assert.throws(
    () => assertCleanTaggerEnvironment({
      GIT_COMMITTER_NAME: "Unapproved Tagger",
      PATH: process.env.PATH,
    }),
    /GIT_COMMITTER_NAME.*overrides are forbidden/,
  );

  const rejected = spawnSync(process.execPath, [
    releaseCli,
    "tag-preflight",
    "--tag", "v3.4.0",
    "--commit", COMMIT,
    "--tagger-name", "ejupi-djenis30",
    "--tagger-email", "69587167+ejupi-djenis30@users.noreply.github.com",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_COMMITTER_EMAIL: UNAPPROVED_TAGGER_EMAIL,
    },
    windowsHide: true,
  });
  assert.notEqual(rejected.status, 0);
  assert.match(`${rejected.stdout}\n${rejected.stderr}`, /GIT_COMMITTER_EMAIL.*overrides are forbidden/);
});

test("release signing public key matches the pinned fingerprint", () => {
  const [algorithm, encodedKey, ...extra] = releaseSigningPublicKey.split(" ");
  assert.equal(algorithm, "ssh-ed25519");
  assert.equal(extra.length, 0, "The release public key must not carry a mutable comment.");
  const fingerprint = createHash("sha256")
    .update(Buffer.from(encodedKey, "base64"))
    .digest("base64")
    .replace(/=+$/, "");
  assert.equal(`SHA256:${fingerprint}`, releaseSigningKeyFingerprint);
});

test("local signed-tag verification checks the exact ref, direct target, tagger and SSH key", async () => {
  const fixture = localTagGit();
  const result = await validateLocalSignedTag({
    runGit: fixture.runGit,
    sourceCommit: COMMIT,
    tag: "v3.4.0",
  });
  assert.deepEqual(result, {
    signingKey: {
      algorithm: "ED25519",
      fingerprint: releaseSigningKeyFingerprint,
    },
    sourceCommit: COMMIT,
    tag: "v3.4.0",
    tagObject: TAG_OBJECT,
    tagger: {
      email: "69587167+ejupi-djenis30@users.noreply.github.com",
      name: "ejupi-djenis30",
    },
  });
  assert.deepEqual(fixture.calls.at(0), [
    "show-ref",
    "--verify",
    "--hash",
    "refs/tags/v3.4.0",
  ]);
  assert.deepEqual(fixture.calls.at(-1), [
    "verify-tag",
    "--raw",
    "refs/tags/v3.4.0",
  ]);
});

test("local signed-tag verification rejects an identity introduced by a committer override", async () => {
  const fixture = localTagGit({ taggerEmail: UNAPPROVED_TAGGER_EMAIL });
  await assert.rejects(
    () => validateLocalSignedTag({
      runGit: fixture.runGit,
      sourceCommit: COMMIT,
      tag: "v3.4.0",
    }),
    /actual annotated tagger email differs from release policy/i,
  );
});

test("local signed-tag verification rejects indirect targets and an unapproved signing key", async () => {
  const indirect = localTagGit({ tagTarget: TAG_OBJECT });
  await assert.rejects(
    () => validateLocalSignedTag({
      runGit: indirect.runGit,
      sourceCommit: COMMIT,
      tag: "v3.4.0",
    }),
    /does not directly target the reviewed commit/,
  );

  const wrongKey = localTagGit({ fingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
  await assert.rejects(
    () => validateLocalSignedTag({
      runGit: wrongKey.runGit,
      sourceCommit: COMMIT,
      tag: "v3.4.0",
    }),
    /was not verified with the release-policy SSH principal and key fingerprint/,
  );
});

test("two independently assembled self-hosted candidates are byte-for-byte identical", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "vector-release-contract-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const first = resolve(root, "first");
  const second = resolve(root, "second");
  await buildReleaseCandidate({
    output: first,
    sourceCommit: COMMIT,
    tag: "v3.4.0",
    verifySource: false,
  });
  await buildReleaseCandidate({
    output: second,
    sourceCommit: COMMIT,
    tag: "v3.4.0",
    verifySource: false,
  });
  const result = await compareReleaseCandidates({
    directory: first,
    otherDirectory: second,
    sourceCommit: COMMIT,
    tag: "v3.4.0",
  });
  assert.deepEqual(result, { sourceCommit: COMMIT, version: "3.4.0" });
  assert.deepEqual(await readdir(first), await readdir(second));
});

test(
  "the extracted self-hosted artifact pins its runtime and passes diagnostics",
  { skip: process.env.VECTOR_RELEASE_ACCEPTANCE_CHILD === "1" },
  async (context) => {
    const previousBootstrapPassword = process.env.VECTOR_BOOTSTRAP_ADMIN_PASSWORD;
    const previousPath = process.env.PATH;
    process.env.VECTOR_BOOTSTRAP_ADMIN_PASSWORD = "ambient-release-secret-must-not-be-retained";
    context.after(() => {
      if (previousBootstrapPassword === undefined) {
        delete process.env.VECTOR_BOOTSTRAP_ADMIN_PASSWORD;
      } else {
        process.env.VECTOR_BOOTSTRAP_ADMIN_PASSWORD = previousBootstrapPassword;
      }
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    });
    const root = await mkdtemp(join(tmpdir(), "vector-release-acceptance-contract-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const fakeBin = resolve(root, "unsupported-runtime-first");
    await mkdir(fakeBin);
    const fakeNode = resolve(fakeBin, process.platform === "win32" ? "node.cmd" : "node");
    await writeFile(
      fakeNode,
      process.platform === "win32"
        ? "@echo Unsupported PATH node must not run. 1>&2\r\n@exit /b 97\r\n"
        : "#!/bin/sh\necho 'Unsupported PATH node must not run.' >&2\nexit 97\n",
      { mode: 0o755 },
    );
    process.env.PATH = [fakeBin, previousPath]
      .filter((value) => typeof value === "string" && value.length > 0)
      .join(delimiter);
    const candidate = resolve(root, "candidate");
    await buildReleaseCandidate({
      output: candidate,
      sourceCommit: COMMIT,
      tag: "v3.4.0",
      verifySource: false,
    });
    assert.deepEqual(
      await acceptReleaseCandidate({
        directory: candidate,
        sourceCommit: COMMIT,
        tag: "v3.4.0",
      }),
      { sourceCommit: COMMIT, version: "3.4.0" },
    );
  },
);

test("canonical gzip headers erase host OS variance without changing the payload", () => {
  const tar = Buffer.from("deterministic tar payload\n");
  const gzip = gzipSync(tar, { level: 9, mtime: 0 });
  const windows = Buffer.from(gzip);
  const unix = Buffer.from(gzip);
  windows[9] = 10;
  unix[9] = 3;

  assert.notEqual(sha256(windows), sha256(unix));
  const canonicalWindows = canonicalizeGzipHeader(windows);
  const canonicalUnix = canonicalizeGzipHeader(unix);

  assert.deepEqual(canonicalWindows, canonicalUnix);
  assert.equal(sha256(canonicalWindows), sha256(canonicalUnix));
  assert.equal(canonicalWindows[9], canonicalGzipOperatingSystem);
  assert.equal(canonicalGzipOperatingSystem, 255);
  assert.deepEqual(gunzipSync(canonicalWindows), tar);
  assert.deepEqual(gunzipSync(canonicalUnix), tar);
  assert.equal(windows[9], 10, "Canonicalization must not mutate its input.");
  assert.equal(unix[9], 3, "Canonicalization must not mutate its input.");
});

test("canonical gzip headers reject malformed streams before mutation", () => {
  const valid = gzipSync(Buffer.from("payload"), { level: 9, mtime: 0 });
  const fixtures = [
    { bytes: valid.subarray(0, 9), message: /too short/ },
    { bytes: Buffer.from(valid), index: 0, value: 0, message: /first magic byte/ },
    { bytes: Buffer.from(valid), index: 1, value: 0, message: /second magic byte/ },
    { bytes: Buffer.from(valid), index: 2, value: 0, message: /DEFLATE compression method/ },
    { bytes: Buffer.from(valid), index: 3, value: 4, message: /fixed ten-byte header/ },
  ];

  for (const fixture of fixtures) {
    if (fixture.index !== undefined) fixture.bytes[fixture.index] = fixture.value;
    const before = Buffer.from(fixture.bytes);
    assert.throws(() => canonicalizeGzipHeader(fixture.bytes), fixture.message);
    assert.deepEqual(fixture.bytes, before);
  }
});

test("candidate verification rejects a checksum-consistent host-specific gzip header", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "vector-release-gzip-os-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const candidate = resolve(root, "candidate");
  await buildReleaseCandidate({
    output: candidate,
    sourceCommit: COMMIT,
    tag: "v3.4.0",
    verifySource: false,
  });

  const archivePath = resolve(candidate, "vector-self-hosted-3.4.0.tar.gz");
  const archive = await readFile(archivePath);
  archive[9] = 3;
  await writeFile(archivePath, archive);
  const checksumPath = resolve(candidate, "SHA256SUMS");
  const checksums = (await readFile(checksumPath, "utf8")).replace(
    /^[0-9a-f]{64}  vector-self-hosted-3\.4\.0\.tar\.gz$/m,
    `${sha256(archive)}  vector-self-hosted-3.4.0.tar.gz`,
  );
  await writeFile(checksumPath, checksums);

  await assert.rejects(
    () => verifyReleaseCandidate({ directory: candidate, sourceCommit: COMMIT, tag: "v3.4.0" }),
    /unknown operating-system marker/,
  );
});

test("candidate verification detects archive drift even when checksums are rewritten", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "vector-release-tamper-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const candidate = resolve(root, "candidate");
  await buildReleaseCandidate({
    output: candidate,
    sourceCommit: COMMIT,
    verifySource: false,
  });

  const archivePath = resolve(candidate, "vector-self-hosted-3.4.0.zip");
  const archive = await readFile(archivePath);
  const contentOffset = archive.indexOf(Buffer.from("<!doctype html>"));
  assert.ok(contentOffset >= 0, "The deterministic ZIP must contain index.html bytes in store mode.");
  archive[contentOffset] ^= 0xff;
  await writeFile(archivePath, archive);
  const crypto = await import("node:crypto");
  const digest = crypto.createHash("sha256").update(archive).digest("hex");
  const checksumPath = resolve(candidate, "SHA256SUMS");
  const checksums = (await readFile(checksumPath, "utf8")).replace(
    /^[0-9a-f]{64}  vector-self-hosted-3\.4\.0\.zip$/m,
    `${digest}  vector-self-hosted-3.4.0.zip`,
  );
  await writeFile(checksumPath, checksums);

  await assert.rejects(
    () => verifyReleaseCandidate({ directory: candidate, sourceCommit: COMMIT }),
    /CRC mismatch/,
  );
});

test("candidate builder refuses to overwrite an existing output directory", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "vector-release-output-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    () => buildReleaseCandidate({
      output: root,
      sourceCommit: COMMIT,
      verifySource: false,
    }),
    /EEXIST/,
  );
});
