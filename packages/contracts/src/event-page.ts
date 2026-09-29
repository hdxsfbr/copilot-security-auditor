import { z } from 'zod';

// Event IDs are PostgreSQL bigserial values. They travel as canonical decimal
// strings and are compared with BigInt; they must never pass through Number.
export const EVENT_PAGE_DEFAULT_LIMIT = 100;
export const EVENT_PAGE_MAX_LIMIT = 200;
export const EVENT_ID_MAX = 9223372036854775807n;
const canonicalId = /^(0|[1-9][0-9]{0,18})$/;

export const isEventId = (value: unknown): value is string => typeof value === 'string' && canonicalId.test(value) && BigInt(value) <= EVENT_ID_MAX;
export const compareEventIds = (a: string, b: string) => { const left = BigInt(a), right = BigInt(b); return left < right ? -1 : left > right ? 1 : 0; };

// `after` is exclusive: "0" (or omission) starts at the first event.
export const eventPageQuery = z.object({
  after: z.string().refine(isEventId).optional(),
  limit: z.string().regex(/^[0-9]{1,3}$/).transform(Number).pipe(z.number().int().min(1).max(EVENT_PAGE_MAX_LIMIT)).default(EVENT_PAGE_DEFAULT_LIMIT)
}).strict();
export type EventPageQuery = z.infer<typeof eventPageQuery>;
export type EventPage<T = unknown> = { items: T[]; hasMore: boolean; nextCursor: string | null };
