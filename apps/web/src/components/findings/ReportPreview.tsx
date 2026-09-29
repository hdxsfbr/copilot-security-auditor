import React from 'react';
import type { Revision } from './model.js';
import { when, words } from './model.js';

const Cites = ({ refs }: { refs: string[] }) => <p className="finding-cites">Cites: {refs.map(ref => <a key={ref} href={`#${ref}`}>{ref}</a>)}</p>;

/** The redacted report exactly as stored for one revision: deterministic facts plus the (possibly operator-edited) narrative. */
export function ReportPreview({ revision }: { revision: Revision }) {
  const { facts, narrative } = revision.content;
  return <article className="report-preview" aria-label={`Report revision ${revision.revision} preview`}>
    <h3>{narrative.title}</h3>
    <p><span className={`finding-sev sev-${narrative.severity.level}`}>Severity: {narrative.severity.level}</span></p>
    <dl className="report-facts">
      <div><dt>Category</dt><dd>{words(facts.category)}</dd></div><div><dt>Target / version</dt><dd>{facts.target.name} / {facts.target.version ?? 'unknown'}</dd></div>
      <div><dt>Confirmation</dt><dd>{words(facts.basis ?? 'unconfirmed')}</dd></div><div><dt>Status</dt><dd>{facts.status} · regression {words(facts.regression)}</dd></div>
    </dl>
    <h4>Severity rationale</h4><p>{narrative.severity.rationale}</p>
    <h4>Clinical impact</h4><p>{narrative.clinicalImpact}</p>
    <h4>Description</h4><p>{narrative.description}</p>
    <h4>Minimal reproduction</h4>
    <ol>{facts.reproduction.map(step => <li key={step.step}>({words(step.kind)}{step.attachment ? `: ${words(step.attachment.documentType)}` : ''}) {step.instruction}</li>)}</ol>
    {narrative.reproductionNotes.map((note, index) => <p key={index}><em>Note: {note}</em></p>)}
    <h4>Expected behavior</h4><p>{narrative.expectedBehavior.text}</p><Cites refs={narrative.expectedBehavior.citations} />
    <h4>Observed behavior</h4><p>{narrative.observedBehavior.text}</p>
    {narrative.observedBehavior.quotes.map((quote, index) => <blockquote key={index}>{quote}</blockquote>)}<Cites refs={narrative.observedBehavior.citations} />
    <h4>Remediation</h4><ul>{narrative.remediation.map((item, index) => <li key={index}>{item}</li>)}</ul>
    <h4>Uncertainty and limits</h4>
    {[...narrative.uncertainty, ...facts.verdict.materialUncertainties].length ? <ul>{[...narrative.uncertainty, ...facts.verdict.materialUncertainties].map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>None recorded.</p>}
    <h4>Evidence excerpts (redacted)</h4>
    {facts.evidence.map(item => <blockquote key={item.ref}><strong>{item.ref} ({item.status})</strong><br />{item.excerpt}</blockquote>)}
    <h4>Fix-validation history</h4>
    {facts.validationHistory.length ? <ul>{facts.validationHistory.map(item => <li key={item.runId}>Run {item.runId.slice(0, 8)} · version {item.version ?? 'unknown'} · {item.outcome ?? 'unknown'}</li>)}</ul> : <p>No later validation run recorded.</p>}
    <footer className="report-footer">Revision {revision.revision} · {revision.author} · evidence revision {revision.evidenceRevision} · redaction {revision.redaction} · saved {when(revision.createdAt)}<br />Content hash <code>{revision.contentHash}</code></footer>
  </article>;
}
