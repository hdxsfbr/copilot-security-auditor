# Audit delivery: design and execution plan

Date: September 29, 2026. Audited source: `e1ae2705df8522f63099577d6f8b1639ba12dbc0`.

[Linear project](https://linear.app/hdxsfbr/project/clinical-auditor-evidence-and-operator-workflow-20b47f75a996) · [Audit](../../audit/2026-09-28/AUDIT.md) · [Task manifest](tasks.json)

## Decisions and success criteria

The user selected **AgentForge submission rubric completion** as the primary objective. The original PRD defines deliverables and required capabilities; the later Co-Pilot feature contract defines the actual target behavior. The settled cross-patient requirement is **chart-context isolation**. A clinician legitimately opening another chart is not a vulnerability.

The user also approved an **optional read-only evidence adapter**. Attacks continue through the user-facing chat/PDF workflow. An explicit adapter contract may supplement observations with approved audit events or seeded chart facts. It is disabled by default; fixture implementation does not authorize live access.

Retain the TypeScript/React/Express/PostgreSQL stack, target reservations, credential snapshots, lease fencing, bounded retry policy, schedule/DST transactions and spend ledger. Replace the observation/Judge boundary, single-page information architecture and placeholder report generation. Extend adaptive strategy only after verdicts, coverage and regression facts become dependable.

The auditor remains a trusted single-operator LAN tool for this delivery. That boundary is documented in the threat model; it does not imply the target is private or satisfy the rubric's deployed-target requirement. Multi-operator identity/access, a stack replacement and new model providers are separate scope decisions.

Success requires both implemented behavior and verifiable submission artifacts. Passing fixture tests cannot establish three discovered vulnerabilities, live 100-case performance, independent peer integration, actual development spend or a published demo. These remain visible requirements until supported by actual evidence.

## Product and architecture design

### Evidence, checks and judgment

E01 introduces a versioned observation envelope with execution identity (target, target version, run, case, action and returned turn identifiers), typed response claims/sources, attachment provenance, sanitized visible content, and completeness metadata. Completeness includes a reason for missing, failed, partial or truncated evidence, with bounds recorded. Do not silently relabel old v1 observations as fully verified v2 evidence.

Preserve structured source references through transport and persistence. A prose string such as `source:` is not a citation. Limit ingestion before buffering an unbounded response; retain only permitted evidence, never credentials. Oversize/partial evidence yields an incomplete or explicitly scoped judgment.

E03 builds a bounded Judge packet from the actual sanitized prompts, attachments and provenance, assistant responses, deterministic checks, effect observations, expected behavior and evidence limitations. The Judge proposes a verdict with linked evidence; deterministic policy validates those references and persists the passed/failed gates. A quote's mere presence does not establish the claimed violation. LLM-only unsupported findings go to review. Safe judgments also require sufficient complete evidence for the asserted scope.

A labeled synthetic calibration corpus covers refusals, echoes, contradictions, real fixture violations, invalid citations, missing artifacts and truncation. Record policy version and failed gates. Independent model accuracy and drift measurements remain separate from deterministic fixture tests. The Red Team cannot modify Judge policy or self-confirm findings.

E02 verifies the candidate's exact selected/adaptive artifact references, hash and size before a new confirmation, report approval or export. Perform validation and decision writes with a transaction/state guard appropriate to the existing artifact store. Restore-and-retry is explicit. Later evidence loss does not erase the historical decision; it blocks a new complete/reproducible export and exposes current integrity.

E04 replaces the universal timeout with handshake/upload/turn/role deadlines bounded by remaining run time. The supplied target contract allows longer turns than the current 15 seconds. Preserve no retry after ambiguous delivery, lease fencing, stop checks and unknown paid charges.

### Optional evidence adapter

X01 defines the disabled-by-default read-only contract, operator profile and exact GET transport for approved seeded facts and audit events. X02 integrates the provider into selected/adaptive workers and records versioned corroboration sidecars; X01 alone changes no run outcome. Configuration binds a known target/version and allowlisted endpoint/auth contract outside model control. Requests carry correlated run/session/turn/chart identities; results carry source, collection time, coverage window, freshness and correlation status. Responses are bounded and validated. X02 keeps private matching inputs separate from persisted references; raw provider data does not enter the existing Judge envelope without a separately versioned contract extension.

Only declared read operations are available. Models cannot invent endpoints, select arbitrary identities, execute queries or emit writes. An adapter timeout, stale record or missing coverage yields unavailable/unknown evidence. An empty result supports only scoped absence for the explicitly attested source, operation classes and exact fresh correlation window. It does not prove global write absence. Independently corroborated positive evidence routes to human review; missing context or unverifiable prompt/PDF sentinel exclusion remains unknown.

Use synthetic positive, negative, stale, wrong-context and unavailable fixtures first. No target source inspection, sibling project reads or guessed production endpoints. Live activation needs the actual operator-supplied matching contract. Black-box mode remains supported and states its proof limits.

### Cases, reusable runs and execution

C01 gives cases draft → published → archived lifecycle with immutable published versions. Upload failure leaves a recoverable, non-runnable draft. Publishing validates the complete action/check definition and attachment references. Cloning or editing never changes a historical run snapshot.

New cases carry category/subcategory, OWASP mappings, severity/exploitability rationale and the exercised boundary, invariant or regression risk. Observed results live with executions, linked to the exact definition/version. Historical unknown metadata stays unknown. C02 publishes new starters for no advice, no unsolicited writes and current-chart isolation, with direct/indirect/multi-turn coverage and negative controls.

M01 makes reusable run definitions the shared input for manual launches and schedules: target, one selected case or adaptive seeds, role/model profile and case/time/spend bounds. Selected-suite definition and execution are added together in G02, including the composer extension; U04 initially offers one selected case. Executions take immutable snapshots. Validate only the roles invoked by that mode; discovering a local model does not prove it is healthy, and cost previews remain conservative.

R01 provides cursor-based run history, exact run/case lookup and cooperative stop for both modes. A queued cancellation must not start work; a running cancellation must be observed before another turn. Preserve in-flight evidence, reservation accounting and unknown billing. Conflicts expose the active run ID so the UI can recover it.

### Agent contracts and adaptive decisions

B01 defines distinct Orchestrator, Red Team, Judge and Documentation responsibilities, contexts, trust levels and decision authority, plus build-versus-configure decisions. Merely renaming pipeline stages does not satisfy the original multi-agent requirement.

K01 publishes versioned success/error schemas in `contracts/`, with shared runtime validators and producer/consumer tests. Include message identity, run/case/lineage references, bounds, evidence references and known failures. Breaking changes require schema version and migration notes. The Documentation envelope exists before F01 consumes it; independent peer proof belongs to I01.

A17 lets the Orchestrator use compatible scoped coverage, unresolved finding severity and regressions to select work. Red Team proposals use sanitized seed actions/checks and prior verdict feedback, record mutation parents, and support bounded response-conditioned next turns. Stagnation and repeated blocked/rejected proposals lead to a recorded redirect or stop. Every proposal still passes deterministic transport, case/time/spend and stop limits.

### Findings, reports and regressions

F00 first introduces report jobs with their own lease/generation and accounting lifecycle. An optional immutable run report policy snapshots the Documentation model/output bound and aggregate report allowance, disabled by default. Run preflight reserves the allowance within the authorized total; confirmed candidates enqueue idempotent jobs keyed by finding/evidence revision, with funds transferred atomically to job reservations. Completion can release the target reservation while report accounting remains held. Set an explicit bounded review window; release only unused allowance after expiry/cancellation, never an uncertain in-flight charge. Late confirmation after release requires fresh explicit report-job authorization. Missing policy produces report-needed status. It never triggers unbudgeted inference or reopens a finished execution lease.

F01 separates execution verdict, human disposition and report revision. A finding contains stable identity, severity rationale, clinical impact, expected/observed behavior, minimal reproduction, citations, remediation, uncertainty and validation history. Store legacy incomplete records without manufacturing the missing details. Add typed human review rationale and append-only decision/correction history in the backend before F02 consumes them.

The bounded Documentation role receives validated confirmed evidence and a typed report contract. Its model usage uses the existing accounting discipline. It drafts automatically from a confirmed exploit; output validation cannot create a new finding or silently add evidence. Use F00's job/role integration to preserve stop/lease/budget invariants. F02 adds the optional Documentation profile and allowance controls to the composer and finding review, shows held funds/expiry and job state, and supports explicit authorization after an expired allowance. Report publication requires human approval of the exact redacted revision; editing invalidates that revision's approval. Stable patient aliases preserve the reproduction mechanism.

G01 groups equivalent normalized attack definitions with stable findings and records explicit replay lineage. G02 executes bounded regression suites against explicit target versions and shows recurring, fixed, resurfaced and unknown states. A missing, blocked or incomplete result never means fixed. Cross-category regressions remain visible.

An explicit opt-in target-version-change trigger lets the Orchestrator enqueue a deduplicated bounded suite using existing reservations and ledger. The trigger is based on supplied/verified target version identity, not a guessed deployment. It never deploys or patches the target.

### Coverage, operations and accounting

V01 scopes coverage by target, target version and time, distinguishing attempted, executed, assessed and reviewed cases. Denominators exclude cases for which the assertion is unknown. Human disposition does not rewrite immutable execution outcomes. V02 compares only compatible scopes and shows untested gaps.

O01 exposes worker heartbeat, queue age, lease state and diagnostic codes without secrets. Incremental event cursors and paginated collections bound reads. Completed runs stop background polling. Target reservations and worker execution concurrency are documented separately.

S01 uses reusable definitions and shows explicit schedule-zone formatting, archived schedules, occurrence reasons and links to runs. Preserve existing DST and uniqueness behavior.

M02 separates reservations, provider-reported charges and unresolved spend. Preserve available generation references. Reconciliation is explicit, evidence-backed, idempotent and auditable; unknown charges cannot be discarded simply to permit another run.

## UI design

Keep the existing restrained palette, with a persistent application shell and task-focused pages. U02 establishes shared landmarks, keyboard/focus behavior, loading/error/empty states, responsive navigation and stable routing. It also reserves the route modules for later feature owners, so they do not all edit the root at once. Extract the legacy selected launcher into `pages/LegacyRunLauncher.tsx`; U04 owns that module's removal when the composer replaces it. Render existing functionality while pages migrate; planned capabilities must not look available.

| Route | Primary operator task |
| --- | --- |
| `/` | See active/blocked work, reviews, queue health and selected target/version summary |
| `/targets` | Configure masked identities, chart bindings and verified target/version access |
| `/cases`, `/cases/:id` | Find, draft, validate, publish, clone or archive repeatable cases |
| `/runs/new` | Use one composer with target, selected case (suite after G02)/seeds, active roles, bounds and preflight |
| `/runs` | Recover any run by target/version/status/time |
| `/runs/:id` | Inspect progress, costs and structured evidence; stop execution |
| `/runs/:id/cases/:caseId` | Open the exact selected or adaptive case and cited turn |
| `/findings`, `/findings/:id` | Review evidence beside verdict; preview and approve a report revision |
| `/regressions` | Run suites and compare recurrence/fix/resurfacing across versions |
| `/coverage` | Examine scoped gaps, denominators and trends |
| `/schedules` | Operate schedules and inspect archived definitions/occurrences |
| `/settings/models` | Manage reusable role profiles and model availability |

Raw JSON is a secondary expandable view. The primary evidence view groups user action, response, checks, verdict/gates and cited sources. Local step numbers and stable anchors make “inspect evidence” reliable. Preserve forms and previously loaded evidence through local API failures; never turn a catalog 503 into an empty React root.

U01 fixes failure handling before the route migration. U03 then adds durable run/detail behavior, C02 cases, U04 the single composer, F02 finding review and V02 coverage. These are behavioral acceptance criteria, not a requirement for a new visual framework.

## Waves and executable issues

Waves group outcomes. **Dependencies and locks control dispatch; a whole wave is not a global barrier.** This permits early CI beside rubric design and optional independent work without speculative branches on unmerged prerequisites.

| Issue | Wave | Outcome | Owner model | Prerequisites |
| --- | --- | --- | --- | --- |
| [D00 · HDX-5](https://linear.app/hdxsfbr/issue/HDX-5/d00-publish-audit-design-decisions-and-merge-driven-delivery-protocol) | W0 | Publish audit, design decisions and merge-driven delivery protocol | coordinator | — |
| [B01 · HDX-6](https://linear.app/hdxsfbr/issue/HDX-6/b01-define-rubric-first-threat-model-architecture-users-metrics-and) | W0 | Define rubric-first threat model, architecture, users, metrics and build decisions | Sol | D00 |
| [E01 · HDX-7](https://linear.app/hdxsfbr/issue/HDX-7/e01-preserve-structured-observations-and-mark-incomplete-evidence) | W1 | Preserve structured observations and mark incomplete evidence | Sol | B01 |
| [E02 · HDX-8](https://linear.app/hdxsfbr/issue/HDX-8/e02-gate-finding-decisions-and-exports-on-candidate-evidence-integrity) | W1 | Gate finding decisions and exports on candidate evidence integrity | Sol | B01 |
| [U01 · HDX-9](https://linear.app/hdxsfbr/issue/HDX-9/u01-keep-the-ui-usable-through-catalog-and-api-failures) | W1 | Keep the UI usable through catalog and API failures | Luna | B01 |
| [E03 · HDX-10](https://linear.app/hdxsfbr/issue/HDX-10/e03-rebuild-judge-evidence-packets-and-calibrate-confirmation-gates) | W2 | Rebuild Judge evidence packets and calibrate confirmation gates | Sol | E01 |
| [E04 · HDX-11](https://linear.app/hdxsfbr/issue/HDX-11/e04-use-operation-specific-deadlines-without-ambiguous-retries) | W2 | Use operation-specific deadlines without ambiguous retries | Sol | E03 |
| [U02 · HDX-12](https://linear.app/hdxsfbr/issue/HDX-12/u02-introduce-routed-application-shell-and-task-focused-navigation) | W2 | Introduce routed application shell and task-focused navigation | Sol | U01 |
| [Q01 · HDX-13](https://linear.app/hdxsfbr/issue/HDX-13/q01-make-fixture-ci-and-browser-setup-reproducible) | W2 | Make fixture CI and browser setup reproducible | Luna | D00 |
| [K01 · HDX-38](https://linear.app/hdxsfbr/issue/HDX-38/k01-publish-and-enforce-versioned-inter-agent-success-and-error) | W3 | Publish and enforce versioned inter-agent success and error contracts | Sol | E03 |
| [R01 · HDX-14](https://linear.app/hdxsfbr/issue/HDX-14/r01-add-run-history-exact-case-lookup-and-cooperative-stop-for-both) | W3 | Add run history, exact case lookup and cooperative stop for both modes | Sol | E02, E04 |
| [C01 · HDX-15](https://linear.app/hdxsfbr/issue/HDX-15/c01-introduce-draft-publish-version-and-archive-lifecycle-for-cases) | W3 | Introduce draft, publish, version and archive lifecycle for cases | Sol | E02, E01 |
| [M01 · HDX-16](https://linear.app/hdxsfbr/issue/HDX-16/m01-validate-active-roles-and-save-reusable-runmodel-definitions) | W3 | Validate active roles and save reusable run/model definitions | Sol | E04, C01 |
| [U03 · HDX-17](https://linear.app/hdxsfbr/issue/HDX-17/u03-build-persistent-run-history-and-structured-run-detail) | W4 | Build persistent run history and structured run detail | Sol | R01, U02 |
| [C02 · HDX-18](https://linear.app/hdxsfbr/issue/HDX-18/c02-build-the-versioned-multi-step-case-workspace-and-starter-matrix) | W4 | Build the versioned multi-step case workspace and starter matrix | Sol | C01, U02, B01, E03 |
| [U04 · HDX-19](https://linear.app/hdxsfbr/issue/HDX-19/u04-replace-duplicate-launchers-with-one-preflighted-run-composer) | W4 | Replace duplicate launchers with one preflighted run composer | Sol | M01, U03 |
| [S01 · HDX-20](https://linear.app/hdxsfbr/issue/HDX-20/s01-make-schedules-reusable-correctly-zoned-and-historically) | W4 | Make schedules reusable, correctly zoned and historically accessible | Sol | M01, U04 |
| [O01 · HDX-21](https://linear.app/hdxsfbr/issue/HDX-21/o01-expose-worker-queue-and-incremental-evidence-health) | W4 | Expose worker, queue and incremental evidence health | Sol | R01, Q01, U03 |
| [F00 · HDX-39](https://linear.app/hdxsfbr/issue/HDX-39/f00-add-leased-report-jobs-and-bounded-post-run-model-accounting) | W5 | Add leased report jobs and bounded post-run model accounting | Sol | E02, E03, M01, K01 |
| [F01 · HDX-22](https://linear.app/hdxsfbr/issue/HDX-22/f01-implement-evidence-grounded-finding-metadata-and-report-drafting) | W5 | Implement evidence-grounded finding metadata and report drafting | Sol | E03, E02, M01, K01, F00 |
| [F02 · HDX-23](https://linear.app/hdxsfbr/issue/HDX-23/f02-build-finding-review-report-preview-and-approved-downloads) | W5 | Build finding review, report preview and approved downloads | Sol | F01, U03, U04 |
| [V01 · HDX-24](https://linear.app/hdxsfbr/issue/HDX-24/v01-scope-coverage-by-targetversion-with-honest-denominators) | W5 | Scope coverage by target/version with honest denominators | Sol | E03, C01, R01 |
| [V02 · HDX-25](https://linear.app/hdxsfbr/issue/HDX-25/v02-show-targetversion-coverage-and-review-trends-in-the-ui) | W5 | Show target/version coverage and review trends in the UI | Luna | V01, U02, O01 |
| [G01 · HDX-26](https://linear.app/hdxsfbr/issue/HDX-26/g01-add-regression-identity-deduplication-and-explicit-replay-lineage) | W5 | Add regression identity, deduplication and explicit replay lineage | Sol | F01, C01 |
| [G02 · HDX-27](https://linear.app/hdxsfbr/issue/HDX-27/g02-run-regression-suites-and-show-fixedresurfacedunknown-states) | W5 | Run regression suites and show fixed/resurfaced/unknown states | Sol | G01, V01, U04 |
| [M02 · HDX-28](https://linear.app/hdxsfbr/issue/HDX-28/m02-make-unresolved-spend-investigable-and-explicitly-reconcilable) | W5 | Make unresolved spend investigable and explicitly reconcilable | Sol | M01, U03 |
| [A17 · HDX-29](https://linear.app/hdxsfbr/issue/HDX-29/a17-give-bounded-adaptive-exploration-feedback-and-mutation-lineage) | W6 | Give bounded adaptive exploration feedback and mutation lineage | Sol | E03, V01, G01, G02 |
| [Q02 · HDX-30](https://linear.app/hdxsfbr/issue/HDX-30/q02-verify-the-complete-fixture-workflow-and-baseline-performance) | W6 | Verify the complete fixture workflow and baseline performance | Sol | F02, V02, G02, M02, S01, O01, C02, A17, Q01 |
| [B02 · HDX-31](https://linear.app/hdxsfbr/issue/HDX-31/b02-demonstrate-ten-finding-triage-and-reporting-quality) | W5 | Demonstrate ten-finding triage and reporting quality | Luna | F01, B01 |
| [P01 · HDX-32](https://linear.app/hdxsfbr/issue/HDX-32/p01-produce-reproducible-100-case-fixture-baseline-and-scale-cost) | W6 | Produce reproducible 100-case fixture baseline and scale cost analysis | Sol | Q02, M02 |
| [D02 · HDX-33](https://linear.app/hdxsfbr/issue/HDX-33/d02-publish-operating-docs-threat-map-metrics-and-rubric-traceability) | W6 | Publish operating docs, threat map, metrics and rubric traceability | Luna | Q02, B02, P01 |
| [X01 · HDX-34](https://linear.app/hdxsfbr/issue/HDX-34/x01-implement-optional-read-only-evidence-adapter-against-an-explicit) | W3 | Implement the optional read-only evidence contract and transport | Sol | E01, E03, B01 |
| [X02 · HDX-42](https://linear.app/hdxsfbr/issue/HDX-42/x02-integrate-scoped-read-only-corroboration-into-worker-outcomes) | W3 | Integrate scoped read-only corroboration into worker outcomes | Sol | X01, R01 |
| [L01 · HDX-35](https://linear.app/hdxsfbr/issue/HDX-35/l01-run-explicitly-authorized-live-synthetic-acceptance) | W6 | Run explicitly authorized live synthetic acceptance | Sol | Q02 |
| [I01 · HDX-36](https://linear.app/hdxsfbr/issue/HDX-36/i01-complete-peer-integration-proof-and-security-review-evidence) | W6 | Complete peer integration proof and security-review evidence packet | Sol | Q02, B02, B01, K01 |
| [L02 · HDX-37](https://linear.app/hdxsfbr/issue/HDX-37/l02-run-explicitly-authorized-100-case-live-performance-acceptance) | W6 | Run explicitly authorized 100-case live performance acceptance | Sol | L01, P01 |
| [Q03 · HDX-40](https://linear.app/hdxsfbr/issue/HDX-40/q03-provide-a-working-gitlab-runner-and-verify-the-fixture-pipeline) | W2 | Provide a working GitLab runner and verify the fixture pipeline | Sol | Q01 |
| [D01 · HDX-41](https://linear.app/hdxsfbr/issue/HDX-41/d01-record-temporary-local-validation-policy-and-runner-blocker) | W0 | Record temporary local validation policy and runner blocker | coordinator | D00 |

External gates Q03, L01, I01 and L02 are not automatically dispatchable merely because code dependencies merge. Prepare reusable documentation/contracts through B01, K01 and D02 while those requirements await operator input. B01's rubric register also tracks demo, deployed-target evidence, actual dev spend, social/interview and submission logistics; those are not silently treated as completed implementation tasks.

The initial sequence is:
1. D00 publishes this baseline and monitor for user review.
2. After D00 merges, B01 (Sol, rubric/architecture) and Q01 (Luna, fixture CI) can run together.
3. After B01 merges, E01 (Sol, evidence), E02 (Sol, integrity) and U01 (Luna, resilience) are independent; an outstanding Q01 review consumes one of the three work slots.
4. E03 follows E01; U02 follows U01 and waits for Q01's package-config lock if needed. E04 follows E03.
5. Later waves draw from the ready set. API/data, contracts, migrations and worker-pipeline locks deliberately serialize shared changes; UI owners can proceed alongside independent backend work.
6. Final fixture acceptance and submission evidence converge in Q02/B02/P01/D02. Live and peer requirements stay separately gated.

## Coordination rules

The root agent coordinates this single session. Subagents use **Sol or Luna only**, as recorded in the manifest. At most three issues may be active or awaiting review combined, including repair work. This bounds both agent concurrency and the review queue. A finished coding agent with an open MR still consumes a work slot and holds its locks.

Linear is the visible work tracker; GitLab is authoritative for branches, MR state and merged commits. The versioned manifest owns the intended dependency graph, file areas, acceptance and lock names. The ignored journal records dispatch details; it is not evidence of a merge. Conflicting or missing records stop the affected dispatch for reconciliation.

For every launch:
1. Read the issue and current manifest; verify prerequisites using GitLab and freshly fetched `origin/main`. Check for an existing owner, branch, journal entry and matching open MR.
2. Reserve a work slot and all locks, record the attempt, owner, base revision and task before dispatch. Never launch the same issue twice.
3. Create a `codex/<linear-id>-<task>` branch from current main in an isolated worktree **inside this repository**, for example `.worktrees/HDX-6`. Ignore that local directory through `.git/info/exclude`. Do not inspect sibling folders or recursively inspect other agents' worktrees.
4. Give the agent the issue, exact workspace, allowed file areas, acceptance, base SHA, locks and dependency facts. The root working checkout must not be reset to manage another agent.
5. The agent implements and validates its bounded scope. Shared test-harness changes belong to Q01; feature tests use separate files and declared fixture facilities. Migrations are numbered only while holding the migration lock against freshly merged main.
6. Root reviews the diff for scope and correctness, runs the relevant checks, records their output against the MR head commit and opens/updates one MR. Link the MR to Linear and attach it to this task. Move the issue to In Review.
7. The user reviews and merges. The coordinator never merges, deploys, publishes reports or runs paid/live validation on their behalf from this routine loop.

Locks are semantic file-area ownership. `api-data`, `contracts`, `migrations`, `worker-pipeline`, `worker-models`, `worker-session`, `worker-loop` and shared UI/harness locks cover their respective shared files. Files listed in issues are scope boundaries, not a claim that all files must change. If a worker needs another owner's shared file, it requests the lock and pauses that portion; it does not bypass the scheduler. Route imports/shared exports and fixtures count as shared changes.

One issue normally produces one bounded MR. Split an unexpectedly large or cross-domain implementation into explicit child issues before expanding scope; update the manifest and native dependencies. Roughly 750 changed non-generated lines is a review checkpoint, not a substitute for judgment. D00 includes the audit, manifest and plan as a documentation baseline. Do not combine unrelated fixes to fill an agent slot.

A failed check gets at most two focused repair rounds per attempt. Record the failure and correction. Repeated failure, unclear product policy or incompatible contract pauses the affected task and asks for the missing decision, while independent ready work may continue. Never hide a flaky test with unlimited reruns.

MR evidence should identify the tested commit and scenario, give the relevant check results, and link the same evidence from the MR and Linear issue. For UI changes, attach authentic before/after screenshots of the affected state; add a short video when interaction, navigation or timing is easier to assess in motion. Use synthetic data and capture the tested build, not a mockup or unrelated revision. For backend-only changes, use API/fixture evidence when a visual capture would add no useful proof.

### Merge detection and restart

`scripts/audit-coordinator.mjs` is a read-only readiness resolver. It queries this GitLab project's MRs, fetches only main's remote-tracking ref, and emits `ready`, `waiting`, `blocked`, `merged`, `active` and `warnings`. It does not write Linear, change the journal, create branches or launch agents. The root session performs those actions from a fresh snapshot.

A prerequisite unlock requires all of:
- GitLab reports the issue's linked MR merged into main with a merge timestamp.
- The merge/squash commit is an ancestor of freshly fetched `origin/main`.
- Required local checks were recorded as passed for the exact MR head. A present GitLab pipeline succeeded for that head or its merge/squash revision; authoritative `head_pipeline: null` means no remote pipeline exists for that MR and still requires the exact-head local checks.
- No duplicate/open competing MR or contradictory state prevents reconciliation.

An open MR with no journal entry blocks duplicate dispatch. A closed unmerged MR does not satisfy its issue. A Done label or forged journal `merged` flag is insufficient. New pushes invalidate old head-specific validation. Rebases/merges that change the tested revision need relevant checks again. Before launch, the root also checks Linear for cancellation/scope changes and reviews intervening main changes, including reverts; ancestry alone cannot prove a feature was not subsequently reverted.

Initialize the local journal explicitly, preserving any existing state:

```json
{
  "schemaVersion": 1,
  "mode": "active-session",
  "tasks": {},
  "updatedAt": "<ISO timestamp>"
}
```

For each dispatched issue, record `phase`, `branch`, `worktree`, `agent`, `attempt`, `baseSha`, and then `mrIid`, `headSha`, and `validation: { passed, headSha }` with check evidence references. This validation record is the trusted coordinator's attestation after running/reviewing those checks; the resolver checks its revision binding, not the contents of test logs. Persist atomically at `test-results/audit-coordination/state.json`. Keep secrets out of the journal and MR bodies. Only set `phase: closed` after reconciling an unmerged closure/cancellation and confirming its worker has stopped; it releases locks but never satisfies a dependency.

```sh
node --test tests/coordinator.test.mjs
node scripts/audit-coordinator.mjs --once
node scripts/audit-coordinator.mjs --watch --interval 30
```

During this active agent session, poll at 30-second intervals, report meaningful changes and dispatch newly eligible work. The resolver is quiet while state is unchanged. Reconcile Linear to Done only after verified merge/validation. Hold locks through review; release after verified merge or an explicitly reconciled cancellation/closure.

**This session has no callable recurring-task/heartbeat tool.** The CLI watch process cannot wake a finished agent task or launch agents by itself. Automatic review-merge-dispatch therefore works while the coordinator session is active. After interruption, resume from the manifest, journal, Linear and GitLab before launching anything. No background daemon or scheduled task is claimed to have been created.

### Runner restoration and current CI policy

On September 29, the user temporarily authorized verified local checks while GitLab had no usable runner. D01 / HDX-41 recorded an explicit pending-pipeline exception. That decision remains part of the historical record; it is no longer a policy for subsequent work. [Q03 / HDX-40](https://linear.app/hdxsfbr/issue/HDX-40) identified online runner 282 with `run_untagged` disabled for this untagged job. After the setting was enabled, [pipeline 32849](https://labs.gauntletai.com/andrebatista/copilot-security-auditor/-/pipelines/32849), job 137071, passed typecheck, build and 68 fixture tests on revision `14883c7`. See [validation.md](../validation.md) for runner diagnostics.

The resolver still requires verified merge/main ancestry and exact-head local validation. A present pipeline must be successful and revision-matched. An authoritative `head_pipeline: null` means no pipeline exists for that MR; it can rely on the same exact-head local validation but is never described as green remote CI. Missing or undefined pipeline data and pending, running, failed, canceled, skipped or stale pipelines block dependency unlocks, even if a historical journal entry still contains `ciException`. Retire obsolete exception records when reconciling the journal; do not relabel the historical local-check decision as remote CI success.

## Validation and completion

Each issue specifies observable acceptance and appropriate tests. Use synthetic targets and disposable local data during routine development. Preserve the existing successful checks for reservations, credentials, leases, ambiguous delivery, spend, schedule uniqueness and DST. Q01 makes fixture setup and browser provisioning reproducible; Q03 records the restored runner and passing remote fixture pipeline. A queued or absent pipeline is not green.

Evidence changes need focused transport/schema/policy and artifact-integrity regressions. UI changes need browser checks of primary paths, keyboard behavior, narrow screens and local errors. Full acceptance Q02 must reproduce and fix the audited failures, exercise the complete finding-to-regression workflow and record current revisions. Do not re-run every suite after documentation-only changes.

P01 establishes measured fixture CPU/memory/latency/throughput and a regression SLO with a defensible CI check, plus scale/cost assumptions for 100/1K/10K/100K workloads. B02 supplies at least ten clearly simulated triage findings including false positives. L01 requires explicitly authorized live synthetic identities and an effective spend cap; it cannot invent three distinct real vulnerabilities. Black-box live acceptance does not depend on optional X01. Only adapter-backed assertions additionally require merged X01/X02 and an approved matching contract. L02 needs separate authorization for the live 100-case workload. I01 requires a peer's independently built published interface, without source access.

Definition of Done for an implementation issue: acceptance evidence, reviewed MR, required passing validation for that revision, verified merge into main, Linear/MR/journal links reconciled and dependency locks released. Definition of a complete submission additionally requires every rubric register item supported or explicitly accepted as an unresolved gap by the user. Planned work is never reported as implemented.

## Audit traceability

D00 preserves all original evidence; Q02 verifies all sixteen findings end to end. Focused owners are:

| Audit finding | Delivery issues |
| --- | --- |
| A01 | [E01](https://linear.app/hdxsfbr/issue/HDX-7/e01-preserve-structured-observations-and-mark-incomplete-evidence), [X01](https://linear.app/hdxsfbr/issue/HDX-34/x01-implement-optional-read-only-evidence-adapter-against-an-explicit), [X02](https://linear.app/hdxsfbr/issue/HDX-42/x02-integrate-scoped-read-only-corroboration-into-worker-outcomes) |
| A02 | [E03](https://linear.app/hdxsfbr/issue/HDX-10/e03-rebuild-judge-evidence-packets-and-calibrate-confirmation-gates), [K01](https://linear.app/hdxsfbr/issue/HDX-38/k01-publish-and-enforce-versioned-inter-agent-success-and-error), [X01](https://linear.app/hdxsfbr/issue/HDX-34/x01-implement-optional-read-only-evidence-adapter-against-an-explicit), [X02](https://linear.app/hdxsfbr/issue/HDX-42/x02-integrate-scoped-read-only-corroboration-into-worker-outcomes) |
| A03 | [E02](https://linear.app/hdxsfbr/issue/HDX-8/e02-gate-finding-decisions-and-exports-on-candidate-evidence-integrity), [F02](https://linear.app/hdxsfbr/issue/HDX-23/f02-build-finding-review-report-preview-and-approved-downloads) |
| A04 | [U01](https://linear.app/hdxsfbr/issue/HDX-9/u01-keep-the-ui-usable-through-catalog-and-api-failures) |
| A05 | [E04](https://linear.app/hdxsfbr/issue/HDX-11/e04-use-operation-specific-deadlines-without-ambiguous-retries) |
| A06 | [R01](https://linear.app/hdxsfbr/issue/HDX-14/r01-add-run-history-exact-case-lookup-and-cooperative-stop-for-both), [U03](https://linear.app/hdxsfbr/issue/HDX-17/u03-build-persistent-run-history-and-structured-run-detail) |
| A07 | [K01](https://linear.app/hdxsfbr/issue/HDX-38/k01-publish-and-enforce-versioned-inter-agent-success-and-error), [F00](https://linear.app/hdxsfbr/issue/HDX-39/f00-add-leased-report-jobs-and-bounded-post-run-model-accounting), [F01](https://linear.app/hdxsfbr/issue/HDX-22/f01-implement-evidence-grounded-finding-metadata-and-report-drafting), [F02](https://linear.app/hdxsfbr/issue/HDX-23/f02-build-finding-review-report-preview-and-approved-downloads), [B02](https://linear.app/hdxsfbr/issue/HDX-31/b02-demonstrate-ten-finding-triage-and-reporting-quality) |
| A08 | [V01](https://linear.app/hdxsfbr/issue/HDX-24/v01-scope-coverage-by-targetversion-with-honest-denominators), [V02](https://linear.app/hdxsfbr/issue/HDX-25/v02-show-targetversion-coverage-and-review-trends-in-the-ui) |
| A09 | [U02](https://linear.app/hdxsfbr/issue/HDX-12/u02-introduce-routed-application-shell-and-task-focused-navigation), [U03](https://linear.app/hdxsfbr/issue/HDX-17/u03-build-persistent-run-history-and-structured-run-detail), [U04](https://linear.app/hdxsfbr/issue/HDX-19/u04-replace-duplicate-launchers-with-one-preflighted-run-composer), [F02](https://linear.app/hdxsfbr/issue/HDX-23/f02-build-finding-review-report-preview-and-approved-downloads) |
| A10 | [C01](https://linear.app/hdxsfbr/issue/HDX-15/c01-introduce-draft-publish-version-and-archive-lifecycle-for-cases), [C02](https://linear.app/hdxsfbr/issue/HDX-18/c02-build-the-versioned-multi-step-case-workspace-and-starter-matrix) |
| A11 | [M01](https://linear.app/hdxsfbr/issue/HDX-16/m01-validate-active-roles-and-save-reusable-runmodel-definitions), [U04](https://linear.app/hdxsfbr/issue/HDX-19/u04-replace-duplicate-launchers-with-one-preflighted-run-composer), [F00](https://linear.app/hdxsfbr/issue/HDX-39/f00-add-leased-report-jobs-and-bounded-post-run-model-accounting), [M02](https://linear.app/hdxsfbr/issue/HDX-28/m02-make-unresolved-spend-investigable-and-explicitly-reconcilable) |
| A12 | [S01](https://linear.app/hdxsfbr/issue/HDX-20/s01-make-schedules-reusable-correctly-zoned-and-historically) |
| A13 | [K01](https://linear.app/hdxsfbr/issue/HDX-38/k01-publish-and-enforce-versioned-inter-agent-success-and-error), [A17](https://linear.app/hdxsfbr/issue/HDX-29/a17-give-bounded-adaptive-exploration-feedback-and-mutation-lineage) |
| A14 | [G01](https://linear.app/hdxsfbr/issue/HDX-26/g01-add-regression-identity-deduplication-and-explicit-replay-lineage), [G02](https://linear.app/hdxsfbr/issue/HDX-27/g02-run-regression-suites-and-show-fixedresurfacedunknown-states) |
| A15 | [B01](https://linear.app/hdxsfbr/issue/HDX-6/b01-define-rubric-first-threat-model-architecture-users-metrics-and), [Q01](https://linear.app/hdxsfbr/issue/HDX-13/q01-make-fixture-ci-and-browser-setup-reproducible), [O01](https://linear.app/hdxsfbr/issue/HDX-21/o01-expose-worker-queue-and-incremental-evidence-health), [M02](https://linear.app/hdxsfbr/issue/HDX-28/m02-make-unresolved-spend-investigable-and-explicitly-reconcilable), [P01](https://linear.app/hdxsfbr/issue/HDX-32/p01-produce-reproducible-100-case-fixture-baseline-and-scale-cost), [D02](https://linear.app/hdxsfbr/issue/HDX-33/d02-publish-operating-docs-threat-map-metrics-and-rubric-traceability), [I01](https://linear.app/hdxsfbr/issue/HDX-36/i01-complete-peer-integration-proof-and-security-review-evidence), [L02](https://linear.app/hdxsfbr/issue/HDX-37/l02-run-explicitly-authorized-100-case-live-performance-acceptance) |
| A16 | [B01](https://linear.app/hdxsfbr/issue/HDX-6/b01-define-rubric-first-threat-model-architecture-users-metrics-and), [K01](https://linear.app/hdxsfbr/issue/HDX-38/k01-publish-and-enforce-versioned-inter-agent-success-and-error), [C02](https://linear.app/hdxsfbr/issue/HDX-18/c02-build-the-versioned-multi-step-case-workspace-and-starter-matrix), [B02](https://linear.app/hdxsfbr/issue/HDX-31/b02-demonstrate-ten-finding-triage-and-reporting-quality), [P01](https://linear.app/hdxsfbr/issue/HDX-32/p01-produce-reproducible-100-case-fixture-baseline-and-scale-cost), [D02](https://linear.app/hdxsfbr/issue/HDX-33/d02-publish-operating-docs-threat-map-metrics-and-rubric-traceability), [X01](https://linear.app/hdxsfbr/issue/HDX-34/x01-implement-optional-read-only-evidence-adapter-against-an-explicit), [L01](https://linear.app/hdxsfbr/issue/HDX-35/l01-run-explicitly-authorized-live-synthetic-acceptance), [I01](https://linear.app/hdxsfbr/issue/HDX-36/i01-complete-peer-integration-proof-and-security-review-evidence), [L02](https://linear.app/hdxsfbr/issue/HDX-37/l02-run-explicitly-authorized-100-case-live-performance-acceptance), [X02](https://linear.app/hdxsfbr/issue/HDX-42/x02-integrate-scoped-read-only-corroboration-into-worker-outcomes) |
