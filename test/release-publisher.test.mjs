import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { buildReleaseCandidate } from "../scripts/release-lib.mjs";
import { GitHubClient, publishReleaseCandidate } from "../scripts/publish-release.mjs";

const COMMIT = "b".repeat(40);
const TAG_SHA = "c".repeat(40);
const UNAPPROVED_TAGGER_EMAIL = ["info", "ejupilabs.com"].join("@");

class FakeGitHub {
  constructor({
    verified = true,
    immutable = true,
    taggerName = "Djenis Ejupi",
    taggerEmail = "69587167+ejupi-djenis30@users.noreply.github.com",
  } = {}) {
    this.verified = verified;
    this.publishedImmutable = immutable;
    this.taggerName = taggerName;
    this.taggerEmail = taggerEmail;
    this.release = null;
    this.latest = null;
    this.mutations = [];
    this.nextAssetId = 100;
  }

  async tagRef(tag) {
    return { ref: `refs/tags/${tag}`, object: { type: "tag", sha: TAG_SHA } };
  }

  async tagObject() {
    return {
      sha: TAG_SHA,
      tag: "v2.0.1",
      tagger: { name: this.taggerName, email: this.taggerEmail },
      verification: { verified: this.verified },
      object: { type: "commit", sha: COMMIT },
    };
  }

  async branchRef() {
    return { object: { type: "commit", sha: COMMIT } };
  }

  async releaseByTag() {
    return this.release;
  }

  async releaseById(id) {
    assert.equal(id, 7);
    return this.release;
  }

  async latestRelease() {
    return this.latest;
  }

  async createDraft(body) {
    this.mutations.push("create");
    this.release = {
      id: 7,
      tag_name: body.tag_name,
      target_commitish: body.target_commitish,
      name: body.name,
      body: body.body,
      draft: true,
      prerelease: false,
      immutable: false,
      assets: [],
      upload_url: "https://uploads.github.com/repos/ejupi-djenis30/vector-placement-operations/releases/7/assets{?name,label}",
    };
    return this.release;
  }

  async deleteAsset(id) {
    this.mutations.push(`delete:${id}`);
    this.release.assets = this.release.assets.filter((asset) => asset.id !== id);
  }

  async uploadAsset(_release, asset) {
    this.mutations.push(`upload:${asset.name}`);
    this.release.assets.push({
      id: this.nextAssetId++,
      name: asset.name,
      size: asset.size,
      digest: asset.digest,
    });
  }

  async updateRelease() {
    this.mutations.push("publish");
    this.release.draft = false;
    this.release.immutable = this.publishedImmutable;
    this.latest = this.release;
    return this.release;
  }
}

async function fixture(context) {
  const root = await mkdtemp(resolve(tmpdir(), "vector-publisher-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = resolve(root, "release");
  await buildReleaseCandidate({ output: directory, sourceCommit: COMMIT, tag: "v2.0.1" });
  return directory;
}

function publish(directory, client) {
  return publishReleaseCandidate({
    directory,
    tag: "v2.0.1",
    repository: "ejupi-djenis30/vector-placement-operations",
    defaultBranch: "main",
    sourceCommit: COMMIT,
    eventName: "push",
    refType: "tag",
    publicationEnabled: "true",
    client,
    pause: async () => {},
  });
}

test("GitHub client uploads a file with the release command's length-aware transport", async (context) => {
  const previousToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "test-token";
  context.after(() => {
    if (previousToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousToken;
  });
  const calls = [];
  const client = new GitHubClient(
    "ejupi-djenis30/vector-placement-operations",
    (args, input) => {
      calls.push({ args, input });
      return { status: 0, stderr: "", stdout: "" };
    },
  );
  const path = resolve("release", "VECTOR.zip");

  await client.uploadAsset(
    {
      id: 7,
      tag_name: "v2.0.1",
      upload_url:
        "https://uploads.github.com/repos/ejupi-djenis30/vector-placement-operations/releases/7/assets{?name,label}",
    },
    { name: "VECTOR.zip", path },
  );

  assert.deepEqual(calls, [{
    args: [
      "release",
      "upload",
      "v2.0.1",
      path,
      "--repo",
      "ejupi-djenis30/vector-placement-operations",
    ],
    input: undefined,
  }]);
});

test("publisher promotes only the verified candidate and is idempotent afterward", async (context) => {
  const directory = await fixture(context);
  const client = new FakeGitHub();
  const release = await publish(directory, client);
  assert.equal(release.draft, false);
  assert.equal(release.immutable, true);
  assert.equal(release.assets.length, 8);
  assert.deepEqual(client.mutations.slice(0, 1), ["create"]);
  assert.equal(client.mutations.at(-1), "publish");
  assert.equal(client.mutations.some((mutation) => mutation.startsWith("delete:")), false);

  const count = client.mutations.length;
  await publish(directory, client);
  assert.equal(client.mutations.length, count, "An existing exact immutable release must not be mutated.");
});

test("publisher resumes an exact partial draft without deleting verified assets", async (context) => {
  const directory = await fixture(context);
  const client = new FakeGitHub();
  await publish(directory, client);
  client.release.draft = true;
  client.release.immutable = false;
  client.release.assets = client.release.assets.slice(0, 3);
  client.latest = null;
  client.mutations = [];

  const release = await publish(directory, client);

  assert.equal(release.draft, false);
  assert.equal(release.immutable, true);
  assert.equal(release.assets.length, 8);
  assert.equal(client.mutations.filter((mutation) => mutation.startsWith("upload:")).length, 5);
  assert.equal(client.mutations.some((mutation) => mutation.startsWith("delete:")), false);
  assert.equal(client.mutations.at(-1), "publish");
});

test("publisher rejects a digest-mismatched partial draft before mutation", async (context) => {
  const directory = await fixture(context);
  const client = new FakeGitHub();
  await publish(directory, client);
  client.release.draft = true;
  client.release.immutable = false;
  client.release.assets = client.release.assets.slice(0, 1);
  client.release.assets[0].digest = `sha256:${"0".repeat(64)}`;
  client.latest = null;
  client.mutations = [];

  await assert.rejects(() => publish(directory, client), /digest-mismatched asset/);
  assert.deepEqual(client.mutations, []);
});

test("publisher rejects an unverified tag before any mutation", async (context) => {
  const directory = await fixture(context);
  const client = new FakeGitHub({ verified: false });
  await assert.rejects(() => publish(directory, client), /signature is not GitHub-verified/);
  assert.deepEqual(client.mutations, []);
});

test("publisher rejects a GitHub-verified tagger outside release policy before mutation", async (context) => {
  const directory = await fixture(context);
  const client = new FakeGitHub({
    taggerEmail: UNAPPROVED_TAGGER_EMAIL,
  });
  await assert.rejects(() => publish(directory, client), /tagger email differs from release policy/);
  assert.deepEqual(client.mutations, []);
});

test("publisher refuses a foreign draft", async (context) => {
  const directory = await fixture(context);
  const client = new FakeGitHub();
  client.release = {
    id: 7,
    tag_name: "v2.0.1",
    target_commitish: COMMIT,
    name: "Foreign draft",
    body: "Unrelated body",
    draft: true,
    prerelease: false,
    immutable: false,
    assets: [],
  };
  await assert.rejects(() => publish(directory, client), /title differs from the contract/);
  assert.deepEqual(client.mutations, []);
});

test("publisher fails closed when GitHub does not make the release immutable", async (context) => {
  const directory = await fixture(context);
  const client = new FakeGitHub({ immutable: false });
  await assert.rejects(() => publish(directory, client), /not immutable/);
  assert.equal(client.release.draft, false, "The irreversible GitHub state must be reported accurately.");
});

test("publisher rejects non-tag and disabled publication contexts before GitHub access", async (context) => {
  const directory = await fixture(context);
  const client = new FakeGitHub();
  await assert.rejects(
    () => publishReleaseCandidate({
      directory,
      tag: "v2.0.1",
      repository: "ejupi-djenis30/vector-placement-operations",
      defaultBranch: "main",
      sourceCommit: COMMIT,
      eventName: "workflow_dispatch",
      refType: "branch",
      publicationEnabled: "false",
      client,
    }),
    /tag push event/,
  );
  assert.deepEqual(client.mutations, []);
});
