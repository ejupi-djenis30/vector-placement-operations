# Contributing to VECTOR

VECTOR is a small, browser-only placement workspace built around fictional records. A useful change
should make the board clearer, safer, easier to test, or more accessible without turning it into a
student-information system.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before opening an issue

Search the existing issues and use the provided forms. Never attach real student, school, employer,
or staff information. Reproduce the problem with the bundled synthetic cohort or replace every
identifying value before sharing a screenshot, browser export, console message, or storage dump.

Report vulnerabilities through [the security policy](SECURITY.md), not a public issue.

## Local setup

Install Node.js 22 or newer, then run:

```bash
npm ci --ignore-scripts
npm run check
npm run test:e2e
npm audit --audit-level=moderate
```

`npm run check` executes the data-model tests and validates the static site. The Playwright suite
checks keyboard interaction, persistence, narrow screens, and the exact geometry used by the project
presentation. The app is served from `site/` and intentionally has no backend or build-time runtime.

## What a good change includes

- Add a focused regression test for changed calculations, filtering, persistence, or interface
  behavior.
- Keep the hosted application useful with the bundled synthetic dataset and no network API.
- Preserve keyboard access, visible focus, reduced motion, and the 320 px layout.
- Treat local storage and imported browser state as untrusted input.
- Explain any data-model change and keep status and hour calculations deterministic.
- Avoid dependencies when the browser platform already provides the required behavior.

Authentication, real-person records, shared databases, analytics, and administrative workflows are
outside this project's scope. A proposal may explain that need, but should not quietly add it.

## Pull requests

Keep commits narrow and describe the result, for example `fix: preserve filters after reload`. In the
pull request, state what failed before, what now enforces the behavior, and the commands you ran.
Confirm that the branch, screenshots, fixtures, logs, and description contain synthetic data only.

By submitting a contribution, you confirm that you have the right to provide it and agree that it
will be licensed under the project's [MIT License](LICENSE).
