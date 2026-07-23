import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";

import {
  buildReleaseCandidate,
  canonicalGzipOperatingSystem,
  canonicalizeGzipHeader,
  compareReleaseCandidates,
  validateReleaseMetadata,
  validateTagPreflight,
  verifyReleaseCandidate,
} from "../scripts/release-lib.mjs";

const COMMIT = "a".repeat(40);
const UNAPPROVED_TAGGER_EMAIL = ["info", "ejupilabs.com"].join("@");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const releaseCli = fileURLToPath(new URL("../scripts/release-cli.mjs", import.meta.url));

test("version metadata stays synchronized and accepts only its stable tag", async () => {
  const metadata = await validateReleaseMetadata({ tag: "v2.0.1" });
  assert.equal(metadata.version, "2.0.1");
  assert.match(metadata.notes, /runtime forward unchanged/);
  await assert.rejects(() => validateReleaseMetadata({ tag: "v2.0.0" }), /does not match package version/);
  await assert.rejects(() => validateReleaseMetadata({ tag: "2.0.1" }), /does not match package version/);
});

test("tag preflight requires the tracked GitHub-verifiable tagger identity", async () => {
  const result = await validateTagPreflight({
    sourceCommit: COMMIT,
    tag: "v2.0.1",
    taggerName: "Djenis Ejupi",
    taggerEmail: "69587167+ejupi-djenis30@users.noreply.github.com",
  });
  assert.deepEqual(result, {
    sourceCommit: COMMIT,
    tag: "v2.0.1",
    tagger: {
      email: "69587167+ejupi-djenis30@users.noreply.github.com",
      name: "Djenis Ejupi",
    },
    version: "2.0.1",
  });
  await assert.rejects(
    () => validateTagPreflight({
      sourceCommit: COMMIT,
      tag: "v2.0.1",
      taggerName: "Ejupi Labs",
      taggerEmail: UNAPPROVED_TAGGER_EMAIL,
    }),
    /Tagger name differs from release-policy/,
  );
  await assert.rejects(
    () => validateTagPreflight({
      sourceCommit: COMMIT,
      tag: "v2.0.1",
      taggerName: "Djenis Ejupi",
      taggerEmail: UNAPPROVED_TAGGER_EMAIL,
    }),
    /Tagger email differs from release-policy/,
  );
});

test("tag preflight CLI fails closed for the unpublished corporate tagger identity", () => {
  const baseArguments = [
    releaseCli,
    "tag-preflight",
    "--tag", "v2.0.1",
    "--commit", COMMIT,
    "--tagger-name", "Djenis Ejupi",
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

test("two independently assembled static candidates are byte-for-byte identical", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "vector-release-contract-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const first = resolve(root, "first");
  const second = resolve(root, "second");
  await buildReleaseCandidate({ output: first, sourceCommit: COMMIT, tag: "v2.0.1" });
  await buildReleaseCandidate({ output: second, sourceCommit: COMMIT, tag: "v2.0.1" });
  const result = await compareReleaseCandidates({
    directory: first,
    otherDirectory: second,
    sourceCommit: COMMIT,
    tag: "v2.0.1",
  });
  assert.deepEqual(result, { sourceCommit: COMMIT, version: "2.0.1" });
  assert.deepEqual(await readdir(first), await readdir(second));
});

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
  await buildReleaseCandidate({ output: candidate, sourceCommit: COMMIT, tag: "v2.0.1" });

  const archivePath = resolve(candidate, "vector-site-2.0.1.tar.gz");
  const archive = await readFile(archivePath);
  archive[9] = 3;
  await writeFile(archivePath, archive);
  const checksumPath = resolve(candidate, "SHA256SUMS");
  const checksums = (await readFile(checksumPath, "utf8")).replace(
    /^[0-9a-f]{64}  vector-site-2\.0\.1\.tar\.gz$/m,
    `${sha256(archive)}  vector-site-2.0.1.tar.gz`,
  );
  await writeFile(checksumPath, checksums);

  await assert.rejects(
    () => verifyReleaseCandidate({ directory: candidate, sourceCommit: COMMIT, tag: "v2.0.1" }),
    /unknown operating-system marker/,
  );
});

test("candidate verification detects archive drift even when checksums are rewritten", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "vector-release-tamper-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const candidate = resolve(root, "candidate");
  await buildReleaseCandidate({ output: candidate, sourceCommit: COMMIT });

  const archivePath = resolve(candidate, "vector-site-2.0.1.zip");
  const archive = await readFile(archivePath);
  const contentOffset = archive.indexOf(Buffer.from("<!doctype html>"));
  assert.ok(contentOffset >= 0, "The deterministic ZIP must contain index.html bytes in store mode.");
  archive[contentOffset] ^= 0xff;
  await writeFile(archivePath, archive);
  const crypto = await import("node:crypto");
  const digest = crypto.createHash("sha256").update(archive).digest("hex");
  const checksumPath = resolve(candidate, "SHA256SUMS");
  const checksums = (await readFile(checksumPath, "utf8")).replace(
    /^[0-9a-f]{64}  vector-site-2\.0\.1\.zip$/m,
    `${digest}  vector-site-2.0.1.zip`,
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
    () => buildReleaseCandidate({ output: root, sourceCommit: COMMIT }),
    /EEXIST/,
  );
});
