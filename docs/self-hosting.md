# Self-hosting VECTOR

VECTOR runs as a single Node.js service backed by SQLite. This guide describes the supported
Docker Compose shape: one application process, one persistent data volume and an HTTPS reverse
proxy controlled by the institution.

Self-hosting transfers operational responsibility to the institution. Before importing real
records, decide who owns access reviews, backups, incident response, retention and privacy
requests. Read [privacy and retention](privacy-and-retention.md) before launch.

## Deployment shape

- Run exactly one VECTOR application replica against a database.
- Keep `/var/lib/vector` on a local, persistent filesystem. Do not put the SQLite database on NFS,
  a shared container volume or object storage.
- Terminate TLS at a maintained reverse proxy and forward traffic to the loopback port published by
  Compose.
- Restrict access at the network layer when VECTOR is intended for staff or a private school
  network.
- Send backups to storage outside the application host.

VECTOR is a small single-instance application, not a high-availability cluster. Adding replicas
that write to the same SQLite file is unsupported.

## Prerequisites

- A maintained Linux host with Docker Engine and Docker Compose v2
- DNS for the chosen public origin
- A TLS certificate and reverse proxy
- A backup destination separate from the VECTOR data volume

Deploy a reviewed release or an exact source revision. Avoid running an unreviewed moving branch in
production.

## Configure the first installation

Copy the example environment file and restrict it to the host administrator:

```sh
cp .env.example .env
chmod 600 .env
```

Edit `.env` before starting:

1. Set `VECTOR_ORIGIN` to the exact external HTTPS origin, including a non-standard port when used.
2. Replace every bootstrap identity value with the institution's own details.
3. Set `VECTOR_BOOTSTRAP_TIME_ZONE` to the school's IANA time zone, such as `Europe/Zurich`.
   VECTOR uses the school's local date when it validates time entries and check-ins.
4. Set `VECTOR_BOOTSTRAP_ADMIN_PASSWORD` to a long, unique initial password. The repository does
   not ship a production password.
5. Leave `VECTOR_SEED_SYNTHETIC=false` for a real installation.
6. Keep `VECTOR_COOKIE_SECURE=true` when users connect over HTTPS.
7. Set `VECTOR_TRUST_PROXY=1` only for the documented topology with exactly one controlled reverse
   proxy between the browser and VECTOR. Set it to `false` when there is no proxy. Do not use the
   unrestricted boolean value `true`.

`compose.yaml` deliberately binds port 4173 to `127.0.0.1`. Change `VECTOR_BIND_ADDRESS` only when
the host firewall and network design require a different interface. Publishing VECTOR directly to
an untrusted network without TLS is not a supported production setup.

## Start and verify

Validate the resolved Compose configuration before it can create resources:

```sh
docker compose config
docker compose build --pull
docker compose up -d
docker compose ps
```

The container runs as the unprivileged `node` user. Its root filesystem is read-only; only the
named volume mounted at `/var/lib/vector` is writable. On startup VECTOR opens the database, applies
pending migrations and bootstraps the first school only when the database is empty.

Check readiness from the host:

```sh
curl --fail --silent --show-error http://127.0.0.1:4173/api/health/ready
docker compose exec vector npm run doctor
```

Inspect startup failures with `docker compose logs vector`. Do not post logs publicly until names,
email addresses, identifiers, tokens and record content have been removed.

The bootstrap password is temporary. On first sign-in VECTOR blocks every workspace route until the
administrator replaces it with a different password of at least 14 characters. The change revokes
all active sessions, including the session that changed it. Sign in again with the replacement,
then remove `VECTOR_BOOTSTRAP_ADMIN_PASSWORD` from `.env` and recreate the service with
`docker compose up -d`. Existing credentials are stored as a password hash in the database; the
bootstrap secret is not needed for later starts.

## Run directly

Docker Compose is the supported production shape, but the same release can run directly for a
controlled evaluation or a host service manager:

```sh
cp .env.example .env
chmod 0600 .env
npm ci --omit=dev --no-audit --no-fund
npm start
```

`npm start` uses Node's built-in `--env-file-if-exists=.env` support; no shell export step is
required. Set `VECTOR_DB_PATH` to a private local directory owned by the service account and protect
that directory with mode `0700` on POSIX or a restricted NTFS ACL on Windows. Run one process only
and use the same HTTPS proxy, backup, retention and upgrade controls described for Compose.

## Reverse proxy

The proxy must:

- serve only HTTPS to users and redirect plain HTTP;
- preserve the original host and scheme;
- set forwarding headers itself instead of trusting client-supplied values;
- enforce suitable request and idle timeouts;
- restrict access to the local VECTOR upstream; and
- omit query strings from access logs, analytics and error reports; and
- receive security updates and certificate renewals independently of VECTOR.

Set `VECTOR_ORIGIN` to the URL users actually open. An origin mismatch can break cookie and
cross-site request protections. Do not place VECTOR at a path prefix unless the current release
explicitly supports that topology.

The `query=` parameter can contain a student, staff member or host name. Pagination cursors are
encrypted and authenticated, but they are still operational request material. Configure the proxy
to log the path only and redact or omit the entire query string, including `query=` and `cursor=`.
VECTOR's own error log uses `request.path` and does not include the query string; a proxy's default
combined-access format may still record the full request URI.

VECTOR applies an application-wide limit of 600 requests per minute for each resolved client
address, plus a stricter limit for unsuccessful sign-in attempts. Keep `VECTOR_TRUST_PROXY`
bounded to the exact number of controlled proxy hops so clients cannot choose the address used by
these limits. A reverse proxy may add a separate edge limit, but it should not replace the
application controls.

## Environment reference

| Variable | Purpose | Production guidance |
| --- | --- | --- |
| `VECTOR_ORIGIN` | Canonical browser origin | Required; use the external HTTPS origin |
| `VECTOR_HOST` | Listen address inside the runtime | Compose pins this to `0.0.0.0` |
| `VECTOR_PORT` | Listen port inside the runtime | Compose pins this to `4173` |
| `VECTOR_DB_PATH` | SQLite database path | Compose pins this to `/var/lib/vector/vector.sqlite` |
| `VECTOR_BOOTSTRAP_SCHOOL_NAME` | First school name | Used only for an empty database |
| `VECTOR_BOOTSTRAP_SCHOOL_SLUG` | First school identifier | Choose a stable, non-sensitive slug |
| `VECTOR_BOOTSTRAP_TIME_ZONE` | First school's IANA time zone | Set the school's operational zone, for example `Europe/Zurich` |
| `VECTOR_BOOTSTRAP_ADMIN_EMAIL` | First administrator login | Use an institution-controlled address |
| `VECTOR_BOOTSTRAP_ADMIN_NAME` | First administrator display name | Used only for an empty database |
| `VECTOR_BOOTSTRAP_ADMIN_PASSWORD` | First administrator password | Required for an empty database; no default |
| `VECTOR_COOKIE_SECURE` | Marks session cookies HTTPS-only | Keep `true` for production |
| `VECTOR_TRUST_PROXY` | Number of trusted proxy hops | Use `1` for one controlled proxy; otherwise `false` |
| `VECTOR_SEED_SYNTHETIC` | Adds fictional evaluation records | Keep `false` with real records |
| `VECTOR_BODY_LIMIT` | Maximum request body in bytes | Increase only for a documented import need |
| `VECTOR_SESSION_HOURS` | Session lifetime | Choose from the institution's access policy |
| `VECTOR_LOG_LEVEL` | Runtime log level | Use `info` normally; avoid verbose production logs |

`VECTOR_BIND_ADDRESS` and `VECTOR_PUBLISHED_PORT` are Compose-only host settings, not application
configuration.

## Administrators

Create later administrators through the audited management command. The password is read from the
temporary `VECTOR_NEW_USER_PASSWORD` environment variable; it is never a command-line argument and
must not be added to `.env`.

On Bash, use a subshell so the variable disappears even when the command fails:

```sh
(
  read -r -s -p "New administrator password: " VECTOR_NEW_USER_PASSWORD
  printf "\n"
  export VECTOR_NEW_USER_PASSWORD
  trap 'unset VECTOR_NEW_USER_PASSWORD' EXIT
  docker compose exec --env VECTOR_NEW_USER_PASSWORD vector npm run admin:create -- \
    --email admin@example.org \
    --name "School administrator" \
    --role school_admin \
    --scope school
)
```

On PowerShell 7, mask the prompt and remove the process environment value in `finally`:

```powershell
$env:VECTOR_NEW_USER_PASSWORD = Read-Host "New administrator password" -MaskInput
try {
  docker compose exec --env VECTOR_NEW_USER_PASSWORD vector `
    npm run admin:create -- `
    --email admin@example.org `
    --name "School administrator" `
    --role school_admin `
    --scope school
} finally {
  Remove-Item Env:VECTOR_NEW_USER_PASSWORD -ErrorAction SilentlyContinue
}
```

The secret exists in the environment of the short-lived management process while it runs, so
privileged host and container administrators must still be trusted. The command prints identifiers
and role information, never the password.

Use named accounts. Do not share one administrator login between staff members. Grant the least
role and data scope required, review active accounts regularly and disable access when a person no
longer needs it.

## Branding and logo concurrency

Branding reads return a positive `revision` and the same value as a strong `ETag`. JSON branding
updates submit that revision in the request body. Raw PNG logo mutations use the HTTP precondition:

```text
PUT /api/branding/logo
Content-Type: image/png
If-Match: "3"

DELETE /api/branding/logo
If-Match: "4"
```

The upload response contains `width`, `height` and the new `revision`; deletion returns the new
`revision`. Missing `If-Match` returns `428 precondition_required`, a weak or malformed value returns
`400 invalid_precondition`, and a stale revision returns `409 conflict`. Refresh branding before
retrying a conflict. This prevents one administrator's palette or logo change from silently
overwriting another administrator's work.

## Upgrades

1. Read the release notes and compatibility notes.
2. Create and inspect a fresh backup as described in
   [backup and restore](backup-restore.md).
3. Build the intended release with `docker compose build --pull`.
4. Recreate the service with `docker compose up -d`.
5. Wait for `/api/health/ready`, then run `docker compose exec vector npm run doctor`.
6. Perform a short authenticated check of search, a record view and the audit trail.

Migrations run on startup and are forward-only. A code rollback may require restoring the
pre-upgrade database with the matching earlier application release.

## Routine operations

- Monitor container health, disk space, restart count and backup results.
- Keep the host, Docker, proxy and VECTOR release patched.
- Test restoration on an isolated system, not only backup creation.
- Review administrator access and retention jobs on a defined schedule.
- When retention reports `cleanupPending`, schedule the inspected-backup, service-stop and
  `npm run db:compact -- --confirm-maintenance` sequence in
  [backup and restore](backup-restore.md).
- Keep the data volume out of general-purpose host snapshots unless those snapshots are encrypted,
  access-controlled and application-consistent.

See [support](../SUPPORT.md) for safe reporting and [security](../SECURITY.md) for vulnerability
reports.
