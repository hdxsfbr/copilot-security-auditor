import type pg from 'pg';
import { EVENT_PAGE_DEFAULT_LIMIT, EVENT_PAGE_MAX_LIMIT, isEventId, type EventPage } from '../../../packages/contracts/src/event-page.js';

export type EventRow = { id: string; event: unknown; createdAt: Date };
export class InvalidEventPage extends Error { constructor() { super('Invalid event page request'); } }

// Bounded read of events with id strictly greater than `after`, ascending.
// Fetches one extra row to learn whether more exist without a COUNT. New events
// may be appended after any read, so `hasMore: false` means "caught up now".
export async function readEventPage(pool: pg.Pool, runId: string, after?: string, limit = EVENT_PAGE_DEFAULT_LIMIT): Promise<EventPage<EventRow> | null> {
  if ((after !== undefined && !isEventId(after)) || !Number.isInteger(limit) || limit < 1 || limit > EVENT_PAGE_MAX_LIMIT) throw new InvalidEventPage();
  if (!(await pool.query('SELECT 1 FROM runs WHERE id=$1', [runId])).rowCount) return null;
  const rows = (await pool.query('SELECT id::text AS id,event,created_at AS "createdAt" FROM events WHERE run_id=$1 AND id>$2::bigint ORDER BY id LIMIT $3', [runId, after ?? '0', limit + 1])).rows as EventRow[];
  const items = rows.slice(0, limit);
  return { items, hasMore: rows.length > limit, nextCursor: items.at(-1)?.id ?? after ?? null };
}
