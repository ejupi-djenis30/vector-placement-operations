import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  releaseAssetManifest,
  sourceCommitPattern,
  stableVersionPattern,
  validateReleaseMetadata,
  verifyReleaseCandidate,
} from "./release-lib.mjs";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const branchPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;
const apiVersion = "2026-03-10";

function parseArguments(values) {
  const options = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    assert.match(key, /^--[a-z-]+$/, `Unknown publisher option: ${key}`);
    assert.ok(index + 1 < values.length && !values[index + 1].startsWith("--"), `Missing value for ${key}`);
    assert.equal(options.has(key), false, `Duplicate publisher option: ${key}`);
    options.set(key, values[index + 1]);
    index += 1;
  }
  return options;
}

function runGitHub(args, input) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    input,
    windowsHide: true,
    env: process.env,
  });
  if (result.error) throw result.error;
  return result;
}

function commandError(args, result) {
  const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
  return new Error(`gh ${args.join(" ")} failed: ${detail}`);
}

function apiArguments(endpoint, method = "GET") {
  return ["api", `--method=${method}`, endpoint, "-H", `X-GitHub-Api-Version: ${apiVersion}`];
}

function jsonRequest(endpoint, { method = "GET", body, allowMissing = false } = {}) {
  const args = apiArguments(endpoint, method);
  if (body !== undefined) args.push("--input", "-");
  const result = runGitHub(args, body === undefined ? undefined : JSON.stringify(body));
  if (result.status !== 0) {
    if (allowMissing && /(?:HTTP 404|Not Found)/i.test(`${result.stderr}\n${result.stdout}`)) return null;
    throw commandError(args, result);
  }
  if (result.stdout.trim() === "") return null;
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`GitHub returned invalid JSON for ${endpoint}: ${error.message}`);
  }
}

function assertUploadUrl(uploadUrl, repository, releaseId) {
  assert.equal(typeof uploadUrl, "string", "GitHub draft is missing its upload URL.");
  const template = "{?name,label}";
  assert.ok(uploadUrl.endsWith(template), "GitHub draft has an unsupported upload URL template.");
  const parsed = new URL(uploadUrl.slice(0, -template.length));
  assert.equal(parsed.protocol, "https:");
  assert.equal(parsed.hostname, "uploads.github.com");
  assert.equal(parsed.port, "");
  assert.equal(parsed.username, "");
  assert.equal(parsed.password, "");
  assert.equal(parsed.pathname, `/repos/${repository}/releases/${releaseId}/assets`);
  assert.equal(parsed.search, "");
  assert.equal(parsed.hash, "");
  return parsed;
}

class GitHubClient {
  constructor(repository) {
    this.repository = repository;
  }

  tagRef(tag) {
    return jsonRequest(`repos/${this.repository}/git/ref/tags/${encodeURIComponent(tag)}`);
  }

  tagObject(sha) {
    return jsonRequest(`repos/${this.repository}/git/tags/${sha}`);
  }

  branchRef(branch) {
    return jsonRequest(`repos/${this.repository}/git/ref/heads/${encodeURIComponent(branch)}`);
  }

  releaseByTag(tag) {
    return jsonRequest(`repos/${this.repository}/releases/tags/${encodeURIComponent(tag)}`, { allowMissing: true });
  }

  releaseById(id) {
    return jsonRequest(`repos/${this.repository}/releases/${id}`);
  }

  latestRelease() {
    return jsonRequest(`repos/${this.repository}/releases/latest`);
  }

  createDraft(body) {
    return jsonRequest(`repos/${this.repository}/releases`, { method: "POST", body });
  }

  deleteAsset(id) {
    return jsonRequest(`repos/${this.repository}/releases/assets/${id}`, { method: "DELETE" });
  }

  updateRelease(id, body) {
    return jsonRequest(`repos/${this.repository}/releases/${id}`, { method: "PATCH", body });
  }

  async uploadAsset(release, asset) {
    assert.ok(typeof process.env.GH_TOKEN === "string" && process.env.GH_TOKEN !== "", "GH_TOKEN is required.");
    const uploadUrl = assertUploadUrl(release.upload_url, this.repository, release.id);
    uploadUrl.searchParams.set("name", asset.name);
    const args = [
      "api",
      "--method=POST",
      uploadUrl.href,
      "-H", "Accept: application/vnd.github+json",
      "-H", "Content-Type: application/octet-stream",
      "-H", `X-GitHub-Api-Version: ${apiVersion}`,
      "--input", "-",
    ];
    const result = runGitHub(args, asset.bytes);
    if (result.status !== 0) throw commandError(args, result);
    return JSON.parse(result.stdout);
  }
}

export function verifyRemoteSource({ tagRef, tagObject, branchRef, tag, sourceCommit, tagger }) {
  assert.equal(tagRef?.ref, `refs/tags/${tag}`, "GitHub returned a different tag reference.");
  assert.equal(tagRef?.object?.type, "tag", "Stable releases require an annotated tag object.");
  assert.equal(tagObject?.sha, tagRef.object.sha, "The annotated tag object changed during verification.");
  assert.equal(tagObject?.tag, tag, "The annotated tag name differs from the release tag.");
  assert.equal(tagObject?.verification?.verified, true, "The annotated tag signature is not GitHub-verified.");
  assert.equal(tagObject?.tagger?.name, tagger.name, "The annotated tagger name differs from release policy.");
  assert.equal(tagObject?.tagger?.email, tagger.email, "The annotated tagger email differs from release policy.");
  assert.equal(tagObject?.object?.type, "commit", "The annotated tag must point directly to a commit.");
  assert.equal(tagObject?.object?.sha, sourceCommit, "The annotated tag points to a different commit.");
  assert.equal(branchRef?.object?.type, "commit", "The default branch does not resolve to a commit.");
  assert.equal(branchRef?.object?.sha, sourceCommit, "The release commit is not the current default-branch head.");
}

function releaseBody(notes, { tag, sourceCommit, checksumDigest }) {
  return `${notes.trim()}\n\n## Verification\n\n` +
    "This release is built twice from the tagged source and compared byte for byte. " +
    "Every asset is bound by `SHA256SUMS` and GitHub build provenance.\n\n" +
    `<!-- vector-release/v1\ntag=${tag}\nsource=${sourceCommit}\nsha256sums=${checksumDigest}\n-->\n`;
}

function remoteAssets(release) {
  assert.ok(Array.isArray(release?.assets), "GitHub returned an invalid release asset inventory.");
  const ids = new Set();
  const names = new Set();
  return release.assets.map((asset) => {
    assert.ok(Number.isSafeInteger(asset?.id) && asset.id > 0, "GitHub returned an invalid release asset ID.");
    assert.equal(ids.has(asset.id), false, `GitHub returned duplicate asset ID ${asset.id}.`);
    assert.equal(names.has(asset.name), false, `GitHub returned duplicate release asset ${asset.name}.`);
    ids.add(asset.id);
    names.add(asset.name);
    return asset;
  });
}

function verifyReleaseIdentity(release, contract) {
  assert.ok(Number.isSafeInteger(release?.id) && release.id > 0, "GitHub returned an invalid release ID.");
  assert.equal(release.tag_name, contract.tag, "GitHub Release tag differs from the contract.");
  assert.equal(release.name, contract.title, "GitHub Release title differs from the contract.");
  assert.equal(release.body, contract.body, "GitHub Release notes differ from the contract.");
  assert.equal(release.target_commitish, contract.sourceCommit, "GitHub Release target differs from the source commit.");
  assert.equal(release.prerelease, false, "Stable releases must not be prereleases.");
}

function verifyAssets(expected, published) {
  const normalized = remoteAssets(published)
    .map(({ name, size, digest }) => ({ name, size, digest }))
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  const wanted = expected
    .map(({ name, size, digest }) => ({ name, size, digest }))
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  assert.deepEqual(normalized, wanted, "Published release assets, sizes or digests differ from the candidate.");
}

function validateOwnedDraft(release, contract, expected) {
  verifyReleaseIdentity(release, contract);
  assert.equal(release.draft, true, "Refusing to modify a published release.");
  const byName = new Map(expected.map((asset) => [asset.name, asset]));
  for (const asset of remoteAssets(release)) {
    const local = byName.get(asset.name);
    assert.ok(local, `GitHub draft contains a foreign asset: ${asset.name}`);
    assert.equal(asset.size, local.size, `GitHub draft contains a size-mismatched asset: ${asset.name}`);
    if (asset.digest !== null && asset.digest !== undefined) {
      assert.equal(asset.digest, local.digest, `GitHub draft contains a digest-mismatched asset: ${asset.name}`);
    }
  }
}

export function verifyPublishedRelease(release, contract, expected) {
  verifyReleaseIdentity(release, contract);
  assert.equal(release.draft, false, "GitHub Release remained a draft.");
  assert.equal(release.immutable, true, "Published GitHub Release is not immutable.");
  verifyAssets(expected, release);
}

async function verifiedRemoteSource(client, values) {
  const tagRef = await client.tagRef(values.tag);
  const tagObject = await client.tagObject(tagRef?.object?.sha);
  const branchRef = await client.branchRef(values.defaultBranch);
  verifyRemoteSource({
    tagRef,
    tagObject,
    branchRef,
    tag: values.tag,
    sourceCommit: values.sourceCommit,
    tagger: values.tagger,
  });
}

export async function publishReleaseCandidate({
  directory,
  tag,
  repository,
  defaultBranch,
  sourceCommit,
  eventName = process.env.GITHUB_EVENT_NAME,
  refType = process.env.GITHUB_REF_TYPE,
  publicationEnabled = process.env.RELEASE_PUBLICATION_ENABLED,
  client = new GitHubClient(repository),
  pause = (milliseconds) => new Promise((resolvePause) => setTimeout(resolvePause, milliseconds)),
} = {}) {
  assert.match(repository, repositoryPattern, "A valid owner/repository is required.");
  assert.match(defaultBranch, branchPattern, "A valid default branch is required.");
  assert.match(sourceCommit, sourceCommitPattern, "A lowercase 40-character source commit is required.");
  assert.equal(eventName, "push", "Publication is permitted only for a tag push event.");
  assert.equal(refType, "tag", "Publication is permitted only for a tag reference.");
  assert.equal(publicationEnabled, "true", "Release publication is disabled by repository policy.");
  const metadata = await validateReleaseMetadata({ tag });
  assert.match(metadata.version, stableVersionPattern);
  await verifyReleaseCandidate({ directory, sourceCommit, tag });

  const assets = (await releaseAssetManifest(directory)).map((asset) => ({
    ...asset,
  }));
  const checksum = assets.find(({ name }) => name === "SHA256SUMS");
  assert.ok(checksum, "Release candidate is missing SHA256SUMS.");
  const notes = await readFile(resolve(directory, "RELEASE_NOTES.md"), "utf8");
  const contract = {
    body: releaseBody(notes, { tag, sourceCommit, checksumDigest: checksum.digest }),
    sourceCommit,
    tag,
    title: `VECTOR ${metadata.version}`,
  };

  await verifiedRemoteSource(client, { tag, defaultBranch, sourceCommit, tagger: metadata.tagger });
  let release = await client.releaseByTag(tag);
  if (release?.draft === false) {
    verifyPublishedRelease(release, contract, assets);
    const latest = await client.latestRelease();
    assert.equal(latest.id, release.id, "The immutable release is not GitHub's latest release.");
    return release;
  }

  if (release === null || release === undefined) {
    release = await client.createDraft({
      tag_name: tag,
      target_commitish: sourceCommit,
      name: contract.title,
      body: contract.body,
      draft: true,
      prerelease: false,
    });
    release = await client.releaseById(release.id);
  }
  validateOwnedDraft(release, contract, assets);

  for (const asset of remoteAssets(release)) await client.deleteAsset(asset.id);
  release = await client.releaseById(release.id);
  validateOwnedDraft(release, contract, assets);
  assert.equal(release.assets.length, 0, "GitHub draft was not empty before upload.");

  for (const asset of assets) await client.uploadAsset(release, asset);
  release = await client.releaseById(release.id);
  validateOwnedDraft(release, contract, assets);
  verifyAssets(assets, release);

  await verifiedRemoteSource(client, { tag, defaultBranch, sourceCommit, tagger: metadata.tagger });
  try {
    await client.updateRelease(release.id, { draft: false, make_latest: "true" });
  } catch (error) {
    const reconciled = await client.releaseById(release.id);
    if (reconciled?.draft !== false) throw error;
  }

  let published;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    published = await client.releaseById(release.id);
    if (published.draft === false && published.immutable === true) break;
    await pause(2 ** attempt * 250);
  }
  verifyPublishedRelease(published, contract, assets);
  const latest = await client.latestRelease();
  assert.equal(latest.id, published.id, "The immutable release is not GitHub's latest release.");
  await verifiedRemoteSource(client, { tag, defaultBranch, sourceCommit, tagger: metadata.tagger });
  return published;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArguments(process.argv.slice(2));
  const required = ["--directory", "--tag", "--repository", "--default-branch", "--source-commit"];
  for (const key of required) assert.ok(options.get(key), `Missing publisher option: ${key}`);
  const known = new Set(required);
  for (const key of options.keys()) assert.ok(known.has(key), `Unknown publisher option: ${key}`);
  const published = await publishReleaseCandidate({
    directory: options.get("--directory"),
    tag: options.get("--tag"),
    repository: options.get("--repository"),
    defaultBranch: options.get("--default-branch"),
    sourceCommit: options.get("--source-commit"),
  });
  console.log(`VECTOR ${options.get("--tag")} published as immutable release ${published.id}.`);
}
