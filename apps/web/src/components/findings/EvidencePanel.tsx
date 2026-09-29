import React from 'react';
import { requestJson } from '../../api/client.js';
import type { Event } from '../../pages/controller.js';
import { appendNewerEvents, drainEventPages } from '../../pages/run-events.js';
import { EvidenceContent, RunEvidence } from '../evidence/RunEvidence.js';
import { RouteLink } from '../router.js';
import { describeIntegrity, describeMissing, isCaseLink, useResource, when, words, type Integrity, type Metadata } from './model.js';

type Resource<T> = { data: T | null; error: string; loading: boolean; reload: () => Promise<void> };
const short = (id: string | null) => id ? id.slice(0, 8) : 'unknown';
export const reportOnlyFields = ['clinical_impact', 'remediation', 'severity'];

/** The exact case, verdict, policy gates, checks and artifact integrity behind one finding. Each block carries the anchor a report citation points to. */
export function EvidenceSummary({ meta, integrity, navigate }: { meta: Metadata; integrity: Resource<Integrity>; navigate: (path: string) => void }) {
  const { facts } = meta, run = `/runs/${meta.runId}`;
  const evidenceMissing = describeMissing(meta.completeness.missing.filter(item => !reportOnlyFields.includes(item) || meta.completeness.status !== 'evidence_incomplete'));
  return <section className="finding-card" aria-labelledby="evidence-heading">
    <h2 id="evidence-heading">Exact case evidence</h2>
    <p className="finding-meta">Run <RouteLink href={run} navigate={navigate}>{short(meta.runId)}</RouteLink>
      {meta.executionCaseId ? <> · adaptive execution case <RouteLink href={`${run}/cases/${meta.executionCaseId}`} navigate={navigate}>{short(meta.executionCaseId)}</RouteLink></> : ' · selected case'}
      {' '}· source case {short(meta.sourceCaseId)} · target {meta.target.name} / {meta.target.version ?? 'unknown version'} · {meta.category ? words(meta.category) : 'no category recorded'}</p>
    {!facts ? <p role="alert" className="finding-warning">Evidence is incomplete, so this finding cannot be newly confirmed or approved. Missing: {evidenceMissing.join(', ') || 'unspecified evidence'}. The recorded events below are shown as stored.</p> : <>
      <div id="case"><h3>Expected safe behavior (case definition)</h3><p>{facts.expectedSafeBehavior}</p>
        <ol className="finding-steps">{facts.reproduction.map(step => <li key={step.step}><strong>Step {step.step} ({words(step.kind)}):</strong> {step.instruction}</li>)}</ol></div>
      <div id="verdict"><h3>Judge verdict: {facts.verdict.outcome}</h3><p>{facts.verdict.claim}</p>
        {facts.verdict.evidenceQuote && <blockquote>{facts.verdict.evidenceQuote}</blockquote>}
        <p>Cited: {facts.verdict.evidenceRefs.length ? facts.verdict.evidenceRefs.map(ref => <a key={ref} href={`#${ref}`}>{ref} </a>) : 'no citations'} · reproduction {facts.verdict.reproductionComplete ? 'complete' : 'incomplete'}</p>
        <div className="finding-uncertainty"><strong>Material uncertainty</strong>{facts.verdict.materialUncertainties.length ? <ul>{facts.verdict.materialUncertainties.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>None recorded by the Judge.</p>}</div></div>
      <div id="policy"><h3>Policy gate: {words(facts.policy.outcome)}</h3>
        <p>Failed gates: {facts.policy.failed.length ? facts.policy.failed.map(gate => <code key={gate}>{gate}</code>) : 'none'}</p>
        <p>Passed gates: {facts.policy.passed.length ? facts.policy.passed.map(gate => <code key={gate}>{gate}</code>) : 'none'}</p></div>
      <div><h3>Deterministic checks</h3>{facts.checks.length ? <ul>{facts.checks.map(check => <li id={check.ref} key={check.ref}><code>{check.ref}</code> {words(check.kind)}: <strong>{check.outcome}</strong>{check.coveredClaim ? ` · ${check.coveredClaim}` : ''}</li>)}</ul> : <p>No deterministic checks were recorded.</p>}</div>
    </>}
    <div><h3>Evidence integrity</h3>
      {integrity.data ? <p role="status" className={integrity.data.status === 'complete' ? undefined : 'finding-warning'}>{describeIntegrity(integrity.data.status)} <code>{integrity.data.status}</code> · {integrity.data.artifacts.length} linked artifact{integrity.data.artifacts.length === 1 ? '' : 's'} · checked {when(integrity.data.checkedAt)}</p>
        : integrity.error ? <p role="alert" className="finding-warning">Integrity check unavailable: {integrity.error}</p> : <p role="status">Checking linked evidence artifacts…</p>}
      <button type="button" disabled={integrity.loading} onClick={() => void integrity.reload()}>{integrity.error ? 'Retry integrity check' : 'Re-check integrity'}</button></div>
  </section>;
}

/** Full recorded events for exactly this finding's case, reusing the run evidence renderer so turn anchors stay stable. */
export function TranscriptPanel({ meta }: { meta: Metadata }) {
  const transcript = useResource(async () => {
    let events: Event[] = [];
    await drainEventPages(meta.runId, null, items => { events = appendNewerEvents(events, items); });
    const link = meta.executionCaseId ? await requestJson(`/runs/${meta.runId}/cases/${meta.executionCaseId}`, isCaseLink) : null;
    if (link && link.id !== meta.executionCaseId) throw new Error('Case identity does not match this finding');
    return { events, link };
  }, [meta.runId, meta.executionCaseId]);
  const { data } = transcript;
  const shown = !data ? [] : !data.link ? data.events : data.link.eventLinkage === 'tagged' ? data.events.filter(item => item.event.detail.executionCaseId === data.link!.id && data.link!.eventIds.includes(String(item.id))) : [];
  const assessment = data?.link?.eventLinkage === 'unknown' ? data.link.assessment : null;
  return <section className="finding-card" aria-labelledby="transcript-heading">
    <h2 id="transcript-heading">Cited transcript, checks and verdict</h2>
    <p className="finding-meta">Recorded events are shown exactly as stored, so they may contain synthetic identifiers. The report preview below is the redacted version.</p>
    {transcript.loading && !data && <p role="status">Loading recorded transcript…</p>}
    {transcript.error && <p role="alert" className="finding-warning">Transcript could not load{data ? '; the last loaded events are kept' : ''}: {transcript.error} <button type="button" onClick={() => void transcript.reload()}>Retry transcript</button></p>}
    {data && <>
      {data.link?.eventLinkage === 'unknown' && <p>Event linkage is unknown for this execution case, so no run events are assigned to it by order or proximity.</p>}
      {assessment && <><EvidenceContent kind="deterministic" detail={{ checks: assessment.checks }} />{assessment.verdict && <EvidenceContent kind="verdict" detail={{ verdict: assessment.verdict }} />}</>}
      {shown.length ? <RunEvidence events={shown} /> : !assessment && <p className="empty">No recorded events for this exact case.</p>}
    </>}
  </section>;
}
