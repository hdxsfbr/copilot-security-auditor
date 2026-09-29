import React, { useState } from 'react';
import { ApiResponseError, isRecord, requestJson } from '../../api/client.js';
import { isCatalog, usd, type Catalog } from '../models/definitions.js';
import { confirmBlock } from './DecisionPanel.js';
import { ReportPreview } from './ReportPreview.js';
import { problemText, RevisionEditor } from './RevisionEditor.js';
import { describeReason, isApproved, useResource, when, words, type Accounting, type Integrity, type Metadata, type Revision } from './model.js';

type Resource<T> = { data: T | null; error: string; loading: boolean; reload: () => Promise<void> };
type Act = (path: string, body: unknown, done: string) => Promise<void>;
const jobText = { report_needed: 'Report needed: drafting is not authorized', queued: 'Queued for the Documentation worker', running: 'Drafting in progress', completed: 'Draft stored as a report revision', failed: 'Drafting failed', cancelled: 'Drafting cancelled' };
const stateOf = (revision: Revision) => !revision.approval ? 'not approved' : revision.approval.invalidatedAt ? 'approval invalidated by a newer revision' : 'approved';

function AuthorizeForm({ jobId, released, act }: { jobId: string; released: boolean; act: Act }) {
  const catalog = useResource<Catalog>(() => requestJson('/models', isCatalog), []);
  const [provider, setProvider] = useState<'ollama' | 'openrouter'>('ollama'), [model, setModel] = useState(''), [tokens, setTokens] = useState('2048'), [allowance, setAllowance] = useState('0.05');
  const suggestions = (provider === 'ollama' ? catalog.data?.ollama : catalog.data?.openrouter) ?? [];
  return <form aria-label="Authorize report job" onSubmit={event => { event.preventDefault(); void act(`/report-jobs/${jobId}/authorize`, { model: { provider, model: model.trim(), maxOutputTokens: Number(tokens) }, ...(provider === 'openrouter' ? { allowanceUsd: Number(allowance) } : {}) }, 'Report job authorized and queued.'); }}>
    <p className="hint">{released ? 'The run’s report allowance was released before this confirmation. Choose the Documentation model and, for a paid model, a fresh allowance for this one job.' : 'Choose the Documentation model for this one job.'} Nothing is called until you authorize.</p>
    <div className="pair"><label>Provider<select value={provider} onChange={event => { setProvider(event.target.value as 'ollama' | 'openrouter'); setModel(''); }}><option value="ollama">Host Ollama (local, no spend)</option><option value="openrouter">OpenRouter (paid)</option></select></label>
      <label>Documentation model<input required list="report-models" value={model} onChange={event => setModel(event.target.value)} /></label></div>
    <datalist id="report-models">{suggestions.map(item => <option key={item} value={item} />)}</datalist>
    <div className="pair"><label>Maximum output tokens<input type="number" min={1} max={4096} required value={tokens} onChange={event => setTokens(event.target.value)} /></label>
      {provider === 'openrouter' && <label>Allowance for this job (USD)<input type="number" min="0.000000001" max="100" step="any" required value={allowance} onChange={event => setAllowance(event.target.value)} /></label>}</div>
    <button className="primary" type="submit">Authorize and queue</button>
  </form>;
}

function JobPanel({ meta, accounting, act }: { meta: Metadata; accounting: Resource<Accounting>; act: Act }) {
  const job = meta.report.job, policy = accounting.data?.policy;
  return <div aria-labelledby="job-heading" role="group">
    <h3 id="job-heading">Report drafting</h3>
    {job ? <p role="status" className={job.state === 'failed' ? 'finding-warning' : undefined}><strong>{jobText[job.state]}</strong> · attempt {job.attempts} · evidence revision {job.evidenceRevision}{job.reason && <><br />{describeReason(job.reason)} <code>{job.reason}</code></>}</p> : <p role="status">No report job exists for this finding yet.</p>}
    {job?.state === 'report_needed' && <AuthorizeForm jobId={job.id} released={job.reason === 'allowance_released'} act={act} />}
    {job?.state === 'queued' && <button type="button" onClick={() => void act(`/report-jobs/${job.id}/cancel`, {}, 'Report job cancelled.')}>Cancel queued job</button>}
    {job && ['failed', 'cancelled'].includes(job.state) && <><button type="button" onClick={() => void act(`/findings/${meta.findingId}/report-jobs`, { evidenceRevision: job.evidenceRevision + 1 }, 'A new report job was created for evidence revision ' + (job.evidenceRevision + 1) + '.')}>Retry as a new report job</button>
      <p className="hint">A retry is a new job for evidence revision {job.evidenceRevision + 1}. It may need explicit authorization if the run allowance no longer covers it.</p></>}
    {!job && <button type="button" onClick={() => void act(`/findings/${meta.findingId}/report-jobs`, {}, 'Report job created.')}>Create report job</button>}
    {accounting.error && <p role="alert" className="finding-warning">Report allowance unavailable: {accounting.error} <button type="button" onClick={() => void accounting.reload()}>Retry allowance</button></p>}
    {accounting.data && (policy ? <p className="finding-allowance">Automatic drafting: {policy.model.provider} / {policy.model.model} (max {policy.model.maxOutputTokens} output tokens). Review window {Math.round(policy.reviewWindowSeconds / 60)} min{policy.reviewExpiresAt ? `, ${policy.releasedAt ? 'ended' : 'expires'} ${when(policy.reviewExpiresAt)}` : ' after the run finishes'}.
      {' '}{policy.releasedAt ? `Allowance released (${words(policy.releaseReason ?? 'released')}) ${when(policy.releasedAt)}; unused ${usd(BigInt(policy.unusedAtRelease ?? '0'))}.` : `Allowance ${usd(BigInt(policy.allowanceNanos))}: held ${usd(BigInt(accounting.data.heldNanos))}, unused ${usd(BigInt(accounting.data.unusedNanos))}.`}
      {!policy.releasedAt && <> <button type="button" onClick={() => void act(`/runs/${meta.runId}/report-allowance/cancel`, {}, 'Report allowance released; queued automatic drafts were cancelled.')}>Release remaining allowance</button></>}</p> : <p className="finding-allowance">Automatic drafting was not enabled for this run.</p>)}
  </div>;
}

export function ReportSection({ meta, integrity, revisions, accounting, onChanged }: { meta: Metadata; integrity: Resource<Integrity>; revisions: Resource<{ revisions: Revision[] }>; accounting: Resource<Accounting>; onChanged: () => void }) {
  const [viewId, setViewId] = useState(''), [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [problem, setProblem] = useState(''), [notice, setNotice] = useState('');
  const list = revisions.data?.revisions ?? [], current = list[0], shown = list.find(item => item.id === viewId) ?? current, viewingCurrent = shown === current;
  const approved = isApproved(current), block = confirmBlock(meta, integrity);
  const act: Act = async (path, body, done) => {
    if (busy) return;
    setBusy(true); setProblem(''); setNotice('');
    try { await requestJson(path, isRecord, { method: 'POST', body: JSON.stringify(body) }); setNotice(done); onChanged(); }
    catch (cause) { setProblem(problemText(cause)); if (cause instanceof ApiResponseError && ['superseded', 'content_changed', 'stale_parent'].includes(cause.reason ?? '')) onChanged(); }
    finally { setBusy(false); }
  };
  const download = async (format: 'markdown' | 'json') => {
    if (!current || busy) return;
    setBusy(true); setProblem(''); setNotice('');
    try {
      const response = await fetch(`/api/findings/${meta.findingId}/report${format === 'markdown' ? '?format=markdown' : ''}`, { headers: { Accept: format === 'json' ? 'application/json' : 'text/markdown' } });
      const text = await response.text();
      if (!response.ok) { let body: Record<string, unknown> = {}; try { body = JSON.parse(text); } catch { /* not JSON */ } throw new Error(typeof body.message === 'string' ? body.message : `Download failed (HTTP ${response.status})`); }
      const matches = format === 'json' ? (() => { try { const value = JSON.parse(text); return value.id === current.id && value.contentHash === current.contentHash; } catch { return false; } })() : text.includes(`Revision ${current.revision}, content hash ${current.contentHash}`);
      if (!matches) { onChanged(); throw new Error('The approved report changed while this page was open. Nothing was downloaded; review the refreshed revision.'); }
      const link = document.createElement('a'), url = URL.createObjectURL(new Blob([text], { type: format === 'json' ? 'application/json' : 'text/markdown' }));
      link.href = url; link.download = `finding-${meta.findingId.slice(0, 8)}-revision-${current.revision}.${format === 'json' ? 'json' : 'md'}`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(`Downloaded revision ${current.revision} (content hash ${current.contentHash.slice(0, 12)}…).`);
    } catch (cause) { setProblem(cause instanceof Error ? cause.message : 'Download failed'); }
    finally { setBusy(false); }
  };
  if (meta.state !== 'confirmed') return <section className="finding-card" aria-labelledby="report-heading"><h2 id="report-heading">Report</h2><p role="status">{meta.state === 'pending_review' ? 'A report exists only after this finding is confirmed. Confirmation never publishes a report; approval is a separate step.' : 'A rejected finding has no report.'}</p></section>;
  return <section className="finding-card" aria-labelledby="report-heading">
    <h2 id="report-heading">Report</h2>
    {notice && <p role="status" className="finding-notice">{notice}</p>}
    {problem && <p role="alert" className="finding-warning">{problem}</p>}
    <JobPanel meta={meta} accounting={accounting} act={act} />
    <h3>Revisions</h3>
    {revisions.error && <p role="alert" className="finding-warning">Revisions unavailable: {revisions.error} <button type="button" onClick={() => void revisions.reload()}>Retry revisions</button></p>}
    {!revisions.data && !revisions.error && <p role="status">Loading revisions…</p>}
    {revisions.data && !list.length && <p>No report revision yet. A draft appears here when the report job completes.</p>}
    {list.length > 0 && <ol className="finding-revisions">{list.map(item => <li key={item.id}><button type="button" aria-pressed={item === shown} onClick={() => { setViewId(item.id); setEditing(false); }}>Revision {item.revision}</button> {item.author} · {when(item.createdAt)} · hash <code>{item.contentHash.slice(0, 12)}</code> · <strong className={item.approval && !item.approval.invalidatedAt ? 'finding-approved' : undefined}>{stateOf(item)}</strong>{item === current && ' · current'}</li>)}</ol>}
    {shown && <>
      <div className="finding-approval" role="group" aria-labelledby="approval-heading"><h3 id="approval-heading">Approval and download</h3>
        {approved && current ? <p role="status"><strong>Approved: revision {current.revision}</strong>, content hash <code>{current.contentHash}</code>, {when(current.approval!.approvedAt)}. The download below is exactly this revision.</p>
          : <p role="status">Revision {current!.revision} is not approved. Approval applies to this exact content hash; any edit or newer draft voids it.</p>}
        {!viewingCurrent && <p className="hint">You are viewing revision {shown.revision}. Only the current revision ({current!.revision}) can be approved or downloaded.</p>}
        <div className="finding-actions">
          <button className="primary" type="button" disabled={busy || approved || !viewingCurrent || !!block} aria-describedby="approve-reason" onClick={() => void act(`/findings/${meta.findingId}/report-revisions/${current!.id}/approve`, { contentHash: current!.contentHash }, `Approved revision ${current!.revision}.`)}>Approve revision {current!.revision}</button>
          <button type="button" disabled={busy || !approved} aria-describedby="approve-reason" onClick={() => void download('markdown')}>Download Markdown</button>
          <button type="button" disabled={busy || !approved} aria-describedby="approve-reason" onClick={() => void download('json')}>Download JSON</button></div>
        <p className="hint" id="approve-reason">{block ? `Approval unavailable: ${block}.` : !approved ? 'Downloads are enabled only when the current revision is approved.' : 'Approved. Downloads are checked against the approved content hash.'}</p></div>
      <ReportPreview revision={shown} />
      {viewingCurrent && <><button type="button" aria-expanded={editing} onClick={() => setEditing(!editing)}>{editing ? 'Close narrative editor' : 'Edit narrative (creates a new revision)'}</button>
        {editing && <RevisionEditor key={shown.id} findingId={meta.findingId} revision={shown} onSaved={message => { setEditing(false); setNotice(message); setViewId(''); onChanged(); }} />}</>}
    </>}
  </section>;
}
