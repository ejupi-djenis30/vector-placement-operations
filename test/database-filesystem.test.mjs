import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { afterEach, test } from "node:test";
import { openDatabase, openExistingDatabase } from "../server/db.mjs";
import { startTestApp } from "../test-support/server-test-helper.mjs";

const roots = new Set();

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function temporaryRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "vector-database-filesystem-"));
  roots.add(root);
  return root;
}

function writePrivateFile(file, content = "filesystem-boundary-probe") {
  writeFileSync(file, content, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(file, 0o600);
}

function createDatabase(file) {
  const db = openDatabase(file);
  db.close();
}

test("live SQLite storage is created inside a private directory with regular single-link files", () => {
  const root = temporaryRoot();
  const directory = path.join(root, "private-data");
  const databasePath = path.join(directory, "vector.sqlite");
  const db = openDatabase(databasePath);
  try {
    assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(db.pragma("trusted_schema", { simple: true }), 0);
    for (const file of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      const stats = lstatSync(file);
      assert.equal(stats.isFile(), true, file);
      assert.equal(stats.isSymbolicLink(), false, file);
      assert.equal(stats.nlink, 1, file);
      if (process.platform !== "win32") {
        assert.equal(stats.uid, process.getuid(), file);
        assert.equal(stats.mode & 0o777, 0o600, file);
      }
    }
    if (process.platform !== "win32") {
      const directoryStats = lstatSync(directory);
      assert.equal(directoryStats.uid, process.getuid());
      assert.equal(directoryStats.mode & 0o777, 0o700);
    }
  } finally {
    db.close();
  }
});

test("in-memory databases disable trusted schema without pretending to support WAL", () => {
  const db = openDatabase(":memory:");
  try {
    assert.equal(db.pragma("journal_mode", { simple: true }), "memory");
    assert.equal(db.pragma("trusted_schema", { simple: true }), 0);
  } finally {
    db.close();
  }
});

test("database paths reject symbolic-link and junction components", (context) => {
  const root = temporaryRoot();
  const target = path.join(root, "target.sqlite");
  const alias = path.join(root, "alias.sqlite");
  const marker = "must-not-be-opened-as-sqlite";
  writePrivateFile(target, marker);
  try {
    symlinkSync(target, alias, "file");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) {
      context.skip(`File symlink probe is unavailable (${error.code}).`);
      return;
    }
    throw error;
  }
  assert.throws(() => openDatabase(alias), /symbolic links or junctions/i);
  assert.equal(readFileSync(target, "utf8"), marker);

  const realDirectory = path.join(root, "real-directory");
  const directoryAlias = path.join(root, "directory-alias");
  mkdirSync(realDirectory, { mode: 0o700 });
  symlinkSync(
    realDirectory,
    directoryAlias,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(
    () => openDatabase(path.join(directoryAlias, "vector.sqlite")),
    /symbolic links or junctions/i,
  );
});

test("Windows database paths reject network, device and alternate-stream aliases", (context) => {
  if (process.platform !== "win32") {
    context.skip("Windows path namespaces are unavailable on POSIX.");
    return;
  }
  const root = temporaryRoot();
  const rejectedPaths = [
    [String.raw`\\server\share\vector.sqlite`, /local Windows drive/i],
    [String.raw`\\?\C:\vector.sqlite`, /local Windows drive/i],
    [path.join(root, "NUL.sqlite"), /reserved Windows device name/i],
    [path.join(root, "NUL .sqlite"), /reserved Windows device name/i],
    [path.join(root, "vector.sqlite:stream"), /alternate data stream/i],
    [path.join(root, "vector.sqlite."), /space or dot on Windows/i],
  ];
  for (const [databasePath, expectedError] of rejectedPaths) {
    assert.throws(() => openDatabase(databasePath), expectedError, databasePath);
  }
});

test("database paths reject hard links and non-regular filesystem objects", () => {
  const root = temporaryRoot();
  const target = path.join(root, "target.sqlite");
  const alias = path.join(root, "hardlink.sqlite");
  const directoryAlias = path.join(root, "directory.sqlite");
  const marker = "must-not-be-opened-through-a-hard-link";
  writePrivateFile(target, marker);
  linkSync(target, alias);
  assert.throws(() => openDatabase(alias), /must not be hard-linked/i);
  assert.equal(readFileSync(target, "utf8"), marker);

  mkdirSync(directoryAlias, { mode: 0o700 });
  assert.throws(() => openDatabase(directoryAlias), /must be a regular file/i);
});

test("maintenance opens inherit the live alias boundary without creating missing storage", () => {
  const root = temporaryRoot();
  const target = path.join(root, "target.sqlite");
  const alias = path.join(root, "maintenance-hardlink.sqlite");
  createDatabase(target);
  linkSync(target, alias);
  assert.throws(
    () => openExistingDatabase(alias, { readonly: true }),
    /must not be hard-linked/i,
  );

  const missingParent = path.join(root, "must-not-be-created");
  assert.throws(
    () => openExistingDatabase(path.join(missingParent, "missing.sqlite")),
    /does not exist/i,
  );
  assert.equal(existsSync(missingParent), false);
});

test("POSIX database paths reject socket-backed special files", async (context) => {
  if (process.platform === "win32") {
    context.skip("Filesystem-backed Unix sockets are unavailable on Windows.");
    return;
  }
  const root = temporaryRoot();
  const socketPath = path.join(root, "database.socket");
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    assert.throws(() => openDatabase(socketPath), /must be a regular file/i);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("existing POSIX database directories and files must already be private", (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX ownership and mode bits are unavailable on Windows.");
    return;
  }
  const root = temporaryRoot();
  const sharedDirectory = path.join(root, "shared-data");
  mkdirSync(sharedDirectory, { mode: 0o750 });
  chmodSync(sharedDirectory, 0o750);
  assert.throws(
    () => openDatabase(path.join(sharedDirectory, "vector.sqlite")),
    /owned by the current user and private \(mode 0700\)/i,
  );
  assert.equal(lstatSync(sharedDirectory).mode & 0o777, 0o750);

  const nonWritableDirectory = path.join(root, "non-writable-data");
  mkdirSync(nonWritableDirectory, { mode: 0o700 });
  chmodSync(nonWritableDirectory, 0o500);
  assert.throws(
    () => openDatabase(path.join(nonWritableDirectory, "vector.sqlite")),
    /owned by the current user and private \(mode 0700\)/i,
  );

  const writableAncestor = path.join(root, "writable-ancestor");
  const privateChild = path.join(writableAncestor, "private-child");
  mkdirSync(privateChild, { recursive: true, mode: 0o700 });
  chmodSync(writableAncestor, 0o770);
  chmodSync(privateChild, 0o700);
  assert.throws(
    () => openDatabase(path.join(privateChild, "vector.sqlite")),
    /ancestor must not be writable by other users/i,
  );

  const databasePath = path.join(root, "open.sqlite");
  writePrivateFile(databasePath, "not-a-database");
  chmodSync(databasePath, 0o640);
  assert.throws(
    () => openDatabase(databasePath),
    /owned by the current user and private \(mode 0600\)/i,
  );
  assert.equal(lstatSync(databasePath).mode & 0o777, 0o640);
  chmodSync(databasePath, 0o700);
  assert.throws(
    () => openDatabase(databasePath),
    /owned by the current user and private \(mode 0600\)/i,
  );
  assert.equal(lstatSync(databasePath).mode & 0o777, 0o700);
});

test("pre-positioned SQLite companions reject symlink and hard-link aliases", (context) => {
  const root = temporaryRoot();
  const databasePath = path.join(root, "vector.sqlite");
  createDatabase(databasePath);
  const target = path.join(root, "companion-target");
  writePrivateFile(target);
  linkSync(target, `${databasePath}-wal`);
  assert.throws(() => openDatabase(databasePath), /must not be hard-linked/i);
  rmSync(`${databasePath}-wal`);

  try {
    symlinkSync(target, `${databasePath}-shm`, "file");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) {
      context.diagnostic(`Companion symlink probe is unavailable (${error.code}).`);
      return;
    }
    throw error;
  }
  assert.throws(
    () => openDatabase(databasePath),
    /symbolic links or junctions/i,
  );
});

test("orphan SQLite companions fail before a new main database is created", () => {
  const root = temporaryRoot();
  const databasePath = path.join(root, "vector.sqlite");
  writePrivateFile(`${databasePath}-wal`, "orphan-wal");
  assert.throws(
    () => openDatabase(databasePath),
    /must not have pre-existing SQLite companion files/i,
  );
  assert.equal(existsSync(databasePath), false);
});

test("application startup inherits the live database alias boundary", async () => {
  const root = temporaryRoot();
  const target = path.join(root, "target.sqlite");
  const alias = path.join(root, "startup-hardlink.sqlite");
  const marker = "startup-must-not-open-this-hard-link";
  writePrivateFile(target, marker);
  linkSync(target, alias);
  await assert.rejects(
    startTestApp({ databasePath: alias }),
    /must not be hard-linked/i,
  );
  assert.equal(readFileSync(target, "utf8"), marker);
});
