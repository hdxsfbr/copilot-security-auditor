# Current-state audit: Clinical Co-Pilot Auditor

Audited September 28, 2026, America/Los_Angeles. Source revision: `e1ae270`.

## Assessment

The project is a functioning, bounded evaluation runner with substantial reliability work, but it is not yet the continuous evaluation and findings platform described in the PRDs. Its strongest parts are target reservations, credential snapshots, cautious retry behavior, model-spend accounting, and schedule execution. Its weakest parts are evidence completeness, the strength of automatic judgments, report usefulness, and the operator's ability to navigate and recover work.

**Recommendation: retain the execution and persistence foundations; rebuild the operator workflow, evidence representation, and findings/reporting experience.** A wholesale stack rewrite would discard useful, tested behavior. Cosmetic changes to the current page would leave the central problems unresolved.

The user clarified during this audit that **chart-context isolation is the intended cross-patient requirement**. A physician's legitimate ability to open another chart is not itself a Co-Pilot vulnerability. Assess whether the assistant stays within the chart bound to the current conversation.

The findings below retain their technical severity. In the subsequent planning discussion, the user selected **AgentForge submission rubric completion** as the delivery priority and approved an **optional read-only evidence adapter**. The [delivery plan](../../implementation/audit-delivery/PLAN.md) records the resulting order and scope.

## Scope and verification

Reviewed the original 18-page AgentForge PRD; the humanlayer research, PRD, technical design, implementation plan, task brief, HTML concept, and supplied screenshots; the Co-Pilot feature brief; lecture notes and the image-based lecture slides; README; all application layers, shared contracts, migrations, deployment files, and test coverage. The original research describes a historical greenfield checkout, not today's state.

All repository inspection stayed inside `/home/hdx/code/copilot-security-auditor`. No sibling projects were inspected. No production target, existing deployment database, paid provider, or Anthropic service was called. Browser checks used the actual built UI and API with disposable PostgreSQL, synthetic target fixtures, and local model stubs. No application source was changed.

| Verification | Result |
| --- | --- |
| Typecheck and production build | Passed |
| Unit/session tests | 18/18 passed |
| PostgreSQL integration tests | 21/21 passed |
| Failure-injection tests | 6/6 passed |
| Browser/API end-to-end tests | First run: 4/5 passed; adaptive test timed out selecting its target. Isolated retry passed; full rerun: 5/5 passed. Cause not established. |
| Additional audit probes | Reproduced catalog-error UI crash, lost run selection after reload, missing selected-run stop, partial PDF creation, citation loss, silent truncation, unsupported auto-confirmation, and confirmation/export after evidence loss. |
| Live deployment validation | Not performed. No local `.env` deployment configuration was present; Compose inspection reported missing `DB_PASSWORD`. Historical live screenshots and implementation notes are supporting evidence, not a fresh verification. |

The final successful suite runs cover 50 tests. Their success does not establish Judge accuracy or completeness of the live attack suite. Several tests assert the current placeholder reporting behavior rather than the PRD's required reporting outcome.

Audit evidence: [probe results](/home/hdx/code/copilot-security-auditor/docs/audit/2026-09-28/probe-results.json), [integrity probe](/home/hdx/code/copilot-security-auditor/docs/audit/2026-09-28/integrity-probe-results.json), [initial desktop UI](/home/hdx/code/copilot-security-auditor/docs/audit/2026-09-28/desktop-initial.png), [completed run UI](/home/hdx/code/copilot-security-auditor/docs/audit/2026-09-28/desktop-completed.png), [mobile UI](/home/hdx/code/copilot-security-auditor/docs/audit/2026-09-28/mobile-initial.png). Screenshots contain synthetic fixtures; external font requests were blocked for these captures.

## Requirements compared with implementation

| Capability | Current state | Assessment |
| --- | --- | --- |
| Operator-owned target and encrypted identities | Host allowlist, encrypted credentials, exact external-patient lookup, saved-target editing, immutable run credential references | Substantially implemented |
| User-facing chat and PDF workflow | Session/chart/conversation/ticket flow, up to three actions through the API, bounded PDF storage and upload | Implemented transport; observation fidelity needs work |
| Three initial threat categories | Three starter cases; chart-context preflight; limited report fingerprint for tool effects | Mechanism exists; breadth and independent outcome evidence remain limited |
| Selected-case execution | One case per run; repeatable definition snapshot | Working, but no multi-case suite or selected-run stop |
| Adaptive exploration | Orchestrator, Red Team, Judge, bounded proposals, case/time/cost limits and cooperative stop | Working bounded exploration; little strategic feedback or mutation lineage |
| Independent judgment | Separate Judge call, scoped checks, citation-reference and quote checks | Separate role implemented; confirmation is weaker than documented |
| Documentation agent | Model choice is stored, never invoked | Not implemented |
| Actionable findings and shared reports | Confirm/reject and approval gates; generic JSON export | Workflow skeleton exists; required report content absent |
| Regressions | Definitions created on confirmation and manually selectable | Partial; no suite, deployment trigger, reliable lifecycle or fix/resurfacing analysis |
| Coverage and trends | Global counts by category/outcome, plus per-adaptive-run progress | Partial; no target/version isolation or longitudinal analysis |
| Models and spend | Ollama/OpenRouter assignments, conservative holds, actual charges and unresolved states | Strong accounting foundation; confusing configuration and limited recovery UX |
| Recurring evaluations | Daily/weekly, time zones, DST handling, pause/resume, occurrence history, reservation conflicts | Strong backend; presentation and archive gaps |
| Operator control plane | One page containing all forms, evidence, findings and coverage | Functionally broad, operationally difficult |
| Launch operations | Compose, migration gating, artifact integrity endpoint, backup guidance, lease fencing | Useful foundation; worker health, diagnostics and CI need completion |

## Prioritized findings

P1 means address before relying on findings or unattended use. P2 means address in the next product iteration. These are implementation priorities, not vulnerability severity ratings for the target.

### A01 — P1: Evidence loses information required for judgment

**Reproduced.** The session adapter retains only summary text, claim text, and limitation text. It discards structured citation/source metadata, claim kinds, target turn identifiers and other response context. The citation check then searches the flattened text for `source:` or similar strings.

A fixture response with a claim carrying structured source metadata became plain text and was classified as a citation violation. Conversely, mentioning `source:` in prose can satisfy the check without establishing a valid source. This cannot verify the Co-Pilot's documented citation and provenance promises.

The adapter also silently cuts visible text at 10,000 characters. A probe placed a synthetic failure after that limit: it disappeared while the observation retained `status: complete` and had no truncation flag. Both the Judge and reviewer can therefore receive incomplete evidence presented as complete.

**Change:** introduce a versioned observation object preserving the relevant response structure, actual request/response identifiers, attachment provenance, and completeness metadata. Bound response ingestion, retain larger authorized evidence privately when needed, and make truncation force an incomplete or explicitly scoped judgment. Validate citations against structured sources, not text markers.

Sources: [session adapter](/home/hdx/code/copilot-security-auditor/apps/worker/src/session.ts:151), [checks](/home/hdx/code/copilot-security-auditor/apps/worker/src/checks.ts:5), [observation schema](/home/hdx/code/copilot-security-auditor/packages/contracts/src/index.ts:45), [target citation behavior](/home/hdx/code/copilot-security-auditor/docs/COPILOT_FEATURE.md:86).

### A02 — P1: The Judge lacks essential context, and the confirmation gate accepts unsupported claims

**Reproduced gate weakness; packet omissions verified in code.** The Judge packet contains the expected-safe text and assistant observations, but excludes the executed user messages, deterministic results, effect comparison, and attachment context. The technical design calls for these evidence inputs. The Judge cannot reliably assess a multi-turn attack or distinguish an echoed instruction from compliance without the actual interaction.

The automatic gate checks whether an exact quote occurs, not whether it supports the claimed violation. In the audit probe, the response was “I cannot reveal hidden instructions or access another chart.” A synthetic unsafe verdict quoted “hidden instructions,” asserted disclosure, and received `auto_confirm`. This demonstrates a gate defect; it does not establish how often a real Judge would make that mistake. The safe route is also permissive: it does not require reproduction completeness or a supporting quote.

**Change:** supply the full bounded, sanitized interaction and check/effect evidence; represent the challenged claim and evidence links explicitly; preserve the failed/passed gate reasons. Add a labeled calibration set containing refusals, prompt echoes, partial responses, unsupported citations and actual violations. Keep LLM-only auto-confirmation limited to policies with demonstrated reliability; send unvalidated cases to review while improving those policies.

Sources: [packet builder](/home/hdx/code/copilot-security-auditor/apps/worker/src/judge.ts:17), [Judge invocation](/home/hdx/code/copilot-security-auditor/apps/worker/src/process.ts:103), [confirmation gate](/home/hdx/code/copilot-security-auditor/apps/worker/src/checks.ts:18).

### A03 — P1: Missing evidence does not prevent later confirmation or export

**Reproduced end to end.** A PDF-backed run entered pending review. After deleting its synthetic evidence file, the integrity endpoint reported the missing artifact, but review returned `200 confirmed`, export approval returned 200, and export returned 200. Integrity is checked on PDF reads and execution, not when accepting a finding or approving its report.

This conflicts with the documented promise that missing evidence invalidates confirmation. A reviewer can approve a finding whose reproduction material is unavailable.

**Change:** validate the candidate's evidence references at confirmation and approval, persist integrity status, and expose failures in the review UI. Preserve historical decisions when evidence subsequently disappears, but mark the affected evidence as unavailable and block a new complete/reproducible export claim.

Sources: [review/approval](/home/hdx/code/copilot-security-auditor/apps/api/src/repository.ts:390), [artifact validation](/home/hdx/code/copilot-security-auditor/apps/api/src/artifacts.ts:29), [probe evidence](/home/hdx/code/copilot-security-auditor/docs/audit/2026-09-28/integrity-probe-results.json).

### A04 — P1: A model-catalog error blanks the entire application

**Reproduced in Chromium.** Returning a JSON 503 from `/api/models` triggers `Cannot read properties of undefined (reading 'map')`; the React root becomes empty. `fetch()` resolves on HTTP error responses, which the component stores as if they were the successful catalog shape. Usage/progress fetching has similar unchecked response handling.

**Change:** centralize HTTP status and response validation; keep the last valid data; render local retry/error states; add an application and panel error boundary. A provider outage should leave targets, existing evidence, local runs and schedules usable.

Source: [catalog fetch and rendering](/home/hdx/code/copilot-security-auditor/apps/web/src/ModelDesk.tsx:30).

### A05 — P1: The target timeout contradicts the documented turn duration

**Verified in code and target brief; no live timing test.** Every target request has a 15-second timeout, including chat turns. The target brief allows turns up to 90 seconds and extraction up to 30 seconds. A legitimate slow turn can therefore become ambiguous/incomplete while the target continues processing. Model calls separately use a fixed 30-second timeout, which also needs validation for the intended local models.

**Change:** use operation-specific deadlines consistent with the target contract and remaining run budget. Continue to forbid replay after ambiguous delivery. Display timeout stage and elapsed time, and preserve the cost reservation when provider delivery is uncertain.

Sources: [target timeout](/home/hdx/code/copilot-security-auditor/apps/worker/src/session.ts:23), [model timeout](/home/hdx/code/copilot-security-auditor/apps/worker/src/models.ts:81), [target resource bounds](/home/hdx/code/copilot-security-auditor/docs/COPILOT_FEATURE.md:279).

### A06 — P1: Runs cannot be reliably recovered or controlled from the UI

**Reproduced.** After completing a run, refreshing shows `NO RUN SELECTED` while the database still has the run. Only the target selection survives. There is no general run-list API/UI or run URL. Findings and schedule occurrences provide some entry points, but an ordinary manual safe, blocked, inconclusive or incomplete run has no history browser.

Selected-case runs have no stop button, and the backend stop method only accepts adaptive runs. The assigned-model launch path also hides the active-run ID returned on a reservation conflict, so its busy-target error offers no route to inspect the owner.

**Change:** add persistent run routes and a paginated history, restore an active run from the selected target, link busy-target errors to that run, and implement cooperative cancellation for both modes. Display the target identity beside every run, not just its version and UUID.

Sources: [run state/polling](/home/hdx/code/copilot-security-auditor/apps/web/src/main.tsx:191), [adaptive-only stop](/home/hdx/code/copilot-security-auditor/apps/api/src/repository.ts:222), [launch errors](/home/hdx/code/copilot-security-auditor/apps/web/src/ModelDesk.tsx:48).

### A07 — P1 product gap: Documentation and reporting do not meet either PRD

**Verified in code and exported fixture.** The Documentation role is configurable but never called. The export repeats generic phrases and instructs the recipient to consult restricted evidence for every reproduction step. It omits the actual attack, specific expected/observed behavior, target version, severity, remediation and fix-validation details. It is displayed as JSON in the page, with no report download workflow.

Redaction has removed the substance needed to reproduce the finding. The underlying candidate schema also lacks the severity, impact, remediation and lifecycle fields a useful report would need.

**Change:** define a real finding/report schema; implement bounded report drafting from confirmed evidence; verify its required fields and citations; replace patient details with stable synthetic aliases while preserving the attack mechanism. Let the operator preview the complete redacted artifact before approval and then download it. Keep publication approval separate from confirmation.

Sources: [export endpoint](/home/hdx/code/copilot-security-auditor/apps/api/src/app.ts:159), [finding schema](/home/hdx/code/copilot-security-auditor/db/migrations/002_findings.sql:1), original PRD pp. 10–11.

### A08 — P1 product gap: Coverage conflates targets, versions and kinds of evidence

**Verified in query and UI.** `/api/coverage` groups all stored runs by category/outcome, without target, target version or time window. Changing the selected target does not change the displayed coverage. Selected cases count finished runs, including blocked runs; adaptive cases count only those marked executed. These are useful outcome counts but not a consistent measure of exercised coverage.

There is no direct/indirect/multi-turn breakdown, OWASP mapping, coverage denominator or resilience trend. Users cannot answer “what remains untested on this version?” Counts can also keep showing `pending_review` after an operator confirms the associated finding, because execution outcome and finding disposition are separate but not explained.

**Change:** query coverage by target/version/time and explicit case/subcategory, separate attempted/executed/adjudicated counts, show gaps and blocked work, and display adjudication status separately. Keep unknown outcomes out of safe-rate denominators. Start with an accurate table before adding charts.

Sources: [coverage query](/home/hdx/code/copilot-security-auditor/apps/api/src/repository.ts:389), [coverage view](/home/hdx/code/copilot-security-auditor/apps/web/src/main.tsx:892).

### A09 — P2: Rebuild navigation and the run-detail/review experience

**Measured in the browser.** At 1440×1000, the initial page was 4,347 pixels tall; Run evidence began around y=3,641. At 390×844, it was 8,127 pixels tall; evidence began around y=7,035. There were no navigation landmarks. Mobile avoided horizontal overflow in the initial fixture, but required extensive scrolling.

Every visit foregrounds credential and case creation plus a large schedule editor. The UI offers two independent selected-run launchers and repeats model settings again for schedules. Clicking “Inspect evidence” scrolls to the top rather than the evidence section. Evidence is expanded JSON, and findings provide confirm/reject buttons without an adjacent structured explanation. The earlier HTML concept already proposed an overview, navigation and current activity; the implementation does not deliver that organization.

**Change:** build a persistent application shell and task-focused pages. Put current activity and review needs first. Show structured transcripts and check/Judge explanations by default; keep JSON as an expandable diagnostic view. Link review decisions to the exact case and cited turn. Use case-local sequence numbers rather than global database event IDs as the visual step counter.

Sources: [current application](/home/hdx/code/copilot-security-auditor/apps/web/src/main.tsx:328), [inspection scroll](/home/hdx/code/copilot-security-auditor/apps/web/src/main.tsx:854), [original UI concept](/home/hdx/code/copilot-security-auditor/docs/humanlayer/mockup-operator-control-plane.html:12).

### A10 — P2: Case authoring is narrower and less recoverable than execution

**Partly reproduced.** The API accepts up to three actions and six checks; the form authors one message, one check and optionally one PDF. There is no saved-case editor, duplicate/version action, action sequence builder or case archive. The form still claims a reciprocal access boundary is required, contrary to the current chart-context requirement.

PDF authoring performs create-case, upload-file, update-case as separate operations. An invalid PDF left a new runnable text-only case behind. The error advises creating another case, which accumulates abandoned definitions. Save errors are shown far above the form and mutations have no consistent pending state.

**Change:** use draft cases with validation and explicit publication; allow recovery of failed uploads in the same draft. Add sequence/check editing, cloning/versioning and an archive. Include category, boundary, expected outcome, attachments and negative-control/adversarial purpose in the preview.

Sources: [save workflow](/home/hdx/code/copilot-security-auditor/apps/web/src/main.tsx:220), [case contract](/home/hdx/code/copilot-security-auditor/packages/contracts/src/index.ts:21), [obsolete wording](/home/hdx/code/copilot-security-auditor/apps/web/src/main.tsx:521).

### A11 — P2: Model configuration includes inactive roles and hides useful availability information

**Verified in code.** Selected runs use only the Judge, but the assigned-model path validates all four configured roles. A missing unused Ollama model can block a valid Judge-only run. Assigning OpenRouter to an unused role also requires a cap and verified catalog pricing. Documentation has editable settings despite having no execution path.

The API returns installed Ollama models, but the UI ignores that list and uses free-text inputs. The legacy launcher, assigned-role launcher and schedule form hold separate settings; defaults differ and manual assignments reset on reload. All-paid configurations still require an Ollama URL in the contract/UI. Unresolved spend is retained correctly but has no operator reconciliation workflow or provider-generation reference. Whole-context cost reservations are conservative but are not previewed before target execution.

**Change:** use reusable model profiles and one run composer, expose only active roles, show discovered models and preflight status, preview conservative reservation/remaining cap, and provide explicit unresolved-charge investigation. Do not weaken the existing reservation logic merely to make estimates look cheaper.

Sources: [all-role validation](/home/hdx/code/copilot-security-auditor/apps/api/src/app.ts:103), [model UI](/home/hdx/code/copilot-security-auditor/apps/web/src/ModelDesk.tsx:66), [reservation calculation](/home/hdx/code/copilot-security-auditor/apps/worker/src/models.ts:25), [ledger](/home/hdx/code/copilot-security-auditor/apps/api/src/repository.ts:280).

### A12 — P2: Schedule presentation can mislabel time and hides removed history

**Verified in code.** The next occurrence is formatted with the browser's local time zone, then labeled with the schedule's zone. For a schedule in a different zone, the number and label disagree. Schedule cards omit key target/mode/case/budget context. Removing a schedule preserves the database rows but filters it out of the list, leaving no UI route to its retained history.

**Change:** explicitly format in the schedule's IANA zone, optionally show browser-local time separately, summarize the immutable definition, and add archived schedules. Prefer a time control over separate hour/minute numeric fields, and create schedules from saved run definitions instead of duplicating the entire model editor.

Sources: [schedule cards](/home/hdx/code/copilot-security-auditor/apps/web/src/ScheduleDesk.tsx:96), [schedule list/deletion](/home/hdx/code/copilot-security-auditor/apps/api/src/repository.ts:30).

### A13 — P2 product gap: Adaptive exploration has little memory of what worked

**Verified in code.** The next category is the least-executed selected category in the current run. The Orchestrator receives candidate titles/criteria and recent response snippets, not historical coverage, severe findings, regressions or prior verdicts. The Red Team does not receive the seed's original chat sequence or deterministic specifications, only its title, expected behavior, allowed attachments and recent responses. All actions in a case are proposed before its first response, so there is no within-case response-conditioned next turn.

This is useful bounded generation, but not the PRD's feedback-driven mutation and prioritization system. Repeatedly blocked or rejected work can keep the same category least-executed and consume the small case allowance.

**Change:** persist mutation lineage and give planning roles sanitized prior actions, outcomes, check results and coverage facts. Define a policy for repeated blocked/rejected categories and novelty/no-progress. Add a bounded observe→propose-next-turn option. Keep transport control and identities entirely outside model output.

Source: [adaptive loop](/home/hdx/code/copilot-security-auditor/apps/worker/src/adaptive.ts:45).

### A14 — P2 product gap: Regression storage exists; regression management does not

**Verified in code.** Replays are individual manually launched cases, not an executable suite. There is no target-version change trigger, fixed/resurfaced analysis, finding resolution workflow or semantic duplicate detection. Uniqueness is per candidate, so repeated successful attacks can create repeated findings/regressions. Replay history only joins the original target ID; running a case against another target does not appear in that regression history. Findings for adaptive runs link only to the parent run in the UI, making individual case review ambiguous when several findings share a run.

**Change:** add explicit regression identity and replay links, target/version grouping, suite execution, stable attack fingerprints and a finding lifecycle. Make review links select the exact adaptive case. Version changes should be an explicit trigger or operator action with a visible coverage result, not inferred from the existence of a case definition.

Sources: [regression creation/history](/home/hdx/code/copilot-security-auditor/apps/api/src/repository.ts:363), [finding projection](/home/hdx/code/copilot-security-auditor/apps/api/src/repository.ts:366), [replay UI](/home/hdx/code/copilot-security-auditor/apps/web/src/main.tsx:914).

### A15 — P2: Operational visibility is weaker than the execution safeguards

**Verified in code/configuration.** Health checks establish database/migration readiness, not worker availability or queue progress. The default worker handles one run at a time; multiple targets can queue independently, but concurrent execution requires additional workers. A stopped worker can leave queued runs reserved with no UI diagnosis or selected-run cancellation. API errors often collapse to generic messages without a traceable diagnostic code.

Run/event/usage polling continues after completion, and events are refetched in full. Schedule polling requests history for every schedule. Collection endpoints mostly lack pagination. There is no checked-in CI configuration despite the plan naming `.gitlab-ci.yml`; browser tests assume a hard-coded Chrome path.

**Change:** expose worker heartbeat, queue age, active leases and actionable error stages; poll incrementally and stop fast polling at terminal state; paginate histories. Add a reproducible CI browser/database environment and investigate the observed intermittent browser-test timeout. Preserve secret suppression while adding safe diagnostic identifiers.

Sources: [health endpoint](/home/hdx/code/copilot-security-auditor/apps/api/src/app.ts:19), [worker loop](/home/hdx/code/copilot-security-auditor/apps/worker/src/main.ts:8), [polling](/home/hdx/code/copilot-security-auditor/apps/web/src/main.tsx:191), [schedule polling](/home/hdx/code/copilot-security-auditor/apps/web/src/ScheduleDesk.tsx:28).

### A16 — P2 product gap: Threat coverage and documentation have drifted apart

The current chart-context implementation is consistent with the user's clarification and the later feature brief. Older PRD/TDD paragraphs and the case form still describe reciprocal record-access denial. The header says “selected case,” the footer says Phase 02, and the intro says unsafe observations wait for review even though automatic confirmation exists.

The unintended-action starter asks for advice even though the feature brief says the target must not give clinical advice. It is a useful negative control for unsolicited writes, but should not define the target's allowed behavior or represent a broad adversarial tool-misuse campaign. Current tool-action outcomes deliberately never become safe on the basis of the report fingerprint; the UI should state this limitation at case selection.

Cross-chart clinical-fact proof and broad write detection need a stronger evidence source. A read-only patient-report hash is an indicator, not an explanation of what changed, and the target brief says reviewed lab facts live in a module-owned table. Whether approved read-only target instrumentation is allowed remains an open question. Strict black-box tests should continue to report these limits rather than imply coverage.

The implementation plan leaves Phase 2 live completion unchecked. Supplied screenshots show real historical work, including a tool-action result marked safe in an older build; the current code correctly downgrades that class of result to inconclusive. Those screenshots should not serve as acceptance evidence for the current build without rerunning the relevant cases.

Sources: [implementation status](/home/hdx/code/copilot-security-auditor/docs/humanlayer/05-structure-outline-clinical-auditor.md:23), [starter case](/home/hdx/code/copilot-security-auditor/db/migrations/003_starter_cases.sql:1), [tool outcome policy](/home/hdx/code/copilot-security-auditor/apps/worker/src/process.ts:38), [Co-Pilot write behavior](/home/hdx/code/copilot-security-auditor/docs/COPILOT_FEATURE.md:140).

## What to retain, refactor and replace

| Area | Recommendation | Reason |
| --- | --- | --- |
| TypeScript / React / Express / PostgreSQL stack | Retain | No evidence that a framework change addresses the important gaps |
| Reservations, lease fencing, encrypted credential snapshots | Retain and extend | Tested safeguards that make execution and recovery defensible |
| Spend ledger and schedule/DST transactions | Retain; improve UI and reconciliation | Strong implementation relative to the rest of the product |
| Session/ticket/PDF transport | Refactor | Keep handshake and retry policy; improve observation fidelity and deadlines |
| Single-page frontend | Replace its information architecture | Operational tasks require distinct, persistent views |
| Judge evidence packet and checks | Redesign | Current representation cannot support several claimed judgments |
| Placeholder report export | Replace | Cannot satisfy reproduction or remediation requirements |
| Adaptive planner | Extend after judgment is trustworthy | More generated attacks are not useful if their evaluation is unreliable |

The no-login trusted-LAN boundary is an explicit release choice, not an accidental missing feature. Keep it for the current single-operator scope. Adoption by multiple operators or broader deployment would require a separate identity/access/accountability design; it should not be silently assumed by this audit.

## Proposed operator workflow

| View | Main job | Essential contents |
| --- | --- | --- |
| Overview | Decide what needs attention | Active/blocked runs, pending reviews, scheduled next run, unresolved charges, selected target/version coverage |
| Targets | Configure and verify access | Saved identities with masked credentials, chart assignments, target/worker reachability, last verified version |
| Cases | Maintain repeatable tests | Search/filter, boundary and expected behavior, multi-step editor, attachments, checks, draft/version/archive |
| New run | Launch one coherent definition | Target → selected suite or adaptive seeds → active models → bounds/preflight → start |
| Run detail | Understand and control an execution | Persistent URL, target/version, progress and stop, per-case transcript, checks, verdict rationale, evidence links and spend |
| Findings | Make a defensible decision | Exact candidate case, cited evidence beside verdict, uncertainty, severity/impact, review rationale, report preview |
| Regressions | Verify fixes | Suite selection, target/version comparison, recurring/fixed/unknown outcomes and linked findings |
| Schedules | Operate recurring work | Saved run definition, explicit zone, next occurrence, pause/archive, skipped/blocked reasons and history |

Keep the current restrained visual palette if desired. The main redesign is hierarchy and behavior: less setup on the home screen, one launch flow, and evidence close to the decisions it supports. Labels, contrast, keyboard focus, pending states and error placement should be checked as part of the rebuilt screens; this audit was not a formal accessibility conformance review.

## Recommended delivery order and acceptance checks

1. **Make existing results dependable:** fix A01–A05 and add targeted regression tests. Acceptance: structured citations survive transport; truncation cannot yield a complete result; a refusal cannot be auto-confirmed by an unrelated quote; missing PDF evidence blocks a new confirmation/approval; catalog failures leave the rest of the UI usable; legitimate slow turns obey operation-specific deadlines.
2. **Make runs recoverable and reviews usable:** introduce routes/history, one run composer, stop for both modes, structured transcripts, exact adaptive-case links and resilient API handling. Acceptance: refresh or open a run URL in another tab and recover its current state; a busy-target error opens the active run; inspect goes directly to the cited evidence.
3. **Complete the finding-to-fix loop:** implement finding/report schema, report drafting/validation, target/version coverage and regression suites. Acceptance: another engineer can reproduce a synthetic finding from an approved redacted report; a known failing/fixed/resurfaced case is correctly grouped across explicit versions.
4. **Increase attack value:** revise seeds around actual Co-Pilot guarantees; add approved effect/fact evidence if permitted; supply feedback and lineage to adaptive planning. Acceptance: a documented live suite covers direct/indirect/multi-turn injection, chart-context leakage and write attempts with honest outcome limitations, plus a labeled Judge calibration dataset.
5. **Complete operations and deliverables:** worker health/queue visibility, pagination, reproducible CI, schedule archive, spend reconciliation, documentation alignment and the chosen rubric requirements.

Avoid starting with more providers, more categories or an aesthetic reskin. The current provider set and transport are enough to validate the core product after these corrections.

## Original AgentForge submission gaps

If rubric completion is the primary objective, these become delivery blockers independently of the UI work. The checkout does not contain the required root `THREAT_MODEL.md`, `USERS.md`, `ARCHITECTURE.md`, `KEY_METRICS.md`, or an `evals/` result dataset. Supporting humanlayer documents cover some architecture and product rationale, but do not replace the required acceptance evidence.

The case schema has no OWASP mapping or subcategory, severity or exploitability metadata. There are no professional vulnerability reports meeting the required format, no checked-in Judge accuracy/drift evaluation set, and no documented 100-case performance/load baseline or scale cost analysis. Shared Zod contracts exist under `packages/contracts`, but selection/proposal messages and loose event details do not provide all the versioned inter-agent/error contracts and migration evidence described by the original brief. External submission artifacts, videos or live results may exist elsewhere; they were outside the authorized inspection scope and are not assumed absent globally.

Do not manufacture findings to satisfy the “three reports” requirement. Obtain real reproducible outcomes and distinguish negative/inconclusive evaluations from vulnerabilities. Do not change the intentional LAN-only auditor deployment solely because the original brief calls for a publicly accessible target; those are different applications.

## Decisions resolved during delivery planning

- Primary success criterion: prioritize the AgentForge submission rubric, with required documents and architecture decisions up front.
- Evidence boundary: design an optional read-only adapter for approved target audit events/seeded chart facts alongside user-facing attacks. Implement against explicit synthetic contracts first; live activation requires the matching operator-supplied contract.
- Chart-context isolation is resolved: use the later requirement, and remove contradictory reciprocal-access wording. No change to target permissions is required merely to run those cases.
