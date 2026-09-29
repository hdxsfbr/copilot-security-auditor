import React, { useEffect, useState } from 'react';

type Role = 'orchestrator' | 'redTeam' | 'judge' | 'documentation';
type Assignment = { provider: 'ollama' | 'openrouter'; model: string; maxOutputTokens: number };
type Definition = { name: string; cadence: 'daily' | 'weekly'; weekday?: number; hour: number; minute: number; zone: string; run: { kind: 'selected' | 'adaptive'; input: Record<string, unknown> } };
type Schedule = { id: string; definition: Definition; nextFireAt: string; paused: boolean };
type Occurrence = { id: string; scheduledFor: string; runId: string | null; state: string; reason: string | null };
type Seed = { id: string; title: string; category?: string };
const roles: Role[] = ['orchestrator', 'redTeam', 'judge', 'documentation'];

export function ScheduleDesk({ targets, cases, onInspect }: { targets: { id: string; name: string }[]; cases: Seed[]; onInspect: (id: string) => void }) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [history, setHistory] = useState<Record<string, Occurrence[]>>({});
  const [editing, setEditing] = useState('');
  const [name, setName] = useState('Daily synthetic evaluation');
  const [targetId, setTargetId] = useState('');
  const [caseIds, setCaseIds] = useState<string[]>([]);
  const [kind, setKind] = useState<'selected' | 'adaptive'>('selected');
  const [cadence, setCadence] = useState<'daily' | 'weekly'>('daily');
  const [weekday, setWeekday] = useState(new Date().getDay());
  const [hour, setHour] = useState(9), [minute, setMinute] = useState(0);
  const [zone, setZone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [maxCases, setMaxCases] = useState(3), [maxMinutes, setMaxMinutes] = useState(3);
  const [ollamaUrl, setOllamaUrl] = useState('');
  const [localModel, setLocalModel] = useState('');
  const [available, setAvailable] = useState<{ openrouter: string[]; configured: boolean }>({ openrouter: [], configured: false });
  const [assignments, setAssignments] = useState<Record<Role, Assignment> | null>(null);
  const [cap, setCap] = useState('0.25');
  const [error, setError] = useState('');
  const refresh = async () => {
    const response = await fetch('/api/schedules');
    if (!response.ok) throw new Error('Schedules unavailable');
    const list = await response.json() as Schedule[];
    setSchedules(list);
    const entries = await Promise.all(list.map(async schedule => {
      const result = await fetch(`/api/schedules/${schedule.id}/occurrences`);
      return [schedule.id, result.ok ? await result.json() : []] as const;
    }));
    setHistory(Object.fromEntries(entries));
  };
  useEffect(() => {
    void refresh().catch(() => setError('Schedules unavailable'));
    const timer = setInterval(() => { void refresh().catch(() => setError('Schedule history unavailable')); }, 5000);
    void fetch('/api/config').then(r => r.json()).then((config: { ollamaUrl: string; model: string }) => {
      setOllamaUrl(config.ollamaUrl); setLocalModel(config.model);
      const local: Assignment = { provider: 'ollama', model: config.model, maxOutputTokens: 256 };
      setAssignments({ orchestrator: local, redTeam: local, judge: local, documentation: local });
    }).catch(() => setError('Local model defaults unavailable'));
    void fetch('/api/models').then(r => r.json()).then(setAvailable).catch(() => {});
    return () => clearInterval(timer);
  }, []);
  const edit = (schedule: Schedule) => {
    const d = schedule.definition, input = d.run.input;
    setEditing(schedule.id); setName(d.name); setCadence(d.cadence); setWeekday(d.weekday ?? 0); setHour(d.hour); setMinute(d.minute); setZone(d.zone); setKind(d.run.kind);
    setTargetId(String(input.targetId ?? '')); setCaseIds(d.run.kind === 'selected' ? [String(input.caseId ?? '')] : input.caseIds as string[] ?? []);
    setOllamaUrl(String(input.ollamaUrl ?? '')); setAssignments(input.roles as Record<Role, Assignment> ?? assignments);
    setCap(String(input.openRouterCapUsd ?? '0.25')); setMaxCases(Number(input.maxCases ?? 3)); setMaxMinutes(Number(input.maxMinutes ?? 3));
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setError('');
    if (!assignments || !caseIds.length) return;
    const selected = cases.filter(c => caseIds.includes(c.id));
    const paid = roles.some(role => assignments[role].provider === 'openrouter');
    const shared = { targetId, ollamaUrl, roles: assignments, ...(paid ? { openRouterCapUsd: Number(cap) } : {}) };
    const input = kind === 'selected' ? { ...shared, caseId: caseIds[0] } : { ...shared, caseIds, categories: [...new Set(selected.map(c => c.category ?? 'prompt_injection'))], maxCases, maxMinutes };
    try {
      const response = await fetch(editing ? `/api/schedules/${editing}` : '/api/schedules', { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, cadence, ...(cadence === 'weekly' ? { weekday } : {}), hour, minute, zone, run: { kind, input } }) });
      if (!response.ok) throw new Error((await response.json()).message ?? 'Schedule invalid');
      setEditing(''); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save schedule'); }
  };
  const change = async (id: string, method: 'PATCH' | 'DELETE', paused?: boolean) => {
    setError('');
    try {
      const result = await fetch(`/api/schedules/${id}`, { method, ...(method === 'PATCH' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paused }) } : {}) });
      if (!result.ok) throw new Error('Schedule update failed');
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Schedule update failed'); }
  };
  const paid = !!assignments && roles.some(role => assignments[role].provider === 'openrouter');
  return <section className="panel schedule-desk"><h2><span>04</span> Scheduled evaluations</h2><p className="hint">Daily or weekly local wall time. A busy target skips that occurrence; a failed chart/login blocks it. History is retained when paused or removed.</p>
    <form onSubmit={e => void submit(e)}><h3>{editing ? 'Edit schedule' : 'New schedule'}</h3>
      <label>Schedule name<input required value={name} onChange={e => setName(e.target.value)}/></label>
      <label>Saved target<select required value={targetId} onChange={e => setTargetId(e.target.value)}><option value="">Select target</option>{targets.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
      <label>Evaluation type<select value={kind} onChange={e => { setKind(e.target.value as typeof kind); setCaseIds([]); }}><option value="selected">Single case</option><option value="adaptive">Bounded adaptive</option></select></label>
      {kind === 'selected' ? <label>Scheduled case<select required value={caseIds[0] ?? ''} onChange={e => setCaseIds([e.target.value])}><option value="">Select case</option>{cases.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label> : <div className="model-roles"><p>Adaptive seed cases</p>{cases.map(c => <label key={c.id}><input type="checkbox" checked={caseIds.includes(c.id)} onChange={e => setCaseIds(ids => e.target.checked ? [...ids, c.id] : ids.filter(id => id !== c.id))}/>{c.title} ({c.category ?? 'prompt_injection'})</label>)}</div>}
      {kind === 'adaptive' && <><label>Maximum cases<input type="number" min="1" max="9" value={maxCases} onChange={e => setMaxCases(Number(e.target.value))}/></label><label>Maximum minutes<input type="number" min="1" max="30" value={maxMinutes} onChange={e => setMaxMinutes(Number(e.target.value))}/></label></>}
      <label>Cadence<select value={cadence} onChange={e => setCadence(e.target.value as typeof cadence)}><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label>
      {cadence === 'weekly' && <label>Weekday<select value={weekday} onChange={e => setWeekday(Number(e.target.value))}>{['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((day, i) => <option value={i} key={day}>{day}</option>)}</select></label>}
      <label>Local hour (0–23)<input type="number" min="0" max="23" value={hour} onChange={e => setHour(Number(e.target.value))}/></label><label>Local minute<input type="number" min="0" max="59" value={minute} onChange={e => setMinute(Number(e.target.value))}/></label><label>IANA time zone<input required value={zone} onChange={e => setZone(e.target.value)}/></label>
      <label>Local model server URL<input type="url" required value={ollamaUrl} onChange={e => setOllamaUrl(e.target.value)}/></label>
      <div className="model-roles">{assignments && roles.map(role => <div className="review-item" key={role}><strong>{role}</strong><label>Provider<select value={assignments[role].provider} onChange={e => setAssignments(current => current && ({ ...current, [role]: { ...current[role], provider: e.target.value as Assignment['provider'], model: e.target.value === 'ollama' ? localModel : available.openrouter[0] ?? '' } }))}><option value="ollama">Host Ollama</option><option value="openrouter" disabled={!available.configured}>OpenRouter</option></select></label><label>Model<input required value={assignments[role].model} onChange={e => setAssignments(current => current && ({ ...current, [role]: { ...current[role], model: e.target.value } }))}/></label><label>Maximum output tokens<input type="number" required min="1" max="4096" value={assignments[role].maxOutputTokens} onChange={e => setAssignments(current => current && ({ ...current, [role]: { ...current[role], maxOutputTokens: Number(e.target.value) } }))}/></label></div>)}</div>
      {paid && <label>Maximum OpenRouter spend per occurrence (USD)<input type="number" min="0.000000001" max="100" step="any" required value={cap} onChange={e => setCap(e.target.value)}/></label>}
      <button disabled={!targetId || !caseIds.length || !assignments}>{editing ? 'Update schedule' : 'Create schedule'}</button>{editing && <button type="button" onClick={() => setEditing('')}>Cancel edit</button>}
    </form>{error && <p role="alert">{error}</p>}
    <div className="review-grid">{schedules.map(schedule => <article className="review-item" key={schedule.id}><strong>{schedule.definition.name}</strong><p>{schedule.paused ? 'Paused' : 'Active'} · next {new Date(schedule.nextFireAt).toLocaleString()} · {schedule.definition.zone}</p><button onClick={() => edit(schedule)}>Edit</button><button onClick={() => void change(schedule.id, 'PATCH', !schedule.paused)}>{schedule.paused ? 'Resume' : 'Pause'}</button><button onClick={() => void change(schedule.id, 'DELETE')}>Remove</button><h3>Occurrences</h3>{history[schedule.id]?.length ? history[schedule.id].map(o => <p key={o.id}>{new Date(o.scheduledFor).toLocaleString()} · {o.state}{o.reason ? ` · ${o.reason}` : ''} {o.runId && <button onClick={() => onInspect(o.runId!)}>Inspect run</button>}</p>) : <p>No occurrences yet.</p>}</article>)}</div>
  </section>;
}
