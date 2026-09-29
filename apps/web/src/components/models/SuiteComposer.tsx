import React, { useEffect, useRef, useState } from 'react';
import { ApiResponseError, requestJson } from '../../api/client.js';
import { useWorkspace } from '../../pages/context.js';
import { isIdentityList, isSuiteDetail, newSuiteForm, suiteSettings, words } from '../regressions/model.js';
import { RouteLink } from '../router.js';
import { PreflightSummary } from './PreflightSummary.js';
import { SuiteFields } from './SuiteFields.js';
import { isCatalog, isPreflight, launchBlock, usd, type Catalog, type Preflight } from './definitions.js';

/** Composer suite mode: pick identities (or every confirmed one on the target), the Judge and the bounds, check, then launch. */
export function SuiteComposer({ active }: { active: boolean }) {
  const { targets, targetId, setTargetId, model, ollamaUrl, navigate, refresh } = useWorkspace();
  const [form, setForm] = useState(() => newSuiteForm(model, ollamaUrl)), [version, setVersion] = useState('');
  const [mode, setMode] = useState<'all_confirmed' | 'identities'>('all_confirmed'), [picked, setPicked] = useState<string[]>([]);
  const [identities, setIdentities] = useState<{ id: string; title: string }[]>([]), [catalog, setCatalog] = useState<Catalog | null>(null);
  const [checked, setChecked] = useState<{ key: string; result: Preflight } | null>(null), [busy, setBusy] = useState(false), [fault, setFault] = useState<{ text: string; runId?: string } | null>(null);
  const inFlight = useRef(false), touched = useRef(false), target = targets.find(item => item.id === targetId);
  useEffect(() => { if (!touched.current) setForm(value => ({ ...value, judge: { ...value.judge, model }, ollamaUrl })); }, [model, ollamaUrl]);
  useEffect(() => { if (active) void requestJson('/models', isCatalog).then(setCatalog, () => setCatalog(null)); }, [active]);
  useEffect(() => {
    setPicked([]); setIdentities([]);
    if (!active || !targetId) return;
    void requestJson(`/regression-identities?targetId=${targetId}&limit=100`, isIdentityList).then(list => setIdentities(list.items.map(item => ({ id: item.id, title: `${item.title ?? item.firstMessage} (${words(item.category ?? 'uncategorized')})` }))), () => setIdentities([]));
  }, [active, targetId]);
  const selection = mode === 'all_confirmed' ? { mode } : { mode, identityIds: picked };
  const body = { targetId, selection, ...suiteSettings(form), ...(version.trim() ? { expectedVersion: version.trim() } : {}) };
  const key = JSON.stringify(body), current = checked?.key === key ? checked.result : null, block = current ? launchBlock(current) : null;
  const change = (patch: Partial<typeof form>) => { touched.current = true; setForm(value => ({ ...value, ...patch })); setChecked(null); setFault(null); };
  const run = async (launch: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setFault(null);
    try {
      const result = await requestJson('/regression-suites/preflight', isPreflight, { method: 'POST', body: key });
      setChecked({ key, result });
      const problem = launchBlock(result);
      if (problem) { setFault({ text: problem }); return; }
      if (!launch) return;
      await requestJson('/regression-suites', isSuiteDetail, { method: 'POST', body: key });
      void refresh(); navigate('/regressions');
    } catch (cause) { setFault({ text: cause instanceof Error ? cause.message : 'Request failed', runId: cause instanceof ApiResponseError ? cause.activeRunId : undefined }); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const ready = !!targetId && (mode === 'all_confirmed' || picked.length > 0), items = mode === 'all_confirmed' ? form.maxItems : Math.min(picked.length, form.maxItems);
  return <form className="suite-composer" onSubmit={event => { event.preventDefault(); if (event.currentTarget.reportValidity()) void run(true); }}>
    <fieldset disabled={busy} className="composer-fields">
      <div className="composer-section">
        <h3>1. Target</h3>
        <label>Saved authorized target<select required value={targetId} onChange={event => { setTargetId(event.target.value); setChecked(null); }}>
          <option value="">Select a saved target</option>{targets.map(item => <option key={item.id} value={item.id}>{item.name} - {item.baseUrl}{item.activeRunId ? ' (reserved)' : ''}</option>)}</select></label>
        {target?.activeRunId && <p role="status" className="composer-warning">This target is reserved by an active run, so a suite cannot start until it finishes. <RouteLink href={`/runs/${target.activeRunId}`} navigate={navigate}>Inspect active run {target.activeRunId.slice(0, 8)}</RouteLink></p>}
      </div>
      <div className="composer-section">
        <h3>2. Regression identities</h3>
        <p className="hint">Each identity replays as its own run, one at a time through the target reservation. Nothing is deployed or patched, and a blocked or incomplete item is kept as such, never retried.</p>
        <fieldset className="composer-mode"><legend>Selection</legend>
          <label className="composer-choice"><input type="radio" name="suite-selection" checked={mode === 'all_confirmed'} onChange={() => { setMode('all_confirmed'); setChecked(null); }}/>All confirmed identities seen on this target</label>
          <label className="composer-choice"><input type="radio" name="suite-selection" checked={mode === 'identities'} onChange={() => { setMode('identities'); setChecked(null); }}/>Choose identities</label>
        </fieldset>
        {mode === 'identities' && <fieldset className="composer-seeds"><legend>Identities on this target</legend>
          {identities.map(item => <label className="composer-choice" key={item.id}><input type="checkbox" checked={picked.includes(item.id)} onChange={event => { setPicked(list => event.target.checked ? [...list, item.id] : list.filter(id => id !== item.id)); setChecked(null); }}/>{item.title}</label>)}
          {!identities.length && <p className="hint">{targetId ? 'No confirmed identities seen on this target.' : 'Select a target first.'}</p>}
          <p className="hint" role="status">{picked.length} selected (at most {form.maxItems}).</p>
        </fieldset>}
        <label>Target version being validated (optional label)<input maxLength={200} value={version} onChange={event => { setVersion(event.target.value); setChecked(null); }}/></label>
        <p className="hint">The label is never used as a result: every item records the version its own run observed, and states are derived from that.</p>
      </div>
      <div className="composer-section">
        <h3>3. Judge and bounds</h3>
        <SuiteFields form={form} catalog={catalog} localModel={model} onChange={change}/>
        <p className="hint">Each item is one selected run, so the paid cap applies per item run: this suite can hold at most {items} item{items === 1 ? '' : 's'}{form.judge.provider === 'openrouter' && Number(form.cap) > 0 ? ` and spend at most ${usd(BigInt(Math.round(Number(form.cap) * 1e9)) * BigInt(items))}` : ''}, and nothing new starts after {form.maxMinutes} minutes.</p>
      </div>
    </fieldset>
    <div className="composer-section">
      <h3>4. Check and launch</h3>
      {fault && <div role="alert" className="alert composer-fault"><p>{fault.text}</p>{fault.runId && <p><RouteLink href={`/runs/${fault.runId}`} navigate={navigate}>Inspect active run {fault.runId.slice(0, 8)}</RouteLink> or wait for it to finish.</p>}</div>}
      <PreflightSummary result={current} checking={busy && !current} catalog={catalog}/>
      <div className="composer-actions">
        <button type="button" disabled={busy || !ready} onClick={event => { if (event.currentTarget.form?.reportValidity()) void run(false); }}>Check availability</button>
        <button className="primary" type="submit" disabled={busy || !ready || !!block}>{busy ? 'Starting…' : 'Start suite'}</button>
      </div>
    </div>
  </form>;
}
