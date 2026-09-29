import React, { useState } from 'react';
import { isRecord, requestJson } from '../../api/client.js';
import { reportOnlyFields } from './EvidencePanel.js';
import { confirmCodes, describeIntegrity, describeMissing, rejectCodes, when, words, type HistoryEntry, type Integrity, type Metadata } from './model.js';

type Resource<T> = { data: T | null; error: string; loading: boolean; reload: () => Promise<void> };
const message = (cause: unknown) => cause instanceof Error ? cause.message : 'Request failed';
const codeLabel = (code: string) => [...confirmCodes, ...rejectCodes].find(([value]) => value === code)?.[1] ?? words(code);
const rationaleText = (entry: HistoryEntry) => entry.rationale ? `${codeLabel(entry.rationale.code)}${entry.rationale.note ? ` — “${entry.rationale.note}”` : ''}${entry.rationale.evidenceRefs?.length ? ` · cites ${entry.rationale.evidenceRefs.join(', ')}` : ''}` : 'no rationale recorded';

/** Why a new confirmation is not allowed right now, or null. Rejection stays available: it never publishes anything. */
export function confirmBlock(meta: Metadata, integrity: Resource<Integrity>): string | null {
  if (meta.completeness.status === 'evidence_incomplete' || !meta.facts) return `Evidence is incomplete (${describeMissing(meta.completeness.missing.filter(item => !reportOnlyFields.includes(item))).join(', ') || 'unspecified'})`;
  if (integrity.data && integrity.data.status !== 'complete') return `Evidence integrity failed: ${describeIntegrity(integrity.data.status)}`;
  if (!integrity.data) return integrity.error ? 'The evidence integrity check is unavailable; retry it first' : 'Checking evidence integrity…';
  return null;
}

export function DecisionPanel({ meta, integrity, history, onChanged }: { meta: Metadata; integrity: Resource<Integrity>; history: Resource<{ entries: HistoryEntry[] }>; onChanged: () => void }) {
  const [decision, setDecision] = useState<'' | 'confirm' | 'reject'>(''), [code, setCode] = useState(''), [note, setNote] = useState(''), [refs, setRefs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), [problem, setProblem] = useState(''), [notice, setNotice] = useState('');
  const [fixCode, setFixCode] = useState(''), [fixNote, setFixNote] = useState(''), [fixReason, setFixReason] = useState('');
  const pending = meta.state === 'pending_review', block = confirmBlock(meta, integrity), entries = history.data?.entries ?? [];
  const codes = decision === 'confirm' ? confirmCodes : rejectCodes, verdict = meta.facts?.verdict;
  const finalCodes = meta.state === 'confirmed' ? confirmCodes : rejectCodes, lastDecision = [...entries].reverse().find(entry => entry.kind === 'decision' || entry.kind === 'correction');
  const send = async (path: string, body: unknown, done: string) => {
    if (busy) return;
    setBusy(true); setProblem(''); setNotice('');
    try { await requestJson(path, isRecord, { method: 'POST', body: JSON.stringify(body) }); setNotice(done); setNote(''); setDecision(''); setCode(''); setRefs([]); setFixNote(''); setFixReason(''); onChanged(); }
    catch (cause) { setProblem(message(cause)); }
    finally { setBusy(false); }
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!decision || !code) return setProblem('Choose a decision and a rationale code.');
    if (code === 'other' && !note.trim()) return setProblem('Add a note explaining the “other” rationale.');
    void send(`/findings/${meta.findingId}/review`, { decision, rationale: { code, ...(note.trim() ? { note: note.trim() } : {}), ...(refs.length ? { evidenceRefs: refs } : {}) } }, decision === 'confirm' ? 'Finding confirmed. Report drafting state is shown below.' : 'Finding rejected.');
  };
  const correct = (event: React.FormEvent) => {
    event.preventDefault();
    if (!fixCode || !fixReason.trim()) return setProblem('Choose the corrected rationale code and explain the correction.');
    if (fixCode === 'other' && !fixNote.trim()) return setProblem('Add a note explaining the “other” rationale.');
    void send(`/findings/${meta.findingId}/corrections`, { rationale: { code: fixCode, ...(fixNote.trim() ? { note: fixNote.trim() } : {}) }, reason: fixReason.trim() }, 'Correction recorded; the original decision remains in the history.');
  };
  return <section className="finding-card finding-decision" aria-labelledby="decision-heading">
    <h2 id="decision-heading">Decision</h2>
    <p><span className={`finding-state state-${meta.state}`}>{words(meta.state)}</span> {meta.decisionRoute ? `via ${meta.decisionRoute} route` : 'awaiting an operator decision'}{meta.decidedAt ? ` · ${when(meta.decidedAt)}` : ''}</p>
    {verdict && <p className="finding-glance">Judge: <strong>{verdict.outcome}</strong> · policy gate {words(meta.facts!.policy.outcome)} · {verdict.materialUncertainties.length} material uncertaint{verdict.materialUncertainties.length === 1 ? 'y' : 'ies'} (listed with the evidence)</p>}
    {notice && <p role="status" className="finding-notice">{notice}</p>}
    {problem && <p role="alert" className="finding-warning">{problem}</p>}
    {pending ? <form onSubmit={submit} aria-label="Review decision">
      <fieldset disabled={busy}><legend>Decision</legend>
        <label className="finding-choice"><input type="radio" name="decision" value="confirm" disabled={!!block} aria-describedby={block ? "confirm-block" : undefined} checked={decision === 'confirm'} onChange={() => { setDecision('confirm'); setCode(confirmCodes[0][0]); }} />Confirm violation</label>
        {block && <p id="confirm-block" role="status" className="finding-warning">Confirmation unavailable: {block}.</p>}
        <label className="finding-choice"><input type="radio" name="decision" value="reject" checked={decision === 'reject'} onChange={() => { setDecision('reject'); setCode(rejectCodes[0][0]); }} />Reject as not a violation</label>
        <label>Rationale<select value={code} disabled={!decision} onChange={event => setCode(event.target.value)}>{!decision && <option value="">Choose a decision first</option>}{codes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>Note{code === 'other' ? ' (required)' : ' (optional)'}<textarea maxLength={1000} value={note} onChange={event => setNote(event.target.value)} /></label>
        {meta.facts && <fieldset className="finding-refs"><legend>Turns that support this decision (optional)</legend>{meta.facts.evidence.map(item => <label className="finding-choice" key={item.ref}><input type="checkbox" checked={refs.includes(item.ref)} onChange={event => setRefs(event.target.checked ? [...refs, item.ref] : refs.filter(ref => ref !== item.ref))} />{item.ref}</label>)}</fieldset>}
        <button className="primary" type="submit" disabled={!decision}>{busy ? 'Recording…' : decision === 'reject' ? 'Record rejection' : 'Record confirmation'}</button>
      </fieldset></form>
      : <><p>Final state: <strong>{words(meta.state)}</strong>{lastDecision ? ` — ${rationaleText(lastDecision)}` : ''}.</p>
        {['confirmed', 'rejected'].includes(meta.state) && <details><summary>Record a correction</summary><form onSubmit={correct} aria-label="Correct rationale"><fieldset disabled={busy}>
          <label>Corrected rationale<select value={fixCode} onChange={event => setFixCode(event.target.value)}><option value="">Choose a code</option>{finalCodes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>Note<textarea maxLength={1000} value={fixNote} onChange={event => setFixNote(event.target.value)} /></label>
          <label>Why is this correction needed?<input maxLength={500} value={fixReason} onChange={event => setFixReason(event.target.value)} /></label>
          <button type="submit">Record correction</button></fieldset></form></details>}</>}
    <h3>Decision history</h3>
    {history.error && <p role="alert" className="finding-warning">History unavailable: {history.error} <button type="button" onClick={() => void history.reload()}>Retry history</button></p>}
    {!history.error && !history.data && <p role="status">Loading history…</p>}
    {history.data && (entries.length ? <ol className="finding-history">{entries.map(entry => <li key={entry.id}><strong>{entry.kind === 'correction' ? 'Correction' : words(entry.decision ?? 'decision')}</strong> · {entry.route ?? entry.actor} · {when(entry.createdAt)}<br />{rationaleText(entry)}{entry.reason ? ` · reason: ${entry.reason}` : ''}</li>)}</ol> : <p>No decision has been recorded yet.</p>)}
  </section>;
}
