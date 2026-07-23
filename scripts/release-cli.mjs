import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import {
  buildReleaseCandidate,
  compareReleaseCandidates,
  validateReleaseMetadata,
  validateTagPreflight,
  verifyReleaseCandidate,
} from "./release-lib.mjs";

function argumentsFor(values) {
  const options = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    assert.match(key, /^--[a-z-]+$/, `Unknown release option: ${key}`);
    assert.ok(index + 1 < values.length && !values[index + 1].startsWith("--"), `Missing value for ${key}`);
    assert.equal(options.has(key), false, `Duplicate release option: ${key}`);
    options.set(key, values[index + 1]);
    index += 1;
  }
  return options;
}

function sourceCommit(options) {
  const explicit = options.get("--commit");
  return explicit ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

const [command = "metadata", ...values] = process.argv.slice(2);
const options = argumentsFor(values);
const allowed = new Set(["metadata", "tag-preflight", "build", "verify", "compare"]);
assert.ok(allowed.has(command), `Unknown release command: ${command}`);
const commandOptions = {
  metadata: new Set(["--tag"]),
  "tag-preflight": new Set(["--commit", "--tag", "--tagger-email", "--tagger-name"]),
  build: new Set(["--commit", "--output", "--tag"]),
  verify: new Set(["--commit", "--directory", "--tag"]),
  compare: new Set(["--commit", "--directory", "--other-directory", "--tag"]),
};
for (const key of options.keys()) assert.ok(commandOptions[command].has(key), `${command} does not accept ${key}.`);
const tag = options.get("--tag");

if (command === "metadata") {
  const metadata = await validateReleaseMetadata({ tag });
  console.log(metadata.version);
} else if (command === "tag-preflight") {
  assert.ok(options.has("--commit"), "tag-preflight requires --commit.");
  const result = await validateTagPreflight({
    sourceCommit: sourceCommit(options),
    tag,
    taggerEmail: options.get("--tagger-email"),
    taggerName: options.get("--tagger-name"),
  });
  console.log(
    `VECTOR ${result.tag} tag preflight passed for ${result.tagger.name} <${result.tagger.email}> ` +
    `at ${result.sourceCommit}.`,
  );
} else if (command === "build") {
  const output = options.get("--output");
  assert.ok(output, "build requires --output.");
  const result = await buildReleaseCandidate({ output, sourceCommit: sourceCommit(options), tag });
  console.log(`VECTOR ${result.version} release candidate built at ${result.directory}.`);
} else if (command === "verify") {
  const directory = options.get("--directory");
  assert.ok(directory, "verify requires --directory.");
  const result = await verifyReleaseCandidate({
    directory,
    sourceCommit: options.has("--commit") ? sourceCommit(options) : undefined,
    tag,
  });
  console.log(`VECTOR ${result.version} release candidate verified.`);
} else {
  const directory = options.get("--directory");
  const otherDirectory = options.get("--other-directory");
  assert.ok(directory && otherDirectory, "compare requires --directory and --other-directory.");
  const result = await compareReleaseCandidates({
    directory,
    otherDirectory,
    sourceCommit: options.has("--commit") ? sourceCommit(options) : undefined,
    tag,
  });
  console.log(`VECTOR ${result.version} release candidates are byte-for-byte identical.`);
}
