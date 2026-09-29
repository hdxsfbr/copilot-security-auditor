import React, { useEffect, useState } from 'react';

type Provider = 'ollama' | 'openrouter';
type Assignment = { provider: Provider; model: string; maxOutputTokens: number };
type Role = 'orchestrator' | 'redTeam' | 'judge' | 'documentation';
const roles: Role[] = ['orchestrator', 'redTeam', 'judge', 'documentation'];
type Usage = { id: string; role: Role; provider: Provider; model: string; status: string; inputTokens: number | null; outputTokens: number | null; latencyMs: number | null; chargeNanos: string | null; reservedNanos: string };
type Seed = { id: string; title: string; category?: string };
type AdaptiveCase = { id: string; ordinal: number; category: string; state: string; executed: boolean; reason?: string };
const dollars = (nanos: string) => `$${(Number(nanos) / 1e9).toFixed(9).replace(/(\.\d{6})0+$/, '$1')}`;

export function ModelDesk({ targetId, caseId, cases, runId, runCategories, runStatus, onStart }: { targetId: string; caseId: string; cases: Seed[]; runId?: string; runCategories?: string[] | null; runStatus?: string; onStart: (id: string) => void }) {
  const [config, setConfig] = useState({ model: '', ollamaUrl: '' });
  const [available, setAvailable] = useState<{ openrouter: string[]; configured: boolean }>({ openrouter: [], configured: false });
  const [assignments, setAssignments] = useState<Record<Role, Assignment> | null>(null);
  const [cap, setCap] = useState('0.25');
  const [usage, setUsage] = useState<Usage[]>([]);
  const [error, setError] = useState('');
  const [selectedCases, setSelectedCases] = useState<string[]>([]);
  const [maxCases, setMaxCases] = useState(3);
  const [maxMinutes, setMaxMinutes] = useState(3);
  const [progress, setProgress] = useState<AdaptiveCase[]>([]);
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    void fetch('/api/config').then(r => r.json()).then((value: { model: string; ollamaUrl: string }) => {
      setConfig(value);
      const entry: Assignment = { provider: 'ollama', model: value.model, maxOutputTokens: 1024 };
      setAssignments({ orchestrator: entry, redTeam: entry, judge: entry, documentation: entry });
    }).catch(() => setError('Model defaults unavailable'));
    void fetch('/api/models').then(r => r.json()).then(setAvailable).catch(() => setError('Model catalog unavailable; Ollama-only runs remain available'));
  }, []);
  useEffect(() => {
    if (!runId) return;
    const poll = () => { void fetch(`/api/runs/${runId}/usage`).then(r => r.json()).then(setUsage).catch(() => setError('Usage ledger unavailable')); };
    poll(); const timer = setInterval(poll, 1500); return () => clearInterval(timer);
  }, [runId]);
  useEffect(() => {
    if (!runId) return;
    const poll = () => { void fetch(`/api/runs/${runId}/cases`).then(r => r.json()).then(setProgress).catch(() => setError('Adaptive progress unavailable')); };
    poll(); const timer = setInterval(poll, 1500); return () => clearInterval(timer);
  }, [runId]);
  const update = (role: Role, next: Partial<Assignment>) => setAssignments(current => current && ({ ...current, [role]: { ...current[role], ...next } }));
  const launch = async (event: React.FormEvent) => {
    event.preventDefault(); setError('');
    if (!assignments) return;
    const paid = roles.some(role => assignments[role].provider === 'openrouter');
    try {
      const response = await fetch('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetId, caseId, ollamaUrl: config.ollamaUrl, roles: assignments, ...(paid ? { openRouterCapUsd: Number(cap) } : {}) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? 'Could not start run');
      setUsage([]); onStart(result.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start run'); }
  };
  const launchAdaptive = async (event: React.FormEvent) => {
    event.preventDefault(); setError('');
    if (!assignments) return;
    const chosen = cases.filter(c => selectedCases.includes(c.id));
    if (!chosen.length) { setError('Select at least one seed case'); return; }
    try {
      const response = await fetch('/api/adaptive-runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetId, caseIds: chosen.map(c => c.id), categories: [...new Set(chosen.map(c => c.category ?? 'prompt_injection'))], maxCases, maxMinutes, ollamaUrl: config.ollamaUrl, roles: assignments, ...(paid ? { openRouterCapUsd: Number(cap) } : {}) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? 'Could not start exploration');
      setProgress([]); setUsage([]); setStopping(false); onStart(result.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start exploration'); }
  };
  const paid = !!assignments && roles.some(role => assignments[role].provider === 'openrouter');
  const settled = usage.filter(call => call.provider === 'openrouter' && call.status === 'settled').reduce((total, call) => total + Number(call.chargeNanos ?? 0), 0);
  return <section className="panel model-desk"><h2><span>03</span> Role models & spend</h2><p className="hint">Choose each role independently. Selected-case runs invoke only the Judge; adaptive runs invoke Orchestrator, Red Team and Judge. Hosted calls receive pseudonymized observations. The paid cap is enforced before dispatch, per run.</p>
    <form onSubmit={e => void launch(e)}>
      <label>Local model server URL<input type="url" required value={config.ollamaUrl} onChange={e => setConfig({ ...config, ollamaUrl: e.target.value })}/></label>
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
    {runId && !!runCategories && <div className="usage-ledger"><h3>Adaptive progress</h3>{runCategories.map(category => <p key={category}>{category.replaceAll('_', ' ')}: {progress.filter(c => c.category === category).map(c => `case ${c.ordinal} ${c.state}${c.executed ? ' (executed)' : ' (not executed)'}`).join(' · ') || 'not tested / gap'}</p>)}
      {runStatus !== 'finished' && <button type="button" disabled={stopping} onClick={() => { void fetch(`/api/runs/${runId}/stop`, { method: 'POST' }).then(r => { if (!r.ok) throw Error('Stop failed'); setStopping(true); }).catch(() => setError('Stop request failed')); }}>{stopping ? 'Stop requested' : 'Stop after in-flight work'}</button>}
      <p className="hint">A stop or time limit leaves the unfinished case incomplete; it never makes a pass.</p></div>}
    {error && <p role="alert">{error}</p>}
    {runId && <div className="usage-ledger"><h3>Measured model usage</h3><p>Paid settled: {dollars(String(settled))} · Ollama: no dollar price assigned</p>{usage.length ? usage.map(call => <p key={call.id}>{call.role}: {call.provider} / {call.model} · {call.status} · {call.inputTokens ?? '?'} in / {call.outputTokens ?? '?'} out · {call.latencyMs ?? '?'} ms · {call.provider === 'ollama' ? 'local, unpriced' : call.status === 'settled' ? dollars(call.chargeNanos!) : `reserved ${dollars(call.reservedNanos)}; charge unresolved`}</p>) : <p>No model calls recorded yet.</p>}</div>}
  </section>;
}
