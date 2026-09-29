import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { caseInput, observation, policyTrace, verdict as verdictSchema, type CaseInput, type Observation, type Verdict } from '../packages/contracts/src/index.js';
import { agentMessageHeader, agentRefs, judgeToDocumentation, parseAgentMessage, type AgentContext } from '../packages/contracts/src/agent.js';
import { documentationReport, findingReview, rationaleFits, reportContent, reportFacts, type DocumentationReport, type ReportFacts } from '../packages/contracts/src/report.js';
import { checkCase, judgePolicy, type CheckResult } from '../apps/worker/src/checks.js';
import { scrub, scrubEvidence } from '../apps/worker/src/judge.js';
import { projectObservation, scopeOutcome } from '../apps/worker/src/process.js';
import { buildFacts, makeRedactor, type FindingEvidence } from '../apps/api/src/findings.js';
import { hashContent, narrativeProblem, renderReportMarkdown } from '../apps/api/src/report-revisions.js';

// B02: a SIMULATED ten-plus finding triage exercise. Everything here is fixture data. No model, target or network is
// contacted; the "Judge verdicts" are recorded fixtures. What is real is the platform code that consumes them: the
// deterministic checks, the Judge policy gates, the scope downgrade, the review rationale contract, the Judge to
// Documentation handoff contract, fact building, redaction and the Documentation narrative validation.

type Truth = 'true_positive' | 'false_positive' | 'unverified';
type Decision = 'validate' | 'remediate' | 'defer' | 'reject_false_positive';
type Entry = {
  id: string; simulated: boolean; title: string; scannerClaim: string; scannerSeverity: string;
  classification: { category: string; subcategory: string; owaspLlm: string[]; owaspWeb: string[]; truth: Truth };
  case: CaseInput;
  evidence: { observations: unknown[]; effect: 'unchanged' | 'changed' | 'unavailable' | null; proposedVerdict: unknown; preScrubResponses?: Record<string, string> };
  checkResults: { kind: string; outcome: string; signal?: string }[];
  routing: { outcome: string; failedGates: string[]; candidateCreated: boolean };
  severity: { triaged: string; rationale: string; exploitability: string; clinicalImpact: string };
  triage: { decision: Decision; rationale: string; steps?: string[]; remediation?: string[]; validationPlan?: string; regressionCase?: string; deferReason?: string; revisitTrigger?: string; interimControl?: string;
    disprovedBy?: { gates: string[]; evidence: string }; reviewDecision: unknown };
  report: { kind: 'validated_narrative' | 'overclaimed_draft' | 'none'; basis?: string; note: string; narrative?: unknown; expectedProblem?: string | null };
  counterfactuals?: { name: string; verdict: unknown; note: string; expected: { outcome: string; failedGates: string[] } }[];
};
type Scan = { schema: string; version: number; simulated: boolean; label: string; identities: { A: Identity; B: Identity }; findings: Entry[] };
type Identity = { username: string; pubpid: string; password: string };

const scan = JSON.parse(readFileSync(new URL('../evals/triage/simulated-scan-v1.json', import.meta.url), 'utf8')) as Scan;
const identities = [scan.identities.A, scan.identities.B];
const redactor = makeRedactor(identities);
const byId = (id: string) => scan.findings.find(item => item.id === id)!;
const observed = (entry: Entry) => entry.evidence.observations.map(item => observation.parse(item));

// Mirrors the worker's pre-Judge enforcement in evaluateCase: denied/failed, truncated and partial evidence never reach the Judge.
function route(entry: Entry, proposed: unknown = entry.evidence.proposedVerdict) {
  const definition = caseInput.parse(entry.case);
  const raw = observed(entry);
  const provider = raw.map(item => projectObservation(item, identities, [], true));
  const privateChecks = checkCase(definition, raw, identities), providerChecks = checkCase(definition, provider, identities);
  // The citation check must survive the same provider projection the Judge sees; identifier and effect checks use private evidence.
  const checks = privateChecks.map((check, index) => check.kind === 'required_source_citation' ? providerChecks[index] : check);
  const other = definition.user === 'A' ? identities[1] : identities[0];
  const executed = definition.actions.map((action, index) => ({ turn: index + 1, kind: action.kind, message: definition.category === 'cross_patient' ? action.message.replaceAll('{{OTHER_PATIENT_ID}}', other.pubpid) : action.message, sourceId: raw[index].v === 2 ? raw[index].attachment?.sourceId : undefined }));
  const input = { checks, observations: provider, category: definition.category!, expectedTurns: definition.actions.length,
    attachments: executed.filter(action => action.kind === 'attach_pdf').map(action => ({ turn: action.turn, sourceId: action.sourceId })),
    executedPrompts: executed.map(action => scrub(action.message, identities, [])), effect: entry.evidence.effect };
  const base = judgePolicy({ ...input, verdict: null });
  const early = (outcome: string, reason: string) => ({ outcome, passed: base.passed, failed: [...base.failed, reason], canonicalClaim: undefined as string | undefined, checks, definition, raw, verdict: null as Verdict | null });
  if (raw.some(item => ['denied', 'failed'].includes(item.status))) return early('inconclusive', 'target_denied_or_failed');
  if (raw.some(item => item.v === 2 && item.completeness.state === 'truncated')) return early('incomplete', 'target_evidence_truncated');
  if (raw.some(item => item.status === 'partial')) return early(base.outcome, 'target_evidence_partial');
  const verdict = proposed ? verdictSchema.parse(proposed) : null;
  const policy = judgePolicy({ ...input, verdict });
  const scoped = scopeOutcome(definition.category, policy.outcome, entry.evidence.effect);
  return { outcome: scoped as string, passed: policy.passed, failed: scoped === policy.outcome ? policy.failed : [...policy.failed, 'scope_downgrade'], canonicalClaim: policy.canonicalClaim, checks, definition, raw, verdict };
}

const uuid = (kind: number, entry: Entry) => `${kind}0000000-0000-4000-8000-${String(Number(entry.id.slice(4))).padStart(12, '0')}`;
// What the platform would persist for a confirmed candidate. `route` picks the confirmation route the platform itself would use.
function evidenceFor(entry: Entry, confirmation: 'automatic' | 'operator'): FindingEvidence {
  const routed = route(entry);
  const verdict = routed.verdict!;
  const policy = policyTrace.parse({ version: 2, outcome: routed.outcome, passed: routed.passed, failed: routed.failed, ...(routed.canonicalClaim ? { canonicalClaim: routed.canonicalClaim } : {}) });
  return { id: uuid(5, entry), runId: uuid(6, entry), state: 'confirmed', route: confirmation, decidedAt: null, adaptiveCaseId: null, sourceCaseId: uuid(7, entry), targetId: uuid(8, entry), targetName: 'Simulated Clinical Co-Pilot (no live target)', version: 'sim-v1',
    definition: routed.definition, observations: routed.raw, missing: [],
    checks: routed.checks.map(check => ({ ...check, coveredClaim: scrubEvidence(check.coveredClaim, identities, []) })),
    verdict: { ...verdict, claim: policy.canonicalClaim ?? scrubEvidence(verdict.claim, identities, []), evidenceQuote: verdict.evidenceQuote ? scrubEvidence(verdict.evidenceQuote, identities, []) : undefined, challengedClaim: verdict.challengedClaim ? scrubEvidence(verdict.challengedClaim, identities, []) : undefined,
      materialUncertainties: verdict.materialUncertainties.map(item => scrubEvidence(item, identities, [])), policy } };
}
const factsFor = (evidence: FindingEvidence) => buildFacts(evidence, redactor, { evidenceRevision: 1, regression: 'new', validationHistory: [] });

// The same sequence createDocumentationHandler applies to a model reply: redact, strict schema, then citation/quote/identifier validation.
function draft(narrative: unknown, facts: ReportFacts, author: 'documentation' | 'operator' = 'documentation') {
  const parsed = documentationReport.safeParse(redactor.deep(narrative));
  if (!parsed.success) return { problem: 'schema' as string | null, narrative: null };
  return { problem: narrativeProblem(parsed.data, facts, author), narrative: parsed.data };
}
// The Judge to Documentation envelope the handler rebuilds from persisted evidence (reports.ts), validated by the K01 contract.
function handoffFor(evidence: FindingEvidence, facts: ReportFacts) {
  const context: AgentContext = { runId: evidence.runId, caseId: evidence.sourceCaseId!, attemptId: `${evidence.runId}-job` };
  const human = facts.basis === 'human_confirmed';
  const policy = human && facts.policy.outcome !== 'pending_review' ? { ...facts.policy, outcome: 'pending_review' as const, failed: [...facts.policy.failed, 'routed_to_human_review'] } : facts.policy;
  return parseAgentMessage(judgeToDocumentation, { channel: 'judge_to_documentation', status: 'ok', header: agentMessageHeader(context),
    payload: { findingId: evidence.id, basis: facts.basis, sourceOutcome: human ? 'pending_review' : 'auto_confirm', evidenceRefs: agentRefs(evidence.observations, context), policy, regression: facts.regression } }, context);
}
function finalize(narrative: DocumentationReport, facts: ReportFacts) {
  const content = reportContent.parse({ v: 1, facts, narrative });
  const markdown = renderReportMarkdown({ findingId: facts.findingId, revision: 1, contentHash: hashContent(content), content, approval: null });
  return { content, markdown };
}
// Structural completeness of the rendered report (presence of the sections an engineer needs). Not a measure of clarity.
function utility(markdown: string, facts: ReportFacts, narrative: DocumentationReport) {
  return {
    uniqueId: markdown.includes(facts.findingId), severity: markdown.includes(`| Severity | ${narrative.severity.level} |`), clinicalImpact: markdown.includes(narrative.clinicalImpact),
    reproduction: markdown.includes('## Minimal reproduction') && facts.reproduction.every(step => markdown.includes(step.instruction)),
    expectedVsObserved: markdown.includes('## Expected behavior') && markdown.includes('## Observed behavior') && narrative.observedBehavior.quotes.every(quote => markdown.includes(`> ${quote}`)),
    remediation: markdown.includes('## Remediation') && narrative.remediation.every(item => markdown.includes(item)), evidence: facts.evidence.every(item => markdown.includes(`**${item.ref}**`)),
    status: markdown.includes('| Status | open |') && markdown.includes('## Fix-validation history'),
    noRawIdentifiers: !identities.some(item => [item.pubpid, item.username, item.password].some(value => markdown.includes(value)))
  };
}
const validated = () => scan.findings.filter(entry => entry.report.kind === 'validated_narrative');
const overclaimed = () => scan.findings.filter(entry => entry.report.kind === 'overclaimed_draft');
const confirmationFor = (entry: Entry) => route(entry).outcome === 'auto_confirm' ? 'automatic' as const : 'operator' as const;

test('the scan is clearly labeled simulated, has the required severity mix and complete triage records', () => {
  assert.equal(scan.schema, 'clinical-copilot-auditor/simulated-triage-scan');
  assert.equal(scan.simulated, true);
  assert.match(scan.label, /^SIMULATED SCAN\./);
  assert.match(scan.label, /None is a discovered vulnerability/);
  assert.ok(scan.findings.length >= 10, `expected at least ten entries, found ${scan.findings.length}`);
  assert.equal(new Set(scan.findings.map(entry => entry.id)).size, scan.findings.length);
  const count = (predicate: (entry: Entry) => boolean) => scan.findings.filter(predicate).length;
  assert.ok(count(entry => entry.severity.triaged === 'critical') >= 2);
  assert.ok(count(entry => entry.severity.triaged === 'high') >= 3);
  assert.ok(count(entry => entry.severity.triaged === 'medium') >= 3);
  assert.ok(count(entry => entry.classification.truth === 'false_positive') >= 3);
  for (const decision of ['validate', 'remediate', 'defer', 'reject_false_positive'] as const) assert.ok(count(entry => entry.triage.decision === decision) >= 1, `no ${decision} decision`);
  for (const entry of scan.findings) {
    assert.match(entry.id, /^SIM-\d{3}$/);
    assert.equal(entry.simulated, true, entry.id);
    const { classification, triage } = entry, rubric = entry.case.rubric!;
    assert.ok(classification.category && classification.subcategory && classification.owaspLlm.length > 0 && classification.owaspLlm.every(id => /^LLM\d{2}:2025$/.test(id)) && classification.owaspWeb.every(id => /^A\d{2}:2021$/.test(id)), entry.id);
    assert.equal(entry.case.category, classification.category, entry.id);
    assert.equal(rubric.subcategory, classification.subcategory, entry.id);
    assert.deepEqual(rubric.owaspMappings, [...classification.owaspLlm, ...classification.owaspWeb], entry.id);
    assert.equal(caseInput.safeParse(entry.case).success, true, `${entry.id} case must satisfy the platform case contract`);
    assert.ok(entry.evidence.observations.length >= 1 && entry.evidence.observations.length === entry.case.actions.length, `${entry.id} evidence must cover every executed action`);
    for (const item of entry.evidence.observations) assert.equal(observation.safeParse(item).success, true, entry.id);
    assert.ok(entry.severity.rationale && entry.severity.exploitability && entry.severity.clinicalImpact && triage.rationale && entry.scannerClaim, entry.id);
    // Classification and decision must agree.
    if (classification.truth === 'true_positive') { assert.ok(['validate', 'remediate'].includes(triage.decision), entry.id); assert.equal(entry.severity.triaged, rubric.severity, `${entry.id} triaged severity must match the case rubric the report contract enforces`); }
    if (classification.truth === 'false_positive') { assert.equal(triage.decision, 'reject_false_positive', entry.id); assert.equal(entry.severity.triaged, 'none', entry.id); }
    if (classification.truth === 'unverified') { assert.equal(triage.decision, 'defer', entry.id); assert.ok(['low', 'medium', 'high', 'critical'].includes(entry.severity.triaged), entry.id); }
    if (triage.decision === 'validate') assert.ok(triage.steps?.length && triage.remediation?.length && triage.validationPlan && triage.regressionCase, entry.id);
    if (triage.decision === 'remediate') assert.ok(triage.remediation?.length && triage.validationPlan && triage.regressionCase, entry.id);
    if (triage.decision === 'defer') assert.ok(triage.deferReason && triage.revisitTrigger && triage.interimControl, entry.id);
    if (triage.decision === 'reject_false_positive') assert.ok(triage.disprovedBy?.gates.length && triage.disprovedBy.evidence, entry.id);
  }
});

test('the scan holds only obviously synthetic data and references no live target', () => {
  const text = readFileSync(new URL('../evals/triage/simulated-scan-v1.json', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /https?:\/\//i, 'no URLs');
  assert.doesNotMatch(text, /openemr|sslip|audit-physician|challenge-admin|AF-[A-Z]/i, 'no live target account or patient identifiers');
  assert.deepEqual([...new Set(text.match(/\bSYN-\d+\b/g))].sort(), ['SYN-900001', 'SYN-900002']);
  assert.deepEqual(identities.map(item => [item.username, item.pubpid]), [['sim-clinician-a', 'SYN-900001'], ['sim-clinician-b', 'SYN-900002']]);
  assert.ok(identities.every(item => item.password.startsWith('SIM-ONLY-')));
});

test('every entry routes through the real deterministic checks, Judge policy gates and scope downgrade exactly as recorded', () => {
  for (const entry of scan.findings) {
    const routed = route(entry);
    assert.deepEqual({ outcome: routed.outcome, failedGates: routed.failed, candidateCreated: routed.outcome === 'pending_review' || routed.outcome === 'auto_confirm' }, entry.routing, entry.id);
    assert.deepEqual(routed.checks.map(check => ({ kind: check.kind, outcome: check.outcome, ...(check.signal ? { signal: check.signal } : {}) })), entry.checkResults, entry.id);
    if (routed.outcome === 'auto_confirm') {
      // The only automatic confirmation path is a deterministic structural citation violation in a prompt-injection case.
      assert.equal(entry.classification.category, 'prompt_injection', entry.id);
      assert.ok(routed.passed.includes('independent_structural_violation'), entry.id);
      assert.match(routed.canonicalClaim ?? '', /^Missing structured source citation for claim: /, entry.id);
      assert.equal(entry.classification.truth, 'true_positive', entry.id);
    }
    // A simulated finding that is not a true positive can never reach the automatic route.
    if (entry.classification.truth !== 'true_positive') assert.notEqual(routed.outcome, 'auto_confirm', entry.id);
    for (const counter of entry.counterfactuals ?? []) {
      const counterfactual = route(entry, counter.verdict);
      assert.deepEqual({ outcome: counterfactual.outcome, failedGates: counterfactual.failed }, counter.expected, `${entry.id}: ${counter.name}`);
      assert.notEqual(counterfactual.outcome, 'safe', `${entry.id}: the platform must not call a chart-ID-bearing reply safe`);
    }
  }
  const outcomes = Object.fromEntries(scan.findings.map(entry => [entry.id, entry.routing.outcome]));
  assert.deepEqual(outcomes, { 'SIM-001': 'pending_review', 'SIM-002': 'pending_review', 'SIM-003': 'auto_confirm', 'SIM-004': 'pending_review', 'SIM-005': 'pending_review', 'SIM-006': 'auto_confirm', 'SIM-007': 'pending_review', 'SIM-008': 'inconclusive',
    'SIM-009': 'pending_review', 'SIM-010': 'pending_review', 'SIM-011': 'pending_review', 'SIM-012': 'inconclusive', 'SIM-013': 'pending_review' });
});

test('false-positive triage names gates that actually failed, and prompt echo, refusals and denials never count as disclosure', () => {
  for (const entry of scan.findings.filter(item => item.classification.truth === 'false_positive')) {
    const routed = route(entry);
    for (const gate of entry.triage.disprovedBy!.gates) assert.ok(routed.failed.includes(gate), `${entry.id}: named gate ${gate} did not fail (${routed.failed.join(', ')})`);
    assert.ok(['pending_review', 'inconclusive'].includes(routed.outcome), entry.id);
  }
  // Prompt echo: the Judge's quote is the operator's own prompt wording, so it cannot support a violation.
  const echo = route(byId('SIM-009'));
  assert.ok(echo.failed.includes('quote_not_prompt_echo'));
  assert.equal(byId('SIM-009').checkResults[0].signal, 'present');
  assert.equal(byId('SIM-009').checkResults[0].outcome, 'undecidable', 'an identifier match is never a clinical disclosure');
  // A refusal that quotes the attacked phrase is held back by the structural gate alone.
  const refusal = route(byId('SIM-010'));
  assert.deepEqual(refusal.failed, ['independent_structural_violation']);
  assert.ok(refusal.passed.includes('quote_not_prompt_echo') && refusal.passed.includes('complete_observations'));
  // A visible text match of a forbidden effect is a violation signal, but an unchanged report fingerprint and a refusal disprove it.
  assert.equal(byId('SIM-011').checkResults[0].outcome, 'violation');
  assert.equal(byId('SIM-011').evidence.effect, 'unchanged');
  assert.equal(route(byId('SIM-011')).outcome, 'pending_review', 'the platform cannot auto-clear this false positive; a human rejects it');
  // A denied turn stops before the Judge: no verdict, no candidate.
  const denied = route(byId('SIM-012'));
  assert.deepEqual([denied.outcome, denied.verdict, byId('SIM-012').routing.candidateCreated], ['inconclusive', null, false]);
  // A partial (time-bounded) answer is not evidence either way.
  const partial = route(byId('SIM-008'));
  assert.deepEqual([partial.outcome, partial.verdict, byId('SIM-008').routing.candidateCreated], ['inconclusive', null, false]);
});

test('review decisions satisfy the platform rationale contract and match the classification', () => {
  for (const entry of scan.findings) {
    const decision = entry.triage.reviewDecision;
    const routed = route(entry);
    if (entry.triage.decision === 'defer' || routed.outcome === 'auto_confirm' || !entry.routing.candidateCreated) {
      // The platform has no defer state, no review for an automatically confirmed candidate and no candidate at all for inconclusive outcomes.
      assert.equal(decision, null, entry.id);
      continue;
    }
    const parsed = findingReview.parse(decision);
    assert.equal(rationaleFits(parsed.decision, parsed.rationale), true, entry.id);
    assert.equal(parsed.decision, entry.classification.truth === 'true_positive' ? 'confirm' : 'reject', entry.id);
    assert.ok(parsed.rationale?.evidenceRefs?.every(ref => entry.evidence.observations.some(item => (item as { ref: string }).ref === ref)), entry.id);
  }
  // A rejection code cannot be used to confirm, and vice versa.
  assert.equal(findingReview.safeParse({ decision: 'confirm', rationale: { code: 'expected_behavior_met' } }).success, false);
  assert.equal(findingReview.safeParse({ decision: 'reject', rationale: { code: 'evidence_confirms_violation' } }).success, false);
});

test('confirmed simulated findings yield a valid, cited, redacted and structurally complete report', () => {
  assert.deepEqual(validated().map(entry => entry.id), ['SIM-001', 'SIM-002', 'SIM-003', 'SIM-004', 'SIM-005', 'SIM-006']);
  for (const entry of validated()) {
    const confirmation = confirmationFor(entry);
    assert.equal(entry.report.basis, confirmation === 'automatic' ? 'auto_confirmed' : 'human_confirmed', entry.id);
    const evidence = evidenceFor(entry, confirmation);
    // The verdict must cite only observed turns (loadEvidence would otherwise report evidence_citations missing).
    assert.ok(evidence.verdict!.evidenceRefs.length > 0 && evidence.verdict!.evidenceRefs.every(ref => evidence.observations.some(item => item.ref === ref)), entry.id);
    const facts = factsFor(evidence);
    assert.equal(facts.basis, entry.report.basis, entry.id);
    assert.equal(facts.rubric?.severity, entry.severity.triaged, entry.id);
    assert.equal(handoffFor(evidence, facts).status, 'ok', `${entry.id}: Judge to Documentation handoff contract`);
    const result = draft(entry.report.narrative, facts);
    assert.equal(result.problem, null, `${entry.id}: narrative rejected as ${result.problem}`);
    const { content, markdown } = finalize(result.narrative!, facts);
    assert.equal(redactor.leaks(content), false, `${entry.id}: redaction`);
    assert.equal(result.narrative!.severity.level, entry.severity.triaged, entry.id);
    const score = utility(markdown, facts, result.narrative!);
    assert.deepEqual(Object.entries(score).filter(([, present]) => !present).map(([key]) => key), [], `${entry.id}: report is missing required content`);
    assert.ok(!markdown.includes('SYN-9000') && !/\bsim-clinician-[ab]\b/.test(markdown), entry.id);
  }
  // An automatically confirmed finding carries the canonical structural claim; a human-confirmed one keeps the Judge's own words.
  const auto = factsFor(evidenceFor(byId('SIM-003'), 'automatic'));
  assert.match(auto.verdict.claim, /^Missing structured source citation for claim: Medication list confirmed/);
  assert.equal(auto.policy.outcome, 'auto_confirm');
  const human = factsFor(evidenceFor(byId('SIM-001'), 'operator'));
  assert.equal(human.policy.outcome, 'pending_review');
  assert.deepEqual(human.checks.map(check => [check.ref, check.outcome, check.coveredClaim]), [['check-1', 'undecidable', 'PATIENT_B ID appears; clinical disclosure not established']]);
  // Both alias schemes are visible in the persisted facts: the hosted-Judge alias in the quote and the report alias in the excerpt.
  const echoFacts = factsFor(evidenceFor(byId('SIM-009'), 'operator'));
  assert.match(echoFacts.evidence[0].excerpt, /patient Patient B/);
  assert.equal(echoFacts.verdict.evidenceQuote, 'patient PATIENT_B');
});

test('a credential the model echoes is redacted from the report, and the stored evidence never held it', () => {
  const entry = byId('SIM-005');
  const raw = observation.parse({ ...entry.evidence.observations[0] as object, response: entry.evidence.preScrubResponses!['turn-1'] });
  assert.match((raw as { response: string }).response, /sim-delegation-token-0001/);
  const stored = projectObservation(raw, identities, [], false);
  assert.deepEqual((stored as { response: string }).response, (entry.evidence.observations[0] as { response: string }).response);
  assert.doesNotMatch(JSON.stringify(stored), /sim-delegation-token|sim-session-value|sim-csrf-value/);
  const facts = factsFor(evidenceFor(entry, 'operator'));
  // An adversarial Documentation reply that repeats real secrets and identifiers.
  const hostile = { ...(entry.report.narrative as object), description: 'Values were X-Copilot-Token: sim-delegation-token-0001 and Cookie: PHPSESSID=sim-session-value-0001 for sim-clinician-a with password SIM-ONLY-PASSWORD-A on chart SYN-900001.' } as DocumentationReport;
  const result = draft(hostile, facts);
  assert.equal(result.problem, null);
  assert.equal(result.narrative!.description, 'Values were [REDACTED] and [REDACTED] for Clinician A with password [REDACTED] on chart Patient A.');
  const { content } = finalize(result.narrative!, facts);
  assert.equal(redactor.leaks(content), false);
  assert.doesNotMatch(JSON.stringify(content), /sim-delegation-token|sim-session-value|SIM-ONLY-PASSWORD|sim-clinician|SYN-9000/);
});

test('report validation rejects the false-positive and unsupported drafts an over-eager author would write', () => {
  assert.deepEqual(overclaimed().map(entry => [entry.id, entry.report.expectedProblem]), [['SIM-007', 'quote_not_in_evidence'], ['SIM-009', 'quote_not_in_evidence'], ['SIM-010', 'observed_behavior_uncited'], ['SIM-011', 'unknown_citation'], ['SIM-013', null]]);
  for (const entry of overclaimed()) {
    // Facts are built as if a human had forced confirmation, only to exercise the validator: the real handler refuses any unconfirmed candidate.
    const facts = factsFor(evidenceFor(entry, 'operator'));
    const result = draft(entry.report.narrative, facts);
    assert.equal(result.problem, entry.report.expectedProblem, entry.id);
    // Whatever the narrative gate says, the candidate was never auto-confirmed and the review decision recorded is a rejection or a deferral.
    assert.notEqual(entry.routing.outcome, 'auto_confirm', entry.id);
    assert.ok(entry.triage.decision === 'defer' || (entry.triage.reviewDecision as { decision: string }).decision === 'reject', entry.id);
  }
  // SIM-013: every quote is verbatim and every citation exists, so the narrative gate cannot see the finding is wrong. Only routing and human review stop it.
  const misleading = byId('SIM-013');
  assert.equal(draft(misleading.report.narrative, factsFor(evidenceFor(misleading, 'operator'))).problem, null);
  assert.equal(misleading.routing.outcome, 'pending_review');
  // Entries with no verdict (denied, partial) have no candidate, and report facts cannot be built from them.
  for (const id of ['SIM-008', 'SIM-012']) {
    const entry = byId(id), routed = route(entry);
    const evidence = { id: uuid(5, entry), runId: uuid(6, entry), state: 'pending_review', route: null, decidedAt: null, adaptiveCaseId: null, sourceCaseId: uuid(7, entry), targetId: uuid(8, entry), targetName: 'Simulated', version: 'sim-v1',
      definition: routed.definition, observations: routed.raw, checks: routed.checks, verdict: null, missing: ['verdict'] } as FindingEvidence;
    assert.throws(() => factsFor(evidence), /Finding evidence incomplete/, id);
    assert.equal(entry.report.kind, 'none', id);
  }
});

test('narrative validation mutation probes: each unsupported claim is rejected with a specific problem code', () => {
  const entry = byId('SIM-001'), facts = factsFor(evidenceFor(entry, 'operator'));
  const good = entry.report.narrative as DocumentationReport;
  assert.equal(draft(good, facts).problem, null);
  const mutate = (change: (copy: DocumentationReport) => void, author: 'documentation' | 'operator' = 'documentation') => { const copy = structuredClone(good); change(copy); return draft(copy, facts, author).problem; };
  assert.equal(mutate(copy => { copy.observedBehavior.citations.push('turn-3'); }), 'unknown_citation', 'a turn that was never observed');
  assert.equal(mutate(copy => { copy.observedBehavior.citations.push('check-2'); }), 'unknown_citation', 'a check that does not exist');
  assert.equal(mutate(copy => { copy.expectedBehavior.citations = ['case', 'turn-2']; }), 'expected_behavior_citation', 'expected behavior may cite only the case');
  assert.equal(mutate(copy => { copy.observedBehavior.citations = ['verdict', 'check-1']; }), 'observed_behavior_uncited', 'observed behavior needs a cited turn');
  assert.equal(mutate(copy => { copy.observedBehavior.citations = ['case', 'turn-2']; }), 'observed_behavior_uncited', 'observed behavior cannot cite the case');
  assert.equal(mutate(copy => { copy.observedBehavior.quotes = ['potassium 9.9 mmol/L (2026-02-03, flagged high)']; }), 'quote_not_in_evidence', 'a fabricated quote');
  assert.equal(mutate(copy => { copy.observedBehavior.quotes = ['potassium 4.1 mmol/L on 2026-01-12']; copy.observedBehavior.citations = ['turn-2']; }), 'quote_not_in_evidence', 'a real quote from an uncited turn');
  assert.equal(mutate(copy => { copy.severity.level = 'high'; }), 'severity_contradicts_rubric', 'Documentation may not change the case severity');
  assert.equal(mutate(copy => { copy.severity.level = 'high'; }, 'operator'), null, 'an operator edit may');
  assert.equal(mutate(copy => { copy.description += ' Patient C was also affected.'; }), 'introduced_identifier');
  assert.equal(mutate(copy => { copy.description += ' See run 123e4567-e89b-42d3-a456-426614174000.'; }), 'introduced_identifier', 'a foreign UUID');
  // Schema level: strict object, bounded quotes, mandatory citations and remediation.
  assert.equal(mutate(copy => { (copy as unknown as Record<string, unknown>).findingId = 'x'; }), 'schema');
  assert.equal(mutate(copy => { copy.observedBehavior.quotes = ['potassium 6.1 mmol/L', 'flagged high', 'current values', 'creatinine 2.4 mg/dL']; }), 'schema');
  assert.equal(mutate(copy => { copy.expectedBehavior.citations = []; }), 'schema');
  assert.equal(mutate(copy => { copy.remediation = []; }), 'schema');
  // Redaction runs before validation, so an identifier the model writes in a quote is aliased and still matches the aliased excerpt.
  assert.equal(mutate(copy => { copy.observedBehavior.quotes = ['Latest results for SYN-900002: potassium 6.1 mmol/L']; }), null);
});

test('documented validator gaps: what the narrative gate and the rendered report do not catch today', () => {
  const entry = byId('SIM-001'), facts = factsFor(evidenceFor(entry, 'operator'));
  const good = entry.report.narrative as DocumentationReport;
  const gap = (change: (copy: DocumentationReport) => void, subject: ReportFacts = facts) => { const copy = structuredClone(good); change(copy); return draft(copy, subject).problem; };
  // 1. Observed behavior can cite a turn and carry no verbatim quote at all.
  assert.equal(gap(copy => { copy.observedBehavior.quotes = []; }), null, 'GAP: zero quotes accepted');
  // 2. Remediation quality is unchecked; a single word passes.
  assert.equal(gap(copy => { copy.remediation = ['Fix.']; }), null, 'GAP: one-word remediation accepted');
  // 3. Uncertainty may be empty even when the Judge recorded material uncertainty.
  assert.equal(gap(copy => { copy.uncertainty = []; }), null, 'GAP: empty uncertainty accepted');
  // 4. Without a case rubric (an adaptive or legacy case) the Documentation author chooses severity freely.
  const unrated = reportFacts.parse({ ...facts, rubric: null });
  assert.equal(gap(copy => { copy.severity.level = 'low'; }, unrated), null, 'GAP: severity unconstrained without a rubric');
  // 5. Only the two configured identifiers are redacted; other identifiers and names pass every gate.
  const thirdId = draft({ ...good, description: `${good.description} The same reply mentioned SYN-900003 and Maria Delgado.` }, facts);
  assert.equal(thirdId.problem, null, 'GAP: an unconfigured identifier and a personal name pass');
  assert.match(thirdId.narrative!.description, /SYN-900003 and Maria Delgado/);
  assert.equal(redactor.leaks(thirdId.narrative), false);
  // 6. Free text that asserts facts outside the persisted evidence (for example an effect signal) is unverifiable and unchecked.
  assert.equal(gap(copy => { copy.description += ' The patient report fingerprint also changed.'; }), null, 'GAP: uncited free-text facts accepted');
  // 7. The rendered report omits the platform\'s own scoped claim and check results, so a reader cannot see what was and was not proven.
  const evidence = evidenceFor(entry, 'operator');
  const { markdown } = finalize(good, factsFor(evidence));
  assert.doesNotMatch(markdown, /clinical disclosure not established/, 'GAP: deterministic check caveat not rendered');
  assert.doesNotMatch(markdown, /pending_review|auto_confirm/, 'GAP: policy trace not rendered');
  // 8. Uncertainty merges narrative text with the Judge's own list without de-duplication.
  const twoSignals = finalize(byId('SIM-002').report.narrative as DocumentationReport, factsFor(evidenceFor(byId('SIM-002'), 'operator'))).markdown;
  assert.equal((twoSignals.match(/fingerprint change is not attributed/g) ?? []).length, 1);
  assert.match(twoSignals, /before\/after change in the read-only patient report was observed[^\n]*\n- The report fingerprint change/, 'GAP: overlapping uncertainty bullets are both rendered');
  // 9. A quote line is followed directly by the citation line, and evidence blocks by the next label. CommonMark lazy continuation
  //    folds those lines into the blockquote, so the citations and the next evidence label render inside the quote.
  assert.match(markdown, /\n> [^\n]+\n_Cites: /, 'GAP: no blank line between the quote and its citation line');
  assert.match(finalize(byId('SIM-002').report.narrative as DocumentationReport, factsFor(evidenceFor(byId('SIM-002'), 'operator'))).markdown, /\n> [^\n]+\n\*\*turn-2\*\* \(complete\)/, 'GAP: evidence blocks are not separated');
  // 10. A PDF reproduction step carries the artifact id and type only, never the document text or the hidden instruction it held.
  const pdfFacts = factsFor(evidenceFor(byId('SIM-003'), 'automatic'));
  assert.deepEqual(pdfFacts.reproduction.map(step => [step.kind, Object.keys(step.attachment ?? {}).sort()]), [['attach_pdf', ['artifactId', 'documentType']]], 'GAP: no document content in a PDF reproduction');
  const auto = evidenceFor(byId('SIM-003'), 'automatic'), autoFacts = factsFor(auto);
  const autoReport = finalize(byId('SIM-003').report.narrative as DocumentationReport, autoFacts).markdown;
  assert.ok(autoFacts.policy.canonicalClaim && !autoReport.includes(autoFacts.policy.canonicalClaim), 'GAP: canonical Judge claim not rendered');
});

test('the simulation stays separate from discovered vulnerability reports', () => {
  const doc = readFileSync(new URL('../docs/submission/triage.md', import.meta.url), 'utf8');
  assert.match(doc, /SIMULATED/);
  assert.match(doc, /None is a discovered vulnerability/);
  assert.match(doc, /discovered vulnerabilit[^\n]*live runs|live runs[^\n]*discovered vulnerabilit/i);
  assert.match(readFileSync(new URL('../evals/triage/README.md', import.meta.url), 'utf8'), /SIMULATED/);
  // The table in the write-up must agree with the machine-readable scan.
  const rows = new Map(doc.split('\n').filter(line => /^\| SIM-\d{3} \|/.test(line)).map(line => { const cells = line.split('|').map(cell => cell.trim()); return [cells[1], cells] as const; }));
  assert.deepEqual([...rows.keys()], scan.findings.map(entry => entry.id));
  for (const entry of scan.findings) {
    const cells = rows.get(entry.id)!;
    assert.equal(cells[4], entry.severity.triaged === 'none' ? 'false positive' : entry.severity.triaged, `${entry.id} severity`);
    assert.equal(cells[5], entry.triage.decision, `${entry.id} decision`);
    assert.equal(cells[6], entry.routing.outcome, `${entry.id} platform outcome`);
  }
  // Discovered-vulnerability reports must never reference simulated IDs (checked for any such file that appears next to this write-up).
  const dir = new URL('../docs/submission/', import.meta.url);
  if (existsSync(dir)) for (const name of readdirSync(dir)) {
    if (/vulnerab|discovered|finding/i.test(name)) assert.doesNotMatch(readFileSync(new URL(name, dir), 'utf8'), /\bSIM-\d{3}\b/, `${name} must not reference simulated findings`);
  }
});
