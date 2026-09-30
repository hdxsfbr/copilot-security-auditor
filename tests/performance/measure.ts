import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import pg from 'pg';

// Instrumentation shared by the P01 fixture baseline (baseline.ts), the CI SLO check (slo-check.ts) and their tests.
// Everything here observes the local process only: no network, no provider, no target.

const round = (value: number, places = 2) => { const factor = 10 ** places; return Math.round(value * factor) / factor; };
export { round };

/** Nearest-rank percentiles, the same definition the Q02 acceptance baseline uses. */
export function summarize(samples: number[]) {
  if (!samples.length) return { count: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  return { count: sorted.length, meanMs: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length), p50Ms: round(at(0.5)), p95Ms: round(at(0.95)), p99Ms: round(at(0.99)), maxMs: round(sorted.at(-1)!) };
}

// ---- SQL statements -------------------------------------------------------------------------------------------------

export type SqlProfile = { statements: number; dbMs: number; bySql: Map<string, { count: number; ms: number }> };
const emptyProfile = (): SqlProfile => ({ statements: 0, dbMs: 0, bySql: new Map() });

/**
 * Counts and times every statement sent through `pg.Client#query` (so pool queries and transaction clients alike) until
 * `restore()`. `dbMs` is what the client observed: PostgreSQL execution plus the loopback round trip. Statement text is
 * normalised to its first 110 characters so the profile groups by shape, never by parameter values.
 */
export function instrumentPg() {
  const proto = pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
  const original = proto.query;
  let profile = emptyProfile();
  proto.query = function patched(this: unknown, ...args: unknown[]) {
    const first = args[0] as string | { text?: string } | undefined;
    const text = typeof first === 'string' ? first : typeof first?.text === 'string' ? first.text : '';
    const key = text.replace(/\s+/g, ' ').trim().slice(0, 110) || '(non-text query)';
    const started = performance.now();
    const done = () => {
      const ms = performance.now() - started;
      profile.statements++; profile.dbMs += ms;
      const entry = profile.bySql.get(key) ?? { count: 0, ms: 0 };
      entry.count++; entry.ms += ms; profile.bySql.set(key, entry);
    };
    const last = args[args.length - 1];
    if (typeof last === 'function') {
      args[args.length - 1] = function wrapped(this: unknown, ...callbackArgs: unknown[]) { done(); return (last as (...a: unknown[]) => unknown).apply(this, callbackArgs); };
      return original.apply(this, args);
    }
    const result = original.apply(this, args) as { then?: (a: () => void, b: () => void) => unknown } | undefined;
    if (result && typeof result.then === 'function') result.then(done, done);
    return result;
  };
  const snapshot = () => ({ statements: profile.statements, dbMs: profile.dbMs, bySql: new Map([...profile.bySql].map(([key, value]) => [key, { ...value }])) }) as SqlProfile;
  /** Cheap running totals, for per-case deltas without copying the per-statement map. */
  const counters = () => ({ statements: profile.statements, dbMs: profile.dbMs });
  return { snapshot, counters, reset() { profile = emptyProfile(); }, restore() { proto.query = original; } };
}
export type PgInstrument = ReturnType<typeof instrumentPg>;

/** The statements that cost the most total time between two snapshots, grouped by shape. */
export function topStatements(after: SqlProfile, before: SqlProfile | null, count: number, limit = 8) {
  const rows = [...after.bySql].map(([sql, value]) => {
    const prior = before?.bySql.get(sql);
    return { sql, count: value.count - (prior?.count ?? 0), totalMs: value.ms - (prior?.ms ?? 0) };
  }).filter(row => row.count > 0).sort((a, b) => b.totalMs - a.totalMs).slice(0, limit);
  const total = after.dbMs - (before?.dbMs ?? 0);
  return rows.map(row => ({ sql: row.sql, callsPerCase: round(row.count / count), msPerCase: round(row.totalMs / count, 3), shareOfDbTime: total > 0 ? round(row.totalMs / total, 3) : 0 }));
}

// ---- HTTP -------------------------------------------------------------------------------------------------------------

/** A fetch that records time-to-response-headers of every request into `sink`. Loopback only; the body is read by the caller. */
export const timedFetch = (inner: typeof fetch, sink: number[]): typeof fetch => async (input, init) => {
  const started = performance.now();
  try { return await inner(input, init); } finally { sink.push(performance.now() - started); }
};
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
/** A fetch that waits `ms` before every request: a fixed, illustrative per-request latency (never a measurement of any real system). */
export const delayedFetch = (ms: number, inner: typeof fetch = fetch): typeof fetch => ms <= 0 ? inner : async (input, init) => { await sleep(ms); return inner(input, init); };
export { sleep };

// ---- CPU, memory, event loop ------------------------------------------------------------------------------------------

/** Runs `work` and reports wall time, this process's CPU time, sampled RSS/heap peaks and event-loop delay while it ran. */
export async function measured<T>(work: () => Promise<T>) {
  const cpu0 = process.cpuUsage(), wall0 = performance.now();
  const loop = monitorEventLoopDelay({ resolution: 5 }); loop.enable();
  let peakRss = process.memoryUsage().rss, peakHeap = process.memoryUsage().heapUsed;
  const sample = () => { const usage = process.memoryUsage(); peakRss = Math.max(peakRss, usage.rss); peakHeap = Math.max(peakHeap, usage.heapUsed); };
  const timer = setInterval(sample, 20);
  try {
    const value = await work();
    const wallMs = performance.now() - wall0, cpu = process.cpuUsage(cpu0);
    sample();
    const cpuMs = (cpu.user + cpu.system) / 1000;
    const mb = (bytes: number) => Math.round(bytes / 1048576);
    return { value, wallMs, resources: {
      wallMs: Math.round(wallMs), cpuMs: Math.round(cpuMs), cpuUserMs: Math.round(cpu.user / 1000), cpuSystemMs: Math.round(cpu.system / 1000), cpuUtilization: round(cpuMs / wallMs), peakRssMb: mb(peakRss), peakHeapUsedMb: mb(peakHeap),
      eventLoopDelay: { meanMs: round(loop.mean / 1e6), p50Ms: round(loop.percentile(50) / 1e6), p99Ms: round(loop.percentile(99) / 1e6), maxMs: round(loop.max / 1e6), note: 'Timer-resolution delay of the single Node event loop that hosts API, worker, fixture target, Judge stand-in and PostgreSQL client.' }
    } };
  } finally { clearInterval(timer); loop.disable(); }
}

/**
 * A fixed CPU workload (JSON round trips and hashing, the shapes the pipeline spends CPU on). Reported with every recording so
 * a reader can compare the speed of two machines without trusting a marketing CPU name.
 */
export async function cpuProbe(iterations = 3): Promise<{ medianMs: number; samplesMs: number[]; workload: string }> {
  const { createHash } = await import('node:crypto');
  const samples: number[] = [];
  for (let run = 0; run < iterations; run++) {
    const started = performance.now();
    let acc = '';
    for (let index = 0; index < 4000; index++) {
      const doc = JSON.parse(JSON.stringify({ index, text: 'synthetic assistant text '.repeat(40), nested: { a: [1, 2, 3, index], b: acc.slice(0, 16) } }));
      acc = createHash('sha256').update(JSON.stringify(doc)).digest('hex');
    }
    samples.push(round(performance.now() - started));
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return { medianMs: sorted[Math.floor(sorted.length / 2)], samplesMs: samples, workload: '4,000 x (JSON stringify+parse of a ~1.3 KB document, then SHA-256 of its serialization), single thread' };
}
