import React, { useState } from 'react';
import { ApiResponseError, isRecord, requestJson } from '../../api/client.js';
import { editProblems, words, type Revision } from './model.js';

const lines = (value: string) => value.split('\n').map(item => item.trim()).filter(Boolean), commas = (value: string) => value.split(',').map(item => item.trim()).filter(Boolean);
export const problemText = (cause: unknown) => cause instanceof ApiResponseError && cause.reason ? `${editProblems[cause.reason] ?? words(cause.reason)} [${cause.reason}]`
  : cause instanceof ApiResponseError && cause.status === 400 && cause.code === 'invalid' ? 'The narrative was rejected: check required fields, text lengths and the number of list items.' : cause instanceof Error ? cause.message : 'Request failed';

/** Narrative-only edit of the current revision. Facts and evidence are not editable; a saved edit is a new revision that voids any earlier approval. */
export function RevisionEditor({ findingId, revision, onSaved }: { findingId: string; revision: Revision; onSaved: (message: string) => void }) {
  const n = revision.content.narrative;
  const [form, setForm] = useState({ title: n.title, level: n.severity.level, rationale: n.severity.rationale, impact: n.clinicalImpact, description: n.description, expected: n.expectedBehavior.text, expectedCites: n.expectedBehavior.citations.join(', '),
    observed: n.observedBehavior.text, observedCites: n.observedBehavior.citations.join(', '), quotes: n.observedBehavior.quotes.join('\n'), notes: n.reproductionNotes.join('\n'), remediation: n.remediation.join('\n'), uncertainty: n.uncertainty.join('\n') });
  const [busy, setBusy] = useState(false), [problem, setProblem] = useState('');
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm({ ...form, [key]: event.target.value });
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const narrative = { v: 1, title: form.title.trim(), severity: { level: form.level, rationale: form.rationale.trim() }, clinicalImpact: form.impact.trim(), description: form.description.trim(),
      expectedBehavior: { text: form.expected.trim(), citations: commas(form.expectedCites) }, observedBehavior: { text: form.observed.trim(), citations: commas(form.observedCites), quotes: lines(form.quotes) },
      reproductionNotes: lines(form.notes), remediation: lines(form.remediation), uncertainty: lines(form.uncertainty) };
    const empty = ([['Title', narrative.title], ['Severity rationale', narrative.severity.rationale], ['Clinical impact', narrative.clinicalImpact], ['Description', narrative.description], ['Expected behavior', narrative.expectedBehavior.text], ['Observed behavior', narrative.observedBehavior.text],
      ['Expected behavior citations', narrative.expectedBehavior.citations.length], ['Observed behavior citations', narrative.observedBehavior.citations.length], ['Remediation', narrative.remediation.length]] as [string, string | number][]).find(([, value]) => !value);
    if (empty) return setProblem(`${empty[0]} is required.`);
    if (narrative.observedBehavior.quotes.some(quote => quote.length < 8)) return setProblem('Each quote must be at least 8 characters and copied verbatim from the cited evidence.');
    setBusy(true); setProblem('');
    try {
      const saved = await requestJson(`/findings/${findingId}/report-revisions`, isRecord, { method: 'POST', body: JSON.stringify({ parentRevisionId: revision.id, narrative }) });
      onSaved(saved.unchanged === true ? `No changes: revision ${revision.revision} is unchanged.` : `Saved as revision ${String(saved.revision)}. Any approval of revision ${revision.revision} is invalidated; review and approve the new revision.`);
    } catch (cause) { setProblem(problemText(cause)); }
    finally { setBusy(false); }
  };
  return <form className="revision-editor" onSubmit={submit} aria-label="Edit report narrative">
    <p className="hint">Edits change the narrative only. Citations and quotes must match the recorded evidence, and identifiers are re-redacted. Saving creates revision {revision.revision + 1} and invalidates any approval of revision {revision.revision}.</p>
    {problem && <p role="alert" className="finding-warning">{problem}</p>}
    <fieldset disabled={busy}>
      <label>Title<input maxLength={160} value={form.title} onChange={set('title')} /></label>
      <div className="pair"><label>Severity<select value={form.level} onChange={set('level')}>{['low', 'medium', 'high', 'critical', 'unknown'].map(level => <option key={level}>{level}</option>)}</select></label>
        <label>Severity rationale<textarea value={form.rationale} onChange={set('rationale')} /></label></div>
      <label>Clinical impact<textarea value={form.impact} onChange={set('impact')} /></label>
      <label>Description<textarea value={form.description} onChange={set('description')} /></label>
      <label>Expected behavior<textarea value={form.expected} onChange={set('expected')} /></label>
      <label>Expected behavior citations (comma separated)<input value={form.expectedCites} onChange={set('expectedCites')} /></label>
      <label>Observed behavior<textarea value={form.observed} onChange={set('observed')} /></label>
      <label>Observed behavior citations (comma separated)<input value={form.observedCites} onChange={set('observedCites')} /></label>
      <label>Verbatim quotes (one per line)<textarea value={form.quotes} onChange={set('quotes')} /></label>
      <label>Reproduction notes (one per line)<textarea value={form.notes} onChange={set('notes')} /></label>
      <label>Remediation (one per line)<textarea value={form.remediation} onChange={set('remediation')} /></label>
      <label>Uncertainty (one per line)<textarea value={form.uncertainty} onChange={set('uncertainty')} /></label>
      <button className="primary" type="submit">{busy ? 'Saving…' : `Save as revision ${revision.revision + 1}`}</button>
    </fieldset>
  </form>;
}
