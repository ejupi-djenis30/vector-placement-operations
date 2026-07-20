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
npm install
npm run check
python -m http.server 8000 --directory site
```

Then open `http://127.0.0.1:8000`.

## Project background

VECTOR began as a 2023 academic team project. This edition keeps the original product problem and rebuilds the application around fictional records, a browser-only data model and a deliberately small attack surface.

The original team was Djenis Ejupi and project contributors. The contributors approved publication of this reconstructed edition.

## Deployment

GitHub Pages publishes the contents of `site/` after the test and validation suite passes on `main`.

Live app: [ejupi-djenis30.github.io/vector-placement-operations](https://ejupi-djenis30.github.io/vector-placement-operations/)

## License

No license is granted by this repository. Viewing or running the public app does not grant permission to copy, modify or distribute the code. Contact the contributors before reusing it.
