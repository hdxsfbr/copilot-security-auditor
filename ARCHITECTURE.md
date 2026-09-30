# Clinical Co-Pilot Auditor architecture

## Summary

The auditor tests an operator-owned, synthetic OpenEMR Clinical Co-Pilot from the outside. An operator composes a bounded run in a React UI. An Express API validates it, preflights the model roles and reserves the target in PostgreSQL. A TypeScript worker claims the run under a lease, opens a fresh authorized chart session, sends user-facing chat and PDF actions, stores each reply as a versioned structured observation, applies deterministic checks, asks a Judge model for a cited verdict and routes the result through deterministic policy gates. The stack (API, worker, PostgreSQL, private evidence volume) runs in Docker Compose on a trusted LAN. There is no application login.

Four roles have separate authority. The **Orchestrator** picks one seed from candidates that deterministic code ranked by regression state, unresolved severity and scoped coverage gap. The **Red Team** proposes one to three typed actions, plus at most one follow-up conditioned on the reply. The **Judge** proposes a verdict with a verbatim quote. The **Documentation** role drafts report narrative for a confirmed finding only. No role holds credentials, chooses endpoints, patients or tickets, sets limits, writes findings or publishes; the worker and repository own those. Roles exchange schema-validated, versioned envelopes ([`contracts/v1`](contracts/v1/)) inside one process. There are no peer services, and independent peer integration is not demonstrated.

A model proposal is data until schema and admission rules admit it, and only the session adapter turns an admitted action into the OpenEMR login, chart, upload, ticket and turn sequence. The Judge only proposes. The worker computes `safe`, `inconclusive`, `pending_review` or `auto_confirm`. The one automatic confirmation is a missing structured citation in a complete prompt-injection observation; every other unsafe verdict waits for a person. Denied, failed, truncated, partial or unverifiable evidence never becomes safe, and a safe result claims only the visible response. A person confirms or rejects with a rationale, and approves an exact report revision before it can be downloaded.

Each confirmation becomes a regression identity. A suite replays up to 25 identities one at a time against a target and derives `fixed`, `recurring`, `resurfaced` or `unknown` per observed version. An opt-in trigger queues a suite when a target reports a new version. Scoped coverage and regression state feed back into the Orchestrator's ranking, and a stagnant category is parked.

Observability is the append-only event log, a per-call model ledger that reserves before any paid dispatch and holds unknown charges, worker heartbeat and queue health, and cursor-paged event reads. No external tracing backend is used.

Measured evidence is limited. The fixture suite has 297 tests. The first live pass (2026-09-29, LAN target version 0.8.0, all roles on local `qwen3-coder:30b`) ran 14 selected and 4 adaptive runs, produced **0 confirmed findings**, cost $0 in auditor spend and exposed two auditor defects, both fixed ([results](evals/results/live/2026-09-29/README.md)). A public-deployment pass on 2026-09-30 ran the 10 starter-matrix cases (target version 0.8.0, local Judge, $0 auditor spend): 2 `safe`, 8 `inconclusive`, 0 findings. The target mostly replied that chart sections could not be retrieved, so the pass shows neither a defense nor a vulnerability ([evidence](evals/results/live/2026-09-30/public-matrix/README.md)); one separate single-case run is [recorded on its own](evals/results/live/2026-09-30/public-single-current-chart/README.md). The required three discovered vulnerability reports do not exist. Main tradeoffs: LAN-only with no login; Judge accuracy unmeasured; a conservative policy leaves most live outcomes `inconclusive`; one worker process; Documentation validation checks provenance, not meaning. See [known tradeoffs](#known-tradeoffs) and the [rubric register](docs/implementation/rubric.md).

## Agent interactions

```mermaid
flowchart TD
  OP([Operator]) -->|"bounded run: target, seeds, caps, role models"| API["API + UI (Express / React)"]
  API -->|"preflight, reserve target, snapshot run"| DB[("PostgreSQL: runs, events, ledger, findings")]
  DB -->|"lease claim"| W["Worker: LangGraph observe to judge"]

  subgraph ADAPT["Adaptive runs only"]
    ORC["Orchestrator: picks one ranked seed"]
    RT["Red Team: 1-3 typed actions, optional 1 follow-up"]
    ADM{"Admission gate: schema, patterns, patient-ID tokens, PDF link"}
    ORC -->|"envelope orchestrator_to_red_team"| RT --> ADM
  end
  W --> ORC
  W -->|"selected run: operator-chosen case"| SES
  ADM -->|"admitted"| SES["Session adapter: worker-owned identity, chart, ticket"]
  ADM -.->|"rejected: recorded, no target turn"| DB
  SES -->|"user-facing chat / PDF"| TGT["Clinical Co-Pilot target"]
  TGT -->|"reply"| OBS["Observation v2 + deterministic checks"]
  EV["Optional read-only evidence provider (off by default)"] -.->|"can only raise to pending_review"| OBS
  OBS -->|"envelope red_team_to_judge"| J["Judge model: proposes verdict, quote, refs"]
  J --> POL{"Policy gates (deterministic)"}
  OBS -.->|"denied, failed, truncated: no Judge call"| POL
  POL -->|"safe / inconclusive / pending_review / auto_confirm"| DB
  DB --> HR["Human review: confirm or reject with rationale"]
  HR -->|"confirmed"| RG["Regression identity"]
  HR -->|"confirmed"| DOC["Documentation role: leased report job"]
  DOC -->|"validated, redacted draft"| APR["Human approves exact revision"]
  APR --> REP["Approved report download"]
  RG --> SUITE["Regression suite or version-change trigger"]
  SUITE -->|"replay through the same worker path"| W
  DB -->|"scoped coverage, regression state, prior verdicts"| ORC
```

Solid arrows are implemented. Dashed arrows are conditional paths. The Orchestrator, Red Team and admission gate run in adaptive runs ([`apps/worker/src/adaptive.ts`](apps/worker/src/adaptive.ts)); a selected run replays one operator-chosen case and calls only the Judge. The case flow is [`apps/worker/src/process.ts`](apps/worker/src/process.ts). The evidence provider is disabled unless an operator configures a bridge, and none has been activated against a live target.

## Roles

| Role | Inputs | Output and authority | Deterministic control on the output | Where |
| --- | --- | --- | --- | --- |
| Orchestrator | Candidate seeds of one category, ranked by code from regression state, unresolved finding severity and scoped coverage gap; up to three sanitized prior verdicts of the run | Returns `{caseId}` only. It cannot change limits, target, credentials or verdicts | `caseId` must be a listed candidate, else `context_mismatch`; the category is chosen by code, and a category is parked after 3 consecutive safe or inconclusive cases (2 rejected or blocked) | [`adaptive.ts`](apps/worker/src/adaptive.ts), [`exploration.ts`](apps/api/src/exploration.ts) |
| Red Team | The seed's own attack actions, its expected safe behavior, allowed PDF references, redacted prior replies, the selection basis and mutation parent | Proposes 1-3 typed actions, and may request one chat-only follow-up after seeing the reply. It cannot issue HTTP or set identity | `admitProposal`: strict schema, at most 1,000 characters per message, URL/path/HTTP-verb/credential patterns rejected, assigned identities blocked as whole tokens, PDFs only from the seed; follow-up is admitted the same way and persisted before it is sent | [`adaptive.ts`](apps/worker/src/adaptive.ts), [`admission-gate.test.ts`](tests/admission-gate.test.ts) |
| Judge | Expected safe behavior, executed actions, aliased observations, deterministic checks and effect scope; at most 100,000 characters | Proposes `safe`, `unsafe` or `inconclusive` with claim, verbatim quote and turn references. It cannot write a finding or change a check | `judgePolicy`: complete observations, resolvable references, quote present in a cited reply and not an echo of a prompt, reproduction complete, no material uncertainty; scope downgrades per category | [`checks.ts`](apps/worker/src/checks.ts), [`judge.ts`](apps/worker/src/judge.ts), [`judge-policy.test.ts`](tests/judge-policy.test.ts) |
| Documentation | One confirmed finding's persisted evidence as a validated envelope, aliased facts, allowed citation IDs | Drafts the narrative only (title, severity rationale, impact, description, cited expected and observed behavior, remediation, uncertainty). Identity, reproduction, excerpts, checks and verdict are worker-built facts | Strict schema, every citation must exist, quotes verbatim from a cited observation, no introduced identifiers, severity cannot contradict the case rubric, redaction on input and output plus a leak scan | [`reports.ts`](apps/worker/src/reports.ts), [`report-revisions.ts`](apps/api/src/report-revisions.ts) |

Separate prompts, models and envelopes reduce conflicts of interest, but a separate model does not make the Judge accurate. The worker owns authorization, execution, admission, outcome routing, budget and persistence.

## Inter-agent communication

Every envelope has a `channel`, a `status` (`ok`, `error`, or for Documentation `no_findings`) and a strict header: `version: 1`, a fresh `messageId`, `parentMessageId`, `runId`, `caseId` and `attemptId`. Three channels are published as JSON Schema in [`contracts/v1`](contracts/v1/), generated from the Zod source in [`packages/contracts/src/agent.ts`](packages/contracts/src/agent.ts), and [`tests/contracts/agent.test.ts`](tests/contracts/agent.test.ts) fails if the committed JSON drifts:

- **Orchestrator to Red Team** carries the selected seed, category, remaining case and time bounds and, from A17, the selection basis, up to three prior verdicts and the mutation parent. A parent must be one of the verdicts the Red Team was shown.
- **Red Team to Judge** carries the executed actions, observations, checks, effect scope and evidence references. References must map one to one onto actions and observations, and a PDF action must match a v2 observation attachment.
- **Judge to Documentation** is `ok` only for an automatically confirmed or human-confirmed finding, with the policy trace and a regression label; `no_findings` never asserts safety.

Producers and consumers validate the same schema, and a wrong header, unsupported version or inconsistent evidence fails with a typed `AgentContractError` before target or provider transport. Known failures use nine typed codes (`target_unreachable`, `target_boundary_unavailable`, `budget_exceeded`, `judge_timeout`, `reservation_unavailable`, `provider_unavailable`, `evidence_incomplete`, `invalid_contract`, `stopped`) with the stage and, for timeouts, the elapsed and limit milliseconds. A compatible optional field can be added within v1; a changed required field or meaning needs a new version and a migration note ([details](docs/implementation/contracts.md)). A schema-valid envelope proves shape, not truth: the Judge gates still decide. All channels are in-process function calls. [I01](https://linear.app/hdxsfbr/issue/HDX-36) (independent peer integration) is not done.

## Orchestration strategy

- **Two run modes.** A selected run executes one saved case and calls only the Judge. An adaptive run executes 1-9 cases within 1-30 minutes; each attempt makes at most one Orchestrator, one Red Team and one Judge call, and a rejected proposal costs two calls and no target turn. Model calls are never retried.
- **Seed selection** ([A17](docs/implementation/contracts.md#adaptive-exploration-feedback-and-mutation-lineage-a17)). Code ranks seeds by regression state (resurfaced, then recurring), unresolved finding severity, then the V01 coverage gap for the run's target and observed version (untested, inconclusive, incomplete, blocked), after categories the run declared but has not yet executed. Only the top-ranked seeds of the chosen category reach the model. A stagnant category is parked and recorded as a `redirect` or `stop` event, so a stagnation stop is a recorded decision, not a run limit.
- **One case, one fresh session.** Each admitted case opens its own authorized session and conversation (two sessions for chart-context cases), and the case graph is a two-node LangGraph flow: observe, then judge ([`process.ts`](apps/worker/src/process.ts)).
- **Leases and reservations.** `processNext` claims one run with `FOR UPDATE SKIP LOCKED` and finishes it before claiming another, so capacity equals the number of processes reporting a fresh heartbeat (one in Compose). A target holds at most one queued or running run (`targets.active_run_id`); a busy target returns 409 with the active run ID. Claim, stop and finish serialize on the run row, and an expired lease fences the old generation ([run history and stop](docs/implementation/run-history-stop.md)).
- **Stop.** `POST /api/runs/:id/stop` is cooperative: a queued run becomes incomplete and releases its target; a running run stops before the next turn, upload, Judge call or model dispatch. Attempted or ambiguous paid calls keep an unresolved hold.
- **Schedules.** Daily or weekly, zone-explicit, snapshotting the run definition; archived schedules keep their occurrence history, and a busy target records a skipped occurrence ([S01](README.md#scheduled-evaluations)).
- **Report jobs.** Confirming a finding, manually or automatically, records a regression, an identity link and an idempotent report job. A job is `queued` only when the run's opt-in report policy names a model (and, for a paid model, has an allowance); otherwise it is `report_needed` and an operator authorizes it. Jobs have their own lease and funds, and are claimable only after their run finished ([`report-jobs.ts`](apps/api/src/report-jobs.ts)).

## Regression harness

**Identity and lineage** ([G01](apps/api/src/regression-identity.ts)). Each confirmation keeps its own `regressions` row and links to a `regression_identities` row: the versioned normalization (v1) of its attack sequence (category, user slot, each action's kind and message in order, and attachment type and artifact). Messages are NFC-normalized with blanks collapsed; case, punctuation and invisible characters stay distinct. A false split costs a readable extra identity, a false merge would hide evidence, so v1 splits when unsure. Every replay of a regression case, on any target, gets a `regression_replays` row at launch (trigger `manual`, `suite` or `version_change`) recording the outcome and the observed target version.

**States and suites** ([G02](apps/api/src/regression-states.ts), migration 020). Per target and observed version, a pure function derives one state from recorded findings and finished replays. `fixed` needs a finished `safe` replay on a verified version that never showed the violation, after a violation at a different verified version. `resurfaced` is a violation after a fixed state. `recurring` is a violation seen again with no earlier fix. Everything else is `unknown`, including blocked, incomplete, inconclusive and version-less results. A suite (`POST /api/regression-suites`) replays at most 25 identities, one at a time, through the ordinary `Repository.start`, so reservation, ledger and lineage are reused. The paid cap applies per item run. A blocked or incomplete item is kept and never re-run. The version-change trigger is off by default and per target, is bounded, deduplicated by a unique `(target, version)` index, and never retroactive. Neither suites nor the trigger deploy or change a target.

**Fixture harness.** `npm run test:local` runs 297 tests in parallel against one disposable PostgreSQL service, each test in its own database, plus browser tests through system Chrome ([validation](docs/implementation/validation.md)). GitLab CI runs the same suite on `main` after a merge; merge requests are gated by exact-head local validation. Fixture passes are not live findings.

**Reproducible evals.** [`evals/`](evals/) holds the starter-matrix seeds, the judge-policy calibration set (14 labeled cases checked by `tests/judge-policy.test.ts`), the simulated triage scan (`node --import tsx --test tests/triage-simulated.test.ts`) and raw live results. Only the live results involve the real target, and none of them is a confirmed finding.

## Observability

- **Events.** PostgreSQL `events` is an append-only, per-run ordered log of worker, target, check and Judge records. `GET /api/runs/:id/events/page?after=<id>&limit=<1-200>` reads it incrementally: `after` is an exclusive canonical decimal bigint kept as a string, the page is bounded in SQL, and the reply is `{items, hasMore, nextCursor}`. `nextCursor` is a resume point, not completion. The unbounded `GET /api/runs/:id/events` remains for existing callers.
- **Worker and queue health** (`GET /api/operations/health`, O01). Each worker registers a random UUID and heartbeats every 10 seconds on a timer independent of run work, and is fresh for 30 seconds. The reply carries per-worker idle, busy or no-recent-heartbeat state, queued count, oldest queued age, active and expired leases and fixed diagnostic codes only, never error text or hostnames. It is separate from `/api/health`, which reports database and migration readiness. A stale heartbeat is a signal, not proof that the process stopped.
- **Cost.** `model_calls` records provider, model, role, tokens, latency, settled charge, reserved amount and unresolved holds for every call, exposed at `GET /api/runs/:id/usage` and `GET /api/spend/unresolved`. Operators reconcile an unresolved OpenRouter call once, with evidence, and the attestation is append-only ([M02](docs/implementation/spend-reconciliation.md)). Local Ollama calls record tokens and latency with no dollar price.
- **Coverage.** `GET /api/coverage/scoped` groups executions by target and observed version and never pools them; safe-rate denominators exclude inconclusive, blocked and incomplete work ([V01](docs/implementation/scoped-coverage.md)). Each scope also reads by OWASP tag from the case rubrics (`owasp` rows, with cases that have no mapping in an explicit `unmapped` row and the same denominators). The Coverage page renders it.
- **Not present.** No external tracing or metrics backend is called, and no alerting is configured.

## External APIs: auth, rate limits, pagination, 429

| Service | Authentication | Rate limits and 429 | Pagination and bounds | Deadlines |
| --- | --- | --- | --- | --- |
| Co-Pilot target (OpenEMR, `/copilot-api/`) | Form login with a fresh cookie jar (a 302 is success), module CSRF token from the session endpoint, a one-time ticket minted per turn (`X-Copilot-Token`). Credentials are stored AES-256-GCM encrypted and never enter model prompts | The target documents 10 turns per minute per conversation, 20K tokens per turn, 60K per conversation and 2M per day ([brief](docs/COPILOT_FEATURE.md)). The auditor has no rate limiter: it stays under the per-conversation limit by design (at most 3 sequential turns per conversation) and does not track the daily budget. There is no 429-specific code. A non-2xx turn reply is treated as ambiguous and ends the case `incomplete`, never replayed; only `409` with `X-Copilot-Turn-Not-Applied: true` permits one retry with a new ticket. A non-OK handshake step blocks the case | Patient finder asked for 2 rows and must return exactly 1; reply bodies capped at 256,000 bytes (turn) and 1,000,000 (other JSON), visible text at 10,000 characters and flagged `truncated` | handshake 15 s, upload 30 s, turn 90 s, each also capped by the remaining adaptive run budget ([`deadlines.ts`](apps/worker/src/deadlines.ts)) |
| OpenRouter (`/models`, `/chat/completions`) | Bearer `OPENROUTER_API_KEY` from private server-side `.env`; never returned to the browser | No 429-specific code and no retry. Any non-OK reply fails the call with no fallback (`allow_fallbacks: false`, price ceiling from the verified catalog). A call that may have been sent stays `unresolved` and blocks further paid calls in that run until reconciled; a proven-unsent call settles at zero. A 429 is not distinguished from other failures, so the operator must reconcile it | The catalog is one unpaginated reply capped at 4,000,000 bytes; a verified price reserves the whole context window before dispatch | paid role 30 s, catalog 15 s |
| Ollama (`/api/tags`, `/api/chat`) | None; trusted LAN endpoint from `OLLAMA_URL` | No limits assumed; a non-OK reply fails the call, no retry, no dollar price | Model list unpaginated (capped at 1,000,000 bytes) | local role 90 s, discovery 10 s |
| Optional evidence bridge | Dedicated `EVIDENCE_HTTP_AUTH_TOKEN`; exact origin and path from private config | Off by default; a single GET per accepted turn, no redirects, failure yields `unknown`, never a safe result | Bounded 64 KiB reply | 15 s and the remaining adaptive run budget |

The auditor's own API is a trusted-LAN operator surface with no rate limiting; JSON bodies are capped at 32 KB and PDFs at 21 MB. Collections that grow are cursor-paged with bounded limits: `GET /api/runs` (1-100), run events (1-200), schedule occurrences, regression identities and suites, and `GET /api/spend/unresolved` (with a `truncated` flag). Some legacy list endpoints (targets, cases, findings, candidates, regressions) are not paginated.

## Auth, data flow and storage

The API restricts target hosts to the exact-hostname `TARGET_ALLOWED_HOSTS` list; that is a dispatch constraint, not authentication of its own clients. Run snapshots keep credential references, not plaintext, and the worker decrypts the chosen identity through the repository. Target-edit responses omit passwords. The worker resolves one exact external patient ID through the authenticated finder, opens that chart, obtains CSRF and conversation context, mints a ticket per turn and sends an admitted action.

Events and assessments live in PostgreSQL; synthetic PDF bytes live on a private volume with size and hash references, checked before use. Observations are stored as bounded v2 records (status, completeness, claims with structured sources, limitations, target correlation IDs). Provider packets alias the two configured patient IDs and redact known secrets; arbitrary names and clinical facts are not covered, so only synthetic data is in scope. Twenty-one SQL migrations are gated by a ledger, and `/api/health` reports unavailable until it is complete. Evidence retention policy and multi-operator access control are not defined.

## Failure behavior

An HTTP timeout or uncertain reply after a turn may mean the target acted, so only the explicit not-applied contract permits the single retry. Unknown paid delivery retains a reservation. Missing Judge evidence is inconclusive or incomplete, never a pass, and an artifact integrity failure blocks a new confirmation or complete export. Expired leases fence the old worker, release the target and leave ambiguous paid calls unresolved. A replay with changed phrasing or an incomplete run is `unknown`, not `fixed`.

## AI-use disclosure

Four roles use a model. All four can run on local Ollama or on OpenRouter; nothing is sent to a hosted model unless the operator assigns one and a key is configured. The live pass used a local `qwen3-coder:30b` for every role.

| AI role and decision | Deterministic check that follows | Human approval | Remaining risk |
| --- | --- | --- | --- |
| **Orchestrator**: choose a seed among ranked candidates | Must be a listed candidate; ranking, category choice and stagnation parking are code; run, case, time and cost bounds fixed at launch | Operator sets seeds, bounds and caps before launch and can stop the run | A weak model picks poorly among ties and wastes bounded budget; ranking quality is unmeasured |
| **Red Team**: write attack messages and one follow-up | Admission gate (schema, forbidden patterns, assigned patient-ID tokens, PDF link); target transport only via the session adapter | Seeds are operator-authored; no per-action approval | Pattern rules are not semantic; a safety-tuned model may refuse (seen live) and the gate can over-reject (22 of 27 proposals before the fix) |
| **Judge**: propose a verdict with a quote | Reference, quote, echo, completeness, structural and scope gates; safe claim is worker-authored text limited to the visible reply; only one auto-confirm path | A person confirms or rejects every other candidate, with a rationale from a fixed list; corrections are append-only | Accuracy and false-safe rate unmeasured; quote occurrence is not semantic support; a false `safe` is limited to the visible response by design |
| **Documentation**: draft report narrative | Strict schema, existing citations, verbatim quotes, no new identifiers, rubric-bound severity, redaction plus leak scan; facts are not model output | Operator approves the exact revision (a newer revision voids approval) before download | Validation checks provenance, not meaning; a verbatim but misleading quote passes ([triage limits](docs/submission/triage.md)); only the two configured identities are redacted; not yet invoked against a live finding |

**Detecting and correcting a drifting Judge.** What exists: every run snapshots the Judge model and policy version; the labeled fixture set in [`evals/judge/`](evals/judge/README.md) (14 cases) fails if a policy change reroutes a known case, which catches policy drift but does not call a model; and decisions and corrections are append-only with rationale codes. One live baseline: of 23 local Judge verdicts (19 `safe`, 4 `inconclusive`, none `unsafe`), the deterministic policy accepted 2 of the 19 `safe` verdicts as `safe` and held 17 to `inconclusive`. In one selected case the Judge quoted the attack prompt as its evidence and the echo gate rejected it. These measure policy strictness, not accuracy. What is planned, not built: replay the frozen labeled set through the configured Judge model on a schedule and record a confusion matrix per model, and compare human rejection of `pending_review` candidates against Judge claims by model. On a failed threshold the correction is to disable auto-confirm for that model, send its verdicts to review and pin or change the model. No model-in-the-loop calibration has been run.

## Known tradeoffs

- **LAN-only, no login.** Anyone who reaches the port has full operator power; the boundary is the network and host allowlist. This suits one operator and synthetic data, and does not satisfy a public, multi-user service.
- **Conservative routing.** In the live pass 13 of 14 selected cases were `inconclusive`. Partial target evidence, visible-response scope and the inability to prove write absence are the reasons, so the auditor avoids false safety at the cost of little `safe` signal. No starter case declares the citation check, so the one auto-confirm path is reachable only through an operator-authored case that does; every starter finding would go to a person.
- **Weak local Judge.** One 30B local model served every role, and it once quoted the attack prompt as evidence. A stronger paid Judge needs a dispatchable catalog price; several Claude and Gemini rows fail the price check ([cost analysis](docs/submission/cost-and-scale.md)).
- **One worker process.** Capacity is serial, and the target's own daily token budget binds first at scale. No 100-case live baseline exists.
- **In-process roles.** LangGraph and PostgreSQL preserve tested lease and reservation behavior, but the roles are function boundaries, not services.
- **Optional corroboration.** Read-only evidence can strengthen write or fact claims but needs an operator-approved bridge and attestations the transport cannot verify. It is off, and absence is never proof.
- **Report quality gaps.** The triage exercise recorded them: no citation for effect evidence, a PDF finding's report omits the hidden instruction, and Markdown structure defects ([details](docs/submission/triage.md)).

Build-versus-configure reasoning is in [ADR 0001](docs/adr/0001-build-versus-configure.md) and [ADR 0002](docs/adr/0002-trust-and-evidence-boundaries.md).
