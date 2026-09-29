import { useCallback, useEffect, useRef, useState } from 'react';
import { requestJson, type ResponseGuard } from '../../api/client.js';

/** Loads a GET resource while `active`; polls every few seconds (only while visible) as long as `poll(data)` says work is in flight. */
export function useLoaded<T>(path: string, guard: ResponseGuard<T>, active: boolean, poll?: (data: T | null) => boolean) {
  const [data, setData] = useState<T | null>(null), [error, setError] = useState(''), sequence = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++sequence.current;
    try { const next = await requestJson(path, guard); if (mine === sequence.current) { setData(next); setError(''); } }
    catch (cause) { if (mine === sequence.current) setError(cause instanceof Error ? cause.message : 'Unavailable'); }
  }, [path, guard]);
  useEffect(() => { if (active) void reload(); }, [active, reload]);
  useEffect(() => {
    if (!active || !poll?.(data)) return;
    const timer = setInterval(() => { if (!document.hidden) void reload(); }, 4000);
    return () => clearInterval(timer);
  }, [active, data, reload]);
  return { data, error, reload };
}
