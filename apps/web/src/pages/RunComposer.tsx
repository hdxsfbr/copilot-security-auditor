import React, { useEffect, useRef, useState } from 'react';
import { ApiResponseError, requestJson } from '../api/client.js';
import { PreflightSummary } from '../components/models/PreflightSummary.js';
import { ReportPolicyFields } from '../components/models/ReportPolicyFields.js';
import { RoleAssignments } from '../components/models/RoleAssignments.js';
import { activeRoles, allRoles, buildRun, draftFromDefinition, draftKey, isCatalog, isDefinition, isPreflight, isStarted, isSummaryList, launchBlock, newDraft, seedCategory,
  type Assignment, type Catalog, type Definition, type DefinitionSummary, type Draft, type Preflight, type ReportDraft, type Role } from '../components/models/definitions.js';
import { SuiteComposer } from '../components/models/SuiteComposer.js';
import { RouteLink } from '../components/router.js';
import { useWorkspace } from './context.js';

type Action = 'check' | 'save' | 'start';
type Fault = { message: string; activeRunId?: string; stale?: boolean; retry?: 'check' | 'start'; top?: boolean };
const errorText = (cause: unknown, fallback: string) => cause instanceof Error ? cause.message : fallback;
const words = (value: string) => value.replaceAll('_', ' ');
const runLink = (id: string) => `/runs/${encodeURIComponent(id)}`;

/** The single manual launch path: compose, preflight, save as a reusable definition, then launch that exact revision. */
export function RunComposer({ active }: { active: boolean }) {
  const { targets, cases, targetId, caseId, caseHandoff, model, ollamaUrl, setTargetId, setCaseId, refresh, openRun, navigate } = useWorkspace();
  const [draft, setDraft] = useState(() => newDraft(targetId, caseId, model, ollamaUrl));
  const draftRef = useRef(draft), edits = useRef(0), inFlight = useRef(false), activations = useRef(0), touched = useRef({ url: false, model: false });
  const errorRef = useRef<HTMLDivElement>(null);
  const [saved, setSaved] = useState<Definition | null>(null);
  const [summaries, setSummaries] = useState<DefinitionSummary[]>([]);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState(''), [definitionsError, setDefinitionsError] = useState('');
  const [checked, setChecked] = useState<{ key: string; result: Preflight } | null>(null);
  const [busy, setBusy] = useState<Action | 'load' | null>(null);
  const [fault, setFault] = useState<Fault | null>(null);
  const [notice, setNotice] = useState('');
  const [launch, setLaunch] = useState<'run' | 'suite'>('run');

  const chosen = cases.find(item => item.id === draft.caseId), target = targets.find(item => item.id === draft.targetId);
  const nameOf = (value: Draft) => value.name.trim() || `${targets.find(item => item.id === value.targetId)?.name ?? 'Target'} · ${value.kind === 'selected' ? cases.find(item => item.id === value.caseId)?.title ?? 'case' : 'adaptive exploration'}`.slice(0, 120);
  const keyOf = (value: Draft) => draftKey(value, cases, nameOf(value));
  const key = keyOf(draft), savedKey = saved ? draftKey(draftFromDefinition(saved), cases, saved.name) : '';
  const current = checked && key && checked.key === key ? checked.result : null;
  const blocked = current ? launchBlock(current) : null, clean = !!saved && savedKey === key;
  const roles = activeRoles(draft.kind), usesLocal = roles.some(role => draft.roles[role].provider === 'ollama') || draft.report.enabled && draft.report.provider === 'ollama', usesPaid = roles.some(role => draft.roles[role].provider === 'openrouter') || draft.report.enabled && draft.report.provider === 'openrouter';
  const categories = [...new Set(cases.filter(item => draft.caseIds.includes(item.id)).map(seedCategory))];
  const plan = !saved ? 'Start saves this as a new reusable definition, then launches it.' : clean ? `Start launches saved revision ${saved.revision} exactly as shown.` : `Start saves your changes as revision ${saved.revision + 1}, then launches it.`;

  // Every change goes through here: it invalidates the displayed preflight and any stale error.
  const edit = (update: (value: Draft) => Draft) => {
    const next = update(draftRef.current);
    if (next === draftRef.current) return;
    draftRef.current = next; edits.current++;
    setDraft(next); setChecked(null); setFault(null); setNotice('');
  };
  const changeRole = (role: Role, patch: Partial<Assignment>) => {
    if ('model' in patch || 'provider' in patch) touched.current.model = true;
    edit(value => ({ ...value, roles: { ...value.roles, [role]: { ...value.roles[role], ...patch } } }));
  };
  const changeReport = (patch: Partial<ReportDraft>) => {
    if ('model' in patch || 'provider' in patch) touched.current.model = true;
    edit(value => ({ ...value, report: { ...value.report, ...patch } }));
  };
  const withDefaults = (value: Draft): Draft => {
    if (touched.current.url && touched.current.model) return value;
    const roles = touched.current.model ? value.roles : Object.fromEntries(allRoles.map(role => [role, value.roles[role].provider === 'ollama' ? { ...value.roles[role], model } : value.roles[role]])) as Draft['roles'];
    const next = { ...value, roles, ollamaUrl: touched.current.url ? value.ollamaUrl : ollamaUrl, report: value.report.provider === 'ollama' && !touched.current.model ? { ...value.report, model } : value.report };
    return JSON.stringify(next) === JSON.stringify(value) ? value : next;
  };
  const loadCatalog = async () => {
    try { setCatalog(await requestJson('/models', isCatalog)); setCatalogError(''); }
    catch (cause) { setCatalogError(errorText(cause, 'Model catalog unavailable')); }
  };
  const loadDefinitions = async () => {
    try { setSummaries(await requestJson('/run-definitions', isSummaryList)); setDefinitionsError(''); }
    catch (cause) { setDefinitionsError(errorText(cause, 'Saved definitions unavailable')); }
  };
  useEffect(() => {
    if (!active) return;
    void loadCatalog(); void loadDefinitions();
    if (activations.current++ > 0) void refresh(); // returning to the composer: refresh target reservations
  }, [active]);
  useEffect(() => { if (targetId && targetId !== draftRef.current.targetId) edit(value => ({ ...value, targetId })); }, [targetId]);
  useEffect(() => { if (caseId && !draftRef.current.caseId) edit(value => ({ ...value, caseId })); }, [caseId]);
  useEffect(() => { if (caseHandoff) edit(value => ({ ...value, kind: 'selected', caseId: caseHandoff.caseId })); }, [caseHandoff]);
  useEffect(() => edit(withDefaults), [model, ollamaUrl]);
  useEffect(() => { if (fault) errorRef.current?.focus(); }, [fault]);

  const fail = (cause: unknown, retry?: Fault['retry'], top = false) => {
    const activeRunId = cause instanceof ApiResponseError ? cause.activeRunId : undefined;
    if (activeRunId) void refresh();
    setFault({ message: errorText(cause, 'Request failed'), activeRunId, stale: cause instanceof ApiResponseError && cause.status === 409 && !activeRunId, retry, top });
  };
  const openDefinition = async (id: string) => {
    if (inFlight.current) return;
    if (!id) { setSaved(null); touched.current = { url: false, model: false }; edit(() => newDraft(targetId, caseId, model, ollamaUrl)); return; }
    inFlight.current = true; setBusy('load'); setFault(null);
    const seen = edits.current;
    try {
      const value = await requestJson(`/run-definitions/${encodeURIComponent(id)}`, isDefinition);
      if (value.archived) throw new Error('This definition was archived. Choose another or start a new one.');
      if (seen !== edits.current) throw new Error('The draft changed while the definition loaded. Select the definition again to replace the draft.');
      const next = draftFromDefinition(value);
      touched.current = { url: true, model: true };
      setSaved(value); edit(() => next); setTargetId(next.targetId); if (next.caseId) setCaseId(next.caseId);
    } catch (cause) { fail(cause, undefined, true); }
    finally { inFlight.current = false; setBusy(null); }
  };

  // One guarded sequence: check -> save a new/changed revision -> launch that exact revision. The ref gate blocks rapid double submits.
  const run = async (action: Action) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(action); setFault(null); setNotice('');
    try {
      const value = draftRef.current, definition = buildRun(value, cases), snapshot = keyOf(value), name = nameOf(value);
      if (action !== 'save') {
        const result = await requestJson('/model-preflight', isPreflight, { method: 'POST', body: JSON.stringify(definition) });
        if (keyOf(draftRef.current) !== snapshot) throw new Error('Run settings changed during the check. Review them and try again.');
        setChecked({ key: snapshot, result });
        const problem = launchBlock(result);
        if (problem) { setFault({ message: problem, retry: 'check' }); return; }
        if (action === 'check') { setNotice('Models and reservation checked. Inference health remains unverified.'); return; }
      }
      let definitionToRun = saved;
      if (!definitionToRun || savedKey !== snapshot) {
        const body = JSON.stringify({ ...(saved ? { revision: saved.revision } : {}), name, run: definition });
        const stored = await requestJson(saved ? `/run-definitions/${saved.id}` : '/run-definitions', isDefinition, { method: saved ? 'PUT' : 'POST', body });
        definitionToRun = stored; setSaved(stored);
        setSummaries(list => [{ id: stored.id, name: stored.name, revision: stored.revision }, ...list.filter(item => item.id !== stored.id)]);
        if (keyOf(draftRef.current) !== snapshot) throw new Error(`Settings changed while saving. Revision ${stored.revision} keeps the earlier values; review and start again.`);
      }
      if (action === 'save') { setNotice(`Saved definition revision ${definitionToRun.revision}.`); return; }
      const started = await requestJson(`/run-definitions/${definitionToRun.id}/launch`, isStarted, { method: 'POST', body: JSON.stringify({ revision: definitionToRun.revision }) });
      void refresh(); openRun(started.id, 'assigned per role');
    } catch (cause) { fail(cause, action === 'save' ? undefined : action); }
    finally { inFlight.current = false; setBusy(null); }
  };
  const validated = (action: Action) => (event: React.MouseEvent<HTMLButtonElement>) => { if (event.currentTarget.form?.reportValidity()) void run(action); };

  const faultAlert = fault && <div ref={errorRef} tabIndex={-1} role="alert" className="alert composer-fault">
    <p>{fault.message}</p>
    {fault.activeRunId && <p><RouteLink href={runLink(fault.activeRunId)} navigate={navigate}>Inspect active run {fault.activeRunId.slice(0, 8)}</RouteLink> or wait for it to finish; your draft is kept.</p>}
    {fault.stale && saved && <p>Your draft is unchanged. <button type="button" onClick={() => void openDefinition(saved.id)}>Reload saved definition</button> <button type="button" onClick={() => { setSaved(null); setFault(null); }}>Keep my draft as a new definition</button></p>}
    {fault.retry && !fault.stale && !fault.activeRunId && <button type="button" onClick={() => void run(fault.retry!)}>Retry</button>}
  </div>;
  return <section className="panel run-composer" aria-labelledby="run-composer-title">
    <h2 id="run-composer-title">Compose a run</h2>
    <p className="hint">Pick a target and test input, then the models each invoked role uses and its bounds. Nothing is dispatched until you press Start, and Start always checks availability and the paid reservation first.</p>
    {fault?.top && faultAlert}
    {definitionsError && <p role="alert" className="alert">Saved definitions unavailable: {definitionsError} <button type="button" onClick={() => void loadDefinitions()}>Retry definitions</button></p>}
    {catalogError && <p role="alert" className="alert">Model catalog unavailable: {catalogError}. Typed model names still work; preflight remains the authority. <button type="button" onClick={() => void loadCatalog()}>Retry model catalog</button></p>}
    <fieldset className="composer-mode composer-launch"><legend>Launch type</legend>
      <label className="composer-choice"><input type="radio" name="launch-type" checked={launch === 'run'} onChange={() => setLaunch('run')}/>Run</label>
      <label className="composer-choice"><input type="radio" name="launch-type" checked={launch === 'suite'} onChange={() => setLaunch('suite')}/>Regression suite</label>
    </fieldset>
    {launch === 'suite' ? <SuiteComposer active={active}/> : <form onSubmit={event => { event.preventDefault(); void run('start'); }}>
      <fieldset disabled={busy !== null} className="composer-fields">
        <div className="composer-section">
          <h3>1. Definition and target</h3>
          <div className="pair">
            <label>Saved definition<select value={saved?.id ?? ''} onChange={event => void openDefinition(event.target.value)}>
              <option value="">New definition</option>
              {saved && !summaries.some(item => item.id === saved.id) && <option value={saved.id}>{saved.name} · revision {saved.revision}</option>}
              {summaries.map(item => <option key={item.id} value={item.id}>{item.name} · revision {item.revision}</option>)}
            </select></label>
            <label>Definition name<input maxLength={120} value={draft.name} placeholder={nameOf(draft)} onChange={event => edit(value => ({ ...value, name: event.target.value }))}/></label>
          </div>
          <label>Saved authorized target<select required value={draft.targetId} onChange={event => { setTargetId(event.target.value); edit(value => ({ ...value, targetId: event.target.value })); }}>
            <option value="">Select a saved target</option>
            {targets.map(item => <option key={item.id} value={item.id}>{item.name} - {item.baseUrl}{item.activeRunId ? ' (reserved)' : ''}</option>)}
          </select></label>
          {!targets.length && <p className="hint">No targets saved yet. <RouteLink href="/targets" navigate={navigate}>Create a target</RouteLink>, then return here.</p>}
          {target?.activeRunId && <p role="status" className="composer-warning">This target is reserved by an active run, so a new launch is rejected until it finishes. <RouteLink href={runLink(target.activeRunId)} navigate={navigate}>Inspect active run {target.activeRunId.slice(0, 8)}</RouteLink></p>}
        </div>
        <div className="composer-section">
          <h3>2. Test input</h3>
          <fieldset className="composer-mode"><legend>Run mode</legend>
            <label className="composer-choice"><input type="radio" name="run-mode" checked={draft.kind === 'selected'} onChange={() => edit(value => ({ ...value, kind: 'selected', caseId: value.caseId || caseId }))}/>Single case</label>
            <label className="composer-choice"><input type="radio" name="run-mode" checked={draft.kind === 'adaptive'} onChange={() => edit(value => ({ ...value, kind: 'adaptive' }))}/>Adaptive exploration</label>
          </fieldset>
          {draft.kind === 'selected' ? <>
            <p className="hint">Runs one published case. Chart-context cases check the Co-Pilot's response boundary, not OpenEMR permissions; the other saved patient ID is substituted at dispatch.</p>
            <label>Selected case<select required value={draft.caseId} onChange={event => { setCaseId(event.target.value); edit(value => ({ ...value, caseId: event.target.value })); }}>
              <option value="">Select case</option>
              {cases.map(item => <option key={item.id} value={item.id}>{item.id === 'c0000000-0000-4000-8000-000000000002' ? `Legacy (role isolation): ${item.title}` : item.title}</option>)}
            </select></label>
            {chosen && <div className="case-preview">
              <strong>{words(seedCategory(chosen))} / user {chosen.user}</strong>
              <p>Expected: {chosen.expectedSafeBehavior}</p>
              {chosen.actions.map((action, index) => <p key={index}>Step {index + 1} ({action.kind}): {action.message}</p>)}
            </div>}
          </> : <>
            <fieldset className="composer-seeds"><legend>Authorized seed cases</legend>
              <p className="hint">Seeds set the boundaries, checks, users and attachments. The Red Team proposes at most three turns per case and nothing dispatches unless validated. Every covered category needs a seed.</p>
              {cases.map(item => <label className="composer-choice" key={item.id}><input type="checkbox" checked={draft.caseIds.includes(item.id)} onChange={event => edit(value => ({ ...value, caseIds: event.target.checked ? [...value.caseIds, item.id] : value.caseIds.filter(id => id !== item.id) }))}/>{item.title} ({words(seedCategory(item))})</label>)}
              <p className="hint" role="status">{draft.caseIds.length ? `${draft.caseIds.length} seed${draft.caseIds.length === 1 ? '' : 's'} selected; categories covered: ${categories.map(words).join(', ')}.` : 'No seeds selected yet.'}</p>
            </fieldset>
            <div className="pair">
              <label>Maximum cases<input type="number" min={1} max={9} required value={draft.maxCases} onChange={event => edit(value => ({ ...value, maxCases: Number(event.target.value) }))}/></label>
              <label>Maximum elapsed minutes<input type="number" min={1} max={30} required value={draft.maxMinutes} onChange={event => edit(value => ({ ...value, maxMinutes: Number(event.target.value) }))}/></label>
            </div>
          </>}
          {!cases.length && <p className="hint">No published cases yet. <RouteLink href="/cases" navigate={navigate}>Create and publish a case</RouteLink>.</p>}
        </div>
        <div className="composer-section">
          <h3>3. Model roles</h3>
          <p className="hint">{draft.kind === 'selected' ? 'A single case invokes only the Judge.' : 'Adaptive runs invoke the Orchestrator, Red Team and Judge.'} Only these roles need a valid model. Hosted calls receive pseudonymized observations, and the paid cap is enforced before dispatch, per run.</p>
          <RoleAssignments kind={draft.kind} roles={draft.roles} catalog={catalog} localModel={model} onChange={changeRole}/>
          {usesLocal && <label>Local model server URL<input type="url" required value={draft.ollamaUrl} onChange={event => { touched.current.url = true; edit(value => ({ ...value, ollamaUrl: event.target.value })); }}/></label>}
          {usesPaid && <label>Maximum OpenRouter spend (USD, this run)<input type="number" min="0.000000001" max="100" step="any" required value={draft.cap} onChange={event => edit(value => ({ ...value, cap: event.target.value }))}/></label>}
        </div>
        <div className="composer-section">
          <h3>4. Report drafting (optional)</h3>
          <ReportPolicyFields value={draft.report} catalog={catalog} localModel={model} onChange={changeReport}/>
        </div>
      </fieldset>
      <div className="composer-section">
        <h3>5. Check and launch</h3>
        {fault && !fault.top && faultAlert}
        {notice && <p role="status" className="composer-notice">{notice}</p>}
        <PreflightSummary result={current} checking={busy === 'check' || (busy === 'start' && !current)} catalog={catalog}/>
        <p className="hint" id="composer-plan">{plan}</p>
        <div className="composer-actions">
          <button type="button" disabled={busy !== null} onClick={validated('check')}>Check availability</button>
          <button type="button" disabled={busy !== null} onClick={validated('save')}>Save definition</button>
          <button className="primary" type="submit" aria-describedby="composer-plan" disabled={busy !== null || !!blocked}>{busy === 'start' ? 'Starting…' : busy === 'load' ? 'Loading…' : 'Start run'}</button>
        </div>
      </div>
    </form>}
  </section>;
}
