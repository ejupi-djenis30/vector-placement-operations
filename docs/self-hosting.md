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

1. Keep `NODE_ENV=production` exactly as shipped. Only the exact values `development`, `test` and
   `production` are accepted; aliases, different casing and surrounding whitespace fail startup.
2. Set `VECTOR_ORIGIN` to the exact external HTTPS origin, including a non-standard port when used.
3. Fill every blank bootstrap identity value with the institution's own details.
4. Set `VECTOR_BOOTSTRAP_TIME_ZONE` to the school's IANA time zone, such as `Europe/Zurich`.
   VECTOR uses the school's local date when it validates time entries and check-ins.
5. Set `VECTOR_BOOTSTRAP_ADMIN_PASSWORD` to a long, unique initial password for the one-shot
   initialization. The repository does not ship a production password.
6. Leave `VECTOR_SEED_SYNTHETIC=false` for a real installation.
7. Keep `VECTOR_COOKIE_SECURE=true`; production rejects insecure cookies.
8. Set `VECTOR_SESSION_HOURS` and `VECTOR_SESSION_IDLE_MINUTES` to the institution's access
   policy. The inactivity timeout must be at least 5 minutes and no longer than the absolute
   lifetime converted to minutes.
9. Keep the shipped `VECTOR_TRUST_PROXY=false` default until the controlled reverse proxy is
   configured. Set `VECTOR_TRUST_PROXY=1` only for the documented topology with exactly one
   controlled proxy between the browser and VECTOR. Do not use the unrestricted boolean value
   `true`.

When a production bootstrap password is present, VECTOR requires the school name, slug, IANA time
zone, administrator email and administrator name to be set explicitly. Startup fails before
creating a database if any identity field is missing or blank; development and test defaults are
never allowed to become a production institution silently.

`compose.yaml` deliberately binds port 4173 to `127.0.0.1`. Change `VECTOR_BIND_ADDRESS` only when
the host firewall and network design require a different interface. Port 4173 is the loopback
upstream used by the host-level TLS proxy, not a production browser URL; `VECTOR_ORIGIN` remains
the external HTTPS browser URL. Production startup rejects both an HTTP origin and
`VECTOR_COOKIE_SECURE=false`. Publishing VECTOR directly to an untrusted network without TLS is
not a supported production setup.

## Start and verify

Validate the resolved Compose configuration and build the reviewed image:

```sh
docker compose config
docker compose build --pull
```

For a new installation, run the application once without publishing a port:

```sh
docker compose run --rm --no-deps vector
```

After creating the school and initial administrator, production initialization deliberately exits
non-zero with an instruction to remove `VECTOR_BOOTSTRAP_ADMIN_PASSWORD` and restart. It never
opens the HTTP listener while that secret is present. Treat any other error as a failed
initialization and investigate it before continuing.

Remove `VECTOR_BOOTSTRAP_ADMIN_PASSWORD` from `.env`, then start the service:

```sh
docker compose up -d
docker compose ps
```

The container runs as the unprivileged `node` user. Application code and dependencies remain
root-owned and non-writable by that process even without the runtime read-only control. Its root
filesystem is read-only, `/tmp` is a bounded `nodev`, `noexec`, `nosuid` tmpfs, and only the named
volume mounted at `/var/lib/vector` is writable. On startup VECTOR opens the database, applies
pending migrations and refuses an empty database unless the explicit initialization secret is
present. An existing installation must not retain that secret: VECTOR fails closed instead of
silently creating a replacement installation when a data volume is missing.

Check readiness from the host:

```sh
curl --fail --silent --show-error http://127.0.0.1:4173/api/health/ready
docker compose exec vector node scripts/doctor.mjs
```

Inspect startup failures with `docker compose logs vector`. Do not post logs publicly until names,
email addresses, identifiers, tokens and record content have been removed.

The bootstrap password is temporary. On first sign-in VECTOR blocks every workspace route until the
administrator replaces it with a different password of at least 14 characters. The change revokes
all active sessions, including the session that changed it. Sign in again with the replacement.
Existing credentials are stored as a password hash in the database; the bootstrap secret has
already been removed and is not needed for later starts.

## Run directly

Docker Compose is the supported production shape, but the same release can run directly for a
controlled evaluation or a host service manager. Use a maintained runtime in VECTOR's tested LTS
range: Node.js 22.23.1 or newer within major 22, or Node.js 24.18.0 or newer within major 24.
Current odd-numbered, end-of-life and not-yet-LTS major versions are rejected at startup.

```sh
cp .env.example .env
chmod 0600 .env
npm ci --omit=dev --no-audit --no-fund
npm start
```

`npm start` uses Node's built-in `--env-file-if-exists=.env` support; no shell export step is
required. On a new production database, the first `npm start` initializes the school and exits
non-zero as described above. Remove `VECTOR_BOOTSTRAP_ADMIN_PASSWORD` from `.env` and run
`npm start` again to serve users. Set `VECTOR_DB_PATH` to a private local directory owned by the
service account and protect that directory with mode `0700` on POSIX or a restricted NTFS ACL on
Windows. Run one process only and use the same HTTPS proxy, backup, retention and upgrade controls
described for Compose.

Startup resolves the live database to an ordinary filesystem path and fails closed when any path
component is a symbolic link or junction, when an unsafe writable ancestor can replace the private
directory, or when the main database or its `-wal`, `-shm` and `-journal` companions are not regular,
single-link files. Existing POSIX storage must already be owned by the service account with directory
mode `0700` and file mode `0600`; VECTOR does not silently change an existing shared directory.
Persistent connections must confirm that SQLite entered WAL mode, and startup disables SQLite's
trusted-schema setting before migrations or application queries use schema objects.
Use a local filesystem that exposes stable file identities. Do not place the live database on NFS,
SMB, a userspace filesystem or a shared host directory.

These checks protect the boundary between the dedicated service identity and other host users. Node
and `better-sqlite3` open SQLite by pathname rather than accepting a pre-opened `openat2` descriptor,
so no application-level check can eliminate a malicious swap performed by another process running as
the same service identity. Do not run plugins, shell jobs or unrelated applications under that account.
Host `root`/Administrator is part of the trust boundary and can bypass user-space path checks.
On Windows, VECTOR rejects symbolic-link/junction, hard-link, UNC, device-namespace, reserved-device
and alternate-data-stream aliases, but Node cannot prove a private NTFS ACL; the operator must
restrict the database directory to the VECTOR service identity and approved backup operators. A drive
letter backed by a network redirector is not distinguishable through the portable Node filesystem API
and remains unsupported.
On POSIX, remove any extended ACL that grants another identity access even when the numeric mode is
`0700` or `0600`; the portable Node filesystem API cannot audit platform-specific ACL policy.

## Reverse proxy

The proxy must:

- serve only HTTPS to users and redirect plain HTTP;
- preserve the original host and scheme;
- set forwarding headers itself instead of trusting client-supplied values;
- enforce suitable request and idle timeouts;
- restrict access to the local VECTOR upstream;
- preserve VECTOR's security headers and `Vary: Accept-Encoding`;
- omit query strings from access logs, analytics and error reports; and
- receive security updates and certificate renewals independently of VECTOR.

Set `VECTOR_ORIGIN` to the URL users actually open. An origin mismatch can break cookie and
cross-site request protections. Production rejects every plain-HTTP origin, including
`http://127.0.0.1` and `http://localhost`; the internal listener may remain HTTP only behind the
same host's controlled TLS proxy. Session cookies are HTTPS-only and scoped to `/api`. Do not place
VECTOR at a path prefix unless the current release explicitly supports that topology.

The `query=` parameter can contain a student, staff member or host name. Pagination cursors are
encrypted and authenticated, but they are still operational request material. Configure the proxy
to log the path only and redact or omit the entire query string, including `query=` and `cursor=`.
VECTOR's own error log records a static route template such as `/api/placements/:id`, never the
actual record identifier or query string; requests that fail before route matching use an anonymous
`/api/<unmatched>` marker. A proxy's default combined-access format may still record the full
request URI.

VECTOR compresses compressible static application assets larger than 1 KiB when the browser sends
a supported `Accept-Encoding`. API responses remain uncompressed so authenticated response sizes
do not become an avoidable cross-request signal. Do not strip `Content-Encoding` or
`Vary: Accept-Encoding` at the proxy without correctly replacing the upstream representation.
Static filenames are stable across releases, so VECTOR sends `Cache-Control: no-cache` and an
entity tag: browsers may retain a copy, but must revalidate it before reuse. Preserve that policy
to prevent an old module or stylesheet from being mixed with a newly deployed workspace.

VECTOR applies an API-wide limit of 600 requests per minute for each resolved client address, plus
a stricter limit for unsuccessful sign-in attempts. Static application assets do not consume this
API quota. The two exact, query-free, credential-free and body-free health probes do not consume it
either, so unrelated client traffic cannot make an orchestrator misclassify a healthy process.
Health requests carrying a query, cookies, authorization, CSRF or body headers are accounted
normally, and neither health route resolves a session. Unsafe requests that carry an explicitly
disallowed `Origin` are rejected before body decompression, JSON parsing and application rate
accounting; they do not displace legitimate clients from the API or sign-in budgets. Requests with
a matching or missing Origin remain bounded by the wide ceiling, and the authenticated gate still
rejects a missing Origin before any mutation.
Keep `VECTOR_TRUST_PROXY` bounded to the exact number of controlled proxy hops so clients cannot
choose the address used by these limits. The standard single-process deployment keeps its counter
in memory. Preserve a separate edge request limit at the reverse proxy for volumetric traffic,
including the inexpensive early Origin rejections; it complements rather than replaces the
application controls.

## Health and observability

`GET /api/health/live` confirms that the HTTP process can answer. `GET /api/health/ready` also
checks the exact migration history, readable database state and single-school invariant; use
readiness for traffic admission and deployment checks. Neither endpoint returns record content.
After `SIGINT` or `SIGTERM`, readiness and new application work fail with
`503 service_draining` while liveness remains observable until the listener closes. This makes the
Docker healthcheck fail closed during termination without misreporting the still-running drain as
a crashed process. Existing responses may finish inside the configured grace period; an absolute
deadline then closes remaining connections before SQLite is released.
Run `docker compose exec vector node scripts/doctor.mjs` for deeper operator diagnostics after
startup, upgrade and restore. A direct host installation can use `npm run doctor`.

VECTOR returns `X-Request-ID` on HTTP responses. Its own error records contain the request ID,
method, path and stable error code, but omit the query string and record values. Configure the
controlled proxy to record status, duration, path and `X-Request-ID` while applying the query
redaction rule above. A write that exhausts the bounded SQLite lock wait returns
`503 database_busy` with `Retry-After: 1`; an occasional caller may retry, but repeated responses
usually indicate a second VECTOR writer, an overlapping maintenance operation or unhealthy
storage latency and require operator investigation. Alert on sustained readiness failure,
repeated `5xx` responses, forced shutdown warnings, disk pressure and failed backup or restore
jobs; do not wait for a user report.

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
| `VECTOR_BOOTSTRAP_ADMIN_PASSWORD` | First administrator password | Required only for one-shot initialization; remove before serving users |
| `VECTOR_COOKIE_SECURE` | Marks `/api` session cookies HTTPS-only | Mandatory `true` in production |
| `VECTOR_TRUST_PROXY` | Number of trusted proxy hops | Use `1` for one controlled proxy; otherwise `false` |
| `VECTOR_SEED_SYNTHETIC` | Adds fictional evaluation records | Keep `false` with real records |
| `VECTOR_BODY_LIMIT` | Maximum parsed JSON or CSV body in bytes | Increase only for a documented import need; PNG logos keep a separate 256 KiB limit |
| `VECTOR_BACKUP_MAX_BYTES` | Maximum backup snapshot or restore input in bytes | Default and maximum `10737418240` (10 GiB); lower it to a reviewed bound above the expected database size |
| `VECTOR_REQUEST_TIMEOUT_MS` | Maximum time for a complete HTTP request | Default `30000`; choose `1000`–`120000` ms and keep the proxy timeout slightly higher |
| `VECTOR_HEADERS_TIMEOUT_MS` | Maximum time to receive HTTP headers | Default `10000`; choose `1000`–`60000` ms and never exceed `VECTOR_REQUEST_TIMEOUT_MS` |
| `VECTOR_KEEP_ALIVE_TIMEOUT_MS` | Idle time before an HTTP keep-alive socket closes | Default `5000`; choose `1000`–`60000` ms and keep the proxy upstream keep-alive compatible |
| `VECTOR_MAX_REQUESTS_PER_SOCKET` | Requests accepted on one persistent connection | Default `1000`; choose `1`–`10000` to bound long-lived connections |
| `VECTOR_SHUTDOWN_GRACE_MS` | Drain time before remaining connections are closed | Default `10000`; choose `1000`–`60000` ms and keep Compose's stop grace longer |
| `VECTOR_SESSION_HOURS` | Absolute session lifetime | Choose from the institution's access policy |
| `VECTOR_SESSION_IDLE_MINUTES` | Server-enforced inactivity timeout | At least `5` and no longer than `VECTOR_SESSION_HOURS × 60`; default `45` |
| `VECTOR_LOG_LEVEL` | Runtime log level | Use `info` normally; avoid verbose production logs |

VECTOR retains at most ten active sessions for one user. A successful eleventh login removes the
least recently used valid session under the same database transaction before creating the new one;
expired and idle sessions are removed first. This fixed bound prevents repeated valid logins from
growing the session table until the absolute lifetime, and an evicted browser returns to sign-in on
its next API request. Signing in again from a browser also revokes the session token that browser
presented before issuing its replacement, so the superseded bearer token cannot be replayed.

`VECTOR_BIND_ADDRESS` and `VECTOR_PUBLISHED_PORT` are Compose-only host settings, not application
configuration.

The HTTP defaults are intentionally finite so a slow client cannot hold a request or connection
open indefinitely and a service restart cannot wait forever. Keep
`VECTOR_HEADERS_TIMEOUT_MS <= VECTOR_REQUEST_TIMEOUT_MS`. Set the reverse proxy's upstream request
timeout slightly above VECTOR's request timeout so the application can return or terminate first,
and keep `stop_grace_period` longer than `VECTOR_SHUTDOWN_GRACE_MS` so the container runtime does
not kill the process before its database handle closes. Raising a limit should follow a measured,
documented import or network need rather than becoming a general workaround.

Node rejects an overlarge header block at its byte limit, and VECTOR rejects more than 100 header
fields with `431` instead of silently ignoring the excess. On shutdown, new connections stop
immediately. Requests that arrive on a connection already participating in the drain are rejected
with `503 service_draining`, `Connection: close` and `Retry-After: 1`; active responses that began
before the signal may drain within `VECTOR_SHUTDOWN_GRACE_MS`. Any response still stalled at the
boundary is closed before the SQLite handle is released. Repeated signals share the same shutdown
operation, so listener, timers and database state are closed at most once.

VECTOR ends a session at whichever limit is reached first. Each authenticated API request advances
the inactivity timestamp without ever extending the absolute expiry. When either limit is reached,
the server removes the database session and instructs the browser to discard its session cookie;
the user must sign in again.

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
  docker compose exec --env VECTOR_NEW_USER_PASSWORD vector node scripts/create-admin.mjs \
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
    node scripts/create-admin.mjs `
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

The settings view and audit actor filter deliberately use the complete account directory rather
than a partial page. To keep that response and its browser rendering bounded, an installation may
retain at most 500 user accounts, including inactive accounts kept for historical attribution. The
API and management command reject the next account with `user_limit_reached`, and a database
trigger enforces the same limit across processes. If unsupported external database changes have
already exceeded the boundary, the directory fails closed with `user_capacity_exceeded` instead of
materialising an unbounded response. Restore a supported backup and reconcile identity lifecycle
records before reopening the service; do not remove attributed accounts directly.

## Cohort coverage planning

The **Coverage** view gives administrators, coordinators and read-only viewers a school-wide
planning board before every student has a placement record. Select an active cohort and placement
period to classify its active students as:

- **Unplaced** — no non-cancelled placement intersects the selected period;
- **Placed** — one or more placements cover the period without overlapping each other; or
- **Conflict** — at least two of the student's placements overlap.

Cancelled placements and records entirely outside the period do not count. Consecutive placements
that do not share a calendar date are not conflicts. Administrators and coordinators can start a
new placement from an uncovered row; VECTOR preselects the student, period and period dates, while
the operator still chooses the host, programme and other accountable details.

Coverage intentionally excludes tutor accounts because it must enumerate students who have not yet
been assigned to any tutor. Use a viewer account when someone needs school-wide planning visibility
without mutation rights.

## Daily attention inbox

The **Attention** view is the operational starting point for coordinators and tutors. It derives a
bounded, paged queue from the records already in VECTOR: evidence that is overdue or due within 14
school-calendar days, pending hour reviews, placement start/end transitions, placements waiting for
close-out and imminent placements without an assigned school tutor.

The queue is not a background notification service and sends no email. It is recalculated on each
request using the school's configured IANA time zone. Every item stays inside the signed-in user's
placement scope; assigned tutors cannot discover another tutor's records. Opening an item takes the
user to the source placement, where completing the underlying review, assignment, status change or
evidence update removes the item.

Check-in next actions, document due dates/references and relevant placement contacts are visible in
the placement record. Keep those fields concise and operational: they are placement data covered by
the same access, backup, export, retention and incident-response responsibilities as the rest of the
record.

## Placement programmes

Administrators and coordinators manage programme policies from **Programmes** in the workspace.
Each programme has a stable uppercase code used by CSV imports, plus one or more immutable versions.
A published version defines:

- the target hours suggested for a new placement;
- the minimum number of non-voided check-ins required for completion; and
- each required evidence item with the document states that satisfy it.

Publishing a new version does not rewrite existing placements. A placement keeps its selected
version so its readiness decision remains explainable later. Programme metadata and availability
may be edited, but published rules cannot be changed or deleted.

VECTOR 3.1 automatically creates `VECTOR_DEFAULT` during upgrade. It reproduces the 3.0 completion
rules and is assigned to every existing placement. Create and review institution-specific
programmes before deactivating that compatibility programme. Deactivation prevents new selection;
it does not hide historical records.

Changing the programme on a newly created placement is permitted only before staff record time,
check-ins or evidence. VECTOR then replaces only the untouched requirement placeholders; it never
removes manually added documents. As soon as any real activity exists, the policy is frozen so the
version shown in the placement remains the version under which that work was recorded. Use a new
placement or a governed operational correction instead of rewriting historical rules.

The workspace exposes the complete immutable version history for each programme. A school may
configure up to 200 programmes, with up to 100 published versions per programme. VECTOR enforces
both limits on writes and returns the complete collection within those bounds, rather than silently
truncating programme or version records.

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
3. Confirm `VECTOR_BOOTSTRAP_ADMIN_PASSWORD` is absent from `.env`.
4. Build the intended release with `docker compose build --pull`.
5. Recreate the service with `docker compose up -d`.
6. Wait for `/api/health/ready`, then run
   `docker compose exec vector node scripts/doctor.mjs`.
7. Perform a short authenticated check of search, a record view and the audit trail.

Migrations run on startup and are forward-only. A code rollback may require restoring the
pre-upgrade database with the matching earlier application release.

The 3.1 migration adds programme policies and backfills existing placements and recognised
training-agreement, attendance-log and evaluation records. Take and inspect a backup before the
upgrade. After startup, verify that `VECTOR_DEFAULT` appears under **Programmes** and open one
existing placement to confirm its programme and readiness information.

VECTOR 3.3 adds a forward-only collection-index migration for stable student and host pagination
at larger data volumes. It also introduces the derived **Coverage** view and defaults
`VECTOR_SESSION_IDLE_MINUTES` to `45` when the variable is absent. Before upgrading, confirm that
the chosen inactivity limit is no greater than `VECTOR_SESSION_HOURS × 60`; after startup, verify
student and host exports, a Coverage query and re-authentication after the institution's configured
idle interval in a non-production rehearsal.

## Routine operations

- Monitor container health, disk space, restart count and backup results.
- Correlate proxy `5xx` entries with VECTOR's `X-Request-ID`, and investigate forced-shutdown
  warnings rather than treating them as routine restarts.
- Keep the host, Docker, proxy and VECTOR release patched.
- Test restoration on an isolated system, not only backup creation.
- Review administrator access and retention jobs on a defined schedule.
- When retention reports `cleanupPending`, schedule the inspected-backup, service-stop and
  `node scripts/compact.mjs --confirm-maintenance` sequence in
  [backup and restore](backup-restore.md).
- Keep the data volume out of general-purpose host snapshots unless those snapshots are encrypted,
  access-controlled and application-consistent.

See [support](../SUPPORT.md) for safe reporting and [security](../SECURITY.md) for vulnerability
reports.

## Per-placement activity capacity

Placement detail responses are deliberately bounded to **500 time entries**, **200 check-ins** and
**200 document records**, including superseded evidence. Records use deterministic indexed ordering
and VECTOR reads one row beyond each limit so an unsupported database is rejected explicitly rather
than silently truncated.

Normal writes count and insert under the same SQLite immediate transaction. Database triggers apply
the same limits to time entries, check-ins and documents, while document replacement checks capacity
before changing the preserved evidence. Placement CSV import creates only new placements and seeds
at most the programme schema's 30 required-document placeholders; that seed is checked in the same
atomic import transaction.

At a limit, the API returns `placement_activity_capacity_reached` and leaves both the collection and
audit trail unchanged. Preserve the placement and create a continuation record before adding more
activity. If an upgraded or externally modified database already exceeds a limit, detail and
readiness operations return `placement_activity_capacity_exceeded`. Take and inspect a backup, stop
the service and investigate the out-of-policy rows before repair; VECTOR does not hide or
automatically delete them.

## Synthetic scale rehearsal

Run `npm run audit:scale` before a capacity-sensitive release or infrastructure change. The command
creates a deterministic fictional school with 5,000 students, 500 hosts, 5,500 placements and
related evidence, activity and audit records. It starts VECTOR in production mode and reports
descriptive endpoint latency, response size, concurrent requests, import statement counts, query
plans, memory use and SQLite integrity.

The command accepts no database path and always removes its temporary database. Never substitute an
operational volume. Results vary by host load and storage, so compare observations from equivalent
machines and do not treat the reported timing or memory values as portable pass/fail thresholds.
