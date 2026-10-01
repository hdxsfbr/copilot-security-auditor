# AI cost analysis and scale plan

**Status:** P01 / HDX-32. This revision adds a reproducible **fixture** baseline, a regression SLO wired into CI and an explicit scenario model. Basis: source at `6781412` and the public OpenRouter catalog retrieved **2026-09-29 21:07 UTC** (unauthenticated `GET https://openrouter.ai/api/v1/models`, 464 rows; no API key, no paid call). **No live run produced any figure here.** The authorized 100-case live acceptance (L02 / HDX-37) has not been run and needs separate authorization; until it is, this document states no live performance.

Every figure carries one of these labels, and the three kinds of evidence are never mixed in one cell:

| Label | Meaning | Where |
| --- | --- | --- |
| **[F]** measured fixture | Measured on local stand-ins (fixture target, scripted Judge, disposable PostgreSQL). Describes the auditor's own orchestration and persistence. **Not live performance.** | section 4, the R and S2 rows of section 6 |
| **[M]** verified | Read from source or from the catalog snapshot. | sections 1-3, the price rows of section 6 |
| **[E]** estimate | Derived from a stated basis, not measured. | sections 3, 6, 7 |
| **[A]** assumption | A planning value to replace with a measurement. Changing one moves every scenario. | section 6 |
| **[L]** live | Measured against the live target or live models. **None exist yet.** | (none) |
| **TODO** | Operator input. | section 6 (all-local host price) |

## 1. Unit of work

"Test run" is ambiguous: an API run is one case (selected) or up to nine (adaptive). This analysis prices one **executed case** in the two modes the worker implements.

| | Selected case / regression replay | Adaptive (per attempted case) |
| --- | --- | --- |
| Auditor model calls [M] | At most 1 Judge (`models.ts:13`, `process.ts:221-229`). None when the target result is denied, failed, truncated or partial, or the packet is invalid (`process.ts:173-200`). | At most 1 Orchestrator + 1 Red Team + 1 Judge (`adaptive.ts:68,88`). A rejected proposal costs 2 calls and no target turn (`adaptive.ts:97`). No model retries (`models.ts:32-35`). |
| Run bounds [M] | 1 case | `maxCases` 1-9, `maxMinutes` 1-30 (`index.ts:65`); 1-3 actions per case (`index.ts:28,74`) |
| Target turns [M] | 1-3; starter matrix uses 1-2 (`011_versioned_starter_matrix.sql`) | 1-3 per admitted case |
| Target sessions [M] | 1, or 2 for chart-context cases (`process.ts:120`); 6 setup requests each (`session.ts:170-198`) | Fresh session per admitted case |
| Other target work [M] | `attach_pdf` adds an intent and upload request (target extracts the PDF); tool-action cases fetch a patient report twice, each at most 2 MB (`process.ts:125,146`) | Same |
| Judge input bound [M] | Packet at most 100,000 characters (`agent.ts:19`, `judge.ts:44`), about 25-33K tokens at 3-4 characters per token; at most 3 observations of 10,000 visible characters (`session.ts:6`) | Same |
| Output bound [M] | `maxOutputTokens` 1-4,096 per role (`index.ts:51-52`) | Same |
| Planning tokens [E] | Judge 3,000 in / 400 out | Orchestrator 2,000 / 60; Red Team 3,000 / 400; Judge 3,000 / 400 (8,000 / 860 total) |
| `events` rows written [M] | 5 + turns (one more for chart-context and tool cases) | 9 + turns |

The planning tokens are guesses; `model_calls.input_tokens/output_tokens` record real values after any run and should replace them.

## 2. Two cost centres

**Auditor side** is the model calls above, recorded in `model_calls` (`db/migrations/005_model_spend.sql`) and exposed per run at `GET /api/runs/:id/usage` (`app.ts:224`). Ollama rows record tokens and latency, never a charge (`repository.ts:599`).

**Target side** is borne by the target operator and is not in that ledger. Every target turn calls the Co-Pilot's own model: the brief describes Claude Sonnet 5 through OpenRouter for the answer, deterministic verification with one repair, and Gemini 2.5 Flash for PDF extraction (`COPILOT_FEATURE.md` sections 3 and 4). The coordinator reports `/copilot-api/ready` shows `openrouter:anthropic/claude-sonnet-5`; I did not re-fetch it. The brief's limits are 20K tokens per turn, 60K per conversation, **2M per day for the whole process**, and 10 turns per minute per conversation (section 5, item 10). The auditor records only that a turn happened (`process.ts:143`).

Planning turn [A]: 8,000 in / 1,000 out at $2 / $10 per million = **$0.026**; range $0.013 (4K / 0.5K) to $0.056 (18K / 2K, near the cap). The brief gives no per-turn average; the target's OpenRouter activity or Langfuse traces would.

## 3. Price inputs and two code-level findings

| Model (OpenRouter id) | Context | $/M in | $/M out | Dispatchable today [M] | Reserved per call, 1,024 max out [M] | Planning Judge charge [E] |
| --- | --- | --- | --- | --- | --- | --- |
| `openai/gpt-oss-120b` | 131,072 | 0.037 | 0.17 | yes | $0.0050 | $0.00018 |
| `moonshotai/kimi-k2-0905` | 262,144 | 0.60 | 2.50 | yes | $0.160 | $0.0028 |
| `mistralai/mistral-medium-3-5` | 262,144 | 1.50 | 7.50 | yes | $0.401 | $0.0075 |
| `anthropic/claude-sonnet-5` (target's model; reference) | 1,000,000 | 2.00 | 10.00 | **no** | $2.01 | $0.010 |
| `google/gemini-2.5-flash` (target's extractor; reference) | 1,048,576 | 0.30 | 2.50 | **no** | $0.32 | n/a |

"Dispatchable" and "reserved" for the first three rows come from running the repository's own `verifiedPrice` and `reserveAmount` against the saved snapshot; the two reference rows are rejected by that function, so their reservations are hand arithmetic with the same formula.

1. **Reservation is not spend.** The worker reserves prompt price times the *entire context window*, plus completion price times `maxOutputTokens`, plus any request fee (`models.ts:85-88`), then replaces it with the provider-reported charge on settlement. That is 28-200 times the planning charge. The preview sums active roles times `maxCases` (`models.ts:21-36`); for 9 adaptive cases with three paid roles it is $0.14 (gpt-oss-120b), $4.32 (kimi), $10.82 (mistral-medium); a Sonnet-5-priced model would preview $54.28. Launch does not compare the preview with the cap; the first `reserveCall` refuses when settled charges plus reservations plus the new call exceed the cap (`repository.ts:581`) and the run ends incomplete. The per-run cap must therefore exceed at least one reservation, and the contract maximum is $100 (`index.ts:59`).
2. **Dispatchability.** `verifiedPrice` rejects any model whose catalog price has a non-zero dimension besides prompt, completion and request (`models.ts:115`). Against the snapshot it accepted 122 of 464 rows and rejected every Claude, Gemini 2.5 and GPT-5.x row I checked (cache, web-search or reasoning dimensions). A paid Claude or Gemini Judge would fail preflight today with `paid_catalog_or_pricing_unavailable`. Changing that is code work outside this documentation slice; prices and this list are a snapshot and will move.

The worker also re-downloads the whole catalog before every paid call (`process.ts:208`, `adaptive.ts:139`): 760,447 bytes on the snapshot [M], so an all-paid adaptive case pulls about 2.3 MB.

## 4. Measured fixture baseline [F]

> **FIXTURE BASELINE: synthetic, in-process, local stand-ins only. This is NOT a live 100-case result and NOT live performance.**

**What was run.** One Node process hosting the real Express API, the real worker entry (`processNext`), a local HTTP stand-in for the Co-Pilot target, scripted Judge stand-ins and a disposable PostgreSQL 17, on 127.0.0.1. 100 distinct published cases (per 20: 10 single-turn injections, 3 three-turn injections, 4 chart-context `cross_patient`, 3 `unintended_tool_action`; 1.3 target turns and 11.3 target requests per case), each outcome asserted, then 100 confirmed findings replayed in regression suites of 25 (the contract maximum). Recorded at commit `6781412` on an Intel Core i9-14900KF (32 threads, shared workstation), Node v24.14.0. Everything is under `evals/results/performance/2026-09-30/`; reproduce with `npm run perf:baseline -- --out evals/results/performance/<date>`.

| Measured [F] | Result |
| --- | --- |
| 100 cases, one worker | 51.6 cases/s (1.94 s wall); worker pass p50 16.3 ms, p95 23.3 ms; launch p50 1.9 ms |
| Where a worker pass goes | PostgreSQL 71% (12.3 ms), target HTTP 13%, orchestration CPU 14%, Judge stand-in 1.5% (the stand-in's answer time, not model latency) |
| CPU | 9.7 ms per case, half a core at one lane |
| SQL | 64.2 worker statements plus 9 at launch per case; 12.65 commits, 52% of database time |
| Memory | 357 MB peak RSS (305 MB before any case runs); JS heap flat under a cap over 1,400 cases (+3.9 KB per case) |
| Storage | 12.8 KiB (13,107 bytes) of database growth per case at the fixture floor; 6.65 events, 2,981 bytes of event JSON |
| Full regression suite (25 replays) | 433-477 ms, median replay 15-17 ms, 84 statements per replay; creating the suite 44-62 ms |
| 100 replays in 4 suites | 1,836 ms, 54.5 replays/s; setting up 100 confirmed findings 2,276 ms |
| Lanes, free calls | 56.5 / 78.4 / 96.8 / 126.0 cases/s at 1 / 2 / 4 / 8 lanes; 1.09 cores used at 8 |
| Lanes, illustrative latency (+50 ms per target request, +100 ms per Judge call) | 1.42 cases/s sequential, 10.44 at 8 lanes (7.35x) using 12% of a core; 81% of a pass is waiting on the target |
| Deployed worker cadence | 5 queued runs drained in 7,618 ms: 1.52 s per run, 0.66 runs/s; the 1.5 s pause is 98.7% of each cycle at fixture speed |
| Repeatability | 5 fresh processes: wall 1,921 ms median (3.0% coefficient of variation), p95 22.82 ms (3.6%), suite 453 ms (3.5%), RSS 374 MB (3.6%); every work count identical |

**What this does not say.** It is not live throughput: the real target turn takes up to 90 s and the real Judge seconds, none of which is here. The injected latencies are arbitrary numbers chosen to show which resource binds. API, worker, target and client share one event loop, so the lane curve understates a multi-process deployment. PostgreSQL server CPU and memory are not measured. Fixture responses are short, so storage per case is a floor. Adaptive exploration, PDF attachments, report drafting, schedules and paid-spend accounting are outside this workload, so paid-call reservation and the per-call price-catalog download are not measured either.

## 5. Bottlenecks and architectural response

Derived from the recorded evidence by `npm run perf:bottlenecks` into `evals/results/performance/2026-09-30/bottlenecks.json`, which carries every measurement and its source path. Ordered by what binds first against a real target.

| # | Bottleneck | Evidence | Architectural response | Binds at |
| --- | --- | --- | --- | --- |
| B1 | **The target sets live throughput, not the auditor.** | [F] 9.7 ms CPU and 73 statements per case; with illustrative latency 8 lanes reach 7.35x one lane at 12% of a core. [E] at an assumed 70 s live case one lane uses 0.014% of a core, 100 lanes 1.4%; the target's 2M-token daily halt allows about 110 cases a day per instance. | Scale with lanes: one target row and synthetic user pair per lane, more worker processes when one nears a core, per-target concurrency and an incomplete-rate circuit breaker, negotiated target token headroom or a multi-day schedule. Do not optimize auditor CPU. | every live scale from 100 cases |
| B2 | **Fixed 1.5 s worker pause after every cycle** (`apps/worker/src/main.ts:24`). | [F] 1.52 s per drained run, 0.66 runs/s; 98.7% of the cycle at fixture speed, [E] 2.1% at a 70 s live case. | Sleep only when `processNext` returns nothing. One line. | negligible live; dominant for bursts of fast runs |
| B3 | **Commit-bound persistence**: each event is its own durable transaction. | [F] 12.65 commits per case cost 7.19 ms: 52% of database time, 37% of launch-plus-worker time. | Group a stage's events into one transaction, skip the no-op version UPDATE, keep durable commits for verdicts (about 5 ms per fixture case [E]). Commit latency on the runner disk is also why the timed SLO is wide. | only under a second per case; not recommended now |
| B4 | **One process saturates a core near 126 fixture cases/s.** | [F] 56.5 to 126.0 cases/s from 1 to 8 lanes (2.2x) while CPU rises 0.44 to 1.09 cores. | Add worker processes (already a separate deployable; claiming is `SKIP LOCKED`-safe). | not reachable with live targets on one process |
| B5 | **Unbounded, quadratic list reads.** | [F] `GET /api/coverage/scoped` with no target returns 4.4 MiB after 706 runs. Synthetic database: `GET /api/regressions` grows 0.6 to 34.4 MiB (x4 per doubling) from 2,500 to 20,000 runs and at 100,000 runs the SQL takes 29.0 s and serialization throws `RangeError: Invalid string length`, so the route returns HTTP 500; `GET /api/findings` 5.2 MiB at 21,667 candidates. A candidate index sped the regressions lookup only 1.27x-1.39x. | Cursor pagination and caps (the pattern exists for run history, identities and suites); latest N replays per regression with a count; page coverage scopes or serve them from counts kept at run finish. An index does not fix it. | from about 10K runs; regressions unusable before 100K |
| B6 | **Coverage reads all history and nothing is indexable.** | Synthetic database: 675 ms at 100,000 runs with or without migration 024; category and subcategory are pulled from JSONB per row; a JSONB-category expression index was not chosen by the planner. | Rollup table per target, version and case updated at run finish; promote category and subcategory to columns. | from about 10K runs |
| B7 | **Storage growth.** | [F] 12.8 KiB per case floor: events 3.0 MiB, runs 2.9 MiB, assessments 0.8 MiB for 706 runs. [E] 1.5 GB for 100K cases at the floor, 2.8 GB at 25 KB. | Partition `events` by month, archive finished-run events keeping hashes in PostgreSQL, read replica for the UI. | from about 10K runs |
| B8 | **Memory of a long-lived process.** | [F] Heap flat under a cap; RSS creeps 302 to 315 MB over 1,400 cases, not attributed. | Watch worker RSS through worker-health (O01); restart on a threshold. | long-lived workers |
| B9 | **CI runner headroom.** | [F] Node starved to a third of a core: timed metrics 2.95x-3.60x the reference, 8.3x-10.2x under the limits; work counts unchanged. | Work counts are the precise tier; wall-clock limits are a coarse tripwire (section 9). | CI only |

**Migration 024** (`db/migrations/024_severity_category_indexes.sql`) adds the three indexes the planner demonstrably uses, measured on a synthetic 100,000-run database (`query-plan-evidence.json`, medians of five plan executions). The gains are modest, and the honest finding is that most category and severity reads cannot be helped by an index.

| Index | Serves | Without | With |
| --- | --- | --- | --- |
| `runs_finished_version (target_id, finished_at DESC) WHERE status='finished' AND version IS NOT NULL` | latest verified version of a target (`regression-suites.ts:178`) | 7.91 ms | 0.03 ms, and no longer grows with history |
| `runs_target_version (target_id, version)` | version-scoped coverage; the target filter of the unresolved-finding scan | 30.17 ms (version scope) | 17.21 ms; no change for the unresolved-finding scan (15.82 vs 17.29 ms) or for a target-only scope at 1 target in 8 |
| `adaptive_cases_executed_category (category, state) WHERE executed` | the adaptive half of `GET /api/coverage` | 6.08 ms | 4.24 ms (whole statement 34.14 to 30.32 ms: the JSONB-grouped runs half dominates) |

**Severity is not indexed.** It exists only inside JSONB (case rubric, report revision); its single SQL read (`exploration.ts:41`) projects it without filtering, so no index can serve that read. **Category is filtered in SQL in one place** (`regression-identity.ts:154`), where the planner already walks `regression_identities_seq_key` and rejects a `(category, seq)` index. The JSONB-category expression index and a `candidates` recency index were tried and not chosen. `tests/performance/migration-024.test.ts` fails if a severity predicate or a second category predicate is ever added, which is when an index becomes justified. Carrying the three indexes costs about 25% more to insert a run and 19% more to re-version one (25.57 to 31.81 ms and 44.31 to 52.78 ms per 5,000 rows).

## 6. Scenarios: 100, 1K, 10K and 100K finished cases

Not token multiplication: each scenario derives attempts from a retry model, prices every auditor role separately from the target, and converts the same attempts into wall-clock, lanes, target budget, auditor CPU and statements, storage and operator review time. All of it comes from `tests/performance/scenarios.ts`; the three tables below are generated (`npm run perf:scenarios -- --write`) and a test fails if they drift from the model. Change an assumption there and every row moves.

### 6.1 Assumptions

<!-- perf:scenarios:assumptions:start -->
| # | Assumption | Value | Label | Basis |
| --- | --- | --- | --- | --- |
| W1 | Finished cases per scenario | 100 / 1,000 / 10,000 / 100,000 | scenario | The four sizes in the brief. A "case" is one executed case (selected or one adaptive attempt). |
| W2 | Unusable attempts (incomplete, denied, failed, truncated, ambiguous) rerun until usable | 10% of attempts, so 1.111 attempts per finished case | [A] | Unmeasured live. The fixture run has none. Retries are reruns; the worker never retries a model call (`models.ts:32-35`). |
| W3 | Share of unusable attempts that end before the Judge is called | 50% | [A] | Denied, failed, truncated and partial target results skip the Judge (`process.ts:173-200`) but have already consumed target turns. |
| W4 | Target turns per attempt | 2 | [A] | The starter matrix averages 1.3 turns (`011_versioned_starter_matrix.sql`); 2 leaves room for adaptive cases with 1-3 actions. |
| T1 | Target tokens per turn | 8,000 in / 1,000 out | [A] | The target's brief gives no average; its activity log or Langfuse would replace this. |
| T2 | Target model price | $2 in / $10 out per M tokens | [M] catalog | `anthropic/claude-sonnet-5`, the model the target brief names, as listed in the 2026-09-29 21:07 UTC catalog snapshot. |
| A1 | Judge tokens per call | 3,000 in / 400 out | [A] | `model_calls` records real values after any run. |
| A2 | Orchestrator / Red Team tokens per call | 2,000 / 60 and 3,000 / 400 | [A] | Adaptive mode only. |
| A3 | Auditor model prices per M tokens (in / out) | openai/gpt-oss-120b $0.037 / $0.17; moonshotai/kimi-k2-0905 $0.6 / $2.5; mistralai/mistral-medium-3-5 $1.5 / $7.5 | [M] catalog | Catalog snapshot 2026-09-29 21:07 UTC; only these three are dispatchable today (`verifiedPrice`, `models.ts:115`). Prices move. |
| S1 | Wall-clock per attempt, one lane | 70 s with a paid Judge, 85 s all-local, plus the worker pause | [A] | 3 s setup, 25.5 s per target turn, Judge 5 s paid or 15 s local, Red Team 12 s, Orchestrator 2-4 s. The target turn time is not measured. |
| S2 | Worker pause after every cycle | 1.5 s | [M] fixture | `apps/worker/src/main.ts`; the fixture cadence run measures its effect. |
| S3 | Target daily token halt | 2,000,000 tokens per day per instance | [E] | The target brief's process-wide limit; whether it is deployed is unverified. |
| R1 | Auditor CPU per attempt | 9.7 ms, 73 SQL statements | [M] fixture | The recorded fixture baseline at `6781412`; in-process, local stand-ins. |
| R2 | Auditor storage per attempt | 13 KB measured floor (fixture), 25 KB planning value | [M] floor / [E] | The fixture's responses are short; real responses are bounded at 256,000 bytes per turn body (`session.ts:5`). |
| H1 | Findings needing human review | 10% of finished cases, 5 min each | [A] | `pending_review` outcomes need an operator; the real share depends on the target and on E03 calibration. |
<!-- perf:scenarios:assumptions:end -->

### 6.2 Workload and resources

<!-- perf:scenarios:workload:start -->
| Finished cases | 100 | 1,000 | 10,000 | 100,000 |
| --- | --- | --- | --- | --- |
| Attempts incl. reruns (W2) | 111 | 1,111 | 11,111 | 111,111 |
| Target tokens (W4, T1) | 2.0 M | 20.0 M | 200.0 M | 2,000.0 M |
| Days of target budget on one instance (S3) | 1.0 | 10.0 | 100.0 | 1,000.0 |
| One lane, serial, paid Judge (S1, S2) | 2.2 h | 22.1 h | 9.2 days | 91.9 days |
| Lanes needed to finish in 24 h | 1 | 1 | 10 | 92 |
| Target instances needed for 24 h (S3) | 1 | 10 | 100 | 1,000 |
| Worker pause alone, one lane, serial (S2) | 3 min | 28 min | 4.6 h | 46.3 h |
| Auditor CPU, all attempts (R1) | 1 s | 11 s | 108 s | 18 min |
| Auditor SQL statements (R1) | 8,133 | 81,333 | 813,333 | 8,133,333 |
| Auditor storage: fixture floor / planning (R2) | 1 MB / 3 MB | 15 MB / 28 MB | 146 MB / 278 MB | 1.5 GB / 2.8 GB |
| Operator review time (H1) | 0.8 h | 8.3 h | 83.3 h | 833.3 h |
<!-- perf:scenarios:workload:end -->

### 6.3 Cost

Auditor cost depends on which roles are paid. "Paid Judge only" is also the cost of selected and regression runs, which use no Orchestrator or Red Team. Target-side inference is identical across auditor configurations.

<!-- perf:scenarios:cost:start -->
| Finished cases | 100 | 1,000 | 10,000 | 100,000 |
| --- | --- | --- | --- | --- |
| Target-side inference (T1, T2), all attempts | $5.78 | $58 | $578 | $5,778 |
| All-local auditor (Ollama): inference | $0 | $0 | $0 | $0 |
| All-local auditor: host time, one lane (S1, S2) | 2.7 h | 26.7 h | 11.1 days | 111.2 days |
| Paid Judge only, openai/gpt-oss-120b | $0.02 | $0.19 | $1.89 | $19 |
| Paid Judge only, moonshotai/kimi-k2-0905 | $0.30 | $2.96 | $30 | $296 |
| Paid Judge only, mistralai/mistral-medium-3-5 | $0.79 | $7.92 | $79 | $792 |
| All three roles paid (adaptive), openai/gpt-oss-120b | $0.05 | $0.48 | $4.81 | $48 |
| All three roles paid (adaptive), moonshotai/kimi-k2-0905 | $0.76 | $7.57 | $76 | $757 |
| All three roles paid (adaptive), mistralai/mistral-medium-3-5 | $2.01 | $20 | $201 | $2,008 |
| Target-side plus paid Judge only, moonshotai/kimi-k2-0905 | $6.07 | $61 | $607 | $6,073 |
<!-- perf:scenarios:cost:end -->

### 6.4 Reading the tables

- **The target is most of the cost and all of the wall-clock.** With a cheap Judge the target-side line is one to three orders of magnitude above the auditor line. Upgrading the Judge barely moves the total; one fewer target turn per case does.
- **The target's token budget binds before any auditor limit.** At 18K target tokens per attempt the target's 2M-token daily halt allows about 110 attempts a day per instance, roughly ten times fewer than one serial worker could send (about 1,200). One hundred finished cases already need a day of target budget (W2 makes it 111 attempts). Whether the deployed target sets the brief's limits is unverified.
- **Scheduling.** A target admits one active run, so lanes are targets (`repository.ts:418,445`); scheduled occurrences are skipped while one is active (`repository.ts:204`). The 1.5 s worker pause costs 2.1% of a live attempt and 99% of a fixture one (B2). One worker loop today means the serial rows are what the current deployment delivers.
- **Retries and failures.** The 10% unusable-attempt assumption (W2) adds 11% to every linear row. Failures also hold spend: an ambiguous paid call keeps its reservation and blocks further paid calls in that run (`repository.ts:579`), so failures shrink the usable per-run cap as well as adding cost; the model never retries a model call (`models.ts:32-35`), only reruns the case.
- **Reservation is not spend** (section 3): the per-run cap must exceed at least one reservation (up to $0.16 for kimi, $0.40 for mistral-medium and $2.01 for a Sonnet-5-priced model at 1,024 output tokens). Reservations are replaced by the settled charge, so they constrain the cap a run needs, not the totals above.
- **All-local scenario.** It shifts cost to hardware: the host-time row times the operator's host price per hour (**TODO**, no hardware price is assumed). Throughput of `qwen3-coder:30b` on that host is unmeasured; the per-call deadline is 90 seconds (`deadlines.ts:10`).
- **Judge size.** A maximal Judge packet with 4,096 output tokens costs about 10 times the planning Judge call in every priced row.
- **Auditor resources are small.** 1.1 s of auditor CPU for 100 cases and 18 minutes for 100K [F, extrapolated linearly]; the CPU, statement and storage rows scale linearly from one fixture measurement, and storage is a floor (real responses are larger) until the ledger replaces it.
- **Human review is the real ceiling at scale.** 83 operator hours at 10K cases and 833 at 100K under H1; the share is unmeasured and E03 calibration decides how much may auto-confirm.

## 7. Architectural change required at each scale

Figures from the section 6 model; bottleneck numbers from section 5.

| Scale | Binding constraint | Change |
| --- | --- | --- |
| 100 | Target's daily token halt (1.0 target-day); 2.2 h serial | None in the auditor: [F] 100 fixture cases cost it about 2 s. Size per-run caps above the reservation; pull the ledger; agree a day of target headroom; record real turn latency and tokens to replace the [A] values (L02). |
| 1K | 22.1 h serial and 10 target-days; one active run per target, scheduled occurrences skipped while busy (`repository.ts:204`) | Suite or batch submission (G02) instead of 1K sequential launches handling 409; a campaign budget above the per-run cap (no cross-run aggregate exists); worker liveness and queue age (O01); a TTL cache for the price catalog that keeps the max(latest, snapshot) rule; pre-execution dedup (G01); more target token budget or a multi-day schedule. Paginate the list routes before this point (B5). |
| 10K | 9.2 days serial; 200M target tokens (100 target-days) | Worker pool: claiming is `SKIP LOCKED`-safe (`repository.ts:610`), but each lane needs its own target row with a distinct synthetic user and chart pair (10 lanes for 24 h) [A: concurrent OpenEMR logins per user unverified]. Backpressure: per-target concurrency, queue depth cap, incomplete-rate circuit breaker. Local serving sized for parallel calls, or a paid Judge. Judge sampling only after E03 calibration. Paginated event reads (`repository.ts:604` returns all events), a coverage rollup and capped regression replays (B5, B6). |
| 100K | 91.9 days serial; 2.0B target tokens (1,000 target-days) | A ceiling, not a plan: only a budget-controlled campaign should approach it. Lanes across several target instances (23 lanes for 4 days; one instance would need 1,000 days); partitioned `events` plus archival of finished-run events to object storage keeping hashes in PostgreSQL; read replica for the UI; asynchronous batch Judge for regression suites (some `:batch` catalog rows are about half price, e.g. `claude-sonnet-5:batch` $1 / $5; compatibility with the synchronous endpoint the worker uses is unverified); campaign and daily ceilings enforced from settled charges; a review-capacity limit. Cut target turns before adding lanes. `GET /api/regressions` fails outright at this size (B5). |

## 8. Why cost is not tokens times runs

- **Target inference dominates.** With a cheap Judge, target-side inference is 1-3 orders of magnitude above auditor-side spend (section 6.3). Upgrading the Judge barely moves the total; one fewer target turn per case does.
- **Early exits still burn target tokens.** Denied, failed, truncated and partial cases skip the Judge but consumed turns. Incomplete outcomes must be rerun, multiplying cost by 1/(1-p); p is unmeasured live, and p = 10% gives x1.11 [A]; the model applies it to every row.
- **Failure holds spend.** Models are never retried (`models.ts:32-35`); the single target retry needs an explicit not-applied 409 (`session.ts:258`). An ambiguous paid call keeps its reservation and blocks further paid calls in that run (`repository.ts:579`), so failures reduce usable cap, not just add cost. Paid calls carry a 30-second deadline (`deadlines.ts:11`) and fail rather than reroute (`allow_fallbacks: false`, `models.ts:152`).
- **Scheduling is a cost.** One worker, one active run per target and a 1.5 s pause per cycle turn attempts into days (section 6.2); lanes cost target rows, synthetic users and target token budget, not auditor CPU (B1).
- **Resource bottlenecks appear before money does.** Reads that return everything (B5), a coverage scan of all history (B6) and event storage (B7) become the limit from about 10K runs, and the operator's review time (H1) from 1K.
- **Stagnation stop (A17, implemented).** An adaptive run now parks a category after 3 consecutive no-signal cases or 2 consecutive rejected/blocked proposals, records a `redirect` event, and records a `stop` when every category is parked (`STAGNATION` in `apps/worker/src/adaptive.ts`). Marginal cost after saturation therefore approaches zero, so cost grows sublinearly with campaign length; the thresholds are constants, not measured optima.
- **Deduplication reduces review, not execution.** G01 groups equivalent normalized attacks. That lets a campaign skip re-executing identical definitions against an unchanged target version, but execution cost stays linear in distinct definitions times versions, and repeated runs of the same definition still measure a nondeterministic target.
- **Regression suites are a fixed set, not exploration.** Cost is confirmed exploits times target versions times replicas, independent of the exploration budget. Illustration [A]: 50 confirmed exploits over 20 deploys is 1,000 cases, the 1K row.
- **Human review is the real ceiling at scale.** `pending_review` outcomes need an operator; the share is unmeasured, and E03 calibration decides how much may auto-confirm.

## 9. Regression SLO (fixture, wired into CI)

`npm run perf:slo` runs the SLO workload (100 sequential fixture cases, then one 25-replay regression suite) and fails the `fixture-validation` job on the default branch when a limit in `tests/performance/slo-definition.ts` is exceeded. **It is a measured threshold on local stand-ins, not a live claim.** Reference values are the median of five fresh-process runs at `6781412` (`fixture-baseline-100.json`, `repeatability`).

| Metric | Reference [F] | Tolerance | Limit | Tier |
| --- | --- | --- | --- | --- |
| Worker SQL statements per case | 64.2 | x1.25 | 81 | work count |
| Launch SQL statements per case | 9 | x1.25 | 12 | work count |
| Event rows per case | 6.65 | x1.25 | 9 | work count |
| Event bytes per case | 2,981 | x1.5 | 4,472 | work count |
| Statements per replay | 84.08 | x1.25 | 106 | work count |
| Target requests per case | 11.3 | x1.25 | 15 | work count |
| 100 sequential cases, wall | 1,921 ms | x30 | 57,630 ms | timed |
| Worker pass p95 | 22.82 ms | x30 | 685 ms | timed |
| 25-replay suite, wall | 453 ms | x30 | 13,590 ms | timed |
| Peak RSS | 374 MB | x2 | 748 MB | timed |

**Why the tolerances are what they are.** The work counts measure what the code does, not how fast the machine is: five fresh-process runs were identical to the last digit, so they cannot flake and carry the precise part of the SLO. The 25% allows a legitimate new audit row or check without failing main; an N+1, an extra round trip per event or a bloated event body moves them past it. The timed limits are deliberately coarse. The GitLab runner is a small shared 1 vCPU machine on which the fixture job already takes about ten minutes, and the reference came from a 32-thread workstation where PostgreSQL ran on other cores and a commit took about half a millisecond. Reasoning from the measured breakdown (9.7 ms Node CPU and 12.3 ms PostgreSQL wait per case, 7.2 ms of it commits) and assuming a core 4x slower, PostgreSQL CPU serialized with Node and 5-10 ms commit flushes (none measured), a case would take about 140-200 ms against the reference 19 ms: roughly 7-11x. The limits sit at 30x. An emulation with Node starved to a third of a core made the timed metrics 2.95x-3.60x slower and left 8.3x-10.2x of headroom; an uncontended local check (recorded in `slo-check-local.json`) passes with 29.7x-31.3x of headroom on the timed wall-clock metrics and 2.01x on memory. A timed-only breach is re-measured once on the same runner before the job fails, so a transient spike cannot fail the pipeline; a sustained slowdown still does (for example an added 0.5 s sleep per case would take 100 cases past 57.6 s).

**What it cannot do.** It cannot see a 2x wall-clock slowdown; the work counts and the recorded baseline are for that. It says nothing about live target or model latency. To change it, re-record the baseline, update the reference and let `tests/performance/slo.test.ts` name the limits that must move.

## 10. Actual development spend (measured, operator-provided)

**Measured over the development window Sep 24 - Oct 1, 2026 (about one week).** These are the operator's own usage-dashboard figures for the period, recorded as a labelled development-cost estimate: the cost to BUILD the auditor, separate from the runtime scenarios above. The auditor itself runs at $0 on local Ollama; this section is build cost only. The coding-agent figures are the full assistant usage for the window (this project was the primary work); any flat subscription is covered by those metered estimates. Amounts are rounded.

| Item | Source of truth | Period | Amount (USD) | Evidence |
| --- | --- | --- | --- | --- |
| Coding agent: Codex | Codex usage dashboard | Sep 24 - Oct 1, 2026 | 289.36 | 17 sessions, 511M tokens |
| Coding agent: Claude Code | Claude Code usage dashboard | Sep 24 - Oct 1, 2026 | 1,836.39 | 40 sessions, 6.51B tokens; about $17,905 of cache savings was not charged |
| OpenRouter, all development keys | OpenRouter activity (agent-forge key) | Sep 24 - Oct 1, 2026 | 26.02 | 9K requests, 29.1M tokens, blended $0.90 per 1M |
| Of which auditor ledger (settled) | SQL below | Sep 24 - Oct 1, 2026 | about 0 (subset of OpenRouter) | Live auditor roles ran on local Ollama ($0); the paid L03 escalation was cents |
| Target-side model spend from test traffic | Target operator's account | Sep 24 - Oct 1, 2026 | not separately billed | Synthetic LAN target; no separate invoice |
| Infrastructure: DigitalOcean droplets and snapshots | DigitalOcean usage | Sep 24 - Oct 1, 2026 | about 7 | About $1.05/day over the window (hosted droplet and snapshots; includes the CI runner) |
| Auditor host, local GPU, backups, other | Own records | Sep 24 - Oct 1, 2026 | 0 (not metered) | Runs on the local LAN host; electricity not counted |
| **Total** | | Sep 24 - Oct 1, 2026 | **about 2,159** | Coding-agent usage is about 98 percent of it |

The auditor ledger covers only worker calls; it excludes coding agents, target-side inference and infrastructure. Run it in `docker compose exec db psql -U auditor -d auditor`; a `reserved_usd` figure on an `unresolved` row is an upper bound, not a charge, and must be reconciled against OpenRouter activity (M02).

```sql
SELECT provider, role, model, status, count(*) AS calls,
       sum(charge_nanos)/1e9 AS charged_usd, sum(reserved_nanos)/1e9 AS reserved_usd,
       sum(input_tokens) AS in_tokens, sum(output_tokens) AS out_tokens
FROM model_calls GROUP BY 1,2,3,4 ORDER BY 1,2,3,4;
SELECT count(*) AS target_turns FROM events WHERE event->>'agent'='target' AND event->>'kind'='turn';
```

## 11. Not verified

- Target per-turn tokens and latency; whether the deployed limits match the brief; the `/ready` provider string.
- Whether opening a chart or conversation triggers a target-side pre-visit brief model call. The auditor never requests one; if server-triggered, add one Sonnet call per session.
- `qwen3-coder:30b` throughput and variant on the operator's host (`ollama show`), and its parallel-request capacity.
- Concurrent logins per synthetic user; OpenRouter rate limits; `:batch` endpoint compatibility.
- Real Orchestrator, Red Team and Judge token use and event sizes; the ledger has them after a run.
- Live orchestration latency, live throughput, live failure and unusable-attempt rates (W2, W3) and live storage per case: the fixture baseline says nothing about them. L02 / HDX-37 is the run that would.
- Commit latency and core speed on the GitLab runner; the SLO's timed limits rest on stated assumptions about them, not measurements.
- PostgreSQL server CPU and memory per case (client-observed wait only), and the cause of the slow RSS creep in a long-lived process.
- The index gains were measured on uniform synthetic data with a warm cache; real skew and cold reads differ.
