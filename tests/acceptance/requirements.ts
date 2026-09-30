// The acceptance requirement register (HDX-30 / Q02). Every audit defect A01-A16 and every major merged journey has an
// entry; every acceptance test title starts with the bracketed ids it verifies, e.g. `[A03][J05] ...`.
// tests/acceptance/traceability.test.ts fails if a requirement has no test, a title cites an unknown id, or the
// recorded evidence under evals/results/acceptance/ no longer matches this register.
//
// `limits` states, in plain words, what the fixture acceptance does NOT establish. Nothing here is live acceptance.

export type Requirement = { id: string; kind: 'audit' | 'journey' | 'browser'; title: string; owners: string; verifies: string; limits: string };

export const requirements: Requirement[] = [
  { id: 'A01', kind: 'audit', title: 'Evidence loses information required for judgment', owners: 'E01, X01, X02',
    verifies: 'Structured chart/document/guideline sources survive transport and are validated structurally; a prose "source:" marker is not a citation; text past 10,000 characters is flagged truncated and can never become safe or auto-confirmed.',
    limits: 'Citation checks prove a recognized structure is present, not that the cited fact is true. The target is a local stand-in.' },
  { id: 'A02', kind: 'audit', title: 'Judge lacks context; confirmation gate accepts unsupported claims', owners: 'E03, K01, X01, X02',
    verifies: 'The Judge packet carries the executed turns, deterministic checks and effect evidence; a refusal quoted by an unrelated unsafe verdict is not auto-confirmed; the labeled calibration set routes exactly as specified with zero false auto-confirms and zero false safes.',
    limits: 'The Judge is a scripted stand-in and the calibration set is small and synthetic: this shows the deterministic gates route as specified, not Judge accuracy, false-positive rate or drift on a real model.' },
  { id: 'A03', kind: 'audit', title: 'Missing evidence does not block confirmation or export', owners: 'E02, F02',
    verifies: 'Losing a stored PDF blocks new confirmation, report approval and export with an evidence-integrity conflict, while a historical decision is kept and marked rather than rewritten.',
    limits: 'Integrity is checked against the local artifact directory; remote or replicated storage is out of scope.' },
  { id: 'A04', kind: 'audit', title: 'A model-catalog error blanks the application', owners: 'U01',
    verifies: 'In a real browser against the real API, a 503 from the model catalog leaves the shell, other pages, entered drafts and run launching usable, shows a local alert, and recovers with a local retry.',
    limits: 'The fault is injected at the browser network edge; a genuine provider outage is not exercised.' },
  { id: 'A05', kind: 'audit', title: 'Target timeout contradicts the documented turn duration', owners: 'E04',
    verifies: 'A legitimate 15.3 s target turn completes through the real worker with one request; an ambiguous delivery ends incomplete with exactly one request and is never replayed; the turn deadline is the documented 90 s.',
    limits: 'Fixture timing only. No live slow turn, and model-call timeouts for the intended live models are not measured.' },
  { id: 'A06', kind: 'audit', title: 'Runs cannot be recovered or controlled from the UI', owners: 'R01, U03',
    verifies: 'Run history pages across a cursor; a run is restored by id and by hard reload; queued and running selected runs can be stopped cooperatively; a busy-target conflict names the owning run and the UI links to it.',
    limits: 'Stop is cooperative: in-flight target or model work is not interrupted mid-request.' },
  { id: 'A07', kind: 'audit', title: 'Documentation and reporting do not meet the PRD', owners: 'K01, F00, F01, F02, B02',
    verifies: 'A confirmed finding yields a cited, redacted report with the attack to reproduce, expected and observed behavior, severity and remediation; approval is per exact content hash; download is the approved revision only; invalid model output creates no revision.',
    limits: 'The Documentation model is a scripted stand-in: report wording quality from a real model is not evaluated. Three real vulnerability reports still require live evidence (L01).' },
  { id: 'A08', kind: 'audit', title: 'Coverage conflates targets, versions and kinds of evidence', owners: 'V01, V02',
    verifies: 'Coverage is scoped per target and version; blocked, inconclusive and untested work is never counted as safe and is excluded from the safe-rate denominator; review decisions change disposition, never the recorded outcome; catalog gaps stay visible.',
    limits: 'Coverage cannot be queried by OWASP tag or by direct/indirect/multi-turn kind; OWASP mappings live in each case rubric. Three pre-matrix historical starter cases have no rubric and report as unknown_legacy.' },
  { id: 'A09', kind: 'audit', title: 'Navigation and run-detail/review experience', owners: 'U02, U03, U04, F02',
    verifies: 'A persistent shell with labelled landmarks, a skip link, route URLs, keyboard-operable navigation with visible focus, a one-step run composer and a keyboard-only review decision.',
    limits: 'Not a formal accessibility conformance review (no screen-reader pass, no WCAG audit of contrast or target size).' },
  { id: 'A10', kind: 'audit', title: 'Case authoring is narrower and less recoverable than execution', owners: 'C01, C02',
    verifies: 'Drafts are not runnable; a failed upload leaves the same draft recoverable; publication validates the full definition; published versions are immutable, cloneable with their PDF and archivable; archived cases cannot start runs but keep their history.',
    limits: 'PDF content is synthetic and minimal.' },
  { id: 'A11', kind: 'audit', title: 'Model configuration includes inactive roles', owners: 'M01, U04, F00, M02',
    verifies: 'A selected run validates only the Judge; a missing local model is refused before any target reservation; an all-paid Judge needs no local endpoint and preflight previews the conservative reservation against the cap; saved run definitions are revisioned and launched exactly.',
    limits: 'The paid provider is a local HTTP stand-in; real OpenRouter catalogs and billing are not exercised. Unresolved-charge holds are per run, not account-wide.' },
  { id: 'A12', kind: 'audit', title: 'Schedule presentation mislabels time and hides history', owners: 'S01',
    verifies: 'Next occurrences are computed in the schedule zone including the DST gap and repeated hour, shown with that zone in the browser and separately labelled in the browser zone, and archived schedules keep their occurrence history and run links.',
    limits: 'The scheduler is driven by calling the dispatch tick with explicit instants; wall-clock scheduling in a deployed API process is not observed.' },
  { id: 'A13', kind: 'audit', title: 'Adaptive exploration has little memory of what worked', owners: 'K01, A17',
    verifies: 'Adaptive runs record per-case mutation lineage, give later planning sanitized prior verdicts, keep every proposal inside the three-action bound, never dispatch a rejected proposal, and stop on repeated no-signal outcomes with a recorded reason.',
    limits: 'The Orchestrator and Red Team are scripted stand-ins, so attack quality and novelty are not evaluated.' },
  { id: 'A14', kind: 'audit', title: 'Regression storage exists; regression management does not', owners: 'G01, G02',
    verifies: 'Equivalent confirmed findings share one regression identity while every finding stays listed; suites replay through the real worker on explicit target versions; states are recurring, fixed, resurfaced or unknown per version and an unreplayed or inconclusive result never reads as fixed.',
    limits: 'Versions are set by the fixture handshake. No real deployment or fix is observed. Known bug O9: a target whose handshake omits module_version is labelled "unknown" and a safe replay there can read as fixed.' },
  { id: 'A15', kind: 'audit', title: 'Operational visibility is weaker than the execution safeguards', owners: 'B01, Q01, O01, M02, P01, D02, I01, L02',
    verifies: 'Operations health distinguishes no worker, idle, busy, stale and aging-queue states with allowlisted codes; event and run pages are bounded and lossless; the CI definition runs the fixture suite; browser tests honour CHROME_BIN.',
    limits: 'Worker heartbeat ageing is simulated by editing timestamps. The remote pipeline is not re-run by this acceptance; see validation.md for its recorded status.' },
  { id: 'A16', kind: 'audit', title: 'Threat coverage and documentation have drifted apart', owners: 'B01, K01, C02, B02, P01, D02, X01, L01, I01, L02, X02',
    verifies: 'An unintended-tool-action case is never safe on a chat reply alone; a changed chart report routes to review; chart-context isolation is tested without reciprocal record-access wording; the starter matrix covers all three categories with OWASP mappings.',
    limits: 'Known remaining drift: the application footer still reads "PHASE 02 / THREE TRUST BOUNDARIES" (apps/web/src/components/AppShell.tsx:36). Broad write detection still needs the optional read-only evidence source.' },
  { id: 'J01', kind: 'journey', title: 'Case authoring and publish lifecycle', owners: 'C01, C02', verifies: 'Draft, validate, publish, clone, version and archive through the public API and the case workspace.', limits: 'See A10.' },
  { id: 'J02', kind: 'journey', title: 'Run composer, selected and adaptive runs', owners: 'M01, U04, R01, A17', verifies: 'Launch, preflight, saved definitions, stop and busy-target handling for selected and adaptive runs.', limits: 'See A06, A11, A13.' },
  { id: 'J03', kind: 'journey', title: 'Evidence and observations', owners: 'E01, E04, X01, X02', verifies: 'Structured observations, completeness, deadlines and the disabled-by-default read-only evidence path.', limits: 'See A01, A05. Read-only corroboration is covered by its own fixture tests and is disabled by default.' },
  { id: 'J04', kind: 'journey', title: 'Judge policy gates', owners: 'E03, K01', verifies: 'Deterministic gates around the Judge verdict, including the labeled calibration set.', limits: 'See A02.' },
  { id: 'J05', kind: 'journey', title: 'Findings review and report drafting', owners: 'F00, F01, F02, B02', verifies: 'Review decisions with typed rationale, report job, redacted draft, exact-revision approval and download.', limits: 'See A07.' },
  { id: 'J06', kind: 'journey', title: 'Regression identity and suites', owners: 'G01, G02', verifies: 'Identity grouping, suite replay and per-version state.', limits: 'See A14.' },
  { id: 'J07', kind: 'journey', title: 'Scoped coverage and OWASP mapping', owners: 'V01, V02, C02', verifies: 'Per-target and per-version coverage with honest denominators and OWASP-mapped catalog cases.', limits: 'See A08.' },
  { id: 'J08', kind: 'journey', title: 'Spend reconciliation', owners: 'M02', verifies: 'An unbilled paid call stays held; an evidence-backed, bounded, idempotent attestation releases it; provider-reported and operator-attested totals stay separate; local inference is never priced.', limits: 'See A11. Real provider invoices are not reconciled.' },
  { id: 'J09', kind: 'journey', title: 'Schedules', owners: 'S01', verifies: 'Zone-correct occurrences, dispatch through the real worker, skipped and blocked reasons, pause and archive.', limits: 'See A12.' },
  { id: 'J10', kind: 'journey', title: 'Worker, queue and evidence health', owners: 'O01, Q01', verifies: 'Operations health states, bounded pages and incremental event reads.', limits: 'See A15.' },
  { id: 'J11', kind: 'journey', title: 'Complete finding-to-regression workflow', owners: 'all', verifies: 'Author, run, review, redacted report, approval, regression suites on explicit versions and scoped coverage in one continuous flow.', limits: 'Judge and Documentation models are scripted stand-ins; the target is a local stand-in.' },
  { id: 'BASELINE', kind: 'journey', title: 'Representative synthetic throughput baseline', owners: 'P01 (owns the 100-case fixture baseline), L02 (owns live 100-case acceptance)',
    verifies: 'The baseline harness runs the real pipeline end to end, injects latency when asked, computes correct percentiles, labels its output as a fixture baseline, and the recorded baseline carries the exact revision, machine notes and known limits.',
    limits: 'Orchestration overhead against local stand-ins only. It is not a live 100-case result, not live performance and not a capacity claim.' },
  { id: 'UI-KEYBOARD', kind: 'browser', title: 'Keyboard navigation in a real browser', owners: 'U02, U04, F02', verifies: 'Skip link, landmark navigation, visible focus, keyboard-only launch and review.', limits: 'See A09.' },
  { id: 'UI-SMALL-SCREEN', kind: 'browser', title: 'Small-screen layout in a real browser', owners: 'U02, V02, S01', verifies: 'Every workspace page at 390px has no sideways page scroll, keeps controls on screen and keeps navigation reachable.', limits: 'One phone width on one Chromium build.' },
  { id: 'UI-RECOVERY', kind: 'browser', title: 'Error recovery in a real browser', owners: 'U01, U03, C01', verifies: 'Catalog 503, list 503, dropped connection, hard reload, busy target and draft preservation.', limits: 'Faults are injected at the browser network edge.' },
];

/**
 * Product behavior seen while writing the acceptance tests that looks like a gap or a surprise. Recorded, NOT fixed here
 * (Q02 is verification only); each is a candidate for a separate issue. None is a regression of an audited defect.
 */
export type Observation = { id: string; kind: 'bug' | 'gap' | 'note'; where: string; what: string; suggestion: string };
export const observations: Observation[] = [
  { id: 'O1', kind: 'gap', where: 'apps/web/src/components/AppShell.tsx:36', what: 'The footer still reads "PHASE 02 / THREE TRUST BOUNDARIES" (audit A16 drift) while the published catalog now holds the 20-case starter and targeted matrix.', suggestion: 'Copy fix in a separate issue.' },
  { id: 'O2', kind: 'gap', where: 'apps/api/src/app.ts:113 (dispatchRun) and apps/api/src/repository.ts:627 (reserveCall)', what: 'POST /api/runs returns 202 for a paid Judge whose conservative reservation exceeds openRouterCapUsd. Only the worker refuses, after the target turn and before the provider call, so the run ends incomplete. The composer blocks this case from its preflight preview; the API does not.', suggestion: 'Refuse at dispatch so an API client cannot spend a target turn on a run that cannot be judged.' },
  { id: 'O3', kind: 'gap', where: 'apps/api/src/app.ts:234 (POST /api/runs/:id/stop)', what: 'The same 409 "No active run to stop" is returned for an unknown run id and for a run that already finished.', suggestion: 'Return 404 for unknown ids.' },
  { id: 'O4', kind: 'note', where: 'apps/worker/src/adaptive.ts:128 (adaptiveOutcome)', what: 'An adaptive run that the no-signal stagnation policy stops early finishes safe although part of its case allowance was not spent, while one rejected proposal makes the whole run incomplete.', suggestion: 'Decide whether an early stagnation stop should be reported as safe.' },
  { id: 'O5', kind: 'gap', where: 'db/migrations/003_starter_cases.sql, 004_chart_context_case.sql, 011_versioned_starter_matrix.sql', what: 'Three pre-matrix starter cases ("Starter: direct instruction override", "Starter: Co-Pilot chart-context isolation", "Starter: unintended chart action") are published without a rubric: coverage reports them as unknown_legacy and they carry no OWASP mapping. Coverage cannot be filtered by OWASP tag.', suggestion: 'Archive or re-version them with rubrics; add an OWASP filter if the rubric needs it.' },
  { id: 'O6', kind: 'note', where: 'apps/api/src/repository.ts:625 (reserveCall)', what: 'An unresolved paid-call hold blocks further paid calls only inside the same run. A new run with its own cap can still call the provider while an earlier charge is unresolved.', suggestion: 'Decide whether unresolved spend should also gate new paid runs on the same account.' },
  { id: 'O7', kind: 'note', where: 'apps/worker/src/process.ts:87 and :91 (scopeOutcome)', what: 'The unintended_tool_action safe-to-inconclusive and cross_patient auto_confirm-to-pending_review branches are unreachable today because judgePolicy already routes those categories the same way. They are defence in depth that no test can exercise.', suggestion: 'None needed; keep or remove deliberately.' },
  { id: 'O8', kind: 'note', where: 'apps/api/src/app.ts:295 (GET /api/coverage)', what: 'The legacy coverage endpoint still pools every target and version. The UI uses GET /api/coverage/scoped.', suggestion: 'Retire it when no client depends on it.' },
  { id: 'O9', kind: 'bug', where: 'apps/worker/src/session.ts:189 and apps/api/src/regression-states.ts:36', what: 'When a target handshake omits module_version the worker records the literal label "unknown". Coverage treats that label as an unestablished version (coverage.ts:24), but regression state treats it as a verified version: a safe replay there after a violation on a verified version is reported fixed / safe_on_later_version, contradicting the documented rule that a version-less result is always unknown. Reproduced with the fixture target; not fixed here.', suggestion: 'Store null (or normalise "unknown") where the version is recorded, so both consumers agree that it was never verified.' }
];

export const requirementIds = requirements.map(item => item.id);
/** Parses the leading `[ID][ID]...` of an acceptance test title. */
export function idsOf(title: string): string[] {
  const match = /^((?:\[[A-Z0-9-]+\])+)/.exec(title);
  return match ? [...match[1].matchAll(/\[([A-Z0-9-]+)\]/g)].map(item => item[1]) : [];
}
