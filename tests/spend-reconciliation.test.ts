import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { database, seed } from './support.js';
import { createApp } from '../apps/api/src/app.js';
import { maxReconcileCharge } from '../apps/api/src/spend.js';
import { callRoleJson, reserveAmount, type ModelUsage, type Snapshot } from '../apps/worker/src/models.js';
import { processNextReportJob } from '../apps/worker/src/report-jobs.js';
import { reconcileInput, reconcileResult, spendTotals, unresolvedSpendReport } from '../packages/contracts/src/index.js';

type Db = Awaited<ReturnType<typeof database>>;
const judge = { provider: 'openrouter' as const, model: 'fixture/paid', maxOutputTokens: 64 };
const docs = { provider: 'openrouter' as const, model: 'fixture/docs', maxOutputTokens: 100 };
const local = { provider: 'ollama' as const, model: 'stub', maxOutputTokens: 64 };
const price = { prompt: '0.000001', completion: '0.000002', request: '0', contextLength: 1000 };
const docsPrice = { ...price, request: '0.001' };
const JOB = reserveAmount(docsPrice, 100);
const models: Snapshot = { roles: { judge }, pricing: { judge: price } };
const evidence = 'OpenRouter activity export row gen-0001, 2026-09-29';
const key = () => `key-${randomUUID()}`;
const body = (over: Record<string, unknown> = {}) => ({ resolution: 'settled_by_operator', chargeUsd: '0.0025', evidence, idempotencyKey: key(), ...over });
const one = async (db: Db, sql: string, params: unknown[] = []) => (await db.repo.pool.query(sql, params)).rows[0];

// A running paid run whose lease stays open. `usage` undefined leaves the call unresolved, exactly as the worker does.
async function paidRun(db: Db, cap = 1) {
  const { input } = await seed(db.repo, 'http://target.fixture/', 'http://ollama.fixture/');
  const started = await db.repo.start({ targetId: input.targetId, caseId: input.caseId, roles: { judge }, openRouterCapUsd: cap }, models);
  assert.ok(started && 'id' in started);
  const lease = (await db.repo.claim('spend'))!;
  return { runId: started.id, generation: lease.lease_generation, reserve: (amount: bigint, provider: 'openrouter' | 'ollama' = 'openrouter') => db.repo.reserveCall(started.id, lease.lease_generation, 'judge', provider, provider === 'ollama' ? 'stub' : judge.model, amount),
    settle: (callId: string, usage?: ModelUsage) => db.repo.settleCall(started.id, lease.lease_generation, callId, usage) };
}
async function unresolved(db: Db, reserve = 2_000_000n, usage: ModelUsage | undefined = undefined) {
  const run = await paidRun(db);
  const callId = await run.reserve(reserve);
  assert.equal(await run.settle(callId, usage), false);
  return { ...run, callId };
}
async function serve(db: Db) {
  const server = createApp(db.repo).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (path: string, init?: RequestInit) => { const response = await fetch(base + path, init); return { status: response.status, body: await response.json() as any }; };
  return { get: (path: string) => call(path), post: (path: string, payload: unknown) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
    reconcile: (callId: string, payload: unknown) => call(`/api/spend/calls/${callId}/reconcile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
    close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
async function withApi(work: (db: Db, api: Awaited<ReturnType<typeof serve>>) => Promise<void>) {
  const db = await database(), api = await serve(db);
  try { await work(db, api); } finally { await api.close(); await db.close(); }
}

test('a paid response id is kept only when bounded, and never for local inference', async () => {
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'fixture-only-key';
  const respond = (id: unknown, usage: Record<string, unknown>): typeof fetch => async () => new Response(JSON.stringify({ id, choices: [{ message: { content: '{}' } }], usage }), { status: 200 });
  const paid = (id: unknown, usage: Record<string, unknown> = { prompt_tokens: 3, completion_tokens: 2 }) => callRoleJson(judge, [], undefined, respond(id, usage), price).then(call => call.usage);
  try {
    assert.equal((await paid('gen-1a2B3c')).generationId, 'gen-1a2B3c');
    assert.equal((await paid('gen-1a2B3c', { cost: 0.0004 })).chargeNanos, '400000');
    for (const hostile of ['has space', 'x'.repeat(201), '', 42, null, 'line\nbreak', 'gén-unicode']) assert.equal('generationId' in await paid(hostile), false, JSON.stringify(hostile));
    const ollama: typeof fetch = async () => new Response(JSON.stringify({ id: 'gen-local', message: { content: '{}' }, prompt_eval_count: 4, eval_count: 2 }), { status: 200 });
    assert.equal('generationId' in (await callRoleJson(local, [], 'http://ollama.test/', ollama)).usage, false);
  } finally { if (previous === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previous; }
});

test('reservations, provider-reported, operator-reconciled and unresolved totals stay separate and local is never priced', () => withApi(async (db, api) => {
  const first = await paidRun(db);
  await first.settle(await first.reserve(2_000_000n), { latencyMs: 5, chargeNanos: '1500000', generationId: 'gen-reported' });
  const unknown = await first.reserve(3_000_000n);
  assert.equal(await first.settle(unknown, { latencyMs: 9, chargeNanos: null, generationId: 'gen-unknown' }), false);
  await assert.rejects(first.reserve(1n), /billing unresolved/);
  const second = await paidRun(db);
  await second.reserve(4_000_000n); // in flight: a reservation, neither reported nor unresolved
  const { runId: localRun } = await (async () => {
    const { input } = await seed(db.repo, 'http://target.fixture/', 'http://ollama.fixture/');
    const started = await db.repo.start(input); assert.ok(started && 'id' in started);
    const lease = (await db.repo.claim('local'))!;
    const call = await db.repo.reserveCall(started.id, lease.lease_generation, 'judge', 'ollama', 'stub', 0n);
    await db.repo.settleCall(started.id, lease.lease_generation, call, { latencyMs: 3, chargeNanos: '999', generationId: 'gen-must-not-stick' });
    return { runId: started.id };
  })();

  const report = unresolvedSpendReport.parse((await api.get('/api/spend/unresolved')).body);
  assert.deepEqual(report.totals, { providerReportedNanos: '1500000', operatorReconciledNanos: '0', reservedNanos: '4000000', unresolvedNanos: '3000000', unresolvedCalls: 1 });
  assert.deepEqual(report.calls.map(call => [call.id, call.runId, call.role, call.provider, call.model, call.reservedNanos, call.reportedChargeNanos, call.providerGenerationId, call.maxChargeNanos, call.targetName, call.reportJobId]),
    [[unknown, first.runId, 'judge', 'openrouter', judge.model, '3000000', null, 'gen-unknown', '30000000', 'Synthetic target', null]]);
  assert.deepEqual([report.truncated, report.bounds], [false, { maxChargeMultiple: 10, maxChargeNanos: '100000000000' }]);
  assert.equal(report.calls.every(call => typeof call.reservedNanos === 'string'), true);

  const local = (await db.repo.usage(localRun))[0];
  assert.deepEqual([local.provider, local.chargeNanos, local.providerGenerationId], ['ollama', null, null], 'local inference gets no price and no generation reference');
  // The default usage response is still the plain call array, now with the reference; totals are opt-in.
  const plain = (await api.get(`/api/runs/${first.runId}/usage`)).body;
  assert.equal(Array.isArray(plain), true);
  assert.deepEqual(plain.map((call: any) => [call.status, call.chargeNanos, call.providerGenerationId, call.reconciled]), [['settled', '1500000', 'gen-reported', false], ['unresolved', null, 'gen-unknown', false]]);
  const wrapped = (await api.get(`/api/runs/${first.runId}/usage?include=totals`)).body;
  assert.equal(wrapped.v, 1);
  assert.deepEqual(spendTotals.parse(wrapped.totals), { providerReportedNanos: '1500000', operatorReconciledNanos: '0', reservedNanos: '0', unresolvedNanos: '3000000', unresolvedCalls: 1 });
  assert.equal(spendTotals.parse((await api.get(`/api/runs/${second.runId}/usage?include=totals`)).body.totals).reservedNanos, '4000000');
  assert.equal((await api.get(`/api/runs/${localRun}/usage?include=totals`)).body.totals.providerReportedNanos, '0');
  assert.equal((await api.get('/api/spend/unresolved?limit=0')).status, 400);
  assert.equal((await api.get('/api/spend/unresolved?limit=101')).status, 400);

  const done = await api.reconcile(unknown, body({ chargeUsd: '0.002' }));
  assert.equal(done.status, 201);
  const after = unresolvedSpendReport.parse((await api.get('/api/spend/unresolved')).body);
  assert.deepEqual(after.totals, { providerReportedNanos: '1500000', operatorReconciledNanos: '2000000', reservedNanos: '4000000', unresolvedNanos: '0', unresolvedCalls: 0 });
  assert.deepEqual(after.calls, []);
  assert.deepEqual((await api.get(`/api/runs/${first.runId}/usage`)).body.map((call: any) => call.reconciled), [false, true]);
}));

test('unresolved list is bounded and oldest first, with explicit truncation', () => withApi(async (db, api) => {
  const calls = [await unresolved(db, 1_000_000n), await unresolved(db, 2_000_000n), await unresolved(db, 3_000_000n)];
  const ages = [30, 20, 10];
  for (const [index, call] of calls.entries()) await db.repo.pool.query(`UPDATE model_calls SET created_at=now()-($2 * interval '1 second') WHERE id=$1`, [call.callId, ages[index]]);
  const page = unresolvedSpendReport.parse((await api.get('/api/spend/unresolved?limit=2')).body);
  assert.deepEqual(page.calls.map(call => call.id), [calls[0].callId, calls[1].callId]);
  assert.equal(page.truncated, true);
  assert.equal(page.totals.unresolvedCalls, 3, 'totals cover every unresolved call, not just the page');
  assert.equal(page.totals.unresolvedNanos, '6000000');
  assert.ok(page.calls[0].ageSeconds >= 30 && page.calls[0].ageSeconds < 300);
  assert.equal(unresolvedSpendReport.parse((await api.get('/api/spend/unresolved')).body).truncated, false);
}));

test('reconciliation is evidence-backed, bounded, idempotent and exactly once; unknown billing stays held until then', () => withApi(async (db, api) => {
  const target = await unresolved(db, 2_000_000n, { latencyMs: 4, chargeNanos: '2500000', generationId: 'gen-over-reserve' }); // provider reported more than the reserve
  const row = () => one(db, 'SELECT status,charge_nanos::text AS charge,reserved_nanos::text AS reserved FROM model_calls WHERE id=$1', [target.callId]);
  const count = async () => (await one(db, 'SELECT count(*)::int AS n FROM spend_reconciliations')).n as number;
  assert.deepEqual(await row(), { status: 'unresolved', charge: '2500000', reserved: '2000000' });

  const invalid: [string, Record<string, unknown>][] = [
    ['missing evidence', { evidence: undefined }], ['blank evidence', { evidence: '   ' }], ['control character', { evidence: 'line\nbreak' }], ['bidi override', { evidence: 'invoice ‮gnp' }], ['evidence over 500', { evidence: 'x'.repeat(501) }],
    ['short key', { idempotencyKey: 'short' }], ['key characters', { idempotencyKey: 'has spaces in it' }], ['no charge', { chargeUsd: undefined }], ['zero charge', { chargeUsd: '0' }],
    ['negative', { chargeUsd: '-0.001' }], ['exponent', { chargeUsd: '1e-7' }], ['ten decimals', { chargeUsd: '0.0000000001' }], ['not a number', { chargeUsd: 'free' }],
    ['unknown resolution', { resolution: 'released' }], ['not-billed with a charge', { resolution: 'confirmed_not_billed' }], ['unknown field', { operator: 'me' }], ['bad envelope', { resolution: undefined }]];
  for (const [label, over] of invalid) assert.equal((await api.reconcile(target.callId, body(over))).status, 400, label);
  const tooMuch = await api.reconcile(target.callId, body({ chargeUsd: '0.020000001' })); // ceiling is 10 x 2,000,000 nanos
  assert.deepEqual([tooMuch.status, tooMuch.body.code, tooMuch.body.reason, tooMuch.body.maxChargeNanos], [400, 'invalid', 'charge_out_of_bounds', '20000000']);
  assert.deepEqual(await row(), { status: 'unresolved', charge: '2500000', reserved: '2000000' }, 'rejected attempts change nothing');
  assert.equal(await count(), 0);
  await assert.rejects(target.reserve(1_000_000n), /billing unresolved/, 'the hold is not released by anything but recorded evidence');
  assert.equal((await api.reconcile('not-a-uuid', body())).status, 400);
  assert.equal((await api.reconcile(randomUUID(), body())).status, 404);

  const request = body({ chargeUsd: 0.0025 }); // a JSON number is accepted and normalized to the same nanos
  const created = await api.reconcile(target.callId, request);
  assert.equal(created.status, 201);
  const result = reconcileResult.parse(created.body);
  assert.deepEqual([result.replayed, result.call.status, result.call.chargeNanos, result.call.providerGenerationId], [false, 'settled', '2500000', 'gen-over-reserve']);
  assert.deepEqual([result.reconciliation.resolution, result.reconciliation.previousStatus, result.reconciliation.previousReservedNanos, result.reconciliation.previousChargeNanos, result.reconciliation.evidence], ['settled_by_operator', 'unresolved', '2000000', '2500000', evidence]);
  assert.deepEqual(await row(), { status: 'settled', charge: '2500000', reserved: '2000000' });

  const replay = await api.reconcile(target.callId, { ...request, chargeUsd: '0.0025' });
  assert.equal(replay.status, 200);
  assert.deepEqual([replay.body.replayed, replay.body.reconciliation, replay.body.call], [true, created.body.reconciliation, created.body.call]);
  assert.equal(await count(), 1);
  const reused = await api.reconcile(target.callId, { ...request, chargeUsd: '0.003' });
  assert.deepEqual([reused.status, reused.body.reason], [409, 'idempotency_conflict']);
  const other = await unresolved(db);
  assert.deepEqual([(await api.reconcile(other.callId, request)).status, (await api.reconcile(other.callId, request)).body.reason], [409, 'idempotency_conflict'], 'a key cannot be replayed onto another call');
  const second = await api.reconcile(target.callId, body({ chargeUsd: '0.001' }));
  assert.deepEqual([second.status, second.body.reason], [409, 'already_reconciled']);
  assert.deepEqual(await row(), { status: 'settled', charge: '2500000', reserved: '2000000' });
  assert.equal(await count(), 1);
  assert.equal(typeof (await target.reserve(1_000_000n)), 'string', 'the ledger rule, not the reconciliation, lets this run reserve again');
  assert.equal((await one(db, "SELECT count(*)::int AS n FROM model_calls WHERE id=$1 AND status='unresolved'", [other.callId])).n, 1, 'other unresolved calls are untouched');
  await assert.rejects(other.reserve(1_000_000n), /billing unresolved/);

  const cleared = await api.reconcile(other.callId, body({ resolution: 'confirmed_not_billed', chargeUsd: undefined, evidence: 'Provider dashboard shows no generation for this request id' }));
  assert.deepEqual([cleared.status, cleared.body.call.chargeNanos, cleared.body.reconciliation.resolution], [201, '0', 'confirmed_not_billed']);
  assert.equal((await api.reconcile(other.callId, body({ resolution: 'confirmed_not_billed', chargeUsd: '0', evidence: 'Different evidence entirely' }))).status, 409);
  assert.equal(reconcileInput.safeParse(body({ resolution: 'confirmed_not_billed', chargeUsd: '0' })).success, true);
}));

test('only unresolved paid calls can be reconciled; local and in-flight calls are rejected untouched', () => withApi(async (db, api) => {
  const run = await paidRun(db);
  const reserved = await run.reserve(1_000_000n);
  const settled = await (async () => { const id = await run.reserve(1_000_000n); await run.settle(id, { latencyMs: 1, chargeNanos: '400000' }); return id; })();
  const localCall = await run.reserve(0n, 'ollama');
  await db.repo.pool.query("UPDATE model_calls SET status='unresolved' WHERE id=$1", [localCall]); // an expired lease can leave a local call unresolved
  for (const [id, reason] of [[reserved, 'not_unresolved'], [settled, 'not_unresolved'], [localCall, 'local_inference_unpriced']] as const) {
    const response = await api.reconcile(id, body());
    assert.deepEqual([response.status, response.body.reason], [409, reason], reason);
  }
  assert.deepEqual(await one(db, 'SELECT status,charge_nanos::text AS charge FROM model_calls WHERE id=$1', [localCall]), { status: 'unresolved', charge: null }, 'local inference is never assigned a price');
  assert.deepEqual(await one(db, 'SELECT status,charge_nanos::text AS charge FROM model_calls WHERE id=$1', [settled]), { status: 'settled', charge: '400000' });
  assert.equal((await one(db, 'SELECT count(*)::int AS n FROM spend_reconciliations')).n, 0);
  assert.equal((await api.get('/api/spend/unresolved')).body.calls.length, 0, 'local unresolved calls never appear as spend');
  assert.equal(maxReconcileCharge(1n), 10n);
  assert.equal(maxReconcileCharge(20_000_000n), 200_000_000n);
  assert.equal(maxReconcileCharge(50_000_000_000n), 100_000_000_000n, 'the absolute ceiling is $100');
  assert.equal(maxReconcileCharge(0n), 0n);
}));

test('concurrent reconciliation yields one attestation, and the database keeps it append-only', () => withApi(async (db, api) => {
  const target = await unresolved(db);
  const same = body();
  const replays = await Promise.all(Array.from({ length: 6 }, () => api.reconcile(target.callId, same)));
  assert.deepEqual(replays.map(response => response.status).sort(), [200, 200, 200, 200, 200, 201]);
  assert.equal(new Set(replays.map(response => response.body.reconciliation.id)).size, 1);
  const contested = await unresolved(db);
  const racers = await Promise.all(Array.from({ length: 4 }, () => api.reconcile(contested.callId, body({ chargeUsd: '0.001' }))));
  assert.deepEqual(racers.map(response => response.status).sort(), [201, 409, 409, 409]);
  assert.deepEqual([...new Set(racers.filter(response => response.status === 409).map(response => response.body.reason))], ['already_reconciled']);
  const [a, b] = [await unresolved(db), await unresolved(db)], shared = key();
  const collide = await Promise.all([api.reconcile(a.callId, body({ idempotencyKey: shared })), api.reconcile(b.callId, body({ idempotencyKey: shared }))]);
  assert.deepEqual(collide.map(response => response.status).sort(), [201, 409]);
  assert.equal(collide.find(response => response.status === 409)!.body.reason, 'idempotency_conflict');
  const loser = collide[0].status === 409 ? a : b;
  assert.equal((await one(db, 'SELECT status FROM model_calls WHERE id=$1', [loser.callId])).status, 'unresolved', 'the losing call keeps its hold');
  assert.equal((await one(db, 'SELECT count(*)::int AS n FROM spend_reconciliations')).n, 3);

  const rows = db.repo.pool.query.bind(db.repo.pool);
  await assert.rejects(rows("UPDATE spend_reconciliations SET evidence='rewritten'"), /append-only/);
  await assert.rejects(rows('DELETE FROM spend_reconciliations'), /append-only/);
  await assert.rejects(rows('TRUNCATE spend_reconciliations'), /append-only/);
  const insert = (callId: string, over = '') => rows(`INSERT INTO spend_reconciliations(id,call_id,previous_status,previous_reserved_nanos,resolution,charge_nanos,evidence,idempotency_key) VALUES ($1,$2,'unresolved',1,'confirmed_not_billed',0,'e',$3)${over}`, [randomUUID(), callId, key()]);
  await assert.rejects(insert(target.callId), /Only unresolved paid calls|violates unique/, 'a settled call cannot be reconciled again even by direct insert');
  const localRun = await paidRun(db), localCall = await localRun.reserve(0n, 'ollama');
  await rows("UPDATE model_calls SET status='unresolved' WHERE id=$1", [localCall]);
  await assert.rejects(insert(localCall), /Only unresolved paid calls/);
  await assert.rejects(rows('UPDATE model_calls SET provider_generation_id=$2 WHERE id=$1', [localCall, 'gen-x']), /model_calls_generation_ref/);
  await assert.rejects(rows("UPDATE model_calls SET provider_generation_id='' WHERE id=$1", [loser.callId]), /model_calls_generation_ref/);
  await assert.rejects(rows("INSERT INTO spend_reconciliations(id,call_id,previous_status,previous_reserved_nanos,resolution,charge_nanos,evidence,idempotency_key) VALUES ($1,$2,'unresolved',1,'settled_by_operator',0,'e',$3)", [randomUUID(), loser.callId, key()]), /check/i, 'a zero settled charge is not a valid attestation');
}));

test('a reconciled report-job call follows the job hold rule and cannot exceed the funds transferred to the job', () => withApi(async (db, api) => {
  const policy = { model: docs, allowanceUsd: Number(JOB * 3n) / 1e9, reviewWindowMinutes: 30 };
  const reportRun = async () => {
    const { target, selected } = await seed(db.repo, 'http://target.fixture/', 'http://ollama.fixture/');
    const started = await db.repo.start({ targetId: target.id, caseId: selected.id, roles: { judge: local }, ollamaUrl: 'http://ollama.fixture/', openRouterCapUsd: 1, reportPolicy: policy }, { roles: { judge: local }, pricing: { documentation: docsPrice } });
    assert.ok(started && 'id' in started);
    await db.repo.finish(started.id, (await db.repo.claim('execution'))!.lease_generation, 'auto_confirm');
    return started.id;
  };
  const held = async (runId: string) => (await db.repo.reports.accounting(runId)).jobs.map(job => [job.state, job.heldNanos]);

  // Finished job: the unresolved call held its reserve; reconciliation drops the hold to the recorded charge.
  const finished = await reportRun();
  await processNextReportJob(db.repo, 'w', async ctx => { await ctx.settleCall(await ctx.reserveCall(JOB)); return { status: 'completed' }; });
  assert.deepEqual(await held(finished), [['completed', JOB.toString()]]);
  const call = (await db.repo.usage(finished))[0];
  assert.deepEqual([call.status, call.role, call.reportJobId === null], ['unresolved', 'documentation', false]);
  const over = await api.reconcile(call.id, body({ chargeUsd: '0.0022001' })); // within 10 x reserve, above the job's funds
  assert.deepEqual([over.status, over.body.reason, over.body.maxChargeNanos], [400, 'charge_exceeds_report_funds', JOB.toString()]);
  assert.deepEqual(await held(finished), [['completed', JOB.toString()]]);
  assert.equal((await api.reconcile(call.id, body({ chargeUsd: '0.0011' }))).status, 201);
  assert.deepEqual(await held(finished), [['completed', '1100000']]);
  const accounting = await db.repo.reports.accounting(finished);
  assert.deepEqual([accounting.heldNanos, accounting.unusedNanos], ['1100000', (JOB * 3n - 1_100_000n).toString()]);
  await db.repo.pool.query("UPDATE runs SET finished_at=now()-interval '2 hours' WHERE id=$1", [finished]);
  await db.repo.reports.sweep(); // the allowance release still records a non-negative unused amount
  assert.equal((await one(db, 'SELECT unused_nanos::text AS unused FROM report_allowance_releases WHERE run_id=$1', [finished])).unused, (JOB * 3n - 1_100_000n).toString());

  // Running job: reconciliation settles the call but the transferred hold stays until the job terminalizes.
  const running = await reportRun();
  const claimed = (await db.repo.reports.claim('long'))!;
  const half = await db.repo.reports.reserveCall(claimed.id, claimed.generation, JOB / 2n);
  assert.equal(await db.repo.reports.settleCall(claimed.id, claimed.generation, half, { latencyMs: 2, chargeNanos: '1500000', generationId: 'gen-report-1' }), false);
  await assert.rejects(db.repo.reports.reserveCall(claimed.id, claimed.generation, 1n), /billing unresolved/);
  assert.equal((await api.reconcile(half, body({ chargeUsd: '0.0015' }))).status, 201);
  assert.deepEqual(await held(running), [['running', JOB.toString()]]);
  assert.equal((await one(db, 'SELECT provider_generation_id AS id FROM model_calls WHERE id=$1', [half])).id, 'gen-report-1');
  await db.repo.reports.settle(claimed.id, claimed.generation, 'completed');
  assert.deepEqual(await held(running), [['completed', '1500000']]);
}));
