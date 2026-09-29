import type pg from 'pg';
import { WORKER_HEARTBEAT_INTERVAL_MS, recordWorkerHeartbeat, registerWorker, type WorkerCycleErrorCode } from '../../api/src/operations.js';

// Independent liveness timer. It runs while the worker is idle or awaiting
// target/model work, and never carries error text: only a fixed cycle code.
export function startWorkerHeartbeat(pool: pg.Pool, workerId: string, intervalMs = WORKER_HEARTBEAT_INTERVAL_MS) {
  let cycleError: WorkerCycleErrorCode | null = null, written: WorkerCycleErrorCode | null = null;
  let inFlight: Promise<boolean> | null = null;
  let failing = false, stopped = false;
  // Registration and heartbeats share one slot, so writes never overlap: an in-flight write is already newer than any timer tick.
  const track = (write: Promise<unknown>): Promise<boolean> => inFlight = write.then(() => {
    failing = false;
    return true;
  }, () => {
    if (!failing) console.error('Worker heartbeat failed (details suppressed)');
    failing = true;
    return false;
  }).finally(() => {
    inFlight = null;
    if (written !== cycleError && !stopped) void beat();
  });
  const beat = (): Promise<boolean> => inFlight ?? track(recordWorkerHeartbeat(pool, workerId, written = cycleError));
  const started = track(registerWorker(pool, workerId));
  const timer = setInterval(() => { void beat(); }, intervalMs);
  return {
    started,
    beat,
    setCycleError(code: WorkerCycleErrorCode | null) {
      if (code === cycleError) return;
      cycleError = code;
      void beat();
    },
    stop() { stopped = true; clearInterval(timer); }
  };
}
