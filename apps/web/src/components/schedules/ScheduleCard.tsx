import React, { useState } from 'react';
import { Occurrences } from './Occurrences.js';
import { RunSummary } from './RunSummary.js';
import { parseRun, type Schedule } from './model.js';
import { browserEquivalent, inZone, wallTime, weekdays } from './zone.js';

export type ScheduleActions = { onEdit: () => void; onPause: () => void; onArchive: () => void };

/** One schedule (active, paused or archived) with its saved run summary and on-demand occurrence history. Archived cards have no actions. */
export function ScheduleCard({ schedule, navigate, actions }: { schedule: Schedule; navigate: (path: string) => void; actions?: ScheduleActions }) {
  const [open, setOpen] = useState(false), [confirming, setConfirming] = useState(false);
  const { definition, source } = schedule, zone = definition.zone;
  const next = schedule.nextFireAt, local = schedule.archived ? null : browserEquivalent(next, zone);
  return <article className={`schedule-card${schedule.archived ? ' archived' : ''}`} aria-label={`${schedule.archived ? 'Archived schedule' : 'Schedule'} ${definition.name}`}>
    <div className="schedule-card-head"><strong>{definition.name}</strong>{schedule.archived && <span className="schedule-badge">Archived</span>}</div>
    <p>{definition.cadence === 'weekly' ? `Every ${weekdays[definition.weekday ?? 0]}` : 'Every day'} at {wallTime(definition.hour, definition.minute, zone, next)}</p>
    {schedule.archived
      ? <p>Removed {schedule.archivedAt ? inZone(schedule.archivedAt, zone) : '(time not recorded)'}. It no longer runs; its definition and occurrence history are kept.</p>
      : <p>{schedule.paused ? 'Paused' : 'Active'} · next {inZone(next, zone)}</p>}
    {local && <small>{local}</small>}
    {source && <p className="hint">From saved definition {source.name ?? 'no longer listed'} · revision {source.revision}</p>}
    {!source && <p className="hint">Created with inline run settings (no saved definition).</p>}
    <RunSummary run={parseRun(definition.run)} target={schedule.target} cases={schedule.cases}/>
    <div className="schedule-actions">
      {actions && !confirming && <>
        <button type="button" onClick={actions.onEdit}>Edit</button>
        <button type="button" onClick={actions.onPause}>{schedule.paused ? 'Resume' : 'Pause'}</button>
        <button type="button" onClick={() => setConfirming(true)}>Remove</button>
      </>}
      {actions && confirming && <span role="group" aria-label="Confirm removal">Archive this schedule? It stops running; history stays under Archived schedules.
        <button type="button" onClick={actions.onArchive}>Archive schedule</button><button type="button" onClick={() => setConfirming(false)}>Keep schedule</button></span>}
      <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? 'Hide occurrences' : schedule.archived ? 'Inspect occurrences' : 'View occurrences'}</button>
    </div>
    {open && <Occurrences scheduleId={schedule.id} zone={zone} navigate={navigate} live={!schedule.archived}/>}
  </article>;
}
