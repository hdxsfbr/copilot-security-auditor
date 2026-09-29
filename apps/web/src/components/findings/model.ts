import { useCallback, useEffect, useRef, useState } from 'react';
// Type-only: the report contracts import server-only modules, so the browser validates the fields it renders instead.
import type { DocumentationReport, ReportContent, ReportFacts } from '../../../../../packages/contracts/src/report.js';
import { isRecord } from '../../api/client.js';

export type JobState = 'report_needed' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type Job = { id: string; state: JobState; reason: string | null; attempts: number; evidenceRevision: number };
export type Metadata = { findingId: string; runId: string; executionCaseId: string | null; sourceCaseId: string | null; state: string; decisionRoute: string | null; decidedAt: string | null;
  target: { id: string; name: string; version: string | null }; category: string | null; severity: { level: string; rationale: string; source: string } | null;
  completeness: { status: 'complete' | 'pending_report' | 'evidence_incomplete'; missing: string[] }; facts: ReportFacts | null; narrative: DocumentationReport | null;
  report: { currentRevisionId: string | null; currentRevision: number | null; approvedRevisionId: string | null; job: Job | null } };
export type Approval = { approvedAt: string; approvedBy: string; invalidatedAt: string | null; invalidatedBy: string | null };
export type Revision = { id: string; revision: number; evidenceRevision: number; author: string; parentId: string | null; contentHash: string; redaction: string; content: ReportContent; createdAt: string; approval: Approval | null };
export type Rationale = { code: string; note?: string; evidenceRefs?: string[] };
export type HistoryEntry = { id: string; kind: 'decision' | 'correction'; decision: string | null; route: string | null; rationale: Rationale | null; reason: string | null; actor: string; createdAt: string };
export type Integrity = { status: 'complete' | 'missing' | 'corrupt' | 'unlinked' | 'invalid_definition' | 'unavailable'; artifacts: { id: string; status: string }[]; checkedAt: string };
export type Accounting = { enabled: boolean; policy: { model: { provider: string; model: string; maxOutputTokens: number }; allowanceNanos: string; reviewWindowSeconds: number; reviewExpiresAt: string | null; releaseReason: string | null; releasedAt: string | null; unusedAtRelease: string | null } | null;
  heldNanos: string; unusedNanos: string; jobs: (Job & { candidateId: string; funding: string | null; reservedNanos: string; heldNanos: string })[] };
export type ListItem = { id: string; runId: string; state: string; decisionRoute: string | null; version: string | null; outcome?: string | null; title?: string | null };

const str = (v: unknown): v is string => typeof v === 'string';
const nul = (v: unknown): v is string | null => v === null || str(v);
const strs = (v: unknown): v is string[] => Array.isArray(v) && v.every(str);
const many = <T>(v: unknown, guard: (item: unknown) => item is T): v is T[] => Array.isArray(v) && v.every(guard);
export const isJob = (v: unknown): v is Job => isRecord(v) && str(v.id) && ['report_needed', 'queued', 'running', 'completed', 'failed', 'cancelled'].includes(String(v.state)) && nul(v.reason) && Number.isInteger(v.attempts) && Number.isInteger(v.evidenceRevision);
export const isListItem = (v: unknown): v is ListItem => isRecord(v) && str(v.id) && str(v.runId) && str(v.state) && nul(v.decisionRoute) && nul(v.version) && (v.outcome === undefined || nul(v.outcome)) && (v.title === undefined || nul(v.title));
const cited = (v: unknown) => isRecord(v) && str(v.text) && strs(v.citations);
const isNarrative = (v: unknown): v is DocumentationReport => isRecord(v) && str(v.title) && isRecord(v.severity) && str(v.severity.level) && str(v.severity.rationale) && str(v.clinicalImpact) && str(v.description) && cited(v.expectedBehavior)
  && cited(v.observedBehavior) && strs((v.observedBehavior as Record<string, unknown>).quotes) && strs(v.reproductionNotes) && strs(v.remediation) && strs(v.uncertainty);
const isFacts = (v: unknown): v is ReportFacts => isRecord(v) && str(v.category) && isRecord(v.target) && str(v.target.name) && nul(v.target.version) && nul(v.basis) && str(v.regression) && str(v.status) && str(v.expectedSafeBehavior)
  && many(v.reproduction, (s): s is Record<string, unknown> => isRecord(s) && Number.isInteger(s.step) && str(s.kind) && str(s.instruction)) && many(v.evidence, (e): e is Record<string, unknown> => isRecord(e) && str(e.ref) && str(e.status) && str(e.excerpt))
  && many(v.checks, (c): c is Record<string, unknown> => isRecord(c) && str(c.ref) && str(c.kind) && str(c.outcome) && str(c.coveredClaim)) && isRecord(v.verdict) && str(v.verdict.outcome) && str(v.verdict.claim) && strs(v.verdict.evidenceRefs) && strs(v.verdict.materialUncertainties)
  && isRecord(v.policy) && str(v.policy.outcome) && strs(v.policy.passed) && strs(v.policy.failed) && many(v.validationHistory, (h): h is Record<string, unknown> => isRecord(h) && str(h.runId));
export const isMetadata = (v: unknown): v is Metadata => isRecord(v) && str(v.findingId) && str(v.runId) && nul(v.executionCaseId) && nul(v.sourceCaseId) && str(v.state) && nul(v.decisionRoute) && nul(v.decidedAt)
  && isRecord(v.target) && str(v.target.name) && nul(v.target.version) && nul(v.category) && (v.severity === null || isRecord(v.severity) && str(v.severity.level)) && isRecord(v.completeness)
  && ['complete', 'pending_report', 'evidence_incomplete'].includes(String(v.completeness.status)) && many(v.completeness.missing, str)
  && (v.facts === null || isFacts(v.facts)) && (v.narrative === null || isNarrative(v.narrative))
  && isRecord(v.report) && nul(v.report.currentRevisionId) && (v.report.job === null || isJob(v.report.job));
const isRevision = (v: unknown): v is Revision => isRecord(v) && str(v.id) && Number.isInteger(v.revision) && str(v.contentHash) && str(v.author) && str(v.createdAt) && isRecord(v.content) && isFacts(v.content.facts) && isNarrative(v.content.narrative) && (v.approval === null || isRecord(v.approval) && str(v.approval.approvedAt));
export const isRevisions = (v: unknown): v is { revisions: Revision[] } => isRecord(v) && many(v.revisions, isRevision);
const isEntry = (v: unknown): v is HistoryEntry => isRecord(v) && str(v.id) && (v.kind === 'decision' || v.kind === 'correction') && str(v.actor) && str(v.createdAt);
export const isHistory = (v: unknown): v is { entries: HistoryEntry[] } => isRecord(v) && many(v.entries, isEntry);
export const isIntegrity = (v: unknown): v is Integrity => isRecord(v) && ['complete', 'missing', 'corrupt', 'unlinked', 'invalid_definition', 'unavailable'].includes(String(v.status)) && Array.isArray(v.artifacts);
export const isAccounting = (v: unknown): v is Accounting => isRecord(v) && typeof v.enabled === 'boolean' && (v.policy === null || isRecord(v.policy) && isRecord(v.policy.model) && str(v.policy.allowanceNanos)) && str(v.heldNanos) && str(v.unusedNanos) && many(v.jobs, (j): j is Accounting['jobs'][number] => isJob(j) && isRecord(j));
export const isCaseLink = (v: unknown): v is { id: string; eventLinkage: string; eventIds: string[]; assessment?: { checks: Record<string, unknown>[]; verdict: Record<string, unknown> | null; route: string } | null } =>
  isRecord(v) && str(v.id) && str(v.eventLinkage) && many(v.eventIds, str);

export const words = (value: string) => value.replaceAll('_', ' ');
const missingText: Record<string, string> = { attack_category: 'attack category', reproduction_steps: 'reproduction steps', expected_behavior: 'expected behavior', observed_behavior: 'observed behavior for every step', verdict: 'Judge verdict',
  evidence_citations: 'verdict citations that match recorded turns', decision_basis: 'decision basis', clinical_impact: 'clinical impact (drafted in the report)', remediation: 'remediation (drafted in the report)', severity: 'severity (no case rubric)' };
export const describeMissing = (missing: string[]) => missing.map(item => missingText[item] ?? words(item));
const integrityText: Record<Integrity['status'], string> = { complete: 'Linked evidence artifacts verified', missing: 'A linked artifact file is missing', corrupt: 'A linked artifact file failed its checksum', unlinked: 'A referenced artifact is not linked to the source case',
  invalid_definition: 'The saved case definition is invalid or has no source case', unavailable: 'Artifact storage is unavailable' };
export const describeIntegrity = (status: Integrity['status']) => integrityText[status];
const reasons: Record<string, string> = { policy_disabled: 'Automatic drafting was not enabled for this run', allowance_released: 'The run report allowance was released, so drafting needs an explicit model and allowance', allowance_exhausted: 'The run report allowance cannot cover another draft',
  operator_cancelled: 'Cancelled by an operator', review_window_expired: 'The review window expired before drafting', run_cancelled: 'The run was cancelled', not_confirmed: 'The finding is not confirmed', missing_required_evidence: 'Required evidence is missing',
  invalid_output: 'The Documentation model returned unusable output', redaction_failed: 'Redaction could not be verified, so nothing was stored', model_unavailable: 'The Documentation model was unavailable', model_endpoint_unavailable: 'The Documentation model endpoint is not configured',
  report_allowance_exhausted: 'The report allowance ran out before the call', lease_lost: 'The worker lost its lease', model_timeout: 'The Documentation model timed out', handler_error: 'The drafting worker failed', duplicate_attack_sequence: 'Another finding already covers this attack sequence' };
export const describeReason = (code: string | null) => { if (!code) return ''; const [key, ...rest] = code.split(':'); return `${reasons[key] ?? words(key)}${rest.length ? ` (${rest.join(':').replaceAll(',', ', ')})` : ''}`; };
export const editProblems: Record<string, string> = { unknown_citation: 'A citation does not exist in this finding’s evidence', expected_behavior_citation: 'Expected behavior may cite only "case"', observed_behavior_uncited: 'Observed behavior must cite at least one turn',
  quote_not_in_evidence: 'A quote is not a verbatim excerpt of the cited evidence', severity_contradicts_rubric: 'Severity contradicts the case rubric', introduced_identifier: 'The text introduces an identifier that is not in the evidence', stale_parent: 'A newer revision exists; reload and edit that one',
  not_confirmed: 'Only confirmed findings have a report', content_changed: 'The revision changed after you loaded it; reload and review again', superseded: 'A newer revision superseded this one', evidence_integrity_failed: 'Linked evidence failed its integrity check' };
export const confirmCodes: [string, string][] = [['evidence_confirms_violation', 'Evidence confirms the violation'], ['other', 'Other (note required)']];
export const rejectCodes: [string, string][] = [['evidence_insufficient', 'Evidence is insufficient'], ['expected_behavior_met', 'Expected behavior was met'], ['target_behavior_acceptable', 'Target behavior is acceptable'], ['test_artifact', 'Test artifact'],
  ['duplicate', 'Duplicate finding'], ['out_of_scope', 'Out of scope'], ['other', 'Other (note required)']];
export const when = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : 'unknown time';
export const isApproved = (revision: Revision | undefined) => !!revision?.approval && !revision.approval.invalidatedAt;

/** Loads one resource; a refresh failure keeps the last good data and reports the error with a reload. */
export function useResource<T>(load: (() => Promise<T>) | null, deps: unknown[]) {
  const [state, setState] = useState<{ data: T | null; error: string; loading: boolean }>({ data: null, error: '', loading: !!load });
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    if (!load) return;
    const mine = ++sequence.current;
    setState(current => ({ ...current, loading: true }));
    try { const data = await load(); if (mine === sequence.current) setState({ data, error: '', loading: false }); }
    catch (cause) { if (mine === sequence.current) setState(current => ({ ...current, error: cause instanceof Error ? cause.message : 'Request failed', loading: false })); }
  }, deps);
  useEffect(() => { setState({ data: null, error: '', loading: !!load }); void reload(); return () => { sequence.current++; }; }, [reload]);
  return { ...state, reload };
}
