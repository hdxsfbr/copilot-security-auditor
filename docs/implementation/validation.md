# Fixture validation

The fixture pipeline uses Node 24, PostgreSQL 17 and Chromium. It validates code and synthetic fixtures; it does not deploy the auditor, connect to a target, or call a live or paid model.

## Local prerequisites

Use Node.js 24 and npm with the checked-in lockfile. The default integration setup requires a working Docker daemon because each test database call starts and stops its own disposable `postgres:17-alpine` container. Do not point `TEST_DATABASE_URL` at a database containing user data.

Browser tests use `playwright-core` with an installed system browser. The helper checks `CHROME_BIN` first, then common Linux Chromium/Chrome locations. For example:

```sh
CHROME_BIN=/usr/bin/chromium npm run test:e2e
```

Install a compatible Chromium/Chrome build and its system libraries before running browser tests. If the executable is unavailable, the test fails with the required `CHROME_BIN` guidance; the suite does not silently skip browser checks.

Run the complete fixture suite with:

```sh
npm ci
npm run typecheck
npm run build
npm run test:fixtures
```

`test:fixtures` discovers `*.test.ts` and `*.test.mjs` files recursively under `tests/` and runs them serially. Add feature regression tests using those suffixes so CI discovers them without editing a central test list. The opt-in `tests/live-smoke.ts` file does not match these patterns and is never started by the fixture command. Existing focused commands (`test:unit`, `test:integration`, `test:e2e`, `test:failure`, and `test:coordinator`) remain available when iterating on one area.

By default, every call to `database()` creates an isolated PostgreSQL container on an ephemeral host port and removes it when the test finishes. To use an already running **disposable** PostgreSQL service instead, set `TEST_DATABASE_URL` to a database on which the supplied role may create and drop databases. The helper creates a unique per-call database, applies migrations there, and drops it on close. This mode lets CI use a PostgreSQL service without Docker-in-Docker and keeps test databases isolated from one another.

## GitLab pipeline

`.gitlab-ci.yml` installs Chromium, installs locked npm dependencies, then runs typecheck, production build and the recursively discovered fixture suite. A PostgreSQL 17 service backs isolated per-test databases. The job clears inherited OpenRouter credentials before tests; the paid-provider fixture uses only its local mock server. It never runs `test:live`.

The GitLab project currently has no confirmed usable runner. Local validation can establish the code checks, but it cannot be described as a green GitLab pipeline. Verify the pipeline in GitLab after a runner becomes available; a missing or never-contacted runner is a pending infrastructure gate, not a passing result. Do not change runner settings as part of this code task.

The audit observed an adaptive-browser target-selection timeout once; an isolated retry and subsequent complete rerun passed, and the cause was not established. The fixture suite runs files serially to limit resource contention, but does not retry failures automatically. Record any recurrence with the failing test and run output, then investigate within the two focused repair rounds for the owning task.

## Live validation boundary

`npm run test:live` is an explicit operator command, excluded from CI and fixture discovery. It needs separately authorized synthetic target identities and a verified effective downstream spend cap. The smoke test cannot enforce provider billing. Local fixtures, stubs, screenshots and a configured but unrun GitLab job do not establish live acceptance.
