# Fixture performance evidence (HDX-32 / P01)

Everything here is **fixture evidence**: the real Express API and worker pipeline running in one Node process against a local HTTP
stand-in for the Co-Pilot target, scripted Judge stand-ins and a disposable PostgreSQL database, all on 127.0.0.1. **It is not a live
100-case result, not live performance and not a capacity claim.** No live target, paid provider, model inference or deployment was
used. The authorized live 100-case run is a separate item (L02 / HDX-37). What these numbers describe is the auditor's own
orchestration, serialization and persistence cost, and how that cost scales; `docs/submission/cost-and-scale.md` keeps measured fixture
results, estimates and (absent) live results in separate columns.

One dated directory per recording:

| File | What it is | Command |
| --- | --- | --- |
| `<date>/fixture-baseline-100.json` | The 100-case baseline: sequential and lane-scaling passes, a 100-identity regression load in suites of 25, API reads, storage, a synthetic-latency profile, the deployed worker cadence and five fresh-process repeats of the SLO workload. | `npm run perf:baseline -- --out evals/results/performance/<date>` |
| `<date>/bottlenecks.json` | The bottleneck list: each bottleneck with the measurements (and source paths) that show it, an architectural response and the scale at which it binds. Derived from the other files, so every number is theirs. | `npm run perf:bottlenecks` |
| `<date>/query-plan-evidence.json` | EXPLAIN evidence for migration 024 on a synthetic database of 100,000 runs, the candidate indexes that were rejected, write overhead and the `/api/regressions` scaling sweep. | `npm run perf:plans -- --runs 100000 --out evals/results/performance/<date>` |
| `<date>/memory-stability.json` | 1,400 cases in one process under a capped V8 heap: is RSS a working set or a leak? | `npm run perf:memory -- --out evals/results/performance/<date>` |
| `<date>/slo-contention-emulation.json` | The SLO workload with Node starved to about a third of a core: how much headroom the timed limits leave. | command recorded in the file |
| `<date>/slo-check-local.json` | One uncontended run of the CI check (`npm run perf:slo`) with every limit and margin. | `npm run perf:slo -- --out <file>` |

Reproduce with a disposable PostgreSQL service (`TEST_DATABASE_URL=postgresql://auditor:fixture-only@127.0.0.1:55432/auditor_test`,
any PostgreSQL 17 works; each stack creates and drops its own database). Every JSON carries the exact git revision, the hashes of the
`apps`, `packages` and `db` trees it measured, whether application source was dirty, and the machine and Node version.

## Revisions

The recordings of 2026-09-30 were taken at commits `6781412` (baseline and contention emulation), `88779c6` (query plans) and
`4048537` (memory); the bottleneck list and the local SLO check were derived or run at later commits. The `apps`, `packages` and `db` trees are byte-identical across all of them
(`66f13ea4` / `f8ef3b60` / `41e407ef`); the commits between them change only `tests/performance/`, so the figures describe the same
application code. The baseline was measured on the branch that introduces migration 024, so its indexes are present.

## The regression SLO

`npm run perf:slo` runs the SLO workload (100 sequential fixture cases, then one 25-replay regression suite) and is wired into the
`fixture-validation` job of `.gitlab-ci.yml` on the default branch. Its limits and the reasoning for them are in
`tests/performance/slo-definition.ts`; in short:

- **Deterministic limits** (SQL statements, event rows and bytes per case, target requests per case) are 1.25x the recorded reference
  (1.5x for bytes). They count work, not time, were identical across five fresh-process runs, and cannot flake.
- **Timed limits** are 30x the recorded reference for wall-clock metrics (100 cases: 1,921 ms recorded, 57,630 ms allowed) and 2x for
  peak memory (374 MB recorded, 748 MB allowed). The CI runner is a small shared 1 vCPU machine; the recorded reference came from a
  32-thread workstation. A timed-only breach is re-measured once before the job fails.
- The uncontended local run (`slo-check-local.json`) passes with 29.7x to 31.3x headroom on the timed wall-clock metrics (2.01x on
  memory); with Node starved to about a third of a core (`slo-contention-emulation.json`) the timed metrics were 3.0x to 3.6x slower
  and still had 8.3x to 10.2x headroom.

## Not covered

Adaptive exploration, PDF attachments, report drafting, schedules and paid-spend accounting are not part of the 100-case workload
(the acceptance suite covers them functionally). PostgreSQL server CPU and memory are outside the measured process. Fixture responses
are short, so event and storage sizes per case are a floor. See `known limits` in each JSON.
