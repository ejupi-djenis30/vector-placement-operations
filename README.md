<div align="center">
  <img src="site/assets/vector-lockup.svg" width="440" alt="VECTOR — Placement Operations" />

  # Every placement, one clear picture.

  VECTOR turns synthetic placement records into a focused operations board. Search the cohort, filter by status, review progress and move milestones forward without sending data to a server.

  [Open VECTOR](https://ejupi-djenis30.github.io/vector-placement-operations/) · [Inspect the data model](site/model.mjs)
</div>

## What you can do

- Search by student, host or supervisor.
- Filter placements by their current status.
- Review cohort metrics and individual progress.
- Advance a milestone and keep the change between browser sessions.
- Reset the workspace to its original fictional dataset.

## Product boundaries

- The public app includes fictional people and fictional organisations only.
- Changes stay in the browser's local storage and can be reset at any time.
- No account system, database or analytics service is connected.
- The status and hour calculations are covered by Node.js tests.

## Run locally

```bash
npm ci --ignore-scripts
npm run check
node scripts/serve-site.mjs
```

Then open `http://127.0.0.1:4173/vector-placement-operations/`. The local path deliberately
matches GitHub Pages, so absolute-path regressions fail before deployment.

Run the browser suite against the same local-only server:

```bash
npx --no-install playwright install chromium
npm run test:e2e
```

## Project background

VECTOR began as a 2023 academic collaboration. This edition keeps the original product problem and rebuilds the application around fictional records, a browser-only data model and a deliberately small attack surface. The collaborators approved publication of this reconstructed edition.

## Deployment

GitHub Pages publishes the contents of `site/` after the test and validation suite passes on `main`.

Live app: [ejupi-djenis30.github.io/vector-placement-operations](https://ejupi-djenis30.github.io/vector-placement-operations/)

## Verified releases

Each stable release contains the complete static site as deterministic `.zip` and `.tar.gz`
archives. The release also includes a file inventory, a CycloneDX SBOM, source-commit evidence and
SHA-256 checksums. GitHub build-provenance attestations bind every published asset to the tagged
source commit.

The release workflow accepts only an annotated, GitHub-verified `v<version>` tag from the tracked
tagger identity at the current default-branch commit. It compares independent Ubuntu and Windows
builds byte for byte before publication. See [the release guide](docs/releasing.md) for the preflight,
rehearsal and verification commands, and [the changelog](CHANGELOG.md) for version history.

## Project policies

Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change. Public reports must use synthetic
data; sensitive problems belong in the [security policy](SECURITY.md). The
[support guide](SUPPORT.md) points each kind of report to the right place, and every project space is
covered by the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Released under the [MIT License](LICENSE).
