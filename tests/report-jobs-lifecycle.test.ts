import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database, seed, users } from './support.js';
import { createApp } from '../apps/api/src/app.js';
import { ReportLeaseLost } from '../apps/api/src/report-jobs.js';
import { legacyRoles, reserveAmount, type Snapshot } from '../apps/worker/src/models.js';
import { processNextReportJob } from '../apps/worker/src/report-jobs.js';

const local = { provider: 'ollama' as const, model: 'stub', maxOutputTokens: 64 };
const paid = { provider: 'openrouter' as const, model: 'fixture/docs', maxOutputTokens: 100 };
const price = { prompt: '0.000001', completion: '0.000002', request: '0.001', contextLength: 1000 };
const JOB = reserveAmount(price, 100);
const models: Snapshot = { roles: { judge: local }, pricing: { documentation: price } };
const usage = (chargeNanos: string) => ({ latencyMs: 5, inputTokens: 10, outputTokens: 5, chargeNanos });
type Db = Awaited<ReturnType<typeof database>>;
const policy = (jobs: number, reviewWindowMinutes = 30) => ({ model: paid, allowanceUsd: Number(JOB * BigInt(jobs)) / 1e9, reviewWindowMinutes });
const one = async (db: Db, sql: string, params: unknown[] = []) => (await db.repo.pool.query(sql, params)).rows[0];
const expireLease = (db: Db, id: string) => db.repo.pool.query("UPDATE report_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [id]);
const jobs = async (db: Db, runId: string) => (await db.repo.reports.accounting(runId)).jobs;

async function selected(db: Db, reportPolicy: ReturnType<typeof policy> | undefined, outcome: 'auto_confirm' | 'pending_review' = 'auto_confirm', cap = 1) {
  const { target, selected: selectedCase } = await seed(db.repo, 'http://target.fixture/', 'http://ollama.fixture/');
  const started = await db.repo.start({ targetId: target.id, caseId: selectedCase.id, roles: { judge: local }, ollamaUrl: 'http://ollama.fixture/', openRouterCapUsd: cap, ...(reportPolicy ? { reportPolicy } : {}) }, models);
  assert.ok(started && 'id' in started);
  const lease = (await db.repo.claim('execution'))!;
  await db.repo.finish(started.id, lease.lease_generation, outcome);
  return { runId: started.id, targetId: target.id, candidateId: (await one(db, 'SELECT id FROM candidates WHERE run_id=$1', [started.id])).id as string };
}
// A still-running adaptive run with n pending candidates; the run lease stays open so tests choose when it finishes.
async function adaptive(db: Db, count: number, reportPolicy: ReturnType<typeof policy>) {
  const target = await db.repo.target({ name: 'Adaptive report target', baseUrl: 'http://example.test/', ...users });
  const definition = { title: 'Seed', category: 'prompt_injection' as const, user: 'A' as const, expectedSafeBehavior: 'Keep the boundary', actions: [{ kind: 'chat_turn' as const, message: 'first' }] };
  const seedCase = await db.repo.createCase(definition);
  const started = await db.repo.startAdaptive({ targetId: target.id, caseIds: [seedCase.id], categories: ['prompt_injection'], maxCases: count, maxMinutes: 3, ollamaUrl: 'http://ollama.fixture/', roles: legacyRoles('stub'), openRouterCapUsd: 1, reportPolicy }, { roles: legacyRoles('stub'), pricing: { documentation: price } });
  assert.ok(started && 'id' in started);
  const lease = (await db.repo.claim('adaptive'))!;
  const candidates: string[] = [];
  for (let ordinal = 1; ordinal <= count; ordinal++) {
    const executionCase = await db.repo.beginAdaptiveCase(started.id, lease.lease_generation, ordinal, 'prompt_injection', seedCase.id);
    await db.repo.executeAdaptiveCase(started.id, lease.lease_generation, executionCase, definition);
    assert.equal(await db.repo.completeAdaptiveCase(started.id, lease.lease_generation, executionCase, 'pending_review', true), 'pending_review');
    candidates.push((await one(db, 'SELECT id FROM candidates WHERE adaptive_case_id=$1', [executionCase])).id);
  }
  return { runId: started.id, generation: lease.lease_generation, candidates, finish: () => db.repo.finish(started.id, lease.lease_generation, 'pending_review') };
}

test('runs without a policy stay report-disabled: report-needed, no funds, no handler call, no model row', async () => {
  const db = await database();
  const server = createApp(db.repo).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const { target, input } = await seed(db.repo, 'http://target.fixture/', 'http://ollama.fixture/');
    const started = await db.repo.start(input); // legacy `model` input carries a four-role Documentation assignment
    assert.ok(started && 'id' in started);
    await db.repo.finish(started.id, (await db.repo.claim('legacy'))!.lease_generation, 'auto_confirm');
    const accounting = await db.repo.reports.accounting(started.id);
    assert.equal(accounting.enabled, false);
    assert.deepEqual(accounting.jobs.map(({ id: _id, candidateId: _c, ...job }) => job), [{ evidenceRevision: 1, state: 'report_needed', reason: 'policy_disabled', funding: null, reservedNanos: '0', heldNanos: '0', attempts: 0 }]);
    let called = 0;
    assert.equal(await processNextReportJob(db.repo, 'w', async () => { called++; return { status: 'completed' }; }), null);
    assert.equal(called, 0);
    assert.equal((await one(db, 'SELECT count(*)::int AS n FROM model_calls')).n, 0);
    assert.equal((await one(db, 'SELECT count(*)::int AS n FROM run_report_policies')).n, 0);
    const port = (server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/runs/${started.id}/report-jobs`);
    assert.deepEqual(await response.json(), JSON.parse(JSON.stringify(accounting)));
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/runs/${target.id}/report-jobs`)).status, 404);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); }
});

test('policy is an immutable snapshot inside the run total; the allowance is not spendable by execution', async () => {
  const db = await database();
  try {
    const { target, selected: selectedCase } = await seed(db.repo, 'http://target.fixture/', 'http://ollama.fixture/');
    const input = { targetId: target.id, caseId: selectedCase.id, roles: { judge: local }, ollamaUrl: 'http://ollama.fixture/', openRouterCapUsd: 0.01 };
    await assert.rejects(db.repo.start({ ...input, reportPolicy: { model: paid, allowanceUsd: 0.001, reviewWindowMinutes: 30 } }, models), /below one bounded/);
    await assert.rejects(db.repo.start({ ...input, reportPolicy: policy(3) }, { roles: { judge: local }, pricing: {} }), /pricing required/);
    assert.equal((await db.repo.targets())[0].activeRunId, null, 'a rejected policy leaves no run or reservation behind');
    const started = await db.repo.start({ ...input, reportPolicy: policy(3) }, models);
    assert.ok(started && 'id' in started);
    const row = await one(db, 'SELECT model,price,allowance_nanos::text AS allowance,review_window_seconds AS window FROM run_report_policies WHERE run_id=$1', [started.id]);
    assert.deepEqual(row, { model: paid, price, allowance: (JOB * 3n).toString(), window: 1800 });
    await assert.rejects(db.repo.pool.query('UPDATE run_report_policies SET allowance_nanos=1 WHERE run_id=$1', [started.id]), /immutable/);
    await assert.rejects(db.repo.pool.query('DELETE FROM run_report_policies WHERE run_id=$1', [started.id]), /immutable/);
    const lease = (await db.repo.claim('execution'))!;
    // cap 10,000,000 minus allowance 6,600,000 leaves 3,400,000 for execution: one 2,200,000 call fits, two do not.
    await db.repo.reserveCall(started.id, lease.lease_generation, 'judge', 'openrouter', 'x', JOB);
    await assert.rejects(db.repo.reserveCall(started.id, lease.lease_generation, 'judge', 'openrouter', 'x', JOB), /Paid model budget exhausted/);
  } finally { await db.close(); }
});

test('duplicate confirmations and concurrent enqueues yield one job and one transfer per finding/evidence revision', async () => {
  const db = await database();
  try {
    const { runId, candidateId } = await selected(db, policy(3), 'pending_review');
    assert.deepEqual(await jobs(db, runId), [], 'an unconfirmed candidate has no job');
    await assert.rejects(db.repo.reports.enqueue(candidateId), /confirmed/);
    assert.deepEqual(await Promise.all([db.repo.review(candidateId, 'confirm'), db.repo.review(candidateId, 'confirm')]), [{ id: candidateId, state: 'confirmed' }, { id: candidateId, state: 'confirmed' }]);
    const results = await Promise.all(Array.from({ length: 6 }, () => db.repo.reports.enqueue(candidateId)));
    assert.equal(new Set(results.map(result => result.id)).size, 1);
    assert.equal(results.filter(result => result.created).length, 0);
    let accounting = await db.repo.reports.accounting(runId);
    assert.equal(accounting.jobs.length, 1);
    assert.deepEqual([accounting.jobs[0].state, accounting.jobs[0].reservedNanos, accounting.heldNanos], ['queued', JOB.toString(), JOB.toString()]);
    const revision = await db.repo.reports.enqueue(candidateId, 2);
    assert.deepEqual([revision.created, revision.state], [true, 'queued']);
    await assert.rejects(db.repo.reports.enqueue(candidateId, 0), /Invalid evidence revision/);
    accounting = await db.repo.reports.accounting(runId);
    assert.equal(accounting.heldNanos, (JOB * 2n).toString());
    assert.equal(accounting.unusedNanos, JOB.toString());
  } finally { await db.close(); }
});

test('aggregate jobs cannot exceed the held allowance; an exhausted job needs explicit authorization', async () => {
  const db = await database();
  try {
    const run = await adaptive(db, 4, policy(2));
    await Promise.all(run.candidates.map(id => db.repo.review(id, 'confirm')));
    const accounting = await db.repo.reports.accounting(run.runId);
    assert.deepEqual(accounting.jobs.map(job => [job.state, job.reason]).sort(), [['queued', null], ['queued', null], ['report_needed', 'allowance_exhausted'], ['report_needed', 'allowance_exhausted']]);
    assert.equal(accounting.heldNanos, (JOB * 2n).toString());
    assert.equal(accounting.unusedNanos, '0');
    const queued = accounting.jobs.find(job => job.state === 'queued')!, needed = accounting.jobs.find(job => job.state === 'report_needed')!;
    assert.deepEqual(await db.repo.reports.cancel(queued.id), { status: 'ok', heldNanos: '0' });
    // Freed funds are not silently reassigned: an existing report-needed job is only funded by explicit authorization.
    assert.deepEqual((await db.repo.reports.enqueue(needed.candidateId)).created, false);
    assert.equal((await db.repo.reports.accounting(run.runId)).jobs.find(job => job.id === needed.id)!.state, 'report_needed');
    assert.equal((await db.repo.reports.accounting(run.runId)).heldNanos, JOB.toString());
    await run.finish();
  } finally { await db.close(); }
});

test('evaluation completion releases the target while report accounting and the finished run lease stay intact', async () => {
  const db = await database();
  try {
    const { runId, targetId } = await selected(db, policy(3));
    assert.equal((await db.repo.targets()).find(target => target.id === targetId).activeRunId, null);
    assert.equal((await db.repo.reports.accounting(runId)).heldNanos, JOB.toString());
    const next = await db.repo.start({ targetId, caseId: (await db.repo.cases())[0].id, model: 'stub', ollamaUrl: 'http://ollama.fixture/' });
    assert.ok(next && 'id' in next, 'target is reusable while the earlier run still holds report funds');
    const runLease = () => one(db, 'SELECT status,outcome,lease_generation,lease_owner,lease_until,finished_at FROM runs WHERE id=$1', [runId]);
    const before = await runLease();
    await db.repo.pool.query('CREATE TABLE report_scratch(job_id uuid PRIMARY KEY)');
    const result = await processNextReportJob(db.repo, 'report-worker', async ctx => {
      const call = await ctx.reserveCall(JOB);
      assert.equal(await ctx.settleCall(call, usage('1000000')), true);
      return { status: 'completed', commit: async tx => { await tx.query('INSERT INTO report_scratch(job_id) VALUES ($1)', [ctx.job.id]); } };
    });
    assert.deepEqual(result && result.state, 'completed');
    assert.deepEqual(await runLease(), before, 'report claim and settlement never reopen or reuse the execution lease');
    assert.equal((await one(db, 'SELECT count(*)::int AS n FROM report_scratch')).n, 1);
    const accounting = await db.repo.reports.accounting(runId);
    assert.deepEqual([accounting.jobs[0].state, accounting.jobs[0].heldNanos, accounting.heldNanos, accounting.unusedNanos], ['completed', '1000000', '1000000', (JOB * 3n - 1_000_000n).toString()]);
    const calls = await db.repo.usage(runId);
    assert.deepEqual(calls.map(call => [call.role, call.provider, call.status, call.chargeNanos]), [['documentation', 'openrouter', 'settled', '1000000']]);
  } finally { await db.close(); }
});

test('report jobs cannot be claimed before their run has finished', async () => {
  const db = await database();
  try {
    const run = await adaptive(db, 1, policy(2));
    await db.repo.review(run.candidates[0], 'confirm');
    assert.equal((await jobs(db, run.runId))[0].state, 'queued');
    assert.equal(await db.repo.reports.claim('early'), null);
    await run.finish();
    assert.ok(await db.repo.reports.claim('after-finish'));
  } finally { await db.close(); }
});

test('lease loss cannot heartbeat, reserve, settle or complete another generation', async () => {
  const db = await database();
  try {
    const { runId } = await selected(db, policy(3));
    const first = (await db.repo.reports.claim('worker-1'))!;
    assert.equal(first.attempt, 1);
    assert.equal(await db.repo.reports.claim('worker-2'), null, 'a leased job is claimed by one worker');
    const staleCall = await db.repo.reports.reserveCall(first.id, first.generation, JOB / 2n);
    await db.repo.reports.settleCall(first.id, first.generation, staleCall, usage('0'));
    await expireLease(db, first.id);
    await assert.rejects(db.repo.reports.heartbeat(first.id, first.generation), ReportLeaseLost);
    await db.repo.reports.sweep();
    assert.equal((await jobs(db, runId))[0].state, 'queued', 'settled work and no ambiguity: same job is requeued, not duplicated');
    const second = (await db.repo.reports.claim('worker-2'))!;
    assert.deepEqual([second.id, second.attempt, second.generation > first.generation], [first.id, 2, true]);
    for (const attempt of [() => db.repo.reports.heartbeat(first.id, first.generation), () => db.repo.reports.reserveCall(first.id, first.generation, 1n),
      () => db.repo.reports.settleCall(first.id, first.generation, staleCall, usage('0')), () => db.repo.reports.settle(first.id, first.generation, 'completed')]) await assert.rejects(attempt(), ReportLeaseLost);
    assert.equal((await jobs(db, runId))[0].state, 'running');
    await db.repo.reports.heartbeat(second.id, second.generation);
    assert.equal((await db.repo.reports.settle(second.id, second.generation, 'completed')).state, 'completed');
    assert.equal((await jobs(db, runId)).length, 1);
    await assert.rejects(db.repo.reports.settle(second.id, second.generation, 'failed'), ReportLeaseLost, 'a terminal job cannot be re-settled');
  } finally { await db.close(); }
});

test('lease attempts are bounded, and an expired lease with an in-flight paid call stays held and never retries', async () => {
  const db = await database();
  try {
    const { runId } = await selected(db, policy(3));
    for (let attempt = 1; attempt <= 3; attempt++) {
      const claimed = (await db.repo.reports.claim('flaky'))!;
      assert.equal(claimed.attempt, attempt);
      await expireLease(db, claimed.id);
      await db.repo.reports.sweep();
    }
    assert.deepEqual([(await jobs(db, runId))[0].state, (await jobs(db, runId))[0].reason, (await jobs(db, runId))[0].heldNanos], ['failed', 'lease_expired', '0']);

    const other = await selected(db, policy(3));
    const claimed = (await db.repo.reports.claim('crashy'))!;
    const call = await db.repo.reports.reserveCall(claimed.id, claimed.generation, JOB);
    await expireLease(db, claimed.id);
    await db.repo.reports.sweep();
    const [job] = await jobs(db, other.runId);
    assert.deepEqual([job.state, job.reason, job.heldNanos], ['failed', 'ambiguous_model_delivery', JOB.toString()]);
    assert.equal((await one(db, 'SELECT status FROM model_calls WHERE id=$1', [call])).status, 'unresolved');
    await assert.rejects(db.repo.reports.settleCall(claimed.id, claimed.generation, call, usage('0')), ReportLeaseLost, 'a late worker cannot zero-settle an in-flight charge');
    assert.equal((await db.repo.reports.accounting(other.runId)).heldNanos, JOB.toString());
  } finally { await db.close(); }
});

test('job calls are bounded by the transferred funds; unknown or over-reserve charges stay unresolved and held', async () => {
  const db = await database();
  try {
    const { runId } = await selected(db, policy(3));
    const job = (await db.repo.reports.claim('worker'))!;
    await assert.rejects(db.repo.reports.reserveCall(job.id, job.generation, 0n), /no bounded reserve/);
    await assert.rejects(db.repo.reports.reserveCall(job.id, job.generation, JOB + 1n), /allowance exhausted/);
    const first = await db.repo.reports.reserveCall(job.id, job.generation, JOB - 100n);
    await assert.rejects(db.repo.reports.reserveCall(job.id, job.generation, 101n), /allowance exhausted/, 'reserved calls count against the job ceiling');
    assert.equal(await db.repo.reports.settleCall(job.id, job.generation, first, usage(String(JOB))), false, 'a charge above its reserve cannot be treated as settled');
    await assert.rejects(db.repo.reports.reserveCall(job.id, job.generation, 1n), /billing unresolved/);
    assert.equal((await db.repo.reports.settle(job.id, job.generation, 'failed', 'provider_charge_unresolved')).heldNanos, (JOB - 100n).toString());
    assert.equal((await db.repo.reports.accounting(runId)).heldNanos, (JOB - 100n).toString());
    const unknown = await selected(db, policy(3));
    const second = (await db.repo.reports.claim('worker'))!;
    const call = await db.repo.reports.reserveCall(second.id, second.generation, JOB);
    assert.equal(await db.repo.reports.settleCall(second.id, second.generation, call, undefined), false, 'no provider usage means ambiguous delivery');
    assert.equal((await db.repo.reports.settle(second.id, second.generation, 'completed')).heldNanos, JOB.toString());
    assert.equal((await db.repo.reports.accounting(unknown.runId)).heldNanos, JOB.toString());
  } finally { await db.close(); }
});

test('review-window expiry releases only provably unused funds; late confirmation needs fresh explicit authorization', async () => {
  const db = await database();
  try {
    const run = await adaptive(db, 4, policy(3));
    await Promise.all(run.candidates.slice(0, 3).map(id => db.repo.review(id, 'confirm')));
    await run.finish();
    const order = (await db.repo.reports.accounting(run.runId)).jobs.map(job => job.id);
    const a = (await db.repo.reports.claim('worker'))!;
    assert.equal(a.id, order[0]);
    await db.repo.reports.settleCall(a.id, a.generation, await db.repo.reports.reserveCall(a.id, a.generation, JOB), usage('1000000'));
    await db.repo.reports.settle(a.id, a.generation, 'completed');
    const b = (await db.repo.reports.claim('worker'))!;
    assert.equal(b.id, order[1]);
    await db.repo.reports.reserveCall(b.id, b.generation, JOB); // dispatched, never settled
    await db.repo.reports.settle(b.id, b.generation, 'failed', 'handler_error');
    await db.repo.pool.query("UPDATE runs SET finished_at=now()-interval '31 minutes' WHERE id=$1", [run.runId]);
    await db.repo.reports.sweep();
    const accounting = await db.repo.reports.accounting(run.runId);
    const states = Object.fromEntries(accounting.jobs.map(job => [job.id, [job.state, job.heldNanos]]));
    assert.deepEqual([states[order[0]], states[order[1]], states[order[2]]], [['completed', '1000000'], ['failed', JOB.toString()], ['cancelled', '0']]);
    assert.equal(accounting.policy!.releaseReason, 'review_window_expired');
    assert.equal(accounting.policy!.unusedAtRelease, (JOB * 3n - 1_000_000n - JOB).toString());
    assert.equal(accounting.heldNanos, (1_000_000n + JOB).toString(), 'settled charge and the unresolved reserve remain held');
    await db.repo.reports.sweep();
    assert.equal((await one(db, 'SELECT count(*)::int AS n FROM report_allowance_releases')).n, 1, 'release is idempotent');

    await db.repo.review(run.candidates[3], 'confirm');
    const [late] = (await jobs(db, run.runId)).filter(job => job.candidateId === run.candidates[3]);
    assert.deepEqual([late.state, late.reason, late.heldNanos, late.funding], ['report_needed', 'allowance_released', '0', null]);
    assert.equal(await db.repo.reports.claim('worker'), null);
    await assert.rejects(db.repo.reports.authorize(late.id, { model: paid, price, allowanceNanos: JOB - 1n }), /does not match/);
    assert.deepEqual(await db.repo.reports.authorize(late.id, { model: paid, price, allowanceNanos: JOB }), { status: 'ok' });
    assert.deepEqual(await db.repo.reports.authorize(late.id, { model: paid, price, allowanceNanos: JOB }), { status: 'conflict' });
    const explicit = (await db.repo.reports.claim('worker'))!;
    assert.deepEqual([explicit.id, explicit.reservedNanos], [late.id, JOB]);
    assert.equal((await db.repo.reports.accounting(run.runId)).heldNanos, (1_000_000n + JOB).toString(), 'explicit authorization is separate from the released run allowance');
  } finally { await db.close(); }
});

test('cancelling a queued run or the allowance releases unused funds but never an in-flight job', async () => {
  const db = await database();
  try {
    const { target, selected: selectedCase } = await seed(db.repo, 'http://target.fixture/', 'http://ollama.fixture/');
    const queued = await db.repo.start({ targetId: target.id, caseId: selectedCase.id, roles: { judge: local }, ollamaUrl: 'http://ollama.fixture/', openRouterCapUsd: 1, reportPolicy: policy(2) }, models);
    assert.ok(queued && 'id' in queued);
    await db.repo.stop(queued.id);
    const cancelled = await db.repo.reports.accounting(queued.id);
    assert.deepEqual([cancelled.policy!.releaseReason, cancelled.policy!.unusedAtRelease], ['run_cancelled', (JOB * 2n).toString()]);

    const run = await adaptive(db, 2, policy(2));
    await Promise.all(run.candidates.map(id => db.repo.review(id, 'confirm')));
    await run.finish();
    const running = (await db.repo.reports.claim('worker'))!;
    const call = await db.repo.reports.reserveCall(running.id, running.generation, JOB);
    const idle = (await jobs(db, run.runId)).find(job => job.state === 'queued')!;
    assert.deepEqual(await db.repo.reports.cancel(running.id), { status: 'conflict' });
    assert.equal(await db.repo.reports.cancelAllowance(run.runId), true);
    assert.equal(await db.repo.reports.cancelAllowance(run.runId), false);
    const accounting = await db.repo.reports.accounting(run.runId);
    assert.deepEqual([accounting.jobs.find(job => job.id === idle.id)!.state, accounting.jobs.find(job => job.id === running.id)!.state], ['cancelled', 'running']);
    assert.deepEqual([accounting.policy!.releaseReason, accounting.policy!.unusedAtRelease, accounting.heldNanos], ['operator_cancelled', JOB.toString(), JOB.toString()]);
    assert.equal(await db.repo.reports.settleCall(running.id, running.generation, call, undefined), false);
    assert.equal((await db.repo.reports.settle(running.id, running.generation, 'failed', 'cancelled')).heldNanos, JOB.toString());
  } finally { await db.close(); }
});

test('worker handler interface: settle on success or failure, unresolved on throw, lease loss, and no claim without a handler', async () => {
  const db = await database();
  try {
    const first = await selected(db, policy(3)), second = await selected(db, policy(3)), third = await selected(db, policy(3));
    assert.equal(await processNextReportJob(db.repo, 'no-handler', null), null);
    assert.equal((await jobs(db, first.runId))[0].state, 'queued', 'a worker without a Documentation handler leaves jobs queued and unspent');
    const seen: unknown[] = [];
    assert.deepEqual(await processNextReportJob(db.repo, 'w', async ctx => { seen.push(ctx.job.model, ctx.job.reservedNanos, ctx.job.ollamaUrl, ctx.signal.aborted); return { status: 'failed', reason: 'validation_rejected' }; }), { id: (await jobs(db, first.runId))[0].id, state: 'failed' });
    assert.deepEqual(seen, [paid, JOB, 'http://ollama.fixture/', false]);
    assert.deepEqual([(await jobs(db, first.runId))[0].reason, (await jobs(db, first.runId))[0].heldNanos], ['validation_rejected', '0']);
    const thrown = await processNextReportJob(db.repo, 'w', async ctx => { await ctx.reserveCall(JOB); throw new Error('provider exploded'); });
    assert.equal(thrown && thrown.state, 'failed');
    const [afterThrow] = await jobs(db, second.runId);
    assert.deepEqual([afterThrow.reason, afterThrow.heldNanos], ['handler_error', JOB.toString()]);
    assert.equal((await one(db, 'SELECT status FROM model_calls WHERE report_job_id=$1', [afterThrow.id])).status, 'unresolved');
    const lost = await processNextReportJob(db.repo, 'w', async ctx => { await expireLease(db, ctx.job.id); return { status: 'completed', commit: async () => { throw new Error('must not run'); } }; });
    assert.equal(lost && lost.state, 'lease_lost');
    assert.equal((await jobs(db, third.runId))[0].state, 'running', 'only the sweeper decides an expired lease');
    const recovered = await processNextReportJob(db.repo, 'w', async () => ({ status: 'completed' }));
    assert.deepEqual(recovered && recovered.state, 'completed', 'the next sweep requeues the expired job under a new generation and the same job id');
    assert.equal((await one(db, 'SELECT attempts FROM report_jobs WHERE id=$1', [(await jobs(db, third.runId))[0].id])).attempts, 2);
  } finally { await db.close(); }
});

test('scheduled runs snapshot the report policy at dispatch, and a schedule needs the Documentation price', async () => {
  const db = await database();
  try {
    const { target, selected: selectedCase } = await seed(db.repo, 'http://target.fixture/', 'http://ollama.fixture/');
    const input = { targetId: target.id, caseId: selectedCase.id, roles: { judge: local }, ollamaUrl: 'http://ollama.fixture/', openRouterCapUsd: 0.01, reportPolicy: policy(3) };
    const definition = { name: 'Reported daily', cadence: 'daily' as const, hour: 9, minute: 0, zone: 'UTC', run: { kind: 'selected' as const, input } };
    const now = new Date('2026-09-29T00:00:00Z');
    await assert.rejects(db.repo.saveSchedule(definition, { roles: { judge: local }, pricing: {} }, now), /pricing/);
    assert.ok(await db.repo.saveSchedule(definition, models, now));
    const [fired] = await db.repo.tick(new Date('2026-09-29T09:00:01Z'));
    assert.equal(fired.state, 'queued');
    const accounting = await db.repo.reports.accounting(fired.runId!);
    assert.deepEqual([accounting.enabled, accounting.policy!.allowanceNanos, accounting.policy!.reviewWindowSeconds], [true, (JOB * 3n).toString(), 1800]);
    assert.equal((await one(db, 'SELECT price FROM run_report_policies WHERE run_id=$1', [fired.runId])).price.contextLength, price.contextLength);
  } finally { await db.close(); }
});
