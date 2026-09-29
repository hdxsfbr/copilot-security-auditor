import React, { useEffect, useRef, useState } from 'react';
import { requestJson } from '../../api/client.js';
import { RouteLink } from '../router.js';
import { isOccurrencePage, type Occurrence } from './model.js';
import { browserEquivalent, inZone } from './zone.js';

const PAGE_SIZE = 25;
const runId = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;
export const runLink = (id: string) => `/runs/${encodeURIComponent(id)}`;
// A busy-target skip names the blocking run; link it instead of leaving an opaque id.
function Reason({ item, navigate }: { item: Occurrence; navigate: (path: string) => void }) {
  if (!item.reason) return item.state === 'skipped' || item.state === 'blocked' ? <p>No reason was recorded for this {item.state} occurrence.</p> : null;
  const [before, id, after] = item.reason.split(runId);
  return <p>{item.state === 'skipped' || item.state === 'blocked' ? `${item.state === 'skipped' ? 'Skipped' : 'Blocked'}: ` : 'Note: '}{id ? <>{before}<RouteLink href={runLink(id)} navigate={navigate}>{id.slice(0, 8)}</RouteLink>{after}</> : item.reason}</p>;
}

/** Newest-first occurrence history, one bounded page at a time. Older pages are loaded on demand and never dropped by the live refresh. */
export function Occurrences({ scheduleId, zone, navigate, live }: { scheduleId: string; zone: string; navigate: (path: string) => void; live: boolean }) {
  const [items, setItems] = useState<Occurrence[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const paged = useRef(false), inFlight = useRef(false), generation = useRef(0), failed = useRef<string | null>(null);
  const load = async (next: string | null) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    const token = generation.current;
    try {
      const page = await requestJson(`/schedules/${scheduleId}/occurrences/page?limit=${PAGE_SIZE}${next ? `&cursor=${encodeURIComponent(next)}` : ''}`, isOccurrencePage);
      if (generation.current !== token) return;
      paged.current = next !== null;
      setItems(previous => next ? [...previous, ...page.items.filter(item => !previous.some(old => old.id === item.id))] : page.items);
      setCursor(page.nextCursor); setLoaded(true);
    } catch (cause) { if (generation.current === token) { failed.current = next; setError(cause instanceof Error ? cause.message : 'Occurrence history unavailable'); } }
    finally { if (generation.current === token) { inFlight.current = false; setBusy(false); } }
  };
  useEffect(() => {
    void load(null);
    const timer = live ? setInterval(() => { if (!paged.current && !document.hidden) void load(null); }, 5000) : undefined;
    return () => { generation.current++; inFlight.current = false; clearInterval(timer); };
  }, [scheduleId, live]);
  return <section className="schedule-occurrences" aria-label="Occurrences">
    <div className="schedule-occurrences-head"><h4>Occurrences</h4><button type="button" disabled={busy} onClick={() => void load(null)}>Refresh occurrences</button></div>
    <p className="hint">Times use the schedule's zone ({zone}). Skipped: the target was busy, so no run started. Blocked: a target, login, chart or case check failed, so there is no security verdict.</p>
    {error && <p role="alert">{loaded ? 'Refresh failed; the rows shown are retained. ' : 'Occurrences could not load. '}{error} <button type="button" onClick={() => void load(failed.current)}>Retry</button></p>}
    {!loaded && busy && <p role="status">Loading occurrences…</p>}
    {loaded && !items.length && <p className="empty">No occurrences yet.</p>}
    {items.length > 0 && <ol className="schedule-occurrence-list">{items.map(item => {
      const local = browserEquivalent(item.scheduledFor, zone);
      return <li key={item.id}>
        <div className="schedule-occurrence-head"><strong>{inZone(item.scheduledFor, zone)}</strong><span className={`occurrence-state ${item.state}`}>{item.state}</span></div>
        {local && <small>{local}</small>}
        <Reason item={item} navigate={navigate}/>
        {item.runId && <p><RouteLink href={runLink(item.runId)} navigate={navigate}>Open run {item.runId.slice(0, 8)}</RouteLink> ({item.runStatus ?? 'status unknown'}{item.runOutcome ? ` / ${item.runOutcome}` : ''})</p>}
      </li>;
    })}</ol>}
    {cursor && <button type="button" disabled={busy} onClick={() => void load(cursor)}>{busy ? 'Loading…' : 'Load older occurrences'}</button>}
  </section>;
}
