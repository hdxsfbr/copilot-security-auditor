---
task: multi-model-llm-integration-platform-gv6ruh
type: structure-outline
repo: copilot-security-auditor
branch: multi-model-llm-integration-platform-gv6ruh
sha: 4f9c267db4bef64ada3816b9ba978753fc3f575a
---

# Clinical Co-Pilot Auditor Implementation Outline

Build a LAN-only TypeScript control plane and PostgreSQL-backed evaluation worker against the operator's existing authorized toy Co-Pilot, not a new Co-Pilot or OpenEMR deployment. Start with one selected, live, local-model case whose evidence is reviewable end to end; grow it into three-category regression testing, per-role provider choice, bounded exploration, recurring runs, and operational safeguards. Each phase leaves a runnable slice and keeps target failures, incomplete evidence, and inconclusive judgments distinct from safe results.

## Desired End State

- Operators configure either local Docker-backed or DigitalOcean-hosted toy targets, two scoped test identities, and role-specific OpenRouter or Ollama models; secrets never appear in evidence or exports.
- Manual selected-case and bounded adaptive runs, plus daily/weekly schedules, exercise the user-facing Co-Pilot chat and document workflow with at most one active run per target.
- Independent judgments and deterministic checks support evidence-gated automatic confirmation or human review; confirmed findings yield version-aware regressions and separately approved, redacted reports.
- The LAN control plane exposes live traces, coverage gaps, blocked/inconclusive outcomes, review queues, schedules, and actual/estimated model usage without pricing local inference as paid usage.
- Routine fixture, database, and UI tests run without the toy target; an opt-in bounded smoke test verifies the operator-supplied handshake against a live synthetic target.

## Implementation Overview

- [x] Phase 1: Run and inspect one selected local-model case
- [ ] Phase 2: Cover three trust boundaries and confirm reproducible findings
- [x] Phase 3: Mix model sources with accountable spending
- [x] Phase 4: Explore adaptively within explicit limits
- [x] Phase 5: Schedule repeatable evaluations without overlap
- [ ] Phase 6: Harden operations and verify the full workflow

---

## ✅ Phase 1: Run and inspect one selected local-model case

Stand up the product's first complete traversal: configure an authorized target and a synthetic-user direct-injection case, start a run from the UI, execute a ticketed turn against the live Co-Pilot, obtain an independent Ollama verdict, and inspect the persisted observation and agent sequence. An unsafe verdict enters a visible pending-review state; safe, inconclusive, infrastructure-blocked, and incomplete remain separate. The worker ends the run and releases the target before any human review. There is no auto-confirmation yet.

### Change Outline

Use npm workspaces, shared runtime-validated v1 contracts, migrations, and a Docker Compose stack. The UI/API binds only to a configured trusted-LAN address; worker and database expose no host ports. The existing template README becomes actual setup instructions; leave the existing untracked `.gitignore` content intact and add only necessary ignore entries if needed.

```text
.
├── apps/
│   ├── api/              # target/case/run APIs, reservations, evidence reads
│   ├── worker/           # leased jobs, LangGraph case, target session, Ollama Judge
│   └── web/              # target setup, selected run form, run/evidence view
├── packages/contracts/   # runtime-validated v1 run, action, observation, verdict, error shapes
├── db/migrations/        # target, encrypted credential, case, run/job, event, candidate tables
├── tests/                # fixture-backed handshake and PostgreSQL reservation/lease tests
├── compose.yaml          # API/UI, worker, PostgreSQL; private evidence volume
├── package.json          # test:unit, test:integration, typecheck, build scripts
└── README.md             # LAN binding, key setup, authorized toy target, development workflow
```

The first case is deliberately narrow but follows the final security boundaries: the target row is locked before reservation; worker writes require the current lease generation; the encrypted credential key lives outside PostgreSQL; the model sees a pseudonymized, secret-scrubbed packet rather than raw private evidence. Use a fresh per-case cookie jar, OpenEMR login 302, chart selection, module session/CSRF and conversation, then one fresh ticket per turn. The session and chat clients never accept model-generated URLs or patient identifiers. The graph stores only bounded sanitized references, not cookies or tickets; ambiguous delivery ends the case incomplete instead of replaying a turn.

```text
POST /api/runs -> queued | conflict(active_run_id)
worker claim + lease -> OpenEMR login/chart/session -> conversation/ticket/turn
  -> observation + deterministic check -> independent Ollama Judge
  -> safe | inconclusive | pending_review | blocked | incomplete
GET /api/runs/:id + /events -> polled, ordered evidence and usage
```

### Validation

#### Automated Verification

- [x] `npm run typecheck && npm run build && npm run test:unit` validates shared schemas, Ollama parsing, safe/uncertain outcomes, secret scrubbing, and fixture-backed 302/200 login, cookie, CSRF, ticket, fallback, and ambiguous-retry behavior.
- [x] `npm run test:integration` uses a disposable PostgreSQL instance to race starts against one target, exercise lease fencing/release, and assert that secrets do not reach persisted events.
- [x] `npm run test:e2e` runs the UI and worker against a fixture-backed toy target and Ollama stub: start, poll, inspect evidence, and distinguish safe from incomplete.

#### Manual Verification

- [x] With operator-supplied synthetic identities and a local Ollama model, start one inexpensive case on the toy target; verify its version, user-visible response, and agent order in the LAN UI. Pending-review evidence was verified with fixture-backed tests rather than an additional paid live turn.

---

## Phase 2: Cover three trust boundaries and confirm reproducible findings

Extend the same selected-case path to direct/indirect injection, Co-Pilot cross-chart context leakage, and unintended tool actions. Operators define typed cases and attach bounded synthetic PDFs; preflight two distinct assigned chart contexts, blocking only cross-chart cases if distinct charts cannot be proven. OpenEMR physician access to both charts or patient-finder visibility is not a Co-Pilot violation. Deterministic checks and a citation-validated Judge gate auto-confirm supported violations in categories with independently sufficient evidence; cross-chart claims without independent clinical-fact proof go to review rather than auto-confirmation. A separate approval exports a patient-redacted report.

### Change Outline

```text
apps/
├── api/                  # case authoring, idempotent review, approved export, regression reads
├── worker/               # document intent/upload, boundary probe, checks, confirmation gate
└── web/                  # case editor, review/evidence, findings and regression views
packages/contracts/       # typed attack/check specs, citations, confirmation route
db/migrations/            # artifact refs, check/verdict records, findings, approvals, regressions
tests/                    # document fixtures, gate matrix, alias/redaction and replay tests
```

The Red Team may propose only bounded `chat_turn` or `attach_pdf` actions; the worker validates message length, artifact type/size/pages, turn count, and case-selected identity before execution. An approved PDF goes through intent/upload and then a source-ID attachment with a fresh ticket; files live on a private volume under opaque IDs with hashes and atomic writes. Case criteria are versioned check specifications; `safe` covers only the claims actually checked. Preserve the original expected-safe criterion on replay and record target version separately from prior outcomes.

```text
observation -> scoped deterministic checks -> Judge packet (stable patient aliases)
  -> cited unsafe + complete reproduction + no contradictions -> auto_confirm -> regression
  -> uncertain, incomplete, or disputed violation -> pending_review -> operator decision
  -> covered safe / unresolved -> rejected candidate or inconclusive case
confirmed finding -> operator approve-export -> redacted report (never raw credentials)
```

### Validation

#### Automated Verification

- [x] `npm run typecheck && npm run test:unit` covers three category criteria, claim coverage, invalid citations, Judge/check disagreement, alias consistency, PDF limits, report redaction, and no auto-confirmation from confidence alone.
- [x] `npm run test:integration` verifies distinct user contexts, blocked cross-patient cases while others continue, once-only regression creation, idempotent review/approval, and artifact reference integrity.
- [x] `npm run test:e2e` exercises selected-case replay, review, approved export, and coverage gaps in the operator UI using synthetic fixtures.

#### Manual Verification

- [ ] Against an authorized toy target with two distinct assigned charts, run one bounded case in each category; verify the Co-Pilot stays in its selected chart context (not merely that OpenEMR permits both charts or echoes an ID) and a redacted export explains reproduction without revealing patient details.

---

## Phase 3: Mix model sources with accountable spending

Let an operator assign provider and model independently to Orchestrator, Red Team, Judge, and Documentation, including mixed OpenRouter/Ollama runs. Centralize role calls behind a validated model result contract and show each call's provider, model, tokens, latency, and reported charge where available. OpenRouter usage is conservatively reserved before dispatch; local Ollama usage has no invented dollar price. The selected-case path remains usable with Ollama only.

### Change Outline

```text
apps/
├── api/                  # available-model validation, role assignment, cap configuration
├── worker/               # model adapters, per-role calls, budget holds/reconciliation
└── web/                  # per-role selectors, run usage and paid-vs-local breakdown
packages/contracts/       # model assignment, normalized tokens/charge, budget errors
db/migrations/            # immutable run model snapshots, per-call ledger and holds
tests/                    # adapter HTTP fixtures and concurrent reservation tests
```

Snapshot choices and max-output-token bounds before dispatch. A PostgreSQL ledger atomically checks `settled + reserved` against the OpenRouter cap in a single currency using verified model pricing; unknown pricing or unbounded requests cannot dispatch. Settle only measured charges, retain holds and halt paid calls when billing is ambiguous, and expose reconciliation status. Never silently fail over to a different model or pass unsanitized target observations to a hosted model. Unsloth and headless Codex/Claude remain out of scope for launch.

### Validation

#### Automated Verification

- [x] `npm run typecheck && npm run test:unit` exercises OpenRouter/Ollama fixtures, per-role selection, hosted packet redaction, usage-unit conversion, unavailable models, and unresolved-charge behavior.
- [x] `npm run test:integration` races paid-call holds against one cap and confirms no over-cap dispatch, correct settlement, and explicit Ollama-only usage.
- [x] `npm run test:e2e` selects different sources by role and inspects usage/charge provenance in a fixture-backed run.

#### Manual Verification

- [x] With the operator's existing OpenRouter key, ran one explicitly capped ($0.05) synthetic direct-injection case with local companion roles and a paid Judge. The provider reported 170 input tokens, 94 output tokens and $0.00001602, matching the settled ledger and catalog rate arithmetic. The result was inconclusive, not safe; no additional paid turn was made.

The operator supplied the path to an existing OpenRouter key after the initial MR. The LAN auditor stack was rebuilt and restarted for the capped live run; the key was injected into Compose at startup without adding it to `.env` or Git. Fixture-backed mixed-provider tests also cover dispatch and ledger behavior. The selected-case worker calls only the Judge; the other three choices are snapshotted for later phases rather than generating artificial calls. The provider-side per-million-token price ceiling conversion discovered during live verification was corrected and verified with a regression test; the PostgreSQL hold was already conservative.

---

## Phase 4: Explore adaptively within explicit limits

Reuse the exact live observation, judgment, and finding pipeline for adaptive runs. The Orchestrator picks gaps within selected categories and the Red Team proposes bounded action sequences informed by recorded observations; the worker admits each case only while case-count, elapsed-time, and applicable OpenRouter spending limits remain. A stopped or budget-limited case remains incomplete, and adaptive confirmations seed selectable regression cases.

### Change Outline

```text
apps/
├── api/                  # adaptive definition, bounds validation, stop request
├── worker/               # coverage selection, action validation, limit/stop checks
└── web/                  # adaptive form, stop control, coverage and run-progress views
packages/contracts/       # proposed vs executed action sequence, coverage/limit states
db/migrations/            # per-run bounds, categorized case outcomes and coverage facts
tests/                    # fake-clock termination, proposal rejection, stop/budget flows
```

Keep run/job scheduling outside the per-case LangGraph thread: selection -> validated proposal -> authorized user-facing execution -> independent judgment -> persisted case outcome. Only executed actions count toward category coverage; reject model-generated URLs, raw requests, patient IDs, or credentials before target transport. Run status distinguishes not-tested, blocked, safe, unsafe, inconclusive, and incomplete for each category and target version.

### Validation

#### Automated Verification

- [x] `npm run typecheck && npm run test:unit` verifies action/attachment bounds, category selection, fake-clock time ceilings, stop checks, and coverage that excludes rejected proposals.
- [x] `npm run test:integration && npm run test:e2e` validates stopped/budget-limited case finalization, target release, regression seeding, and rendered category gaps against fixtures.

#### Manual Verification

- [x] Ran a two-case, three-minute maximum adaptive exploration on the authorized toy target with the host Ollama and requested stop after the first observed synthetic turn (run `aa378364-4386-40d9-aff8-eca264517d95`). The turn remains in the event stream, the case and parent run are incomplete, no candidate was produced, and the target reservation was released. The already in-flight local Judge call settled before the stop was processed; no paid provider call was made.

---

## Phase 5: Schedule repeatable evaluations without overlap

Create daily/weekly local-time schedules for either selected cases or bounded adaptive definitions. The API scheduler records each due occurrence exactly once; a target reservation decides whether to queue it, skip it because the target is busy, or block it for target/login failure without retrying the same occurrence. Pausing preserves history; the next occurrence advances even after a skip or block. Scheduled runs use the same confirmation and export policy as manual runs.

### Change Outline

```text
apps/
├── api/                  # schedule CRUD/pause, locked scheduler tick, occurrence reads
├── worker/               # preflight and terminal blocked occurrence transition
└── web/                  # cadence editor, next run, pause, skipped/blocked history
packages/contracts/       # daily/weekly wall time, IANA zone and occurrence states
db/migrations/            # schedule, unique(schedule_id, scheduled_for), occurrence
tests/                    # fake clock, DST, repeated-tick and busy-target races
```

Compute and persist the next UTC fire time in the transaction that inserts an occurrence. For DST gaps use the first valid local time after the gap; for repeated local times fire only at the first occurrence. Lock before reserve/queue, retain `(schedule_id, scheduled_for)` uniqueness, and record an explicit scheduled timestamp and reason on skip/block. Manual starts return the active run ID on conflict; distinct targets still run concurrently.

### Validation

#### Automated Verification

- [x] `npm run test:unit` uses an explicit clock for time zones, missing/repeated DST hours, and next-occurrence advancement. PostgreSQL tests exercise pause/resume semantics.
- [x] `npm run test:integration` races scheduler ticks and manual starts, verifies unique occurrences and target reservation, checks scheduled adaptive execution and blocked preflight, and simulates a worker restart after lease expiration without redispatch or a security verdict.
- [x] `npm run test:e2e` creates, pauses, resumes, and inspects schedules and skipped occurrence history in the UI; blocked occurrence state is covered by integration tests.

#### Manual Verification

- [x] On the authorized synthetic target, queued local Ollama selected run `d98d92d2-d9ae-40bc-be6f-d74acec22959` while the worker was paused, scheduled one due occurrence at 2026-09-29T03:33:00Z, and observed exactly one `skipped` record with the active run ID. The next fire advanced to 2026-09-30T03:33:00Z. Removed the test schedule before resuming the worker; the manual run completed with one local Judge call and released the target. No paid provider call was made.

---

## Phase 6: Harden operations and verify the full workflow

Close deployment and evidence lifecycle gaps without changing the evaluation policy: migrations and DB health gate work, backups pair database and private artifact volume, stale leases reconcile safely, and logs/errors disclose no credentials. Provide operator-ready setup for LAN firewalling, key custody, synthetic identities, target allowlisting, review/approval limitations, and measured versus unresolved OpenRouter spend. Ship an opt-in live smoke command that uses only operator-owned toy targets and discloses possible provider charges.

### Change Outline

```text
.
├── apps/api/              # artifact access checks, reconciliation and health endpoints
├── apps/worker/           # stale lease/hold recovery, artifact integrity checks
├── tests/                 # full fixture flow, failure injection, opt-in live smoke
├── compose.yaml           # health checks, startup gating, private mounts/LAN binding
├── README.md              # deploy, backups, recovery, limits and live smoke instructions
└── .gitlab-ci.yml          # routine unit, fixture, PostgreSQL and UI tests only
```

An orphan file or missing referenced PDF is an evidence-integrity error, never a confirmed finding. The smoke path verifies ready/login/chart/session, one inexpensive ticketed turn, and one bounded synthetic PDF attachment; it requires explicit URL, identities, and charge limit and does not run in routine CI. Document that LAN reachability grants full operator power, and that review records an action and time, not an authenticated reviewer identity.

### Validation

#### Automated Verification

- [x] `npm run typecheck && npm run build && npm run test:unit && npm run test:integration && npm run test:e2e` exercises the complete fixture-backed flow and CI entry points.
- [x] `npm run test:failure` injects target outage, stale leases, missing artifacts, ambiguous turn/provider delivery, and restore/restart conditions; assert no false pass, unsafe retry, duplicate dispatch, or secret-bearing logs.
- [x] `npm run test:live` is opt-in only with explicitly supplied toy-target configuration and a bounded charge setting; never run it in CI by default.

#### Manual Verification

- [x] Restored the encrypted paired backup in an isolated loopback-only deployment; verified prior run evidence and synthetic PDF checksums/tamper detection, confirmed the worker has no published port, and operator confirmed the API is unreachable from guest Wi-Fi.

---

## Open Questions

- No structural blocker. Live smoke requires the operator's target URL, assigned synthetic patient IDs, authorized test-user credentials, and optionally a capped OpenRouter key; these are runtime inputs, not values to commit.
