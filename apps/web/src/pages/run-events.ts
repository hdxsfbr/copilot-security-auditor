import { isRecord, requestJson } from "../api/client.js";
import type { Event } from "./controller.js";

// Event IDs are bigint strings. They are compared with BigInt and never coerced
// to Number, so IDs beyond 2^53 keep their exact order and identity.
const PAGE_LIMIT = 100;
const MAX_EVENT_ID = 9223372036854775807n;
export const isEventId = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= MAX_EVENT_ID;
const isEventRow = (value: unknown): value is Event & { id: string } => isRecord(value) && isEventId(value.id) && isRecord(value.event) && typeof value.event.agent === "string" && typeof value.event.kind === "string" && isRecord(value.event.detail) && typeof value.createdAt === "string";
type EventPage = { items: (Event & { id: string })[]; hasMore: boolean; nextCursor: string | null };
const isEventPage = (value: unknown): value is EventPage => isRecord(value) && Array.isArray(value.items) && value.items.every(isEventRow) && typeof value.hasMore === "boolean" && (value.nextCursor === null || isEventId(value.nextCursor));

// Append only events strictly newer than the newest accepted one, in ascending
// order. Duplicates and out-of-order rows are dropped; nothing is reordered.
export function appendNewerEvents(current: Event[], incoming: Event[]): Event[] {
  let newest = current.length ? BigInt(String(current[current.length - 1].id)) : -1n;
  const accepted: Event[] = [];
  for (const item of incoming) {
    const id = BigInt(String(item.id));
    if (id > newest) { accepted.push(item); newest = id; }
  }
  return accepted.length ? [...current, ...accepted] : current;
}

// Reads pages sequentially from `after` until caught up. `accept` receives each
// verified page immediately, so a failure on a later page keeps earlier pages
// and the cursor (Retry resumes after the last accepted event). `proceed` lets a
// superseded caller stop before requesting another page.
export async function drainEventPages(runId: string, after: string | null, accept: (items: Event[], cursor: string | null) => void, proceed: () => boolean = () => true) {
  let cursor = after;
  while (proceed()) {
    const page = await requestJson(`/runs/${encodeURIComponent(runId)}/events/page?limit=${PAGE_LIMIT}${cursor ? `&after=${cursor}` : ""}`, isEventPage);
    if (!proceed()) return;
    if (page.nextCursor !== null && cursor !== null && BigInt(page.nextCursor) < BigInt(cursor)) throw new Error("Event cursor moved backwards");
    if (page.hasMore && (!page.items.length || page.nextCursor === null || page.nextCursor === cursor)) throw new Error("Event cursor did not advance");
    cursor = page.nextCursor ?? cursor;
    accept(page.items, cursor);
    if (!page.hasMore) return;
  }
}
