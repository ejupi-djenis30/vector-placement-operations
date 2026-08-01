# Backup and restore

The live SQLite database contains the institution's VECTOR records, configuration, password hashes,
sessions and audit history. VECTOR removes active session rows from the backup snapshot so a
restored installation requires users to sign in again. The remaining snapshot is still sensitive
production data even when its filename or storage location appears harmless.

## Backup principles

- Use VECTOR's backup command while the service is running. It uses SQLite's online backup
  mechanism to create a consistent snapshot.
- Do not copy `vector.sqlite` on its own while VECTOR is running. SQLite uses write-ahead logging,
  so a live file copy can omit committed data or produce an unusable snapshot.
- Move completed backups off the application volume and off the host.
- Encrypt backup storage, restrict access, record backup failures and set a retention schedule.
- Inspect every backup and test representative restores regularly.

Host or hypervisor snapshots are not a substitute unless the platform guarantees an
application-consistent SQLite snapshot.

## Create an online backup

Choose a unique output filename on the persistent volume:

```sh
docker compose exec vector node scripts/backup.mjs \
  --output /var/lib/vector/vector-backup-YYYYMMDD-HHMMSS.sqlite
```

Inspect it before copying it elsewhere:

```sh
docker compose exec vector node scripts/inspect-backup.mjs \
  --file /var/lib/vector/vector-backup-YYYYMMDD-HHMMSS.sqlite
```

The inspection command runs SQLite's full, index-aware integrity check, verifies foreign keys, the
exact migration history and the migration-owned tables, indexes and triggers, and reports backup
metadata without printing record content. This schema comparison prevents a replaced snapshot and
freshly recomputed sidecar from hiding a removed safety trigger or an added executable schema
object. Startup and readiness apply the same migration/schema identity check to the live database.
A successful process exit is required before the file is accepted as a backup.
`VECTOR_BACKUP_MAX_BYTES` sets a shared byte ceiling for backup creation, inspection and restore.
The default and maximum is 10 GiB; choose a lower reviewed value above the largest expected
database. Inspection and restore reject an oversized input before hashing it or opening it with
SQLite.

The backup command creates two files: the SQLite snapshot and a
`vector-backup-YYYYMMDD-HHMMSS.sqlite.manifest.json` sidecar containing its checksum and inspection
metadata, including the VECTOR application version, migration identity and table counts. Keep,
transfer and retain them as one backup set. Inspection and restore fail when the manifest is
missing, belongs to a different supported build or does not match the snapshot. A published backup
is a self-contained SQLite file: inspection and restore reject an adjacent `-wal`, `-shm` or
`-journal` companion instead of letting unmanifested SQLite state influence verification. They also
verify the SQLite header is the canonical rollback-journal snapshot produced by the backup command,
rather than opening a WAL-mode main file that could depend on or create unmanifested companions.

VECTOR synchronizes each published file and its parent directory on POSIX systems, but a filesystem
cannot publish the snapshot and manifest as one transaction. A host crash between those two
publications can therefore leave a snapshot without its manifest; treat it as an incomplete orphan,
never reconstruct a manifest by hand. Preserve it only if incident analysis requires it, otherwise
remove it under the approved procedure and rerun the backup with a new unique filename. Apply the
same rule to a manifest without its snapshot. The commands never overwrite either member of an
existing pair.

The command builds and sanitizes a temporary snapshot before publishing the pair. Allow enough free
space for the live database, its WAL, the temporary snapshot and `VACUUM` working space. If final
temporary-file cleanup fails after a restore or manifest was linked into place, VECTOR attempts to
remove the exact target it just published and exits non-zero. Treat any such result as a failed job,
inspect the private directory for an orphan and never continue from an uninspected file.
The selected snapshot and manifest names must also stay distinct from the live database and its
reserved `-wal`, `-shm` and `-journal` companion paths; the backup command rejects any overlap even
when the relevant companion does not currently exist.

Backup, inspection and restore reject symbolic-link/junction components, hard-linked or non-regular
SQLite files and unsafe main-database companions. Use the canonical private directory and the
single-link file itself rather than an alias. Live backup inspection and snapshot creation remain
bound to the same guarded SQLite connection. On Windows the commands also reject device namespaces,
reserved DOS device names, trailing-dot or trailing-space aliases and NTFS alternate data streams.

The checksum detects accidental corruption or an incomplete backup set. It does not prove
authenticity against an attacker who can replace both the snapshot and its manifest. Protect the
backup destination with separate access controls, immutable retention or an institution-approved
signature mechanism.

Copy the verified pair out of the named volume. On a POSIX host, prepare a private staging
directory, copy both files and inspect the transferred copy through a read-only bind mount:

```sh
install -d -m 0700 /srv/vector-backups/staging
docker compose cp \
  vector:/var/lib/vector/vector-backup-YYYYMMDD-HHMMSS.sqlite \
  /srv/vector-backups/staging/vector-backup-YYYYMMDD-HHMMSS.sqlite
docker compose cp \
  vector:/var/lib/vector/vector-backup-YYYYMMDD-HHMMSS.sqlite.manifest.json \
  /srv/vector-backups/staging/vector-backup-YYYYMMDD-HHMMSS.sqlite.manifest.json
chmod 0600 /srv/vector-backups/staging/vector-backup-YYYYMMDD-HHMMSS.sqlite*
docker compose run --rm --no-deps \
  --volume /srv/vector-backups/staging:/restore-source:ro \
  vector node scripts/inspect-backup.mjs \
  --file /restore-source/vector-backup-YYYYMMDD-HHMMSS.sqlite
```

On Windows, use an NTFS directory dedicated to VECTOR. Replace the example drive with an approved
location:

```powershell
$vectorBackupDir = "D:\VECTOR\backup-staging"
New-Item -ItemType Directory -Force -Path $vectorBackupDir | Out-Null
$vectorBackupAccount = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
icacls.exe $vectorBackupDir /inheritance:r
icacls.exe $vectorBackupDir /grant:r "${vectorBackupAccount}:(OI)(CI)F"
docker compose cp `
  vector:/var/lib/vector/vector-backup-YYYYMMDD-HHMMSS.sqlite `
  "$vectorBackupDir\vector-backup-YYYYMMDD-HHMMSS.sqlite"
docker compose cp `
  vector:/var/lib/vector/vector-backup-YYYYMMDD-HHMMSS.sqlite.manifest.json `
  "$vectorBackupDir\vector-backup-YYYYMMDD-HHMMSS.sqlite.manifest.json"
$vectorBackupMount = (Resolve-Path $vectorBackupDir).Path
docker compose run --rm --no-deps `
  --volume "${vectorBackupMount}:/restore-source:ro" `
  vector node scripts/inspect-backup.mjs `
  --file /restore-source/vector-backup-YYYYMMDD-HHMMSS.sqlite
```

Restrict the final backup destination as well as the staging directory. POSIX directories should be
mode `0700` and backup files mode `0600`; on Windows, remove inherited ACLs and grant access only to
the backup service identity and approved recovery operators. VECTOR also rejects a POSIX backup
destination below an ancestor owned by another non-root identity or writable by other users without
the sticky bit, because that ancestor could replace an otherwise private output directory.

Two `docker compose cp` calls are not an atomic transfer. Treat the snapshot and manifest as
incomplete until both arrive and the post-transfer inspection succeeds. Then move the verified pair
to the institution's protected backup system and remove both working copies from the application
volume under the approved procedure. Do not keep the only backup beside the live database.

## Schedule backups

VECTOR does not include a scheduler. Run the same `db:backup` and `db:inspect-backup` commands from
a host timer or the institution's job runner. The operator must:

1. create a unique destination;
2. stop the job if backup or inspection fails;
3. transfer the verified snapshot and manifest to protected storage;
4. confirm the transfer before removing the working copy; and
5. emit an alert that does not include record content.

Choose frequency and retention from the institution's recovery objectives and record-retention
policy. A daily backup may be inadequate when staff enter time-sensitive placement data throughout
the day.

## Restore runbook

Restoration replaces operational data. Use a maintenance window and keep the original files until
the restored installation has been verified.

1. Confirm the selected pair's source, timestamp, application version and custody history.
2. Transfer both files into a protected staging directory and inspect that transferred pair again
   through a read-only bind mount.
3. Stop the production service so no process can write to its named volume:

   ```sh
   docker compose stop vector
   ```

4. Preserve the current `vector.sqlite` and every companion that exists: `vector.sqlite-wal`,
   `vector.sqlite-shm` and `vector.sqlite-journal`. The stopped original named volume is one rollback
   copy; export the existing files to separately protected storage as a second rollback set.
5. Restore into a new Compose project, which gives the candidate an empty, separate named volume.
   Keep the inspected backup directory read-only. Use a unique project name and keep it in the
   operating record:

   ```sh
   docker compose -p vector-recovery-YYYYMMDD run --rm --no-deps \
     --volume /srv/vector-backups/staging:/restore-source:ro \
     vector node scripts/restore.mjs \
     --file /restore-source/vector-backup-YYYYMMDD-HHMMSS.sqlite \
     --confirm-empty
   ```

   On Windows, use the resolved mount from the transfer example:

   ```powershell
   docker compose -p vector-recovery-YYYYMMDD run --rm --no-deps `
     --volume "${vectorBackupMount}:/restore-source:ro" `
     vector node scripts/restore.mjs `
     --file /restore-source/vector-backup-YYYYMMDD-HHMMSS.sqlite `
     --confirm-empty
   ```

6. Start only the recovery project:

   ```sh
   docker compose -p vector-recovery-YYYYMMDD up -d
   ```

7. Wait for `/api/health/ready` and run:

   ```sh
   docker compose -p vector-recovery-YYYYMMDD exec vector node scripts/doctor.mjs
   ```

8. Sign in with a named administrator and verify representative records, expected audit history,
   the release version and the external HTTPS origin.
9. Update the service runbook so every later Compose command uses the accepted project name. Keep
   the stopped original project and exported rollback set until the institution accepts the
   restore. To roll back before acceptance, stop the recovery project and restart the original
   project; do not write into both volumes.
10. Dispose of the rejected or superseded volume and rollback files only after formal acceptance and
    under the same rules as any other production backup.

`--confirm-empty` is an intentional guard, not an instruction to delete data. If the target is not
empty, stop and resolve the unexpected state before retrying. Restore refuses to start when the
target database or its `-wal`, `-shm` or `-journal` companion exists. After the atomic copy, it
verifies the destination against the manifest before reporting success.

A truncated manifest, a structurally corrupt snapshot or any post-copy verification failure exits
non-zero. Restore removes only the destination file it created and never overwrites pre-existing
target state. Preserve the rejected pair for incident analysis, choose a different empty recovery
volume and inspect the next candidate before retrying.

## Reclaim deleted space

Ordinary deletion does not guarantee immediate physical removal from SQLite pages, WAL, backups,
host snapshots or storage media. VECTOR backup creation removes sessions, enables secure deletion
for the snapshot and vacuums that copy. The live database needs a separate maintenance window when
retention reports `cleanupPending` or the operator needs to reclaim unused pages.

Create and inspect a fresh backup first. Then stop every VECTOR process and compact the live named
volume:

```sh
docker compose stop vector
docker compose run --rm --no-deps vector \
  node scripts/compact.mjs --confirm-maintenance
docker compose start vector
docker compose exec vector node scripts/doctor.mjs
```

The confirmation flag states that an inspected backup exists and downtime has been approved. The
command refuses a busy database, enables `secure_delete`, truncates WAL, runs `VACUUM` and checks the
final checkpoint. Compaction and doctor use the same existing-file guard as the server, rejecting
symbolic-link/junction, hard-link, non-regular and unsafe companion aliases before maintenance or a
writability probe begins. Compaction binds integrity inspection and mutation to that one connection.
It does not reach historical backups, exported files, host snapshots or storage-controller
remanence.

## Disaster recovery

Rebuild the application from the exact reviewed release, recreate the persistent volume and restore
the inspected backup. Reapply environment configuration from the institution's secret and
configuration store, not from a backup of an administrator's shell history.

Recovery is complete only when:

- readiness and `node scripts/doctor.mjs` pass;
- an authorized operator can sign in;
- representative records and audit events are present;
- the external HTTPS origin works with secure cookies; and
- a new post-recovery backup can be created and inspected.

Document the recovery time and any lost records. If personal data may have been exposed or lost,
follow the institution's incident process and obtain legal or privacy guidance where required.
