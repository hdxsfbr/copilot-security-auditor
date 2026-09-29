import type pg from 'pg';

// Liveness policy. Heartbeats are written every 10 seconds; a worker is fresh
// for three missed periods. A queued run older than the warning age is reported
// with its age and count, never as proof that a worker stopped.
export const WORKER_HEARTBEAT_INTERVAL_MS = 10_000;
export const WORKER_FRESH_SECONDS = 30;
export const QUEUE_WARNING_SECONDS = 30;
const WORKER_LIST_LIMIT = 5;
const WORKER_RETENTION_DAYS = 7;

// Diagnostic codes are the only failure text stored or returned. Adding a code
// means adding it here and to the web copy map; raw error text is never used.
export const workerCycleErrorCodes = ['worker_cycle_failed', 'lease_lost'] as const;
export type WorkerCycleErrorCode = typeof workerCycleErrorCodes[number];
export type OperationsDiagnosticCode = 'no_worker_registered' | 'worker_heartbeat_stale' | 'queue_aging' | 'queue_waiting_for_worker_capacity' | 'expired_lease' | WorkerCycleErrorCode;
export type WorkerState = 'idle' | 'busy' | 'no_recent_heartbeat';
export type OperationsHealth = {
  v: 1;
  status: 'ok' | 'attention';
  checkedAt: string;
  policy: { heartbeatIntervalSeconds: number; freshSeconds: number; queueWarningSeconds: number };
  workerSummary: { state: 'none_registered' | 'no_recent_heartbeat' | 'fresh'; freshCount: number; idleCount: number; busyCount: number };
  workers: { id: string; state: WorkerState; startedAt: string; heartbeatAgeSeconds: number; activeRunId: string | null; diagnosticCode: WorkerCycleErrorCode | null }[];
  queue: { queuedCount: number; oldestQueuedAgeSeconds: number | null };
  leases: { activeCount: number; expiredCount: number };
  diagnostics: { code: OperationsDiagnosticCode; level: 'warning' | 'info' }[];
};

// Unknown failures collapse to the generic code; only allowlisted strings are
// ever persisted.
export function workerCycleErrorCode(error: unknown): WorkerCycleErrorCode {
  return error instanceof Error && error.message === 'Lease lost' ? 'lease_lost' : 'worker_cycle_failed';
}
const knownCycleCode = (value: unknown): WorkerCycleErrorCode | null =>
  value === null || value === undefined ? null : (workerCycleErrorCodes as readonly string[]).includes(String(value)) ? value as WorkerCycleErrorCode : 'worker_cycle_failed';

export async function registerWorker(pool: pg.Pool, workerId: string) {
  await pool.query(`INSERT INTO worker_instances(worker_id) VALUES ($1)
    ON CONFLICT (worker_id) DO UPDATE SET started_at=now(),last_heartbeat_at=now(),last_cycle_error_code=NULL`, [workerId]);
  await pool.query("DELETE FROM worker_instances WHERE last_heartbeat_at<now()-make_interval(days=>$1) AND worker_id<>$2", [WORKER_RETENTION_DAYS, workerId]);
}
export async function recordWorkerHeartbeat(pool: pg.Pool, workerId: string, cycleError: WorkerCycleErrorCode | null = null) {
  await pool.query(`INSERT INTO worker_instances(worker_id,last_cycle_error_code) VALUES ($1,$2)
    ON CONFLICT (worker_id) DO UPDATE SET last_heartbeat_at=now(),last_cycle_error_code=EXCLUDED.last_cycle_error_code`, [workerId, cycleError]);
}

export async function operationsHealth(pool: pg.Pool): Promise<OperationsHealth> {
  const db = await pool.connect();
  try {
    // One read-only transaction gives both queries the same now().
    await db.query('BEGIN READ ONLY');
    const workers = (await db.query(`SELECT w.worker_id::text AS id,w.started_at AS "startedAt",
        w.last_heartbeat_at>now()-make_interval(secs=>$2::double precision) AS fresh,
        GREATEST(0,floor(extract(epoch FROM now()-w.last_heartbeat_at)))::int AS "heartbeatAgeSeconds",
        w.last_cycle_error_code AS "cycleErrorCode",r.id AS "activeRunId"
      FROM (SELECT * FROM worker_instances ORDER BY last_heartbeat_at DESC LIMIT $1) w
      LEFT JOIN LATERAL (SELECT id FROM runs WHERE lease_owner=w.worker_id::text AND status='running' AND lease_until>now() ORDER BY started_at DESC LIMIT 1) r ON true
      ORDER BY w.last_heartbeat_at DESC`, [WORKER_LIST_LIMIT, WORKER_FRESH_SECONDS])).rows;
    const totals = (await db.query(`WITH fresh AS (SELECT worker_id,last_cycle_error_code FROM worker_instances WHERE last_heartbeat_at>now()-make_interval(secs=>$1::double precision))
      SELECT now() AS "checkedAt",EXISTS(SELECT 1 FROM worker_instances) AS registered,
        (SELECT count(*)::int FROM fresh) AS "freshCount",
        (SELECT count(DISTINCT r.lease_owner)::int FROM runs r JOIN fresh f ON f.worker_id::text=r.lease_owner WHERE r.status='running' AND r.lease_until>now()) AS "busyCount",
        (SELECT COALESCE(array_agg(DISTINCT last_cycle_error_code),'{}') FROM fresh WHERE last_cycle_error_code IS NOT NULL) AS "cycleErrorCodes",
        (SELECT count(*)::int FROM runs WHERE status='queued' AND stop_requested=false) AS "queuedCount",
        (SELECT floor(extract(epoch FROM now()-min(created_at)))::int FROM runs WHERE status='queued' AND stop_requested=false) AS "oldestQueuedAgeSeconds",
        (SELECT count(*)::int FROM runs WHERE status='running' AND lease_until>now()) AS "activeLeases",
        (SELECT count(*)::int FROM runs WHERE status='running' AND (lease_until IS NULL OR lease_until<=now())) AS "expiredLeases"`, [WORKER_FRESH_SECONDS])).rows[0];
    await db.query('COMMIT');
    const fresh: number = totals.freshCount, busy: number = totals.busyCount;
    const oldest: number | null = totals.oldestQueuedAgeSeconds === null ? null : Math.max(0, totals.oldestQueuedAgeSeconds);
    const diagnostics: OperationsHealth['diagnostics'] = [];
    if (!totals.registered) diagnostics.push({ code: 'no_worker_registered', level: 'warning' });
    else if (!fresh) diagnostics.push({ code: 'worker_heartbeat_stale', level: 'warning' });
    if (oldest !== null && oldest > QUEUE_WARNING_SECONDS) {
      // A fresh worker with every process busy is normal one-run-per-process capacity.
      diagnostics.push(fresh > 0 && busy >= fresh ? { code: 'queue_waiting_for_worker_capacity', level: 'info' } : { code: 'queue_aging', level: 'warning' });
    }
    if (totals.expiredLeases > 0) diagnostics.push({ code: 'expired_lease', level: 'warning' });
    for (const code of new Set((totals.cycleErrorCodes as string[]).map(knownCycleCode))) if (code) diagnostics.push({ code, level: 'warning' });
    return {
      v: 1, status: diagnostics.some(item => item.level === 'warning') ? 'attention' : 'ok', checkedAt: new Date(totals.checkedAt).toISOString(),
      policy: { heartbeatIntervalSeconds: WORKER_HEARTBEAT_INTERVAL_MS / 1000, freshSeconds: WORKER_FRESH_SECONDS, queueWarningSeconds: QUEUE_WARNING_SECONDS },
      workerSummary: { state: !totals.registered ? 'none_registered' : fresh ? 'fresh' : 'no_recent_heartbeat', freshCount: fresh, busyCount: busy, idleCount: Math.max(0, fresh - busy) },
      workers: workers.map(row => ({ id: row.id, state: !row.fresh ? 'no_recent_heartbeat' as const : row.activeRunId ? 'busy' as const : 'idle' as const,
        startedAt: new Date(row.startedAt).toISOString(), heartbeatAgeSeconds: row.heartbeatAgeSeconds, activeRunId: row.activeRunId ?? null, diagnosticCode: knownCycleCode(row.cycleErrorCode) })),
      queue: { queuedCount: totals.queuedCount, oldestQueuedAgeSeconds: oldest },
      leases: { activeCount: totals.activeLeases, expiredCount: totals.expiredLeases },
      diagnostics
    };
  } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
  finally { db.release(); }
}
