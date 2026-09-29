# AI cost analysis and scale plan

**Status:** early-submission draft for P01 / HDX-32. Basis: source at `cca4c66` and the public OpenRouter catalog retrieved **2026-09-29 21:07 UTC** (unauthenticated `GET https://openrouter.ai/api/v1/models`, 464 rows; no API key, no paid call). No live run or fixture benchmark produced any figure below. The measured fixture baseline and CI SLO (P01) and the authorized 100-case live baseline (L02) remain open.

Labels: **[M]** verified in code or the catalog snapshot; **[E]** estimate from a stated basis; **[A]** planning assumption to replace with a measurement; **TODO** operator input.

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

## 4. Auditor-side cost by scenario

Adaptive mix unless noted; (b) is Judge-only and therefore also the cost of selected or regression runs with a paid Judge. Totals are [E]: planning tokens times snapshot prices.

| Scenario | Per case | 100 | 1K | 10K | 100K |
| --- | --- | --- | --- | --- | --- |
| (a) All local (Ollama `qwen3-coder:30b`) | $0 inference | $0 + 1.9-2.4 h host | $0 + 19-24 h | $0 + 194-236 h | $0 + 1,944-2,361 h |
| (b) Local Orchestrator/Red Team, paid Judge: gpt-oss-120b | $0.00018 | $0.02 | $0.18 | $1.79 | $17.90 |
| (b) kimi-k2-0905 | $0.0028 | $0.28 | $2.80 | $28 | $280 |
| (b) mistral-medium-3-5 | $0.0075 | $0.75 | $7.50 | $75 | $750 |
| (c) All paid: gpt-oss-120b | $0.00044 | $0.04 | $0.44 | $4.42 | $44 |
| (c) kimi-k2-0905 | $0.00695 | $0.70 | $6.95 | $70 | $695 |
| (c) mistral-medium-3-5 | $0.0185 | $1.85 | $18.45 | $185 | $1,845 |
| Reference: Sonnet-5-priced, not dispatchable | $0.0246 | $2.46 | $24.60 | $246 | $2,460 |

Scenario (a) shifts cost to hardware: hours times the operator's host price per hour (**TODO**, no hardware price is assumed here). Throughput of `qwen3-coder:30b` on that host is unmeasured; the per-call deadline is 90 seconds (`deadlines.ts:10`). A maximal Judge packet with 4,096 output tokens costs about 10 times the planning Judge call in every priced row.

## 5. Capacity, target cost and storage

Current concurrency [M]: one worker loop runs one run at a time with a 1.5-second pause after each (`main.ts:8-12`), and a target admits one active run (`repository.ts:418,445`). Wall-clock assumes 3 s setup, 25.5 s per turn (deadline 90 s), 15 s local Judge, 5 s paid Judge, 12 s local Red Team, and 2-4 s for the Orchestrator and catalog fetch [A]: about 70 s per case with a paid Judge, 85 s all-local.

| Cases | Serial wall-clock [E] | Target tokens; days at 2M/day on one instance [E] | Target-side inference at planning turn (range) [E] | `events` storage: 25 KB per case (8-130 KB) [E] | Adaptive model calls, all paid | Catalog download |
| --- | --- | --- | --- | --- | --- | --- |
| 100 | 1.9-2.4 h | 1.8M; 0.9 | $5 ($1-17) | 2.4 MB | 300 | 0.2 GB |
| 1K | 19-24 h | 18M; 9 | $52 ($13-168) | 24 MB | 3K | 2.2 GB |
| 10K | 8-10 days | 180M; 90 | $520 ($130-1,680) | 244 MB | 30K | 22 GB |
| 100K | 81-98 days | 1.8B; 900 | $5,200 ($1,300-16,800) | 2.4 GB (0.8-13 GB) | 300K | 223 GB |

Assumptions: 2 turns per case (the ten starter-matrix variants average 1.3, none attach a PDF) at 9,000 target tokens per turn; the low range is 1 turn at $0.013, the high range 3 turns at $0.056. Storage assumes the observation-heavy turn event dominates; the parser's hard cap is 256,000 bytes per turn body (`session.ts:5`). Synthetic PDFs are stored once per case (20 MiB lab, 10 MiB intake limits, `artifacts.ts:27`) and referenced by hash, so they add nothing per run on the auditor side.

**Two binding constraints appear before any auditor limit.** At 18K tokens per case, the target's 2M-token daily halt allows about **110 cases per day per instance**, roughly ten times fewer than one serial worker can send (about 1,200). One hundred cases already consume a day. Cases per day per target is approximately 2,000,000 divided by turns per case times tokens per turn. Whether the deployed target sets the brief's limits is unverified.

## 6. Architectural change required at each scale

| Scale | Binding constraint | Change |
| --- | --- | --- |
| 100 | Target's daily token halt | None in the auditor. Size per-run caps above the reservation; pull the ledger; agree a day of target headroom; record real turn latency and tokens to replace [A] values (P01, L02). |
| 1K | About a day serial and about 9 target-days; one active run per target, scheduled occurrences skipped while busy (`repository.ts:204`) | Suite or batch submission (G02) instead of 1K sequential launches handling 409; a campaign budget above the per-run cap (no cross-run aggregate exists); worker liveness and queue age (O01); a TTL cache for the price catalog that keeps the max(latest, snapshot) rule; pre-execution dedup (G01); more target token budget or a multi-day schedule. |
| 10K | 8-10 days serial; 180M target tokens | Worker pool: claiming is `SKIP LOCKED`-safe (`repository.ts:610`), but each lane needs its own target row with a distinct synthetic user and chart pair (about 9 lanes for 24 h) [A: concurrent OpenEMR logins per user unverified]. Backpressure: per-target concurrency, queue depth cap, incomplete-rate circuit breaker. Local serving sized for parallel calls, or a paid Judge. Judge sampling only after E03 calibration. Paginated event reads (`repository.ts:604` returns all events). |
| 100K | About 81-98 days serial; 1.8B target tokens | A ceiling, not a plan: only a budget-controlled campaign should approach it. Lanes across several target instances (about 22 lanes for 4 days; one instance would need about 900 days); partitioned `events` plus archival of finished-run events to object storage keeping hashes in PostgreSQL; read replica for the UI; asynchronous batch Judge for regression suites (some `:batch` catalog rows are about half price, e.g. `claude-sonnet-5:batch` $1 / $5; compatibility with the synchronous endpoint the worker uses is unverified); campaign and daily ceilings enforced from settled charges; a review-capacity limit. Cut target turns before adding lanes. |

## 7. Why cost is not tokens times runs

- **Target inference dominates.** With a cheap Judge, target-side inference is 1-3 orders of magnitude above auditor-side spend. Upgrading the Judge barely moves the total; one fewer target turn per case does.
- **Early exits still burn target tokens.** Denied, failed, truncated and partial cases skip the Judge but consumed turns. Incomplete outcomes must be rerun, multiplying cost by 1/(1-p); p is unmeasured, and p = 10% gives x1.11 [A].
- **Failure holds spend.** Models are never retried (`models.ts:32-35`); the single target retry needs an explicit not-applied 409 (`session.ts:258`). An ambiguous paid call keeps its reservation and blocks further paid calls in that run (`repository.ts:579`), so failures reduce usable cap, not just add cost. Paid calls carry a 30-second deadline (`deadlines.ts:11`) and fail rather than reroute (`allow_fallbacks: false`, `models.ts:152`).
- **Stagnation stop is planned, not implemented.** Adaptive runs today stop only on the case or minute bound, a stop request, an incomplete case or an unresolved charge (`adaptive.ts:60,105,117`); the Orchestrator balances categories (`chooseGap`) but does not detect no-signal spend. A17 adds that. Once present, marginal cost after saturation approaches zero, so cost grows sublinearly with campaign length.
- **Deduplication reduces review, not execution.** G01 groups equivalent normalized attacks. That lets a campaign skip re-executing identical definitions against an unchanged target version, but execution cost stays linear in distinct definitions times versions, and repeated runs of the same definition still measure a nondeterministic target.
- **Regression suites are a fixed set, not exploration.** Cost is confirmed exploits times target versions times replicas, independent of the exploration budget. Illustration [A]: 50 confirmed exploits over 20 deploys is 1,000 cases, the 1K row.
- **Human review is the real ceiling at scale.** `pending_review` outcomes need an operator; the share is unmeasured, and E03 calibration decides how much may auto-confirm.

## 8. Actual development spend (operator input)

Nothing below is measured. Do not fill it from estimates.

| Item | Source of truth | Period | Amount (USD) | Evidence |
| --- | --- | --- | --- | --- |
| Coding agent: Codex | Vendor billing or usage export | TODO | TODO | TODO |
| Coding agent: Claude Code | Vendor billing or usage export | TODO | TODO | TODO |
| OpenRouter, all development keys | OpenRouter activity/billing page | TODO | TODO | TODO |
| Of which auditor ledger (settled) | SQL below | TODO | TODO | TODO |
| Target-side model spend from test traffic | Target operator's OpenRouter account or Langfuse | TODO | TODO | TODO |
| Target droplet | Hosting invoice | TODO | TODO | TODO |
| Auditor host, local GPU, backups, other | Own records | TODO | TODO | TODO |
| **Total** | | | TODO | |

The auditor ledger covers only worker calls; it excludes coding agents, target-side inference and infrastructure. Run it in `docker compose exec db psql -U auditor -d auditor`; a `reserved_usd` figure on an `unresolved` row is an upper bound, not a charge, and must be reconciled against OpenRouter activity (M02).

```sql
SELECT provider, role, model, status, count(*) AS calls,
       sum(charge_nanos)/1e9 AS charged_usd, sum(reserved_nanos)/1e9 AS reserved_usd,
       sum(input_tokens) AS in_tokens, sum(output_tokens) AS out_tokens
FROM model_calls GROUP BY 1,2,3,4 ORDER BY 1,2,3,4;
SELECT count(*) AS target_turns FROM events WHERE event->>'agent'='target' AND event->>'kind'='turn';
```

## 9. Not verified

- Target per-turn tokens and latency; whether the deployed limits match the brief; the `/ready` provider string.
- Whether opening a chart or conversation triggers a target-side pre-visit brief model call. The auditor never requests one; if server-triggered, add one Sonnet call per session.
- `qwen3-coder:30b` throughput and variant on the operator's host (`ollama show`), and its parallel-request capacity.
- Concurrent logins per synthetic user; OpenRouter rate limits; `:batch` endpoint compatibility.
- Real Orchestrator, Red Team and Judge token use and event sizes; the ledger has them after a run.
- `ARCHITECTURE.md` still describes a 15-second target deadline and fixed 30-second model timeout, while `deadlines.ts:4-11` sets per-operation limits. This document follows the code.
