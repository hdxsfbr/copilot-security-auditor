import React, { useEffect, useRef, useState } from 'react';
import { isRecord, requestJson, requestOk } from './api/client.js';

type Role = 'orchestrator' | 'redTeam' | 'judge' | 'documentation';
type Assignment = { provider: 'ollama' | 'openrouter'; model: string; maxOutputTokens: number };
type Definition = { name: string; cadence: 'daily' | 'weekly'; weekday?: number; hour: number; minute: number; zone: string; run: { kind: 'selected' | 'adaptive'; input: Record<string, unknown> } };
type Schedule = { id: string; definition: Definition; nextFireAt: string; paused: boolean };
type Occurrence = { id: string; scheduledFor: string; runId: string | null; state: string; reason: string | null };
type Seed = { id: string; title: string; category?: string };
type ModelCatalog = { openrouter: string[]; ollama: string[]; configured: boolean };
type ModelConfig = { ollamaUrl: string; model: string };
const roles: Role[] = ['orchestrator', 'redTeam', 'judge', 'documentation'];
const isProvider = (value: unknown): value is Assignment['provider'] => value === 'ollama' || value === 'openrouter';
const isAssignment = (value: unknown): value is Assignment => isRecord(value) && isProvider(value.provider) && typeof value.model === 'string' && Number.isInteger(value.maxOutputTokens);
const isConfig = (value: unknown): value is ModelConfig => isRecord(value) && typeof value.ollamaUrl === 'string' && typeof value.model === 'string';
const isCatalog = (value: unknown): value is ModelCatalog => isRecord(value) && Array.isArray(value.openrouter) && value.openrouter.every(model => typeof model === 'string') && Array.isArray(value.ollama) && value.ollama.every(model => typeof model === 'string') && typeof value.configured === 'boolean';
const isDefinition = (value: unknown): value is Definition => isRecord(value) && typeof value.name === 'string' && (value.cadence === 'daily' || value.cadence === 'weekly') && Number.isInteger(value.hour) && Number.isInteger(value.minute) && typeof value.zone === 'string' && isRecord(value.run) && (value.run.kind === 'selected' || value.run.kind === 'adaptive') && isRecord(value.run.input);
const isSchedule = (value: unknown): value is Schedule => isRecord(value) && typeof value.id === 'string' && isDefinition(value.definition) && typeof value.nextFireAt === 'string' && Number.isFinite(Date.parse(value.nextFireAt)) && typeof value.paused === 'boolean';
const isScheduleList = (value: unknown): value is Schedule[] => Array.isArray(value) && value.every(isSchedule);
const isOccurrence = (value: unknown): value is Occurrence => isRecord(value) && typeof value.id === 'string' && typeof value.scheduledFor === 'string' && Number.isFinite(Date.parse(value.scheduledFor)) && (typeof value.runId === 'string' || value.runId === null) && typeof value.state === 'string' && (typeof value.reason === 'string' || value.reason === null);
const isOccurrenceList = (value: unknown): value is Occurrence[] => Array.isArray(value) && value.every(isOccurrence);
const isSavedSchedule = (value: unknown): value is { id: string; nextFireAt: string } => isRecord(value) && typeof value.id === 'string' && typeof value.nextFireAt === 'string' && Number.isFinite(Date.parse(value.nextFireAt));
const isRoleAssignments = (value: unknown): value is Record<Role, Assignment> => isRecord(value) && roles.every(role => isAssignment(value[role]));

function defaultAssignments(config: ModelConfig): Record<Role, Assignment> {
  return Object.fromEntries(roles.map(role => [role, { provider: 'ollama' as const, model: config.model, maxOutputTokens: 256 }])) as Record<Role, Assignment>;
}

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
  const [available, setAvailable] = useState<ModelCatalog>({ openrouter: [], ollama: [], configured: false });
  const [assignments, setAssignments] = useState<Record<Role, Assignment> | null>(null);
  const [cap, setCap] = useState('0.25');
  const [actionError, setActionError] = useState('');
  const [scheduleError, setScheduleError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [configError, setConfigError] = useState('');
  const [catalogError, setCatalogError] = useState('');
  const configEdited = useRef({ ollamaUrl: false });

  const refresh = async () => {
    try {
      const list = await requestJson('/schedules', isScheduleList);
      setSchedules(list);
      setScheduleError('');
      const entries = await Promise.all(list.map(async schedule => {
        try { return [schedule.id, await requestJson(`/schedules/${schedule.id}/occurrences`, isOccurrenceList)] as const; }
        catch { return [schedule.id, null] as const; }
      }));
      const failed = entries.some(([, occurrences]) => occurrences === null);
      setHistory(current => {
        const next = { ...current };
        for (const [id, occurrences] of entries) if (occurrences !== null) next[id] = occurrences;
        return next;
      });
      setHistoryError(failed ? 'Some occurrence history could not be refreshed; previously loaded history is retained.' : '');
    } catch (cause) {
      setScheduleError(cause instanceof Error ? cause.message : 'Schedules unavailable');
    }
  };
  const loadConfig = async () => {
    try {
      const config = await requestJson('/config', isConfig);
      if (!configEdited.current.ollamaUrl) setOllamaUrl(config.ollamaUrl);
      setLocalModel(current => current || config.model);
      setAssignments(current => current ?? defaultAssignments(config));
      setConfigError('');
    } catch (cause) { setConfigError(cause instanceof Error ? cause.message : 'Local model defaults unavailable'); }
  };
  const loadCatalog = async () => {
    try {
      setAvailable(await requestJson('/models', isCatalog));
      setCatalogError('');
    } catch (cause) { setCatalogError(cause instanceof Error ? cause.message : 'Model catalog unavailable'); }
  };

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 5000);
    void loadConfig();
    void loadCatalog();
    return () => clearInterval(timer);
  }, []);
  const edit = (schedule: Schedule) => {
    const d = schedule.definition, input = d.run.input;
    setEditing(schedule.id); setName(d.name); setCadence(d.cadence); setWeekday(d.weekday ?? 0); setHour(d.hour); setMinute(d.minute); setZone(d.zone); setKind(d.run.kind);
    setTargetId(String(input.targetId ?? '')); setCaseIds(d.run.kind === 'selected' ? [String(input.caseId ?? '')] : Array.isArray(input.caseIds) ? input.caseIds.filter((id): id is string => typeof id === 'string') : []);
    setOllamaUrl(String(input.ollamaUrl ?? '')); setAssignments(isRoleAssignments(input.roles) ? input.roles : assignments);
    setCap(String(input.openRouterCapUsd ?? '0.25')); setMaxCases(Number(input.maxCases ?? 3)); setMaxMinutes(Number(input.maxMinutes ?? 3));
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setActionError('');
    if (!assignments || !caseIds.length) return;
    const selected = cases.filter(c => caseIds.includes(c.id));
    const paid = roles.some(role => assignments[role].provider === 'openrouter');
    const shared = { targetId, ollamaUrl, roles: assignments, ...(paid ? { openRouterCapUsd: Number(cap) } : {}) };
    const input = kind === 'selected' ? { ...shared, caseId: caseIds[0] } : { ...shared, caseIds, categories: [...new Set(selected.map(c => c.category ?? 'prompt_injection'))], maxCases, maxMinutes };
    try {
      await requestJson(editing ? `/schedules/${editing}` : '/schedules', isSavedSchedule, { method: editing ? 'PUT' : 'POST', body: JSON.stringify({ name, cadence, ...(cadence === 'weekly' ? { weekday } : {}), hour, minute, zone, run: { kind, input } }) });
      setEditing(''); await refresh();
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : 'Could not save schedule'); }
  };
  const change = async (id: string, method: 'PATCH' | 'DELETE', paused?: boolean) => {
    setActionError('');
    try {
      await requestOk(`/schedules/${id}`, { method, ...(method === 'PATCH' ? { body: JSON.stringify({ paused }) } : {}) });
      await refresh();
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : 'Schedule update failed'); }
  };

  const paid = !!assignments && roles.some(role => assignments[role].provider === 'openrouter');
  return <section className="panel schedule-desk"><h2><span>04</span> Scheduled evaluations</h2><p className="hint">Daily or weekly local wall time. A busy target skips that occurrence; a failed chart/login blocks it. History is retained when paused or removed.</p>
    {scheduleError && <div className="alert" role="alert">Schedules unavailable: {scheduleError} <button type="button" onClick={() => void refresh()}>Retry schedules</button></div>}
    {historyError && <p role="alert">{historyError} <button type="button" onClick={() => void refresh()}>Retry history</button></p>}
    {configError && <div className="alert" role="alert">Local model defaults unavailable: {configError} <button type="button" onClick={() => void loadConfig()}>Retry defaults</button></div>}
    {catalogError && <div className="alert" role="alert">OpenRouter catalog unavailable; local schedules remain available. {catalogError} <button type="button" onClick={() => void loadCatalog()}>Retry model catalog</button></div>}
    {actionError && <p role="alert">{actionError}</p>}
    <form onSubmit={e => void submit(e)}><h3>{editing ? 'Edit schedule' : 'New schedule'}</h3>
      <label>Schedule name<input required value={name} onChange={e => setName(e.target.value)}/></label>
      <label>Saved target<select required value={targetId} onChange={e => setTargetId(e.target.value)}><option value="">Select target</option>{targets.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
      <label>Evaluation type<select value={kind} onChange={e => { setKind(e.target.value as typeof kind); setCaseIds([]); }}><option value="selected">Single case</option><option value="adaptive">Bounded adaptive</option></select></label>
      {kind === 'selected' ? <label>Scheduled case<select required value={caseIds[0] ?? ''} onChange={e => setCaseIds([e.target.value])}><option value="">Select case</option>{cases.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label> : <div className="model-roles"><p>Adaptive seed cases</p>{cases.map(c => <label key={c.id}><input type="checkbox" checked={caseIds.includes(c.id)} onChange={e => setCaseIds(ids => e.target.checked ? [...ids, c.id] : ids.filter(id => id !== c.id))}/>{c.title} ({c.category ?? 'prompt_injection'})</label>)}</div>}
      {kind === 'adaptive' && <><label>Maximum cases<input type="number" min="1" max="9" value={maxCases} onChange={e => setMaxCases(Number(e.target.value))}/></label><label>Maximum minutes<input type="number" min="1" max="30" value={maxMinutes} onChange={e => setMaxMinutes(Number(e.target.value))}/></label></>}
      <label>Cadence<select value={cadence} onChange={e => setCadence(e.target.value as typeof cadence)}><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label>
      {cadence === 'weekly' && <label>Weekday<select value={weekday} onChange={e => setWeekday(Number(e.target.value))}>{['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((day, i) => <option value={i} key={day}>{day}</option>)}</select></label>}
      <label>Local hour (0–23)<input type="number" min="0" max="23" value={hour} onChange={e => setHour(Number(e.target.value))}/></label><label>Local minute<input type="number" min="0" max="59" value={minute} onChange={e => setMinute(Number(e.target.value))}/></label><label>IANA time zone<input required value={zone} onChange={e => setZone(e.target.value)}/></label>
      <label>Local model server URL<input type="url" required value={ollamaUrl} onChange={e => { configEdited.current.ollamaUrl = true; setOllamaUrl(e.target.value); }}/></label>
      <div className="model-roles">{assignments && roles.map(role => <div className="review-item" key={role}><strong>{role}</strong><label>Provider<select value={assignments[role].provider} onChange={e => setAssignments(current => current && ({ ...current, [role]: { ...current[role], provider: e.target.value as Assignment['provider'], model: e.target.value === 'ollama' ? localModel : available.openrouter[0] ?? '' } }))}><option value="ollama">Host Ollama</option><option value="openrouter" disabled={!available.configured}>OpenRouter</option></select></label><label>Model<input required value={assignments[role].model} onChange={e => setAssignments(current => current && ({ ...current, [role]: { ...current[role], model: e.target.value } }))}/></label><label>Maximum output tokens<input type="number" required min="1" max="4096" value={assignments[role].maxOutputTokens} onChange={e => setAssignments(current => current && ({ ...current, [role]: { ...current[role], maxOutputTokens: Number(e.target.value) } }))}/></label></div>)}</div>
      {paid && <label>Maximum OpenRouter spend per occurrence (USD)<input type="number" min="0.000000001" max="100" step="any" required value={cap} onChange={e => setCap(e.target.value)}/></label>}
      <button disabled={!targetId || !caseIds.length || !assignments}>{editing ? 'Update schedule' : 'Create schedule'}</button>{editing && <button type="button" onClick={() => setEditing('')}>Cancel edit</button>}
    </form>
    <div className="review-grid">{schedules.map(schedule => <article className="review-item" key={schedule.id}><strong>{schedule.definition.name}</strong><p>{schedule.paused ? 'Paused' : 'Active'} · next {new Date(schedule.nextFireAt).toLocaleString()} · {schedule.definition.zone}</p><button onClick={() => edit(schedule)}>Edit</button><button onClick={() => void change(schedule.id, 'PATCH', !schedule.paused)}>{schedule.paused ? 'Resume' : 'Pause'}</button><button onClick={() => void change(schedule.id, 'DELETE')}>Remove</button><h3>Occurrences</h3>{history[schedule.id]?.length ? history[schedule.id].map(o => <p key={o.id}>{new Date(o.scheduledFor).toLocaleString()} · {o.state}{o.reason ? ` · ${o.reason}` : ''} {o.runId && <button onClick={() => onInspect(o.runId!)}>Inspect run</button>}</p>) : <p>No occurrences yet.</p>}</article>)}</div>
  </section>;
}
