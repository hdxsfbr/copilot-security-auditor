import type pg from 'pg';
import type { Repository } from '../../api/src/repository.js';
import { ReportLeaseLost, type ClaimedReportJob } from '../../api/src/report-jobs.js';
import type { ModelUsage } from './models.js';

// F01 plugs Documentation drafting in here. The handler sees one leased job and can only reserve and settle
// calls for that job's snapshotted Documentation model, within the funds transferred to it. It never receives
// the run lease, the target, credentials or any way to widen the model, allowance or generation.
export type ReportJobContext = {
  job: Omit<ClaimedReportJob, 'generation'>;
  // Aborts when the lease is lost; stop work and do not treat any in-flight paid call as free.
  signal: AbortSignal;
  reserveCall(amountNanos: bigint): Promise<string>;
  // Settle at zero only when the request was provably never sent. A missing or ambiguous usage stays held.
  settleCall(callId: string, usage?: ModelUsage): Promise<boolean>;
};
// `commit` runs inside the fenced completion transaction (persist a draft atomically with settlement).
export type ReportJobResult = { status: 'completed'; commit?: (db: pg.PoolClient) => Promise<void> } | { status: 'failed'; reason: string };
export type ReportJobHandler = (context: ReportJobContext) => Promise<ReportJobResult>;

let registered: ReportJobHandler | null = null;
// Without a handler the worker only sweeps leases and review windows; queued jobs stay queued and unspent.
export function registerReportJobHandler(handler: ReportJobHandler | null) { registered = handler; }

export async function processNextReportJob(repo: Repository, owner = 'worker', handler: ReportJobHandler | null = registered, heartbeatMs = 10_000) {
  await repo.reports.sweep();
  if (!handler) return null;
  const claimed = await repo.reports.claim(owner);
  if (!claimed) return null;
  const { generation, ...job } = claimed;
  const lost = new AbortController();
  const beat = setInterval(() => { void repo.reports.heartbeat(job.id, generation).catch(() => { lost.abort(); clearInterval(beat); }); }, heartbeatMs);
  try {
    const result = await handler({ job, signal: lost.signal,
      reserveCall: amount => repo.reports.reserveCall(job.id, generation, amount),
      settleCall: (callId, usage) => repo.reports.settleCall(job.id, generation, callId, usage) });
    const settled = await repo.reports.settle(job.id, generation, result.status, result.status === 'failed' ? result.reason : undefined, result.status === 'completed' ? result.commit : undefined);
    return { id: job.id, state: settled.state };
  } catch (error) {
    if (error instanceof ReportLeaseLost) return { id: job.id, state: 'lease_lost' as const };
    // Unsettled calls become unresolved inside settle; only a fenced generation may record the failure.
    return repo.reports.settle(job.id, generation, 'failed', 'handler_error').then(settled => ({ id: job.id, state: settled.state }), () => ({ id: job.id, state: 'unsettled' as const }));
  } finally { clearInterval(beat); }
}
