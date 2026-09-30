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

Remote fixture CI was verified on September 29, 2026: project runner **282** picked up untagged job **137071** in [pipeline 32849](https://labs.gauntletai.com/andrebatista/copilot-security-auditor/-/pipelines/32849) for revision `14883c7`. Typecheck, production build and all 68 discovered fixture tests passed. This verifies that the runner can execute this project’s fixture job. For a later MR with a pipeline, that pipeline must succeed on its tested head or merge revision. An authoritative GitLab `head_pipeline: null` means no remote pipeline exists for that MR; the coordinator still requires exact-head local checks, verified merge and ancestry, and never calls that remote CI green.

The job has no `tags:` entry. Runner 282 was online and carried the `digitalocean` tag, but its **Run untagged jobs** setting was off, leaving the job pending. Enabling that setting let it run; no CI test or pipeline command was skipped. If a job is pending again, check that an enabled online project runner is assigned, that its tags match the job (or it accepts untagged jobs), and that protected-ref settings permit the branch. Inspect the job's runner message before changing CI or treating local checks as a remote pass. Runner 281 was previously listed as never contacted, and shared runners were disabled; that earlier diagnosis is historical, not the current status.

The audit observed an adaptive-browser target-selection timeout once; an isolated retry and subsequent complete rerun passed, and the cause was not established. The fixture suite runs files serially to limit resource contention, but does not retry failures automatically. Record any recurrence with the failing test and run output, then investigate within the two focused repair rounds for the owning task.

## Merge gate (from 2026-09-29)

The project runner is a small shared VM on which the full fixture job takes about ten minutes, and it runs one job at a time. Merge requests are therefore gated by local validation of the exact revision, and the GitLab job runs only on `main` after a merge (or when started manually from the web UI). An MR without a pipeline is never described as green CI.

The local gate uses one disposable PostgreSQL service instead of a container per test, and runs test files in parallel:

```sh
docker run -d --rm --name ca-test-pg -e POSTGRES_USER=auditor -e POSTGRES_PASSWORD=fixture-only \
  -e POSTGRES_DB=auditor_test -p 127.0.0.1:55432:5432 postgres:17-alpine -c max_connections=300
npm run typecheck && npm run build
TEST_DATABASE_URL=postgresql://auditor:fixture-only@127.0.0.1:55432/auditor_test \
  CHROME_BIN=/usr/bin/google-chrome npm run test:local   # TEST_CONCURRENCY defaults to 8
```

Each test still gets its own database. On a 32-core workstation the complete suite takes about 25 seconds. The coordinator validates the MR head merged onto current `main`, records the commit and counts in the MR, and reruns a failing file alone once; a failure that repeats in isolation blocks the merge. Browser tests can still time out on first page load when other processes create or remove Docker networks at the same time (Chrome reports `net::ERR_NETWORK_CHANGED`); serving the prebuilt UI to browser tests is the planned fix.

## Acceptance

`tests/acceptance/` is the curated fixture acceptance layer for HDX-30 (Q02). It ties each audit defect (A01-A16) and each major merged journey to explicit evidence from the current build: case authoring and publishing, the run composer with selected and adaptive runs, evidence and observations, Judge policy gates, finding review and report drafting, regression identity and suites, scoped coverage with OWASP mapping, spend reconciliation, schedules, and worker, queue and evidence health. The files match `*.test.ts`, so `test:fixtures`, `test:local` and the GitLab job run them with everything else.

**These are fixture results. They are not live acceptance.** The target is a local HTTP stand-in, the Judge, Orchestrator, Red Team and Documentation models are scripted stand-ins, the paid provider is a `127.0.0.1` stand-in and the database is disposable. Nothing reaches a live target, a paid provider or any other network. The suite verifies the platform's plumbing, gates, recovery paths and UI behavior; it does not measure model accuracy, real-target behavior, real spend or live performance. Explicitly authorized live synthetic acceptance (L01) and the live 100-case acceptance (L02) remain separate, gated work.

| File | Requirement ids | Path exercised |
| --- | --- | --- |
| `evidence-judge.test.ts` | A01, A02, A03, A05, A16, J03, J04 | real API and worker against a fixture target: structured observations, truncation, Judge packet, confirmation gate and calibration set, evidence integrity at decision time, turn deadlines, tool-action and chart-context scope |
| `runs-models-ops.test.ts` | A06, A11, A13, A15, J02, J10 | run history, restore, cooperative stop, busy target, active-role preflight, paid Judge reservation, saved definitions, adaptive lineage and bounds, operations health, event pages, CI definition |
| `cases-reports-regressions.test.ts` | A07, A10, A14, J01, J05, J06 | draft and publish lifecycle, clone, archive, starter matrix, report drafting with redaction, exact-hash approval, regression identities and suites |
| `coverage-spend-schedules.test.ts` | A08, A11, A12, J07, J08, J09 | scoped coverage, OWASP-mapped catalog, review disposition, unresolved spend reconciliation, schedule zones, DST, dispatch, pause and archive |
| `workflow.test.ts` | J11 (A07, A14, J05-J07) | one continuous flow from authoring to regression states on explicit versions and coverage |
| `browser.test.ts` | UI-KEYBOARD, UI-SMALL-SCREEN, UI-RECOVERY, A04, A06, A09, A10, A12 | real Chromium against the built UI served by the real API: keyboard-only navigation, launch and review; every page at 390 px; catalog 503, list 503, dropped connection, hard reload, busy target, draft preservation |
| `baseline.test.ts` | BASELINE | the throughput harness itself, at small scale |
| `traceability.test.ts` | BASELINE | every requirement has a test, no test cites an unknown id, the recorded evidence is current, passing and labeled fixture-only, and these docs keep saying so |

`tests/acceptance/requirements.ts` is the register: each requirement states what the acceptance asserts and, in plain words, what it does not establish. Every acceptance test title starts with the ids it verifies, for example `[A03][J05] ...`.

### No false passes

An acceptance test fails if the feature regresses. Each test names the exact expected outcome rather than "not safe", and a blocked, incomplete or inconclusive observation is never counted as a pass. A claim that something did not happen (no second target request, no Judge call, no candidate) is only made next to positive evidence that the path ran, such as the exact request count or the recorded failure reason. The tests were checked with mutation probes on scratch copies of the source (for example: let truncated evidence reach the Judge, auto-confirm an unrelated quote, skip the integrity check at confirmation, count blocked work as safe, serve a report before approval, drop the skip link). Every probe that changed reachable behavior made at least one test fail; the few survivors were equivalent or unreachable code (observation O7). Two assertions that would have survived a real regression (an archive check confounded with a pause, and a fix check that never replayed on the violating version) were found this way and strengthened. Mutations are never applied to the working tree.

### Running it

The browser tests serve the built UI from the API, so build first. Use a disposable PostgreSQL service as in the merge gate above.

```sh
npm run build
export TEST_DATABASE_URL=postgresql://auditor:fixture-only@127.0.0.1:55432/auditor_test CHROME_BIN=/usr/bin/google-chrome
node --import tsx --test tests/acceptance/*.test.ts       # the acceptance suite alone
node --import tsx tests/acceptance/record.ts               # run it and record per-test evidence (see below)
node --import tsx tests/acceptance/baseline.ts             # reproduce the fixture throughput baseline
```

`record.ts` and `baseline.ts` write to `evals/results/acceptance/<date>/` (override with `--out`). `baseline.ts` also accepts `--cases`, `--workers`, `--suite`, `--latency-runs`, `--target-latency-ms` and `--judge-latency-ms`. They are not named `*.test.ts`, so the suite never runs them and they never write files during `test:local`.

### Recorded evidence

Directory [`evals/results/acceptance/2026-09-30/`](../../evals/results/acceptance/2026-09-30/):

| File | Contents |
| --- | --- |
| [`acceptance-matrix.md`](../../evals/results/acceptance/2026-09-30/acceptance-matrix.md) | Each requirement (A01-A16, journeys, browser paths), the tests that verify it, what they assert and what they do not establish, plus the product observations below |
| [`acceptance-run.json`](../../evals/results/acceptance/2026-09-30/acceptance-run.json) | Per-test result and duration, requirement coverage, exact revision and machine notes |
| [`fixture-throughput-baseline.json`](../../evals/results/acceptance/2026-09-30/fixture-throughput-baseline.json) | The fixture throughput baseline: methods, numbers, revision, machine and runtime notes, known limits |

**Revision.** Recorded at `c9c3eb73c3c7813294798daceff10fe1d060b8ab` (the merge base of the Q02 branch). The application source (`apps/`, `packages/`, `db/`, `contracts/`) is exactly that commit's, so the evidence applies to any commit with the same trees: compare `git rev-parse <commit>:apps` with `applicationTrees.apps` in either JSON file. The branch adds only `tests/acceptance/`, `evals/results/acceptance/` and this section. Machine: Intel(R) Core(TM) i9-14900KF, 32 logical CPUs, 31 GB, Linux 7.0.0-31-generic x64, Node v24.14.0, PostgreSQL 17.11 as a disposable local service.

**Acceptance result.** 60 of 60 acceptance tests passed in the recorded run (the traceability test, which validates these files, is excluded from `record.ts` and runs with the rest of the suite). Every requirement in the register had at least one passing test.

**Fixture throughput baseline.** This is a fixture baseline: orchestration overhead measured in one process against local stand-ins. It is **not a live 100-case result**, not live performance and not a capacity claim.

| Profile | Measurement | Result |
| --- | --- | --- |
| No injected latency | 60 selected runs, one at a time (48 safe, 12 inconclusive by design) | 47.72 runs/s; launch-to-result p50 19.63 ms, p95 28.91 ms, p99 56.92 ms |
| No injected latency | 60 runs over 4 targets with 4 concurrent worker loops | 97.27 runs/s; per-run cycle p50 39.79 ms, p95 51.19 ms |
| No injected latency | one regression suite replaying 10 confirmed identities | 208 ms (47.98 replays/s) |
| No injected latency | process CPU and memory over the sequential phase | 706 ms CPU in 1257 ms wall; peak RSS 322 MB (API, worker, fixtures and database client share the process) |
| Illustrative latency (+50 ms per target request, +100 ms per Judge call) | 20 runs sequentially, then over 4 lanes | 1.65 runs/s sequential (worker p50 587.08 ms); 4.72 runs/s with 4 lanes |

The injected latencies are arbitrary illustrative values, not measurements of a real target or model. The real target's documented turn envelope is up to 90 s, so live throughput will be far lower; nothing here predicts it. The parallel phase uses several targets because a target admits one in-flight run. Numbers come from one run on a shared workstation (load average 3.09 at start) and serve as a regression baseline for the same machine, not as an SLO. The 100-case fixture baseline with scale-cost analysis belongs to HDX-32 (P01), and the authorized live 100-case acceptance to HDX-37 (L02).

**Known limits and product observations.** Each requirement row in the matrix states what its tests do not establish. Judge, Orchestrator, Red Team and Documentation behavior is scripted, so model accuracy, attack quality and report wording from real models are not evaluated; three real vulnerability reports still need live evidence. The keyboard, focus, landmark and phone-width checks are not a formal accessibility conformance review. While writing the tests the following were found and deliberately **not fixed** here (Q02 verifies; none is a regression of an audited defect); the matrix lists them with file and line references for separate issues:

- **Bug (O9).** A target handshake without `module_version` is recorded as the label `unknown`. Coverage treats that as an unestablished version, but regression state treats it as a verified one, so a safe replay there after a violation can be reported `fixed`. Contradicts the documented rule that version-less results are always `unknown`.
- **Gap (O2).** `POST /api/runs` accepts a paid Judge whose conservative reservation exceeds the cap (202); only the worker refuses, after the target turn. The composer blocks it; the API does not.
- **Gap (O1, O3, O5).** The application footer still reads "PHASE 02 / THREE TRUST BOUNDARIES"; the stop route returns one 409 for unknown and finished runs; three pre-matrix starter cases have no rubric or OWASP mapping, and coverage cannot be filtered by OWASP tag.
- **Notes (O4, O6, O7, O8).** A stagnation stop finishes an adaptive run `safe`; unresolved-charge holds gate only their own run; two `scopeOutcome` branches are unreachable defence in depth; the legacy `GET /api/coverage` still pools targets.

After changing `tests/acceptance/` or its requirement register, re-run `record.ts` and `baseline.ts` and commit the new files: `traceability.test.ts` fails while the recorded evidence no longer matches the tests, and it also checks that these results stay labeled as fixture-only.

## Live validation boundary

`npm run test:live` is an explicit operator command, excluded from CI and fixture discovery. It needs separately authorized synthetic target identities and a verified effective downstream spend cap. The smoke test cannot enforce provider billing. Local fixtures, stubs, screenshots and a configured but unrun GitLab job do not establish live acceptance.
