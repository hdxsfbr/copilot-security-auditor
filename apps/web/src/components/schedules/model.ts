import { runDefinition, type RunDefinition } from '../../../../../packages/contracts/src/index.js';
import { isRecord } from '../../api/client.js';

export type Definition = { name: string; cadence: 'daily' | 'weekly'; weekday?: number; hour: number; minute: number; zone: string; run: { kind: 'selected' | 'adaptive'; input: Record<string, unknown> } };
export type Schedule = {
  id: string; definition: Definition; nextFireAt: string; paused: boolean; archived: boolean; archivedAt: string | null; createdAt: string;
  source: { runDefinitionId: string; revision: number; name: string | null } | null;
  target: { id: string; name: string | null }; cases: { id: string; title: string | null; category: string }[];
};
export type OccurrenceState = 'queued' | 'running' | 'finished' | 'skipped' | 'blocked';
export type Occurrence = { id: string; scheduledFor: string; state: OccurrenceState; reason: string | null; runId: string | null; runStatus: string | null; runOutcome: string | null };
export type OccurrencePage = { items: Occurrence[]; nextCursor: string | null };

const text = (value: unknown): value is string => typeof value === 'string';
const nullable = (value: unknown): value is string | null => value === null || text(value);
const instant = (value: unknown): value is string => text(value) && Number.isFinite(Date.parse(value));
// Deliberately structural for the stored run: one legacy snapshot that no longer parses must not hide every schedule.
const isDefinition = (value: unknown): value is Definition => isRecord(value) && text(value.name) && (value.cadence === 'daily' || value.cadence === 'weekly') && Number.isInteger(value.hour) && Number.isInteger(value.minute)
  && text(value.zone) && isRecord(value.run) && (value.run.kind === 'selected' || value.run.kind === 'adaptive') && isRecord(value.run.input);
const isSchedule = (value: unknown): value is Schedule => isRecord(value) && text(value.id) && isDefinition(value.definition) && instant(value.nextFireAt) && typeof value.paused === 'boolean' && typeof value.archived === 'boolean'
  && (value.archivedAt === null || instant(value.archivedAt)) && instant(value.createdAt) && (value.source === null || isRecord(value.source) && text(value.source.runDefinitionId) && Number.isInteger(value.source.revision) && nullable(value.source.name))
  && isRecord(value.target) && text(value.target.id) && nullable(value.target.name)
  && Array.isArray(value.cases) && value.cases.every(item => isRecord(item) && text(item.id) && nullable(item.title) && text(item.category));
export const isScheduleList = (value: unknown): value is Schedule[] => Array.isArray(value) && value.every(isSchedule);
const states = ['queued', 'running', 'finished', 'skipped', 'blocked'];
const isOccurrence = (value: unknown): value is Occurrence => isRecord(value) && text(value.id) && instant(value.scheduledFor) && text(value.state) && states.includes(value.state) && nullable(value.reason) && nullable(value.runId) && nullable(value.runStatus) && nullable(value.runOutcome);
export const isOccurrencePage = (value: unknown): value is OccurrencePage => isRecord(value) && Array.isArray(value.items) && value.items.every(isOccurrence) && nullable(value.nextCursor);
export const isSavedSchedule = (value: unknown): value is { id: string; nextFireAt: string } => isRecord(value) && text(value.id) && instant(value.nextFireAt);

/** A stored schedule run, parsed with the current contract, or null when the snapshot predates it. */
export const parseRun = (run: Schedule['definition']['run']): RunDefinition | null => { const parsed = runDefinition.safeParse(run); return parsed.success ? parsed.data : null; };
