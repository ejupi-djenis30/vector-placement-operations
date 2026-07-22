import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
export const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const sourceCommitPattern = /^[0-9a-f]{40}$/;

const inventorySchema = "https://ejupilabs.com/schemas/vector/site-inventory/v1";
const releaseSchema = "https://ejupilabs.com/schemas/vector/release-manifest/v1";
const archiveRoot = (version) => `vector-placement-operations-${version}`;

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function assertSafeAssetName(name) {
  assert.equal(typeof name, "string", "Release asset names must be strings.");
  assert.equal(basename(name), name, `Unsafe release asset name: ${name}`);
  assert.match(name, /^[A-Za-z0-9._-]+$/, `Unsupported release asset name: ${name}`);
}

function changelogSection(changelog, version) {
  const escaped = version.replaceAll(".", "\\.");
  const match = changelog.match(new RegExp(
    `^## ${escaped} — (\\d{4}-\\d{2}-\\d{2})\\r?\\n\\r?\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`,
    "m",
  ));
  assert.ok(match, `CHANGELOG.md is missing a ${version} release section.`);
  const lines = match[2].trim().split(/\r?\n/);
  assert.ok(lines.some((line) => line.startsWith("- ")), `CHANGELOG.md ${version} has no release notes.`);
  return { date: match[1], notes: `${match[2].trim()}\n` };
}

export async function validateReleaseMetadata({ tag } = {}) {
  const [packageText, lockText, changelog, license] = await Promise.all([
    readFile(resolve(repositoryRoot, "package.json"), "utf8"),
    readFile(resolve(repositoryRoot, "package-lock.json"), "utf8"),
    readFile(resolve(repositoryRoot, "CHANGELOG.md"), "utf8"),
    readFile(resolve(repositoryRoot, "LICENSE"), "utf8"),
  ]);
  const packageJson = JSON.parse(packageText);
  const packageLock = JSON.parse(lockText);
  const version = packageJson.version;

  assert.match(version, stableVersionPattern, "package.json must declare a stable semantic version.");
  assert.equal(packageLock.version, version, "package-lock.json top-level version is out of sync.");
  assert.equal(packageLock.packages?.[""]?.version, version, "package-lock.json root version is out of sync.");
  assert.equal(packageJson.license, "MIT", "package.json must declare the MIT license.");
  assert.equal(packageLock.packages?.[""]?.license, "MIT", "package-lock.json must declare the MIT license.");
  assert.match(license, /^MIT License\r?\n/, "LICENSE is not the canonical MIT license text.");
  assert.match(license, /Copyright \(c\) 2026 Ejupi Labs and project contributors/, "LICENSE must keep collective attribution.");
  assert.match(changelog, /^## Unreleased\r?\n\r?\n- No unreleased changes\./m, "A release candidate must not carry unreleased changes.");

  const section = changelogSection(changelog, version);
  if (tag !== undefined && tag !== "") {
    assert.equal(tag, `v${version}`, `Tag ${tag} does not match package version ${version}.`);
  }

  return {
    date: section.date,
    name: packageJson.name,
    notes: section.notes,
    version,
  };
}

async function collectFiles(root) {
  const files = [];

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => utf8Compare(left.name, right.name));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const metadata = await lstat(path);
      assert.equal(metadata.isSymbolicLink(), false, `Static release input must not contain symlinks: ${path}`);
      if (metadata.isDirectory()) {
        await visit(path);
      } else {
        assert.equal(metadata.isFile(), true, `Static release input must contain regular files only: ${path}`);
        const relativePath = relative(root, path).split(sep).join("/");
        assert.ok(relativePath !== "" && !relativePath.startsWith("../"), `Unsafe static file path: ${relativePath}`);
        const bytes = await readFile(path);
        files.push({ bytes, path: relativePath });
      }
    }
  }

  await visit(root);
  assert.ok(files.length > 0, "The static site contains no files.");
  return files.sort((left, right) => utf8Compare(left.path, right.path));
}

function writeAscii(buffer, value, offset, length) {
  const bytes = Buffer.from(value, "ascii");
  assert.ok(bytes.length <= length, `Archive field is too long: ${value}`);
  bytes.copy(buffer, offset);
}

function writeOctal(buffer, value, offset, length) {
  const text = value.toString(8).padStart(length - 1, "0");
  assert.ok(text.length < length, `Archive number is too large: ${value}`);
  writeAscii(buffer, `${text}\0`, offset, length);
}

function tarHeader(name, size) {
  assert.ok(Buffer.byteLength(name, "utf8") <= 100, `Tar path exceeds the ustar name field: ${name}`);
  const header = Buffer.alloc(512);
  writeAscii(header, name, 0, 100);
  writeOctal(header, 0o644, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, size, 124, 12);
  writeOctal(header, 0, 136, 12);
  header.fill(0x20, 148, 156);
  writeAscii(header, "0", 156, 1);
  writeAscii(header, "ustar\0", 257, 6);
  writeAscii(header, "00", 263, 2);
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  writeAscii(header, `${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return header;
}

function buildTarGzip(files, version) {
  const chunks = [];
  for (const file of files) {
    const name = `${archiveRoot(version)}/${file.path}`;
    chunks.push(tarHeader(name, file.bytes.length), file.bytes);
    const remainder = file.bytes.length % 512;
    if (remainder !== 0) chunks.push(Buffer.alloc(512 - remainder));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function buildZip(files, version) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(`${archiveRoot(version)}/${file.path}`, "utf8");
    const checksum = crc32(file.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(file.bytes.length, 18);
    local.writeUInt32LE(file.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localChunks.push(local, name, file.bytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(file.bytes.length, 20);
    central.writeUInt32LE(file.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0x81a40000, 38);
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, name);
    offset += local.length + name.length + file.bytes.length;
  }

  const centralDirectory = Buffer.concat(centralChunks);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localChunks, centralDirectory, end]);
}

function inventoryFor(files, version, sourceCommit) {
  return {
    schema: inventorySchema,
    project: "vector-placement-operations",
    version,
    sourceCommit,
    archiveRoot: archiveRoot(version),
    files: files.map(({ bytes, path }) => ({ path, size: bytes.length, sha256: sha256(bytes) })),
  };
}

function sbomFor(version, sourceCommit) {
  const reference = `pkg:npm/vector-placement-operations@${version}`;
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: {
        type: "application",
        "bom-ref": reference,
        name: "vector-placement-operations",
        version,
        licenses: [{ license: { id: "MIT" } }],
        properties: [
          { name: "vector:source-commit", value: sourceCommit },
          { name: "vector:runtime-dependencies", value: "none" },
        ],
      },
    },
    components: [],
    dependencies: [{ ref: reference, dependsOn: [] }],
  };
}

function expectedNames(version) {
  const prefix = `vector-site-${version}`;
  return [
    "RELEASE_NOTES.md",
    "SHA256SUMS",
    "SOURCE_COMMIT",
    `${prefix}.cdx.json`,
    `${prefix}.inventory.json`,
    `${prefix}.tar.gz`,
    `${prefix}.zip`,
    `vector-release-${version}.json`,
  ].sort(utf8Compare);
}

async function writeExclusive(path, bytes) {
  await writeFile(path, bytes, { flag: "wx" });
}

export async function buildReleaseCandidate({ output, sourceCommit, tag } = {}) {
  assert.match(sourceCommit, sourceCommitPattern, "A lowercase 40-character source commit is required.");
  const metadata = await validateReleaseMetadata({ tag });
  const outputDirectory = resolve(output);
  await mkdir(outputDirectory);

  const siteRoot = resolve(repositoryRoot, "site");
  const files = await collectFiles(siteRoot);
  const prefix = `vector-site-${metadata.version}`;
  const assets = new Map([
    [`${prefix}.zip`, buildZip(files, metadata.version)],
    [`${prefix}.tar.gz`, buildTarGzip(files, metadata.version)],
    [`${prefix}.inventory.json`, Buffer.from(stableJson(inventoryFor(files, metadata.version, sourceCommit)))],
    [`${prefix}.cdx.json`, Buffer.from(stableJson(sbomFor(metadata.version, sourceCommit)))],
    ["SOURCE_COMMIT", Buffer.from(`${sourceCommit}\n`)],
    ["RELEASE_NOTES.md", Buffer.from(`# VECTOR ${metadata.version}\n\n${metadata.notes}`)],
  ]);

  const manifest = {
    schema: releaseSchema,
    project: "vector-placement-operations",
    version: metadata.version,
    sourceCommit,
    assets: [...assets]
      .map(([name, bytes]) => ({ name, size: bytes.length, sha256: sha256(bytes) }))
      .sort((left, right) => utf8Compare(left.name, right.name)),
  };
  assets.set(`vector-release-${metadata.version}.json`, Buffer.from(stableJson(manifest)));

  const ordered = [...assets].sort(([left], [right]) => utf8Compare(left, right));
  for (const [name, bytes] of ordered) {
    assertSafeAssetName(name);
    await writeExclusive(resolve(outputDirectory, name), bytes);
  }
  const checksums = ordered.map(([name, bytes]) => `${sha256(bytes)}  ${name}`).join("\n") + "\n";
  await writeExclusive(resolve(outputDirectory, "SHA256SUMS"), checksums);

  await verifyReleaseCandidate({ directory: outputDirectory, sourceCommit, tag });
  return { directory: outputDirectory, version: metadata.version };
}

function parseChecksums(text) {
  assert.ok(text.endsWith("\n") && !text.endsWith("\n\n"), "SHA256SUMS must end with exactly one newline.");
  const rows = text.slice(0, -1).split("\n").map((line) => {
    const match = line.match(/^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/);
    assert.ok(match, `Malformed SHA256SUMS entry: ${line}`);
    return { digest: match[1], name: match[2] };
  });
  const names = rows.map(({ name }) => name);
  assert.deepEqual(names, [...names].sort(utf8Compare), "SHA256SUMS entries are not in canonical UTF-8 order.");
  assert.equal(new Set(names).size, names.length, "SHA256SUMS contains duplicate assets.");
  return rows;
}

function validateInventory(value, expectedFiles, version, sourceCommit) {
  assert.equal(value.schema, inventorySchema);
  assert.equal(value.project, "vector-placement-operations");
  assert.equal(value.version, version);
  assert.equal(value.sourceCommit, sourceCommit);
  assert.equal(value.archiveRoot, archiveRoot(version));
  assert.deepEqual(value.files, inventoryFor(expectedFiles, version, sourceCommit).files);
}

function readTarFiles(bytes) {
  const tar = gunzipSync(bytes);
  const files = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      assert.equal(tar.length - offset, 1024, "Tar archive must end with exactly two zero blocks.");
      assert.ok(tar.subarray(offset).every((byte) => byte === 0), "Tar end blocks contain non-zero data.");
      offset = tar.length;
      break;
    }
    const stored = Number.parseInt(header.toString("ascii", 148, 154), 8);
    const copy = Buffer.from(header);
    copy.fill(0x20, 148, 156);
    assert.equal([...copy].reduce((sum, byte) => sum + byte, 0), stored, "Tar header checksum mismatch.");
    assert.equal(header.toString("ascii", 156, 157), "0", "Tar archive contains a non-file entry.");
    assert.equal(header.toString("ascii", 257, 263), "ustar\0", "Tar entry does not use the ustar format.");
    assert.equal(Number.parseInt(header.toString("ascii", 100, 107), 8), 0o644, "Tar entry mode differs from the contract.");
    assert.equal(Number.parseInt(header.toString("ascii", 108, 115), 8), 0, "Tar entry UID differs from the contract.");
    assert.equal(Number.parseInt(header.toString("ascii", 116, 123), 8), 0, "Tar entry GID differs from the contract.");
    assert.equal(Number.parseInt(header.toString("ascii", 136, 147), 8), 0, "Tar entry timestamp differs from the contract.");
    const name = header.toString("utf8", 0, 100).replace(/\0.*$/, "");
    const size = Number.parseInt(header.toString("ascii", 124, 136).replace(/\0.*$/, "").trim(), 8);
    assert.ok(Number.isSafeInteger(size) && size >= 0, `Invalid tar entry size for ${name}.`);
    const start = offset + 512;
    const end = start + size;
    assert.ok(end <= tar.length, `Truncated tar entry: ${name}`);
    files.push({ path: name, bytes: Buffer.from(tar.subarray(start, end)) });
    const paddedEnd = start + Math.ceil(size / 512) * 512;
    assert.ok(tar.subarray(end, paddedEnd).every((byte) => byte === 0), `Tar padding is non-zero for ${name}.`);
    offset = paddedEnd;
  }
  assert.equal(offset, tar.length, "Tar archive is truncated or missing its end blocks.");
  return files;
}

function readZipFiles(bytes) {
  const files = [];
  const records = [];
  let offset = 0;
  while (offset + 4 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    const localOffset = offset;
    assert.equal(bytes.readUInt16LE(offset + 6), 0x0800, "ZIP entries must use only the UTF-8 flag.");
    assert.equal(bytes.readUInt16LE(offset + 8), 0, "ZIP entries must use deterministic store mode.");
    assert.equal(bytes.readUInt16LE(offset + 10), 0, "ZIP entry time differs from the contract.");
    assert.equal(bytes.readUInt16LE(offset + 12), 0x0021, "ZIP entry date differs from the contract.");
    const checksum = bytes.readUInt32LE(offset + 14);
    const compressed = bytes.readUInt32LE(offset + 18);
    const size = bytes.readUInt32LE(offset + 22);
    assert.equal(compressed, size, "Stored ZIP entry sizes differ.");
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    assert.equal(extraLength, 0, "ZIP entries must not contain extra metadata.");
    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLength;
    const dataEnd = nameEnd + size;
    assert.ok(dataEnd <= bytes.length, "ZIP entry is truncated.");
    const name = bytes.toString("utf8", nameStart, nameEnd);
    const data = Buffer.from(bytes.subarray(nameEnd, dataEnd));
    assert.equal(crc32(data), checksum, `ZIP CRC mismatch for ${name}.`);
    files.push({ path: name, bytes: data });
    records.push({ checksum, localOffset, name, size });
    offset = dataEnd;
  }
  assert.ok(files.length > 0, "ZIP archive contains no files.");
  const centralOffset = offset;
  for (const record of records) {
    assert.ok(offset + 46 <= bytes.length && bytes.readUInt32LE(offset) === 0x02014b50, "ZIP central directory is missing an entry.");
    assert.equal(bytes.readUInt16LE(offset + 4), (3 << 8) | 20, "ZIP creator version differs from the contract.");
    assert.equal(bytes.readUInt16LE(offset + 6), 20, "ZIP extraction version differs from the contract.");
    assert.equal(bytes.readUInt16LE(offset + 8), 0x0800, "ZIP central entry must use only the UTF-8 flag.");
    assert.equal(bytes.readUInt16LE(offset + 10), 0, "ZIP central entry must use store mode.");
    assert.equal(bytes.readUInt16LE(offset + 12), 0);
    assert.equal(bytes.readUInt16LE(offset + 14), 0x0021);
    assert.equal(bytes.readUInt32LE(offset + 16), record.checksum);
    assert.equal(bytes.readUInt32LE(offset + 20), record.size);
    assert.equal(bytes.readUInt32LE(offset + 24), record.size);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    assert.equal(extraLength, 0);
    assert.equal(commentLength, 0);
    assert.equal(bytes.readUInt16LE(offset + 34), 0);
    assert.equal(bytes.readUInt16LE(offset + 36), 0);
    assert.equal(bytes.readUInt32LE(offset + 38), 0x81a40000);
    assert.equal(bytes.readUInt32LE(offset + 42), record.localOffset);
    assert.equal(bytes.toString("utf8", offset + 46, offset + 46 + nameLength), record.name);
    offset += 46 + nameLength;
  }
  const centralSize = offset - centralOffset;
  assert.ok(offset + 22 === bytes.length && bytes.readUInt32LE(offset) === 0x06054b50, "ZIP end record is missing or trailing data is present.");
  assert.equal(bytes.readUInt16LE(offset + 4), 0);
  assert.equal(bytes.readUInt16LE(offset + 6), 0);
  assert.equal(bytes.readUInt16LE(offset + 8), records.length);
  assert.equal(bytes.readUInt16LE(offset + 10), records.length);
  assert.equal(bytes.readUInt32LE(offset + 12), centralSize);
  assert.equal(bytes.readUInt32LE(offset + 16), centralOffset);
  assert.equal(bytes.readUInt16LE(offset + 20), 0);
  return files;
}

function archiveInventory(files, version) {
  const prefix = `${archiveRoot(version)}/`;
  const seen = new Set();
  const inventory = files.map(({ path, bytes }) => {
    assert.ok(path.startsWith(prefix), `Archive entry is outside ${prefix}: ${path}`);
    const relativePath = path.slice(prefix.length);
    assert.ok(
      relativePath !== "" && !relativePath.split("/").includes("..") && !relativePath.startsWith("/"),
      `Unsafe archive entry: ${path}`,
    );
    assert.equal(seen.has(relativePath), false, `Archive contains duplicate entry: ${relativePath}`);
    seen.add(relativePath);
    return { path: relativePath, size: bytes.length, sha256: sha256(bytes) };
  });
  assert.deepEqual(inventory.map(({ path }) => path), [...seen].sort(utf8Compare), "Archive entries are not in canonical order.");
  return inventory;
}

export async function verifyReleaseCandidate({ directory, sourceCommit, tag } = {}) {
  const metadata = await validateReleaseMetadata({ tag });
  const root = resolve(directory);
  const entries = await readdir(root, { withFileTypes: true });
  assert.ok(entries.every((entry) => entry.isFile()), "Release candidate must contain regular files only.");
  const names = entries.map(({ name }) => name).sort(utf8Compare);
  assert.deepEqual(names, expectedNames(metadata.version), "Release candidate asset inventory differs from the contract.");

  const sourceText = await readFile(resolve(root, "SOURCE_COMMIT"), "utf8");
  assert.match(sourceText, /^[0-9a-f]{40}\n$/, "SOURCE_COMMIT is malformed.");
  const candidateCommit = sourceText.trim();
  if (sourceCommit !== undefined) assert.equal(candidateCommit, sourceCommit, "Release candidate source commit differs from the expected commit.");
  assert.match(candidateCommit, sourceCommitPattern);

  const checksumRows = parseChecksums(await readFile(resolve(root, "SHA256SUMS"), "utf8"));
  assert.deepEqual(
    checksumRows.map(({ name }) => name),
    names.filter((name) => name !== "SHA256SUMS"),
    "SHA256SUMS must bind every non-manifest asset exactly once.",
  );
  for (const row of checksumRows) {
    assert.equal(sha256(await readFile(resolve(root, row.name))), row.digest, `Checksum mismatch for ${row.name}.`);
  }

  const siteFiles = await collectFiles(resolve(repositoryRoot, "site"));
  const prefix = `vector-site-${metadata.version}`;
  const inventory = JSON.parse(await readFile(resolve(root, `${prefix}.inventory.json`), "utf8"));
  validateInventory(inventory, siteFiles, metadata.version, candidateCommit);

  const tarInventory = archiveInventory(readTarFiles(await readFile(resolve(root, `${prefix}.tar.gz`)), metadata.version), metadata.version);
  const zipInventory = archiveInventory(readZipFiles(await readFile(resolve(root, `${prefix}.zip`)), metadata.version), metadata.version);
  assert.deepEqual(tarInventory, inventory.files, "The tar.gz content differs from the site inventory.");
  assert.deepEqual(zipInventory, inventory.files, "The ZIP content differs from the site inventory.");

  const sbom = JSON.parse(await readFile(resolve(root, `${prefix}.cdx.json`), "utf8"));
  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.equal(sbom.specVersion, "1.6");
  assert.equal(sbom.metadata?.component?.name, "vector-placement-operations");
  assert.equal(sbom.metadata?.component?.version, metadata.version);
  assert.deepEqual(sbom.components, [], "Static VECTOR releases must not claim runtime dependencies.");
  assert.deepEqual(sbom.dependencies, [{ ref: `pkg:npm/vector-placement-operations@${metadata.version}`, dependsOn: [] }]);

  assert.equal(
    await readFile(resolve(root, "RELEASE_NOTES.md"), "utf8"),
    `# VECTOR ${metadata.version}\n\n${metadata.notes}`,
    "RELEASE_NOTES.md differs from CHANGELOG.md.",
  );

  const manifest = JSON.parse(await readFile(resolve(root, `vector-release-${metadata.version}.json`), "utf8"));
  assert.equal(manifest.schema, releaseSchema);
  assert.equal(manifest.project, "vector-placement-operations");
  assert.equal(manifest.version, metadata.version);
  assert.equal(manifest.sourceCommit, candidateCommit);
  const manifestRows = checksumRows.filter(({ name }) => !name.startsWith("vector-release-"));
  const expectedManifestAssets = [];
  for (const { name, digest } of manifestRows) {
    expectedManifestAssets.push({ name, size: (await lstat(resolve(root, name))).size, sha256: digest });
  }
  expectedManifestAssets.sort((left, right) => utf8Compare(left.name, right.name));
  assert.deepEqual(manifest.assets, expectedManifestAssets, "Release manifest asset metadata differs from the candidate.");

  return { sourceCommit: candidateCommit, version: metadata.version };
}

export async function compareReleaseCandidates({ directory, otherDirectory, sourceCommit, tag } = {}) {
  const first = await verifyReleaseCandidate({ directory, sourceCommit, tag });
  const second = await verifyReleaseCandidate({ directory: otherDirectory, sourceCommit, tag });
  assert.deepEqual(second, first);
  const names = (await readdir(resolve(directory))).sort(utf8Compare);
  assert.deepEqual((await readdir(resolve(otherDirectory))).sort(utf8Compare), names);
  for (const name of names) {
    assert.deepEqual(
      await readFile(resolve(otherDirectory, name)),
      await readFile(resolve(directory, name)),
      `Independent release builds differ: ${name}`,
    );
  }
  return first;
}

export async function releaseAssetManifest(directory) {
  const entries = await readdir(resolve(directory), { withFileTypes: true });
  assert.ok(entries.length > 0 && entries.every((entry) => entry.isFile()), "Release assets must be regular files.");
  const assets = [];
  for (const entry of entries.sort((left, right) => utf8Compare(left.name, right.name))) {
    assertSafeAssetName(entry.name);
    const bytes = await readFile(resolve(directory, entry.name));
    assets.push({ name: entry.name, size: bytes.length, digest: `sha256:${sha256(bytes)}` });
  }
  return assets;
}
