import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { modelAssignment, type ModelAssignment, type RunReportPolicy } from '../../../packages/contracts/src/index.js';
import { nanos, reserveAmount, type ModelUsage, type Price, type Snapshot } from '../../worker/src/models.js';

// Report jobs are post-run work with their own lease, generation and funds. They never touch the run's lease or
// target reservation. A job is claimable only after its run has finished, so execution and report accounting
// cannot interleave. Held funds follow the run ledger rule: settled = charge, reserved/unresolved = reserve.
export class ReportLeaseLost extends Error { constructor() { super('Report job lease lost'); } }
export const MAX_REPORT_ATTEMPTS = 3;
export type ReportJobState = 'report_needed' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ReleaseReason = 'review_window_expired' | 'run_cancelled' | 'operator_cancelled';
export type ClaimedReportJob = { id: string; runId: string; candidateId: string; evidenceRevision: number; generation: number; attempt: number; model: ModelAssignment; price: Price | null; reservedNanos: bigint; ollamaUrl?: string };
export type ReportJobView = { id: string; candidateId: string; evidenceRevision: number; state: ReportJobState; reason: string | null; funding: 'run_allowance' | 'explicit_authorization' | null; reservedNanos: string; heldNanos: string; attempts: number };
export type ReportGrant = { model: ModelAssignment; price?: Price; allowanceNanos: bigint };
const held = "COALESCE(sum(CASE WHEN status='settled' THEN charge_nanos ELSE reserved_nanos END),0)";
const perJob = (model: ModelAssignment, price: Price | null | undefined) => {
  if (model.provider === 'ollama') return 0n;
  if (!price) throw new Error('Verified Documentation pricing required');
  return reserveAmount(price, model.maxOutputTokens);
};

// Runs inside the run-start transaction. The immutable policy also fixes the execution headroom: the
// allowance is carved out of paid_cap_nanos, so Orchestrator/Red Team/Judge reservations cannot spend it.
export async function snapshotReportPolicy(db: pg.PoolClient, runId: string, policy: RunReportPolicy, models?: Snapshot, capUsd?: number) {
  const allowance = policy.allowanceUsd === undefined ? 0n : nanos(policy.allowanceUsd);
  const price = models?.pricing.documentation ?? null;
  if (allowance > (capUsd === undefined ? 0n : nanos(capUsd))) throw new Error('Report allowance must fit inside the run cap');
  if (allowance < perJob(policy.model, price)) throw new Error('Report allowance below one bounded Documentation call');
  await db.query('INSERT INTO run_report_policies(run_id,model,price,allowance_nanos,review_window_seconds) VALUES ($1,$2,$3,$4,$5)', [runId, policy.model, price, allowance.toString(), policy.reviewWindowMinutes * 60]);
}

// Moves a job out of the active states. Unsettled calls become unresolved (delivery unknown), never free funds.
async function terminalize(db: pg.PoolClient, id: string, state: 'completed' | 'failed' | 'cancelled', reason: string | null) {
  await db.query("UPDATE model_calls SET status='unresolved' WHERE report_job_id=$1 AND status='reserved'", [id]);
  return (await db.query(`UPDATE report_jobs SET state=$2,reason=$3,finished_at=now(),lease_until=NULL,updated_at=now(),
    held_nanos=(SELECT ${held} FROM model_calls WHERE report_job_id=$1 AND provider='openrouter') WHERE id=$1 RETURNING held_nanos::text AS held`, [id, state, reason])).rows[0].held as string;
}

// Closes the run allowance to new transfers and cancels queued, never-leased-funds jobs. Running or
// unresolved holds stay on their jobs; unused_nanos records only what was provably unheld.
export async function releaseAllowance(db: pg.PoolClient, runId: string, reason: ReleaseReason) {
  const policy = (await db.query('SELECT allowance_nanos::text AS allowance FROM run_report_policies WHERE run_id=$1 FOR UPDATE', [runId])).rows[0];
  if (!policy || (await db.query('SELECT 1 FROM report_allowance_releases WHERE run_id=$1', [runId])).rowCount) return false;
  for (const row of (await db.query("SELECT id FROM report_jobs WHERE run_id=$1 AND funding='run_allowance' AND state='queued' ORDER BY id FOR UPDATE", [runId])).rows) await terminalize(db, row.id, 'cancelled', reason);
  const total = (await db.query("SELECT COALESCE(sum(held_nanos),0)::text AS amount FROM report_jobs WHERE run_id=$1 AND funding='run_allowance'", [runId])).rows[0].amount;
  await db.query('INSERT INTO report_allowance_releases(run_id,reason,unused_nanos) VALUES ($1,$2,$3)', [runId, reason, (BigInt(policy.allowance) - BigInt(total)).toString()]);
  return true;
}

// One job per (finding, evidence revision). A repeat or concurrent call returns the existing job and
// transfers nothing. The policy row lock serializes transfers, so aggregate holds cannot exceed the allowance.
export async function enqueueReportJob(db: pg.PoolClient, candidateId: string, evidenceRevision = 1) {
  if (!Number.isSafeInteger(evidenceRevision) || evidenceRevision < 1) throw new Error('Invalid evidence revision');
  const candidate = (await db.query("SELECT run_id FROM candidates WHERE id=$1 AND state='confirmed'", [candidateId])).rows[0];
  if (!candidate) throw new Error('Only confirmed findings can be reported');
  // Lock first, read second: a statement that waits on the lock keeps its old snapshot and would miss a concurrent transfer.
  await db.query('SELECT 1 FROM run_report_policies WHERE run_id=$1 FOR UPDATE', [candidate.run_id]);
  const policy = (await db.query(`SELECT p.model,p.price,p.allowance_nanos::text AS allowance,
    EXISTS (SELECT 1 FROM report_allowance_releases x WHERE x.run_id=p.run_id) OR (r.finished_at IS NOT NULL AND r.finished_at+p.review_window_seconds*interval '1 second'<=now()) AS closed,
    (SELECT COALESCE(sum(held_nanos),0)::text FROM report_jobs j WHERE j.run_id=p.run_id AND j.funding='run_allowance') AS held
    FROM run_report_policies p JOIN runs r ON r.id=p.run_id WHERE p.run_id=$1`, [candidate.run_id])).rows[0];
  const existing = async () => (await db.query('SELECT id,state,reason FROM report_jobs WHERE candidate_id=$1 AND evidence_revision=$2', [candidateId, evidenceRevision])).rows[0];
  const found = await existing();
  if (found) return { id: found.id as string, state: found.state as ReportJobState, reason: found.reason as string | null, created: false };
  let state: ReportJobState = 'report_needed', reason: string | null = 'policy_disabled', amount = 0n;
  if (policy) {
    amount = perJob(policy.model, policy.price);
    if (policy.closed) reason = 'allowance_released';
    else if (BigInt(policy.held) + amount > BigInt(policy.allowance)) reason = 'allowance_exhausted';
    else { state = 'queued'; reason = null; }
  }
  const queued = state === 'queued';
  const inserted = (await db.query(`INSERT INTO report_jobs(id,run_id,candidate_id,evidence_revision,state,reason,funding,model,price,reserved_nanos,held_nanos)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) ON CONFLICT (candidate_id,evidence_revision) DO NOTHING RETURNING id`,
    [randomUUID(), candidate.run_id, candidateId, evidenceRevision, state, reason, queued ? 'run_allowance' : null, queued ? policy.model : null, queued ? policy.price : null, queued ? amount.toString() : '0'])).rows[0];
  if (inserted) return { id: inserted.id as string, state, reason, created: true };
  const raced = (await existing())!;
  return { id: raced.id as string, state: raced.state as ReportJobState, reason: raced.reason as string | null, created: false };
}

export class ReportJobStore {
  constructor(readonly pool: pg.Pool) {}
  private async tx<T>(work: (db: pg.PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try { await db.query('BEGIN'); const value = await work(db); await db.query('COMMIT'); return value; }
    catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }
  // Every mutation carries the generation it was leased under; a stale or expired generation always fails.
  private async leased(db: pg.PoolClient, id: string, generation: number) {
    const job = (await db.query("SELECT run_id,model,reserved_nanos::text AS reserved FROM report_jobs WHERE id=$1 AND lease_generation=$2 AND state='running' AND lease_until>now() FOR UPDATE", [id, generation])).rows[0];
    if (!job) throw new ReportLeaseLost();
    return job as { run_id: string; model: ModelAssignment; reserved: string };
  }
  enqueue(candidateId: string, evidenceRevision = 1) { return this.tx(db => enqueueReportJob(db, candidateId, evidenceRevision)); }
  // Fresh explicit authorization is the only way a report-needed job (no policy, released, or exhausted allowance) can run.
  authorize(id: string, grant: ReportGrant) {
    const model = modelAssignment.parse(grant.model);
    return this.tx(async db => {
      const job = (await db.query('SELECT state FROM report_jobs WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!job) return { status: 'not_found' as const };
      if (job.state !== 'report_needed') return { status: 'conflict' as const };
      if (grant.allowanceNanos < perJob(model, grant.price) || model.provider === 'ollama' && grant.allowanceNanos !== 0n) throw new Error('Authorization does not match one bounded Documentation call');
      await db.query("UPDATE report_jobs SET state='queued',reason=NULL,funding='explicit_authorization',model=$2,price=$3,reserved_nanos=$4,held_nanos=$4,authorized_at=now(),updated_at=now() WHERE id=$1", [id, model, model.provider === 'openrouter' ? grant.price : null, grant.allowanceNanos.toString()]);
      return { status: 'ok' as const };
    });
  }
  // Only a queued job is provably unused; a running job may already have dispatched.
  cancel(id: string) {
    return this.tx(async db => {
      const job = (await db.query('SELECT state FROM report_jobs WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!job) return { status: 'not_found' as const };
      return job.state === 'queued' ? { status: 'ok' as const, heldNanos: await terminalize(db, id, 'cancelled', 'operator_cancelled') } : { status: 'conflict' as const };
    });
  }
  cancelAllowance(runId: string) { return this.tx(db => releaseAllowance(db, runId, 'operator_cancelled')); }
  claim(owner: string): Promise<ClaimedReportJob | null> {
    return this.tx(async db => {
      const next = (await db.query(`SELECT j.id FROM report_jobs j JOIN runs r ON r.id=j.run_id LEFT JOIN run_report_policies p ON p.run_id=j.run_id
        WHERE j.state='queued' AND r.status='finished' AND (j.funding='explicit_authorization' OR (p.run_id IS NOT NULL AND r.finished_at+p.review_window_seconds*interval '1 second'>now()
          AND NOT EXISTS (SELECT 1 FROM report_allowance_releases x WHERE x.run_id=j.run_id)))
        ORDER BY j.created_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1`)).rows[0];
      if (!next) return null;
      const job = (await db.query(`UPDATE report_jobs j SET state='running',lease_owner=$2,lease_generation=lease_generation+1,lease_until=now()+interval '60 seconds',attempts=attempts+1,started_at=COALESCE(started_at,now()),updated_at=now()
        WHERE id=$1 RETURNING id,run_id,candidate_id,evidence_revision,lease_generation,attempts,model,price,reserved_nanos::text AS reserved,(SELECT definition->>'ollamaUrl' FROM runs WHERE id=j.run_id) AS ollama_url`, [next.id, owner])).rows[0];
      return { id: job.id, runId: job.run_id, candidateId: job.candidate_id, evidenceRevision: job.evidence_revision, generation: job.lease_generation, attempt: job.attempts, model: job.model, price: job.price, reservedNanos: BigInt(job.reserved), ...(job.ollama_url ? { ollamaUrl: job.ollama_url } : {}) };
    });
  }
  async heartbeat(id: string, generation: number) {
    const result = await this.pool.query("UPDATE report_jobs SET lease_until=now()+interval '60 seconds' WHERE id=$1 AND lease_generation=$2 AND state='running' AND lease_until>now()", [id, generation]);
    if (!result.rowCount) throw new ReportLeaseLost();
  }
  // The call always uses the job's snapshotted Documentation model and cannot exceed the job's transferred funds.
  reserveCall(id: string, generation: number, amount: bigint) {
    return this.tx(async db => {
      const job = await this.leased(db, id, generation);
      if (job.model.provider === 'openrouter') {
        if (amount <= 0n) throw new Error('Paid model has no bounded reserve');
        if ((await db.query("SELECT 1 FROM model_calls WHERE report_job_id=$1 AND provider='openrouter' AND status='unresolved' LIMIT 1", [id])).rowCount) throw new Error('Paid model billing unresolved');
        const total = (await db.query(`SELECT ${held}::text AS amount FROM model_calls WHERE report_job_id=$1 AND provider='openrouter'`, [id])).rows[0].amount;
        if (BigInt(total) + amount > BigInt(job.reserved)) throw new Error('Report allowance exhausted');
      }
      const callId = randomUUID();
      await db.query("INSERT INTO model_calls(id,run_id,role,provider,model,status,reserved_nanos,report_job_id) VALUES ($1,$2,'documentation',$3,$4,'reserved',$5,$6)", [callId, job.run_id, job.model.provider, job.model.model, job.model.provider === 'openrouter' ? amount.toString() : '0', id]);
      return callId;
    });
  }
  settleCall(id: string, generation: number, callId: string, usage?: ModelUsage) {
    return this.tx(async db => {
      await this.leased(db, id, generation);
      const call = (await db.query("SELECT provider,reserved_nanos FROM model_calls WHERE id=$1 AND report_job_id=$2 AND status='reserved' FOR UPDATE", [callId, id])).rows[0];
      if (!call) throw new Error('Call not reserved');
      const measured = usage?.chargeNanos;
      const resolved = !!usage && (call.provider === 'ollama' || measured !== null && measured !== undefined && BigInt(measured) <= BigInt(call.reserved_nanos));
      await db.query('UPDATE model_calls SET status=$2,charge_nanos=$3,input_tokens=$4,output_tokens=$5,latency_ms=$6,completed_at=now() WHERE id=$1', [callId, resolved ? 'settled' : 'unresolved', call.provider === 'ollama' ? null : measured ?? null, usage?.inputTokens ?? null, usage?.outputTokens ?? null, usage?.latencyMs ?? null]);
      return resolved;
    });
  }
  // `commit` runs inside the fenced transaction, so F01 can persist a draft atomically with completion.
  settle(id: string, generation: number, status: 'completed' | 'failed', reason?: string, commit?: (db: pg.PoolClient) => Promise<void>) {
    return this.tx(async db => {
      await this.leased(db, id, generation);
      await commit?.(db);
      return { state: status, heldNanos: await terminalize(db, id, status, status === 'failed' ? reason ?? 'failed' : null) };
    });
  }
  // Expired leases are fenced by a generation bump. A job requeues only with no ambiguous paid delivery.
  async sweep() {
    for (const row of (await this.pool.query("SELECT id FROM report_jobs WHERE state='running' AND lease_until<now()")).rows) await this.tx(async db => {
      const job = (await db.query("SELECT attempts FROM report_jobs WHERE id=$1 AND state='running' AND lease_until<now() FOR UPDATE", [row.id])).rows[0];
      if (!job) return;
      await db.query("UPDATE model_calls SET status='unresolved' WHERE report_job_id=$1 AND status='reserved'", [row.id]);
      const ambiguous = !!(await db.query("SELECT 1 FROM model_calls WHERE report_job_id=$1 AND provider='openrouter' AND status='unresolved' LIMIT 1", [row.id])).rowCount;
      if (!ambiguous && job.attempts < MAX_REPORT_ATTEMPTS) await db.query("UPDATE report_jobs SET state='queued',lease_generation=lease_generation+1,lease_until=NULL,lease_owner=NULL,updated_at=now() WHERE id=$1", [row.id]);
      else await terminalize(db, row.id, 'failed', ambiguous ? 'ambiguous_model_delivery' : 'lease_expired');
    });
    for (const row of (await this.pool.query(`SELECT p.run_id FROM run_report_policies p JOIN runs r ON r.id=p.run_id
      WHERE r.status='finished' AND r.finished_at+p.review_window_seconds*interval '1 second'<=now() AND NOT EXISTS (SELECT 1 FROM report_allowance_releases x WHERE x.run_id=p.run_id)`)).rows) await this.tx(db => releaseAllowance(db, row.run_id, 'review_window_expired'));
  }
  async accounting(runId: string) {
    const policy = (await this.pool.query(`SELECT p.model,p.allowance_nanos::text AS allowance,p.review_window_seconds AS "reviewWindowSeconds",
      r.finished_at+p.review_window_seconds*interval '1 second' AS "reviewExpiresAt",x.reason AS "releaseReason",x.released_at AS "releasedAt",x.unused_nanos::text AS "unusedAtRelease"
      FROM run_report_policies p JOIN runs r ON r.id=p.run_id LEFT JOIN report_allowance_releases x ON x.run_id=p.run_id WHERE p.run_id=$1`, [runId])).rows[0];
    const jobs = (await this.pool.query(`SELECT id,candidate_id AS "candidateId",evidence_revision AS "evidenceRevision",state,reason,funding,reserved_nanos::text AS "reservedNanos",held_nanos::text AS "heldNanos",attempts
      FROM report_jobs WHERE run_id=$1 ORDER BY created_at,id`, [runId])).rows as ReportJobView[];
    const heldNanos = jobs.filter(job => job.funding === 'run_allowance').reduce((sum, job) => sum + BigInt(job.heldNanos), 0n);
    const { allowance, ...rest } = policy ?? {};
    return { enabled: !!policy, policy: policy ? { ...rest, allowanceNanos: allowance as string } : null, heldNanos: heldNanos.toString(), unusedNanos: policy ? (BigInt(allowance) - heldNanos).toString() : '0', jobs };
  }
}
