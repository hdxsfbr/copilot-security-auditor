import type pg from 'pg';
import { decodeRunCursor, encodeRunCursor } from './repository.js';

// Archive-aware schedule reads. Archiving is a soft delete (`deleted`), so archived schedules and every
// occurrence stay readable by id; nothing here mutates or removes history.
const ARCHIVED_LIST_LIMIT = 200;
type Snapshot = { case?: { title?: string; category?: string }; adaptive?: { seeds?: { id: string; definition?: { title?: string; category?: string } }[] } };
type Definition = { run: { kind: 'selected' | 'adaptive'; input: { targetId: string; caseId?: string } } };

const scheduleSql = `SELECT s.id,s.definition,s.run_snapshot AS snapshot,s.next_fire_at AS "nextFireAt",s.paused,s.deleted AS archived,
  s.archived_at AS "archivedAt",s.created_at AS "createdAt",s.source_definition_id AS "sourceId",s.source_revision AS "sourceRevision",
  d.name AS "sourceName",t.name AS "targetName"
  FROM schedules s LEFT JOIN run_definitions d ON d.id=s.source_definition_id
  LEFT JOIN targets t ON t.id=(s.definition->'run'->'input'->>'targetId')::uuid`;

// The saved case titles come from the schedule's own snapshot, so they stay accurate after the source case is archived or edited.
function cases(definition: Definition, snapshot: Snapshot) {
  const run = definition.run;
  if (run.kind === 'selected') return [{ id: run.input.caseId ?? '', title: snapshot.case?.title ?? null, category: snapshot.case?.category ?? 'prompt_injection' }];
  return (snapshot.adaptive?.seeds ?? []).map(seed => ({ id: seed.id, title: seed.definition?.title ?? null, category: seed.definition?.category ?? 'prompt_injection' }));
}

function view(row: Record<string, unknown>) {
  const definition = row.definition as Definition, snapshot = (row.snapshot ?? {}) as Snapshot;
  return { id: row.id as string, definition, nextFireAt: row.nextFireAt, paused: row.paused as boolean, archived: row.archived as boolean,
    archivedAt: row.archivedAt ?? null, createdAt: row.createdAt,
    source: row.sourceId ? { runDefinitionId: row.sourceId as string, revision: row.sourceRevision as number, name: (row.sourceName as string | null) ?? null } : null,
    target: { id: definition.run.input.targetId, name: (row.targetName as string | null) ?? null }, cases: cases(definition, snapshot) };
}

export async function listSchedules(pool: pg.Pool, archived: boolean) {
  const order = archived ? 's.archived_at DESC NULLS LAST,s.created_at DESC,s.id' : 's.created_at DESC,s.id';
  const rows = (await pool.query(`${scheduleSql} WHERE s.deleted=$1 ORDER BY ${order} LIMIT $2`, [archived, archived ? ARCHIVED_LIST_LIMIT : null])).rows;
  return rows.map(view);
}

export async function readSchedule(pool: pg.Pool, id: string) {
  const row = (await pool.query(`${scheduleSql} WHERE s.id=$1`, [id])).rows[0];
  return row ? view(row) : null;
}

/** Newest-first page keyed by (scheduled_for, id), the run-history cursor format. Null when the schedule does not exist (archived ones do). */
export async function occurrencePage(pool: pg.Pool, scheduleId: string, limit: number, cursor?: string) {
  const after = decodeRunCursor(cursor);
  if (!(await pool.query('SELECT 1 FROM schedules WHERE id=$1', [scheduleId])).rowCount) return null;
  const rows = (await pool.query(`SELECT o.id,o.scheduled_for AS "scheduledFor",o.state,o.reason,o.run_id AS "runId",r.status AS "runStatus",r.outcome AS "runOutcome",
    to_char(o.scheduled_for AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorCreatedAt"
    FROM schedule_occurrences o LEFT JOIN runs r ON r.id=o.run_id
    WHERE o.schedule_id=$1 AND ($3::timestamptz IS NULL OR (o.scheduled_for,o.id)<($3::timestamptz,$4::uuid))
    ORDER BY o.scheduled_for DESC,o.id DESC LIMIT $2`, [scheduleId, limit + 1, after?.t ?? null, after?.id ?? null])).rows;
  const items = rows.slice(0, limit);
  return { items: items.map(({ cursorCreatedAt: _cursor, ...row }) => row), nextCursor: rows.length > limit ? encodeRunCursor(items.at(-1)) : null };
}
