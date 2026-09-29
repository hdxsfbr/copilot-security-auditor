import React, { useEffect, useRef, useState } from 'react';
import { isRecord, requestJson } from './api/client.js';

type Provider = 'ollama' | 'openrouter';
type Assignment = { provider: Provider; model: string; maxOutputTokens: number };
type Role = 'orchestrator' | 'redTeam' | 'judge' | 'documentation';
const roles: Role[] = ['orchestrator', 'redTeam', 'judge', 'documentation'];
type Usage = { id: string; role: Role; provider: Provider; model: string; status: string; inputTokens: number | null; outputTokens: number | null; latencyMs: number | null; chargeNanos: string | null; reservedNanos: string };
type Seed = { id: string; title: string; category?: string };
type AdaptiveCase = { id: string; ordinal: number; category: string; state: string; executed: boolean; reason?: string | null };
type ModelCatalog = { openrouter: string[]; ollama: string[]; configured: boolean };
type ModelConfig = { model: string; ollamaUrl: string };
const dollars = (nanos: string) => `$${(Number(nanos) / 1e9).toFixed(9).replace(/(\.\d{6})0+$/, '$1')}`;

const isRole = (value: unknown): value is Role => roles.includes(value as Role);
const isProvider = (value: unknown): value is Provider => value === 'ollama' || value === 'openrouter';
const isAssignment = (value: unknown): value is Assignment => isRecord(value) && isProvider(value.provider) && typeof value.model === 'string' && Number.isInteger(value.maxOutputTokens);
const isConfig = (value: unknown): value is ModelConfig => isRecord(value) && typeof value.model === 'string' && typeof value.ollamaUrl === 'string';
const isCatalog = (value: unknown): value is ModelCatalog => isRecord(value) && Array.isArray(value.openrouter) && value.openrouter.every(model => typeof model === 'string') && Array.isArray(value.ollama) && value.ollama.every(model => typeof model === 'string') && typeof value.configured === 'boolean';
const isUsage = (value: unknown): value is Usage => isRecord(value) && typeof value.id === 'string' && isRole(value.role) && isProvider(value.provider) && typeof value.model === 'string' && typeof value.status === 'string' && (value.inputTokens === null || typeof value.inputTokens === 'number') && (value.outputTokens === null || typeof value.outputTokens === 'number') && (value.latencyMs === null || typeof value.latencyMs === 'number') && (value.chargeNanos === null || typeof value.chargeNanos === 'string') && typeof value.reservedNanos === 'string';
const isUsageList = (value: unknown): value is Usage[] => Array.isArray(value) && value.every(isUsage);
const isAdaptiveCase = (value: unknown): value is AdaptiveCase => isRecord(value) && typeof value.id === 'string' && Number.isInteger(value.ordinal) && typeof value.category === 'string' && typeof value.state === 'string' && typeof value.executed === 'boolean' && (value.reason === undefined || value.reason === null || typeof value.reason === 'string');
const isAdaptiveCaseList = (value: unknown): value is AdaptiveCase[] => Array.isArray(value) && value.every(isAdaptiveCase);
const isStartedRun = (value: unknown): value is { id: string } => isRecord(value) && typeof value.id === 'string';
const isStopResult = (value: unknown): value is { stopRequested: boolean } => isRecord(value) && typeof value.stopRequested === 'boolean';

function modelAssignments(value: ModelConfig): Record<Role, Assignment> {
  return Object.fromEntries(roles.map(role => [role, { provider: 'ollama' as const, model: value.model, maxOutputTokens: 1024 }])) as Record<Role, Assignment>;
}

export function ModelDesk({ targetId, caseId, cases, runId, runCategories, runStatus, onStart }: { targetId: string; caseId: string; cases: Seed[]; runId?: string; runCategories?: string[] | null; runStatus?: string; onStart: (id: string) => void }) {
  const [config, setConfig] = useState<ModelConfig>({ model: '', ollamaUrl: '' });
  const [available, setAvailable] = useState<ModelCatalog>({ openrouter: [], ollama: [], configured: false });
  const [assignments, setAssignments] = useState<Record<Role, Assignment> | null>(null);
  const [cap, setCap] = useState('0.25');
  const [usage, setUsage] = useState<Usage[]>([]);
  const [selectedCases, setSelectedCases] = useState<string[]>([]);
  const [maxCases, setMaxCases] = useState(3);
  const [maxMinutes, setMaxMinutes] = useState(3);
  const [progress, setProgress] = useState<AdaptiveCase[]>([]);
  const [stopping, setStopping] = useState(false);
  const [configError, setConfigError] = useState('');
  const [catalogError, setCatalogError] = useState('');
  const [usageError, setUsageError] = useState('');
  const [progressError, setProgressError] = useState('');
  const [actionError, setActionError] = useState('');
  const configEdited = useRef({ model: false, ollamaUrl: false });

  const loadConfig = async (preserveEdits = true) => {
    try {
      const next = await requestJson('/config', isConfig);
      setConfig(current => preserveEdits ? { model: configEdited.current.model ? current.model : next.model, ollamaUrl: configEdited.current.ollamaUrl ? current.ollamaUrl : next.ollamaUrl } : next);
      setAssignments(current => current ?? modelAssignments(next));
      setConfigError('');
    } catch (cause) { setConfigError(cause instanceof Error ? cause.message : 'Model defaults unavailable'); }
  };
  const loadCatalog = async () => {
    try {
      const next = await requestJson('/models', isCatalog);
      setAvailable(next);
      setCatalogError('');
    } catch (cause) { setCatalogError(cause instanceof Error ? cause.message : 'Model catalog unavailable'); }
  };
  const loadUsage = async (id = runId) => {
    if (!id) return;
    try {
      const next = await requestJson(`/runs/${id}/usage`, isUsageList);
      setUsage(next);
      setUsageError('');
    } catch (cause) { setUsageError(cause instanceof Error ? cause.message : 'Usage ledger unavailable'); }
  };
  const loadProgress = async (id = runId) => {
    if (!id) return;
    try {
      const next = await requestJson(`/runs/${id}/cases`, isAdaptiveCaseList);
      setProgress(next);
      setProgressError('');
    } catch (cause) { setProgressError(cause instanceof Error ? cause.message : 'Adaptive progress unavailable'); }
  };

  useEffect(() => {
    void loadConfig();
    void loadCatalog();
  }, []);
  useEffect(() => {
    if (!runId) return;
    void loadUsage(runId);
    const timer = setInterval(() => { void loadUsage(runId); }, 1500);
    return () => clearInterval(timer);
  }, [runId]);
  useEffect(() => {
    if (!runId) return;
    void loadProgress(runId);
    const timer = setInterval(() => { void loadProgress(runId); }, 1500);
    return () => clearInterval(timer);
  }, [runId]);

  const update = (role: Role, next: Partial<Assignment>) => setAssignments(current => current && ({ ...current, [role]: { ...current[role], ...next } }));
  const launch = async (event: React.FormEvent) => {
    event.preventDefault(); setActionError('');
    if (!assignments) return;
    const paid = roles.some(role => assignments[role].provider === 'openrouter');
    try {
      const result = await requestJson('/runs', isStartedRun, { method: 'POST', body: JSON.stringify({ targetId, caseId, ollamaUrl: config.ollamaUrl, roles: assignments, ...(paid ? { openRouterCapUsd: Number(cap) } : {}) }) });
      setUsage([]); setProgress([]); setUsageError(''); setProgressError(''); onStart(result.id);
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : 'Could not start run'); }
  };
  const launchAdaptive = async (event: React.FormEvent) => {
    event.preventDefault(); setActionError('');
    if (!assignments) return;
    const chosen = cases.filter(c => selectedCases.includes(c.id));
    if (!chosen.length) { setActionError('Select at least one seed case'); return; }
    const paid = roles.some(role => assignments[role].provider === 'openrouter');
    try {
      const result = await requestJson('/adaptive-runs', isStartedRun, { method: 'POST', body: JSON.stringify({ targetId, caseIds: chosen.map(c => c.id), categories: [...new Set(chosen.map(c => c.category ?? 'prompt_injection'))], maxCases, maxMinutes, ollamaUrl: config.ollamaUrl, roles: assignments, ...(paid ? { openRouterCapUsd: Number(cap) } : {}) }) });
      setProgress([]); setUsage([]); setUsageError(''); setProgressError(''); setStopping(false); onStart(result.id);
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : 'Could not start exploration'); }
  };
  const requestStop = async () => {
    if (!runId) return;
    setActionError('');
    try {
      await requestJson(`/runs/${runId}/stop`, isStopResult, { method: 'POST' });
      setStopping(true);
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : 'Stop request failed'); }
  };

  const paid = !!assignments && roles.some(role => assignments[role].provider === 'openrouter');
  const settled = usage.filter(call => call.provider === 'openrouter' && call.status === 'settled').reduce((total, call) => total + Number(call.chargeNanos ?? 0), 0);
  return <section className="panel model-desk"><h2><span>03</span> Role models & spend</h2><p className="hint">Choose each role independently. Selected-case runs invoke only the Judge; adaptive runs invoke Orchestrator, Red Team and Judge. Hosted calls receive pseudonymized observations. The paid cap is enforced before dispatch, per run.</p>
    {configError && <div className="alert" role="alert">Model defaults unavailable: {configError} <button type="button" onClick={() => void loadConfig()}>Retry model defaults</button></div>}
    {catalogError && <div className="alert" role="alert">OpenRouter catalog unavailable. Loaded models and local runs remain available. {catalogError} <button type="button" onClick={() => void loadCatalog()}>Retry model catalog</button></div>}
    <form onSubmit={e => void launch(e)}>
      <label>Local model server URL<input type="url" required value={config.ollamaUrl} onChange={e => { configEdited.current.ollamaUrl = true; setConfig({ ...config, ollamaUrl: e.target.value }); }}/></label>
      <div className="model-roles">{assignments && roles.map(role => <div key={role} className="review-item"><strong>{role === 'redTeam' ? 'Red Team' : role}</strong><label>Provider<select value={assignments[role].provider} onChange={e => update(role, { provider: e.target.value as Provider, model: e.target.value === 'ollama' ? config.model : available.openrouter[0] ?? '' })}><option value="ollama">Host Ollama (local)</option><option value="openrouter" disabled={!available.configured}>OpenRouter (paid)</option></select></label><label>Model<input required list={assignments[role].provider === 'openrouter' ? 'openrouter-models' : undefined} value={assignments[role].model} onChange={e => update(role, { model: e.target.value })}/></label><label>Maximum output tokens<input type="number" min="1" max="4096" required value={assignments[role].maxOutputTokens} onChange={e => update(role, { maxOutputTokens: Number(e.target.value) })}/></label></div>)}</div>
      <datalist id="openrouter-models">{available.openrouter.map(model => <option key={model} value={model}/>)}</datalist>
      {paid && <label>Maximum OpenRouter spend (USD, this run)<input type="number" min="0.000000001" max="100" step="any" required value={cap} onChange={e => setCap(e.target.value)}/></label>}
      <button disabled={!assignments || !targetId || !caseId}>Start with assigned models</button>
    </form>
    <form onSubmit={e => void launchAdaptive(e)}><h3>Bounded adaptive exploration</h3><p className="hint">Choose authorized seed cases to set boundaries, checks, users and permitted attachments. The Red Team proposes up to three turns per case. No proposed action dispatches unless validated. Every selected category needs a seed case.</p>
      <div className="model-roles">{cases.map(c => <label key={c.id}><input type="checkbox" checked={selectedCases.includes(c.id)} onChange={e => setSelectedCases(current => e.target.checked ? [...current, c.id] : current.filter(id => id !== c.id))}/>{c.title} ({c.category ?? 'prompt_injection'})</label>)}</div>
      <label>Maximum cases<input type="number" min="1" max="9" required value={maxCases} onChange={e => setMaxCases(Number(e.target.value))}/></label>
      <label>Maximum elapsed minutes<input type="number" min="1" max="30" required value={maxMinutes} onChange={e => setMaxMinutes(Number(e.target.value))}/></label>
      <p className="hint">Provider/model settings, local endpoint and {paid ? `USD cap ${cap}` : 'local-only usage'} above apply to this exploration.</p>
      <button disabled={!assignments || !targetId || !selectedCases.length}>Start bounded exploration</button>
    </form>
    {actionError && <p role="alert">{actionError}</p>}
    {runId && !!runCategories && <div className="usage-ledger"><h3>Adaptive progress</h3>{progressError && <p role="alert">{progressError} <button type="button" onClick={() => void loadProgress()}>Retry progress</button></p>}{runCategories.map(category => <p key={category}>{category.replaceAll('_', ' ')}: {progress.filter(c => c.category === category).map(c => `case ${c.ordinal} ${c.state}${c.executed ? ' (executed)' : ' (not executed)'}`).join(' · ') || 'not tested / gap'}</p>)}
      {runStatus !== 'finished' && <button type="button" disabled={stopping} onClick={() => void requestStop()}>{stopping ? 'Stop requested' : 'Stop after in-flight work'}</button>}
      <p className="hint">A stop or time limit leaves the unfinished case incomplete; it never makes a pass.</p></div>}
    {runId && <div className="usage-ledger"><h3>Measured model usage</h3>{usageError && <p role="alert">{usageError} <button type="button" onClick={() => void loadUsage()}>Retry usage</button></p>}<p>Paid settled: {dollars(String(settled))} · Ollama: no dollar price assigned</p>{usage.length ? usage.map(call => <p key={call.id}>{call.role}: {call.provider} / {call.model} · {call.status} · {call.inputTokens ?? '?'} in / {call.outputTokens ?? '?'} out · {call.latencyMs ?? '?'} ms · {call.provider === 'ollama' ? 'local, unpriced' : call.status === 'settled' ? dollars(call.chargeNanos!) : `reserved ${dollars(call.reservedNanos)}; charge unresolved`}</p>) : <p>No model calls recorded yet.</p>}</div>}
  </section>;
}
