import React, { useEffect, useState } from 'react';
import { ApiResponseError, requestJson } from '../../api/client.js';
import type { Definition as SavedDefinition } from '../models/definitions.js';
import { RouteLink } from '../router.js';
import { RunSummary } from './RunSummary.js';
import { isSavedSchedule, type Schedule } from './model.js';
import { browserEquivalent, browserZone, inZone, validZone, wallTime, weekdays, zoneNames } from './zone.js';

type Named = { id: string; name: string };
type Seed = { id: string; title: string; category?: string };
export type Saved = { id: string; nextFireAt: string; name: string; zone: string; edited: boolean };
const clock = (hour: number, minute: number) => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

/** Create or edit a schedule from a saved run definition revision: pick it, review its summary, then set cadence and zone. */
export function ScheduleForm({ definitions, targets, cases, editing, navigate, onSaved, onCancel, onReload }: {
  definitions: SavedDefinition[]; targets: Named[]; cases: Seed[]; editing: Schedule | null; navigate: (path: string) => void;
  onSaved: (saved: Saved) => void; onCancel: () => void; onReload: () => void;
}) {
  const edit = editing?.definition;
  const linked = definitions.find(item => item.id === editing?.source?.runDefinitionId);
  const [definitionId, setDefinitionId] = useState(linked?.id ?? '');
  const [name, setName] = useState(edit?.name ?? '');
  const [cadence, setCadence] = useState<'daily' | 'weekly'>(edit?.cadence ?? 'daily');
  const [weekday, setWeekday] = useState(edit?.weekday ?? 1);
  const [time, setTime] = useState(edit ? clock(edit.hour, edit.minute) : '09:00');
  const [zone, setZone] = useState(edit?.zone ?? browserZone());
  const [busy, setBusy] = useState(false), [error, setError] = useState<{ message: string; stale: boolean } | null>(null);
  useEffect(() => { if (linked) setDefinitionId(current => current || linked.id); }, [linked?.id]); // definitions may arrive after Edit opens
  const chosen = definitions.find(item => item.id === definitionId);
  const ok = validZone(zone), now = new Date().toISOString(), here = ok ? browserEquivalent(now, zone) : null;
  const seedIds = !chosen ? [] : chosen.run.kind === 'selected' ? [chosen.run.input.caseId] : chosen.run.input.caseIds;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!chosen || !ok || busy) return;
    const [hour, minute] = time.split(':').map(Number);
    setBusy(true); setError(null);
    try {
      const body = { name: name.trim() || chosen.name, cadence, ...(cadence === 'weekly' ? { weekday } : {}), hour, minute, zone: zone.trim(), runDefinitionId: chosen.id, revision: chosen.revision };
      const saved = await requestJson(editing ? `/schedules/${editing.id}` : '/schedules', isSavedSchedule, { method: editing ? 'PUT' : 'POST', body: JSON.stringify(body) });
      onSaved({ ...saved, name: body.name, zone: body.zone, edited: !!editing });
    } catch (cause) { setError({ message: cause instanceof Error ? cause.message : 'Could not save schedule', stale: cause instanceof ApiResponseError && cause.status === 409 }); }
    finally { setBusy(false); }
  };
  return <form className="schedule-form" onSubmit={event => void submit(event)} aria-label={editing ? 'Edit schedule' : 'New schedule'}>
    <h3>{editing ? `Edit schedule: ${editing.definition.name}` : 'New schedule'}</h3>
    {editing && !linked && <p className="hint" role="status">{editing.source ? 'The saved definition this schedule used is archived or unavailable.' : 'This schedule was created with inline settings.'} Choose a saved definition to replace its run settings, or cancel.</p>}
    <fieldset disabled={busy}>
      <div className="pair">
        <label>Saved run definition<select required value={definitionId} onChange={event => { setDefinitionId(event.target.value); setError(null); }}>
          <option value="">Select a saved definition</option>
          {definitions.map(item => <option key={item.id} value={item.id}>{item.name} · revision {item.revision}</option>)}
        </select></label>
        <label>Schedule name<input maxLength={120} value={name} placeholder={chosen?.name ?? 'Defaults to the definition name'} onChange={event => setName(event.target.value)}/></label>
      </div>
      {!definitions.length && <p className="hint">No saved run definitions yet. <RouteLink href="/runs/new" navigate={navigate}>Compose and save a run</RouteLink>, then return here.</p>}
      {chosen && <div className="schedule-chosen"><h4>Run settings from {chosen.name} (revision {chosen.revision})</h4>
        <RunSummary run={chosen.run} target={{ id: chosen.run.input.targetId, name: targets.find(item => item.id === chosen.run.input.targetId)?.name ?? null }}
          cases={seedIds.map(id => { const seed = cases.find(item => item.id === id); return { id, title: seed?.title ?? null, category: seed?.category ?? 'prompt_injection' }; })}/>
        <p className="hint">The schedule stores a snapshot of this revision. Later edits to the definition do not change it until you edit the schedule.</p></div>}
      <div className="pair">
        <label>Cadence<select value={cadence} onChange={event => setCadence(event.target.value as typeof cadence)}><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label>
        {cadence === 'weekly' && <label>Weekday<select value={weekday} onChange={event => setWeekday(Number(event.target.value))}>{weekdays.map((day, index) => <option value={index} key={day}>{day}</option>)}</select></label>}
      </div>
      <div className="pair">
        <label>Time of day (in the schedule zone)<input type="time" required value={time} onChange={event => setTime(event.target.value)}/></label>
        <label>IANA time zone<input required list="schedule-zones" value={zone} aria-invalid={!ok} onChange={event => setZone(event.target.value)}/><datalist id="schedule-zones">{zoneNames().map(item => <option key={item} value={item}/>)}</datalist></label>
      </div>
      <p className="hint" role="status">{ok ? <>Runs {cadence === 'weekly' ? `every ${weekdays[weekday]}` : 'every day'} at {wallTime(Number(time.slice(0, 2)), Number(time.slice(3, 5)), zone.trim(), now)}; the wall time follows daylight saving. It is now {inZone(now, zone.trim())}.{here && ` ${here}.`}</> : 'Enter a valid IANA time zone, for example America/Chicago.'}</p>
    </fieldset>
    {error && <div role="alert" className="alert"><p>{error.message}</p>{error.stale && <button type="button" onClick={onReload}>Reload saved definitions</button>}</div>}
    <div className="schedule-actions">
      <button className="primary" disabled={!chosen || !ok || busy}>{busy ? 'Saving…' : editing ? 'Update schedule' : 'Create schedule'}</button>
      {editing && <button type="button" disabled={busy} onClick={onCancel}>Cancel edit</button>}
    </div>
  </form>;
}
