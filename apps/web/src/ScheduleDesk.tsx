import React, { useEffect, useRef, useState } from 'react';
import { requestJson, requestOk } from './api/client.js';
import { isDefinition, type Definition } from './components/models/definitions.js';
import { ScheduleCard } from './components/schedules/ScheduleCard.js';
import { ScheduleForm, type Saved } from './components/schedules/ScheduleForm.js';
import { isScheduleList, type Schedule } from './components/schedules/model.js';
import { browserEquivalent, inZone } from './components/schedules/zone.js';
import './components/schedules/schedules.css';

const isDefinitions = (value: unknown): value is Definition[] => Array.isArray(value) && value.every(isDefinition);
const ARCHIVE_LIMIT = 200; // mirrors the API bound on the archived list
const reason = (cause: unknown, fallback: string) => cause instanceof Error ? cause.message : fallback;

/** Definition-based scheduling: create from a saved run definition, operate active schedules, and inspect archived ones and their occurrences. */
export function ScheduleDesk({ active, targets, cases, navigate }: { active: boolean; targets: { id: string; name: string }[]; cases: { id: string; title: string; category?: string }[]; navigate: (path: string) => void }) {
  const [schedules, setSchedules] = useState<Schedule[] | null>(null), [archived, setArchived] = useState<Schedule[] | null>(null);
  const [definitions, setDefinitions] = useState<Definition[]>([]);
  const [editing, setEditing] = useState<Schedule | null>(null), [created, setCreated] = useState(0);
  const [notice, setNotice] = useState(''), [actionError, setActionError] = useState('');
  const [scheduleError, setScheduleError] = useState(''), [archiveError, setArchiveError] = useState(''), [definitionsError, setDefinitionsError] = useState('');
  const archiveOpen = useRef(false), formRef = useRef<HTMLDivElement>(null);

  const refresh = async () => {
    try { setSchedules(await requestJson('/schedules', isScheduleList)); setScheduleError(''); }
    catch (cause) { setScheduleError(reason(cause, 'Schedules unavailable')); }
  };
  const loadArchived = async () => {
    try { setArchived(await requestJson('/schedules/archived', isScheduleList)); setArchiveError(''); }
    catch (cause) { setArchiveError(reason(cause, 'Archived schedules unavailable')); }
  };
  const loadDefinitions = async () => {
    try { setDefinitions(await requestJson('/run-definitions', isDefinitions)); setDefinitionsError(''); }
    catch (cause) { setDefinitionsError(reason(cause, 'Saved run definitions unavailable')); }
  };
  useEffect(() => {
    if (!active) return;
    void refresh(); void loadDefinitions(); if (archiveOpen.current) void loadArchived();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
    return () => clearInterval(timer);
  }, [active]);
  useEffect(() => { if (editing) formRef.current?.scrollIntoView({ block: 'start' }); }, [editing]);

  const saved = (result: Saved) => {
    const local = browserEquivalent(result.nextFireAt, result.zone);
    setNotice(`${result.edited ? 'Updated' : 'Created'} schedule "${result.name}". Next run: ${inZone(result.nextFireAt, result.zone)}.${local ? ` ${local}.` : ''}`);
    setEditing(null); setCreated(count => count + 1); void refresh(); void loadDefinitions();
  };
  const change = async (id: string, method: 'PATCH' | 'DELETE', paused?: boolean) => {
    setActionError(''); setNotice('');
    try {
      await requestOk(`/schedules/${id}`, { method, ...(method === 'PATCH' ? { body: JSON.stringify({ paused }) } : {}) });
      if (editing?.id === id) setEditing(null);
      await refresh(); if (method === 'DELETE') await loadArchived();
    } catch (cause) { setActionError(reason(cause, 'Schedule update failed')); }
  };
  const card = (schedule: Schedule) => <ScheduleCard key={schedule.id} schedule={schedule} navigate={navigate}
    actions={schedule.archived ? undefined : { onEdit: () => { setNotice(''); setEditing(schedule); }, onPause: () => void change(schedule.id, 'PATCH', !schedule.paused), onArchive: () => void change(schedule.id, 'DELETE') }}/>;

  return <section className="panel schedule-desk" aria-labelledby="schedules-title"><h2 id="schedules-title">Scheduled evaluations</h2>
    <p className="hint">Each schedule runs a saved run definition daily or weekly at a wall-clock time in its own IANA zone, following daylight saving. A busy target skips that occurrence; a failed target, login or chart check blocks it. Removing a schedule archives it: its definition and occurrence history stay inspectable below.</p>
    {scheduleError && <div className="alert" role="alert">Schedules unavailable: {scheduleError} <button type="button" onClick={() => void refresh()}>Retry schedules</button></div>}
    {definitionsError && <div className="alert" role="alert">Saved run definitions unavailable: {definitionsError} <button type="button" onClick={() => void loadDefinitions()}>Retry definitions</button></div>}
    {actionError && <p role="alert">{actionError}</p>}
    {notice && <p role="status" className="composer-notice">{notice}</p>}
    <div ref={formRef}><ScheduleForm key={editing?.id ?? `new-${created}`} definitions={definitions} targets={targets} cases={cases} editing={editing} navigate={navigate}
      onSaved={saved} onCancel={() => setEditing(null)} onReload={() => void loadDefinitions()}/></div>
    <h3>Schedules</h3>
    {schedules === null ? !scheduleError && <p role="status">Loading schedules…</p> : schedules.length ? <div className="schedule-list">{schedules.map(card)}</div> : <p className="empty">No active schedules. Create one from a saved run definition above.</p>}
    <details className="schedule-archive" onToggle={event => { archiveOpen.current = event.currentTarget.open; if (event.currentTarget.open && archived === null) void loadArchived(); }}>
      <summary>Archived schedules{archived ? ` (${archived.length})` : ''}</summary>
      {archiveError && <p role="alert">Archived schedules unavailable: {archiveError} <button type="button" onClick={() => void loadArchived()}>Retry archived schedules</button></p>}
      {archived === null ? !archiveError && <p role="status">Loading archived schedules…</p> : archived.length ? <>
        {archived.length >= ARCHIVE_LIMIT && <p className="hint">Showing the {ARCHIVE_LIMIT} most recently archived schedules.</p>}
        <div className="schedule-list">{archived.map(card)}</div></> : <p className="empty">No archived schedules.</p>}
    </details>
  </section>;
}
