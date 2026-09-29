import React, { useEffect, useState } from 'react';

type Provider = 'ollama' | 'openrouter';
type Assignment = { provider: Provider; model: string; maxOutputTokens: number };
type Role = 'orchestrator' | 'redTeam' | 'judge' | 'documentation';
const roles: Role[] = ['orchestrator', 'redTeam', 'judge', 'documentation'];
type Usage = { id: string; role: Role; provider: Provider; model: string; status: string; inputTokens: number | null; outputTokens: number | null; latencyMs: number | null; chargeNanos: string | null; reservedNanos: string };
const dollars = (nanos: string) => `$${(Number(nanos) / 1e9).toFixed(9).replace(/(\.\d{6})0+$/, '$1')}`;

export function ModelDesk({ targetId, caseId, runId, onStart }: { targetId: string; caseId: string; runId?: string; onStart: (id: string) => void }) {
  const [config, setConfig] = useState({ model: '', ollamaUrl: '' });
  const [available, setAvailable] = useState<{ openrouter: string[]; configured: boolean }>({ openrouter: [], configured: false });
  const [assignments, setAssignments] = useState<Record<Role, Assignment> | null>(null);
  const [cap, setCap] = useState('0.25');
  const [usage, setUsage] = useState<Usage[]>([]);
  const [error, setError] = useState('');
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
  const paid = !!assignments && roles.some(role => assignments[role].provider === 'openrouter');
  const settled = usage.filter(call => call.provider === 'openrouter' && call.status === 'settled').reduce((total, call) => total + Number(call.chargeNanos ?? 0), 0);
  return <section className="panel model-desk"><h2><span>03</span> Role models & spend</h2><p className="hint">Choose each role independently. Selected-case runs invoke only the Judge; other assignments are saved for future workflows. Hosted calls receive pseudonymized observations. The paid cap is enforced before dispatch, per run.</p>
    <form onSubmit={e => void launch(e)}>
      <label>Local model server URL<input type="url" required value={config.ollamaUrl} onChange={e => setConfig({ ...config, ollamaUrl: e.target.value })}/></label>
      <div className="model-roles">{assignments && roles.map(role => <div key={role} className="review-item"><strong>{role === 'redTeam' ? 'Red Team' : role}</strong><label>Provider<select value={assignments[role].provider} onChange={e => update(role, { provider: e.target.value as Provider, model: e.target.value === 'ollama' ? config.model : available.openrouter[0] ?? '' })}><option value="ollama">Host Ollama (local)</option><option value="openrouter" disabled={!available.configured}>OpenRouter (paid)</option></select></label><label>Model<input required list={assignments[role].provider === 'openrouter' ? 'openrouter-models' : undefined} value={assignments[role].model} onChange={e => update(role, { model: e.target.value })}/></label><label>Maximum output tokens<input type="number" min="1" max="4096" required value={assignments[role].maxOutputTokens} onChange={e => update(role, { maxOutputTokens: Number(e.target.value) })}/></label></div>)}</div>
      <datalist id="openrouter-models">{available.openrouter.map(model => <option key={model} value={model}/>)}</datalist>
      {paid && <label>Maximum OpenRouter spend (USD, this run)<input type="number" min="0.000000001" max="100" step="any" required value={cap} onChange={e => setCap(e.target.value)}/></label>}
      <button disabled={!assignments || !targetId || !caseId}>Start with assigned models</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {runId && <div className="usage-ledger"><h3>Measured model usage</h3><p>Paid settled: {dollars(String(settled))} · Ollama: no dollar price assigned</p>{usage.length ? usage.map(call => <p key={call.id}>{call.role}: {call.provider} / {call.model} · {call.status} · {call.inputTokens ?? '?'} in / {call.outputTokens ?? '?'} out · {call.latencyMs ?? '?'} ms · {call.provider === 'ollama' ? 'local, unpriced' : call.status === 'settled' ? dollars(call.chargeNanos!) : `reserved ${dollars(call.reservedNanos)}; charge unresolved`}</p>) : <p>No model calls recorded yet.</p>}</div>}
  </section>;
}
