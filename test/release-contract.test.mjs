import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  buildReleaseCandidate,
  compareReleaseCandidates,
  validateReleaseMetadata,
  verifyReleaseCandidate,
} from "../scripts/release-lib.mjs";

const COMMIT = "a".repeat(40);

test("version metadata stays synchronized and accepts only its stable tag", async () => {
  const metadata = await validateReleaseMetadata({ tag: "v2.0.0" });
  assert.equal(metadata.version, "2.0.0");
  assert.match(metadata.notes, /deterministic static-site archives/);
  await assert.rejects(() => validateReleaseMetadata({ tag: "v2.0.1" }), /does not match package version/);
  await assert.rejects(() => validateReleaseMetadata({ tag: "2.0.0" }), /does not match package version/);
});

test("two independently assembled static candidates are byte-for-byte identical", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "vector-release-contract-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const first = resolve(root, "first");
  const second = resolve(root, "second");
  await buildReleaseCandidate({ output: first, sourceCommit: COMMIT, tag: "v2.0.0" });
  await buildReleaseCandidate({ output: second, sourceCommit: COMMIT, tag: "v2.0.0" });
  const result = await compareReleaseCandidates({
    directory: first,
    otherDirectory: second,
    sourceCommit: COMMIT,
    tag: "v2.0.0",
  });
  assert.deepEqual(result, { sourceCommit: COMMIT, version: "2.0.0" });
  assert.deepEqual(await readdir(first), await readdir(second));
});

test("candidate verification detects archive drift even when checksums are rewritten", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "vector-release-tamper-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const candidate = resolve(root, "candidate");
  await buildReleaseCandidate({ output: candidate, sourceCommit: COMMIT });

  const archivePath = resolve(candidate, "vector-site-2.0.0.zip");
  const archive = await readFile(archivePath);
  const contentOffset = archive.indexOf(Buffer.from("<!doctype html>"));
  assert.ok(contentOffset >= 0, "The deterministic ZIP must contain index.html bytes in store mode.");
  archive[contentOffset] ^= 0xff;
  await writeFile(archivePath, archive);
  const crypto = await import("node:crypto");
  const digest = crypto.createHash("sha256").update(archive).digest("hex");
  const checksumPath = resolve(candidate, "SHA256SUMS");
  const checksums = (await readFile(checksumPath, "utf8")).replace(
    /^[0-9a-f]{64}  vector-site-2\.0\.0\.zip$/m,
    `${digest}  vector-site-2.0.0.zip`,
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
