import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { MAX_RECONCILE_MULTIPLE, MAX_RECONCILE_NANOS, type ReconcileInput, type SpendReconciliation, type SpendTotals, type UnresolvedCall } from '../../../packages/contracts/src/index.js';
import { nanos } from '../../worker/src/models.js';

// M02: paid spend whose billing is unknown stays held until an operator records evidence. Nothing here
// runs automatically and nothing releases a hold as a side effect of another action. Local inference has
// no price, so it never appears in a total, a list or a reconciliation.
export const maxReconcileCharge = (reservedNanos: bigint) => {
  const bound = reservedNanos * BigInt(MAX_RECONCILE_MULTIPLE), ceiling = BigInt(MAX_RECONCILE_NANOS);
  return bound < ceiling ? bound : ceiling;
};
const TERMINAL_JOB = ['completed', 'failed', 'cancelled'];
// The ledger rule shared with runs and report jobs: settled = charge, reserved/unresolved = reserve.
const held = "COALESCE(sum(CASE WHEN status='settled' THEN charge_nanos ELSE reserved_nanos END),0)";
export type ReconcileOutcome =
  | { status: 'ok' | 'replayed'; reconciliation: SpendReconciliation; call: { id: string; status: 'settled'; chargeNanos: string; reservedNanos: string; providerGenerationId: string | null } }
  | { status: 'not_found' }
  | { status: 'conflict'; reason: 'local_inference_unpriced' | 'not_unresolved' | 'already_reconciled' | 'idempotency_conflict' }
  | { status: 'invalid'; reason: 'charge_out_of_bounds' | 'charge_exceeds_report_funds'; maxChargeNanos: string };
type UsageRow = { provider: string; status: string; reservedNanos: string; chargeNanos: string | null; reconciled?: boolean };
const view = (row: Record<string, unknown>): SpendReconciliation => ({ id: row.id as string, callId: row.call_id as string, resolution: row.resolution as SpendReconciliation['resolution'], chargeNanos: row.charge as string,
  evidence: row.evidence as string, previousStatus: 'unresolved', previousReservedNanos: row.previous_reserved as string, previousChargeNanos: row.previous_charge as string | null, createdAt: (row.created_at as Date).toISOString() });
const RECONCILIATION = 'id,call_id,resolution,charge_nanos::text AS charge,evidence,previous_reserved_nanos::text AS previous_reserved,previous_charge_nanos::text AS previous_charge,created_at';

// Totals for one run's usage rows, from the same snapshot the rows came from.
export function totalsOf(rows: UsageRow[]): SpendTotals {
  const sum = { providerReportedNanos: 0n, operatorReconciledNanos: 0n, reservedNanos: 0n, unresolvedNanos: 0n };
  let unresolvedCalls = 0;
  for (const row of rows) {
    if (row.provider !== 'openrouter') continue;
    if (row.status === 'settled') sum[row.reconciled ? 'operatorReconciledNanos' : 'providerReportedNanos'] += BigInt(row.chargeNanos ?? 0);
    else if (row.status === 'reserved') sum.reservedNanos += BigInt(row.reservedNanos);
    else { sum.unresolvedNanos += BigInt(row.reservedNanos); unresolvedCalls++; }
  }
  return { providerReportedNanos: sum.providerReportedNanos.toString(), operatorReconciledNanos: sum.operatorReconciledNanos.toString(), reservedNanos: sum.reservedNanos.toString(), unresolvedNanos: sum.unresolvedNanos.toString(), unresolvedCalls };
}

export class SpendStore {
  constructor(readonly pool: pg.Pool) {}
  // Aggregated over every paid call (not only the bounded list), so totals are never a page artifact.
  async totals(): Promise<SpendTotals> {
    const row = (await this.pool.query(`SELECT
      COALESCE(sum(m.charge_nanos) FILTER (WHERE m.status='settled' AND x.id IS NULL),0)::text AS "providerReportedNanos",
      COALESCE(sum(m.charge_nanos) FILTER (WHERE m.status='settled' AND x.id IS NOT NULL),0)::text AS "operatorReconciledNanos",
      COALESCE(sum(m.reserved_nanos) FILTER (WHERE m.status='reserved'),0)::text AS "reservedNanos",
      COALESCE(sum(m.reserved_nanos) FILTER (WHERE m.status='unresolved'),0)::text AS "unresolvedNanos",
      (count(*) FILTER (WHERE m.status='unresolved'))::int AS "unresolvedCalls"
      FROM model_calls m LEFT JOIN spend_reconciliations x ON x.call_id=m.id WHERE m.provider='openrouter'`)).rows[0];
    return row as SpendTotals;
  }
  // Oldest first: the longest-held unknown charge is the most urgent. Truncation is explicit.
  async unresolved(limit: number) {
    const rows = (await this.pool.query(`SELECT c.id,c.run_id AS "runId",r.target_id AS "targetId",r.target_snapshot->>'name' AS "targetName",c.report_job_id AS "reportJobId",
      c.role,c.provider,c.model,c.reserved_nanos::text AS "reservedNanos",c.charge_nanos::text AS "reportedChargeNanos",c.provider_generation_id AS "providerGenerationId",
      c.created_at AS "createdAt",floor(extract(epoch FROM now()-c.created_at))::int AS "ageSeconds"
      FROM model_calls c JOIN runs r ON r.id=c.run_id WHERE c.status='unresolved' AND c.provider='openrouter' ORDER BY c.created_at,c.id LIMIT $1`, [limit + 1])).rows;
    const calls: UnresolvedCall[] = rows.slice(0, limit).map(row => ({ ...row, createdAt: row.createdAt.toISOString(), maxChargeNanos: maxReconcileCharge(BigInt(row.reservedNanos)).toString() }));
    return { v: 1 as const, totals: await this.totals(), calls, truncated: rows.length > limit, bounds: { maxChargeMultiple: MAX_RECONCILE_MULTIPLE, maxChargeNanos: MAX_RECONCILE_NANOS } as const };
  }

  // One transaction: parent lock (run, or policy then report job), call row lock, idempotency check, bounds,
  // append the attestation, settle the call, then recompute a terminal report job's hold with F00's rule.
  async reconcile(callId: string, input: ReconcileInput): Promise<ReconcileOutcome> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const outcome = await this.reconcileLocked(db, callId, input);
      await db.query(outcome.status === 'ok' ? 'COMMIT' : 'ROLLBACK');
      return outcome;
    } catch (error) {
      await db.query('ROLLBACK');
      // A concurrent request reusing the key for a different call loses on the unique index.
      if (error instanceof Error && 'code' in error && error.code === '23505' && 'constraint' in error && error.constraint === 'spend_reconciliations_idempotency_key_key') return { status: 'conflict', reason: 'idempotency_conflict' };
      throw error;
    } finally { db.release(); }
  }
  private async reconcileLocked(db: pg.PoolClient, callId: string, input: ReconcileInput): Promise<ReconcileOutcome> {
    const found = (await db.query('SELECT run_id,report_job_id FROM model_calls WHERE id=$1', [callId])).rows[0];
    if (!found) return { status: 'not_found' };
    // Lock order matches reserve/settle (runs) and enqueue/release (policy, then job) so nothing deadlocks.
    let job: { reserved: string; state: string } | undefined;
    if (found.report_job_id) {
      await db.query('SELECT 1 FROM run_report_policies WHERE run_id=$1 FOR UPDATE', [found.run_id]);
      job = (await db.query('SELECT reserved_nanos::text AS reserved,state FROM report_jobs WHERE id=$1 FOR UPDATE', [found.report_job_id])).rows[0];
    } else await db.query('SELECT 1 FROM runs WHERE id=$1 FOR UPDATE', [found.run_id]);
    const call = (await db.query('SELECT provider,status,reserved_nanos::text AS reserved,charge_nanos::text AS charge,provider_generation_id AS generation FROM model_calls WHERE id=$1 FOR UPDATE', [callId])).rows[0];
    const charge = input.resolution === 'confirmed_not_billed' ? 0n : nanos(input.chargeUsd!);
    const replay = (await db.query(`SELECT ${RECONCILIATION} FROM spend_reconciliations WHERE idempotency_key=$1`, [input.idempotencyKey])).rows[0];
    const shape = (row: Record<string, unknown>, status: 'ok' | 'replayed'): ReconcileOutcome => ({ status, reconciliation: view(row), call: { id: callId, status: 'settled', chargeNanos: row.charge as string, reservedNanos: call.reserved, providerGenerationId: call.generation } });
    if (replay) return replay.call_id === callId && replay.resolution === input.resolution && replay.charge === charge.toString() && replay.evidence === input.evidence ? shape(replay, 'replayed') : { status: 'conflict', reason: 'idempotency_conflict' };
    if (call.provider !== 'openrouter') return { status: 'conflict', reason: 'local_inference_unpriced' };
    if (call.status !== 'unresolved') return { status: 'conflict', reason: (await db.query('SELECT 1 FROM spend_reconciliations WHERE call_id=$1', [callId])).rowCount ? 'already_reconciled' : 'not_unresolved' };
    const bound = maxReconcileCharge(BigInt(call.reserved));
    if (charge > bound) return { status: 'invalid', reason: 'charge_out_of_bounds', maxChargeNanos: bound.toString() };
    if (job) {
      const others = (await db.query(`SELECT ${held}::text AS amount FROM model_calls WHERE report_job_id=$1 AND provider='openrouter' AND id<>$2`, [found.report_job_id, callId])).rows[0].amount;
      if (BigInt(others) + charge > BigInt(job.reserved)) return { status: 'invalid', reason: 'charge_exceeds_report_funds', maxChargeNanos: (BigInt(job.reserved) - BigInt(others) < bound ? BigInt(job.reserved) - BigInt(others) : bound).toString() };
    }
    const row = (await db.query(`INSERT INTO spend_reconciliations(id,call_id,previous_status,previous_reserved_nanos,previous_charge_nanos,resolution,charge_nanos,evidence,idempotency_key)
      VALUES ($1,$2,'unresolved',$3,$4,$5,$6,$7,$8) RETURNING ${RECONCILIATION}`, [randomUUID(), callId, call.reserved, call.charge, input.resolution, charge.toString(), input.evidence, input.idempotencyKey])).rows[0];
    await db.query("UPDATE model_calls SET status='settled',charge_nanos=$2 WHERE id=$1", [callId, charge.toString()]);
    // A running job keeps its transferred hold until terminalize; only a finished job's hold follows the settled charge.
    if (job && TERMINAL_JOB.includes(job.state)) await db.query(`UPDATE report_jobs SET held_nanos=(SELECT ${held} FROM model_calls WHERE report_job_id=$1 AND provider='openrouter'),updated_at=now() WHERE id=$1`, [found.report_job_id]);
    return shape(row, 'ok');
  }
}
